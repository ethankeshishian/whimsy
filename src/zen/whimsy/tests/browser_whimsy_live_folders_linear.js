/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// Linear live folder: "My Issues" (assigned, open states) as a
// self-updating folder, the same model as Zen's GitHub live folder and
// Whimsy's Jira folder. Unlike those two, Linear's GraphQL API has no
// documented cookie/session path, so this tries the signed-in linear.app
// session first and falls back to a personal API key, stored in the
// login manager, when that doesn't authenticate.

const { WhimsyLinearLiveFolderProvider } = ChromeUtils.importESModule(
  "resource:///modules/whimsy/WhimsyLinearLiveFolder.sys.mjs"
);
const { WhimsyLiveFolders } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyLiveFolders.sys.mjs");

const GRAPHQL_URL =
  getRootDirectory(gTestPath).replace("chrome://mochitests/content", "https://example.com") + "whimsy_linear.sjs";
const VALID_KEY = "lin_api_test_key";

// A minimal stand-in for the manager: no window, no real tab-group
// folder, so the fetch runs with userContextId 0 and nothing touches tab UI.
function makeFolder(extraState = {}) {
  const manager = {
    window: null,
    getFolderForLiveFolder: () => null,
    saveState: () => {},
  };
  return new WhimsyLinearLiveFolderProvider({
    id: "test-linear",
    manager,
    graphqlUrl: GRAPHQL_URL,
    state: { ...extraState },
  });
}

registerCleanupFunction(async () => {
  await WhimsyLinearLiveFolderProvider.clearApiKey();
});

add_task(async function test_session_auth() {
  await WhimsyLinearLiveFolderProvider.clearApiKey();
  const folder = makeFolder();
  const items = await folder.fetchItems();
  ok(Array.isArray(items), "Fetches an array of issues over the signed-in session, no API key needed");
  is(items.length, 3, "Triage, Todo and In Progress issues come back by default");
  is(items[0].title, "Fix the login bug", "Title comes from the issue's title");
  is(items[0].subtitle, "ENG-1 · In Progress", "Subtitle carries the identifier and state");
  ok(items[0].url.endsWith("/issue/ENG-1"), "The URL points at the issue");
});

add_task(async function test_api_key_fallback() {
  // The "SESSIONFAIL" marker makes the fixture answer the first,
  // session-only request as unauthenticated, exactly like a signed-out
  // linear.app session would -- the real trigger for the API-key path.
  await WhimsyLinearLiveFolderProvider.setApiKey(VALID_KEY);
  try {
    const folder = makeFolder({ team: "SESSIONFAIL" });
    const items = await folder.fetchItems();
    ok(Array.isArray(items), "Falls back to the stored API key when the session isn't authenticated");
    is(items.length, 3, "The fixture's open issues come back over the API-key request");
  } finally {
    await WhimsyLinearLiveFolderProvider.clearApiKey();
  }
});

add_task(async function test_no_auth() {
  await WhimsyLinearLiveFolderProvider.clearApiKey();
  const folder = makeFolder({ team: "SESSIONFAIL" });
  const result = await folder.fetchItems();
  is(
    result,
    "whimsy-live-folder-linear-no-auth",
    "Neither the session nor a stored key: the folder's own no-auth error id, not a generic failed fetch"
  );
});

add_task(async function test_rejected_api_key() {
  await WhimsyLinearLiveFolderProvider.setApiKey("lin_api_wrong_key");
  try {
    const folder = makeFolder({ team: "SESSIONFAIL" });
    const result = await folder.fetchItems();
    is(result, "whimsy-live-folder-linear-no-auth", "A key the server rejects also surfaces as no-auth");
  } finally {
    await WhimsyLinearLiveFolderProvider.clearApiKey();
  }
});

add_task(async function test_switch_off() {
  await SpecialPowers.pushPrefEnv({ set: [["whimsy.feature.live-folders-linear", false]] });
  ok(!WhimsyLiveFolders.linearEnabled, "The feature switch is off");
  await SpecialPowers.popPrefEnv();
  ok(WhimsyLiveFolders.linearEnabled, "and back on by default");
});

// The toolbar menu's Live Folder submenu lists Jira and Linear next to Zen's
// GitHub and RSS items: inside the submenu's popup (they used to be appended
// to the <menu> itself, outside its popup, and never showed), and only once.
add_task(async function test_create_menu_lists_jira_and_linear() {
  const submenu = document.getElementById("zen-panel-ui-live-folder-create");
  ok(submenu, "Zen's live folder submenu exists");
  const popup = submenu.menupopup;
  const show = () => popup.dispatchEvent(new Event("popupshowing", { bubbles: true }));
  show();
  show();
  const linear = popup.querySelectorAll(":scope > .whimsy-live-folder-linear-create");
  const jira = popup.querySelectorAll(":scope > .whimsy-live-folder-jira-create");
  is(linear.length, 1, "Linear is in the popup, once");
  is(jira.length, 1, "Jira is in the popup, once");
  ok(!linear[0].hidden && !jira[0].hidden, "Both are shown");
  ok(!submenu.querySelector(":scope > menuitem"), "Nothing sits outside the popup");
  is(linear[0].getAttribute("command"), "cmd_zenNewLiveFolder", "Linear runs the live folder command");

  await SpecialPowers.pushPrefEnv({ set: [["whimsy.feature.live-folders-linear", false]] });
  show();
  ok(linear[0].hidden, "Linear's switch off hides it");
  await SpecialPowers.popPrefEnv();
});

