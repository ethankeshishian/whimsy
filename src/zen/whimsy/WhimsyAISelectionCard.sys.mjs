/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// W23 commands: AI on selected text (spec "Right-click on selected text";
// page-2.x, fu-page 2.4, 2.6, 2.8). Four rows at the top of the selection's
// menu (Improve Writing, Fix Spelling and Grammar, Translate ▸, More
// Commands…), none on password, card, or one-time-code fields. A row opens
// a result card under the selection: Replace · Insert after · Copy · Try
// again, dimmed until the answer is complete. Editable text: Replace is the
// default (Enter). Read-only text: Copy and Insert after (a marked block
// under its paragraph until reload). Esc changes nothing. Undo (toast or
// ⌘Z) puts the original back, selected, and reopens the card on Replace.

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  WhimsyAI: "resource:///modules/whimsy/WhimsyAI.sys.mjs",
  WhimsyAICommands: "resource:///modules/whimsy/WhimsyAICommands.sys.mjs",
  WhimsyAIContext: "resource:///modules/whimsy/WhimsyAIContext.sys.mjs",
  WhimsyAIProviders: "resource:///modules/whimsy/WhimsyAIProviders.sys.mjs",
  WhimsyAIViewShare: "resource:///modules/whimsy/WhimsyAIViewShare.sys.mjs",
  WhimsyCommands: "resource:///modules/whimsy/WhimsyCommands.sys.mjs",
  WhimsyCopy: "resource:///modules/whimsy/WhimsyCopy.sys.mjs",
  WhimsySurface: "resource:///modules/whimsy/WhimsySurface.sys.mjs",
  WhimsyUndo: "resource:///modules/whimsy/WhimsyUndo.sys.mjs",
  WhimsyVerbs: "resource:///modules/whimsy/WhimsyVerbs.sys.mjs",
});

const FEATURE_PREF = "whimsy.feature.ai-selection-commands";
const RECENT_PREF = "whimsy.ai.translate.recent";
const PANEL_ID = "whimsy-ai-selection-card";
const HTML_NS = "http://www.w3.org/1999/xhtml";
const SPARKLE = "chrome://browser/skin/zen-icons/sparkles.svg";
const LANGUAGES = ["ar", "zh", "nl", "en", "fr", "de", "el", "he", "hi", "id", "it", "ja", "ko", "pl", "pt", "ru", "es", "sv", "th", "tr", "uk", "vi"];

function languageName(tag) {
  try {
    return new Intl.DisplayNames([Services.locale.appLocaleAsBCP47], { type: "language" }).of(tag) ?? tag;
  } catch {
    return tag;
  }
}

const base = tag => String(tag ?? "").split("-")[0].toLowerCase();

function h(doc, tag, className, text) {
  const el = doc.createElementNS(HTML_NS, tag);
  if (className) {
    el.className = className;
  }
  if (text != null) {
    el.textContent = text;
  }
  return el;
}

/** Word-level changes from `before` to `after`: [{op: "same"|"del"|"ins", text}]. */
export function wordDiff(before, after) {
  const a = String(before).split(/(\s+)/);
  const b = String(after).split(/(\s+)/);
  if (a.length * b.length > 400000) {
    return [{ op: "ins", text: after }];
  }
  const dp = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      dp[i][j] = a[i] == b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out = [];
  const push = (op, text) => {
    if (out.at(-1)?.op == op) {
      out.at(-1).text += text;
    } else if (text) {
      out.push({ op, text });
    }
  };
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] == b[j]) {
      push("same", a[i++]);
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      push("del", a[i++]);
    } else {
      push("ins", b[j++]);
    }
  }
  while (i < a.length) {
    push("del", a[i++]);
  }
  while (j < b.length) {
    push("ins", b[j++]);
  }
  return out;
}

