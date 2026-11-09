/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

// W23 memory-fire: Settings › AI › Memory (set-7.1-7.5). One switch ("Use
// and save memories") that pauses both saving and using at once, then the
// list: source and date, edit in place (Return saves, Esc cancels), delete
// immediate with an Undo toast, and Export as Markdown.

/* globals WhimsyAISettings */

(() => {
  const S = WhimsyAISettings;
  const lazy = {};
  ChromeUtils.defineESModuleGetters(lazy, {
    WhimsyAIMemory: "resource:///modules/whimsy/WhimsyAIMemory.sys.mjs",
    WhimsyAIStore: "resource:///modules/whimsy/WhimsyAIStore.sys.mjs",
  });
  const ICONS = "chrome://browser/content/whimsy/icons/";
  const view = { list: null };

  function dateLabel(ms) {
    try {
      return new Services.intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(new Date(ms));
    } catch {
      return new Date(ms).toLocaleDateString();
    }
  }

  function startEdit(item, memory) {
    const textEl = item.querySelector(".whimsy-ai-item-name");
    const input = S.el("textarea", "whimsy-memory-edit");
    input.value = memory.text;
    input.rows = 1;
    textEl.replaceWith(input);
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
    const finish = async commit => {
      if (commit && input.value.trim() && input.value.trim() != memory.text) {
        await lazy.WhimsyAIMemory.update(memory.id, input.value.trim());
      }
      render();
    };
    input.addEventListener("keydown", event => {
      if (event.key == "Enter" && !event.shiftKey) {
        event.preventDefault();
        finish(true);
      } else if (event.key == "Escape") {
        event.preventDefault();
        event.stopPropagation();
        finish(false);
      }
    });
    input.addEventListener("blur", () => finish(true), { once: true });
  }

  // Where a memory came from: its chat's title (or first question), if
  // that chat is still around.
  async function sourceTitle(memory) {
    if (!memory.source) {
      return "";
    }
    const thread = await lazy.WhimsyAIStore.thread(memory.source).catch(() => null);
    return String(thread?.title || thread?.firstAsk || "").trim();
  }

  function row(memory, from = "") {
    const item = S.el("div", "whimsy-ai-item whimsy-memory-row");
    item.dataset.memory = memory.id;
    item.setAttribute("role", "listitem");
    S.tile(item, `${ICONS}memory.svg`);
    const text = S.el("span", "whimsy-ai-item-text", item);
    S.el("span", "whimsy-ai-item-name", text).textContent = memory.text;
    const date = dateLabel(memory.date ?? Date.now());
    if (from) {
      S.el("span", "whimsy-ai-item-detail", text, "whimsy-memory-from-chat", { title: from, date });
    } else {
      S.el("span", "whimsy-ai-item-detail", text, "whimsy-memory-date", { date });
    }
    const end = S.el("span", "whimsy-ai-item-end", item);
    const edit = S.el("button", "whimsy-ai-iconbtn", end, "whimsy-memory-edit-button", { fact: memory.text });
    edit.type = "button";
    S.el("img", "", edit).src = `${ICONS}pencil.svg`;
    edit.addEventListener("click", () => startEdit(item, memory));
    const del = S.el("button", "whimsy-ai-iconbtn", end, "whimsy-memory-delete-button", { fact: memory.text });
    del.type = "button";
    S.el("img", "", del).src = "chrome://browser/skin/zen-icons/trash.svg";
    del.addEventListener("click", () => doDelete(memory));
    return item;
  }

  async function doDelete(memory) {
    await lazy.WhimsyAIMemory.remove(memory.id, { block: false });
    await render();
    S.toast("whimsy-memory-deleted-toast", {
      buttons: [{ id: "whimsy-memory-undo-toast-button", l10nId: "whimsy-undo-toast-action", command: async () => {
        await lazy.WhimsyAIMemory.restore(memory);
        await render();
      } }],
    });
  }

  async function exportMarkdown() {
    const all = await lazy.WhimsyAIMemory.list();
    const lines = ["# Memory", "", ...all.map(m => `- ${m.text} _(${dateLabel(m.date ?? Date.now())})_`)];
    const picker = Cc["@mozilla.org/filepicker;1"].createInstance(Ci.nsIFilePicker);
    picker.init(window.browsingContext, "Export memory", Ci.nsIFilePicker.modeSave);
    picker.defaultString = "whimsy-memory.md";
    picker.appendFilter("Markdown", "*.md");
    const result = await new Promise(resolve => picker.open(resolve));
    if ((result == Ci.nsIFilePicker.returnOK || result == Ci.nsIFilePicker.returnReplace) && picker.file) {
      await IOUtils.writeUTF8(picker.file.path, lines.join("\n") + "\n");
    }
  }

  async function render() {
    if (!view.list) {
      return;
    }
    const on = Services.prefs.getBoolPref(lazy.WhimsyAIMemory.USE_PREF, true);
    view.toggle.pressed = on;
    view.list.hidden = !on;
    const all = await lazy.WhimsyAIMemory.list();
    if (!view.list) {
      return;
    }
    view.list.replaceChildren();
    view.empty.hidden = !!all.length;
    if (!all.length) {
      return;
    }
    const sources = await Promise.all(all.map(sourceTitle));
    if (!view.list) {
      return;
    }
    view.list.append(...all.map((memory, i) => row(memory, sources[i])));
    await document.l10n.translateFragment(view.list);
  }

  WhimsyAISettings.register({
    id: "memory",
    order: 400,
    jumpL10nId: "whimsy-ai-jump-memory",
    headingL10nId: "whimsy-ai-memory-heading",
    descL10nId: "whimsy-ai-memory-desc",
    build(container) {
      const switchRow = S.el("div", "whimsy-ai-item", container);
      const toggle = S.el("moz-toggle", "", switchRow, "whimsy-memory-switch");
      toggle.setAttribute("data-l10n-attrs", "label, description");
      toggle.setAttribute("inputlayout", "inline-end");
      toggle.style.flex = "1";
      toggle.addEventListener("toggle", () => Services.prefs.setBoolPref(lazy.WhimsyAIMemory.USE_PREF, toggle.pressed));
      view.toggle = toggle;
      const update = () => render();
      Services.prefs.addObserver(lazy.WhimsyAIMemory.USE_PREF, update);

      // Shown from the start (most people begin with none), so the page
      // doesn't grow under a jump once the list has loaded.
      const empty = S.el("p", "whimsy-ai-desc", container, "whimsy-memory-empty");
      view.empty = empty;
      const list = S.el("div", "whimsy-ai-list", container);
      list.setAttribute("role", "list");
      list.id = "whimsyMemoryList";
      view.list = list;

      const exportBtn = S.button(container, "whimsy-memory-export-button", { kind: "text", onClick: () => exportMarkdown() });
      exportBtn.id = "whimsyMemoryExport";

      render();
      return () => {
        Services.prefs.removeObserver(lazy.WhimsyAIMemory.USE_PREF, update);
        view.list = null;
      };
    },
  });
})();
