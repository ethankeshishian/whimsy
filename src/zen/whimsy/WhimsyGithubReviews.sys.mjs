/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// GitHub pull-request live folders, following Zen's PR zen-browser/desktop#16183:
//   My Review Requests    user-review-requested:@me, new (key myReviewRequests),
//                         off by default as in the PR
//   Team Review Requests  Zen's "Review Requests" (review-requested:@me, which
//                         includes your teams), renamed as the maintainer
//                         suggested; same key
//   Assigned to Me        kept: dropping it was floated, never agreed
// Same keys and query as Zen's PR, so when Zen ships it, whimsy/overlay.py
// turns this off and the folders' settings carry over. Whimsy runs its search
// through the provider's own parsePullRequests and merges the results into
// Zen's. Zen's code is wrapped, not edited.

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

  applies(provider) {
    return this.enabled && provider.state?.type === "pull-requests";
  },

  wantsMine(options) {
    return options?.[KEY] ?? false;
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
        if (!WhimsyGithubReviews.applies(this) || options.some(o => o.key == KEY)) {
          return options;
        }
        const index = options.findIndex(option => option.key == "reviewRequested");
        if (index < 0) {
          return options;
        }
        options.splice(
          index,
          1,
          {
            l10nId: "whimsy-live-folder-github-option-my-review-requests",
            key: KEY,
            checked: WhimsyGithubReviews.wantsMine(this.state.options),
          },
          { ...options[index], l10nId: "whimsy-live-folder-github-option-team-review-requests" }
        );
        return options;
      },
    });

    proto.fetchItems = async function (...args) {
      if (!WhimsyGithubReviews.applies(this)) {
        return fetchItems.apply(this, args);
      }
      const options = this.state.options;
      const mine = WhimsyGithubReviews.wantsMine(options);
      // Zen's search for its own options. With none on, Zen would refuse to
      // fetch, so let it run "assigned" just to settle the page format, and
      // drop those results.
      const zenFilters =
        (options.authorMe ?? false) || (options.assignedMe ?? true) || (options.reviewRequested ?? false);
      if (!zenFilters && !mine) {
        return "zen-live-folder-github-no-filter";
      }
      let items;
      try {
        if (!zenFilters) {
          this.state.options = { ...options, assignedMe: true };
        }
        items = await fetchItems.apply(this, args);
      } finally {
        this.state.options = options;
      }
      if (!Array.isArray(items)) {
        return items; // Zen's error id: no auth, failed fetch...
      }
      if (!mine) {
        return items;
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
