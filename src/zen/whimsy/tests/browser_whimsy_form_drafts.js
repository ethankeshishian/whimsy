/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// R1 v2 (wave13/r1-v2-design.md §4, §6, §9): the encrypted draft store.
// Drafts are keyed by the address without its fragment and the container;
// normal ones are kept on disk as one OSKeyStore ciphertext, private ones in
// memory only; 7 days; Fire and the setting erase them.

const { WhimsyFormDrafts, WhimsyFormProtection } = ChromeUtils.importESModule(
  "resource:///modules/whimsy/WhimsyFormProtection.sys.mjs"
);
const { WhimsyFireButton } = ChromeUtils.importESModule(
  "resource:///modules/whimsy/WhimsyFireButton.sys.mjs"
);
const { OSKeyStore } = ChromeUtils.importESModule(
  "resource://gre/modules/OSKeyStore.sys.mjs"
);
const { OSKeyStoreTestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/OSKeyStoreTestUtils.sys.mjs"
);

const SAVE_PREF = "whimsy.forms.saveDrafts";
// Built by concatenation so no fixture looks like typed text in the tree.
// eslint-disable-next-line no-useless-concat
const MARKER = "whimsy" + "-draft-" + "marker-" + "7f3a";
const PAGE = "https://example.com/apply?job=1";
const ROOT = getRootDirectory(gTestPath).replace("chrome://mochitests/content/", "http://mochi.test:8888/");
const FORM_PAGE = ROOT + "whimsy_email_form.html";
const SENSITIVE_PAGE = ROOT + "whimsy_form_sensitive.html";

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

const typed = tab => tab.hasAttribute("whimsy-form-typed");

async function typeInto(browser, id, text) {
  await SpecialPowers.spawn(browser, [id], fieldId => content.document.getElementById(fieldId).focus());
  for (const key of text) {
    await BrowserTestUtils.synthesizeKey(key, {}, browser);
  }
}

function quitSubject() {
  const subject = Cc["@mozilla.org/supports-PRBool;1"].createInstance(Ci.nsISupportsPRBool);
  subject.data = false;
  return subject;
}

add_setup(async function () {
  OSKeyStoreTestUtils.setup();
  await WhimsyFormDrafts._resetForTests();
  await SpecialPowers.pushPrefEnv({ set: [["whimsy.feature.form-protection", true]] });
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
  // eslint-disable-next-line sdl/no-insecure-url -- the point of this assertion is that http != https
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

// ---- Real user paths (design §11): close, quit, reopen, Fire, filtering ----

add_task(async function test_real_cmd_w_closes_and_keeps_the_draft() {
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, FORM_PAGE);
  gBrowser.selectedTab = tab;
  await typeInto(tab.linkedBrowser, "name", "Ada");
  await TestUtils.waitForCondition(() => typed(tab), "Typed");
  await new Promise(resolve => setTimeout(resolve, 600)); // eslint-disable-line mozilla/no-arbitrary-setTimeout
  EventUtils.synthesizeKey("w", { accelKey: true }, window);
  await TestUtils.waitForCondition(() => !gBrowser.tabs.includes(tab), "⌘W closes at once, with no prompt");
  ok(await WhimsyFormDrafts.get({ url: FORM_PAGE }), "the store has the draft");
  await WhimsyFormDrafts.delete({ url: FORM_PAGE });
});

add_task(async function test_reopen_with_cmd_shift_t_offers_refill() {
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, FORM_PAGE);
  gBrowser.selectedTab = tab;
  await typeInto(tab.linkedBrowser, "name", "Grace");
  await TestUtils.waitForCondition(() => typed(tab), "Typed");
  await new Promise(resolve => setTimeout(resolve, 600)); // eslint-disable-line mozilla/no-arbitrary-setTimeout
  EventUtils.synthesizeKey("w", { accelKey: true }, window);
  await TestUtils.waitForCondition(() => !gBrowser.tabs.includes(tab), "Closed");
  await SimpleTest.promiseFocus(window);
  EventUtils.synthesizeKey("t", { accelKey: true, shiftKey: true });
  await TestUtils.waitForCondition(() => toastFor("whimsy-form-refill-ask"), "⌘⇧T reopen offers Refill");
  closeToasts();
  await WhimsyFormDrafts.delete({ url: FORM_PAGE });
});

