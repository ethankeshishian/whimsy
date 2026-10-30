/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// One components.conf registration serves all trusted Whimsy pages in the
// parent process. Game/year retain their legacy query routes and their own
// feature switches; only Home/Changelog delegate to Firefox when home is off.
const PAGES = {
  home: "chrome://browser/content/whimsy/whimsy-home.xhtml",
  game: "chrome://browser/content/whimsy/whimsy-game.html",
  year: "chrome://browser/content/whimsy/whimsy-year.html",
  // wave5: Easel (about:whimsy?easel&id=<id>; WhimsyEasel.sys.mjs).
  easel: "chrome://browser/content/whimsy/whimsy-easel.html",
};

function pageIdFor(uri) {
  const query = (uri.query || "").split("&")[0].toLowerCase();
  if (query == "easel") {
    return "easel";
  }
  if (!query || query.startsWith("tab=")) {
    return "home";
  }
  // Preserve the original game fallback for unknown legacy page names.
  return Object.hasOwn(PAGES, query) ? query : "game";
}

export class WhimsyAboutPage {
  QueryInterface = ChromeUtils.generateQI(["nsIAboutModule"]);

  get fallback() {
    return Cc["@mozilla.org/network/protocol/about;1?what=home"].getService(Ci.nsIAboutModule);
  }

  useFallback(uri) {
    return pageIdFor(uri) == "home" &&
      !Services.prefs.getBoolPref("whimsy.feature.home", true);
  }

  newChannel(uri, loadInfo) {
    if (this.useFallback(uri)) {
      return this.fallback.newChannel(Services.io.newURI("about:home"), loadInfo);
    }
    const channel = Services.io.newChannelFromURIWithLoadInfo(
      Services.io.newURI(PAGES[pageIdFor(uri)]), loadInfo
    );
    channel.originalURI = uri;
    channel.owner = Services.scriptSecurityManager.getSystemPrincipal();
    return channel;
  }

  getURIFlags(uri) {
    if (this.useFallback(uri)) {
      return this.fallback.getURIFlags(Services.io.newURI("about:home"));
    }
    return Ci.nsIAboutModule.ALLOW_SCRIPT | Ci.nsIAboutModule.IS_SECURE_CHROME_UI;
  }

  getChromeURI(uri) {
    return this.useFallback(uri)
      ? this.fallback.getChromeURI(Services.io.newURI("about:home"))
      : Services.io.newURI(PAGES[pageIdFor(uri)]);
  }
}
