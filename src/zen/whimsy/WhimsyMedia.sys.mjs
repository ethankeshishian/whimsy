/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Media: how tabs play sound.
//
// Mute background tabs (Vivaldi's Settings → Tabs → Tab Muting): a stray
// autoplay video in a background tab never talks over the tab you're
// looking at. whimsy.media.background-mute picks the mode:
// - "prioritize" (default): background tabs are muted only while the
//   current tab plays sound, and come back when it stops or you leave it.
// - "background": only the current tab ever plays sound.
// - "off": every tab plays, as in Firefox.
// Whimsy mutes with its own mute reason, so a mute (or unmute) you set by
// hand is never undone. Tabs in the current split view and tabs showing
// their video in picture-in-picture keep playing.

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  PrivateBrowsingUtils: "resource://gre/modules/PrivateBrowsingUtils.sys.mjs",
});

const MUTE_FEATURE_PREF = "whimsy.feature.background-mute";
const MUTE_PREF = "whimsy.media.background-mute";
const MUTE_REASON = "whimsy-background";
// A tab you unmuted by hand while Whimsy had it muted stays audible until
// you next select it.
const USER_UNMUTED = Symbol("whimsyUserUnmuted");

// Remember muted sites (Chrome's tab menu "Mute site"): the tab context
// menu's "Mute Site" mutes the site's open tabs, and every tab that goes
// to that site later opens muted, until "Unmute Site". People use it for
// news and shopping sites with autoplay video ads. The choice is a
// permission on the site (its base domain, all spaces and containers;
// private windows keep their own, forgotten when they close).
const SITE_FEATURE_PREF = "whimsy.feature.mute-site";
const SITE_PERMISSION = "whimsy-muted";
const SITE_REASON = "whimsy-site";
const SITE_MENU_ID = "context_whimsyMuteSite";

