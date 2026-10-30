/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// fix7/private: the private page (about:privatebrowsing, in a private window
// or a Whimsy private tab) is calm: Whimsy's logo and the private browsing
// notes only. Firefox's search box (a stand-in that hands off to the address
// bar, which in Zen pops the command bar) and its private-engine banner are
// hidden. Cmd+L and Cmd+T reach the address bar as usual.
//
// The page's own script still finds both elements (they're hidden, not
// removed), and CSSOM writes aren't subject to the page's style-src CSP.
const FEATURE_PREF = "whimsy.feature.scratch";
const HIDDEN_SELECTORS = [".search-inner-wrapper", "#search-banner"];

export class WhimsyPrivatePageChild extends JSWindowActorChild {
  handleEvent(event) {
    if (event.type != "DOMContentLoaded" || !Services.prefs.getBoolPref(FEATURE_PREF, true)) {
      return;
    }
    const doc = this.document;
    for (const selector of HIDDEN_SELECTORS) {
      const el = doc?.querySelector(selector);
      if (el) {
        el.style.setProperty("display", "none", "important");
        el.setAttribute("aria-hidden", "true");
        el.inert = true;
      }
    }
    doc?.documentElement?.setAttribute("whimsy-calm", "true");
  }
}
