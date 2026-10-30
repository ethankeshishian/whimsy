/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// about:whimsy: one nsIAboutModule shared by every Whimsy full-page chrome
// page, routed by the query string (about:whimsy?game, about:whimsy?year).
// Registered at runtime with Components.manager.registerFactory, from chrome
// JS, the first time any window initialises - no engine patch, no
// components.conf entry. JS can't register a real "whimsy:" protocol
// (that needs an Info.plist CFBundleURLSchemes entry), so WhimsyProtocol.go()
// rewrites whimsy://game and whimsy://year to about:whimsy?game/?year, the
// way Arc's internal pages map onto Chromium's chrome:// pages.
// Each page keeps its own whimsy.feature.<id> switch; this module just
// serves whichever chrome:// document the query string names.

const CONTRACT_ID = "@mozilla.org/network/protocol/about;1?what=whimsy";
const CID = Components.ID("{d8f1b9b0-7b7b-4f4a-9a7e-2f6a6c6f9b1a}");

// about:whimsy?<page> -> the real chrome document. Loaded with the system
// principal, not remote (like about:preferences and about:downloads), so
// each page's own script can use Services/ChromeUtils directly: the game
// reads/writes its prefs, and Year in tabs queries Places, with no actor.
const PAGES = {
  game: "chrome://browser/content/whimsy/whimsy-game.html",
  year: "chrome://browser/content/whimsy/whimsy-year.html",
};
const DEFAULT_PAGE = "game";

function pageIdFor(uri) {
  const query = (uri.query || "").split("&")[0].toLowerCase();
  return Object.hasOwn(PAGES, query) ? query : DEFAULT_PAGE;
}

const aboutModule = {
  QueryInterface: ChromeUtils.generateQI(["nsIAboutModule"]),

  newChannel(uri, loadInfo) {
    const chromeURI = Services.io.newURI(PAGES[pageIdFor(uri)]);
    const channel = Services.io.newChannelFromURIWithLoadInfo(chromeURI, loadInfo);
    channel.originalURI = uri;
    channel.owner = Services.scriptSecurityManager.getSystemPrincipal();
    return channel;
  },

  getURIFlags() {
    return (
      Ci.nsIAboutModule.ALLOW_SCRIPT |
      Ci.nsIAboutModule.IS_SECURE_CHROME_UI |
      Ci.nsIAboutModule.HIDE_FROM_ABOUTABOUT // needs a query string to be useful
    );
  },
};

const factory = {
  createInstance(iid) {
    return aboutModule.QueryInterface(iid);
  },
  QueryInterface: ChromeUtils.generateQI(["nsIFactory"]),
};

export const WhimsyAboutPage = {
  PAGES,

  register() {
    if (this._registered) {
      return;
    }
    Components.manager
      .QueryInterface(Ci.nsIComponentRegistrar)
      .registerFactory(CID, "about:whimsy", CONTRACT_ID, factory);
    this._registered = true;
  },
};
