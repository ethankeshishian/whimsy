/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// Linear live folder: "My Issues" (assigned, open states) as a
// self-updating folder, the same model as Zen's GitHub live folder and
// Whimsy's Jira folder. It rides the linear.app session (the cookie of
// the space's container, sent the way linear.app's own web app sends it,
// with Origin: the linear.app page) -- no API key. A personal API key is
// only an advanced fallback. whimsy_linear.sjs plays both endpoints.

const {
  WhimsyLinearLiveFolderProvider,
  LINEAR_ERROR_SIGNED_OUT,
  LINEAR_ERROR_KEY_REJECTED,
  LINEAR_ERROR_RATE_LIMITED,
  classifyLinearResponse,
} = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyLinearLiveFolder.sys.mjs");
const { WhimsyLiveFolders } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyLiveFolders.sys.mjs");

const GRAPHQL_URL =
  getRootDirectory(gTestPath).replace("chrome://mochitests/content", "https://example.com") + "whimsy_linear.sjs";
// Stands in for https://linear.app: a different host on the same site as
// the endpoint, like linear.app and client-api.linear.app.
const SESSION_ORIGIN = "https://test1.example.com";
const SIGN_IN_URL = "https://example.com/?whimsy-linear-sign-in";
const VALID_KEY = "lin_api_test_key";
const COOKIE = "whimsy_linear_session";
const CONTAINER = 2;

// A minimal stand-in for the manager. With `userContextId`, the folder
// sits in a space whose container (profile) is that id.
function makeFolder(extraState = {}, { userContextId = 0, win = null } = {}) {
  const tabGroup = userContextId
    ? {
        documentGlobal: {
          gZenWorkspaces: { getWorkspaceFromId: () => ({ containerTabId: userContextId }) },
        },
        getAttribute: () => "space-1",
      }
    : null;
  const manager = {
    window: win,
    getFolderForLiveFolder: () => tabGroup,
    saveState: () => {},
  };
  return new WhimsyLinearLiveFolderProvider({
    id: "test-linear",
    manager,
    graphqlUrl: GRAPHQL_URL,
    sessionUrl: GRAPHQL_URL,
    sessionOrigin: SESSION_ORIGIN,
    signInUrl: SIGN_IN_URL,
    state: { ...extraState },
  });
}

// A domain cookie on .example.com, like linear.app's session cookie that
// client-api.linear.app also receives.
function signIn(value, userContextId = 0) {
  Services.cookies.add(
    ".example.com",
    "/",
    COOKIE,
    value,
    true,
    true,
    true,
    Date.now() + 60 * 60 * 1000,
    { userContextId },
    Ci.nsICookie.SAMESITE_LAX,
    Ci.nsICookie.SCHEME_HTTPS
  );
}

function signOut(userContextId = 0) {
  Services.cookies.remove(".example.com", COOKIE, "/", { userContextId });
}

function signOutEverywhere() {
  signOut(0);
  signOut(CONTAINER);
}

registerCleanupFunction(async () => {
  signOutEverywhere();
  await WhimsyLinearLiveFolderProvider.clearApiKey();
});

add_task(async function test_session_auth() {
  await WhimsyLinearLiveFolderProvider.clearApiKey();
  signIn("solo");
  try {
    const folder = makeFolder();
    const items = await folder.fetchItems();
    ok(Array.isArray(items), "Fetches issues over the signed-in linear.app session, no API key needed");
    is(items.length, 3, "Triage, Todo and In Progress issues come back by default");
    is(items[0].title, "Fix the login bug", "Title comes from the issue's title");
    is(items[0].subtitle, "ENG-1 · In Progress", "Subtitle carries the identifier and state");
    ok(items[0].url.endsWith("/issue/ENG-1"), "The URL points at the issue");
    ok(!folder.isWatchingForSignIn, "Signed in: nothing listens for cookies");
    ok(
      !folder.options.some(o => o.key === "workspace"),
      "One workspace: no Workspace menu"
    );
    ok(!folder.options.some(o => o.key === "linearApiKey"), "Signed in: no API key option at all");
    const saved = JSON.stringify(folder.serialize());
    ok(!saved.includes("solo") && !saved.includes(COOKIE), "Nothing about the session is saved with the folder");
  } finally {
    signOutEverywhere();
  }
});

