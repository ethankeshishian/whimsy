/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// batch3glance: Glance size (scout batch6 #3, Zen discussion #13326).
// Zen draws every Glance at 80% of the tab panels' width, in CSS and in the
// opening/closing arc. Two Whimsy hotfixes in ZenGlanceManager.mjs read
// `gZenGlanceManager.whimsyWidthPercent` instead (see whimsy/overlay.py), and
// --whimsy-glance-width sizes the card to match, so the arc lands exactly on
// the card's final size. Arc's Peek has one fixed size; this is a Whimsy
// addition the user asked for. "standard" is Zen's 80%.

const SIZE_PREF = "whimsy.glance.size";
const FEATURE_PREF = "whimsy.feature.glance-size";
export const GLANCE_WIDTHS = { compact: 60, standard: 80, wide: 90 };
const installed = new WeakSet();

function enabled() {
  return Services.prefs.getBoolPref(FEATURE_PREF, true);
}

export const WhimsyGlance = {
  // The card's width in percent of the tab panels, or null for Zen's own.
  widthPercent() {
    if (!enabled()) {
      return null;
    }
    const size = Services.prefs.getStringPref(SIZE_PREF, "standard");
    return GLANCE_WIDTHS[size] ?? GLANCE_WIDTHS.standard;
  },

  apply(win) {
    const root = win.document.documentElement;
    const width = this.widthPercent();
    const wrapper = win.gZenGlanceManager?.browserWrapper;
    if (width === null) {
      root.style.removeProperty("--whimsy-glance-width");
      root.removeAttribute("whimsy-glance-sizing");
      if (wrapper) {
        wrapper.style.width = "80%";
      }
      return;
    }
    root.style.setProperty("--whimsy-glance-width", `${width}%`);
    root.setAttribute("whimsy-glance-sizing", "true");
    if (wrapper) {
      wrapper.style.width = `${width}%`;
    }
  },

  // W30 (owner: "I can't Ctrl+Tab out of a tab when I opened a Glance from a
  // link in a pinned tab"). The W29 hotfix in fullyOpenGlance puts a Glance
  // expanded from a pinned tab or Essential at the top of the space's normal
  // tabs; with no normal tab there yet it appends it to the strip, after the
  // new-tab periphery. tabContainer.allTabs always drops a strip's last
  // child, so the tab fell out of gBrowser.tabs: selecting it again (Ctrl+Tab,
  // the command bar, the sidebar) was ignored, and the window was stuck. Zen
  // moves the tab before its first await, so this runs right after.
  keepExpandedTabsSelectable(win, manager) {
    const fullyOpen = manager.fullyOpenGlance;
    manager.fullyOpenGlance = function (...args) {
      const result = fullyOpen.apply(this, args);
      const tab = win.gBrowser.selectedTab;
      const strip = tab?.parentNode;
      const periphery = strip?.querySelector(":scope > #tabbrowser-arrowscrollbox-periphery");
      if (periphery && strip.lastElementChild == tab) {
        strip.insertBefore(tab, periphery);
        win.gBrowser.tabContainer._invalidateCachedTabs();
      }
      return result;
    };
  },

  initWindow(win) {
    const manager = win.gZenGlanceManager;
    if (!manager || installed.has(win)) {
      return;
    }
    installed.add(win);
    // Read by the hotfixed lines in ZenGlanceManager.mjs on every open and
    // close, so a size change applies to the next Glance with no reload.
    Object.defineProperty(manager, "whimsyWidthPercent", {
      configurable: true,
      get: () => {
        const width = this.widthPercent();
        return width === null ? undefined : width / 100;
      },
    });
    this.keepExpandedTabsSelectable(win, manager);
    this.apply(win);
    const observer = () => this.apply(win);
    Services.prefs.addObserver(SIZE_PREF, observer);
    Services.prefs.addObserver(FEATURE_PREF, observer);
    win.addEventListener(
      "unload",
      () => {
        Services.prefs.removeObserver(SIZE_PREF, observer);
        Services.prefs.removeObserver(FEATURE_PREF, observer);
      },
      { once: true }
    );
  },
};
