/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// W10-05 (hand test I6 note): "cmd y doesn't work". Arc's View History is
// Cmd+Y (Firefox's Show All History on macOS); in Whimsy it opens the
// Library on History. Pressed for real, from the places a person presses
// it: a web page, the address bar, and with the Library open elsewhere.

const PAGE = "https://example.com/browser/";

function historyKey() {
  return AppConstants.platform == "macosx" ? ["y", { accelKey: true }] : ["h", { accelKey: true, shiftKey: true }];
}

function Library() {
  return customElements.get("zen-library");
}

async function closeLibrary() {
  if (Library()?.isLibraryOpen) {
    Library().toggle();
    await TestUtils.waitForCondition(() => !Library().isLibraryOpen, "Library closed");
  }
}

async function pressAndExpectHistory(what) {
  EventUtils.synthesizeKey(...historyKey());
  await TestUtils.waitForCondition(() => Library().isLibraryOpen, `${what}: the Library opens`);
  is(Library().getInstance().activeTab, "history", `${what}: on History`);
}

add_setup(async function () {
  ok(Services.prefs.getBoolPref("zen.library.enabled"), "Zen's Library is on");
  const keyEl = document.getElementById("showAllHistoryKb");
  ok(keyEl, "Firefox's Show All History key exists");
  await document.l10n.translateElements([keyEl]);
  if (AppConstants.platform == "macosx") {
    is(keyEl.getAttribute("key")?.toUpperCase(), "Y", "It is Y…");
    is(keyEl.getAttribute("modifiers"), "accel", "…with Cmd");
  }
  ok(keyEl.getAttribute("disabled") != "true", "and is enabled");
  registerCleanupFunction(closeLibrary);
});

add_task(async function cmd_y_from_a_web_page() {
  await closeLibrary();
  await BrowserTestUtils.withNewTab(PAGE, async browser => {
    await SpecialPowers.spawn(browser, [], () => content.document.body.focus());
    browser.focus();
    await pressAndExpectHistory("From a page");
    await closeLibrary();
  });
});

add_task(async function cmd_y_from_the_address_bar() {
  await closeLibrary();
  gURLBar.focus();
  await pressAndExpectHistory("From the address bar");
  EventUtils.synthesizeKey("KEY_Escape");
  await closeLibrary();
});

add_task(async function cmd_y_switches_an_open_library_to_history() {
  await closeLibrary();
  Library().toggle("downloads");
  await TestUtils.waitForCondition(() => Library().isLibraryOpen, "Library open");
  is(Library().getInstance().activeTab, "downloads", "on Downloads");
  EventUtils.synthesizeKey(...historyKey());
  await TestUtils.waitForCondition(() => Library().getInstance().activeTab == "history", "Switched to History");
  ok(Library().isLibraryOpen, "Still open");
  await closeLibrary();
});

add_task(async function the_menu_and_the_key_agree() {
  const item = document.getElementById("menu_showAllHistory");
  is(item?.getAttribute("key"), "showAllHistoryKb", "History ▸ Show All History shows the key");
});
