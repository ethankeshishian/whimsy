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
// 2. Automatically triggers when battery < 20% and discharging, if the
//    Settings switch ("Turn on Battery Saver automatically...") is on.
// 3. Shows a heads-up toast (WhimsyToast, 6s, with a "Turn Off" action).
// 4. Turns itself off once plugged in (charging) or back at >= 20%, unless
//    the user turned it on by hand: a manual "on" sticks until they turn
//    it off (wave9 review M4).
// 5. Throttles frame rate (layout.frame_rate = 30) and starts background
//    timer throttling right after load (dom.timeout.throttling_delay = 1;
//    0 would DISABLE throttling, see TimeoutManager::MaybeStartThrottleTimeout),
//    restoring the original prefs afterwards. No tab unloading (Arc doesn't).
// 6. Command "Turn Battery Saver On or Off" (variants Turn ... On / Off),
//    no default key, assignable in about:keyboard. It works whenever the
//    feature switch is on, also with the automatic mode off.
// 7. Settings switch in Tab Management → Performance (with the settings
//    redesign; General without it), also found by Settings search.

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  WhimsyCommands: "resource:///modules/whimsy/WhimsyCommands.sys.mjs",
  WhimsyToast: "resource:///modules/whimsy/WhimsyToast.sys.mjs",
});

const FEATURE_PREF = "whimsy.feature.battery-saver";
const ENABLED_PREF = "whimsy.battery-saver.enabled";
const ACTIVE_PREF = "whimsy.battery-saver.active";
const RESTORE_FRAME_RATE_PREF = "whimsy.battery-saver.restore-frame-rate";
const RESTORE_THROTTLING_DELAY_PREF = "whimsy.battery-saver.restore-throttling-delay";

const BATTERY_THRESHOLD = 0.2;
const THROTTLED_FRAME_RATE = 30;
// Delay (ms) from page load until background timeouts are throttled. Must be
// > 0: Gecko treats <= 0 as "never throttle".
const THROTTLED_TIMEOUT_DELAY = 1;
const TOPIC = "whimsy-battery-saver-changed";
const ICON = "chrome://browser/skin/zen-icons/bolt.svg";

let active = false;
// true: the user turned it on by hand (sticks until they turn it off).
// false: the user turned it off by hand while low (until charged or >= 20%).
// null: automatic.
let manualOverride = null;
let mockBattery = null;
let lastBattery = null;
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

  // The feature switch: the command works whenever this is on.
  get enabled() {
    return Services.prefs.getBoolPref(FEATURE_PREF, true);
  },

  // The Settings switch: turn on automatically below 20%.
  get autoEnabled() {
    return this.enabled && Services.prefs.getBoolPref(ENABLED_PREF, true);
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
    Services.prefs.clearUserPref(ACTIVE_PREF);

    Services.prefs.addObserver(FEATURE_PREF, () => {
      if (!this.enabled) {
        manualOverride = null;
        this.deactivate({ reason: "disabled" });
      } else {
        this.checkBattery(mockBattery || lastBattery);
      }
    });
    Services.prefs.addObserver(ENABLED_PREF, () => {
      // Turning the automatic mode off ends an automatic session, never a
      // manual one.
      if (!this.autoEnabled && active && manualOverride !== true) {
        this.deactivate({ reason: "disabled" });
      } else {
        this.checkBattery(mockBattery || lastBattery);
      }
    });
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

    if (reason === "auto") {
      // Arc's heads-up: say why, and offer a way out.
      this.showToast(win, {
        l10nId: "whimsy-battery-saver-active-toast",
        action: {
          l10nId: "whimsy-battery-saver-turn-off-button",
          onCommand: () => this.turnOff(win),
        },
      });
    } else if (reason === "manual") {
      this.showToast(win, { l10nId: "whimsy-battery-saver-on-toast" });
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
      this.showToast(win, { l10nId: "whimsy-battery-saver-off-toast" });
    }
    return active;
  },

  showToast(win, options) {
    const target = win && !win.closed ? win : Services.wm.getMostRecentWindow("navigator:browser");
    if (!target) {
      return;
    }
    try {
      lazy.WhimsyToast.show(target, options);
    } catch (e) {
      console.error("Whimsy: Battery Saver toast", e);
    }
  },

  checkBattery(battery, win = null) {
    if (!battery) {
      return;
    }
    if (battery !== mockBattery) {
      lastBattery = battery;
    }
    if (!this.enabled) {
      return;
    }
    // Turned on by hand: stays on, plugged in or not, until turned off.
    if (manualOverride === true) {
      return;
    }
    const { level, charging } = battery;
    if (charging || level >= BATTERY_THRESHOLD) {
      // Charged or plugged in: automatic off, and a manual "off" is spent.
      manualOverride = null;
      if (active) {
        this.deactivate({ reason: "auto", win });
      }
      return;
    }
    // Below 20% and discharging.
    if (manualOverride === false || !this.autoEnabled) {
      return;
    }
    if (!active) {
      this.activate({ reason: "auto", win });
    }
  },

  turnOff(win) {
    if (!active) {
      return active;
    }
    manualOverride = false;
    return this.deactivate({ reason: "manual", win });
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

  // Feeds a fake battery reading; keeps any manual choice, as a real
  // levelchange/chargingchange would.
  setBatteryForTesting(mock, win = null) {
    mockBattery = mock;
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
      isAvailable: () => this.enabled,
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
