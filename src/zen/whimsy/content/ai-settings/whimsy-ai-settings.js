/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

// W23: Settings › AI is one page. AI off: one card. AI on: an Off limits
// card, then each registered section, with a sticky jump strip. Sections
// come from their own files through WhimsyAISettings.register(); sheets
// open over the page and confirms sit in the page under their row.

/* globals gotoPref */

var WhimsyAISettings = {
  HTML: "http://www.w3.org/1999/xhtml",
  STRIP: ["providers", "connectors", "commands", "memory", "agent", "outside-agents", "activity", "features"],
  _sections: new Map(),
  _sheets: new Map(),
  _built: new Map(),
  root: null,
  _sheet: null,

  get ai() {
    return ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyAI.sys.mjs").WhimsyAI;
  },

  get providers() {
    return ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyAIProviders.sys.mjs").WhimsyAIProviders;
  },

  browserWindow() {
    return Services.wm.getMostRecentWindow("navigator:browser");
  },

  el(tag, className, parent, l10nId, l10nArgs) {
    const node = document.createElementNS(this.HTML, tag);
    if (className) {
      node.className = className;
    }
    if (l10nId) {
      document.l10n.setAttributes(node, l10nId, l10nArgs);
    }
    parent?.append(node);
    return node;
  },

  button(parent, l10nId, { kind = "", small = false, onClick, l10nArgs, id } = {}) {
    const node = this.el("button", "whimsy-ai-btn", parent, l10nId, l10nArgs);
    node.type = "button";
    for (const k of kind.split(" ").filter(Boolean)) {
      node.classList.add(`is-${k}`);
    }
    node.classList.toggle("is-small", small);
    if (id) {
      node.id = id;
    }
    if (onClick) {
      node.addEventListener("click", onClick);
    }
    return node;
  },

  tile(parent, src, { logo = false, tone = null } = {}) {
    const tile = this.el("span", "whimsy-ai-tile", parent);
    tile.classList.toggle("is-logo", logo);
    tile.setAttribute("aria-hidden", "true");
    if (tone) {
      tile.dataset.tone = tone;
    }
    const img = this.el("img", "", tile);
    img.src = src;
    img.alt = "";
    return tile;
  },

  reducedMotion() {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  },

  // Zen's expand: rows unfold with grid-template-rows 0fr → 1fr.
  unfold(node) {
    if (this.reducedMotion()) {
      return null;
    }
    return node.animate({ gridTemplateRows: ["0fr", "1fr"], opacity: [0, 1] }, { duration: 300, easing: "cubic-bezier(0.34, 1.2, 0.64, 1)" });
  },

  // ---- registry ----

  /**
   * @param {{id: string, order: number, jumpL10nId: string, headingL10nId?: string,
   *   descL10nId?: string, build: (container: Element, ctx: object) => void|Function}} section
   */
  register(section) {
    if (!section?.id || typeof section.build != "function") {
      throw new Error("WhimsyAISettings.register needs an id and build()");
    }
    this._sections.set(section.id, section);
    if (this.root) {
      this._renderSections();
    }
  },

  registerSheet(id, open) {
    this._sheets.set(id, open);
  },

  get ctx() {
    return {
      doc: document,
      confirmStrip: (row, opts) => this.confirmStrip(row, opts),
      openSheet: (id, opts) => this.openSheet(id, opts),
      closeSheet: () => this.closeSheet(),
      toast: (l10nId, opts) => this.toast(l10nId, opts),
      settings: this,
    };
  },

  // ---- the page ----

  mount(root) {
    this.root = root;
    this.watchList = root.querySelector("#whimsyAIWatchList");
    root.replaceChildren();
    const top = this.el("div", "whimsy-ai-top", root);
    top.id = "whimsyAITop";
    const h1row = this.el("div", "whimsy-ai-h1row", top);
    this.el("h1", "", h1row, "whimsy-ai-page-title");
    this.onLabel = this.el("span", "whimsy-ai-onlabel", h1row);
    this.onLabel.id = "whimsyAIOnLabel";
    this.toggle = this.el("moz-toggle", "", h1row, "whimsy-ai-page-switch");
    this.toggle.id = "whimsyAIEnable";
    this.toggle.addEventListener("toggle", () => this._onToggle());
    this.lockedNote = this.el("p", "whimsy-ai-desc", top, "whimsy-ai-locked-note");
    this.lockedNote.hidden = true;
    this.confirmSlot = this.el("div", "", top);
    this.confirmSlot.id = "whimsyAIConfirmSlot";
    this.strip = this.el("nav", "whimsy-ai-strip", top, "whimsy-ai-jump-label");
    this.strip.id = "whimsyAIJump";
    this.offCard = this.el("div", "whimsy-ai-hero", root);
    this.offCard.id = "whimsyAIOffCard";
    this.offCard.hidden = true;
    this.onPart = this.el("div", "", root);
    this.onPart.id = "whimsyAIOn";
    this.onPart.style.cssText = "display:flex;flex-direction:column;gap:22px";
    this.onPart.hidden = true;
    this._buildOffLimits();
    this.sectionsBox = this.el("div", "", this.onPart);
    this.sectionsBox.style.cssText = "display:flex;flex-direction:column;gap:22px";
    this._renderSections();
    this._watch();
    this.refresh();
    this._takeAction();
  },

  _watch() {
    const update = () => this.refresh();
    const prefs = [this.ai.PREF, "browser.ai.control.default", "whimsy.ai.order"];
    for (const pref of prefs) {
      Services.prefs.addObserver(pref, update);
    }
    const topics = ["whimsy-ai-providers-changed", "whimsy-ai-accounts-changed"];
    for (const topic of topics) {
      Services.obs.addObserver(update, topic);
    }
    const action = () => this._takeAction();
    Services.obs.addObserver(action, "whimsy-ai-settings-action");
    const scroller = this._scroller();
    const onScroll = () => this._spy();
    scroller?.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener(
      "unload",
      () => {
        prefs.forEach(pref => Services.prefs.removeObserver(pref, update));
        topics.forEach(topic => Services.obs.removeObserver(update, topic));
        Services.obs.removeObserver(action, "whimsy-ai-settings-action");
        for (const cleanup of this._built.values()) {
          try {
            cleanup?.();
          } catch (e) {
            console.error(e);
          }
        }
      },
      { once: true }
    );
  },

  _scroller() {
    let node = this.root?.parentElement;
    while (node && node != document.documentElement) {
      const { overflowY } = getComputedStyle(node);
      if (overflowY == "auto" || overflowY == "scroll") {
        return node;
      }
      node = node.parentElement;
    }
    return document.scrollingElement ?? document.documentElement;
  },

  get isOn() {
    return this.ai.enabled && !this.ai.lockedOff;
  },

  async refresh() {
    const serial = (this._serial = (this._serial ?? 0) + 1);
    const locked = this.ai.lockedOff;
    const on = this.isOn;
    const connected = on ? true : await this.providers.anyConnected();
    if (serial != this._serial || !this.root) {
      return;
    }
    const was = this.onPart.hidden ? (this.offCard.hidden ? null : "off") : "on";
    const now = on ? "on" : "off";
    this.lockedNote.hidden = !locked;
    // Off: the card's own button is the one way back, so the switch hides.
    this.toggle.hidden = !on && !locked;
    this.toggle.pressed = on;
    this.toggle.disabled = locked || Services.prefs.prefIsLocked(this.ai.PREF);
    document.l10n.setAttributes(this.onLabel, on ? "whimsy-ai-page-on" : "whimsy-ai-page-off");
    this.onLabel.hidden = this.toggle.hidden;
    if (!on) {
      this._closeConfirm(this.confirmSlot);
      this._buildOffCard(connected && !locked ? "kept" : "setup");
    }
    this.strip.hidden = !on;
    if (was == now) {
      return;
    }
    const swap = () => {
      this.offCard.hidden = on;
      this.onPart.hidden = !on;
      this._updateStrip();
    };
    if (was === null || this.reducedMotion()) {
      swap();
      return;
    }
    // Off: sections fade out 180ms, then the page collapses to the card.
    const leaving = on ? this.offCard : this.onPart;
    const fade = leaving.animate({ opacity: [1, 0] }, { duration: 180, easing: "ease-in" });
    this.fading = fade;
    fade.finished.then(() => {
      swap();
      const arriving = on ? this.onPart : this.offCard;
      this.arriving = arriving.animate({ opacity: [0, 1], transform: ["translateY(6px)", "none"] }, { duration: 240, easing: "cubic-bezier(0.075, 0.82, 0.165, 1)" });
    }, () => swap());
  },

  _onToggle() {
    if (this.toggle.pressed) {
      Services.prefs.setBoolPref(this.ai.PREF, true);
      return;
    }
    // Turning off asks first, in the page under the header.
    this.toggle.pressed = true;
    this.confirmStrip(this.confirmSlot, {
      titleL10nId: "whimsy-ai-off-confirm-title",
      textL10nId: "whimsy-ai-off-confirm-text",
      okL10nId: "whimsy-ai-off-confirm-ok",
      replace: false,
      restoreFocus: this.toggle,
      onConfirm: () => {
        Services.prefs.setBoolPref(this.ai.PREF, false);
      },
    });
  },

  _buildOffCard(kind) {
    if (this.offCard.dataset.kind == kind) {
      return;
    }
    this.offCard.dataset.kind = kind;
    const card = this.offCard;
    card.replaceChildren();
    if (kind == "setup") {
      const logos = this.el("span", "whimsy-ai-logos", card);
      for (const id of ["apple", "claude", "openai", "gemini", "ollama"]) {
        this.tile(logos, this.logo(id), { logo: true });
      }
    } else {
      this.tile(card, "chrome://browser/skin/zen-icons/sparkles.svg");
    }
    this.el("h2", "", card, "whimsy-ai-off-title");
    this.el("p", "", card, kind == "setup" ? "whimsy-ai-off-setup-text" : "whimsy-ai-off-kept-text");
    const actions = this.el("div", "whimsy-ai-actions", card);
    if (kind == "setup") {
      this.button(actions, "whimsy-ai-off-setup", { kind: "primary", id: "whimsyAISetUp", onClick: () => this.openSheet("add-provider") });
    } else {
      this.button(actions, "whimsy-ai-off-turn-on", {
        kind: "primary",
        id: "whimsyAITurnOn",
        onClick: () => Services.prefs.setBoolPref(this.ai.PREF, true),
      });
      this.button(actions, "whimsy-ai-off-forget", { kind: "text", id: "whimsyAIForget", onClick: () => this.forgetEverything() });
    }
  },

  // Forget everything… is the Fire button's choices, not a second flow.
  forgetEverything() {
    const win = this.browserWindow();
    const { WhimsyFireButton } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyFireButton.sys.mjs");
    win?.focus();
    WhimsyFireButton.openPanel(win);
  },

  _buildOffLimits() {
    const sec = this.el("section", "whimsy-ai-sec", this.onPart);
    sec.id = "whimsyAIOffLimits";
    const head = this.el("div", "whimsy-ai-sec-head", sec);
    this.el("h2", "", head, "whimsy-ai-limits-heading");
    this.el("p", "whimsy-ai-desc", sec, "whimsy-ai-limits-desc");
    const facts = this.el("div", "whimsy-ai-facts", sec);
    for (const [icon, id] of [
      ["chrome://browser/content/whimsy/icons/eye-slash.svg", "private"],
      ["chrome://browser/skin/zen-icons/security.svg", "hidden"],
      ["chrome://browser/content/whimsy/icons/card.svg", "cards"],
    ]) {
      const fact = this.el("div", "whimsy-ai-fact", facts);
      const img = this.el("img", "", fact);
      img.src = icon;
      img.alt = "";
      const text = this.el("span", "whimsy-ai-fact-text", fact);
      this.el("b", "", text, `whimsy-ai-limits-${id}`);
      this.el("span", "", text, `whimsy-ai-limits-${id}-detail`);
    }
  },

  _available() {
    return [...this._sections.values()].filter(s => s.isAvailable?.() ?? true).sort((a, b) => a.order - b.order);
  },

  _renderSections() {
    const sections = this._available();
    for (const section of sections) {
      if (this._built.has(section.id)) {
        continue;
      }
      const container = this.el("section", "whimsy-ai-sec");
      container.id = `whimsyAISection-${section.id}`;
      container.dataset.section = section.id;
      const head = this.el("div", "whimsy-ai-sec-head", container);
      const h2 = this.el("h2", "", head, section.headingL10nId ?? section.jumpL10nId);
      h2.id = `whimsyAIHeading-${section.id}`;
      container.setAttribute("aria-labelledby", h2.id);
      if (section.descL10nId) {
        this.el("p", "whimsy-ai-desc", container, section.descL10nId);
      }
      container.whimsyHead = head;
      const after = sections.slice(sections.indexOf(section) + 1).map(s => this._built.has(s.id) && document.getElementById(`whimsyAISection-${s.id}`)).find(Boolean);
      this.sectionsBox.insertBefore(container, after || null);
      let cleanup = null;
      try {
        cleanup = section.build(container, this.ctx) ?? null;
      } catch (e) {
        console.error(`Whimsy AI settings: the ${section.id} section`, e);
      }
      this._built.set(section.id, cleanup);
    }
    this._updateStrip();
  },

  _updateStrip() {
    if (!this.strip) {
      return;
    }
    const sections = this._available();
    this.strip.replaceChildren();
    for (const section of sections) {
      const button = this.el("button", "", this.strip, section.jumpL10nId);
      button.type = "button";
      button.dataset.section = section.id;
      button.addEventListener("click", () => this.jumpTo(section.id));
    }
    this._spy();
  },

  jumpTo(id) {
    const target = document.getElementById(`whimsyAISection-${id}`);
    if (!target) {
      return;
    }
    this._jumping = id;
    this._markStrip(id);
    target.scrollIntoView({ block: "start", behavior: this.reducedMotion() ? "instant" : "smooth" });
    clearTimeout(this._jumpTimer);
    this._jumpTimer = setTimeout(() => (this._jumping = null), 700);
  },

  _markStrip(id) {
    for (const button of this.strip.children) {
      button.setAttribute("aria-current", button.dataset.section == id ? "true" : "false");
    }
  },

  _spy() {
    if (!this.root || this.onPart.hidden) {
      return;
    }
    const top = document.getElementById("whimsyAITop");
    top.toggleAttribute("stuck", top.getBoundingClientRect().top <= 1 && this._scroller().scrollTop > 0);
    if (this._jumping) {
      return;
    }
    const line = top.getBoundingClientRect().bottom + 8;
    let current = null;
    for (const button of this.strip.children) {
      const section = document.getElementById(`whimsyAISection-${button.dataset.section}`);
      if (section && section.getBoundingClientRect().top <= line) {
        current = button.dataset.section;
      }
    }
    this._markStrip(current);
  },

  // ---- confirms in the page ----

  /**
   * A one-line confirm under a row (or in a slot): title, what happens,
   * Cancel and the action. Esc or Cancel restores; focus starts on Cancel.
   */
  confirmStrip(row, { titleL10nId, titleArgs, textL10nId, textArgs, text, okL10nId, destructive = true, onConfirm, restoreFocus = null, replace = true } = {}) {
    const slot = replace ? row : row;
    this._closeConfirm(slot);
    const strip = this.el("div", "whimsy-ai-confirm");
    strip.setAttribute("role", "alertdialog");
    const inner = this.el("div", "", strip);
    const box = this.el("div", "whimsy-ai-confirm-in", inner);
    const textBox = this.el("span", "whimsy-ai-confirm-text", box);
    const title = this.el("b", "", textBox, titleL10nId, titleArgs);
    title.id = `whimsyAIConfirmTitle-${Math.random().toString(36).slice(2, 8)}`;
    const body = this.el("span", "", textBox, textL10nId, textArgs);
    if (text) {
      body.textContent = text;
    }
    strip.setAttribute("aria-labelledby", title.id);
    const close = () => {
      strip.remove();
      slot.whimsyConfirm = null;
      (restoreFocus ?? slot.querySelector?.("button"))?.focus?.();
    };
    const cancel = this.button(box, "whimsy-ai-confirm-cancel-button", { small: true, onClick: close });
    cancel.dataset.action = "cancel";
    const ok = this.button(box, okL10nId, { small: true, kind: destructive ? "destructive" : "primary" });
    ok.dataset.action = "confirm";
    ok.addEventListener("click", async () => {
      ok.disabled = true;
      try {
        await onConfirm?.();
      } finally {
        strip.remove();
        slot.whimsyConfirm = null;
      }
    });
    strip.addEventListener("keydown", event => {
      if (event.key == "Escape") {
        event.preventDefault();
        event.stopPropagation();
        close();
      }
    });
    if (slot.classList?.contains("whimsy-ai-item")) {
      slot.after(strip);
    } else {
      slot.append(strip);
    }
    slot.whimsyConfirm = strip;
    this.unfold(strip);
    cancel.focus();
    return strip;
  },

  _closeConfirm(slot) {
    slot?.whimsyConfirm?.remove();
    if (slot) {
      slot.whimsyConfirm = null;
    }
  },

  // ---- sheets ----

  openSheet(id, opts = {}) {
    const open = this._sheets.get(id);
    if (!open) {
      console.error(`Whimsy AI settings: no sheet ${id}`);
      return null;
    }
    this.closeSheet({ restore: false });
    const restore = opts.restoreFocus ?? document.activeElement;
    const scrim = this.el("div", "whimsy-ai-scrim", document.body ?? document.documentElement);
    scrim.id = "whimsyAISheetScrim";
    const sheet = this.el("div", "whimsy-ai-sheet", scrim);
    sheet.id = "whimsyAISheet";
    sheet.dataset.sheet = id;
    sheet.setAttribute("role", "dialog");
    sheet.setAttribute("aria-modal", "true");
    const head = this.el("div", "whimsy-ai-sheet-head", sheet);
    const title = this.el("h1", "", head);
    title.id = "whimsyAISheetTitle";
    sheet.setAttribute("aria-labelledby", title.id);
    const x = this.el("button", "whimsy-ai-x", head, "whimsy-ai-sheet-close-button");
    x.type = "button";
    x.addEventListener("click", () => this.closeSheet());
    const body = this.el("div", "", sheet);
    body.style.cssText = "display:flex;flex-direction:column;gap:10px";
    const footer = this.el("div", "whimsy-ai-footer", sheet);
    const state = { id, scrim, sheet, head, title, body, footer, restore, cleanups: [] };
    this._sheet = state;
    scrim.addEventListener("mousedown", event => {
      if (event.target == scrim) {
        this.closeSheet();
      }
    });
    const onKey = event => this._sheetKeys(event);
    document.addEventListener("keydown", onKey);
    state.cleanups.push(() => document.removeEventListener("keydown", onKey));
    try {
      open(state, opts, this.ctx);
    } catch (e) {
      console.error(`Whimsy AI settings: the ${id} sheet`, e);
    }
    if (!this.reducedMotion()) {
      state.animation = sheet.animate({ opacity: [0, 1], scale: [0.97, 1] }, { duration: 160, easing: "cubic-bezier(0.2, 0, 0, 1)" });
      scrim.animate({ opacity: [0, 1] }, { duration: 150 });
    } else {
      state.animation = sheet.animate({ opacity: [0, 1] }, { duration: 100 });
    }
    (sheet.querySelector("[autofocus]") ?? this._focusables(sheet).find(n => !n.classList.contains("whimsy-ai-x")) ?? x).focus();
    return state;
  },

  _focusables(root) {
    return [...root.querySelectorAll("button:not([disabled]), input:not([disabled]), a[href], [tabindex='0'], moz-toggle")].filter(n => n.getClientRects().length);
  },

  _sheetKeys(event) {
    const state = this._sheet;
    if (!state || event.defaultPrevented) {
      return;
    }
    if (event.key == "Escape") {
      event.preventDefault();
      event.stopPropagation();
      this.closeSheet();
    } else if (event.key == "Tab") {
      const list = this._focusables(state.sheet);
      const at = list.indexOf(document.activeElement);
      const next = event.shiftKey ? (at <= 0 ? list.length - 1 : at - 1) : (at + 1) % list.length;
      event.preventDefault();
      list[next]?.focus();
    }
  },

  closeSheet({ restore = true } = {}) {
    const state = this._sheet;
    if (!state) {
      return;
    }
    this._sheet = null;
    for (const cleanup of state.cleanups) {
      try {
        cleanup();
      } catch (e) {
        console.error(e);
      }
    }
    const { scrim, sheet } = state;
    const done = () => scrim.remove();
    if (this.reducedMotion()) {
      done();
    } else {
      scrim.style.pointerEvents = "none";
      sheet.animate({ opacity: [1, 0], scale: [1, 0.98] }, { duration: 110, easing: "cubic-bezier(0.4, 0, 1, 1)", fill: "forwards" });
      scrim.animate({ opacity: [1, 0] }, { duration: 110, fill: "forwards" }).finished.then(done, done);
    }
    if (restore && state.restore?.isConnected) {
      state.restore.focus();
    }
  },

  get sheet() {
    return this._sheet;
  },

  // A toast in the browser window (Zen's toasts), since Settings is a tab.
  toast(l10nId, { args, descriptionId, descriptionArgs, buttons, timeout } = {}) {
    const win = this.browserWindow();
    return win?.gZenUIManager?.toasts?.open(l10nId, { l10nArgs: args, descriptionId, descriptionArgs, buttons, timeout });
  },

  // ---- deep links and actions ----

  // about:preferences#whimsyAI?sheet=add-provider, and openSettings(win, action).
  _takeAction() {
    if (!this.root) {
      return;
    }
    let action = this.providers.takeSettingsAction?.() ?? null;
    const linked = this._linkedSheet ?? this.readLink();
    this._linkedSheet = null;
    action = linked ?? action;
    if (!action) {
      return;
    }
    const [sheet, method] = { connect: ["add-provider"], "plan-openai": ["openai", "plan"], "plan-claude": ["claude", "plan"] }[action] ?? [action];
    if (this._sheet?.id == sheet) {
      return;
    }
    if (this._sheets.has(sheet)) {
      this.openSheet(sheet, { restoreFocus: this.toggle, method });
    } else if (this._sections.has(sheet)) {
      this.jumpTo(sheet);
    }
  },

  // ?sheet=<id> in the address (before or after #whimsyAI), used once.
  readLink() {
    const match = /[?&]sheet=([\w-]+)/.exec(decodeURIComponent(location.hash || "")) ?? /[?&]sheet=([\w-]+)/.exec(location.search || "");
    if (match) {
      history.replaceState(null, "", `${location.href.split(/[?#]/)[0]}#whimsyAI`);
    }
    return match?.[1] ?? null;
  },

  // ---- shared bits for section files ----

  LOGOS: {
    apple: "chrome://browser/content/whimsy/ai/apple-intelligence.svg",
    claude: "chrome://browser/content/whimsy/icons/claude.svg",
    openai: "chrome://browser/content/whimsy/icons/openai.svg",
    gemini: "chrome://browser/content/whimsy/icons/gemini.svg",
    ollama: "chrome://browser/content/whimsy/ai/ollama.svg",
  },

  logo(id) {
    return this.LOGOS[id] ?? "chrome://browser/skin/zen-icons/sparkles.svg";
  },
};

