/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// wave6: Trails. A tab's history as a small tree instead of a line, after
// Horse's Trails, Nyxt's history tree and NetSurf's visual history: go back
// three pages, click a different link, and the pages you were reading are
// normally gone from Forward for good. Here they stay in the tab's
// back/forward menu (long-press or right-click Back or Forward), as faded
// branch rows right where they left the trail, one click away. The menu also
// ends with where the tab came from (the tab whose link opened it), so a tab
// can always be traced back.
//
// Gecko drops forward entries on a new navigation, so this records them first
// from the parent's session history (nsISHistoryListener.OnHistoryTruncate
// runs before the entries go). Everything stays in memory with the tab, like
// session history itself: nothing is written to disk, private tabs included,
// and Clear History empties it. Only http(s) pages are kept.

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  BrowserUtils: "resource://gre/modules/BrowserUtils.sys.mjs",
  PrivateBrowsingUtils: "resource://gre/modules/PrivateBrowsingUtils.sys.mjs",
});

const FEATURE_PREF = "whimsy.feature.trails";
const SHEET = "chrome://browser/content/whimsy/whimsy-navigation.css";
// Per tab: the newest branches, and the pages kept per branch.
const MAX_BRANCHES = 8;
const MAX_ENTRIES = 10;
// Rows the menu shows at most, so it stays a small tree.
const MENU_ROWS = 12;
const ITEM_CLASS = "whimsy-trail-item";

function isWebUrl(spec) {
  return /^https?:/i.test(spec || "");
}

