/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// Form protection, W13-R1 (design: whimsy-handoff/wave13/r1-forms-design.md),
// then R1 v2 (save instead of ask: wave13/r1-v2-design.md). This file keeps
// what "unsaved input" means and the refill offer; the close/quit warning
// toast and the draft store live in browser_whimsy_form_drafts.js. Every
// test drives the real path: real key events into a real page, pages that
// fill themselves by script, an editor that autosaves to a .sjs, a site
// with its own beforeunload, pinned ⌘W, and the refill offer after a reload.

const { WhimsyFormProtection, WhimsyFormDrafts } = ChromeUtils.importESModule(
  "resource:///modules/whimsy/WhimsyFormProtection.sys.mjs"
);
const { OSKeyStoreTestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/OSKeyStoreTestUtils.sys.mjs"
);
const { WhimsyArchive } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyArchive.sys.mjs");
const { TabStateCache } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sessionstore/TabStateCache.sys.mjs"
);
const { TabStateFlusher } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sessionstore/TabStateFlusher.sys.mjs"
);

const ROOT = getRootDirectory(gTestPath).replace("chrome://mochitests/content/", "http://mochi.test:8888/");
const FORM_PAGE = ROOT + "whimsy_email_form.html";
const R1_PAGE = ROOT + "whimsy_form_r1.html";
const SCRIPT_PAGE = ROOT + "whimsy_script_form.html";
const AUTOSAVE_PAGE = ROOT + "whimsy_form_autosave.html";
const GUARDED_PAGE = ROOT + "whimsy_form_beforeunload.html";
const SAVE_URL = ROOT + "whimsy_form_save.sjs";

const typed = tab => tab.hasAttribute("whimsy-form-typed");

async function typeInto(browser, id, text) {
  await SpecialPowers.spawn(browser, [id], fieldId => content.document.getElementById(fieldId).focus());
  for (const key of text) {
    await BrowserTestUtils.synthesizeKey(key, {}, browser);
  }
}

// Asks the page itself; the actor's earlier reports reach the parent first.
function askPage(browser) {
  return browser.browsingContext.currentWindowGlobal.getActor("WhimsyFormProtection").sendQuery("Whimsy:FormIsDirty");
}

async function savesSoFar() {
  return Number(await (await fetch(SAVE_URL + "?count")).text());
}

add_setup(async function () {
  OSKeyStoreTestUtils.setup();
  await SpecialPowers.pushPrefEnv({
    set: [
      ["whimsy.feature.form-protection", true],
      ["whimsy.feature.auto-archive-tabs", true],
      ["whimsy.tabs.archive.idle-after", "12h"],
      ["zen.pinned-tab-manager.close-shortcut-behavior", "reset-unload-switch"],
      ["dom.serviceWorkers.enabled", true],
      ["dom.serviceWorkers.testing.enabled", true],
    ],
  });
});

// Protect This Tab: auto-archive exemption and a lock, never the form
// dialog (old code asked "You started a form…" for it).
add_task(async function test_manual_protection() {
  const cmd = document.getElementById(WhimsyFormProtection.COMMAND_ID);
  ok(cmd, "Protect command is registered");
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, FORM_PAGE);
  const other = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.com/?other");
  try {
    gBrowser.selectedTab = tab;
    cmd.doCommand();
    ok(tab.hasAttribute("whimsy-form-protected"), "Protected by hand");
    ok(WhimsyArchive.isSweepExempt(tab), "and exempt from the sweep");
    const marker = tab.querySelector(".whimsy-tab-form-marker");
    is(marker?.getAttribute("kind"), "lock", "Its lock shows");
    await document.l10n.translateFragment(marker);
    is(marker.getAttribute("aria-label"), "Protected tab", "labelled");

    gBrowser.selectedTab = other;
    const result = await gBrowser.explicitUnloadTabs([tab]);
    ok(result, "Unloading a tab protected by hand unloads, without asking");
    tab._whimsyFormManual = false;
    WhimsyFormProtection.refreshTab(tab);
  } finally {
    BrowserTestUtils.removeTab(tab);
    BrowserTestUtils.removeTab(other);
  }
});

