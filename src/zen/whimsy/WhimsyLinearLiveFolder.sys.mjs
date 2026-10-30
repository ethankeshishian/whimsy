/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Linear live folder: "My Issues" (assigned to you, open states) as a
// self-updating folder of tabs, the same "always current" model as Zen's
// GitHub live folder and Whimsy's Jira folder. Unlike Jira/GitHub, which
// take the browser's own session cookie straight to a GET, Linear's
// GraphQL API (https://api.linear.app/graphql) is a single POST endpoint
// that every client -- including linear.app's own web app -- calls with
// an explicit Authorization header; there's no public documentation of a
// cookie/session path to it (see the commit body). This still tries the
// signed-in linear.app session first, exactly as asked: a credentialed
// POST with no Authorization header, the same cookie-scoped request
// nsZenLiveFolderProvider's own fetch() sends for Jira and GitHub. When
// that comes back unauthenticated, it falls back to a personal API key
// the user pastes once, stored in the login manager (origin
// https://api.linear.app), sent as `Authorization: <key>` from then on.
//
// Registered into Zen's live-folder registry by WhimsyLiveFolders.sys.mjs;
// Zen's ZenLiveFolder.sys.mjs (the base class) is read, never edited.

import { nsZenLiveFolderProvider } from "resource:///modules/zen/ZenLiveFolder.sys.mjs";
import { whimsyPostFetch } from "resource:///modules/whimsy/WhimsyLiveFolderFetch.sys.mjs";

const lazy = {};
ChromeUtils.defineLazyGetter(lazy, "l10n", () => new Localization(["browser/whimsy.ftl"]));
ChromeUtils.defineESModuleGetters(lazy, {
  WhimsyPanels: "resource:///modules/whimsy/WhimsyPanels.sys.mjs",
});

const GRAPHQL_URL = "https://api.linear.app/graphql";
const LOGIN_ORIGIN = "https://api.linear.app";
const LOGIN_REALM = "Whimsy Linear API key";
const LOGIN_USERNAME = "linear-api-key";

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

// A GraphQL endpoint answers unauthenticated requests with HTTP 200 and
// an "errors" array (no "data"), not necessarily a 401 -- so "no viewer
// came back" is what actually means "not authenticated", regardless of
// the HTTP status.
function viewerFrom(data) {
  return data && !data.errors ? data.data?.viewer : null;
}

export class WhimsyLinearLiveFolderProvider extends nsZenLiveFolderProvider {
  static type = "linear";

  constructor({ id, state, manager, graphqlUrl }) {
    super({ id, state, manager });
    this.state.team = (state.team || "").trim().toUpperCase();
    // Saved folders from before the Statuses menu get the defaults.
    this.state.hiddenStates = Array.isArray(state.hiddenStates)
      ? state.hiddenStates.filter(t => typeof t === "string")
      : [...LINEAR_DEFAULT_HIDDEN];
    // Test-only: lets a test fixture stand in for Linear's real GraphQL
    // endpoint. Deliberately not part of `this.state`, so it's never
    // persisted (see serialize()).
    this._graphqlUrl = graphqlUrl || GRAPHQL_URL;
  }

  async #query(headers) {
    const body = JSON.stringify({
      query: MY_ISSUES_QUERY,
      variables: { filter: buildFilter(this.state.team, this.state.hiddenStates) },
    });
    const { text, status } = await whimsyPostFetch(this, this._graphqlUrl, {
      body,
      headers: { Accept: "application/json", ...headers },
    });
    if (status !== 200) {
      return { status, data: null };
    }
    try {
      return { status, data: JSON.parse(text) };
    } catch {
      return { status, data: null };
    }
  }

  async fetchItems() {
    try {
      // 1) The signed-in linear.app session: no Authorization header,
      // just the cookie-scoped request nsZenLiveFolderProvider's fetch()
      // already sends for Jira and GitHub.
      const session = await this.#query({});
      const sessionViewer = viewerFrom(session.data);
      if (sessionViewer) {
        return this.#toItems(sessionViewer);
      }

      // 2) No session: fall back to a pasted personal API key.
      const apiKey = await WhimsyLinearLiveFolderProvider.getApiKey();
      if (!apiKey) {
        return "whimsy-live-folder-linear-no-auth";
      }

      const keyed = await this.#query({ Authorization: apiKey });
      const keyedViewer = viewerFrom(keyed.data);
      if (keyedViewer) {
        return this.#toItems(keyedViewer);
      }
      if (keyed.status === 200) {
        // A clean response with no viewer and no network problem means
        // the stored key itself is being rejected, not a transient glitch.
        return "whimsy-live-folder-linear-no-auth";
      }
      return "zen-live-folder-failed-fetch";
    } catch (e) {
      console.error("Whimsy: Linear live folder fetch failed", e);
      return "zen-live-folder-failed-fetch";
    }
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
    return [
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

  async onOptionTrigger(option) {
    super.onOptionTrigger(option);

    const key = option.getAttribute("option-key");
    if (key === "linearState") {
      this.toggleStateType(option.getAttribute("option-value"));
      return;
    }
    if (key !== "team") {
      return;
    }

    const window = this.manager.window;
    const [promptText] = await lazy.l10n.formatValues(["whimsy-live-folder-linear-prompt-team"]);
    const value = window && await lazy.WhimsyPanels.ask(window, { title: promptText, value: this.state.team });
    if (typeof value == "string") {
      this.state.team = value.trim().toUpperCase();
      this.refresh();
    }

    this.requestSave();
  }

  async onActionButtonClick(errorId) {
    super.onActionButtonClick(errorId);

    if (errorId !== "whimsy-live-folder-linear-no-auth") {
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
    const key = await lazy.WhimsyPanels.ask(window, { title, body: text, password: true });
    if (key === null) {
      return false;
    }
    return WhimsyLinearLiveFolderProvider.setApiKey(key);
  }

  serialize() {
    return { state: this.state };
  }
}
