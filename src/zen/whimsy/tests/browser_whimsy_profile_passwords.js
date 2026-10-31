/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// wave5/profiles, phase 2: saved passwords per profile. Autofill only uses
// the page's profile's logins; a login saved from a page takes that page's
// profile; the tag rides Firefox Sync as an unknown field (round-trip
// through the passwords engine's store); deleting a profile deletes its
// logins.

const { WhimsyProfiles } = ChromeUtils.importESModule(
  "resource:///modules/whimsy/WhimsyProfiles.sys.mjs"
);
const { WhimsyProfilePasswords, TAG } = ChromeUtils.importESModule(
  "resource:///modules/whimsy/WhimsyProfilePasswords.sys.mjs"
);
const { ContextualIdentityService } = ChromeUtils.importESModule(
  "moz-src:///toolkit/components/contextualidentity/ContextualIdentityService.sys.mjs"
);

const FEATURE = "whimsy.feature.space-profiles";
const ORIGIN = "https://example.com";
const PAGE = getRootDirectory(gTestPath).replace("chrome://mochitests/content", ORIGIN) +
  "whimsy_login_form.html";
const LoginInfo = Components.Constructor("@mozilla.org/login-manager/loginInfo;1",
  Ci.nsILoginInfo, "init");

let work;

function newLogin(username, password = `${username}-secret`) {
  return new LoginInfo(ORIGIN, ORIGIN, null, username, password, "username", "password");
}

add_setup(async function () {
  // Firefox's password manager ships off here (signon.rememberSignons), and
  // with it off nothing autofills; per-profile logins only matter with it on.
  // As Firefox's own password tests do (passwordmgr/test/browser/head.js).
  await SpecialPowers.pushPrefEnv({
    set: [
      ["signon.rememberSignons", true],
      ["signon.testOnlyUserHasInteractedByPrefValue", true],
      ["signon.testOnlyUserHasInteractedWithDocument", true],
    ],
  });
  WhimsyProfilePasswords.init();
  work = WhimsyProfiles.create("Whimsy Passwords Work");
  registerCleanupFunction(async () => {
    Services.prefs.clearUserPref(FEATURE);
    await Services.logins.removeAllUserFacingLoginsAsync();
    if (ContextualIdentityService.getPublicIdentityFromId(work)) {
      ContextualIdentityService.remove(work);
    }
  });
});

async function filledUsername(userContextId) {
  // A profile's page opens in a space of that profile (wave8/isolation
  // keeps every tab in a space of its own container).
  const home = gZenWorkspaces.getActiveWorkspace();
  const space = userContextId
    ? await gZenWorkspaces.createAndSaveWorkspace(`Passwords ${userContextId}`, undefined, true, userContextId)
    : null;
  if (space) {
    await gZenWorkspaces.changeWorkspace(space);
  }
  // In front, as a login page is: Firefox defers autofill in a hidden
  // (background) document until it's shown.
  const tab = await BrowserTestUtils.openNewForegroundTab({
    gBrowser,
    opening: () => (gBrowser.selectedTab = BrowserTestUtils.addTab(gBrowser, PAGE, { userContextId })),
  });
  try {
    is(tab.userContextId, userContextId, "The page is in that profile");
    return await SpecialPowers.spawn(tab.linkedBrowser, [], async () => {
      const field = content.document.getElementById("username");
      // Autofill runs shortly after load; give it a moment, then read.
      await ContentTaskUtils.waitForCondition(() => field.value, "autofilled", 50, 40).catch(() => {});
      return field.value;
    });
  } finally {
    if (space) {
      await gZenWorkspaces.changeWorkspace(home);
    }
    BrowserTestUtils.removeTab(tab);
    if (space) {
      await gZenWorkspaces.removeWorkspace(space.uuid);
    }
  }
}

add_task(async function untagged_logins_are_default() {
  const login = await Services.logins.addLoginAsync(newLogin("legacy"));
  is(WhimsyProfilePasswords.keyOfLogin(login), "default", "A login from before profiles is Default's");
  await Services.logins.removeLoginAsync(login);
});

add_task(async function autofill_uses_the_page_profile() {
  await Services.logins.addLoginAsync(newLogin("home"));
  const workLogin = await Services.logins.addLoginAsync(newLogin("office"));
  const [stored] = await Services.logins.searchLoginsAsync({ guid: workLogin.guid, origin: ORIGIN });
  await WhimsyProfilePasswords.tag(stored, WhimsyProfiles.keyFor(work));

  is(await filledUsername(0), "home", "Default fills Default's login only");
  is(await filledUsername(work), "office", "Work fills Work's login only");

  Services.prefs.setBoolPref(FEATURE, false);
  is(await filledUsername(work), "", "Feature off: two logins, so Firefox fills neither (no scoping)");
  Services.prefs.clearUserPref(FEATURE);
  await Services.logins.removeAllUserFacingLoginsAsync();
});

add_task(async function a_new_profile_starts_without_passwords() {
  await Services.logins.addLoginAsync(newLogin("home"));
  const fresh = WhimsyProfiles.create("Whimsy Passwords Fresh");
  try {
    is(await filledUsername(fresh), "", "Nothing fills in a brand-new profile");
  } finally {
    ContextualIdentityService.remove(fresh);
    await Services.logins.removeAllUserFacingLoginsAsync();
  }
});

