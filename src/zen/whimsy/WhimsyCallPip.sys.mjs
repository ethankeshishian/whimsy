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
// Not covered: Arc's floating window also has a leave button. Zoom's web
// client draws video on a <canvas>, which picture-in-picture can't show.
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
});

const FEATURE_PREF = "whimsy.feature.call-pip";
const PIP_ENABLED_PREF = "media.videocontrols.picture-in-picture.enabled";

// W13-R3/W21: call controls.
const CONTROLS_PREF = "whimsy.feature.call-controls";
// W21: whether a plain click on the mic/camera does the call's own mute
// ("call", the default) or a hard device mute ("device"); Option-click (or
// right-click → the panel) always does the other one.
const DEFAULT_PREF = "whimsy.call.buttons-default";
const KINDS = ["mic", "camera"];
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
const PIP_L10N = {
  mic: { on: "whimsy-call-pip-mic-turn-off", off: "whimsy-call-pip-mic-turn-on" },
  camera: { on: "whimsy-call-pip-camera-turn-off", off: "whimsy-call-pip-camera-turn-on" },
};
// Meet's own shortcuts, also in the PiP window.
const SHORTCUT_KEY = { mic: "D", camera: "E" };
const ACCEL = AppConstants.platform == "macosx" ? "⌘" : "Ctrl+";

