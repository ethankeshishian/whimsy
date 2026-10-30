"""Package reviewed release notes; never infer shipped features from work logs.

Edit whimsy/changelog.json for dev builds, then run this script and commit both
source and generated data. Published history comes from whimsy/version.json:
it supplies each release's date, and a release with no reviewed entry shows
its published notes under "New". Use --check to detect stale packaged notes
without writing files.

Each reviewed group: {"version", "date"?, "title"?, "new"?, "improved"?,
"fixed"?}; every list holds short, plain sentences.
"""
import argparse
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "src/zen/whimsy/content/whimsy-changelog.json"
KINDS = ("new", "improved", "fixed")


def _lines(version, kind, value):
    if value is None:
        return []
    if not isinstance(value, list) or any(not isinstance(line, str) or not line.strip() for line in value):
        raise ValueError(f"Invalid release notes: {version} ({kind})")
    return list(dict.fromkeys(line.strip() for line in value))


def generate(root=ROOT):
    groups = json.loads((root / "whimsy/changelog.json").read_text())["groups"]
    history = json.loads((root / "whimsy/version.json").read_text())["history"]
    dates = {h["version"]: h.get("date") for h in history}
    seen = set()
    result = []
    for group in groups + [dict(version=h["version"], new=h["notes"]) for h in history]:
        version = group.get("version")
        if not isinstance(version, str) or not version.strip():
            raise ValueError("Every version must have a name")
        if version in seen:
            if group in groups:
                raise ValueError(f"Duplicate version: {version}")
            continue  # A reviewed entry already covers this release.
        seen.add(version)
        build = {"version": version}
        date = group.get("date") or dates.get(version)
        if date is not None:
            if not isinstance(date, str) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", date):
                raise ValueError(f"Date must be YYYY-MM-DD: {version}")
            build["date"] = date
        if group.get("title"):
            build["title"] = group["title"].strip()
        for kind in KINDS:
            lines = _lines(version, kind, group.get(kind))
            if lines:
                build[kind] = lines
        if not any(kind in build for kind in KINDS):
            raise ValueError(f"Invalid release notes: {version}")
        result.append(build)
    # Newest first; a build with no date yet (Unreleased) leads.
    result.sort(key=lambda b: b.get("date", "9999-99-99"), reverse=True)
    return {"groups": result}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    data = json.dumps(generate(), indent=2) + "\n"
    if args.check:
        if OUT.read_text(encoding="utf-8") != data:
            parser.exit(1, "Changelog is stale: run python3 whimsy/generate_changelog.py\n")
    else:
        OUT.write_text(data, encoding="utf-8")
        print(f"Wrote {OUT.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
