/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// wave6/search: Instant result and the Search Deck (research pick #3).
//
// Instant result (Arc Max "Instant Links"): in the command bar, Shift+Enter
// on a search opens the top result instead of the results page. Firefox
// gives Shift+Enter a meaning too (open in a new window); that stays for
// everything Arc doesn't override: URLs, history/bookmark/tab rows, Zen's
// commands, and private tabs.
//
// Search Deck (Cake's swipe-through results): with the deck on, Shift+Enter
// opens the results page as Enter would, with result 1 in a Glance on top.
// The next/previous space keys (Cmd+Opt+→/←, Zen's defaults) and a
// two-finger swipe over the card flip to the next/previous result; deck dots
// show where you are. Cmd+Enter (or Zen's own Cmd+O) promotes the card to a
// real tab; Esc lands on the results page. Cards you flip past never touch
// global history, session history or the recently closed list. Swipes are
// only taken over the card itself, so Zen's space swipe (sidebar and
// Library) is never touched; over the card they replace back/forward,
// which a card has no use for. "Flip Through Results" in the command bar
// starts a deck from any results page.
//
// Results come from the results page loaded again in WhimsyAIReader's
// hidden, sandboxed browser (no forms, popups, downloads or top-level
// navigation, no history), read by WhimsySearchDeckChild.

import { clearTimeout, setTimeout } from "resource://gre/modules/Timer.sys.mjs";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  PlacesUtils: "resource://gre/modules/PlacesUtils.sys.mjs",
  PrivateBrowsingUtils: "resource://gre/modules/PrivateBrowsingUtils.sys.mjs",
  SessionStore: "resource:///modules/sessionstore/SessionStore.sys.mjs",
  WhimsyAIReader: "resource:///modules/whimsy/WhimsyAIReader.sys.mjs",
  WhimsyShortcuts: "resource:///modules/whimsy/WhimsyShortcuts.sys.mjs",
});

const INSTANT_PREF = "whimsy.feature.instant-result";
const DECK_PREF = "whimsy.feature.search-deck";
export const SEARCH_DECK_GROUP = "whimsy-search-deck";
const SHEET = "chrome://browser/content/whimsy/whimsy-search-deck.css";
const READ_TIMEOUT_MS = 10000;
const MAX_RESULTS = 10;
const NEXT_COMMAND = "cmd_zenWorkspaceForward";
const PREV_COMMAND = "cmd_zenWorkspaceBackward";
const PROMOTE_COMMAND = "cmd_whimsySearchDeckPromote";
const PROMOTE_KEY = "whimsy-search-deck-promote-key";
const SWIPE_EVENTS = [
  "MozSwipeGestureMayStart",
  "MozSwipeGestureStart",
  "MozSwipeGestureUpdate",
  "MozSwipeGestureEnd",
  "MozSwipeGesture",
];

// The parent side has nothing to do: WhimsySearchDeck asks the child.
export class WhimsySearchDeckParent extends JSWindowActorParent {}

// window -> the open deck { parentTab, tab, results, index, userContextId, ... }
const decks = new WeakMap();
const installed = new WeakSet();
const sheets = new WeakSet();

function enabled(pref) {
  return Services.prefs.getBoolPref(pref, true);
}

