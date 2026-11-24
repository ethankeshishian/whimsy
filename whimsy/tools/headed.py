"""Which test files must run headed, from the browser.toml tags.

    python3 whimsy/tools/headed.py [--engine DIR] files PATH...
    python3 whimsy/tools/headed.py [--engine DIR] suite SUITE_DIR...
    python3 whimsy/tools/headed.py [--engine DIR] check SUITE_DIR...

A test that needs a real window (WKWebView, native key events, window
levels) carries `tags = "whimsy-headed"` and `skip-if = ["headless"]` in its
browser.toml. The headless runs skip it, and the runners (tools/test.sh,
verify.sh, verify-parallel.sh, vrerun.sh) run it in a separate headed
harness run, so its coverage never vanishes into a skip.

`files` prints which of the given engine-relative test paths are tagged
whimsy-headed. `suite` prints every tagged file in the suites. `check` exits
1, naming the entry, when a file is skipped headless without a whimsy-headed
tag (nothing would run it) or tagged without being skipped headless (the
headless run would run it too). `whimsy-manual` marks a file the owner runs
by hand (it needs a macOS permission a test run can't grant).
"""
import os
import sys
import tomllib

HEADED = "whimsy-headed"
MANUAL = "whimsy-manual"


def entries(engine, suite):
    path = os.path.join(engine, suite, "browser.toml")
    if not os.path.exists(path):
        return {}
    with open(path, "rb") as f:
        manifest = tomllib.load(f)
    return {k: v for k, v in manifest.items() if k != "DEFAULT" and isinstance(v, dict)}


def tags(entry):
    raw = entry.get("tags", "")
    if isinstance(raw, list):
        raw = " ".join(raw)
    return set(raw.split())


def skipped_headless(entry):
    skip = entry.get("skip-if", [])
    if isinstance(skip, str):
        skip = [skip]
    return any(s.strip() == "headless" for s in skip)


def main(argv):
    engine = "."
    if argv[:1] == ["--engine"]:
        engine, argv = argv[1], argv[2:]
    if not argv or argv[0] not in ("files", "suite", "check"):
        sys.exit(__doc__)
    cmd, args = argv[0], argv[1:]
    if cmd == "files":
        cache = {}
        for f in args:
            suite, name = os.path.dirname(f), os.path.basename(f)
            if suite not in cache:
                cache[suite] = entries(engine, suite)
            if HEADED in tags(cache[suite].get(name, {})):
                print(f)
        return 0
    if cmd == "suite":
        for suite in args:
            for name, entry in entries(engine, suite).items():
                if HEADED in tags(entry):
                    print(f"{suite}/{name}")
        return 0
    bad = 0
    for suite in args:
        for name, entry in entries(engine, suite).items():
            t, skip = tags(entry), skipped_headless(entry)
            if skip and not (t & {HEADED, MANUAL}):
                print(f"{suite}/{name}: skip-if headless without tags = \"{HEADED}\", so no run executes it")
                bad = 1
            if HEADED in t and not skip:
                print(f"{suite}/{name}: tagged {HEADED} without skip-if = [\"headless\"], so the headless run executes it too")
                bad = 1
    return bad


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
