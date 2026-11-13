"""Runs before `surfer import`: puts the engine back to what the incoming
patch set expects, so patches re-apply cleanly and nothing stale survives.

1. Stale files. Lanes share one engine checkout, so an import can follow an
   import of a branch with patches or src/ files this one doesn't have. surfer
   only ever applies, so those files would stay patched (a lane's
   whimsy-nsXPLookAndFeel-cpp.patch kept including a header dev doesn't have,
   and dev's full build failed). Every engine path a patch or a src/ link has
   ever touched (in any ref of this repository, or in the previous import)
   that the incoming set doesn't own is put back to Firefox's version: a
   modified tracked file is checked out from the engine's HEAD, a file a
   patch created or a src/ symlink is removed. Only those paths are looked
   at, so other import steps' files and the build folders (obj-*) are left
   alone.

2. Changed patches. surfer re-applies a patch by reverse-applying the patch's
   *new* contents, then applying it. When a patch changed (a Zen release, or
   Whimsy's overlay editing one), the reverse step fails silently and the
   apply then fails. Changed patches and connected groups of overlapping
   patches are restored to Firefox's version, so surfer applies them fresh.
   Independent unchanged patches are left alone.

Restoring a file gives it a new timestamp even when the import writes back
exactly the same contents, which would rebuild everything that depends on it.
So every restored file's contents hash and timestamp are recorded, and
`engine_prepare.py --finish` (the import's last step) gives each file that
ended up byte-identical its old timestamp back.
"""
import glob
import hashlib
import json
import os
import re
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ENGINE = os.path.join(ROOT, "engine")
ARGS = ["--ignore-space-change", "--ignore-whitespace"]
STATE = "whimsy-prepare.json"  # inside engine/.git, so it's never an untracked file
DIFF_TARGET = re.compile(r"^diff --git a/(\S+) b/", re.M)
# A patch file's own lines inside `git log -p`, prefixed with + - or space.
LOGGED_TARGET = re.compile(r"^[-+ ]diff --git a/(\S+) b/", re.M)


def targets(patch):
    with open(patch, encoding="utf-8", errors="replace") as source:
        return DIFF_TARGET.findall(source.read())


def git(*args, cwd=None, stdin=None, check=False):
    return subprocess.run(["git", *args], cwd=cwd or ENGINE, input=stdin, capture_output=True,
                          check=check)


def literal(*args, paths, cwd=None, check=False):
    """`git <args> -- <paths>` with the paths taken literally, in chunks."""
    paths, out, rc = sorted(paths), b"", 0
    for start in range(0, len(paths), 500):
        run = subprocess.run(["git", "--literal-pathspecs", *args, "--", *paths[start:start + 500]],
                             cwd=cwd or ENGINE, capture_output=True, check=check)
        out, rc = out + run.stdout, rc or run.returncode
    return subprocess.CompletedProcess(args, rc, out, b"")


def in_head(paths):
    """The subset of `paths` the engine's HEAD tracks."""
    paths = sorted(paths)
    if not paths:
        return set()
    run = git("cat-file", "--batch-check=%(objectname)", stdin="".join(f"HEAD:{p}\n" for p in paths).encode(),
              check=True)
    lines = run.stdout.decode("utf-8", "replace").splitlines()
    return {p for p, line in zip(paths, lines) if not line.endswith(" missing")}


def state_path():
    return os.path.join(ENGINE, ".git", STATE)


def load_state():
    try:
        with open(state_path(), encoding="utf-8") as source:
            return json.load(source)
    except (OSError, ValueError):
        return {}


def save_state(state):
    tmp = state_path() + ".tmp"
    with open(tmp, "w", encoding="utf-8") as out:
        json.dump(state, out, indent=1, sort_keys=True)
    os.replace(tmp, state_path())


def link_path(rel):
    """The engine path surfer links src/<rel> to, or None for files it skips."""
    if rel.endswith(".patch") or "node_modules" in rel.split("/"):
        return None
    return rel


