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

function normalizeSite(site) {
  return (site || "").trim().replace(/\/+$/, "");
}

export class WhimsyJiraLiveFolderProvider extends nsZenLiveFolderProvider {
  static type = "jira";

  constructor({ id, state, manager }) {
    super({ id, state, manager });
    this.state.site = normalizeSite(state.site);
    this.state.jql = state.jql || DEFAULT_JQL;
  }

  async fetchItems() {
    const site = normalizeSite(this.state.site);
    if (!site) {
      return "whimsy-live-folder-jira-no-site";
    }
    try {
      const url = new URL(`${site}/rest/api/2/search`);
      url.searchParams.set("jql", this.state.jql || DEFAULT_JQL);
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

      const issues = Array.isArray(data?.issues) ? data.issues : [];
      return issues.map(issue => ({
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
    return [
      { l10nId: "whimsy-live-folder-jira-option-site", key: "site" },
      { l10nId: "whimsy-live-folder-jira-option-jql", key: "jql" },
    ];
  }

  async onOptionTrigger(option) {
    super.onOptionTrigger(option);

    const key = option.getAttribute("option-key");
    if (!this.options.some(x => x.key === key)) {
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