add_task(async function conflicting_profiles_show_nothing() {
  const logins = [newLogin("a"), newLogin("b")];
  const key = WhimsyProfiles.keyFor(work);
  WhimsyProfilePasswords.enter(ORIGIN, key);
  Assert.deepEqual(WhimsyProfilePasswords.filter(ORIGIN, logins), [], "Work sees no Default login");
  WhimsyProfilePasswords.enter(ORIGIN, "default");
  Assert.deepEqual(WhimsyProfilePasswords.filter(ORIGIN, logins), [],
    "Two profiles at once on one origin: nothing, never the other profile's");
  WhimsyProfilePasswords.leave(ORIGIN, key);
  is(WhimsyProfilePasswords.filter(ORIGIN, logins).length, 2, "Default alone sees its logins");
  WhimsyProfilePasswords.leave(ORIGIN, "default");
  is(WhimsyProfilePasswords._active.size, 0, "Bookkeeping cleared");
});

add_task(async function saved_login_takes_the_page_profile() {
  const key = WhimsyProfiles.keyFor(work);
  WhimsyProfilePasswords._pending.set(ORIGIN, { key, time: Date.now() });
  const login = await Services.logins.addLoginAsync(newLogin("saved-in-work"));
  await TestUtils.waitForCondition(async () => {
    const [stored] = await Services.logins.searchLoginsAsync({ guid: login.guid, origin: ORIGIN });
    return WhimsyProfilePasswords.keyOfLogin(stored) == key;
  }, "The new login is Work's");
  WhimsyProfilePasswords._pending.clear();
  await Services.logins.removeAllUserFacingLoginsAsync();
});

add_task(async function sync_round_trip_of_the_tag() {
  const { PasswordEngine } = ChromeUtils.importESModule(
    "resource://services-sync/engines/passwords.sys.mjs"
  );
  const { Service } = ChromeUtils.importESModule("resource://services-sync/service.sys.mjs");
  const engine = new PasswordEngine(Service);
  const store = engine._store;
  const key = WhimsyProfiles.keyFor(work);

  const login = await Services.logins.addLoginAsync(newLogin("synced"));
  const [stored] = await Services.logins.searchLoginsAsync({ guid: login.guid, origin: ORIGIN });
  await WhimsyProfilePasswords.tag(stored, key);

  if (WhimsyProfilePasswords.rustStore) {
    // Firefox's Rust store doesn't expose unknownFields: the tag is local.
    const [again] = await Services.logins.searchLoginsAsync({ guid: login.guid, origin: ORIGIN });
    is(WhimsyProfilePasswords.keyOfLogin(again), key, "Rust store: the sidecar keeps the tag locally");
    await Services.logins.removeAllUserFacingLoginsAsync();
    return;
  }

  // Outgoing: the tag becomes a top-level field of the uploaded record.
  const outgoing = await store.createRecord(login.guid, "passwords");
  is(outgoing.cleartext[TAG], key, "Upload carries whimsyProfile");
  is(outgoing.cleartext.username, "synced", "…next to the ordinary fields");

  // Incoming from another device: a record with the tag lands tagged,
  // with no sidecar entry here.
  const guid = Services.uuid.generateUUID().toString();
  const incoming = await store.createRecord(login.guid, "passwords");
  incoming.id = guid;
  incoming.cleartext.id = guid;
  incoming.cleartext.username = "from-other-device";
  incoming.cleartext[TAG] = "builtin-2";
  await store.applyIncoming(incoming);
  const [arrived] = await Services.logins.searchLoginsAsync({ guid, origin: ORIGIN });
  ok(arrived, "The incoming login was stored");
  is(WhimsyProfilePasswords.tags.get(guid), undefined, "Nothing in the synced map for it yet");
  is(WhimsyProfilePasswords.keyOfLogin(arrived), "builtin-2", "Its profile came with it");

  // And it goes back out unchanged (stock Firefox does the same).
  const back = await store.createRecord(guid, "passwords");
  is(back.cleartext[TAG], "builtin-2", "Round-trips on the next upload");
  await Services.logins.removeAllUserFacingLoginsAsync();
});

add_task(async function deleting_a_profile_deletes_its_logins() {
  const doomed = WhimsyProfiles.create("Whimsy Passwords Doomed");
  const keep = await Services.logins.addLoginAsync(newLogin("keep"));
  const gone = await Services.logins.addLoginAsync(newLogin("gone"));
  const [stored] = await Services.logins.searchLoginsAsync({ guid: gone.guid, origin: ORIGIN });
  await WhimsyProfilePasswords.tag(stored, WhimsyProfiles.keyFor(doomed));
  ok(await WhimsyProfiles.delete(doomed, window), "Deleted the unused profile");
  const left = (await Services.logins.getAllLogins()).map(l => l.username);
  ok(left.includes("keep") && !left.includes("gone"), "Only its own login went with it");
  await Services.logins.removeLoginAsync(keep);
});
