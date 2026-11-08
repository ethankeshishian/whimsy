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
const { SessionSaver } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sessionstore/SessionSaver.sys.mjs"
);
const { TabStateFlusher } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sessionstore/TabStateFlusher.sys.mjs"
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
    // The ⌘W tests can close the space's only ordinary tab; later files expect one.
    if (!gBrowser.tabs.some(t => !t.hasAttribute("zen-empty-tab") && !t.closing)) {
      await BrowserTestUtils.openNewForegroundTab(gBrowser, "about:blank");
    }
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

// The store-level test above drives forgetSite/forgetAll directly. This one
// drives the real Fire burn functions (WhimsyFireButton), the same template
// as test_burn_profile_is_per_profile / test_fire_leaves_nothing_restorable:
// stub allTabs/profileTabs and the side-effect helpers so the real burn
// touches at most one extra tab, and prove each scope clears only its own
// drafts and leaves every other draft alone.
add_task(async function test_fire_burns_clear_matching_drafts_only() {
  const mine = WhimsyFireButton.profileId(window);
  const other = mine + 101;
  const SITE1 = "https://example.com/?fire-drafts-1";
  const SITE2 = "https://example.org/?fire-drafts-2";

  async function seedFour() {
    await WhimsyFormDrafts.put({ url: SITE1, data: draft(), userContextId: mine });
    await WhimsyFormDrafts.put({ url: SITE1, data: draft(), userContextId: other });
    await WhimsyFormDrafts.put({ url: SITE2, data: draft(), userContextId: mine });
    await WhimsyFormDrafts.put({ url: SITE2, data: draft(), userContextId: other });
  }

  // ---- burnSite: clears SITE1 in every container, leaves SITE2 alone ----
  await seedFour();
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, SITE1);
  const originalAllTabs = WhimsyFireButton.allTabs;
  WhimsyFireButton.allTabs = () => [[window, [tab]]];
  try {
    await WhimsyFireButton.burnSite(window);
    is(await WhimsyFormDrafts.get({ url: SITE1, userContextId: mine }), null,
      "burnSite: this container's draft on the site is gone");
    is(await WhimsyFormDrafts.get({ url: SITE1, userContextId: other }), null,
      "...and another container's draft on the same site");
    ok(await WhimsyFormDrafts.get({ url: SITE2, userContextId: mine }),
      "A different site's draft stays, this container");
    ok(await WhimsyFormDrafts.get({ url: SITE2, userContextId: other }),
      "...and another container");
  } finally {
    WhimsyFireButton.allTabs = originalAllTabs;
    if (tab.isConnected) {
      BrowserTestUtils.removeTab(tab);
    }
    await TestUtils.waitForCondition(() => !tab.isConnected, "The site tab is gone");
  }
  await WhimsyFormDrafts.forgetAll();

  // ---- burnProfile: clears only `mine`'s container, on every site ----
  await seedFour();
  const originalProfileTabs = WhimsyFireButton.profileTabs;
  const originalProfileVisits = WhimsyFireButton.profileVisits;
  const originalClearSiteData = WhimsyFireButton.clearSiteData;
  const originalRemoveVisit = WhimsyFireButton.removeVisit;
  WhimsyFireButton.profileTabs = () => [];
  WhimsyFireButton.profileVisits = async () => [];
  WhimsyFireButton.clearSiteData = async () => {};
  WhimsyFireButton.removeVisit = async () => {};
  try {
    await WhimsyFireButton.burnProfile(window);
    is(await WhimsyFormDrafts.get({ url: SITE1, userContextId: mine }), null,
      "burnProfile: this container's draft is gone");
    is(await WhimsyFormDrafts.get({ url: SITE2, userContextId: mine }), null,
      "...on every site it was on");
    ok(await WhimsyFormDrafts.get({ url: SITE1, userContextId: other }),
      "Another container's draft on the same site stays");
    ok(await WhimsyFormDrafts.get({ url: SITE2, userContextId: other }),
      "...and on a different site");
  } finally {
    WhimsyFireButton.profileTabs = originalProfileTabs;
    WhimsyFireButton.profileVisits = originalProfileVisits;
    WhimsyFireButton.clearSiteData = originalClearSiteData;
    WhimsyFireButton.removeVisit = originalRemoveVisit;
  }
  await WhimsyFormDrafts.forgetAll();

  // ---- burnEverything: clears every draft, private ones included ----
  await seedFour();
  await WhimsyFormDrafts.put({ url: SITE1, data: draft(), userContextId: mine, isPrivate: true });
  const originalAllTabs2 = WhimsyFireButton.allTabs;
  const originalClearData = WhimsyFireButton.clearData;
  const originalClearFormHistory = WhimsyFireButton.clearFormHistory;
  WhimsyFireButton.allTabs = () => [];
  WhimsyFireButton.clearData = async () => {};
  WhimsyFireButton.clearFormHistory = async () => {};
  try {
    await WhimsyFireButton.burnEverything(window);
    for (const userContextId of [mine, other]) {
      for (const url of [SITE1, SITE2]) {
        is(await WhimsyFormDrafts.get({ url, userContextId }), null,
          `burnEverything: ${url} is gone for container ${userContextId}`);
      }
    }
    is(await WhimsyFormDrafts.get({ url: SITE1, userContextId: mine, isPrivate: true }), null,
      "...the private one too");
    ok(!(await IOUtils.exists(WhimsyFormDrafts.path)), "The drafts file is gone");
  } finally {
    WhimsyFireButton.allTabs = originalAllTabs2;
    WhimsyFireButton.clearData = originalClearData;
    WhimsyFireButton.clearFormHistory = originalClearFormHistory;
  }
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
  const toast = await TestUtils.waitForCondition(() => toastFor("whimsy-form-refill-ask"), "⌘⇧T reopen offers Restore");
  await toast.shown;
  await document.l10n.translateFragment(toast.element);
  const restore = toast.element.querySelector(".whimsy-toast-button");
  is(restore.textContent, "Restore", "The button says Restore");
  EventUtils.synthesizeMouseAtCenter(restore, {});
  const reopenedBrowser = gBrowser.selectedBrowser;
  await TestUtils.waitForCondition(async () =>
    (await SpecialPowers.spawn(reopenedBrowser, [], () => content.document.getElementById("name").value)) == "Grace",
  "Restore fills the reopened tab back in");
  closeToasts();
  // ⌘⇧T reopens the just-closed tab via session restore (a new tab, not
  // `tab`, which is already gone): close it too and wait for the close to
  // actually finish, or it lingers into later tests/files that check for
  // no tab left at FORM_PAGE (e.g. form_protection.js's test_switch_off).
  const reopened = gBrowser.tabs.find(t => t.linkedBrowser?.currentURI?.spec == FORM_PAGE);
  if (reopened) {
    BrowserTestUtils.removeTab(reopened);
    await TestUtils.waitForCondition(() => !gBrowser.tabs.includes(reopened), "The reopened tab finished closing");
  }
  await WhimsyFormDrafts.delete({ url: FORM_PAGE });
});

