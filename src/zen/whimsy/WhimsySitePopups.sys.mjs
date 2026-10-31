/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// wave9/mini W8-23, the normal-window path: a site's popup window
// ("Continue with Google": window.open(url, name, "width=…,height=…")).
// Firefox gives such a window minimal chrome: no tabs, no toolbars, but
// always the read-only address bar with the site's identity, because a
// sign-in window that hides where it is would be an easy phishing page
// (dom.disable_window_open_feature.location). In Zen the address bar lives
// in the sidebar (#navigator-toolbox), and Zen collapses the whole sidebar
// in a popup window ([popup-window]), so the popup can come up with no
// address at all: a bare page that looks like a broken Mini Whimsy window.
//
// When that happens, this moves the nav bar into the top toolbar area Zen
// already keeps above the page (#zen-appcontent-navbar-container) and marks
// the window [whimsy-site-popup] so whimsy-browser.css shows that strip.
// The address bar stays Firefox's own, read-only, with its identity box.
// Nothing else changes: the popup keeps its opener (window.opener,
// postMessage, window.close all belong to the page, not the chrome). Mini
// Whimsy (also a popup window) has its own bar and is left alone. If Zen
// already shows the address in a popup, this does nothing.
// whimsy.feature.site-popup-chrome.

const FEATURE_PREF = "whimsy.feature.site-popup-chrome";
const ATTR = "whimsy-site-popup";

export const WhimsySitePopups = {
  get enabled() {
    return Services.prefs.getBoolPref(FEATURE_PREF, true);
  },

  // A window a web page opened as a popup, not Mini Whimsy.
  isSitePopup(win) {
    return !!win && !win.closed && !win.toolbar.visible && !win._whimsyQuickWindow &&
      !win.document.documentElement.hasAttribute("whimsy-quick-window");
  },

  initWindow(win) {
    if (!this.enabled || !this.isSitePopup(win)) {
      return;
    }
    // After Zen's own toolbar layout for this window (it runs on startup
    // and again on some pref changes): only then can we tell what shows.
    win.requestAnimationFrame(() => this.showAddress(win));
  },

  showAddress(win) {
    if (win.closed || !this.isSitePopup(win)) {
      return false;
    }
    const doc = win.document;
    const navBar = doc.getElementById("nav-bar");
    const container = doc.getElementById("zen-appcontent-navbar-container");
    if (!navBar || !container || !win.gURLBar) {
      return false;
    }
    if (!doc.documentElement.hasAttribute(ATTR) && win.gURLBar.checkVisibility()) {
      return false; // Zen already shows it.
    }
    doc.documentElement.setAttribute(ATTR, "");
    if (navBar.parentElement != container) {
      // moveBefore keeps the toolbar's state, as Zen's own moves do.
      if (container.moveBefore) {
        container.moveBefore(navBar, null);
      } else {
        container.append(navBar);
      }
    }
    return true;
  },
};
