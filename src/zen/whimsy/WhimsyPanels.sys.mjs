/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// fixB: one look for every small Whimsy panel ("sheet") and confirm.
//
// Each Whimsy popover used to build its own <panel> with its own markup, so
// none of them looked like Zen. A sheet is built only from the vocabulary
// Firefox's panels already use and Zen already restyles (zen-popup.css):
//
//   <panel type="arrow" class="whimsy-sheet">      Zen's panel surface
//     .panel-header > title (+ subtitle) + close   like the app menu's subviews
//     .whimsy-sheet-search                         Zen's folder-search field
//     <toolbarseparator/>
//     .panel-subview-body                          scrolls
//       .subviewbutton rows (icon, title, subtitle, trailing detail)
//     .panel-footer > .footer-button               Firefox's panel footer
//
// It opens anchored to what it acts on (a tab, the address bar) or, when
// called from the command bar or a shortcut, centred over the page near the
// top, where the command bar itself sits. Esc, a click outside and the close
// button all close it; arrow keys move through the rows; the search field
// takes the keyboard first. Panels animate the way Firefox's do, which
// honours prefers-reduced-motion; colours come from Zen's panel variables,
// so dark and light both follow the theme.
//
// Confirmations use the in-window prompt (gDialogBox), which Zen styles in
// zen-panels/dialog.css, the same one Zen's own "Clear history" uses.

const HTML_NS = "http://www.w3.org/1999/xhtml";

export const SHEET_WIDTHS = { small: 300, medium: 360, large: 440 };

const FOCUSABLE =
  "toolbarbutton:not([disabled]):not([hidden]), button:not([disabled]):not([hidden]), " +
  "input:not([disabled]):not([hidden]), textarea:not([disabled]), [tabindex='0']:not([hidden])";

function visible(el) {
  return !!el && el.isConnected && el.getClientRects().length > 0 && !el.closest("[hidden]");
}

function setL10n(doc, el, l10nId, args) {
  if (l10nId) {
    doc.l10n.setAttributes(el, l10nId, args ?? undefined);
  }
}

