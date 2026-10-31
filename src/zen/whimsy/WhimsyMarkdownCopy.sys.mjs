/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Copy page as Markdown (MarkDownload, Obsidian Web Clipper, Raycast's
// "Copy as Markdown"; requested for Zen in discussion #12557). People paste
// articles into notes, docs and AI chats, and want the article, not the
// page: so the title, a source link, then the Reader View version of the
// page with its headings, links, lists and code. Right-click the page:
// "Copy Page as Markdown"; right-click a selection: "Copy Selection as
// Markdown" copies just that. Also in the command bar (the selection when
// there is one). A toast confirms. Zen's own "Copy current URL as Markdown"
// ([title](url), Cmd+Opt+Shift+C) stays as it is.
//
// The conversion runs in the page (WhimsyPageMarkdown.sys.mjs through
// WhimsyPageChild); this side owns the menu, the command and the clipboard.

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  WhimsyCommands: "resource:///modules/whimsy/WhimsyCommands.sys.mjs",
});
ChromeUtils.defineLazyGetter(lazy, "ClipboardHelper", () =>
  Cc["@mozilla.org/widget/clipboardhelper;1"].getService(Ci.nsIClipboardHelper)
);

const FEATURE_PREF = "whimsy.feature.copy-page-markdown";
const MENU_ID = "context-whimsy-copy-markdown";
const COMMAND_ID = "cmd_whimsyCopyPageMarkdown";
const COPYABLE_SCHEMES = new Set(["http", "https", "file", "about", "moz-extension"]);

export const WhimsyMarkdownCopy = {
  get enabled() {
    return Services.prefs.getBoolPref(FEATURE_PREF, true);
  },

  isCopyable(browser) {
    const uri = browser?.currentURI;
    if (!uri || !COPYABLE_SCHEMES.has(uri.scheme)) {
      return false;
    }
    // about: pages other than Reader View are the browser's own.
    return uri.scheme != "about" || uri.spec.startsWith("about:reader?");
  },

  // Converts in the page and copies. `selection`: true, false or "auto".
  // Returns { markdown, kind } or null when there was nothing to copy.
  async copy(win, { browsingContext = null, selection = "auto" } = {}) {
    if (!this.enabled) {
      return null;
    }
    const browser = win.gBrowser.selectedBrowser;
    const context = browsingContext ?? browser?.browsingContext;
    const actor = context?.currentWindowGlobal?.getActor("WhimsyPage");
    let result = null;
    try {
      result = actor ? await actor.sendQuery("Whimsy:PageMarkdown", { selection }) : null;
    } catch (e) {
      console.error("Whimsy: copy page as Markdown", e);
    }
    if (!result?.markdown) {
      win.gZenUIManager?.showToast?.("whimsy-copy-markdown-empty-toast");
      return null;
    }
    lazy.ClipboardHelper.copyString(result.markdown);
    win.gZenUIManager?.showToast?.(
      result.kind == "selection" ? "whimsy-copy-selection-markdown-toast" : "whimsy-copy-page-markdown-toast"
    );
    return result;
  },

  initWindow(win) {
    const { document } = win;
    lazy.WhimsyCommands.register(win, {
      id: COMMAND_ID,
      l10nId: "whimsy-action-copy-page-markdown",
      run: w => this.copy(w).catch(e => console.error("Whimsy: copy page as Markdown", e)),
      icon: "chrome://browser/skin/zen-icons/edit-copy.svg",
      isAvailable: w => this.enabled && this.isCopyable(w.gBrowser.selectedBrowser),
    });

    const menu = document.getElementById("contentAreaContextMenu");
    if (!menu) {
      return;
    }
    const item = document.createXULElement("menuitem");
    item.id = MENU_ID;
    item.hidden = true;
    item.addEventListener("command", () => {
      // gContextMenu is read when the item is used, never kept.
      const context = win.gContextMenu;
      const selection = !!context?.isContentSelected;
      this.copy(win, {
        browsingContext: selection ? context.browsingContext : context?.browser?.browsingContext,
        selection,
      }).catch(e => console.error("Whimsy: copy page as Markdown", e));
    });
    menu.addEventListener("popupshowing", event => {
      if (event.target != menu) {
        return;
      }
      const context = win.gContextMenu;
      const selection = !!context?.isContentSelected && !context.onTextInput;
      // Firefox has already decided whether page items show (Save Page
      // As is hidden on links, images, selections and fields).
      const page = !document.getElementById("context-savepage")?.hidden;
      item.hidden = !this.enabled || !context || !(selection || page) || !this.isCopyable(context.browser);
      if (item.hidden) {
        return;
      }
      document.l10n.setAttributes(
        item,
        selection ? "whimsy-context-copy-selection-markdown" : "whimsy-context-copy-page-markdown"
      );
      // Beside Copy for a selection; beside Save Page As for the page.
      const anchor = document.getElementById(selection ? "context-copy" : "context-savepage");
      if (anchor && anchor.nextElementSibling != item) {
        anchor.after(item);
      }
    });
    menu.append(item);
  },
};