export const WhimsyMedia = {
  get backgroundMuteMode() {
    if (!Services.prefs.getBoolPref(MUTE_FEATURE_PREF, true)) {
      return "off";
    }
    const mode = Services.prefs.getStringPref(MUTE_PREF, "prioritize");
    return ["prioritize", "background"].includes(mode) ? mode : "off";
  },

  initWindow(win) {
    this.initBackgroundMute(win);
    this.initMuteSite(win);
  },

  // --- Mute background tabs ---

  initBackgroundMute(win) {
    const { gBrowser } = win;
    const container = gBrowser.tabContainer;
    const update = () => {
      try {
        this.applyBackgroundMute(win);
      } catch (e) {
        console.error("Whimsy: background mute", e);
      }
    };
    container.addEventListener("TabSelect", update);
    container.addEventListener("TabAttrModified", event => {
      const changed = event.detail?.changed ?? [];
      if (changed.includes("muted") && !this._muting) {
        const tab = event.target;
        if (!tab.hasAttribute("muted") && tab[USER_UNMUTED] === false) {
          tab[USER_UNMUTED] = true;
        }
      }
      if (changed.includes("soundplaying") || changed.includes("pictureinpicture")) {
        update();
      }
    });
    const observer = () => update();
    Services.prefs.addObserver(MUTE_PREF, observer);
    Services.prefs.addObserver(MUTE_FEATURE_PREF, observer);
    win.addEventListener(
      "unload",
      () => {
        Services.prefs.removeObserver(MUTE_PREF, observer);
        Services.prefs.removeObserver(MUTE_FEATURE_PREF, observer);
      },
      { once: true }
    );
  },

  isAutoMuted(tab) {
    return tab.hasAttribute("muted") && tab.muteReason == MUTE_REASON;
  },

  // A tab that keeps its sound whatever the mode: on screen in the current
  // split view, or playing in a picture-in-picture window.
  isExempt(tab, selected) {
    if (tab == selected || tab.pictureinpicture) {
      return true;
    }
    const group = selected.group;
    return !!group?.hasAttribute?.("split-view-group") && tab.group == group;
  },

  applyBackgroundMute(win) {
    const { gBrowser } = win;
    const selected = gBrowser.selectedTab;
    const mode = this.backgroundMuteMode;
    // The tab you're on is never one Whimsy keeps quiet.
    selected[USER_UNMUTED] = undefined;
    const quiet = new Set();
    if (mode == "background" || (mode == "prioritize" && this.playsSound(gBrowser, selected))) {
      for (const tab of gBrowser.tabs) {
        if (this.isExempt(tab, selected) || tab[USER_UNMUTED]) {
          continue;
        }
        if (this.isAutoMuted(tab) || (tab.soundPlaying && !tab.hasAttribute("muted"))) {
          quiet.add(tab);
        }
      }
    }
    for (const tab of gBrowser.tabs) {
      const auto = this.isAutoMuted(tab);
      if (quiet.has(tab) && !auto) {
        this.setMuted(tab, true);
      } else if (!quiet.has(tab) && auto) {
        this.setMuted(tab, false);
      }
    }
  },

  // The current tab, or a tab beside it in split view, is making sound.
  playsSound(gBrowser, selected) {
    return gBrowser.tabs.some(
      tab => tab.soundPlaying && !tab.hasAttribute("muted") && this.isExempt(tab, selected) && !tab.pictureinpicture
    );
  },

  setMuted(tab, muted) {
    if (tab.hasAttribute("muted") == muted) {
      return;
    }
    this._muting = true;
    try {
      tab.toggleMuteAudio(muted ? MUTE_REASON : null);
      tab[USER_UNMUTED] = muted ? false : undefined;
    } finally {
      this._muting = false;
    }
  },

  // --- Remember muted sites ---

  get muteSiteEnabled() {
    return Services.prefs.getBoolPref(SITE_FEATURE_PREF, true);
  },

  // The site's key: its base domain over https (so http, https and every
  // subdomain share one choice), or its host when it has no base domain.
  sitePrincipal(uri, privateBrowsing) {
    if (!uri || !["http", "https"].includes(uri.scheme) || !uri.host) {
      return null;
    }
    let site = uri.host;
    try {
      site = Services.eTLD.getBaseDomain(uri);
    } catch (e) {
      // IP addresses, localhost: the host is the site.
    }
    const origin = Services.io.newURI(`https://${site}`);
    return Services.scriptSecurityManager.createContentPrincipal(origin, {
      privateBrowsingId: privateBrowsing ? 1 : 0,
    });
  },

  siteFor(browser) {
    const uri = browser?.currentURI;
    const win = browser?.ownerGlobal;
    const principal = this.sitePrincipal(uri, win && lazy.PrivateBrowsingUtils.isWindowPrivate(win));
    return principal ? { principal, host: principal.host } : null;
  },

  isSiteMuted(principal) {
    return (
      !!principal &&
      Services.perms.testExactPermissionFromPrincipal(principal, SITE_PERMISSION) == Services.perms.ALLOW_ACTION
    );
  },

  initMuteSite(win) {
    const { gBrowser, document } = win;
    gBrowser.addTabsProgressListener({
      onLocationChange: (browser, webProgress, request, location, flags) => {
        if (!webProgress.isTopLevel || flags & Ci.nsIWebProgressListener.LOCATION_CHANGE_SAME_DOCUMENT) {
          return;
        }
        const tab = gBrowser.getTabForBrowser(browser);
        if (tab) {
          this.applySiteMute(tab);
        }
      },
    });
    const menu = document.getElementById("tabContextMenu");
    menu?.addEventListener("popupshowing", event => {
      if (event.target == menu) {
        this.updateMuteSiteMenu(win);
      }
    });
  },

  // Mute a tab on a muted site; unmute one Whimsy muted for a site it left.
  applySiteMute(tab) {
    if (!this.muteSiteEnabled) {
      return;
    }
    const site = this.siteFor(tab.linkedBrowser);
    const muted = this.isSiteMuted(site?.principal);
    if (muted && !tab.hasAttribute("muted")) {
      tab.toggleMuteAudio(SITE_REASON);
    } else if (!muted && tab.hasAttribute("muted") && tab.muteReason == SITE_REASON) {
      tab.toggleMuteAudio();
    }
  },

  updateMuteSiteMenu(win) {
    const { document } = win;
    let item = document.getElementById(SITE_MENU_ID);
    const tab = win.TabContextMenu?.contextTab;
    const site = this.muteSiteEnabled && tab && !tab.multiselected ? this.siteFor(tab.linkedBrowser) : null;
    if (!site) {
      if (item) {
        item.hidden = true;
      }
      return;
    }
    if (!item) {
      item = document.createXULElement("menuitem");
      item.id = SITE_MENU_ID;
      item.addEventListener("command", () => {
        const contextTab = win.TabContextMenu?.contextTab;
        if (contextTab) {
          this.toggleSiteMute(win, contextTab);
        }
      });
      const anchor =
        document.getElementById("context_toggleMuteSelectedTabs") || document.getElementById("context_toggleMuteTab");
      anchor ? anchor.after(item) : document.getElementById("tabContextMenu").appendChild(item);
    }
    item.hidden = false;
    document.l10n.setAttributes(
      item,
      this.isSiteMuted(site.principal) ? "tab-context-whimsy-unmute-site" : "tab-context-whimsy-mute-site",
      { site: site.host }
    );
  },

  // Returns whether the site is now muted.
  toggleSiteMute(win, tab) {
    const site = this.siteFor(tab.linkedBrowser);
    if (!site) {
      return false;
    }
    const mute = !this.isSiteMuted(site.principal);
    if (mute) {
      const expire = site.principal.privateBrowsingId
        ? Services.perms.EXPIRE_SESSION
        : Services.perms.EXPIRE_NEVER;
      Services.perms.addFromPrincipal(site.principal, SITE_PERMISSION, Services.perms.ALLOW_ACTION, expire);
    } else {
      Services.perms.removeFromPrincipal(site.principal, SITE_PERMISSION);
    }
    // Every open tab on the site, in every window of the same kind.
    for (const other of Services.wm.getEnumerator("navigator:browser")) {
      for (const t of other.gBrowser?.tabs ?? []) {
        if (this.siteFor(t.linkedBrowser)?.principal.equals(site.principal)) {
          if (!mute && t == tab && t.hasAttribute("muted")) {
            t.toggleMuteAudio();
          } else {
            this.applySiteMute(t);
          }
        }
      }
    }
    win.gZenUIManager?.showToast?.(mute ? "whimsy-mute-site-toast" : "whimsy-unmute-site-toast", {
      l10nArgs: { site: site.host },
    });
    return mute;
  },
};
