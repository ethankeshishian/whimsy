/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// W13-R2 paste to upload, the indicator (option D, the user's pick; see
// wave13/r2-paste-design.md §6). While the clipboard holds an image or a
// file, the upload targets on screen get a small "⌘V Paste" badge; hovering
// or focusing one grows it into a pill with the drag highlight on its box;
// clicking it pastes there; after a paste it says "Uploading… ✓" or
// "Couldn't upload: the site didn't accept it".
//
// - Drawn here, in the browser's own layer above the page (the tab's
//   .browserStack), never in the page: the page can't see, style or click
//   it. The page side (WhimsyUploadChild) only reports where its targets
//   are, found with the same rule the paste uses.
// - The clipboard is checked by type only (WhimsyUploadParent.clipboardKind),
//   when the window comes to the front, on a tab switch, after a copy in
//   Whimsy, and when you point at a target while nothing shows. Never on a
//   timer.
// - Badges show for 5 minutes after the clipboard's content is first seen,
//   at most 3, only for targets in view; after that only the pill (on hover
//   or focus). Off in private tabs, with whimsy.uploadClipboard.badges off,
//   and with the feature off.

import { AppConstants } from "resource://gre/modules/AppConstants.sys.mjs";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  PrivateBrowsingUtils: "resource://gre/modules/PrivateBrowsingUtils.sys.mjs",
  WhimsyCommands: "resource:///modules/whimsy/WhimsyCommands.sys.mjs",
  WhimsyToast: "resource:///modules/whimsy/WhimsyToast.sys.mjs",
  WhimsyUploadParent: "resource:///modules/whimsy/WhimsyUploadParent.sys.mjs",
  clipboardKind: "resource:///modules/whimsy/WhimsyUploadParent.sys.mjs",
  FILE_FLAVOR: "resource:///modules/whimsy/WhimsyUploadParent.sys.mjs",
  IMAGE_FLAVOR: "resource:///modules/whimsy/WhimsyUploadParent.sys.mjs",
});

const FEATURE_PREF = "whimsy.feature.upload-clipboard";
export const BADGES_PREF = "whimsy.uploadClipboard.badges";
const HTML_NS = "http://www.w3.org/1999/xhtml";
const ICON = "chrome://browser/skin/zen-icons/edit-paste.svg";

const MAX_BADGES = 3;
const BADGE_H = 24;
const GAP = 4;
// A copy in Whimsy lands on the clipboard a moment after the key or menu
// command: a check after each of these (two one-shots, never a loop).
const COPY_SETTLE_MS = [250, 1000];
// A child asking for a check (pointer near a target) at most this often.
const NEAR_MS = 1000;

const pasteKey = () => (AppConstants.platform == "macosx" ? "⌘V" : "Ctrl+V");

// Sets an element's string only when it changes (render runs every frame
// while the page scrolls).
function setL10n(element, id, args = null) {
  const key = id + JSON.stringify(args);
  if (element.dataset.l10nKey != key) {
    element.dataset.l10nKey = key;
    element.ownerDocument.l10n.setAttributes(element, id, args);
  }
}

// The clipboard as last checked, flavors only: { kind, firstSeen, snapshot }
// or null. The snapshot is a change token: it turns invalid when the
// clipboard changes (it never holds the data).
let clip = null;
let freshTimer = null;
let lastNear = 0;
let observingPrefs = false;
const windows = new Set();
// <browser> → its layer's state.
const layers = new WeakMap();

function snapshotNow() {
  try {
    return Services.clipboard.getDataSnapshotSync([lazy.FILE_FLAVOR, lazy.IMAGE_FLAVOR], Ci.nsIClipboard.kGlobalClipboard);
  } catch (e) {
    return null;
  }
}

function actorFor(browser) {
  try {
    return browser?.browsingContext?.currentWindowGlobal?.getActor("WhimsyUpload") ?? null;
  } catch (e) {
    return null;
  }
}