add_task(async function test_signed_out_offers_sign_in() {
  await WhimsyLinearLiveFolderProvider.clearApiKey();
  signOutEverywhere();
  const folder = makeFolder();
  const result = await folder.fetchItems();
  is(result, LINEAR_ERROR_SIGNED_OUT, "Signed out with no key: the Sign in to Linear state, not a key prompt");
  is(result, "whimsy-live-folder-linear-signed-out", "with its own error id");
  ok(folder.isWatchingForSignIn, "and it listens for the sign-in");
  folder.state.lastErrorId = result;
  ok(
    folder.options.some(o => o.key === "linearApiKey"),
    "The API key is offered as an advanced option once the session path failed"
  );
  folder.stop();
  ok(!folder.isWatchingForSignIn, "Stopping the folder stops listening");
});

add_task(async function test_sign_in_action_and_auto_refresh() {
  await WhimsyLinearLiveFolderProvider.clearApiKey();
  signOutEverywhere();
  const folder = makeFolder({}, { userContextId: CONTAINER, win: window });
  is(await folder.fetchItems(), LINEAR_ERROR_SIGNED_OUT, "Signed out in the space's container");

  const tabOpened = BrowserTestUtils.waitForNewTab(gBrowser, SIGN_IN_URL);
  await folder.onActionButtonClick(LINEAR_ERROR_SIGNED_OUT);
  const tab = await tabOpened;
  is(gBrowser.selectedTab, tab, "Sign in to Linear opens and selects the sign-in page");
  is(tab.userContextId, CONTAINER, "in the space's container, so the session lands where the folder reads");

  const oldDebounce = WhimsyLinearLiveFolderProvider.signInDebounceMs;
  WhimsyLinearLiveFolderProvider.signInDebounceMs = 0;
  let refreshed = 0;
  folder.refresh = async () => {
    refreshed++;
  };
  try {
    signIn("solo", 0);
    await new Promise(r => setTimeout(r, 50));
    is(refreshed, 0, "A sign-in in another container doesn't refresh this folder");
    signIn("solo", CONTAINER);
    await TestUtils.waitForCondition(() => refreshed === 1, "Signing in refreshes the folder by itself");
    const items = await folder.fetchItems();
    ok(Array.isArray(items) && items.length === 3, "and then the container's session works");
    ok(!folder.isWatchingForSignIn, "Once signed in, it stops listening");
  } finally {
    WhimsyLinearLiveFolderProvider.signInDebounceMs = oldDebounce;
    folder.stop();
    BrowserTestUtils.removeTab(tab);
    signOutEverywhere();
  }
});

add_task(async function test_container_cookies_only() {
  await WhimsyLinearLiveFolderProvider.clearApiKey();
  signIn("solo", CONTAINER);
  try {
    const inDefault = makeFolder();
    is(await inDefault.fetchItems(), LINEAR_ERROR_SIGNED_OUT, "A default-container space doesn't see a container's session");
    inDefault.stop();
    const inContainer = makeFolder({}, { userContextId: CONTAINER });
    const items = await inContainer.fetchItems();
    ok(Array.isArray(items) && items.length === 3, "A space in that container (its profile) does");
  } finally {
    signOutEverywhere();
  }
});

add_task(async function test_multiple_workspaces() {
  await WhimsyLinearLiveFolderProvider.clearApiKey();
  signIn("multi");
  try {
    const folder = makeFolder();
    let items = await folder.fetchItems();
    Assert.deepEqual(
      items.map(i => i.id),
      ["linear:issue-1", "linear:issue-2", "linear:issue-3", "linear:side-1"],
      "Every workspace of the signed-in account is fetched, merged in order"
    );

    const menu = folder.options.find(o => o.key === "workspace");
    ok(menu, "Two workspaces: a Workspace menu");
    Assert.deepEqual(
      menu.options.map(o => [o.value, o.checked]),
      [
        ["", true],
        ["org-a", false],
        ["org-b", false],
      ],
      "All Workspaces, then each workspace; All is the default"
    );
    Assert.deepEqual(menu.options[2].l10nArgs, { name: "Side Project" }, "Workspaces are labelled by name");

    folder.setWorkspace("org-b");
    is(folder.state.workspace, "org-b", "The choice is saved with the folder");
    items = await folder.fetchItems();
    Assert.deepEqual(items.map(i => i.id), ["linear:side-1"], "Only the picked workspace's issues");

    folder.setWorkspace("org-gone");
    items = await folder.fetchItems();
    is(items.length, 4, "A workspace that's gone falls back to all of them");
  } finally {
    signOutEverywhere();
  }
});

