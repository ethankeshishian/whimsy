/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// Jira Cloud live folder: assigned, unresolved issues as a self-updating
// folder, the same "tabs that refresh themselves" model as Zen's GitHub
// live folder and Whimsy's GitHub review-requests folder, just a
// different tracker. Jira's REST API takes the browser's own session
// cookie (no API key), so a 401/403 means "not signed in to this Jira
// site", surfaced distinctly from a generic failed fetch.

const { WhimsyJiraLiveFolderProvider } = ChromeUtils.importESModule(
  "resource:///modules/whimsy/WhimsyJiraLiveFolder.sys.mjs"
);
const { WhimsyLiveFolders } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyLiveFolders.sys.mjs");

const SITE =
  getRootDirectory(gTestPath).replace("chrome://mochitests/content", "https://example.com") + "whimsy_jira.sjs";

// A minimal stand-in for the manager: no window, no real tab-group
// folder, so fetch() runs with userContextId 0 and nothing touches tab UI.
function makeFolder(extraState = {}) {
  const manager = {
    window: null,
    getFolderForLiveFolder: () => null,
    saveState: () => {},
  };
  const folder = new WhimsyJiraLiveFolderProvider({
    id: "test-jira",
    manager,
    state: { site: SITE, ...extraState },
  });
  const originalFetch = folder.fetch;
  folder.fetch = function (url, options) {
    const query = new URL(url).search;
    return originalFetch.call(this, SITE + query, options);
  };
  return folder;
}

add_task(async function test_main_flow() {
  const folder = makeFolder();
  const items = await folder.fetchItems();
  ok(Array.isArray(items), "Fetches an array of issues");
  is(items.length, 2, "Both fixture issues come back");
  is(items[0].title, "Fix the login bug", "Title comes from the issue's summary");
  is(items[0].subtitle, "In Progress", "Subtitle comes from the issue's status");
  ok(items[0].url.endsWith("/browse/ABC-1"), "The URL points at the issue");
});

add_task(async function test_no_auth() {
  const folder = makeFolder({ jql: "unauth" });
  const result = await folder.fetchItems();
  is(result, "whimsy-live-folder-jira-no-auth", "A 401 surfaces the no-auth error id, not a generic failed fetch");
});

add_task(async function test_no_site_configured() {
  const folder = makeFolder();
  folder.state.site = "";
  const result = await folder.fetchItems();
  is(result, "whimsy-live-folder-jira-no-site", "No site configured surfaces its own error id");
});

add_task(async function test_two_sites_dont_cross_contaminate() {
  const a = makeFolder();
  const b = makeFolder({ jql: "unauth" });
  const [itemsA, itemsB] = await Promise.all([a.fetchItems(), b.fetchItems()]);
  ok(Array.isArray(itemsA) && itemsA.length === 2, "The first folder's own state fetches normally");
  is(itemsB, "whimsy-live-folder-jira-no-auth", "The second folder's own state still fails on its own terms");
});

add_task(async function test_switch_off() {
  await SpecialPowers.pushPrefEnv({ set: [["whimsy.feature.live-folders-jira", false]] });
  ok(!WhimsyLiveFolders.jiraEnabled, "The feature switch is off");
  await SpecialPowers.popPrefEnv();
  ok(WhimsyLiveFolders.jiraEnabled, "and back on by default");
});
