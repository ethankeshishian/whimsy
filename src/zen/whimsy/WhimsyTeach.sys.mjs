/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// wave7/teach: Teach once (idea #30). The first time someone does
// something a Whimsy shortcut does faster (copies the address from the
// address bar, pins a tab by hand, ⌘-clicks a link they only wanted to
// look at), or the first time Whimsy does something on its own (archives
// idle tabs), one small hint appears beside what they just touched,
// says the one thing worth knowing, and is never shown again.
//
// Where it comes from: Arc teaches in place rather than in a tour. Little
// Arc shows its own ⌘O beside "Open in Space"; archiving and copying say
// what happened in a toast that names the shortcut; its onboarding is a
// handful of real gestures, not a manual. macOS does the same with its
// one-time "tips" popovers. People love it because it never interrupts
// work they haven't started and never repeats itself: the tip arrives
// exactly when the shortcut would have saved them a step.
//
// The rules, all enforced here so a feature never has to think about them:
// - one hint per id, ever: shown state is a pref Firefox Sync carries
//   (whimsy.teach.seen), so a tip seen on one Mac isn't repeated on another;
// - no nagging: pressing the hint's own shortcut counts as knowing it, and
//   that hint is retired without being shown;
// - at most one hint a minute, never two at once, never over an open menu
//   or panel, never in a window that isn't frontmost (it waits for it),
//   never during onboarding, never under test automation unless a test
//   asks for it;
// - Esc, a click anywhere else, the close button, switching tabs, or eight
//   quiet seconds dismiss it (hovering it holds it open);
// - Settings → General → Tips → "Show tips" turns them all off, and the
//   "Reset Tips" command brings every hint back.
//
// Adding a hint is one entry in HINTS below (or WhimsyTeach.register()
// from a feature's own module):
//
//   {
//     id: "copy-url",                     // stable; stored once seen
//     l10nId: "whimsy-teach-copy-url",    // whimsy.ftl; { $key } is the
//                                         // live shortcut, <kbd> allowed
//     key: "zen-copy-url",                // the <key> it teaches: its
//                                         // current binding fills { $key }
//                                         // (unbound → the hint waits), and
//                                         // pressing it retires the hint.
//                                         // Or a function (win) => label.
//     usedKeys: ["…"],                    // more <key>s that count as known
//     isAvailable: win => bool,           // e.g. the feature's switch
//     window: "main" | "mini",            // default "main"
//     anchor: (win, context) => Element,  // what it points at
//     position: "after_start",            // optional; else beside the
//                                         // sidebar or below the toolbar
//     delay: 300,                         // ms to let the moment settle
//     trigger: on(target, "Event", test), // when it's the moment; or any
//                                         // (win, show) => cleanup
//     usedWhen: on(...),                  // optional: other proof the
//                                         // person already knows it
//   }
//
// A feature can also ask directly: WhimsyTeach.trigger(win, id, context).

import { AppConstants } from "resource://gre/modules/AppConstants.sys.mjs";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  ShortcutUtils: "resource://gre/modules/ShortcutUtils.sys.mjs",
  WhimsyCommands: "resource:///modules/whimsy/WhimsyCommands.sys.mjs",
  WhimsyPanels: "resource:///modules/whimsy/WhimsyPanels.sys.mjs",
  clearTimeout: "resource://gre/modules/Timer.sys.mjs",
  setTimeout: "resource://gre/modules/Timer.sys.mjs",
});

const FEATURE_PREF = "whimsy.feature.teach-once";
const ENABLED_PREF = "whimsy.teach.enabled";
const SEEN_PREF = "whimsy.teach.seen";
const ONBOARDED_PREF = "zen.welcome-screen.seen";
const ONBOARDING_ATTR = "zen-welcome-stage";

const PANEL_ID = "whimsy-teach";
const RESET_COMMAND_ID = "cmd_whimsyTeachReset";
export const ARCHIVED_TOPIC = "whimsy-tabs-archived";

