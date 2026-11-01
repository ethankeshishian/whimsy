#!/usr/bin/env python3
"""Compare per-test pass counts between two verify runs (e.g. serial vs parallel).

Usage:
  python3 whimsy/verify-compare.py <run1_log_or_dir> <run2_log_or_dir...>
  python3 whimsy/verify-compare.py --serial <files_or_dir> --parallel <files_or_dir>
  python3 whimsy/verify-compare.py  # defaults to .surfer/verify/whimsy.log vs .surfer/verify/whimsy-c*.log

Exits 0 if all tests in both runs have identical pass counts and coverage.
Exits 1 if there are missing tests or mismatched pass counts.
"""

import argparse
import glob
import os
import re
import sys

ANSI_RE = re.compile(r"\x1b\[[0-9;]*[a-zA-Z]|\x1b\([a-zA-Z]")
TEST_START_RE = re.compile(r"(?:^|\s)TEST_START:\s*(\S+)")
TEST_END_SUBTESTS_RE = re.compile(
    r"(?:^|\s)TEST_END:\s*Test\s+(\w+).*Subtests passed\s+(\d+)/(\d+)"
)
TEST_END_STATUS_RE = re.compile(r"(?:^|\s)TEST_END:\s*Test\s+(\w+)")
TEST_PASS_RE = re.compile(r"(?:^|\s)TEST-PASS\s*\|\s*([^|]+)")
TEST_OK_RE = re.compile(r"(?:^|\s)TEST-OK\s*\|\s*([^|]+)")
TOTAL_PASSED_RE = re.compile(r"INFO Passed:\s*(\d+)")
TOTAL_FAILED_RE = re.compile(r"INFO Failed:\s*(\d+)")


def normalize_test_name(raw_name):
    """Extract standard test filename from path or URL."""
    name = raw_name.strip().split()[0].split("?")[0]
    return os.path.basename(name)


def parse_log_file(filepath):
    """Parse a mochitest log file for per-test pass counts and overall totals.

    Returns:
        tuple: (dict of {test_name: pass_count}, dict of {'passed': int, 'failed': int})
    """
    tests = {}
    current_test = None
    curr_counted_passes = 0
    curr_subtest_passes = None
    curr_status = None
    totals = {"passed": None, "failed": None}

    def flush_current():
        nonlocal current_test, curr_counted_passes, curr_subtest_passes, curr_status
        if current_test:
            if curr_subtest_passes is not None:
                passes = curr_subtest_passes
            elif curr_counted_passes > 0:
                passes = curr_counted_passes
            elif curr_status in ("OK", "PASS"):
                passes = 1
            else:
                passes = 0
            # If test already seen (e.g. retry), keep highest pass count
            prev = tests.get(current_test, 0)
            tests[current_test] = max(prev, passes)
        current_test = None
        curr_counted_passes = 0
        curr_subtest_passes = None
        curr_status = None

    try:
        with open(filepath, "r", encoding="utf-8", errors="replace") as f:
            for line in f:
                clean = ANSI_RE.sub("", line).strip()

                m_tot_p = TOTAL_PASSED_RE.search(clean)
                if m_tot_p:
                    totals["passed"] = int(m_tot_p.group(1))
                m_tot_f = TOTAL_FAILED_RE.search(clean)
                if m_tot_f:
                    totals["failed"] = int(m_tot_f.group(1))

                m_start = TEST_START_RE.search(clean)
                if m_start:
                    flush_current()
                    current_test = normalize_test_name(m_start.group(1))
                    continue

                m_end_sub = TEST_END_SUBTESTS_RE.search(clean)
                if m_end_sub:
                    curr_status = m_end_sub.group(1)
                    curr_subtest_passes = int(m_end_sub.group(2))
                    continue

                m_end_stat = TEST_END_STATUS_RE.search(clean)
                if m_end_stat:
                    curr_status = m_end_stat.group(1)
                    continue

                m_pass = TEST_PASS_RE.search(clean)
                if m_pass:
                    if current_test:
                        curr_counted_passes += 1
                    else:
                        tname = normalize_test_name(m_pass.group(1))
                        tests[tname] = tests.get(tname, 0) + 1
                    continue

                m_ok = TEST_OK_RE.search(clean)
                if m_ok and not current_test:
                    tname = normalize_test_name(m_ok.group(1))
                    if tname not in tests:
                        tests[tname] = 1

            flush_current()
    except OSError as e:
        print(f"Warning: failed to read {filepath}: {e}", file=sys.stderr)

    return tests, totals


