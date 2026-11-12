"""Why a mochitest run is red, from its log: the runner prints this in its
first lines instead of "DONE passed ? failed ?" (W24 read that text 20 times).

    python3 whimsy/tools/reason.py LOG [--exit N] [--file PATH...]

Prints
    RESULT green|red
    REASON <one line naming the cause and the test file>
    PASSED n FAILED m
    FAIL <up to 12 failing assertions>
and exits 0 for green, 1 for red. --file names the test files that were
requested, so a file that doesn't exist is named before the harness's output
is searched.
"""
import os
import re
import sys

CRASH = re.compile(r"killed by (SIG\w+)|PROCESS-CRASH|application crashed|Exiting due to channel error")
MOZ_CRASH = re.compile(r"(?:Hit )?MOZ_CRASH\((.*?)\)|Missing chrome or resource URLs?: (\S+)")
TIMEOUT = re.compile(r"TEST-UNEXPECTED-TIMEOUT|Test timed out|ran for longer than allowed|no output timeout")
NOT_FOUND = re.compile(r"could not find any (?:supported )?(?:mochi)?tests|No tests were found|"
                       r"TEST-UNEXPECTED-ERROR .*(?:not found|No such file)")
TRACEBACK = re.compile(r"^Traceback \(most recent call last\)")
UNEXPECTED = re.compile(r"TEST-UNEXPECTED-(FAIL|ERROR|TIMEOUT|CRASH)|^ *FAIL ")
TEST_START = re.compile(r"TEST_START(?::)? (\S+)|TEST-START \| (\S+)")
SUMMARY = re.compile(r"^\s*(?:\S+\s+)?(?:INFO )?(Passed|Failed|Todo):\s*(\d+)")
EXPECTED_FAIL = re.compile(r"(?<!UN)EXPECTED-FAIL|TEST-KNOWN-FAIL")


def analyse(log_text, exit_code=None, requested=()):
    """(green: bool, reason: str, passed: int|None, failed: int|None, fails: [str])"""
    missing = [f for f in requested if f and not os.path.exists(f)]
    counts = {}
    fails, crash_sig, moz_crash, timeout_at, not_found, traceback_tail = [], None, None, None, False, None
    current = None
    crash_at = None
    lines = log_text.splitlines()
    for i, line in enumerate(lines):
        m = TEST_START.search(line)
        if m:
            current = m.group(1) or m.group(2)
        m = SUMMARY.match(line)
        if m:
            counts[m.group(1)] = int(m.group(2))
        if EXPECTED_FAIL.search(line):
            continue
        if UNEXPECTED.search(line) and "finished in" not in line:
            fails.append(line.strip()[:220])
        m = CRASH.search(line)
        if m and (crash_sig is None or (m.group(1) and crash_sig == "crash")):
            # The signal name comes a few lines after "channel error"; prefer it.
            crash_sig = m.group(1) or "crash"
            crash_at = crash_at or current
        m = MOZ_CRASH.search(line)
        if m and moz_crash is None:
            moz_crash = m.group(1) or ("missing URL " + m.group(2))
        if timeout_at is None and TIMEOUT.search(line):
            timeout_at = current
        if NOT_FOUND.search(line):
            not_found = True
        if TRACEBACK.match(line):
            tail = [l for l in lines[i + 1:i + 40] if l.strip() and not l.startswith(" ")]
            traceback_tail = tail[0] if tail else "Traceback"
    passed, failed = counts.get("Passed"), counts.get("Failed")
    uniq = []
    for f in fails:
        if f not in uniq:
            uniq.append(f)
    green = (exit_code in (None, 0) and failed == 0 and (passed or 0) > 0
             and not crash_sig and not missing and not not_found and timeout_at is None and not traceback_tail)
    if green:
        return True, f"green: {passed} passed", passed, failed, []
    if missing:
        reason = "test file not found: " + ", ".join(os.path.relpath(f) if os.path.isabs(f) else f for f in missing)
    elif crash_sig:
        where = f" in {crash_at}" if crash_at else " at startup (before the first test)"
        reason = f"crashed ({crash_sig}){where}"
        if moz_crash:
            reason += f": {moz_crash}"
        else:
            reason += "; run whimsy/tools/crash-stack.sh on the file for the native stack"
    elif not_found:
        reason = "harness found no tests at the requested path(s)"
    elif timeout_at is not None:
        reason = f"timed out in {timeout_at}" if timeout_at else "timed out before the first test"
    elif traceback_tail:
        reason = f"harness error: {traceback_tail.strip()[:160]}"
    elif failed:
        files = sorted({re.sub(r".*\| ", "", f.split(" | ")[1]) if " | " in f else "" for f in uniq} - {""})
        reason = f"{failed} assertion(s) failed" + (f" in {', '.join(files[:6])}" if files else "")
    elif passed is None:
        reason = f"no test summary in the log (harness exit {exit_code})"
    elif passed == 0:
        reason = "no assertions ran (0 passed)"
    else:
        reason = f"harness exit {exit_code} with {passed} passed, {failed} failed"
    return False, reason, passed, failed, uniq


def main(argv):
    if not argv:
        print(__doc__)
        return 2
    log = argv[0]
    exit_code = None
    requested = []
    i = 1
    while i < len(argv):
        if argv[i] == "--exit" and i + 1 < len(argv):
            exit_code = int(argv[i + 1]); i += 2
        elif argv[i] == "--file":
            i += 1
            while i < len(argv) and not argv[i].startswith("--"):
                requested.append(argv[i]); i += 1
        else:
            i += 1
    text = open(log, encoding="utf-8", errors="replace").read() if os.path.exists(log) else ""
    if not text and not os.path.exists(log):
        exit_code = exit_code if exit_code is not None else 1
    green, reason, passed, failed, fails = analyse(text, exit_code, requested)
    print("RESULT", "green" if green else "red")
    print("REASON", reason)
    print(f"PASSED {passed if passed is not None else '?'} FAILED {failed if failed is not None else '?'}")
    for f in fails[:12]:
        print("FAIL", f)
    return 0 if green else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
