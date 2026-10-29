/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// whimsy:// URL schemes (Arc parity: arc://settings, arc://history, ...).
// JS can't register a real new URL *scheme* macOS/Gecko will route from
// outside the app (that needs an Info.plist CFBundleURLSchemes entry and a
// command-line handler - an engine-adjacent packaging change, not an
// overlay, and risky to land untested overnight; left for a follow-up).
// What IS a pure overlay, and what this does: typing whimsy://<page> into
// the address bar and pressing Enter jumps straight to Whimsy/Firefox's
// real page for it, the way Arc's internal pages map onto Chromium's own
// chrome:// pages. "Open in a space from the command line" needs no new
// code: Zen's BrowserContentHandler patch already has --space (verified,
// see docs/whimsy/scout/batch7.md).
// whimsy.feature.url-schemes.

const FEATURE_PREF = "whimsy.feature.url-schemes";

// whimsy://<page> -> a real page or a Zen command to run instead.
const ROUTES = {
  settings: { url: "about:preferences" },
  downloads: { url: "about:downloads" },
  extensions: { url: "about:addons" },
  flags: { url: "about:config" },
  keyboard: { url: "about:keyboard" },
  history: { command: "cmd_zenToggleLibrary", fallbackUrl: "about:firefoxview" },
};

const PATTERN = /^whimsy:\/\/([a-z-]+)\/?$/i;

export const WhimsyProtocol = {
  get enabled() {
    return Services.prefs.getBoolPref(FEATURE_PREF, true);
  },

  route(value) {
    const match = PATTERN.exec(value.trim());
    return match ? ROUTES[match[1].toLowerCase()] ?? null : null;
  },

  initWindow(win) {
    const { gURLBar } = win;
    if (!gURLBar) {
      return;
    }
    gURLBar.inputField.addEventListener(
      "keydown",
      event => {
        if (event.key != "Enter" || !this.enabled) {
          return;
        }
        const route = this.route(gURLBar.value);
        if (!route) {
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        this.go(win, route);
      },
      true
    );
  },

  go(win, route) {
    win.gURLBar.blur();
    if (route.command) {
      const command = win.document.getElementById(route.command);
      if (command) {
        command.doCommand();
        return;
      }
      win.openTrustedLinkIn(route.fallbackUrl, "current");
      return;
    }
    win.openTrustedLinkIn(route.url, "current");
  },
};
