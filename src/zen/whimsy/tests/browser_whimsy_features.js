/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// Whimsy's overlay wiring: the startup hook ran, feature switches exist, and
// the features that wrap Zen code behave.

const { Whimsy } = ChromeUtils.importESModule("resource:///modules/whimsy/Whimsy.sys.mjs");
const { WhimsyGithubReviews, MY_REVIEW_QUERY } = ChromeUtils.importESModule(
  "resource:///modules/whimsy/WhimsyGithubReviews.sys.mjs"
);

add_task(async function test_startup_hook_ran() {
  ok(
    document.documentElement.hasAttribute("whimsy-ui-zoom"),
    "Zen's startup called Whimsy.initWindow for this window"
  );
  for (const id of ["ctrl-tab", "ui-zoom", "app-icon", "github-reviews"]) {
    ok(Whimsy.featureEnabled(id), `whimsy.feature.${id} is on (Zen doesn't ship it)`);
  }
});

add_task(async function test_ui_zoom_scales_chrome_only() {
  await SpecialPowers.pushPrefEnv({ set: [["whimsy.ui-zoom", 150]] });
  await TestUtils.waitForCondition(
    () => getComputedStyle(document.getElementById("navigator-toolbox")).zoom == "1.5",
    "The sidebar is zoomed to 150%"
  );
  is(getComputedStyle(gBrowser.selectedBrowser).zoom, "1", "Web pages aren't zoomed");
  await SpecialPowers.popPrefEnv();
  await TestUtils.waitForCondition(
    () => getComputedStyle(document.getElementById("navigator-toolbox")).zoom == "1",
    "Back to 100%"
  );
});

// A stand-in for Zen's GitHub provider: its options menu, its fetch (which
// runs Zen's team-inclusive "review-requested:@me" for Review Requests), and
// the search the wrapper uses.
function fakeProvider(options) {
  const queries = [];
  const proto = {
    get options() {
      return [
        { key: "authorMe", checked: false },
        { key: "assignedMe", checked: true },
        { l10nId: "zen-live-folder-github-option-review-requested", key: "reviewRequested", checked: false },
        { key: "includeDrafts", checked: true },
      ];
    },
    async fetchItems() {
      const o = this.state.options;
      if (!(o.authorMe ?? false) && !(o.assignedMe ?? true) && !(o.reviewRequested ?? false)) {
        return "zen-live-folder-github-no-filter";
      }
      if (o.reviewRequested) {
        queries.push("review-requested:@me");
      }
      this.state.repos = new Set(["zen"]);
      return [{ id: "z#1" }];
    },
    async parsePullRequests(url) {
      queries.push(new URL(url).searchParams.get("q"));
      return { status: 200, items: [{ id: "m#2" }], activeRepos: new Set(["mine"]) };
    },
  };
  WhimsyGithubReviews.wrap(proto);
  const provider = Object.create(proto);
  provider.state = {
    type: "pull-requests",
    url: "https://github.com/pulls",
    options: { repoExcludes: new Set(["x/skip"]), ...options },
    repos: new Set(),
  };
  return { provider, queries };
}

add_task(async function test_my_review_requests_option() {
  const { provider } = fakeProvider({ myReviewRequests: true });
  Assert.deepEqual(
    provider.options.map(o => o.key),
    ["authorMe", "assignedMe", "reviewRequested", "myReviewRequests", "includeDrafts"],
    "My Review Requests sits right after Zen's Review Requests"
  );
  const mine = provider.options[3];
  ok(mine.checked, "It reflects the folder's setting");
  is(provider.options[2].l10nId, "zen-live-folder-github-option-review-requested", "Zen's option is untouched");
  const [label] = await document.l10n.formatMessages([{ id: mine.l10nId }]);
  is(label.attributes[0].value, "My Review Requests", "Labelled like Zen's PR");
});

add_task(async function test_my_review_requests_queries() {
  // My Review Requests alongside Zen's options.
  let { provider, queries } = fakeProvider({ myReviewRequests: true, reviewRequested: true });
  let items = await provider.fetchItems();
  ok(queries.includes("review-requested:@me"), "Zen's Review Requests still runs");
  ok(queries.some(q => q.endsWith(MY_REVIEW_QUERY) && q.includes("-repo:x/skip") && q.includes("is:pr")),
    "Plus user-review-requested:@me, with the folder's filters");
  Assert.deepEqual(items.map(i => i.id).sort(), ["m#2", "z#1"], "Results merged");

  // Only My Review Requests, every Zen option off.
  ({ provider, queries } = fakeProvider({ assignedMe: false, myReviewRequests: true }));
  items = await provider.fetchItems();
  Assert.deepEqual(items.map(i => i.id), ["m#2"], "Only reviews requested from you");
  ok(!provider.state.repos.has("zen"), "The helper fetch's repositories are dropped");
  is(provider.state.options.assignedMe, false, "The folder's options are restored");

  // Off: Zen's behavior, untouched.
  ({ provider, queries } = fakeProvider({}));
  items = await provider.fetchItems();
  Assert.deepEqual(items.map(i => i.id), ["z#1"], "Zen's fetch runs as is");
  is(queries.length, 0, "No extra searches");
});
