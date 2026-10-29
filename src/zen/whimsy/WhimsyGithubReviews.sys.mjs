/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// GitHub pull-request live folders: a "My Review Requests" option, for pull
// requests where a review was requested from you directly
// (user-review-requested:@me). Zen's "Review Requests" also matches requests
// sent to any team you're on, and stays as Zen ships it.
//
// This mirrors Zen's open PR zen-browser/desktop#16183, same option key
// (myReviewRequests) and query, so when Zen ships it, whimsy/overlay.py turns
// this off and the folder's setting carries over to Zen's own option.
// Whimsy runs the search through the provider's own parsePullRequests and
// merges the results into Zen's. Zen's code is wrapped, not edited.

export const MY_REVIEW_QUERY = "user-review-requested:@me";
const KEY = "myReviewRequests";

export const WhimsyGithubReviews = {
  init() {
    if (this._initialized) {
      return;
    }
    this._initialized = true;
    const { nsGithubLiveFolderProvider } = ChromeUtils.importESModule(
      "resource:///modules/zen/GithubLiveFolder.sys.mjs"
    );
    this.wrap(nsGithubLiveFolderProvider.prototype);
  },

  get enabled() {
    return Services.prefs.getBoolPref("whimsy.feature.github-reviews", true);
  },

  // The search Zen uses for every query, plus the review qualifier.
  query(state) {
    const parts = ["is:pr", "is:open", "archived:false", "sort:updated-desc"];
    if (!(state.options.includeDrafts ?? true)) {
      parts.push("draft:false");
    }
    for (const repo of state.options.repoExcludes ?? []) {
      if (repo?.trim()) {
        parts.push(`-repo:${repo.trim()}`);
      }
    }
    return `${parts.join(" ")} ${MY_REVIEW_QUERY}`;
  },

  wrap(proto) {
    const optionsGetter = Object.getOwnPropertyDescriptor(proto, "options")?.get;
    const fetchItems = proto.fetchItems;
    if (!optionsGetter || typeof fetchItems != "function" || fetchItems.whimsyWrapped) {
      return;
    }

    Object.defineProperty(proto, "options", {
      configurable: true,
      get() {
        const options = optionsGetter.call(this);
        const index = options.findIndex(option => option.key == "reviewRequested");
        if (!WhimsyGithubReviews.enabled || index < 0 || options.some(o => o.key == KEY)) {
          return options;
        }
        options.splice(index + 1, 0, {
          l10nId: "whimsy-live-folder-github-option-my-review-requests",
          key: KEY,
          checked: this.state.options[KEY] ?? false,
          hidden: this.state.type === "issues",
        });
        return options;
      },
    });

    proto.fetchItems = async function (...args) {
      const options = this.state?.options;
      if (this.state?.type !== "pull-requests" || !(options?.[KEY] ?? false) || !WhimsyGithubReviews.enabled) {
        return fetchItems.apply(this, args);
      }

      // Zen's own search for its options. With none of them on, Zen would
      // refuse to fetch, so let it run "assigned" just to settle the page
      // format, and drop those results.
      const zenFilters =
        (options.authorMe ?? false) || (options.assignedMe ?? true) || (options.reviewRequested ?? false);
      let items;
      if (zenFilters) {
        items = await fetchItems.apply(this, args);
      } else {
        try {
          this.state.options = { ...options, assignedMe: true };
          items = await fetchItems.apply(this, args);
        } finally {
          this.state.options = options;
        }
      }
      if (!Array.isArray(items)) {
        return items; // Zen's error id: no auth, failed fetch...
      }

      const merged = new Map((zenFilters ? items : []).map(item => [item.id, item]));
      const repos = new Set(zenFilters ? (this.state.repos ?? []) : []);
      const url = new URL(this.state.url);
      url.searchParams.set("q", WhimsyGithubReviews.query(this.state));
      const { status, items: found, activeRepos } = await this.parsePullRequests(url.href);
      if (status === 404) {
        return "zen-live-folder-github-no-auth";
      }
      if (status !== 200) {
        return "zen-live-folder-failed-fetch";
      }
      for (const item of found ?? []) {
        merged.set(item.id, item);
      }
      for (const repo of activeRepos ?? []) {
        repos.add(repo);
      }
      this.state.repos = repos;
      return Array.from(merged.values());
    };
    proto.fetchItems.whimsyWrapped = true;
  },
};
