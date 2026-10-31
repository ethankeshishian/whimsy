/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// wave9: Battery Saver (Arc parity).
//
// Arc introduced Battery Saver Mode in macOS v1.10.1 (September 2023):
// "When your device has < 20% battery, you'll get a heads up when Battery
// Saver Mode is activated. It will turn off automatically once battery is
// back over 20%."
//
// Arc's Battery Saver throttles display refresh/animations down to 30 FPS
// (Chromium Energy Saver) and clamps background tab timer execution to reduce
// power consumption. It does not indiscriminately kill/discard tabs on
// entry (tab sleep/archive is managed separately).
//
// Whimsy brings full parity:
// 1. Monitors battery level and charging state via navigator.getBattery().
// 2. Automatically triggers when battery < 20% (and discharging).
// 3. Displays a heads-up toast banner when activated.
// 4. Automatically turns off once plugged in (charging) or charged >= 20%.
// 5. Throttles frame rate (layout.frame_rate = 30) and background timer delay
//    (dom.timeout.throttling_delay = 0), cleanly restoring original prefs.
// 6. Registered in WhimsyCommands as an assignable command ("Toggle Battery Saver",
//    with "Turn On Battery Saver" / "Turn Off Battery Saver" variants).
// 7. Settings toggle in Preferences → General → Battery Saver.

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  WhimsyCommands: "resource:///modules/whimsy/WhimsyCommands.sys.mjs",
});

const FEATURE_PREF = "whimsy.feature.battery-saver";
const ENABLED_PREF = "whimsy.battery-saver.enabled";
const ACTIVE_PREF = "whimsy.battery-saver.active";
const RESTORE_FRAME_RATE_PREF = "whimsy.battery-saver.restore-frame-rate";
const RESTORE_THROTTLING_DELAY_PREF = "whimsy.battery-saver.restore-throttling-delay";

const BATTERY_THRESHOLD = 0.20;
const THROTTLED_FRAME_RATE = 30;
const THROTTLED_TIMEOUT_DELAY = 0;
const TOPIC = "whimsy-battery-saver-changed";
const ICON = "chrome://browser/skin/zen-icons/bolt.svg";

let active = false;
let manualOverride = null;
let mockBattery = null;
let currentBatteryManager = null;
let initialized = false;
const listeners = new WeakSet();

