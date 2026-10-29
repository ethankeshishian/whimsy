"""Whimsy's version: Zen's version plus a Whimsy revision, like 1.24b-w3.

  python3 whimsy/version.py              what this checkout would show
  python3 whimsy/version.py write <app>  put that into a built Whimsy.app

The Zen part is Zen's own version (surfer.json displayVersion, untouched by
the overlay). The revision counts Whimsy releases on that Zen version and
starts over at 1 when Zen's version changes. whimsy/version.json records the
last release and the history; publish.py adds an entry each time it publishes.

A build that isn't exactly a release shows the next version plus -dev and its
commit, like 1.24b-w4-dev (e169bef).

The app itself keeps Zen's version (application.ini, the user agent):
changing that recompiles nearly everything, and Firefox's updater orders
builds by build ID when versions match. The Whimsy version lives in
Contents/Resources/whimsy-version.json, which the browser reads.
"""
import datetime
import json
import os
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BUNDLE_FILE = "whimsy-version.json"
HISTORY_KEPT = 30


def path(repo):
    return os.path.join(repo, "whimsy", "version.json")


def load(repo):
    try:
        return json.load(open(path(repo)))
    except OSError:
        return {"zen": None, "revision": 0, "commit": None, "history": []}


def save(repo, data):
    with open(path(repo), "w") as f:
        json.dump(data, f, indent=2)
        f.write("\n")


def git(repo, *args):
    return subprocess.run(["git", *args], cwd=repo, capture_output=True, text=True).stdout.strip()


def zen_version(repo):
    surfer = json.load(open(os.path.join(repo, "surfer.json")))
    return surfer["brands"]["release"]["release"]["displayVersion"]


def firefox_version(repo):
    return json.load(open(os.path.join(repo, "surfer.json")))["version"]["version"]


def zen_label(repo):
    base = json.load(open(os.path.join(repo, "whimsy", "upstream.json")))
    return base.get("tag") or base.get("label")


def name(zen, revision):
    return f"{zen}-w{revision}"


def next_revision(data, zen):
    return data["revision"] + 1 if data.get("zen") == zen else 1


def is_release(repo, data):
    """True if HEAD is the last release (ignoring the version.json commit)."""
    commit = data.get("commit")
    if not commit or data.get("zen") != zen_version(repo):
        return False
    changed = subprocess.run(["git", "diff", "--quiet", commit, "--", ".", ":!whimsy/version.json"],
                             cwd=repo).returncode
    dirty = git(repo, "status", "--porcelain", "--untracked-files=no")
    return changed == 0 and not dirty


def describe(repo=ROOT):
    """What a build of this checkout is."""
    data = load(repo)
    zen = zen_version(repo)
    commit = git(repo, "rev-parse", "--short", "HEAD")
    if is_release(repo, data):
        version = name(zen, data["revision"])
    else:
        dirty = "+" if git(repo, "status", "--porcelain", "--untracked-files=no") else ""
        version = f"{name(zen, next_revision(data, zen))}-dev"
        commit += dirty
    return {
        "version": version,
        "zen": zen,
        "zen_label": zen_label(repo),
        "firefox": firefox_version(repo),
        "commit": commit,
        "released": not version.endswith("-dev"),
        "history": data.get("history", [])[:HISTORY_KEPT],
    }


def notes_since(repo, commit):
    """Commit subjects since the last release, oldest first."""
    if not commit:
        return []
    log = git(repo, "log", "--reverse", "--format=%s", f"{commit}..HEAD", "--", ".", ":!whimsy/version.json")
    return [line for line in log.splitlines() if line]


def next_release(repo=ROOT, notes_url=None):
    """The release publishing HEAD would make. Nothing is written."""
    data = load(repo)
    zen = zen_version(repo)
    revision = next_revision(data, zen)
    entry = {
        "version": name(zen, revision),
        "zen": zen,
        "zen_label": zen_label(repo),
        "firefox": firefox_version(repo),
        "date": datetime.date.today().isoformat(),
        "commit": git(repo, "rev-parse", "--short", "HEAD"),
        "notes": notes_since(repo, data.get("commit")),
    }
    if notes_url:
        entry["notes_url"] = notes_url
    info = dict(entry, released=True, history=[entry, *data.get("history", [])][:HISTORY_KEPT])
    return revision, info


def record_release(repo, revision, info):
    """Save a published release as the newest in whimsy/version.json."""
    data = load(repo)
    data.update(zen=info["zen"], revision=revision, commit=git(repo, "rev-parse", "HEAD"),
                history=info["history"])
    save(repo, data)


def write_bundle(app, info):
    resources = os.path.join(app, "Contents", "Resources")
    with open(os.path.join(resources, BUNDLE_FILE), "w") as f:
        json.dump(info, f, indent=2)
        f.write("\n")


def main():
    cmd = sys.argv[1] if len(sys.argv) > 1 else "describe"
    if cmd == "write" and len(sys.argv) > 2:
        info = describe()
        write_bundle(sys.argv[2], info)
        print(info["version"])
    elif cmd == "describe":
        print(json.dumps(describe(), indent=2))
    else:
        raise SystemExit(__doc__)


if __name__ == "__main__":
    main()