// A different query string on revisit gets no offer (sameAddress §4).
add_task(async function test_revisit_different_query_gets_no_offer() {
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, FORM_PAGE);
  await typeInto(tab.linkedBrowser, "name", "Ada");
  await TestUtils.waitForCondition(() => typed(tab), "Typed");
  await new Promise(resolve => setTimeout(resolve, 600)); // eslint-disable-line mozilla/no-arbitrary-setTimeout
  try {
    const loaded = BrowserTestUtils.browserLoaded(tab.linkedBrowser);
    BrowserTestUtils.startLoadingURIString(tab.linkedBrowser, FORM_PAGE + "?other");
    await loaded;
    closeToasts();
    await new Promise(resolve => setTimeout(resolve, 500)); // eslint-disable-line mozilla/no-arbitrary-setTimeout
    is(toastFor("whimsy-form-refill-ask"), null, "A different query string: nothing offered");
  } finally {
    BrowserTestUtils.removeTab(tab);
    await WhimsyFormDrafts.delete({ url: FORM_PAGE });
  }
});

// Saving off, or a private tab: the first ⌘W warns and keeps the tab open;
// the second closes it. Nothing is written to disk for a private tab.
add_task(async function test_private_tab_close_warns_then_closes() {
  const { WhimsyPrivate } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyPrivate.sys.mjs");
  const before = await fileText();
  const tab = WhimsyPrivate.openPrivateTab(window, { url: FORM_PAGE, force: true });
  await TestUtils.waitForCondition(() => tab.linkedBrowser.currentURI?.spec == FORM_PAGE && !tab.hasAttribute("busy"),
    "The private tab loaded");
  gBrowser.selectedTab = tab;
  await typeInto(tab.linkedBrowser, "name", "Priv");
  await TestUtils.waitForCondition(() => typed(tab), "Typed");
  EventUtils.synthesizeKey("w", { accelKey: true }, window);
  await TestUtils.waitForCondition(() => toastFor("whimsy-form-close-warning"), "First ⌘W warns");
  ok(gBrowser.tabs.includes(tab), "and keeps the tab open");
  is(await fileText(), before, "The store file is unchanged");
  EventUtils.synthesizeKey("w", { accelKey: true }, window);
  await TestUtils.waitForCondition(() => !gBrowser.tabs.includes(tab), "A second ⌘W closes it");
  closeToasts();
});

add_task(async function test_setting_off_close_warns_then_closes() {
  await SpecialPowers.pushPrefEnv({ set: [[SAVE_PREF, false]] });
  try {
    const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, FORM_PAGE);
    await typeInto(tab.linkedBrowser, "name", "Ada");
    await TestUtils.waitForCondition(() => typed(tab), "Typed");
    EventUtils.synthesizeKey("w", { accelKey: true }, window);
    const toast = await TestUtils.waitForCondition(() => toastFor("whimsy-form-close-warning"), "Warns");
    await document.l10n.translateFragment(toast.element);
    ok(toast.element.querySelector("label").textContent.includes("Unsaved typing"), "says so");
    EventUtils.synthesizeKey("w", { accelKey: true }, window);
    await TestUtils.waitForCondition(() => !gBrowser.tabs.includes(tab), "A second ⌘W closes");
    is(await WhimsyFormDrafts.get({ url: FORM_PAGE }), null, "Nothing was stored (saving is off)");
    closeToasts();
  } finally {
    await SpecialPowers.popPrefEnv();
  }
});

// The toast's own Close button closes right away, without a second ⌘W.
add_task(async function test_close_warning_button_closes() {
  await SpecialPowers.pushPrefEnv({ set: [[SAVE_PREF, false]] });
  try {
    const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, FORM_PAGE);
    await typeInto(tab.linkedBrowser, "name", "Ada");
    await TestUtils.waitForCondition(() => typed(tab), "Typed");
    EventUtils.synthesizeKey("w", { accelKey: true }, window);
    const toast = await TestUtils.waitForCondition(() => toastFor("whimsy-form-close-warning"), "Warns");
    toast.element.querySelector(".whimsy-toast-button").click();
    await TestUtils.waitForCondition(() => !gBrowser.tabs.includes(tab), "The Close button closes it");
  } finally {
    await SpecialPowers.popPrefEnv();
  }
});

