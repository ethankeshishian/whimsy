"""Whimsy's changes to files that live only in engine/ (Firefox's own files,
which src/ can't patch as text). Runs at the end of `npm run import`.

- The updater trusts only Whimsy's update-signing certificate, so it installs
  Whimsy's .mar files and rejects anyone else's (Mozilla's or Zen's).
- Whimsy's built-in add-ons (src/zen/whimsy/cookie-banners) are real files
  in engine/, not links into src/: content processes read an add-on's
  scripts and, in a dev build, the sandbox won't follow a link out to src/.
  Packaged builds are unaffected (the files are in omni.ja either way).
- legacy: surfer writes Zen's welcome, What's New, release-notes and
  download URLs into each brand's firefox-branding.js on every import.
  That file loads after firefox.js (libpref reads browser/defaults/
  preferences in reverse alphabetical order), so prefs/whimsy can't
  override them. A Whimsy block appended to the file wins instead: a later
  pref() in the same file replaces the earlier default.
- legacy: a new profile's default bookmarks are Whimsy's (a "Whimsy"
  folder: Changelog, Feedback) instead of Firefox's "Mozilla Firefox"
  folder of Mozilla help and community links.
"""
import glob
import json
import os
import re
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


# legacy: Whimsy's own pages for the URLs surfer's branding points at
# zen-browser.app. The welcome URL must stay non-empty: with
# browser.startup.firstrunSkipsHomepage, an empty one opens a new profile
# on about:blank instead of the homepage.
BRANDING_PREFS = [
    ("startup.homepage_welcome_url", "about:whimsy"),
    ("startup.homepage_welcome_url.additional", ""),
    ("startup.homepage_override_url", "about:whimsy?tab=changelog"),
    ("app.update.url.manual", "https://github.com/ethankeshishian/whimsy/releases"),
    ("app.update.url.details", "about:whimsy?tab=changelog"),
    ("app.releaseNotesURL", "about:whimsy?tab=changelog"),
    ("app.releaseNotesURL.aboutDialog", "about:whimsy?tab=changelog"),
    ("app.releaseNotesURL.prompt", "about:whimsy?tab=changelog"),
]
BRANDING_BEGIN = "// Whimsy branding prefs (whimsy/engine_overrides.py): begin"
BRANDING_END = "// Whimsy branding prefs: end"


def override_branding_prefs():
    block = "\n".join([BRANDING_BEGIN]
                      + [f'pref("{name}", {json.dumps(value)});' for name, value in BRANDING_PREFS]
                      + [BRANDING_END]) + "\n"
    old_block = re.compile(re.escape(BRANDING_BEGIN) + r".*?" + re.escape(BRANDING_END) + r"\n?", re.S)
    changed = 0
    for path in sorted(glob.glob(os.path.join(ROOT, "engine", "browser", "branding", "*", "pref", "firefox-branding.js"))):
        text = open(path, encoding="utf-8").read()
        new = old_block.sub("", text).rstrip("\n") + "\n\n" + block
        if new != text:
            with open(path, "w", encoding="utf-8") as f:
                f.write(new)
            changed += 1
    print(f"engine_overrides: branding prefs point at Whimsy's pages ({changed} files updated)")


DEFAULT_BOOKMARKS = os.path.join(ROOT, "whimsy", "default-bookmarks.html")


def override_default_bookmarks():
    dest = os.path.join(ROOT, "engine", "browser", "base", "content", "default-bookmarks.html")
    if not os.path.exists(dest):
        print("engine_overrides: PROBLEM: Firefox no longer has default-bookmarks.html")
        return
    want = open(DEFAULT_BOOKMARKS, "rb").read()
    changed = open(dest, "rb").read() != want
    if changed:
        with open(dest, "wb") as f:
            f.write(want)
    print(f"engine_overrides: default bookmarks are Whimsy's ({int(changed)} files updated)")


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
    override_branding_prefs()
    override_default_bookmarks()


if __name__ == "__main__":
    main()
