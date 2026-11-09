/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

// W23: Settings › AI › Connectors (07 set-5.x, fu-settings 5.6). Grouped
// like onboarding: Schedule and inbox, Work tools, Other MCP servers. A
// connected row shows its account and scopes and opens to a switch per
// scope and Disconnect (confirmed in the page, naming what stops). Every
// problem has one button. Connect opens the scopes sheet first.

/* globals WhimsyAISettings */

(() => {
  const S = WhimsyAISettings;
  const lazy = {};
  ChromeUtils.defineESModuleGetters(lazy, {
    CONNECTOR_GROUPS: "resource:///modules/whimsy/WhimsyConnectors.sys.mjs",
    CATALOG: "resource:///modules/whimsy/WhimsyConnectors.sys.mjs",
    WhimsyConnectors: "resource:///modules/whimsy/WhimsyConnectors.sys.mjs",
  });
  const C = () => lazy.WhimsyConnectors;
  const ICONS = "chrome://browser/content/whimsy/icons/";
  const SETUP_URLS = {
    google: "https://console.cloud.google.com/apis/credentials",
    microsoft: "https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade",
  };
  const view = { list: null, open: new Set(), byId: new Map() };
  const logoOf = c => `${ICONS}${c.logo == "apple" ? "apple" : c.logo}.svg`;
  const nameId = id => (id.startsWith("mcp:") ? null : `whimsy-connectors-name-${id}`);

  function nameInto(node, c) {
    const id = nameId(c.id);
    if (id) {
      document.l10n.setAttributes(node, id);
    } else {
      node.textContent = c.name || c.id.slice(4);
    }
  }

  function browserWin() {
    return S.browserWindow();
  }

  // ---- the list ----

  async function render() {
    if (!view.list) {
      return;
    }
    const all = await C().list();
    view.byId = new Map(all.map(c => [c.id, c]));
    const list = view.list;
    list.replaceChildren();
    for (const group of lazy.CONNECTOR_GROUPS) {
      S.el("div", "whimsy-ai-caption", list, group.l10nId);
      const box = S.el("div", "whimsy-ai-list", list);
      box.setAttribute("role", "list");
      for (const id of group.ids) {
        box.append(row(view.byId.get(id)));
      }
    }
    S.el("div", "whimsy-ai-caption", list, "whimsy-connectors-group-mcp");
    const box = S.el("div", "whimsy-ai-list", list);
    box.setAttribute("role", "list");
    for (const c of all.filter(x => x.id.startsWith("mcp:"))) {
      box.append(row(c));
    }
    const add = S.el("div", "whimsy-ai-item is-button", box);
    add.id = "whimsyConnectorsAddMcp";
    add.setAttribute("role", "listitem");
    S.tile(add, `${ICONS}mcp.svg`, { tone: "accent" });
    const text = S.el("span", "whimsy-ai-item-text", add);
    const name = S.el("button", "whimsy-ai-item-name whimsy-connectors-rowbtn", text, "whimsy-connectors-add-mcp");
    name.type = "button";
    name.addEventListener("click", () => S.openSheet("connector-mcp", { restoreFocus: name }));
    S.el("span", "whimsy-ai-item-detail", text, "whimsy-connectors-add-mcp-detail");
    add.addEventListener("click", event => event.target == add && name.click());
    for (const id of view.open) {
      const r = list.querySelector(`.whimsy-ai-item[data-connector="${CSS.escape(id)}"]`);
      if (r && view.byId.get(id)?.connected) {
        r.after(body(r, view.byId.get(id)));
        r.setAttribute("aria-expanded", "true");
        r.querySelector(".whimsy-ai-chev")?.setAttribute("aria-expanded", "true");
      }
    }
    list.dataset.ready = "true";
  }

  function detailFor(node, c) {
    if (c.problem && (c.connected || c.status == "needs-client-id" || c.status == "unavailable")) {
      document.l10n.setAttributes(node, c.problem.l10nId, c.problem.args ?? {});
      node.dataset.tone = c.problem.tone;
      return;
    }
    if (!c.connected) {
      document.l10n.setAttributes(node, `whimsy-connectors-detail-${c.id.startsWith("mcp:") ? "mcp" : c.id}`);
      return;
    }
    if (c.id.startsWith("mcp:")) {
      document.l10n.setAttributes(node, "whimsy-connectors-detail-server", { host: new URL(c.url).host, count: c.toolCount });
      return;
    }
    if (c.scopes.length) {
      const on = c.scopes.filter(s => s.on).map(s => s.id);
      document.l10n.setAttributes(node, c.account ? "whimsy-connectors-detail-account-scopes" : "whimsy-connectors-detail-scopes", {
        account: c.account,
        scopes: on.map(s => scopeName(c.id, s)).join(" · "),
      });
      return;
    }
    document.l10n.setAttributes(node, c.account ? "whimsy-connectors-detail-account" : `whimsy-connectors-detail-${c.id}-on`, { account: c.account });
  }

  const SCOPE_NAMES = { gmail: "Gmail", calendar: "Calendar", drive: "Drive", outlook: "Outlook", onedrive: "OneDrive" };
  const scopeName = (id, s) => SCOPE_NAMES[s] ?? s;

  function row(c) {
    const r = S.el("div", "whimsy-ai-item");
    r.dataset.connector = c.id;
    r.dataset.status = c.status;
    r.setAttribute("role", "listitem");
    S.tile(r, logoOf(c), { logo: true });
    const text = S.el("span", "whimsy-ai-item-text", r);
    nameInto(S.el("span", "whimsy-ai-item-name", text), c);
    const detail = S.el("span", "whimsy-ai-item-detail", text);
    detailFor(detail, c);
    const end = S.el("span", "whimsy-ai-item-end", r);
    const action = (l10nId, run, kind = "") => {
      const b = S.button(end, l10nId, { small: true, kind, onClick: run });
      b.dataset.action = "fix";
      return b;
    };
    if (c.problem?.action == "client-id" && !c.connected) {
      action("whimsy-connectors-set-up", () => S.openSheet("connector-client-id", { connector: c.id, restoreFocus: r.querySelector("button") }));
    } else if (c.problem?.action == "system-settings") {
      action("whimsy-connectors-open-system-settings", openSystemSettings);
    } else if (c.problem?.action == "sign-in") {
      action("whimsy-connectors-sign-in-again", () => startConnect(c.id, r));
    } else if (c.problem?.action == "retry") {
      action("whimsy-connectors-try-again", () => retry(c.id));
    } else if (!c.connected && c.status != "unavailable") {
      action("whimsy-connectors-connect", () => startConnect(c.id, r));
    }
    if (c.connected && !c.problem) {
      const chev = S.el("button", "whimsy-ai-chev", end, "whimsy-connectors-row-details", { name: c.name || c.id });
      chev.type = "button";
      chev.dataset.action = "details";
      chev.setAttribute("aria-expanded", "false");
      chev.addEventListener("click", () => toggleOpen(c.id));
    }
    return r;
  }

  function toggleOpen(id) {
    const r = view.list.querySelector(`.whimsy-ai-item[data-connector="${CSS.escape(id)}"]`);
    const existing = r?.nextElementSibling?.classList.contains("whimsy-ai-body") ? r.nextElementSibling : null;
    const chev = r?.querySelector(".whimsy-ai-chev");
    if (!r) {
      return;
    }
    if (existing) {
      view.open.delete(id);
      existing.remove();
      r.setAttribute("aria-expanded", "false");
      chev?.setAttribute("aria-expanded", "false");
      return;
    }
    view.open.add(id);
    r.setAttribute("aria-expanded", "true");
    chev?.setAttribute("aria-expanded", "true");
    const node = body(r, view.byId.get(id));
    r.after(node);
    view.unfolding = S.unfold(node);
  }

  function body(r, c) {
    const outer = S.el("div", "whimsy-ai-body");
    outer.dataset.connector = c.id;
    const inner = S.el("div", "whimsy-ai-body-in", S.el("div", "", outer));
    const kv = S.el("dl", "whimsy-ai-kv", inner);
    if (c.account) {
      S.el("dt", "", kv, "whimsy-connectors-account");
      S.el("dd", "", kv).textContent = c.account;
    }
    if (c.url) {
      S.el("dt", "", kv, "whimsy-connectors-address");
      S.el("dd", "whimsy-ai-mono", kv).textContent = c.url;
    }
    if (c.lastUsed) {
      S.el("dt", "", kv, "whimsy-connectors-last-used");
      S.el("dd", "", kv).textContent = new Date(c.lastUsed).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
    }
    if (!kv.children.length) {
      kv.remove();
    }
    if (c.scopes.length) {
      const scopes = S.el("div", "whimsy-connectors-scopes", inner);
      for (const s of c.scopes) {
        const item = S.el("div", "whimsy-connectors-scope", scopes);
        const t = S.el("span", "whimsy-ai-item-text", item);
        S.el("span", "whimsy-ai-item-name", t).textContent = scopeName(c.id, s.id);
        S.el("span", "whimsy-ai-item-detail", t, `whimsy-connectors-scope-${c.id}-${s.id}`);
        const toggle = S.el("moz-toggle", "", item, "whimsy-connectors-scope-switch", { scope: scopeName(c.id, s.id) });
        toggle.setAttribute("data-l10n-attrs", "aria-label");
        toggle.dataset.scope = s.id;
        toggle.pressed = s.on;
        toggle.addEventListener("toggle", async () => {
          const want = toggle.pressed;
          try {
            await C().setScope(browserWin(), c.id, s.id, want);
          } catch (e) {
            if (e.code != "cancelled") {
              console.error(e);
            }
            toggle.pressed = !want;
          }
        });
      }
    } else if (c.toolNames?.length) {
      const tools = S.el("p", "whimsy-ai-desc whimsy-connectors-tools", inner, "whimsy-connectors-tools", { count: c.toolCount, names: c.toolNames.slice(0, 6).join(", ") });
      tools.dataset.count = c.toolCount;
    }
    const actions = S.el("div", "whimsy-ai-actions", inner);
    actions.style.justifyContent = "flex-end";
    const disconnect = S.button(actions, "whimsy-connectors-disconnect", { small: true });
    disconnect.dataset.action = "disconnect";
    disconnect.addEventListener("click", () => confirmDisconnect(c, r, disconnect));
    return outer;
  }

  function confirmDisconnect(c, r, button) {
    const users = C().usersOf(c.id);
    const what = c.scopes.length ? c.scopes.filter(s => s.on).map(s => scopeName(c.id, s.id)) : [];
    const list = items => new Intl.ListFormat(undefined, { type: "conjunction" }).format(items);
    const nameNode = r.querySelector(".whimsy-ai-item-name");
    S.confirmStrip(r, {
      titleL10nId: "whimsy-connectors-disconnect-title",
      titleArgs: { name: nameNode.textContent },
      textL10nId: users.length ? "whimsy-connectors-disconnect-text-users" : "whimsy-connectors-disconnect-text",
      textArgs: { what: what.length ? list(what) : nameNode.textContent, users: list(users) },
      okL10nId: "whimsy-connectors-disconnect",
      restoreFocus: button,
      onConfirm: async () => {
        view.open.delete(c.id);
        await C().disconnect(c.id);
      },
    });
  }

  function openSystemSettings() {
    const uri = Services.io.newURI("x-apple.systempreferences:com.apple.preference.security?Privacy_Calendars");
    Cc["@mozilla.org/uriloader/external-protocol-service;1"].getService(Ci.nsIExternalProtocolService).loadURI(uri);
  }

  async function retry(id) {
    const c = view.byId.get(id);
    try {
      if (c?.url) {
        await C().check(c.url);
      }
    } catch {}
    render();
  }

  // Connect: Google and Microsoft show their scopes first; Jira asks for
  // its site; the rest sign in straight away.
  function startConnect(id, r) {
    const c = view.byId.get(id);
    if (lazy.CATALOG[id]?.scopes.length || id == "jira") {
      S.openSheet("connector-scopes", { connector: id, restoreFocus: r.querySelector("button") });
      return;
    }
    if (c?.url && id.startsWith("mcp:")) {
      run(id, {}, r, { url: c.url });
      return;
    }
    run(id, {}, r);
  }

  async function run(id, opts, r, extra = {}) {
    const end = r?.querySelector(".whimsy-ai-item-end");
    if (end) {
      end.replaceChildren();
      const status = S.el("span", "whimsy-ai-status", end);
      status.setAttribute("role", "status");
      S.el("span", "whimsy-ai-spinner", status);
      S.el("span", "", status, "whimsy-connectors-signing-in");
      const cancel = S.button(end, "whimsy-connectors-cancel", { small: true, kind: "text", onClick: () => C().cancel() });
      cancel.dataset.action = "cancel";
    }
    try {
      await C().connect(browserWin(), extra.url ? "mcp" : id, { ...opts, ...extra });
      S.toast("whimsy-connectors-connected-toast", { args: { name: r?.querySelector(".whimsy-ai-item-name")?.textContent ?? "" } });
    } catch (e) {
      if (!["cancelled", "busy"].includes(e.code)) {
        console.error("Whimsy connectors", e);
      }
    }
    render();
  }

  // ---- sheets ----

  S.registerSheet("connector-scopes", (state, { connector }) => {
    const id = connector;
    const isJira = id == "jira";
    S.tile(state.head, `${ICONS}${lazy.CATALOG[id].logo}.svg`, { logo: true }).classList.add("is-small");
    state.head.prepend(state.head.lastChild);
    document.l10n.setAttributes(state.title, `whimsy-connectors-sheet-title-${id}`);
    S.el("p", "whimsy-ai-desc", state.body, isJira ? "whimsy-connectors-sheet-jira-text" : `whimsy-connectors-sheet-text-${id}`);
    let field = null;
    const checks = [];
    if (isJira) {
      field = S.el("input", "whimsy-ai-input", state.body);
      field.id = "whimsyConnectorsJiraSite";
      field.type = "url";
      field.placeholder = "your-team.atlassian.net";
      field.setAttribute("autofocus", "");
      field.setAttribute("data-l10n-id", "whimsy-connectors-jira-site-field");
    } else {
      const group = S.el("div", "whimsy-connectors-checks", state.body);
      for (const s of lazy.CATALOG[id].scopes) {
        const label = S.el("label", "whimsy-connectors-check", group);
        const box = S.el("input", "", label);
        box.type = "checkbox";
        box.checked = true;
        box.dataset.scope = s;
        checks.push(box);
        const img = S.el("img", "", label);
        img.src = `${ICONS}${lazy.CATALOG[id].marks[s]}.svg`;
        img.alt = "";
        const t = S.el("span", "whimsy-ai-item-text", label);
        S.el("span", "whimsy-ai-item-name", t).textContent = scopeName(id, s);
        S.el("span", "whimsy-ai-item-detail", t, `whimsy-connectors-scope-${id}-${s}`);
      }
    }
    S.el("p", "whimsy-ai-desc", state.body, "whimsy-connectors-sheet-keychain");
    S.el("span", "whimsy-connectors-spacer", state.footer);
    S.button(state.footer, "whimsy-ai-confirm-cancel-button", { onClick: () => S.closeSheet() });
    const go = S.button(state.footer, `whimsy-connectors-sheet-continue-${id}`, { kind: "primary", id: "whimsyConnectorsContinue" });
    const sync = () => (go.disabled = isJira ? !field.value.trim() : !checks.some(b => b.checked));
    for (const b of checks) {
      b.addEventListener("change", sync);
    }
    field?.addEventListener("input", sync);
    sync();
    go.addEventListener("click", () => {
      const r = view.list.querySelector(`.whimsy-ai-item[data-connector="${id}"]`);
      const opts = isJira ? { site: field.value.trim() } : { scopes: checks.filter(b => b.checked).map(b => b.dataset.scope) };
      S.closeSheet({ restore: false });
      run(id, opts, r);
    });
  });

  S.registerSheet("connector-client-id", (state, { connector }) => {
    const id = connector;
    document.l10n.setAttributes(state.title, `whimsy-connectors-client-title-${id}`);
    S.el("p", "whimsy-ai-desc", state.body, `whimsy-connectors-client-text-${id}`);
    const steps = S.el("ol", "whimsy-connectors-steps", state.body);
    for (const n of [1, 2, 3]) {
      S.el("li", "", steps, `whimsy-connectors-client-step${n}-${id}`);
    }
    const link = S.el("button", "whimsy-ai-link is-external", state.body, `whimsy-connectors-client-open-${id}`);
    link.type = "button";
    link.addEventListener("click", () => browserWin()?.openTrustedLinkIn(SETUP_URLS[id], "tab"));
    const field = S.el("input", "whimsy-ai-input", state.body);
    field.id = "whimsyConnectorsClientId";
    field.setAttribute("autofocus", "");
    field.setAttribute("data-l10n-id", `whimsy-connectors-client-id-field-${id}`);
    field.value = Services.prefs.getStringPref(`whimsy.connectors.${id}.client-id`, "");
    S.el("span", "whimsy-connectors-spacer", state.footer);
    S.button(state.footer, "whimsy-ai-confirm-cancel-button", { onClick: () => S.closeSheet() });
    const save = S.button(state.footer, "whimsy-connectors-client-save", { kind: "primary", id: "whimsyConnectorsClientSave" });
    const sync = () => (save.disabled = !field.value.trim());
    field.addEventListener("input", sync);
    sync();
    save.addEventListener("click", async () => {
      await C().setClientId(id, field.value);
      S.closeSheet();
    });
  });

  // Add an MCP server: address → check → name, tool count, a few tool
  // names → its own sign-in in a tab (set-5.6–5.9; fu-settings 5.6 says
  // which direction this is).
  S.registerSheet("connector-mcp", state => {
    document.l10n.setAttributes(state.title, "whimsy-connectors-mcp-title");
    S.el("label", "whimsy-ai-label", state.body, "whimsy-connectors-mcp-address").setAttribute("for", "whimsyConnectorsMcpUrl");
    const field = S.el("input", "whimsy-ai-input whimsy-ai-mono", state.body);
    field.id = "whimsyConnectorsMcpUrl";
    field.type = "url";
    field.value = "https://";
    field.setAttribute("autofocus", "");
    field.setAttribute("aria-describedby", "whimsyConnectorsMcpHint");
    const slot = S.el("div", "whimsy-connectors-mcp-slot", state.body);
    const hint = S.el("p", "whimsy-connectors-hint", slot, "whimsy-connectors-mcp-hint");
    hint.id = "whimsyConnectorsMcpHint";
    S.el("p", "whimsy-ai-desc", state.body, "whimsy-connectors-mcp-rules");
    const direction = S.el("div", "whimsy-ai-note whimsy-connectors-direction", state.body);
    direction.dataset.tone = "info";
    const dirText = S.el("span", "whimsy-ai-note-body", direction);
    S.el("span", "", dirText, "whimsy-connectors-mcp-direction");
    const outside = S.el("button", "whimsy-ai-link", dirText, "whimsy-connectors-mcp-outside");
    outside.type = "button";
    outside.addEventListener("click", () => {
      S.closeSheet({ restore: false });
      S.jumpTo("outside-agents");
    });
    S.el("span", "whimsy-connectors-spacer", state.footer);
    S.button(state.footer, "whimsy-ai-confirm-cancel-button", { onClick: () => S.closeSheet() });
    const go = S.button(state.footer, "whimsy-connectors-mcp-continue", { kind: "primary", id: "whimsyConnectorsMcpGo" });
    let found = null;
    let checking = null;
    const sync = () => {
      go.disabled = !/^https?:\/\/[^/\s]+/.test(field.value.trim()) || !!checking;
    };
    field.addEventListener("input", () => {
      found = null;
      field.removeAttribute("aria-invalid");
      document.l10n.setAttributes(go, "whimsy-connectors-mcp-continue");
      slot.replaceChildren(hint);
      sync();
    });
    field.addEventListener("keydown", event => event.key == "Enter" && !go.disabled && go.click());
    sync();
    go.addEventListener("click", async () => {
      if (found) {
        const target = found;
        S.closeSheet({ restore: false });
        const r = view.list.querySelector("#whimsyConnectorsAddMcp");
        run("mcp", {}, r, { url: target.url });
        return;
      }
      const controller = new AbortController();
      checking = controller;
      sync();
      const status = S.el("div", "whimsy-ai-status", null);
      status.setAttribute("role", "status");
      S.el("span", "whimsy-ai-spinner", status);
      S.el("span", "", status, "whimsy-connectors-mcp-checking");
      slot.replaceChildren(status);
      state.cleanups.push(() => controller.abort());
      try {
        found = await C().check(field.value, { signal: controller.signal });
        const card = S.el("div", "whimsy-connectors-found", null);
        card.id = "whimsyConnectorsMcpFound";
        S.tile(card, `${ICONS}mcp.svg`, { logo: true });
        const t = S.el("span", "whimsy-ai-item-text", card);
        S.el("span", "whimsy-ai-item-name", t).textContent = found.name;
        S.el("span", "whimsy-ai-item-detail", t, found.signIn ? "whimsy-connectors-mcp-found-signin" : "whimsy-connectors-mcp-found", { count: found.tools.length, names: found.tools.slice(0, 4).join(", ") });
        if (found.signIn) {
          S.el("span", "whimsy-ai-pill", card, "whimsy-connectors-mcp-signs-in").dataset.tone = "accent";
        }
        slot.replaceChildren(card);
        if (found.signIn) {
          S.el("p", "whimsy-connectors-hint", slot, "whimsy-connectors-mcp-signin-next", { name: found.name });
        }
        document.l10n.setAttributes(go, found.signIn ? "whimsy-connectors-mcp-continue-to" : "whimsy-connectors-mcp-add", { name: found.name });
      } catch (e) {
        if (controller.signal.aborted) {
          return;
        }
        field.setAttribute("aria-invalid", "true");
        const err = S.el("p", "whimsy-connectors-hint", null, e.code == "unreachable" ? "whimsy-connectors-mcp-unreachable" : "whimsy-connectors-mcp-not-mcp");
        err.dataset.tone = "fail";
        err.id = "whimsyConnectorsMcpError";
        err.setAttribute("role", "alert");
        slot.replaceChildren(err);
        document.l10n.setAttributes(go, "whimsy-connectors-try-again");
      } finally {
        checking = null;
        sync();
      }
    });
  });

  S.register({
    id: "connectors",
    order: 200,
    jumpL10nId: "whimsy-ai-jump-connectors",
    headingL10nId: "whimsy-connectors-heading",
    descL10nId: "whimsy-connectors-desc",
    isAvailable: () => Services.prefs.getBoolPref("whimsy.feature.ai-connectors", true),
    build(container) {
      view.list = S.el("div", "whimsy-connectors", container);
      view.list.id = "whimsyConnectorsList";
      const update = () => render();
      Services.obs.addObserver(update, "whimsy-connectors-changed");
      const prefs = ["whimsy.connectors.google.client-id", "whimsy.connectors.microsoft.client-id"];
      prefs.forEach(p => Services.prefs.addObserver(p, update));
      render();
      return () => {
        Services.obs.removeObserver(update, "whimsy-connectors-changed");
        prefs.forEach(p => Services.prefs.removeObserver(p, update));
      };
    },
  });
})();
