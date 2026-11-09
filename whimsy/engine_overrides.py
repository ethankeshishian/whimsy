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
- legacy: small text fixes in Firefox's own files (ENGINE_TEXT_FIXES), each
  applied only while Firefox's original text is still there.
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


# legacy: (id, file under engine/, Firefox's text, Whimsy's text, why).
# W11-07: Settings → Home's choices (Whimsy Home and Firefox Home) are a
# patch now, src/browser/components/preferences/config/
# whimsy-home-startup-mjs.patch, not text fixes here.
_CALL_PIP_EMPTIED_GUARD = (
    "        if (lazy.PIP_AUTO_CLOSE &&\n"
    "            !ChromeUtils.importESModule(\n"
    "              \"resource:///modules/whimsy/WhimsyCallVideos.sys.mjs\"\n"
    "            ).callVideos.has(this.getWeakVideo())) {\n"
    "          let video = this.getWeakVideo();"
)
ENGINE_TEXT_FIXES = [
    ("auto-pip-share-deliberate-skip",
     "toolkit/components/pictureinpicture/PictureInPicture.sys.mjs",
     "          PictureInPicture.weakAutoPipBrowserClosedDeliberately.delete(browser);\n          break;",
     "          ChromeUtils.importESModule(\n"
     "            \"resource:///modules/whimsy/WhimsyMedia.sys.mjs\"\n"
     "          ).WhimsyMedia.recordAutoPipSkip(browser);\n"
     "          PictureInPicture.weakAutoPipBrowserClosedDeliberately.delete(browser);\n          break;",
     "Preserve Firefox's deliberate-close skip for Whimsy's delayed fallback, "
     "even when the hidden-page message arrives before TabSelect."),
    ("auto-pip-retain-deliberate-skip",
     "toolkit/components/pictureinpicture/PictureInPicture.sys.mjs",
     "          PictureInPicture.weakAutoPipBrowserClosedDeliberately.has(browser)\n",
     "          ChromeUtils.importESModule(\n"
     "            \"resource:///modules/whimsy/WhimsyMedia.sys.mjs\"\n"
     "          ).WhimsyMedia.shouldSkipAutoPip(browser)\n",
     "Late or repeated hidden-page messages must respect the skip after Firefox's "
     "one-use close mark has been consumed by the fallback."),
    ("auto-pip-cancel-fallback-on-close",
     "toolkit/components/pictureinpicture/PictureInPicture.sys.mjs",
     "        PictureInPicture.weakAutoPipBrowserClosedDeliberately.add(browser);",
     "        PictureInPicture.weakAutoPipBrowserClosedDeliberately.add(browser);\n"
     "        ChromeUtils.importESModule(\n"
     "          \"resource:///modules/whimsy/WhimsyMedia.sys.mjs\"\n"
     "        ).WhimsyMedia.recordAutoPipSkip(browser);",
     "Record every deliberate background-player close synchronously and cancel "
     "its pending fallback before teardown can hide the page again."),
    ("auto-pip-check-skip-at-open",
     "toolkit/components/pictureinpicture/PictureInPicture.sys.mjs",
     "    this.currentPlayerCount += 1;",
     # All automatic launchers (including calls) pass autoFocus=false. Check
     # after IPC, before opening a window; manual launches remain available.
     "    if (videoData.autoFocus === false && ChromeUtils.importESModule(\n"
     "      \"resource:///modules/whimsy/WhimsyMedia.sys.mjs\"\n"
     "    ).WhimsyMedia.shouldSkipAutoPip(wgp.browsingContext.top.embedderElement)) {\n"
     "      return;\n"
     "    }\n\n"
     "    this.currentPlayerCount += 1;",
     "Reject automatic requests already in flight when the player was closed."),
    ("call-pip-keep-emptied-tile",
     "toolkit/actors/PictureInPictureChild.sys.mjs",
     "        if (lazy.PIP_AUTO_CLOSE) {\n          let video = this.getWeakVideo();",
     _CALL_PIP_EMPTIED_GUARD,
     "Keep an emptied call tile open for the camera-off placeholder and resumption; "
     "ordinary videos retain Firefox's auto-close behavior."),
    # Also upgrade engines that already have the original blanket exemption.
    ("call-pip-restart-sourced-tile",
     "toolkit/actors/PictureInPictureChild.sys.mjs",
     _CALL_PIP_EMPTIED_GUARD,
     _CALL_PIP_EMPTIED_GUARD.replace(
         "!ChromeUtils", "(!ChromeUtils"
     ).replace(
         ").callVideos.has(this.getWeakVideo())) {",
         ").callVideos.has(this.getWeakVideo()) ||\n"
         "            this.getWeakVideo()?.srcObject || this.getWeakVideo()?.src)) {"
     ),
     "Only source-less call tiles need the camera-off placeholder. Resetting an "
     "active stream must still close and reopen PiP through the unload retry."),
    ("vpn-scope-after-status-site-inclusions",
     "browser/components/ipprotection/content/ipprotection-content.mjs",
     "        ${this.statusCardTemplate()}\n        <div class=\"vpn-bottom-content\">",
     "        ${this.statusCardTemplate()}\n        <slot name=\"whimsy-after-status\"></slot>\n        <div class=\"vpn-bottom-content\">",
     "Place Whimsy scope after the status card, before native panel actions."),
    ("vpn-scope-after-status-default",
     "browser/components/ipprotection/content/ipprotection-content.mjs",
     "      ${this.statusCardTemplate()} ${this.exclusionToggleTemplate()}",
     "      ${this.statusCardTemplate()} <slot name=\"whimsy-after-status\"></slot> ${this.exclusionToggleTemplate()}",
     "Place Whimsy scope after the status card, before native panel actions."),
]

