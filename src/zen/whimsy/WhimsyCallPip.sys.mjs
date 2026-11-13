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
// PiP), and closing the window by hand keeps it closed until you return
// to the call's tab, as Firefox does for videos.
//
// W26: like Arc's floating window, a red Leave call button presses the
// call page's own hang-up control (WhimsyCallControls.findLeave) and closes
// the window; with no such control on the page it's hidden. The × still
// only closes the window. Not covered: Zoom's web client draws video on a
// <canvas>, which picture-in-picture can't show.
//
// W13-R3 (whimsy.feature.call-controls): the call's microphone and camera,
// in sync three ways: the page's own toggles (Meet) are the only state;
// the small player under the tab bar (Zen's sharing card) and the PiP
// window read it and toggle through it. Design:
// whimsy-handoff/wave13/r3-meetpip-design.md.

import { AppConstants } from "resource://gre/modules/AppConstants.sys.mjs";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  WhimsyCommands: "resource:///modules/whimsy/WhimsyCommands.sys.mjs",
  PictureInPicture: "moz-src:///toolkit/components/pictureinpicture/PictureInPicture.sys.mjs",
  SitePermissions: "resource:///modules/SitePermissions.sys.mjs",
  WhimsyCallOptionsPanel: "resource:///modules/whimsy/WhimsyCallOptionsPanel.sys.mjs",
});

const FEATURE_PREF = "whimsy.feature.call-pip";
const PIP_ENABLED_PREF = "media.videocontrols.picture-in-picture.enabled";

// W13-R3/W21: call controls.
const CONTROLS_PREF = "whimsy.feature.call-controls";
// W21: whether a plain click on the mic/camera does the call's own mute
// ("call", the default) or a hard device mute ("device"); Option-click (or
// the panel) always does the other one.
const DEFAULT_PREF = "whimsy.call.buttons-default";
const KINDS = ["mic", "camera"];
// W16-3: how long a camera press from another tab may answer the page's
// camera request, and how often (and how many times) a call with no
// playing video is asked again to float while its tab is in the background.
const CAMERA_INTENT_MS = 10000;
const RETRY_MS = 500;
const RETRY_TRIES = 7200;
// W26: how often an open call PiP asks its page which video should float,
// and how long another video must lead before the window follows it (no
// flicker while speakers trade the big tile).
const FOLLOW_MS = 500;
const FOLLOW_HOLD_MS = 1500;
const PERMISSION = { mic: "microphone", camera: "camera" };
// Zen's sharing card: its buttons and its muted attributes (Zen's icons).
const CARD_BUTTON = { mic: ".zen-media-mute-mic-button", camera: ".zen-media-mute-camera-button" };
const CARD_MUTED = { mic: "mic-muted", camera: "camera-muted" };
const MUTE_MESSAGE = { mic: "webrtc:MuteMicrophone", camera: "webrtc:MuteCamera" };
const DEVICE_UNMUTE = { mic: "webrtc:UnmuteMicrophone", camera: "webrtc:UnmuteCamera" };
const L10N = {
  mic: { on: "whimsy-call-mic-turn-off", off: "whimsy-call-mic-turn-on" },
  camera: { on: "whimsy-call-camera-turn-off", off: "whimsy-call-camera-turn-on" },
};
// W21: the device-mute labels, shown when buttonsDefault (or an unknown
// in-call state) means the glyph is the device mute, not the call's own.
const BLOCK_L10N = {
  mic: { on: "whimsy-call-mic-block", off: "whimsy-call-mic-unblock" },
  camera: { on: "whimsy-call-camera-block", off: "whimsy-call-camera-unblock" },
};
const PIP_L10N = {
  mic: { on: "whimsy-call-pip-mic-turn-off", off: "whimsy-call-pip-mic-turn-on" },
  camera: { on: "whimsy-call-pip-camera-turn-off", off: "whimsy-call-pip-camera-turn-on" },
};
const PIP_BLOCK_L10N = {
  mic: { on: "whimsy-call-pip-mic-block", off: "whimsy-call-pip-mic-unblock" },
  camera: { on: "whimsy-call-pip-camera-block", off: "whimsy-call-pip-camera-unblock" },
};
// Meet's own shortcuts, also in the PiP window.
const SHORTCUT_KEY = { mic: "D", camera: "E" };
const ACCEL = AppConstants.platform == "macosx" ? "⌘" : "Ctrl+";

// The PiP window's call buttons: Firefox's own control buttons with Zen's
// microphone and camera icons (the small player's), red when off as there.
// Firefox's speaker button and volume act on the call tile's video, which is
// always muted, so a call hides them.
const ICON = "chrome://browser/skin/zen-icons/";
// The PiP window loads only the player's own sheet, so a panel in it has none
// of the popup styling a browser window's panels get from global.css.
const PANEL_SHEETS = ["chrome://global/skin/design-system/panel.css", "chrome://global/skin/popup.css"];
const SURFACE_SHEET = "chrome://browser/content/whimsy/whimsy-surface.css";
const PIP_SHEET =
  "data:text/css," +
  encodeURIComponent(`
panel.whimsy-surface { --panel-background-color: var(--arrowpanel-background); }
:where(panel.whimsy-surface button, panel.whimsy-surface input) { font: inherit; }
#whimsy-call-controls { display: flex; align-items: center; gap: 8px; }
#whimsy-call-mic { background-image: url("${ICON}microphone-fill.svg"); }
#whimsy-call-mic[data-state="off"] { background-image: url("${ICON}microphone-blocked-fill.svg"); }
#whimsy-call-camera { background-image: url("${ICON}video-fill.svg"); }
#whimsy-call-camera[data-state="off"] { background-image: url("${ICON}video-blocked-fill.svg"); }
:is(#whimsy-call-mic, #whimsy-call-camera)[data-state="off"] { fill: rgb(224, 41, 29); }
:is(#whimsy-call-mic, #whimsy-call-camera)[aria-busy="true"] { cursor: progress; }
/* W21: a corner badge for the mute that's on but isn't the main glyph —
   amber lock for the device mute, a red off-dot for the call's own mute. */
:is(#whimsy-call-mic, #whimsy-call-camera)[data-badge] { position: relative; }
:is(#whimsy-call-mic, #whimsy-call-camera)[data-badge]::after {
  content: "";
  position: absolute;
  inset-inline-end: 2px;
  inset-block-start: 2px;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  border: 1px solid #1c1c1e;
}
#whimsy-call-mic[data-badge="lock"]::after, #whimsy-call-camera[data-badge="lock"]::after { background: #f2a33c; }
#whimsy-call-mic[data-badge="off"]::after, #whimsy-call-camera[data-badge="off"]::after { background: rgb(224, 41, 29); }
/* W21: the Call Options button, separated from mic/camera by a hairline
   (border-inline-start) since this row is PiP-internal, not Zen's DOM. */
#whimsy-call-options {
  background-image: url("chrome://browser/content/whimsy/icons/call-options.svg");
  border-inline-start: 1px solid rgba(255, 255, 255, 0.3);
  margin-inline-start: 4px;
  padding-inline-start: 8px;
}
/* W26: Leave call, last in the row (it comes and goes with the page's
   hang-up control): the player's button, filled with the design system's
   destructive pair (tokens-shared.css), as Arc's and the call apps' own
   red hang-up buttons are. */
#whimsy-call-leave {
  background-image: url("chrome://browser/content/whimsy/icons/call-end.svg");
  background-color: var(--button-background-color-destructive);
  fill: var(--button-text-color-destructive);
  margin-inline-start: 4px;
}
#whimsy-call-leave:hover:enabled { background-color: var(--button-background-color-destructive-hover); }
#whimsy-call-leave:hover:active:enabled { background-color: var(--button-background-color-destructive-active); }
#whimsy-call-leave[aria-busy="true"] { cursor: progress; }
body[whimsy-call] :is(#audio, #audio-scrubber, #timestamp, #playbackRate) { display: none !important; }
body[whimsy-call] .end-controls,
body[whimsy-call] .end-controls:has(#playbackRate:not([hidden])) {
  grid-template-columns: repeat(2, 1fr);
  grid-template-areas: "closedcaption fullscreen";
}
@media (width <= 475px), (height <= 325px) and (width > 630px) {
  body[whimsy-call] .end-controls,
  body[whimsy-call] .end-controls:has(#playbackRate:not([hidden])) {
    grid-template-columns: 1fr;
    grid-template-areas: "fullscreen";
  }
}
@media (width <= 300px) {
  body[whimsy-call] .start-controls { display: grid; }
  body[whimsy-call] .controls-bottom-lower { grid-template-columns: repeat(3, 1fr); }
}
`);

