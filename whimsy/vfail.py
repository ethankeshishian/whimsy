#!/usr/bin/env python3
"""Summarize verify failures without running tests (partial logs are OK)."""
import argparse
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
TEST = re.compile(r"(?:[\w.-]+/)*browser_[\w.-]+\.js")


def test_path(value):
    match = TEST.search(str(value))
    if not match:
        return None
    path = match[0]
    for prefix in ("zen/", "browser/"):
        if prefix in path:
            return path[path.index(prefix):]
    return path


def unexpected(event):
    status = event.get("status")
    # Mozlog omits expected when it equals status (including expected FAILs).
    expected = event.get("expected", status)
    return status != expected and status not in event.get("known_intermittent", [])


def collect(directory):
    tests = {}
    warnings = []

    def record(path):
        return tests.setdefault(path, {"failures": [], "flags": set(), "seconds": None})

    def note(path, subtest, message):
        if not path:
            return
        row = record(path)
        pair = (subtest, " ".join(str(message).split())[:200])
        if pair not in row["failures"]:
            row["failures"].append(pair)
        hints(path, f"{subtest} {message}", failure=True)

    def hints(path, message, failure=False):
        if not path:
            return
        flags = record(path)["flags"]
        if failure and re.search(r"TIMEOUT|timed out|50 tries", message, re.I):
            flags.add("load")
        if failure and re.search(r"stray (?:tab|window)|WHIMSY-LEAKCHECK leaked|start.*extra (?:tabs|windows)", message, re.I):
            flags.add("leak")
        marker = "WHIMSY-LEAKCHECK start "
        if marker in message:
            try:
                state = json.loads(message.split(marker, 1)[1])
                if state.get("tabs", 0) > 1 or state.get("windows", 0) > 1:
                    flags.add("leak(start-state)")
            except (ValueError, TypeError):
                pass

    log = directory / "whimsy.log"
    current = None
    starts = {}
    if log.exists():
        with log.open(errors="replace") as stream:
            for line in stream:
                stamp = re.match(r"\s*(\d+):(\d+\.\d+)", line)
                seconds = int(stamp[1]) * 60 + float(stamp[2]) if stamp else None
                if "TEST_START:" in line:
                    current = test_path(line)
                    starts[current] = seconds
                if "TEST_END:" in line and current:
                    start = starts.get(current)
                    if seconds is not None and start is not None:
                        record(current)["seconds"] = seconds - start
                    if re.search(r"Test (?:FAIL|TIMEOUT|ERROR|CRASH)", line):
                        note(current, "test_end", line.split("TEST_END:", 1)[1].strip())
                if line.startswith("FAIL "):
                    subtest, _, message = line[5:].strip().partition(" - ")
                    path = test_path(subtest) or current
                    duration = re.search(r"finished in (\d+)ms", message)
                    if duration and path:
                        record(path)["seconds"] = int(duration[1]) / 1000
                        note(path, "test_end", message)
                    else:
                        note(path, subtest, message)
                if "TEST-UNEXPECTED-" in line:
                    parts = line.strip().split(" | ", 2)
                    note(test_path(parts[1]) if len(parts) > 1 else current,
                         "harness", parts[-1])
                hints(current, line)
    else:
        warnings.append("whimsy.log missing")

    raws = sorted(directory.glob("*.raw"))
    # Only this run's raws: verify.sh clears the folder and touches
    # run-started.txt as it starts, so a raw older than that marker is from an
    # earlier run and would read as tonight's failure.
    marker = directory / "run-started.txt"
    if marker.exists():
        began = marker.stat().st_mtime
        stale = [raw for raw in raws if raw.stat().st_mtime < began]
        if stale:
            warnings.append(f"ignored {len(stale)} raw log(s) from an earlier run")
        raws = [raw for raw in raws if raw not in stale]
    for raw in raws:
        current = None
        starts = {}
        ended = set()
        malformed = 0
        with raw.open(errors="replace") as stream:
            for line in stream:
                try:
                    event = json.loads(line)
                except ValueError:
                    malformed += 1
                    continue
                if not isinstance(event, dict):
                    malformed += 1
                    continue
                action = event.get("action")
                path = test_path(event.get("test", ""))
                message = str(event.get("message", ""))
                if action == "test_start" and path:
                    current = path
                    starts[path] = event.get("time")
                    record(path)
                if action in ("test_status", "test_end") and path:
                    if unexpected(event):
                        note(path, event.get("subtest", "test_end"), message or event.get("status"))
                        hints(path, str(event.get("status", "")), failure=True)
                    if action == "test_end":
                        ended.add(path)
                        duration = re.search(r"finished in (\d+)ms", message)
                        start, end = starts.get(path), event.get("time")
                        if duration:
                            record(path)["seconds"] = int(duration[1]) / 1000
                        elif start is not None and end is not None:
                            record(path)["seconds"] = (end - start) / 1000
                        current = None
                hints(path or current, message)
        pending = set(starts) - ended
        if pending:
            warnings.append(f"{raw.name}: {len(pending)} unfinished test(s)")
        if malformed:
            warnings.append(f"{raw.name}: ignored {malformed} non-JSON/truncated line(s)")
    if not raws:
        warnings.append("no raw logs")
    return {path: row for path, row in tests.items() if row["failures"]}, raws, warnings


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--log-dir", type=Path, default=ROOT / ".surfer/verify")
    args = parser.parse_args()
    if not args.log_dir.is_dir():
        parser.error(f"not a log directory: {args.log_dir}")
    tests, raws, warnings = collect(args.log_dir)
    # A file that passed its retry didn't fail the run (verify.sh lists it in
    # flaky.txt); keep it out of failed.txt so the list is what blocked.
    flaky_list = args.log_dir / "flaky.txt"
    flaky_names = set(flaky_list.read_text().split()) if flaky_list.exists() else set()
    flaky = {path: tests.pop(path) for path in sorted(flaky_names) if path in tests}
    output = args.log_dir / "failed.txt"
    output.write_text("".join(path + "\n" for path in sorted(tests)))
    print(f"vfail: {len(tests)} failing file(s); whimsy.log + {len(raws)} raw log(s)")
    for path, row in sorted(tests.items()):
        duration = "?s" if row["seconds"] is None else f'{row["seconds"]:.2f}s'
        flags = ",".join(sorted(row["flags"])) or "unclassified"
        print(f"{path}  {duration}  [{flags}]")
        # Raw test_end adds duration, not another assertion; prefer subtest details.
        details = [pair for pair in row["failures"] if pair[0] != "test_end"]
        for subtest, message in details or row["failures"]:
            print(f"  {subtest}: {message}")
    for path in flaky:
        print(f"flaky (passed on retry): {path}")
    for warning in warnings:
        print(f"NOTE: {warning}")
    print(f"List: {output.relative_to(ROOT) if output.is_relative_to(ROOT) else output}")


if __name__ == "__main__":
    main()