def current_links():
    src = os.path.join(ROOT, "src")
    links = set()
    for path in glob.glob(os.path.join(src, "**", "*"), recursive=True):
        if os.path.isfile(path):
            rel = link_path(os.path.relpath(path, src).replace(os.sep, "/"))
            if rel:
                links.add(rel)
    return links


def history():
    """Engine paths any patch or src/ file in this repository's refs touched."""
    patched, linked = set(), set()
    log = git("log", "--all", "-p", "--format=", "--", "src/*.patch", cwd=ROOT)
    if log.returncode == 0:
        patched = set(LOGGED_TARGET.findall(log.stdout.decode("utf-8", "replace")))
    names = git("log", "--all", "--name-only", "--format=", "--", "src", cwd=ROOT)
    if names.returncode == 0:
        for name in names.stdout.decode("utf-8", "replace").splitlines():
            rel = link_path(name[len("src/"):]) if name.startswith("src/") else None
            if rel:
                linked.add(rel)
    return patched, linked


def safe(rel):
    parts = rel.split("/")
    return rel and not rel.startswith("/") and ".." not in parts and not parts[0].startswith(("obj-", ".git"))


def fingerprint(rel):
    """(sha256, mtime_ns) of a regular file, or None (missing, symlink)."""
    path = os.path.join(ENGINE, rel)
    if os.path.islink(path) or not os.path.isfile(path):
        return None
    with open(path, "rb") as source:
        digest = hashlib.sha256(source.read()).hexdigest()
    return [digest, os.stat(path).st_mtime_ns]


def restore(files, records):
    """Checks tracked `files` out from HEAD, recording what they were."""
    files = sorted(set(files))
    if not files:
        return
    for rel in files:
        if rel not in records:
            seen = fingerprint(rel)
            if seen:
                records[rel] = seen
    literal("checkout", "HEAD", paths=files, check=True)


def clear_stale(owned, previous, records):
    """Puts back every once-patched or once-linked path the incoming set doesn't own."""
    patched, linked = history()
    patched |= set(previous.get("targets", []))
    linked |= set(previous.get("links", []))
    candidates = {p for p in (patched | linked) - owned if safe(p)}
    if not candidates:
        return [], []
    tracked = in_head(candidates)
    changed = (literal("diff", "--name-only", "--no-renames", "HEAD", paths=tracked, check=True)
               .stdout.decode().splitlines() if tracked else [])
    restore(changed, records)
    removed = []
    for rel in sorted(candidates - tracked):
        path = os.path.join(ENGINE, rel)
        # A src/ link is a symlink; a file a patch created is a plain file.
        if os.path.islink(path) or (rel in patched and os.path.isfile(path)):
            os.remove(path)
            removed.append(rel)
    return changed, removed


def summary(label, files):
    return (f"{len(files)} {label}"
            + (f" ({', '.join(files[:5])}{'…' if len(files) > 5 else ''})" if files else ""))


def expected_blobs(groups):
    """{path: blob} of every group's files after applying its patches to HEAD.

    Works in a scratch index holding only those paths, so it is quick and
    never touches the engine's own index or files. A group whose patches
    don't apply to HEAD maps its files to None (it is restored either way)."""
    index = os.path.join(ENGINE, ".git", "whimsy-prepare.index")
    env = dict(os.environ, GIT_INDEX_FILE=index)
    files = set().union(*(group[1] for group in groups)) if groups else set()

    def reset():
        if os.path.exists(index):
            os.remove(index)
        tree = literal("ls-tree", "-r", "-z", "--full-tree", "HEAD", paths=files).stdout
        subprocess.run(["git", "update-index", "-z", "--index-info"], cwd=ENGINE, env=env, input=tree,
                       capture_output=True, check=True)

    def apply(patches):
        return subprocess.run(["git", "apply", "--cached", *ARGS, *patches], cwd=ENGINE, env=env,
                              capture_output=True).returncode == 0

    failed = set()
    try:
        reset()
        if not apply([patch for group in groups for patch in sorted(group[0])]):
            # One bad group fails the batch: apply them one by one instead.
            reset()
            for members, group_files in groups:
                if not apply(sorted(members)):
                    failed |= group_files
        listed = subprocess.run(["git", "ls-files", "-s", "-z"], cwd=ENGINE, env=env,
                                capture_output=True, check=True).stdout.decode("utf-8", "replace")
    finally:
        if os.path.exists(index):
            os.remove(index)
    blobs = {}
    for entry in filter(None, listed.split("\0")):
        meta, path = entry.split("\t", 1)
        blobs[path] = meta.split()[1]
    for path in failed:
        blobs[path] = "unappliable"
    return blobs


