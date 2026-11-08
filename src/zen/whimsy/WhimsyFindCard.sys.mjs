/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// W23 (fu-page 1.7): Find as a floating card at the top right of the page,
// like Chrome. It is still Firefox's findbar, restyled and re-laid out, so
// Quick Find (/ and ') and Ask on Page keep working: the field holds the
// match count, then previous, next, ⋯ (a WhimsySurface menu with Firefox's
// options as checkable rows), and close. With nothing found the count turns
// red; WhimsyAIPage puts Ask in the space kept for it.

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  Whimsy: "resource:///modules/whimsy/Whimsy.sys.mjs",
  WhimsyCommands: "resource:///modules/whimsy/WhimsyCommands.sys.mjs",
  WhimsySurface: "resource:///modules/whimsy/WhimsySurface.sys.mjs",
});

const FEATURE = "find-card";
const SHEET = "chrome://browser/content/whimsy/whimsy-find-card.css";
const MENU_ID = "whimsy-find-menu";
const COMMAND = "whimsy-find-options";
const MENU_ICON = "chrome://browser/skin/zen-icons/menu.svg";
const HTML = "http://www.w3.org/1999/xhtml";

const imageMatchers = new Set();
const windows = new WeakSet();

export const WhimsyFindCard = {
  get enabled() {
    return lazy.Whimsy.featureEnabled(FEATURE);
  },

  initWindow(win) {
    if (windows.has(win)) {
      return;
    }
    windows.add(win);
    try {
      win.windowUtils.loadSheetUsingURIString(SHEET, win.windowUtils.AUTHOR_SHEET);
    } catch (e) {
      console.error("Whimsy: find card sheet", e);
    }
    lazy.WhimsyCommands?.register?.(win, {
      id: COMMAND,
      l10nId: "whimsy-find-options-command",
      icon: MENU_ICON,
      isAvailable: () => this.enabled,
      run: async w => {
        const findbar = await w.gBrowser.getFindBar();
        if (!findbar) {
          return;
        }
        this.attach(w, findbar);
        if (findbar.hidden) {
          findbar.startFind(findbar.FIND_NORMAL);
        }
        this.openMenu(w, findbar);
      },
    });
  },

  isCard(findbar) {
    return !!findbar?.hasAttribute("whimsy-find-card");
  },

  /**
   * L16 (media-3.4): words inside on-screen images. `fn({browser, text,
   * findbar})` resolves to how many matches the images hold; they count as
   * found, so Ask isn't offered for them.
   */
  registerImageMatcher(fn) {
    imageMatchers.add(fn);
    return () => imageMatchers.delete(fn);
  },

  attach(win, findbar) {
    if (!findbar || findbar._whimsyFindCard || !this.enabled) {
      return;
    }
    findbar._whimsyFindCard = true;
    const doc = win.document;
    findbar.setAttribute("whimsy-find-card", "true");
    const wrapper = findbar.getElement("findbar-textbox-wrapper");
    const field = findbar._findField;
    const prev = findbar.getElement("find-previous");
    const next = findbar.getElement("find-next");
    wrapper.classList.add("whimsy-find-field");
    const glass = doc.createXULElement("image");
    glass.className = "whimsy-find-glass";
    glass.setAttribute("aria-hidden", "true");
    const count = doc.createXULElement("label");
    count.className = "whimsy-find-count";
    count.setAttribute("aria-hidden", "true");
    wrapper.prepend(glass);
    field.after(count);
    const sep = doc.createElementNS(HTML, "div");
    sep.className = "whimsy-find-sep";
    const more = doc.createXULElement("toolbarbutton");
    more.className = "whimsy-find-more tabbable";
    more.setAttribute("aria-haspopup", "menu");
    doc.l10n.setAttributes(more, "whimsy-find-more");
    more.addEventListener("command", () => this.openMenu(win, findbar));
    wrapper.after(sep, prev, next, more);
    findbar._whimsyCount = count;

    const counts = findbar.onMatchesCountResult.bind(findbar);
    findbar.onMatchesCountResult = result => {
      counts(result);
      this.showCount(findbar, result);
    };
    const updateUI = findbar._updateFindUI.bind(findbar);
    findbar._updateFindUI = () => {
      updateUI();
      sep.hidden = more.hidden = findbar.findMode != findbar.FIND_NORMAL && !findbar._whimsyLinksOnly;
      findbar.dispatchEvent(new win.CustomEvent("WhimsyFindUIUpdated"));
    };
    field.addEventListener("input", () => {
      if (!field.value) {
        this.showCount(findbar, { total: 0 });
      }
    });
    new win.MutationObserver(() => this.syncStatus(findbar)).observe(field, { attributes: true, attributeFilter: ["status"] });
    findbar.addEventListener("findbarclose", () => {
      lazy.WhimsySurface.close(doc.getElementById(MENU_ID));
      if (findbar._whimsyLinksOnly) {
        findbar._whimsyLinksOnly = false;
        findbar.removeAttribute("whimsy-links-only");
      }
    });
  },

  syncStatus(findbar) {
    const notFound = findbar._findField.getAttribute("status") == "notfound" && !!findbar._findField.value;
    findbar.getElement("findbar-textbox-wrapper").toggleAttribute("notfound", notFound && !findbar.hasAttribute("whimsy-image-matches"));
    if (notFound) {
      this.showCount(findbar, { total: 0 });
    }
  },

  async showCount(findbar, result) {
    const count = findbar._whimsyCount;
    if (!count) {
      return;
    }
    const text = findbar._findField.value;
    let images = 0;
    if (text && !(result.total > 0) && imageMatchers.size) {
      const found = await Promise.all(
        [...imageMatchers].map(fn => Promise.resolve(fn({ browser: findbar.browser, text, findbar })).catch(() => 0))
      );
      images = found.reduce((sum, n) => sum + (Number(n) || 0), 0);
      if (findbar._findField.value != text) {
        return;
      }
    }
    findbar.toggleAttribute("whimsy-image-matches", images > 0);
    let value = "";
    if (text) {
      if (result.total === -1) {
        value = `${result.limit}+`;
      } else if (result.total > 0) {
        value = `${result.current}/${result.total}`;
      } else {
        value = images ? `${images}` : "0/0";
      }
    }
    count.setAttribute("value", value);
    findbar.getElement("findbar-textbox-wrapper").toggleAttribute(
      "notfound",
      !!text && !(result.total > 0) && !images && findbar._findField.getAttribute("status") == "notfound"
    );
  },

  // The options Firefox's bar showed as checkboxes, as checkable rows. The
  // rows call what the (hidden) checkboxes' command handlers call, which
  // also checks the boxes, rather than clicking controls nobody can see.
  options(findbar) {
    const box = id => findbar.getElement(id);
    return [
      { id: "highlight", l10nId: "whimsy-find-highlight-all", checked: box("highlight").checked, toggle: () => findbar.toggleHighlight(!box("highlight").checked) },
      { id: "case", l10nId: "whimsy-find-match-case", checked: box("find-case-sensitive").checked, toggle: () => findbar._setCaseSensitivity(box("find-case-sensitive").checked ? 0 : 1) },
      { id: "diacritics", l10nId: "whimsy-find-match-diacritics", checked: box("find-match-diacritics").checked, toggle: () => findbar._setDiacriticMatching(box("find-match-diacritics").checked ? 0 : 1) },
      { id: "words", l10nId: "whimsy-find-whole-words", checked: box("find-entire-word").checked, toggle: () => findbar.toggleEntireWord(!box("find-entire-word").checked) },
      { id: "links", l10nId: "whimsy-find-links-only", checked: !!findbar._whimsyLinksOnly, toggle: () => this.setLinksOnly(findbar, !findbar._whimsyLinksOnly), rule: true },
    ];
  },

  setLinksOnly(findbar, on) {
    findbar._whimsyLinksOnly = on;
    findbar.findMode = on ? findbar.FIND_LINKS : findbar.FIND_NORMAL;
    findbar.toggleAttribute("whimsy-links-only", on);
    if (findbar._findField.value) {
      findbar._findFailedString = null;
      findbar._find();
    }
  },

  openMenu(win, findbar) {
    const doc = win.document;
    const more = findbar.querySelector(".whimsy-find-more");
    const parts = lazy.WhimsySurface.create(win, {
      id: MENU_ID,
      width: 220,
      className: "whimsy-surface-listbox-panel whimsy-find-menu",
      onHidden: () => {
        more?.removeAttribute("open");
        if (!findbar.hidden) {
          findbar._findField.focus();
        }
      },
      initialFocus: () => list.querySelector("[role=option]"),
    });
    const list = doc.createElementNS(HTML, "div");
    list.className = "whimsy-surface-listbox";
    list.setAttribute("role", "listbox");
    list.setAttribute("aria-multiselectable", "true");
    doc.l10n.setAttributes(list, "whimsy-find-menu");
    for (const option of this.options(findbar)) {
      if (option.rule) {
        list.append(lazy.WhimsySurface.rule(doc));
      }
      const row = doc.createElementNS(HTML, "div");
      row.className = "whimsy-surface-option";
      row.setAttribute("role", "option");
      row.dataset.option = option.id;
      row.setAttribute("aria-selected", String(option.checked));
      row.tabIndex = -1;
      const check = doc.createXULElement("image");
      check.className = "whimsy-surface-option-check";
      check.setAttribute("src", "chrome://global/skin/icons/check.svg");
      const label = doc.createElementNS(HTML, "span");
      label.className = "whimsy-surface-option-label";
      doc.l10n.setAttributes(label, option.l10nId);
      row.append(check, label);
      const toggle = () => {
        option.toggle();
        const on = row.getAttribute("aria-selected") != "true";
        row.setAttribute("aria-selected", String(on));
      };
      row.addEventListener("click", toggle);
      row.addEventListener("keydown", event => {
        if (event.key == "Enter" || event.key == " ") {
          event.preventDefault();
          toggle();
        }
      });
      list.append(row);
    }
    list.querySelector("[role=option]").tabIndex = 0;
    parts.view.append(list);
    more?.setAttribute("open", "true");
    lazy.WhimsySurface.open(win, parts.panel, { anchor: more ?? findbar, position: "after_end", y: 8 });
    return parts.panel;
  },
};