export const WhimsyTrails = {
  // browser -> { sh, listener, branches: [{ anchorId, anchorUrl, entries }] }
  _records: new WeakMap(),
  // tab -> { url, title, opener: WeakRef<tab> }
  _origins: new WeakMap(),
  // Bumped by Clear History; records from an older generation are empty.
  _generation: 0,

  get enabled() {
    return Services.prefs.getBoolPref(FEATURE_PREF, true);
  },

  init() {
    if (this._initialized) {
      return;
    }
    this._initialized = true;
    Services.obs.addObserver(() => this._generation++, "browser:purge-session-history");
  },

  initWindow(win) {
    this.init();
    const { gBrowser } = win;
    if (!gBrowser || win._whimsyTrails) {
      return;
    }
    win._whimsyTrails = true;
    if (!win._whimsyNavigationSheet) {
      win._whimsyNavigationSheet = true;
      win.windowUtils.loadSheetUsingURIString(SHEET, win.windowUtils.AUTHOR_SHEET);
    }
    gBrowser.addTabsProgressListener({
      onLocationChange: (browser, webProgress) => {
        if (webProgress?.isTopLevel) {
          this.attach(browser);
        }
      },
    });
    gBrowser.tabContainer.addEventListener("TabOpen", event => this.rememberOrigin(event.target));
    win.addEventListener("popupshowing", event => this.onPopupShowing(win, event));
    win.addEventListener("popuphidden", event => {
      if (this.isHistoryPopup(event.target)) {
        this.clearMenu(event.target);
      }
    });
    // Capturing, so it runs before the cloned Back/Forward menus stop the
    // command (their rows only carry Firefox's own index attributes).
    win.addEventListener("command", event => this.onCommand(win, event), true);
  },

  // --- Recording ---

  record(browser) {
    let rec = this._records.get(browser);
    if (!rec || rec.generation != this._generation) {
      rec = { sh: rec?.sh ?? null, listener: rec?.listener ?? null, branches: [], generation: this._generation };
      this._records.set(browser, rec);
    }
    return rec;
  },

  attach(browser) {
    if (!this.enabled) {
      return;
    }
    const sh = browser.browsingContext?.sessionHistory;
    if (!sh) {
      return;
    }
    const rec = this.record(browser);
    if (rec.sh == sh) {
      return;
    }
    if (rec.sh && rec.listener) {
      try {
        rec.sh.removeSHistoryListener(rec.listener);
      } catch {}
    }
    const noop = () => {};
    rec.sh = sh;
    rec.listener = {
      QueryInterface: ChromeUtils.generateQI(["nsISHistoryListener", "nsISupportsWeakReference"]),
      OnHistoryNewEntry: noop,
      OnHistoryGotoIndex: noop,
      OnHistoryPurge: noop,
      OnHistoryReload: () => true,
      OnHistoryReplaceEntry: noop,
      OnDocumentViewerEvicted: noop,
      OnHistoryCommit: noop,
      OnEntryUpdated: noop,
      // Runs before Gecko drops the forward entries.
      OnHistoryTruncate: () => {
        try {
          this.onTruncate(browser, sh);
        } catch (e) {
          console.error("Whimsy: trails", e);
        }
      },
    };
    // The record keeps the listener alive; session history holds it weakly.
    sh.addSHistoryListener(rec.listener);
  },

  onTruncate(browser, sh) {
    if (!this.enabled) {
      return;
    }
    const index = sh.index;
    const anchor = index >= 0 ? sh.getEntryAtIndex(index) : null;
    if (!anchor) {
      return;
    }
    const entries = [];
    for (let i = index + 1; i < sh.count && entries.length < MAX_ENTRIES; i++) {
      const entry = sh.getEntryAtIndex(i);
      const url = entry?.URI?.spec;
      if (isWebUrl(url) && entries.at(-1)?.url != url) {
        entries.push({ url, title: entry.title || "" });
      }
    }
    this.addBranch(browser, { anchorId: anchor.ID, anchorUrl: anchor.URI?.spec, entries });
  },

  addBranch(browser, branch) {
    if (!branch.entries.length) {
      return;
    }
    const rec = this.record(browser);
    // The same pages lost again from the same place replace the old branch.
    rec.branches = rec.branches.filter(
      b => !(b.anchorId == branch.anchorId && b.entries[0]?.url == branch.entries[0].url)
    );
    rec.branches.push(branch);
    if (rec.branches.length > MAX_BRANCHES) {
      rec.branches.splice(0, rec.branches.length - MAX_BRANCHES);
    }
  },

  branchesFor(browser) {
    const rec = this._records.get(browser);
    return rec && rec.generation == this._generation ? rec.branches : [];
  },

  rememberOrigin(tab) {
    const opener = tab.openerTab;
    const browser = opener?.linkedBrowser;
    const url = browser?.currentURI?.spec;
    if (!isWebUrl(url)) {
      return;
    }
    this._origins.set(tab, {
      url,
      title: opener.label || url,
      opener: new WeakRef(opener),
      generation: this._generation,
    });
  },

  originFor(tab) {
    const origin = this._origins.get(tab);
    return origin?.generation == this._generation ? origin : null;
  },

  // --- The menu ---

  isHistoryPopup(popup) {
    return (
      popup?.localName == "menupopup" &&
      (popup.id == "backForwardMenu" || ["back-button", "forward-button"].includes(popup.parentNode?.id))
    );
  },

  clearMenu(popup) {
    for (const node of [...popup.querySelectorAll(`.${ITEM_CLASS}`)]) {
      node.remove();
    }
  },

  makeRow(doc, { url, title, kind }) {
    const item = doc.createXULElement("menuitem");
    item.className = `${ITEM_CLASS} whimsy-trail-${kind} menuitem-iconic menuitem-with-favicon`;
    item.setAttribute("label", title || url);
    // Shown in the status bar on hover by FillHistoryMenu's listener.
    item.setAttribute("uri", url);
    item.dataset.whimsyTrailUrl = url;
    item.style.setProperty("--menuitem-icon", `url(page-icon:${CSS.escape(url)})`);
    return item;
  },

  onPopupShowing(win, event) {
    const popup = event.target;
    if (!this.isHistoryPopup(popup)) {
      return;
    }
    this.clearMenu(popup);
    if (!this.enabled || event.defaultPrevented) {
      return;
    }
    const doc = win.document;
    const tab = win.gBrowser.selectedTab;
    const browser = tab.linkedBrowser;
    const sh = browser.browsingContext?.sessionHistory;
    // Firefox's rows, by the session history entry each one stands for.
    const rows = new Map();
    for (const row of popup.querySelectorAll(":scope > menuitem[index]")) {
      const entry = sh?.getEntryAtIndex(Number(row.getAttribute("index")));
      if (entry) {
        rows.set(entry.ID, row);
      }
    }
    let budget = MENU_ROWS;
    const strays = [];
    // Newest branches first; each sits right above the page it left from,
    // where its forward pages used to be (the menu lists newest at the top).
    for (const branch of [...this.branchesFor(browser)].reverse()) {
      if (budget <= 0) {
        break;
      }
      const entries = branch.entries.slice(0, budget);
      budget -= entries.length;
      const anchor = rows.get(branch.anchorId);
      if (!anchor) {
        strays.push(entries);
        continue;
      }
      for (const entry of [...entries].reverse()) {
        anchor.before(this.makeRow(doc, { ...entry, kind: "branch" }));
      }
    }
    // Branches whose page has scrolled out of the menu, then where the tab
    // came from, at the bottom (the oldest end of the trail).
    const origin = this.originFor(tab);
    if (strays.length || origin) {
      const separator = doc.createXULElement("menuseparator");
      separator.className = ITEM_CLASS;
      popup.append(separator);
    }
    for (const entries of strays) {
      for (const entry of [...entries].reverse()) {
        popup.append(this.makeRow(doc, { ...entry, kind: "branch" }));
      }
    }
    if (origin) {
      const row = this.makeRow(doc, { url: origin.url, title: origin.title, kind: "origin" });
      row.removeAttribute("label");
      doc.l10n.setAttributes(row, "whimsy-trail-origin", { title: origin.title });
      popup.append(row);
    }
    const branchRows = popup.querySelectorAll(".whimsy-trail-branch");
    if (branchRows.length) {
      doc.l10n.formatValue("whimsy-trail-branch-tooltip").then(text => {
        for (const row of branchRows) {
          row.setAttribute("tooltiptext", text);
        }
      });
    }
  },

  onCommand(win, event) {
    const item = event.target;
    if (!item?.classList?.contains(ITEM_CLASS) || !item.dataset.whimsyTrailUrl) {
      return;
    }
    event.stopPropagation();
    const url = item.dataset.whimsyTrailUrl;
    const tab = win.gBrowser.selectedTab;
    if (item.classList.contains("whimsy-trail-origin")) {
      const opener = this.originFor(tab)?.opener.deref();
      if (opener?.isConnected && !opener.closing && opener.linkedBrowser?.currentURI?.spec == url) {
        win.gZenWorkspaces?.switchTabIfNeeded
          ? win.gZenWorkspaces.switchTabIfNeeded(opener)
          : (win.gBrowser.selectedTab = opener);
        return;
      }
      this.open(win, tab, url, "tab");
      return;
    }
    this.open(win, tab, url, lazy.BrowserUtils.whereToOpenLink(lazy.BrowserUtils.getRootEvent(event)));
  },

  // Opens a trail page with the tab's container. Going back to a branch in
  // the same tab makes it the trail again, so the branch row goes (and the
  // pages it replaces become a branch in turn).
  open(win, tab, url, where) {
    if (!isWebUrl(url)) {
      return;
    }
    // A private tab in a normal window keeps its pages to itself.
    if (
      lazy.PrivateBrowsingUtils.isBrowserPrivate(tab.linkedBrowser) &&
      !lazy.PrivateBrowsingUtils.isWindowPrivate(win)
    ) {
      where = "current";
    }
    if (where == "current") {
      const rec = this._records.get(tab.linkedBrowser);
      if (rec) {
        for (const branch of rec.branches) {
          branch.entries = branch.entries.filter(e => e.url != url);
        }
        rec.branches = rec.branches.filter(b => b.entries.length);
      }
    }
    win.openTrustedLinkIn(url, where, { userContextId: tab.userContextId });
  },
};
