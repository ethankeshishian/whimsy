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
// W13-C2 (the user): leaving a private tab, the Private Space or a locked
// space locks at once only with this on. Off (the default), switching tabs
// or spaces inside Whimsy never locks; the lock comes when Whimsy isn't in
// front for "Lock after", or the Mac sleeps, locks or shares its screen.
export const ON_LEAVE_PREF = "whimsy.privateLock.onLeave";
const SHARING_PREF = "whimsy.privateLock.stayUnlockedWhileSharing";
const FEATURE_PREF = "whimsy.feature.private-lock";
const ASK_ID = "whimsyPrivateLockAsk";
const LOCKED_ATTR = "whimsy-private-locked";
const COVER_CLASS = "whimsy-lock-cover";
// The tab menu items that still work on a covered tab (d10: closing).
const CLOSE_ITEM = /close/i;

// W14-14: wraps obj[name] so `guard(call, args)` runs before it, however
// many wrappers other modules add later: they become the inner function
// (the property's setter), and reading it always gives the guard around
// the latest one. A Proxy, so their marker properties still read through.
function guardOutermost(obj, name, guard) {
  const current = Object.getOwnPropertyDescriptor(obj, name);
  if (current?.get?._whimsyLockGuard) {
    return;
  }
  let inner = obj[name];
  if (typeof inner != "function") {
    return;
  }
  const proxies = new WeakMap();
  const get = function () {
    let proxy = proxies.get(inner);
    if (!proxy) {
      proxy = new Proxy(inner, {
        apply(target, thisArg, args) {
          const call = (...override) => Reflect.apply(target, thisArg, override.length ? override : args);
          return guard(call, args);
        },
      });
      proxies.set(inner, proxy);
    }
    return proxy;
  };
  get._whimsyLockGuard = true;
  Object.defineProperty(obj, name, {
    configurable: true,
    enumerable: true,
    get,
    set(value) {
      inner = value;
    },
  });
}