// The real menu: right-click the tab sidebar, open "Live Folder" (Zen's
// create menu, next to its GitHub and RSS items) and find Jira and Linear.
add_task(async function test_create_menu_opened_for_real() {
  const contextMenu = document.getElementById("toolbar-context-menu");
  const shown = BrowserTestUtils.waitForPopupEvent(contextMenu, "shown");
  EventUtils.synthesizeMouseAtCenter(gBrowser.tabContainer, { type: "contextmenu", button: 2 });
  await shown;
  const submenu = document.getElementById("zen-panel-ui-live-folder-create");
  ok(BrowserTestUtils.isVisible(submenu), "The Live Folder submenu is in the sidebar's context menu");
  const popup = submenu.menupopup;
  const subShown = BrowserTestUtils.waitForPopupEvent(popup, "shown");
  submenu.openMenu(true);
  await subShown;
  const labels = [...popup.querySelectorAll(":scope > menuitem")].filter(i => !i.hidden).map(i => i.getAttribute("data-l10n-id"));
  ok(labels.includes("zen-live-folder-github-pull-requests"), "Zen's GitHub item is there");
  ok(labels.includes("zen-live-folder-type-rss"), "Zen's RSS item is there");
  ok(labels.includes("whimsy-live-folder-jira-create"), "Jira is listed beside them");
  ok(labels.includes("whimsy-live-folder-linear-create"), "Linear is listed beside them");
  for (const cls of ["whimsy-live-folder-jira-create", "whimsy-live-folder-linear-create"]) {
    ok(BrowserTestUtils.isVisible(popup.querySelector(`.${cls}`)), `${cls} is visible in the open menu`);
  }
  const hidden = BrowserTestUtils.waitForPopupEvent(contextMenu, "hidden");
  contextMenu.hidePopup();
  await hidden;
});

// Statuses: Backlog, Done, Canceled and Duplicate are hidden by default;
// every Linear workflow state type has its own toggle in the folder's
// Statuses submenu.
add_task(async function test_status_filters() {
  await WhimsyLinearLiveFolderProvider.clearApiKey();
  const folder = makeFolder();
  Assert.deepEqual(
    folder.state.hiddenStates,
    ["backlog", "completed", "canceled", "duplicate"],
    "A new (or pre-existing, unsaved) folder hides Backlog, Done, Canceled and Duplicate"
  );
  let items = await folder.fetchItems();
  Assert.deepEqual(
    items.map(i => i.subtitle.split(" · ")[0]).sort(),
    ["ENG-1", "ENG-2", "ENG-3"],
    "Only triage, unstarted and started issues show by default"
  );

  const statuses = folder.options.find(o => o.key === "statuses");
  ok(statuses, "The folder's options have a Statuses submenu");
  Assert.deepEqual(
    statuses.options.map(o => o.value),
    ["triage", "backlog", "unstarted", "started", "completed", "canceled", "duplicate"],
    "One toggle per Linear workflow state type, in Linear's order"
  );
  Assert.deepEqual(
    statuses.options.filter(o => o.checked).map(o => o.value),
    ["triage", "unstarted", "started"],
    "Checked means shown"
  );
  for (const o of statuses.options) {
    ok(o.l10nId.startsWith("whimsy-live-folder-linear-state-"), `${o.value} has its own label`);
  }

  // Showing Canceled brings back canceled issues, but not an older
  // workspace's canceled "Duplicate" while Duplicate stays hidden.
  folder.toggleStateType("canceled");
  items = await folder.fetchItems();
  const ids = items.map(i => i.id);
  ok(ids.includes("linear:issue-6"), "Showing Canceled brings back a canceled issue");
  ok(!ids.includes("linear:issue-8"), "A canceled state named Duplicate still counts as Duplicate");
  ok(!ids.includes("linear:issue-7"), "A native duplicate stays hidden");

  folder.toggleStateType("duplicate");
  items = await folder.fetchItems();
  ok(items.some(i => i.id === "linear:issue-7"), "Showing Duplicate brings back native duplicates");
  ok(items.some(i => i.id === "linear:issue-8"), "and legacy canceled duplicates");

  folder.toggleStateType("started");
  items = await folder.fetchItems();
  ok(!items.some(i => i.id === "linear:issue-1"), "Hiding In Progress drops started issues");

  folder.toggleStateType("not-a-type");
  ok(!folder.state.hiddenStates.includes("not-a-type"), "Unknown types are ignored");

  const saved = makeFolder({ hiddenStates: [] });
  items = await saved.fetchItems();
  is(items.length, 8, "With nothing hidden, every status shows");
});
