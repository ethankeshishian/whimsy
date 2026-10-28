"""Runs before `surfer import`: lets changed patches re-apply cleanly.

surfer re-applies a patch by reverse-applying the patch's *new* contents, then
applying it. When a patch changed (a Zen release, or Whimsy's overlay editing
one), the reverse step fails silently and the apply then fails. This restores
the files of every patch the engine doesn't already match to Firefox's own
version, so surfer applies them fresh. Untouched patches, and the build folder,
are left alone, so incremental builds stay incremental.
"""
import glob
import os
import re
import subprocess

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ENGINE = os.path.join(ROOT, "engine")
ARGS = ["--ignore-space-change", "--ignore-whitespace"]


def targets(patch):
    return re.findall(r"^diff --git a/(\S+) b/", open(patch, encoding="utf-8", errors="replace").read(), re.M)


def main():
    if not os.path.isdir(os.path.join(ENGINE, ".git")):
        print("engine_prepare: no engine yet, skipping")
        return
    restored = []
    for patch in sorted(glob.glob(os.path.join(ROOT, "src", "**", "*.patch"), recursive=True)):
        applied = subprocess.run(["git", "apply", "-R", "--check", *ARGS, patch], cwd=ENGINE,
                                 capture_output=True).returncode == 0
        if applied:
            continue
        files = [f for f in targets(patch)
                 if subprocess.run(["git", "cat-file", "-e", f"HEAD:{f}"], cwd=ENGINE,
                                   capture_output=True).returncode == 0]
        if files:
            subprocess.run(["git", "checkout", "HEAD", "--", *files], cwd=ENGINE, check=True)
            restored += files
    print(f"engine_prepare: restored {len(restored)} files for changed patches"
          + (f": {', '.join(restored[:5])}{'…' if len(restored) > 5 else ''}" if restored else ""))


if __name__ == "__main__":
    main()