// The PiP window's call buttons: Firefox's own control buttons with Zen's
// microphone and camera icons (the small player's), red when off as there.
// Firefox's speaker button and volume act on the call tile's video, which is
// always muted, so a call hides them.
const ICON = "chrome://browser/skin/zen-icons/";
const PIP_SHEET =
  "data:text/css," +
  encodeURIComponent(`
#whimsy-call-controls { display: flex; align-items: center; gap: 8px; }
#whimsy-call-mic { background-image: url("${ICON}microphone-fill.svg"); }
#whimsy-call-mic[data-state="off"] { background-image: url("${ICON}microphone-blocked-fill.svg"); }
#whimsy-call-camera { background-image: url("${ICON}video-fill.svg"); }
#whimsy-call-camera[data-state="off"] { background-image: url("${ICON}video-blocked-fill.svg"); }
:is(#whimsy-call-mic, #whimsy-call-camera)[data-state="off"] { fill: rgb(224, 41, 29); }
:is(#whimsy-call-mic, #whimsy-call-camera)[aria-busy="true"] { cursor: progress; }
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
    // W13-R3: Toggle Meeting Microphone / Camera (no key by default).
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
            this.toggleInCall(browser, kind);
          }
        },
        key: null,
        icon: ICON + icon,
        isAvailable: w => !!this.commandTarget(w, kind),
      });
    }
    this.hookMediaBar(win);
    win.addEventListener("TabAttrModified", event => {
      if (event.detail?.changed?.includes("sharing")) {
        this.onSharingChanged(event.target);
      }
    });
    for (const type of ["TabClose", "TabBrowserDiscarded"]) {
      win.addEventListener(type, event => this.forget(event.target.linkedBrowser));
    }
    for (const tab of gBrowser.tabs) {
      if (this.isInCall(tab)) {
        this.watch(tab.linkedBrowser);
      }
    }
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
    // W13-R3: a camera or microphone blocked (or allowed) for a site hides
    // (or shows) its buttons; the switch turns the call controls off or on.
    Services.obs.addObserver(this, "perm-changed");
    Services.prefs.addObserver(CONTROLS_PREF, this);
    for (const pipWin of Services.wm.getEnumerator("Toolkit:PictureInPicture")) {
      this.hookPipWindow(pipWin);
    }
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
        if (!this.isInCall(tab)) {
          return;
        }
        const id = event.target?.id;
        if (id == "closed-caption") {
          event.stopPropagation();
          event.preventDefault();
          this.toggleCaptions(browser);
          return;
        }
        const kind = id == "whimsy-call-mic" ? "mic" : id == "whimsy-call-camera" ? "camera" : null;
        if (kind) {
          event.stopPropagation();
          event.preventDefault();
          this.toggleInCall(browser, kind);
        }
      }, true);
      pipWin.addEventListener("keydown", event => {
        const kind = this.pipKeyKind(event);
        if (kind && this.isInCall(tab) && this.shownState(browser, kind)) {
          event.stopPropagation();
          event.preventDefault();
          this.toggleInCall(browser, kind);
        }
      }, true);
    }
    this.showCaptionsButton(pipWin, browser);
    if (this.controlsEnabled) {
      this.addPipButtons(pipWin);
      this.watch(browser);
      this.renderPip(pipWin, browser);
    }
  },

  // M (as before) or Meet's ⌘D toggles the microphone, ⌘E the camera.
  pipKeyKind(event) {
    const accel = AppConstants.platform == "macosx" ? event.metaKey : event.ctrlKey;
    const key = event.key?.toUpperCase();
    if (event.altKey || event.shiftKey) {
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
  // click on the mic/camera does; Option-click/right-click do the other.
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
      this.hookMediaBar(tab.ownerDocument?.defaultView);
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
    this.render(browser);
  },

  isPageSynced(browser) {
    try {
      return PAGE_SYNCED_HOSTS.has(browser.currentURI?.host);
    } catch (e) {
      return false;
    }
  },

  // Whether `kind` follows the page here: always on Meet, elsewhere once
  // the page has shown a toggle for it. Otherwise Zen's device mute stays.
  isPageDriven(browser, kind) {
    return this.controlsEnabled && (this.isPageSynced(browser) || !!this._states.get(browser)?.seen[kind]);
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

  // The state a surface may show: null hides the button (unknown, or the
  // site may not use that device at all).
  shownState(browser, kind) {
    if (!this.controlsEnabled) {
      return null;
    }
    const value = this._states.get(browser)?.[kind] ?? null;
    return value && !this.isBlocked(browser, kind) ? value : null;
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
    return !!result?.ok;
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
  // picks.
  toggleDefault(browser, kind) {
    return this.buttonsDefault == "device" ? this.toggleBlocked(browser, kind) : this.toggleInCall(browser, kind);
  },

  // W21: Option-click (or the panel's/command's explicit "other" action) —
  // whichever mute buttonsDefault does NOT pick.
  toggleOther(browser, kind) {
    return this.buttonsDefault == "device" ? this.toggleInCall(browser, kind) : this.toggleBlocked(browser, kind);
  },

  // Every surface showing this call, from the same state.
  render(browser) {
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
    if (!doc?.getElementById("whimsy-call-controls")) {
      return;
    }
    // Firefox's speaker and volume come back when the switch is off.
    doc.body.toggleAttribute("whimsy-call", this.controlsEnabled);
    for (const kind of KINDS) {
      const button = doc?.getElementById(`whimsy-call-${kind}`);
      if (!button) {
        continue;
      }
      const value = this.controlsEnabled ? this.shownState(browser, kind) : null;
      button.hidden = !value;
      if (!value) {
        continue;
      }
      button.dataset.state = value;
      button.setAttribute("aria-busy", String(!!this._states.get(browser)?.pending[kind]));
      doc.l10n.setAttributes(button, PIP_L10N[kind][value], { shortcut: ACCEL + SHORTCUT_KEY[kind] });
    }
  },

  // Zen's sharing card: the page's state on Zen's own muted attributes
  // (Zen's icons), hidden when unknown.
  renderCard(card, browser) {
    for (const kind of KINDS) {
      const button = card.querySelector(CARD_BUTTON[kind]);
      const hideAttr = `whimsy-call-hide-${kind}`;
      if (!this.isPageDriven(browser, kind)) {
        if (card._whimsyDriven?.[kind]) {
          card._whimsyDriven[kind] = false;
          card.removeAttribute(hideAttr);
          card.removeAttribute(CARD_MUTED[kind]);
          if (button) {
            for (const attr of ["data-l10n-id", "data-l10n-args", "tooltiptext", "aria-label", "aria-busy"]) {
              button.removeAttribute(attr);
            }
          }
        }
        continue;
      }
      card._whimsyDriven ??= {};
      if (!card._whimsyDriven[kind]) {
        card._whimsyDriven[kind] = true;
        // Zen's device mute was pressed before the page's toggles showed
        // up: move the mute to the page, then let go of the device.
        if (card.hasAttribute(CARD_MUTED[kind])) {
          this.handOver(browser, kind);
        }
      }
      const value = this.shownState(browser, kind);
      card.toggleAttribute(hideAttr, !value);
      if (!value) {
        continue;
      }
      card.toggleAttribute(CARD_MUTED[kind], value == "off");
      if (button) {
        button.setAttribute("aria-busy", String(!!this._states.get(browser)?.pending[kind]));
        card.ownerDocument.l10n.setAttributes(button, L10N[kind][value]);
      }
    }
  },

  async handOver(browser, kind) {
    if (this.shownState(browser, kind) == "on") {
      await this.toggleInCall(browser, kind);
    }
    try {
      browser.browsingContext?.currentWindowGlobal?.getActor("WebRTC")?.sendAsyncMessage(DEVICE_UNMUTE[kind]);
    } catch (e) {}
  },

  // Tags each new sharing card with its tab (Zen keeps the card objects
  // private) and takes presses of its microphone and camera buttons first
  // when they follow the page. Zen's code is unchanged; without the method
  // to wrap, Zen's own card stays as it is.
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
      for (const card of bar.querySelectorAll(".zen-media-card[media-sharing]")) {
        if (!before.has(card)) {
          self.attachCard(card, browser);
        }
      }
      return result;
    };
    bar.addEventListener("command", event => {
      const button = event.target?.closest?.(`${CARD_BUTTON.mic}, ${CARD_BUTTON.camera}`);
      const browser = button?.closest(".zen-media-card")?._whimsyCallBrowser;
      if (!browser) {
        return;
      }
      const kind = button.matches(CARD_BUTTON.mic) ? "mic" : "camera";
      if (!this.isPageDriven(browser, kind)) {
        return;
      }
      event.stopPropagation();
      this.toggleInCall(browser, kind);
    }, true);
  },

  attachCard(card, browser) {
    card._whimsyCallBrowser = browser;
    this.renderCard(card, browser);
    this.watch(browser);
  },

  // Toggle Meeting Microphone / Camera: the selected tab's call, else the
  // call in an open PiP window, else the only call. Several: none.
  commandTarget(win, kind) {
    const usable = browser => !!browser && this._calls.has(browser) && !!this.shownState(browser, kind);
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
