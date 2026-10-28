/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// GitHub pull-request live folders: the user's own pull requests say "Yours"
// (in the accent color, see whimsy-browser.css); everyone else's show their
// author. GitHub alone knows who is signed in, so after Zen's fetch this asks
// Zen's own fetch again for just the user's pull requests (author:@me), then
// marks those. Zen's code is wrapped, not edited.

export const GITHUB_MINE_SUBTITLE = "Yours";

export const WhimsyGithubMine = {
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

  wrap(proto) {
    const original = proto.fetchItems;
    if (typeof original != "function" || original.whimsyWrapped) {
      return;
    }
    proto.fetchItems = async function (...args) {
      const items = await original.apply(this, args);
      if (
        this.state?.type !== "pull-requests" ||
        !Array.isArray(items) ||
        !items.length ||
        !Services.prefs.getBoolPref("whimsy.feature.github-mine", true)
      ) {
        return items;
      }
      const { options, repos } = this.state;
      try {
        this.state.options = {
          ...options,
          authorMe: true,
          assignedMe: false,
          reviewRequested: false,
        };
        const mine = await original.apply(this, args);
        if (Array.isArray(mine)) {
          const mineIds = new Set(mine.map(item => item.id));
          for (const item of items) {
            if (mineIds.has(item.id)) {
              item.subtitle = GITHUB_MINE_SUBTITLE;
            }
          }
        }
      } catch (e) {
        console.error("Whimsy: couldn't mark your pull requests", e);
      } finally {
        this.state.options = options;
        this.state.repos = repos;
      }
      return items;
    };
    proto.fetchItems.whimsyWrapped = true;
  },
};