// "One hint per session-minute."
const COOLDOWN_MS = 60 * 1000;
// Long enough to read a sentence twice; hovering holds it.
const VISIBLE_MS = 8000;
const AFTER_HOVER_MS = 3000;
// Let the action that triggered it finish (a tab sliding in, a menu
// closing) before pointing at it.
const SETTLE_MS = 300;
// A hint asked for in a background window waits this long for the window
// to come forward, then lets the moment go.
const PENDING_MAX_MS = 10 * 60 * 1000;
// Session restore pins and opens tabs as the window starts; none of that
// is the person acting.
const STARTUP_QUIET_MS = 10 * 1000;

const ICON = "chrome://browser/skin/zen-icons/lightbulb.svg";
const CLOSE_ICON = "chrome://browser/skin/zen-icons/close.svg";
const HTML_NS = "http://www.w3.org/1999/xhtml";

const MODIFIER_LABELS = {
  macosx: { alt: "⌥", ctrl: "⌃", shift: "⇧", meta: "⌘" },
  other: { alt: "Alt", ctrl: "Ctrl", shift: "Shift", meta: "Win" },
};

const windowStarted = new WeakMap();

function featureOn(id) {
  return Services.prefs.getBoolPref(`whimsy.feature.${id}`, true);
}

function settled(win) {
  return Date.now() - (windowStarted.get(win) ?? 0) >= STARTUP_QUIET_MS;
}

/**
 * A trigger that fires on a DOM event: on(win => target, "TabOpen",
 * (win, event) => context | true | falsy).
 */
export function on(getTarget, type, test = () => true, options = {}) {
  return (win, show) => {
    const target = getTarget(win);
    if (!target) {
      return null;
    }
    const listener = event => {
      let context = null;
      try {
        context = test(win, event);
      } catch (e) {
        console.error(`Whimsy: teach trigger ${type}`, e);
      }
      if (context) {
        show(context === true ? {} : context);
      }
    };
    target.addEventListener(type, listener, options);
    return () => target.removeEventListener(type, listener, options);
  };
}

/**
 * A trigger that fires on an observer topic whose subject is the window:
 * onTopic("whimsy-tabs-archived", (win, data) => context | true | falsy).
 */
export function onTopic(topic, test = () => true) {
  return (win, show) => {
    const observer = (subject, _topic, data) => {
      if (subject != win) {
        return;
      }
      const context = test(win, data);
      if (context) {
        show(context === true ? {} : context);
      }
    };
    Services.obs.addObserver(observer, topic);
    return () => Services.obs.removeObserver(observer, topic);
  };
}

// The real page in this window has loaded (not about:blank, not the empty
// Mini Whimsy waiting for an address), then `delay` ms more.
function onFirstPage(delay) {
  return (win, show) => {
    let timer = null;
    const isPage = uri => /^(https?|file):/.test(uri?.spec ?? "");
    const schedule = () => {
      lazy.clearTimeout(timer);
      timer = lazy.setTimeout(() => show({}), delay);
    };
    const listener = {
      onLocationChange(browser, webProgress, request, location) {
        if (webProgress?.isTopLevel && browser == win.gBrowser.selectedBrowser && isPage(location)) {
          schedule();
        }
      },
    };
    win.gBrowser.addProgressListener(listener);
    if (isPage(win.gBrowser.currentURI)) {
      schedule();
    }
    return () => {
      lazy.clearTimeout(timer);
      win.gBrowser.removeProgressListener(listener);
    };
  };
}

function glanceModifierLabel() {
  const method = Services.prefs.getStringPref("zen.glance.activation-method", "alt");
  const labels = AppConstants.platform == "macosx" ? MODIFIER_LABELS.macosx : MODIFIER_LABELS.other;
  return labels[method] ?? null;
}

function urlbarAnchor(win) {
  return win.gURLBar ?? win.document.getElementById("urlbar");
}

// ---------------------------------------------------------------------------
// The registry. Only features that exist, with keys checked against their
// definitions (zen-keysets.inc.xhtml, WhimsyShortcuts, the modules named).