add_task(async function test_locked_workspace() {
  await WhimsyLinearLiveFolderProvider.clearApiKey();
  signIn("locked");
  try {
    const folder = makeFolder();
    const items = await folder.fetchItems();
    ok(Array.isArray(items), "One locked workspace doesn't sign the whole folder out");
    is(items.length, 3, "The other workspace's issues still come back");
  } finally {
    signOutEverywhere();
  }
});

add_task(async function test_rate_limited() {
  await WhimsyLinearLiveFolderProvider.clearApiKey();
  signIn("ratelimited");
  try {
    const folder = makeFolder();
    is(await folder.fetchItems(), LINEAR_ERROR_RATE_LIMITED, "A rate limit has its own state (tabs stay put)");
    const until = folder._rateLimitedUntil;
    ok(until > Date.now() + 5 * 60 * 1000, "It backs off until Linear's X-RateLimit-Requests-Reset");
    ok(until <= Date.now() + 60 * 60 * 1000, "but never more than an hour");

    // Signed in properly now, but still inside the window: no request.
    signIn("solo");
    is(await folder.fetchItems(), LINEAR_ERROR_RATE_LIMITED, "Inside the window it doesn't ask again");
    folder._rateLimitedUntil = Date.now() - 1;
    ok(Array.isArray(await folder.fetchItems()), "After the window it fetches again");
  } finally {
    signOutEverywhere();
  }
});

add_task(async function test_classify() {
  is(classifyLinearResponse({ status: 429, data: null }), "rate-limited", "429 is a rate limit");
  is(
    classifyLinearResponse({ status: 400, data: { errors: [{ message: "x", extensions: { code: "RATELIMITED" } }] } }),
    "rate-limited",
    "RATELIMITED is a rate limit"
  );
  is(
    classifyLinearResponse({ status: 200, data: { errors: [{ message: "Authentication required." }] } }),
    "unauthenticated",
    "An authentication message is signed out"
  );
  is(classifyLinearResponse({ status: 401, data: null }), "unauthenticated", "401 is signed out");
  is(classifyLinearResponse({ status: 200, data: { data: { viewer: {} } } }), "ok", "Data is fine");
  is(
    classifyLinearResponse({ status: 400, data: { errors: [{ message: "Cannot query field" }] } }),
    "failed",
    "Any other error is a plain failed fetch, not a sign-out"
  );
  is(classifyLinearResponse({ status: 502, data: null }), "failed", "So is a server error");
});

add_task(async function test_api_key_fallback() {
  signOutEverywhere();
  await WhimsyLinearLiveFolderProvider.setApiKey(VALID_KEY);
  try {
    const folder = makeFolder();
    const items = await folder.fetchItems();
    ok(Array.isArray(items), "Signed out, a stored API key still works as the fallback");
    is(items.length, 3, "The fixture's open issues come back over the API-key request");
    ok(folder.options.some(o => o.key === "linearRemoveApiKey"), "and the key can be removed from the folder's menu");
  } finally {
    await WhimsyLinearLiveFolderProvider.clearApiKey();
  }
});

add_task(async function test_session_wins_over_key() {
  await WhimsyLinearLiveFolderProvider.setApiKey("lin_api_wrong_key");
  signIn("solo");
  try {
    const folder = makeFolder();
    const items = await folder.fetchItems();
    ok(Array.isArray(items) && items.length === 3, "Signed in, the session is used and the key never matters");
  } finally {
    signOutEverywhere();
    await WhimsyLinearLiveFolderProvider.clearApiKey();
  }
});

add_task(async function test_rejected_api_key() {
  signOutEverywhere();
  await WhimsyLinearLiveFolderProvider.setApiKey("lin_api_wrong_key");
  try {
    const folder = makeFolder();
    const result = await folder.fetchItems();
    is(result, LINEAR_ERROR_KEY_REJECTED, "Signed out and a key the server rejects: the key-rejected state");
    ok(folder.isWatchingForSignIn, "Signing in to linear.app would still fix it, so it listens");
    folder.stop();
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
  signIn("solo");
  registerCleanupFunction(signOutEverywhere);
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
