/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// W11-14: lock private browsing behind Touch ID or the Mac password
// (wave11/design/private-lock-spec.md, with the user's picks).
//
// Three separate lockable things, each with its own switch (d1): private
// tabs in a normal space, the Private Space, and private windows. Each
// switch starts "not chosen" (behaves as off). The first time one of them
// opens, a surface asks once whether to lock it (Don't Lock / Lock, neither
// the default). Esc asks again next time and stops after two dismissals
// (d2).
//
// When it locks: once none of that kind is in front of you (the private tab
// isn't selected, the Private Space isn't the active space, no private
// window is frontmost, or Whimsy isn't the active app) for "Lock after"
// (default Right away, d3). Always on Mac sleep, and when Whimsy starts
// sharing the screen unless "Stay unlocked while sharing" is on (d4).
// Locking the Mac makes Whimsy inactive, which counts as away.
//
// A locked surface: an opaque cover in the space's colours (d5) over the
// page (a tab or the Private Space) or the whole window (a private window),
// with Unlock. Landing on it asks for Touch ID at once (d6); a cancel shows
// "Didn't unlock. Try again." and doesn't ask again until you leave and
// come back. One unlock unlocks everything. Locked tabs read "Private tab"
// with a lock (the Private Space's collapse to one "N private tabs" row),
// the address bar reads "Locked", the window title is generic. Closing and
// Fire work without unlocking (d10). Turning a switch off asks for Touch ID
// only while something is locked (d8).
//
// Through WhimsyAuth (OSReauthenticator, no native patch: d7). Lock Space
// uses the same cover (d14, WhimsySpaceLock).

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  PrivateBrowsingUtils: "resource://gre/modules/PrivateBrowsingUtils.sys.mjs",
  WhimsyAuth: "resource:///modules/whimsy/WhimsyAuth.sys.mjs",
  WhimsyCommands: "resource:///modules/whimsy/WhimsyCommands.sys.mjs",
  WhimsyPrivate: "resource:///modules/whimsy/WhimsyPrivate.sys.mjs",
  WhimsySpaceLock: "resource:///modules/whimsy/WhimsySpaceLock.sys.mjs",
  WhimsySurface: "resource:///modules/whimsy/WhimsySurface.sys.mjs",
  webrtcUI: "resource:///modules/webrtcUI.sys.mjs",
});
ChromeUtils.defineLazyGetter(lazy, "l10n", () => new Localization(["browser/whimsy.ftl"], true));

const HTML_NS = "http://www.w3.org/1999/xhtml";
export const KINDS = ["tabs", "space", "windows"];
const PREF = kind => `whimsy.privateLock.${kind}`;
const DISMISS_PREF = kind => `whimsy.privateLock.askDismissals.${kind}`;
const AFTER_PREF = "whimsy.privateLock.afterSeconds";
const SHARING_PREF = "whimsy.privateLock.stayUnlockedWhileSharing";
const FEATURE_PREF = "whimsy.feature.private-lock";
const ASK_ID = "whimsyPrivateLockAsk";
const LOCKED_ATTR = "whimsy-private-locked";
const COVER_CLASS = "whimsy-lock-cover";

// Module state (one app): which kinds are locked, and since when each kind
// has been out of sight.
const locked = new Set();
const awaySince = new Map();
let timer = null;
// The surface a cancel was answered on: no automatic prompt there again
// until the person leaves and comes back (d6).
let declinedFront = null;