// W16-5: a React-style form (controlled text fields keep their value
// attribute in step with what's typed, which Gecko's collector takes for
// "unchanged"): every field comes back, and the framework sees the refill.
add_task(async function test_controlled_form_restores_every_field() {
  const page = ROOT + "whimsy_form_controlled.html";
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, page);
  gBrowser.selectedTab = tab;
  const browser = tab.linkedBrowser;
  await typeInto(browser, "first-name", "Ada");
  await typeInto(browser, "email", "ada@example.com");
  await typeInto(browser, "message", "Hello there");
  await typeInto(browser, "company", "Engines");
  await SpecialPowers.spawn(browser, [], () => content.document.getElementById("subject").focus());
  await BrowserTestUtils.synthesizeKey("s", {}, browser);
  await SpecialPowers.spawn(browser, [], () => content.document.getElementById("newsletter").focus());
  await BrowserTestUtils.synthesizeKey(" ", {}, browser);
  const typedNow = await SpecialPowers.spawn(browser, [], () => {
    const doc = content.document;
    return {
      attr: doc.getElementById("first-name").getAttribute("value"),
      subject: doc.getElementById("subject").value,
      newsletter: doc.getElementById("newsletter").checked,
    };
  });
  is(typedNow.attr, "Ada", "The page keeps the value attribute in step, as React does");
  is(typedNow.subject, "sales", "A subject is picked");
  ok(typedNow.newsletter, "The box is ticked");
  await TestUtils.waitForCondition(() => typed(tab), "Typed");
  await new Promise(resolve => setTimeout(resolve, 600)); // eslint-disable-line mozilla/no-arbitrary-setTimeout
  EventUtils.synthesizeKey("w", { accelKey: true }, window);
  await TestUtils.waitForCondition(() => !gBrowser.tabs.includes(tab), "Closed");
  await SimpleTest.promiseFocus(window);
  EventUtils.synthesizeKey("t", { accelKey: true, shiftKey: true });
  const toast = await TestUtils.waitForCondition(() => toastFor("whimsy-form-refill-ask"), "⌘⇧T reopen offers Restore");
  await toast.shown;
  await document.l10n.translateFragment(toast.element);
  ok(toast.element.textContent.includes("6 fields"), `The toast counts all six fields (${toast.element.textContent})`);
  const reopenedBrowser = gBrowser.selectedBrowser;
  EventUtils.synthesizeMouseAtCenter(toast.element.querySelector(".whimsy-toast-button"), {});
  await TestUtils.waitForCondition(async () =>
    (await SpecialPowers.spawn(reopenedBrowser, [], () => content.document.getElementById("company").value)) == "Engines",
  "Restore fills the form back in");
  const back = await SpecialPowers.spawn(reopenedBrowser, [], () => {
    const doc = content.document;
    return {
      first: doc.getElementById("first-name").value,
      email: doc.getElementById("email").value,
      message: doc.getElementById("message").value,
      subject: doc.getElementById("subject").value,
      newsletter: doc.getElementById("newsletter").checked,
      company: doc.getElementById("company").value,
      seen: { ...content.wrappedJSObject.reactSeen },
    };
  });
  Assert.deepEqual(
    { first: back.first, email: back.email, message: back.message, subject: back.subject, newsletter: back.newsletter, company: back.company },
    { first: "Ada", email: "ada@example.com", message: "Hello there", subject: "sales", newsletter: true, company: "Engines" },
    "Every field is back");
  Assert.deepEqual(back.seen, { "first-name": "Ada", email: "ada@example.com", company: "Engines" },
    "…and the page's own input handlers saw each refill");
  closeToasts();
  const reopened = gBrowser.tabs.find(t => t.linkedBrowser?.currentURI?.spec == page);
  if (reopened) {
    BrowserTestUtils.removeTab(reopened);
    await TestUtils.waitForCondition(() => !gBrowser.tabs.includes(reopened), "The reopened tab finished closing");
  }
  await WhimsyFormDrafts.delete({ url: page });
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
  await WhimsyPrivate.closeScratch(window);
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
    ok(!toast.element.textContent.includes("·"), "W16-6: no · separator in the close warning");
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
    await toast.shown;
    await document.l10n.translateFragment(toast.element);
    const button = toast.element.querySelector(".whimsy-toast-button");
    is(button.textContent, "Close", "The button says Close");
    EventUtils.synthesizeMouseAtCenter(button, {});
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
    ok(!toast.element.textContent.includes("·"), "W16-6: no · separator in the quit warning");
    is(toast.element.querySelector(".whimsy-toast-button").textContent, "Quit", "The button says Quit");

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

// R1 v2 §7, §11: typed text never reaches disk in plaintext, whatever
// SessionStore does with it. A real keystroke, a forced flush and a forced
// SessionStore write, then every session file and the draft file itself are
// read back and searched for the marker.
add_task(async function test_no_plaintext_on_disk_anywhere() {
  // Built by concatenation so no fixture or grep sees typed-looking text.
  // eslint-disable-next-line no-useless-concat
  const plainMarker = "wh" + "imsy-plain-" + Date.now();

  Services.prefs.setIntPref("browser.sessionstore.interval", 10000000);
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, FORM_PAGE);
  try {
    gBrowser.selectedTab = tab;
    await typeInto(tab.linkedBrowser, "name", plainMarker);
    await TestUtils.waitForCondition(() => typed(tab), "Typed");
    await TestUtils.waitForCondition(
      async () => (await WhimsyFormDrafts.get({ url: FORM_PAGE }))?.data?.id?.name == plainMarker,
      "The draft reached the parent store"
    );
    await WhimsyFormDrafts.flush();

    // Force SessionStore to actually write: flush the content process's
    // pending TabStateUpdate into the parent cache, then run a full save.
    await TabStateFlusher.flush(tab.linkedBrowser);
    await SessionSaver.run();

    const sessionPaths = [
      PathUtils.join(PathUtils.profileDir, "sessionstore-backups", "recovery.jsonlz4"),
      PathUtils.join(PathUtils.profileDir, "sessionstore-backups", "recovery.baklz4"),
      PathUtils.join(PathUtils.profileDir, "sessionstore-backups", "previous.jsonlz4"),
      PathUtils.join(PathUtils.profileDir, "sessionstore.jsonlz4"),
    ];
    for (const path of sessionPaths) {
      if (!(await IOUtils.exists(path))) {
        continue;
      }
      const text = await IOUtils.readUTF8(path, { decompress: true });
      ok(!text.includes(plainMarker), `No plaintext marker in ${path}`);
    }

    const draftText = await fileText();
    ok(draftText, "The draft file was written");
    ok(!draftText.includes(plainMarker), "The draft file holds no plaintext marker; ciphertext only");
  } finally {
    BrowserTestUtils.removeTab(tab);
    await TestUtils.waitForCondition(() => !gBrowser.tabs.includes(tab), "The tab finished closing");
    await WhimsyFormDrafts.delete({ url: FORM_PAGE });
    Services.prefs.clearUserPref("browser.sessionstore.interval");
  }
});