def collect_run_data(paths_or_globs):
    """Collect test results from multiple files, directories, or globs."""
    resolved_files = []
    for item in paths_or_globs:
        if os.path.isdir(item):
            resolved_files.extend(sorted(glob.glob(os.path.join(item, "*.log"))))
        else:
            matches = glob.glob(item)
            if matches:
                resolved_files.extend(sorted(matches))
            elif os.path.isfile(item):
                resolved_files.append(item)

    # De-duplicate while preserving order
    unique_files = []
    seen = set()
    for f in unique_files:
        norm = os.path.abspath(f)
        if norm not in seen:
            seen.add(norm)
            unique_files.append(f)

    all_tests = {}
    sum_totals_passed = 0
    sum_totals_failed = 0
    has_totals = False

    for f in resolved_files:
        norm = os.path.abspath(f)
        if norm in seen:
            continue
        seen.add(norm)
        unique_files.append(f)

        tests, totals = parse_log_file(f)
        for t, count in tests.items():
            all_tests[t] = max(all_tests.get(t, 0), count)
        if totals["passed"] is not None:
            sum_totals_passed += totals["passed"]
            has_totals = True
        if totals["failed"] is not None:
            sum_totals_failed += totals["failed"]
            has_totals = True

    return {
        "files": unique_files,
        "tests": all_tests,
        "total_passed_summary": sum_totals_passed if has_totals else None,
        "total_failed_summary": sum_totals_failed if has_totals else None,
    }


def compare_runs(run1_data, run2_data, name1="Run 1 (Serial)", name2="Run 2 (Parallel)"):
    """Compare two sets of test results."""
    tests1 = run1_data["tests"]
    tests2 = run2_data["tests"]

    set1 = set(tests1.keys())
    set2 = set(tests2.keys())

    only1 = sorted(set1 - set2)
    only2 = sorted(set2 - set1)
    common = sorted(set1 & set2)

    matches = []
    mismatches = []
    for t in common:
        c1 = tests1[t]
        c2 = tests2[t]
        if c1 == c2:
            matches.append((t, c1))
        else:
            mismatches.append((t, c1, c2))

    total_passes1 = sum(tests1.values())
    total_passes2 = sum(tests2.values())

    print("=" * 60)
    print("Whimsy Verify Compare: Serial vs Parallel Equality Check")
    print("=" * 60)
    files1_desc = ", ".join(os.path.basename(f) for f in run1_data["files"][:5])
    if len(run1_data["files"]) > 5:
        files1_desc += f"... (+{len(run1_data['files']) - 5} more)"
    print(f"{name1}:")
    print(f"  Files ({len(run1_data['files'])}): {files1_desc or '(none)'}")
    print(f"  Distinct tests: {len(tests1)}, Total passes: {total_passes1}")
    if run1_data["total_passed_summary"] is not None:
        print(
            f"  Summary counts: passed={run1_data['total_passed_summary']}, failed={run1_data['total_failed_summary']}"
        )

    files2_desc = ", ".join(os.path.basename(f) for f in run2_data["files"][:5])
    if len(run2_data["files"]) > 5:
        files2_desc += f"... (+{len(run2_data['files']) - 5} more)"
    print(f"\n{name2}:")
    print(f"  Files ({len(run2_data['files'])}): {files2_desc or '(none)'}")
    print(f"  Distinct tests: {len(tests2)}, Total passes: {total_passes2}")
    if run2_data["total_passed_summary"] is not None:
        print(
            f"  Summary counts: passed={run2_data['total_passed_summary']}, failed={run2_data['total_failed_summary']}"
        )

    print("\nComparison Results:")
    print(f"  Common tests matching exactly: {len(matches)}/{len(common)}")

    diff_found = False

    if mismatches:
        diff_found = True
        print(f"\n  [MISMATCH] {len(mismatches)} tests had differing pass counts:")
        for t, c1, c2 in mismatches[:20]:
            print(f"    {t}: {name1}={c1} vs {name2}={c2} (diff: {c2 - c1:+d})")
        if len(mismatches) > 20:
            print(f"    ... and {len(mismatches) - 20} more.")

    if only1:
        diff_found = True
        print(f"\n  [MISSING in {name2}] {len(only1)} tests only in {name1}:")
        for t in only1[:15]:
            print(f"    {t} (had {tests1[t]} passes in {name1})")
        if len(only1) > 15:
            print(f"    ... and {len(only1) - 15} more.")

    if only2:
        diff_found = True
        print(f"\n  [MISSING in {name1}] {len(only2)} tests only in {name2}:")
        for t in only2[:15]:
            print(f"    {t} (had {tests2[t]} passes in {name2})")
        if len(only2) > 15:
            print(f"    ... and {len(only2) - 15} more.")

    print("=" * 60)
    if not diff_found and len(matches) > 0:
        print(
            f"SUCCESS: Perfect match! All {len(matches)} tests have identical pass counts ({total_passes1} total passes)."
        )
        return 0
    elif len(matches) == 0 and not set1 and not set2:
        print("ERROR: No test results found in either run.")
        return 1
    else:
        print(
            f"FAILURE: Runs differ! ({len(mismatches)} count mismatches, {len(only1)} missing in run 2, {len(only2)} missing in run 1)"
        )
        return 1


