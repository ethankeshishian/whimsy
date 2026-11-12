"""Whimsy's whimsy-*.patch files: check that they apply, and merge them.

A whimsy-*.patch is a diff on top of Zen's own patch for the same engine file
(Zen's patch, if any, is the same name without the whimsy- prefix, in the same
folder). Git's text merge of two lanes' edits to such a patch produces hunks
that no longer apply (W24 lost two 25-minute builds and four hand merges to
whimsy-Tabbrowser-sys-mjs.patch). Both tools here work on the *patched source*
instead of the patch text:

  check: pristine engine file + Zen's patch, then `git apply --check` ours.
  merge: apply base/ours/theirs to that source, `git merge-file` the three
         results, and write the diff back as the patch (a git merge driver).

    python3 whimsy/tools/patchtools.py check [PATCH...]        # all if none
    python3 whimsy/tools/patchtools.py merge %O %A %B %P        # from git
    python3 whimsy/tools/patchtools.py targets PATCH            # engine paths

The engine is $WHIMSY_ENGINE, else <repo>/engine (a git checkout of Firefox
whose HEAD is the pristine tree).
"""
import glob
import os
import re
import subprocess
import sys
import tempfile

ROOT = os.environ.get("WHIMSY_ROOT") or os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
ENGINE = os.environ.get("WHIMSY_ENGINE") or os.path.join(ROOT, "engine")
APPLY_ARGS = ["--ignore-space-change", "--ignore-whitespace"]


def targets(text):
    """Engine paths a patch touches, from its --- a/ lines (falls back to
    diff --git headers)."""
    out = re.findall(r"^--- a/(\S+)", text, re.M)
    if not out:
        out = re.findall(r"^diff --git a/(\S+) b/", text, re.M)
    seen, uniq = set(), []
    for t in out:
        if t not in seen:
            seen.add(t)
            uniq.append(t)
    return uniq


def zen_patch_for(patch_path):
    """Zen's own patch for the same file (applied before ours), or None."""
    folder, name = os.path.split(patch_path)
    if not name.startswith("whimsy-"):
        return None
    zen = os.path.join(folder, name[len("whimsy-"):])
    return zen if os.path.exists(zen) else None


def pristine(engine, rel):
    """The engine file as Firefox ships it (engine HEAD), or None."""
    r = subprocess.run(["git", "-C", engine, "show", f"HEAD:{rel}"], capture_output=True)
    return r.stdout if r.returncode == 0 else None


def apply_text(work, rel, patch_text):
    """Apply patch text to <work>/<rel>. Returns (ok, message)."""
    with tempfile.NamedTemporaryFile("w", suffix=".patch", delete=False) as f:
        f.write(patch_text)
        name = f.name
    try:
        r = subprocess.run(["git", "apply", *APPLY_ARGS, name], cwd=work, capture_output=True, text=True)
        return r.returncode == 0, (r.stderr or r.stdout).strip()
    finally:
        os.unlink(name)


def stage(work, engine, rel, zen_patch):
    """Write the pristine engine file, with Zen's patch on top, into work/."""
    base = pristine(engine, rel)
    if base is None:
        return f"{rel} is not in the engine"
    dest = os.path.join(work, rel)
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    with open(dest, "wb") as f:
        f.write(base)
    if zen_patch:
        ok, msg = apply_text(work, rel, open(zen_patch, encoding="utf-8", errors="replace").read())
        if not ok:
            return f"Zen's {os.path.relpath(zen_patch, ROOT)} does not apply to the engine: {msg}"
    return None


def check_patch(patch_path, engine=None, text=None):
    """None if the patch applies after Zen's; else a one-line problem."""
    engine = engine or ENGINE
    text = text if text is not None else open(patch_path, encoding="utf-8", errors="replace").read()
    rels = targets(text)
    if not rels:
        return f"{os.path.relpath(patch_path, ROOT)}: no '--- a/' header; not a patch"
    zen = zen_patch_for(patch_path)
    with tempfile.TemporaryDirectory() as work:
        for rel in rels:
            problem = stage(work, engine, rel, zen)
            if problem:
                return f"{os.path.relpath(patch_path, ROOT)}: {problem}"
        with tempfile.NamedTemporaryFile("w", suffix=".patch", delete=False) as f:
            f.write(text)
            name = f.name
        try:
            r = subprocess.run(["git", "apply", "--check", *APPLY_ARGS, name], cwd=work,
                               capture_output=True, text=True)
        finally:
            os.unlink(name)
    if r.returncode:
        detail = (r.stderr or r.stdout).strip().splitlines()
        first = next((l for l in detail if "patch failed" in l or "error" in l), detail[0] if detail else "")
        return (f"{os.path.relpath(patch_path, ROOT)}: does not apply after Zen's patch "
                f"({first.strip()}); regenerate it (python3 whimsy/tools/patchtools.py merge, or surfer export)")
    return None


def all_patches(root=ROOT):
    return sorted(glob.glob(os.path.join(root, "src", "**", "whimsy-*.patch"), recursive=True))