// ⌘Q (quit-application-requested, cancelled here instead of really
// quitting): saving on doesn't cancel; saving off with a typed tab cancels
// once and shows the toast; a second ⌘Q within the window isn't cancelled.
add_task(async function test_quit_warns_once_when_saving_off() {
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, FORM_PAGE);
  try {
    await typeInto(tab.linkedBrowser, "name", "Ada");
    await TestUtils.waitForCondition(() => typed(tab), "Typed");

    let subject = quitSubject();
    Services.obs.notifyObservers(subject, "quit-application-requested");
    ok(!subject.data, "Saving on: quitting isn't cancelled");

    await SpecialPowers.pushPrefEnv({ set: [[SAVE_PREF, false]] });
    subject = quitSubject();
    Services.obs.notifyObservers(subject, "quit-application-requested");
    ok(subject.data, "Saving off with a typed tab: the first ⌘Q is cancelled");
    const toast = await TestUtils.waitForCondition(() => toastFor("whimsy-form-quit-warning"), "and warns");
    await document.l10n.translateFragment(toast.element);
    ok(toast.element.querySelector("label").textContent.includes("unsaved typing"), "says so");

    subject = quitSubject();
    Services.obs.notifyObservers(subject, "quit-application-requested");
    ok(!subject.data, "A second ⌘Q within the window isn't cancelled");
    closeToasts();
  } finally {
    await SpecialPowers.popPrefEnv();
    BrowserTestUtils.removeTab(tab);
  }
});

// Sensitive fields (design §5): a password, card number, CVC, one-time
// code and an autocomplete=off "pin" field never reach the stored draft,
// even though the platform's own collector would otherwise keep some of
// them (an invalid-Luhn "card number" isn't skipped by Firefox itself).
add_task(async function test_sensitive_fields_never_stored() {
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, SENSITIVE_PAGE);
  try {
    await typeInto(tab.linkedBrowser, "message", "hello");
    await typeInto(tab.linkedBrowser, "cc-number", "4111111111111112");
    await typeInto(tab.linkedBrowser, "cc-csc", "123");
    await typeInto(tab.linkedBrowser, "otp", "000000");
    await typeInto(tab.linkedBrowser, "pin-code", "4321");
    await TestUtils.waitForCondition(() => typed(tab), "Typed (the plain field tracks)");
    await new Promise(resolve => setTimeout(resolve, 600)); // eslint-disable-line mozilla/no-arbitrary-setTimeout
    const got = await WhimsyFormDrafts.get({ url: SENSITIVE_PAGE });
    ok(got, "A draft was stored");
    Assert.deepEqual(Object.keys(got.data.id ?? {}), ["message"], "Only the plain field");
  } finally {
    BrowserTestUtils.removeTab(tab);
    await WhimsyFormDrafts.delete({ url: SENSITIVE_PAGE });
  }
});

// R1 v2 §7: an upgraded profile's old plaintext (SessionStore's formdata,
// and the pre-draft R1 snapshot) is stripped, from a live TabStateUpdate
// and from a freshly read session state alike.
add_task(async function test_upgrade_strips_old_plaintext() {
  const state = {
    windows: [{ tabs: [{ formdata: { id: { x: MARKER } }, extData: { "whimsy-formdata": "{}" } }] }],
    _closedWindows: [{ tabs: [{ formdata: { id: { y: MARKER } } }] }],
    _closedTabs: [{ state: { formdata: { id: { z: MARKER } } } }],
  };
  WhimsyFormDrafts.stripSessionState(state);
  ok(!("formdata" in state.windows[0].tabs[0]), "an open tab's formdata is stripped");
  ok(!("whimsy-formdata" in state.windows[0].tabs[0].extData), "and the old R1 snapshot");
  ok(!("formdata" in state._closedWindows[0].tabs[0]), "a closed window's tab is stripped");
  ok(!("formdata" in state._closedTabs[0].state), "a closed tab is stripped");

  const update = { data: { formdata: { id: { w: MARKER } }, scroll: {} } };
  WhimsyFormDrafts.stripSessionUpdate(update);
  ok(!("formdata" in update.data), "a live TabStateUpdate is stripped too");
  ok("scroll" in update.data, "other fields are untouched");
});
