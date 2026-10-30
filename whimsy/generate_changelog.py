"""Package reviewed release notes; never infer shipped features from work logs.

Edit whimsy/changelog.json for dev builds, then run this script and commit both
source and generated data. Published history comes from whimsy/version.json.
Use --check to detect stale packaged notes without writing files.
"""
import argparse
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "src/zen/whimsy/content/whimsy-changelog.json"


def generate(root=ROOT):
    groups = json.loads((root / "whimsy/changelog.json").read_text())["groups"]
    history = json.loads((root / "whimsy/version.json").read_text())["history"]
    seen = set()
    result = []
    for group in groups + [dict(version=v["version"], entries=v["notes"]) for v in history]:
        version, entries = group["version"], group["entries"]
        if not isinstance(version, str) or not version.strip():
            raise ValueError("Every version must have a name")
        if version in seen:
            raise ValueError(f"Duplicate version: {version}")
        if not isinstance(entries, list) or not entries or any(
            not isinstance(line, str) or not line.strip() for line in entries
        ):
            raise ValueError(f"Invalid release notes: {version}")
        seen.add(version)
        result.append({"version": version, "entries": list(dict.fromkeys(entries))})
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
