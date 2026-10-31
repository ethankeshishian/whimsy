/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// wave7/focus: Do Not Disturb.
//
// macOS Focus already silences sites: Firefox hands web notifications to
// macOS Notification Center (alerts.useSystemBackend, on by default), and
// Focus holds back banners from apps it doesn't allow, then shows them in
// Notification Center when Focus ends. Whimsy changes nothing there. What
// chrome code can't do is *read* Focus (Apple exposes it only through
// INFocusStatusCenter, which needs a native patch and an entitlement), so
// Whimsy's own in-window toasts can't follow Focus by themselves: deferred.
//
// What Whimsy adds is Firefox's "Pause notifications until Firefox
// restarts" as one command ("Turn On/Off Do Not Disturb", assignable in
// Settings → Keyboard Shortcuts). Firefox's Settings checkbox is hidden on
// macOS because the macOS backend doesn't implement manualDoNotDisturb; it
// does honour suppressForScreenSharing (the flag Firefox raises while you
// share your screen), so on macOS Whimsy pauses through that, and through
// manualDoNotDisturb everywhere it exists. While it's on, Whimsy's own
// unprompted toasts (a new season, Year in tabs, inbox zero) wait too.
// Like Firefox's, it lasts until you turn it off or quit; nothing is saved.
//
// Firefox's screen-sharing code rewrites suppressForScreenSharing whenever
// a camera, mic or screen share starts or stops
// (privacy.webrtc.allowSilencingNotifications, on by default). While Do
// Not Disturb is on Whimsy turns that pref off, so a video call can't end
// the pause, and puts it back after (also at the next start, after a
// crash).

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  WhimsyCommands: "resource:///modules/whimsy/WhimsyCommands.sys.mjs",
});

const FEATURE_PREF = "whimsy.feature.do-not-disturb";
const WEBRTC_SILENCING_PREF = "privacy.webrtc.allowSilencingNotifications";
// Set only while Do Not Disturb holds WEBRTC_SILENCING_PREF: the value to
// put back.
const RESTORE_PREF = "whimsy.dnd.restore-webrtc-silencing";
const ICON = "chrome://browser/skin/zen-icons/selectable/moon.svg";
const TOPIC = "whimsy-dnd-changed";

function alertsDND() {
  try {
    return Cc["@mozilla.org/alerts-service;1"].getService(Ci.nsIAlertsService).QueryInterface(Ci.nsIAlertsDoNotDisturb);
  } catch (e) {
    return null;
  }
}

let paused = false;
// Which flag the pause set: "manual" (manualDoNotDisturb) or "suppress"
// (suppressForScreenSharing, the macOS backend).
let via = null;
let initialized = false;

export const WhimsyDoNotDisturb = {
  FEATURE_PREF,
  TOPIC,

  get enabled() {
    return Services.prefs.getBoolPref(FEATURE_PREF, true);
  },

  // Site notifications are paused.
  get paused() {
    return paused;
  },

  // Whimsy's unprompted toasts should wait. Toasts that confirm something
  // the person just did still show.
  get quiet() {
    return paused && this.enabled;
  },

  // Whether macOS Focus can hold back site notifications: they go to
  // Notification Center (Firefox's default), not Firefox's own popups.
  get followsSystemFocus() {
    return Services.appinfo.OS == "Darwin" && Services.prefs.getBoolPref("alerts.useSystemBackend", true);
  },

  // Once per session: undo a pause a crash left behind, and stop when the
  // switch goes off.
  init() {
    if (initialized) {
      return;
    }
    initialized = true;
    this.restoreWebRTCSilencing();
    Services.prefs.addObserver(FEATURE_PREF, () => {
      if (!this.enabled && paused) {
        this.setPaused(false);
      }
    });
  },

  /**
   * Pauses or resumes site notifications. Returns the new state.
   *
   * @param {boolean} on
   */
  setPaused(on) {
    on = !!on && this.enabled;
    if (on == paused) {
      return paused;
    }
    const service = alertsDND();
    if (!service) {
      return paused;
    }
    if (on) {
      try {
        service.manualDoNotDisturb = true;
        via = "manual";
      } catch (e) {
        // The macOS backend: no manual mode, but it drops alerts while
        // this is set.
        try {
          this.holdWebRTCSilencing();
          service.suppressForScreenSharing = true;
          via = "suppress";
        } catch (e2) {
          this.restoreWebRTCSilencing();
          console.error("Whimsy: Do Not Disturb isn't available", e2);
          return paused;
        }
      }
    } else {
      try {
        if (via == "manual") {
          service.manualDoNotDisturb = false;
        } else if (via == "suppress") {
          service.suppressForScreenSharing = false;
        }
      } catch (e) {
        console.error("Whimsy: Do Not Disturb", e);
      }
      this.restoreWebRTCSilencing();
      via = null;
    }
    paused = on;
    Services.obs.notifyObservers(null, TOPIC, paused ? "on" : "off");
    return paused;
  },

  toggle(win) {
    if (!this.enabled) {
      return;
    }
    const before = paused;
    const now = this.setPaused(!paused);
    if (now == before) {
      return;
    }
    win?.gZenUIManager?.showToast?.(
      now ? "whimsy-dnd-on-toast" : "whimsy-dnd-off-toast",
      now ? { descriptionId: "whimsy-dnd-on-toast-description" } : {}
    );
  },

  holdWebRTCSilencing() {
    if (Services.prefs.prefHasUserValue(RESTORE_PREF)) {
      return;
    }
    const current = Services.prefs.getBoolPref(WEBRTC_SILENCING_PREF, true);
    Services.prefs.setBoolPref(RESTORE_PREF, current);
    Services.prefs.setBoolPref(WEBRTC_SILENCING_PREF, false);
  },

  restoreWebRTCSilencing() {
    if (!Services.prefs.prefHasUserValue(RESTORE_PREF)) {
      return;
    }
    const value = Services.prefs.getBoolPref(RESTORE_PREF, true);
    Services.prefs.clearUserPref(RESTORE_PREF);
    // Put back exactly what was there: the default unless the person had
    // their own value.
    const fallback = Services.prefs.getDefaultBranch("").getBoolPref(WEBRTC_SILENCING_PREF, true);
    if (value == fallback) {
      Services.prefs.clearUserPref(WEBRTC_SILENCING_PREF);
    } else {
      Services.prefs.setBoolPref(WEBRTC_SILENCING_PREF, value);
    }
  },

  initWindow(win) {
    this.init();
    // One command; the command bar names the state it moves to.
    lazy.WhimsyCommands.register(win, {
      id: "cmd_whimsyDoNotDisturb",
      l10nId: "whimsy-action-dnd-toggle",
      run: w => this.toggle(w),
      icon: ICON,
      variants: [
        { l10nId: "whimsy-action-dnd-on", isAvailable: () => this.enabled && !paused },
        { l10nId: "whimsy-action-dnd-off", isAvailable: () => this.enabled && paused },
      ],
    });
  },
};
