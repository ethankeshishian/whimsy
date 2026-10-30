"""Runs before `surfer import`: lets changed patches re-apply cleanly.

surfer re-applies a patch by reverse-applying the patch's *new* contents, then
applying it. When a patch changed (a Zen release, or Whimsy's overlay editing
one), the reverse step fails silently and the apply then fails. This restores
changed patches and connected groups of overlapping patches to Firefox's own
version, so surfer applies them fresh. Independent unchanged patches and the
build folder are left alone.
"""
import glob
import os
import re
import subprocess

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ENGINE = os.path.join(ROOT, "engine")
ARGS = ["--ignore-space-change", "--ignore-whitespace"]


def targets(patch):
    with open(patch, encoding="utf-8", errors="replace") as source:
        return re.findall(r"^diff --git a/(\S+) b/", source.read(), re.M)


def main():
    if not os.path.isdir(os.path.join(ENGINE, ".git")):
        print("engine_prepare: no engine yet, skipping")
        return
    # Patches sharing a file form one unit. An individual reverse check is
    # meaningless when another patch changes its context, and restoring just
    # that patch's targets leaves the rest of the unit partially applied.
    groups = []
    for patch in sorted(glob.glob(os.path.join(ROOT, "src", "**", "*.patch"), recursive=True)):
        files = set(targets(patch))
        connected = [group for group in groups if group[1] & files]
        patches = [patch]
        for group in connected:
            patches += group[0]
            files |= group[1]
            groups.remove(group)
        groups.append((patches, files))

    restored = []
    for patches, targets_in_group in groups:
        if len(patches) == 1:
            applied = subprocess.run(["git", "apply", "-R", "--check", *ARGS, patches[0]],
                                     cwd=ENGINE, capture_output=True).returncode == 0
            if applied:
                continue
        # Always replay overlapping patches together, in surfer's normal
        # order, rather than asking surfer to reverse them independently.
        files = sorted(f for f in targets_in_group
                       if subprocess.run(["git", "cat-file", "-e", f"HEAD:{f}"], cwd=ENGINE,
                                         capture_output=True).returncode == 0)
        if files:
            subprocess.run(["git", "checkout", "HEAD", "--", *files], cwd=ENGINE, check=True)
            restored += files
    print(f"engine_prepare: restored {len(restored)} files for changed patches"
          + (f": {', '.join(restored[:5])}{'…' if len(restored) > 5 else ''}" if restored else ""))


if __name__ == "__main__":
    main()
