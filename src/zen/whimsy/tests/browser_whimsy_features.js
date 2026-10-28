/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// Whimsy's overlay wiring: the startup hook ran, feature switches exist, and
// the features that wrap Zen code behave.

const { Whimsy } = ChromeUtils.importESModule("resource:///modules/whimsy/Whimsy.sys.mjs");
const { WhimsyGithubMine, GITHUB_MINE_SUBTITLE } = ChromeUtils.importESModule(
  "resource:///modules/whimsy/WhimsyGithubMine.sys.mjs"
);

add_task(async function test_startup_hook_ran() {
  ok(
    document.documentElement.hasAttribute("whimsy-ui-zoom"),
    "Zen's startup called Whimsy.initWindow for this window"
  );
  for (const id of ["ctrl-tab", "ui-zoom", "app-icon", "github-mine"]) {
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

add_task(async function test_github_mine_marks_your_pull_requests() {
  // A stand-in for Zen's provider: returns the user's own PRs when only
  // authorMe is on, everyone's otherwise.
  const proto = {
    async fetchItems() {
      const mineOnly = this.state.options.authorMe && !this.state.options.assignedMe;
      this.state.repos = new Set([mineOnly ? "mine-only" : "everyone"]);
      return mineOnly ? [{ id: 2 }] : [{ id: 1, subtitle: "teammate" }, { id: 2, subtitle: "me" }];
    },
  };
  WhimsyGithubMine.wrap(proto);
  WhimsyGithubMine.wrap(proto);
  ok(proto.fetchItems.whimsyWrapped, "Wrapped once");

  const options = { assignedMe: true, reviewRequested: true, authorMe: false };
  const repos = new Set(["original"]);
  const provider = Object.create(proto);
  provider.state = { type: "pull-requests", options, repos };
  const items = await provider.fetchItems();
  is(items.find(i => i.id == 2).subtitle, GITHUB_MINE_SUBTITLE, "Your pull request says Yours");
  is(items.find(i => i.id == 1).subtitle, "teammate", "A teammate's keeps its author");
  is(provider.state.options, options, "The folder's filters are restored");
  ok(provider.state.repos.has("everyone"), "The folder keeps the repositories from Zen's own fetch");

  provider.state = { type: "issues", options, repos };
  const issues = await provider.fetchItems();
  is(issues.find(i => i.id == 2).subtitle, "me", "Issues aren't touched");
});
