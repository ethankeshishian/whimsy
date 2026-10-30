/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Linear live folder: "My Issues" (assigned to you, open states) as a
// self-updating folder of tabs, the same "always current" model as Zen's
// GitHub live folder and Whimsy's Jira folder.
//
// Auth, by default, is the linear.app session you're already signed in to
// in Whimsy -- no API key. Linear's own web app (linear.app) talks to
// https://client-api.linear.app/graphql with `credentials: "include"`:
// its session cookie, plus `user`/`userAccount` headers that pick which
// workspace (Linear "user") of the signed-in account a query runs as, and
// a `Linear-Client-ID`. No CSRF token: the server relies on the Origin
// (https://linear.app) and on those custom headers, which a cross-site
// page can't send without a CORS preflight. This sends the same request
// from the parent process: a channel whose principal is https://linear.app
// in the folder's container (so the space's profile's cookies, and Origin:
// https://linear.app), to client-api.linear.app. The cookie is attached by
// necko; Whimsy never reads, stores or logs it. Nothing here is reachable
// from web content: no actor, no message listener, no new page API.
//
// 1) `availableUsers` lists the account's workspaces (one per Linear user).
// 2) `viewer.assignedIssues` runs once per workspace (or only the one
//    picked in the folder's Workspace menu), merged into one folder.
// Signed out: the folder shows "Sign in to Linear", which opens
// linear.app/login in the space's container and refreshes as soon as a
// linear.app cookie lands in that container. A personal API key (login
// manager, origin https://api.linear.app, sent as `Authorization: <key>`
// to the public https://api.linear.app/graphql) stays as an advanced
// fallback in the folder's menu, used only when the session isn't.
// Rate limits (HTTP 429, or Linear's RATELIMITED error code) back off
// until X-RateLimit-Requests-Reset / Retry-After, leaving tabs in place.
//
// Registered into Zen's live-folder registry by WhimsyLiveFolders.sys.mjs;
// Zen's ZenLiveFolder.sys.mjs (the base class) is read, never edited.

import { nsZenLiveFolderProvider } from "resource:///modules/zen/ZenLiveFolder.sys.mjs";
import {
  whimsyLiveFolderUserContextId,
  whimsyPostFetch,
} from "resource:///modules/whimsy/WhimsyLiveFolderFetch.sys.mjs";

const lazy = {};
ChromeUtils.defineLazyGetter(lazy, "l10n", () => new Localization(["browser/whimsy.ftl"]));
ChromeUtils.defineESModuleGetters(lazy, {
  clearTimeout: "resource://gre/modules/Timer.sys.mjs",
  setTimeout: "resource://gre/modules/Timer.sys.mjs",
});

// The public API, for the API-key fallback.
const GRAPHQL_URL = "https://api.linear.app/graphql";
// What linear.app's own web app calls with its session cookie.
const SESSION_GRAPHQL_URL = "https://client-api.linear.app/graphql";
const SESSION_ORIGIN = "https://linear.app";
const SIGN_IN_URL = "https://linear.app/login";
const LOGIN_ORIGIN = "https://api.linear.app";
const LOGIN_REALM = "Whimsy Linear API key";
const LOGIN_USERNAME = "linear-api-key";

export const LINEAR_ERROR_SIGNED_OUT = "whimsy-live-folder-linear-signed-out";
// Kept from the key-only days: now only "the stored API key was rejected".
export const LINEAR_ERROR_KEY_REJECTED = "whimsy-live-folder-linear-no-auth";
export const LINEAR_ERROR_RATE_LIMITED = "whimsy-live-folder-linear-rate-limited";
const ERROR_FAILED = "zen-live-folder-failed-fetch";

// The account's workspaces are re-listed at most hourly (or right away
// after an auth failure); each refresh is then one request per workspace.
const WORKSPACES_TTL_MS = 60 * 60 * 1000;
const MAX_WORKSPACES = 10;
const DEFAULT_RATE_LIMIT_BACKOFF_MS = 5 * 60 * 1000;
const MAX_RATE_LIMIT_BACKOFF_MS = 60 * 60 * 1000;

// Like linear.app's own client: a random id per running browser.
const CLIENT_ID = Math.random().toString(36).substring(2, 15);

const AUTH_ERROR_CODES = new Set(["AUTHENTICATION_ERROR", "UNAUTHENTICATED", "FORBIDDEN"]);

