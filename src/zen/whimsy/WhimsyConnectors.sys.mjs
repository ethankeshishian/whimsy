/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// W23: connectors, what AI may read when asked. Google (Gmail, Calendar,
// and Drive), Microsoft (Outlook, Calendar, and OneDrive), Apple Calendar
// (macOS permission), Granola (its MCP server), Linear and Jira (the
// sign-ins the live folders already use), and any MCP server the person
// adds. Each scope is its own switch. Tokens are encrypted with OSKeyStore
// in a 0600 profile file, never in prefs.
//
// Where they go: to Claude Code as a temporary --mcp-config (remote servers
// directly; the built-in ones through a loopback MCP endpoint with its own
// token), to the router as `tools`, and to chat as context sources. Outside
// agents never get them (WhimsyClaude's server is a different one).

import { clearInterval, setInterval, setTimeout } from "resource://gre/modules/Timer.sys.mjs";
import { WhimsyConnectorError, WhimsyConnectorOAuth } from "resource:///modules/whimsy/WhimsyConnectorOAuth.sys.mjs";
import { WhimsyMCPClient, mcpUrl } from "resource:///modules/whimsy/WhimsyMCPClient.sys.mjs";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  HttpServer: "chrome://remote/content/server/httpd.sys.mjs",
  NetUtil: "resource://gre/modules/NetUtil.sys.mjs",
  OSKeyStore: "resource://gre/modules/OSKeyStore.sys.mjs",
  WhimsyAIContext: "resource:///modules/whimsy/WhimsyAIContext.sys.mjs",
  WhimsyChatContextUI: "resource:///modules/whimsy/WhimsyChatContextUI.sys.mjs",
  WhimsyMeetingNotes: "resource:///modules/whimsy/WhimsyMeetingNotes.sys.mjs",
  WhimsyNextMeeting: "resource:///modules/whimsy/WhimsyNextMeeting.sys.mjs",
  whimsyPostFetch: "resource:///modules/whimsy/WhimsyLiveFolderFetch.sys.mjs",
});

const FILE = "whimsy-connectors.json";
const FEATURE = "ai-connectors";
const TOPIC = "whimsy-connectors-changed";
const ICONS = "chrome://browser/content/whimsy/icons/";
const MINUTE = 60 * 1000;
const NOTES_CHARS = 12000;
const BRIDGE_PATH = "/mcp";
// W23 secfix H1: Claude Code's --permission-prompt-tool, one token per run.
const GUARD_PATH = "/guard";
export const GUARD_SERVER = "whimsy_guard";
export const GUARD_TOOL = "confirm";
// A tool may run without a press only when its server says it only reads
// AND reaches nothing outside the server (P2-M1: a read-only fetch or web
// search can still carry data out in its arguments). Everything else needs
// a press in chat and Ask, and routines (no guard) never get it.
const readOnlyOf = tools => tools
  .filter(t => t?.annotations?.readOnlyHint === true && t?.annotations?.openWorldHint === false)
  .map(t => t.name);
// Saved `readOnly` lists made by an older rule aren't trusted.
const READ_ONLY_RULE = 2;

export const CONNECTOR_GROUPS = [
  { id: "schedule", l10nId: "whimsy-connectors-group-schedule", ids: ["google", "microsoft", "apple-calendar"] },
  { id: "work", l10nId: "whimsy-connectors-group-work", ids: ["granola", "linear", "jira"] },
];

export const CATALOG = {
  google: { kind: "oauth", logo: "google", scopes: ["gmail", "calendar", "drive"], marks: { gmail: "gmail", calendar: "google-calendar", drive: "google-drive" } },
  microsoft: { kind: "oauth", logo: "microsoft", scopes: ["outlook", "calendar", "onedrive"], marks: { outlook: "outlook", calendar: "outlook", onedrive: "onedrive" } },
  "apple-calendar": { kind: "system", logo: "apple", scopes: [] },
  granola: { kind: "mcp", logo: "granola", scopes: [] },
  linear: { kind: "session", logo: "linear", scopes: [] },
  jira: { kind: "session", logo: "jira", scopes: [] },
};

const API = { google: "https://www.googleapis.com", microsoft: "https://graph.microsoft.com/v1.0" };
const LINEAR_GRAPHQL = "https://client-api.linear.app/graphql";
const LINEAR_CLIENT_ID = Math.random().toString(36).slice(2, 15);

const error = (code, message) => new WhimsyConnectorError(code, message);
const utf8 = s => String.fromCharCode(...new TextEncoder().encode(s));

function sameSecret(a, b) {
  if (typeof a != "string" || typeof b != "string" || a.length != b.length) {
    return false;
  }
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff == 0;
}

function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}

const day = (offset = 0) => {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + offset);
  return d;
};

// W23 secfix L7: an owner-only file, written whole: the temporary file is
// made 0600 before anything goes in it, then moved into place.
async function writeOwnerOnlyJSON(path, value) {
  const tmp = await IOUtils.createUniqueFile(PathUtils.parent(path), `${PathUtils.filename(path)}.tmp`, 0o600);
  try {
    await IOUtils.setPermissions(tmp, 0o600, false);
    await IOUtils.writeJSON(tmp, value);
    await IOUtils.move(tmp, path);
  } finally {
    await IOUtils.remove(tmp, { ignoreAbsent: true });
  }
  await IOUtils.setPermissions(path, 0o600, false);
}