export const WhimsyPrivateLock = {
  KINDS,
  ASK_ID,
  LOCKED_ATTR,

  get enabled() {
    return Services.prefs.getBoolPref(FEATURE_PREF, true);
  },

  // -1 not chosen (acts as off), 0 off, 1 on.
  choice(kind) {
    return Services.prefs.getIntPref(PREF(kind), -1);
  },

  isOn(kind) {
    return this.enabled && this.choice(kind) == 1;
  },

  get afterSeconds() {
    return Math.max(0, Services.prefs.getIntPref(AFTER_PREF, 0));
  },

  isLocked(kind) {
    return locked.has(kind);
  },

  get anyLocked() {
    return locked.size > 0;
  },

  // --- what is private, and where ---------------------------------------

  isPrivateWindow(win) {
    return !!win && !win.closed && lazy.PrivateBrowsingUtils.isWindowPrivate(win);
  },

  // The kind a tab belongs to, or null for a normal tab.
  kindOfTab(win, tab) {
    if (!tab || tab.closing) {
      return null;
    }
    if (this.isPrivateWindow(win)) {
      return "windows";
    }
    if (!lazy.WhimsyPrivate.isPrivateTab(tab) && !lazy.WhimsyPrivate.isPrivateBrowser(tab.linkedBrowser)) {
      return null;
    }
    return lazy.WhimsyPrivate.isScratchId(win, tab.getAttribute("zen-workspace-id")) ? "space" : "tabs";
  },

  browserWindows() {
    return [...Services.wm.getEnumerator("navigator:browser")].filter(w => !w.closed && w.gBrowser);
  },

  tabsOfKind(kind) {
    const out = [];
    for (const win of this.browserWindows()) {
      for (const tab of win.gBrowser.tabs) {
        if (this.kindOfTab(win, tab) == kind) {
          out.push(tab);
        }
      }
    }
    return out;
  },

  hasOpen(kind) {
    return this.tabsOfKind(kind).length > 0;
  },

  // Which kind is in front of the person right now, or null.
  frontKind() {
    const win = Services.focus.activeWindow;
    if (!win?.gBrowser || win.closed) {
      return null;
    }
    return this.kindOfTab(win, win.gBrowser.selectedTab);
  },

  isTabCovered(win, tab) {
    const kind = this.kindOfTab(win, tab);
    return !!kind && locked.has(kind);
  },

  // --- locking -------------------------------------------------------------

  lock(kind) {
    if (!this.isOn(kind) || locked.has(kind) || !this.hasOpen(kind)) {
      return false;
    }
    locked.add(kind);
    awaySince.delete(kind);
    this.renderAll();
    Services.obs.notifyObservers(null, "whimsy-private-lock-changed", kind);
    return true;
  },

  // Lock Private Browsing Now: every kind that's on and open.
  lockNow() {
    let any = false;
    for (const kind of KINDS) {
      any = this.lock(kind) || any;
    }
    return any;
  },

  unlockAll() {
    if (!locked.size) {
      return;
    }
    locked.clear();
    awaySince.clear();
    declinedFront = null;
    this.renderAll();
    Services.obs.notifyObservers(null, "whimsy-private-lock-changed", "");
  },

  /** Asks for Touch ID or the password, then unlocks everything. */
  async unlock(win) {
    if (!locked.size) {
      return true;
    }
    const result = await lazy.WhimsyAuth.unlock(win, "whimsy-auth-reason-private");
    if (result == "cancel") {
      for (const w of this.browserWindows()) {
        w.document.querySelectorAll(`.${COVER_CLASS}`).forEach(cover => cover.toggleAttribute("failed", true));
      }
      return false;
    }
    this.unlockAll();
    return true;
  },

  // Re-evaluates who is away: called on every tab, space, window and app
  // focus change.
  evaluate() {
    if (!this.enabled) {
      return;
    }
    const front = this.frontKind();
    const now = Date.now();
    for (const kind of KINDS) {
      if (!this.isOn(kind) || locked.has(kind)) {
        awaySince.delete(kind);
        continue;
      }
      if (front == kind || !this.hasOpen(kind)) {
        awaySince.delete(kind);
        continue;
      }
      if (!awaySince.has(kind)) {
        awaySince.set(kind, now);
      }
      if (now - awaySince.get(kind) >= this.afterSeconds * 1000) {
        this.lock(kind);
      }
    }
    this.scheduleTimer();
    // Landing on a locked surface asks at once (d6), once per landing.
    if (front && locked.has(front)) {
      const win = Services.focus.activeWindow;
      const landing = `${front}:${win?.gBrowser?.selectedTab?.linkedPanel ?? ""}`;
      if (declinedFront != landing) {
        this.promptOnLanding(win, landing);
      }
    } else {
      declinedFront = null;
    }
  },

  async promptOnLanding(win, landing) {
    if (this._prompting) {
      return;
    }
    this._prompting = true;
    try {
      // Paint the cover first, so the system sheet never sits over the page.
      await new Promise(resolve => win.requestAnimationFrame(() => resolve()));
      if (!await this.unlock(win)) {
        declinedFront = landing;
      }
    } finally {
      this._prompting = false;
    }
  },

  scheduleTimer() {
    if (timer) {
      timer.cancel();
      timer = null;
    }
    if (!awaySince.size) {
      return;
    }
    const due = Math.min(...[...awaySince.values()].map(at => at + this.afterSeconds * 1000));
    timer = Cc["@mozilla.org/timer;1"].createInstance(Ci.nsITimer);
    timer.initWithCallback(() => {
      timer = null;
      this.evaluate();
    }, Math.max(50, due - Date.now()), Ci.nsITimer.TYPE_ONE_SHOT);
  },

  // --- the cover and masks -----------------------------------------------

  renderAll() {
    for (const win of this.browserWindows()) {
      this.render(win);
    }
  },

  render(win) {
    if (win.closed || !win.gBrowser) {
      return;
    }
    const doc = win.document;
    const root = doc.documentElement;
    const isPrivateWin = this.isPrivateWindow(win);
    const windowLocked = isPrivateWin && locked.has("windows");
    root.toggleAttribute("whimsy-private-window-locked", windowLocked);

    // Tab rows: "Private tab" with a lock; the Private Space collapses to
    // one "N private tabs" row.
    const scratchTabs = [];
    for (const tab of win.gBrowser.tabs) {
      const kind = this.kindOfTab(win, tab);
      const isLocked = !!kind && locked.has(kind);
      const was = tab.hasAttribute(LOCKED_ATTR);
      tab.toggleAttribute(LOCKED_ATTR, isLocked);
      tab.removeAttribute("whimsy-private-collapsed");
      if (kind == "space" && isLocked) {
        scratchTabs.push(tab);
      }
      if (was != isLocked) {
        // setTabTitle is wrapped (installWindow) to read "Private tab".
        try {
          win.gBrowser.setTabTitle(tab);
        } catch (e) {}
      }
    }
    if (scratchTabs.length) {
      const [first, ...rest] = scratchTabs;
      const label = lazy.l10n.formatValueSync("whimsy-private-lock-space-row", { count: scratchTabs.length });
      win.gBrowser._setTabLabel(first, label);
      for (const tab of rest) {
        tab.toggleAttribute("whimsy-private-collapsed", true);
      }
    }
    // The Private Space's switcher icon gets the lock badge.
    const scratch = lazy.WhimsyPrivate.getScratch?.(win);
    if (scratch) {
      doc.querySelector(`#zen-workspaces-button toolbarbutton[zen-workspace-id="${scratch.uuid}"]`)
        ?.toggleAttribute("whimsy-private-space-locked", locked.has("space"));
    }

    const selected = win.gBrowser.selectedTab;
    const selectedKind = this.kindOfTab(win, selected);
    const coverKind = windowLocked ? "windows" : selectedKind && locked.has(selectedKind) ? selectedKind : null;
    root.toggleAttribute("whimsy-private-selected-locked", !!coverKind);
    this.syncUrlbar(win, !!coverKind);
    if (coverKind) {
      this.showCover(win, coverKind);
    } else {
      for (const kind of KINDS) {
        this.hideCover(win, kind);
      }
      // A locked space (Lock Space, d14) shares the cover.
      if (lazy.WhimsySpaceLock.isCovered(win.gZenWorkspaces?.activeWorkspace)) {
        lazy.WhimsySpaceLock.renderCover(win);
      }
    }
    try {
      win.gBrowser.updateTitlebar();
    } catch (e) {}
  },

  // The address bar reads "Locked" and can't be edited (CSS draws the word
  // over the hidden address, from --whimsy-lock-urlbar-text).
  syncUrlbar(win, isLocked) {
    const urlbar = win.gURLBar;
    if (!urlbar) {
      return;
    }
    if (isLocked && !urlbar._whimsyLockedReadOnly) {
      urlbar._whimsyLockedReadOnly = { readOnly: urlbar.readOnly };
      urlbar.readOnly = true;
      win.document.documentElement.style.setProperty("--whimsy-lock-urlbar-text",
        JSON.stringify(lazy.l10n.formatValueSync("whimsy-private-lock-urlbar")));
    } else if (!isLocked && urlbar._whimsyLockedReadOnly) {
      urlbar.readOnly = urlbar._whimsyLockedReadOnly.readOnly;
      delete urlbar._whimsyLockedReadOnly;
    }
  },

  /**
   * The shared lock cover (WhimsyLockCover in the spec): an opaque layer in
   * the space's colours with a lock tile, a title, a line and Unlock. Over
   * the page area, or the whole window for a private window. Also used by
   * Lock Space (d14) through showCoverFor().
   */
  showCover(win, kind) {
    const others = Math.max(0, this.tabsOfKind(kind).length - 1);
    const count = this.tabsOfKind(kind).length;
    const text = {
      tabs: ["whimsy-private-lock-tab-title", others ? "whimsy-private-lock-tab-others" : "whimsy-private-lock-tab-alone", { others }],
      space: ["whimsy-private-lock-space-title", "whimsy-private-lock-space-detail", { count }],
      windows: ["whimsy-private-lock-window-title", "whimsy-private-lock-window-detail", { count }],
    }[kind];
    this.showCoverFor(win, {
      kind,
      whole: kind == "windows",
      titleL10nId: text[0],
      detailL10nId: text[1],
      args: text[2],
      onUnlock: () => this.unlock(win),
    });
  },

  showCoverFor(win, { kind, whole = false, titleL10nId, detailL10nId, args, onUnlock }) {
    const doc = win.document;
    const host = whole ? doc.documentElement : doc.getElementById("tabbrowser-tabbox");
    if (!host) {
      return null;
    }
    let cover = doc.querySelector(`.${COVER_CLASS}`);
    if (cover && cover.parentNode != host) {
      cover.remove();
      cover = null;
    }
    if (!cover) {
      cover = doc.createXULElement("vbox");
      cover.className = COVER_CLASS;
      cover.setAttribute("align", "center");
      cover.setAttribute("pack", "center");
      cover.setAttribute("role", "dialog");
      const tile = doc.createXULElement("hbox");
      tile.className = "whimsy-lock-cover-tile";
      tile.setAttribute("align", "center");
      tile.setAttribute("pack", "center");
      const icon = doc.createXULElement("image");
      icon.setAttribute("src", "chrome://browser/skin/zen-icons/selectable/lock-closed.svg");
      tile.append(icon);
      const title = doc.createElementNS(HTML_NS, "h1");
      title.className = "whimsy-lock-cover-title";
      title.id = "whimsy-lock-cover-title";
      const detail = doc.createElementNS(HTML_NS, "p");
      detail.className = "whimsy-lock-cover-detail";
      const error = doc.createElementNS(HTML_NS, "p");
      error.className = "whimsy-lock-cover-error";
      error.setAttribute("role", "alert");
      doc.l10n.setAttributes(error, "whimsy-private-lock-failed");
      const button = doc.createXULElement("button");
      button.className = "footer-button primary whimsy-lock-cover-button";
      doc.l10n.setAttributes(button, "whimsy-private-lock-unlock");
      button.addEventListener("command", () => {
        cover.removeAttribute("failed");
        cover._onUnlock?.();
      });
      cover.addEventListener("keydown", event => {
        if (event.key == "Enter" && !event.defaultPrevented) {
          event.preventDefault();
          button.doCommand();
        }
      });
      cover.setAttribute("aria-labelledby", title.id);
      cover.append(tile, title, detail, error, button);
      host.append(cover);
    }
    cover.dataset.kind = kind;
    cover.toggleAttribute("whole", whole);
    cover._onUnlock = onUnlock;
    const [title, detail] = [cover.querySelector(".whimsy-lock-cover-title"), cover.querySelector(".whimsy-lock-cover-detail")];
    doc.l10n.setAttributes(title, titleL10nId, args);
    doc.l10n.setAttributes(detail, detailL10nId, args);
    this.paintCover(win, cover);
    return cover;
  },

  // The space's colours, never the page (d5).
  paintCover(win, cover) {
    const space = win.gZenWorkspaces?.getActiveWorkspace?.();
    const colors = (space?.theme?.gradientColors ?? []).map(c => Array.isArray(c?.c) ? `rgb(${c.c.slice(0, 3).join(" ")})` : null).filter(Boolean);
    cover.style.setProperty("--whimsy-lock-a", colors[0] ?? "var(--zen-primary-color, AccentColor)");
    cover.style.setProperty("--whimsy-lock-b", colors[1] ?? colors[0] ?? "var(--zen-primary-color, AccentColor)");
  },

  hideCover(win, kind = null) {
    for (const cover of win.document.querySelectorAll(`.${COVER_CLASS}`)) {
      if (!kind || cover.dataset.kind == kind) {
        cover.remove();
      }
    }
  },

  // --- the first-run question (d2) ----------------------------------------

  maybeAsk(win, kind) {
    if (!this.enabled || this.choice(kind) != -1 || !lazy.WhimsyAuth.available() ||
        Services.prefs.getIntPref(DISMISS_PREF(kind), 0) >= 2 ||
        lazy.WhimsySurface.isOpen(win, ASK_ID) || this._asked?.has(kind)) {
      return null;
    }
    (this._asked ??= new Set()).add(kind);
    const doc = win.document;
    const S = lazy.WhimsySurface;
    let answered = false;
    const parts = S.create(win, {
      id: ASK_ID,
      width: 360,
      footer: true,
      className: "whimsy-private-lock-ask",
      onHidden: () => {
        this._asked?.delete(kind);
        if (!answered) {
          Services.prefs.setIntPref(DISMISS_PREF(kind), Services.prefs.getIntPref(DISMISS_PREF(kind), 0) + 1);
        }
      },
      // Neither answer is the default: focus starts on the surface itself.
      initialFocus: () => parts.view,
    });
    parts.panel.dataset.kind = kind;
    parts.view.setAttribute("tabindex", "-1");
    const body = doc.createXULElement("hbox");
    body.className = "whimsy-private-lock-ask-body";
    const tile = S.tile(doc, { icon: "chrome://browser/skin/zen-icons/selectable/lock-closed.svg" });
    const text = doc.createXULElement("vbox");
    text.setAttribute("flex", "1");
    const heading = doc.createElementNS(HTML_NS, "h1");
    heading.className = "whimsy-surface-title";
    heading.id = `${ASK_ID}-title`;
    doc.l10n.setAttributes(heading, `whimsy-private-lock-ask-${kind}`);
    const line = doc.createElementNS(HTML_NS, "p");
    line.className = "whimsy-private-lock-ask-line";
    doc.l10n.setAttributes(line, "whimsy-private-lock-ask-line");
    text.append(heading, line);
    body.append(tile, text);
    parts.view.append(body);
    parts.panel.setAttribute("aria-labelledby", heading.id);
    const answer = on => {
      answered = true;
      Services.prefs.setIntPref(PREF(kind), on ? 1 : 0);
      Services.prefs.clearUserPref(DISMISS_PREF(kind));
      S.close(parts.panel);
      if (on) {
        win.gZenUIManager?.showToast?.("whimsy-private-lock-on-toast");
      }
    };
    const dont = S.footerButton(doc, { id: "whimsy-private-lock-dont", l10nId: "whimsy-private-lock-dont", onCommand: () => answer(false) });
    const yes = S.footerButton(doc, { id: "whimsy-private-lock-yes", l10nId: "whimsy-private-lock-yes", onCommand: () => answer(true) });
    parts.footer.append(dont, yes);
    S.finish(parts);
    S.open(win, parts.panel, { at: "page-top-center" });
    return parts;
  },

  // --- turning a switch off (d8) -----------------------------------------

  /** Settings and the commands go through this. */
  async setChoice(win, kind, on) {
    if (!on && locked.has(kind)) {
      const result = await lazy.WhimsyAuth.unlock(win, "whimsy-auth-reason-private-off");
      if (result == "cancel") {
        return false;
      }
      locked.delete(kind);
      this.renderAll();
    }
    Services.prefs.setIntPref(PREF(kind), on ? 1 : 0);
    Services.prefs.clearUserPref(DISMISS_PREF(kind));
    this.evaluate();
    return true;
  },

  // --- wiring ---------------------------------------------------------------

  initGlobal() {
    if (this._global) {
      return;
    }
    this._global = true;
    const onChange = () => this.evaluate();
    for (const topic of ["mac_app_activate", "xul-window-visible"]) {
      Services.obs.addObserver(onChange, topic);
    }
    // Mac sleep (d4): lock everything that's on, before the display sleeps.
    Services.obs.addObserver(() => this.lockNow(), "sleep_notification");
    // Whimsy starts sharing the screen or a window (d4).
    Services.obs.addObserver(() => {
      if (Services.prefs.getBoolPref(SHARING_PREF, false)) {
        return;
      }
      if (lazy.webrtcUI.sharingScreen || lazy.webrtcUI.sharingWindow) {
        this.lockNow();
      }
    }, "recording-device-events");
    Services.prefs.addObserver("whimsy.privateLock.", () => this.evaluate());
  },

  initWindow(win) {
    if (win._whimsyPrivateLock || !win.gBrowser) {
      return;
    }
    win._whimsyPrivateLock = true;
    this.initGlobal();
    this.wrapTitles(win);
    const onChange = () => {
      this.render(win);
      this.evaluate();
    };
    for (const type of ["TabSelect", "TabOpen", "TabClose"]) {
      win.gBrowser.tabContainer.addEventListener(type, onChange);
    }
    win.addEventListener("ZenWorkspaceChanged", onChange);
    win.addEventListener("ZenWorkspacesUIUpdate", onChange);
    // App and window focus: activate fires when Whimsy comes back too.
    win.addEventListener("activate", onChange);
    win.addEventListener("deactivate", () => win.setTimeout(() => this.evaluate(), 0));
    // The first time something private opens, ask (d2).
    const askFor = () => {
      const kind = this.kindOfTab(win, win.gBrowser.selectedTab);
      if (kind) {
        this.maybeAsk(win, kind);
      }
    };
    win.gBrowser.tabContainer.addEventListener("TabSelect", askFor);
    win.addEventListener("activate", askFor);
    win.setTimeout(askFor, 0);
    this.registerCommands(win);
    const popup = win.document.getElementById("windowPopup");
    popup?.addEventListener("popupshowing", () => this.addWindowMenuItem(win.document));
    this.render(win);
  },

  // Locked tabs read "Private tab"; a locked window's title is generic.
  wrapTitles(win) {
    const gBrowser = win.gBrowser;
    const self = this;
    const setTabTitle = gBrowser.setTabTitle;
    if (typeof setTabTitle == "function" && !setTabTitle._whimsyLock) {
      gBrowser.setTabTitle = function (tab) {
        if (tab?.hasAttribute?.(LOCKED_ATTR)) {
          return this._setTabLabel(tab, lazy.l10n.formatValueSync("whimsy-private-lock-tab-label"));
        }
        return setTabTitle.apply(this, arguments);
      };
      gBrowser.setTabTitle._whimsyLock = true;
    }
    const getTitle = gBrowser.getWindowTitleForBrowser;
    if (typeof getTitle == "function" && !getTitle._whimsyLock) {
      gBrowser.getWindowTitleForBrowser = function (browser) {
        const tab = this.getTabForBrowser(browser);
        if (win.document.documentElement.hasAttribute("whimsy-private-window-locked") ||
            (tab && self.isTabCovered(win, tab))) {
          return lazy.l10n.formatValueSync(self.isPrivateWindow(win) ? "whimsy-private-lock-window-name" : "whimsy-private-lock-tab-label");
        }
        return getTitle.apply(this, arguments);
      };
      gBrowser.getWindowTitleForBrowser._whimsyLock = true;
    }
  },

  registerCommands(win) {
    const icon = "chrome://browser/skin/zen-icons/selectable/lock-closed.svg";
    const anyOnAndOpen = () => KINDS.some(kind => this.isOn(kind) && !locked.has(kind) && this.hasOpen(kind));
    lazy.WhimsyCommands.register(win, {
      id: "cmd_whimsyLockPrivateNow",
      l10nId: "whimsy-action-lock-private-now",
      run: () => this.lockNow(),
      icon,
      isAvailable: () => this.enabled && anyOnAndOpen(),
    });
    lazy.WhimsyCommands.register(win, {
      id: "cmd_whimsyUnlockPrivate",
      l10nId: "whimsy-action-unlock-private",
      run: w => this.unlock(w),
      icon,
      isAvailable: () => this.enabled && locked.size > 0,
    });
    for (const kind of KINDS) {
      lazy.WhimsyCommands.register(win, {
        id: `cmd_whimsyTogglePrivateLock_${kind}`,
        l10nId: `whimsy-action-private-lock-${kind}-toggle`,
        run: w => this.setChoice(w, kind, !this.isOn(kind)),
        icon,
        variants: [
          { l10nId: `whimsy-action-private-lock-${kind}-on`, isAvailable: () => this.enabled && !this.isOn(kind) },
          { l10nId: `whimsy-action-private-lock-${kind}-off`, isAvailable: () => this.isOn(kind) },
        ],
      });
    }
  },

  addWindowMenuItem(doc) {
    let item = doc.getElementById("menu_whimsyLockPrivate");
    if (!item) {
      item = doc.createXULElement("menuitem");
      item.id = "menu_whimsyLockPrivate";
      item.setAttribute("data-l10n-id", "whimsy-menu-lock-private");
      item.setAttribute("command", "cmd_whimsyLockPrivateNow");
      doc.getElementById("sep-window-list")?.before(item);
    }
    const anyOnAndOpen = KINDS.some(kind => this.isOn(kind) && !locked.has(kind) && this.hasOpen(kind));
    item.hidden = !this.enabled;
    item.toggleAttribute("disabled", !anyOnAndOpen);
  },
};
