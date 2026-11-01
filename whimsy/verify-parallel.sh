#!/bin/sh
# Run Whimsy tests and Zen's tab/UI suites in parallel chunks.
# Usage:
#   sh whimsy/verify-parallel.sh [quick|gate|all] [chunks]
#   sh whimsy/verify-parallel.sh [chunks] [quick|gate|all]
# Default chunks: 5. Default mode: all.
cd "$(dirname "$0")/.."
export PATH="$HOME/.cargo/bin:/opt/homebrew/bin:$PATH" _ZO_DOCTOR=0
export WHIMSY_SHOTS="${WHIMSY_SHOTS:-$PWD/.surfer/shots}"

MODE="all"
CHUNKS=5

for arg in "$@"; do
  case "$arg" in
    ''|*[!0-9]*)
      MODE="$arg"
      ;;
    *)
      CHUNKS="$arg"
      ;;
  esac
done

if [ "$CHUNKS" -lt 1 ] 2>/dev/null; then
  CHUNKS=5
fi

rm -rf "$WHIMSY_SHOTS" && mkdir -p "$WHIMSY_SHOTS" .surfer/verify
ROOT=$PWD
status=0

TMP_PROFILES="/tmp/whimsy-parallel-$$"
mkdir -p "$TMP_PROFILES"
cleanup() {
  rm -rf "$TMP_PROFILES"
}
trap cleanup EXIT INT TERM

# Prints "passed failed" for a log.
counts() {
  p=$(grep -E "INFO Passed:" "$1" 2>/dev/null | tail -1 | awk '{print $NF}')
  f=$(grep -E "INFO Failed:" "$1" 2>/dev/null | tail -1 | awk '{print $NF}')
  echo "${p:-?} ${f:-?}"
}