def actual_blobs(files):
    """{path: blob} of the engine's working files (None when missing)."""
    files = sorted(files)
    present = [f for f in files if os.path.isfile(os.path.join(ENGINE, f))]
    hashed = git("hash-object", "--stdin-paths", stdin="".join(f + "\n" for f in present).encode(),
                 check=True).stdout.decode().split() if present else []
    blobs = dict.fromkeys(files)
    blobs.update(zip(present, hashed))
    return blobs


def main():
    if not os.path.isdir(os.path.join(ENGINE, ".git")):
        print("engine_prepare: no engine yet, skipping")
        return
    patches = sorted(glob.glob(os.path.join(ROOT, "src", "**", "*.patch"), recursive=True))
    patch_targets = {patch: set(targets(patch)) for patch in patches}
    owned_targets = set().union(*patch_targets.values())
    links = current_links()
    previous = load_state()
    records = {}

    stale, removed = clear_stale(owned_targets | links, previous, records)

    # Patches sharing a file form one unit. An individual reverse check is
    # meaningless when another patch changes its context, and restoring just
    # that patch's targets leaves the rest of the unit partially applied.
    groups = []
    for patch in patches:
        files = set(patch_targets[patch])
        connected = [group for group in groups if group[1] & files]
        members = [patch]
        for group in connected:
            members += group[0]
            files |= group[1]
            groups.remove(group)
        groups.append((members, files))

    expected = expected_blobs(groups)
    actual = actual_blobs(set().union(*(g[1] for g in groups if len(g[0]) == 1)) if groups else set())
    restored = []
    for members, targets_in_group in groups:
        # A lone patch is left alone only when its files are exactly HEAD plus
        # this patch. A reverse check isn't enough: another branch's patch to
        # the same file (a lane's whimsy-nsImageFrame-cpp.patch next to Zen's
        # nsImageFrame-cpp.patch) can sit on top and still let it reverse.
        if len(members) == 1 and all(expected.get(f) == actual[f] for f in targets_in_group):
            continue
        # Always replay overlapping patches together, in surfer's normal
        # order, rather than asking surfer to reverse them independently.
        files = sorted(f for f in targets_in_group
                       if git("cat-file", "-e", f"HEAD:{f}").returncode == 0)
        if files:
            restore(files, records)
            restored += files

    save_state({"targets": sorted(owned_targets), "links": sorted(links), "restored": records})
    print("engine_prepare: restored " + summary("files no patch or link owns any more", stale)
          + ", removed " + summary("stale created files or links", removed)
          + ", restored " + summary("files for changed patches", restored))


def finish():
    """After the import: byte-identical restored files get their old timestamps back."""
    if not os.path.isdir(os.path.join(ENGINE, ".git")):
        return
    state = load_state()
    kept = []
    for rel, (digest, mtime_ns) in sorted(state.get("restored", {}).items()):
        now = fingerprint(rel)
        if now and now[0] == digest and now[1] != mtime_ns:
            path = os.path.join(ENGINE, rel)
            os.utime(path, ns=(os.stat(path).st_atime_ns, mtime_ns))
            kept.append(rel)
    state["restored"] = {}
    save_state(state)
    print(f"engine_prepare: kept the timestamps of {len(kept)} unchanged restored files")


if __name__ == "__main__":
    finish() if sys.argv[1:] == ["--finish"] else main()