export const WhimsyConnectors = {
  _file: null,
  _queue: Promise.resolve(),
  _secrets: new Map(),
  _busy: null,
  _users: new Set(),
  _bridge: null,
  _guards: new Map(),
  _windows: new Set(),
  _timer: null,
  // Tests replace these: the Linear and Jira sign-in checks, and the poll.
  _sessions: null,
  pollMs: MINUTE,

  get enabled() {
    return Services.prefs.getBoolPref(`whimsy.feature.${FEATURE}`, true);
  },

  get _path() {
    return PathUtils.join(PathUtils.profileDir, FILE);
  },

  // ---- storage: ciphertext and plain facts, one owner-only file ----

  async _read() {
    if (!this._file) {
      try {
        const saved = await IOUtils.readJSON(this._path);
        this._file = saved && typeof saved == "object" && saved.connectors ? saved : { connectors: {} };
      } catch {
        this._file = { connectors: {} };
      }
    }
    return this._file;
  },

  _update(change) {
    const run = this._queue.then(async () => {
      const file = await this._read();
      await change(file);
      await writeOwnerOnlyJSON(this._path, file);
    });
    this._queue = run.catch(() => {});
    return run.then(() => this._changed());
  },

  _changed() {
    Services.obs.notifyObservers(null, TOPIC);
  },

  async _saveTokens(file, id, tokens) {
    await lazy.OSKeyStore.ensureLoggedIn(false);
    file.connectors[id].secret = await lazy.OSKeyStore.encrypt(JSON.stringify(tokens));
    this._secrets.set(id, tokens);
  },

  async _tokens(id) {
    if (this._secrets.has(id)) {
      return this._secrets.get(id);
    }
    const entry = (await this._read()).connectors[id];
    if (!entry?.secret) {
      return null;
    }
    try {
      const tokens = JSON.parse(await lazy.OSKeyStore.decrypt(entry.secret));
      this._secrets.set(id, tokens);
      return tokens;
    } catch {
      return null;
    }
  },

  /** A usable access token, refreshed when it's close to expiring. */
  async accessToken(id) {
    const tokens = await this._tokens(id);
    if (!tokens?.access) {
      throw error("expired");
    }
    if (tokens.expiresAt && tokens.expiresAt - Date.now() > MINUTE) {
      return tokens.access;
    }
    const entry = (await this._read()).connectors[id];
    const oauthId = CATALOG[id]?.kind == "oauth" ? id : null;
    try {
      const fresh = await WhimsyConnectorOAuth.refresh({
        tokenUrl: oauthId ? WhimsyConnectorOAuth.provider(id).token : tokens.tokenUrl,
        clientId: tokens.clientId,
        clientSecret: oauthId ? WhimsyConnectorOAuth.clientSecret(id) : "",
        resource: tokens.resource ?? "",
        tokens,
      });
      const merged = { ...tokens, ...fresh };
      await this._update(async file => {
        if (file.connectors[id]) {
          await this._saveTokens(file, id, merged);
          file.connectors[id].status = "ok";
        }
      });
      return merged.access;
    } catch (e) {
      if (e.code == "expired" && entry) {
        await this._update(file => {
          if (file.connectors[id]) {
            file.connectors[id].status = "expired";
          }
        });
      }
      throw e;
    }
  },

  // ---- what Settings and onboarding show ----

  /**
   * Every connector, connected or not, then the added MCP servers.
   * @returns {Promise<{id, kind, logo, connected, account, scopes: {id, on}[], status, problem?, name?, url?, toolCount?}[]>}
   */
  async list() {
    const file = await this._read();
    const out = [];
    for (const [id, info] of Object.entries(CATALOG)) {
      out.push(this._describe(id, info, file.connectors[id]));
    }
    for (const [id, entry] of Object.entries(file.connectors)) {
      if (id.startsWith("mcp:")) {
        out.push(this._describe(id, { kind: "mcp", logo: "mcp", scopes: [] }, entry));
      }
    }
    return out;
  },

  _describe(id, info, entry) {
    const c = {
      id,
      kind: info.kind,
      logo: info.logo,
      connected: !!entry,
      account: entry?.account ?? "",
      scopes: info.scopes.map(s => ({ id: s, on: entry ? entry.scopes?.[s] !== false : true })),
      status: entry ? entry.status ?? "ok" : "off",
      name: entry?.name ?? "",
      url: entry?.url ?? "",
      site: entry?.site ?? "",
      toolCount: entry?.tools?.length ?? 0,
      toolNames: entry?.tools ?? [],
      lastUsed: entry?.lastUsed ?? 0,
    };
    if (info.kind == "oauth" && !WhimsyConnectorOAuth.clientId(id)) {
      c.problem = { l10nId: "whimsy-connectors-needs-client-id", action: "client-id", tone: "muted" };
      if (!entry) {
        c.status = "needs-client-id";
      }
    }
    if (id == "apple-calendar") {
      const status = lazy.WhimsyNextMeeting.appleStatus;
      if (["unavailable", "missing-usage-description"].includes(status) && (entry || !lazy.WhimsyNextMeeting.appleAvailable)) {
        c.status = "unavailable";
        c.problem = { l10nId: "whimsy-connectors-apple-unavailable", action: null, tone: "muted" };
      } else if (entry && ["denied", "restricted"].includes(status)) {
        c.status = "denied";
        c.problem = { l10nId: "whimsy-connectors-apple-denied", action: "system-settings", tone: "fail" };
      }
    }
    if (entry && c.status == "expired") {
      c.problem = { l10nId: "whimsy-connectors-expired", action: "sign-in", tone: "warn" };
    } else if (entry && c.status == "unreachable") {
      c.problem = { l10nId: "whimsy-connectors-unreachable", args: { host: hostOf(entry.url || entry.site) || entry.site || "" }, action: "retry", tone: "fail" };
    }
    return c;
  },

  /** Routines and features that stop when `id` disconnects. */
  usersOf(id) {
    const names = [];
    for (const fn of this._users) {
      try {
        names.push(...(fn(id) ?? []));
      } catch (e) {
        console.error(e);
      }
    }
    return [...new Set(names)];
  },

  /** Routines (L15) say which connectors they use: fn(id) -> names. */
  registerUser(fn) {
    this._users.add(fn);
    return () => this._users.delete(fn);
  },

  // ---- connecting ----

  get busy() {
    return this._busy?.id ?? null;
  },

  /** Cancel on the busy card stops its sign-in. */
  cancel() {
    const pending = this._busy;
    if (pending) {
      pending.cancelled = true;
      pending.cancel?.();
    }
  },

  /**
   * Signs in one connector (the scopes sheet comes first, in the UI).
   * Only one at a time. Resolves to its list entry.
   */
  async connect(win, id, { scopes = null, site = "", url = "" } = {}) {
    if (!this.enabled) {
      throw error("blocked");
    }
    if (this._busy) {
      throw error("busy");
    }
    const pending = (this._busy = { id });
    try {
      if (id == "mcp") {
        return await this._connectServer(win, url, pending);
      }
      const info = CATALOG[id];
      if (!info) {
        throw error("failed", `No connector ${id}`);
      }
      if (info.kind == "oauth") {
        const on = (scopes ?? info.scopes).filter(s => info.scopes.includes(s));
        const { tokens, account } = await WhimsyConnectorOAuth.signInProvider(win, id, on, pending);
        await this._update(async file => {
          file.connectors[id] = { account, scopes: Object.fromEntries(info.scopes.map(s => [s, on.includes(s)])), status: "ok", at: Date.now() };
          await this._saveTokens(file, id, tokens);
        });
        this._refreshCalendars().catch(() => {});
      } else if (id == "apple-calendar") {
        await this._connectApple();
      } else if (id == "granola") {
        await this._connectServer(win, Services.prefs.getStringPref("whimsy.connectors.granola.url", ""), pending, "granola");
      } else {
        await this._connectSession(win, id, site, pending);
      }
      return (await this.list()).find(c => c.id == id);
    } finally {
      if (this._busy == pending) {
        this._busy = null;
      }
      this._changed();
    }
  },

  async _connectApple() {
    const meeting = lazy.WhimsyNextMeeting;
    if (!meeting.appleAvailable) {
      throw error("unavailable");
    }
    meeting.setAppleEnabled(true);
    const ok = await meeting.requestAppleAccess();
    await this._update(file => {
      file.connectors["apple-calendar"] = { account: "", status: ok ? "ok" : "denied", at: Date.now() };
    });
    if (!ok) {
      throw error(["unavailable", "missing-usage-description"].includes(meeting.appleStatus) ? "unavailable" : "denied");
    }
  },

  /** Asks an MCP server what it offers (set-5.7), without saving. */
  async check(url, { signal } = {}) {
    const parsed = mcpUrl(url);
    if (!parsed) {
      throw error("bad-url");
    }
    try {
      const { name, tools } = await WhimsyMCPClient.connect(parsed.href, { signal });
      return { url: parsed.href, name, tools: tools.map(t => t.name), readOnly: readOnlyOf(tools), signIn: false };
    } catch (e) {
      if (e.code == "auth") {
        return { url: parsed.href, name: parsed.hostname.replace(/^(mcp|api)\./, ""), tools: [], signIn: true, resourceMetadata: e.resourceMetadata };
      }
      throw error(e.code == "unreachable" ? "unreachable" : "not-mcp", e.message);
    }
  },

  async _connectServer(win, url, pending, fixedId = null) {
    const found = await this.check(url);
    const id = fixedId ?? `mcp:${new URL(found.url).host}`;
    let tokens = null;
    let result = found;
    if (found.signIn) {
      tokens = await WhimsyConnectorOAuth.signInMcp(win, found.url, { resourceMetadata: found.resourceMetadata, pending });
      const listed = await WhimsyMCPClient.connect(found.url, { headers: { Authorization: `Bearer ${tokens.access}` } });
      result = { ...found, name: listed.name, tools: listed.tools.map(t => t.name), readOnly: readOnlyOf(listed.tools) };
    }
    await this._update(async file => {
      file.connectors[id] = { url: found.url, name: fixedId ? "" : result.name, tools: result.tools, readOnly: result.readOnly ?? [], readOnlyRule: READ_ONLY_RULE, status: "ok", account: "", at: Date.now() };
      if (tokens) {
        await this._saveTokens(file, id, tokens);
      }
    });
    return (await this.list()).find(c => c.id == id);
  },

  // Linear and Jira use the sign-ins the live folders use: the site's own
  // session. Signed out: its sign-in page opens in a tab, and the card
  // waits until the session works.
  async _connectSession(win, id, site, pending) {
    if (id == "jira") {
      site = this._jiraSite(site);
      if (!site) {
        throw error("needs-site");
      }
    }
    let account = await this._sessionAccount(id, site);
    if (account === null) {
      const login = id == "linear" ? "https://linear.app/login" : site;
      const opened = await WhimsyConnectorOAuth.openSignIn(win, login, { tab: true, onClosed: () => pending.cancel?.() });
      account = await new Promise((resolve, reject) => {
        let timer = null;
        const stop = failure => {
          clearInterval(timer);
          failure ? reject(failure) : null;
        };
        pending.cancel = () => stop(error("cancelled"));
        timer = setInterval(async () => {
          const found = await this._sessionAccount(id, site).catch(() => null);
          if (found !== null) {
            clearInterval(timer);
            resolve(found);
          }
        }, 2000);
        setTimeout(() => stop(error("cancelled")), 5 * MINUTE);
      });
      opened?.close?.();
    }
    await this._update(file => {
      file.connectors[id] = { account, site: site || "", status: "ok", at: Date.now() };
    });
  },

  _jiraSite(input) {
    let url;
    try {
      url = new URL(/^https?:\/\//.test(input) ? input : `https://${input}`);
    } catch {
      return "";
    }
    return url.protocol == "https:" || (url.hostname == "127.0.0.1" && url.protocol == "http:") ? url.origin : "";
  },

  /** The signed-in account's name, or null when signed out. */
  async _sessionAccount(id, site) {
    if (this._sessions?.[id]) {
      return this._sessions[id](site);
    }
    if (id == "linear") {
      const { data } = await this._linear("query { viewer { name email } }");
      return data?.viewer ? String(data.viewer.email || data.viewer.name || "") : null;
    }
    const response = await fetch(`${site}/rest/api/2/myself`, { credentials: "include", headers: { Accept: "application/json" } });
    if (!response.ok) {
      return null;
    }
    const me = await response.json().catch(() => ({}));
    return String(me.emailAddress || me.displayName || "");
  },

  async _linear(query, variables) {
    const result = await lazy.whimsyPostFetch(null, LINEAR_GRAPHQL, {
      body: JSON.stringify(variables ? { query, variables } : { query }),
      headers: { Accept: "application/json", "Linear-Client-ID": LINEAR_CLIENT_ID },
      principalURL: "https://linear.app",
    });
    try {
      return JSON.parse(result.text);
    } catch {
      return {};
    }
  },

  /**
   * A scope's switch. Off narrows at once; on asks the provider again for
   * that scope (set-5.2), and stays off if the person says no.
   */
  async setScope(win, id, scope, on) {
    const info = CATALOG[id];
    const entry = (await this._read()).connectors[id];
    if (!info?.scopes.includes(scope) || !entry) {
      return false;
    }
    if (!on) {
      await this._update(file => {
        file.connectors[id].scopes[scope] = false;
      });
      return true;
    }
    if (this._busy) {
      throw error("busy");
    }
    const pending = (this._busy = { id });
    try {
      const want = info.scopes.filter(s => s == scope || entry.scopes?.[s] !== false);
      const { tokens, account } = await WhimsyConnectorOAuth.signInProvider(win, id, want, pending);
      await this._update(async file => {
        const current = file.connectors[id];
        current.scopes[scope] = true;
        current.account = account || current.account;
        current.status = "ok";
        await this._saveTokens(file, id, tokens);
      });
      return true;
    } finally {
      this._busy = null;
      this._changed();
    }
  },

  async disconnect(id) {
    const tokens = await this._tokens(id).catch(() => null);
    if (CATALOG[id]?.kind == "oauth") {
      WhimsyConnectorOAuth.revoke(id, tokens);
      lazy.WhimsyNextMeeting.setConnectorEvents(id, null);
    }
    if (id == "apple-calendar") {
      lazy.WhimsyNextMeeting.setAppleEnabled(false);
    }
    this._secrets.delete(id);
    await this._update(file => {
      delete file.connectors[id];
    });
  },

  /** A server refused the sign-in (401): its row says Sign in again. */
  async markExpired(id) {
    if (!(await this._read()).connectors[id]) {
      return;
    }
    this._secrets.delete(id);
    await this._update(file => {
      if (file.connectors[id]) {
        file.connectors[id].status = "expired";
      }
    });
  },

  async setClientId(id, value) {
    Services.prefs.setStringPref(`whimsy.connectors.${id}.client-id`, String(value ?? "").trim());
    this._changed();
  },

  // ---- feeding AI ----

  /**
   * The connectors' tools for one run, as MCP servers (router `tools`).
   * Each server says which of its tools only read and stay inside the
   * server (`readOnlyTools`, from the server's own annotations when it was
   * added; the built-in tools all read). Every other tool needs the person's press (H1).
   */
  async tools() {
    if (!this.enabled) {
      return [];
    }
    const file = await this._read();
    const servers = [];
    for (const [id, entry] of Object.entries(file.connectors)) {
      if (entry.url && entry.status != "expired") {
        const tokens = await this._tokens(id);
        let headers;
        if (tokens) {
          headers = { Authorization: `Bearer ${await this.accessToken(id).catch(() => "")}` };
        }
        servers.push({
          name: id == "granola" ? "granola" : entry.name || hostOf(entry.url),
          url: entry.url,
          readOnlyTools: entry.readOnlyRule === READ_ONLY_RULE && Array.isArray(entry.readOnly)
            ? entry.readOnly.filter(n => typeof n == "string")
            : [],
          ...(headers ? { headers } : {}),
        });
      }
    }
    if (this._builtinTools(file).length) {
      const bridge = this._startBridge();
      servers.push({ name: "whimsy_connectors", url: bridge.url, readOnly: true, headers: { Authorization: `Bearer ${bridge.token}` } });
    }
    return servers;
  },

  /**
   * One run's permission endpoint for Claude Code's --permission-prompt-tool
   * (H1). Claude Code calls it before any tool that isn't pre-approved and
   * waits: `confirm({ server, tool, args })` resolves true for "Allow once".
   * `names` maps the run's MCP server names (as Claude Code sees them) to
   * what the person calls them; null marks the guard's own name.
   * Returns { server, dispose }; dispose answers anything pending with "no".
   */
  guard(confirm, names = {}) {
    const bridge = this._startBridge();
    const token = ChromeUtils.base64URLEncode(crypto.getRandomValues(new Uint8Array(32)), { pad: false });
    const run = { confirm, names, pending: new Set() };
    this._guards.set(token, run);
    return {
      server: {
        name: GUARD_SERVER,
        url: bridge.url.replace(BRIDGE_PATH, GUARD_PATH),
        guard: true,
        headers: { Authorization: `Bearer ${token}` },
        // Claude Code's names for this run's servers, once they're known.
        bindNames: map => (run.names = { ...map }),
      },
      dispose: () => {
        this._guards.delete(token);
        for (const settle of run.pending) {
          settle(false);
        }
        run.pending.clear();
      },
    };
  },

  // What the guard answers Claude Code for one tool call.
  async _guardAnswer(run, params) {
    const deny = message => ({ behavior: "deny", message });
    const args = params?.arguments ?? {};
    const name = String(args.tool_name ?? "");
    const input = args.input && typeof args.input == "object" ? args.input : {};
    const key = Object.keys(run.names)
      .filter(k => name.startsWith(`mcp__${k}__`))
      .sort((a, b) => b.length - a.length)[0];
    if (!key || run.names[key] === null) {
      return deny("Only connector tools can be allowed here.");
    }
    const match = [name, key, name.slice(`mcp__${key}__`.length)];
    const server = run.names[key];
    let settle;
    const answered = new Promise(resolve => (settle = resolve));
    run.pending.add(settle);
    Promise.resolve()
      .then(() => run.confirm({ server, tool: match[2], args: input }))
      .then(ok => settle(ok === true), () => settle(false));
    const ok = await answered;
    run.pending.delete(settle);
    return ok ? { behavior: "allow", updatedInput: input } : deny("The person didn't allow this. Don't try it another way; say what you would have done.");
  },

  /** Calls one tool of a connector; resolves to its text. */
  async call(id, tool, args = {}) {
    const file = await this._read();
    const entry = file.connectors[id];
    if (!entry) {
      throw error("not-connected");
    }
    entry.lastUsed = Date.now();
    if (entry.url) {
      const tokens = await this._tokens(id);
      const headers = tokens ? { Authorization: `Bearer ${await this.accessToken(id)}` } : {};
      return WhimsyMCPClient.callTool(entry.url, tool, args, { headers });
    }
    const def = this._builtinTools(file).find(t => t.connector == id && t.name == tool);
    if (!def) {
      throw error("no-tool");
    }
    return def.run(args);
  },

  // The built-in connectors' tools, by what's switched on.
  _builtinTools(file) {
    const on = (id, scope) => !!file.connectors[id] && file.connectors[id].status != "expired" && (!scope || file.connectors[id].scopes?.[scope] !== false);
    const range = { type: "object", properties: { days: { type: "number", description: "How many days from today (default 1)" } } };
    const query = { type: "object", properties: { query: { type: "string" } }, required: ["query"] };
    const tools = [];
    const add = (connector, scope, name, description, inputSchema, run) => on(connector, scope) && tools.push({ connector, name, description, inputSchema, run });
    add("google", "calendar", "google_calendar_events", "Events on the person's Google Calendar from today", range, a => this._googleEvents(a.days));
    add("google", "gmail", "gmail_search", "Search the person's Gmail (read-only) with Gmail search syntax", query, a => this._gmail(a.query));
    add("google", "drive", "drive_search", "Find files in the person's Google Drive by text", query, a => this._drive(a.query));
    add("microsoft", "calendar", "outlook_calendar_events", "Events on the person's Outlook calendar from today", range, a => this._graphEvents(a.days));
    add("microsoft", "outlook", "outlook_mail_search", "Search the person's Outlook mail (read-only)", query, a => this._graph(`/me/messages?$search="${encodeURIComponent(a.query)}"&$top=10&$select=subject,from,receivedDateTime,bodyPreview`));
    add("microsoft", "onedrive", "onedrive_search", "Find files in the person's OneDrive", query, a => this._graph(`/me/drive/root/search(q='${encodeURIComponent(a.query)}')?$top=10&$select=name,webUrl,lastModifiedDateTime`));
    add("apple-calendar", null, "apple_calendar_events", "Upcoming events from the calendars on this Mac", range, () => JSON.stringify(lazy.WhimsyNextMeeting.upcoming().slice(0, 30).map(e => ({ title: e.title, start: new Date(e.start).toISOString(), end: new Date(e.end).toISOString() }))));
    add("linear", null, "linear_my_issues", "Linear issues assigned to the person", { type: "object", properties: {} }, async () => JSON.stringify((await this._linear("query { viewer { assignedIssues(first: 30, filter: { completedAt: { null: true } }) { nodes { identifier title url state { name } } } } }")).data ?? {}));
    add("jira", null, "jira_my_issues", "Jira issues assigned to the person", { type: "object", properties: {} }, () => this._jira("assignee = currentUser() AND resolution = Unresolved"));
    add("jira", null, "jira_search", "Search Jira with JQL", { type: "object", properties: { jql: { type: "string" } }, required: ["jql"] }, a => this._jira(a.jql));
    return tools;
  },

  async _api(id, path) {
    const base = WhimsyConnectorOAuth._test?.[id]?.api ?? API[id];
    const response = await fetch(`${base}${path}`, { credentials: "omit", headers: { Authorization: `Bearer ${await this.accessToken(id)}`, Accept: "application/json" } });
    if (response.status == 401) {
      throw error("expired");
    }
    return response.json();
  },

  async _googleEvents(days = 1) {
    const params = new URLSearchParams({ timeMin: day().toISOString(), timeMax: day(Math.max(1, Number(days) || 1)).toISOString(), singleEvents: "true", orderBy: "startTime", maxResults: "50" });
    const data = await this._api("google", `/calendar/v3/calendars/primary/events?${params}`);
    return (data.items ?? []).map(e => ({ title: e.summary ?? "", start: Date.parse(e.start?.dateTime ?? e.start?.date), end: Date.parse(e.end?.dateTime ?? e.end?.date), allDay: !e.start?.dateTime, location: e.location ?? "", url: e.hangoutLink ?? "" }));
  },

  async _graphEvents(days = 1) {
    const params = new URLSearchParams({ startDateTime: day().toISOString(), endDateTime: day(Math.max(1, Number(days) || 1)).toISOString(), $top: "50" });
    const data = await this._api("microsoft", `/me/calendarView?${params}`);
    return (data.value ?? []).map(e => ({ title: e.subject ?? "", start: Date.parse(e.start?.dateTime + "Z"), end: Date.parse(e.end?.dateTime + "Z"), allDay: !!e.isAllDay, location: e.location?.displayName ?? "", url: e.onlineMeeting?.joinUrl ?? "" }));
  },

  async _gmail(q) {
    const list = await this._api("google", `/gmail/v1/users/me/messages?maxResults=10&q=${encodeURIComponent(q)}`);
    const out = [];
    for (const { id } of list.messages ?? []) {
      const m = await this._api("google", `/gmail/v1/users/me/messages/${id}?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=Date`);
      const h = Object.fromEntries((m.payload?.headers ?? []).map(x => [x.name, x.value]));
      out.push({ subject: h.Subject ?? "", from: h.From ?? "", date: h.Date ?? "", snippet: m.snippet ?? "" });
    }
    return JSON.stringify(out);
  },

  async _drive(q) {
    const params = new URLSearchParams({ q: `fullText contains '${String(q).replace(/['\\]/g, "\\$&")}' and trashed = false`, pageSize: "10", fields: "files(id,name,mimeType,modifiedTime,webViewLink)" });
    return JSON.stringify((await this._api("google", `/drive/v3/files?${params}`)).files ?? []);
  },

  async _graph(path) {
    return JSON.stringify((await this._api("microsoft", path)).value ?? []);
  },

  async _jira(jql) {
    const site = (await this._read()).connectors.jira?.site;
    const response = await fetch(`${site}/rest/api/2/search?maxResults=30&fields=summary,status&jql=${encodeURIComponent(jql)}`, { credentials: "include", headers: { Accept: "application/json" } });
    return JSON.stringify(((await response.json()).issues ?? []).map(i => ({ key: i.key, summary: i.fields?.summary, status: i.fields?.status?.name, url: `${site}/browse/${i.key}` })));
  },

  // The built-in tools as one loopback MCP endpoint for Claude Code. Its
  // token lives only in memory and in the run's 0600 --mcp-config file.
  _startBridge() {
    if (this._bridge) {
      return this._bridge;
    }
    const server = new lazy.HttpServer();
    const token = ChromeUtils.base64URLEncode(crypto.getRandomValues(new Uint8Array(32)), { pad: false });
    server.registerPathHandler(BRIDGE_PATH, (request, response) => {
      response.processAsync();
      this._bridgeReply(request, token)
        .catch(() => ({ status: 500, body: { jsonrpc: "2.0", id: null, error: { code: -32603, message: "Internal error" } } }))
        .then(({ status, body }) => {
          response.setStatusLine(request.httpVersion, status, status == 200 ? "OK" : "Error");
          response.setHeader("Cache-Control", "no-store", false);
          if (body !== undefined) {
            response.setHeader("Content-Type", "application/json; charset=utf-8", false);
            response.write(utf8(JSON.stringify(body)));
          }
          response.finish();
        });
    });
    server.registerPathHandler(GUARD_PATH, (request, response) => {
      response.processAsync();
      this._guardReply(request)
        .catch(() => ({ status: 500, body: { jsonrpc: "2.0", id: null, error: { code: -32603, message: "Internal error" } } }))
        .then(({ status, body }) => {
          response.setStatusLine(request.httpVersion, status, status == 200 ? "OK" : "Error");
          response.setHeader("Cache-Control", "no-store", false);
          if (body !== undefined) {
            response.setHeader("Content-Type", "application/json; charset=utf-8", false);
            response.write(utf8(JSON.stringify(body)));
          }
          response.finish();
        });
    });
    server._start(-1, "127.0.0.1");
    const port = server.identity.primaryPort;
    server.identity.add("http", "127.0.0.1", port);
    this._bridge = { server, token, url: `http://127.0.0.1:${port}${BRIDGE_PATH}` };
    return this._bridge;
  },

  // The per-run guard: same checks as the bridge, keyed by the run's token.
  async _guardReply(request) {
    const header = name => (request.hasHeader(name) ? request.getHeader(name) : "");
    if (header("Origin")) {
      return { status: 403, body: undefined };
    }
    const given = header("Authorization").replace(/^Bearer\s+/i, "");
    const token = [...this._guards.keys()].find(t => sameSecret(given, t));
    if (!token) {
      return { status: 401, body: undefined };
    }
    if (request.method != "POST") {
      return { status: 405, body: undefined };
    }
    const stream = request.bodyInputStream;
    let message;
    try {
      message = JSON.parse(lazy.NetUtil.readInputStreamToString(stream, stream.available(), { charset: "UTF-8" }));
    } catch {
      return { status: 400, body: { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } } };
    }
    const { id, method, params = {} } = message ?? {};
    if (id === undefined || id === null) {
      return { status: 202, body: undefined };
    }
    const reply = result => ({ status: 200, body: { jsonrpc: "2.0", id, result } });
    switch (method) {
      case "initialize":
        return reply({ protocolVersion: params.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "whimsy-guard", version: "1" } });
      case "ping":
        return reply({});
      case "tools/list":
        return reply({
          tools: [
            {
              name: GUARD_TOOL,
              description: "Asks the person before a connector tool runs",
              inputSchema: { type: "object", properties: { tool_name: { type: "string" }, input: { type: "object" }, tool_use_id: { type: "string" } }, required: ["tool_name"] },
            },
          ],
        });
      case "tools/call": {
        const run = this._guards.get(token);
        if (params.name != GUARD_TOOL || !run) {
          return reply({ content: [{ type: "text", text: JSON.stringify({ behavior: "deny", message: "Unknown tool" }) }] });
        }
        return reply({ content: [{ type: "text", text: JSON.stringify(await this._guardAnswer(run, params)) }] });
      }
      default:
        return { status: 200, body: { jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } } };
    }
  },

  async _bridgeReply(request, token) {
    const header = name => (request.hasHeader(name) ? request.getHeader(name) : "");
    if (header("Origin")) {
      return { status: 403, body: undefined };
    }
    if (!sameSecret(header("Authorization").replace(/^Bearer\s+/i, ""), token)) {
      return { status: 401, body: undefined };
    }
    if (request.method != "POST") {
      return { status: 405, body: undefined };
    }
    const stream = request.bodyInputStream;
    let message;
    try {
      message = JSON.parse(lazy.NetUtil.readInputStreamToString(stream, stream.available(), { charset: "UTF-8" }));
    } catch {
      return { status: 400, body: { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } } };
    }
    const { id, method, params = {} } = message ?? {};
    if (id === undefined || id === null) {
      return { status: 202, body: undefined };
    }
    const reply = result => ({ status: 200, body: { jsonrpc: "2.0", id, result } });
    const tools = this.enabled ? this._builtinTools(await this._read()) : [];
    switch (method) {
      case "initialize":
        return reply({ protocolVersion: params.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "whimsy-connectors", version: "1" } });
      case "ping":
        return reply({});
      case "tools/list":
        return reply({ tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
      case "tools/call": {
        const tool = tools.find(t => t.name == params.name);
        if (!tool) {
          return reply({ content: [{ type: "text", text: `Unknown tool: ${params.name}` }], isError: true });
        }
        try {
          const out = await tool.run(params.arguments ?? {});
          return reply({ content: [{ type: "text", text: typeof out == "string" ? out : JSON.stringify(out) }] });
        } catch (e) {
          return reply({ content: [{ type: "text", text: `Couldn't read it: ${e.code ?? e.message}` }], isError: true });
        }
      }
      default:
        return { status: 200, body: { jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } } };
    }
  },

  // ---- Granola's silent chip (owner settlement 5) ----

  /** The calendar meeting happening now, from every calendar connected. */
  meetingNow(now = Date.now()) {
    return lazy.WhimsyNextMeeting.upcoming(now).find(ev => ev.start <= now && ev.end > now && !ev.allDay) ?? null;
  },

  /**
   * While a calendar meeting is on and Granola has notes for it: a chip
   * with its in-progress notes when Granola exposes them, else the event
   * plus past notes of that series. null otherwise.
   */
  async granolaNow(win, now = Date.now()) {
    if (!this.enabled || !win || win.closed) {
      return null;
    }
    const entry = (await this._read()).connectors.granola;
    const meeting = this.meetingNow(now);
    if (!entry || entry.status == "expired" || !meeting) {
      return null;
    }
    const names = entry.tools ?? [];
    const live = names.find(n => /live|current|in.?progress|now/i.test(n));
    const search = names.find(n => /search|query|find|list.*meeting|meetings/i.test(n));
    let notes = "";
    let liveNotes = false;
    try {
      if (live) {
        notes = await this.call("granola", live, { title: meeting.title });
        liveNotes = !!notes.trim();
      }
      if (!liveNotes && search) {
        notes = await this.call("granola", search, { query: meeting.title });
      }
    } catch (e) {
      console.error("Whimsy: Granola notes", e?.code ?? e);
      return null;
    }
    if (!notes.trim()) {
      return null;
    }
    const when = new Date(meeting.start).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    const text = [
      `Meeting in progress: ${meeting.title} (started ${when})`,
      liveNotes ? "Granola's notes so far:" : "Granola's notes from earlier meetings in this series:",
      notes.slice(0, NOTES_CHARS),
    ].join("\n");
    const chipId = "granola:live";
    return {
      id: chipId,
      kind: "granola",
      label: meeting.title,
      icon: `${ICONS}granola.svg`,
      counts: { text: text.length },
      sourceId: "granola",
      liveNotes,
      parts: [{ chipId, kind: "text", size: text.length, text, title: meeting.title }],
    };
  },

  // Once a minute per window: the Granola chip and the calendars.
  initWindow(win) {
    const { WhimsyCommands } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyCommands.sys.mjs");
    const { WhimsyAIProviders } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyAIProviders.sys.mjs");
    WhimsyCommands.register(win, {
      id: "cmd_whimsyConnectors",
      l10nId: "whimsy-action-connectors",
      run: w => WhimsyAIProviders.openSettings(w, "connectors"),
      icon: `${ICONS}mcp.svg`,
      isAvailable: () => this.enabled && WhimsyAIProviders.enabled,
    });
    if (this._windows.has(win) || !this.enabled) {
      return;
    }
    this._windows.add(win);
    win.addEventListener("unload", () => {
      this._windows.delete(win);
      if (!this._windows.size) {
        clearInterval(this._timer);
        this._timer = null;
      }
    }, { once: true });
    this._registerSources();
    this._timer ??= setInterval(() => this.poll(), this.pollMs);
    this.poll();
  },

  async poll() {
    if ((this._polls = (this._polls ?? 0) + 1) % 5 == 1) {
      await this._refreshCalendars().catch(() => {});
    }
    for (const win of this._windows) {
      // W25: while Whimsy follows a meeting, its notes are the chip.
      const chip = lazy.WhimsyMeetingNotes.chipFor(win) ?? (await this.granolaNow(win).catch(() => null));
      if (!win.closed) {
        lazy.WhimsyChatContextUI.setLiveChip(win, chip);
      }
    }
  },

  async _refreshCalendars() {
    const file = await this._read();
    for (const [id, scope, read] of [["google", "calendar", d => this._googleEvents(d)], ["microsoft", "calendar", d => this._graphEvents(d)]]) {
      const entry = file.connectors[id];
      if (entry && entry.scopes?.[scope] !== false && entry.status != "expired") {
        lazy.WhimsyNextMeeting.setConnectorEvents(id, await read(2).catch(() => null) ?? []);
      } else {
        lazy.WhimsyNextMeeting.setConnectorEvents(id, null);
      }
    }
  },

  // Chat context: Drive or OneDrive files the message names, and Granola's
  // notes when a message asks about a meeting.
  _registerSources() {
    if (this._sourcesOn) {
      return;
    }
    this._sourcesOn = true;
    lazy.WhimsyAIContext.registerSource("drive", async prompt => {
      const file = await this._read();
      const tool = this._builtinTools(file).find(t => t.name == "drive_search" || t.name == "onedrive_search");
      const words = /\b(?:doc|docs|drive|onedrive|file|spreadsheet|slides?)\b/i.test(prompt ?? "") && String(prompt).replace(/[^\p{L}\p{N}\s]/gu, " ").trim();
      if (!tool || !words) {
        return null;
      }
      const text = await tool.run({ query: words.split(/\s+/).slice(-6).join(" ") }).catch(() => "");
      const chipId = `drive:${tool.connector}`;
      return text ? { chips: [{ id: chipId, kind: "drive", label: tool.connector == "google" ? "Drive" : "OneDrive", icon: `${ICONS}${tool.connector == "google" ? "google-drive" : "onedrive"}.svg`, counts: { text: text.length }, sourceId: tool.connector }], parts: [{ chipId, kind: "text", size: text.length, text, title: "Files" }] } : null;
    });
    lazy.WhimsyAIContext.registerSource("granola", async (prompt, win) => {
      if (!/\b(?:meeting|call|standup|notes?|granola)\b/i.test(prompt ?? "")) {
        return null;
      }
      const chip = await this.granolaNow(win).catch(() => null);
      return chip ? { chips: [chip], parts: chip.parts } : null;
    });
  },

  // Tests only.
  async _resetForTest() {
    this._file = null;
    this._secrets.clear();
    this._busy = null;
    await IOUtils.remove(this._path, { ignoreAbsent: true });
  },
};