def main():
    parser = argparse.ArgumentParser(
        description="Compare per-test pass counts between serial and parallel verify runs."
    )
    parser.add_argument(
        "--serial",
        "-s",
        nargs="+",
        help="Path(s), directory, or glob for serial run logs.",
    )
    parser.add_argument(
        "--parallel",
        "-p",
        nargs="+",
        help="Path(s), directory, or glob for parallel run logs.",
    )
    parser.add_argument(
        "paths",
        nargs="*",
        help="Run 1 log/dir followed by Run 2 log(s)/dir.",
    )
    args = parser.parse_args()

    run1_paths = []
    run2_paths = []

    if args.serial and args.parallel:
        run1_paths = args.serial
        run2_paths = args.parallel
    elif len(args.paths) >= 2:
        run1_paths = [args.paths[0]]
        run2_paths = args.paths[1:]
    elif len(args.paths) == 1:
        run1_paths = [args.paths[0]]
        run2_paths = glob.glob(".surfer/verify/*-c*.log")
    else:
        # Default discovery
        if os.path.exists(".surfer/verify-serial"):
            run1_paths = [".surfer/verify-serial"]
        elif os.path.exists(".surfer/verify/whimsy.log"):
            run1_paths = [".surfer/verify/whimsy.log"]
        else:
            run1_paths = [".surfer/verify/whimsy.log"]

        parallel_chunks = glob.glob(".surfer/verify/*-c*.log")
        if parallel_chunks:
            run2_paths = parallel_chunks
        elif os.path.exists(".surfer/verify-parallel"):
            run2_paths = [".surfer/verify-parallel"]
        else:
            run2_paths = glob.glob(".surfer/verify/*.log")

    run1_data = collect_run_data(run1_paths)
    run2_data = collect_run_data(run2_paths)

    if not run1_data["files"]:
        print(
            f"Error: No log files found for Run 1 from paths: {run1_paths}",
            file=sys.stderr,
        )
        sys.exit(1)
    if not run2_data["files"]:
        print(
            f"Error: No log files found for Run 2 from paths: {run2_paths}",
            file=sys.stderr,
        )
        sys.exit(1)

    rc = compare_runs(run1_data, run2_data)
    sys.exit(rc)


if __name__ == "__main__":
    main()
