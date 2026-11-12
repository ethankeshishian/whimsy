#!/bin/sh
# After a build: run the Whimsy tests and Zen's tab/UI suites, and save
# screenshots of the real window to $WHIMSY_SHOTS (default .surfer/shots).
#   sh whimsy/verify.sh          everything
#   sh whimsy/verify.sh quick    Whimsy tests + screenshots only
#   sh whimsy/verify.sh gate     the updater's gate; also retries Zen's failing
#                                test files once
# A failing Whimsy test file gets one retry in every mode. A file that passes
# on retry is listed in .surfer/verify/flaky.txt for the next wave to fix.
# $WHIMSY_ROOT names the checkout to verify when this file runs from a
# worktree (whimsy/tools/verify-dev.sh).
cd "${WHIMSY_ROOT:-$(dirname "$0")/..}"
export PATH="$HOME/.cargo/bin:/opt/homebrew/bin:$PATH" _ZO_DOCTOR=0
export WHIMSY_SHOTS="${WHIMSY_SHOTS:-$PWD/.surfer/shots}"
MODE="${1:-all}"
rm -rf "$WHIMSY_SHOTS" && mkdir -p "$WHIMSY_SHOTS" .surfer/verify
# Only this run's logs: vfail.py reads every .raw in the folder, and old
# retries made W24's handoff count 9 failing files after a green run.
rm -f .surfer/verify/*.log .surfer/verify/*.raw .surfer/verify/failed.txt
: > .surfer/verify/flaky.txt
# vfail.py reads every *.raw here, so a run must start without the last
# runs' logs: a retry log left from an earlier run (or a suite this mode
# skips) would be reported as tonight's failure.
rm -f .surfer/verify/*.raw .surfer/verify/*-retry-*.log
: > .surfer/verify/run-started.txt
# The sandbox read path must be the src/ the engine links into: in a
# worktree, engine/ is a symlink to the main checkout's engine.
ROOT=$(cd "$(dirname "$(cd engine && pwd -P)")" && pwd -P)
status=0

mochitest() { # mochitest <log> <paths...>
  out=$1; shift
  (cd engine && ./mach test $([ -n "${WHIMSY_HEADED:-}" ] || echo --headless) \
    "--setpref=security.sandbox.content.mac.testing_read_path2=$ROOT/src" "--log-raw=$ROOT/${out%.log}.raw" "$@") > "$out" 2>&1
}

# Prints "passed failed" for a log.
counts() {
  p=$(grep -E "INFO Passed:" "$1" | tail -1 | awk '{print $NF}')
  f=$(grep -E "INFO Failed:" "$1" | tail -1 | awk '{print $NF}')
  echo "${p:-?} ${f:-?}"
}

run() { # run <name> <paths...>
  name=$1; shift
  log=.surfer/verify/$name.log
  mochitest "$log" "$@"
  test_exit=$?
  set -- $(counts "$log")
  echo "$name: passed $1, failed $2"
  if [ "$test_exit" != "0" ] || [ "$2" != "0" ] || ! [ "$1" -gt 0 ] 2>/dev/null; then
    echo "$name: harness exit $test_exit"
    grep -E "^FAIL|TEST-UNEXPECTED" "$log" | grep -v "finished in" | cut -c1-220 | sort -u | head -15
    return 1
  fi
}

# Retry each failing test file once, so one flaky test can't block an update
# but a real breakage still does.
run_with_retry() { # run_with_retry <name> <path>
  if run "$1" "$2"; then return 0; fi
  # A missing summary, empty run, or crash is not a flaky test failure.
  # Only retry a completed suite with identifiable failing test files.
  set -- "$1" "$2" $(counts ".surfer/verify/$1.log")
  if ! [ "$3" -gt 0 ] 2>/dev/null || ! [ "$4" -gt 0 ] 2>/dev/null; then
    return 1
  fi
  if grep -Eq 'PROCESS-CRASH|TEST-UNEXPECTED-(CRASH|TIMEOUT)|Traceback' ".surfer/verify/$1.log"; then
    return 1
  fi
  retry_files=$(grep -E "TEST_START|TEST_END: Test FAIL" ".surfer/verify/$1.log" |
    awk '/TEST_START/{f=$NF} /TEST_END: Test FAIL/{print f}' | sort -u)
  [ -n "$retry_files" ] || return 1
  bad=""
  for f in $retry_files; do
    if run "$1-retry-$(basename "$f" .js)" "$f"; then
      echo "  $f passed on retry (flaky)"
      echo "$f" >> .surfer/verify/flaky.txt
    else
      bad="$bad $f"
    fi
  done
  [ -z "$bad" ]
}

# A headed run's harness waits for its window to take focus. While any app
# holds Secure Keyboard Entry (a password field, a terminal's secure input),
# macOS won't let another app come to the front, so the suite would sit
# silent until the harness's no-output timeout. Wait for it to be released;
# if it never is, say why instead of reporting a hang.
secure_input_pid() {
  ioreg -l -w 0 2>/dev/null | sed -n 's/.*"kCGSSessionSecureInputPID"=\([0-9]*\).*/\1/p' | head -1
}
wait_for_foreground() { # wait_for_foreground <name>
  waited=0
  while pid=$(secure_input_pid); [ -n "$pid" ]; do
    if [ "$waited" = 0 ]; then
      echo "$1: waiting for secure keyboard input to be released (held by $(ps -p "$pid" -o comm= 2>/dev/null || echo "pid $pid"))"
    fi
    if [ "$waited" -ge 1800 ]; then
      echo "$1: not run: secure keyboard input still held after 30 minutes, so its window can't take focus"
      return 1
    fi
    sleep 10
    waited=$((waited + 10))
  done
}