export const WhimsyBatterySaver = {
  FEATURE_PREF,
  ENABLED_PREF,
  ACTIVE_PREF,
  BATTERY_THRESHOLD,
  THROTTLED_FRAME_RATE,
  THROTTLED_TIMEOUT_DELAY,
  TOPIC,

  get enabled() {
    return (
      Services.prefs.getBoolPref(FEATURE_PREF, true) &&
      Services.prefs.getBoolPref(ENABLED_PREF, true)
    );
  },

  get active() {
    return active;
  },

  get threshold() {
    return BATTERY_THRESHOLD;
  },

  get manualOverride() {
    return manualOverride;
  },

  init() {
    if (initialized) {
      return;
    }
    initialized = true;

    // Restore any throttles left behind if a previous session crashed.
    this.restoreThrottles();

    const onPrefChange = () => {
      if (!this.enabled && active) {
        this.deactivate({ reason: "disabled" });
      }
    };
    Services.prefs.addObserver(FEATURE_PREF, onPrefChange);
    Services.prefs.addObserver(ENABLED_PREF, onPrefChange);
  },

  applyThrottles() {
    if (!Services.prefs.prefHasUserValue(RESTORE_FRAME_RATE_PREF)) {
      if (Services.prefs.prefHasUserValue("layout.frame_rate")) {
        Services.prefs.setStringPref(
          RESTORE_FRAME_RATE_PREF,
          String(Services.prefs.getIntPref("layout.frame_rate"))
        );
      } else {
        Services.prefs.setStringPref(RESTORE_FRAME_RATE_PREF, "__default__");
      }
    }
    Services.prefs.setIntPref("layout.frame_rate", THROTTLED_FRAME_RATE);

    if (!Services.prefs.prefHasUserValue(RESTORE_THROTTLING_DELAY_PREF)) {
      if (Services.prefs.prefHasUserValue("dom.timeout.throttling_delay")) {
        Services.prefs.setStringPref(
          RESTORE_THROTTLING_DELAY_PREF,
          String(Services.prefs.getIntPref("dom.timeout.throttling_delay"))
        );
      } else {
        Services.prefs.setStringPref(RESTORE_THROTTLING_DELAY_PREF, "__default__");
      }
    }
    Services.prefs.setIntPref("dom.timeout.throttling_delay", THROTTLED_TIMEOUT_DELAY);
  },

  restoreThrottles() {
    if (Services.prefs.prefHasUserValue(RESTORE_FRAME_RATE_PREF)) {
      const val = Services.prefs.getStringPref(RESTORE_FRAME_RATE_PREF);
      Services.prefs.clearUserPref(RESTORE_FRAME_RATE_PREF);
      if (val === "__default__") {
        Services.prefs.clearUserPref("layout.frame_rate");
      } else {
        Services.prefs.setIntPref("layout.frame_rate", parseInt(val, 10));
      }
    }

    if (Services.prefs.prefHasUserValue(RESTORE_THROTTLING_DELAY_PREF)) {
      const val = Services.prefs.getStringPref(RESTORE_THROTTLING_DELAY_PREF);
      Services.prefs.clearUserPref(RESTORE_THROTTLING_DELAY_PREF);
      if (val === "__default__") {
        Services.prefs.clearUserPref("dom.timeout.throttling_delay");
      } else {
        Services.prefs.setIntPref("dom.timeout.throttling_delay", parseInt(val, 10));
      }
    }
  },

  activate({ reason = "auto", win = null } = {}) {
    if (!this.enabled || active) {
      return active;
    }
    active = true;
    this.applyThrottles();
    Services.prefs.setBoolPref(ACTIVE_PREF, true);
    Services.obs.notifyObservers(null, TOPIC, "on");

    const targetWin = win || Services.wm.getMostRecentWindow("navigator:browser");
    if (reason === "auto" || reason === "manual") {
      targetWin?.gZenUIManager?.showToast?.("whimsy-battery-saver-active-toast", {
        descriptionId: "whimsy-battery-saver-active-toast-description",
      });
    }
    return active;
  },

  deactivate({ reason = "auto", win = null } = {}) {
    if (!active) {
      return active;
    }
    active = false;
    this.restoreThrottles();
    Services.prefs.clearUserPref(ACTIVE_PREF);
    Services.obs.notifyObservers(null, TOPIC, "off");

    if (reason === "manual") {
      const targetWin = win || Services.wm.getMostRecentWindow("navigator:browser");
      targetWin?.gZenUIManager?.showToast?.("whimsy-battery-saver-off-toast");
    }
    return active;
  },

  checkBattery(battery, win = null) {
    if (!this.enabled || !battery) {
      return;
    }
    const { level, charging } = battery;

    // When charging, clear any manual override and turn off battery saver
    if (charging) {
      manualOverride = null;
      if (active) {
        this.deactivate({ reason: "auto", win });
      }
      return;
    }

    // When discharged / on battery
    if (level < BATTERY_THRESHOLD) {
      if (manualOverride === false) {
        // User manually turned it off while below threshold
        return;
      }
      if (!active) {
        this.activate({ reason: "auto", win });
      }
    } else {
      // level >= BATTERY_THRESHOLD
      if (manualOverride === true) {
        // User manually turned it on
        return;
      }
      if (active) {
        this.deactivate({ reason: "auto", win });
      }
    }
  },

  toggle(win) {
    if (!this.enabled) {
      return active;
    }
    const next = !active;
    manualOverride = next;
    if (next) {
      this.activate({ reason: "manual", win });
    } else {
      this.deactivate({ reason: "manual", win });
    }
    return active;
  },

  setBatteryForTesting(mock, win = null) {
    mockBattery = mock;
    manualOverride = null;
    this.checkBattery(mockBattery, win);
  },

  resetBatteryForTesting() {
    mockBattery = null;
    manualOverride = null;
    this.deactivate({ reason: "test" });
    this.restoreThrottles();
  },

  initWindow(win) {
    this.init();

    lazy.WhimsyCommands.register(win, {
      id: "cmd_whimsyToggleBatterySaver",
      l10nId: "whimsy-action-toggle-battery-saver",
      run: w => this.toggle(w),
      icon: ICON,
      variants: [
        {
          l10nId: "whimsy-action-turn-on-battery-saver",
          isAvailable: () => this.enabled && !active,
        },
        {
          l10nId: "whimsy-action-turn-off-battery-saver",
          isAvailable: () => this.enabled && active,
        },
      ],
    });

    if (mockBattery) {
      this.checkBattery(mockBattery, win);
    } else if (win.navigator?.getBattery) {
      win.navigator
        .getBattery()
        .then(battery => {
          if (!battery || listeners.has(battery)) {
            return;
          }
          listeners.add(battery);
          currentBatteryManager = battery;
          const onUpdate = () => this.checkBattery(mockBattery || battery, win);
          battery.addEventListener("levelchange", onUpdate);
          battery.addEventListener("chargingchange", onUpdate);
          onUpdate();
        })
        .catch(e => {
          console.warn("Whimsy: navigator.getBattery unavailable", e);
        });
    }
  },
};
