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
  for (const id of [
    "ctrl-tab",
    "ui-zoom",
    "app-icon",
    "github-reviews",
    "peek-essential-links",
    "glance-split-action",
    "external-link-target",
    "split-link-click",
    "split-close-other-panes",
    "split-swap-panes",
    "split-command-bar",
    "command-bar-slash",
    "command-bar-create",
  ]) {
    ok(Whimsy.featureEnabled(id), `whimsy.feature.${id} is on (Zen doesn't ship it)`);
  }
});

// W23: every AI-wave feature has its switch, on by default (Zen ships none
// of them). browser.toml turns some off for tests (ai-related), so this reads
// the shipped default rather than the test run's value.
const W23_FEATURES = [
  "ai-chat", "ai-ask", "ai-updates", "ai-context-commands", "ai-selection-commands", "ai-commands",
  "ai-related", "ai-memory", "ai-agent", "ai-task-folder", "ai-outside-agents", "ai-activity",
  "ai-connectors", "ai-onboarding", "ai-hints", "ai-summary", "ai-draft-reply", "ai-form-fill",
  "ai-translate", "ai-page-edits", "ai-scam-warning", "ai-compare", "ai-tab-requests", "find-card",
  "ai-video-summary", "video-speed-range", "video-default-speed", "image-text", "read-aloud",
  "dictation", "media-settings", "routines", "link-previews", "ask-on-page", "page-watch",
  "claude-replay", "ai-providers",
];

add_task(async function test_w23_feature_switches() {
  for (const id of W23_FEATURES) {
    ok(Services.prefs.getPrefType(`whimsy.feature.${id}`) == Services.prefs.PREF_BOOL, `whimsy.feature.${id} exists`);
    ok(Services.prefs.getDefaultBranch("").getBoolPref(`whimsy.feature.${id}`), `whimsy.feature.${id} is on`);
  }
});

// W23: the icon set later lanes use for commands and chips.
const W23_ICONS = [
  "agent", "apple", "background", "brain", "chat", "chat-hide", "claude", "clock", "compare", "drive",
  "eye", "fire-settings", "gemini", "gmail", "google", "google-calendar", "google-drive",
  "granola", "hand", "ibeam", "image-chip", "image-text", "jira", "linear", "listen", "mask",
  "mcp", "memory", "mic", "microsoft", "onedrive", "openai", "outlook", "pause", "pdf", "pip",
  "remind", "routines", "scam", "split-pane", "stop", "summarize", "tabs-all", "updates", "task-folder",
  "text-chip", "thinking", "uturn-backward", "video-chip",
];

add_task(async function icons_exist() {
  for (const name of W23_ICONS) {
    const url = `chrome://browser/content/whimsy/icons/${name}.svg`;
    const response = await fetch(url);
    ok(response.ok, `${url} loads`);
    ok((await response.text()).includes("<svg"), `${name}.svg is an SVG`);
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

add_task(async function test_options_match_zen_pr_16183() {
  const { provider } = fakeProvider({});
  Assert.deepEqual(
    provider.options.map(o => o.key),
    ["authorMe", "assignedMe", "myReviewRequests", "reviewRequested", "includeDrafts"],
    "Assigned to Me kept; My Review Requests, then Team Review Requests"
  );
  const [mine, team] = provider.options.slice(2, 4);
  ok(!mine.checked, "My Review Requests is off by default, as in the PR");
  ok(!team.checked, "Team Review Requests keeps Zen's default (off)");
  const [mineLabel, teamLabel] = await document.l10n.formatMessages([{ id: mine.l10nId }, { id: team.l10nId }]);
  is(mineLabel.attributes[0].value, "My Review Requests", "Named as agreed");
  is(teamLabel.attributes[0].value, "Team Review Requests", "Zen's option renamed as agreed");

  const issues = fakeProvider({});
  issues.provider.state.type = "issues";
  ok(issues.provider.options.some(o => o.key == "assignedMe"), "Issue folders keep Assigned to Me");
});

add_task(async function test_review_queries() {
  // Default: Zen's Assigned to Me, nothing extra.
  let { provider, queries } = fakeProvider({});
  let items = await provider.fetchItems();
  Assert.deepEqual(items.map(i => i.id), ["z#1"], "Zen's default fetch");
  is(queries.length, 0, "No extra search by default");

  // My Review Requests alone: Zen's fetch only settles the page format.
  ({ provider, queries } = fakeProvider({ assignedMe: false, myReviewRequests: true }));
  items = await provider.fetchItems();
  Assert.deepEqual(items.map(i => i.id), ["m#2"], "Only reviews requested from you");
  ok(queries.some(q => q.endsWith(MY_REVIEW_QUERY) && q.includes("-repo:x/skip") && q.includes("is:pr")),
    "user-review-requested:@me, with the folder's filters");
  ok(!provider.state.repos.has("zen"), "The helper fetch's repositories are dropped");

  // With Team Review Requests too: Zen's team-inclusive search runs as well.
  ({ provider, queries } = fakeProvider({ assignedMe: false, myReviewRequests: true, reviewRequested: true }));
  items = await provider.fetchItems();
  ok(queries.includes("review-requested:@me"), "Team Review Requests runs Zen's query");
  Assert.deepEqual(items.map(i => i.id).sort(), ["m#2", "z#1"], "Results merged");
  ok(provider.state.options.assignedMe === false, "The folder's options are restored");

  // Everything off: Zen's no-filter message.
  ({ provider, queries } = fakeProvider({ assignedMe: false }));
  is(await provider.fetchItems(), "zen-live-folder-github-no-filter", "No filters, no fetch");

  // Issue folders: Zen's behavior, untouched.
  ({ provider, queries } = fakeProvider({ myReviewRequests: true }));
  provider.state.type = "issues";
  items = await provider.fetchItems();
  Assert.deepEqual(items.map(i => i.id), ["z#1"], "Zen's fetch runs as is");
  is(queries.length, 0, "No extra searches");
});