// Review design-full-4 L5: the command bar says Protect or Stop Protecting.
add_task(async function test_command_variants() {
  const { globalActions } = ChromeUtils.importESModule("resource:///modules/ZenUBGlobalActions.sys.mjs");
  const action = id => globalActions.find(a => a.l10nId == id);
  await BrowserTestUtils.withNewTab(FORM_PAGE, async browser => {
    const tab = gBrowser.getTabForBrowser(browser);
    ok(action("whimsy-action-protect-form-on")?.isAvailable(window), "Offers Protect on an unprotected tab");
    ok(!action("whimsy-action-protect-form-off")?.isAvailable(window), "No Stop Protecting yet");
    document.getElementById(WhimsyFormProtection.COMMAND_ID).doCommand();
    ok(tab.hasAttribute("whimsy-form-protected"), "Protected");
    ok(action("whimsy-action-protect-form-off")?.isAvailable(window), "Stop Protecting is offered");
    // Protection by hand survives a navigation in the tab.
    BrowserTestUtils.startLoadingURIString(browser, FORM_PAGE + "?again");
    await BrowserTestUtils.browserLoaded(browser);
    ok(tab.hasAttribute("whimsy-form-protected"), "Still protected after navigating");
    document.getElementById(WhimsyFormProtection.COMMAND_ID).doCommand();
    ok(!tab.hasAttribute("whimsy-form-protected"), "Stop Protecting clears it");
  });
});

// Real typing marks the tab; going back to what the field held before
// (here a draft the page restored by script) clears it. Old code compared
// with the HTML default ("") and stayed marked.
add_task(async function test_typing_and_reverting() {
  await BrowserTestUtils.withNewTab(R1_PAGE, async browser => {
    const tab = gBrowser.getTabForBrowser(browser);
    await SpecialPowers.spawn(browser, [], () =>
      ContentTaskUtils.waitForCondition(() => content.document.body.dataset.ready == "true", "Draft restored"));
    await typeInto(browser, "draft", "x");
    await TestUtils.waitForCondition(() => typed(tab), "Typing marks the tab");
    ok(tab.hasAttribute("whimsy-form-protected"), "protected");
    ok(tab.undiscardable, "and never discarded automatically");
    const tip = gBrowser.getTabTooltip(tab, true);
    ok(tip.includes("unsent form text"), "The tooltip says why");

    await BrowserTestUtils.synthesizeKey("KEY_Backspace", {}, browser);
    is(await askPage(browser), false, "Back to the restored draft: nothing unsaved");
    await TestUtils.waitForCondition(() => !typed(tab), "The mark goes");
    ok(!tab.hasAttribute("whimsy-form-protected"), "not protected");
    ok(!tab.undiscardable, "discardable again");
  });
});

// F33: a page that fills its own fields and editor is not a form in
// progress, even once Firefox's session copy of the form has landed
// (old code counted that copy as typing), and pinned ⌘W resets it at once.
add_task(async function test_site_filled_fields_never_count() {
  const other = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.com/?other");
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, SCRIPT_PAGE);
  const browser = tab.linkedBrowser;
  try {
    await SpecialPowers.spawn(browser, [], () =>
      ContentTaskUtils.waitForCondition(() => content.document.body.dataset.filled == "true", "The page filled itself"));
    await TabStateFlusher.flush(browser);
    ok(!TabStateCache.get(browser.permanentKey)?.formdata, "R1 v2 §7: SessionStore's own copy is stripped too, script-filled or not");
    is(await askPage(browser), false, "The page says nothing is unsaved");
    ok(!typed(tab) && !WhimsyFormProtection.isFormProtected(tab), "The tab isn't marked or protected");

    gBrowser.pinTab(tab);
    gBrowser.selectedTab = tab;
    EventUtils.synthesizeKey("w", { accelKey: true }, window);
    await TestUtils.waitForCondition(() => tab.hasAttribute("pending"), "Pinned ⌘W unloads it at once, without asking");
  } finally {
    BrowserTestUtils.removeTab(tab);
    BrowserTestUtils.removeTab(other);
  }
});

// Search boxes never count (old code counted type=search and name=q).
add_task(async function test_search_fields_never_count() {
  await BrowserTestUtils.withNewTab(R1_PAGE, async browser => {
    const tab = gBrowser.getTabForBrowser(browser);
    for (const id of ["search", "q", "site-find"]) {
      await typeInto(browser, id, "cats");
      is(await askPage(browser), false, `#${id} is a search box`);
    }
    ok(!typed(tab), "The tab isn't marked");
  });
});