// Module state (one app): which kinds are locked, and since when each kind
// has been out of sight.
const locked = new Set();
const awaySince = new Map();
// W14-14: the pages a lock covered, by the browser's permanentKey (it
// follows the page through adoptTab and tear-off). Covered stays covered
// wherever the tab goes until you unlock, so a route out of its place that
// no guard knows about still shows nothing.
let lockedKeys = new WeakSet();
let anyLockedKeys = false;
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

  get lockOnLeave() {
    return Services.prefs.getBoolPref(ON_LEAVE_PREF, false);
  },

  isLocked(kind) {
    return locked.has(kind);
  },

  get anyLocked() {
    return locked.size > 0 || anyLockedKeys;
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

  // W13-C2: every tab in the window, in every space. Zen's gBrowser.tabs
  // lists only the active space's tabs (tabs.mjs allTabs reads
  // gZenWorkspaces.tabboxChildren), so after a space switch the Private
  // Space, or a private tab in the space you left, looked closed: lock()
  // refused to lock it and evaluate() dropped its lock.
  allTabs(win) {
    const spaces = win.gZenWorkspaces;
    return spaces?.workspaceEnabled ? spaces.allStoredTabs : win.gBrowser.tabs;
  },

  tabsOfKind(kind) {
    const out = [];
    for (const win of this.browserWindows()) {
      for (const tab of this.allTabs(win)) {
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
    if (!kind) {
      return false;
    }
    if (locked.has(kind)) {
      return true;
    }
    const key = tab.linkedBrowser?.permanentKey;
    return anyLockedKeys && !!key && lockedKeys.has(key);
  },

  // Covered by the private lock or by Lock Space: nothing of the page
  // (thumbnail, favicon, address) may show anywhere.
  isTabHidden(win, tab) {
    return this.isTabCovered(win, tab) || !!lazy.WhimsySpaceLock.coveringSpace(tab);
  },

  // --- W14-14: a covered tab stays where it is ----------------------------
  //
  // Moving a tab changed what covered it (the lock follows where the tab
  // is), so a tab moved out of the Private Space or a locked space showed
  // its page. Every way out goes through one of these: the async flows ask
  // to unlock first (ensureTabsUnlocked), the synchronous choke points
  // (guardMoves) refuse and ask, a drag of a covered tab never starts, and
  // the tab menu offers only Close while a covered tab is in it.

  hiddenAmong(tabs) {
    return (tabs ?? []).filter(tab => tab && !tab.closing && this.isTabHidden(tab.documentGlobal, tab));
  },

  /** Asks to unlock what covers any of `tabs`. False when cancelled. */
  async ensureTabsUnlocked(win, tabs) {
    const hidden = this.hiddenAmong(tabs);
    if (!hidden.length) {
      return true;
    }
    if (hidden.some(tab => this.isTabCovered(tab.documentGlobal, tab)) && !(await this.unlock(win))) {
      return false;
    }
    const spaces = new Set(hidden.map(tab => lazy.WhimsySpaceLock.coveringSpace(tab)).filter(Boolean));
    for (const uuid of spaces) {
      const space = lazy.WhimsySpaceLock.space(uuid);
      if (space && !(await lazy.WhimsySpaceLock.ensureUnlocked(win, space))) {
        return false;
      }
    }
    return this.hiddenAmong(tabs).length == 0;
  },

  // For a synchronous way out: true (and the unlock prompt) when one of
  // `tabs` is covered. Unlocked, the person does it again.
  refuseMove(win, tabs) {
    if (!this.hiddenAmong(tabs).length) {
      return false;
    }
    if (!this._askingToMove) {
      this._askingToMove = true;
      this.ensureTabsUnlocked(win, tabs)
        .catch(e => console.error("Whimsy: private lock", e))
        .finally(() => {
          this._askingToMove = false;
        });
    }
    return true;
  },

  // The tab and, with it, every tab that moves along (selected, a folder).
  movingWith(win, tab) {
    if (!tab) {
      return [];
    }
    if (win.gBrowser?.isTab?.(tab)) {
      return tab.multiselected ? win.gBrowser.selectedTabs : [tab];
    }
    const group = tab.group ?? tab.closest?.("tab-group");
    return group?.tabs ? [...group.tabs] : [];
  },

  guardMoves(win) {
    const { gBrowser } = win;
    const self = this;
    guardOutermost(gBrowser, "replaceTabWithWindow", (call, [tab]) =>
      self.refuseMove(win, self.movingWith(win, tab)) ? null : call());
    guardOutermost(gBrowser, "replaceTabsWithWindow", (call, [tab]) =>
      self.refuseMove(win, self.movingWith(win, tab)) ? null : call());
    // From another window: the tab is judged where it is now.
    guardOutermost(gBrowser, "adoptTab", (call, [tab]) =>
      self.refuseMove(tab?.documentGlobal ?? win, [tab]) ? null : call());
    // Zen's window sync swaps a tab's page between its copies in two
    // windows (zenCloseOther false): the same tab, not a move.
    guardOutermost(gBrowser, "swapBrowsersAndCloseOther", (call, [, other, zenCloseOther]) =>
      zenCloseOther !== false && self.refuseMove(other?.documentGlobal ?? win, [other]) ? false : call());
    if (win.gZenWorkspaces) {
      guardOutermost(win.gZenWorkspaces, "moveTabsToWorkspace", (call, [tabs, spaceId, ...rest]) => {
        // Tabs, folders or splits.
        const list = (Array.isArray(tabs) ? tabs : [tabs]).filter(Boolean);
        const tabsOf = item => (gBrowser.isTab?.(item) ? [item] : [...(item.tabs ?? [])]);
        const leaving = list.flatMap(tabsOf).filter(tab => tab.getAttribute("zen-workspace-id") != spaceId);
        if (!self.refuseMove(win, leaving)) {
          return call();
        }
        const hidden = new Set(self.hiddenAmong(leaving));
        const rest2 = list.filter(item => !tabsOf(item).some(tab => hidden.has(tab)));
        return rest2.length ? call(rest2, spaceId, ...rest) : false;
      });
    }
    if (win.gZenFolders) {
      guardOutermost(win.gZenFolders, "changeFolderToSpace", (call, [folder]) =>
        self.refuseMove(win, [...(folder?.tabs ?? [])]) ? undefined : call());
    }
    if (win.gZenViewSplitter) {
      guardOutermost(win.gZenViewSplitter, "splitTabs", (call, [tabs]) =>
        self.refuseMove(win, tabs) ? undefined : call());
    }
    // A covered tab (or a folder holding one) never starts a drag: Zen's
    // drop on another space sets its space directly, and a drop outside
    // the window tears it off.
    win.addEventListener("dragstart", event => {
      const item = event.target?.closest?.("tab, .tab-group-label, tab-group");
      if (item && this.refuseMove(win, this.movingWith(win, item))) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    }, true);
    // After every other popupshowing handler (they run on the popup; this
    // one bubbles to the window last): a covered tab's menu offers only
    // closing. Items are hidden, not disabled (many follow a <command>'s
    // state), and shown again once the menu closes.
    // Some items show themselves later (tab notes after an async lookup), so
    // while it's open anything that shows is tucked away again.
    const tucked = new Set();
    let watcher = null;
    const tuck = menu => {
      for (const item of menu.querySelectorAll(":scope > menuitem, :scope > menu, :scope > menuseparator")) {
        if (!item.hidden && !(item.localName != "menuseparator" && CLOSE_ITEM.test(item.id))) {
          item.hidden = true;
          tucked.add(item);
        }
      }
    };
    win.addEventListener("popupshowing", event => {
      const menu = event.target;
      if (menu?.id != "tabContextMenu") {
        return;
      }
      const context = win.TabContextMenu?.contextTab;
      if (!context || !this.hiddenAmong(this.movingWith(win, context)).length) {
        return;
      }
      tuck(menu);
      watcher?.disconnect();
      watcher = new win.MutationObserver(() => tuck(menu));
      watcher.observe(menu, { childList: true, subtree: true, attributes: true, attributeFilter: ["hidden"] });
    });
    win.addEventListener("popuphidden", event => {
      if (event.target?.id == "tabContextMenu") {
        watcher?.disconnect();
        watcher = null;
        for (const item of tucked) {
          item.hidden = false;
        }
        tucked.clear();
      }
    });
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
    if (!locked.size && !anyLockedKeys) {
      return;
    }
    locked.clear();
    lockedKeys = new WeakSet();
    anyLockedKeys = false;
    awaySince.clear();
    declinedFront = null;
    this.renderAll();
    Services.obs.notifyObservers(null, "whimsy-private-lock-changed", "");
  },

  /** Asks for Touch ID or the password, then unlocks everything. */
  async unlock(win) {
    if (!locked.size && !anyLockedKeys) {
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
    // Once the last of a kind closes there's nothing left to hide (its
    // private data is gone): a new one starts unlocked.
    let emptied = false;
    for (const kind of [...locked]) {
      if (!this.hasOpen(kind)) {
        locked.delete(kind);
        emptied = true;
      }
    }
    if (emptied) {
      this.renderAll();
    }
    // Whimsy in front: only leaving with "Lock as Soon as I Leave" on
    // locks, at once. Whimsy not in front (another app, the Mac locked):
    // "Lock after" counts from then.
    const appActive = !!Services.focus.activeWindow;
    for (const kind of KINDS) {
      if (!this.isOn(kind) || locked.has(kind) || !this.hasOpen(kind)) {
        awaySince.delete(kind);
        continue;
      }
      if (appActive && (front == kind || !this.lockOnLeave)) {
        awaySince.delete(kind);
        continue;
      }
      if (appActive) {
        this.lock(kind);
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
    const frontWin = Services.focus.activeWindow;
    if (front && (locked.has(front) || this.isTabCovered(frontWin, frontWin?.gBrowser?.selectedTab))) {
      const win = frontWin;
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
    for (const tab of this.allTabs(win)) {
      const kind = this.kindOfTab(win, tab);
      if (kind && locked.has(kind) && tab.linkedBrowser?.permanentKey) {
        lockedKeys.add(tab.linkedBrowser.permanentKey);
        anyLockedKeys = true;
      }
      const isLocked = this.isTabCovered(win, tab);
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
    // W14-14: a split shows every tab in it, not just the selected one.
    const shown = selected?.group?.hasAttribute?.("split-view-group") ? [...selected.group.tabs] : [selected];
    const coveredShown = shown.find(tab => this.isTabCovered(win, tab));
    const coveredKind = coveredShown ? this.kindOfTab(win, coveredShown) : null;
    const coverKind = windowLocked ? "windows" : coveredKind ? (locked.has(coveredKind) ? coveredKind : "tabs") : null;
    // A space behind Lock Space's cover hides its address too.
    const hidden = !!coverKind || lazy.WhimsySpaceLock.isCovered(win.gZenWorkspaces?.activeWorkspace) ||
      shown.some(tab => !!lazy.WhimsySpaceLock.coveringSpace(tab));
    root.toggleAttribute("whimsy-private-selected-locked", hidden);
    this.syncUrlbar(win, hidden);
    if (coverKind) {
      this.showCover(win, coverKind);
    } else {
      for (const kind of KINDS) {
        this.hideCover(win, kind);
      }
    }
    // A locked space (Lock Space, d14) shares the cover; it never replaces
    // a private one (hasPrivateCover).
    lazy.WhimsySpaceLock.renderCover(win);
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

  hasPrivateCover(win) {
    return KINDS.includes(win.document.querySelector(`.${COVER_CLASS}`)?.dataset.kind);
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
    this.guardMoves(win);
    this.wrapTitles(win);
    this.guardCommandBar(win);
    const onChange = () => {
      this.render(win);
      this.evaluate();
    };
    win.gBrowser.tabContainer.addEventListener("TabSelect", onChange);
    // A tab opened in front is selected right after TabOpen: decide once
    // that has happened, or a new private tab would lock as it opens. A
    // closing tab is still in the list during TabClose.
    for (const type of ["TabOpen", "TabClose"]) {
      win.gBrowser.tabContainer.addEventListener(type, () => win.setTimeout(onChange, 0));
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
    this.guardPreviews(win);
    this.registerCommands(win);
    const popup = win.document.getElementById("windowPopup");
    popup?.addEventListener("popupshowing", () => this.addWindowMenuItem(win.document));
    this.render(win);
  },

  // W13-C2: side doors that show a page without selecting it. Ctrl+Tab
  // (MRU, browser.ctrlTab.sortByRecentlyUsed) captures a live thumbnail
  // and shows the favicon; the tab hover preview shows the address.
  guardPreviews(win) {
    const previews = win.tabPreviews;
    if (previews?.get && !previews.get._whimsyLock) {
      const get = previews.get;
      previews.get = function (tab) {
        if (WhimsyPrivateLock.isTabHidden(win, tab)) {
          return Promise.resolve(null);
        }
        return get.apply(this, arguments);
      };
      previews.get._whimsyLock = true;
    }
    const ctrlTab = win.ctrlTab;
    if (ctrlTab?.updatePreview && !ctrlTab.updatePreview._whimsyLock) {
      const updatePreview = ctrlTab.updatePreview;
      ctrlTab.updatePreview = function (preview, tab) {
        const result = updatePreview.apply(this, arguments);
        if (tab && preview?._label && WhimsyPrivateLock.isTabHidden(win, tab)) {
          const label = tab.hasAttribute(LOCKED_ATTR) ? tab.label : lazy.l10n.formatValueSync("whimsy-private-lock-urlbar");
          preview._label.setAttribute("value", label);
          preview.setAttribute("tooltiptext", label);
          preview._favicon?.removeAttribute("src");
        }
        return result;
      };
      ctrlTab.updatePreview._whimsyLock = true;
    }
    win.addEventListener("TabHoverStart", event => {
      if (this.isTabHidden(win, event.target)) {
        event.stopImmediatePropagation();
      }
    }, true);
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
        if (tab && self.isTabHidden(win, tab)) {
          return lazy.l10n.formatValueSync("whimsy-private-lock-urlbar");
        }
        return getTitle.apply(this, arguments);
      };
      gBrowser.getWindowTitleForBrowser._whimsyLock = true;
    }
  },

  // W13-C2 follow-up: the command bar never lists a locked tab (a private
  // tab behind the lock, or a tab in a space behind Lock Space). Its
  // "Switch to Tab" row would show the page's title and address. Only rows
  // are dropped, before the view shows them; nothing is reordered.
  guardCommandBar(win) {
    const view = win.gURLBar?.view;
    if (!view || view._whimsyLockRows) {
      return;
    }
    view._whimsyLockRows = true;
    const onQueryResults = view.onQueryResults;
    view.onQueryResults = function (queryContext) {
      try {
        WhimsyPrivateLock.dropLockedRows(queryContext);
      } catch (e) {
        console.error("Whimsy: private lock rows", e);
      }
      return onQueryResults.apply(this, arguments);
    };
  },

  // The pages of every tab the lock hides, in any window or space.
  hiddenPages() {
    const pages = new Set();
    for (const win of this.browserWindows()) {
      for (const tab of this.allTabs(win)) {
        if (this.isTabHidden(win, tab)) {
          const spec = tab.linkedBrowser?.currentURI?.spec;
          if (spec) {
            pages.add(spec);
          }
        }
      }
    }
    return pages;
  },

  dropLockedRows(queryContext) {
    const results = queryContext?.results;
    if (!results?.length || (!this.anyLocked && !lazy.WhimsySpaceLock.anyCovered?.())) {
      return;
    }
    const pages = this.hiddenPages();
    if (!pages.size) {
      return;
    }
    const isTabRow = r => r.type == 1 || r.source == 4 || r.payload?.action?.type == "switchtab";
    for (let i = results.length - 1; i >= 0; i--) {
      if (!results[i].heuristic && isTabRow(results[i]) && pages.has(results[i].payload?.url)) {
        results.splice(i, 1);
      }
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
    lazy.WhimsyCommands.register(win, {
      id: "cmd_whimsyTogglePrivateLockOnLeave",
      l10nId: "whimsy-action-private-lock-on-leave-toggle",
      run: () => Services.prefs.setBoolPref(ON_LEAVE_PREF, !this.lockOnLeave),
      icon,
      variants: [
        { l10nId: "whimsy-action-private-lock-on-leave-on", isAvailable: () => this.enabled && !this.lockOnLeave },
        { l10nId: "whimsy-action-private-lock-on-leave-off", isAvailable: () => this.enabled && this.lockOnLeave },
      ],
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
