/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// Jira Cloud live folder: assigned, unresolved issues as a self-updating
// folder, the same "tabs that refresh themselves" model as Zen's GitHub
// live folder and Whimsy's GitHub review-requests folder, just a
// different tracker. Jira's REST API takes the browser's own session
// cookie (no API key), so a 401/403 means "not signed in to this Jira
// site", surfaced distinctly from a generic failed fetch.

const { WhimsyJiraLiveFolderProvider, jiraQuery, DEFAULT_JQL } = ChromeUtils.importESModule(
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
  is(items.length, 2, "The To Do and In Progress issues come back; Done is hidden by default");
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

// Statuses: one toggle per Jira status category; Done is hidden by default.
add_task(async function test_status_categories() {
  const folder = makeFolder();
  Assert.deepEqual(folder.state.hiddenCategories, ["done"], "Done is hidden by default");
  is(
    jiraQuery(DEFAULT_JQL, ["done"]),
    "assignee = currentUser() AND statusCategory not in (3) ORDER BY updated DESC",
    "The default query filters hidden categories by id, not by the unresolved flag"
  );
  is(jiraQuery(DEFAULT_JQL, []), "assignee = currentUser() ORDER BY updated DESC", "Nothing hidden, no clause");
  is(jiraQuery("project = X", ["done"]), "project = X", "A custom query is left as written");

  const statuses = folder.options.find(o => o.key === "statuses");
  ok(statuses, "The folder's options have a Statuses submenu");
  Assert.deepEqual(
    statuses.options.map(o => [o.value, o.checked]),
    [["new", true], ["indeterminate", true], ["done", false], ["undefined", true]],
    "One toggle per status category; checked means shown"
  );

  folder.toggleCategory("done");
  let items = await folder.fetchItems();
  ok(items.some(i => i.id.endsWith(":ABC-3")), "Showing Done brings back done issues");

  folder.toggleCategory("new");
  items = await folder.fetchItems();
  ok(!items.some(i => i.id.endsWith(":ABC-2")), "Hiding To Do drops to-do issues");

  // A custom query isn't rewritten, so the filter applies client-side.
  const custom = makeFolder({ jql: "project = ABC" });
  items = await custom.fetchItems();
  ok(!items.some(i => i.id.endsWith(":ABC-3")), "Done is hidden client-side for a custom query too");
});

add_task(async function test_jira_workflow_sorting() {
  const folder = makeFolder();
  folder.state.hiddenCategories = [];
  const items = await folder.fetchItems();
  is(items.length, 3, "All categories fetched");
  is(items[0].subtitle, "In Progress", "In Progress issues come first");
  is(items[1].subtitle, "To Do", "To Do issues come second");
  is(items[2].subtitle, "Done", "Done issues come last");
});

