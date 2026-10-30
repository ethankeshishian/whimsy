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
  WhimsyCommands: "resource:///modules/whimsy/WhimsyCommands.sys.mjs",
  PictureInPicture: "moz-src:///toolkit/components/pictureinpicture/PictureInPicture.sys.mjs",
  SessionStore: "moz-src:///browser/components/sessionstore/SessionStore.sys.mjs",
  // wave3/speed: the speed each site plays at.
  WhimsyVideoSpeed: "resource:///modules/whimsy/WhimsyVideoSpeed.sys.mjs",
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

// Per-tab volume (the Volume Master extension, Opera GX's per-tab limiter):
// right-click a tab's speaker, or "Volume…" in the tab menu, and drag the
// slider. Gecko has no per-tab volume, so WhimsyPageChild scales every
// audio and video element in the tab (each keeps the volume the page set).
// The level survives reloads and restarts (session store). Web Audio
// isn't reached, and there's no boost above 100%.
const VOLUME_FEATURE_PREF = "whimsy.feature.tab-volume";
const VOLUME_KEY = "whimsy-volume";
const VOLUME_MENU_ID = "context_whimsyTabVolume";
const VOLUME_PANEL_ID = "whimsy-volume-panel";

// PiP snaps back (Arc): going back to a tab whose video is in a
// picture-in-picture window puts the video back in the page, whether the
// player opened by itself (automatic PiP, which Firefox already closes) or
// by hand. whimsy.media.pip-snap-back (Settings → Tab Management).
// Automatic PiP itself is Firefox's, now on by default; its checkbox is in
// Firefox's Media settings.
const PIP_FEATURE_PREF = "whimsy.feature.pip-snap-back";
const PIP_PREF = "whimsy.media.pip-snap-back";

// Playback speed (the Video Speed Controller extension): Cmd+Opt+. speeds
// up the video the page is about by 0.25×, Cmd+Opt+, slows it, Cmd+Opt+0
// goes back to 1×, with a toast saying the speed. Also in the command bar.
// Firefox's own speed control in the picture-in-picture player is turned
// on (media.videocontrols.picture-in-picture.playback-speed.enabled).
const SPEED_FEATURE_PREF = "whimsy.feature.playback-speed";
const SPEED_STEP = 0.25;

// fixD: two tabs playing, and switching tabs left one of them audible.
// Firefox drops a tab's soundplaying flag 3 s after it goes quiet, and a
// muted tab counts as quiet; unmuted again within those 3 s, only
// soundplaying-scheduledremoval changes. So the tab you selected, which
// Whimsy had muted, didn't count as playing (no one was muted for it) and
// nothing checked again once it was audible: the other tab stayed on.
// Whimsy now remembers that a tab it muted was playing, re-checks on
// either attribute, and once more a moment after every switch.
const WAS_PLAYING = Symbol("whimsyMutedWhilePlaying");
const RECHECK_MS = 1000;