// Typing into a contenteditable editor counts; deleting it all clears it.
add_task(async function test_contenteditable_typing_counts() {
  await BrowserTestUtils.withNewTab(R1_PAGE, async browser => {
    const tab = gBrowser.getTabForBrowser(browser);
    await typeInto(browser, "editor", "Dear team");
    await TestUtils.waitForCondition(() => typed(tab), "Typing into an editor marks the tab");
    for (let i = 0; i < "Dear team".length; i++) {
      await BrowserTestUtils.synthesizeKey("KEY_Backspace", {}, browser);
    }
    await TestUtils.waitForCondition(async () => !(await askPage(browser)), "Deleted again: nothing unsaved");
    await TestUtils.waitForCondition(() => !typed(tab), "The mark goes");
  });
});

// An editor that saves as you type (Sheets, Docs, beehiiv): its own POST
// after the edit is the save. Old code kept the tab marked forever.
add_task(async function test_autosave_clears() {
  await fetch(SAVE_URL + "?reset");
  const other = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.com/?other");
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, AUTOSAVE_PAGE);
  const browser = tab.linkedBrowser;
  try {
    await typeInto(browser, "body", "Weekly letter");
    await TestUtils.waitForCondition(async () => (await savesSoFar()) >= 1, "The page saved to its server");
    await TestUtils.waitForCondition(() => !typed(tab), "The save clears the mark");
    is(await askPage(browser), false, "Nothing unsaved");

    gBrowser.selectedTab = other;
    ok(await gBrowser.explicitUnloadTabs([tab]), "Unloads, without asking");
  } finally {
    BrowserTestUtils.removeTab(tab);
    BrowserTestUtils.removeTab(other);
  }
});

// Every way a site saves as you type clears the mark, the same on every
// site (no site list; design §2): fetch, sendBeacon, a WebSocket, a fetch a
// service worker intercepts (passed on, or answered and queued), a save the service worker makes itself, and a
// contenteditable editor syncing over a socket (Sheets-style). A page that
// never saves keeps the mark.
const SAVES_PAGE = ROOT + "whimsy_form_saves.html";
for (const [via, field] of [
  ["fetch", "body"],
  ["beacon", "body"],
  ["ws", "body"],
  ["sw-fetch", "body"],
  ["sw-queue", "body"],
  ["sw-message", "body"],
  ["ws", "editor"],
]) {
  add_task(async function test_site_saves_clear() {
    info(`Saving through ${via}, typing in #${field}`);
    const other = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.com/?other");
    const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, `${SAVES_PAGE}?via=${via}`);
    const browser = tab.linkedBrowser;
    try {
      await TestUtils.waitForCondition(() => SpecialPowers.spawn(browser, [], () => content.wrappedJSObject.ready), "The page is ready");
      await typeInto(browser, field, "Weekly letter");
      await TestUtils.waitForCondition(
        () => SpecialPowers.spawn(browser, [], () => content.wrappedJSObject.saves),
        `The page saved through ${via}`
      );
      await TestUtils.waitForCondition(() => !typed(tab), "The save clears the mark");
      is(await askPage(browser), false, "Nothing unsaved");
      gBrowser.selectedTab = other;
      ok(await gBrowser.explicitUnloadTabs([tab]), "Unloads, without asking");
    } finally {
      BrowserTestUtils.removeTab(tab);
      BrowserTestUtils.removeTab(other);
    }
  });
}

// R1 v2 §3: Unload (gBrowser.explicitUnloadTabs) never warns, whatever the
// page's own saving: the draft already holds the typing continuously.
add_task(async function test_page_that_never_saves_keeps_the_mark_but_unload_never_asks() {
  const other = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.com/?other");
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, `${SAVES_PAGE}?via=none`);
  const browser = tab.linkedBrowser;
  try {
    await TestUtils.waitForCondition(() => SpecialPowers.spawn(browser, [], () => content.wrappedJSObject.ready), "The page is ready");
    await typeInto(browser, "editor", "Never saved");
    await TestUtils.waitForCondition(() => typed(tab), "Typed");
    await new Promise(resolve => setTimeout(resolve, 1000)); // eslint-disable-line mozilla/no-arbitrary-setTimeout
    ok(typed(tab), "Still marked a second later");
    gBrowser.selectedTab = other;
    ok(await gBrowser.explicitUnloadTabs([tab]), "Unload still goes through, without asking");
  } finally {
    BrowserTestUtils.removeTab(tab);
    BrowserTestUtils.removeTab(other);
  }
});

