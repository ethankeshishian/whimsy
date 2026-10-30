/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// A trusted, local page in the parent process, like about:preferences.
// MigrationUtils needs the browser window; it cannot run in a content process.
// The disabled route delegates both its flags and channel to Firefox's home.

const PAGE_URI = "chrome://browser/content/whimsy/whimsy-home.xhtml";
const FEATURE_PREF = "whimsy.feature.home";

export class WhimsyAboutPage {
  QueryInterface = ChromeUtils.generateQI(["nsIAboutModule"]);

  get fallback() {
    return Cc["@mozilla.org/network/protocol/about;1?what=home"].getService(Ci.nsIAboutModule);
  }

  get enabled() {
    return Services.prefs.getBoolPref(FEATURE_PREF, true);
  }

  newChannel(uri, loadInfo) {
    if (!this.enabled) {
      return this.fallback.newChannel(Services.io.newURI("about:home"), loadInfo);
    }
    const channel = Services.io.newChannelFromURIWithLoadInfo(
      Services.io.newURI(PAGE_URI), loadInfo
    );
    channel.originalURI = uri;
    return channel;
  }

  getURIFlags() {
    return this.enabled
      ? Ci.nsIAboutModule.ALLOW_SCRIPT | Ci.nsIAboutModule.IS_SECURE_CHROME_UI
      : this.fallback.getURIFlags(Services.io.newURI("about:home"));
  }

  getChromeURI() {
    return this.enabled
      ? Services.io.newURI(PAGE_URI)
      : this.fallback.getChromeURI(Services.io.newURI("about:home"));
  }
}
