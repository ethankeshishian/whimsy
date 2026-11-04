/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// W11-13: move private pages out to a space (Zen parity, plus the user's
// picks d11-d13 in wave11/design/private-lock-spec.md).
//
// Zen's affordance: in an unsynced window (a private or blank one) the
// space header's "…" button becomes "Move To" (ZenSpace.mjs,
// moveTabToButtonMarkup). Its menu lists every space, and picking one
// adoptTab()s ALL the window's tabs into the first synced window
// (ZenWindowSync.moveTabsToSyncedWorkspace). From a private window that
// can't work: Tabbrowser.swapBrowsersAndCloseOther refuses to swap a private
// browser into a normal one, and carrying private cookies or history out
// would be wrong anyway. Whimsy keeps Zen's button and word, and in a
// private window answers it itself:
//
// - The header's Move To moves ALL the window's tabs (like Zen, d11).
// - The tab's right-click "Move Out of Private…" and the command of the
//   same name move THAT tab, from a private window or a private tab in a
//   normal window (Private Space or a private tab, d13).
// - Step 1, a WhimsySurface: "Move to a space", spaces in switcher order
//   (grouped by profile when there's more than one), hidden ones last,
//   locked ones marked. Step 2 asks first (d12): "Move this tab to
//   “Work”?" with what it means (it opens again outside private browsing,
//   in that space's profile, and goes into history; you may need to sign
//   in again). Esc in step 2 goes back.
// - Then each page's URL opens again as an ordinary tab in that space (its
//   profile's container), in the first normal window (a new one if there
//   is none). Only the URL moves: never cookies, session history, form
//   data or scroll. Then it switches there and selects the first moved
//   tab, and closes the private originals (and the private window, once
//   empty). A locked target space asks to unlock first, through
//   WhimsySpaceLock.ensureUnlocked; cancelling moves nothing.

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  BrowserWindowTracker: "resource:///modules/BrowserWindowTracker.sys.mjs",
  PrivateBrowsingUtils: "resource://gre/modules/PrivateBrowsingUtils.sys.mjs",
  WhimsyCommands: "resource:///modules/whimsy/WhimsyCommands.sys.mjs",
  WhimsyPrivate: "resource:///modules/whimsy/WhimsyPrivate.sys.mjs",
  WhimsyPrivateLock: "resource:///modules/whimsy/WhimsyPrivateLock.sys.mjs",
  WhimsyProfiles: "resource:///modules/whimsy/WhimsyProfiles.sys.mjs",
  WhimsySpaceLock: "resource:///modules/whimsy/WhimsySpaceLock.sys.mjs",
  WhimsySurface: "resource:///modules/whimsy/WhimsySurface.sys.mjs",
});

const HTML_NS = "http://www.w3.org/1999/xhtml";
export const PANEL_ID = "whimsyPrivateMoveTo";
const FEATURE_PREF = "whimsy.feature.private-move";
const FILTER_FROM = 6;
// Pages with nothing public to reopen.
const SKIP_URLS = new Set(["about:blank", "about:privatebrowsing", "about:newtab", "about:home"]);

function spaceColor(space) {
  const rgb = space?.theme?.gradientColors?.[0]?.c;
  return Array.isArray(rgb) && rgb.length >= 3 ? `rgb(${rgb.slice(0, 3).join(" ")})` : null;
}

