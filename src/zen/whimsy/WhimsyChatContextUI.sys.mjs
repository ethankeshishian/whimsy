/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// W23 chat-answers: what a chat reads, shown as chips inside the composer.
// A chip is the source's mark plus small icons with counts; hover and
// screen readers get the words. The chips are the context for the next
// message: × leaves one out for the rest of the chat (a note line offers
// Undo), + Add or a drop adds one, and asking for "all my tabs" widens it
// (a "Used …" line under the message keeps the history honest). A split
// view is one chat with a chip per pane. What AI sees is a sheet inside
// the panel: where it goes, one row per kind, and a drill-in per kind.

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  WhimsyVideoSummary: "resource:///modules/whimsy/WhimsyVideoSummary.sys.mjs",
  WhimsyAIContext: "resource:///modules/whimsy/WhimsyAIContext.sys.mjs",
  WhimsyAIProviders: "resource:///modules/whimsy/WhimsyAIProviders.sys.mjs",
  WhimsyAIStore: "resource:///modules/whimsy/WhimsyAIStore.sys.mjs",
  WhimsyChatAnswer: "resource:///modules/whimsy/WhimsyChatAnswer.sys.mjs",
  WhimsyChatThreads: "resource:///modules/whimsy/WhimsyChatThreads.sys.mjs",
});

const HTML_NS = "http://www.w3.org/1999/xhtml";
const ICONS = "chrome://browser/content/whimsy/icons/";
const EASE = "cubic-bezier(0.075, 0.82, 0.165, 1)";
const REDACTED = /\[(card number|secret|hidden)\]/g;
const FILE_CHARS = 200000;
const KIND_ICON = {
  text: `${ICONS}text-chip.svg`,
  images: `${ICONS}image-chip.svg`,
  videos: `${ICONS}video-chip.svg`,
  pages: `${ICONS}text-chip.svg`,
  tabs: `${ICONS}tabs-all.svg`,
};

// Per chat (or draft): {added: descriptor[], removed: string[]}.
const drafts = new Map();
// Granola's live chip per window (L08 sets it).
const liveChips = new WeakMap();
// What Esc does in each open What AI sees sheet.
const sheetEscapes = new WeakMap();

function h(doc, tag, attrs = {}, ...children) {
  const el = doc.createElementNS(HTML_NS, tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) {
      continue;
    }
    if (k == "l10n") {
      const [id, args] = Array.isArray(v) ? v : [v];
      doc.l10n.setAttributes(el, id, args);
    } else if (k.startsWith("on")) {
      el.addEventListener(k.slice(2), v);
    } else if (v === true) {
      el.setAttribute(k, "");
    } else {
      el.setAttribute(k, v);
    }
  }
  el.append(...children.flat(Infinity).filter(c => c != null && c !== false));
  return el;
}

function icon(doc, url, cls = "") {
  return h(doc, "span", { class: `whimsy-chat-icon ${cls}`.trim(), style: `--whimsy-chat-icon: url("${url}")`, "aria-hidden": "true" });
}