// A private window's draft lives in memory only (§6): typing in one must
// never create, or change, the drafts file.
add_task(async function test_private_window_draft_never_touches_disk() {
  await WhimsyFormDrafts.flush(); // settle any earlier test's debounced write first
  const before = await fileText();
  const win = await BrowserTestUtils.openNewBrowserWindow({ private: true });
  try {
    const privTab = await BrowserTestUtils.openNewForegroundTab(win.gBrowser, FORM_PAGE);
    win.gBrowser.selectedTab = privTab;
    // eslint-disable-next-line no-useless-concat
    await typeInto(privTab.linkedBrowser, "name", "wh" + "imsy-private-" + Date.now());
    await TestUtils.waitForCondition(() => typed(privTab), "Typed in the private window");
    await new Promise(resolve => setTimeout(resolve, 600)); // eslint-disable-line mozilla/no-arbitrary-setTimeout
    is(await fileText(), before, "The drafts file is untouched by a private window's typing");
    if (before == null) {
      ok(!(await IOUtils.exists(WhimsyFormDrafts.path)), "and was never created");
    }
  } finally {
    await BrowserTestUtils.closeWindow(win);
    await SimpleTest.promiseFocus(window);
  }
});

// W14 21.10: fields with no id (most real forms use name) are saved and
// restored: ⌘W, ⌘⇧T, Restore.
add_task(async function test_fields_without_an_id_restore() {
  const page = ROOT + "whimsy_form_noid.html";
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, page);
  gBrowser.selectedTab = tab;
  await SpecialPowers.spawn(tab.linkedBrowser, [], () => content.document.querySelector("[name=city]").focus());
  for (const key of "Oslo") {
    await BrowserTestUtils.synthesizeKey(key, {}, tab.linkedBrowser);
  }
  await TestUtils.waitForCondition(() => typed(tab), "Typed");
  await TestUtils.waitForCondition(async () => (await WhimsyFormDrafts.get({ url: page }))?.data, "Saved, though the field has no id");
  EventUtils.synthesizeKey("w", { accelKey: true }, window);
  await TestUtils.waitForCondition(() => !gBrowser.tabs.includes(tab), "Closed");
  await SimpleTest.promiseFocus(window);
  EventUtils.synthesizeKey("t", { accelKey: true, shiftKey: true });
  const toast = await TestUtils.waitForCondition(() => toastFor("whimsy-form-refill-ask"), "⌘⇧T offers Restore");
  await toast.shown;
  await document.l10n.translateFragment(toast.element);
  is(toast.element.querySelector(".description")?.textContent, "1 field on this page", "It counts the field");
  const reopened = gBrowser.selectedBrowser;
  EventUtils.synthesizeMouseAtCenter(toast.element.querySelector(".whimsy-toast-button"), {});
  await TestUtils.waitForCondition(async () =>
    (await SpecialPowers.spawn(reopened, [], () => content.document.querySelector("[name=city]").value)) == "Oslo",
  "Restore fills the field with no id");
  closeToasts();
  BrowserTestUtils.removeTab(gBrowser.getTabForBrowser(reopened));
  await WhimsyFormDrafts.delete({ url: page });
});