// A submitted form is saved. Old code kept the tab marked.
add_task(async function test_submit_clears() {
  await BrowserTestUtils.withNewTab(R1_PAGE, async browser => {
    const tab = gBrowser.getTabForBrowser(browser);
    await typeInto(browser, "name", "Ada");
    await TestUtils.waitForCondition(() => typed(tab), "Typed");
    await BrowserTestUtils.synthesizeKey("KEY_Enter", {}, browser);
    await TestUtils.waitForCondition(() => !typed(tab), "Submitting clears the mark");
    ok(!(await WhimsyFormProtection.snapshotFor(browser, R1_PAGE)), "and leaves nothing to offer back");
  });
});

// A site with its own beforeunload decides for itself: no Whimsy warning,
// so never two. ⌘Q/Unload still never block on it either.
add_task(async function test_site_beforeunload_owns_the_decision() {
  const other = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.com/?other");
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, GUARDED_PAGE);
  try {
    await typeInto(tab.linkedBrowser, "name", "Ada");
    await TestUtils.waitForCondition(() => typed(tab), "Typed (the marker still shows)");
    ok(tab.linkedBrowser.hasBeforeUnload, "The page has its own guard");
    gBrowser.selectedTab = other;
    ok(await gBrowser.explicitUnloadTabs([tab]), "Unloads (the site didn't object), without asking");
  } finally {
    BrowserTestUtils.removeTab(tab);
    BrowserTestUtils.removeTab(other);
  }
});

// F29 (the user's pick B): an 11px pencil with no backing, inside the
// Essential's tile and at the end of a row, hidden while the row is hovered
// (the close button takes its place), and inside the tile in the collapsed
// sidebar. Old code drew a disc outside the tile's corner.
add_task(async function test_marker_inside_tile_and_row() {
  const essential = await BrowserTestUtils.openNewForegroundTab(gBrowser, FORM_PAGE);
  gZenPinnedTabManager.addToEssentials(essential);
  await TestUtils.waitForCondition(() => essential.hasAttribute("zen-essential"), "An Essential");
  const row = await BrowserTestUtils.openNewForegroundTab(gBrowser, FORM_PAGE + "?row");
  try {
    gBrowser.selectedTab = essential;
    await typeInto(essential.linkedBrowser, "name", "Ada");
    gBrowser.selectedTab = row;
    await typeInto(row.linkedBrowser, "name", "Ada");
    await TestUtils.waitForCondition(() => typed(essential) && typed(row), "Both typed");
    await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.com/?away");
    const awayTab = gBrowser.selectedTab;
    EventUtils.synthesizeMouseAtCenter(document.getElementById("tabbrowser-tabpanels"), { type: "mousemove" });

    const marker = essential.querySelector(".whimsy-tab-form-marker");
    ok(marker?.checkVisibility(), "The Essential shows the marker");
    const m = marker.getBoundingClientRect();
    const tile = essential.querySelector(".tab-background").getBoundingClientRect();
    ok(m.left >= tile.left && m.right <= tile.right && m.top >= tile.top && m.bottom <= tile.bottom,
      `inside the tile (${JSON.stringify(m)} in ${JSON.stringify(tile)})`);
    is(marker.getAttribute("src"), "chrome://browser/content/whimsy/whimsy-form-pencil.svg", "a pencil");
    ok(Math.round(m.width) == 11 && Math.round(m.height) == 11, `11px (${m.width}x${m.height})`);
    ok(m.left - tile.left <= 8 && tile.bottom - m.bottom <= 8, "in the tile's bottom-start corner");
    is(getComputedStyle(essential.querySelector(".tab-icon-stack"), "::before").content, "none", "no disc on the icon");

    const rowMarker = row.querySelector(".whimsy-tab-form-marker");
    ok(rowMarker?.checkVisibility(), "The row shows the marker");
    is(rowMarker.previousElementSibling, row.querySelector(".tab-label-container"), "after the title");
    const r = rowMarker.getBoundingClientRect();
    const rowBox = row.getBoundingClientRect();
    ok(r.left >= rowBox.left && r.right <= rowBox.right, "inside the row");
    ok(rowBox.right - r.right <= 12, "at the end of the row");

    // Hovered, the row's close button takes the marker's place.
    EventUtils.synthesizeMouseAtCenter(row, { type: "mousemove" });
    await TestUtils.waitForCondition(() => row.matches(":hover"), "Row hovered");
    ok(!rowMarker.checkVisibility(), "Hovered: no marker on the row");
    EventUtils.synthesizeMouseAtCenter(document.getElementById("tabbrowser-tabpanels"), { type: "mousemove" });
    await TestUtils.waitForCondition(() => rowMarker.checkVisibility(), "Away: the marker is back");

    // The collapsed sidebar: the row is a tile, the pencil inside it.
    await SpecialPowers.pushPrefEnv({ set: [["zen.view.sidebar-expanded", false]] });
    try {
      await TestUtils.waitForCondition(() => document.documentElement.getAttribute("zen-sidebar-expanded") != "true", "Collapsed");
      const insideTile = (tab, pencil) => {
        const box = tab.querySelector(".tab-background").getBoundingClientRect();
        const pen = pencil.getBoundingClientRect();
        return pencil.checkVisibility() && pen.left >= box.left && pen.right <= box.right && pen.top >= box.top && pen.bottom <= box.bottom;
      };
      await TestUtils.waitForCondition(() => insideTile(row, rowMarker), "Collapsed: the row's pencil is inside its tile");
      ok(insideTile(essential, marker), "and the Essential's inside its (narrower) tile");
    } finally {
      await SpecialPowers.popPrefEnv();
    }
    BrowserTestUtils.removeTab(awayTab);
  } finally {
    BrowserTestUtils.removeTab(row);
    BrowserTestUtils.removeTab(essential);
  }
});