// fixD: automatic picture-in-picture (Arc pops a playing video out when you
// switch tabs or spaces). Firefox's own auto-PiP does this (on by default
// in Whimsy), deciding once the page reports it went hidden, after the
// switch, and never for a muted tab. Background muting muted the tab on
// the switch itself, so the video never popped out. A playing tab with a
// PiP-able video now gets a moment to pop out before Whimsy mutes it (a
// tab in PiP keeps its sound). Zen spaces switch by selecting a tab in the
// other space, so the same path covers them.
const AUTO_PIP_FEATURE_PREF = "whimsy.feature.pip-auto-before-mute";
const AUTO_PIP_PREF = "media.videocontrols.picture-in-picture.enable-when-switching-tabs.enabled";
const PIP_ENABLED_PREF = "media.videocontrols.picture-in-picture.enabled";
const PIP_GRACE = Symbol("whimsyPipGrace");
const PIP_GRACE_MS = 1000;

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
    this.initTabVolume(win);
    this.initPlaybackSpeed(win);
    win.gBrowser.tabContainer.addEventListener("TabSelect", event => {
      try {
        this.snapBackPip(event.target);
      } catch (e) {
        console.error("Whimsy: PiP snap back", e);
      }
    });
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
    let recheck = null;
    container.addEventListener("TabSelect", event => {
      try {
        this.giveAutoPipAMoment(win, event.detail?.previousTab, update);
      } catch (e) {
        console.error("Whimsy: auto PiP before mute", e);
      }
      update();
      win.clearTimeout(recheck);
      recheck = win.setTimeout(update, RECHECK_MS);
    });
    container.addEventListener("TabAttrModified", event => {
      const changed = event.detail?.changed ?? [];
      if (changed.includes("muted") && !this._muting) {
        const tab = event.target;
        if (!tab.hasAttribute("muted") && tab[USER_UNMUTED] === false) {
          tab[USER_UNMUTED] = true;
        }
      }
      if (
        changed.includes("soundplaying") ||
        changed.includes("soundplaying-scheduledremoval") ||
        changed.includes("pictureinpicture")
      ) {
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
        if (this.isExempt(tab, selected) || tab[USER_UNMUTED] || tab[PIP_GRACE]) {
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

  // The current tab, or a tab beside it in split view, is making sound, or
  // was when Whimsy muted it (it's about to be unmuted).
  playsSound(gBrowser, selected) {
    return gBrowser.tabs.some(
      tab =>
        this.isExempt(tab, selected) &&
        !tab.pictureinpicture &&
        ((tab.soundPlaying && !tab.hasAttribute("muted")) ||
          (this.isAutoMuted(tab) && (tab.soundPlaying || tab[WAS_PLAYING])))
    );
  },

  // A tab you just left that Firefox may pop into picture-in-picture: auto
  // PiP is on, the tab plays sound unmuted, and its page has a PiP-able
  // video. It isn't muted for PIP_GRACE_MS, then it's checked again.
  giveAutoPipAMoment(win, tab, update) {
    if (!this.autoPipCandidate(tab)) {
      return;
    }
    tab[PIP_GRACE] = true;
    win.setTimeout(() => {
      delete tab[PIP_GRACE];
      update();
    }, PIP_GRACE_MS);
  },

  autoPipCandidate(tab) {
    if (
      !tab ||
      tab.closing ||
      tab.selected ||
      !Services.prefs.getBoolPref(AUTO_PIP_FEATURE_PREF, true) ||
      !Services.prefs.getBoolPref(PIP_ENABLED_PREF, false) ||
      !Services.prefs.getBoolPref(AUTO_PIP_PREF, false) ||
      !tab.soundPlaying ||
      tab.hasAttribute("muted") ||
      tab.pictureinpicture
    ) {
      return false;
    }
    const browser = tab.linkedBrowser;
    if (!browser?.browsingContext) {
      return false;
    }
    return lazy.PictureInPicture.getEligiblePipVideoCount(browser).totalPipCount > 0;
  },

  setMuted(tab, muted) {
    if (tab.hasAttribute("muted") == muted) {
      return;
    }
    this._muting = true;
    try {
      const playing = tab.soundPlaying;
      tab.toggleMuteAudio(muted ? MUTE_REASON : null);
      tab[USER_UNMUTED] = muted ? false : undefined;
      tab[WAS_PLAYING] = muted ? playing : undefined;
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
    const win = browser?.ownerDocument?.defaultView;
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
    // wave5: the tab menu's "Mute Site" as a command for the current tab.
    const siteMuted = w => {
      const site = this.siteFor(w.gBrowser.selectedBrowser);
      return site ? this.isSiteMuted(site.principal) : null;
    };
    lazy.WhimsyCommands.register(win, {
      id: "cmd_whimsyMuteSite",
      l10nId: "whimsy-action-mute-site-toggle",
      run: w => this.muteSiteEnabled && this.toggleSiteMute(w, w.gBrowser.selectedTab),
      icon: "chrome://browser/skin/zen-icons/media-mute.svg",
      variants: [
        { l10nId: "whimsy-action-mute-site", isAvailable: w => this.muteSiteEnabled && siteMuted(w) === false },
        { l10nId: "whimsy-action-unmute-site", isAvailable: w => this.muteSiteEnabled && siteMuted(w) === true },
      ],
    });
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

  // --- Per-tab volume ---

  get tabVolumeEnabled() {
    return Services.prefs.getBoolPref(VOLUME_FEATURE_PREF, true);
  },

  // The tab's level, 0 to 1 (1 = as the page sets it).
  volumeFor(tab) {
    if (!tab || !this.tabVolumeEnabled) {
      return 1;
    }
    if (tab.whimsyVolume === undefined) {
      const saved = parseFloat(lazy.SessionStore.getCustomTabValue(tab, VOLUME_KEY));
      tab.whimsyVolume = Number.isFinite(saved) ? Math.min(1, Math.max(0, saved)) : 1;
    }
    return tab.whimsyVolume;
  },

  setTabVolume(tab, level) {
    if (!tab || !Number.isFinite(level)) {
      return;
    }
    level = Math.round(Math.min(1, Math.max(0, level)) * 100) / 100;
    tab.whimsyVolume = level;
    try {
      if (level == 1) {
        lazy.SessionStore.deleteCustomTabValue(tab, VOLUME_KEY);
      } else {
        lazy.SessionStore.setCustomTabValue(tab, VOLUME_KEY, String(level));
      }
    } catch (e) {
      // A tab the session store doesn't know yet (closing, or brand new).
    }
    this.sendToFrames(tab.linkedBrowser, "Whimsy:SetVolume", { level: this.volumeFor(tab) });
  },

  sendToFrames(browser, name, data) {
    const contexts = browser?.browsingContext?.getAllBrowsingContextsInSubtree() ?? [];
    for (const context of contexts) {
      try {
        context.currentWindowGlobal?.getActor("WhimsyPage").sendAsyncMessage(name, data);
      } catch (e) {
        // A frame that is going away, or one actors can't run in.
      }
    }
  },

  canAdjustVolume(tab) {
    return (
      this.tabVolumeEnabled &&
      !!tab?.linkedPanel &&
      (tab.soundPlaying || tab.hasAttribute("muted") || this.volumeFor(tab) < 1)
    );
  },

  initTabVolume(win) {
    const { document, gBrowser } = win;
    // wave5: the tab menu's "Volume…" as a command for the current tab.
    lazy.WhimsyCommands.register(win, {
      id: "cmd_whimsyTabVolume",
      l10nId: "whimsy-action-tab-volume",
      run: w => this.canAdjustVolume(w.gBrowser.selectedTab) && this.openVolumePanel(w, w.gBrowser.selectedTab),
      icon: "chrome://browser/skin/zen-icons/media-unmute.svg",
      isAvailable: w => this.canAdjustVolume(w.gBrowser.selectedTab),
    });
    const update = () => {
      for (const tab of gBrowser.tabs) {
        this.sendToFrames(tab.linkedBrowser, "Whimsy:SetVolume", { level: this.volumeFor(tab) });
      }
      if (!this.tabVolumeEnabled) {
        document.getElementById(VOLUME_PANEL_ID)?.hidePopup();
      }
    };
    Services.prefs.addObserver(VOLUME_FEATURE_PREF, update);
    win.addEventListener("unload", () => Services.prefs.removeObserver(VOLUME_FEATURE_PREF, update), { once: true });
    const menu = document.getElementById("tabContextMenu");
    menu?.addEventListener("popupshowing", event => {
      if (event.target == menu) {
        this.updateVolumeMenu(win);
      }
    });
    // Right-clicking a tab's speaker opens the slider instead of the menu.
    gBrowser.tabContainer.addEventListener(
      "contextmenu",
      event => {
        const speaker = event.target.closest?.(".tab-audio-button, .tab-icon-overlay");
        const tab = speaker?.closest("tab");
        if (!tab || !this.canAdjustVolume(tab)) {
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        this.openVolumePanel(win, tab, speaker);
      },
      true
    );
  },

  updateVolumeMenu(win) {
    const { document } = win;
    let item = document.getElementById(VOLUME_MENU_ID);
    const tab = win.TabContextMenu?.contextTab;
    const show = !!tab && !tab.multiselected && this.canAdjustVolume(tab);
    if (!show) {
      if (item) {
        item.hidden = true;
      }
      return;
    }
    if (!item) {
      item = document.createXULElement("menuitem");
      item.id = VOLUME_MENU_ID;
      document.l10n.setAttributes(item, "tab-context-whimsy-volume");
      item.addEventListener("command", () => {
        const contextTab = win.TabContextMenu?.contextTab;
        if (contextTab) {
          this.openVolumePanel(win, contextTab);
        }
      });
      const anchor =
        document.getElementById("context_toggleMuteSelectedTabs") || document.getElementById("context_toggleMuteTab");
      anchor ? anchor.after(item) : document.getElementById("tabContextMenu").appendChild(item);
    }
    item.hidden = false;
  },

  volumePanel(win) {
    const { document } = win;
    let panel = document.getElementById(VOLUME_PANEL_ID);
    if (panel) {
      return panel;
    }
    panel = document.createXULElement("panel");
    panel.id = VOLUME_PANEL_ID;
    panel.setAttribute("type", "arrow");
    panel.setAttribute("noautofocus", "true");
    panel.setAttribute("role", "dialog");
    document.l10n.setAttributes(panel, "whimsy-volume-panel");
    const row = document.createXULElement("hbox");
    row.className = "whimsy-volume-row";
    row.setAttribute("align", "center");
    const mute = document.createXULElement("toolbarbutton");
    mute.className = "whimsy-volume-mute toolbarbutton-1";
    document.l10n.setAttributes(mute, "whimsy-volume-mute");
    const slider = document.createElementNS("http://www.w3.org/1999/xhtml", "input");
    slider.type = "range";
    slider.min = "0";
    slider.max = "100";
    slider.step = "5";
    slider.className = "whimsy-volume-slider";
    document.l10n.setAttributes(slider, "whimsy-volume-slider");
    const value = document.createElementNS("http://www.w3.org/1999/xhtml", "output");
    value.className = "whimsy-volume-value";
    row.append(mute, slider, value);
    panel.append(row);
    const show = () => {
      const tab = panel.whimsyTab;
      const level = this.volumeFor(tab);
      slider.value = String(Math.round(level * 100));
      value.textContent = new Intl.NumberFormat(undefined, { style: "percent" }).format(level);
      mute.toggleAttribute("muted", !!tab?.hasAttribute("muted"));
    };
    panel.whimsyUpdate = show;
    slider.addEventListener("input", () => {
      const tab = panel.whimsyTab;
      if (tab && !tab.closing) {
        this.setTabVolume(tab, parseInt(slider.value, 10) / 100);
        show();
      }
    });
    mute.addEventListener("command", () => {
      const tab = panel.whimsyTab;
      if (tab && !tab.closing) {
        tab.toggleMuteAudio();
        show();
      }
    });
    document.getElementById("mainPopupSet").appendChild(panel);
    return panel;
  },

  openVolumePanel(win, tab, anchor = null) {
    const panel = this.volumePanel(win);
    panel.whimsyTab = tab;
    panel.whimsyUpdate();
    const target = anchor?.getBoundingClientRect().width ? anchor : tab;
    panel.openPopup(target, { position: "after_start", triggerEvent: null });
    return panel;
  },

  // --- PiP snaps back ---

  get pipSnapBack() {
    return Services.prefs.getBoolPref(PIP_FEATURE_PREF, true) && Services.prefs.getBoolPref(PIP_PREF, true);
  },

  // Closes the tab's picture-in-picture players, putting the video back in
  // the page. Returns how many it closed.
  snapBackPip(tab) {
    const browser = tab?.linkedBrowser;
    const PiP = lazy.PictureInPicture;
    if (!this.pipSnapBack || !browser || !PiP.browserWeakMap.has(browser)) {
      return 0;
    }
    let closed = 0;
    for (const playerWin of Services.wm.getEnumerator("Toolkit:PictureInPicture")) {
      // The player's own "Back to tab" button (its actor isn't reachable
      // from outside the player's script).
      const unpip = playerWin.document?.getElementById("unpip");
      if (PiP.weakWinToBrowser.get(playerWin) === browser && unpip) {
        unpip.click();
        closed++;
      }
    }
    return closed;
  },

  // --- Playback speed ---

  get playbackSpeedEnabled() {
    return Services.prefs.getBoolPref(SPEED_FEATURE_PREF, true);
  },

  initPlaybackSpeed(win) {
    const commands = [
      ["cmd_whimsySpeedUp", "key_whimsySpeedUp", ".", { delta: SPEED_STEP }, "whimsy-action-speed-up"],
      ["cmd_whimsySlowDown", "key_whimsySlowDown", ",", { delta: -SPEED_STEP }, "whimsy-action-slow-down"],
      ["cmd_whimsySpeedReset", "key_whimsySpeedReset", "0", { reset: true }, "whimsy-action-speed-reset"],
    ];
    for (const [id, keyId, key, change, l10nId] of commands) {
      lazy.WhimsyCommands.register(win, {
        id,
        l10nId,
        run: w => this.changePlaybackRate(w, change),
        keyId,
        key: this.playbackSpeedEnabled ? { key, modifiers: "accel,alt" } : null,
        icon: "chrome://browser/skin/zen-icons/media-play.svg",
        isAvailable: w => this.playbackSpeedEnabled && !!w.gBrowser.selectedTab.linkedPanel,
      });
    }
  },

  // Finds the frame whose media the tab is about and changes its speed.
  // Returns the new rate, or null when the tab has no media.
  async changePlaybackRate(win, change, tab = win.gBrowser.selectedTab) {
    if (!this.playbackSpeedEnabled) {
      return null;
    }
    const contexts = tab.linkedBrowser?.browsingContext?.getAllBrowsingContextsInSubtree() ?? [];
    let best = null;
    for (const context of contexts) {
      try {
        const actor = context.currentWindowGlobal?.getActor("WhimsyPage");
        const info = actor && (await actor.sendQuery("Whimsy:MediaInfo"));
        if (info && (!best || info.playing > best.info.playing || (info.playing == best.info.playing && info.area > best.info.area))) {
          best = { actor, info };
        }
      } catch (e) {
        // A frame that went away.
      }
    }
    const rate = best ? await best.actor.sendQuery("Whimsy:SetRate", change) : null;
    if (rate === null) {
      win.gZenUIManager?.showToast?.("whimsy-speed-none-toast");
    } else {
      win.gZenUIManager?.showToast?.("whimsy-speed-toast", { l10nArgs: { rate } });
      // wave3/speed: the site's next videos play at it too.
      lazy.WhimsyVideoSpeed.remember(best.actor.browsingContext, rate).catch(console.error);
    }
    return rate;
  },
};