// A Keychain prompt nobody answers (unlock, or "allow access" for a rebuilt
// app) must not hold up quitting: the shutdown write gives up after a moment.
add_task(async function test_shutdown_write_is_bounded() {
  await WhimsyFormDrafts.flush();
  const before = await fileText();
  const realLogin = OSKeyStore.ensureLoggedIn;
  const realBound = WhimsyFormDrafts._shutdownMs;
  const prompt = Promise.withResolvers();
  OSKeyStore.ensureLoggedIn = () => prompt.promise;
  WhimsyFormDrafts._shutdownMs = 200;
  try {
    ok(await WhimsyFormDrafts.put({ url: PAGE, data: draft() }), "Stored");
    const start = Date.now();
    await WhimsyFormDrafts.flushAtShutdown();
    Assert.less(Date.now() - start, 2000, "Quitting waits a moment, not for the prompt");
    is(await fileText(), before, "The file on disk is the previous one");
  } finally {
    OSKeyStore.ensureLoggedIn = realLogin;
    WhimsyFormDrafts._shutdownMs = realBound;
    prompt.resolve({ authenticated: true });
  }
  await WhimsyFormDrafts.flush();
  await WhimsyFormDrafts.delete({ url: PAGE });
  await WhimsyFormDrafts.flush();
});