const AVAILABLE_USERS_QUERY = `
  query WhimsyAvailableUsers {
    availableUsers {
      id
      users {
        id
        active
        organization { id name urlKey deletionRequestedAt }
      }
    }
  }
`;

// Linear's WorkflowState `type` values, in Linear's own board order (see
// WorkflowState.type in Linear's public schema,
// github.com/linear/linear packages/sdk/src/schema.graphql: "triage",
// "backlog", "unstarted", "started", "completed", "canceled",
// "duplicate"). Each one is a show/hide toggle in the folder's Statuses
// menu. Backlog, Done (completed), Canceled and Duplicate are hidden by
// default, so the folder is what's actually on your plate; anything else,
// including a type Linear adds later, is shown.
export const LINEAR_STATE_TYPES = ["triage", "backlog", "unstarted", "started", "completed", "canceled", "duplicate"];
export const LINEAR_DEFAULT_HIDDEN = ["backlog", "completed", "canceled", "duplicate"];

// Older workspaces marked duplicates with a canceled state named
// "Duplicate" before Linear's native duplicate type; treat those the same.
export function linearStateType(state) {
  const type = state?.type || "";
  if (type === "canceled" && /^duplicate$/i.test((state?.name || "").trim())) {
    return "duplicate";
  }
  return type;
}

const MY_ISSUES_QUERY = `
  query WhimsyMyIssues($filter: IssueFilter) {
    viewer {
      id
      assignedIssues(filter: $filter, orderBy: updatedAt, first: 50) {
        nodes {
          id
          identifier
          title
          url
          state { name type }
        }
      }
    }
  }
`;

function buildFilter(team, hidden) {
  const filter = {};
  // Server-side, so the 50-issue page isn't spent on hidden ones. An
  // older workspace's canceled "Duplicate" is caught client-side in
  // #toItems when canceled is shown but duplicate isn't.
  if (hidden.length) {
    filter.state = { type: { nin: [...hidden] } };
  }
  if (team) {
    filter.team = { key: { eq: team } };
  }
  return filter;
}

// What a GraphQL response means. Linear answers most failures with an
// "errors" array (HTTP 200 or 400) rather than a bare status, so both are
// read: RATELIMITED or 429 is a rate limit; AUTHENTICATION_ERROR, a 401/403
// or an "authenticat..." message is signed out (or a rejected key);
// anything with data is fine; the rest is a plain failed fetch.
export function classifyLinearResponse({ status, data }) {
  const errors = Array.isArray(data?.errors) ? data.errors : [];
  const codes = errors.map(e => String(e?.extensions?.code || "").toUpperCase());
  if (status === 429 || codes.includes("RATELIMITED")) {
    return "rate-limited";
  }
  if (data?.data && !errors.length) {
    return "ok";
  }
  if (
    status === 401 ||
    status === 403 ||
    codes.some(c => AUTH_ERROR_CODES.has(c)) ||
    errors.some(e => /authenticat/i.test(String(e?.message || "")) || /authentication/i.test(String(e?.extensions?.type || "")))
  ) {
    return "unauthenticated";
  }
  return "failed";
}

function cookieHostMatches(cookieHost, host) {
  const h = (cookieHost || "").replace(/^\./, "");
  return h === host || host.endsWith(`.${h}`) || h.endsWith(`.${host}`);
}

export class WhimsyLinearLiveFolderProvider extends nsZenLiveFolderProvider {
  static type = "linear";

  constructor({ id, state, manager, graphqlUrl, sessionUrl, sessionOrigin, signInUrl }) {
    super({ id, state, manager });
    this.state.team = (state.team || "").trim().toUpperCase();
    // Saved folders from before the Statuses menu get the defaults.
    this.state.hiddenStates = Array.isArray(state.hiddenStates)
      ? state.hiddenStates.filter(t => typeof t === "string")
      : [...LINEAR_DEFAULT_HIDDEN];
    // "" = every workspace of the signed-in account; else an organization id.
    this.state.workspace = typeof state.workspace === "string" ? state.workspace : "";
    // Test-only: lets a test fixture stand in for Linear's endpoints and
    // sign-in page. Deliberately not part of `this.state`, so never persisted.
    this._graphqlUrl = graphqlUrl || GRAPHQL_URL;
    this._sessionUrl = sessionUrl || SESSION_GRAPHQL_URL;
    this._sessionOrigin = sessionOrigin || SESSION_ORIGIN;
    this._signInUrl = signInUrl || SIGN_IN_URL;
    // In memory only: the account's workspaces (ids and names, never
    // credentials), the container they were listed in, and when.
    this._workspaces = null;
    this._workspacesContext = null;
    this._workspacesAt = 0;
    this._usingApiKey = false;
    this._rateLimitedUntil = 0;
    this._signInObserver = null;
    this._signInTimer = null;
  }

