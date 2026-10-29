#!/bin/sh
# After a build: run the Whimsy tests and Zen's tab/UI suites, and save
# screenshots of the real window to $WHIMSY_SHOTS (default .surfer/shots).
#   sh whimsy/verify.sh          everything
#   sh whimsy/verify.sh quick    Whimsy tests + screenshots only
#   sh whimsy/verify.sh gate     the updater's gate: Whimsy tests must pass;
#                                a failing Zen test file gets one retry
cd "$(dirname "$0")/.."
export PATH="$HOME/.cargo/bin:/opt/homebrew/bin:$PATH" _ZO_DOCTOR=0
export WHIMSY_SHOTS="${WHIMSY_SHOTS:-$PWD/.surfer/shots}"
MODE="${1:-all}"
rm -rf "$WHIMSY_SHOTS" && mkdir -p "$WHIMSY_SHOTS" .surfer/verify
ROOT=$PWD
status=0

mochitest() { # mochitest <log> <paths...>
  out=$1; shift
  (cd engine && ./mach test \
    "--setpref=security.sandbox.content.mac.testing_read_path2=$ROOT/src" "$@") > "$out" 2>&1
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

# Zen's suites: retry each failing test file once, so one flaky test can't
# block an update but a real breakage still does.
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
    else
      bad="$bad $f"
    fi
  done
  [ -z "$bad" ]
}

run whimsy zen/whimsy/tests || status=1
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
exit $status
