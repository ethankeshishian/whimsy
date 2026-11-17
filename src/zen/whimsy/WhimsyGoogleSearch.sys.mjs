/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { UrlbarProvider } from "moz-src:///browser/components/urlbar/UrlbarUtils.sys.mjs";
import { WhimsyConnectors } from "resource:///modules/whimsy/WhimsyConnectors.sys.mjs";
const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  UrlbarShared: "chrome://browser/content/urlbar/UrlbarShared.mjs",
  UrlbarResult: "chrome://browser/content/urlbar/UrlbarResult.mjs",
  ProvidersManager: "moz-src:///browser/components/urlbar/UrlbarProvidersManager.sys.mjs",
  BrowserWindowTracker: "resource:///modules/BrowserWindowTracker.sys.mjs",
  PrivateBrowsingUtils: "resource://gre/modules/PrivateBrowsingUtils.sys.mjs",
  WhimsyTabs: "resource:///modules/whimsy/WhimsyTabs.sys.mjs",
  WhimsyAIContext: "resource:///modules/whimsy/WhimsyAIContext.sys.mjs",
});
const TYPE = "whimsy-google-search";
const ENTRY = "whimsy-google-entry";
const states = new WeakMap();
const topWindow = () => lazy.BrowserWindowTracker.getTopWindow();
const on = () => WhimsyConnectors.enabled && Services.prefs.getBoolPref("whimsy.feature.google-search", true);
const allowed = win => !!win && on() && !lazy.PrivateBrowsingUtils.isWindowPrivate(win) && !lazy.WhimsyAIContext.isPrivate(win.gBrowser.selectedTab);
const icon = mode => `chrome://browser/content/whimsy/icons/${mode == "mail" ? "gmail" : "google-drive"}.svg`;
const configuration = accounts => JSON.stringify(accounts.map(a => [a.id, a.label, a.useInSearch, a.scopes]));
const identity = row => `${row.accountId}:${row.id}`;
const html = (doc, tag, cls, text) => {
  const el = doc.createElementNS("http://www.w3.org/1999/xhtml", tag);
  if (cls) {
    el.className = cls;
  }
  if (text !== undefined) {
    el.textContent = text;
  }
  return el;
};

export class WhimsyGoogleSearchProvider extends UrlbarProvider {
  get name() { return "WhimsyGoogleSearch"; }
  get type() { return lazy.UrlbarShared.PROVIDER_TYPE.PROFILE; }
  getPriority() { return states.has(topWindow()) ? 100 : 0; }
  isActive(context) {
    return !context.isPrivate && allowed(topWindow()) && (states.has(topWindow()) || (!context.searchMode && /^@(mail|drive)?$/i.test(context.searchString)));
  }
  async startQuery(context, add) {
    const win = topWindow();
    if (!this.isActive(context)) {
      return;
    }
    const state = states.get(win);
    if (!state) {
      for (const mode of ["mail", "drive"]) {
        if (`@${mode}`.startsWith(context.searchString.toLowerCase())) {
          add(this, new lazy.UrlbarResult({ type: lazy.UrlbarShared.RESULT_TYPE.DYNAMIC, source: lazy.UrlbarShared.RESULT_SOURCE.OTHER_LOCAL, payload: { dynamicType: ENTRY, mode } }));
        }
      }
      return;
    }
    add(this, new lazy.UrlbarResult({ type: lazy.UrlbarShared.RESULT_TYPE.DYNAMIC, source: lazy.UrlbarShared.RESULT_SOURCE.OTHER_LOCAL, payload: { dynamicType: TYPE } }));
    await WhimsyGoogleSearch.search(win, context.searchString);
  }
  cancelQuery() {
    states.get(topWindow())?.controller?.abort();
  }
  getViewTemplate(result) {
    return result.payload.dynamicType == ENTRY
      ? { attributes: { selectable: true }, children: [{ name: "icon", tag: "img", classList: ["urlbarView-favicon"] }, { name: "title", tag: "span", classList: ["urlbarView-title"] }] }
      : { attributes: { role: "presentation" }, children: [{ name: "list", tag: "div", classList: ["whimsy-google-results"] }] };
  }
  getViewUpdate(result) {
    if (result.payload.dynamicType == ENTRY) {
      return { icon: { attributes: { src: icon(result.payload.mode) } }, title: { l10n: { id: `whimsy-google-search-${result.payload.mode}` } } };
    }
    return {};
  }
  onEngagement(_context, _controller, details) {
    if (details.result?.payload.dynamicType == ENTRY) {
      const win = details.element?.documentGlobal ?? topWindow();
      win.setTimeout(() => WhimsyGoogleSearch.enter(win, details.result.payload.mode), 0);
    }
  }
}

