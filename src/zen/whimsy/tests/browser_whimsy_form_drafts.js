/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// R1 v2 (wave13/r1-v2-design.md §4, §6, §9): the encrypted draft store.
// Drafts are keyed by the address without its fragment and the container;
// normal ones are kept on disk as one OSKeyStore ciphertext, private ones in
// memory only; 7 days; Fire and the setting erase them.

const { WhimsyFormDrafts } = ChromeUtils.importESModule(
  "resource:///modules/whimsy/WhimsyFormProtection.sys.mjs"
);
const { OSKeyStore } = ChromeUtils.importESModule(
  "resource://gre/modules/OSKeyStore.sys.mjs"
);
const { OSKeyStoreTestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/OSKeyStoreTestUtils.sys.mjs"
);

const SAVE_PREF = "whimsy.forms.saveDrafts";
// Built by concatenation so no fixture looks like typed text in the tree.
const MARKER = "whimsy" + "-draft-" + "marker-" + "7f3a";
const PAGE = "https://example.com/apply?job=1";

function draft(text = MARKER) {
  return { id: { message: text, agree: true, size: { selectedIndex: 2, value: "L" } } };
}

async function fileText() {
  try {
    return await IOUtils.readUTF8(WhimsyFormDrafts.path);
  } catch (e) {
    return null;
  }
}

add_setup(async function () {
  OSKeyStoreTestUtils.setup();
  await WhimsyFormDrafts._resetForTests();
  registerCleanupFunction(async () => {
    await WhimsyFormDrafts._resetForTests();
    await IOUtils.remove(WhimsyFormDrafts.path, { ignoreAbsent: true });
    Services.prefs.clearUserPref(SAVE_PREF);
    await OSKeyStoreTestUtils.cleanup();
  });
});

add_task(async function test_key_is_the_address_without_its_fragment() {
  ok(await WhimsyFormDrafts.put({ url: PAGE + "#step2", data: draft() }), "Stored");
  const got = await WhimsyFormDrafts.get({ url: "HTTPS://Example.com:443/apply?job=1#top" });
  is(got?.data.id.message, MARKER, "Same address (case, default port, fragment) finds it");
  is(await WhimsyFormDrafts.get({ url: "https://example.com/apply?job=2" }), null, "Another query string: nothing");
  is(await WhimsyFormDrafts.get({ url: "http://example.com/apply?job=1" }), null, "http is another address");
  is(await WhimsyFormDrafts.get({ url: "https://example.com.evil.test/apply?job=1" }), null, "A lookalike host: nothing");
  is(await WhimsyFormDrafts.get({ url: PAGE, userContextId: 2 }), null, "Another container: nothing");
  await WhimsyFormDrafts.delete({ url: PAGE });
  is(await WhimsyFormDrafts.get({ url: PAGE }), null, "Deleted");
});

add_task(async function test_page_data_is_filtered() {
  ok(!(await WhimsyFormDrafts.put({ url: "javascript:alert(1)", data: draft() })), "Only http(s) pages");
  ok(!(await WhimsyFormDrafts.put({ url: "about:blank", data: draft() })), "Not about: pages");
  ok(!(await WhimsyFormDrafts.put({ url: PAGE, data: { id: {} } })), "An empty draft isn't stored");
  ok(!(await WhimsyFormDrafts.put({ url: PAGE, data: { id: { a: 3, b: null } } })), "Numbers and null are not field values");
  ok(!(await WhimsyFormDrafts.put({ url: PAGE, data: draft("x".repeat(70 * 1024)) })), "Over 64 KB is refused");
  const evil = JSON.parse('{"id": {"__proto__": {"value": "p", "selectedIndex": 1}, "name": "ok"}, "other": {"x": "y"}}');
  ok(await WhimsyFormDrafts.put({ url: PAGE, data: evil }), "The plain part is kept");
  const got = await WhimsyFormDrafts.get({ url: PAGE });
  Assert.deepEqual(Object.keys(got.data), ["id"], "Only id/xpath maps");
  Assert.deepEqual(Object.keys(got.data.id), ["name"], "__proto__ isn't a field");
  // (The store's objects come from another realm, so compare by shape.)
  ok(!("value" in got.data.id) && !("selectedIndex" in got.data.id), "No prototype was set through the draft");
  await WhimsyFormDrafts.delete({ url: PAGE });
});

add_task(async function test_disk_holds_only_ciphertext() {
  await WhimsyFormDrafts.put({ url: PAGE, data: draft() });
  await WhimsyFormDrafts.flush();
  const text = await fileText();
  ok(text, "The draft file was written");
  ok(!text.includes(MARKER), "The typed text isn't in the file");
  ok(!text.includes("example.com"), "Nor the address");
  const { version, blob } = JSON.parse(text);
  is(version, 1, "Versioned");
  const records = JSON.parse(await OSKeyStore.decrypt(blob));
  is(records[0].data.id.message, MARKER, "It decrypts to the draft under the Keychain key");

  // A fresh start reads it back.
  await WhimsyFormDrafts._dropMemoryForTests();
  is((await WhimsyFormDrafts.get({ url: PAGE }))?.data.id.message, MARKER, "Read back after a restart");
  await WhimsyFormDrafts.delete({ url: PAGE });
  await WhimsyFormDrafts.flush();
});