function reducedMotion(win) {
  return win.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function siteOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

export const WhimsySearchDeck = {
  get instantEnabled() {
    return enabled(INSTANT_PREF);
  },

  get deckEnabled() {
    return enabled(DECK_PREF);
  },

  deckFor(win) {
    return decks.get(win) ?? null;
  },

  initWindow(win) {
    if (installed.has(win) || !win.gURLBar) {
      return;
    }
    installed.add(win);
    // Capture on the window runs before the urlbar's own Enter handling.
    win.addEventListener("keydown", event => this.onKeyDown(win, event), true);
    // The next/previous space commands flip cards while the deck is showing
    // (so a customized space key flips too), and only then.
    win.addEventListener("command", event => this.onCommand(win, event), true);
    for (const type of SWIPE_EVENTS) {
      win.addEventListener(type, event => this.onSwipe(win, event), true);
    }
    lazy.WhimsyShortcuts.addCommand(win, {
      id: PROMOTE_COMMAND,
      run: w => this.promote(w),
      key: { id: PROMOTE_KEY, keycode: "VK_RETURN", modifiers: "accel" },
    });
    this.syncPromoteKey(win);
    lazy.WhimsyShortcuts.addActions([
      {
        l10nId: "whimsy-action-search-deck",
        command: w => this.startFromPage(w).catch(e => console.error("Whimsy: search deck", e)),
        icon: "chrome://browser/skin/zen-icons/search-glass.svg",
        isAvailable: w => this.deckEnabled && !!this.searchPageOf(w.gBrowser.selectedBrowser),
      },
    ]);
  },

  // ---- Instant result ----------------------------------------------------

  /**
   * What Shift+Enter should open instantly, or null to leave the key to
   * Firefox: only searches (the heuristic search row, a search suggestion,
   * or text Firefox would search for), never URLs or other rows.
   *
   * @returns {{ query: string, engine: object, url: string } | null}
   */
  instantQuery(win) {
    const urlbar = win.gURLBar;
    if (!this.instantEnabled || !urlbar) {
      return null;
    }
    if (this.isPrivate(win)) {
      return null;
    }
    const value = urlbar.value.trim();
    if (!value) {
      return null;
    }
    const mode = urlbar.searchMode;
    // Zen's commands, history, tabs, bookmarks...: not a web search.
    if (mode && !mode.engineName) {
      return null;
    }
    const { UrlbarShared } = ChromeUtils.importESModule("chrome://browser/content/urlbar/UrlbarShared.mjs");
    const result = urlbar.view?.isOpen ? urlbar.view.selectedResult : urlbar._resultForCurrentValue;
    let query;
    let engineName;
    if (result) {
      if (result.type != UrlbarShared.RESULT_TYPE.SEARCH || !result.payload?.engine) {
        return null;
      }
      query = result.payload.suggestion || result.payload.query;
      engineName = result.payload.engine;
    } else {
      // Results not in yet: decide the way Enter would.
      let info;
      try {
        info = Services.uriFixup.getFixupURIInfo(value, Ci.nsIURIFixup.FIXUP_FLAG_ALLOW_KEYWORD_LOOKUP);
      } catch {
        return null;
      }
      if (!info.keywordProviderName) {
        return null;
      }
      query = info.keywordAsSent || value;
      engineName = info.keywordProviderName;
    }
    if (mode?.engineName) {
      engineName = mode.engineName;
    }
    query = String(query ?? "").trim();
    // A bang ("!w cats") goes where the bang says, not to a top result.
    if (/(^|\s)![^\s!]/.test(query) || /(^|\s)![^\s!]/.test(value)) {
      return null;
    }
    const engine = engineName && Services.search.getEngineByName(engineName);
    if (!query || !engine) {
      return null;
    }
    const submission = engine.getSubmission(query);
    // A POST-only engine has no results page we can load again.
    if (!submission || submission.postData || !/^https?:/.test(submission.uri.spec)) {
      return null;
    }
    return { query, engine, url: submission.uri.spec };
  },

  isPrivate(win) {
    return (
      lazy.PrivateBrowsingUtils.isWindowPrivate(win) ||
      lazy.PrivateBrowsingUtils.isBrowserPrivate(win.gBrowser?.selectedBrowser)
    );
  },

  onKeyDown(win, event) {
    if (
      event.key != "Enter" ||
      !event.shiftKey ||
      event.altKey ||
      event.metaKey ||
      event.ctrlKey ||
      event.isComposing ||
      event.repeat ||
      event.target != win.gURLBar?.inputField
    ) {
      return;
    }
    if (win.gURLBar.view?.isResultMenuOpen?.()) {
      return;
    }
    const target = this.instantQuery(win);
    if (!target) {
      return;
    }
    event.preventDefault();
    event.stopImmediatePropagation();
    this.instant(win, target).catch(e => console.error("Whimsy: instant result", e));
  },

  // Where plain Enter would open, without its modifiers.
  whereForEnter(win) {
    const { gBrowser, gURLBar } = win;
    let where =
      gURLBar.hasAttribute("zen-newtab") || Services.prefs.getBoolPref("browser.urlbar.openintab", false)
        ? "tab"
        : "current";
    if (where == "tab" && gBrowser.selectedTab.isEmpty) {
      where = "current";
    }
    return where;
  },

  closeUrlbar(win) {
    const { gURLBar, gBrowser } = win;
    try {
      gURLBar.view?.close();
      gURLBar.handleRevert();
    } catch {}
    gBrowser.selectedBrowser.focus();
  },

  async instant(win, { url: serpUrl }) {
    const { gBrowser } = win;
    const where = this.whereForEnter(win);
    const userContextId = gBrowser.selectedTab.userContextId || 0;
    this.closeUrlbar(win);
    const reading = this.readResults(serpUrl, { userContextId });

    if (this.deckEnabled && win.gZenGlanceManager) {
      // The results page opens as Enter would; result 1 lands on top of it.
      win.openTrustedLinkIn(serpUrl, where, { userContextId });
      const parentTab = gBrowser.selectedTab;
      const results = await reading.catch(() => []);
      if (gBrowser.selectedTab != parentTab || parentTab.closing || !win.gZenGlanceManager) {
        return;
      }
      if (!results.length) {
        win.gZenUIManager?.showToast("whimsy-search-deck-none");
        return;
      }
      await this.openDeck(win, { parentTab, results, userContextId });
      return;
    }

    // Arc parity: straight to the top result, no results page in between.
    win.gZenUIManager?.showToast("whimsy-instant-finding");
    const results = await reading.catch(() => []);
    if (win.closed) {
      return;
    }
    if (!results.length) {
      win.gZenUIManager?.showToast("whimsy-instant-none");
      win.openTrustedLinkIn(serpUrl, where, { userContextId });
      return;
    }
    win.openLinkIn(results[0].url, where, {
      triggeringPrincipal: Services.scriptSecurityManager.createNullPrincipal({ userContextId }),
      userContextId,
    });
  },

  /**
   * Reads the result links of a results page in the AI reader's sandbox.
   *
   * @returns {Promise<Array<{ url: string, title: string }>>}
   */
  async readResults(serpUrl, { userContextId = 0, signal } = {}) {
    const controller = new AbortController();
    signal?.addEventListener("abort", () => controller.abort(), { once: true });
    const timer = setTimeout(() => controller.abort(), READ_TIMEOUT_MS);
    try {
      const results = await lazy.WhimsyAIReader.withHiddenPage(
        serpUrl,
        { userContextId, signal: controller.signal, messageManagerGroup: SEARCH_DECK_GROUP },
        browser =>
          browser.browsingContext.currentWindowGlobal
            .getActor("WhimsySearchDeck")
            .sendQuery("WhimsySearchDeck:Read", { limit: MAX_RESULTS })
      );
      return (Array.isArray(results) ? results : []).filter(r => /^https?:\/\//.test(r?.url ?? ""));
    } finally {
      clearTimeout(timer);
    }
  },

  // ---- The deck ---------------------------------------------------------

  // The engine and terms when `browser` shows a search results page.
  searchPageOf(browser) {
    const url = browser?.currentURI?.spec;
    if (!url || !/^https?:/.test(url)) {
      return null;
    }
    try {
      const info = Services.search.parseSubmissionURL(url);
      return info?.engine && info.terms ? info : null;
    } catch {
      return null;
    }
  },

  async startFromPage(win) {
    const { gBrowser } = win;
    const parentTab = gBrowser.selectedTab;
    if (!this.deckEnabled || !win.gZenGlanceManager || this.isPrivate(win) || parentTab.hasAttribute("glance-id")) {
      return;
    }
    const browser = parentTab.linkedBrowser;
    if (!this.searchPageOf(browser)) {
      return;
    }
    const userContextId = parentTab.userContextId || 0;
    const results = await this.readResults(browser.currentURI.spec, { userContextId }).catch(() => []);
    if (gBrowser.selectedTab != parentTab) {
      return;
    }
    if (!results.length) {
      win.gZenUIManager?.showToast("whimsy-search-deck-none");
      return;
    }
    await this.openDeck(win, { parentTab, results, userContextId });
  },

  async openDeck(win, { parentTab, results, userContextId = 0, index = 0 }) {
    const { gBrowser, gZenGlanceManager: manager } = win;
    if (decks.has(win) || parentTab.hasAttribute("glance-id")) {
      return null;
    }
    if (!sheets.has(win)) {
      sheets.add(win);
      win.windowUtils.loadSheetUsingURIString(SHEET, win.windowUtils.AUTHOR_SHEET);
    }
    // The card grows from the command bar, not from the last link clicked.
    const box = win.windowUtils.getBoundsWithoutFlushing(gBrowser.tabbox);
    manager.lastLinkClickData = { clientX: box.width / 2, clientY: 0, width: 0, height: 0 };
    const opened = manager.openGlance(
      {
        url: "about:blank",
        clientX: box.width / 2,
        clientY: 0,
        width: 0,
        height: 0,
        triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
      },
      null,
      parentTab
    );
    // openGlance creates and selects the tab synchronously.
    const tab = gBrowser.selectedTab;
    if (tab == parentTab || !tab.hasAttribute("zen-glance-tab")) {
      return null;
    }
    const state = {
      win,
      parentTab,
      tab,
      results: results.slice(0, MAX_RESULTS),
      index: -1,
      userContextId,
      bar: null,
      swiping: false,
    };
    decks.set(win, state);
    tab.setAttribute("whimsy-search-deck", "true");
    this.keepOffHistory(state);
    this.watch(state);
    this.show(state, index, 0);
    this.syncPromoteKey(win);
    await opened;
    if (decks.get(win) == state) {
      this.mountBar(state);
    }
    return tab;
  },

  // Rejected cards stay out of global history (also for links followed
  // inside a card), and each flip replaces the card's one session entry.
  keepOffHistory(state) {
    const browser = state.tab.linkedBrowser;
    // Read again whenever the browser gets a new browsing context.
    browser.setAttribute("disableglobalhistory", "true");
    try {
      browser.browsingContext.useGlobalHistory = false;
    } catch {}
  },

  watch(state) {
    const { win, tab } = state;
    const cardUrl = () => tab.linkedBrowser.currentURI?.spec;
    // Esc / click outside / closing the tab: the card leaves no "recently
    // closed" entry either. Zen fires GlanceClose just before removing the
    // tab, so forget it once TabClose has saved it.
    const forgetAfterClose = url =>
      tab.addEventListener("TabClose", () => win.setTimeout(() => this.forgetClosed(win, url), 0), { once: true });
    const onGlanceClose = () => {
      if (decks.get(win) == state) {
        const url = cardUrl();
        this.end(state);
        forgetAfterClose(url);
      }
    };
    const onTabClose = () => {
      if (decks.get(win) == state) {
        const url = cardUrl();
        this.end(state);
        win.setTimeout(() => this.forgetClosed(win, url), 0);
      }
    };
    tab.addEventListener("GlanceClose", onGlanceClose);
    tab.addEventListener("TabClose", onTabClose);
    // Promoted (Cmd+Enter here, or Zen's Cmd+O / sidebar button): the tab
    // stops being a Glance and stays open. Closing also drops the attribute,
    // so wait a tick and make sure the tab is still there.
    const observer = new win.MutationObserver(() => {
      if (tab.hasAttribute("zen-glance-tab")) {
        return;
      }
      win.setTimeout(() => {
        if (decks.get(win) == state && !tab.closing && tab.isConnected && !tab.hasAttribute("zen-glance-tab")) {
          this.onPromoted(state);
        }
      }, 0);
    });
    observer.observe(tab, { attributes: true, attributeFilter: ["zen-glance-tab"] });
    state.cleanup = () => {
      tab.removeEventListener("GlanceClose", onGlanceClose);
      tab.removeEventListener("TabClose", onTabClose);
      observer.disconnect();
    };
  },

  show(state, index, direction) {
    const { results, tab, win } = state;
    if (index < 0 || index >= results.length || index == state.index) {
      return;
    }
    state.index = index;
    const browser = tab.linkedBrowser;
    this.keepOffHistory(state);
    if (direction && !state.swiping) {
      this.nudge(win, browser, direction);
    }
    browser.loadURI(Services.io.newURI(results[index].url), {
      triggeringPrincipal: Services.scriptSecurityManager.createNullPrincipal({
        userContextId: state.userContextId,
      }),
      loadFlags: Ci.nsIWebNavigation.LOAD_FLAGS_REPLACE_HISTORY,
    });
    this.prefetch(state, index + 1);
    this.updateBar(state);
  },

  // Only the next card is warmed up: a connection, not a page load.
  prefetch(state, index) {
    const next = state.results[index];
    if (!next) {
      return;
    }
    try {
      Services.io.speculativeConnect(
        Services.io.newURI(next.url),
        Services.scriptSecurityManager.createNullPrincipal({ userContextId: state.userContextId }),
        null,
        false
      );
    } catch {}
  },

  // A short slide from the side the card came from (fade only with reduced
  // motion), so the direction of travel reads at a glance.
  nudge(win, browser, direction) {
    const from = reducedMotion(win)
      ? [{ opacity: 0.6 }, { opacity: 1 }]
      : [
          { translate: `${direction * 28}px 0`, opacity: 0.55 },
          { translate: "0 0", opacity: 1 },
        ];
    try {
      browser.animate(from, { duration: 240, easing: "cubic-bezier(0.16, 1, 0.3, 1)" });
    } catch {}
  },

  isShowing(win) {
    const state = decks.get(win);
    return !!state && win.gBrowser.selectedTab == state.tab && state.tab.hasAttribute("zen-glance-tab");
  },

  flip(win, step) {
    const state = decks.get(win);
    if (!state || !this.isShowing(win)) {
      return false;
    }
    const index = state.index + step;
    if (index < 0 || index >= state.results.length) {
      this.bump(state, step);
      return true;
    }
    this.show(state, index, step);
    return true;
  },

  // At either end: a small rubber-band bump instead of nothing.
  bump(state, step) {
    if (reducedMotion(state.win)) {
      return;
    }
    try {
      state.tab.linkedBrowser.animate(
        [{ translate: "0 0" }, { translate: `${-step * 10}px 0` }, { translate: "0 0" }],
        { duration: 260, easing: "cubic-bezier(0.34, 1.4, 0.64, 1)" }
      );
    } catch {}
  },

  promote(win) {
    if (!this.isShowing(win)) {
      return;
    }
    win.gZenGlanceManager.fullyOpenGlance();
  },

  onPromoted(state) {
    const browser = state.tab.linkedBrowser;
    browser.removeAttribute("disableglobalhistory");
    try {
      browser.browsingContext.useGlobalHistory = true;
    } catch {}
    // The card you kept is a visit like any other; the rest never were.
    const url = browser.currentURI?.spec;
    if (url && /^https?:/.test(url)) {
      lazy.PlacesUtils.history
        .insert({
          url,
          title: browser.contentTitle || state.results[state.index]?.title || undefined,
          visits: [{ transition: lazy.PlacesUtils.history.TRANSITIONS.LINK }],
        })
        .catch(e => console.error("Whimsy: search deck visit", e));
    }
    state.tab.removeAttribute("whimsy-search-deck");
    this.end(state);
  },

  end(state) {
    const { win } = state;
    state.cleanup?.();
    state.bar?.remove();
    state.bar = null;
    state.tab.linkedBrowser?.style.removeProperty("translate");
    if (decks.get(win) == state) {
      decks.delete(win);
    }
    this.syncPromoteKey(win);
  },

  forgetClosed(win, url) {
    if (!url || win.closed) {
      return;
    }
    try {
      const closed = lazy.SessionStore.getClosedTabDataForWindow(win);
      const index = closed.findIndex(item => {
        const entries = item.state?.entries ?? [];
        return entries[entries.length - 1]?.url == url;
      });
      if (index >= 0) {
        lazy.SessionStore.forgetClosedTab(win, index);
      }
    } catch (e) {
      console.error("Whimsy: search deck closed tab", e);
    }
  },

  syncPromoteKey(win) {
    const key = win.document.getElementById(PROMOTE_KEY);
    if (!key) {
      return;
    }
    // Off unless a deck is open, so Cmd+Enter is untouched everywhere else.
    if (decks.has(win)) {
      key.removeAttribute("disabled");
    } else {
      key.setAttribute("disabled", "true");
    }
  },

  onCommand(win, event) {
    const id = event.target?.id;
    if ((id != NEXT_COMMAND && id != PREV_COMMAND) || !this.isShowing(win) || win.gURLBar?.focused) {
      return;
    }
    event.stopPropagation();
    event.preventDefault();
    this.flip(win, id == NEXT_COMMAND ? 1 : -1);
  },

  // ---- Swipes over the card ---------------------------------------------

  // Only gestures that start over the deck card's own page. Zen's space
  // swipe listens on the sidebar and the Library, never here.
  ownsSwipe(win, target) {
    const state = decks.get(win);
    if (!state || !this.isShowing(win) || !target) {
      return false;
    }
    if (win.gNavToolbox?.contains(target)) {
      return false;
    }
    const browser = state.tab.linkedBrowser;
    // The card and its deck dots.
    return target == browser || !!browser.closest(".browserContainer")?.contains(target);
  },

  onSwipe(win, event) {
    const state = decks.get(win);
    if (!state) {
      return;
    }
    if (event.type == "MozSwipeGestureMayStart") {
      state.swiping = false;
      if (!this.ownsSwipe(win, event.target)) {
        return;
      }
      // DIRECTION_LEFT is Firefox's "back": the previous card.
      let directions = 0;
      if (state.index > 0) {
        directions |= event.DIRECTION_LEFT;
      }
      if (state.index < state.results.length - 1) {
        directions |= event.DIRECTION_RIGHT;
      }
      if (!directions) {
        return;
      }
      event.allowedDirections = directions;
      event.preventDefault();
      event.stopPropagation();
      state.swiping = true;
      return;
    }
    if (event.type == "MozSwipeGesture") {
      if (!state.swiping && !this.ownsSwipe(win, event.target)) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      state.swiping = false;
      this.settle(state);
      if (event.direction & event.DIRECTION_LEFT) {
        this.flip(win, -1);
      } else if (event.direction & event.DIRECTION_RIGHT) {
        this.flip(win, 1);
      }
      return;
    }
    if (!state.swiping) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    if (event.type == "MozSwipeGestureUpdate") {
      if (reducedMotion(win)) {
        return;
      }
      // The page follows the fingers, with resistance: about 40px at the
      // point the swipe commits, never more than 120px.
      const delta = Number(event.delta) || 0;
      const offset = Math.sign(delta) * 120 * (1 - 1 / (1 + Math.abs(delta) * 2));
      state.tab.linkedBrowser.style.translate = `${offset.toFixed(1)}px 0`;
    } else if (event.type == "MozSwipeGestureEnd") {
      state.swiping = false;
      this.settle(state);
    }
  },

  // Back to rest from wherever the swipe left it.
  settle(state) {
    const browser = state.tab.linkedBrowser;
    const from = browser.style.translate;
    browser.style.removeProperty("translate");
    if (!from || from == "0px 0" || reducedMotion(state.win)) {
      return;
    }
    try {
      browser.animate([{ translate: from }, { translate: "0 0" }], {
        duration: 280,
        easing: "cubic-bezier(0.16, 1, 0.3, 1)",
      });
    } catch {}
  },

  // ---- Deck dots ---------------------------------------------------------

  mountBar(state) {
    const { win, tab } = state;
    const doc = win.document;
    const container = tab.linkedBrowser.closest(".browserContainer");
    if (!container || state.bar) {
      return;
    }
    const html = name => doc.createElementNS("http://www.w3.org/1999/xhtml", name);
    const bar = html("div");
    bar.className = "whimsy-search-deck-bar";
    bar.setAttribute("role", "toolbar");
    doc.l10n.setAttributes(bar, "whimsy-search-deck-bar");

    const button = (className, l10nId, onClick) => {
      const el = html("button");
      el.className = className;
      el.type = "button";
      doc.l10n.setAttributes(el, l10nId);
      el.addEventListener("click", onClick);
      return el;
    };
    const prev = button("whimsy-search-deck-prev", "whimsy-search-deck-prev", () => this.flip(win, -1));
    const next = button("whimsy-search-deck-next", "whimsy-search-deck-next", () => this.flip(win, 1));
    const dots = html("div");
    dots.className = "whimsy-search-deck-dots";
    state.results.forEach((result, i) => {
      const dot = button("whimsy-search-deck-dot", "whimsy-search-deck-dot", () =>
        this.show(state, i, Math.sign(i - state.index))
      );
      doc.l10n.setAttributes(dot, "whimsy-search-deck-dot", { index: i + 1, title: result.title });
      dots.append(dot);
    });
    const label = html("span");
    label.className = "whimsy-search-deck-position";
    label.setAttribute("aria-live", "polite");
    bar.append(prev, dots, label, next);
    container.append(bar);
    state.bar = bar;
    this.updateBar(state);
  },

  updateBar(state) {
    const { bar, index, results, win } = state;
    if (!bar) {
      return;
    }
    const doc = win.document;
    bar.querySelector(".whimsy-search-deck-prev").disabled = index <= 0;
    bar.querySelector(".whimsy-search-deck-next").disabled = index >= results.length - 1;
    for (const [i, dot] of [...bar.querySelectorAll(".whimsy-search-deck-dot")].entries()) {
      if (i == index) {
        dot.setAttribute("aria-current", "true");
      } else {
        dot.removeAttribute("aria-current");
      }
    }
    doc.l10n.setAttributes(bar.querySelector(".whimsy-search-deck-position"), "whimsy-search-deck-position", {
      index: index + 1,
      count: results.length,
      site: siteOf(results[index]?.url) || "",
    });
  },
};