export const HINTS = [
  // Mini Whimsy (WhimsyQuickWindow): ⌘O moves the page into a space, the
  // whole point of Arc's Little Arc. Shown once a real page has loaded.
  {
    id: "mini-open-in-space",
    l10nId: "whimsy-teach-mini",
    window: "mini",
    key: "key_whimsyQuickWindowOpenInSpace",
    usedKeys: ["key_whimsyQuickWindowChooseSpace"],
    isAvailable: () => featureOn("quick-window"),
    anchor: win => win.document.getElementById("whimsy-quick-window-open"),
    position: "after_end",
    trigger: onFirstPage(1200),
  },
  // Glance (Zen, zen.glance.activation-method, ⌥ by default): someone
  // ⌘-clicked or middle-clicked a link into a background tab.
  {
    id: "glance",
    l10nId: "whimsy-teach-glance",
    key: () => glanceModifierLabel(),
    isAvailable: () => Services.prefs.getBoolPref("zen.glance.enabled", true),
    anchor: (win, { tab }) =>
      tab?.isConnected && !tab.closing && !tab.hasAttribute("zen-glance-tab") && !tab.hasAttribute("glance-id")
        ? tab
        : null,
    trigger: on(
      win => win.gBrowser?.tabContainer,
      "TabOpen",
      (win, event) => {
        const tab = event.target;
        const opener = tab.openerTab;
        if (!settled(win) || tab.selected || tab.pinned || !opener || opener != win.gBrowser.selectedTab) {
          return null;
        }
        return { tab };
      }
    ),
    usedWhen: on(win => win, "GlanceOpen"),
  },
  // Selection verbs (WhimsyVerbs, ⌘K): someone right-clicked selected text
  // to do something with it.
  {
    id: "selection-verbs",
    l10nId: "whimsy-teach-verbs",
    key: "key_whimsySelectionVerbs",
    isAvailable: () => featureOn("selection-verbs"),
    anchor: urlbarAnchor,
    trigger: (win, show) => {
      const menu = win.document.getElementById("contentAreaContextMenu");
      if (!menu) {
        return null;
      }
      let hadSelection = false;
      const onShowing = event => {
        if (event.target == menu) {
          hadSelection = !!win.gContextMenu?.isTextSelected;
        }
      };
      const onHidden = event => {
        if (event.target == menu && hadSelection) {
          hadSelection = false;
          show({});
        }
      };
      menu.addEventListener("popupshowing", onShowing);
      menu.addEventListener("popuphidden", onHidden);
      return () => {
        menu.removeEventListener("popupshowing", onShowing);
        menu.removeEventListener("popuphidden", onHidden);
      };
    },
  },
  // Split view (Zen, ⌥⌘V splits the selected tabs): someone selected two
  // to four tabs by hand. Waits a little longer, they may still be picking.
  {
    id: "split-selected",
    l10nId: "whimsy-teach-split",
    key: "zen-split-view-vertical",
    usedKeys: ["zen-split-view-grid", "zen-split-view-horizontal"],
    isAvailable: win => !!win.gZenViewSplitter,
    delay: 1200,
    anchor: win => {
      const tabs = win.gBrowser.selectedTabs;
      if (tabs.length < 2 || tabs.length > 4 || tabs.some(tab => tab.group?.hasAttribute("split-view-group"))) {
        return null;
      }
      return tabs.at(-1);
    },
    trigger: on(
      win => win.gBrowser?.tabContainer,
      "TabMultiSelect",
      win => win.gBrowser.multiSelectedTabsCount >= 2
    ),
  },
  // Auto-archive (WhimsyArchive): what just happened, the first time idle
  // tabs leave a space on their own. The Library (⌥⇧L) is where they are.
  {
    id: "auto-archive",
    l10nId: "whimsy-teach-archive",
    key: "zen-library-toggle",
    isAvailable: () => featureOn("auto-archive-tabs") && featureOn("archive-view"),
    anchor: win =>
      win.document.getElementById("zen-library-button") ?? win.gZenWorkspaces?.activeWorkspaceIndicator ?? null,
    trigger: onTopic(ARCHIVED_TOPIC, (win, reason) => reason == "idle"),
  },
  // Pin (⌘D, WhimsyShortcuts): someone pinned the tab they're on by hand.
  {
    id: "pin",
    l10nId: "whimsy-teach-pin",
    key: "zen-toggle-pin-tab",
    anchor: (win, { tab }) => (tab?.isConnected && tab.pinned ? tab : null),
    trigger: on(
      win => win.gBrowser?.tabContainer,
      "TabPinned",
      (win, event) => (settled(win) && event.target.selected ? { tab: event.target } : null)
    ),
  },
  // Copy URL (Zen, ⇧⌘C; Arc's own): someone copied the whole address out
  // of the address bar.
  {
    id: "copy-url",
    l10nId: "whimsy-teach-copy-url",
    key: "zen-copy-url",
    usedKeys: ["zen-copy-url-markdown"],
    delay: 600,
    anchor: win => (win.gURLBar?.view?.isOpen ? null : urlbarAnchor(win)),
    trigger: on(
      win => win.gURLBar?.inputField,
      "copy",
      win => {
        const input = win.gURLBar?.inputField;
        const length = input?.value?.length ?? 0;
        return !!length && !win.gURLBar.valueIsTyped && input.selectionStart == 0 && input.selectionEnd == length;
      }
    ),
  },
  // Next space (Zen, ⌥⌘→ and ⌥⌘←): someone clicked a space in the switcher.
  {
    id: "next-space",
    l10nId: "whimsy-teach-next-space",
    key: "zen-workspace-forward",
    usedKeys: [
      "zen-workspace-backward",
      ...Array.from({ length: 10 }, (_, i) => `zen-workspace-switch-${i + 1}`),
    ],
    isAvailable: win => (win.gZenWorkspaces?.getWorkspaces?.()?.length ?? 0) > 1,
    anchor: win => win.document.getElementById("zen-workspaces-button"),
    trigger: on(
      win => win.document.getElementById("zen-workspaces-button"),
      "click",
      (win, event) => event.button == 0 && !!event.target.closest?.("toolbarbutton")
    ),
  },
];