# fix7 settings: Firefox's VPN (IP Protection) is Mozilla's service, but its
# strings say "{ -brand-product-name }'s built-in VPN", which reads "Whimsy's
# built-in VPN". The VPN is Firefox's, so it says so; lines about the browser
# you're in ("while browsing in Whimsy") keep the brand. The Android promo
# offers Firefox for Android, not a Whimsy app.
_VPN_FTL = "browser/locales/en-US/browser/ipProtection.ftl"
ENGINE_TEXT_FIXES += [
    (f"vpn-is-firefox-{string_id}", _VPN_FTL,
     f"{string_id} = {before}{{ -brand-product-name }}\u2019s built-in VPN",
     f"{string_id} = {before}Firefox\u2019s built-in VPN",
     "Firefox's VPN, not Whimsy's.")
    for string_id, before in [
        ("ipprotection-feature-introduction-title-1", 'Try '),
        ("ipprotection-feature-introduction-description-summer-promo", 'Go farther with '),
        ("ipprotection-feature-introduction-title-private-browsing", 'Maximize privacy with '),
        ("ipprotection-feature-introduction-title-captive-portal", 'On public Wi-Fi? Try '),
        ("ipprotection-location-selection-callout-description-1", '<a data-l10n-name="learn-more-vpn">'),
        ("unauthenticated-vpn-title", 'Try '),
    ]
] + [
    ("vpn-panel-heading-is-firefox", _VPN_FTL,
     "  .heading = Try { -brand-short-name }\u2019s built-in VPN",
     "  .heading = Try Firefox\u2019s built-in VPN",
     "Firefox's VPN, not Whimsy's."),
    ("vpn-android-promo-is-firefox", _VPN_FTL,
     "Scan the QR code to get { -brand-product-name } for Android",
     "Scan the QR code to get Firefox for Android",
     "The promo's app is Firefox for Android."),
]



# W23 verifyfix: clearing site data by time (Clear Recent History, and the
# Fire button's cookies item over a range) asks the storage activity service
# for the origins used in the range and makes each back into a principal.
# An origin string that can't be made back into one (left by earlier
# storage use) comes back as a null entry, queryElementAt throws, and the
# whole clear fails ("Error sanitizing offlineApps"). Such entries are
# skipped; every other origin still clears.
ENGINE_TEXT_FIXES += [
    ("clear-by-range-skip-unmade-origins", "toolkit/components/cleardata/ClearDataService.sys.mjs",
     "    for (let i = 0; i < principals.length; ++i) {\n"
     "      let principal = principals.queryElementAt(i, Ci.nsIPrincipal);\n\n"
     "      if (\n"
     "        !principal.schemeIs(\"http\") &&",
     "    for (let i = 0; i < principals.length; ++i) {\n"
     "      let principal;\n"
     "      try {\n"
     "        principal = principals.queryElementAt(i, Ci.nsIPrincipal);\n"
     "      } catch (e) {\n"
     "        // Whimsy: an origin that couldn't be made into a principal.\n"
     "        continue;\n"
     "      }\n\n"
     "      if (\n"
     "        !principal.schemeIs(\"http\") &&",
     "One stored origin that can't be made back into a principal made every "
     "clear-by-time of site data fail; it is skipped instead."),
]


def apply_engine_text_fixes():
    changed = 0
    for fix_id, rel, old, new, _why in ENGINE_TEXT_FIXES:
        path = os.path.join(ROOT, "engine", rel)
        text = open(path, encoding="utf-8").read() if os.path.exists(path) else ""
        if new in text:
            continue
        if old not in text:
            print(f"engine_overrides: {fix_id} obsolete (Firefox changed {rel})")
            continue
        with open(path, "w", encoding="utf-8") as f:
            f.write(text.replace(old, new, 1))
        changed += 1
    print(f"engine_overrides: Firefox text fixes ({changed} applied)")


# wave7/ux: the private page said data goes "when you close all your
# private windows", but Whimsy's private tabs and Scratch live in normal
# windows and are wiped when the last private tab closes (WhimsyPrivate).
# Both models are covered: a real private window still works the old way.
ENGINE_TEXT_FIXES += [
    ("private-page-last-private-tab", "browser/locales/en-US/browser/aboutPrivateBrowsing.ftl",
     "about-private-browsing-felt-privacy-v1-info-body = { -brand-short-name} deletes your cookies, "
     "history, and site data when you close all your private windows.",
     "about-private-browsing-felt-privacy-v1-info-body = { -brand-short-name} deletes your cookies, "
     "history, and site data when you close your last private tab.",
     "Whimsy's private tabs and Scratch are wiped when the last private tab closes, "
     "not when a private window closes."),
]


# W16-22: the tab hover preview has no "Add note" button. Whimsy turns
# browser.tabs.notes.enabled on so the Library's page notes can use
# Firefox's tab notes storage, and the preview shows its button whenever
# that pref is on and the tab has no note; with the branch never taken,
# the else always removes the button. The tab context menu's Add Note and
# the note icon on a tab that has one stay.
ENGINE_TEXT_FIXES += [
    ("tab-preview-no-add-note", "browser/components/tabbrowser/content/tab-hover-preview.mjs",
     "    if (this._prefUseTabNotes && lazy.TabNotes.isEligible(this.#tab)) {",
     "    if (false) { // Whimsy: the tab hover preview has no \"Add note\" button",
     "Notes stay on (the Library uses them); the hover preview just doesn't offer one."),
]


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
    apply_engine_text_fixes()


if __name__ == "__main__":
    main()
