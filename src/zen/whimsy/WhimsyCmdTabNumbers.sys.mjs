/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { AppConstants } from "resource://gre/modules/AppConstants.sys.mjs";
import { MODIFIER_HOLD_MS } from "resource:///modules/whimsy/WhimsyHold.sys.mjs";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  WhimsyPrivate: "resource:///modules/whimsy/WhimsyPrivate.sys.mjs",
  WhimsyLinkHints: "resource:///modules/whimsy/WhimsyLinkHints.sys.mjs",
});
const PREF = "whimsy.feature.cmd-tab-numbers";
const states = new WeakMap();

export const WhimsyCmdTabNumbers = {
  HOLD_MS: MODIFIER_HOLD_MS,
  PREF,

  // Shared with Firefox's selectTabAtIndex (whimsy-Tabbrowser patch) and the Private
  // Space guard. Keep Firefox's visibleTabs order, including Essentials,
  // pins, and Zen's rules for spaces, collapsed folders, and split views.
  // The preference affects decoration only, never shortcut destinations.
  tabsForShortcut(win) {
    const tabs = win.gBrowser.visibleTabs;
    if (lazy.WhimsyPrivate.featureOn && lazy.WhimsyPrivate.activeSpaceIsScratch(win)) {
      return tabs.filter(t => !t.hasAttribute("zen-essential") && !t.hasAttribute("zen-empty-tab"));
    }
    return tabs;
  },

  targets(win) {
    const tabs = this.tabsForShortcut(win);
    const targets = new Map();
    // Firefox clamps 1–8 when there are fewer tabs. Give each actual row
    // its first shortcut, plus 9 on the last (e.g. “3 · 9” in a short list).
    for (let i = 0; i < Math.min(8, tabs.length); i++) {
      targets.set(tabs[i], String(i + 1));
    }
    const last = tabs.at(-1);
    if (last) {
      targets.set(last, targets.has(last) ? `${targets.get(last)} · 9` : "9");
    }
    return targets;
  },

  isActiveWindow(win) {
    return Services.focus.activeWindow == win;
  },

  initWindow(win) {
    if (AppConstants.platform != "macosx" || states.has(win)) {
      return;
    }
    const state = { active: this.isActiveWindow(win), timer: 0, meta: false, buttons: 0, keys: new Set(), badges: new Map(), observer: null };
    states.set(win, state);
    const on = () => Services.prefs.getBoolPref(PREF, true);
    const hide = () => this.hide(win);
    const keydown = event => {
      // Remote content replies redispatch the original event through chrome.
      // They can arrive after the physical keyup (or even the next press),
      // so counting them leaves phantom held keys and can restart a hold.
      if (event.isReplyEventFromRemoteContent) {
        return;
      }
      // Key delivery is authoritative even when this window is not OS-active.
      // A fresh Meta press also repairs a missed release while another window
      // owned input. Never let stale bookkeeping veto a new physical press.
      state.active = this.isActiveWindow(win);
      if (event.key == "Meta" && !event.repeat &&
          (state.meta && state.keys.has(event.code || event.key))) {
        hide();
        state.meta = false;
        state.keys.clear();
      }
      state.keys.add(event.code || event.key);
      if (event.key != "Meta") {
        hide();
        return;
      }
      // Auto-repeat cannot restart the delay. A second physical Meta while
      // one is already held is a chord (metaKey is true on both presses).
      if (state.meta) {
        return;
      }
      state.meta = true;
      if (!on() || event.repeat || event.ctrlKey || event.altKey || event.shiftKey || state.buttons ||
          state.keys.size != 1 || win.gURLBar?.view.isOpen) {
        return;
      }
      state.timer = win.setTimeout(() => {
        state.timer = 0;
        if (state.meta && on() && !win.gURLBar?.view.isOpen) {
          this.show(win);
        }
      }, MODIFIER_HOLD_MS);
    };
    const keyup = event => {
      if (event.isReplyEventFromRemoteContent) {
        return;
      }
      state.keys.delete(event.code || event.key);
      if (event.key == "Meta" || !event.metaKey) {
        state.meta = false;
        hide();
      }
    };
    const pointerdown = event => {
      state.buttons = event.buttons;
      hide();
    };
    const pointerup = event => { state.buttons = event.buttons; };
    const deactivate = event => {
      // Only an actual active -> inactive transition ends input ownership.
      // Background windows can receive keys without an activate event; a
      // stray deactivate there must not erase that newly delivered input.
      // Document blur (chrome handing focus to content) is not deactivation.
      if (event.target != win || !state.active || this.isActiveWindow(win)) {
        return;
      }
      state.active = false;
      state.meta = false;
      state.buttons = 0;
      state.keys.clear();
      hide();
    };
    const workspace = () => {
      if (win.document.documentElement.hasAttribute("whimsy-tab-numbers")) {
        this.show(win);
      }
    };
    const listeners = { keydown, keyup, pointerdown, pointerup, deactivate, ZenWorkspacesUIUpdate: workspace };
    for (const [type, listener] of Object.entries(listeners)) {
      win.addEventListener(type, listener, true);
    }
    Services.prefs.addObserver(PREF, hide);
    win.addEventListener("unload", () => {
      hide();
      for (const [type, listener] of Object.entries(listeners)) {
        win.removeEventListener(type, listener, true);
      }
      Services.prefs.removeObserver(PREF, hide);
      states.delete(win);
    }, { once: true });
  },

  show(win) {
    const state = states.get(win);
    if (!state || !Services.prefs.getBoolPref(PREF, true)) {
      return;
    }
    const { accent, ink } = lazy.WhimsyLinkHints.colors(win);
    const root = win.document.documentElement;
    root.style.setProperty("--whimsy-tab-number-bg", accent);
    root.style.setProperty("--whimsy-tab-number-ink", ink);
    const refresh = () => {
      const targets = this.targets(win);
      for (const [tab, badge] of state.badges) {
        if (!targets.has(tab)) {
          badge.remove();
          state.badges.delete(tab);
        }
      }
      for (const [tab, label] of targets) {
        let badge = state.badges.get(tab);
        if (!badge) {
          const content = tab.querySelector(".tab-content");
          if (!content) {
            continue;
          }
          badge = win.document.createElementNS("http://www.w3.org/1999/xhtml", "span");
          badge.className = "whimsy-tab-number";
          badge.setAttribute("aria-hidden", "true");
          content.append(badge);
          state.badges.set(tab, badge);
        }
        if (badge.textContent != label) {
          badge.textContent = label;
        }
      }
    };
    refresh();
    // Establish the transparent starting style before fading in.
    root.getBoundingClientRect();
    root.setAttribute("whimsy-tab-numbers", "");
    if (!state.observer) {
      state.observer = new win.MutationObserver(refresh);
      state.observer.observe(win.gBrowser.tabContainer, {
        subtree: true, childList: true, attributes: true,
        attributeFilter: ["hidden", "collapsed", "selected", "multiselected", "zen-workspace-id", "zen-essential", "zen-empty-tab"],
      });
    }
  },

  hide(win) {
    const state = states.get(win);
    if (!state) {
      return;
    }
    win.clearTimeout(state.timer);
    state.timer = 0;
    state.observer?.disconnect();
    state.observer = null;
    win.document.documentElement.removeAttribute("whimsy-tab-numbers");
    // Keep the aria-hidden spans for the fade out, and reuse them on the
    // next hold. They take no layout space and never alter the tab's name.
  },
};