// R1 v2: type, reload, and a toast offers to refill what was typed; Refill
// fills only empty fields, never the password, and deletes the draft.
add_task(async function test_refill_after_reload_offers_refill() {
  await BrowserTestUtils.withNewTab(FORM_PAGE, async browser => {
    const tab = gBrowser.getTabForBrowser(browser);
    await typeInto(browser, "name", "Ada Lovelace");
    await typeInto(browser, "password", "hunter2");
    await TestUtils.waitForCondition(() => typed(tab), "Typed");

    const loaded = BrowserTestUtils.browserLoaded(browser);
    browser.reloadWithFlags(Ci.nsIWebNavigation.LOAD_FLAGS_BYPASS_CACHE);
    await loaded;
    await SpecialPowers.spawn(browser, [], () => {
      // A reload that bypasses the cache starts with empty fields.
      for (const el of content.document.querySelectorAll("input")) {
        el.value = "";
      }
    });
    const toast = await TestUtils.waitForCondition(() => toastFor("whimsy-form-refill-ask"),
      "A toast offers to refill what was typed");
    await toast.shown;
    await document.l10n.translateFragment(toast.element);
    is(toast.element.querySelector("label").textContent, "Refill what you typed?", "The new wording");
    const buttons = [...toast.element.querySelectorAll(".whimsy-toast-button")];
    is(buttons.length, 2, "Refill and Dismiss");
    is(await SpecialPowers.spawn(browser, [], () => content.document.getElementById("name").value), "",
      "Nothing is filled before Refill");
    buttons[0].click();
    await TestUtils.waitForCondition(async () =>
      (await SpecialPowers.spawn(browser, [], () => content.document.getElementById("name").value)) == "Ada Lovelace",
    "Refill fills the answer back in");
    is(await SpecialPowers.spawn(browser, [], () => content.document.getElementById("password").value), "",
      "never the password");
    await TestUtils.waitForCondition(() => typed(tab), "What was filled back is unsaved again");
    ok(!(await WhimsyFormProtection.snapshotFor(browser, FORM_PAGE)), "Refill deleted the draft");
  });
});

