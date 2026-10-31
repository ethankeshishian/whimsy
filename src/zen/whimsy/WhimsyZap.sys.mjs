/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// wave6/zap: Zap, erase any page element.
//
// The original: Safari 18's Distraction Control and Arc's Boosts "Zap".
// People love it because the page finally obeys them: the cookie nag, the
// sticky "subscribe" bar, the autoplaying sidebar video, gone for good on
// that site. The flow (Arc): turn Zap on, hover to see an outline around
// what will go, click and it dissolves; the zaps stay for that site, and
// each one can be brought back from the restore buttons while zapping.
//
// Zen already ships the engine of it inside Boosts: zap mode (element
// picker, hover outline), the dust dissolve, per-site rules in the site's
// Boost, and the zap bar listing each zap with a hover preview and restore
// (ZenBoostsChild, ZenZapBar, ZenZapDissolve). It's only reachable from the
// Boost editor, though, and only on a site that already has a Boost. This
// makes it a first-class command:
//
// - Cmd+Shift+X toggles zap mode on the current page (taking the key from
//   Firefox's Switch Text Direction, which stays in the context menu), from
//   the command bar ("Zap Elements") or from the site panel's menu, which
//   also says how many things are zapped there. A Boost is created on the
//   fly when the site has none.
// - Cmd+Z while zapping (and Whimsy's general undo after) brings back the
//   last zap; Cmd+Shift+Z zaps it again.
// - The dust takes the current space's gradient colors (WhimsyZapTint, via
//   one hook in ZenZapDissolve).
// - Each zap counts toward Year in tabs ("Things zapped").
// Reduced motion keeps Zen's behavior: the element goes at once, no dust.

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  gZenBoostsManager: "resource:///modules/zen/boosts/ZenBoostsManager.sys.mjs",
  WhimsyShortcuts: "resource:///modules/whimsy/WhimsyShortcuts.sys.mjs",
  WhimsyStats: "resource:///modules/whimsy/WhimsyStats.sys.mjs",
  WhimsyUndo: "resource:///modules/whimsy/WhimsyUndo.sys.mjs",
});

const FEATURE_PREF = "whimsy.feature.zap";
const BOOSTS_PREF = "zen.boosts.enabled";
export const TINT_KEY = "whimsy:zap-tint";
const COMMAND_ID = "whimsy-zap";
const MENUITEM_ID = "whimsy-site-zap";