export const WhimsyGoogleSearch = {
  provider: null,
  state: win => states.get(win),
  allowed,
  initWindow(win) {
    if (!this.provider) {
      this.provider = new WhimsyGoogleSearchProvider();
      lazy.ProvidersManager.getInstanceForSap("urlbar").registerProvider(this.provider);
    }
    const bar = win.gURLBar;
    const input = event => {
      if (!allowed(win)) {
        this.exit(win, false);
        return;
      }
      if (!states.has(win)) {
        const match = /^@(mail|drive)\s(.*)$/is.exec(bar.value);
        if (match) {
          this.enter(win, match[1].toLowerCase(), match[2]);
        }
      }
    };
    const key = event => this.onKey(win, event);
    bar.inputField.addEventListener("input", input, true);
    win.addEventListener("keydown", key, true);
    const observer = new win.MutationObserver(() => {
      const state = states.get(win);
      const node = bar.view.panel.querySelector(".whimsy-google-results");
      if (state && node && state.node != node) {
        state.node = node;
        this.render(win);
      }
    });
    observer.observe(bar.view.panel, { childList: true, subtree: true });
    bar.controller.addListener({ onViewClose: () => this.exit(win, false) });
    const changed = async () => {
      const state = states.get(win);
      if (!state) {
        return;
      }
      if (!allowed(win) || (state.configuration && state.configuration != configuration(await WhimsyConnectors.googleAccounts()))) {
        this.exit(win);
      }
    };
    const tabChanged = () => this.exit(win, false);
    Services.obs.addObserver(changed, "whimsy-connectors-changed");
    Services.prefs.addObserver("whimsy.feature.google-search", changed);
    Services.prefs.addObserver("whimsy.feature.ai-connectors", changed);
    win.gBrowser.tabContainer.addEventListener("TabSelect", tabChanged);
    win.addEventListener("unload", () => {
      this.exit(win, false);
      observer.disconnect();
      win.gBrowser.tabContainer.removeEventListener("TabSelect", tabChanged);
      win.removeEventListener("keydown", key, true);
      Services.obs.removeObserver(changed, "whimsy-connectors-changed");
      Services.prefs.removeObserver("whimsy.feature.google-search", changed);
      Services.prefs.removeObserver("whimsy.feature.ai-connectors", changed);
    }, { once: true });
  },
  enter(win, mode, query = "") {
    if (!allowed(win) || !["mail", "drive"].includes(mode)) {
      return;
    }
    this.exit(win, false);
    const bar = win.gURLBar;
    bar.searchMode = null;
    // Same position and token pair as the existing Ask mode pill.
    const chip = html(win.document, "span", "whimsy-ask-mode whimsy-google-mode");
    const image = html(win.document, "img", "whimsy-ask-mode-icon");
    image.src = icon(mode);
    image.alt = "";
    chip.append(image);
    const label = html(win.document, "span");
    win.document.l10n.setAttributes(label, `whimsy-google-mode-${mode}`);
    chip.append(label);
    bar.querySelector(".urlbar-input-box").before(chip);
    states.set(win, { mode, chip, rows: [], accounts: [], pages: new Map(), selected: null, query: "", node: null });
    bar.setAttribute("whimsy-google-mode", mode);
    bar.search(query);
  },
  exit(win, query = true) {
    const state = states.get(win);
    if (!state) {
      return;
    }
    state.controller?.abort();
    state.chip.remove();
    states.delete(win);
    win.gURLBar.removeAttribute("whimsy-google-mode");
    win.gURLBar.inputField.removeAttribute("aria-activedescendant");
    win.gURLBar.inputField.removeAttribute("aria-controls");
    if (query) {
      win.gURLBar.search("");
    }
  },
  async search(win, query, more = false) {
    const state = states.get(win);
    if (!state || !allowed(win)) {
      return;
    }
    state.controller?.abort();
    const controller = new AbortController();
    state.controller = controller;
    const current = () => states.get(win) == state && !controller.signal.aborted && allowed(win);
    if (!more) {
      state.query = query;
      state.rows = [];
      state.pages.clear();
      state.selected = null;
    }
    const accounts = await WhimsyConnectors.googleAccounts();
    state.configuration = configuration(accounts);
    state.accounts = accounts.filter(a => a.useInSearch && a.scopes.some(s => s.id == (state.mode == "mail" ? "gmail" : "drive") && s.on));
    if (!current()) {
      return;
    }
    this.render(win);
    if (!query.trim()) {
      return;
    }
    await Promise.all(state.accounts.map(async account => {
      if (more && !state.pages.get(account.id)) {
        return;
      }
      try {
        const rows = await WhimsyConnectors.searchGoogleAccount(account.id, state.mode, query, { signal: controller.signal, pageToken: more ? state.pages.get(account.id) : null });
        if (!current()) {
          return;
        }
        state.pages.set(account.id, rows.nextPageToken || null);
        for (const row of rows) {
          const result = { ...row, accountId: account.id, account: account.account, label: account.label };
          if (!state.rows.some(old => identity(old) == identity(result))) {
            state.rows.push(result);
          }
        }
      } catch {
        if (!current()) {
          return;
        }
        state.pages.delete(account.id);
        state.rows = state.rows.filter(row => row.accountId != account.id);
        state.rows.push({ id: "error", accountId: account.id, account: account.account, label: account.label, failed: true, at: 0 });
      }
      if (current()) {
        state.rows.sort((a, b) => Number(!!a.failed) - Number(!!b.failed) || b.at - a.at || identity(a).localeCompare(identity(b)));
        this.render(win);
      }
    }));
  },
  render(win) {
    const state = states.get(win);
    if (!state?.node || !allowed(win)) {
      return;
    }
    const doc = win.document;
    const list = state.node;
    list.replaceChildren();
    list.setAttribute("role", "listbox");
    list.id = "whimsy-google-list";
    win.gURLBar.inputField.setAttribute("aria-controls", list.id);
    const rows = [...state.rows];
    if ([...state.pages.values()].some(Boolean)) {
      rows.push({ id: "more", accountId: "", more: true });
    }
    state.visible = rows;
    if (!rows.some(r => identity(r) == state.selected)) {
      state.selected = rows.length ? identity(rows[0]) : null;
    }
    if (!state.query.trim()) {
      const hint = html(doc, "div", "whimsy-google-hint");
      doc.l10n.setAttributes(hint, `whimsy-google-hint-${state.mode}`, { count: state.accounts.length });
      list.append(hint);
    }
    for (const row of rows) {
      const el = html(doc, "div", "whimsy-google-row");
      el.id = `whimsy-google-option-${rows.indexOf(row)}`;
      el.setAttribute("role", "option");
      if (identity(row) == state.selected) {
        win.gURLBar.inputField.setAttribute("aria-activedescendant", el.id);
      }
      el.setAttribute("aria-selected", String(identity(row) == state.selected));
      el.toggleAttribute("selected", identity(row) == state.selected);
      el.toggleAttribute("data-failed", !!row.failed);
      const image = html(doc, "img", "urlbarView-favicon");
      image.src = row.mimeType == "application/pdf" ? "chrome://browser/content/whimsy/icons/pdf.svg" : icon(state.mode);
      image.alt = "";
      const text = html(doc, "span", "whimsy-google-text");
      const title = html(doc, "span", "urlbarView-title");
      if (row.failed || row.more) {
        doc.l10n.setAttributes(title, row.failed ? "whimsy-google-failed" : `whimsy-google-more-${state.mode}`, row.failed ? { account: row.account } : {});
      } else {
        title.textContent = row.title;
      }
      text.append(title);
      if (!row.failed && !row.more) {
        const date = new Date(row.at).toLocaleDateString(undefined, { month: "short", day: "numeric" });
        const detail = html(doc, "span", "whimsy-google-detail");
        if (state.mode == "drive") {
          const types = { "application/vnd.google-apps.document": "Doc", "application/vnd.google-apps.spreadsheet": "Sheet", "application/vnd.google-apps.presentation": "Slides", "application/pdf": "PDF" };
          doc.l10n.setAttributes(detail, "whimsy-google-file-detail", { type: types[row.mimeType] || "File", date, owner: row.editor || "" });
        } else {
          detail.textContent = `${row.detail} · ${date}`;
        }
        text.append(detail);
      }
      el.append(image, text);
      if (row.accountId) {
        el.append(html(doc, "span", "whimsy-google-account", row.label));
      }
      el.addEventListener("mousedown", event => { event.preventDefault(); event.stopPropagation(); });
      el.addEventListener("click", event => { event.preventDefault(); event.stopPropagation(); this.open(win, row, event.altKey).catch(console.error); });
      list.append(el);
    }
    if (!rows.length) {
      return;
    }
    const foot = html(doc, "div", "whimsy-google-foot");
    for (const [key, id] of [["↩", "whimsy-google-open"], ["⌥↩", "whimsy-google-new-tab"]]) {
      const hint = html(doc, "span");
      hint.append(html(doc, "kbd", "whimsy-cmdbar-key", key));
      const label = html(doc, "span");
      doc.l10n.setAttributes(label, id);
      hint.append(label);
      foot.append(hint);
    }
    list.append(foot);
  },
  onKey(win, event) {
    const state = states.get(win);
    if (!state || event.target != win.gURLBar.inputField) {
      return;
    }
    if (!allowed(win)) {
      this.exit(win, false);
      return;
    }
    if (event.key == "Escape" || (event.key == "Backspace" && !win.gURLBar.value)) {
      event.preventDefault();
      event.stopImmediatePropagation();
      this.exit(win);
    } else if (["ArrowDown", "ArrowUp", "Enter"].includes(event.key)) {
      event.preventDefault();
      event.stopImmediatePropagation();
      const rows = state.visible ?? [];
      if (event.key == "Enter") {
        const row = rows.find(r => identity(r) == state.selected);
        if (row) {
          this.open(win, row, event.altKey).catch(console.error);
        }
      } else if (rows.length) {
        const at = rows.findIndex(r => identity(r) == state.selected);
        state.selected = identity(rows[(at + (event.key == "ArrowDown" ? 1 : rows.length - 1)) % rows.length]);
        this.render(win);
        state.node.querySelector("[selected]")?.scrollIntoView({ block: "nearest" });
      }
    }
  },
  mailTab(win, account) {
    return win.gBrowser.tabs.find(tab => {
      if (lazy.WhimsyAIContext.isPrivate(tab)) {
        return false;
      }
      try {
        const url = new URL(tab.linkedBrowser.currentURI.spec);
        return url.hostname == "mail.google.com" && (
          lazy.WhimsyTabs.mailAccountMatches(tab, account) ||
          url.searchParams.get("authuser")?.toLowerCase() == account.toLowerCase() ||
          decodeURIComponent(url.pathname).toLowerCase().includes(`/${account.toLowerCase()}/`)
        );
      } catch {
        return false;
      }
    });
  },
  async open(win, row, newTab = false) {
    const state = states.get(win);
    if (!state || !allowed(win)) {
      return;
    }
    if (row.more) {
      await this.search(win, state.query, true);
      return;
    }
    const account = (await WhimsyConnectors.googleAccounts()).find(a => a.id == row.accountId);
    if (!account || !states.has(win) || !allowed(win)) {
      return;
    }
    if (row.failed) {
      win.gURLBar.view.close();
      await WhimsyConnectors.connect(win, "google", { accountId: account.id, scopes: account.scopes.filter(s => s.on).map(s => s.id) });
      return;
    }
    let url;
    let tab;
    if (state.mode == "mail") {
      // Use the existing mail account matcher, including Gmail title addresses;
      // never infer Google's account index from the order of connectors.
      if (!newTab) {
        tab = this.mailTab(win, account.account);
      }
      const base = tab ? new URL(tab.linkedBrowser.currentURI.spec) : new URL("https://mail.google.com/mail/");
      base.searchParams.set("authuser", account.account);
      base.hash = `all/${encodeURIComponent(row.threadId || row.id)}`;
      url = base.href;
    } else {
      const file = new URL(row.url);
      if (file.protocol != "https:" || !["drive.google.com", "docs.google.com"].includes(file.hostname)) {
        return;
      }
      file.searchParams.set("authuser", account.account);
      url = file.href;
    }
    win.gURLBar.view.close();
    if (tab) {
      win.gBrowser.selectedTab = tab;
      win.gBrowser.loadURI(Services.io.newURI(url), { triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() });
    } else {
      win.openTrustedLinkIn(url, newTab ? "tab" : "current");
    }
  },
};
