/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Where a link from another app (Mail, Slack, Terminal...) opens. Arc's
// quick window (Little Arc, Cmd+Opt+N) is the model: a link clicked outside
// the browser doesn't have to land in a full tab. Settings → Tab Management
// → "Links from other apps open in": Glance (a preview over the current
// tab), a tab (Firefox's own behavior), or a quick window
// (WhimsyQuickWindow, batch12).
//
// Wraps BrowserDOMWindow's openURI (browser/modules/BrowserDOMWindow.sys.mjs),
// Firefox's nsIBrowserDOMWindow, for OPEN_EXTERNAL opens only. Every other
// open (window.open, links clicked inside the browser) is untouched.

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  WhimsyQuickWindow: "resource:///modules/whimsy/WhimsyQuickWindow.sys.mjs",
});

const FEATURE_PREF = "whimsy.feature.external-link-target";
const TARGET_PREF = "whimsy.external-links.target";

export const WhimsyExternalLinks = {
  get enabled() {
    return Services.prefs.getBoolPref(FEATURE_PREF, true);
  },

  get target() {
    return Services.prefs.getStringPref(TARGET_PREF, "tab");
  },

  init() {
    if (this._initialized) {
      return;
    }
    this._initialized = true;
    const { BrowserDOMWindow } = ChromeUtils.importESModule("resource:///modules/BrowserDOMWindow.sys.mjs");
    const original = BrowserDOMWindow.prototype.openURI;
    const self = this;
    BrowserDOMWindow.prototype.openURI = function whimsyOpenURI(
      aURI,
      aOpenWindowInfo,
      aWhere,
      aFlags,
      aTriggeringPrincipal,
      aPolicyContainer
    ) {
      try {
        const isExternal = !!(aFlags & Ci.nsIBrowserDOMWindow.OPEN_EXTERNAL);
        if (
          isExternal &&
          self.enabled &&
          (self.openInGlance(aURI, aTriggeringPrincipal) || self.openInQuickWindow(aURI, aTriggeringPrincipal))
        ) {
          return null;
        }
      } catch (e) {
        console.error("Whimsy: external link target", e);
      }
      return original.call(this, aURI, aOpenWindowInfo, aWhere, aFlags, aTriggeringPrincipal, aPolicyContainer);
    };
  },

  // Opens the link as a Glance over the most recent window's current tab
  // when the target is "glance". Returns true when it handled the link
  // itself (openURI should return null); false to fall through to
  // Firefox's own handling ("tab", and "quick-window" until Whimsy has one).
  openInGlance(uri, triggeringPrincipal) {
    if (this.target != "glance") {
      return false;
    }
    const win = Services.wm.getMostRecentBrowserWindow();
    if (!win?.gZenGlanceManager) {
      return false;
    }
    win.gZenGlanceManager.openGlance({ url: uri.spec, triggeringPrincipal });
    win.focus();
    return true;
  },

  // batch12: opens the link in Whimsy's quick window (Little Arc) when the
  // target is "quick-window". Same return convention as openInGlance.
  openInQuickWindow(uri, triggeringPrincipal) {
    if (this.target != "quick-window") {
      return false;
    }
    return !!lazy.WhimsyQuickWindow.open(uri.spec, { triggeringPrincipal });
  },
};