export const WhimsyUploadBadges = {
  // How long badges show after the clipboard's content is first seen.
  // Overridable for tests.
  FRESH_MS: 5 * 60 * 1000,
  DONE_MS: 2500,
  FAILED_MS: 4000,

  get enabled() {
    return Services.prefs.getBoolPref(FEATURE_PREF, true) && Services.prefs.getBoolPref(BADGES_PREF, true);
  },

  // For tests: the clipboard as last checked.
  get clipboardState() {
    return clip ? { kind: clip.kind, firstSeen: clip.firstSeen } : null;
  },

  initWindow(win) {
    if (!win.gBrowser) {
      return;
    }
    windows.add(win);
    win.addEventListener("activate", () => this.check());
    win.gBrowser.tabContainer.addEventListener("TabSelect", event => this.onTabSelect(win, event));
    // A copy in Whimsy: Cmd+C or Cmd+X anywhere in the window, or a copy
    // command (Copy Image, Copy Link, Whimsy's copy actions).
    win.addEventListener(
      "keydown",
      event => {
        const key = event.key?.toLowerCase();
        if (
          event.isTrusted &&
          (key == "c" || key == "x") &&
          (AppConstants.platform == "macosx" ? event.metaKey : event.ctrlKey) &&
          !event.altKey
        ) {
          this.checkSoon(win);
        }
      },
      { capture: true, mozSystemGroup: true }
    );
    win.addEventListener(
      "command",
      event => {
        if (/copy/i.test(event.target?.id ?? "")) {
          this.checkSoon(win);
        }
      },
      true
    );
    win.addEventListener("unload", () => windows.delete(win), { once: true });
    if (!observingPrefs) {
      observingPrefs = true;
      Services.prefs.addObserver(BADGES_PREF, () => this.pushAll());
      Services.prefs.addObserver(FEATURE_PREF, () => this.pushAll());
    }
    lazy.WhimsyCommands.register(win, {
      id: "cmd_whimsyPasteToUpload",
      l10nId: "whimsy-action-paste-to-upload",
      run: w => this.pasteCommand(w),
      icon: ICON,
      isAvailable: () => Services.prefs.getBoolPref(FEATURE_PREF, true),
    });
  },

  // ── The clipboard ─────────────────────────────────────────────────────

  checkSoon(win) {
    const copied = { first: true };
    for (const ms of COPY_SETTLE_MS) {
      win.setTimeout(() => {
        // The first check after a copy marks the content new; a later one
        // only notices a copy that landed late (the snapshot changed).
        this.check({ copied: copied.first });
        copied.first = false;
      }, ms);
    }
  },

  // Reads the clipboard's type and tells the selected tabs. `copied`: a copy
  // in Whimsy just happened, so this is new content.
  check({ copied = false } = {}) {
    const kind = lazy.clipboardKind();
    if (!kind) {
      clip = null;
    } else if (copied || !clip || clip.kind != kind || (clip.snapshot && !clip.snapshot.valid)) {
      clip = { kind, firstSeen: Date.now(), snapshot: snapshotNow() };
    }
    this.scheduleExpiry();
    this.pushAll();
  },

  // For tests: as if the clipboard's content was first seen `ms` ago.
  _testFirstSeen(ms) {
    if (clip) {
      clip.firstSeen = Date.now() - ms;
      this.scheduleExpiry();
      this.pushAll();
    }
  },

  // One timer: when the badges' 5 minutes are up, every tab drops to the
  // pill.
  scheduleExpiry() {
    if (freshTimer) {
      freshTimer.cancel();
      freshTimer = null;
    }
    const left = clip ? clip.firstSeen + this.FRESH_MS - Date.now() : 0;
    if (left > 0) {
      freshTimer = Cc["@mozilla.org/timer;1"].createInstance(Ci.nsITimer);
      freshTimer.initWithCallback(() => {
        freshTimer = null;
        this.pushAll();
      }, left + 10, Ci.nsITimer.TYPE_ONE_SHOT);
    }
  },

  isPrivate(browser) {
    try {
      return lazy.PrivateBrowsingUtils.isBrowserPrivate(browser);
    } catch (e) {
      return true;
    }
  },

  modeFor(browser) {
    if (!browser || !this.enabled || !clip || this.isPrivate(browser)) {
      return "off";
    }
    return Date.now() - clip.firstSeen < this.FRESH_MS ? "badges" : "pill";
  },

  // What a page is told (WhimsyUpload:Hello, Arm). Never the clipboard's
  // contents; the page side doesn't need its kind either.
  stateFor(browser) {
    const allowed = !!browser && this.enabled && !this.isPrivate(browser);
    const selected = browser?.documentGlobal?.gBrowser?.selectedBrowser == browser;
    return { allowed, mode: selected ? this.modeFor(browser) : "off" };
  },

  pushAll() {
    for (const win of windows) {
      this.push(win.gBrowser?.selectedBrowser);
    }
  },

  push(browser) {
    if (!browser) {
      return;
    }
    actorFor(browser)?.sendAsyncMessage("WhimsyUpload:Arm", this.stateFor(browser));
    this.render(browser);
  },

  onTabSelect(win, event) {
    const previous = event.detail?.previousTab?.linkedBrowser;
    if (previous) {
      actorFor(previous)?.sendAsyncMessage("WhimsyUpload:Arm", {
        allowed: this.stateFor(previous).allowed,
        mode: "off",
      });
      this.clear(previous);
    }
    this.check();
  },

  // ── From the page ────────────────────────────────────────────────────

  fromChild(browser, name, data) {
    const state = this.layerState(browser);
    switch (name) {
      case "WhimsyUpload:Targets":
        state.targets = Array.isArray(data.targets) ? data.targets.slice(0, 20) : [];
        state.viewport = data.viewport ?? null;
        state.avoid = data.avoid ?? null;
        break;
      case "WhimsyUpload:Hot":
        state.hot = data.id ?? null;
        break;
      case "WhimsyUpload:Status":
        this.setStatus(browser, data.id, data.state);
        return;
      case "WhimsyUpload:FocusBadge":
        this.focusBadge(browser, data.id);
        return;
      case "WhimsyUpload:Near":
        if (Date.now() - lastNear >= NEAR_MS && browser.documentGlobal?.gBrowser?.selectedBrowser == browser) {
          lastNear = Date.now();
          this.check();
        }
        return;
    }
    this.render(browser);
  },

  // ── Drawing ──────────────────────────────────────────────────────────

  layerState(browser) {
    let state = layers.get(browser);
    if (!state) {
      state = {
        layer: null,
        highlight: null,
        badges: new Map(),
        targets: [],
        viewport: null,
        avoid: null,
        hot: null,
        badgeHover: null,
        badgeFocus: null,
        status: new Map(),
      };
      layers.set(browser, state);
    }
    return state;
  },

  clear(browser) {
    const state = layers.get(browser);
    if (!state) {
      return;
    }
    state.targets = [];
    state.hot = state.badgeHover = state.badgeFocus = null;
    this.render(browser);
  },

  ensureLayer(browser, state) {
    const stack = browser.closest(".browserStack");
    if (!stack) {
      return null;
    }
    if (!state.layer) {
      const doc = browser.ownerDocument;
      state.layer = doc.createElementNS(HTML_NS, "div");
      state.layer.className = "whimsy-paste-layer";
      state.highlight = doc.createElementNS(HTML_NS, "div");
      state.highlight.className = "whimsy-paste-highlight";
      state.highlight.hidden = true;
      state.layer.append(state.highlight);
    }
    if (state.layer.parentNode != stack) {
      stack.append(state.layer);
    }
    return state.layer;
  },

  // The badge for `id` (a button), made on first use.
  badgeFor(browser, state, id) {
    let button = state.badges.get(id);
    if (button) {
      return button;
    }
    const doc = browser.ownerDocument;
    button = doc.createElementNS(HTML_NS, "button");
    button.className = "whimsy-paste-badge";
    button.dataset.id = id;
    const kbd = doc.createElementNS(HTML_NS, "kbd");
    kbd.className = "whimsy-paste-key";
    kbd.textContent = pasteKey();
    const icon = doc.createElementNS(HTML_NS, "span");
    icon.className = "whimsy-paste-icon";
    const label = doc.createElementNS(HTML_NS, "span");
    label.className = "whimsy-paste-text";
    button.append(icon, kbd, label);
    // A click pastes; it never takes focus from the page.
    button.addEventListener("mousedown", event => event.preventDefault());
    button.addEventListener("click", () => this.pasteInto(browser, id));
    button.addEventListener("mouseenter", () => this.setBadgeHover(browser, id));
    button.addEventListener("mouseleave", () => this.setBadgeHover(browser, null));
    button.addEventListener("focus", () => {
      state.badgeFocus = id;
      this.render(browser);
    });
    button.addEventListener("blur", () => {
      if (state.badgeFocus == id) {
        state.badgeFocus = null;
        this.render(browser);
      }
    });
    button.addEventListener("keydown", event => this.onBadgeKey(browser, id, event));
    state.badges.set(id, button);
    this.ensureLayer(browser, state)?.append(button);
    return button;
  },

  setBadgeHover(browser, id) {
    const state = this.layerState(browser);
    state.badgeHover = id;
    actorFor(browser)?.sendAsyncMessage("WhimsyUpload:BadgeHover", { id });
    this.render(browser);
  },

  render(browser) {
    const state = layers.get(browser);
    if (!state) {
      return;
    }
    const mode = this.modeFor(browser);
    const selected = browser.documentGlobal?.gBrowser?.selectedBrowser == browser;
    const targets = mode != "off" && selected && state.viewport ? state.targets : [];
    const byId = new Map(targets.map(t => [t.id, t]));
    const hot = [state.badgeFocus, state.badgeHover, state.hot].find(id => id != null && byId.has(id)) ?? null;

    // Which boxes show something: the first 3 badges (badges mode), the hot
    // one's pill (both modes), and any box with a paste status.
    const shown = new Set();
    if (mode == "badges") {
      targets.slice(0, MAX_BADGES).forEach(t => shown.add(t.id));
    }
    if (hot != null) {
      shown.add(hot);
    }
    for (const id of state.status.keys()) {
      if (byId.has(id)) {
        shown.add(id);
      }
    }
    for (const [id, button] of state.badges) {
      if (!shown.has(id)) {
        button.remove();
        state.badges.delete(id);
        // A removed badge gets no mouseleave or blur.
        if (state.badgeHover == id) {
          state.badgeHover = null;
          actorFor(browser)?.sendAsyncMessage("WhimsyUpload:BadgeHover", { id: null });
        }
        if (state.badgeFocus == id) {
          state.badgeFocus = null;
        }
      }
    }
    if (!shown.size) {
      if (state.highlight) {
        state.highlight.hidden = true;
      }
      if (state.layer) {
        state.layer.hidden = true;
      }
      return;
    }
    const layer = this.ensureLayer(browser, state);
    if (!layer) {
      return;
    }
    layer.hidden = false;

    // Page coordinates → the layer's: the browser's offset in the layer and
    // its size over the page's viewport (any zoom).
    const browserRect = browser.getBoundingClientRect();
    const layerRect = layer.getBoundingClientRect();
    const scale = state.viewport.w ? browserRect.width / state.viewport.w : 1;
    const ox = browserRect.left - layerRect.left;
    const oy = browserRect.top - layerRect.top;
    const toLayer = r => ({ x: ox + r.x * scale, y: oy + r.y * scale, w: r.w * scale, h: r.h * scale });
    const bounds = { top: oy, bottom: oy + browserRect.height, left: ox, right: ox + browserRect.width };
    const avoid = state.avoid ? toLayer(state.avoid) : null;
    const overlaps = (top, left, right) =>
      avoid && top < avoid.y + avoid.h && top + BADGE_H > avoid.y && left < avoid.x + avoid.w && right > avoid.x;

    const kind = clip?.kind == "file" ? "file" : "image";
    for (const id of shown) {
      const target = byId.get(id);
      const r = toLayer(target);
      const button = this.badgeFor(browser, state, id);
      const status = state.status.get(id)?.state ?? null;
      const isHot = id == hot;
      button.classList.toggle("whimsy-paste-hot", isHot || !!status);
      button.toggleAttribute("status", !!status);
      button.dataset.status = status ?? "";
      const text = button.querySelector(".whimsy-paste-text");
      if (status) {
        setL10n(text, `whimsy-upload-status-${status}`);
      } else if (isHot) {
        setL10n(text, `whimsy-upload-pill-${kind}`, { key: pasteKey() });
      } else {
        setL10n(text, "whimsy-upload-badge-paste");
      }
      // Attributes only (aria-label): Fluent leaves the button's children.
      setL10n(button, `whimsy-upload-badge-${kind}`);

      // Above the box's top-right corner, outside it; below it when there's
      // no room above; never over the focused text field.
      const right = Math.max(0, layerRect.width - Math.min(r.x + r.w, bounds.right) + 10);
      const rightEdge = layerRect.width - right;
      const leftEdge = rightEdge - 220;
      let top = r.y - BADGE_H - GAP;
      if (top < bounds.top + 2 || overlaps(top, leftEdge, rightEdge)) {
        const below = r.y + r.h + GAP;
        if (below + BADGE_H <= bounds.bottom - 2 && !overlaps(below, leftEdge, rightEdge)) {
          top = below;
        } else {
          top = Math.max(bounds.top + 2, r.y - BADGE_H / 2);
        }
      }
      button.style.top = `${Math.round(top)}px`;
      button.style.right = `${Math.round(right)}px`;
    }

    // The drag-style highlight on the hot box.
    if (hot != null) {
      const r = toLayer(byId.get(hot));
      Object.assign(state.highlight.style, {
        left: `${Math.round(r.x)}px`,
        top: `${Math.round(r.y)}px`,
        width: `${Math.round(r.w)}px`,
        height: `${Math.round(r.h)}px`,
      });
      state.highlight.hidden = false;
    } else {
      state.highlight.hidden = true;
    }
  },

  // ── Paste from a badge, the keyboard and the command ─────────────────

  setStatus(browser, id, status) {
    const state = this.layerState(browser);
    if (id == null || !["uploading", "done", "failed"].includes(status)) {
      return;
    }
    const old = state.status.get(id);
    old?.timer?.cancel();
    const entry = { state: status, timer: null };
    const ms = status == "done" ? this.DONE_MS : status == "failed" ? this.FAILED_MS : 10000;
    entry.timer = Cc["@mozilla.org/timer;1"].createInstance(Ci.nsITimer);
    entry.timer.initWithCallback(() => {
      if (state.status.get(id) == entry) {
        state.status.delete(id);
        this.render(browser);
      }
    }, ms, Ci.nsITimer.TYPE_ONE_SHOT);
    state.status.set(id, entry);
    this.render(browser);
  },

  // Reads the clipboard here (the click or the command is the gesture) and
  // hands the file to the page side for that box.
  async pasteInto(browser, id) {
    const actor = actorFor(browser);
    if (!actor) {
      return false;
    }
    this.setStatus(browser, id, "uploading");
    const file = await lazy.WhimsyUploadParent.readClipboardFile();
    let ok = false;
    if (file) {
      try {
        ok = !!(await actor.sendQuery("WhimsyUpload:Deliver", { id, file }))?.ok;
      } catch (e) {
        ok = false;
      }
    }
    this.setStatus(browser, id, ok ? "done" : "failed");
    return ok;
  },

  // Paste Image to Upload: into the box Cmd+V would choose.
  async pasteCommand(win) {
    const browser = win.gBrowser?.selectedBrowser;
    const actor = actorFor(browser);
    let resolved = null;
    try {
      resolved = await actor?.sendQuery("WhimsyUpload:Resolve");
    } catch (e) {
      resolved = null;
    }
    if (!resolved?.id) {
      lazy.WhimsyToast.show(win, { l10nId: "whimsy-upload-no-target", browser });
      return;
    }
    const ok = await this.pasteInto(browser, resolved.id);
    // No badge to say it (private tab, the setting off): a toast instead.
    if (!ok && this.modeFor(browser) == "off") {
      lazy.WhimsyToast.show(win, { l10nId: "whimsy-upload-status-failed", browser });
    }
  },

  // Tab from a focused box lands on its badge.
  focusBadge(browser, id) {
    const state = this.layerState(browser);
    if (!state.targets.some(t => t.id == id) || this.modeFor(browser) == "off") {
      actorFor(browser)?.sendAsyncMessage("WhimsyUpload:Refocus", { id, after: true });
      return;
    }
    state.badgeFocus = id;
    this.render(browser);
    state.badges.get(id)?.focus();
  },

  onBadgeKey(browser, id, event) {
    const back = event.key == "Escape" || (event.key == "Tab" && event.shiftKey);
    const on = event.key == "Tab" && !event.shiftKey;
    if (!back && !on) {
      return;
    }
    event.preventDefault();
    const state = this.layerState(browser);
    state.badgeFocus = null;
    browser.focus();
    actorFor(browser)?.sendAsyncMessage("WhimsyUpload:Refocus", { id, after: on });
    this.render(browser);
  },
};
