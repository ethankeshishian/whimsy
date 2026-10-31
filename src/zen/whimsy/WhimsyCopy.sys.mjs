/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Copy & share (Arc parity). Zen's Cmd+Shift+C / Cmd+Opt+Shift+C copy the
// current tab's URL (plain) or a Markdown link. Whimsy takes over those same
// commands, so the shortcuts, the command bar action and the URL bar's copy
// button all:
// - copy every selected tab when several are multi-selected (one URL per
//   line, or a Markdown list);
// - put a titled link (text/html) next to the plain URL, so pasting into
//   Docs, Slack or Notion gives the page title as a link, and plain-text
//   fields still get the bare URL (Arc's "Copy Link");
// - show a toast with the URL or the number of links copied.
// It also adds "Copy Link"/"Copy Links" to the tab context menu. Tracking
// parameters are stripped the way Zen's copy does (Firefox's Copy Clean Link
// list, privacy.query_stripping.strip_on_share.enabled).
// With whimsy.feature.copy off, Zen's own handlers run untouched.

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  SessionStore: "moz-src:///browser/components/sessionstore/SessionStore.sys.mjs",
  WhimsyCommands: "resource:///modules/whimsy/WhimsyCommands.sys.mjs",
});
ChromeUtils.defineLazyGetter(lazy, "QueryStringStripper", () =>
  Cc["@mozilla.org/url-query-string-stripper;1"].getService(Ci.nsIURLQueryStringStripper)
);

const FEATURE_PREF = "whimsy.feature.copy";
const COMMANDS = {
  cmd_zenCopyCurrentURL: false,
  cmd_zenCopyCurrentURLMarkdown: true,
};
const MENU_ID = "context_whimsyCopyLinks";
const TOAST_TIMEOUT_MS = 3000;

function escapeHTML(text) {
  return text.replace(
    /[&<>"']/g,
    c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]
  );
}

function escapeMarkdown(text) {
  return text.replace(/([\\[\]])/g, "\\$1");
}

