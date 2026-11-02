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
  WhimsyCommands: "resource:///modules/whimsy/WhimsyCommands.sys.mjs",
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
    // F31: Live Captions for This Call (no key by default; one can be set
    // in Settings → Keyboard Shortcuts).
    lazy.WhimsyCommands.register(win, {
      id: "cmd_whimsyCallCaptions",
      l10nId: "whimsy-action-call-captions",
      run: w => this.toggleCaptions(w.gBrowser.selectedBrowser),
      key: null,
      icon: "chrome://global/skin/media/closed-caption-settings-button.svg",
      isAvailable: w => this.isInCall(w.gBrowser.selectedTab),
    });
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
      pipWin._whimsyCallBrowser = browser;
      pipWin.addEventListener("click", event => {
        if (event.target?.id == "closed-caption" && this.isInCall(tab)) {
          event.stopPropagation();
          event.preventDefault();
          this.toggleCaptions(browser);
          return;
        }
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
    this.showCaptionsButton(pipWin, browser);
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

  // F31: turns the call's live captions on or off (WhimsyVideoSpeedChild).
  // Resolves to "on", "off" or why not ("no-video", "unavailable").
  async toggleCaptions(browser) {
    const actor = browser?.browsingContext?.currentWindowGlobal?.getActor("WhimsyVideoSpeed");
    let state = "unavailable";
    try {
      state = (await actor?.sendQuery("WhimsyVideoSpeed:CallCaptions")) ?? "unavailable";
    } catch (e) {}
    browser._whimsyCallCaptions = state == "on";
    for (const pipWin of this.pipWindowsFor(browser)) {
      this.showCaptionsButton(pipWin, browser);
      if (state != "on") {
        this.writeCaption(pipWin, "");
      }
    }
    return state;
  },

  pipWindowsFor(browser) {
    const wins = [];
    for (const pipWin of Services.wm.getEnumerator("Toolkit:PictureInPicture")) {
      if (lazy.PictureInPicture.weakWinToBrowser?.get(pipWin) == browser || pipWin._whimsyCallBrowser == browser) {
        wins.push(pipWin);
      }
    }
    return wins;
  },

  // The caption text in the call's PiP window(s).
  showCaption(browser, text) {
    for (const pipWin of this.pipWindowsFor(browser)) {
      this.writeCaption(pipWin, text);
    }
  },

  writeCaption(pipWin, text) {
    const doc = pipWin.document;
    let box = doc.getElementById("whimsy-call-caption");
    if (!box && text) {
      box = doc.createElement("div");
      box.id = "whimsy-call-caption";
      box.setAttribute("role", "status");
      Object.assign(box.style, {
        position: "fixed", insetInline: "8%", bottom: "64px", zIndex: "10", textAlign: "center",
        pointerEvents: "none", font: "600 15px/1.35 system-ui, sans-serif", color: "#fff",
      });
      const line = doc.createElement("span");
      Object.assign(line.style, { background: "rgba(0,0,0,0.72)", padding: "3px 8px", borderRadius: "6px",
        boxDecorationBreak: "clone" });
      box.append(line);
      doc.body.append(box);
    }
    if (box) {
      box.firstChild.textContent = text;
      box.hidden = !text;
    }
  },

  // The player's own CC button, which a call's muted tiles never enable:
  // in a call it turns the live captions on and off.
  showCaptionsButton(pipWin, browser) {
    const cc = pipWin.document?.getElementById("closed-caption");
    if (!cc) {
      return;
    }
    // The player hides and disables it again for a video without text
    // tracks (every call tile): kept on while it's a call.
    if (!pipWin._whimsyCcObserver) {
      pipWin._whimsyCcObserver = new pipWin.MutationObserver(() => {
        if ((cc.hidden || cc.disabled) && this.isInCallBrowser(browser)) {
          cc.hidden = false;
          cc.disabled = false;
        }
      });
      pipWin._whimsyCcObserver.observe(cc, { attributes: true, attributeFilter: ["hidden", "disabled"] });
    }
    cc.hidden = false;
    cc.disabled = false;
    cc.removeAttribute("disabled");
    cc.setAttribute("aria-pressed", String(!!browser._whimsyCallCaptions));
    cc.classList.toggle("whimsy-call-captions-on", !!browser._whimsyCallCaptions);
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
