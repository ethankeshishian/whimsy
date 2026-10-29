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

const MUTE_FEATURE_PREF = "whimsy.feature.background-mute";
const MUTE_PREF = "whimsy.media.background-mute";
const MUTE_REASON = "whimsy-background";
// A tab you unmuted by hand while Whimsy had it muted stays audible until
// you next select it.
const USER_UNMUTED = Symbol("whimsyUserUnmuted");

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
};
