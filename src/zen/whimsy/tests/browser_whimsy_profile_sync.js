/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// wave5/profiles: per-profile data travels with Firefox Sync. Login tags,
// the history page → profile map and the search/download/extension choices
// are synced maps (WhimsyProfileSync) carried by Sync's prefs engine. A
// two-device round trip: export the prefs record this device would upload,
// wipe everything local (a fresh Mac), apply the record through the prefs
// engine's own store, and the tags are back. Conflicts resolve the same way
// on every device.

const { WhimsyProfiles } = ChromeUtils.importESModule(
  "resource:///modules/whimsy/WhimsyProfiles.sys.mjs"
);
const { WhimsyProfilePasswords, TAGS_PREF } = ChromeUtils.importESModule(
  "resource:///modules/whimsy/WhimsyProfilePasswords.sys.mjs"
);
const { WhimsyProfileSettings } = ChromeUtils.importESModule(
  "resource:///modules/whimsy/WhimsyProfileSettings.sys.mjs"
);
const { WhimsySpaceExtensions } = ChromeUtils.importESModule(
  "resource:///modules/whimsy/WhimsySpaceExtensions.sys.mjs"
);
const { WhimsySpaceHistory, HISTORY_PROFILES_PREF } = ChromeUtils.importESModule(
  "resource:///modules/whimsy/WhimsySpaceHistory.sys.mjs"
);
const { mergeEntries } = ChromeUtils.importESModule(
  "resource:///modules/whimsy/WhimsyProfileSync.sys.mjs"
);
const { ContextualIdentityService } = ChromeUtils.importESModule(
  "moz-src:///toolkit/components/contextualidentity/ContextualIdentityService.sys.mjs"
);

const ORIGIN = "https://example.com";
const LoginInfo = Components.Constructor("@mozilla.org/login-manager/loginInfo;1",
  Ci.nsILoginInfo, "init");

add_task(function merge_is_deterministic() {
  const a = { x: ["work", 100], y: ["home", 300], z: ["one", 50] };
  const b = { x: ["play", 200], y: ["away", 100], z: ["two", 50] };
  Assert.deepEqual(mergeEntries(a, b), mergeEntries(b, a), "Same result whichever device merges");
  const merged = mergeEntries(a, b);
  is(merged.x[0], "play", "Newer wins");
  is(merged.y[0], "home", "Newer wins the other way too");
  is(merged.z[0], "one", "An exact tie goes to the smaller value");
  is(mergeEntries({ x: ["work", 10] }, { x: [null, 20] }).x[0], null, "A newer deletion wins");
});

// Every synced map, with its prefs-engine pref.
function maps() {
  return [
    [WhimsyProfilePasswords.tags, TAGS_PREF],
    [WhimsySpaceHistory.placeProfiles, HISTORY_PROFILES_PREF],
    [WhimsyProfileSettings.engines, WhimsyProfileSettings.ENGINES_PREF],
    [WhimsySpaceExtensions.choices, WhimsySpaceExtensions.PROFILES_PREF],
  ];
}

function wipeLocally() {
  for (const [map, pref] of maps()) {
    map.file.data.entries = {};
    map._writing++;
    try {
      Services.prefs.clearUserPref(pref);
    } finally {
      map._writing--;
    }
  }
}

add_task(async function two_device_round_trip() {
  const { PrefsEngine, getPrefsGUIDForTest } = ChromeUtils.importESModule(
    "resource://services-sync/engines/prefs.sys.mjs"
  );
  const { Service } = ChromeUtils.importESModule("resource://services-sync/service.sys.mjs");
  const store = new PrefsEngine(Service)._store;
  WhimsyProfilePasswords.init();

  const work = WhimsyProfiles.create("Whimsy Sync Work");
  const key = WhimsyProfiles.keyFor(work);
  const login = await Services.logins.addLoginAsync(
    new LoginInfo(ORIGIN, ORIGIN, null, "synced-tag", "secret", "u", "p"));
  try {
    const [stored] = await Services.logins.searchLoginsAsync({ guid: login.guid, origin: ORIGIN });
    await WhimsyProfilePasswords.tag(stored, key);
    WhimsySpaceHistory.placeProfiles.set("placeGuidAAA", [key]);
    WhimsyProfileSettings.engines.set(key, "whimsy-test-engine");
    WhimsySpaceExtensions.choices.set("ext@whimsy.test", [key]);

    // Device A: the record Sync would upload.
    const record = await store.createRecord(getPrefsGUIDForTest(), "prefs");
    for (const [, pref] of maps()) {
      ok(record.value[pref], `${pref} is in the uploaded prefs`);
    }

    // Device B: nothing local, not even the tag inside the login itself.
    wipeLocally();
    if (!WhimsyProfilePasswords.rustStore) {
      const [bare] = await Services.logins.searchLoginsAsync({ guid: login.guid, origin: ORIGIN });
      await Services.logins.modifyLoginAsync(bare,
        ChromeUtils.importESModule("resource://gre/modules/LoginHelper.sys.mjs")
          .LoginHelper.newPropertyBag({ unknownFields: null }));
    }
    const [before] = await Services.logins.searchLoginsAsync({ guid: login.guid, origin: ORIGIN });
    is(WhimsyProfilePasswords.keyOfLogin(before), "default", "Fresh device: untagged");

    await store.update(record);
    const [after] = await Services.logins.searchLoginsAsync({ guid: login.guid, origin: ORIGIN });
    is(WhimsyProfilePasswords.keyOfLogin(after), key, "The login's profile came through Sync");
    Assert.deepEqual(WhimsySpaceHistory.placeProfiles.get("placeGuidAAA"), [key], "History page map too");
    is(WhimsyProfileSettings.engineFor(key), "whimsy-test-engine", "Search engine choice too");
    Assert.deepEqual(WhimsySpaceExtensions.getAllowedProfiles("ext@whimsy.test"), [key], "Extension choice too");
    ok(WhimsyProfilePasswords.tags.file.data.entries[login.guid], "…and the local cache holds it again");

    // A local change made before the download isn't lost: merged, re-uploaded.
    wipeLocally();
    WhimsyProfileSettings.engines.set("local-only", "other-engine");
    await store.update(record);
    is(WhimsyProfileSettings.engineFor("local-only"), "other-engine", "Local entry kept");
    is(WhimsyProfileSettings.engineFor(key), "whimsy-test-engine", "Incoming entry added");
    ok(JSON.parse(Services.prefs.getStringPref(WhimsyProfileSettings.ENGINES_PREF))["local-only"],
      "The merge is what uploads next");
  } finally {
    await Services.logins.removeLoginAsync(login).catch(() => {});
    WhimsySpaceHistory.placeProfiles.set("placeGuidAAA", null);
    WhimsyProfileSettings.engines.set(key, null);
    WhimsyProfileSettings.engines.set("local-only", null);
    WhimsySpaceExtensions.choices.set("ext@whimsy.test", null);
    ContextualIdentityService.remove(work);
  }
});
