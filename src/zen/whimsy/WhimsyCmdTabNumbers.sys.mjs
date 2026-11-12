/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { AppConstants } from "resource://gre/modules/AppConstants.sys.mjs";
import { MODIFIER_HOLD_MS } from "resource:///modules/whimsy/WhimsyHold.sys.mjs";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  WhimsyPrivate: "resource:///modules/whimsy/WhimsyPrivate.sys.mjs",
  WhimsyLinkHints: "resource:///modules/whimsy/WhimsyLinkHints.sys.mjs",
  STYLESHEET: "resource:///modules/whimsy/WhimsyLinkHintsChild.sys.mjs",
  placeHint: "resource:///modules/whimsy/WhimsyLinkHintsChild.sys.mjs",
});
const HTML_NS = "http://www.w3.org/1999/xhtml";
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
    const state = { active: this.isActiveWindow(win), timer: 0, meta: false, buttons: 0, keys: new Set(), badges: new Map(), observer: null, layer: null, reposition: null };
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
        if (!event.metaKey) {
          state.meta = false;
        }
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
    const release = () => {
      state.meta = false;
      hide();
    };
    const keyup = event => {
      // A release must never be lost: a Meta keyup ends the hold even when
      // it is the copy web content sends back. Other replies may be stale.
      if (event.isReplyEventFromRemoteContent) {
        if (event.key == "Meta") {
          release();
        }
        return;
      }
      state.keys.delete(event.code || event.key);
      if (event.key == "Meta" || !event.metaKey) {
        release();
      }
    };
    // Any later input that reports Command up proves a missed release
    // (macOS can swallow the keyup, e.g. after a system shortcut).
    const moved = event => {
      if (state.meta && !event.metaKey) {
        release();
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
    const listeners = { keydown, keyup, pointerdown, pointerup, mousemove: moved, wheel: moved, deactivate,
      ZenWorkspacesUIUpdate: workspace };
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

  // The ⌘J link-hint overlay (whimsy-link-hints.css, .hint), drawn in the
  // browser chrome inside a shadow root so its selectors stay scoped.
  layer(win) {
    return states.get(win)?.layer ?? null;
  },

  hint(win, tab) {
    return states.get(win)?.badges.get(tab) ?? null;
  },

  ensureLayer(win, state) {
    if (state.layer?.isConnected) {
      return state.layer;
    }
    const doc = win.document;
    const host = doc.createElementNS(HTML_NS, "div");
    host.id = "whimsy-tab-hints";
    host.setAttribute("aria-hidden", "true");
    host.style.display = "contents";
    const shadow = host.attachShadow({ mode: "open" });
    const link = doc.createElementNS(HTML_NS, "link");
    link.rel = "stylesheet";
    link.href = lazy.STYLESHEET;
    const layer = doc.createElementNS(HTML_NS, "div");
    layer.id = "whimsy-hints";
    layer.className = "tab-shortcuts leaving";
    shadow.append(link, layer);
    doc.documentElement.append(host);
    state.layer = layer;
    state.badges.clear();
    return layer;
  },

  // Beside the title, clear of the close button; icon-only tabs (Essentials,
  // the collapsed sidebar) get it on their trailing corner.
  // A hint goes only on a tab row the person can see, inside that row: a
  // tab in a collapsed pinned section or folder, scrolled out, or under
  // other chrome gets none. ⌘N's target is unchanged (tabsForShortcut, the
  // list Tabbrowser.selectTabAtIndex uses).
  place(win, state) {
    const doc = win.document;
    const iconOnlyStrip = doc.documentElement.getAttribute("zen-sidebar-expanded") != "true";
    const onTab = (tab, x, y) => {
      const hit = doc.elementFromPoint(x, y);
      return !!hit && (hit == tab || tab.contains(hit));
    };
    for (const [tab, node] of state.badges) {
      const r = tab.getBoundingClientRect();
      node.hidden = false;
      // Layout size: the hint's pop-in scale must not shrink the measure.
      const width = node.offsetWidth;
      const height = node.offsetHeight;
      const iconOnly = iconOnlyStrip || tab.hasAttribute("zen-essential");
      const x = Math.max(r.left + 2, iconOnly ? r.right - width - 2 : r.right - width - 28);
      const y = iconOnly ? r.top + 2 : r.top + (r.height - height) / 2;
      const fits = r.width >= width + 4 && r.height >= height && x + width <= r.right && y + height <= r.bottom;
      const visible = fits && tab.checkVisibility({ visibilityProperty: true }) &&
        onTab(tab, x + 1, y + 1) && onTab(tab, x + width - 1, y + height - 1) &&
        onTab(tab, r.left + r.width / 2, r.top + r.height / 2);
      node.hidden = !visible;
      if (visible) {
        lazy.placeHint(node, x, y, node.textContent, win);
      }
    }
  },

  show(win) {
    const state = states.get(win);
    if (!state || !Services.prefs.getBoolPref(PREF, true)) {
      return;
    }
    const layer = this.ensureLayer(win, state);
    // The sidebar's text colour, not the accent: tab shortcuts, not links.
    const { accent, ink } = lazy.WhimsyLinkHints.colors(win, "--toolbox-textcolor");
    layer.style.setProperty("--hint-bg", accent);
    layer.style.setProperty("--hint-ink", ink);
    const root = win.document.documentElement;
    const refresh = () => {
      const targets = this.targets(win);
      for (const [tab, node] of state.badges) {
        if (!targets.has(tab)) {
          node.remove();
          state.badges.delete(tab);
        }
      }
      for (const [tab, label] of targets) {
        let node = state.badges.get(tab);
        if (!node) {
          node = win.document.createElementNS(HTML_NS, "span");
          node.className = "hint";
          layer.append(node);
          state.badges.set(tab, node);
        }
        if (node.textContent != label) {
          node.textContent = label;
        }
      }
      this.place(win, state);
    };
    refresh();
    // Rows can still be settling (a section expanding): place again once
    // layout has caught up.
    win.requestAnimationFrame(() => win.requestAnimationFrame(() => {
      if (win.document.documentElement.hasAttribute("whimsy-tab-numbers")) {
        this.place(win, state);
      }
    }));
    // Establish the transparent starting style before fading in.
    layer.getBoundingClientRect();
    layer.classList.remove("leaving");
    root.setAttribute("whimsy-tab-numbers", "");
    if (!state.observer) {
      state.observer = new win.MutationObserver(refresh);
      state.observer.observe(win.gBrowser.tabContainer, {
        subtree: true, childList: true, attributes: true,
        attributeFilter: ["hidden", "collapsed", "selected", "multiselected", "zen-workspace-id", "zen-essential", "zen-empty-tab"],
      });
      state.reposition = () => this.place(win, state);
      win.addEventListener("resize", state.reposition);
      win.gBrowser.tabContainer.addEventListener("scroll", state.reposition, true);
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
    if (state.reposition) {
      win.removeEventListener("resize", state.reposition);
      win.gBrowser.tabContainer.removeEventListener("scroll", state.reposition, true);
      state.reposition = null;
    }
    win.document.documentElement.removeAttribute("whimsy-tab-numbers");
    // Keep the hints for the fade out, and reuse them on the next hold.
    state.layer?.classList.add("leaving");
  },
};
