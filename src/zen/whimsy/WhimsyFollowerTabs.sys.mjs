/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Follower tabs (Vivaldi 7.9): in a 2-pane split, one pane is "the
// source" and the other is wherever a link clicked in the source lands —
// the source itself never navigates. "Make This a Follower Split" (tab
// context menu, offered only on a tab already in a 2-pane split) marks
// the tab as the source; its partner becomes the follower. People use it
// for research/reading flows: a reference page (docs, a wiki, a forum
// thread) stays put while every link you click opens beside it, one
// after another, without losing the source.
//
// Built on ZenViewSplitter's existing split mechanics (window's own
// gZenViewSplitter) rather than a new pane system or split type: a
// follower split is an ordinary 2-pane split, Whimsy only remembers which
// tab is the source (SOURCES below). WhimsyPageChild intercepts link
// clicks in the source's content (capture phase, the same actor as
// per-tab volume) and tells WhimsyPageParent, which redirects the load to
// the follower pane's browser instead of letting the source navigate. A
// link clicked *inside* the follower pane is never intercepted (no
// listener runs there), so it navigates that pane normally. Closing
// either pane relies on ZenViewSplitter's own handleTabClose, which
// already puts a 2-pane split's surviving tab back to a normal single
// tab; Whimsy doesn't add a second confirmation for that.

const FEATURE_PREF = "whimsy.feature.follower-tabs";
const MENU_ID = "context_whimsyFollowerSplit";

// Tabs currently acting as a follower split's source.
const SOURCES = new WeakSet();

export const WhimsyFollowerTabs = {
  get enabled() {
    return Services.prefs.getBoolPref(FEATURE_PREF, true);
  },

  initWindow(win) {
    // wave5: the tab menu's follower toggle as a command for the current tab.
    const partnered = w => this.enabled && !!this.partnerOf(w, w.gBrowser.selectedTab);
    ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyCommands.sys.mjs").WhimsyCommands.register(win, {
      id: "cmd_whimsyFollowerSplit",
      l10nId: "whimsy-action-follower-toggle",
      run: w => this.toggle(w, w.gBrowser.selectedTab),
      icon: "chrome://browser/skin/zen-icons/split.svg",
      variants: [
        { l10nId: "whimsy-action-follow", isAvailable: w => partnered(w) && !this.isSource(w.gBrowser.selectedTab) },
        { l10nId: "whimsy-action-unfollow", isAvailable: w => partnered(w) && this.isSource(w.gBrowser.selectedTab) },
      ],
    });
    const menu = win.document.getElementById("tabContextMenu");
    menu?.addEventListener("popupshowing", event => {
      if (event.target == menu) {
        this.updateMenu(win);
      }
    });
    win.gBrowser.tabContainer.addEventListener("TabClose", event => this.stopSource(event.target));
    // A source tab reloads or navigates by hand (not a followed link):
    // its content actor is fresh, so re-arm the click listener there.
    win.gBrowser.addTabsProgressListener({
      onLocationChange: (browser, webProgress, request, location, flags) => {
        if (!webProgress.isTopLevel || flags & Ci.nsIWebProgressListener.LOCATION_CHANGE_SAME_DOCUMENT) {
          return;
        }
        const tab = win.gBrowser.getTabForBrowser(browser);
        if (tab && this.isSource(tab)) {
          this.setListening(tab, true);
        }
      },
    });
  },

  isSource(tab) {
    return SOURCES.has(tab);
  },

  // The tab's split partner, when it's in an ordinary 2-pane split.
  // gZenViewSplitter has no public accessor for this; reads its own
  // _data the same way its tests and Whimsy's Split Glance action do.
  partnerOf(win, tab) {
    const group = win.gZenViewSplitter?._data?.find(g => g.tabs.includes(tab));
    if (!group || group.tabs.length != 2) {
      return null;
    }
    return group.tabs.find(t => t != tab) ?? null;
  },

  updateMenu(win) {
    const { document } = win;
    let item = document.getElementById(MENU_ID);
    const tab = win.TabContextMenu?.contextTab;
    const partner = this.enabled && tab && !tab.multiselected ? this.partnerOf(win, tab) : null;
    if (!partner) {
      if (item) {
        item.hidden = true;
      }
      return;
    }
    if (!item) {
      item = document.createXULElement("menuitem");
      item.id = MENU_ID;
      item.addEventListener("command", () => {
        const contextTab = win.TabContextMenu?.contextTab;
        if (contextTab) {
          this.toggle(win, contextTab);
        }
      });
      document.getElementById("tabContextMenu").appendChild(item);
    }
    item.hidden = false;
    document.l10n.setAttributes(item, this.isSource(tab) ? "tab-context-whimsy-unfollow" : "tab-context-whimsy-follow");
  },

  // Marks the tab as the source of its split (its partner the follower),
  // or clears it back to a plain split.
  async toggle(win, tab) {
    if (!this.enabled) {
      return;
    }
    const partner = this.partnerOf(win, tab);
    if (!partner) {
      return;
    }
    if (this.isSource(tab)) {
      this.stopSource(tab);
      return;
    }
    this.stopSource(partner); // only one source per split
    SOURCES.add(tab);
    await this.setListening(tab, true);
  },

  stopSource(tab) {
    if (SOURCES.delete(tab)) {
      this.setListening(tab, false);
    }
  },

  async setListening(tab, on) {
    try {
      return await tab.linkedBrowser?.browsingContext?.currentWindowGlobal
        ?.getActor("WhimsyPage")
        ?.sendQuery("Whimsy:SetFollowerSource", { on });
    } catch (e) {
      // The browser hasn't loaded a window global yet, or is already gone.
    }
  },

  // From WhimsyPageParent: a link clicked in a source tab's page. Loads it
  // in the follower pane instead of letting the source navigate.
  onLinkFollowed(tab, url) {
    if (!this.enabled || !tab || !this.isSource(tab)) {
      return;
    }
    const partner = this.partnerOf(tab.ownerDocument.defaultView, tab);
    if (!partner || partner.closing) {
      this.stopSource(tab);
      return;
    }
    partner.linkedBrowser.fixupAndLoadURIString(url, {
      triggeringPrincipal: tab.linkedBrowser.contentPrincipal,
    });
  },
};
