#!/bin/sh
# Parallel version of verify.sh: the same suites, with the Whimsy tests split
# into N chunks that run at the same time. The headed native tests still run
# alone, after everything else. Not the release gate yet: verify.sh stays the
# definition of green, and this script records nothing for the updater.
#   sh whimsy/verify-parallel.sh [all|quick] [chunks]    default: all 3
# Logs go to .surfer/verify/parallel/. Compare with verify.sh's run:
#   python3 whimsy/verify-compare.py
#
# Ports: Firefox 159's runtests.py checks the fixed ports (HTTP 8888, SSL
# 4443, websocket 9988, Marionette 2828) and takes a free port when one is
# busy, and it writes the proxy prefs after the servers start, so the PAC and
# ssltunnel follow the real ports. The http2/DoH/moz-http2 servers already use
# free ports. What's left is a race: two runs that check a port at the same
# moment both see it free. So each run starts only once the previous one is
# listening (its Marionette line), and nothing starts at the same instant.
# Gap: pywebsocket listens on *:9988 and the harness probes 127.0.0.1, so only
# the first run gets a websocket server. No test in these suites uses ws/wss.
# Each run also gets its own --testrun-manifest-file, or the runs overwrite
# each other's tests.json in the shared objdir and run each other's tests.
#
# STATUS (2026-11-01): runs, but does NOT yet match serial. Under 3-4
# concurrent browsers some timing-sensitive tests fail (vsync left on,
# load-event waits, synthesized shortcut waits), and a test timeout ends that
# chunk's browser, so the rest of the chunk never runs. See
# whimsy-handoff/wave11/reports/w11-parallel.md.
#
# Chunks: mochitest has no --this-chunk on desktop. Each chunk passes a
# contiguous run of entries from the suite's browser.toml as test paths;
# mach still reads the manifest, so prefs, support files and skip-if apply.
cd "$(dirname "$0")/.."
export PATH="$HOME/.cargo/bin:/opt/homebrew/bin:$PATH" _ZO_DOCTOR=0
export WHIMSY_SHOTS="${WHIMSY_SHOTS:-$PWD/.surfer/shots}"
MODE=all
# W11-P1: 4 chunks (with Zen's suites on top, 6 browsers) saturated an
# 8-core Mac (load ~74, background-tab work 10-35x slower); 3 keep it
# within ~2x of serial.
CHUNKS=3
for arg in "$@"; do
  case "$arg" in
    all|quick) MODE=$arg ;;
    *[!0-9]*|'') echo "usage: sh whimsy/verify-parallel.sh [all|quick] [chunks]"; exit 2 ;;
    *) CHUNKS=$arg ;;
  esac
done
[ "$CHUNKS" -ge 1 ] || CHUNKS=1
# The sandbox read path must be the src/ the engine links into: in a
# worktree, engine/ is a symlink to the main checkout's engine.
ROOT=$(cd "$(dirname "$(cd engine && pwd -P)")" && pwd -P)
OUT=.surfer/verify/parallel
rm -rf "$WHIMSY_SHOTS" "$OUT" && mkdir -p "$WHIMSY_SHOTS" "$OUT"
start_time=$(date +%s)
status=0
jobs=""

mochitest() { # mochitest <log> <paths...>
  out=$1; shift
  (cd engine && ./mach test $([ -n "${WHIMSY_HEADED:-}" ] || echo --headless) \
    "--setpref=security.sandbox.content.mac.testing_read_path2=$ROOT/src" ${WHIMSY_VERIFY_ARGS:-} "$@") > "$out" 2>&1
}

counts() { # prints "passed failed" for a log
  p=$(grep -E "INFO Passed:" "$1" | tail -1 | awk '{print $NF}')
  f=$(grep -E "INFO Failed:" "$1" | tail -1 | awk '{print $NF}')
  echo "${p:-?} ${f:-?}"
}

