"""Whimsy's changes to files that live only in engine/ (Firefox's own files,
which src/ can't patch as text). Runs at the end of `npm run import`.

- The updater trusts only Whimsy's update-signing certificate, so it installs
  Whimsy's .mar files and rejects anyone else's (Mozilla's or Zen's).
"""
import os
import shutil

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CERT = os.path.join(ROOT, "whimsy", "signing", "whimsy-mar.der")
UPDATER = os.path.join(ROOT, "engine", "toolkit", "mozapps", "update", "updater")
CERT_FILES = ["release_primary.der", "release_secondary.der", "dep1.der", "dep2.der",
              "nightly_aurora_level3_primary.der", "nightly_aurora_level3_secondary.der"]


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


if __name__ == "__main__":
    main()
