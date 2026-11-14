/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// W28: "Open in Safari" / "Open in Chrome" (research/multi-engine.md,
// option A, step 1). The current tab's address, handed to another
// installed engine through `open -a <app> <url>`: no cookie jar sharing,
// no new UI beyond a command-bar row per installed browser, and no engine
// runs inside Whimsy. A site that breaks in Gecko, or needs DRM quality
// Gecko can't give it, still opens somewhere.
//
// ENGINES is deliberately data, not one command per browser: a later
// "auto" command (picks the best engine for the site) calls the same
// openInApp(win, engine) this module's own commands call, so "open in
// Safari" and "auto" never drift into two code paths that each decide
// installed-ness or build the open call differently.

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  WhimsyCommands: "resource:///modules/whimsy/WhimsyCommands.sys.mjs",
});

const ICON = "chrome://browser/skin/zen-icons/open.svg";
const FEATURE_PREF = "whimsy.feature.open-in-browser";

function feature() {
  return Services.prefs.getBoolPref(FEATURE_PREF, true);
}

// One entry per engine Whimsy can hand a tab to. `path` is where macOS
// installs it by default; a later engine (Chromium, Arc, …) is just
// another row here.
export const ENGINES = [
  { id: "safari", app: "Safari", path: "/Applications/Safari.app", l10nId: "whimsy-action-open-in-safari" },
  { id: "chrome", app: "Google Chrome", path: "/Applications/Google Chrome.app", l10nId: "whimsy-action-open-in-chrome" },
];

export const WhimsyOpenInBrowser = {
  // The page a command would hand off: the tab's address, unwrapped from
  // about:reader (same rule as WhimsyCopy.displaySpec), or null when there
  // isn't one Whimsy can open elsewhere.
  currentURL(win) {
    const uri = win?.gBrowser?.selectedBrowser?.currentURI;
    if (!uri) {
      return null;
    }
    let spec = uri.displaySpec ?? uri.spec;
    if (uri.schemeIs("about") && spec.startsWith("about:reader?")) {
      try {
        spec = new URL(spec).searchParams.get("url") || spec;
      } catch (e) {
        // Malformed about:reader URL; fall back to the address as given.
      }
    }
    return spec;
  },

  // Whether `engine` is installed, checked by the app bundle's path so a
  // test can stub it without touching the real /Applications folder.
  installed(engine) {
    try {
      const file = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
      file.initWithPath(engine.path);
      return file.exists();
    } catch (e) {
      return false;
    }
  },

  // Runs `open -a <app> <url>`. Separated from openInApp so a test can
  // replace this one method and never actually launch another app.
  launch(appName, url) {
    try {
      const file = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
      file.initWithPath("/usr/bin/open");
      const process = Cc["@mozilla.org/process/util;1"].createInstance(Ci.nsIProcess);
      process.init(file);
      process.runAsync(["-a", appName, url], 2);
    } catch (e) {
      console.error(`Whimsy: open in ${appName}`, e);
    }
  },

  // The one open call every engine's command (and a later "auto" picker)
  // goes through.
  openInApp(win, engine) {
    if (!feature()) {
      return false;
    }
    const url = this.currentURL(win);
    if (!url) {
      return false;
    }
    this.launch(engine.app, url);
    return true;
  },

  initWindow(win) {
    for (const engine of ENGINES) {
      lazy.WhimsyCommands.register(win, {
        id: `cmd_whimsyOpenIn${engine.id[0].toUpperCase()}${engine.id.slice(1)}`,
        l10nId: engine.l10nId,
        icon: ICON,
        run: w => this.openInApp(w, engine),
        isAvailable: w => feature() && lazy.WhimsyCommands.hasAddress(w) && this.installed(engine),
      });
    }
  },
};
