#!/usr/bin/env python3
"""Compare per-test results of a serial verify.sh run with a parallel
verify-parallel.sh run of the same build.

  python3 whimsy/verify-compare.py [--serial LOG...] [--parallel LOG...]

Defaults: verify.sh's logs (.surfer/verify/{whimsy,whimsy-native,zen-tabs,
zen-ui}.log) against .surfer/verify/parallel/*.log. Each test file's results
across a run's logs (a skip in one log and a run in another both count) must
match exactly: status, subtests passed and total, unexpected count. Retry logs
(verify.sh gate) are ignored. Exits 0 on a match, 1 otherwise.
"""

import argparse
import glob
import os
import re
import sys
from collections import defaultdict

ANSI = re.compile(r"\x1b\[[0-9;]*[a-zA-Z]")
STAMP = r"\s*([\d:.]+) "
START = re.compile(STAMP + r"TEST_START: (\S+)")
END = re.compile(STAMP + r"TEST_END: (.*)")
RESULT = re.compile(r"Test (\w+)\. Subtests passed (\d+)/(\d+)\. Unexpected (\d+)")
TOTAL = re.compile(r"INFO (Passed|Failed|Todo):\s*(\d+)")


def secs(stamp):
    t = 0.0
    for part in stamp.split(":"):
        t = t * 60 + float(part)
    return t


def parse(path):
    """Returns ({test: [result, ...]}, {Passed/Failed/Todo: n}, seconds)."""
    results = defaultdict(list)
    totals = {}
    current = None
    last = 0.0
    for line in open(path, errors="replace"):
        line = ANSI.sub("", line)
        m = re.match(STAMP, line)
        if m:
            try:
                last = max(last, secs(m.group(1)))
            except ValueError:
                pass
        m = START.match(line)
        if m:
            current = m.group(2)
            continue
        m = END.match(line)
        if m and current:
            text = m.group(2).strip()
            r = RESULT.search(text)
            if r:
                text = f"{r[1]} {r[2]}/{r[3]} unexpected {r[4]}"
            elif text.startswith("SKIP"):
                text = "SKIP"
            results[current].append(text)
            current = None
            continue
        m = TOTAL.search(line)
        if m:
            totals[m.group(1)] = int(m.group(2))
    if current:
        results[current].append("NO END (crash or timeout)")
    return results, totals, last


def collect(paths):
    files = sorted({f for p in paths for f in (glob.glob(os.path.join(p, "*.log")) if os.path.isdir(p) else glob.glob(p))})
    files = [f for f in files if "-retry-" not in os.path.basename(f)]
    tests = defaultdict(list)
    totals = defaultdict(int)
    seconds = 0.0
    for f in files:
        results, t, s = parse(f)
        for name, rs in results.items():
            tests[name].extend(rs)
        for k, v in t.items():
            totals[k] += v
        seconds += s
    return files, {k: sorted(v) for k, v in tests.items()}, dict(totals), seconds


def describe(label, files, tests, totals, seconds):
    print(f"{label}: {len(files)} logs, {len(tests)} test files, "
          f"Passed {totals.get('Passed', '?')}, Failed {totals.get('Failed', '?')}, "
          f"Todo {totals.get('Todo', '?')}, harness time summed {seconds / 60:.1f} min")
    for f in files:
        print(f"  {f}")


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--serial", nargs="+", default=[
        f".surfer/verify/{n}.log" for n in ("whimsy", "whimsy-native", "zen-tabs", "zen-ui")])
    ap.add_argument("--parallel", nargs="+", default=[".surfer/verify/parallel"])
    args = ap.parse_args()

    s_files, serial, s_totals, s_secs = collect(args.serial)
    p_files, parallel, p_totals, p_secs = collect(args.parallel)
    describe("Serial", s_files, serial, s_totals, s_secs)
    describe("Parallel", p_files, parallel, p_totals, p_secs)
    if not serial or not parallel:
        print("FAIL: no test results in one of the runs")
        return 1

    diffs = []
    for name in sorted(set(serial) | set(parallel)):
        a, b = serial.get(name, ["(missing)"]), parallel.get(name, ["(missing)"])
        if a != b:
            diffs.append(f"  {name}\n    serial:   {'; '.join(a)}\n    parallel: {'; '.join(b)}")
    for key in ("Passed", "Failed", "Todo"):
        if s_totals.get(key) != p_totals.get(key):
            diffs.append(f"  summary {key}: serial {s_totals.get(key)} vs parallel {p_totals.get(key)}")
    if diffs:
        print(f"FAIL: {len(diffs)} differences")
        print("\n".join(diffs))
        return 1
    print(f"MATCH: all {len(serial)} test files have identical results "
          f"({s_totals.get('Passed')} passed, {s_totals.get('Todo')} todo)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