// ---------------------------------------------------------------------------

export const WhimsyTeach = {
  HINTS,
  _windows: new Set(),
  _armed: new WeakMap(),
  _pending: new WeakMap(),
  _lastShownAt: 0,
  _showing: false,
  _current: null,
  // A test that wants hints under automation sets this.
  allowInAutomation: false,

  get enabled() {
    return Services.prefs.getBoolPref(FEATURE_PREF, true) && Services.prefs.getBoolPref(ENABLED_PREF, true);
  },

  get(id) {
    return HINTS.find(hint => hint.id == id) ?? null;
  },

  /** Adds (or replaces) a hint; arms it in every open window. */
  register(hint) {
    const index = HINTS.findIndex(h => h.id == hint.id);
    if (index >= 0) {
      this._disarm(hint.id);
      HINTS.splice(index, 1, hint);
    } else {
      HINTS.push(hint);
    }
    this._armAll();
  },

  unregister(id) {
    this._disarm(id);
    const index = HINTS.findIndex(h => h.id == id);
    if (index >= 0) {
      HINTS.splice(index, 1);
    }
  },

  // --- shown state (synced) -------------------------------------------------

  seen() {
    return new Set(
      Services.prefs
        .getStringPref(SEEN_PREF, "")
        .split(",")
        .map(s => s.trim())
        .filter(Boolean)
    );
  },

  hasSeen(id) {
    return this.seen().has(id);
  },

  markSeen(id) {
    const seen = this.seen();
    if (!seen.has(id)) {
      seen.add(id);
      Services.prefs.setStringPref(SEEN_PREF, [...seen].join(","));
    }
  },

  // "Reset Tips": every hint can show again, starting now.
  reset(win = null) {
    Services.prefs.clearUserPref(SEEN_PREF);
    this._lastShownAt = 0;
    if (win?.gZenUIManager?.showToast) {
      win.gZenUIManager.showToast("whimsy-teach-reset-toast");
    }
  },

  // --- windows --------------------------------------------------------------

  init() {
    if (this._initialized) {
      return;
    }
    this._initialized = true;
    this._onPref = () => {
      if (!this.enabled) {
        this.dismiss();
      }
      this._armAll();
    };
    for (const pref of [FEATURE_PREF, ENABLED_PREF, SEEN_PREF]) {
      Services.prefs.addObserver(pref, this._onPref);
    }
  },

  initWindow(win) {
    this.init();
    windowStarted.set(win, Date.now());
    this._windows.add(win);
    lazy.WhimsyCommands.register(win, {
      id: RESET_COMMAND_ID,
      l10nId: "whimsy-action-teach-reset",
      run: w => this.reset(w),
      icon: ICON,
      isAvailable: () => Services.prefs.getBoolPref(FEATURE_PREF, true),
    });
    // Someone who presses a hint's shortcut already knows it. A <key>'s
    // command is redirected to its <command> with the key as the source.
    const onCommand = event => {
      const source = event.sourceEvent?.originalTarget ?? event.originalTarget;
      if (source?.localName == "key" && source.id) {
        this.noteKey(source.id);
      }
    };
    win.addEventListener("command", onCommand, true);
    win.addEventListener(
      "unload",
      () => {
        win.removeEventListener("command", onCommand, true);
        this._disarmWindow(win);
        this._windows.delete(win);
        if (this._current?.win == win) {
          this._current = null;
        }
      },
      { once: true }
    );
    this._arm(win);
  },

  noteKey(keyId) {
    for (const hint of HINTS) {
      const keys = [typeof hint.key == "string" ? hint.key : null, ...(hint.usedKeys ?? [])];
      if (keys.includes(keyId)) {
        this.markSeen(hint.id);
      }
    }
  },

  _kind(win) {
    return win._whimsyQuickWindow ? "mini" : "main";
  },

  _arm(win) {
    let armed = this._armed.get(win);
    if (!armed) {
      armed = new Map();
      this._armed.set(win, armed);
    }
    const seen = this.seen();
    const active = this.enabled;
    for (const hint of HINTS) {
      const wanted = active && !seen.has(hint.id) && (hint.window ?? "main") == this._kind(win);
      if (wanted && !armed.has(hint.id)) {
        const cleanups = [];
        try {
          cleanups.push(hint.trigger?.(win, context => this.request(win, hint.id, context)));
          cleanups.push(hint.usedWhen?.(win, () => this.markSeen(hint.id)));
        } catch (e) {
          console.error(`Whimsy: teach ${hint.id}`, e);
        }
        armed.set(hint.id, () => {
          for (const cleanup of cleanups) {
            try {
              cleanup?.();
            } catch (e) {
              console.error(`Whimsy: teach ${hint.id} cleanup`, e);
            }
          }
        });
      } else if (!wanted && armed.has(hint.id)) {
        armed.get(hint.id)();
        armed.delete(hint.id);
      }
    }
  },

  _armAll() {
    for (const win of this._windows) {
      if (!win.closed) {
        this._arm(win);
      }
    }
  },

  _disarm(id) {
    for (const win of this._windows) {
      const armed = this._armed.get(win);
      if (armed?.has(id)) {
        armed.get(id)();
        armed.delete(id);
      }
    }
  },

  _disarmWindow(win) {
    const armed = this._armed.get(win);
    for (const cleanup of armed?.values() ?? []) {
      cleanup();
    }
    this._armed.delete(win);
  },

  // --- showing --------------------------------------------------------------

  _onboarding(win) {
    if (!Services.prefs.getBoolPref(ONBOARDED_PREF, false)) {
      return true;
    }
    return [win, ...this._windows].some(w => !w.closed && w.document.documentElement.hasAttribute(ONBOARDING_ATTR));
  },

  // Everything that can say "not now", without side effects.
  canShow(win, hint) {
    if (!hint || !win || win.closed || !this.enabled) {
      return false;
    }
    if (Cu.isInAutomation && !this.allowInAutomation) {
      return false;
    }
    if (this.hasSeen(hint.id) || (hint.window ?? "main") != this._kind(win)) {
      return false;
    }
    if (this._showing || this._current || Date.now() - this._lastShownAt < COOLDOWN_MS) {
      return false;
    }
    if (this._onboarding(win)) {
      return false;
    }
    try {
      return hint.isAvailable?.(win) !== false;
    } catch (e) {
      return false;
    }
  },

  keyLabel(win, hint) {
    if (typeof hint.key == "function") {
      return hint.key(win) || null;
    }
    if (!hint.key) {
      return "";
    }
    const keyEl = win.document.getElementById(hint.key);
    if (!keyEl || keyEl.getAttribute("disabled") == "true" || (!keyEl.getAttribute("key") && !keyEl.getAttribute("keycode"))) {
      return null;
    }
    return lazy.ShortcutUtils.prettifyShortcut(keyEl) || null;
  },

  _visible(win, el) {
    if (!el?.isConnected || el.closest("[hidden]") || !el.checkVisibility?.({ visibilityProperty: true })) {
      return false;
    }
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 && rect.right > 0 && rect.bottom > 0 &&
      rect.left < win.innerWidth && rect.top < win.innerHeight;
  },

  // Another menu, panel or the command bar is up: a hint would stack.
  _busy(win) {
    if (win.gURLBar?.view?.isOpen) {
      return true;
    }
    for (const popup of win.document.querySelectorAll("panel, menupopup")) {
      if (popup.id != PANEL_ID && (popup.state == "open" || popup.state == "showing")) {
        return true;
      }
    }
    return false;
  },

  /**
   * Show hint `id` in `win` if it's the moment. Resolves to the open
   * <panel>, or null when it isn't (already seen, too soon, switched off,
   * nothing to point at...). A hint that couldn't show isn't used up.
   */
  trigger(win, id, context = {}) {
    return this.request(win, id, context);
  },

  async request(win, id, context = {}) {
    const hint = this.get(id);
    if (!this.canShow(win, hint)) {
      return null;
    }
    if (Services.focus.activeWindow != win) {
      this._waitForWindow(win, id, context);
      return null;
    }
    this._showing = true;
    try {
      await new Promise(resolve => lazy.setTimeout(resolve, hint.delay ?? SETTLE_MS));
      this._showing = false;
      if (!this.canShow(win, hint) || this._busy(win)) {
        return null;
      }
      const label = this.keyLabel(win, hint);
      if (label === null) {
        return null;
      }
      const anchor = hint.anchor?.(win, context) ?? null;
      if (!this._visible(win, anchor)) {
        return null;
      }
      // Claimed before it opens, so a second window can't repeat it.
      this.markSeen(hint.id);
      this._lastShownAt = Date.now();
      return await this._open(win, hint, anchor, label);
    } catch (e) {
      console.error(`Whimsy: teach ${id}`, e);
      return null;
    } finally {
      this._showing = false;
    }
  },

  // Asked for while another window (or app) was in front: try again when
  // this one comes forward, unless the moment is long gone.
  _waitForWindow(win, id, context) {
    if (this._pending.has(win)) {
      return;
    }
    const since = Date.now();
    const onActivate = () => {
      this._pending.delete(win);
      if (Date.now() - since < PENDING_MAX_MS) {
        this.request(win, id, context);
      }
    };
    this._pending.set(win, onActivate);
    win.addEventListener("activate", onActivate, { once: true });
  },

  _position(win, anchor) {
    const rect = anchor.getBoundingClientRect();
    const narrow = rect.width < win.innerWidth * 0.4;
    if (narrow && rect.right <= win.innerWidth * 0.4) {
      return "end_before"; // beside a left sidebar
    }
    if (narrow && rect.left >= win.innerWidth * 0.6) {
      return rect.top < win.innerHeight * 0.2 ? "after_end" : "start_before"; // a right sidebar
    }
    return "after_start";
  },

  async _open(win, hint, anchor, label) {
    const doc = win.document;
    doc.getElementById(PANEL_ID)?.remove();
    const panel = doc.createXULElement("panel");
    panel.id = PANEL_ID;
    panel.className = "whimsy-teach";
    panel.setAttribute("type", "arrow");
    panel.setAttribute("noautofocus", "true");
    panel.setAttribute("consumeoutsideclicks", "false");
    // Keys keep going to the page; only Esc is ours (below).
    panel.setAttribute("ignorekeys", "true");
    panel.setAttribute("role", "status");
    panel.setAttribute("aria-live", "polite");
    panel.dataset.hint = hint.id;

    const body = doc.createXULElement("hbox");
    body.className = "whimsy-teach-body";
    body.setAttribute("align", "start");
    const icon = doc.createXULElement("image");
    icon.className = "whimsy-teach-icon";
    icon.setAttribute("src", ICON);
    icon.setAttribute("role", "presentation");
    const text = doc.createElementNS(HTML_NS, "p");
    text.className = "whimsy-teach-text";
    doc.l10n.setAttributes(text, hint.l10nId, { key: label });
    const close = lazy.WhimsyPanels.iconButton(doc, {
      icon: CLOSE_ICON,
      l10nId: "whimsy-sheet-close",
      onCommand: () => this.dismiss(),
    });
    close.classList.add("whimsy-sheet-close", "whimsy-teach-close");
    body.append(icon, text, close);
    panel.append(body);
    (doc.getElementById("mainPopupSet") ?? doc.documentElement).append(panel);

    // Translate first, so it opens at its final size.
    await doc.l10n.translateElements([text, close]);
    if (win.closed || !anchor.isConnected || !this.enabled) {
      panel.remove();
      return null;
    }

    let timer = null;
    const arm = ms => {
      lazy.clearTimeout(timer);
      timer = lazy.setTimeout(() => this.dismiss(), ms);
    };
    const onKey = event => {
      if (event.key == "Escape" && !event.defaultPrevented && panel.state == "open") {
        event.preventDefault();
        event.stopPropagation();
        this.dismiss();
      }
    };
    // The moment has passed.
    const onMoveOn = () => this.dismiss();
    const tabs = win.gBrowser?.tabContainer;
    panel.addEventListener("mouseenter", () => lazy.clearTimeout(timer));
    panel.addEventListener("mouseleave", () => arm(AFTER_HOVER_MS));
    panel.addEventListener("popupshown", () => arm(VISIBLE_MS), { once: true });
    panel.addEventListener("popuphidden", event => {
      if (event.target != panel) {
        return;
      }
      lazy.clearTimeout(timer);
      win.removeEventListener("keydown", onKey, true);
      tabs?.removeEventListener("TabSelect", onMoveOn);
      if (this._current?.panel == panel) {
        this._current = null;
      }
      panel.remove();
    });
    win.addEventListener("keydown", onKey, true);
    tabs?.addEventListener("TabSelect", onMoveOn);

    this._current = { win, panel, id: hint.id };
    panel.openPopup(anchor, { position: hint.position ?? this._position(win, anchor) });
    return panel;
  },

  // Closes the open hint, if any.
  dismiss() {
    const panel = this._current?.panel;
    if (panel && (panel.state == "open" || panel.state == "showing")) {
      panel.hidePopup();
    } else if (panel) {
      panel.remove();
      this._current = null;
    }
  },

  // Tests: forget the per-session cooldown.
  _resetSession() {
    this.dismiss();
    this._current = null;
    this._showing = false;
    this._lastShownAt = 0;
  },
};
