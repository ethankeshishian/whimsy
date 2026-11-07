#!/bin/sh
# Run only failed.txt, twice per file, in separate headless harness processes.
cd "$(dirname "$0")/.." || exit 2
export PATH="$HOME/.cargo/bin:/opt/homebrew/bin:$PATH" _ZO_DOCTOR=0
list=.surfer/verify/failed.txt
[ -f "$list" ] || { echo "Run python3 whimsy/vfail.py first." >&2; exit 2; }
[ -s "$list" ] || { echo "No failing files listed."; exit 0; }
# One shared engine objdir: refuse while verify/build/publish is active.
busy=$(pgrep -fl 'mach|verify.sh|publish.py')
probe=$?
if [ "$probe" -ne 1 ]; then
  echo "Cannot start isolated reruns: engine may be busy (pgrep status $probe)." >&2
  echo "$busy" >&2
  exit 2
fi
mkdir .surfer/verify/rerun.lock 2>/dev/null || {
  echo "Another vrerun may be active (.surfer/verify/rerun.lock)." >&2; exit 2;
}
trap 'rmdir .surfer/verify/rerun.lock' 0
trap 'exit 2' 1 2 15
ROOT=$(cd "$(dirname "$(cd engine && pwd -P)")" && pwd -P) || exit 2
out=$(mktemp -d "$PWD/.surfer/verify/rerun.XXXXXX") || exit 2
# Snapshot the list: a later vfail invocation must not alter this run.
cp "$list" "$out/failed.txt" || exit 2
python3 - "$out/failed.txt" <<'PY' || exit 2
import re, sys
from pathlib import PurePosixPath
for line in open(sys.argv[1]):
    path = line.rstrip("\n")
    if not re.fullmatch(r"(?:zen|browser)/[\w./-]+/browser_[\w.-]+\.js", path) or ".." in PurePosixPath(path).parts:
        sys.exit(f"Invalid test file in failed.txt: {path!r}")
PY

result=0
index=0
printf '%-20s %-11s %s\n' CLASSIFICATION RUNS FILE
while IFS= read -r file || [ -n "$file" ]; do
  index=$((index + 1))
  outcomes=""
  for attempt in 1 2; do
    raw="$out/$index-$attempt.raw"
    log="$out/$index-$attempt.log"
    (cd engine && ./mach test --headless \
      "--setpref=security.sandbox.content.mac.testing_read_path2=$ROOT/src" \
      "--log-raw=$raw" "$file") > "$log" 2>&1
    harness=$?
    outcome=$(python3 - "$raw" "$file" "$harness" <<'PY'
import json, sys
sys.path.insert(0, "whimsy")
from vfail import test_path, unexpected
events = []
try:
    with open(sys.argv[1]) as stream:
        events = [json.loads(line) for line in stream if line.strip()]
except (OSError, ValueError):
    print("ERROR")
    sys.exit()
tests = [e for e in events if e.get("action") in ("test_status", "test_end")
         and test_path(e.get("test", "")) == sys.argv[2]]
ends = [e for e in tests if e["action"] == "test_end"]
complete = any(e.get("action") == "suite_end" for e in events)
if not complete or not ends or any(e.get("status") == "SKIP" for e in ends):
    print("ERROR")
elif any(unexpected(e) for e in tests):
    print("FAIL")
elif sys.argv[3] == "0" and all(e.get("status") == "PASS" for e in ends):
    print("PASS")
else:
    print("ERROR")
PY
    )
    outcomes="${outcomes:+$outcomes/}${outcome:-ERROR}"
  done
  case "$outcomes" in
    PASS/PASS) label=PASS-ALONE-BOTH ;;
    FAIL/FAIL) label=FAIL-ALONE; [ "$result" -eq 2 ] || result=1 ;;
    PASS/FAIL|FAIL/PASS) label=FLAKY; [ "$result" -eq 2 ] || result=1 ;;
    *) label=HARNESS-ERROR; result=2 ;;
  esac
  printf '%-20s %-11s %s\n' "$label" "$outcomes" "$file"
done < "$out/failed.txt"
echo "Logs: $out"
echo "PASS-ALONE-BOTH: hunt order/load leaks; FAIL-ALONE: investigate defect; FLAKY: investigate timing."
exit "$result"
