"""What source the shared engine objdir was last built from.

Lanes share one objdir. engine/zen/* are links into the main checkout's src/,
which goes back to dev after every lane, and patched upstream files keep the
last import. So the build a lane needs depends on what the engine last BUILT,
not only on the lane's diff against dev: after a lane that changed
components.conf, IDL or patches (W26 passkeys), the next front-end-only lane
tested a stale XUL or raced `build binaries` against regenerated headers
(every test red 2026-11-13 21:36-22:58).

The record is .surfer/verify/engine-built.json in the main checkout:

    {"state": "built" | "building" | "unknown", "commit", "tree", "kind",
     "at", "by", "updater_at"}

lane.sh and verify-dev.sh write "building" before a build and "built" after
it succeeds (and pin the commit at refs/whimsy/engine-built); a ticket queued by hand that builds (queue.sh) writes "unknown".
Builds the updater makes (npm run ship, the nightly, npm run build) keep
their own record, .surfer/verify/build.json, which begin_build deletes and
record_build rewrites; `updater_at` is that file's "at" when we last wrote
ours, so a newer one means the updater built after us (its commit counts if
the tree was clean) and a missing one means it started a build that did not
finish. Anything unclear is unknown, and unknown means a full build.

    python3 whimsy/tools/buildstate.py base                print the built commit, or nothing
    python3 whimsy/tools/buildstate.py need [--to REF] [--at-least KIND]
                                                           KIND<TAB>why (max of the two rules)
    python3 whimsy/tools/buildstate.py begin [REF] [--by NAME]
    python3 whimsy/tools/buildstate.py record [REF] [--kind KIND] [--by NAME]
    python3 whimsy/tools/buildstate.py invalidate [--by NAME]
    python3 whimsy/tools/buildstate.py show

The root is $WHIMSY_ROOT, else $WHIMSY_MAIN, else the current folder.
"""
import datetime
import json
import os
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import buildkind  # noqa: E402

RECORD = os.path.join(".surfer", "verify", "engine-built.json")
UPDATER_RECORD = os.path.join(".surfer", "verify", "build.json")
PIN = "refs/whimsy/engine-built"


def root():
    return os.environ.get("WHIMSY_ROOT") or os.environ.get("WHIMSY_MAIN") or os.getcwd()


def _git(repo, *args):
    r = subprocess.run(["git", *args], cwd=repo, capture_output=True, text=True)
    return r.stdout.strip() if r.returncode == 0 else None


def _now():
    return datetime.datetime.now().astimezone().isoformat(timespec="seconds")


def _when(text):
    try:
        t = datetime.datetime.fromisoformat(text)
    except (TypeError, ValueError):
        return None
    return t if t.tzinfo else t.astimezone()


def _read(path):
    try:
        with open(path) as f:
            value = json.load(f)
        return value if isinstance(value, dict) else None
    except (OSError, ValueError):
        return None


def _write(repo, value):
    path = os.path.join(repo, RECORD)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path + ".tmp", "w") as f:
        json.dump(value, f, indent=2)
    os.replace(path + ".tmp", path)


def _commit(repo, ref):
    return _git(repo, "rev-parse", "-q", "--verify", f"{ref}^{{commit}}")


def begin(repo, ref="HEAD", by=""):
    """Before a build: until it succeeds the engine is in no known state."""
    _write(repo, {"state": "building", "commit": _commit(repo, ref), "at": _now(), "by": by})


def record(repo, ref="HEAD", kind="", by=""):
    """After a successful build of `ref` (the tree that was imported)."""
    sha = _commit(repo, ref)
    if not sha:
        return invalidate(repo, by=f"{by} (could not resolve {ref})")
    updater = _read(os.path.join(repo, UPDATER_RECORD))
    # A lane's merge commit is only kept at refs/tested/<lane> until that
    # lane runs again; pin it so gc never takes the base of the next diff.
    _git(repo, "update-ref", PIN, sha)
    _write(repo, {"state": "built", "commit": sha, "tree": _git(repo, "rev-parse", f"{sha}^{{tree}}"),
                  "kind": kind, "at": _now(), "by": by,
                  "updater_at": updater.get("at") if updater else None})


def invalidate(repo, by=""):
    """Something built (or half-built) the engine from an unknown tree."""
    _write(repo, {"state": "unknown", "at": _now(), "by": by})


def base(repo):
    """(commit the engine was last fully built from, or None; why)."""
    rec = _read(os.path.join(repo, RECORD))
    updater = _read(os.path.join(repo, UPDATER_RECORD))
    if not rec:
        return None, "no engine build is recorded"
    rec_at, up_at = _when(rec.get("at")), _when((updater or {}).get("at"))
    if updater and up_at and updater.get("at") != rec.get("updater_at") and (rec_at is None or up_at > rec_at):
        if updater.get("dirty"):
            return None, f"the updater built at {updater.get('at')} with uncommitted changes"
        sha = updater.get("commit")
        if sha and _commit(repo, sha):
            return sha, f"the updater's build at {updater.get('at')}"
        return None, f"the updater's build at {updater.get('at')} names an unknown commit"
    state = rec.get("state")
    if state != "built":
        return None, f"the last engine build is {state or 'unrecorded'} ({rec.get('by') or '?'} at {rec.get('at')})"
    if not updater and rec.get("updater_at"):
        return None, "the updater started a build after ours that never finished"
    sha = rec.get("commit")
    if sha and _commit(repo, sha):
        return sha, f"{rec.get('by') or 'a build'} at {rec.get('at')}"
    tree = rec.get("tree")
    if tree and _git(repo, "rev-parse", "-q", "--verify", f"{tree}^{{tree}}"):
        return tree, f"tree {tree[:12]} ({rec.get('by') or 'a build'} at {rec.get('at')})"
    return None, f"the recorded commit {str(sha)[:12]} is not in the repository"


def need(repo, to="HEAD", at_least="faster"):
    """(kind, why): the larger of `at_least` (the lane's diff against dev)
    and the build the diff between the last engine build and `to` needs."""
    at_least = at_least if at_least in buildkind.ORDER else "faster"
    built, why = base(repo)
    if not built:
        return "full", f"FULL build: {why}"
    kind, text = buildkind.needed_between(built, to, cwd=repo)
    if buildkind.ORDER.index(kind) > buildkind.ORDER.index(at_least):
        return kind, f"since the engine's last build ({str(built)[:12]}, {why}): {text}"
    return at_least, f"the lane's own diff (engine last built from {str(built)[:12]}, {why}, needs {kind})"


def main(argv):
    if not argv:
        print(__doc__)
        return 2
    cmd, args = argv[0], argv[1:]

    def opt(name, default=""):
        if name in args:
            i = args.index(name)
            value = args[i + 1] if i + 1 < len(args) else default
            del args[i:i + 2]
            return value
        return default
    by, kind, to, at_least = opt("--by"), opt("--kind"), opt("--to", "HEAD"), opt("--at-least", "faster")
    ref = args[0] if args else "HEAD"
    repo = root()
    if cmd == "begin":
        begin(repo, ref, by)
    elif cmd == "record":
        record(repo, ref, kind, by)
    elif cmd == "invalidate":
        invalidate(repo, by)
    elif cmd == "base":
        sha, _why = base(repo)
        if sha:
            print(sha)
    elif cmd == "need":
        k, why = need(repo, to, at_least)
        print(f"{k}\t{why}")
    elif cmd == "show":
        sha, why = base(repo)
        print(json.dumps({"base": sha, "why": why, "record": _read(os.path.join(repo, RECORD))}, indent=2))
    else:
        print(f"buildstate: unknown command {cmd}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