export const WhimsyCopy = {
  get enabled() {
    return Services.prefs.getBoolPref(FEATURE_PREF, true);
  },

  init(win) {
    // Capture phase, so Whimsy runs before Zen's listener on its commandset
    // (the same way Zen's Library takes over Firefox's history command).
    win.document.addEventListener(
      "command",
      event => {
        const markdown = COMMANDS[event.target.id];
        if (markdown === undefined || !this.enabled) {
          return;
        }
        event.stopPropagation();
        try {
          this.copyFromShortcut(win, { markdown });
        } catch (e) {
          console.error("Whimsy: copy failed", e);
        }
      },
      true
    );
    this.initEditMenu(win);
    const menu = win.document.getElementById("tabContextMenu");
    menu?.addEventListener("popupshowing", event => {
      if (event.target == menu) {
        this.updateContextMenu(win);
      }
    });
  },

  // The tabs a shortcut acts on: all selected tabs when several are
  // multi-selected, else the current tab.
  shortcutTabs(win) {
    const { gBrowser } = win;
    return gBrowser.multiSelectedTabsCount > 1 ? gBrowser.selectedTabs : [gBrowser.selectedTab];
  },

  // The tabs the context menu acts on (Firefox's rule for its tab items).
  contextTabs(win) {
    const tab = win.TabContextMenu.contextTab;
    if (!tab) {
      return [];
    }
    return tab.multiselected ? win.gBrowser.selectedTabs : [tab];
  },

  copyFromShortcut(win, { markdown }) {
    const tabs = this.shortcutTabs(win);
    let links;
    if (tabs.length == 1) {
      // The current tab: exactly what Zen copies (it honours a URL typed into
      // the address bar and Copy Clean Link).
      const [uri] = win.gURLBar.zenStrippedURI;
      links = [{ url: this.displaySpec(uri), title: tabs[0].label }];
    } else {
      links = this.linksFor(tabs);
    }
    this.copy(win, links, { markdown });
  },

  copyFromContextMenu(win) {
    this.copy(win, this.linksFor(this.contextTabs(win)), { markdown: false });
  },

  linksFor(tabs) {
    const links = [];
    for (const tab of tabs) {
      const uri = this.tabURI(tab);
      if (uri && !this.isBlank(uri)) {
        links.push({ url: this.displaySpec(this.clean(uri)), title: tab.label });
      }
    }
    return links;
  },

  tabURI(tab) {
    const browser = tab.linkedBrowser;
    let uri = browser?.currentURI;
    // A restored tab that hasn't loaded yet still shows about:blank.
    if ((!uri || this.isBlank(uri)) && tab.hasAttribute("pending")) {
      try {
        const state = JSON.parse(lazy.SessionStore.getTabState(tab));
        const entry = state.entries?.[(state.index || state.entries.length) - 1];
        if (entry?.url) {
          uri = Services.io.newURI(entry.url);
        }
      } catch (e) {}
    }
    return uri;
  },

  isBlank(uri) {
    // Home/Changelog behave like the homepage; game/year remain copyable.
    const [page, query] = uri.specIgnoringRef.split("?");
    return (
      uri.spec == "about:blank" ||
      uri.spec == "about:newtab" ||
      uri.spec == "about:home" ||
      (page == "about:whimsy" &&
        (!query || query.startsWith("tab=") || query.split("&")[0] == "home"))
    );
  },

  // Copy Clean Link's stripping, like Zen's copy (gURLBar.zenStrippedURI).
  clean(uri) {
    try {
      return lazy.QueryStringStripper.stripForCopyOrShare(uri) || uri;
    } catch (e) {
      // Thrown when strip-on-share is off.
      return uri;
    }
  },

  displaySpec(uri) {
    // Never copy about:reader?url=…; give the original page instead.
    let spec = uri.displaySpec;
    if (uri.schemeIs("about") && spec.startsWith("about:reader?")) {
      try {
        spec = new URL(spec).searchParams.get("url") || spec;
      } catch (e) {}
    }
    try {
      if (Services.prefs.getBoolPref("browser.urlbar.decodeURLsOnCopy", false) && !uri.schemeIs("data")) {
        spec = decodeURI(spec);
      }
    } catch (e) {}
    return spec;
  },

  // The clipboard contents for some links: plain text (URLs, or Markdown) and,
  // for the plain variant, titled HTML links for rich-text editors.
  format(links, { markdown }) {
    const title = link => link.title?.trim() || link.url;
    if (markdown) {
      const md = link => `[${escapeMarkdown(title(link))}](${link.url})`;
      return {
        text: links.length == 1 ? md(links[0]) : links.map(l => `- ${md(l)}`).join("\n"),
      };
    }
    const a = link => `<a href="${escapeHTML(link.url)}">${escapeHTML(title(link))}</a>`;
    return {
      text: links.map(l => l.url).join("\n"),
      html: links.length == 1 ? a(links[0]) : `<ul>${links.map(l => `<li>${a(l)}</li>`).join("")}</ul>`,
    };
  },

  writeClipboard(win, { text, html }) {
    const transferable = Cc["@mozilla.org/widget/transferable;1"].createInstance(Ci.nsITransferable);
    transferable.init(win.docShell.QueryInterface(Ci.nsILoadContext));
    const put = (flavor, data) => {
      const str = Cc["@mozilla.org/supports-string;1"].createInstance(Ci.nsISupportsString);
      str.data = data;
      transferable.addDataFlavor(flavor);
      transferable.setTransferData(flavor, str);
    };
    if (html) {
      put("text/html", html);
    }
    put("text/plain", text);
    Services.clipboard.setData(transferable, null, Ci.nsIClipboard.kGlobalClipboard);
  },

  copy(win, links, { markdown }) {
    if (!links.length) {
      return;
    }
    this.writeClipboard(win, this.format(links, { markdown }));
    this.showToast(win, links, { markdown });
  },

  showToast(win, links, { markdown }) {
    const { gZenUIManager, document } = win;
    if (!gZenUIManager?.showToast) {
      return;
    }
    const messageId = markdown ? "whimsy-copy-markdown-toast" : "whimsy-copy-toast";
    const count = links.length;
    let button;
    const url = count == 1 ? links[0].url : null;
    /* eslint-disable mozilla/valid-services */
    if (url && !markdown && Services.zen?.canShare() && url.startsWith("http")) {
      button = {
        id: "zen-copy-current-url-button",
        command: event => {
          const rect = event.target.getBoundingClientRect();
          Services.zen.share(
            Services.io.newURI(url),
            "",
            "",
            rect.left,
            win.innerHeight - rect.bottom,
            rect.width,
            rect.height
          );
        },
      };
    }
    gZenUIManager.showToast(messageId, { l10nArgs: { count }, button, timeout: TOAST_TIMEOUT_MS });
    // Zen reuses a toast that's still showing, keeping its old text: refresh
    // the count, and show which URL was copied under the message.
    const toast = [...(document.getElementById("zen-toast-container")?.children ?? [])].find(
      t => t._messageId == messageId
    );
    if (!toast) {
      return;
    }
    const box = toast.firstElementChild;
    const label = box?.querySelector("label:not(.whimsy-copy-url)");
    if (label) {
      document.l10n.setAttributes(label, messageId, { count });
    }
    let detail = box?.querySelector(".whimsy-copy-url");
    if (url && box) {
      if (!detail) {
        detail = document.createXULElement("label");
        detail.classList.add("description", "whimsy-copy-url");
        detail.setAttribute("crop", "center");
        box.appendChild(detail);
      }
      detail.setAttribute("value", url);
    } else {
      detail?.remove();
    }
  },

  // wave6/parity: Arc's Edit menu. Copy URL (Cmd+Shift+C), Copy URL as
  // Markdown (Cmd+Opt+Shift+C), Copy URL as Quote (Cmd+Ctrl+Shift+C) after
  // Copy, and Paste and Match Style (Cmd+Shift+V) after Paste.
  initEditMenu(win) {
    const { document } = win;
    lazy.WhimsyCommands.register(win, {
      id: "cmd_whimsyCopyURLQuote",
      l10nId: "whimsy-action-copy-url-quote",
      run: w => this.copyQuote(w),
      keyId: "key_whimsyCopyURLQuote",
      key: { key: "C", modifiers: "accel,control,shift" },
      icon: "chrome://browser/skin/zen-icons/link.svg",
      isAvailable: w => this.enabled && !this.isBlank(w.gBrowser.selectedBrowser?.currentURI),
    });
    // Gecko's editors already paste without formatting on Cmd+Shift+V
    // (ShortcutKeyDefinitions); the menu item runs the same command, and its
    // key is internal (display only), like Firefox's own Paste.
    lazy.WhimsyCommands.addCommandElement(win, "cmd_whimsyPasteMatchStyle", w => w.goDoCommand("cmd_pasteNoFormatting"));
    if (!document.getElementById("key_whimsyPasteMatchStyle")) {
      const key = document.createXULElement("key");
      key.id = "key_whimsyPasteMatchStyle";
      key.setAttribute("modifiers", "accel,shift");
      key.setAttribute("key", "V");
      key.setAttribute("internal", "true");
      document.getElementById("key_paste")?.after(key);
    }
    const copy = document.getElementById("menu_copy");
    const paste = document.getElementById("menu_paste");
    if (!copy || !paste || document.getElementById("menu_whimsyCopyURL")) {
      return;
    }
    const item = (id, l10nId, command, key) => {
      const el = document.createXULElement("menuitem");
      el.id = id;
      el.setAttribute("data-l10n-id", l10nId);
      el.setAttribute("command", command);
      el.setAttribute("key", key);
      return el;
    };
    const urlItems = [
      item("menu_whimsyCopyURL", "whimsy-menu-copy-url", "cmd_zenCopyCurrentURL", "zen-copy-url"),
      item("menu_whimsyCopyURLMarkdown", "whimsy-menu-copy-url-markdown", "cmd_zenCopyCurrentURLMarkdown", "zen-copy-url-markdown"),
      item("menu_whimsyCopyURLQuote", "whimsy-menu-copy-url-quote", "cmd_whimsyCopyURLQuote", "key_whimsyCopyURLQuote"),
    ];
    copy.after(...urlItems);
    paste.after(item("menu_whimsyPasteMatchStyle", "whimsy-menu-paste-match-style", "cmd_whimsyPasteMatchStyle", "key_whimsyPasteMatchStyle"));
    copy.parentElement.addEventListener("popupshowing", event => {
      if (event.target != copy.parentElement) {
        return;
      }
      const blank = this.isBlank(win.gBrowser.selectedBrowser?.currentURI);
      for (const el of urlItems) {
        el.hidden = !this.enabled;
        el.disabled = blank;
      }
    });
  },

  // A Markdown quote: the page's selected text (or its title) as a
  // blockquote, then the source as a link. Rich editors get the same as
  // HTML. Arc's exact output is unverified.
  async copyQuote(win) {
    if (!this.enabled) {
      return;
    }
    const browser = win.gBrowser.selectedBrowser;
    const tab = win.gBrowser.selectedTab;
    const [uri] = win.gURLBar.zenStrippedURI ?? [browser.currentURI];
    const link = { url: this.displaySpec(uri), title: tab.label };
    let selected = null;
    try {
      selected = await browser.browsingContext?.currentWindowGlobal?.getActor("WhimsyPage").sendQuery("Whimsy:Selection");
    } catch (e) {
      // No page actor here (a privileged page): quote the title.
    }
    this.writeClipboard(win, this.formatQuote(link, selected?.text));
    win.gZenUIManager?.showToast?.("whimsy-copy-quote-toast", { timeout: TOAST_TIMEOUT_MS });
  },

  formatQuote(link, text) {
    const title = link.title?.trim() || link.url;
    const quote = (text?.trim() || title).replace(/\r\n?/g, "\n");
    const md = quote
      .split("\n")
      .map(line => (line ? `> ${line}` : ">"))
      .join("\n");
    const html = escapeHTML(quote).replace(/\n/g, "<br>");
    return {
      text: `${md}\n\n[${escapeMarkdown(title)}](${link.url})`,
      html: `<blockquote>${html}</blockquote><p><a href="${escapeHTML(link.url)}">${escapeHTML(title)}</a></p>`,
    };
  },

  // "Copy Link" / "Copy Links" in the tab context menu, after Duplicate.
  updateContextMenu(win) {
    const { document } = win;
    let item = document.getElementById(MENU_ID);
    if (!this.enabled) {
      if (item) {
        item.hidden = true;
      }
      return;
    }
    if (!item) {
      item = document.createXULElement("menuitem");
      item.id = MENU_ID;
      item.addEventListener("command", () => this.copyFromContextMenu(win));
      const anchor =
        document.getElementById("context_tabStateSeparator") ||
        document.getElementById("context_duplicateTabs")?.nextSibling;
      if (anchor) {
        anchor.before(item);
      } else {
        document.getElementById("tabContextMenu").appendChild(item);
      }
    }
    const count = this.linksFor(this.contextTabs(win)).length;
    item.hidden = count == 0;
    document.l10n.setAttributes(item, "tab-context-whimsy-copy-links", { count: Math.max(count, 1) });
  },
};
