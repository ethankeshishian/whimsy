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
    this.ensureObserver();
    gBrowser.tabContainer.addEventListener("TabSelect", event => {
      try {
        this.onTabSelect(win, event.detail?.previousTab, event.target);
      } catch (e) {
        console.error("Whimsy: call picture-in-picture", e);
      }
    });
  },

  ensureObserver() {
    if (this._observerSet) {
      return;
    }
    this._observerSet = true;
    Services.obs.addObserver(this, "domwindowopened");
    for (const pipWin of Services.wm.getEnumerator("Toolkit:PictureInPicture")) {
      this.hookPipWindow(pipWin);
    }
  },

  observe(subject, topic) {
    if (topic === "domwindowopened") {
      const win = subject;
      win.addEventListener(
        "load",
        () => {
          try {
            if (win.document?.documentElement?.getAttribute("windowtype") === "Toolkit:PictureInPicture") {
              this.hookPipWindow(win);
            }
          } catch (e) {}
        },
        { once: true }
      );
    }
  },

  // A browser or tab is in a call while it shares your camera or microphone.
  isInCallBrowser(browser) {
    const state = browser?._sharingState?.webRTC;
    return !!(state && (state.camera || state.microphone));
  },

  isInCall(tab) {
    return this.isInCallBrowser(tab?.linkedBrowser);
  },

  hookPipWindow(pipWin) {
    if (!pipWin || pipWin._whimsyCallHooked) {
      return;
    }
    pipWin._whimsyCallHooked = true;

    const findBrowser = () => {
      const pip = lazy.PictureInPicture;
      const browser = pip.weakWinToBrowser?.get(pipWin);
      if (browser) {
        return browser;
      }
      for (const win of Services.wm.getEnumerator("navigator:browser")) {
        const gBrowser = win.gBrowser;
        if (!gBrowser) {
          continue;
        }
        for (const tab of gBrowser.tabs) {
          if (this.isInCall(tab) && tab.hasAttribute("pictureinpicture")) {
            return tab.linkedBrowser;
          }
        }
      }
      return null;
    };

    const attach = () => {
      const browser = findBrowser();
      if (!browser) {
        return false;
      }
      const tab = browser.ownerDocument?.defaultView?.gBrowser?.getTabForBrowser?.(browser);
      if (!this.isInCall(tab)) {
        return false;
      }
      this.setupCallControls(pipWin, browser, tab);
      return true;
    };

    if (!attach()) {
      let attempts = 0;
      const interval = pipWin.setInterval?.(() => {
        attempts++;
        if (attach() || attempts > 20 || pipWin.closed) {
          pipWin.clearInterval?.(interval);
        }
      }, 50);
    }
  },

  // F32: in a call the PiP window's audio button (and M) mutes the
  // microphone, not the call's sound. The player's own Player object is a
  // top-level `let` in player.js, so it isn't reachable from here; the click
  // and the key are taken first, in the capture phase, and the button's
  // muted look is set through player.js's setIsMutedState().
  setupCallControls(pipWin, browser, tab) {
    const doc = pipWin.document;
    const audioBtn = doc?.getElementById("audio");
    if (audioBtn) {
      audioBtn.hidden = false;
    }
    if (!pipWin._whimsyCallControls) {
      pipWin._whimsyCallControls = true;
      // Firefox keeps the button in step with the video's own muted state
      // (a call's tiles are muted videos); in a call it shows the
      // microphone instead, so only Whimsy sets it.
      const setIsMutedState = pipWin.setIsMutedState;
      if (typeof setIsMutedState == "function") {
        pipWin._whimsySetMuted = setIsMutedState;
        pipWin.setIsMutedState = isMuted => {
          if (!this.isInCall(tab)) {
            setIsMutedState(isMuted);
          }
        };
      }
      pipWin.addEventListener("click", event => {
        if (event.target?.id == "audio" && this.isInCall(tab)) {
          event.stopPropagation();
          event.preventDefault();
          this.toggleCallMute(pipWin, browser);
        }
      }, true);
      pipWin.addEventListener("keydown", event => {
        if (event.key?.toLowerCase() == "m" && !event.metaKey && !event.ctrlKey && !event.altKey &&
            this.isInCall(tab)) {
          event.stopPropagation();
          event.preventDefault();
          this.toggleCallMute(pipWin, browser);
        }
      }, true);
    }
    const actor = browser.browsingContext?.currentWindowGlobal?.getActor("WhimsyPage");
    actor
      ?.sendQuery("Whimsy:GetMicrophoneState")
      .then(res => {
        if (res && typeof res.active === "boolean") {
          this.showCallMuted(pipWin, !res.active);
        }
      })
      .catch(() => {});
  },

  showCallMuted(pipWin, muted) {
    (pipWin._whimsySetMuted ?? pipWin.setIsMutedState)?.(muted);
  },

  isCallMuted(pipWin) {
    return !!pipWin.document?.getElementById("controls")?.classList.contains("muted");
  },

  async toggleCallMute(pipWin, browser) {
    const actor = browser.browsingContext?.currentWindowGlobal?.getActor("WhimsyPage");
    if (!actor) {
      return;
    }
    // Show the change at once; the page's answer settles it.
    this.showCallMuted(pipWin, !this.isCallMuted(pipWin));
    try {
      const res = await actor.sendQuery("Whimsy:ToggleMicrophone");
      if (res && typeof res.active === "boolean") {
        this.showCallMuted(pipWin, !res.active);
      }
    } catch (e) {
      console.error("Whimsy: toggle call microphone failed", e);
    }
  },

  onMicrophoneState(browser, active) {
    if (!browser) {
      return;
    }
    browser._whimsyMicrophoneActive = !!active;
    const pip = lazy.PictureInPicture;
    for (const pipWin of Services.wm.getEnumerator("Toolkit:PictureInPicture")) {
      if (pip.weakWinToBrowser?.get(pipWin) === browser) {
        this.showCallMuted(pipWin, !active);
      }
    }
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
    // Already floating: an open player shows this tab. (Firefox's
    // isOriginatingBrowser stays true until a closing player finishes
    // tearing down, which would skip a switch made right after coming back.)
    const floating = [...Services.wm.getEnumerator("Toolkit:PictureInPicture")].some(
      w => !w.closed && pip.weakWinToBrowser?.get(w) === browser
    );
    if (floating) {
      return false;
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