// Whether a keydown is the shortcut a <key> element is bound to.
function keyMatches(keyEl, event) {
  const key = keyEl.getAttribute("key");
  const keycode = keyEl.getAttribute("keycode");
  if (!key && !keycode) {
    return false;
  }
  const mods = new Set((keyEl.getAttribute("modifiers") ?? "").split(/[\s,]+/).filter(Boolean));
  const mac = AppConstants.platform == "macosx";
  const want = {
    metaKey: mods.has("meta") || (mac && mods.has("accel")),
    ctrlKey: mods.has("control") || (!mac && mods.has("accel")),
    altKey: mods.has("alt"),
    shiftKey: mods.has("shift"),
  };
  if (Object.entries(want).some(([name, on]) => event[name] != on)) {
    return false;
  }
  if (keycode) {
    return event.keyCode == event.constructor[`DOM_${keycode}`];
  }
  const k = key.toUpperCase();
  return event.key?.toUpperCase() == k || event.code == (/\d/.test(k) ? `Digit${k}` : `Key${k}`);
}

export const WhimsyCallPip = {
  _closedByHand: new WeakSet(),

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
    // W13-R3: Press Call Microphone / Camera Button (no key by default); W21:
    // these now follow whichever mute buttonsDefault picks.
    for (const [kind, id, l10nId, icon] of [
      ["mic", "cmd_whimsyCallMicrophone", "whimsy-action-call-microphone", "microphone-fill.svg"],
      ["camera", "cmd_whimsyCallCamera", "whimsy-action-call-camera", "video-fill.svg"],
    ]) {
      lazy.WhimsyCommands.register(win, {
        id,
        l10nId,
        run: w => {
          const browser = this.commandTarget(w, kind);
          if (browser) {
            this.toggleDefault(browser, kind);
          }
        },
        key: null,
        icon: ICON + icon,
        isAvailable: w => !!this.commandTarget(w, kind),
      });
    }
    // W21: the four individual mutes, each independently assignable.
    for (const [kind, id, l10nId, icon] of [
      ["mic", "cmd_whimsyCallMicrophoneInCall", "whimsy-action-call-microphone-in-call", "microphone-fill.svg"],
      ["camera", "cmd_whimsyCallCameraInCall", "whimsy-action-call-camera-in-call", "video-fill.svg"],
    ]) {
      lazy.WhimsyCommands.register(win, {
        id,
        l10nId,
        run: w => {
          const browser = this.commandTarget(w, kind);
          if (browser) {
            this.toggleInCall(browser, kind);
          }
        },
        key: null,
        icon: ICON + icon,
        isAvailable: w => !!this.commandTarget(w, kind),
      });
    }
    for (const [kind, id, l10nId, icon] of [
      ["mic", "cmd_whimsyCallMicrophoneBlock", "whimsy-action-call-microphone-block", "microphone-fill.svg"],
      ["camera", "cmd_whimsyCallCameraBlock", "whimsy-action-call-camera-block", "video-fill.svg"],
    ]) {
      lazy.WhimsyCommands.register(win, {
        id,
        l10nId,
        run: w => {
          const browser = this.commandTarget(w, kind, true);
          if (browser) {
            this.toggleBlocked(browser, kind);
          }
        },
        key: null,
        icon: ICON + icon,
        isAvailable: w => !!this.commandTarget(w, kind, true),
      });
    }
    lazy.WhimsyCommands.register(win, {
      id: "cmd_whimsyCallButtonsDefault",
      l10nId: "whimsy-action-call-buttons-default",
      run: () => Services.prefs.setStringPref(DEFAULT_PREF, this.buttonsDefault == "call" ? "device" : "call"),
      key: null,
      icon: "chrome://browser/content/whimsy/icons/call-options.svg",
      isAvailable: () => true,
    });
    this.hookMediaBar(win);
    win.addEventListener("TabAttrModified", event => {
      if (event.detail?.changed?.includes("sharing")) {
        this.onSharingChanged(event.target);
      }
    });
    for (const type of ["TabClose", "TabBrowserDiscarded"]) {
      win.addEventListener(type, event => {
        const browser = event.target.linkedBrowser;
        // W16-17: the call's PiP goes with its tab. Firefox closes it on the
        // page's pagehide, which a page still capturing doesn't always get
        // to, and the player's own close button can't reach a page that's
        // gone.
        for (const pipWin of this.pipWindowsFor(browser)) {
          try {
            pipWin.close();
          } catch (e) {}
        }
        this.forget(browser);
      });
    }
    for (const tab of gBrowser.tabs) {
      if (this.isInCall(tab)) {
        this.watch(tab.linkedBrowser);
      }
    }
    gBrowser.tabContainer.addEventListener("TabSelect", event => {
      for (const tab of [event.detail?.previousTab, event.target]) {
        if (this._calls.has(tab?.linkedBrowser)) {
          this.render(tab.linkedBrowser);
        }
      }
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
    this.installDeliberateCloseHook();
    this.installCameraIntent();
    Services.obs.addObserver(this, "domwindowopened");
    // W13-R3: a camera or microphone blocked (or allowed) for a site hides
    // (or shows) its buttons; the switch turns the call controls off or on.
    Services.obs.addObserver(this, "perm-changed");
    Services.prefs.addObserver(CONTROLS_PREF, this);
    for (const pipWin of Services.wm.getEnumerator("Toolkit:PictureInPicture")) {
      this.hookPipWindow(pipWin);
    }
  },

  // Firefox consumes its deliberate-close flag as soon as closing the PiP
  // hides the video tab. Keep our own record before that happens, so the
  // unload retry cannot reopen a call the user has just closed.
  installDeliberateCloseHook() {
    if (this._deliberateCloseHookInstalled) {
      return;
    }
    const pip = lazy.PictureInPicture;
    const original = pip.closeSinglePipWindow;
    const self = this;
    pip.closeSinglePipWindow = function (...args) {
      const { reason, actorRef } = args[0];
      if (["CloseButton", "ClosePlayerShortcut", "Shortcut"].includes(reason)) {
        const browser = this.weakWinToBrowser.get(this.getWeakPipPlayer(actorRef));
        if (self.isInCallBrowser(browser) && self.isBackground(browser)) {
          self._closedByHand.add(browser);
        }
      }
      return original.apply(this, args);
    };
    this._deliberateCloseHookInstalled = true;
  },

  observe(subject, topic) {
    if (topic == "perm-changed") {
      const type = subject?.QueryInterface?.(Ci.nsIPermission)?.type;
      if (type == "camera" || type == "microphone") {
        for (const browser of this._calls) {
          this.render(browser);
        }
      }
      return;
    }
    if (topic == "nsPref:changed") {
      this.onControlsSwitched();
      return;
    }
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

  // The call's PiP window: its CC button captions the call (F31), and
  // W13-R3's microphone and camera buttons toggle the call's own controls.
  setupCallControls(pipWin, browser, tab) {
    pipWin._whimsyCallBrowser = browser;
    if (!pipWin._whimsyCallControls) {
      pipWin._whimsyCallControls = true;
      pipWin.addEventListener("click", event => {
        const id = event.target?.id;
        // W16-17: the call's page is gone (its tab closed or discarded):
        // Firefox's close button asks the page first, which can't answer.
        if (id == "close" && !pipWin._whimsyCallBrowser?.browsingContext) {
          event.stopPropagation();
          event.preventDefault();
          pipWin.close();
          return;
        }
        if (!this.isInCall(tab)) {
          return;
        }
        if (id == "closed-caption") {
          event.stopPropagation();
          event.preventDefault();
          this.toggleCaptions(browser);
          return;
        }
        if (id == "whimsy-call-leave") {
          event.stopPropagation();
          event.preventDefault();
          if (this.isPlainPress(event)) {
            this.leaveCall(pipWin, browser);
          }
          return;
        }
        if (id == "whimsy-call-options") {
          event.stopPropagation();
          event.preventDefault();
          if (!this.isPlainPress(event)) {
            return;
          }
          lazy.WhimsyCallOptionsPanel.open(pipWin, browser, { anchor: event.target });
          return;
        }
        const kind = id == "whimsy-call-mic" ? "mic" : id == "whimsy-call-camera" ? "camera" : null;
        if (kind) {
          event.stopPropagation();
          event.preventDefault();
          if (!this.isPlainPress(event)) {
            return;
          }
          if (event.altKey) {
            this.toggleOther(browser, kind);
          } else {
            this.toggleDefault(browser, kind);
          }
        }
      }, true);
      // Right-click and Ctrl-click (macOS's secondary click) on the call
      // buttons do nothing; the panel opens only from its own ⋯ button.
      pipWin.addEventListener("contextmenu", event => {
        const id = event.target?.id;
        if (["whimsy-call-mic", "whimsy-call-camera", "whimsy-call-options", "whimsy-call-leave"].includes(id) && this.isInCall(tab)) {
          event.stopPropagation();
          event.preventDefault();
        }
      }, true);
      pipWin.addEventListener("keydown", event => {
        if (this.forwardShortcut(browser, event)) {
          return;
        }
        const kind = this.pipKeyKind(event);
        if (kind && this.isInCall(tab)) {
          event.stopPropagation();
          event.preventDefault();
          if (event.shiftKey) {
            this.toggleOther(browser, kind);
          } else {
            this.toggleDefault(browser, kind);
          }
        }
      }, true);
      pipWin.addEventListener("unload", () => {
        pipWin.clearInterval(pipWin._whimsyFollowTimer);
        pipWin._whimsyFollowTimer = null;
        this.onCallPipClosed(pipWin._whimsyCallBrowser);
      }, { once: true });
    }
    this.showCaptionsButton(pipWin, browser);
    this.renderCameraOff(pipWin, browser);
    if (!pipWin._whimsyFollowTimer) {
      pipWin._whimsyFollowTimer = pipWin.setInterval(() => this.followCall(pipWin, pipWin._whimsyCallBrowser), FOLLOW_MS);
      this.followCall(pipWin, browser);
    }
    if (this.controlsEnabled) {
      this.addPipButtons(pipWin);
      this.watch(browser);
      this.renderPip(pipWin, browser);
    }
  },

  renderCameraOff(pipWin, browser) {
    const doc = pipWin.document;
    let box = doc.getElementById("whimsy-call-camera-off");
    if (!box) {
      doc.l10n?.addResourceIds(["browser/whimsy.ftl"]);
      box = doc.createElement("div");
      box.id = "whimsy-call-camera-off";
      box.setAttribute("role", "status");
      Object.assign(box.style, {
        position: "fixed", inset: "0", zIndex: "1", background: "#1c1c1e", color: "white",
        textAlign: "center", alignContent: "center", pointerEvents: "none",
        font: "500 16px/1.5 system-ui, sans-serif",
      });
      const icon = doc.createElement("span");
      icon.setAttribute("aria-hidden", "true");
      Object.assign(icon.style, {
        display: "block", width: "48px", height: "48px", margin: "0 auto 12px",
        background: `center / contain no-repeat url("${ICON}video-blocked-fill.svg")`,
        MozContextProperties: "fill", fill: "currentColor",
      });
      const label = doc.createElement("span");
      doc.l10n.setAttributes(label, "whimsy-call-pip-camera-off");
      box.append(icon, label);
      const controls = doc.getElementById("controls");
      if (controls) {
        controls.style.zIndex = "2";
      }
      doc.body.insertBefore(box, doc.body.firstChild);
    }
    // W26: the cover stands in for your own preview only. Someone else's
    // video is never covered, whatever your camera does.
    box.hidden = !this.isInCallBrowser(browser) || this.shownState(browser, "camera") != "off" ||
      pipWin._whimsyFloatingSelf !== true;
  },

  // W26: keeps the open call PiP on the call's main video (WhimsyPageChild
  // callFollow): another participant over your own preview, then the
  // active speaker's (biggest) tile once it has led for FOLLOW_HOLD_MS.
  // The window stays open and shows the new video in place. It also learns
  // whether the floating video is your own preview, for the cover.
  async followCall(pipWin, browser) {
    if (pipWin.closed || pipWin._whimsyFollowPending || !this.enabled || !this.isInCallBrowser(browser)) {
      return;
    }
    pipWin._whimsyFollowPending = true;
    try {
      const actor = browser.browsingContext?.currentWindowGlobal?.getActor("WhimsyPage");
      const follow = this.isBackground(browser) && !this._closedByHand.has(browser);
      const floating = await actor?.sendQuery("Whimsy:CallFollow", { holdMs: FOLLOW_HOLD_MS, follow });
      if (!pipWin.closed) {
        pipWin._whimsyFloatingSelf = floating ? !!floating.self : null;
        pipWin._whimsyCanLeave = !!floating?.leave;
        this.renderCameraOff(pipWin, browser);
        this.renderLeave(pipWin, browser);
      }
    } catch (e) {
      // Navigation or teardown while the page was answering.
    } finally {
      pipWin._whimsyFollowPending = false;
    }
  },

  // W26: the Leave call button shows only while the page has a hang-up
  // control to press (followCall asks every FOLLOW_MS), never as a dead
  // button.
  renderLeave(pipWin, browser) {
    const button = pipWin.document?.getElementById("whimsy-call-leave");
    if (button) {
      button.hidden = !this.controlsEnabled || !this.isInCallBrowser(browser) || pipWin._whimsyCanLeave !== true;
    }
  },

  // W26: presses the call page's own hang-up control, then closes the
  // window. Counted as closed by hand, so it doesn't float again while the
  // page is still hanging up. With no control left to press, the button
  // hides and the window stays.
  async leaveCall(pipWin, browser) {
    const button = pipWin.document.getElementById("whimsy-call-leave");
    if (button?.getAttribute("aria-busy") == "true") {
      return;
    }
    button?.setAttribute("aria-busy", "true");
    let left = false;
    try {
      const actor = browser?.browsingContext?.currentWindowGlobal?.getActor("WhimsyPage");
      left = !!(await actor?.sendQuery("Whimsy:CallLeave"));
    } catch (e) {
      console.error("Whimsy: leave call", e);
    }
    button?.removeAttribute("aria-busy");
    if (!left) {
      pipWin._whimsyCanLeave = false;
      this.renderLeave(pipWin, browser);
      return;
    }
    this._closedByHand.add(browser);
    if (!pipWin.closed) {
      pipWin.close();
    }
  },

  // W14 21.7: a shortcut assigned to a call command (Settings → Keyboard
  // Shortcuts) works in the call's PiP window too, which has no keyset of
  // its own: it runs the command in the call's browser window.
  forwardShortcut(browser, event) {
    const win = browser?.ownerDocument?.defaultView;
    if (!win || win.closed || event.repeat || !this.isInCallBrowser(browser)) {
      return false;
    }
    for (const keyEl of win.document.querySelectorAll('key[command^="cmd_whimsyCall"]')) {
      if (keyMatches(keyEl, event)) {
        event.stopPropagation();
        event.preventDefault();
        win.document.getElementById(keyEl.getAttribute("command"))?.doCommand();
        return true;
      }
    }
    return false;
  },

  // W14 21.7: Firefox closes the call's PiP when its video is
  // removed, which a call page does when it re-renders a tile (turning a
  // camera off and on). While you're still on another tab in the call, it
  // comes back; a PiP you closed yourself (Firefox's deliberate closes) or
  // left by going back to the call stays closed.
  onCallPipClosed(browser) {
    const win = browser?.ownerDocument?.defaultView;
    if (!win) {
      return;
    }
    win.setTimeout(() => this.floatWhenReady(browser, { tries: 6 }), 500);
  },

  // Asks the call's page to float its main video, and asks again every
  // half second (`tries` times) while it has none playing (W16-3: a call
  // with every camera off has no video to show; it floats once one
  // starts), for as long as the call's tab stays in the background.
  floatWhenReady(browser, { tries = RETRY_TRIES } = {}) {
    if (this._closedByHand.has(browser)) {
      return;
    }
    const win = browser?.ownerDocument?.defaultView;
    if (!win || win.closed || !this.enabled || !this.isInCallBrowser(browser) || !this.isBackground(browser)) {
      return;
    }
    if (lazy.PictureInPicture.weakAutoPipBrowserClosedDeliberately?.has(browser) || this.pipWindowsFor(browser).length) {
      return;
    }
    const actor = browser.browsingContext?.currentWindowGlobal?.getActor("WhimsyPage");
    if (!actor) {
      return;
    }
    actor
      .sendQuery("Whimsy:CallPip")
      .then(opened => {
        if (!opened && tries > 1) {
          win.setTimeout(() => this.floatWhenReady(browser, { tries: tries - 1 }), RETRY_MS);
        }
      })
      .catch(() => {});
  },

  // M (as before) or Meet's ⌘D toggles the microphone, ⌘E the camera; Shift
  // with either does the other mute (W21) — bare Option still does nothing
  // in the PiP window, since ⌥⌘D is macOS's Show/Hide Dock, so the "other"
  // mute's keyboard form uses Shift here, not Option.
  pipKeyKind(event) {
    const accel = AppConstants.platform == "macosx" ? event.metaKey : event.ctrlKey;
    const key = event.key?.toUpperCase();
    if (event.altKey) {
      return null;
    }
    if (!accel && !event.ctrlKey && !event.metaKey && key == "M") {
      return "mic";
    }
    if (accel) {
      return KINDS.find(kind => SHORTCUT_KEY[kind] == key) ?? null;
    }
    return null;
  },

  addPipButtons(pipWin) {
    const doc = pipWin.document;
    if (doc.getElementById("whimsy-call-controls")) {
      return;
    }
    const start = doc.querySelector(".start-controls");
    if (!start) {
      return;
    }
    try {
      for (const sheet of [...PANEL_SHEETS, SURFACE_SHEET]) {
        pipWin.windowUtils.loadSheetUsingURIString(sheet, pipWin.windowUtils.AUTHOR_SHEET);
      }
      pipWin.windowUtils.loadSheetUsingURIString(PIP_SHEET, pipWin.windowUtils.AUTHOR_SHEET);
    } catch (e) {
      console.error("Whimsy: call PiP sheet", e);
    }
    doc.l10n?.addResourceIds(["browser/whimsy.ftl"]);
    const group = doc.createElement("div");
    group.id = "whimsy-call-controls";
    for (const kind of KINDS) {
      const button = doc.createElement("button");
      button.id = `whimsy-call-${kind}`;
      button.className = "control-item control-button tooltip-over-controls center-tooltip";
      // As the player's own buttons: Fluent fills the CSS tooltip too.
      button.setAttribute("data-l10n-attrs", "tooltip");
      button.hidden = true;
      group.append(button);
    }
    // W21: the "⋯" Call Options button — a CSS hairline (border-inline-start)
    // stands in for the card's DOM rule, since this row is PiP-internal.
    const options = doc.createElement("button");
    options.id = "whimsy-call-options";
    options.className = "control-item control-button tooltip-over-controls center-tooltip";
    options.setAttribute("data-l10n-attrs", "tooltip");
    options.setAttribute("aria-haspopup", "menu");
    doc.l10n.setAttributes(options, "whimsy-call-pip-options-button");
    group.append(options);
    // W26: Leave call, hidden until the page shows a hang-up control.
    const leave = doc.createElement("button");
    leave.id = "whimsy-call-leave";
    leave.className = "control-item control-button tooltip-over-controls center-tooltip";
    leave.setAttribute("data-l10n-attrs", "tooltip");
    leave.hidden = true;
    doc.l10n.setAttributes(leave, "whimsy-call-pip-leave");
    group.append(leave);
    start.prepend(group);
    doc.body.setAttribute("whimsy-call", "");
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

  // ---- W13-R3: call controls ------------------------------------------

  get controlsEnabled() {
    return Services.prefs.getBoolPref(CONTROLS_PREF, true);
  },

  // W21: "call" (the shipped default) or "device" — which mute a plain
  // click on the mic/camera does; Option-click does the other.
  get buttonsDefault() {
    const value = Services.prefs.getStringPref(DEFAULT_PREF, "call");
    return value == "device" ? "device" : "call";
  },

  // browser -> {
  //   mic, camera: "on" | "off" | null,  // the page's own toggle (unchanged)
  //   blocked: { mic, camera: boolean }, // W21: Whimsy's own device mute
  //   seen: {}, pending: {},
  // }. mic/camera are only what the page last reported; never a guess.
  _states: new WeakMap(),
  // W16-17: capture-only calls Whimsy has made a small player for.
  _cardOffered: new WeakSet(),
  // The browsers being watched (for the commands' target).
  _calls: new Set(),

  // The switch: off puts Zen's small player back as Zen ships it and takes
  // the PiP buttons away; on starts following every call again.
  onControlsSwitched() {
    const enabled = this.controlsEnabled;
    for (const win of Services.wm.getEnumerator("navigator:browser")) {
      for (const tab of win.gZenWorkspaces?.allStoredTabs ?? win.gBrowser?.tabs ?? []) {
        const browser = tab.linkedBrowser;
        if (!this.isInCall(tab) && !this._calls.has(browser)) {
          continue;
        }
        if (enabled) {
          this.watch(browser);
        } else {
          this.forget(browser, true);
        }
      }
    }
    for (const pipWin of Services.wm.getEnumerator("Toolkit:PictureInPicture")) {
      const browser = pipWin._whimsyCallBrowser;
      if (browser && enabled) {
        this.addPipButtons(pipWin);
        this.renderPip(pipWin, browser);
      } else if (browser) {
        this.renderPip(pipWin, browser);
      }
    }
  },

  stateFor(browser) {
    let state = this._states.get(browser);
    if (!state) {
      state = { mic: null, camera: null, blocked: { mic: false, camera: false }, seen: {}, pending: {} };
      this._states.set(browser, state);
    }
    return state;
  },

  onSharingChanged(tab) {
    const browser = tab?.linkedBrowser;
    if (!browser) {
      return;
    }
    if (this.isInCall(tab)) {
      const win = tab.ownerDocument?.defaultView;
      this.hookMediaBar(win);
      this.ensureSharingCard(win, browser);
      this.watch(browser);
    } else {
      this.forget(browser, true);
    }
  },

  // Asks the page to report its toggles (idempotent in the page).
  watch(browser) {
    if (!this.controlsEnabled || !browser) {
      return;
    }
    const actor = browser.browsingContext?.currentWindowGlobal?.getActor("WhimsyPage");
    if (!actor) {
      return;
    }
    this._calls.add(browser);
    actor
      .sendQuery("Whimsy:CallControlsWatch", { on: true })
      .then(state => state && this.onPageState(browser, state))
      .catch(() => {});
  },

  // The call ended or the tab went away: stop watching, release any device
  // mute left on, and drop its state.
  forget(browser, stopWatching = false) {
    if (!browser) {
      return;
    }
    if (stopWatching) {
      try {
        browser.browsingContext?.currentWindowGlobal?.getActor("WhimsyPage")
          ?.sendAsyncMessage("Whimsy:CallControlsWatch", { on: false });
      } catch (e) {}
    }
    const state = this._states.get(browser);
    if (state) {
      for (const kind of KINDS) {
        if (state.blocked[kind]) {
          this.releaseBlocked(browser, kind);
        }
      }
    }
    this._calls.delete(browser);
    this._states.delete(browser);
    if (stopWatching) {
      this._cardOffered.delete(browser);
    }
    this.render(browser);
  },

  // Sends the device-unmute message for `kind` (forget(), and any other
  // place a device mute must let go without flipping state.blocked itself).
  releaseBlocked(browser, kind) {
    try {
      browser.browsingContext?.currentWindowGlobal?.getActor("WebRTC")?.sendAsyncMessage(DEVICE_UNMUTE[kind]);
    } catch (e) {}
  },

  // From WhimsyPageParent: the page's toggles changed (content data, so
  // only "on", "off" or null are taken).
  onPageState(browser, data) {
    if (!browser || !this.controlsEnabled) {
      return;
    }
    const state = this.stateFor(browser);
    for (const kind of KINDS) {
      const value = data?.[kind];
      state[kind] = value == "on" || value == "off" ? value : null;
      if (state[kind]) {
        state.seen[kind] = true;
      }
    }
    if (data && "app" in data) {
      const app = typeof data.app == "string" ? data.app.replace(/\s+/g, " ").trim().slice(0, 40) : "";
      state.app = app || null;
    }
    this.render(browser);
  },

  // W14-6: the call app's name from its page (Meet, Zoom, Teams...), or null.
  appName(browser) {
    return this._states.get(browser)?.app ?? null;
  },

  isBlocked(browser, kind) {
    try {
      const principal = browser.contentPrincipal;
      if (!principal?.isContentPrincipal) {
        return false;
      }
      const { state } = lazy.SitePermissions.getForPrincipal(principal, PERMISSION[kind], browser);
      return state == lazy.SitePermissions.BLOCK;
    } catch (e) {
      return false;
    }
  },

  // W16-17: the page doesn't capture this device and has no control of its
  // own for it (a camera-only page's microphone): the button would mute
  // nothing. A call page with its own control keeps it, so a camera the
  // call turned off (and stopped) can be turned back on.
  nothingToMute(browser, kind) {
    return !browser?._sharingState?.webRTC?.[PERMISSION[kind]] && this.shownState(browser, kind) == null;
  },

  // W16-17: Zen asks for a sharing card when the sharing indicators first
  // show, which can come before the tab's sharing state says it's a call
  // (so wantsSharingCard said no then, for a page with no peer
  // connection). Once it is one, make the card if it still has none, once
  // per call: a card you close stays closed, as Zen's do.
  ensureSharingCard(win, browser) {
    const controller = win?.gZenMediaController;
    const bar = controller?.mediaControlBar;
    if (!bar || this._cardOffered.has(browser) || !this.wantsSharingCard(browser)) {
      return;
    }
    let peers = false;
    try {
      peers = browser.browsingContext?.currentWindowGlobal?.hasActivePeerConnections();
    } catch (e) {}
    if (peers) {
      return; // Zen's own rule makes this card.
    }
    this._cardOffered.add(browser);
    const has = [...bar.querySelectorAll(".zen-media-card[media-sharing]")].some(
      card => card._whimsyCallBrowser == browser && !card.hasAttribute("zen-removing")
    );
    if (!has) {
      try {
        controller.activateMediaDeviceControls(browser);
      } catch (e) {
        console.error("Whimsy: call small player", e);
      }
    }
  },

  // W16-17: Zen makes a sharing card (the small player) only for a page
  // with a peer connection; Whimsy's ZenMediaController hotfix asks here
  // too, so a capture-only call (a camera test page) gets one. Without a
  // card, Zen unmuted the devices on every sharing change, undoing a block.
  wantsSharingCard(browser) {
    return this.enabled && this.controlsEnabled && this.isInCallBrowser(browser);
  },

  // The state a surface may show: null hides the button (unknown, or the
  // site may not use that device at all).
  shownState(browser, kind) {
    if (!this.controlsEnabled) {
      return null;
    }
    const value = this._states.get(browser)?.[kind] ?? null;
    return value && !this.isBlocked(browser, kind) ? value : null;
  },

  // W21: what a surface draws for `kind` — one glyph (the state of
  // whichever mute is the default here) plus, at most, one corner badge for
  // the *other* mute when it's the one that's on. Shared by the small
  // player, the PiP window and the options panel, so a card, a PiP button
  // and a panel row can never disagree about what's muted.
  //
  //  - useDevice: the device mute is what the glyph shows — either because
  //    buttonsDefault says so, or because the in-call state is unknown (no
  //    recognised controls on this page yet, or none at all): the device
  //    mute is the only thing guaranteed to exist, so it's shown instead of
  //    guessing at an unknown in-call state.
  //  - badge: "lock" when the device mute is on but not shown as the main
  //    glyph (the call's own mute is the default and is off); "off" when
  //    the call's own mute is on but not shown as the main glyph (the
  //    device mute is the default and is off). Never both — the main glyph
  //    already shows whichever mute is the default, so only the other one
  //    can still need a badge.
  displayState(browser, kind) {
    const state = this.stateFor(browser);
    const value = this.shownState(browser, kind);
    const useDevice = this.pressDoes(browser, kind) == "device";
    const off = useDevice ? state.blocked[kind] : value == "off";
    let badge = null;
    if (!useDevice && state.blocked[kind]) {
      badge = "lock";
    } else if (useDevice && value == "off") {
      badge = "off";
    }
    return { off, badge, busy: !!state.pending[kind], inCallAvailable: value != null };
  },

  // Toggles the page's own control and shows the page's answer. A press
  // while one is pending is ignored; nothing changes until the page has.
  async toggleInCall(browser, kind) {
    if (!KINDS.includes(kind) || !this.shownState(browser, kind)) {
      return false;
    }
    const state = this.stateFor(browser);
    if (state.pending[kind]) {
      return false;
    }
    const actor = browser.browsingContext?.currentWindowGlobal?.getActor("WhimsyPage");
    if (!actor) {
      return false;
    }
    state.pending[kind] = true;
    // W16-3: turning the call's camera back on from another tab. The page
    // asks for the camera again, which Firefox would hold until the tab is
    // selected; this press is what lets grantCameraIntent answer it now.
    if (kind == "camera" && this.shownState(browser, kind) == "off" && this.isBackground(browser)) {
      state.cameraIntentUntil = Date.now() + CAMERA_INTENT_MS;
    }
    this.render(browser);
    let result = null;
    try {
      result = await actor.sendQuery("Whimsy:CallControlsToggle", { kind });
    } catch (e) {
      console.error("Whimsy: call control toggle", e);
    }
    state.pending[kind] = false;
    if (result?.state) {
      this.onPageState(browser, result.state);
    } else {
      this.render(browser);
    }
    if (result && !result.ok && result.reason == "no-change") {
      this.showToggleFailed(browser, kind);
    }
    return !!result?.ok;
  },

  // W14 21.7: the page didn't show a press within the toggle's wait.
  // W16-3: from another tab, the toast offers Go to Call, which selects the
  // call's tab: a camera the site may not use yet needs Firefox's prompt,
  // and Firefox shows it there.
  showToggleFailed(browser, kind) {
    const state = this._states.get(browser);
    if (state) {
      state.cameraIntentUntil = 0;
    }
    const win = browser.ownerDocument?.defaultView;
    const app = this.appName(browser);
    const l10nArgs = { app: app ?? "", known: app ? "yes" : "no" };
    const id = `whimsy-call-${kind}-failed-toast`;
    const tab = win?.gBrowser?.getTabForBrowser(browser);
    const toasts = win?.gZenUIManager?.toasts;
    if (this.isBackground(browser) && tab && toasts?.open) {
      toasts.open(id, {
        key: "whimsy-call-failed",
        l10nArgs,
        timeout: 6000,
        buttons: [
          {
            id: "whimsy-call-go-to-call",
            l10nId: "whimsy-call-go-to-call",
            command: () => {
              if (tab.isConnected && !tab.closing) {
                win.gBrowser.selectedTab = tab;
              }
            },
          },
        ],
      });
      return;
    }
    win?.gZenUIManager?.showToast?.(id, { l10nArgs, timeout: 6000 });
  },

  // W16-3: Firefox holds a camera or microphone request from a tab that
  // isn't selected until it is (WebRTCParent's prompt), so a call's camera
  // turned back on from another tab came on only when you went back. A
  // request a Whimsy press caused (state.cameraIntentUntil, from
  // toggleInCall) is answered now, but only with what the site may already
  // use (WebRTCParent.checkRequestAllowed: a persistent or temporary grant,
  // never screen sharing); anything else goes to Firefox's prompt as usual.
  installCameraIntent() {
    if (this._cameraIntentInstalled) {
      return;
    }
    this._cameraIntentInstalled = true;
    let WebRTCParent;
    try {
      ({ WebRTCParent } = ChromeUtils.importESModule("resource:///actors/WebRTCParent.sys.mjs"));
    } catch (e) {
      console.error("Whimsy: call camera", e);
      return;
    }
    const proto = WebRTCParent?.prototype;
    const receiveMessage = proto?.receiveMessage;
    if (typeof receiveMessage != "function" || typeof proto.checkRequestAllowed != "function") {
      return;
    }
    const self = this;
    proto.receiveMessage = function (message) {
      try {
        if (message.name == "webrtc:Request" && self.grantCameraIntent(this, message.data)) {
          return undefined;
        }
      } catch (e) {
        console.error("Whimsy: call camera", e);
      }
      return receiveMessage.call(this, message);
    };
  },

  grantCameraIntent(actor, data) {
    const browser = actor.getBrowser?.();
    const state = browser && this._states.get(browser);
    if (!state?.cameraIntentUntil || state.cameraIntentUntil < Date.now()) {
      return false;
    }
    if (!data || data.sharingScreen || !data.videoInputDevices?.length || !this.isInCallBrowser(browser)) {
      return false;
    }
    // As WebRTCParent does before it prompts.
    data.isThirdPartyOrigin =
      actor.manager.documentPrincipal.origin != actor.manager.topWindowContext.documentPrincipal.origin;
    data.origin = actor.manager.topWindowContext.documentPrincipal.origin;
    const principal = Services.scriptSecurityManager.createContentPrincipalFromOrigin(data.origin);
    if (!actor.checkRequestAllowed(data, principal, browser)) {
      return false;
    }
    state.cameraIntentUntil = 0;
    return true;
  },

  // W21: Whimsy's own device mute for `kind` on this browser — works with
  // or without the page's own controls, the fallback the ticket requires
  // when findControls finds nothing. Released by forget() (call ended) or
  // flipped back by a second call.
  async toggleBlocked(browser, kind) {
    if (!KINDS.includes(kind) || !browser) {
      return false;
    }
    const state = this.stateFor(browser);
    const next = !state.blocked[kind];
    state.blocked[kind] = next;
    try {
      const actor = browser.browsingContext?.currentWindowGlobal?.getActor("WebRTC");
      actor?.sendAsyncMessage(next ? MUTE_MESSAGE[kind] : DEVICE_UNMUTE[kind]);
    } catch (e) {}
    this.render(browser);
    return true;
  },

  // W21: a plain click on the mic/camera — whichever mute buttonsDefault
  // picks, or the device mute regardless of the pref when no in-call
  // control was ever found (there's nothing else to toggle: never a no-op).
  toggleDefault(browser, kind) {
    if (this.pressDoes(browser, kind) == "call") {
      return this.toggleInCall(browser, kind);
    }
    return this.toggleBlocked(browser, kind);
  },

  // What a plain press of the mic/camera button does here: "call" or
  // "device" (W14-6: the panel's "Mic button"/"Camera button" hint).
  //
  // W16-2 (user decision D1): the camera follows the Buttons mute choice
  // from anywhere, PiP and other tabs included, like the microphone. A
  // camera turned back on from another tab is granted by
  // grantCameraIntent (Firefox would hold it until the tab is selected).
  pressDoes(browser, kind) {
    const value = this.shownState(browser, kind);
    if (this.buttonsDefault == "device" || value == null) {
      return "device";
    }
    return "call";
  },

  // The call's tab isn't the selected one in its window.
  isBackground(browser) {
    const gBrowser = browser?.ownerDocument?.defaultView?.gBrowser;
    return !!gBrowser && gBrowser.selectedBrowser != browser;
  },

  // W14-6c: Zen lets go of the device mute itself (its card's close button,
  // and a sharing card made again); the block is off from then on.
  deviceReleased(browser) {
    const state = this._states.get(browser);
    if (state && KINDS.some(kind => state.blocked[kind])) {
      state.blocked = { mic: false, camera: false };
      this.render(browser);
    }
  },

  // W21: Option-click (or the panel's/command's explicit "other" action) —
  // whichever mute buttonsDefault does NOT pick. With no in-call control
  // found, toggleDefault already is the device mute, so "the other" one
  // would have nothing to do; keep it a device mute too rather than a no-op.
  toggleOther(browser, kind) {
    if (this.shownState(browser, kind) == null) {
      return this.toggleBlocked(browser, kind);
    }
    return this.pressDoes(browser, kind) == "device" ? this.toggleInCall(browser, kind) : this.toggleBlocked(browser, kind);
  },

  // Every surface showing this call, from the same state.
  render(browser) {
    lazy.WhimsyCallOptionsPanel.refresh(browser);
    for (const pipWin of this.pipWindowsFor(browser)) {
      this.renderPip(pipWin, browser);
    }
    for (const win of Services.wm.getEnumerator("navigator:browser")) {
      for (const card of win.document.querySelectorAll(".zen-media-card[media-sharing]")) {
        if (card._whimsyCallBrowser == browser) {
          this.renderCard(card, browser);
        }
      }
    }
  },

  renderPip(pipWin, browser) {
    const doc = pipWin.document;
    this.renderCameraOff(pipWin, browser);
    if (!doc?.getElementById("whimsy-call-controls")) {
      return;
    }
    // Firefox's speaker and volume come back when the switch is off.
    doc.body.toggleAttribute("whimsy-call", this.controlsEnabled);
    this.renderLeave(pipWin, browser);
    for (const kind of KINDS) {
      const button = doc?.getElementById(`whimsy-call-${kind}`);
      if (!button) {
        continue;
      }
      // The OS/site permission is BLOCK, or the switch is off: no device to
      // mute either way, so the button has nothing to do — hide it, unlike
      // an unrecognised call page, which still falls back to the device mute.
      if (!this.controlsEnabled || this.isBlocked(browser, kind) || this.nothingToMute(browser, kind)) {
        button.hidden = true;
        continue;
      }
      button.hidden = false;
      const d = this.displayState(browser, kind);
      button.dataset.state = d.off ? "off" : "on";
      if (d.badge) {
        button.dataset.badge = d.badge;
      } else {
        delete button.dataset.badge;
      }
      button.setAttribute("aria-busy", String(d.busy));
      const useDevice = this.pressDoes(browser, kind) == "device";
      const l10n = useDevice ? PIP_BLOCK_L10N[kind] : PIP_L10N[kind];
      doc.l10n.setAttributes(button, d.off ? l10n.off : l10n.on, { shortcut: ACCEL + SHORTCUT_KEY[kind] });
    }
  },

  // Zen's sharing card: every call's card is driven by displayState now —
  // the device mute always works, so there's no more "unknown, Zen's own
  // device mute stays as it is" branch to fall back to.
  renderCard(card, browser) {
    for (const kind of KINDS) {
      const button = card.querySelector(CARD_BUTTON[kind]);
      const hideAttr = `whimsy-call-hide-${kind}`;
      // The OS/site permission is BLOCK: neither mute means anything here
      // (there's no device to mute), unlike an unrecognised call page,
      // which still has a real device to fall back to.
      if (this.controlsEnabled && (this.isBlocked(browser, kind) || this.nothingToMute(browser, kind))) {
        card.toggleAttribute(hideAttr, true);
        continue;
      }
      card.removeAttribute(hideAttr);
      const d = this.displayState(browser, kind);
      card.toggleAttribute(CARD_MUTED[kind], d.off);
      if (!button) {
        continue;
      }
      button.setAttribute("aria-busy", String(d.busy));
      if (d.badge) {
        button.setAttribute("whimsy-call-badge", d.badge);
      } else {
        button.removeAttribute("whimsy-call-badge");
      }
      const useDevice = this.pressDoes(browser, kind) == "device";
      const l10n = useDevice ? BLOCK_L10N[kind] : L10N[kind];
      card.ownerDocument.l10n.setAttributes(button, d.off ? l10n.off : l10n.on);
    }
  },

  // Tags each new sharing card with its tab (Zen keeps the card objects
  // private) and takes over presses of its microphone and camera buttons.
  // Zen's code is unchanged; without the method to wrap, Zen's own card
  // stays as it is.
  hookMediaBar(win) {
    const controller = win?.gZenMediaController;
    const bar = controller?.mediaControlBar;
    if (!bar || controller._whimsyCallHooked || typeof controller.activateMediaDeviceControls != "function") {
      return;
    }
    controller._whimsyCallHooked = true;
    const original = controller.activateMediaDeviceControls;
    const self = this;
    controller.activateMediaDeviceControls = function (browser) {
      const before = new Set(bar.querySelectorAll(".zen-media-card"));
      const result = original.call(this, browser);
      let attached = false;
      for (const card of bar.querySelectorAll(".zen-media-card[media-sharing]")) {
        if (!before.has(card)) {
          // Zen unmutes the devices right before it makes a new card
          // (updateMediaSharing); only then has the block let go (W16-17).
          if (!attached) {
            self.deviceReleased(browser);
            attached = true;
          }
          self.attachCard(card, browser);
        }
      }
      return result;
    };
    // W21: a plain click on the mic/camera does the default mute,
    // Option-click the other. A capture-phase click (not a XUL command
    // event) is used so event.altKey is read directly from the pointer
    // event, not relied on to survive command dispatch.
    bar.addEventListener("click", event => {
      const card = event.target?.closest?.(".zen-media-card");
      const browser = card?._whimsyCallBrowser;
      if (!browser || !this.controlsEnabled) {
        return;
      }
      const options = event.target?.closest?.("#whimsy-call-options");
      if (options) {
        event.stopPropagation();
        event.preventDefault();
        if (this.isPlainPress(event)) {
          lazy.WhimsyCallOptionsPanel.open(win, browser, { anchor: options });
        }
        return;
      }
      const button = event.target?.closest?.(`${CARD_BUTTON.mic}, ${CARD_BUTTON.camera}`);
      if (!button) {
        return;
      }
      const kind = button.matches(CARD_BUTTON.mic) ? "mic" : "camera";
      event.stopPropagation();
      event.preventDefault();
      if (!this.isPlainPress(event)) {
        return;
      }
      if (event.altKey) {
        this.toggleOther(browser, kind);
      } else {
        this.toggleDefault(browser, kind);
      }
    }, true);
    // Zen's close button on a sharing card unmutes both devices.
    bar.addEventListener("command", event => {
      const card = event.target?.closest?.(".zen-media-close-button")?.closest(".zen-media-card");
      if (card?._whimsyCallBrowser) {
        this.deviceReleased(card._whimsyCallBrowser);
      }
    }, true);
    // Right-click and Ctrl-click (macOS's secondary click) on the call
    // buttons do nothing: no toggle, no panel, no toolbar context menu.
    bar.addEventListener("contextmenu", event => {
      const button = event.target?.closest?.(`${CARD_BUTTON.mic}, ${CARD_BUTTON.camera}, #whimsy-call-options`);
      if (!button?.closest(".zen-media-card")?._whimsyCallBrowser || !this.controlsEnabled) {
        return;
      }
      event.stopPropagation();
      event.preventDefault();
    }, true);
  },

  // A plain primary press: not a right/middle click, and not Ctrl-click,
  // which macOS turns into a secondary click (it also fires contextmenu).
  isPlainPress(event) {
    return (event.button ?? 0) == 0 && !event.ctrlKey;
  },

  attachCard(card, browser) {
    card._whimsyCallBrowser = browser;
    this.addCardOptionsButton(card);
    this.renderCard(card, browser);
    this.watch(browser);
  },

  // W21: the "⋯" Call Options button, appended after a hairline next to
  // Zen's own mic/camera buttons (Zen's markup untouched).
  addCardOptionsButton(card) {
    if (card.querySelector("#whimsy-call-options")) {
      return;
    }
    const group = card.querySelector(".media-device-buttons");
    if (!group) {
      return;
    }
    const doc = card.ownerDocument;
    const rule = doc.createElement("div");
    rule.className = "whimsy-call-options-rule";
    const button = doc.createXULElement("toolbarbutton");
    button.id = "whimsy-call-options";
    button.className = "toolbarbutton-1";
    button.setAttribute("aria-haspopup", "menu");
    doc.l10n.setAttributes(button, "whimsy-call-options-button");
    button.style.listStyleImage = "url(\"chrome://browser/content/whimsy/icons/call-options.svg\")";
    group.append(rule, button);
  },

  // The call commands: the selected tab's call, else the
  // call in an open PiP window, else the only call. Several: none.
  // `any`: the device-mute commands need no in-call controls to be found
  // (the device mute always works), unlike the in-call-only commands.
  commandTarget(win, kind, any = false) {
    const usable = browser => !!browser && this._calls.has(browser) && (any || !!this.shownState(browser, kind));
    const selected = win?.gBrowser?.selectedBrowser;
    if (usable(selected)) {
      return selected;
    }
    const pip = new Set();
    for (const pipWin of Services.wm.getEnumerator("Toolkit:PictureInPicture")) {
      if (!pipWin.closed && usable(pipWin._whimsyCallBrowser)) {
        pip.add(pipWin._whimsyCallBrowser);
      }
    }
    if (pip.size == 1) {
      return [...pip][0];
    }
    if (pip.size > 1) {
      return null;
    }
    const calls = [...this._calls].filter(usable);
    return calls.length == 1 ? calls[0] : null;
  },

  // Whether the call stays on screen anyway: the new tab is in the same
  // split view.
  stillVisible(previous, selected) {
    const group = previous.group;
    return !!group?.hasAttribute?.("split-view-group") && selected?.group == group;
  },

  onTabSelect(win, previous, selected) {
    if (this.isInCall(selected)) {
      this._closedByHand.delete(selected.linkedBrowser);
    }
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
    if (!browser.browsingContext?.currentWindowGlobal?.getActor("WhimsyPage")) {
      return false;
    }
    this.floatWhenReady(browser);
    return true;
  },
};
