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
  is(items.length, 2, "Both fixture issues come back");
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
    is(items.length, 2, "The fixture's issues come back over the API-key request");
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
