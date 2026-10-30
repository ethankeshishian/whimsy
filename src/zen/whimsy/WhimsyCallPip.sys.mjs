/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// wave3: floating calls (whimsy.feature.call-pip).
//
// Arc: when you're in a Google Meet (or Zoom, Teams...) call and switch to
// another tab, the call pops out into a floating picture-in-picture window,
// so you keep seeing who's talking while you look something up; going back
// to the call's tab (or clicking the window) puts it back. People love it
// because a call never disappears behind the tab you switched to.
//
// Firefox already opens picture-in-picture when you leave a tab playing a
// video (media.videocontrols.picture-in-picture.enable-when-switching-tabs,
// on in Whimsy), but call videos never qualify: their sound plays from
// separate audio elements, so the videos are muted or silent. Here, a tab
// counts as a call while it uses your camera or microphone (WebRTC), on
// any site, and leaving it asks WhimsyPageChild to put the call's main
// video in Firefox's picture-in-picture player. Firefox's own TabSelect
// handling closes it again when you come back (the window opens while the
// call's tab is in the background, which is how it marks an automatic
// PiP), and closing the window by hand skips the next automatic one, as
// Firefox does for videos.
//
// Not covered: Arc's floating window also has mute/camera/leave buttons;
// Firefox's player only shows the video. Zoom's web client draws video on a
// <canvas>, which picture-in-picture can't show.

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  PictureInPicture: "moz-src:///toolkit/components/pictureinpicture/PictureInPicture.sys.mjs",
});

const FEATURE_PREF = "whimsy.feature.call-pip";
const PIP_ENABLED_PREF = "media.videocontrols.picture-in-picture.enabled";

export const WhimsyCallPip = {
  get enabled() {
    return (
      Services.prefs.getBoolPref(FEATURE_PREF, true) && Services.prefs.getBoolPref(PIP_ENABLED_PREF, true)
    );
  },

  initWindow(win) {
    const { gBrowser } = win;
    if (!gBrowser || gBrowser._whimsyCallPip) {
      return;
    }
    gBrowser._whimsyCallPip = true;
    gBrowser.tabContainer.addEventListener("TabSelect", event => {
      try {
        this.onTabSelect(win, event.detail?.previousTab, event.target);
      } catch (e) {
        console.error("Whimsy: call picture-in-picture", e);
      }
    });
  },

  // A tab is in a call while it shares your camera or microphone.
  isInCall(tab) {
    const state = tab?.linkedBrowser?._sharingState?.webRTC;
    return !!(state && (state.camera || state.microphone));
  },

  // Whether the call stays on screen anyway: the new tab is in the same
  // split view.
  stillVisible(previous, selected) {
    const group = previous.group;
    return !!group?.hasAttribute?.("split-view-group") && selected?.group == group;
  },

  onTabSelect(win, previous, selected) {
    if (!previous || previous == selected || previous.closing || !previous.isConnected) {
      return false;
    }
    if (!this.enabled || !this.isInCall(previous) || this.stillVisible(previous, selected)) {
      return false;
    }
    const browser = previous.linkedBrowser;
    const pip = lazy.PictureInPicture;
    if (pip.isOriginatingBrowser?.(browser)) {
      return false; // Already floating.
    }
    // Closing the window by hand skips the next automatic one (Firefox's
    // rule for videos, which this set is shared with).
    if (pip.weakAutoPipBrowserClosedDeliberately?.has(browser)) {
      pip.weakAutoPipBrowserClosedDeliberately.delete(browser);
      return false;
    }
    const actor = browser.browsingContext?.currentWindowGlobal?.getActor("WhimsyPage");
    if (!actor) {
      return false;
    }
    actor.sendAsyncMessage("Whimsy:CallPip");
    return true;
  },
};