add_task(async function test_private_drafts_never_touch_disk() {
  await WhimsyFormDrafts.flush();
  const before = await fileText();
  ok(await WhimsyFormDrafts.put({ url: PAGE, data: draft(), isPrivate: true }), "Private draft kept");
  await WhimsyFormDrafts.flush();
  is(await fileText(), before, "The file is unchanged");
  is((await WhimsyFormDrafts.get({ url: PAGE, isPrivate: true }))?.data.id.message, MARKER, "Found in private");
  is(await WhimsyFormDrafts.get({ url: PAGE }), null, "Not offered to a normal tab");
  Services.obs.notifyObservers(null, "last-pb-context-exited");
  is(await WhimsyFormDrafts.get({ url: PAGE, isPrivate: true }), null, "Gone when private browsing ends");
});

add_task(async function test_seven_days() {
  const old = Date.now() - 8 * 24 * 60 * 60 * 1000;
  await WhimsyFormDrafts.put({ url: PAGE, data: draft(), time: old });
  is(await WhimsyFormDrafts.get({ url: PAGE }), null, "An 8-day-old draft isn't offered");
  await WhimsyFormDrafts.flush();
  const records = JSON.parse(await OSKeyStore.decrypt(JSON.parse(await fileText()).blob));
  is(records.length, 0, "and isn't written");
});

add_task(async function test_unreadable_file_is_discarded() {
  await IOUtils.writeUTF8(WhimsyFormDrafts.path, JSON.stringify({ version: 1, blob: "not-a-ciphertext" }));
  await WhimsyFormDrafts._dropMemoryForTests();
  is(await WhimsyFormDrafts.get({ url: PAGE }), null, "Nothing from a file that doesn't decrypt");
  ok(await WhimsyFormDrafts.put({ url: PAGE, data: draft() }), "Still stores");
  await WhimsyFormDrafts.flush();
  const records = JSON.parse(await OSKeyStore.decrypt(JSON.parse(await fileText()).blob));
  is(records.length, 1, "The bad file was replaced");
  await WhimsyFormDrafts.delete({ url: PAGE });
});

add_task(async function test_no_keystore_means_memory_only() {
  await WhimsyFormDrafts.flush();
  const before = await fileText();
  const realEncrypt = OSKeyStore.encrypt;
  OSKeyStore.encrypt = async () => {
    throw new Error("no keystore");
  };
  try {
    ok(await WhimsyFormDrafts.put({ url: PAGE, data: draft() }), "Kept for this session");
    await WhimsyFormDrafts.flush();
    is(await fileText(), before, "Never written in the clear");
    is((await WhimsyFormDrafts.get({ url: PAGE }))?.data.id.message, MARKER, "Offered this session");
  } finally {
    OSKeyStore.encrypt = realEncrypt;
  }
  await WhimsyFormDrafts.delete({ url: PAGE });
});

add_task(async function test_fire_erases_in_scope() {
  await WhimsyFormDrafts.put({ url: PAGE, data: draft() });
  await WhimsyFormDrafts.put({ url: "https://sub.example.com/a", data: draft() });
  await WhimsyFormDrafts.put({ url: "https://example.org/b", data: draft() });
  await WhimsyFormDrafts.put({ url: "https://example.net/c", data: draft(), isPrivate: true });
  await WhimsyFormDrafts.forgetSite("example.com");
  is(await WhimsyFormDrafts.get({ url: PAGE }), null, "The site's draft is gone");
  is(await WhimsyFormDrafts.get({ url: "https://sub.example.com/a" }), null, "and its subdomains'");
  ok(await WhimsyFormDrafts.get({ url: "https://example.org/b" }), "Another site keeps its draft");
  await WhimsyFormDrafts.forgetAll();
  is(await WhimsyFormDrafts.get({ url: "https://example.org/b" }), null, "Everything: gone");
  is(await WhimsyFormDrafts.get({ url: "https://example.net/c", isPrivate: true }), null, "Private too");
  ok(!(await IOUtils.exists(WhimsyFormDrafts.path)), "The file is deleted");
});

add_task(async function test_setting_off_stores_nothing_and_erases() {
  await WhimsyFormDrafts.put({ url: PAGE, data: draft() });
  Services.prefs.setBoolPref(SAVE_PREF, false);
  await TestUtils.waitForCondition(async () => !(await WhimsyFormDrafts.get({ url: PAGE })), "Turning it off erases");
  ok(!(await WhimsyFormDrafts.put({ url: PAGE, data: draft() })), "Off: nothing is stored");
  ok(!(await WhimsyFormDrafts.put({ url: PAGE, data: draft(), isPrivate: true })), "Not even in memory");
  Services.prefs.clearUserPref(SAVE_PREF);
  ok(await WhimsyFormDrafts.put({ url: PAGE, data: draft() }), "On again: stored");
  await WhimsyFormDrafts.forgetAll();
});
