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
// W10-54 (the user: "three links nested"): the long-press / right-click on
// Back or Forward opens a drawn trail instead of the native menu: a
// WhimsySurface with the tab's pages on a rail (ahead, "You're here", back),
// each branch hanging off the page it left with a curved connector and
// "You went back from", and "Opened from" at the end. Switch the feature off
// and the native menu comes back.
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
  WhimsySurface: "resource:///modules/whimsy/WhimsySurface.sys.mjs",
});

const FEATURE_PREF = "whimsy.feature.trails";
const SHEET = "chrome://browser/content/whimsy/whimsy-navigation.css";
// Per tab: the newest branches, and the pages kept per branch.
const MAX_BRANCHES = 8;
const MAX_ENTRIES = 10;
// Rows the menu shows at most, so it stays a small tree.
const MENU_ROWS = 12;
const ITEM_CLASS = "whimsy-trail-item";
const PANEL_ID = "whimsy-trail";
const PANEL_WIDTH = 320;
const HTML_NS = "http://www.w3.org/1999/xhtml";

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
    this.addBranch(browser, { anchorId: anchor.ID, anchorUrl: anchor.URI?.spec, entries, time: Date.now() });
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
    // W10-54: the drawn trail instead of the native menu.
    if (popup.id == "backForwardMenu" || popup.parentNode?.id == "back-button" || popup.parentNode?.id == "forward-button") {
      const button = popup.triggerNode?.closest?.("#back-button, #forward-button") ??
        (["back-button", "forward-button"].includes(popup.parentNode?.id) ? popup.parentNode : null) ??
        win.document.getElementById("back-button");
      if (this.openTrail(win, button)) {
        event.preventDefault();
        return;
      }
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

  // --- The drawn trail (W10-54) ---

  /**
   * The rows of the selected tab's trail, top to bottom: forward pages
   * (newest first), the current page, back pages, each followed by the
   * branches that left from it; then where the tab came from.
   */
  trailOf(win) {
    const tab = win.gBrowser.selectedTab;
    const browser = tab.linkedBrowser;
    const sh = browser.browsingContext?.sessionHistory;
    const rows = [];
    if (!sh || sh.count < 1) {
      return { rows, origin: this.originFor(tab) };
    }
    const branches = this.branchesFor(browser);
    const index = sh.index;
    let budget = MENU_ROWS;
    for (let i = sh.count - 1; i >= 0 && budget > 0; i--) {
      const entry = sh.getEntryAtIndex(i);
      if (!entry) {
        continue;
      }
      const url = entry.URI?.spec ?? "";
      rows.push({
        kind: i == index ? "here" : i > index ? "ahead" : "back",
        index: i,
        steps: Math.abs(i - index),
        url,
        title: entry.title || url,
      });
      budget--;
      // Branches hang below the page they left from.
      for (const branch of [...branches].reverse()) {
        if (branch.anchorId != entry.ID || budget <= 0) {
          continue;
        }
        rows.push({ kind: "caption" });
        for (const page of branch.entries.slice(0, budget)) {
          rows.push({ kind: "branch", url: page.url, title: page.title || page.url, time: branch.time });
          budget--;
        }
      }
    }
    // Branches whose page isn't in the list any more come at the end.
    const shown = new Set(rows.filter(r => r.kind == "branch").map(r => r.url));
    for (const branch of [...branches].reverse()) {
      const pages = branch.entries.filter(p => !shown.has(p.url));
      if (!pages.length || budget <= 0 ||
        [...Array(sh.count).keys()].some(i => sh.getEntryAtIndex(i)?.ID == branch.anchorId)) {
        continue;
      }
      rows.push({ kind: "caption" });
      for (const page of pages.slice(0, budget)) {
        rows.push({ kind: "branch", url: page.url, title: page.title || page.url, time: branch.time });
        budget--;
      }
    }
    return { rows, origin: this.originFor(tab) };
  },

  hostOf(url) {
    try {
      return Services.io.newURI(url).displayHost;
    } catch {
      return "";
    }
  },

  ago(time) {
    if (!time) {
      return "";
    }
    const rtf = new Intl.RelativeTimeFormat(Services.locale.appLocaleAsBCP47, { numeric: "auto", style: "short" });
    const minutes = Math.round((time - Date.now()) / 60000);
    if (Math.abs(minutes) < 60) {
      return rtf.format(Math.min(0, minutes), "minute");
    }
    const hours = Math.round(minutes / 60);
    return Math.abs(hours) < 24 ? rtf.format(hours, "hour") : rtf.format(Math.round(hours / 24), "day");
  },

  /** Opens the drawn trail under `button`. Returns the panel, or null. */
  openTrail(win, button = null) {
    if (!this.enabled) {
      return null;
    }
    const doc = win.document;
    const tab = win.gBrowser.selectedTab;
    const { rows, origin } = this.trailOf(win);
    if (!rows.length && !origin) {
      return null;
    }
    const parts = lazy.WhimsySurface.create(win, {
      id: PANEL_ID,
      width: PANEL_WIDTH,
      className: "whimsy-trail",
      initialFocus: () => {
        const here = list.querySelector(".whimsy-trail-row.here");
        let next = here?.nextElementSibling;
        while (next && !next.matches("[role=option]")) {
          next = next.nextElementSibling;
        }
        return next ?? list.querySelector("[role=option]");
      },
    });
    const { panel, view } = parts;
    const { caption } = lazy.WhimsySurface.caption(doc, { l10nId: "whimsy-trail-heading", id: `${PANEL_ID}-title` });
    caption.classList.add("whimsy-trail-heading");
    panel.setAttribute("aria-labelledby", `${PANEL_ID}-title`);

    const list = doc.createElementNS(HTML_NS, "div");
    list.className = "whimsy-trail-list";
    list.setAttribute("role", "listbox");
    list.setAttribute("aria-labelledby", `${PANEL_ID}-title`);
    const trailRows = rows.filter(r => r.kind != "branch" && r.kind != "caption");
    const firstTrail = trailRows[0];
    const lastTrail = trailRows.at(-1);

    const act = (row, event) => {
      const where = event && (event.button == 1 || event.metaKey || event.ctrlKey) ? "tab" : "current";
      lazy.WhimsySurface.close(panel);
      if (row.kind == "branch") {
        this.open(win, tab, row.url, where);
      } else if (row.kind == "origin") {
        this.goToOrigin(win, tab, row.url);
      } else if (where == "tab") {
        this.open(win, tab, row.url, "tab");
      } else if (row.kind != "here") {
        win.gBrowser.gotoIndex(row.index);
      }
    };
    const option = row => {
      const el = doc.createElementNS(HTML_NS, "div");
      el.className = `whimsy-trail-row ${row.kind}`;
      if (row == firstTrail) {
        el.classList.add("first");
      }
      if (row == lastTrail) {
        el.classList.add("last");
      }
      el.setAttribute("role", "option");
      el.setAttribute("aria-selected", row.kind == "here" ? "true" : "false");
      el.tabIndex = -1;
      el.dataset.whimsyTrailUrl = row.url;
      if (row.index != null) {
        el.dataset.index = String(row.index);
      }
      const rail = doc.createElementNS(HTML_NS, "span");
      rail.className = "whimsy-trail-rail";
      rail.setAttribute("aria-hidden", "true");
      const icon = doc.createElementNS(HTML_NS, "img");
      icon.className = "whimsy-trail-favicon";
      icon.alt = "";
      if (isWebUrl(row.url)) {
        icon.src = `page-icon:${row.url}`;
      }
      const text = doc.createElementNS(HTML_NS, "span");
      text.className = "whimsy-trail-text";
      const title = doc.createElementNS(HTML_NS, "span");
      title.className = "whimsy-trail-title";
      const sub = doc.createElementNS(HTML_NS, "span");
      sub.className = "whimsy-trail-sub";
      if (row.kind == "here") {
        doc.l10n.setAttributes(title, "whimsy-trail-here");
        sub.textContent = row.title;
      } else if (row.kind == "origin") {
        doc.l10n.setAttributes(title, "whimsy-trail-origin-text", { title: row.title });
        sub.textContent = this.hostOf(row.url);
      } else {
        title.textContent = row.title;
        sub.textContent = [this.hostOf(row.url), row.kind == "branch" ? this.ago(row.time) : ""].filter(Boolean).join(" · ");
      }
      title.title = row.title;
      text.append(title, sub);
      const trailing = doc.createElementNS(HTML_NS, "span");
      trailing.className = "whimsy-trail-steps";
      if (row.kind == "back" || row.kind == "ahead") {
        doc.l10n.setAttributes(trailing, `whimsy-trail-steps-${row.kind}`, { count: row.steps });
      }
      el.append(rail, icon, text, trailing);
      el.addEventListener("click", event => act(row, event));
      el.addEventListener("auxclick", event => {
        if (event.button == 1) {
          act(row, event);
        }
      });
      el.addEventListener("keydown", event => {
        if (event.key == "Enter" || event.key == " ") {
          event.preventDefault();
          act(row, event);
        }
      });
      return el;
    };
    for (const row of rows) {
      if (row.kind == "caption") {
        const cap = doc.createElementNS(HTML_NS, "div");
        cap.className = "whimsy-trail-branch-caption";
        cap.setAttribute("role", "presentation");
        doc.l10n.setAttributes(cap, "whimsy-trail-branch-caption");
        list.append(cap);
        continue;
      }
      list.append(option(row));
    }
    view.append(caption, list);
    if (origin) {
      view.append(lazy.WhimsySurface.rule(doc));
      const originList = doc.createElementNS(HTML_NS, "div");
      originList.className = "whimsy-trail-list whimsy-trail-origin-list";
      originList.setAttribute("role", "listbox");
      originList.append(option({ kind: "origin", url: origin.url, title: origin.title }));
      view.append(originList);
    }
    lazy.WhimsySurface.finish(parts);
    // One tab stop per list: the row that takes focus, and the origin.
    parts.panel.querySelector(".whimsy-trail-origin-list [role=option]")?.setAttribute("tabindex", "0");
    const here = list.querySelector(".whimsy-trail-row.here");
    let start = here?.nextElementSibling;
    while (start && !start.matches("[role=option]")) {
      start = start.nextElementSibling;
    }
    (start ?? list.querySelector("[role=option]"))?.setAttribute("tabindex", "0");
    const anchor = button?.isConnected ? button : doc.getElementById("back-button");
    if (anchor && lazy.WhimsySurface.visibleAnchor(win, [anchor])) {
      lazy.WhimsySurface.open(win, panel, { anchor, position: "after_start", y: 4 });
    } else {
      lazy.WhimsySurface.open(win, panel, { at: "page-top-center" });
    }
    return panel;
  },

  goToOrigin(win, tab, url) {
    const opener = this.originFor(tab)?.opener.deref();
    if (opener?.isConnected && !opener.closing && opener.linkedBrowser?.currentURI?.spec == url) {
      win.gZenWorkspaces?.switchTabIfNeeded
        ? win.gZenWorkspaces.switchTabIfNeeded(opener)
        : (win.gBrowser.selectedTab = opener);
      return;
    }
    this.open(win, tab, url, "tab");
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
      this.goToOrigin(win, tab, url);
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
