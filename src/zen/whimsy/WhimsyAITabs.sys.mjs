/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// AI v1, part 1: Arc Max's Tidy Tabs and tidy tab titles.
//
// Tidy Tabs (Arc parity): hovering the line between pinned and Today tabs
// shows a broom next to "Clear" once a space has more than six Today tabs.
// Clicking it sorts that space's Today tabs into named sections, each under
// a small header, still in Today (pinned tabs, Essentials and folders are
// never touched). New tabs open above the sections, unsorted; clicking the
// broom again sorts everything again. A header's names can't be edited.
// Hovering a header offers "Move to Folder" (the section becomes a pinned
// folder) and "Close"; right-clicking it also offers "Remove Header", which
// keeps the tabs. Dragging a tab into a section joins it; dragging it above
// the first header leaves it.
//
// Tidy tab titles (Arc parity): only pinning renames a tab. A tab being
// pinned gets a short name ("Inbox – me@example.com – Gmail" → "Gmail
// Inbox"), stored like a manual rename, so it persists and double-click
// still renames it. Today tabs keep the page's own title, and a name the
// person typed is never touched.
//
// Both only run once the chosen AI provider is set up, and stop with the
// AI kill switch.

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  PrivateBrowsingUtils: "resource://gre/modules/PrivateBrowsingUtils.sys.mjs",
  SessionStore: "resource:///modules/sessionstore/SessionStore.sys.mjs",
  WhimsyAIProviders: "resource:///modules/whimsy/WhimsyAIProviders.sys.mjs",
});

const TIDY_PREF = "whimsy.feature.tidy-tabs";
const TITLES_PREF = "whimsy.feature.tidy-titles";
// Arc: Tidy Tabs needs more than six Today tabs.
export const MIN_TIDY_TABS = 7;
const SECTION_ATTR = "whimsy-tidy-section";
const NAME_ATTR = "whimsy-tidy-name";
const STORE_KEY = "whimsy-tidy";
const HEADER_CLASS = "whimsy-tidy-header";
const BROOM_CLASS = "whimsy-tidy-broom";
const MENU_ID = "whimsy-tidy-header-menu";
// Node.DOCUMENT_POSITION_FOLLOWING (no Node global in a system module).
const Node_FOLLOWING = 4;
const TITLE_CACHE_MAX = 300;
const MIN_TITLE_LENGTH = 24;

const TIDY_SYSTEM =
  "You organize a person's open browser tabs into a few topic sections, like Arc's Tidy Tabs. " +
  "Reply with JSON only.";
const TITLE_SYSTEM =
  "You shorten web page titles into short browser tab names, like Arc's Tidy Tab Titles. " +
  "Reply with the name only: no quotes, no punctuation at the end.";

// Short titles by "title\nhost", shared by every window.
const titleCache = new Map();
const windows = new WeakMap();