// Read before Settings picks its pane from the hash: "#whimsyAI?sheet=…"
// would otherwise name no pane.
WhimsyAISettings._linkedSheet = WhimsyAISettings.readLink();

// ---- Features (fu-settings dec-10) ----

WhimsyAISettings.register({
  id: "features",
  order: 800,
  jumpL10nId: "whimsy-ai-jump-features",
  headingL10nId: "whimsy-ai-features-heading",
  descL10nId: "whimsy-ai-features-desc",
  build(container) {
    const S = WhimsyAISettings;
    const list = S.el("div", "whimsy-ai-list", container);
    const observers = [];
    for (const [id, pref, l10nId] of [
      ["whimsyAITidyTabs", "whimsy.feature.tidy-tabs", "whimsy-ai-features-tidy-tabs"],
      ["whimsyAITidyTitles", "whimsy.feature.tidy-titles", "whimsy-ai-features-tidy-titles"],
      ["whimsyAIAskOnPage", "whimsy.feature.ask-on-page", "whimsy-ai-features-ask-on-page"],
      ["whimsyAILinkPreviews", "whimsy.feature.link-previews", "whimsy-ai-features-link-previews"],
      ["whimsyAIPageWatch", "whimsy.feature.page-watch", "whimsy-ai-features-page-watch"],
    ]) {
      const item = S.el("div", "whimsy-ai-item", list);
      const toggle = S.el("moz-toggle", "", item, l10nId);
      toggle.id = id;
      toggle.dataset.featurePref = pref;
      toggle.setAttribute("data-l10n-attrs", "label, description");
      toggle.style.flex = "1";
      const update = () => {
        toggle.pressed = Services.prefs.getBoolPref(pref, true);
        toggle.disabled = Services.prefs.prefIsLocked(pref);
      };
      toggle.addEventListener("toggle", () => Services.prefs.setBoolPref(pref, toggle.pressed));
      Services.prefs.addObserver(pref, update);
      observers.push([pref, update]);
      update();
    }
    // The watch list stays with its switch until Library › Routines has it.
    const watches = S.watchList;
    if (watches) {
      list.querySelector("#whimsyAIPageWatch").parentElement.after(watches);
    }
    const routines = S.el("div", "whimsy-ai-item is-button", list);
    routines.id = "whimsyAIRoutinesRow";
    S.tile(routines, "chrome://browser/skin/zen-icons/library.svg");
    const text = S.el("span", "whimsy-ai-item-text", routines);
    S.el("span", "whimsy-ai-item-name", text, "whimsy-ai-features-routines");
    S.el("span", "whimsy-ai-item-detail", text, "whimsy-ai-features-routines-detail");
    const open = S.el("button", "whimsy-ai-link", routines, "whimsy-ai-features-routines-open");
    open.type = "button";
    open.id = "whimsyAIOpenLibrary";
    open.addEventListener("click", () => WhimsyAISettings.openRoutines());
    return () => observers.forEach(([pref, fn]) => Services.prefs.removeObserver(pref, fn));
  },
});

WhimsyAISettings.openRoutines = function () {
  const win = this.browserWindow();
  if (!win) {
    return false;
  }
  const { WhimsyArcMenus } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyArcMenus.sys.mjs");
  win.focus();
  if (WhimsyArcMenus.openLibrarySection(win, "routines")) {
    return true;
  }
  return WhimsyArcMenus.openLibrarySection(win, "history");
};

// ---- Outside agents: today's connector card, until its section is built ----

WhimsyAISettings.register({
  id: "outside-agents",
  order: 600,
  jumpL10nId: "whimsy-ai-jump-outside-agents",
  isAvailable: () => !!document.getElementById("whimsyClaudeGroup"),
  build(container) {
    const group = document.getElementById("whimsyClaudeGroup");
    group.querySelector(":scope > label")?.remove();
    group.hidden = false;
    container.append(group);
  },
});