export const WhimsyZap = {
  COMMAND_ID,
  TINT_KEY,

  // Replaying an undo or redo: not a new zap (no count, no undo entry).
  _replaying: false,
  _wrapped: false,
  // Zaps that can be undone while WhimsyUndo is switched off.
  _ownStack: [],

  get enabled() {
    return Services.prefs.getBoolPref(FEATURE_PREF, true) && Services.prefs.getBoolPref(BOOSTS_PREF, true);
  },

  // The domain Zen's boosts key on (the page's host without its port), or
  // null for pages that can't be zapped (about:, files, the new tab page).
  domainFor(browser) {
    const uri = browser?.currentURI;
    if (!uri || !["http", "https"].includes(uri.scheme)) {
      return null;
    }
    try {
      return uri.host || null;
    } catch (e) {
      return null;
    }
  },

  canZap(win) {
    return this.enabled && !!this.domainFor(win?.gBrowser?.selectedBrowser);
  },

  isZapping(win) {
    const container = win?.gBrowser?.selectedBrowser?.closest(".browserSidebarContainer");
    return !!container?.hasAttribute("zen-zapping");
  },

  // Zaps live in the site's active Boost; make one (with no other changes)
  // when the site has none yet, the way Zen's own tests do.
  ensureBoost(domain) {
    const manager = lazy.gZenBoostsManager;
    let boost = manager.getActiveBoostId(domain) ? manager.loadActiveBoostFromStore(domain) : null;
    if (!boost) {
      boost = manager.createNewBoost(domain);
      if (!boost) {
        return null;
      }
      manager.makeBoostActiveForDomain(domain, boost.id);
    }
    if (!boost.boostEntry.boostData.changeWasMade) {
      boost.boostEntry.boostData.changeWasMade = true;
      manager.updateBoost(boost);
    }
    return boost;
  },

  zapCount(domain) {
    if (!domain) {
      return 0;
    }
    try {
      const manager = lazy.gZenBoostsManager;
      if (!manager.getActiveBoostId(domain)) {
        return 0;
      }
      return manager.loadActiveBoostFromStore(domain)?.boostEntry.boostData.zapSelectors?.length ?? 0;
    } catch (e) {
      return 0;
    }
  },

  // Turns zap mode on (or off) in the current tab.
  async toggle(win) {
    if (!this.canZap(win)) {
      return false;
    }
    const browser = win.gBrowser.selectedBrowser;
    const domain = this.domainFor(browser);
    this.wrapManager();
    if (!this.isZapping(win) && !this.ensureBoost(domain)) {
      return false;
    }
    await this.updateTint(win);
    try {
      const actor = browser.browsingContext?.currentWindowGlobal?.getActor("ZenBoosts");
      await actor?.sendQuery("ZenBoost:ToggleZapMode", { mode: "zap" });
    } catch (e) {
      // A page that's still loading (or an error page) has no boosts actor.
      return false;
    }
    return true;
  },

  async exit(win, browser) {
    browser = browser || win?.gBrowser?.selectedBrowser;
    const container = browser?.closest(".browserSidebarContainer");
    if (container?.hasAttribute("zen-zapping")) {
      try {
        const actor = browser.browsingContext?.currentWindowGlobal?.getActor("ZenBoosts");
        await actor?.sendQuery("ZenBoost:ToggleZapMode", { mode: "zap" });
      } catch (e) {
        return false;
      }
      return true;
    }
    return false;
  },

  // The space's gradient colors ([[r, g, b], ...]) for the dust, shared with
  // the content processes (WhimsyZapTint reads them there).
  async updateTint(win) {
    let colors = [];
    try {
      const space = await win.gZenWorkspaces?.getActiveWorkspace?.();
      colors = (space?.theme?.gradientColors ?? [])
        .map(color => color?.c)
        .filter(c => Array.isArray(c) && c.length >= 3 && c.slice(0, 3).every(Number.isFinite))
        .map(c => c.slice(0, 3).map(v => Math.max(0, Math.min(255, Math.round(v)))));
    } catch (e) {
      colors = [];
    }
    const shared = Services.ppmm.sharedData;
    if (colors.length) {
      shared.set(TINT_KEY, colors);
    } else {
      shared.delete(TINT_KEY);
    }
    shared.flush();
    return colors;
  },

  // Every zap goes through gZenBoostsManager (zap mode, the Boost editor),
  // so wrapping it once per session counts zaps and makes them undoable.
  wrapManager() {
    if (this._wrapped) {
      return;
    }
    const manager = lazy.gZenBoostsManager;
    const add = manager.addZapSelectorToActive;
    const remove = manager.removeZapSelectorToActive;
    if (typeof add != "function" || typeof remove != "function") {
      return;
    }
    this._wrapped = true;
    this._add = (selector, domain) => add.call(manager, selector, domain, "zap");
    this._remove = (selector, domain) => remove.call(manager, selector, domain, "zap");
    const zap = this;
    manager.addZapSelectorToActive = function (selector, domain, mode = "zap") {
      const isNew =
        mode == "zap" &&
        !zap._replaying &&
        !(this.getActiveBoostId(domain) &&
          this.loadActiveBoostFromStore(domain)?.boostEntry.boostData.zapSelectors?.includes(selector));
      const result = add.call(this, selector, domain, mode);
      if (isNew && Services.prefs.getBoolPref(FEATURE_PREF, true)) {
        try {
          zap.onZapped(selector, domain);
        } catch (e) {
          console.error("Whimsy: zap bookkeeping", e);
        }
      }
      return result;
    };
  },

  onZapped(selector, domain) {
    lazy.WhimsyStats.recordZap();
    const win = Services.wm.getMostRecentWindow("navigator:browser");
    const entry = {
      type: "zap",
      selector,
      domain,
      undo: () => this.replay(() => this._remove(selector, domain)),
      redo: () => this.replay(() => this._add(selector, domain)),
    };
    if (win && lazy.WhimsyUndo.enabled) {
      lazy.WhimsyUndo.push(win, entry);
    } else {
      this._ownStack.push(entry);
      this._ownStack.splice(0, Math.max(0, this._ownStack.length - 20));
    }
  },

  replay(fn) {
    this._replaying = true;
    try {
      fn();
    } finally {
      this._replaying = false;
    }
  },

  // Cmd+Z / Cmd+Shift+Z while zapping. Focus is in the page then, which
  // WhimsyUndo leaves alone, so zap mode answers them itself.
  undoInZapMode(win, redo = false) {
    const undo = lazy.WhimsyUndo;
    if (undo.enabled) {
      const top = redo ? undo.peekRedo?.(win) : undo.peek?.(win);
      if (top?.type != "zap") {
        return false;
      }
      return redo ? undo.redo(win) : undo.undo(win);
    }
    if (redo) {
      return false;
    }
    const entry = this._ownStack.pop();
    entry?.undo();
    return !!entry;
  },

  initWindow(win) {
    const { document } = win;
    const shortcuts = lazy.WhimsyShortcuts;
    if (this.enabled) {
      shortcuts.releaseKey(win, "key_switchTextDirection");
      this.wrapManager();
    }
    shortcuts.addCommand(win, {
      id: COMMAND_ID,
      run: w => this.toggle(w),
      key: this.enabled ? { id: "key_whimsyZap", key: "X", modifiers: "accel,shift" } : null,
    });
    shortcuts.addActions([
      {
        l10nId: "whimsy-action-zap",
        command: COMMAND_ID,
        icon: "chrome://browser/skin/zen-icons/bolt.svg",
        isAvailable: w => this.canZap(w),
      },
    ]);

    // The site panel's "..." menu: Zap Elements, with the site's count.
    const popup = document.getElementById("zenSiteDataActions");
    const onShowing = event => {
      if (event.target != popup) {
        return;
      }
      let item = document.getElementById(MENUITEM_ID);
      if (!item) {
        item = document.createXULElement("menuitem");
        item.id = MENUITEM_ID;
        item.setAttribute("command", COMMAND_ID);
        item.setAttribute("key", "key_whimsyZap");
        const separator = document.createXULElement("menuseparator");
        separator.id = `${MENUITEM_ID}-separator`;
        popup.prepend(item, separator);
      }
      const show = this.canZap(win);
      item.hidden = !show;
      document.getElementById(`${MENUITEM_ID}-separator`).hidden = !show;
      if (show) {
        const count = this.zapCount(this.domainFor(win.gBrowser.selectedBrowser));
        document.l10n.setAttributes(item, count ? "whimsy-site-zap-count" : "whimsy-site-zap", { count });
      }
    };
    popup?.addEventListener("popupshowing", onShowing);

    const onKeyDown = event => {
      if (!this.isZapping(win)) {
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        this.exit(win);
        return;
      }
      if (event.key?.toLowerCase() != "z" || event.altKey) {
        return;
      }
      const mac = Services.appinfo.OS == "Darwin";
      if (!(mac ? event.metaKey && !event.ctrlKey : event.ctrlKey)) {
        return;
      }
      if (this.undoInZapMode(win, event.shiftKey)) {
        event.preventDefault();
        event.stopPropagation();
      }
    };
    win.addEventListener("keydown", onKeyDown, true);

    const zapObserver = new win.MutationObserver(mutations => {
      for (const m of mutations) {
        if (m.type === "attributes" && m.attributeName === "zen-zapping") {
          const container = m.target;
          const browser = container.querySelector("browser");
          const isZapping = container.hasAttribute("zen-zapping");
          const actor = browser?.browsingContext?.currentWindowGlobal?.getActor("WhimsyPage");
          actor?.sendAsyncMessage("Whimsy:ZapActive", { active: isZapping });
        }
      }
    });
    const tabpanels = win.document.getElementById("tabbrowser-tabpanels");
    if (tabpanels) {
      zapObserver.observe(tabpanels, { attributes: true, subtree: true, attributeFilter: ["zen-zapping"] });
    }

    const onGradient = () => {
      if (Services.wm.getMostRecentWindow("navigator:browser") == win) {
        this.updateTint(win);
      }
    };
    Services.obs.addObserver(onGradient, "zen-space-gradient-update");
    win.gZenWorkspaces?.promiseInitialized?.then(() => onGradient()).catch(() => {});
    // A space switch changes the colors too.
    win.addEventListener("ZenWorkspacesUIUpdate", onGradient);
    win.addEventListener(
      "unload",
      () => {
        zapObserver.disconnect();
        win.removeEventListener("ZenWorkspacesUIUpdate", onGradient);
        popup?.removeEventListener("popupshowing", onShowing);
        win.removeEventListener("keydown", onKeyDown, true);
        Services.obs.removeObserver(onGradient, "zen-space-gradient-update");
      },
      { once: true }
    );
  },
};