export const WhimsyPanels = {
  SHEET_WIDTHS,

  /**
   * Builds (or rebuilds) a sheet. Returns its parts; the caller fills
   * `body` (and `footer`) and then calls open(). The panel removes itself
   * once hidden, so every open starts fresh.
   *
   * @param {Window} win
   * @param {object} opts
   * @param {string} opts.id - element id of the <panel>
   * @param {string} opts.titleL10nId - the heading (a message with a value)
   * @param {object} [opts.titleArgs]
   * @param {string} [opts.subtitle] - plain text under the title (a host, a tab title)
   * @param {string} [opts.subtitleL10nId]
   * @param {object} [opts.subtitleArgs]
   * @param {"small"|"medium"|"large"} [opts.size]
   * @param {object} [opts.search] - { l10nId, onInput(value) }
   * @param {boolean} [opts.footer] - add an (empty) .panel-footer
   * @param {Function} [opts.onHidden]
   */
  create(win, opts) {
    const { document: doc } = win;
    doc.getElementById(opts.id)?.remove();

    const panel = doc.createXULElement("panel");
    panel.id = opts.id;
    panel.className = "whimsy-sheet";
    panel.setAttribute("type", "arrow");
    panel.setAttribute("role", "dialog");
    panel.setAttribute("noautofocus", "true");
    panel.setAttribute("size", opts.size ?? "small");
    panel.style.setProperty("--whimsy-sheet-width", `${SHEET_WIDTHS[opts.size ?? "small"]}px`);
    panel.setAttribute("aria-labelledby", `${opts.id}-title`);

    const header = doc.createXULElement("hbox");
    header.className = "panel-header whimsy-sheet-header";
    header.setAttribute("align", "center");
    const titles = doc.createXULElement("vbox");
    titles.className = "whimsy-sheet-titles";
    const h1 = doc.createElementNS(HTML_NS, "h1");
    h1.className = "whimsy-sheet-title";
    const span = doc.createElementNS(HTML_NS, "span");
    span.id = `${opts.id}-title`;
    setL10n(doc, span, opts.titleL10nId, opts.titleArgs);
    h1.append(span);
    titles.append(h1);
    let subtitle = null;
    if (opts.subtitle || opts.subtitleL10nId) {
      subtitle = doc.createXULElement("description");
      subtitle.className = "whimsy-sheet-subtitle";
      subtitle.setAttribute("crop", "end");
      if (opts.subtitleL10nId) {
        setL10n(doc, subtitle, opts.subtitleL10nId, opts.subtitleArgs);
      } else {
        subtitle.textContent = opts.subtitle;
      }
      titles.append(subtitle);
    }
    const close = this.iconButton(doc, {
      icon: "chrome://browser/skin/zen-icons/close.svg",
      l10nId: "whimsy-sheet-close",
      onCommand: () => this.close(panel),
    });
    close.classList.add("whimsy-sheet-close");
    header.append(titles, close);
    panel.append(header);

    let search = null;
    if (opts.search) {
      const box = doc.createXULElement("hbox");
      box.className = "whimsy-sheet-search";
      box.setAttribute("align", "center");
      const glass = doc.createXULElement("image");
      glass.className = "whimsy-sheet-search-icon";
      glass.setAttribute("src", "chrome://browser/skin/zen-icons/search-glass.svg");
      search = doc.createElementNS(HTML_NS, "input");
      search.type = "search";
      search.className = "whimsy-sheet-search-input";
      setL10n(doc, search, opts.search.l10nId);
      search.addEventListener("input", () => opts.search.onInput?.(search.value));
      box.append(glass, search);
      panel.append(box);
    }

    panel.append(doc.createXULElement("toolbarseparator"));

    const body = doc.createXULElement("vbox");
    body.className = "panel-subview-body whimsy-sheet-body";
    body.setAttribute("role", "group");
    panel.append(body);

    let footer = null;
    if (opts.footer) {
      footer = doc.createXULElement("hbox");
      footer.className = "panel-footer whimsy-sheet-footer";
      footer.setAttribute("align", "center");
      panel.append(footer);
    }

    panel.addEventListener("keydown", event => this._onKeyDown(panel, event, search));
    // Esc also works while focus is still in the page (the sheet opened
    // from a shortcut or the command bar, before anything inside it took
    // focus): listen on the window too, for as long as the sheet is open.
    const onWindowKey = event => {
      if (event.key == "Escape" && !event.defaultPrevented && panel.state == "open") {
        event.preventDefault();
        event.stopPropagation();
        this.close(panel);
      }
    };
    panel.addEventListener("popupshown", () => {
      win.addEventListener("keydown", onWindowKey, true);
      // Keyboard first: the search field, else the first row.
      const first = search ?? this.focusables(body)[0] ?? close;
      first?.focus();
    });
    panel.addEventListener("popuphidden", event => {
      if (event.target != panel) {
        return;
      }
      win.removeEventListener("keydown", onWindowKey, true);
      opts.onHidden?.();
      panel.remove();
    });

    (doc.getElementById("mainPopupSet") ?? doc.documentElement).append(panel);
    return { panel, header, subtitle, search, body, footer };
  },

  focusables(root) {
    return [...root.querySelectorAll(FOCUSABLE)].filter(visible);
  },

  _onKeyDown(panel, event, search) {
    const body = panel.querySelector(".whimsy-sheet-body");
    switch (event.key) {
      case "Escape":
        event.preventDefault();
        event.stopPropagation();
        this.close(panel);
        return;
      case "ArrowDown":
      case "ArrowUp": {
        const target = event.target;
        if (target.localName == "textarea") {
          return;
        }
        const items = this.focusables(body).filter(el => el.classList.contains("whimsy-sheet-item"));
        if (!items.length) {
          return;
        }
        event.preventDefault();
        let index = items.indexOf(target.closest?.(".whimsy-sheet-item") ?? target);
        if (target == search || index < 0) {
          index = event.key == "ArrowDown" ? 0 : items.length - 1;
        } else {
          index += event.key == "ArrowDown" ? 1 : -1;
          if (index < 0 && search) {
            search.focus();
            return;
          }
          index = (index + items.length) % items.length;
        }
        items[index].focus();
        return;
      }
      case "Home":
      case "End": {
        if (event.target.localName == "input" || event.target.localName == "textarea") {
          return;
        }
        const items = this.focusables(body).filter(el => el.classList.contains("whimsy-sheet-item"));
        if (items.length) {
          event.preventDefault();
          items[event.key == "Home" ? 0 : items.length - 1].focus();
        }
        return;
      }
      case "Enter":
        // Enter in the search field runs the first visible row, the way a
        // command palette does.
        if (search && event.target == search) {
          const first = this.focusables(body).find(el => el.classList.contains("whimsy-sheet-item"));
          if (first) {
            event.preventDefault();
            first.doCommand();
          }
        }
    }
  },

  /**
   * A row: a .subviewbutton with an icon, a title, an optional second line
   * and an optional trailing detail (a time, a size, a shortcut).
   *
   * @param {Document} doc
   * @param {object} o
   * @param {string} [o.l10nId] / [o.label] - the title
   * @param {object} [o.l10nArgs]
   * @param {string} [o.subtitleL10nId] / [o.subtitle]
   * @param {object} [o.subtitleArgs]
   * @param {string} [o.detail] - trailing text
   * @param {string} [o.keys] - a shortcut, drawn as key caps
   * @param {string} [o.icon] - image URL
   * @param {boolean} [o.favicon] - the icon is a site icon (no fill)
   * @param {boolean|null} [o.checked] - a radio row: true/false; null = not a radio
   * @param {boolean} [o.destructive]
   * @param {Function} [o.onCommand]
   */
  item(doc, o) {
    const button = doc.createXULElement("toolbarbutton");
    button.className = "subviewbutton whimsy-sheet-item";
    button.setAttribute("tabindex", "0");
    if (o.destructive) {
      button.setAttribute("destructive", "true");
    }
    if (o.checked != null) {
      button.setAttribute("role", "menuitemradio");
      button.setAttribute("aria-checked", o.checked ? "true" : "false");
      if (o.checked) {
        button.setAttribute("checked", "true");
      }
    }
    // Custom children: toolbarbutton then skips its own icon/label.
    const icon = doc.createXULElement("image");
    icon.className = "whimsy-sheet-item-icon";
    if (o.favicon) {
      icon.setAttribute("favicon", "true");
    }
    if (o.icon) {
      icon.setAttribute("src", o.icon);
    }
    const text = doc.createXULElement("vbox");
    text.className = "whimsy-sheet-item-text";
    text.setAttribute("flex", "1");
    const title = doc.createXULElement("label");
    title.className = "whimsy-sheet-item-title";
    title.setAttribute("crop", "end");
    if (o.l10nId) {
      setL10n(doc, title, o.l10nId, o.l10nArgs);
    } else {
      title.setAttribute("value", o.label ?? "");
      button.setAttribute("aria-label", o.label ?? "");
    }
    text.append(title);
    if (o.subtitle || o.subtitleL10nId) {
      const sub = doc.createXULElement("label");
      sub.className = "whimsy-sheet-item-subtitle";
      sub.setAttribute("crop", "end");
      if (o.subtitleL10nId) {
        setL10n(doc, sub, o.subtitleL10nId, o.subtitleArgs);
      } else {
        sub.setAttribute("value", o.subtitle);
      }
      text.append(sub);
    }
    button.append(icon, text);
    if (o.detail) {
      const detail = doc.createXULElement("label");
      detail.className = "whimsy-sheet-item-detail";
      detail.setAttribute("value", o.detail);
      button.append(detail);
    }
    if (o.keys) {
      const keys = doc.createXULElement("label");
      keys.className = "whimsy-sheet-item-keys";
      keys.setAttribute("value", o.keys);
      button.append(keys);
    }
    if (o.checked != null) {
      const check = doc.createXULElement("image");
      check.className = "whimsy-sheet-item-check";
      check.setAttribute("src", "chrome://browser/skin/zen-icons/check.svg");
      button.append(check);
    }
    if (o.onCommand) {
      button.addEventListener("command", event => o.onCommand(event));
    }
    return button;
  },

  /** A small icon-only button (close, delete, restore) with a tooltip. */
  iconButton(doc, { icon, l10nId, l10nArgs, onCommand }) {
    const button = doc.createXULElement("toolbarbutton");
    button.className = "whimsy-sheet-icon-button";
    button.setAttribute("tabindex", "0");
    button.setAttribute("image", icon);
    // The message carries .tooltiptext and .aria-label.
    setL10n(doc, button, l10nId, l10nArgs);
    if (onCommand) {
      button.addEventListener("command", event => {
        event.stopPropagation();
        onCommand(event);
      });
    }
    return button;
  },

  /** A row with secondary actions after it (shown on hover or focus). */
  line(doc, item, ...actions) {
    const line = doc.createXULElement("hbox");
    line.className = "whimsy-sheet-line";
    line.setAttribute("align", "center");
    item.setAttribute("flex", "1");
    const box = doc.createXULElement("hbox");
    box.className = "whimsy-sheet-line-actions";
    box.setAttribute("align", "center");
    box.append(...actions);
    line.append(item, box);
    return line;
  },

  /** A small group heading inside the body ("Today", "1.2 GB · 4% CPU"). */
  caption(doc, { l10nId, l10nArgs, text, detail }) {
    const box = doc.createXULElement("hbox");
    box.className = "whimsy-sheet-caption";
    box.setAttribute("align", "center");
    const label = doc.createXULElement("label");
    label.setAttribute("flex", "1");
    if (l10nId) {
      setL10n(doc, label, l10nId, l10nArgs);
    } else {
      label.setAttribute("value", text ?? "");
    }
    box.append(label);
    if (detail) {
      const d = doc.createXULElement("label");
      d.className = "whimsy-sheet-caption-detail";
      d.setAttribute("value", detail);
      box.append(d);
    }
    return box;
  },

  /** The empty state: an icon and a sentence, centred. */
  empty(doc, { l10nId, l10nArgs, icon }) {
    const box = doc.createXULElement("vbox");
    box.className = "whimsy-sheet-empty";
    box.setAttribute("align", "center");
    if (icon) {
      const image = doc.createXULElement("image");
      image.setAttribute("src", icon);
      box.append(image);
    }
    const text = doc.createXULElement("description");
    setL10n(doc, text, l10nId, l10nArgs);
    box.append(text);
    return box;
  },

  /** A footer button; `primary` is the default action. */
  footerButton(doc, { l10nId, l10nArgs, primary = false, onCommand }) {
    const button = doc.createXULElement("button");
    button.className = "footer-button whimsy-sheet-footer-button";
    if (primary) {
      button.classList.add("primary");
      button.setAttribute("default", "true");
    }
    setL10n(doc, button, l10nId, l10nArgs);
    if (onCommand) {
      button.addEventListener("command", onCommand);
    }
    return button;
  },

  /** The first of these elements that is actually on screen. */
  visibleAnchor(win, ids) {
    for (const id of ids) {
      const el = typeof id == "string" ? win.document.getElementById(id) : id;
      if (el && visible(el) && el.checkVisibility?.({ visibilityProperty: true }) !== false) {
        const rect = el.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) {
          return el;
        }
      }
    }
    return null;
  },

  /**
   * Opens a sheet. With an anchor, it hangs off it (`position`, default
   * below and start-aligned); without one, it is centred over the page
   * near the top, where the command bar sits.
   */
  open(win, panel, { anchor = null, position = "after_start", triggerEvent = null } = {}) {
    if (anchor) {
      panel.openPopup(anchor, { position, triggerEvent });
      return;
    }
    const doc = win.document;
    const area =
      this.visibleAnchor(win, ["tabbrowser-tabbox", "browser", "appcontent"]) ?? doc.documentElement;
    const rect = area.getBoundingClientRect();
    const width = parseInt(panel.style.getPropertyValue("--whimsy-sheet-width"), 10) || SHEET_WIDTHS.small;
    const x = Math.max(0, Math.round((rect.width - width) / 2));
    const y = Math.round(Math.min(Math.max(rect.height * 0.1, 12), 96));
    panel.openPopup(area, { position: "overlap", x, y, triggerEvent });
  },

  close(panel) {
    if (panel && (panel.state == "open" || panel.state == "showing")) {
      panel.hidePopup();
    }
  },

  /**
   * Asks before something destructive, in the window's own dialog (Zen
   * styles it). Resolves true when the person accepts.
   *
   * @param {Window} win
   * @param {object} o
   * @param {string} o.title
   * @param {string} o.body
   * @param {string} [o.accept] - the accept button's label
   * @param {boolean} [o.cancelDefault] - Return picks Cancel, for what
   *   can't be undone (Forget Everything), so a reflexive Return after
   *   the sheet never wipes anything.
   */
  async confirm(win, { title, body, accept = null, cancelDefault = false }) {
    const ps = Services.prompt;
    let flags = accept
      ? ps.BUTTON_POS_0 * ps.BUTTON_TITLE_IS_STRING + ps.BUTTON_POS_1 * ps.BUTTON_TITLE_CANCEL
      : ps.STD_OK_CANCEL_BUTTONS;
    if (cancelDefault) {
      flags += ps.BUTTON_POS_1_DEFAULT;
    }
    try {
      const result = await ps.asyncConfirmEx(
        win.browsingContext,
        ps.MODAL_TYPE_INTERNAL_WINDOW,
        title ?? "",
        body ?? "",
        flags,
        accept,
        null,
        null,
        null,
        false
      );
      return result.get("buttonNumClicked") == 0;
    } catch (e) {
      console.error("Whimsy: confirm", e);
      return false;
    }
  },

  /**
   * Asks for one line of text in the window's own sheet, the same in-window
   * dialog Zen styles for "Delete Space" (never a separate system window).
   * Resolves the entered text, or null when the person cancels.
   *
   * @param {Window} win
   * @param {object} o
   * @param {string} o.title
   * @param {string} [o.body]
   * @param {string} [o.value] - prefilled text
   * @param {boolean} [o.password] - mask the field (API keys)
   */
  async ask(win, { title, body = "", value = "", password = false }) {
    const ps = Services.prompt;
    try {
      const args = [win.browsingContext, ps.MODAL_TYPE_INTERNAL_WINDOW, title ?? "", body ?? "",
        value ?? "", null, false];
      const result = password ? await ps.asyncPromptPassword(...args) : await ps.asyncPrompt(...args);
      if (!result.getProperty("ok")) {
        return null;
      }
      return String(result.getProperty(password ? "pass" : "value") ?? "");
    } catch (e) {
      console.error("Whimsy: ask", e);
      return null;
    }
  },

  /**
   * Zen's "Delete space" confirmation (ZenSpaceManager.contextDeleteWorkspace,
   * via the space-delete-confirm hotfix in whimsy/overlay.py). Zen asked
   * with a parentless prompt, which macOS shows as a separate system
   * window; this asks inside the window instead, with a "Delete" button.
   */
  async confirmDeleteSpace(win, title, body) {
    const accept = await win.document.l10n.formatValue("whimsy-delete-space-accept");
    return this.confirm(win, { title, body, accept });
  },
};