export const WhimsyAITabs = {
  get tidyEnabled() {
    return Services.prefs.getBoolPref(TIDY_PREF, true) && lazy.WhimsyAIProviders.enabled;
  },

  get titlesEnabled() {
    return Services.prefs.getBoolPref(TITLES_PREF, true) && lazy.WhimsyAIProviders.enabled;
  },

  // Always installed: every part checks its switches on use, so the kill
  // switch and the Settings toggles apply without a restart.
  initWindow(win) {
    if (windows.has(win)) {
      return;
    }
    const state = { renderQueued: false };
    windows.set(win, state);
    const container = win.gBrowser.tabContainer;
    const render = () => this.queueRender(win);
    for (const type of ["TabClose", "TabPinned", "TabUnpinned", "TabShow", "TabHide", "TabGrouped"]) {
      container.addEventListener(type, render);
    }
    container.addEventListener("TabOpen", event => this.onTabOpen(win, event.target));
    container.addEventListener("TabMove", event => this.onTabMove(win, event.target));
    container.addEventListener("TabPinned", event => this.onTabPinned(event.target));
    container.addEventListener("SSTabRestoring", event => this.restoreSection(win, event.target));
    win.addEventListener("ZenWorkspacesUIUpdate", render);
    win.addEventListener("TabSelect", render);
    const prefs = [TIDY_PREF, "whimsy.ai.blocked", "whimsy.feature.ai-providers"];
    for (const pref of prefs) {
      Services.prefs.addObserver(pref, render);
    }
    win.addEventListener(
      "unload",
      () => {
        for (const pref of prefs) {
          Services.prefs.removeObserver(pref, render);
        }
      },
      { once: true }
    );
    for (const tab of win.gBrowser.tabs) {
      this.restoreSection(win, tab, { render: false });
    }
    this.queueRender(win);
  },

  // ---- Today tabs and sections ----

  isTodayTab(tab) {
    return (
      tab?.localName == "tab" &&
      !lazy.PrivateBrowsingUtils.isBrowserPrivate(tab.linkedBrowser) &&
      !tab.pinned &&
      !tab.closing &&
      !tab.hasAttribute("zen-essential") &&
      !tab.hasAttribute("zen-empty-tab") &&
      !tab.hasAttribute("zen-glance-tab") &&
      !tab.group
    );
  },

  // A space's Today tabs, top to bottom.
  todayTabs(win, spaceId = win.gZenWorkspaces?.activeWorkspace) {
    const strip = spaceId ? win.gZenWorkspaces?.workspaceElement(spaceId)?.tabsContainer : null;
    const children = strip ? [...strip.children] : win.gBrowser.tabs;
    return children.filter(tab => this.isTodayTab(tab));
  },

  sectionOf(tab) {
    return this.isTodayTab(tab) ? tab.getAttribute(SECTION_ATTR) || null : null;
  },

  setSection(tab, section) {
    if (section) {
      tab.setAttribute(SECTION_ATTR, section.id);
      tab.setAttribute(NAME_ATTR, section.name);
      lazy.SessionStore.setCustomTabValue(tab, STORE_KEY, JSON.stringify(section));
    } else if (tab.hasAttribute(SECTION_ATTR)) {
      tab.removeAttribute(SECTION_ATTR);
      tab.removeAttribute(NAME_ATTR);
      try {
        lazy.SessionStore.deleteCustomTabValue(tab, STORE_KEY);
      } catch {}
    }
  },

  restoreSection(win, tab, { render = true } = {}) {
    let saved;
    try {
      saved = JSON.parse(lazy.SessionStore.getCustomTabValue(tab, STORE_KEY) || "null");
    } catch {}
    if (saved?.id && saved.name && !tab.hasAttribute(SECTION_ATTR)) {
      tab.setAttribute(SECTION_ATTR, saved.id);
      tab.setAttribute(NAME_ATTR, saved.name);
      if (render) {
        this.queueRender(win);
      }
    }
  },

  // The tab element before/after `tab` in its strip, skipping headers.
  neighborTab(tab, forward) {
    let el = forward ? tab.nextElementSibling : tab.previousElementSibling;
    while (el && el.classList?.contains(HEADER_CLASS)) {
      el = forward ? el.nextElementSibling : el.previousElementSibling;
    }
    return el?.localName == "tab" ? el : null;
  },

  // A new tab joins a section only when it opens between two of its tabs
  // (a link opened from inside it). Otherwise it goes above the sections
  // (Arc: "new tabs appear separately, towards the top"). Done after the
  // TabOpen handlers, so Zen has put the tab in its space first.
  onTabOpen(win, tab) {
    const state = windows.get(win);
    if (!this.tidyEnabled || state?.reordering) {
      return;
    }
    win.setTimeout(() => {
      if (!this.tidyEnabled) {
        return;
      }
      // Session restore brings its section back; leave restored tabs be.
      this.restoreSection(win, tab, { render: false });
      if (
        tab.closing ||
        !tab.isConnected ||
        !this.isTodayTab(tab) ||
        tab.hasAttribute(SECTION_ATTR) ||
        tab.hasAttribute("pending")
      ) {
        this.queueRender(win);
        return;
      }
      const before = this.neighborTab(tab, false);
      const after = this.neighborTab(tab, true);
      const id = this.sectionOf(before);
      if (id && id == this.sectionOf(after)) {
        this.setSection(tab, { id, name: before.getAttribute(NAME_ATTR) });
      } else {
        this.moveAboveSections(win, tab);
      }
      this.queueRender(win);
    }, 0);
  },

  // Moves a loose tab that landed below a section's header up above the
  // first section in its strip.
  moveAboveSections(win, tab) {
    const strip = tab.parentNode;
    const firstHeader = strip?.querySelector(`:scope > .${HEADER_CLASS}`);
    if (!firstHeader || !(firstHeader.compareDocumentPosition(tab) & Node_FOLLOWING)) {
      return;
    }
    const firstMember = this.neighborTab(firstHeader, true);
    if (!firstMember || firstMember == tab) {
      return;
    }
    const state = windows.get(win);
    if (state) {
      state.reordering = true;
    }
    try {
      win.gBrowser.moveTabBefore(tab, firstMember);
    } finally {
      if (state) {
        state.reordering = false;
      }
    }
  },

  // A dragged tab joins the section it lands in: right under a header, or
  // after one of a section's tabs. Above the first header, it leaves.
  onTabMove(win, tab) {
    const state = windows.get(win);
    if (!this.tidyEnabled || state?.reordering || !this.isTodayTab(tab)) {
      this.queueRender(win);
      return;
    }
    const prev = tab.previousElementSibling;
    let section = null;
    if (prev?.classList?.contains(HEADER_CLASS)) {
      section = { id: prev.getAttribute(SECTION_ATTR), name: prev.getAttribute(NAME_ATTR) };
    } else if (this.sectionOf(prev)) {
      section = { id: prev.getAttribute(SECTION_ATTR), name: prev.getAttribute(NAME_ATTR) };
    }
    this.setSection(tab, section);
    this.queueRender(win);
  },

  queueRender(win) {
    const state = windows.get(win);
    if (!state || state.renderQueued || win.closed) {
      return;
    }
    state.renderQueued = true;
    win.requestAnimationFrame(() => {
      state.renderQueued = false;
      try {
        this.render(win);
      } catch (error) {
        console.error("Whimsy: Tidy Tabs", error);
      }
    });
  },

  // Puts a header above each section's first tab, removes headers whose
  // section is gone, and shows each space's broom when it can tidy.
  render(win) {
    const doc = win.document;
    if (!this.tidyEnabled) {
      // Keep saved membership for re-enabling, but remove interactive headers.
      doc.querySelectorAll(`.${HEADER_CLASS}`).forEach(header => header.remove());
      for (const separator of doc.querySelectorAll(".pinned-tabs-container-separator")) {
        this.updateBroom(win, separator);
      }
      return;
    }
    const sections = new Map();
    for (const tab of win.gBrowser.tabs) {
      const id = this.sectionOf(tab);
      if (!id) {
        // Pinned or grouped since: no longer in a section.
        if (tab.hasAttribute(SECTION_ATTR)) {
          this.setSection(tab, null);
        }
        continue;
      }
      if (!sections.has(id)) {
        sections.set(id, { id, name: tab.getAttribute(NAME_ATTR), tabs: [] });
      }
      sections.get(id).tabs.push(tab);
    }
    for (const header of [...doc.querySelectorAll(`.${HEADER_CLASS}`)]) {
      if (!sections.has(header.getAttribute(SECTION_ATTR))) {
        header.remove();
      }
    }
    for (const section of sections.values()) {
      const first = section.tabs[0];
      let header = doc.querySelector(`.${HEADER_CLASS}[${SECTION_ATTR}="${win.CSS.escape(section.id)}"]`);
      header ??= this.createHeader(win, section);
      if (first.previousElementSibling != header) {
        first.before(header);
      }
    }
    for (const separator of doc.querySelectorAll(".pinned-tabs-container-separator")) {
      this.updateBroom(win, separator);
    }
  },

  createHeader(win, section) {
    const doc = win.document;
    const header = doc.createXULElement("hbox");
    header.className = HEADER_CLASS;
    header.setAttribute(SECTION_ATTR, section.id);
    header.setAttribute(NAME_ATTR, section.name);
    header.setAttribute("align", "center");
    header.setAttribute("context", MENU_ID);
    const label = doc.createXULElement("label");
    label.className = "whimsy-tidy-header-label";
    label.setAttribute("crop", "end");
    label.setAttribute("flex", "1");
    label.setAttribute("value", section.name);
    const toFolder = doc.createXULElement("toolbarbutton");
    toFolder.className = "whimsy-tidy-header-button whimsy-tidy-header-folder";
    doc.l10n.setAttributes(toFolder, "whimsy-tidy-header-folder");
    toFolder.addEventListener("command", () => this.sectionToFolder(win, section.id));
    const close = doc.createXULElement("toolbarbutton");
    close.className = "whimsy-tidy-header-button whimsy-tidy-header-close";
    doc.l10n.setAttributes(close, "whimsy-tidy-header-close");
    close.addEventListener("command", () => this.closeSection(win, section.id));
    header.append(label, toFolder, close);
    this.ensureMenu(win);
    return header;
  },

  ensureMenu(win) {
    const doc = win.document;
    if (doc.getElementById(MENU_ID)) {
      return;
    }
    const menu = doc.createXULElement("menupopup");
    menu.id = MENU_ID;
    const items = [
      ["whimsy-tidy-menu-remove-header", id => this.removeHeader(win, id)],
      ["whimsy-tidy-menu-folder", id => this.sectionToFolder(win, id)],
      ["whimsy-tidy-menu-close", id => this.closeSection(win, id)],
    ];
    for (const [l10nId, command] of items) {
      const item = doc.createXULElement("menuitem");
      doc.l10n.setAttributes(item, l10nId);
      item.addEventListener("command", () => {
        const id = menu.triggerNode?.closest?.(`.${HEADER_CLASS}`)?.getAttribute(SECTION_ATTR);
        if (id) {
          command(id);
        }
      });
      menu.append(item);
    }
    doc.getElementById("mainPopupSet").append(menu);
  },

  sectionTabs(win, id) {
    return win.gBrowser.tabs.filter(tab => this.sectionOf(tab) == id);
  },

  // Arc's "Remove header": the tabs stay where they are.
  removeHeader(win, id) {
    for (const tab of this.sectionTabs(win, id)) {
      this.setSection(tab, null);
    }
    this.queueRender(win);
  },

  // Arc: a section can become a folder, which lives with the pinned tabs.
  sectionToFolder(win, id) {
    const tabs = this.sectionTabs(win, id);
    if (!tabs.length || !win.gZenFolders) {
      return null;
    }
    const name = tabs[0].getAttribute(NAME_ATTR);
    const workspaceId = tabs[0].getAttribute("zen-workspace-id") || win.gZenWorkspaces?.activeWorkspace;
    for (const tab of tabs) {
      this.setSection(tab, null);
    }
    const folder = win.gZenFolders.createFolder(tabs, { label: name, renameFolder: false, workspaceId });
    this.queueRender(win);
    return folder;
  },

  closeSection(win, id) {
    const tabs = this.sectionTabs(win, id);
    if (tabs.length) {
      win.gBrowser.removeTabs(tabs);
    }
  },

  // ---- The broom ----

  updateBroom(win, separator) {
    const doc = win.document;
    let broom = separator.querySelector(`.${BROOM_CLASS}`);
    const spaceId = separator.closest("zen-workspace")?.id;
    const show =
      this.tidyEnabled &&
      !lazy.PrivateBrowsingUtils.isWindowPrivate(win) &&
      !!spaceId &&
      this.todayTabs(win, spaceId).length >= MIN_TIDY_TABS;
    if (!broom) {
      if (!show) {
        return;
      }
      broom = doc.createXULElement("toolbarbutton");
      broom.className = BROOM_CLASS;
      doc.l10n.setAttributes(broom, "whimsy-tidy-broom");
      broom.addEventListener("command", () => {
        this.tidy(win, separator.closest("zen-workspace")?.id).catch(error =>
          console.error("Whimsy: Tidy Tabs", error)
        );
      });
      const clear = separator.querySelector(".zen-workspace-close-unpinned-tabs-button");
      if (clear) {
        clear.before(broom);
      } else {
        separator.append(broom);
      }
    }
    broom.hidden = !show;
  },

  // ---- Tidying ----

  /**
   * Sorts a space's Today tabs into sections.
   *
   * @returns {Promise<{ sections: number, tabs: number } | null>}
   */
  async tidy(win, spaceId = win.gZenWorkspaces?.activeWorkspace) {
    if (!this.tidyEnabled) {
      return null;
    }
    const state = windows.get(win);
    if (state?.tidying) {
      return null;
    }
    const tabs = this.todayTabs(win, spaceId);
    if (tabs.length < MIN_TIDY_TABS) {
      win.gZenUIManager?.showToast("whimsy-tidy-too-few", { l10nArgs: { count: MIN_TIDY_TABS } });
      return null;
    }
    const brooms = [...win.document.querySelectorAll(`.${BROOM_CLASS}`)].filter(
      b => b.closest("zen-workspace")?.id == spaceId
    );
    if (state) {
      state.tidying = true;
    }
    brooms.forEach(b => b.setAttribute("tidying", "true"));
    try {
      const list = tabs
        .map((tab, i) => {
          const url = tab.linkedBrowser?.currentURI;
          let where = "";
          try {
            where = url?.host ? `${url.host}${url.filePath.slice(0, 60)}` : url?.spec.slice(0, 80) || "";
          } catch {}
          const name = tab.zenStaticLabel || tab.label;
          const was = tab.getAttribute(NAME_ATTR);
          return `${i}. ${name.slice(0, 120)} (${where})${was ? ` [was in "${was}"]` : ""}`;
        })
        .join("\n");
      const prompt =
        `Group these ${tabs.length} tabs into between 2 and 6 sections by topic or task.\n` +
        "Each section needs at least 2 tabs. Leave out a tab that fits nowhere.\n" +
        "Name each section in 1 to 3 words, Title Case, no emoji. Keep a previous name when it still fits.\n" +
        'Reply as JSON: {"sections": [{"name": "Trip Planning", "tabs": [0, 4, 5]}]}\n\n' +
        lazy.WhimsyAIProviders.clip(list);
      const answer = await lazy.WhimsyAIProviders.completeJSON({ system: TIDY_SYSTEM, prompt, maxTokens: 800 });
      if (!this.tidyEnabled) {
        return null;
      }
      const sections = this.parseSections(answer, tabs);
      if (!sections.length) {
        throw Object.assign(new Error("No sections"), { code: "bad-response" });
      }
      // The tabs may have closed, moved or been pinned while we waited.
      const current = new Set(this.todayTabs(win, spaceId));
      for (const section of sections) {
        section.tabs = section.tabs.filter(tab => current.has(tab));
      }
      const kept = sections.filter(s => s.tabs.length >= 2);
      this.applySections(win, [...current], kept);
      const count = kept.reduce((n, s) => n + s.tabs.length, 0);
      win.gZenUIManager?.showToast("whimsy-tidy-done", { l10nArgs: { sections: kept.length, tabs: count } });
      return { sections: kept.length, tabs: count };
    } catch (error) {
      this.showError(win, error);
      return null;
    } finally {
      if (state) {
        state.tidying = false;
      }
      brooms.forEach(b => b.removeAttribute("tidying"));
    }
  },

  // The model's answer, checked: known tabs only, each in one section,
  // sections of two or more, short names.
  parseSections(answer, tabs) {
    const raw = Array.isArray(answer) ? answer : answer?.sections;
    if (!Array.isArray(raw)) {
      return [];
    }
    const used = new Set();
    const sections = [];
    const stamp = Date.now().toString(36);
    for (const entry of raw.slice(0, 8)) {
      const name = cleanName(entry?.name, 32);
      const members = [];
      for (const index of Array.isArray(entry?.tabs) ? entry.tabs : []) {
        const tab = tabs[Number(index)];
        if (tab && !used.has(tab)) {
          used.add(tab);
          members.push(tab);
        }
      }
      if (name && members.length >= 2) {
        members.sort((a, b) => tabs.indexOf(a) - tabs.indexOf(b));
        sections.push({ id: `${stamp}-${sections.length}`, name, tabs: members });
      }
    }
    // Sections in the order their first tab was in.
    sections.sort((a, b) => tabs.indexOf(a.tabs[0]) - tabs.indexOf(b.tabs[0]));
    return sections;
  },

  // Loose tabs first (where new tabs open), then each section.
  applySections(win, tabs, sections) {
    const state = windows.get(win);
    const inSection = new Set(sections.flatMap(s => s.tabs));
    const loose = tabs.filter(tab => !inSection.has(tab));
    const order = [...loose, ...sections.flatMap(s => s.tabs)];
    const gBrowser = win.gBrowser;
    if (state) {
      state.reordering = true;
    }
    try {
      for (const tab of loose) {
        this.setSection(tab, null);
      }
      for (const section of sections) {
        for (const tab of section.tabs) {
          this.setSection(tab, { id: section.id, name: section.name });
        }
      }
      const top = tabs[0];
      if (order[0] != top) {
        gBrowser.moveTabBefore(order[0], top);
      }
      for (let i = 1; i < order.length; i++) {
        if (this.neighborTab(order[i - 1], true) != order[i]) {
          gBrowser.moveTabAfter(order[i], order[i - 1]);
        }
      }
    } finally {
      if (state) {
        state.reordering = false;
      }
    }
    this.render(win);
  },

  // ---- Tidy tab titles ----

  async shortTitleFor(tab, { signal } = {}) {
    const title = tab.label || "";
    let host = "";
    try {
      host = tab.linkedBrowser.currentURI.host;
    } catch {}
    const key = `${title}\n${host}`;
    if (titleCache.has(key)) {
      return titleCache.get(key);
    }
    const prompt =
      "Shorten this tab title to 1 to 4 words (at most 28 characters). Keep what tells the page apart " +
      "(the product, person, document or topic); drop site names, separators, counters and filler " +
      "unless the site name is all there is.\n" +
      `Title: ${title.slice(0, 200)}\nSite: ${host}`;
    const text = await lazy.WhimsyAIProviders.complete({ system: TITLE_SYSTEM, prompt, maxTokens: 40, signal });
    const short = cleanName(text.split("\n")[0], 40);
    const result = short && short.length < title.length ? short : null;
    titleCache.set(key, result);
    if (titleCache.size > TITLE_CACHE_MAX) {
      titleCache.delete(titleCache.keys().next().value);
    }
    return result;
  },

  // Arc's Tidy Tab Titles: a tab being pinned gets a short name.
  onTabPinned(tab) {
    const win = tab.ownerGlobal;
    if (!windows.has(win) || !this.titlesEnabled || tab.zenStaticLabel || tab.hasAttribute("zen-essential")) {
      return;
    }
    const title = tab.label;
    const apply = short => {
      // Unpinned, renamed by hand or navigated while we asked: leave it.
      if (short && tab.pinned && !tab.closing && !tab.zenStaticLabel && tab.label == title && this.titlesEnabled) {
        tab.zenStaticLabel = short;
        tab.ownerGlobal.gBrowser._setTabLabel(tab, short, { _zenChangeLabelFlag: true });
      }
    };
    const uri = tab.linkedBrowser?.currentURI;
    if (!uri || !/^https?$/.test(uri.scheme) || (tab.label || "").length < MIN_TITLE_LENGTH) {
      return;
    }
    if (lazy.WhimsyAIProviders.isCloud && lazy.PrivateBrowsingUtils.isBrowserPrivate(tab.linkedBrowser)) {
      return;
    }
    lazy.WhimsyAIProviders.isReady()
      .then(ready => (ready ? this.shortTitleFor(tab) : null))
      .then(apply)
      .catch(error => console.debug("Whimsy: tidy tab title", error));
  },

  showError(win, error) {
    lazy.WhimsyAIProviders.showError(win, error);
  },
};

function cleanName(value, max) {
  let name = String(value ?? "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/^[\s"'“”‘’`*#-]+|[\s"'“”‘’`*.:;,!-]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (name.length > max) {
    name = name.slice(0, max).trim();
  }
  return name;
}