// Fire ("Forget All") calls forgetAll() directly, not at shutdown: an
// unanswered Keychain prompt must not hold that up either.
add_task(async function test_forget_all_write_is_bounded() {
  const realLogin = OSKeyStore.ensureLoggedIn;
  const realBound = WhimsyFormDrafts._shutdownMs;
  const prompt = Promise.withResolvers();
  OSKeyStore.ensureLoggedIn = () => prompt.promise;
  WhimsyFormDrafts._shutdownMs = 200;
  let flushing;
  try {
    ok(await WhimsyFormDrafts.put({ url: PAGE, data: draft() }), "Stored");
    // Starts the write that hangs on the prompt; forgetAll() has to wait on
    // this same in-flight write (it reaches the Keychain too).
    flushing = WhimsyFormDrafts.flush();
    dump("WDBG test before waitForCondition writing=" + !!WhimsyFormDrafts._writing + "\n");
    await TestUtils.waitForCondition(() => WhimsyFormDrafts._writing, "The write starts");
    dump("WDBG test after waitForCondition\n");
    const start = Date.now();
    dump("WDBG test before forgetAll\n");
    await WhimsyFormDrafts.forgetAll();
    dump("WDBG test after forgetAll\n");
    Assert.less(Date.now() - start, 2000, "Fire doesn't wait for the prompt");
    is(await fileText(), null, "The file is gone");
  } finally {
    OSKeyStore.ensureLoggedIn = realLogin;
    WhimsyFormDrafts._shutdownMs = realBound;
    prompt.resolve({ authenticated: true });
    // The write forgetAll() didn't wait for still lands once the prompt
    // answers, with the pre-forgetAll draft: put it back to a clean slate
    // rather than leave that stale file for the next test.
    await flushing;
    await WhimsyFormDrafts._resetForTests();
  }
});

// Tests never reach the person's real Keychain item (head.js).
add_task(async function test_tests_use_a_throwaway_keystore() {
  ok(OSKeyStore.STORE_LABEL.startsWith("test-"), "A throwaway Keychain item");
});
