/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Jira Cloud live folder: assigned, unresolved issues as a self-updating
// folder of tabs, the same "always current" model as Zen's GitHub live
// folder (zen-browser/desktop#16183) and Whimsy's GitHub review-requests
// folder, just a different tracker. Jira Cloud's REST API
// (`/rest/api/2/search`) accepts the browser's own session cookie for GET
// requests from first-party contexts -- the same way Jira's own web UI
// calls it -- so this needs no API key: whoever is signed in to that Jira
// site in the folder's own space (container) is who it fetches as, exactly
// like the existing GitHub provider's cookie-scoped fetch().
//
// Registered into Zen's live-folder registry by WhimsyLiveFolders.sys.mjs;
// Zen's ZenLiveFolder.sys.mjs (the base class) is read, never edited.

import { nsZenLiveFolderProvider } from "resource:///modules/zen/ZenLiveFolder.sys.mjs";

const lazy = {};
ChromeUtils.defineLazyGetter(lazy, "l10n", () => new Localization(["browser/whimsy.ftl"]));

export const DEFAULT_JQL = "assignee = currentUser() AND resolution = Unresolved";

// Jira's status categories -- the fixed buckets every site's own statuses
// map to (statusCategory.key in the REST API: "new" is To Do,
// "indeterminate" is In Progress, "done" is Done, "undefined" is No
// Category). Each is a show/hide toggle in the folder's Statuses menu;
// Done is hidden by default. JQL takes the category ids, which, unlike
// the names, aren't translated.
export const JIRA_STATUS_CATEGORIES = ["new", "indeterminate", "done", "undefined"];
export const JIRA_DEFAULT_HIDDEN = ["done"];
const JIRA_CATEGORY_IDS = { undefined: 1, new: 2, done: 3, indeterminate: 4 };

// With the default query the status filter goes into the JQL, so hidden
// issues don't use up the page and showing Done really brings them back
// (the old default's "resolution = Unresolved" would keep them out). A
// custom query is left as written and filtered client-side.
export function jiraQuery(jql, hidden) {
  if (jql && jql !== DEFAULT_JQL) {
    return jql;
  }
  const clauses = ["assignee = currentUser()"];
  const ids = hidden.map(key => JIRA_CATEGORY_IDS[key]).filter(Boolean);
  if (ids.length) {
    clauses.push(`statusCategory not in (${ids.join(", ")})`);
  }
  return `${clauses.join(" AND ")} ORDER BY updated DESC`;
}

function normalizeSite(site) {
  return (site || "").trim().replace(/\/+$/, "");
}

export class WhimsyJiraLiveFolderProvider extends nsZenLiveFolderProvider {
  static type = "jira";

  constructor({ id, state, manager }) {
    super({ id, state, manager });
    this.state.site = normalizeSite(state.site);
    this.state.jql = state.jql || DEFAULT_JQL;
    this.state.hiddenCategories = Array.isArray(state.hiddenCategories)
      ? state.hiddenCategories.filter(k => typeof k === "string")
      : [...JIRA_DEFAULT_HIDDEN];
  }

  async fetchItems() {
    const site = normalizeSite(this.state.site);
    if (!site) {
      return "whimsy-live-folder-jira-no-site";
    }
    try {
      const url = new URL(`${site}/rest/api/2/search`);
      url.searchParams.set("jql", jiraQuery(this.state.jql, this.state.hiddenCategories));
      url.searchParams.set("fields", "summary,status");

      const { text, status } = await this.fetch(url.href, {
        headers: { Accept: "application/json" },
      });

      if (status === 401 || status === 403) {
        return "whimsy-live-folder-jira-no-auth";
      }
      if (status !== 200) {
        return "zen-live-folder-failed-fetch";
      }

      let data;
      try {
        data = JSON.parse(text);
      } catch {
        return "zen-live-folder-failed-fetch";
      }

      const hidden = new Set(this.state.hiddenCategories);
      const issues = Array.isArray(data?.issues) ? data.issues : [];
      return issues
        .filter(issue => !hidden.has(issue.fields?.status?.statusCategory?.key))
        .map(issue => ({
          // Scoped by site: two folders for two Jira sites never collide.
          id: `${site}:${issue.key}`,
          title: issue.fields?.summary || issue.key,
          subtitle: issue.fields?.status?.name,
          icon: "chrome://browser/skin/zen-icons/selectable/ticket.svg",
          url: `${site}/browse/${issue.key}`,
        }));
    } catch (e) {
      console.error("Whimsy: Jira live folder fetch failed", e);
      return "zen-live-folder-failed-fetch";
    }
  }

  get options() {
    const hidden = new Set(this.state.hiddenCategories);
    return [
      { l10nId: "whimsy-live-folder-jira-option-site", key: "site" },
      { l10nId: "whimsy-live-folder-jira-option-jql", key: "jql" },
      {
        l10nId: "whimsy-live-folder-option-statuses",
        key: "statuses",
        options: JIRA_STATUS_CATEGORIES.map(category => ({
          l10nId: `whimsy-live-folder-jira-category-${category}`,
          key: "jiraCategory",
          value: category,
          checked: !hidden.has(category),
        })),
      },
    ];
  }

  // Shows or hides one status category and refetches.
  toggleCategory(category) {
    if (!JIRA_STATUS_CATEGORIES.includes(category)) {
      return;
    }
    const hidden = new Set(this.state.hiddenCategories);
    if (hidden.has(category)) {
      hidden.delete(category);
    } else {
      hidden.add(category);
    }
    this.state.hiddenCategories = JIRA_STATUS_CATEGORIES.filter(k => hidden.has(k));
    this.requestSave();
    this.refresh().catch(e => console.error("Whimsy: Jira live folder refresh failed", e));
  }

  async onOptionTrigger(option) {
    super.onOptionTrigger(option);

    const key = option.getAttribute("option-key");
    if (key === "jiraCategory") {
      this.toggleCategory(option.getAttribute("option-value"));
      return;
    }
    if (key !== "site" && key !== "jql") {
      return;
    }

    const window = this.manager.window;
    if (key === "site") {
      const [promptText] = await lazy.l10n.formatValues(["whimsy-live-folder-jira-prompt-site"]);
      const input = { value: this.state.site };
      if (window && Services.prompt.prompt(window, promptText, null, input, null, { value: null })) {
        this.state.site = normalizeSite(input.value);
        this.refresh();
      }
    } else if (key === "jql") {
      const [promptText] = await lazy.l10n.formatValues(["whimsy-live-folder-jira-prompt-jql"]);
      const input = { value: this.state.jql };
      if (window && Services.prompt.prompt(window, promptText, null, input, null, { value: null })) {
        this.state.jql = input.value?.trim() || DEFAULT_JQL;
        this.refresh();
      }
    }

    this.requestSave();
  }

  async onActionButtonClick(errorId) {
    super.onActionButtonClick(errorId);

    if (errorId === "whimsy-live-folder-jira-no-auth" && this.state.site && this.manager.window) {
      const tab = this.manager.window.gBrowser.addTrustedTab(this.state.site);
      this.manager.window.gBrowser.selectedTab = tab;
    }
  }

  // Asked once, when the folder is created.
  static async promptForSite(window, initialSite = "") {
    const [promptText] = await lazy.l10n.formatValues(["whimsy-live-folder-jira-prompt-site"]);
    const input = { value: initialSite };
    if (!Services.prompt.prompt(window, promptText, null, input, null, { value: null })) {
      return null;
    }
    return normalizeSite(input.value) || null;
  }

  serialize() {
    return { state: this.state };
  }
}