// F08: most sites build their form after the page loads; the refill offer
// waits for it.
add_task(async function test_refill_offered_for_late_form() {
  const PAGE = ROOT + "whimsy_late_form.html";
  await BrowserTestUtils.withNewTab(PAGE, async browser => {
    const tab = gBrowser.getTabForBrowser(browser);
    await SpecialPowers.spawn(browser, [], () =>
      ContentTaskUtils.waitForCondition(() => !!content.document.getElementById("name"), "The form appeared"));
    await typeInto(browser, "name", "Grace");
    await TestUtils.waitForCondition(() => typed(tab), "Typed");
    const loaded = BrowserTestUtils.browserLoaded(browser);
    browser.reload();
    await loaded;
    const toast = await TestUtils.waitForCondition(() => toastFor("whimsy-form-refill-ask"),
      "Once the form appears, a toast offers to refill the answer");
    await toast.shown;
    await document.l10n.translateFragment(toast.element);
    toast.element.querySelector(".whimsy-toast-button").click();
    await TestUtils.waitForCondition(async () =>
      (await SpecialPowers.spawn(browser, [], () => content.document.getElementById("name").value)) == "Grace",
    "Refill fills it back in");
  });
});

// Dismiss deletes the draft without filling anything.
add_task(async function test_dismiss_deletes_without_filling() {
  await BrowserTestUtils.withNewTab(FORM_PAGE, async browser => {
    const tab = gBrowser.getTabForBrowser(browser);
    await typeInto(browser, "name", "Ada");
    await TestUtils.waitForCondition(() => typed(tab), "Typed");
    const loaded = BrowserTestUtils.browserLoaded(browser);
    browser.reloadWithFlags(Ci.nsIWebNavigation.LOAD_FLAGS_BYPASS_CACHE);
    await loaded;
    const toast = await TestUtils.waitForCondition(() => toastFor("whimsy-form-refill-ask"), "Offered");
    await toast.shown;
    await document.l10n.translateFragment(toast.element);
    toast.element.querySelectorAll(".whimsy-toast-button")[1].click();
    await TestUtils.waitForCondition(async () => !(await WhimsyFormProtection.snapshotFor(browser, FORM_PAGE)),
      "Dismiss deletes the draft");
    is(await SpecialPowers.spawn(browser, [], () => content.document.getElementById("name").value), "",
      "Nothing was filled");
  });
});

// R1 v2 §4, §6: a private tab's draft stays in memory, never on disk, keyed
// by the address without its fragment.
add_task(async function test_private_draft_stays_in_memory() {
  const { WhimsyPrivate } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyPrivate.sys.mjs");
  const tab = WhimsyPrivate.openPrivateTab(window, { url: FORM_PAGE, force: true });
  await TestUtils.waitForCondition(() => tab.linkedBrowser.currentURI?.spec == FORM_PAGE && !tab.hasAttribute("busy"),
    "The private tab loaded");
  try {
    await typeInto(tab.linkedBrowser, "name", "Private Person");
    await TestUtils.waitForCondition(() => typed(tab), "Typed");
    await new Promise(resolve => setTimeout(resolve, 600)); // eslint-disable-line mozilla/no-arbitrary-setTimeout
    const draft = await WhimsyFormProtection.snapshotFor(tab.linkedBrowser, FORM_PAGE + "#x");
    is(draft?.data.id.name, "Private Person", "Found again for the same page (ignoring the hash)");
  } finally {
    // A typed private tab needs the close warning (R1 v2 §3): one
    // removeTab only shows it, a second within CLOSE_CONFIRM_MS closes.
    // removeTab's own close isn't awaited by the test utility (it returns
    // whatever gBrowser.removeTab returns, which is undefined on this
    // path), so wait for the tab to actually leave gBrowser.tabs before
    // the next test starts: otherwise its close animation can still be
    // in flight when that test checks for a tab at the same address.
    BrowserTestUtils.removeTab(tab);
    BrowserTestUtils.removeTab(tab);
    closeToasts();
    await TestUtils.waitForCondition(() => !gBrowser.tabs.includes(tab), "The private tab finished closing");
  }
});

