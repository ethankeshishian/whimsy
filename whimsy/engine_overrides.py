"""Whimsy's changes to files that live only in engine/ (Firefox's own files,
which src/ can't patch as text). Runs at the end of `npm run import`.

- The updater trusts only Whimsy's update-signing certificate, so it installs
  Whimsy's .mar files and rejects anyone else's (Mozilla's or Zen's).
- Whimsy's built-in add-ons (src/zen/whimsy/cookie-banners) are real files
  in engine/, not links into src/: content processes read an add-on's
  scripts and, in a dev build, the sandbox won't follow a link out to src/.
  Packaged builds are unaffected (the files are in omni.ja either way).
"""
import os
import shutil

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CERT = os.path.join(ROOT, "whimsy", "signing", "whimsy-mar.der")
UPDATER = os.path.join(ROOT, "engine", "toolkit", "mozapps", "update", "updater")
BUILTIN_ADDONS = ["src/zen/whimsy/cookie-banners"]
CERT_FILES = ["release_primary.der", "release_secondary.der", "dep1.der", "dep2.der",
              "nightly_aurora_level3_primary.der", "nightly_aurora_level3_secondary.der"]


def copy_builtin_addons():
    copied = 0
    for rel in BUILTIN_ADDONS:
        src = os.path.join(ROOT, rel)
        dest = os.path.join(ROOT, "engine", os.path.relpath(rel, "src"))
        for base, _, files in os.walk(src):
            for name in files:
                s = os.path.join(base, name)
                d = os.path.join(dest, os.path.relpath(s, src))
                if os.path.islink(d):
                    os.unlink(d)
                elif os.path.exists(d) and open(d, "rb").read() == open(s, "rb").read():
                    continue
                os.makedirs(os.path.dirname(d), exist_ok=True)
                shutil.copyfile(s, d)
                copied += 1
    print(f"engine_overrides: built-in add-ons copied into engine ({copied} files updated)")


def main():
    if not os.path.isdir(UPDATER):
        print("engine_overrides: no engine yet, skipping")
        return
    changed = 0
    want = open(CERT, "rb").read()
    for name in CERT_FILES:
        path = os.path.join(UPDATER, name)
        if os.path.exists(path) and open(path, "rb").read() == want:
            continue
        shutil.copyfile(CERT, path)
        changed += 1
    print(f"engine_overrides: updater trusts Whimsy's certificate ({changed} files updated)")
    copy_builtin_addons()


if __name__ == "__main__":
    main()
