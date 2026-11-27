/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// W29: Pass Keys to Page (whimsy-handoff/intake-w29/designs/pass-keys.md).
//
// A command that gives the current tab's page every key it can get, until
// you hold Esc, click the pill, switch tabs, or leave the site. For vim,
// web terminals, remote desktops, and games.
//
//   - Firefox's reserved keys (New Tab, Close Tab, ...): the <browser> gets
//     [whimsy-pass-keys], which whimsy-GlobalKeyListener-cpp.patch treats
//     like fullscreen keyboard lock (the exit-full-screen key stays the
//     browser's). macOS keeps ⌘Q, ⌘H, ⌘M, ⌘Tab, and ⌘Space.
//   - Whimsy's own capture listeners (about 48 modules): one capture
//     listener on the window root, ahead of all of them, stops the key
//     before they see it (WhimsyShortcuts.isPassing is the shared check).
//     It doesn't cancel it, so the page still gets it.
//   - The browser's <key>s that wait for the page (⌘L, ⌘1-9, Whimsy's keys):
//     their second dispatch, after the page let the key through, is
//     cancelled, so the browser never acts on them.
//
// Holding Esc uses Firefox's keyboard-lock timings
// (dom.fullscreen.keyboard_lock.long_press_*): a notice with a filling ring
// after 0.5s, off at 1.5s. A short press still goes to the page.
// Never saved: it's for one tab, this session.

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  WhimsyCommands: "resource:///modules/whimsy/WhimsyCommands.sys.mjs",
  WhimsyShortcuts: "resource:///modules/whimsy/WhimsyShortcuts.sys.mjs",
});

const FEATURE_PREF = "whimsy.feature.pass-keys-to-page";
const TOAST_SHOWN_PREF = "whimsy.pass-keys-to-page.toast-shown";
const LONG_PRESS_PREF = "dom.fullscreen.keyboard_lock.long_press_interval";
const WARNING_PREF = "dom.fullscreen.keyboard_lock.long_press_warning_interval";
const ATTR = "whimsy-pass-keys";
const COMMAND_ID = "cmd_whimsyPassKeysToPage";
const PILL_ID = "whimsy-pass-keys-pill";
const ICON = "chrome://browser/content/whimsy/icons/keyboard.svg";
const HOLD_TOAST_KEY = "whimsy-pass-keys-hold";
const HTML_NS = "http://www.w3.org/1999/xhtml";
const KEY_EVENTS = ["keydown", "keypress", "keyup"];

const windows = new WeakMap();

function siteOf(uri) {
  if (!uri) {
    return "";
  }
  try {
    return Services.eTLD.getSite(uri);
  } catch {
    try {
      return `${uri.scheme}://${uri.host}`;
    } catch {
      return uri.spec;
    }
  }
}