// Pinned ⌘W, bug: confirming one typed pinned tab must not spend its
// confirmation when a later press (with another, still-unconfirmed, pinned
// tab in the mix) warns and closes nothing. onCloseTabShortcut's needWarn
// filter used to call closeConfirmed (which *consumes* the timestamp) on
// every candidate tab just to decide who still needs a warning, so the
// already-confirmed tab's timestamp was gone even though nothing closed.
add_task(async function test_pinned_multiselect_close_does_not_consume_other_confirmation() {
  await SpecialPowers.pushPrefEnv({ set: [["whimsy.forms.saveDrafts", false]] });
  const tab1 = await BrowserTestUtils.openNewForegroundTab(gBrowser, FORM_PAGE);
  const tab2 = await BrowserTestUtils.openNewForegroundTab(gBrowser, FORM_PAGE);
  gBrowser.pinTab(tab1);
  gBrowser.pinTab(tab2);
  try {
    await typeInto(tab1.linkedBrowser, "name", "Ada");
    await TestUtils.waitForCondition(() => typed(tab1), "tab1 typed");
    await typeInto(tab2.linkedBrowser, "name", "Grace");
    await TestUtils.waitForCondition(() => typed(tab2), "tab2 typed");

    // First press: only tab1 is selected. It warns and is now confirmed
    // (within CLOSE_CONFIRM_MS, a second press on it alone would close it).
    gBrowser.selectedTab = tab1;
    await SimpleTest.promiseFocus(window);
    EventUtils.synthesizeKey("w", { accelKey: true });
    await TestUtils.waitForCondition(() => toastFor("whimsy-form-close-warning"), "tab1's first ⌘W warns");
    closeToasts();

    // Second press: both tabs are the target (as a real multiselected ⌘W
    // would pass them). tab2 has never been warned, so this press must
    // warn again and close nothing for either tab.
    await gZenPinnedTabManager.onCloseTabShortcut(undefined, [tab1, tab2]);
    await TestUtils.waitForCondition(() => toastFor("whimsy-form-close-warning"), "tab2 still needs a fresh warning");
    ok(gBrowser.tabs.includes(tab1) && gBrowser.tabs.includes(tab2), "nothing closed");
    closeToasts();

    // Third press: tab1 alone again, right away. Its earlier confirmation
    // must still hold (it was never consumed by the press that closed
    // nothing), so this must proceed without a fresh warning toast.
    gBrowser.selectedTab = tab1;
    await SimpleTest.promiseFocus(window);
    EventUtils.synthesizeKey("w", { accelKey: true });
    await new Promise(resolve => setTimeout(resolve, 200)); // eslint-disable-line mozilla/no-arbitrary-setTimeout
    is(toastFor("whimsy-form-close-warning"), null, "tab1's earlier confirmation was not spent by the press that closed nothing");
  } finally {
    closeToasts();
    for (const tab of [tab1, tab2]) {
      if (tab.pinned) {
        gBrowser.unpinTab(tab);
      }
      if (gBrowser.tabs.includes(tab)) {
        BrowserTestUtils.removeTab(tab);
      }
    }
    await TestUtils.waitForCondition(
      () => !gBrowser.tabs.includes(tab1) && !gBrowser.tabs.includes(tab2),
      "Both tabs finished closing"
    );
    await SpecialPowers.popPrefEnv();
  }
});

add_task(async function test_switch_off() {
  await SpecialPowers.pushPrefEnv({ set: [["whimsy.feature.form-protection", false]] });
  await BrowserTestUtils.withNewTab(FORM_PAGE, async browser => {
    const tab = gBrowser.getTabForBrowser(browser);
    await typeInto(browser, "name", "Ada");
    await new Promise(resolve => setTimeout(resolve, 300)); // eslint-disable-line mozilla/no-arbitrary-setTimeout
    ok(!WhimsyFormProtection.isFormProtected(tab), "With the switch off, nothing is protected");
    ok(!typed(tab), "or marked");
  });
  // withNewTab's own removeTab isn't awaited, and this is the file's last
  // test: wait for it to actually finish so the harness's end-of-run check
  // doesn't catch it still closing. (This used to also catch a tab leaked
  // by browser_whimsy_form_drafts.js's ⌘⇧T reopen test when the two files
  // ran in the same mach invocation; that leak is fixed at its source now.)
  await TestUtils.waitForCondition(() => !gBrowser.tabs.some(t => t.linkedBrowser?.currentURI?.spec == FORM_PAGE), "The tab finished closing");
  await SpecialPowers.popPrefEnv();
});