  // Test hook: how long to wait after a linear.app cookie lands before
  // refreshing (sign-in sets several cookies in a burst).
  static signInDebounceMs = 1500;

  async #graphql(url, query, variables, { session = false, headers = {} } = {}) {
    const result = await whimsyPostFetch(this, url, {
      body: JSON.stringify(variables ? { query, variables } : { query }),
      headers: {
        Accept: "application/json",
        ...(session ? { "Linear-Client-ID": CLIENT_ID } : {}),
        ...headers,
      },
      principalURL: session ? this._sessionOrigin : null,
    });
    let data = null;
    try {
      data = JSON.parse(result.text);
    } catch {
      data = null;
    }
    return { status: result.status, data, header: result.header };
  }

  #issuesVariables() {
    return { filter: buildFilter(this.state.team, this.state.hiddenStates) };
  }

  #rateLimited(response) {
    const now = Date.now();
    const reset = Number(response.header?.("X-RateLimit-Requests-Reset"));
    const retryAfter = Number(response.header?.("Retry-After")) * 1000;
    let until = now + DEFAULT_RATE_LIMIT_BACKOFF_MS;
    if (Number.isFinite(reset) && reset > now) {
      until = reset;
    } else if (Number.isFinite(retryAfter) && retryAfter > 0) {
      until = now + retryAfter;
    }
    this._rateLimitedUntil = Math.min(until, now + MAX_RATE_LIMIT_BACKOFF_MS);
    return LINEAR_ERROR_RATE_LIMITED;
  }

  // The signed-in account's workspaces, or an error id.
  async #sessionWorkspaces(userContextId) {
    if (
      this._workspaces &&
      this._workspacesContext === userContextId &&
      Date.now() - this._workspacesAt < WORKSPACES_TTL_MS
    ) {
      return this._workspaces;
    }
    const response = await this.#graphql(this._sessionUrl, AVAILABLE_USERS_QUERY, null, { session: true });
    const kind = classifyLinearResponse(response);
    if (kind === "rate-limited") {
      return this.#rateLimited(response);
    }
    if (kind === "unauthenticated") {
      return LINEAR_ERROR_SIGNED_OUT;
    }
    if (kind !== "ok") {
      return ERROR_FAILED;
    }
    const account = response.data.data.availableUsers;
    const workspaces = (Array.isArray(account?.users) ? account.users : [])
      .filter(u => u?.id && u.active !== false && u.organization?.id && !u.organization.deletionRequestedAt)
      .slice(0, MAX_WORKSPACES)
      .map(u => ({
        id: u.organization.id,
        name: u.organization.name || u.organization.urlKey || "Linear",
        userId: u.id,
        accountId: account.id || "",
      }));
    this._workspaces = workspaces;
    this._workspacesContext = userContextId;
    this._workspacesAt = Date.now();
    return workspaces;
  }

  #forgetWorkspaces() {
    this._workspaces = null;
    this._workspacesAt = 0;
  }

  // Items over the linear.app session, or an error id.
  async #fetchViaSession() {
    const userContextId = whimsyLiveFolderUserContextId(this);
    const workspaces = await this.#sessionWorkspaces(userContextId);
    if (typeof workspaces === "string") {
      return workspaces;
    }
    const chosen = workspaces.find(w => w.id === this.state.workspace);
    const targets = chosen ? [chosen] : workspaces;

    const items = [];
    const seen = new Set();
    let ok = 0;
    let signedOut = 0;
    for (const workspace of targets) {
      const headers = { user: workspace.userId };
      if (workspace.accountId) {
        headers.userAccount = workspace.accountId;
      }
      const response = await this.#graphql(this._sessionUrl, MY_ISSUES_QUERY, this.#issuesVariables(), {
        session: true,
        headers,
      });
      const kind = classifyLinearResponse(response);
      if (kind === "rate-limited") {
        return this.#rateLimited(response);
      }
      if (kind === "unauthenticated") {
        // One workspace can be locked (e.g. SAML-only) without the
        // session being gone; only all of them failing means signed out.
        signedOut++;
        continue;
      }
      if (kind !== "ok") {
        continue;
      }
      ok++;
      for (const item of this.#toItems(response.data.data.viewer)) {
        if (!seen.has(item.id)) {
          seen.add(item.id);
          items.push(item);
        }
      }
    }
    if (ok || !targets.length) {
      return items;
    }
    this.#forgetWorkspaces();
    return signedOut === targets.length ? LINEAR_ERROR_SIGNED_OUT : ERROR_FAILED;
  }

  async fetchItems() {
    if (this._rateLimitedUntil > Date.now()) {
      return LINEAR_ERROR_RATE_LIMITED;
    }
    try {
      // 1) The signed-in linear.app session (the default; no key needed).
      const session = await this.#fetchViaSession();
      if (session !== LINEAR_ERROR_SIGNED_OUT) {
        if (Array.isArray(session)) {
          this._usingApiKey = false;
          this.#stopWatchingSignIn();
        }
        return session;
      }

      // 2) Signed out: an API key, only if the user chose to add one.
      const apiKey = await WhimsyLinearLiveFolderProvider.getApiKey();
      this._usingApiKey = !!apiKey;
      if (!apiKey) {
        this.#watchForSignIn();
        return LINEAR_ERROR_SIGNED_OUT;
      }

      const keyed = await this.#graphql(this._graphqlUrl, MY_ISSUES_QUERY, this.#issuesVariables(), {
        headers: { Authorization: apiKey },
      });
      const kind = classifyLinearResponse(keyed);
      if (kind === "ok") {
        this.#stopWatchingSignIn();
        return this.#toItems(keyed.data.data.viewer);
      }
      if (kind === "rate-limited") {
        return this.#rateLimited(keyed);
      }
      if (kind === "unauthenticated") {
        // Signing in to linear.app also fixes this, so keep listening.
        this.#watchForSignIn();
        return LINEAR_ERROR_KEY_REJECTED;
      }
      return ERROR_FAILED;
    } catch (e) {
      // The error only, never request headers or cookies.
      console.error("Whimsy: Linear live folder fetch failed", e?.name || "", e?.result || "");
      return ERROR_FAILED;
    }
  }

  // While signed out, refresh as soon as a linear.app cookie is set in
  // this folder's container (the user signing in, in any tab of that
  // profile). Only the cookie's host and container are looked at.
  #watchForSignIn() {
    if (this._signInObserver) {
      return;
    }
    const host = new URL(this._sessionOrigin).hostname;
    this._signInObserver = {
      observe: subject => {
        let cookie = null;
        try {
          const notification = subject.QueryInterface(Ci.nsICookieNotification);
          if (
            notification.action !== Ci.nsICookieNotification.COOKIE_ADDED &&
            notification.action !== Ci.nsICookieNotification.COOKIE_CHANGED
          ) {
            return;
          }
          cookie = notification.cookie;
        } catch {
          return;
        }
        if (!cookie || !cookieHostMatches(cookie.host, host)) {
          return;
        }
        if ((cookie.originAttributes?.userContextId || 0) !== whimsyLiveFolderUserContextId(this)) {
          return;
        }
        if (this._signInTimer) {
          lazy.clearTimeout(this._signInTimer);
        }
        this._signInTimer = lazy.setTimeout(() => {
          this._signInTimer = null;
          this.#forgetWorkspaces();
          this._rateLimitedUntil = 0;
          Promise.resolve()
            .then(() => this.refresh())
            .catch(e => console.error("Whimsy: Linear live folder refresh failed", e?.name || ""));
        }, WhimsyLinearLiveFolderProvider.signInDebounceMs);
      },
    };
    Services.obs.addObserver(this._signInObserver, "cookie-changed");
  }

  #stopWatchingSignIn() {
    if (this._signInTimer) {
      lazy.clearTimeout(this._signInTimer);
      this._signInTimer = null;
    }
    if (this._signInObserver) {
      try {
        Services.obs.removeObserver(this._signInObserver, "cookie-changed");
      } catch {}
      this._signInObserver = null;
    }
  }

  get isWatchingForSignIn() {
    return !!this._signInObserver;
  }

  stop() {
    super.stop();
    this.#stopWatchingSignIn();
  }

  #toItems(viewer) {
    const nodes = viewer?.assignedIssues?.nodes;
    if (!Array.isArray(nodes)) {
      return [];
    }
    const hidden = new Set(this.state.hiddenStates);
    return nodes.filter(issue => !hidden.has(linearStateType(issue.state))).map(issue => ({
      // Scoped to the provider type: a Linear issue id never collides
      // with a Jira or GitHub item id in the same folder manager.
      id: `linear:${issue.id}`,
      title: issue.title,
      subtitle: `${issue.identifier} · ${issue.state?.name || ""}`,
      icon: "chrome://browser/skin/zen-icons/selectable/ticket.svg",
      url: issue.url,
    }));
  }

  get options() {
    const hidden = new Set(this.state.hiddenStates);
    const options = [
      { l10nId: "whimsy-live-folder-linear-option-team", key: "team" },
      {
        l10nId: "whimsy-live-folder-option-statuses",
        key: "statuses",
        // Zen's submenu-of-checkboxes, like the GitHub folder's repo list.
        options: LINEAR_STATE_TYPES.map(type => ({
          l10nId: `whimsy-live-folder-linear-state-${type}`,
          key: "linearState",
          value: type,
          checked: !hidden.has(type),
        })),
      },
    ];
    // Only when the signed-in account has more than one workspace.
    const workspaces = this._workspaces || [];
    if (workspaces.length > 1) {
      const current = workspaces.some(w => w.id === this.state.workspace) ? this.state.workspace : "";
      options.push({
        l10nId: "whimsy-live-folder-linear-option-workspace",
        key: "workspace",
        options: [
          {
            l10nId: "whimsy-live-folder-linear-workspace-all",
            key: "linearWorkspace",
            value: "",
            type: "radio",
            checked: current === "",
          },
          ...workspaces.map(w => ({
            l10nId: "whimsy-live-folder-linear-workspace",
            l10nArgs: { name: w.name },
            key: "linearWorkspace",
            value: w.id,
            type: "radio",
            checked: current === w.id,
          })),
        ],
      });
    }
    // The API key is the advanced fallback: offered only once the session
    // path has failed, and removable whenever one is in use.
    if (this.state.lastErrorId === LINEAR_ERROR_SIGNED_OUT && !this._usingApiKey) {
      options.push({ l10nId: "whimsy-live-folder-linear-option-use-api-key", key: "linearApiKey" });
    }
    if (this._usingApiKey) {
      options.push({ l10nId: "whimsy-live-folder-linear-option-remove-api-key", key: "linearRemoveApiKey" });
    }
    return options;
  }

  // Shows or hides one workflow state type and refetches.
  toggleStateType(type) {
    if (!LINEAR_STATE_TYPES.includes(type)) {
      return;
    }
    const hidden = new Set(this.state.hiddenStates);
    if (hidden.has(type)) {
      hidden.delete(type);
    } else {
      hidden.add(type);
    }
    this.state.hiddenStates = LINEAR_STATE_TYPES.filter(t => hidden.has(t));
    this.requestSave();
    // Refetch so tabs of a newly hidden status leave the folder now.
    this.refresh().catch(e => console.error("Whimsy: Linear live folder refresh failed", e));
  }

  // Picks one workspace ("" = all of them) and refetches.
  setWorkspace(id) {
    this.state.workspace = typeof id === "string" ? id : "";
    this.requestSave();
    this.refresh().catch(e => console.error("Whimsy: Linear live folder refresh failed", e));
  }

  // "Sign in to Linear": linear.app's login page in this space's
  // container (its profile), so the session lands where the folder reads.
  openSignIn() {
    const window = this.manager.window;
    if (!window?.gBrowser) {
      return null;
    }
    const tab = window.gBrowser.addTrustedTab(this._signInUrl, {
      userContextId: whimsyLiveFolderUserContextId(this),
    });
    window.gBrowser.selectedTab = tab;
    this.#watchForSignIn();
    return tab;
  }

  async onOptionTrigger(option) {
    super.onOptionTrigger(option);

    const key = option.getAttribute("option-key");
    if (key === "linearState") {
      this.toggleStateType(option.getAttribute("option-value"));
      return;
    }
    if (key === "linearWorkspace") {
      this.setWorkspace(option.getAttribute("option-value") || "");
      return;
    }
    if (key === "linearApiKey") {
      const window = this.manager.window;
      if (window && (await WhimsyLinearLiveFolderProvider.promptForApiKey(window))) {
        this.refresh().catch(e => console.error("Whimsy: Linear live folder refresh failed", e));
      }
      return;
    }
    if (key === "linearRemoveApiKey") {
      await WhimsyLinearLiveFolderProvider.clearApiKey();
      this._usingApiKey = false;
      this.refresh().catch(e => console.error("Whimsy: Linear live folder refresh failed", e));
      return;
    }
    if (key !== "team") {
      return;
    }

    const window = this.manager.window;
    const [promptText] = await lazy.l10n.formatValues(["whimsy-live-folder-linear-prompt-team"]);
    const input = { value: this.state.team };
    if (window && Services.prompt.prompt(window, promptText, null, input, null, { value: null })) {
      this.state.team = (input.value || "").trim().toUpperCase();
      this.refresh();
    }

    this.requestSave();
  }

  async onActionButtonClick(errorId) {
    super.onActionButtonClick(errorId);

    if (errorId === LINEAR_ERROR_SIGNED_OUT) {
      this.openSignIn();
      return;
    }
    if (errorId === LINEAR_ERROR_RATE_LIMITED) {
      // Still inside Linear's window: nothing to do but wait; otherwise retry.
      if (this._rateLimitedUntil <= Date.now()) {
        this.refresh().catch(e => console.error("Whimsy: Linear live folder refresh failed", e));
      }
      return;
    }
    if (errorId !== LINEAR_ERROR_KEY_REJECTED) {
      return;
    }
    const window = this.manager.window;
    if (!window) {
      return;
    }
    const added = await WhimsyLinearLiveFolderProvider.promptForApiKey(window);
    if (added) {
      this.refresh();
    }
  }

  // The stored key lives in the login manager, not in any folder's own
  // state: one key covers every Linear live folder (and survives a
  // folder being removed and recreated).
  static async getApiKey() {
    try {
      await Services.logins.initializationPromise;
      const logins = await Services.logins.searchLoginsAsync({
        origin: LOGIN_ORIGIN,
        httpRealm: LOGIN_REALM,
      });
      return logins[0]?.password || null;
    } catch (e) {
      console.error("Whimsy: reading the stored Linear API key failed", e);
      return null;
    }
  }

  static async setApiKey(key) {
    const trimmed = (key || "").trim();
    if (!trimmed) {
      return false;
    }
    try {
      await Services.logins.initializationPromise;
      const LoginInfo = Components.Constructor(
        "@mozilla.org/login-manager/loginInfo;1",
        Ci.nsILoginInfo,
        "init"
      );
      const login = new LoginInfo(LOGIN_ORIGIN, null, LOGIN_REALM, LOGIN_USERNAME, trimmed, "", "");
      const existing = await Services.logins.searchLoginsAsync({
        origin: LOGIN_ORIGIN,
        httpRealm: LOGIN_REALM,
      });
      if (existing.length) {
        await Services.logins.modifyLoginAsync(existing[0], login);
      } else {
        await Services.logins.addLoginAsync(login);
      }
      return true;
    } catch (e) {
      console.error("Whimsy: saving the Linear API key failed", e);
      return false;
    }
  }

  static async clearApiKey() {
    try {
      await Services.logins.initializationPromise;
      const existing = await Services.logins.searchLoginsAsync({
        origin: LOGIN_ORIGIN,
        httpRealm: LOGIN_REALM,
      });
      for (const login of existing) {
        await Services.logins.removeLoginAsync(login);
      }
    } catch (e) {
      console.error("Whimsy: clearing the stored Linear API key failed", e);
    }
  }

  static async promptForApiKey(window) {
    const [title, text] = await lazy.l10n.formatValues([
      "whimsy-live-folder-linear-apikey-title",
      "whimsy-live-folder-linear-apikey-text",
    ]);
    const input = { value: "" };
    if (!Services.prompt.promptPassword(window, title, text, input)) {
      return false;
    }
    return WhimsyLinearLiveFolderProvider.setApiKey(input.value);
  }

  serialize() {
    return { state: this.state };
  }
}