export const WhimsyKeysToPage = {
  get enabled() {
    return Services.prefs.getBoolPref(FEATURE_PREF, true);
  },

  isPassing(win) {
    return lazy.WhimsyShortcuts.isPassing(win);
  },

  initWindow(win) {
    if (!win.gBrowser || windows.has(win)) {
      return;
    }
    const state = { holdTimers: [], holdToast: null };
    windows.set(win, state);
    lazy.WhimsyCommands.register(win, {
      id: COMMAND_ID,
      l10nId: "whimsy-action-pass-keys-to-page",
      key: null,
      icon: ICON,
      isAvailable: w => this.canPass(w),
      run: w => this.start(w),
      whimsyKeywords: () => lazy.WhimsyCommands.keywords("whimsy-keywords-pass-keys-to-page"),
    });
    const onKey = event => this.onKey(win, event);
    for (const type of KEY_EVENTS) {
      win.windowRoot.addEventListener(type, onKey, true);
    }
    win.gBrowser.tabContainer.addEventListener("TabSelect", event => {
      const browser = event.detail?.previousTab?.linkedBrowser;
      if (browser?.whimsyPassKeys) {
        this.stop(win, browser);
      }
    });
    win.gBrowser.addTabsProgressListener({
      onLocationChange: (browser, _progress, _request, location) => {
        if (browser.whimsyPassKeys && siteOf(location) != browser.whimsyPassKeysSite) {
          this.stop(win, browser);
        }
      },
    });
    // A release we can't see (another app took the keyboard) mustn't end it.
    win.addEventListener("blur", () => this.cancelHold(win));
    win.addEventListener(
      "unload",
      () => {
        for (const type of KEY_EVENTS) {
          win.windowRoot?.removeEventListener(type, onKey, true);
        }
        this.cancelHold(win);
        windows.delete(win);
      },
      { once: true }
    );
  },

  canPass(win) {
    const browser = win.gBrowser?.selectedBrowser;
    return this.enabled && !!browser && !browser.whimsyPassKeys && browser.isRemoteBrowser;
  },

  start(win) {
    if (!this.canPass(win)) {
      return;
    }
    const browser = win.gBrowser.selectedBrowser;
    browser.whimsyPassKeys = true;
    browser.whimsyPassKeysSite = siteOf(browser.currentURI);
    browser.setAttribute(ATTR, "true");
    this.updatePill(win);
    if (!Services.prefs.getBoolPref(TOAST_SHOWN_PREF, false)) {
      Services.prefs.setBoolPref(TOAST_SHOWN_PREF, true);
      win.gZenUIManager?.toasts?.open("whimsy-pass-keys-on-toast", {
        descriptionId: "whimsy-pass-keys-on-detail",
        icon: ICON,
      });
    }
    browser.focus();
  },

  stop(win, browser = win.gBrowser?.selectedBrowser) {
    if (!browser?.whimsyPassKeys) {
      return;
    }
    delete browser.whimsyPassKeys;
    delete browser.whimsyPassKeysSite;
    browser.removeAttribute(ATTR);
    this.cancelHold(win);
    this.updatePill(win);
    win.gZenUIManager?.toasts?.open("whimsy-pass-keys-off-toast", {});
  },

  // --- Keys ---

  // Whether this key event is going to the passing page (its <browser> is
  // the focused element in this window).
  passingTarget(win, event) {
    const browser = win.gBrowser?.selectedBrowser;
    return browser?.whimsyPassKeys === true && event.originalTarget == browser;
  },

  onKey(win, event) {
    if (!event.isTrusted || !this.passingTarget(win, event)) {
      return;
    }
    if (event.key == "Escape") {
      if (event.type == "keydown" && !event.repeat && !event.isReplyEventFromRemoteContent) {
        this.startHold(win);
      } else if (event.type == "keyup") {
        this.cancelHold(win);
      }
    }
    // The browser's keys get a second dispatch when the page let the key
    // through; with keys passed, the browser doesn't act on them either.
    if (event.isReplyEventFromRemoteContent && (event.metaKey || event.ctrlKey || event.altKey || /^F\d{1,2}$/.test(event.key))) {
      event.preventDefault();
    }
    event.stopImmediatePropagation();
  },

  // --- Hold Esc ---

  startHold(win) {
    const state = windows.get(win);
    if (!state) {
      return;
    }
    this.cancelHold(win);
    const total = Services.prefs.getIntPref(LONG_PRESS_PREF, 1500);
    const warning = Math.min(Services.prefs.getIntPref(WARNING_PREF, 500), total);
    state.holdTimers.push(
      win.setTimeout(() => this.showHold(win, total, warning), warning),
      win.setTimeout(() => this.stop(win), total)
    );
  },

  showHold(win, total, warning) {
    const state = windows.get(win);
    const toasts = win.gZenUIManager?.toasts;
    if (!state || !toasts) {
      return;
    }
    const ring = win.document.createElementNS(HTML_NS, "span");
    ring.className = "whimsy-pass-keys-ring";
    // The ring fills over the whole hold; it shows already part-filled.
    ring.style.setProperty("--whimsy-pass-keys-hold", `${total}ms`);
    ring.style.setProperty("--whimsy-pass-keys-shown", `-${warning}ms`);
    state.holdToast = toasts.open("whimsy-pass-keys-hold", {
      key: HOLD_TOAST_KEY,
      icon: { src: ring, size: 18 },
      timeout: 0,
      closable: false,
    });
  },

  cancelHold(win) {
    const state = windows.get(win);
    if (!state) {
      return;
    }
    for (const id of state.holdTimers) {
      win.clearTimeout(id);
    }
    state.holdTimers = [];
    state.holdToast?.close({ reason: "owner" });
    state.holdToast = null;
  },

  // --- The pill ---

  updatePill(win) {
    const doc = win.document;
    let pill = doc.getElementById(PILL_ID);
    const show = this.isPassing(win);
    if (!show) {
      if (pill) {
        pill.hidden = true;
      }
      return null;
    }
    if (!pill) {
      // W32 P2: the pill's rules (with the other address bar page actions)
      // live in whimsy-browser.css; whimsy-navigation.css holds only the
      // trail and Cook mode, so nothing loads here.
      pill = doc.createXULElement("hbox");
      pill.id = PILL_ID;
      pill.className = "whimsy-page-action whimsy-pass-keys-action";
      pill.setAttribute("align", "center");
      pill.setAttribute("role", "button");
      pill.setAttribute("tabindex", "0");
      const icon = doc.createXULElement("image");
      icon.className = "whimsy-page-action-icon";
      icon.setAttribute("src", ICON);
      const label = doc.createXULElement("label");
      label.className = "whimsy-page-action-label";
      doc.l10n.setAttributes(label, "whimsy-pass-keys-pill");
      pill.append(icon, label);
      doc.l10n.setAttributes(pill, "whimsy-pass-keys-pill-tooltip");
      pill.addEventListener("click", event => event.button == 0 && this.stop(win));
      pill.addEventListener("keydown", event => {
        if (event.key == "Enter" || event.key == " ") {
          event.preventDefault();
          this.stop(win);
        }
      });
      (doc.getElementById("page-action-buttons") ?? doc.getElementById("urlbar-container"))?.prepend(pill);
    }
    pill.hidden = false;
    return pill;
  },
};