# Run a mochitest job with dedicated profile and distinct port.
# mochitest_exec <out_log> <profile_dir> <port> <chunk> <total_chunks> <paths...>
mochitest_exec() {
  out=$1; prof=$2; port=$3; chunk=$4; total=$5; shift 5
  mkdir -p "$prof"
  (
    cd engine && ./mach test $([ -n "${WHIMSY_HEADED:-}" ] || echo --headless) \
      "--setpref=security.sandbox.content.mac.testing_read_path2=$ROOT/src" \
      --total-chunks="$total" --this-chunk="$chunk" \
      --profile-path="$prof" \
      --marionette="127.0.0.1:$port" \
      "$@"
  ) > "$out" 2>&1
  rc=$?

  # Harness compatibility fallback: if desktop mochitest rejects --total-chunks,
  # partition test files for this chunk and re-run.
  if [ $rc -ne 0 ] && grep -Eq "unrecognized arguments:.*--total-chunks|error: unrecognized arguments:.*--total-chunks" "$out"; then
    chunk_files=$(python3 -c "
import sys, os, glob
suite_path = sys.argv[1]
chunk_idx = int(sys.argv[2])
total_chunks = int(sys.argv[3])
all_files = []
target = suite_path if os.path.isabs(suite_path) else os.path.join('engine', suite_path)
if os.path.isdir(target):
    all_files = sorted(glob.glob(os.path.join(target, 'browser_*.js')))
    all_files = [os.path.relpath(f, 'engine') for f in all_files]
if not all_files:
    sys.exit(1)
k, m = divmod(len(all_files), total_chunks)
chunks = [all_files[i*k + min(i, m):(i+1)*k + min(i+1, m)] for i in range(total_chunks)]
selected = chunks[chunk_idx - 1] if chunk_idx <= len(chunks) else []
print(' '.join(selected))
" "$1" "$chunk" "$total" 2>/dev/null)
    if [ -n "$chunk_files" ]; then
      (
        cd engine && ./mach test $([ -n "${WHIMSY_HEADED:-}" ] || echo --headless) \
          "--setpref=security.sandbox.content.mac.testing_read_path2=$ROOT/src" \
          --profile-path="$prof" \
          --marionette="127.0.0.1:$port" \
          $chunk_files
      ) > "$out" 2>&1
      rc=$?
    fi
  fi
  return $rc
}

pids=""
all_jobs=""

run_job_bg() { # run_job_bg <name> <prof> <port> <chunk> <total> <paths...>
  name=$1; prof=$2; port=$3; chunk=$4; total=$5; shift 5
  log=".surfer/verify/$name.log"
  (
    mochitest_exec "$log" "$prof" "$port" "$chunk" "$total" "$@"
    echo $? > "$TMP_PROFILES/$name.exit"
  ) &
  pids="$pids $!"
  all_jobs="$all_jobs $name"
}

# 1. Launch Whimsy suite in N chunks concurrently
c=1
while [ "$c" -le "$CHUNKS" ]; do
  name="whimsy-c$c"
  prof="$TMP_PROFILES/$name"
  port=$((2828 + c * 10))
  run_job_bg "$name" "$prof" "$port" "$c" "$CHUNKS" zen/whimsy/tests
  c=$((c + 1))
done

# 2. Launch zen-tabs and zen-ui as two more parallel jobs if MODE != quick
if [ "$MODE" = "all" ] || [ "$MODE" = "gate" ]; then
  name="zen-tabs-c1"
  prof="$TMP_PROFILES/$name"
  port=$((2828 + (CHUNKS + 1) * 10))
  run_job_bg "$name" "$prof" "$port" 1 1 zen/tests/tabs

  name="zen-ui-c1"
  prof="$TMP_PROFILES/$name"
  port=$((2828 + (CHUNKS + 2) * 10))
  run_job_bg "$name" "$prof" "$port" 1 1 zen/tests/ui
fi

# 3. Wait for all parallel jobs to complete
for pid in $pids; do
  wait "$pid" 2>/dev/null || status=1
done

total_passed=0
total_failed=0

check_job() { # check_job <name>
  name=$1
  log=".surfer/verify/$name.log"
  test_exit=0
  if [ -f "$TMP_PROFILES/$name.exit" ]; then
    test_exit=$(cat "$TMP_PROFILES/$name.exit")
  fi
  set -- $(counts "$log")
  p=${1:-?}
  f=${2:-?}
  echo "$name: passed $p, failed $f"
  if [ "$test_exit" != "0" ] || [ "$f" != "0" ] || ! [ "$p" -gt 0 ] 2>/dev/null; then
    echo "$name: harness exit $test_exit"
    grep -E "^FAIL|TEST-UNEXPECTED" "$log" 2>/dev/null | grep -v "finished in" | cut -c1-220 | sort -u | head -15
    status=1
  fi
  if [ "$p" -gt 0 ] 2>/dev/null; then
    total_passed=$((total_passed + p))
  fi
  if [ "$f" -gt 0 ] 2>/dev/null; then
    total_failed=$((total_failed + f))
  fi
}

for job in $all_jobs; do
  check_job "$job"
done

# 4. Keep headed whimsy-native SERIAL, after all parallel jobs
native_name="whimsy-native-c1"
native_log=".surfer/verify/$native_name.log"
native_prof="$TMP_PROFILES/$native_name"
native_port=$((2828 + (CHUNKS + 3) * 10))
(
  WHIMSY_HEADED=1
  export WHIMSY_HEADED
  mochitest_exec "$native_log" "$native_prof" "$native_port" 1 1 \
    zen/whimsy/tests/browser_whimsy_ctrl_tab_native.js \
    zen/whimsy/tests/browser_whimsy_native_services.js \
    zen/whimsy/tests/browser_whimsy_arc_menu_keys_native.js
  echo $? > "$TMP_PROFILES/$native_name.exit"
)
cp "$native_log" ".surfer/verify/whimsy-native.log" 2>/dev/null || true
check_job "$native_name"

# 5. Summarise total in the same format
echo "total: passed $total_passed, failed $total_failed"

if [ "$total_passed" -eq 0 ] 2>/dev/null || [ "$total_failed" -ne 0 ] 2>/dev/null || [ "$status" -ne 0 ]; then
  status=1
fi

echo "Screenshots: $WHIMSY_SHOTS"
ls "$WHIMSY_SHOTS" 2>/dev/null || true
python3 whimsy/updater/updater.py record-verify "$MODE" "$status" || true
exit $status
