/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// about:whimsy: the homepage (what Whimsy is, quick links) with a
// Changelog tab (about:whimsy?tab=changelog), replacing Zen's about:home.
// A plain nsIAboutModule (components.conf), the same way Firefox's own
// about:robots etc. work: it hands back a channel for a static page under
// chrome://browser/content/whimsy/, with originalURI set back to the
// requested about:whimsy URI so the query string (?tab=) survives and the
// address bar still reads "about:whimsy". whimsy.feature.home off: falls
// back to Firefox's real about:home.
// whimsy.feature.home.

const PAGE_URI = "chrome://browser/content/whimsy/whimsy-home.xhtml";
const FEATURE_PREF = "whimsy.feature.home";

export class WhimsyAboutPage {
  QueryInterface = ChromeUtils.generateQI(["nsIAboutModule"]);

  newChannel(uri, loadInfo) {
    const enabled = Services.prefs.getBoolPref(FEATURE_PREF, true);
    const chromeURI = Services.io.newURI(enabled ? PAGE_URI : "about:home");
    const channel = Services.io.newChannelFromURIWithLoadInfo(chromeURI, loadInfo);
    channel.originalURI = uri;
    return channel;
  }

  getURIFlags() {
    return (
      Ci.nsIAboutModule.ALLOW_SCRIPT |
      Ci.nsIAboutModule.URI_MUST_LOAD_IN_CHILD |
      Ci.nsIAboutModule.URI_CAN_LOAD_IN_PRIVILEGEDABOUT_PROCESS
    );
  }

  getChromeURI() {
    return Services.io.newURI(PAGE_URI);
  }
}