export const WhimsyAISelectionCard = {
  // The open card: {win, cmd, subject, editable, status, text, error, provider, controller, parts}.
  card: null,
  // The card whose answer replaced the selection, until it's undone.
  replaced: null,

  get enabled() {
    return Services.prefs.getBoolPref(FEATURE_PREF, true);
  },

  available(win) {
    const tab = win?.gBrowser?.selectedTab;
    return this.enabled && lazy.WhimsyAI.enabled && !!tab && !lazy.WhimsyAIContext.isPrivate(tab);
  },

  recentLanguages() {
    return Services.prefs
      .getStringPref(RECENT_PREF, "")
      .split(",")
      .filter(Boolean)
      .filter(t => base(t) != base(Services.locale.appLocaleAsBCP47))
      .slice(0, 2);
  },

  rememberLanguage(tag) {
    if (base(tag) == base(Services.locale.appLocaleAsBCP47)) {
      return;
    }
    const list = [tag, ...this.recentLanguages().filter(t => base(t) != base(tag))].slice(0, 2);
    Services.prefs.setStringPref(RECENT_PREF, list.join(","));
  },

  // ---- The menu ----

  initWindow(win) {
    const menu = win.document.getElementById("contentAreaContextMenu");
    if (!menu) {
      return;
    }
    menu.addEventListener("popupshowing", event => {
      if (event.target == menu) {
        this.updateMenu(win);
      }
    });
    lazy.WhimsyCommands.register(win, {
      id: "cmd_whimsyAIImproveWriting",
      l10nId: "whimsy-ai-command-improve",
      icon: "chrome://browser/skin/zen-icons/wand-sparkle.svg",
      commandBar: false,
      isAvailable: w => this.available(w),
      run: w => this.runOnSelection(w, "improve").catch(console.error),
    });
    lazy.WhimsyCommands.register(win, {
      id: "cmd_whimsyAIFixSpelling",
      l10nId: "whimsy-ai-command-fix",
      icon: "chrome://browser/skin/zen-icons/spell-check.svg",
      commandBar: false,
      isAvailable: w => this.available(w),
      run: w => this.runOnSelection(w, "fix").catch(console.error),
    });
  },

  // Whether the right-click landed on text the AI rows may see.
  menuAllowed(win) {
    const context = win.gContextMenu;
    if (!context || !this.available(win) || context.onPassword) {
      return false;
    }
    const text = (context.selectionInfo?.fullText || context.selectedText || "").trim();
    if (!text) {
      return false;
    }
    const target = lazy.WhimsyAIViewShare.contextTarget(context.browser);
    return !target?.sensitive;
  },

  updateMenu(win) {
    const doc = win.document;
    const menu = doc.getElementById("contentAreaContextMenu");
    const rows = this._rows(win);
    const show = this.menuAllowed(win);
    const hidden = id => lazy.WhimsyAICommands.get(id)?.hidden;
    rows.improve.hidden = !show || hidden("improve");
    rows.fix.hidden = !show || hidden("fix");
    rows.translate.hidden = !show || hidden("translate");
    rows.more.hidden = !show;
    rows.separator.hidden = !show;
    if (menu.firstElementChild != rows.improve) {
      menu.prepend(rows.improve, rows.fix, rows.translate, rows.more, rows.separator);
    }
    if (show) {
      this._fillTranslate(win, rows.translate.menupopup ?? rows.translate.querySelector("menupopup"));
    }
  },

  _rows(win) {
    const doc = win.document;
    const existing = doc.getElementById("context-whimsy-ai-improve");
    if (existing) {
      return {
        improve: existing,
        fix: doc.getElementById("context-whimsy-ai-fix"),
        translate: doc.getElementById("context-whimsy-ai-translate"),
        more: doc.getElementById("context-whimsy-ai-more"),
        separator: doc.getElementById("context-whimsy-ai-separator"),
      };
    }
    const item = (id, l10nId, run) => {
      const row = doc.createXULElement("menuitem");
      row.id = id;
      doc.l10n.setAttributes(row, l10nId);
      row.addEventListener("command", () => run());
      return row;
    };
    const improve = item("context-whimsy-ai-improve", "whimsy-ai-menu-improve", () => this.runOnSelection(win, "improve").catch(console.error));
    const fix = item("context-whimsy-ai-fix", "whimsy-ai-menu-fix", () => this.runOnSelection(win, "fix").catch(console.error));
    const translate = doc.createXULElement("menu");
    translate.id = "context-whimsy-ai-translate";
    doc.l10n.setAttributes(translate, "whimsy-ai-menu-translate");
    const popup = doc.createXULElement("menupopup");
    popup.id = "context-whimsy-ai-translate-popup";
    translate.append(popup);
    const more = item("context-whimsy-ai-more", "whimsy-ai-menu-more", () => this.moreCommands(win));
    more.setAttribute("acceltext", "⌘K");
    const separator = doc.createXULElement("menuseparator");
    separator.id = "context-whimsy-ai-separator";
    return { improve, fix, translate, more, separator };
  },

  _fillTranslate(win, popup) {
    const doc = win.document;
    const mine = Services.locale.appLocaleAsBCP47;
    const tags = [mine, ...this.recentLanguages()];
    popup.replaceChildren(
      ...tags.map((tag, i) => {
        const row = doc.createXULElement("menuitem");
        row.id = `context-whimsy-ai-translate-${i}`;
        doc.l10n.setAttributes(row, "whimsy-ai-menu-translate-to", { language: languageName(tag) });
        row.addEventListener("command", () => this.runOnSelection(win, "translate", { language: tag }).catch(console.error));
        return row;
      }),
      doc.createXULElement("menuseparator"),
      (() => {
        const row = doc.createXULElement("menuitem");
        row.id = "context-whimsy-ai-translate-other";
        doc.l10n.setAttributes(row, "whimsy-ai-menu-translate-other");
        row.addEventListener("command", () => this.runOnSelection(win, "translate", { pickLanguage: true }).catch(console.error));
        return row;
      })()
    );
  },

  // More Commands…: ⌘K on the selection, its text commands only.
  moreCommands(win) {
    lazy.WhimsyVerbs.openFromKey(win, { textOnly: true }).catch(console.error);
  },

  // ---- The card ----

  /** Runs a built-in or your command on the page's selection and shows the card. */
  async runOnSelection(win, id, { language = null, pickLanguage = false } = {}) {
    if (!this.available(win)) {
      return null;
    }
    const context = win.gContextMenu?.actor?.manager?.browsingContext ?? win.gBrowser.selectedBrowser.browsingContext;
    const actor = context?.currentWindowGlobal?.getActor("WhimsyAIViewShare");
    let mark = null;
    try {
      mark = await actor?.sendQuery("Whimsy:CardMark");
    } catch (e) {
      console.error("Whimsy: selection card", e);
    }
    if (!mark?.text || mark.sensitive) {
      return null;
    }
    const cmd = lazy.WhimsyAICommands.get(id);
    if (!cmd) {
      return null;
    }
    const browser = win.gBrowser.selectedBrowser;
    const subject = { kind: "selection", text: mark.text, url: browser.currentURI.spec, title: win.gBrowser.selectedTab.label };
    this.close();
    this.card = {
      win,
      cmd,
      subject,
      context,
      editable: mark.editable,
      rect: mark.rect,
      language: language ?? Services.locale.appLocaleAsBCP47,
      status: pickLanguage ? "choose" : "waiting",
      text: "",
      error: null,
      provider: null,
    };
    this.open(this.card);
    if (!pickLanguage) {
      await this.run(this.card);
    }
    return this.card;
  },

  async run(card) {
    card.controller?.abort();
    card.controller = new card.win.AbortController();
    card.status = "waiting";
    card.text = "";
    card.error = null;
    if (card.cmd.id == "translate") {
      this.rememberLanguage(card.language);
    }
    this.render(card);
    const { signal } = card.controller;
    try {
      const out = await lazy.WhimsyAICommands.run(card.win, card.cmd.id, card.subject, {
        signal,
        language: languageName(card.language),
        onEvent: event => {
          if (signal.aborted || this.card != card) {
            return;
          }
          if (event.type == "text") {
            card.status = "streaming";
            card.text += event.delta;
            this.render(card);
          } else if (event.type == "status" && event.provider) {
            card.provider = event.provider;
          }
        },
      });
      if (signal.aborted) {
        return;
      }
      card.text = out.text;
      card.provider = out.result?.provider ?? card.provider;
      card.status = "done";
    } catch (e) {
      if (signal.aborted) {
        return;
      }
      card.status = "error";
      card.error = e?.code ?? "failed";
      card.provider = e?.provider ?? card.provider;
    }
    if (this.card == card) {
      this.render(card);
      card.parts?.panel.querySelector("[default='true']:not([disabled])")?.focus({ focusVisible: false });
    }
  },

  open(card) {
    const { win } = card;
    const doc = win.document;
    const parts = lazy.WhimsySurface.create(win, {
      id: PANEL_ID,
      width: 460,
      title: card.cmd.name,
      close: true,
      footer: true,
      className: "whimsy-ai-card",
      initialFocus: false,
      onHidden: () => {
        if (this.card == card) {
          card.controller?.abort();
          this.card = null;
        }
      },
    });
    const icon = doc.createXULElement("image");
    icon.className = "whimsy-ai-card-icon";
    icon.setAttribute("src", SPARKLE);
    parts.title.before(icon);
    parts.body = h(doc, "div", "whimsy-ai-card-body");
    parts.body.setAttribute("aria-live", "polite");
    parts.view.append(parts.body);
    const S = lazy.WhimsySurface;
    parts.model = h(doc, "span", "whimsy-ai-card-model");
    parts.again = S.textButton(doc, { l10nId: "whimsy-ai-card-try-again", id: "whimsy-ai-card-again", ghost: true, onCommand: () => this.run(card) });
    parts.copy = S.footerButton(doc, { l10nId: "whimsy-ai-card-copy", id: "whimsy-ai-card-copy", onCommand: () => this.copy(card) });
    parts.insert = S.footerButton(doc, { l10nId: "whimsy-ai-card-insert-after", id: "whimsy-ai-card-insert", primary: !card.editable, onCommand: () => this.insertAfter(card) });
    parts.replace = card.editable ? S.footerButton(doc, { l10nId: "whimsy-ai-card-replace", id: "whimsy-ai-card-replace", primary: true, onCommand: () => this.replace(card) }) : null;
    const spacer = doc.createXULElement("spacer");
    spacer.setAttribute("flex", "1");
    parts.footer.append(parts.model, spacer, parts.again, parts.copy, parts.insert, ...(parts.replace ? [parts.replace] : []));
    S.finish(parts);
    card.parts = parts;
    this.render(card);
    const r = card.rect;
    S.open(win, parts.panel, { screenRect: { left: r.left, top: r.top + r.height, width: Math.max(1, r.width), height: 1 }, position: "after_start", gap: 6 });
  },

  render(card) {
    const parts = card.parts;
    if (!parts) {
      return;
    }
    const doc = card.win.document;
    const busy = card.status == "waiting" || card.status == "streaming";
    parts.panel.toggleAttribute("busy", busy);
    for (const button of [parts.copy, parts.insert, parts.replace]) {
      button?.toggleAttribute("disabled", card.status != "done" || !card.text);
    }
    parts.again.disabled = busy || card.status == "choose";
    if (card.provider) {
      parts.model.textContent = lazy.WhimsyAIProviders.providerName(card.provider);
    }
    const body = parts.body;
    if (card.status == "choose") {
      this._renderChooser(card, body);
      return;
    }
    if (card.status == "error") {
      const line = h(doc, "p", "whimsy-ai-card-error");
      doc.l10n.setAttributes(line, card.error == "offline" ? "whimsy-ai-card-error-offline" : "whimsy-ai-card-error", { provider: card.provider ? lazy.WhimsyAIProviders.providerName(card.provider) : "AI" });
      body.replaceChildren(line);
      return;
    }
    if (!card.text) {
      const line = h(doc, "p", "whimsy-ai-card-working");
      doc.l10n.setAttributes(line, "whimsy-ai-card-working");
      body.replaceChildren(line);
      return;
    }
    const text = h(doc, "p", "whimsy-ai-card-text");
    if (card.cmd.marks && card.status == "done") {
      for (const part of wordDiff(card.subject.text, card.text)) {
        text.append(part.op == "same" ? part.text : h(doc, part.op, `whimsy-ai-card-${part.op}`, part.text));
      }
    } else {
      text.textContent = card.text;
    }
    body.replaceChildren(text);
  },

  _renderChooser(card, body) {
    const doc = card.win.document;
    const S = lazy.WhimsySurface;
    const label = h(doc, "label", "whimsy-ai-card-label");
    label.id = "whimsy-ai-card-language-label";
    doc.l10n.setAttributes(label, "whimsy-ai-card-language");
    const options = LANGUAGES.map(tag => ({ value: tag, label: languageName(tag) })).sort((a, b) => a.label.localeCompare(b.label));
    const dropdown = S.dropdown(doc, {
      id: "whimsy-ai-card-language",
      label: label.id,
      options,
      value: base(card.language),
      onPick: value => {
        card.language = value;
      },
    });
    const go = S.footerButton(doc, { l10nId: "whimsy-ai-card-translate", id: "whimsy-ai-card-translate", primary: true, onCommand: () => this.run(card) });
    body.replaceChildren(h(doc, "div", "whimsy-ai-card-choose"));
    body.firstChild.append(label, dropdown, go);
    card.win.requestAnimationFrame(() => dropdown.focus());
  },

  close() {
    const card = this.card;
    this.card = null;
    card?.controller?.abort();
    if (card?.parts?.panel.state == "open" || card?.parts?.panel.state == "showing") {
      lazy.WhimsySurface.close(card.parts.panel);
    }
  },

  _send(card, name, data) {
    return card.context?.currentWindowGlobal?.getActor("WhimsyAIViewShare").sendQuery(name, data);
  },

  async replace(card) {
    if (card.status != "done" || !card.editable) {
      return;
    }
    this.close();
    const done = await this._send(card, "Whimsy:CardReplace", { text: card.text }).catch(() => false);
    if (!done) {
      return;
    }
    this.replaced = card;
    card.undoEntry = { undo: () => this._send(card, "Whimsy:CardUndo", {}).catch(() => {}) };
    card.toast = lazy.WhimsyUndo.showToast(card.win, "whimsy-ai-card-replaced-toast", card.undoEntry);
  },

  // The field's text was put back (⌘Z there, or the toast's Undo): the
  // original is selected again, and the card reopens on Replace.
  async onUndone(context) {
    const card = this.replaced;
    if (!card || card.context != context) {
      return;
    }
    this.replaced = null;
    lazy.WhimsyUndo.removeEntry(card.win, card.undoEntry);
    card.toast?.close?.();
    const mark = await this._send(card, "Whimsy:CardMark", {}).catch(() => null);
    if (mark?.rect) {
      card.rect = mark.rect;
    }
    this.close();
    this.card = card;
    card.status = "done";
    this.open(card);
    card.parts.panel.addEventListener("popupshown", () => card.parts.replace?.focus({ focusVisible: false }), { once: true });
  },

  async insertAfter(card) {
    if (card.status != "done") {
      return;
    }
    this.close();
    const done = await this._send(card, "Whimsy:CardInsertAfter", { text: card.text, editable: card.editable }).catch(() => false);
    if (done && card.editable) {
      lazy.WhimsyUndo.showToast(card.win, "whimsy-ai-card-inserted-toast", { undo: () => this._send(card, "Whimsy:CardUndo", {}).catch(() => {}) });
    }
  },

  copy(card) {
    if (card.status != "done") {
      return;
    }
    lazy.WhimsyCopy.copyText(card.text, false);
    this.close();
    card.win.gZenUIManager?.showToast?.("whimsy-ai-card-copied-toast");
  },
};
