/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

// W23: Settings › AI › Commands (07 set-6.x, fu-settings 6.1, 6.2, 6.7).
// Built in (a switch hides each) and Yours (an edit button each). The
// sheet: name, result, then a prompt and model, or for Link an address
// with %s. No "Show in": every command shows in ⌘K and chat. Deleting one
// of yours shows an Undo toast, and ⌘Z undoes while it's up.

/* globals WhimsyAISettings */

(() => {
  const S = WhimsyAISettings;
  const lazy = {};
  ChromeUtils.defineESModuleGetters(lazy, {
    WhimsyAICommands: "resource:///modules/whimsy/WhimsyAICommands.sys.mjs",
    problems: "resource:///modules/whimsy/WhimsyAICommands.sys.mjs",
    RESULTS: "resource:///modules/whimsy/WhimsyAICommands.sys.mjs",
  });
  const C = () => lazy.WhimsyAICommands;
  const ZEN = "chrome://browser/skin/zen-icons/";
  const TOKENS = ["selection", "page", "link"];
  const view = { list: null };

  function modelLabel(node, cmd) {
    const P = S.providers;
    if (cmd.result == "link") {
      document.l10n.setAttributes(node, "whimsy-commands-model-none");
    } else if (cmd.model && cmd.model != "auto") {
      node.removeAttribute("data-l10n-id");
      node.textContent = P.providerName(cmd.model);
    } else if (cmd.builtIn && cmd.task != "summary" && P.quickTextOnApple && P.order.includes("apple") && P.isOn("apple")) {
      node.removeAttribute("data-l10n-id");
      node.textContent = P.providerName("apple");
    } else {
      document.l10n.setAttributes(node, "whimsy-commands-model-auto");
    }
  }

  function detailOf(node, cmd) {
    if (cmd.builtIn) {
      document.l10n.setAttributes(node, cmd.detailL10nId);
    } else if (cmd.result == "link") {
      node.textContent = cmd.url.replace(/^https?:\/\/(www\.)?/i, "");
    } else {
      node.textContent = cmd.prompt.replace(/\s+/g, " ").trim();
    }
  }

  function row(cmd) {
    const item = S.el("div", "whimsy-ai-item whimsy-commands-row");
    item.dataset.command = cmd.id;
    item.setAttribute("role", "listitem");
    item.toggleAttribute("data-off", cmd.builtIn && cmd.hidden);
    S.tile(item, cmd.builtIn ? cmd.icon : `${ZEN}${cmd.result == "link" ? "link" : "sparkles"}.svg`);
    const text = S.el("span", "whimsy-ai-item-text", item);
    const name = S.el("span", "whimsy-ai-item-name", text);
    name.textContent = cmd.name;
    detailOf(S.el("span", "whimsy-ai-item-detail whimsy-commands-detail", text), cmd);
    const end = S.el("span", "whimsy-ai-item-end", item);
    S.el("span", "whimsy-ai-pill", end, `whimsy-commands-result-${cmd.result}`).dataset.pill = "result";
    modelLabel(S.el("span", "whimsy-ai-pill", end), cmd);
    if (cmd.builtIn) {
      const toggle = S.el("moz-toggle", "", end, "whimsy-commands-show", { name: cmd.name });
      toggle.setAttribute("data-l10n-attrs", "aria-label");
      toggle.pressed = !cmd.hidden;
      toggle.addEventListener("toggle", () => {
        item.toggleAttribute("data-off", !toggle.pressed);
        C().setHidden(cmd.id, !toggle.pressed).catch(console.error);
      });
    } else {
      const edit = S.el("button", "whimsy-commands-iconbtn", end, "whimsy-commands-edit", { name: cmd.name });
      edit.type = "button";
      edit.addEventListener("click", () => S.openSheet("command", { id: cmd.id, restoreFocus: edit }));
    }
    return item;
  }

  async function render() {
    if (!view.list) {
      return;
    }
    await C().init();
    const all = C().list();
    const list = view.list;
    const focused = document.activeElement?.closest?.(".whimsy-commands-row")?.dataset.command;
    list.replaceChildren();
    S.el("div", "whimsy-ai-caption", list, "whimsy-commands-built-in");
    const built = S.el("div", "whimsy-ai-list", list);
    built.setAttribute("role", "list");
    built.id = "whimsyCommandsBuiltIn";
    for (const cmd of all.filter(c => c.builtIn)) {
      built.append(row(cmd));
    }
    S.el("div", "whimsy-ai-caption", list, "whimsy-commands-yours");
    const yours = S.el("div", "whimsy-ai-list", list);
    yours.setAttribute("role", "list");
    yours.id = "whimsyCommandsYours";
    const mine = all.filter(c => !c.builtIn);
    for (const cmd of mine) {
      yours.append(row(cmd));
    }
    if (!mine.length) {
      // The section's own New command is the one control; no second button here.
      const empty = S.el("div", "whimsy-ai-item", yours);
      empty.id = "whimsyCommandsEmpty";
      empty.setAttribute("role", "listitem");
      S.tile(empty, `${ZEN}plus.svg`);
      const text = S.el("span", "whimsy-ai-item-text", empty);
      S.el("span", "whimsy-ai-item-name", text, "whimsy-commands-empty-title");
      S.el("span", "whimsy-ai-item-detail", text, "whimsy-commands-empty-detail");
    }
    list.dataset.ready = "true";
    if (focused) {
      list.querySelector(`.whimsy-commands-row[data-command="${CSS.escape(focused)}"] button, .whimsy-commands-row[data-command="${CSS.escape(focused)}"] moz-toggle`)?.focus();
    }
  }

  // ---- the sheet ----

  // A styled listbox (whimsy-ai-popup), never a native menu.
  function listbox(anchor, options, selected, onPick, { focus = true } = {}) {
    document.getElementById("whimsyCommandsMenu")?.remove();
    const el = S.el("div", "whimsy-ai-popup", document.body ?? document.documentElement);
    el.id = "whimsyCommandsMenu";
    el.setAttribute("role", "listbox");
    for (const option of options) {
      const item = S.el("div", "whimsy-ai-popup-item", el, option.l10nId, option.l10nArgs);
      if (option.text) {
        item.textContent = option.text;
      }
      item.setAttribute("role", "option");
      item.tabIndex = -1;
      item.dataset.value = option.value;
      item.setAttribute("aria-selected", option.value == selected ? "true" : "false");
    }
    const rect = anchor.getBoundingClientRect();
    el.style.minWidth = `${Math.max(rect.width, 180)}px`;
    el.style.left = `${Math.max(8, rect.left)}px`;
    el.style.top = `${rect.bottom + 4}px`;
    anchor.setAttribute("aria-expanded", "true");
    const close = ({ restore = true } = {}) => {
      document.removeEventListener("mousedown", outside, true);
      el.remove();
      anchor.setAttribute("aria-expanded", "false");
      if (restore) {
        anchor.focus();
      }
    };
    const items = () => [...el.querySelectorAll('[role="option"]')];
    const choose = item => {
      close();
      onPick(item.dataset.value);
    };
    el.addEventListener("click", event => {
      const item = event.target.closest('[role="option"]');
      if (item) {
        choose(item);
      }
    });
    el.addEventListener("keydown", event => {
      const list = items();
      const at = list.indexOf(document.activeElement);
      const move = i => {
        event.preventDefault();
        list[(i + list.length) % list.length]?.focus();
      };
      if (event.key == "ArrowDown") {
        move(at + 1);
      } else if (event.key == "ArrowUp") {
        move(at - 1);
      } else if (event.key == "Enter" || event.key == " ") {
        event.preventDefault();
        if (list[at]) {
          choose(list[at]);
        }
      } else if (event.key == "Escape" || event.key == "Tab") {
        event.preventDefault();
        event.stopPropagation();
        close();
      }
    });
    const outside = event => {
      if (!el.contains(event.target) && event.target != anchor) {
        close({ restore: false });
      }
    };
    document.addEventListener("mousedown", outside, true);
    if (focus) {
      (items().find(i => i.getAttribute("aria-selected") == "true") ?? items()[0])?.focus();
    }
    return { el, close };
  }

  function field(state, id, labelL10nId, input) {
    const label = S.el("label", "whimsy-ai-label", state.body, labelL10nId);
    label.setAttribute("for", id);
    input.id = id;
    state.body.append(input);
    const error = S.el("span", "whimsy-ai-hint whimsy-commands-error", state.body);
    error.id = `${id}Error`;
    error.dataset.tone = "fail";
    error.setAttribute("role", "alert");
    error.hidden = true;
    input.setAttribute("aria-describedby", error.id);
    return error;
  }

  S.registerSheet("command", (state, opts = {}) => {
    const fill = C().takePrefill() ?? {};
    const id = opts.id ?? fill.id ?? null;
    const existing = id ? C().get(id) : null;
    const cmd = {
      id: existing?.id ?? null,
      name: existing?.name ?? fill.name ?? "",
      result: existing?.result ?? fill.result ?? "copy",
      prompt: existing?.prompt ?? fill.prompt ?? "",
      url: existing?.url ?? fill.url ?? "",
      model: existing?.model ?? fill.model ?? "auto",
    };
    state.sheet.classList.add("is-wide");
    document.l10n.setAttributes(state.title, existing ? "whimsy-commands-sheet-edit" : "whimsy-commands-sheet-new");

    const name = S.el("input", "whimsy-ai-input");
    name.type = "text";
    name.value = cmd.name;
    name.setAttribute("maxlength", "80");
    const nameError = field(state, "whimsyCommandName", "whimsy-commands-name", name);

    S.el("span", "whimsy-ai-label", state.body, "whimsy-commands-result").id = "whimsyCommandResultLabel";
    const seg = S.el("div", "whimsy-ai-seg", state.body);
    seg.id = "whimsyCommandResult";
    seg.setAttribute("role", "radiogroup");
    seg.setAttribute("aria-labelledby", "whimsyCommandResultLabel");
    seg.style.setProperty("--count", String(lazy.RESULTS.length));
    S.el("span", "whimsy-ai-seg-thumb", seg);
    for (const r of lazy.RESULTS) {
      const b = S.el("button", "", seg, `whimsy-commands-result-${r}`);
      b.type = "button";
      b.dataset.result = r;
      b.setAttribute("role", "radio");
      b.addEventListener("click", () => setResult(r, { focus: false }));
    }
    const resultHint = S.el("span", "whimsy-ai-hint", state.body, "whimsy-commands-result-hint");

    // Prompt and model, or the address.
    const promptBox = S.el("div", "whimsy-commands-group", state.body);
    const linkBox = S.el("div", "whimsy-commands-group", state.body);
    const promptState = { body: promptBox };
    const prompt = S.el("textarea", "whimsy-ai-input whimsy-commands-prompt");
    prompt.rows = 4;
    prompt.value = cmd.prompt;
    const promptError = field(promptState, "whimsyCommandPrompt", "whimsy-commands-prompt", prompt);
    S.el("span", "whimsy-ai-hint", promptBox, "whimsy-commands-prompt-hint");
    const modelRow = S.el("div", "whimsy-commands-model", promptBox);
    S.el("span", "whimsy-ai-label", modelRow, "whimsy-commands-model").id = "whimsyCommandModelLabel";
    const model = S.el("button", "whimsy-ai-dropdown", modelRow);
    model.type = "button";
    model.id = "whimsyCommandModel";
    model.setAttribute("aria-haspopup", "listbox");
    model.setAttribute("aria-expanded", "false");
    model.setAttribute("aria-labelledby", "whimsyCommandModelLabel whimsyCommandModel");
    const showModel = () => modelLabel(model, { ...cmd, result: "copy", builtIn: false });
    showModel();
    model.addEventListener("click", () => {
      if (model.getAttribute("aria-expanded") == "true") {
        document.getElementById("whimsyCommandsMenu")?.remove();
        model.setAttribute("aria-expanded", "false");
        return;
      }
      const P = S.providers;
      const options = [{ value: "auto", l10nId: "whimsy-commands-model-auto-choice" }, ...P.order.filter(p => P.isOn(p)).map(p => ({ value: p, text: P.providerName(p) }))];
      listbox(model, options, cmd.model, value => {
        cmd.model = value;
        showModel();
      });
    });

    const linkState = { body: linkBox };
    const address = S.el("input", "whimsy-ai-input whimsy-ai-mono");
    address.type = "url";
    address.value = cmd.url;
    address.placeholder = "https://";
    const addressError = field(linkState, "whimsyCommandAddress", "whimsy-commands-address", address);
    S.el("span", "whimsy-ai-hint", linkBox, "whimsy-commands-address-hint");

    // "{" offers the tokens.
    let tokens = null;
    prompt.addEventListener("input", event => {
      tokens?.close({ restore: false });
      tokens = null;
      if (event.data != "{") {
        return;
      }
      const at = prompt.selectionStart;
      tokens = listbox(prompt, TOKENS.map(t => ({ value: t, l10nId: `whimsy-commands-token-${t}` })), null, value => {
        const before = prompt.value.slice(0, at - 1);
        prompt.value = `${before}{${value}}${prompt.value.slice(at)}`;
        prompt.setSelectionRange(before.length + value.length + 2, before.length + value.length + 2);
        tokens = null;
      });
    });

    function setResult(r, { focus = true } = {}) {
      cmd.result = r;
      const index = lazy.RESULTS.indexOf(r);
      seg.style.setProperty("--index", String(index));
      for (const b of seg.querySelectorAll("button")) {
        const on = b.dataset.result == r;
        b.setAttribute("aria-checked", on ? "true" : "false");
        b.tabIndex = on ? 0 : -1;
        if (on && focus) {
          b.focus();
        }
      }
      promptBox.hidden = r == "link";
      linkBox.hidden = r != "link";
      resultHint.hidden = r == "link";
    }
    seg.addEventListener("keydown", event => {
      const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key];
      if (!step) {
        return;
      }
      event.preventDefault();
      const flip = document.dir == "rtl" && (event.key == "ArrowLeft" || event.key == "ArrowRight") ? -1 : 1;
      const list = lazy.RESULTS;
      setResult(list[(list.indexOf(cmd.result) + step * flip + list.length) % list.length]);
    });
    setResult(cmd.result, { focus: false });

    for (const [input, error] of [[name, nameError], [prompt, promptError], [address, addressError]]) {
      input.addEventListener("input", () => {
        input.removeAttribute("aria-invalid");
        error.hidden = true;
      });
    }

    if (existing) {
      const del = S.button(state.footer, "whimsy-commands-delete", { kind: "text", id: "whimsyCommandDelete" });
      del.classList.add("is-danger", "whimsy-ai-spacer");
      del.addEventListener("click", () => {
        S.closeSheet({ restore: false });
        C().remove(existing.id, S.browserWindow()).catch(console.error);
        view.list?.querySelector("#whimsyCommandsNew")?.focus();
      });
    }
    S.button(state.footer, "whimsy-ai-confirm-cancel-button", { onClick: () => S.closeSheet() });
    S.button(state.footer, "whimsy-commands-save", {
      kind: "primary",
      id: "whimsyCommandSave",
      onClick: async () => {
        const next = { ...cmd, name: name.value, prompt: prompt.value, url: address.value.trim() };
        const issues = lazy.problems(next);
        const shown = [[issues?.name, name, nameError], [issues?.prompt, prompt, promptError], [issues?.url, address, addressError]];
        let first = null;
        for (const [l10nId, input, error] of shown) {
          const bad = !!l10nId && !input.closest("[hidden]");
          error.hidden = !bad;
          input.toggleAttribute("aria-invalid", bad);
          if (bad) {
            document.l10n.setAttributes(error, l10nId);
            first ??= input;
          }
        }
        if (first) {
          first.focus();
          return;
        }
        try {
          await C().save(next.id ? next : { ...next, id: undefined });
          S.closeSheet();
        } catch (e) {
          console.error("Whimsy: saving a command", e);
        }
      },
    });
    name.setAttribute("autofocus", "");
  });

  S.register({
    id: "commands",
    order: 300,
    jumpL10nId: "whimsy-ai-jump-commands",
    headingL10nId: "whimsy-commands-heading",
    descL10nId: "whimsy-commands-desc",
    build(container) {
      const head = container.querySelector(".whimsy-ai-sec-head");
      const add = S.button(head, "whimsy-commands-new", { small: true, id: "whimsyCommandsNew" });
      add.addEventListener("click", () => S.openSheet("command", { restoreFocus: add }));
      view.list = S.el("div", "whimsy-commands-list", container);
      view.list.id = "whimsyCommandsList";
      const update = () => render().catch(console.error);
      Services.obs.addObserver(update, C().TOPIC);
      Services.prefs.addObserver("whimsy.ai.", update);
      update();
      return () => {
        Services.obs.removeObserver(update, C().TOPIC);
        Services.prefs.removeObserver("whimsy.ai.", update);
        view.list = null;
      };
    },
  });
})();
