/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

// W23: Settings › AI › Providers. Only connected providers, in the order
// Whimsy tries them (drag, or ⌥↑/⌥↓ on the grip); each has a switch, a
// Usage link, and details with Disconnect. Connecting happens in sheets
// over the page (set-3.x), Claude Code's verified install included.

/* globals WhimsyAISettings */

(() => {
  const S = WhimsyAISettings;
  const lazy = {};
  ChromeUtils.defineESModuleGetters(lazy, {
    WhimsyAIClaudeCode: "resource:///modules/whimsy/WhimsyAIClaudeCode.sys.mjs",
    WhimsyAIProviders: "resource:///modules/whimsy/WhimsyAIProviders.sys.mjs",
    WhimsyClaudeCodeInstall: "resource:///modules/whimsy/WhimsyClaudeCodeInstall.sys.mjs",
  });
  const P = () => lazy.WhimsyAIProviders;
  const ALL = ["apple", "claude", "openai", "gemini", "ollama"];
  const CLOUD = ["claude", "openai", "gemini"];
  const KEY_SITES = { claude: "platform.claude.com", openai: "platform.openai.com", gemini: "aistudio.google.com" };
  const KEY_URLS = { claude: "https://platform.claude.com/settings/keys", openai: "https://platform.openai.com/api-keys", gemini: "https://aistudio.google.com/apikey" };
  const BILLED_BY = { claude: "Anthropic", openai: "OpenAI", gemini: "Google" };
  const CLAUDE_CODE_URL = "https://code.claude.com/docs/en/setup";
  const OLLAMA_URL = "https://ollama.com/download";
  const nameOf = id => P().providerName(id);
  const openTab = url => {
    const win = S.browserWindow();
    win?.focus();
    win?.openTrustedLinkIn(url, "tab");
  };

  // ---- the list ----

  const view = { list: null, open: new Set(), justAdded: null, status: null, info: new Map() };

  async function info(id) {
    const providers = P();
    const result = { id, connection: null, detailL10n: null, tone: null, problem: null };
    try {
      result.connection = await providers.connection(id);
    } catch (e) {
      console.error(e);
    }
    const c = result.connection;
    if (id == "claude" && c?.method == "plan") {
      const status = await lazy.WhimsyAIClaudeCode._authStatus().catch(() => ({ installed: true, loggedIn: true }));
      result.claudeCode = status;
      result.byWhimsy = await lazy.WhimsyClaudeCodeInstall.installedByWhimsy().catch(() => false);
      if (!status.installed) {
        result.problem = "claude-missing";
      } else if (!status.loggedIn) {
        result.problem = "signed-out";
      }
    } else if (c?.signedOut) {
      result.problem = "signed-out";
    }
    if (c?.method == "key") {
      result.hint = await providers.keyHint(id).catch(() => "");
    }
    return result;
  }

  // The nearest switched-on provider above is resting, so this one covers.
  function coveringFor(id) {
    const providers = P();
    if (id == "apple" || !providers.isOn(id) || providers.resting(id)) {
      return null;
    }
    const order = providers.order;
    for (let i = order.indexOf(id) - 1; i >= 0; i--) {
      const other = order[i];
      if (other != "apple" && providers.isOn(other)) {
        return providers.resting(other) ? { id: other, until: providers.resting(other).until } : null;
      }
    }
    return null;
  }

  function timeOf(when) {
    return new Date(when).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  }

  function detail(row, data) {
    const shown = baseDetail(row, data);
    const cover = !data.problem && coveringFor(data.id);
    if (!shown || !cover) {
      return;
    }
    const node = row.querySelector(".whimsy-ai-item-detail");
    document.l10n.formatValue(shown.l10nId, shown.args).then(text => {
      if (node.getAttribute("data-l10n-id") != shown.l10nId || !node.isConnected) {
        return;
      }
      const args = { detail: text, provider: nameOf(cover.id) };
      if (cover.until) {
        document.l10n.setAttributes(node, "whimsy-ai-row-covering-until", { ...args, time: timeOf(cover.until) });
      } else {
        document.l10n.setAttributes(node, "whimsy-ai-row-covering", args);
      }
    });
  }

  function baseDetail(row, data) {
    const providers = P();
    const id = data.id;
    const resting = providers.resting(id);
    const node = row.querySelector(".whimsy-ai-item-detail");
    node.removeAttribute("data-tone");
    node.replaceChildren();
    const set = (l10nId, args, tone) => {
      document.l10n.setAttributes(node, l10nId, args);
      if (tone) {
        node.dataset.tone = tone;
      }
      return { l10nId, args };
    };
    const c = data.connection;
    const name = row.querySelector(".whimsy-ai-item-name");
    name.querySelector(".whimsy-ai-pill")?.remove();
    if (data.problem == "claude-missing") {
      return set("whimsy-ai-row-claude-missing", null, "fail");
    }
    if (data.problem == "signed-out") {
      return set(`whimsy-ai-row-signed-out-${id}`, null, "warn");
    }
    if (resting) {
      const pill = S.el("span", "whimsy-ai-pill", name, "whimsy-ai-row-resting-pill");
      pill.dataset.tone = "warn";
      return resting.until
        ? set("whimsy-ai-row-resting-until", { time: timeOf(resting.until), message: resting.message || "" }, "warn")
        : set("whimsy-ai-row-resting", { message: resting.message || "" }, "warn");
    }
    if (!providers.isOn(id)) {
      return set("whimsy-ai-row-off");
    }
    if (id == "apple") {
      return set("whimsy-ai-row-apple");
    }
    if (id == "ollama") {
      return set("whimsy-ai-row-ollama", { model: providers.modelOf("ollama") || "" });
    }
    if (c?.method == "plan") {
      return set(`whimsy-ai-row-plan-${id}`, { label: c.label || "" });
    }
    if (c?.method == "key") {
      return set(data.hint ? "whimsy-ai-row-key" : "whimsy-ai-row-key-nohint", { hint: data.hint || "", provider: BILLED_BY[id] ?? nameOf(id) });
    }
    return set("whimsy-ai-row-connected");
  }

  function rowEnd(row, data) {
    const providers = P();
    const id = data.id;
    const end = row.querySelector(".whimsy-ai-item-end");
    end.replaceChildren();
    if (data.problem == "claude-missing" || data.problem == "signed-out") {
      S.button(end, data.problem == "claude-missing" ? "whimsy-ai-row-install" : "whimsy-ai-row-sign-in-again", {
        small: true,
        onClick: () => S.openSheet(id, { restoreFocus: row.querySelector(".whimsy-ai-grip") }),
      }).dataset.action = "fix";
      S.button(end, "whimsy-ai-row-check-again", { small: true, onClick: () => render(true) }).dataset.action = "check";
    } else {
      const usage = providers.usageUrl(id);
      if (usage && CLOUD.includes(id)) {
        const link = S.el("button", "whimsy-ai-link is-external", end, "whimsy-ai-row-usage");
        link.type = "button";
        link.dataset.action = "usage";
        link.addEventListener("click", () => openTab(usage));
      }
    }
    const toggle = S.el("moz-toggle", "", end, "whimsy-ai-row-switch", { provider: nameOf(id) });
    toggle.setAttribute("data-l10n-attrs", "aria-label");
    toggle.pressed = providers.isOn(id);
    toggle.addEventListener("toggle", () => providers.setOn(id, toggle.pressed));
    const chev = S.el("button", "whimsy-ai-chev", end, "whimsy-ai-row-details", { provider: nameOf(id) });
    chev.type = "button";
    chev.dataset.action = "details";
    chev.setAttribute("aria-expanded", view.open.has(id) ? "true" : "false");
    chev.addEventListener("click", () => toggleOpen(id));
  }

  function caps(parent, id) {
    const c = P().capabilities(id);
    const box = S.el("span", "whimsy-ai-caps", parent);
    for (const [key, on] of [
      ["text", true],
      ["images", !!c.images],
      ["thinking", !!c.thinking?.length],
      ["tools", !!c.tools],
    ]) {
      const cap = S.el("span", "whimsy-ai-cap", box, `whimsy-ai-cap-${key}`);
      cap.classList.toggle("is-no", !on);
    }
    return box;
  }

  async function body(row, data) {
    const providers = P();
    const id = data.id;
    const outer = S.el("div", "whimsy-ai-body");
    outer.dataset.provider = id;
    const inner = S.el("div", "whimsy-ai-body-in", S.el("div", "", outer));
    const kv = S.el("dl", "whimsy-ai-kv", inner);
    const pair = (l10nId, fill) => {
      S.el("dt", "", kv, l10nId);
      const dd = S.el("dd", "", kv);
      fill(dd);
      return dd;
    };
    const c = data.connection;
    if (c?.method == "plan") {
      pair("whimsy-ai-detail-signed-in", dd => {
        if (c.label) {
          dd.textContent = c.label;
        } else {
          document.l10n.setAttributes(dd, "whimsy-ai-detail-signed-in-plan");
        }
      });
    } else if (c?.method == "key") {
      pair("whimsy-ai-detail-key", dd => document.l10n.setAttributes(dd, data.hint ? "whimsy-ai-detail-key-ending" : "whimsy-ai-detail-key-saved", { hint: data.hint || "" }));
    } else {
      pair("whimsy-ai-detail-runs", dd => document.l10n.setAttributes(dd, "whimsy-ai-detail-on-this-mac"));
    }
    if (id == "claude" && c?.method == "plan") {
      pair("whimsy-ai-detail-claude-code", dd => document.l10n.setAttributes(dd, data.byWhimsy ? "whimsy-ai-detail-claude-code-whimsy" : "whimsy-ai-detail-claude-code-yours"));
    }
    if (id != "apple") {
      pair("whimsy-ai-detail-model", dd => modelPicker(dd, id, c));
    }
    pair("whimsy-ai-detail-can-do", dd => caps(dd, id));
    const resting = providers.resting(id);
    if (resting?.message) {
      pair("whimsy-ai-detail-last-limit", dd => (dd.textContent = `“${resting.message}”`));
    }
    const actions = S.el("div", "whimsy-ai-actions", inner);
    const cap = providers.capabilities(id);
    if (!cap.images || !cap.tools) {
      S.el("span", "whimsy-ai-hint whimsy-ai-spacer", actions, "whimsy-ai-detail-skips", { provider: nameOf(id) });
    } else {
      S.el("span", "whimsy-ai-spacer", actions);
    }
    if (data.byWhimsy) {
      const remove = S.button(actions, "whimsy-ai-detail-remove-claude-code", { kind: "text danger" });
      remove.dataset.action = "remove-claude-code";
      remove.addEventListener("click", () =>
        S.confirmStrip(row, {
          titleL10nId: "whimsy-ai-remove-claude-code-title",
          textL10nId: "whimsy-ai-remove-claude-code-text",
          okL10nId: "whimsy-ai-remove-claude-code-ok",
          restoreFocus: remove,
          onConfirm: async () => {
            await providers.disconnect("claude");
            await lazy.WhimsyClaudeCodeInstall.remove();
          },
        })
      );
    }
    const disconnect = S.button(actions, "whimsy-ai-detail-disconnect", { small: true });
    disconnect.dataset.action = "disconnect";
    disconnect.addEventListener("click", () => confirmDisconnect(row, id, c, disconnect));
    return outer;
  }

  async function confirmDisconnect(row, id, connection, button) {
    const providers = P();
    const kind = connection?.method == "plan" ? `plan-${id}` : connection?.method == "key" ? "key" : id;
    const parts = [await document.l10n.formatValue(`whimsy-ai-confirm-${kind}`)];
    const order = providers.order.filter(other => other != id && providers.isOn(other));
    const at = providers.order.indexOf(id);
    const next = providers.order.slice(at + 1).find(other => providers.isOn(other));
    if (next) {
      parts.push(await document.l10n.formatValue("whimsy-ai-confirm-moves-up", { provider: nameOf(next), rank: order.indexOf(next) + 1 }));
    } else if (!order.length) {
      parts.push(await document.l10n.formatValue("whimsy-ai-confirm-last"));
    }
    view.open.delete(id);
    row.nextElementSibling?.classList.contains("whimsy-ai-body") && row.nextElementSibling.remove();
    row.querySelector(".whimsy-ai-chev")?.setAttribute("aria-expanded", "false");
    S.confirmStrip(row, {
      titleL10nId: "whimsy-ai-confirm-title",
      titleArgs: { provider: nameOf(id) },
      text: parts.join(" "),
      okL10nId: "whimsy-ai-confirm-disconnect-button",
      restoreFocus: row.querySelector(".whimsy-ai-chev") ?? button,
      onConfirm: () => providers.disconnect(id),
    });
  }

  function modelPicker(dd, id, connection) {
    const providers = P();
    const current = providers.modelOf(id);
    const button = S.el("button", "whimsy-ai-dropdown", dd);
    button.type = "button";
    button.dataset.action = "model";
    button.setAttribute("aria-haspopup", "listbox");
    button.setAttribute("aria-expanded", "false");
    const label = value => {
      if (value) {
        button.removeAttribute("data-l10n-id");
        button.textContent = value;
      } else {
        document.l10n.setAttributes(button, id == "claude" && connection?.method == "plan" ? "whimsy-ai-model-claude-code" : "whimsy-ai-model-default-choice");
      }
    };
    label(current);
    button.addEventListener("click", async () => {
      if (button.getAttribute("aria-expanded") == "true") {
        closeMenu();
        return;
      }
      let models = [];
      try {
        models = await providers.models(id);
      } catch {}
      openMenu(button, [{ value: "", l10nId: id == "claude" && connection?.method == "plan" ? "whimsy-ai-model-claude-code" : "whimsy-ai-model-default-choice" }, ...models.map(m => ({ value: m, text: m }))], current, value => {
        providers.setModel(id, value);
        label(value);
      });
    });
  }

  // A styled listbox (whimsy-ai-popup), never a native menu.
  let menu = null;
  function closeMenu({ restore = true } = {}) {
    if (!menu) {
      return;
    }
    const { el, anchor, cleanup } = menu;
    menu = null;
    cleanup();
    el.remove();
    anchor.setAttribute("aria-expanded", "false");
    if (restore) {
      anchor.focus();
    }
  }
  function openMenu(anchor, options, selected, onPick) {
    closeMenu({ restore: false });
    const el = S.el("div", "whimsy-ai-popup", document.body ?? document.documentElement);
    el.id = "whimsyAIModelMenu";
    el.setAttribute("role", "listbox");
    for (const option of options) {
      const item = S.el("div", "whimsy-ai-popup-item", el, option.l10nId);
      if (option.text) {
        item.textContent = option.text;
      }
      item.setAttribute("role", "option");
      item.tabIndex = -1;
      item.dataset.value = option.value;
      item.setAttribute("aria-selected", option.value == selected ? "true" : "false");
    }
    const rect = anchor.getBoundingClientRect();
    el.style.minWidth = `${Math.max(rect.width, 260)}px`;
    el.style.left = `${Math.max(8, rect.left)}px`;
    el.style.top = `${rect.bottom + 4}px`;
    anchor.setAttribute("aria-expanded", "true");
    const items = () => [...el.querySelectorAll('[role="option"]')];
    const choose = item => {
      closeMenu();
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
        closeMenu();
      }
    });
    const outside = event => {
      if (!el.contains(event.target) && event.target != anchor) {
        closeMenu({ restore: false });
      }
    };
    document.addEventListener("mousedown", outside, true);
    menu = { el, anchor, cleanup: () => document.removeEventListener("mousedown", outside, true) };
    (items().find(i => i.getAttribute("aria-selected") == "true") ?? items()[0])?.focus();
  }

  async function toggleOpen(id) {
    const row = view.list.querySelector(`.whimsy-ai-item[data-provider="${id}"]`);
    if (!row) {
      return;
    }
    const chev = row.querySelector(".whimsy-ai-chev");
    const existing = row.nextElementSibling?.classList.contains("whimsy-ai-body") ? row.nextElementSibling : null;
    if (existing) {
      view.open.delete(id);
      existing.remove();
      row.setAttribute("aria-expanded", "false");
      chev.setAttribute("aria-expanded", "false");
      return;
    }
    view.open.add(id);
    row.setAttribute("aria-expanded", "true");
    chev.setAttribute("aria-expanded", "true");
    const data = view.info.get(id) ?? (await info(id));
    const node = await body(row, data);
    if (!view.open.has(id) || !row.isConnected) {
      return;
    }
    row.after(node);
    view.unfolding = S.unfold(node);
  }

  function makeRow(id, rank, count) {
    const row = S.el("div", "whimsy-ai-item");
    row.dataset.provider = id;
    row.setAttribute("role", "listitem");
    row.toggleAttribute("data-off", !P().isOn(id));
    const grip = S.el("button", "whimsy-ai-grip", row, "whimsy-ai-row-grip", { provider: nameOf(id), rank, count });
    grip.type = "button";
    grip.dataset.action = "grip";
    grip.addEventListener("keydown", event => {
      if (event.altKey && (event.key == "ArrowUp" || event.key == "ArrowDown")) {
        event.preventDefault();
        move(id, event.key == "ArrowUp" ? -1 : 1);
      }
    });
    grip.addEventListener("pointerdown", event => startDrag(event, id, row));
    const rankNode = S.el("span", "whimsy-ai-rank", row);
    rankNode.textContent = String(rank);
    rankNode.setAttribute("aria-hidden", "true");
    S.tile(row, S.logo(id), { logo: true });
    const text = S.el("span", "whimsy-ai-item-text", row);
    const name = S.el("span", "whimsy-ai-item-name", text);
    name.append(S.el("span", "", null, `whimsy-ai-name-${id}`));
    const d = S.el("span", "whimsy-ai-item-detail", text);
    d.append(S.el("span", "whimsy-ai-skeleton"));
    d.firstChild.style.cssText = "width:180px;margin-top:4px";
    const end = S.el("span", "whimsy-ai-item-end", row);
    const skeleton = S.el("span", "whimsy-ai-skeleton", end);
    skeleton.style.cssText = "width:30px;height:18px;border-radius:9px";
    row.addEventListener("click", event => {
      if (!event.target.closest("button, moz-toggle, a")) {
        toggleOpen(id);
      }
    });
    return row;
  }

  // Keyboard reorder: one place per press, said aloud.
  function move(id, delta) {
    const providers = P();
    const order = providers.order;
    const at = order.indexOf(id);
    const to = at + delta;
    if (at < 0 || to < 0 || to >= order.length) {
      return;
    }
    order.splice(at, 1);
    order.splice(to, 0, id);
    view.focusGrip = id;
    providers.setOrder(order);
    document.l10n.setAttributes(view.status, "whimsy-ai-order-moved", { provider: nameOf(id), rank: to + 1, count: order.length });
  }

  // Drag: the row lifts and a dashed slot shows where it lands.
  function startDrag(event, id, row) {
    if (event.button != 0) {
      return;
    }
    event.preventDefault();
    const grip = event.currentTarget;
    grip.setPointerCapture?.(event.pointerId);
    const list = view.list;
    const rows = () => [...list.querySelectorAll(".whimsy-ai-item[data-provider]")].filter(r => r != row);
    for (const r of [...list.querySelectorAll(".whimsy-ai-body, .whimsy-ai-confirm")]) {
      r.remove();
    }
    view.open.clear();
    const rect = row.getBoundingClientRect();
    const listRect = list.getBoundingClientRect();
    const slot = S.el("div", "whimsy-ai-slot");
    slot.style.height = `${rect.height - 8}px`;
    row.after(slot);
    row.classList.add("is-lifted");
    row.style.position = "absolute";
    row.style.width = `${rect.width}px`;
    row.style.left = "0";
    list.style.position = "relative";
    const offset = event.clientY - rect.top;
    const place = y => {
      row.style.top = `${y - listRect.top - offset}px`;
      const mid = y - offset + rect.height / 2;
      const target = rows().find(r => {
        const b = r.getBoundingClientRect();
        return mid < b.top + b.height / 2;
      });
      const anchor = target ?? list.querySelector(".whimsy-ai-add");
      if (anchor && slot.nextElementSibling != anchor) {
        anchor.before(slot);
      }
    };
    place(event.clientY);
    view.dragging = { row, slot };
    const onMove = e => place(e.clientY);
    const onUp = () => {
      grip.removeEventListener("pointermove", onMove);
      grip.removeEventListener("pointerup", onUp);
      grip.removeEventListener("lostpointercapture", onUp);
      const order = [];
      for (const node of list.children) {
        if (node == slot) {
          order.push(id);
        } else if (node != row && node.dataset?.provider && node.classList.contains("whimsy-ai-item")) {
          order.push(node.dataset.provider);
        }
      }
      view.dragging = null;
      slot.remove();
      row.classList.remove("is-lifted");
      row.style.cssText = "";
      list.style.position = "";
      view.focusGrip = id;
      if (order.join(",") == P().order.join(",")) {
        render();
      } else {
        P().setOrder(order);
        document.l10n.setAttributes(view.status, "whimsy-ai-order-moved", { provider: nameOf(id), rank: order.indexOf(id) + 1, count: order.length });
      }
    };
    grip.addEventListener("pointermove", onMove);
    grip.addEventListener("pointerup", onUp);
    grip.addEventListener("lostpointercapture", onUp);
  }

  let renderSerial = 0;
  async function render(fresh = false) {
    if (!view.list || view.dragging) {
      return;
    }
    const providers = P();
    const serial = ++renderSerial;
    const order = providers.order;
    const list = view.list;
    const focusedProvider = document.activeElement?.closest?.(".whimsy-ai-item[data-provider]")?.dataset.provider;
    const focusedAction = document.activeElement?.dataset?.action;
    const rows = order.map((id, i) => {
      const row = makeRow(id, i + 1, order.length);
      const known = !fresh && view.info.get(id);
      if (known) {
        detail(row, known);
        rowEnd(row, known);
      }
      return row;
    });
    const add = S.el("button", "whimsy-ai-item is-compact is-button whimsy-ai-add");
    add.type = "button";
    add.id = "whimsyAIAddProvider";
    add.style.cssText = "width:100%;border:0;font:inherit;color:inherit;text-align:start";
    S.el("span", "", add).style.width = "38px";
    S.tile(add, "chrome://browser/skin/zen-icons/plus.svg");
    S.el("span", "whimsy-ai-item-name", add, "whimsy-ai-add-provider");
    add.addEventListener("click", () => S.openSheet("add-provider", { restoreFocus: add }));
    list.replaceChildren(...rows, add);
    if (focusedProvider || view.focusGrip) {
      const id = view.focusGrip ?? focusedProvider;
      list.querySelector(`.whimsy-ai-item[data-provider="${id}"] [data-action="${view.focusGrip ? "grip" : focusedAction}"]`)?.focus();
    }
    view.focusGrip = null;
    view.quick.hidden = !order.includes("apple");
    view.quickToggle.pressed = providers.quickTextOnApple;
    const datas = await Promise.all(order.map(id => info(id)));
    if (serial != renderSerial) {
      return;
    }
    for (const data of datas) {
      view.info.set(data.id, data);
      const row = list.querySelector(`.whimsy-ai-item[data-provider="${data.id}"]`);
      const refocus = row.contains(document.activeElement) ? document.activeElement.dataset.action : null;
      detail(row, data);
      rowEnd(row, data);
      if (refocus) {
        row.querySelector(`[data-action="${refocus}"]`)?.focus();
      }
      if (view.open.has(data.id)) {
        view.open.delete(data.id);
        toggleOpen(data.id);
      }
    }
    list.dataset.ready = "true";
    if (view.justAdded) {
      const row = list.querySelector(`.whimsy-ai-item[data-provider="${view.justAdded}"]`);
      view.justAdded = null;
      if (row) {
        view.arrived = S.unfold(row);
      }
    }
  }

  function howCard(container) {
    const card = S.el("div", "whimsy-ai-list", container);
    card.id = "whimsyAIHowPicks";
    card.hidden = true;
    const ol = S.el("ol", "whimsy-ai-howto", card);
    for (const n of [1, 2, 3, 4]) {
      const li = S.el("li", "", ol);
      S.el("b", "", li, `whimsy-ai-how-${n}-title`);
      li.append(" ");
      S.el("span", "", li, `whimsy-ai-how-${n}`);
    }
    return card;
  }

  S.register({
    id: "providers",
    order: 100,
    jumpL10nId: "whimsy-ai-jump-providers",
    headingL10nId: "whimsy-ai-providers-heading",
    descL10nId: "whimsy-ai-providers-desc",
    build(container) {
      const how = S.el("button", "whimsy-ai-btn is-text", container.whimsyHead, "whimsy-ai-how-button");
      how.type = "button";
      how.id = "whimsyAIHowButton";
      how.setAttribute("aria-expanded", "false");
      view.list = S.el("div", "whimsy-ai-list", container);
      view.list.id = "whimsyAIProviderList";
      view.list.setAttribute("role", "list");
      document.l10n.setAttributes(view.list, "whimsy-ai-providers-list");
      const howBox = howCard(container);
      how.setAttribute("aria-controls", howBox.id);
      how.addEventListener("click", () => {
        const open = howBox.hidden;
        howBox.hidden = !open;
        how.setAttribute("aria-expanded", String(open));
        if (open) {
          view.howAnimation = S.unfold(howBox);
        }
      });
      view.quick = S.el("div", "whimsy-ai-list", container);
      view.quick.id = "whimsyAIQuickTextCard";
      const quick = S.el("div", "whimsy-ai-item", view.quick);
      S.tile(quick, S.logo("apple"), { logo: true });
      view.quickToggle = S.el("moz-toggle", "", quick, "whimsy-ai-quick-text");
      view.quickToggle.id = "whimsyAIQuickText";
      view.quickToggle.setAttribute("data-l10n-attrs", "label, description");
      view.quickToggle.setAttribute("inputlayout", "inline-end");
      view.quickToggle.style.flex = "1";
      view.quickToggle.addEventListener("toggle", () => (P().quickTextOnApple = view.quickToggle.pressed));
      view.status = S.el("div", "whimsy-ai-status", container);
      view.status.id = "whimsyAIOrderStatus";
      view.status.setAttribute("role", "status");
      const changed = (subject, topic, what) => {
        if (what == "connected") {
          const order = P().order;
          view.justAdded = order.at(-1);
        }
        if (what == "switch") {
          for (const row of view.list.querySelectorAll(".whimsy-ai-item[data-provider]")) {
            row.toggleAttribute("data-off", !P().isOn(row.dataset.provider));
            const data = view.info.get(row.dataset.provider);
            if (data) {
              detail(row, data);
            }
          }
          return;
        }
        render(what == "connected" || what == "order" ? false : true);
      };
      const accounts = () => render(true);
      Services.obs.addObserver(changed, "whimsy-ai-providers-changed");
      Services.obs.addObserver(accounts, "whimsy-ai-accounts-changed");
      render(true);
      return () => {
        Services.obs.removeObserver(changed, "whimsy-ai-providers-changed");
        Services.obs.removeObserver(accounts, "whimsy-ai-accounts-changed");
        closeMenu({ restore: false });
      };
    },
  });

  // ---- sheets ----

  function sheetHead(state, id, titleL10nId = "whimsy-ai-sheet-connect-title") {
    document.l10n.setAttributes(state.title, titleL10nId, { provider: nameOf(id) });
    const tile = S.tile(null, S.logo(id), { logo: true });
    state.head.prepend(tile);
  }

  // A rebuilt sheet keeps focus inside it.
  function clear(state) {
    if (state.sheet.contains(document.activeElement)) {
      setTimeout(() => {
        if (S.sheet == state && !state.sheet.contains(document.activeElement)) {
          (S._focusables(state.sheet).find(n => !n.classList.contains("whimsy-ai-x")) ?? state.sheet.querySelector(".whimsy-ai-x"))?.focus();
        }
      }, 0);
    }
    state.body.replaceChildren();
    state.footer.replaceChildren();
  }

  function note(parent, l10nId, tone, args) {
    const box = S.el("div", "whimsy-ai-note", parent);
    box.dataset.tone = tone;
    const inner = S.el("span", "whimsy-ai-note-body", box);
    S.el("span", "", inner, l10nId, args);
    return inner;
  }

  function status(parent, l10nId, { busy = false, tone = null, args } = {}) {
    const box = S.el("div", "whimsy-ai-status", parent);
    box.setAttribute("role", "status");
    if (busy) {
      S.el("span", "whimsy-ai-spinner", box);
    }
    if (tone) {
      box.dataset.tone = tone;
    }
    S.el("span", "", box, l10nId, args);
    return box;
  }

  function cancel(state) {
    return S.button(state.footer, "whimsy-ai-sheet-cancel", { onClick: () => S.closeSheet() });
  }

  function connected(id, { first }) {
    S.toast("whimsy-ai-toast-connected", { args: { provider: nameOf(id) }, descriptionId: first ? "whimsy-ai-toast-ai-on" : "whimsy-ai-toast-at-end" });
  }

  async function afterConnect(id, wasOn) {
    if (S.sheet) {
      S.closeSheet();
    }
    connected(id, { first: !wasOn && S.ai.enabled });
  }

  // Add a provider (set-3.1, set-1.2).
  S.registerSheet("add-provider", async (state, opts) => {
    document.l10n.setAttributes(state.title, "whimsy-ai-add-title");
    S.el("p", "", state.body, "whimsy-ai-add-text");
    const choices = S.el("div", "whimsy-ai-choices", state.body);
    choices.setAttribute("role", "list");
    cancel(state);
    const order = P().order;
    let appleOk = true;
    try {
      const version = await P()._macOSVersion();
      appleOk = Services.appinfo.OS == "Darwin" && (version == null || version >= 26);
    } catch {}
    for (const id of ALL) {
      if (id == "apple" && !appleOk) {
        continue;
      }
      const choice = S.el("button", "whimsy-ai-choice", choices);
      choice.type = "button";
      choice.dataset.provider = id;
      S.tile(choice, S.logo(id), { logo: true });
      const text = S.el("span", "", choice);
      S.el("span", "whimsy-ai-choice-name", text, `whimsy-ai-name-${id}`);
      S.el("span", "whimsy-ai-choice-detail", text, `whimsy-ai-add-${id}`);
      if (order.includes(id)) {
        choice.setAttribute("aria-disabled", "true");
        S.el("span", "whimsy-ai-pill", choice, "whimsy-ai-add-connected").dataset.tone = "pass";
      } else {
        S.el("span", "whimsy-ai-chev", choice).setAttribute("aria-hidden", "true");
        choice.addEventListener("click", () => S.openSheet(id, { restoreFocus: opts.restoreFocus }));
      }
    }
    choices.querySelector(".whimsy-ai-choice:not([aria-disabled])")?.focus();
  });

  // Plan or API key, for Claude and ChatGPT.
  function segment(state, id, method, onPick) {
    if (!P().planAvailable(id)) {
      return null;
    }
    const seg = S.el("div", "whimsy-ai-seg", state.body);
    seg.setAttribute("role", "radiogroup");
    seg.style.setProperty("--count", "2");
    seg.style.setProperty("--index", method == "plan" ? "0" : "1");
    S.el("span", "whimsy-ai-seg-thumb", seg);
    for (const m of ["plan", "key"]) {
      const b = S.el("button", "", seg, `whimsy-ai-seg-${m}-${id}`);
      b.type = "button";
      b.dataset.method = m;
      b.setAttribute("role", "radio");
      b.setAttribute("aria-checked", String(m == method));
      b.tabIndex = m == method ? 0 : -1;
      b.addEventListener("click", () => m != method && onPick(m));
    }
    seg.addEventListener("keydown", event => {
      if (event.key == "ArrowLeft" || event.key == "ArrowRight") {
        event.preventDefault();
        const m = method == "plan" ? "key" : "plan";
        onPick(m);
        state.body.querySelector(`.whimsy-ai-seg [data-method="${m}"]`)?.focus();
      }
    });
    return seg;
  }

  // An API key: Connect stays dimmed until something's pasted; pasting
  // checks it by itself; a rejected key turns the field red with why.
  function keyPanel(state, id, rebuild) {
    S.el("label", "whimsy-ai-label", state.body, "whimsy-ai-key-label").htmlFor = "whimsyAIKeyField";
    const input = S.el("input", "whimsy-ai-input whimsy-ai-mono", state.body, "whimsy-ai-key-field-placeholder");
    input.type = "password";
    input.id = "whimsyAIKeyField";
    input.autocomplete = "off";
    input.spellcheck = false;
    input.setAttribute("autofocus", "");
    const error = S.el("span", "whimsy-ai-hint", state.body);
    error.dataset.tone = "fail";
    error.id = "whimsyAIKeyError";
    error.hidden = true;
    const hint = S.el("span", "whimsy-ai-hint", state.body, `whimsy-ai-key-hint-${id}`, { site: KEY_SITES[id] });
    const site = S.el("a", "whimsy-ai-link", hint);
    site.setAttribute("data-l10n-name", "site");
    site.href = KEY_URLS[id];
    site.style.fontSize = "11.5px";
    hint.addEventListener("click", event => {
      if (event.target.closest("a")) {
        event.preventDefault();
        openTab(KEY_URLS[id]);
      }
    });
    if (id == "gemini") {
      note(state.body, "whimsy-ai-key-gemini-free", "warn");
    }
    const checking = S.el("div", "", state.body);
    cancel(state);
    const connect = S.button(state.footer, "whimsy-ai-key-connect", { kind: "primary" });
    connect.id = "whimsyAIKeyConnect";
    connect.disabled = true;
    const go = async () => {
      const value = input.value.trim();
      if (!value || connect.dataset.busy) {
        return;
      }
      connect.dataset.busy = "1";
      connect.disabled = true;
      error.hidden = true;
      input.removeAttribute("aria-invalid");
      checking.replaceChildren();
      status(checking, "whimsy-ai-key-checking", { busy: true, args: { provider: nameOf(id) } });
      const wasOn = S.ai.enabled;
      try {
        await P().connectKey(id, value);
        if (S.sheet?.id == id) {
          afterConnect(id, wasOn);
        }
      } catch (e) {
        if (S.sheet?.id != id) {
          return;
        }
        checking.replaceChildren();
        const code = ["bad-key", "network", "no-key", "unavailable"].includes(e?.code) ? e.code : "failed";
        input.setAttribute("aria-invalid", "true");
        input.setAttribute("aria-describedby", error.id);
        document.l10n.setAttributes(error, code == "bad-key" ? `whimsy-ai-key-rejected-${id}` : `whimsy-ai-connect-error-${code}`, { provider: nameOf(id) });
        error.hidden = false;
        input.focus();
      } finally {
        delete connect.dataset.busy;
        connect.disabled = !input.value.trim();
      }
    };
    input.addEventListener("input", () => {
      connect.disabled = !input.value.trim() || !!connect.dataset.busy;
    });
    input.addEventListener("paste", () => setTimeout(go, 0));
    input.addEventListener("keydown", event => {
      if (event.key == "Enter") {
        go();
      }
    });
    connect.addEventListener("click", go);
    return input;
  }

  // ---- Claude: plan through Claude Code, installed if missing ----

  const install = { promise: null, steps: [], error: null, version: "" };
  const INSTALL_STEPS = [
    ["download", ["fetch", "signature", "download"]],
    ["check", ["hash", "codesign", "notarization"]],
    ["setup", ["install"]],
    ["sign-in", ["sign-in"]],
  ];

  function startInstall() {
    if (install.promise) {
      return install.promise;
    }
    install.steps = [];
    install.error = null;
    const notify = () => Services.obs.notifyObservers(null, "whimsy-ai-settings-claude-install");
    install.promise = (async () => {
      const wasOn = S.ai.enabled;
      try {
        const result = await lazy.WhimsyClaudeCodeInstall.install({
          onStep: step => {
            install.steps.push(step);
            notify();
          },
        });
        install.version = result?.version ?? "";
        lazy.WhimsyAIClaudeCode._status = null;
        install.steps.push("sign-in");
        notify();
        if (!S.sheet) {
          S.toast("whimsy-ai-toast-claude-code-ready", { descriptionId: "whimsy-ai-toast-claude-code-sign-in" });
        }
        await P().connectPlan(S.browserWindow(), "claude");
        install.steps.push("done");
        notify();
        if (S.sheet?.id == "claude") {
          S.closeSheet();
        }
        connected("claude", { first: !wasOn && S.ai.enabled });
      } catch (e) {
        install.error = e;
        notify();
        if (!S.sheet) {
          S.toast("whimsy-ai-toast-claude-code-failed");
        }
      } finally {
        install.promise = null;
        notify();
      }
    })();
    return install.promise;
  }

  function installSteps(parent) {
    const box = S.el("div", "whimsy-ai-steps", parent);
    box.id = "whimsyAIInstallSteps";
    box.setAttribute("role", "status");
    const seen = install.steps;
    const all = seen.includes("done");
    const reached = Math.max(-1, ...seen.map(step => INSTALL_STEPS.findIndex(([, parts]) => parts.includes(step))));
    INSTALL_STEPS.forEach(([key], i) => {
      const state = all || i < reached ? "done" : i == reached ? (install.error ? "failed" : "busy") : "todo";
      const step = S.el("div", "whimsy-ai-step", box, `whimsy-ai-install-${key}-${state == "failed" ? "busy" : state}`, { version: install.version || "" });
      step.dataset.step = key;
      step.dataset.state = state;
    });
    return box;
  }

  async function claudeSheet(state, opts) {
    sheetHead(state, "claude");
    let method = opts.method ?? (P().planAvailable("claude") ? "plan" : "key");
    const watch = () => build();
    Services.obs.addObserver(watch, "whimsy-ai-settings-claude-install");
    state.cleanups.push(() => Services.obs.removeObserver(watch, "whimsy-ai-settings-claude-install"));
    state.cleanups.push(() => P().cancelPlan?.("claude"));
    let waiting = false;
    async function build() {
      if (S.sheet != state) {
        return;
      }
      const focusMethod = document.activeElement?.dataset?.method;
      clear(state);
      segment(state, "claude", method, m => {
        method = m;
        build();
      });
      if (focusMethod) {
        state.body.querySelector(`[data-method="${focusMethod}"]`)?.focus();
      }
      if (method == "key") {
        keyPanel(state, "claude", build).focus();
        return;
      }
      const useKey = () => {
        method = "key";
        build();
      };
      if (install.promise || install.error) {
        // fu-settings 3.4: the steps tick over; closing doesn't stop it.
        installSteps(state.body);
        if (install.error) {
          const inner = note(state.body, "whimsy-ai-install-failed", "fail");
          const actions = S.el("span", "whimsy-ai-actions", inner);
          S.button(actions, "whimsy-ai-install-get", { small: true, onClick: () => openTab(CLAUDE_CODE_URL) }).classList.add("whimsy-ai-ext");
          S.button(actions, "whimsy-ai-install-retry", {
            small: true,
            onClick: () => {
              install.error = null;
              startInstall();
              build();
            },
          });
          S.button(state.footer, "whimsy-ai-use-key", { kind: "text", onClick: useKey }).classList.add("whimsy-ai-spacer");
          cancel(state);
          return;
        }
        S.el("p", "", state.body, "whimsy-ai-install-background");
        cancel(state);
        return;
      }
      const loading = status(state.body, "whimsy-ai-claude-checking", { busy: true });
      const cc = await lazy.WhimsyAIClaudeCode._authStatus({ fresh: true }).catch(() => ({ installed: false }));
      if (S.sheet != state || method != "plan") {
        return;
      }
      loading.remove();
      if (!cc.installed) {
        S.el("p", "", state.body, "whimsy-ai-claude-install-text");
        const facts = S.el("div", "whimsy-ai-facts-box", state.body);
        for (const n of [1, 2, 3]) {
          S.el("div", "", facts, `whimsy-ai-claude-install-fact-${n}`);
        }
        S.button(state.footer, "whimsy-ai-use-key", { kind: "text", onClick: useKey }).classList.add("whimsy-ai-spacer");
        cancel(state);
        S.button(state.footer, "whimsy-ai-claude-install", {
          kind: "primary",
          id: "whimsyAIClaudeInstall",
          onClick: () => {
            startInstall();
            build();
          },
        });
        return;
      }
      if (waiting) {
        S.el("p", "", state.body, "whimsy-ai-claude-signed-out-text");
        status(state.body, "whimsy-ai-claude-waiting", { busy: true });
        S.button(state.footer, "whimsy-ai-use-key", { kind: "text", onClick: useKey }).classList.add("whimsy-ai-spacer");
        S.button(state.footer, "whimsy-ai-sheet-cancel", {
          onClick: () => {
            P().cancelPlan("claude");
            S.closeSheet();
          },
        });
        return;
      }
      if (cc.loggedIn) {
        S.el("p", "", state.body, "whimsy-ai-claude-plan-text");
        const line = S.el("div", "whimsy-ai-actions", state.body);
        S.el("span", "whimsy-ai-hint", line, "whimsy-ai-claude-plan-can");
        caps(line, "claude");
        S.el("p", "", state.body, "whimsy-ai-claude-plan-next");
      } else {
        S.el("p", "", state.body, "whimsy-ai-claude-signed-out-text");
      }
      if (state.error) {
        note(state.body, state.error, "fail");
      }
      S.button(state.footer, "whimsy-ai-use-key", { kind: "text", onClick: useKey }).classList.add("whimsy-ai-spacer");
      cancel(state);
      S.button(state.footer, cc.loggedIn ? "whimsy-ai-claude-connect" : "whimsy-ai-claude-sign-in", {
        kind: "primary",
        id: "whimsyAIClaudeSignIn",
        onClick: async () => {
          waiting = !cc.loggedIn;
          state.error = null;
          build();
          const wasOn = S.ai.enabled;
          try {
            await P().connectPlan(S.browserWindow(), "claude");
            waiting = false;
            if (S.sheet == state) {
              afterConnect("claude", wasOn);
            }
          } catch (e) {
            waiting = false;
            if (e?.code == "claude-code-outdated") {
              startInstall();
            } else if (e?.code != "sign-in-cancelled") {
              state.error = "whimsy-ai-claude-sign-in-failed";
            }
            build();
          }
        },
      });
    }
    await build();
  }
  S.registerSheet("claude", claudeSheet);

  // ---- ChatGPT ----

  S.registerSheet("openai", (state, opts) => {
    sheetHead(state, "openai");
    let method = opts.method ?? (P().planAvailable("openai") ? "plan" : "key");
    let phase = "start";
    let errorCode = null;
    const build = () => {
      if (S.sheet != state) {
        return;
      }
      clear(state);
      if (phase == "welcome") {
        document.l10n.setAttributes(state.title, "whimsy-ai-openai-welcome-title");
        status(state.body, "whimsy-ai-openai-welcome-signed-in", { tone: "pass" });
        const inner = note(state.body, "whimsy-ai-plan-welcome-text", "info");
        inner.firstChild.before(S.el("b", "", null, "whimsy-ai-plan-welcome-title"));
        const manage = S.button(state.footer, "whimsy-ai-manage-usage", { onClick: () => P().manageUsage(S.browserWindow(), "openai") });
        manage.classList.add("whimsy-ai-ext");
        S.button(state.footer, "whimsy-ai-openai-done", { kind: "primary", id: "whimsyAIOpenAIDone", onClick: () => S.closeSheet() }).setAttribute("autofocus", "");
        state.footer.querySelector("#whimsyAIOpenAIDone").focus();
        return;
      }
      segment(state, "openai", method, m => {
        method = m;
        errorCode = null;
        build();
      });
      if (method == "key") {
        keyPanel(state, "openai", build).focus();
        return;
      }
      if (errorCode == "plan-ineligible") {
        const inner = note(state.body, "whimsy-ai-openai-ineligible", "fail");
        const actions = S.el("span", "whimsy-ai-actions", inner);
        S.button(actions, "whimsy-ai-use-key-button", {
          small: true,
          onClick: () => {
            method = "key";
            errorCode = null;
            build();
          },
        });
      } else if (errorCode) {
        note(state.body, `whimsy-ai-connect-error-${errorCode}`, "fail", { provider: nameOf("openai") });
      }
      S.el("p", "", state.body, "whimsy-ai-openai-plan-text");
      if (phase == "waiting") {
        status(state.body, "whimsy-ai-openai-waiting", { busy: true });
        S.button(state.footer, "whimsy-ai-sheet-cancel", {
          onClick: () => {
            P().cancelPlan("openai");
            S.closeSheet();
          },
        });
        return;
      }
      const line = S.el("div", "whimsy-ai-actions", state.body);
      S.el("span", "whimsy-ai-hint", line, "whimsy-ai-openai-plan-can");
      caps(line, "openai");
      cancel(state);
      S.button(state.footer, errorCode ? "whimsy-ai-try-again" : "whimsy-ai-openai-continue", {
        kind: errorCode ? "" : "primary",
        id: "whimsyAIOpenAIContinue",
        onClick: async () => {
          phase = "waiting";
          errorCode = null;
          build();
          const wasOn = S.ai.enabled;
          try {
            const result = await P().connectPlan(S.browserWindow(), "openai");
            if (S.sheet != state) {
              return;
            }
            if (result?.welcome) {
              phase = "welcome";
              connected("openai", { first: !wasOn && S.ai.enabled });
              build();
            } else {
              afterConnect("openai", wasOn);
            }
          } catch (e) {
            phase = "start";
            errorCode = e?.code == "sign-in-cancelled" ? null : ["plan-ineligible", "network", "unavailable"].includes(e?.code) ? e.code : "failed";
            build();
          }
        },
      });
    };
    state.cleanups.push(() => phase == "waiting" && P().cancelPlan("openai"));
    build();
  });

  // ---- Gemini: an API key, with the free-tier note ----

  S.registerSheet("gemini", state => {
    sheetHead(state, "gemini");
    keyPanel(state, "gemini").focus();
  });

  // ---- Ollama: looks at the default address straight away ----

  S.registerSheet("ollama", state => {
    sheetHead(state, "ollama");
    const providers = P();
    let address = providers.ollamaEndpoint;
    let chosen = providers.modelOf("ollama");
    const look = async () => {
      clear(state);
      S.el("label", "whimsy-ai-label", state.body, "whimsy-ai-ollama-address").htmlFor = "whimsyAIOllamaAddress";
      const input = S.el("input", "whimsy-ai-input whimsy-ai-mono", state.body);
      input.id = "whimsyAIOllamaAddress";
      input.value = address;
      input.spellcheck = false;
      input.addEventListener("keydown", event => {
        if (event.key == "Enter") {
          address = input.value.trim() || address;
          look();
        }
      });
      const result = S.el("div", "", state.body);
      result.style.cssText = "display:flex;flex-direction:column;gap:10px";
      status(result, "whimsy-ai-ollama-looking", { busy: true });
      cancel(state);
      let models = [];
      try {
        models = await providers.ollamaModelDetails(address);
      } catch {}
      if (S.sheet != state) {
        return;
      }
      result.replaceChildren();
      if (!models.length) {
        input.setAttribute("aria-invalid", "true");
        const inner = note(result, "whimsy-ai-ollama-offline", "fail");
        const actions = S.el("span", "whimsy-ai-actions", inner);
        S.button(actions, "whimsy-ai-ollama-get", { small: true, onClick: () => openTab(OLLAMA_URL) }).classList.add("whimsy-ai-ext");
        S.button(actions, "whimsy-ai-try-again", {
          small: true,
          onClick: () => {
            address = input.value.trim() || address;
            look();
          },
        });
        return;
      }
      status(result, "whimsy-ai-ollama-found", { tone: "pass", args: { count: models.length } });
      S.el("span", "whimsy-ai-label", result, "whimsy-ai-ollama-model");
      const list = S.el("div", "whimsy-ai-choices", result);
      list.setAttribute("role", "radiogroup");
      if (!models.some(m => m.name == chosen)) {
        chosen = models[0].name;
      }
      for (const model of models) {
        const choice = S.el("button", "whimsy-ai-choice is-radio", list);
        choice.type = "button";
        choice.setAttribute("role", "radio");
        choice.dataset.model = model.name;
        choice.setAttribute("aria-checked", String(model.name == chosen));
        const text = S.el("span", "", choice);
        const name = S.el("span", "whimsy-ai-choice-name whimsy-ai-mono", text);
        name.textContent = model.name;
        const kind = model.caps ? (model.caps.images ? "images" : "text") + (model.caps.thinking ? "-thinking" : "") : "unknown";
        S.el("span", "whimsy-ai-choice-detail", text, `whimsy-ai-ollama-model-${kind}`, { size: (model.size / 1e9).toFixed(1) });
        choice.addEventListener("click", () => {
          chosen = model.name;
          for (const c of list.children) {
            c.setAttribute("aria-checked", String(c == choice));
          }
        });
      }
      S.el("p", "", result, "whimsy-ai-ollama-local");
      const done = S.button(state.footer, "whimsy-ai-ollama-done", { kind: "primary", id: "whimsyAIOllamaDone" });
      done.addEventListener("click", async () => {
        done.disabled = true;
        const wasOn = S.ai.enabled;
        try {
          await providers.connectOllama(address);
          providers.setModel("ollama", chosen);
          afterConnect("ollama", wasOn);
        } catch {
          done.disabled = false;
          look();
        }
      });
    };
    look();
  });

  // ---- Apple Intelligence: builds its helper once ----

  S.registerSheet("apple", state => {
    sheetHead(state, "apple", "whimsy-ai-apple-sheet-title");
    const providers = P();
    const check = async () => {
      clear(state);
      status(state.body, "whimsy-ai-apple-status-checking", { busy: true });
      S.el("p", "", state.body, "whimsy-ai-apple-first-time");
      cancel(state);
      let result;
      try {
        result = await providers.appleStatus({ build: true });
      } catch (e) {
        console.error("Whimsy AI: checking Apple Intelligence", e);
        result = "unavailable";
      }
      if (S.sheet != state) {
        return;
      }
      if (result == "available") {
        const wasOn = S.ai.enabled;
        if (!providers.order.includes("apple")) {
          providers.appleConnected();
        }
        afterConnect("apple", wasOn);
        return;
      }
      clear(state);
      if (result == "apple-needs-tools") {
        note(state.body, "whimsy-ai-apple-needs-tools", "warn");
        S.el("span", "whimsy-ai-hint", state.body, "whimsy-ai-apple-needs-tools-hint");
        const code = S.el("pre", "whimsy-ai-code", state.body);
        code.textContent = "xcode-select --install";
        const actions = S.el("div", "whimsy-ai-actions", state.body);
        const copy = S.button(actions, "whimsy-ai-copy", { small: true });
        copy.addEventListener("click", () => {
          Cc["@mozilla.org/widget/clipboardhelper;1"].getService(Ci.nsIClipboardHelper).copyString("xcode-select --install");
          document.l10n.setAttributes(copy, "whimsy-ai-copied");
        });
      } else {
        note(state.body, `whimsy-ai-apple-status-${result}`, "warn", { detail: "" });
      }
      if (providers.appleDetail) {
        const actions = state.body.querySelector(".whimsy-ai-actions") ?? S.el("div", "whimsy-ai-actions", state.body);
        S.el("span", "whimsy-ai-spacer", actions);
        const more = S.button(actions, "whimsy-ai-show-details", { kind: "text" });
        const pre = S.el("pre", "whimsy-ai-code", state.body);
        pre.textContent = providers.appleDetail;
        pre.hidden = true;
        more.addEventListener("click", () => (pre.hidden = !pre.hidden));
      }
      if (result == "apple-intelligence-off") {
        S.button(state.footer, "whimsy-ai-apple-open-settings", {
          kind: "text",
          onClick: () => {
            Cc["@mozilla.org/uriloader/external-protocol-service;1"]
              .getService(Ci.nsIExternalProtocolService)
              .loadURI(Services.io.newURI("x-apple.systempreferences:com.apple.Siri-Settings.extension"), Services.scriptSecurityManager.getSystemPrincipal());
          },
        }).classList.add("whimsy-ai-spacer");
      }
      cancel(state);
      if (result != "apple-unavailable-os" && result != "unavailable") {
        S.button(state.footer, "whimsy-ai-check-again", { kind: "primary", id: "whimsyAIAppleCheck", onClick: check });
      }
    };
    check();
  });
})();