def check(paths=None, engine=None):
    engine = engine or ENGINE
    if not os.path.isdir(os.path.join(engine, ".git")) and not os.path.isfile(os.path.join(engine, ".git")):
        return []
    return [p for p in (check_patch(path, engine) for path in (paths or all_patches())) if p]


def regenerate(patch_rel, original, merged):
    """Patch text for original -> merged, in surfer's format."""
    with tempfile.TemporaryDirectory() as t:
        a, b = os.path.join(t, "a"), os.path.join(t, "b")
        open(a, "wb").write(original)
        open(b, "wb").write(merged)
        r = subprocess.run(["diff", "-u", a, b], capture_output=True)
    if r.returncode not in (0, 1):
        raise RuntimeError("diff failed: " + r.stderr.decode(errors="replace"))
    lines = r.stdout.decode("utf-8", errors="replace").splitlines(keepends=True)
    if not lines:
        return f"diff --git a/{patch_rel} b/{patch_rel}\n"
    lines[0] = f"--- a/{patch_rel}\n"
    lines[1] = f"+++ b/{patch_rel}\n"
    return f"diff --git a/{patch_rel} b/{patch_rel}\n" + "".join(lines)


def merge(base_file, ours_file, theirs_file, path_in_repo, engine=None):
    """Git merge driver. Writes the merged patch into ours_file.
    Returns 0 on success, 1 on a source-level conflict (ours_file untouched)."""
    engine = engine or ENGINE
    base_t = open(base_file, encoding="utf-8", errors="replace").read()
    ours_t = open(ours_file, encoding="utf-8", errors="replace").read()
    theirs_t = open(theirs_file, encoding="utf-8", errors="replace").read()
    rels = targets(ours_t) or targets(theirs_t) or targets(base_t)
    if len(rels) != 1:
        print(f"patch merge: {path_in_repo} touches {len(rels)} files; only single-file patches are merged",
              file=sys.stderr)
        return 1
    rel = rels[0]
    patch_abs = os.path.join(ROOT, path_in_repo)
    zen = zen_patch_for(patch_abs)
    with tempfile.TemporaryDirectory() as work:
        orig_dir = os.path.join(work, "orig")
        problem = stage(orig_dir, engine, rel, zen)
        if problem:
            print(f"patch merge: {problem}", file=sys.stderr)
            return 1
        original = open(os.path.join(orig_dir, rel), "rb").read()
        versions = {}
        for name, text in (("base", base_t), ("ours", ours_t), ("theirs", theirs_t)):
            d = os.path.join(work, name)
            os.makedirs(os.path.dirname(os.path.join(d, rel)), exist_ok=True)
            open(os.path.join(d, rel), "wb").write(original)
            if text.strip():
                ok, msg = apply_text(d, rel, text)
                if not ok:
                    print(f"patch merge: the {name} version of {path_in_repo} does not apply: {msg}", file=sys.stderr)
                    return 1
            versions[name] = os.path.join(d, rel)
        r = subprocess.run(["git", "merge-file", "-p", "-L", "ours", "-L", "base", "-L", "theirs",
                            versions["ours"], versions["base"], versions["theirs"]], capture_output=True)
        if r.returncode < 0 or r.returncode > 127:
            print("patch merge: git merge-file failed: " + r.stderr.decode(errors="replace"), file=sys.stderr)
            return 1
        if r.returncode > 0:
            print(f"patch merge: {path_in_repo}: the lanes change the same lines of {rel} "
                  f"({r.returncode} conflict(s)); resolve in the source and regenerate", file=sys.stderr)
            return 1
        merged = r.stdout
        new_text = regenerate(rel, original, merged)
        # Prove the result before handing it to git.
        chk = os.path.join(work, "chk")
        stage(chk, engine, rel, zen)
        ok, msg = apply_text(chk, rel, new_text)
        if not ok:
            print(f"patch merge: regenerated {path_in_repo} does not apply: {msg}", file=sys.stderr)
            return 1
    with open(ours_file, "w", encoding="utf-8") as f:
        f.write(new_text)
    hunks = new_text.count("\n@@ ")
    print(f"patch merge: regenerated {path_in_repo} ({hunks} hunks) from the merged source", file=sys.stderr)
    return 0


def main(argv):
    if not argv:
        print(__doc__)
        return 2
    cmd, args = argv[0], argv[1:]
    if cmd == "check":
        problems = check([os.path.abspath(a) for a in args] or None)
        for p in problems:
            print("PROBLEM:", p)
        print(f"patchtools: {len(problems)} patch problem(s)")
        return 1 if problems else 0
    if cmd == "merge":
        if len(args) < 4:
            print("usage: patchtools.py merge %O %A %B %P", file=sys.stderr)
            return 2
        return merge(args[0], args[1], args[2], args[3])
    if cmd == "targets":
        for a in args:
            for t in targets(open(a, encoding="utf-8", errors="replace").read()):
                print(t)
        return 0
    print(f"unknown command {cmd}", file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