export const WhimsyPrivateMove = {
  PANEL_ID,

  get enabled() {
    return Services.prefs.getBoolPref(FEATURE_PREF, true);
  },

  isPrivateWindow(win) {
    return !!win && lazy.PrivateBrowsingUtils.isWindowPrivate(win);
  },

  isPrivateTab(win, tab) {
    if (!tab || tab.closing) {
      return false;
    }
    return this.isPrivateWindow(win) || lazy.WhimsyPrivate.isPrivateTab(tab) ||
      lazy.WhimsyPrivate.isPrivateBrowser(tab.linkedBrowser);
  },

  // The pages `tabs` would reopen (private new-tab pages have nothing to move).
  movableTabs(tabs) {
    return tabs.filter(tab => !tab.closing && !tab.hasAttribute("zen-empty-tab") &&
      !SKIP_URLS.has(this.urlOf(tab)));
  },

  urlOf(tab) {
    return tab.linkedBrowser?.currentURI?.spec ?? "about:blank";
  },

  initWindow(win) {
    if (win._whimsyPrivateMove) {
      return;
    }
    win._whimsyPrivateMove = true;
    // Zen's header "Move To" in a private window: answered here (capture,
    // before the button's own listener) so the tabs reopen instead of
    // being adopted, which can't work across private and normal.
    if (this.isPrivateWindow(win)) {
      win.addEventListener("command", event => {
        const button = event.target?.closest?.(".zen-workspaces-actions");
        if (!this.enabled || !button ||
            button.getAttribute("data-l10n-id") != "zen-move-tab-to-workspace-button") {
          return;
        }
        event.stopImmediatePropagation();
        event.preventDefault();
        const tabs = this.movableTabs(win.gZenWorkspaces?.allStoredTabs ?? win.gBrowser.tabs);
        this.open(win, { tabs, anchor: button, all: true });
      }, true);
    }
    lazy.WhimsyCommands.register(win, {
      id: "cmd_whimsyMoveOutOfPrivate",
      l10nId: "whimsy-action-move-out-of-private",
      run: w => this.open(w, { tabs: [w.gBrowser.selectedTab] }),
      icon: "chrome://browser/skin/zen-icons/private-window.svg",
      isAvailable: w => this.enabled && this.isPrivateTab(w, w.gBrowser.selectedTab) &&
        this.movableTabs([w.gBrowser.selectedTab]).length > 0,
    });
  },

  // The normal window tabs go to: the most recent one, or none.
  targetWindow() {
    return lazy.BrowserWindowTracker.getTopWindow({ private: false, allowPopups: false }) ?? null;
  },

  // Every space in switcher order, hidden ones last; never the Private Space.
  spaces(win) {
    const source = this.targetWindow() ?? win;
    const all = (source.gZenWorkspaces?.getWorkspaces?.() ?? []).filter(space => !space.whimsyScratch);
    return [...all.filter(space => !space.whimsyHidden), ...all.filter(space => space.whimsyHidden)];
  },

  profileName(space) {
    return lazy.WhimsyProfiles.nameOf(lazy.WhimsyProfiles.profileIdOfSpace(space));
  },

  /**
   * Opens the picker for `tabs`. `all`: the header's Move To (every tab in
   * the private window).
   */
  open(win, { tabs, anchor = null, all = false }) {
    tabs = this.movableTabs(tabs ?? []);
    if (!this.enabled || !tabs.length) {
      return null;
    }
    // W14-14: a covered tab asks to unlock first; the picker follows.
    if (lazy.WhimsyPrivateLock.hiddenAmong(tabs).length) {
      lazy.WhimsyPrivateLock.ensureTabsUnlocked(win, tabs)
        .then(ok => ok && this.open(win, { tabs, anchor, all }))
        .catch(e => console.error("Whimsy: move out of private", e));
      return null;
    }
    const doc = win.document;
    const S = lazy.WhimsySurface;
    let step = 1;
    const parts = S.create(win, {
      id: PANEL_ID,
      width: 340,
      titleL10nId: "whimsy-private-move-title",
      close: true,
      footer: true,
      className: "whimsy-private-move-panel",
      onEscape: () => {
        if (step == 2) {
          showPicker();
          return true;
        }
        return false;
      },
    });
    parts.panel._whimsyMoveTabs = tabs;
    const content = doc.createXULElement("vbox");
    content.className = "whimsy-private-move-content";
    parts.view.append(content);
    S.finish(parts);

    const showPicker = () => {
      step = 1;
      doc.l10n.setAttributes(parts.title, "whimsy-private-move-title");
      parts.footer.replaceChildren();
      parts.footer.hidden = true;
      content.replaceChildren(...this.buildPicker(win, parts, tabs, space => showConfirm(space)));
      (content.querySelector(".whimsy-private-move-filter") ??
        content.querySelector("[role=option][tabindex='0']"))?.focus();
    };
    const showConfirm = space => {
      step = 2;
      const count = tabs.length;
      doc.l10n.setAttributes(parts.title, "whimsy-private-move-confirm-title", { count, space: space.name || "" });
      const body = doc.createElementNS(HTML_NS, "p");
      body.className = "whimsy-private-move-body";
      doc.l10n.setAttributes(body, "whimsy-private-move-confirm-body", { count, profile: this.profileName(space) });
      content.replaceChildren(body);
      parts.footer.hidden = false;
      const move = S.footerButton(doc, {
        id: "whimsy-private-move-confirm",
        l10nId: "whimsy-private-move-confirm-button",
        l10nArgs: { count },
        primary: true,
        onCommand: () => {
          S.close(parts.panel);
          this.move(win, tabs, space.uuid).catch(e => console.error("Whimsy: move out of private", e));
        },
      });
      parts.footer.replaceChildren(
        S.footerButton(doc, { id: "whimsy-private-move-back", l10nId: "whimsy-private-move-back", onCommand: showPicker }),
        move
      );
      move.focus();
    };

    showPicker();
    if (anchor) {
      S.open(win, parts.panel, { anchor, position: "after_start", y: 4 });
    } else {
      S.open(win, parts.panel, { at: "page-top-center" });
    }
    parts.panel.dataset.scope = all ? "all" : "tab";
    return parts;
  },

  buildPicker(win, parts, tabs, onPick) {
    const doc = win.document;
    const S = lazy.WhimsySurface;
    const out = [];
    const spaces = this.spaces(win);
    let filter = null;
    if (spaces.length >= FILTER_FROM) {
      const box = doc.createXULElement("hbox");
      box.className = "whimsy-surface-search";
      box.setAttribute("align", "center");
      const glass = doc.createXULElement("image");
      glass.className = "whimsy-sheet-search-icon";
      glass.setAttribute("src", "chrome://browser/skin/zen-icons/search-glass.svg");
      filter = doc.createElementNS(HTML_NS, "input");
      filter.type = "search";
      filter.className = "whimsy-private-move-filter";
      doc.l10n.setAttributes(filter, "whimsy-private-move-filter");
      box.append(glass, filter);
      out.push(box);
    }
    const list = doc.createElementNS(HTML_NS, "div");
    list.className = "whimsy-surface-listbox whimsy-private-move-list";
    list.setAttribute("role", "listbox");
    list.setAttribute("aria-labelledby", `${PANEL_ID}-title`);
    const manyProfiles = lazy.WhimsyProfiles.list().length > 1;
    let lastGroup = null;
    spaces.forEach((space, index) => {
      const group = space.whimsyHidden ? "hidden" : manyProfiles ? `profile:${this.profileName(space)}` : null;
      if (group && group != lastGroup) {
        const caption = doc.createElementNS(HTML_NS, "div");
        caption.className = "whimsy-private-move-caption";
        caption.setAttribute("role", "presentation");
        if (group == "hidden") {
          doc.l10n.setAttributes(caption, "whimsy-private-move-hidden");
        } else {
          caption.textContent = this.profileName(space);
        }
        list.append(caption);
      }
      lastGroup = group;
      const row = doc.createElementNS(HTML_NS, "div");
      row.className = "whimsy-surface-option whimsy-private-move-space";
      row.setAttribute("role", "option");
      row.setAttribute("aria-selected", "false");
      row.dataset.uuid = space.uuid;
      row.dataset.name = (space.name || "").toLocaleLowerCase();
      row.tabIndex = index == 0 ? 0 : -1;
      const iconURL = /^[a-z-]+:\/\//.test(space.icon ?? "") ? space.icon : null;
      const tile = S.tile(doc, { icon: iconURL, text: iconURL ? null : (space.icon || (space.name || "?").slice(0, 1)) });
      const color = spaceColor(space);
      if (color) {
        tile.style.setProperty("--whimsy-tile-color", color);
      }
      const name = doc.createElementNS(HTML_NS, "span");
      name.className = "whimsy-private-move-name";
      name.textContent = space.name || "";
      row.append(tile, name);
      if (space.whimsyLocked) {
        row.append(S.pill(doc, { l10nId: "whimsy-hidden-space-locked" }));
      }
      const pick = () => onPick(space);
      row.addEventListener("click", pick);
      row.addEventListener("keydown", event => {
        if (event.key == "Enter" || event.key == " ") {
          event.preventDefault();
          pick();
        }
      });
      list.append(row);
    });
    if (filter) {
      filter.addEventListener("input", () => {
        const query = filter.value.trim().toLocaleLowerCase();
        let first = null;
        for (const row of list.querySelectorAll("[role=option]")) {
          row.hidden = !!query && !row.dataset.name.includes(query);
          row.tabIndex = -1;
          first ??= row.hidden ? null : row;
        }
        first?.setAttribute("tabindex", "0");
      });
      filter.addEventListener("keydown", event => {
        const first = [...list.querySelectorAll("[role=option]")].find(row => !row.hidden);
        if (first && event.key == "Enter") {
          event.preventDefault();
          first.click();
        } else if (first && event.key == "ArrowDown") {
          event.preventDefault();
          first.focus();
        }
      });
    }
    out.push(list);
    const hint = doc.createElementNS(HTML_NS, "p");
    hint.className = "whimsy-private-move-hint";
    doc.l10n.setAttributes(hint, "whimsy-private-move-hint");
    out.push(hint);
    return out;
  },

  async ensureTargetWindow(win) {
    let target = this.targetWindow();
    if (target) {
      return target;
    }
    target = win.OpenBrowserWindow({ private: false });
    await new Promise(resolve => target.addEventListener("load", resolve, { once: true }));
    await target.delayedStartupPromise;
    await target.gZenStartup?.promiseInitialized;
    return target;
  },

  /**
   * Reopens each tab's URL as an ordinary tab in space `uuid`, switches
   * there, selects the first and closes the private originals.
   */
  async move(win, tabs, uuid) {
    tabs = this.movableTabs(tabs);
    if (!tabs.length || !(await lazy.WhimsyPrivateLock.ensureTabsUnlocked(win, tabs))) {
      return false;
    }
    const target = await this.ensureTargetWindow(win);
    const { gBrowser, gZenWorkspaces } = target;
    const space = gZenWorkspaces.getWorkspaces().find(s => s.uuid == uuid);
    if (!space) {
      return false;
    }
    // A locked space asks first; cancelled = no move.
    if (!(await lazy.WhimsySpaceLock.ensureUnlocked(target, space))) {
      return false;
    }
    if (gZenWorkspaces.activeWorkspace != uuid) {
      await gZenWorkspaces.changeWorkspaceWithID(uuid);
      if (gZenWorkspaces.activeWorkspace != uuid) {
        return false;
      }
    }
    const userContextId = space.containerTabId || 0;
    const moved = [];
    for (const tab of tabs) {
      const copy = gBrowser.addTrustedTab(this.urlOf(tab), {
        userContextId,
        inBackground: true,
        relatedToCurrent: false,
        zenWorkspaceId: uuid,
        skipRoute: true,
      });
      if (copy) {
        moved.push(copy);
      }
    }
    if (!moved.length) {
      return false;
    }
    target.focus();
    gBrowser.selectedTab = moved[0];
    // The originals go; an emptied private window closes.
    const sourceIsWindow = this.isPrivateWindow(win);
    const left = win.gBrowser.tabs.filter(tab => !tab.closing && !tabs.includes(tab) && !tab.hasAttribute("zen-empty-tab"));
    if (sourceIsWindow && !left.length) {
      win.close();
    } else {
      win.gBrowser.removeTabs(tabs, { closeWindowWithLastTab: false, animate: false });
    }
    target.gZenUIManager?.showToast?.("whimsy-private-moved-toast", { l10nArgs: { space: space.name || "", count: moved.length } });
    return true;
  },
};