function reducedMotion(win) {
  return win.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function keyOf(thread) {
  return thread?.id ?? `draft:${thread?.tabKey ?? ""}`;
}

function emptyContext() {
  return { chips: [], parts: [], leftOut: { private: 0, hidden: 0, locked: 0 }, widened: [] };
}

function addInto(ctx, other) {
  const seen = new Set(ctx.chips.map(c => c.id));
  for (const chip of other.chips ?? []) {
    if (!seen.has(chip.id)) {
      seen.add(chip.id);
      ctx.chips.push(chip);
      ctx.parts.push(...(other.parts ?? []).filter(p => p.chipId == chip.id));
    }
  }
  for (const k of Object.keys(ctx.leftOut)) {
    ctx.leftOut[k] += other.leftOut?.[k] ?? 0;
  }
  ctx.widened.push(...(other.widened ?? []));
  return ctx;
}

function tabByKey(win, key) {
  for (const w of Services.wm.getEnumerator("navigator:browser")) {
    const tab = w.gBrowser?.tabs.find(t => lazy.WhimsyAIContext.tabKey(t) == key);
    if (tab) {
      return tab;
    }
  }
  return null;
}

function splitGroup(tab) {
  const win = tab?.documentGlobal;
  return tab?.splitView ? win?.gZenViewSplitter?._data?.find(g => g.tabs.includes(tab)) ?? null : null;
}

/** The words for a chip: "This tab · article · 2 images · 1 video". */
function chipArgs(chip) {
  const c = chip.counts ?? {};
  return {
    kind: chip.kind,
    label: chip.label ?? "",
    text: c.text ? 1 : 0,
    images: Number(c.images) || 0,
    videos: Number(c.videos) || 0,
    pages: Number(c.pages) || 0,
  };
}

export const WhimsyChatContextUI = {
  // ---- State ----

  stateOf(thread) {
    return drafts.get(keyOf(thread)) ?? thread?.context ?? { added: [], removed: [] };
  },

  async setState(thread, state) {
    drafts.set(keyOf(thread), state);
    if (thread?.id && !thread.draft) {
      thread.context = state;
      await lazy.WhimsyAIStore.updateThread(thread.id, { context: state, updated: thread.updated });
    }
  },

  adopt(draft, thread) {
    const state = drafts.get(keyOf(draft));
    if (state) {
      drafts.delete(keyOf(draft));
      return this.setState(thread, state);
    }
    return null;
  },

  /** In a split view, the chat belongs to the split (its first pane). */
  threadTab(tab) {
    return splitGroup(tab)?.tabs[0] ?? tab;
  },

  setLiveChip(win, chip) {
    if (chip) {
      liveChips.set(win, { ...chip, live: true });
    } else {
      liveChips.delete(win);
    }
    const panel = win.gBrowser && ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyChatPanel.sys.mjs").WhimsyChatPanel.forWindow(win);
    if (panel?.isOpen) {
      this.render(panel);
    }
  },

  // ---- What the chat reads ----

  /** The base context of the chat's tab (each pane of a split). */
  async baseFor(panel, thread) {
    const tab = thread?.kind == "tab" && !thread.closedTab ? lazy.WhimsyChatThreads.tabOf(thread) ?? (thread.draft ? panel.win.gBrowser.selectedTab : null) : null;
    if (!tab) {
      return emptyContext();
    }
    const ctx = await lazy.WhimsyAIContext.forSplit(tab);
    return { ...emptyContext(), ...ctx, chips: [...ctx.chips], parts: [...ctx.parts], leftOut: { ...emptyContext().leftOut, ...ctx.leftOut }, widened: [...(ctx.widened ?? [])] };
  },

  async addedContext(win, desc, prompt) {
    if (desc.kind == "tab") {
      const tab = tabByKey(win, desc.tabKey);
      return tab ? lazy.WhimsyAIContext.forTab(tab) : emptyContext();
    }
    if (desc.kind == "tabs") {
      const ctx = await lazy.WhimsyAIContext.allTabs(prompt ?? "", win);
      return { ...ctx, widened: [] };
    }
    // W23 video: "This video", what Summarize read.
    if (desc.kind == "video") {
      return lazy.WhimsyVideoSummary.contextFor(win, desc);
    }
    if (desc.kind == "file") {
      let text = "";
      try {
        text = /\.pdf$/i.test(desc.path) ? "" : (await IOUtils.readUTF8(desc.path)).slice(0, FILE_CHARS);
      } catch {}
      const chip = { id: desc.id, kind: "file", label: desc.label, icon: `${ICONS}pdf.svg`, counts: { text: text.length || undefined, pages: /\.pdf$/i.test(desc.path) ? 1 : undefined }, sourceId: desc.path };
      return { ...emptyContext(), chips: [chip], parts: text ? [{ chipId: desc.id, kind: "text", size: text.length, text, title: desc.label }] : [{ chipId: desc.id, kind: "pdf", size: 0, path: desc.path }] };
    }
    return emptyContext();
  },

  /**
   * Everything the next message reads: the tab, what was added, what the
   * prompt widens to, less what was left out. Widening sticks for the chat.
   */
  async contextFor(panel, thread, prompt = null) {
    const { win } = panel;
    const state = this.stateOf(thread);
    const ctx = await this.baseFor(panel, thread);
    for (const desc of state.added) {
      addInto(ctx, await this.addedContext(win, desc, prompt));
    }
    const live = liveChips.get(win);
    if (live) {
      addInto(ctx, { chips: [live], parts: live.parts ?? [] });
    }
    let out = ctx;
    if (prompt != null) {
      out = await lazy.WhimsyAIContext.widen(ctx, prompt, win);
      const sticky = (out.widened ?? []).filter(w => w.kind == "tabs");
      if (sticky.length && !state.added.some(d => d.kind == "tabs")) {
        await this.setState(thread, { ...state, added: [...state.added, { id: "tabs", kind: "tabs" }] });
      }
    }
    const removed = new Set(this.stateOf(thread).removed);
    // "All my tabs" already holds this tab (or each pane), so it stands in for their chips.
    const widenedTabs = out.chips.some(c => c.kind == "tabs" && !removed.has(c.id) && !removed.has("tabs"));
    const isRemoved = chip => removed.has(chip.id) || (chip.kind == "tabs" && removed.has("tabs")) || (widenedTabs && (chip.kind == "tab" || chip.kind == "pane"));
    return {
      ...out,
      chips: out.chips.filter(c => !isRemoved(c)),
      parts: out.parts.filter(p => !out.chips.some(c => c.id == p.chipId && isRemoved(c))),
    };
  },

  /** What a context needs from a model. */
  needsOf(ctx, system = "") {
    const parts = ctx?.parts ?? [];
    return {
      images: parts.some(p => p.kind == "image"),
      video: parts.some(p => p.kind == "video"),
      chars: String(system).length,
    };
  },

  // ---- Chips ----

  chipsFor(win, thread) {
    return this._shown?.get(keyOf(thread)) ?? [];
  },

  async render(panel) {
    const { doc, win } = panel;
    const thread = panel.thread;
    const token = (panel._chipToken = (panel._chipToken ?? 0) + 1);
    if (!thread || lazy.WhimsyAIContext.isPrivate(win.gBrowser.selectedTab)) {
      panel.chips.replaceChildren();
      return;
    }
    const ctx = await this.contextFor(panel, thread);
    if (token != panel._chipToken) {
      return;
    }
    this._shown ??= new Map();
    this._shown.set(keyOf(thread), ctx.chips);
    panel.contextNeeds = this.needsOf(ctx);
    const nodes = ctx.chips.map(chip => this.chip(panel, chip));
    nodes.push(
      h(doc, "button", {
        class: "whimsy-chat-chip whimsy-chat-chip-add",
        "aria-haspopup": "menu",
        onclick: e => this.openAddMenu(panel, e.currentTarget),
      }, icon(doc, "chrome://browser/skin/zen-icons/plus.svg"), h(doc, "span", { l10n: "whimsy-chat-chip-add" }))
    );
    panel.chips.replaceChildren(...nodes);
    await doc.l10n.translateFragment(panel.chips);
  },

  chip(panel, chip) {
    const { doc } = panel;
    const counts = chip.counts ?? {};
    const lead =
      chip.icon && !/^chrome:\/\/browser\/content\/whimsy\/icons\//.test(chip.icon)
        ? h(doc, "img", { class: "whimsy-chat-chip-mark", src: chip.icon, alt: "" })
        : icon(doc, chip.icon || KIND_ICON.text, "whimsy-chat-chip-mark");
    const label =
      chip.kind == "tab" ? h(doc, "span", { class: "whimsy-chat-chip-label", l10n: "whimsy-chat-chip-this-tab" })
        : chip.kind == "tabs" ? h(doc, "span", { class: "whimsy-chat-chip-label", l10n: "whimsy-chat-chip-all-tabs" })
          : h(doc, "span", { class: "whimsy-chat-chip-label" }, chip.label ?? "");
    const count = (kind, n) => h(doc, "span", { class: "whimsy-chat-chip-count", "data-kind": kind }, icon(doc, KIND_ICON[kind]), n ? String(n) : "");
    return h(
      doc,
      "span",
      { class: "whimsy-chat-chip", "data-chip": chip.id, "data-kind": chip.kind, live: chip.live || null, warning: chip.warning || null },
      h(
        doc,
        "button",
        {
          class: "whimsy-chat-chip-body",
          l10n: ["whimsy-chat-chip-words", chipArgs(chip)],
          onclick: () => this.openSheet(panel, chip.id),
          onkeydown: e => {
            if (e.key == "Delete" || e.key == "Backspace") {
              e.preventDefault();
              this.removeChip(panel.win, chip.id);
            }
          },
        },
        lead,
        label,
        chip.live ? h(doc, "span", { class: "whimsy-chat-chip-live", "aria-hidden": "true" }) : null,
        counts.text && chip.kind != "tabs" ? count("text", chip.kind == "file" || chip.kind == "pdf" ? counts.pages : 0) : null,
        counts.images ? count("images", counts.images) : null,
        counts.videos ? count("videos", counts.videos) : null,
        chip.kind == "tabs" ? count("tabs", counts.pages) : null
      ),
      h(doc, "button", { class: "whimsy-chat-chip-x", l10n: ["whimsy-chat-chip-remove", { label: chip.label ?? "" }], onclick: () => this.removeChip(panel.win, chip.id) }, icon(doc, "chrome://browser/skin/zen-icons/close.svg"))
    );
  },

  async addChip(win, desc) {
    const panel = this._panel(win);
    const thread = panel.thread;
    const state = this.stateOf(thread);
    if (!state.added.some(d => d.id == desc.id)) {
      await this.setState(thread, { added: [...state.added, desc], removed: state.removed.filter(id => id != desc.id) });
    } else if (state.removed.includes(desc.id)) {
      await this.setState(thread, { ...state, removed: state.removed.filter(id => id != desc.id) });
    }
    await this.render(panel);
  },

  async removeChip(win, chipId) {
    const panel = this._panel(win);
    const thread = panel.thread;
    const state = this.stateOf(thread);
    const chip = this.chipsFor(win, thread).find(c => c.id == chipId);
    const node = panel.chips.querySelector(`[data-chip="${CSS.escape(chipId)}"]`);
    await this.setState(thread, { ...state, removed: [...new Set([...state.removed, chipId])] });
    if (node && !reducedMotion(win)) {
      await node.animate({ scale: [1, 0.92], opacity: [1, 0] }, { duration: 150, easing: EASE, fill: "forwards" }).finished.catch(() => {});
    }
    const note = { role: "note", kind: "chip-removed", chipId, label: chip?.kind == "tab" ? "" : chip?.label ?? "", chipKind: chip?.kind ?? "" };
    let saved = note;
    if (thread?.id && !thread.draft) {
      saved = await lazy.WhimsyAIStore.append(thread.id, note);
    }
    const line = panel.renderNote(saved);
    if (line) {
      panel.body.querySelector(".whimsy-chat-empty")?.remove();
      panel.body.append(line);
      await panel.doc.l10n.translateFragment(line);
      if (!reducedMotion(win)) {
        line.animate({ gridTemplateRows: ["0fr", "1fr"], opacity: [0, 1] }, { duration: 300, easing: "cubic-bezier(0.34, 1.2, 0.64, 1)" });
      }
      panel.body.scrollTop = panel.body.scrollHeight;
    }
    await this.render(panel);
  },

  async undoRemove(win, msg, line) {
    const panel = this._panel(win);
    const thread = panel.thread;
    const state = this.stateOf(thread);
    await this.setState(thread, { ...state, removed: state.removed.filter(id => id != msg.chipId) });
    if (thread?.id && msg.id) {
      await lazy.WhimsyAIStore.updateMessage(thread.id, msg.id, { resolved: true });
    }
    line?.remove();
    await this.render(panel);
  },

  renderRemovedNote(doc, msg, ctx) {
    if (msg.resolved) {
      return null;
    }
    const { noteLine } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyChatAnswer.sys.mjs");
    const node = noteLine(doc, {
      kind: "chip-removed",
      iconUrl: `${ICONS}eye-slash.svg`,
      l10n: ["whimsy-chat-note-chip-removed", { label: msg.label ?? "", kind: msg.chipKind ?? "" }],
      buttons: [{ l10n: "whimsy-chat-undo", run: () => WhimsyChatContextUI.undoRemove(ctx.win, msg, node) }],
    });
    return node;
  },

  renderLeftOut(doc, msg) {
    const { noteLine } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyChatAnswer.sys.mjs");
    return noteLine(doc, {
      kind: "left-out",
      iconUrl: `${ICONS}eye-slash.svg`,
      l10n: ["whimsy-chat-note-left-out", { private: msg.leftOut?.private ?? 0, hidden: msg.leftOut?.hidden ?? 0, locked: msg.leftOut?.locked ?? 0 }],
    });
  },

  /** "Used all my tabs · 14" under a message whose context widened. */
  usedLine(doc, msg) {
    const used = msg.used ?? [];
    if (!used.length) {
      return null;
    }
    return h(
      doc,
      "div",
      { class: "whimsy-chat-used" },
      used.map(u => h(doc, "span", {}, icon(doc, u.kind == "tabs" ? KIND_ICON.tabs : `${ICONS}pdf.svg`), h(doc, "span", { l10n: ["whimsy-chat-used", { kind: u.kind, count: u.count ?? 0, label: u.label ?? "" }] })))
    );
  },

  openAddMenu(panel, anchor) {
    const { doc, win } = panel;
    panel.el.querySelector(".whimsy-chat-menu")?.remove();
    const current = new Set(this.chipsFor(win, panel.thread).map(c => c.sourceId));
    const tabs = win.gBrowser.visibleTabs.filter(t => !t.closing && !current.has(lazy.WhimsyAIContext.tabKey(t)) && !lazy.WhimsyAIContext.isOffLimits(t) && /^(https?|file):/.test(t.linkedBrowser.currentURI.spec)).slice(0, 6);
    const close = () => menu.remove();
    const item = (attrs, ...children) => h(doc, "button", { class: "whimsy-chat-option", role: "menuitem", tabindex: "-1", ...attrs }, ...children);
    const menu = h(
      doc,
      "div",
      {
        class: "whimsy-chat-menu whimsy-chat-add-menu",
        role: "menu",
        onkeydown: e => {
          const items = [...menu.querySelectorAll(".whimsy-chat-option")];
          const at = items.indexOf(doc.activeElement);
          if (e.key == "Escape") {
            e.preventDefault();
            e.stopPropagation();
            close();
            panel.composer.focus();
          } else if (e.key == "ArrowDown" || e.key == "ArrowUp") {
            e.preventDefault();
            items[(at + (e.key == "ArrowDown" ? 1 : items.length - 1)) % items.length]?.focus();
          }
        },
      },
      tabs.map(t =>
        item(
          { onclick: () => (close(), this.addChip(win, { id: `tab:${lazy.WhimsyAIContext.tabKey(t)}`, kind: "tab", tabKey: lazy.WhimsyAIContext.tabKey(t), label: t.label })) },
          h(doc, "img", { class: "whimsy-chat-brand", src: t.getAttribute("image") || "chrome://global/skin/icons/defaultFavicon.svg", alt: "" }),
          h(doc, "span", { class: "whimsy-chat-option-label" }, t.label)
        )
      ),
      tabs.length ? h(doc, "hr", { class: "whimsy-chat-menu-rule" }) : null,
      item({ onclick: () => (close(), this.addChip(win, { id: "tabs", kind: "tabs" })) }, icon(doc, KIND_ICON.tabs), h(doc, "span", { class: "whimsy-chat-option-label", l10n: "whimsy-chat-add-all-tabs" })),
      item({ onclick: () => (close(), this.pickFile(win)) }, icon(doc, `${ICONS}pdf.svg`), h(doc, "span", { class: "whimsy-chat-option-label", l10n: "whimsy-chat-add-file" }))
    );
    panel.panel.append(menu);
    const dismiss = e => {
      if (!menu.isConnected || (!menu.contains(e.target) && !anchor.contains(e.target))) {
        menu.remove();
        win.removeEventListener("mousedown", dismiss, true);
      }
    };
    win.addEventListener("mousedown", dismiss, true);
    doc.l10n.translateFragment(menu).then(() => {
      if (!reducedMotion(win)) {
        menu.animate({ opacity: [0, 1], scale: [0.98, 1], translate: ["0 4px", "0 0"] }, { duration: 180, easing: EASE });
      }
      menu.querySelector(".whimsy-chat-option")?.focus();
    });
    return menu;
  },

  async pickFile(win) {
    const fp = Cc["@mozilla.org/filepicker;1"].createInstance(Ci.nsIFilePicker);
    fp.init(win.browsingContext, "", Ci.nsIFilePicker.modeOpen);
    const result = await new Promise(resolve => fp.open(resolve));
    if (result == Ci.nsIFilePicker.returnOK && fp.file) {
      await this.addFile(win, fp.file.path);
    }
  },

  addFile(win, path) {
    return this.addChip(win, { id: `file:${path}`, kind: "file", path, label: PathUtils.filename(path) });
  },

  /** A tab or a file dropped on the panel becomes a chip. */
  onDrop(panel, event) {
    const dt = event.dataTransfer;
    const tab = dt.mozGetDataAt?.("application/x-moz-tabbrowser-tab", 0);
    if (tab?.linkedBrowser && !lazy.WhimsyAIContext.isOffLimits(tab)) {
      event.preventDefault();
      const key = lazy.WhimsyAIContext.tabKey(tab);
      return this.addChip(panel.win, { id: `tab:${key}`, kind: "tab", tabKey: key, label: tab.label });
    }
    const file = dt.files?.[0];
    if (file?.mozFullPath) {
      event.preventDefault();
      return this.addFile(panel.win, file.mozFullPath);
    }
    return null;
  },

  // ---- What AI sees ----

  async openSheet(panel, chipId = null) {
    const { doc, win } = panel;
    panel.el.querySelector(".whimsy-chat-sheet")?.remove();
    const thread = panel.thread;
    const ctx = await this.contextFor(panel, thread);
    const chips = chipId ? ctx.chips.filter(c => c.id == chipId) : ctx.chips;
    const parts = ctx.parts.filter(p => chips.some(c => c.id == p.chipId));
    const { provider, model } = lazy.WhimsyChatAnswer.resolve(thread, this.needsOf(ctx));
    const dest = lazy.WhimsyAIContext.describeDestination(provider, model);
    const caps = provider ? lazy.WhimsyAIProviders.capabilities(provider, model || undefined) : { maxInputChars: Infinity };
    const sheet = h(doc, "div", { class: "whimsy-chat-sheet", role: "dialog", "aria-labelledby": "whimsy-chat-sheet-title" });
    const close = () => {
      const done = () => sheet.remove();
      if (reducedMotion(win)) {
        done();
      } else {
        sheet.animate({ translate: ["0 0", "16px 0"], opacity: [1, 0] }, { duration: 180, easing: "cubic-bezier(0.4, 0, 1, 1)", fill: "forwards" }).finished.then(done, done);
      }
      panel.composer.focus();
    };
    const leaveOut = async ids => {
      for (const id of ids) {
        await this.removeChip(win, id);
      }
      close();
    };
    const header = (titleL10n, back) =>
      h(
        doc,
        "header",
        { class: "whimsy-chat-sheet-head" },
        h(doc, "button", { class: "whimsy-chat-btn", l10n: back ? "whimsy-chat-sheet-back" : "whimsy-chat-sheet-close-back", onclick: back ?? close }, icon(doc, "chrome://browser/skin/zen-icons/back.svg")),
        h(doc, "h3", { id: "whimsy-chat-sheet-title", l10n: titleL10n }),
        h(doc, "button", { class: "whimsy-chat-btn", l10n: "whimsy-chat-sheet-close", onclick: close }, icon(doc, "chrome://browser/skin/zen-icons/close.svg"))
      );
    const footer = (leaveL10n, ids, copy = null) =>
      h(
        doc,
        "div",
        { class: "whimsy-chat-sheet-foot" },
        copy ? h(doc, "button", { class: "whimsy-chat-pill-btn whimsy-chat-sees-copy", l10n: "whimsy-chat-sees-copy", onclick: copy }) : null,
        h(doc, "button", { class: "whimsy-chat-pill-btn", l10n: leaveL10n, onclick: () => leaveOut(ids) }),
        h(doc, "button", { class: "whimsy-chat-pill-btn primary", l10n: "whimsy-chat-sheet-done", onclick: close })
      );
    const kinds = [];
    const text = parts.filter(p => p.kind == "text" || p.kind == "page");
    const pages = parts.filter(p => p.kind == "page");
    const images = parts.filter(p => p.kind == "image");
    const videos = parts.filter(p => p.kind == "video");
    const chars = text.reduce((n, p) => n + (p.size ?? p.text?.length ?? 0), 0);
    if (pages.length) {
      kinds.push({ id: "pages", l10n: ["whimsy-chat-sees-pages", { count: pages.length }], detail: ["whimsy-chat-sees-chars", { chars }] });
    } else if (text.length) {
      kinds.push({ id: "text", l10n: "whimsy-chat-sees-text", detail: [chars > caps.maxInputChars ? "whimsy-chat-sees-chars-cut" : "whimsy-chat-sees-chars-whole", { chars, sent: Math.min(chars, caps.maxInputChars) }] });
    }
    if (images.length) {
      kinds.push({ id: "images", l10n: "whimsy-chat-sees-images", detail: ["whimsy-chat-sees-images-detail", { count: images.length }] });
    }
    if (videos.length) {
      kinds.push({ id: "videos", l10n: "whimsy-chat-sees-videos", detail: ["whimsy-chat-sees-videos-detail", { count: videos.length }] });
    }
    const drill = kind => {
      const body = h(doc, "div", { class: "whimsy-chat-sheet-body" });
      let copyAll = null;
      if (kind == "text") {
        const all = text.map(p => p.text ?? "").join("\n\n");
        const cut = Math.min(all.length, caps.maxInputChars);
        const pre = h(doc, "div", { class: "whimsy-chat-sees-text" });
        const add = s => {
          let at = 0;
          for (const m of s.matchAll(REDACTED)) {
            pre.append(s.slice(at, m.index), h(doc, "span", { class: "whimsy-chat-redacted" }, m[1]));
            at = m.index + m[0].length;
          }
          pre.append(s.slice(at));
        };
        add(all.slice(0, cut));
        if (cut < all.length) {
          pre.append(h(doc, "div", { class: "whimsy-chat-cut", l10n: ["whimsy-chat-sees-cut", { who: lazy.WhimsyAIProviders.providerName(provider), chars: cut }] }));
        }
        const row = kinds.find(k => k.id == "text");
        body.append(h(doc, "div", { class: "whimsy-chat-sees-section" }, h(doc, "span", { l10n: "whimsy-chat-sees-page-text" }), row ? h(doc, "span", { l10n: row.detail }) : null), pre);
        copyAll = () => lazy.WhimsyChatAnswer.copyText(all.slice(0, cut));
      } else if (kind == "pages") {
        body.append(h(doc, "ul", { class: "whimsy-chat-sees-list" }, pages.map(p => h(doc, "li", {}, h(doc, "span", { class: "whimsy-chat-sees-title" }, p.title ?? p.url ?? ""), h(doc, "span", { class: "whimsy-chat-sees-detail", l10n: ["whimsy-chat-sees-chars", { chars: p.size ?? 0 }] })))));
      } else if (kind == "images") {
        body.append(h(doc, "div", { class: "whimsy-chat-sees-grid" }, images.map(p => h(doc, "figure", {}, h(doc, "img", { src: p.url, alt: p.alt ?? "" }), h(doc, "figcaption", {}, [p.alt, p.w && p.h ? `${p.w}×${p.h}` : ""].filter(Boolean).join(" · "))))));
      } else {
        body.append(h(doc, "ul", { class: "whimsy-chat-sees-list" }, videos.map(p => h(doc, "li", {}, h(doc, "span", { class: "whimsy-chat-sees-title" }, p.title || p.url || "")))));
      }
      const view = h(doc, "div", { class: "whimsy-chat-sheet-view", "data-view": kind }, header(`whimsy-chat-sees-title-${kind}`, () => show(list(), true)), body, footer(`whimsy-chat-sees-leave-${kind}`, chips.map(c => c.id), copyAll));
      return view;
    };
    const list = () => {
      const destCard = h(
        doc,
        "div",
        { class: "whimsy-chat-sees-dest" },
        provider ? h(doc, "img", { class: "whimsy-chat-brand", src: lazy.WhimsyChatAnswer.brands?.[provider] ?? "", alt: "" }) : null,
        h(
          doc,
          "div",
          {},
          h(doc, "div", { class: "whimsy-chat-sees-dest-title", l10n: [dest.method == "local" ? "whimsy-chat-sees-dest-local" : "whimsy-chat-sees-dest", { who: provider ? lazy.WhimsyChatAnswer.who(provider, model) : "" }] }),
          h(doc, "div", { class: "whimsy-chat-sees-dest-detail", l10n: [`whimsy-chat-sees-method-${dest.method}${dest.leavesMac ? "" : "-stays"}`, { provider: provider ? lazy.WhimsyAIProviders.providerName(provider) : "" }] })
        )
      );
      return h(
        doc,
        "div",
        { class: "whimsy-chat-sheet-view", "data-view": "list" },
        header("whimsy-chat-sees-title", null),
        h(
          doc,
          "div",
          { class: "whimsy-chat-sheet-body" },
          destCard,
          h(doc, "div", { class: "whimsy-chat-sees-section" }, h(doc, "span", { l10n: chips.length == 1 && chips[0].kind == "tab" ? "whimsy-chat-sees-from-tab" : "whimsy-chat-sees-from" }), h(doc, "span", { l10n: ["whimsy-chat-sees-kinds", { count: kinds.length }] })),
          h(
            doc,
            "div",
            { class: "whimsy-chat-sees-rows" },
            kinds.map(k =>
              h(
                doc,
                "button",
                { class: "whimsy-chat-sees-row", "data-kind": k.id, onclick: () => show(drill(k.id)) },
                icon(doc, k.id == "images" ? KIND_ICON.images : k.id == "videos" ? KIND_ICON.videos : k.id == "pages" ? KIND_ICON.tabs : KIND_ICON.text),
                h(doc, "span", { class: "whimsy-chat-sees-row-text" }, h(doc, "span", { l10n: k.l10n }), h(doc, "span", { class: "whimsy-chat-sees-detail", l10n: k.detail })),
                icon(doc, "chrome://browser/content/whimsy/icons/chevron-down.svg", "whimsy-chat-sees-chevron")
              )
            )
          ),
          h(doc, "p", { class: "whimsy-chat-sees-never", l10n: "whimsy-chat-sees-never" })
        ),
        footer("whimsy-chat-sees-leave", chips.map(c => c.id))
      );
    };
    const show = async (view, back = false) => {
      // Every view already there leaves, including one still fading out.
      const old = [...sheet.children];
      sheet.append(view);
      await doc.l10n.translateFragment(view);
      if (old.length) {
        if (reducedMotion(win)) {
          old.forEach(v => v.remove());
        } else {
          const dir = back ? -1 : 1;
          view.animate({ translate: [`${dir * 16}px 0`, "0 0"], opacity: [0, 1] }, { duration: 240, easing: EASE });
          for (const v of old) {
            v.setAttribute("leaving", "true");
            v.animate({ opacity: [1, 0] }, { duration: 150, fill: "forwards" }).finished.then(() => v.remove(), () => v.remove());
          }
        }
      }
      view.querySelector(back ? `.whimsy-chat-sees-row` : "button:not([disabled])")?.focus();
    };
    // Esc anywhere in chat steps back from a drill-in, then closes the sheet.
    sheetEscapes.set(sheet, () => {
      if (sheet.querySelector(".whimsy-chat-sheet-view:not([data-view='list'], [leaving])")) {
        show(list(), true);
      } else {
        close();
      }
    });
    panel.panel.append(sheet);
    await show(list());
    if (!reducedMotion(win)) {
      sheet.animate({ translate: ["16px 0", "0 0"], opacity: [0, 1] }, { duration: 240, easing: EASE });
    }
    return sheet;
  },

  /** Esc in chat while `sheet` is open; false if it isn't a What AI sees sheet. */
  escapeSheet(sheet) {
    const run = sheetEscapes.get(sheet);
    run?.();
    return !!run;
  },

  _panel(win) {
    return ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyChatPanel.sys.mjs").WhimsyChatPanel.forWindow(win);
  },
};