# Guard: a Whimsy test that triggers a real download must land it in a
# temp folder it cleans up itself, never the person's actual Downloads
# folder (browser_whimsy_private_followups.js left 173 whimsy-slow.bin
# files there before useTempDownloadDir() existed). Resolve the folder the
# way macOS does, not a hard-coded path: iCloud Drive can mirror it at a
# CloudDocs path (this Mac does), and that's what "path to downloads
# folder" and Firefox's own downloads code both return.
downloads_dir() {
  osascript -e 'POSIX path of (path to downloads folder)' 2>/dev/null | sed 's:/*$::'
}
DOWNLOADS_DIR=$(downloads_dir)
if [ -n "$DOWNLOADS_DIR" ] && [ -d "$DOWNLOADS_DIR" ]; then
  LC_ALL=C ls -A "$DOWNLOADS_DIR" 2>/dev/null | LC_ALL=C sort > .surfer/verify/downloads-before.txt
fi

run_with_retry whimsy zen/whimsy/tests || status=1
# Native-event tests need a visible window; run just those headed.
wait_for_foreground whimsy-native &&
(WHIMSY_HEADED=1; export WHIMSY_HEADED; run whimsy-native zen/whimsy/tests/browser_whimsy_ctrl_tab_native.js zen/whimsy/tests/browser_whimsy_native_services.js zen/whimsy/tests/browser_whimsy_arc_menu_keys_native.js) || status=1

if [ -n "$DOWNLOADS_DIR" ] && [ -d "$DOWNLOADS_DIR" ] && [ -f .surfer/verify/downloads-before.txt ]; then
  LC_ALL=C ls -A "$DOWNLOADS_DIR" 2>/dev/null | LC_ALL=C sort > .surfer/verify/downloads-after.txt
  LC_ALL=C comm -13 .surfer/verify/downloads-before.txt .surfer/verify/downloads-after.txt > .surfer/verify/downloads-new.txt
  # Names a .sjs in the tests dir hands out via Content-Disposition, plus
  # the plain whimsy-* pattern every fixture's own name follows.
  grep -ho 'filename="\{0,1\}[^";]*' src/zen/whimsy/tests/*.sjs 2>/dev/null | sed -E 's/^filename="?//' | LC_ALL=C sort -u > .surfer/verify/downloads-fixtures.txt
  leaked=""
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    case "$f" in
      whimsy-*) leaked="$leaked
$f" ;;
      *) grep -qxF "$f" .surfer/verify/downloads-fixtures.txt && leaked="$leaked
$f" ;;
    esac
  done < .surfer/verify/downloads-new.txt
  if [ -n "$leaked" ]; then
    echo "whimsy: the suite left test fixture(s) in the real Downloads folder ($DOWNLOADS_DIR):"
    echo "$leaked"
    status=1
  fi
fi

if [ "$MODE" = "all" ] || [ "$MODE" = "gate" ]; then
  if [ "$MODE" = "gate" ]; then
    run_with_retry zen-tabs zen/tests/tabs || status=1
    run_with_retry zen-ui zen/tests/ui || status=1
  else
    run zen-tabs zen/tests/tabs || status=1
    run zen-ui zen/tests/ui || status=1
  fi
fi

echo "Screenshots: $WHIMSY_SHOTS"
ls "$WHIMSY_SHOTS"
# Record the result for `npm run promote`: only a green full run (all or
# gate) of a clean checkout, testing a full build of that same commit, lets
# it move the release tag (.surfer/verify/verified.json).
python3 whimsy/updater/updater.py record-verify "$MODE" "$status" || true
python3 whimsy/vfail.py || true
exit $status