# Splits a manifest's tests into <n> contiguous chunks, balanced by the run
# times in the last serial or parallel log when there is one. Prints one line
# per chunk: the test paths, relative to engine/.
chunk_paths() { # chunk_paths <suite dir under engine/> <n>
  python3 - "$1" "$2" .surfer/verify/whimsy.log .surfer/verify/parallel-last/*.log <<'EOF'
import os, re, sys, tomllib
suite, n, logs = sys.argv[1], int(sys.argv[2]), sys.argv[3:]
with open(os.path.join("engine", suite, "browser.toml"), "rb") as f:
    manifest = tomllib.load(f)
tests = [f"{suite}/{k}" for k, v in manifest.items() if k != "DEFAULT" and isinstance(v, dict)]
if not tests:
    sys.exit(f"no tests in {suite}/browser.toml")
def secs(stamp):
    t = 0.0
    for part in stamp.split(":"):
        t = t * 60 + float(part)
    return t
times = {}
for log in logs:
    if not os.path.isfile(log):
        continue
    current = None
    for line in open(log, errors="replace"):
        m = re.match(r"\s*([\d:.]+) TEST_START: (\S+)", line)
        if m:
            current = (m.group(2), secs(m.group(1)))
            continue
        m = re.match(r"\s*([\d:.]+) TEST_END: ", line)
        if m and current:
            times[current[0]] = max(1.0, secs(m.group(1)) - current[1])
            current = None
default = sorted(times.values())[len(times) // 2] if times else 1.0
weights = [times.get(t, default) for t in tests]
n = max(1, min(n, len(tests)))
target = sum(weights) / n
chunks, cur, acc = [], [], 0.0
for i, (t, w) in enumerate(zip(tests, weights)):
    cur.append(t)
    acc += w
    left_chunks = n - len(chunks) - 1
    left_tests = len(tests) - i - 1
    if left_chunks > 0 and (acc >= target * (len(chunks) + 1) or left_tests == left_chunks):
        chunks.append(cur)
        cur = []
chunks.append(cur)
for c in chunks:
    if c:
        print(" ".join(c))
EOF
}

# Starts a job in the background, then waits until its browser is listening
# (or it has exited) so the next job sees this one's ports as taken.
start_job() { # start_job <name> <paths...>
  name=$1; shift
  log=$OUT/$name.log
  : > "$log"
  # Each run needs its own tests.json: runtests.py writes the list of tests
  # to run into that file in the shared objdir, and the browser reads it back.
  ( mochitest "$log" "--testrun-manifest-file=tests-whimsy-$name.json" "$@" < /dev/null
    echo $? > "$OUT/$name.exit" ) &
  jobs="$jobs $name"
  waited=0
  while [ ! -f "$OUT/$name.exit" ] && [ "$waited" -lt 180 ] &&
    ! grep -q "Marionette is listening" "$log"; do
    sleep 1; waited=$((waited + 1))
  done
}

check() { # check <name>
  name=$1
  log=$OUT/$name.log
  test_exit=$(cat "$OUT/$name.exit" 2>/dev/null || echo "?")
  set -- $(counts "$log")
  echo "$name: passed $1, failed $2"
  if grep -qE "Address already in use|EADDRINUSE|Unable to start" "$log"; then
    echo "$name: a server could not bind its port"
    status=1
  fi
  if [ "$test_exit" != "0" ] || [ "$2" != "0" ] || ! [ "$1" -gt 0 ] 2>/dev/null; then
    echo "$name: harness exit $test_exit"
    grep -E "^FAIL|TEST-UNEXPECTED" "$log" | grep -v "finished in" | cut -c1-220 | sort -u | head -15
    status=1
  fi
}

i=1
chunk_paths zen/whimsy/tests "$CHUNKS" > "$OUT/chunks.txt" || exit 1
while read -r paths; do
  start_job "whimsy-c$i" $paths
  i=$((i + 1))
done < "$OUT/chunks.txt"
wait

# A test that times out ends its chunk's browser, so the files after it never
# start. Run those, serially, in a fresh browser: a first run, not a retry (a
# file that ran and failed stays failed). Repeats while files are left over.
never_started() {
  for t in $(cat "$OUT/chunks.txt"); do
    grep -qF "TEST_START: $t" "$OUT"/whimsy-c*.log "$OUT"/whimsy-rest*.log 2>/dev/null || echo "$t"
  done
}
n=1
rest=$(never_started)
while [ -n "$rest" ]; do
  echo "whimsy-rest$n: $(echo $rest | wc -w | tr -d ' ') files never started; running them now"
  start_job "whimsy-rest$n" $rest
  wait
  left=$(never_started)
  [ "$left" = "$rest" ] && break # nothing more started: don't loop forever
  rest=$left; n=$((n + 1))
done
if [ -n "$rest" ]; then
  echo "never started:"; echo "$rest" | sed 's/^/  /'; status=1
fi
# Zen's suites are short: they run together after the Whimsy chunks, so
# the peak stays at one browser per chunk.
if [ "$MODE" = "all" ]; then
  start_job zen-tabs zen/tests/tabs
  start_job zen-ui zen/tests/ui
  wait
fi
for name in $jobs; do check "$name"; done

# Native-event tests need a visible window and focus; run them alone, headed.
(WHIMSY_HEADED=1; export WHIMSY_HEADED
 mochitest "$OUT/whimsy-native.log" zen/whimsy/tests/browser_whimsy_ctrl_tab_native.js \
   zen/whimsy/tests/browser_whimsy_native_services.js zen/whimsy/tests/browser_whimsy_arc_menu_keys_native.js
 echo $? > "$OUT/whimsy-native.exit")
check whimsy-native

rm -f engine/obj-*/_tests/testing/mochitest/tests-whimsy-*.json
# Keep this run's logs as timing data for the next run's chunk split.
rm -rf .surfer/verify/parallel-last && cp -R "$OUT" .surfer/verify/parallel-last
echo "Wall clock: $(( $(date +%s) - start_time ))s ($CHUNKS Whimsy chunks)"
echo "Screenshots: $WHIMSY_SHOTS"
exit $status
