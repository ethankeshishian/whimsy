/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// Duplicate tab shortcut: Cmd+Shift+D duplicates the current tab; Pin/Unpin moves to Cmd+D (Arc), which Bookmark This Page
// gives up. The feature switch hands the keys back to Zen and Firefox.

const { WhimsyShortcuts } = ChromeUtils.importESModule(
  "resource:///modules/whimsy/WhimsyShortcuts.sys.mjs"
);

const startTabs = new Set(gBrowser.tabs);
registerCleanupFunction(() => {
  for (const tab of gBrowser.tabs.filter(t => !startTabs.has(t))) {
    BrowserTestUtils.removeTab(tab);
  }
});

function binding(id) {
  const key = document.getElementById(id);
  return `${key.getAttribute("modifiers") || ""}+${key.getAttribute("key") || ""}`;
}

add_task(async function test_bindings() {
  ok(Services.prefs.getBoolPref("whimsy.feature.duplicate-shortcut"), "The feature switch is on");
  is(binding("zen-duplicate-tab"), "accel,shift+D", "Duplicate Tab is Cmd+Shift+D");
  is(binding("zen-toggle-pin-tab"), "accel+D", "Pin/Unpin Tab is Cmd+D");
  is(binding("addBookmarkAsKb"), "+", "Bookmark This Page has no shortcut");
  ok(!document.getElementById("addBookmarkAsKb").hasAttribute("data-l10n-id"), "Fluent won't put Cmd+D back");
  // Nothing else in the window claims Cmd+Shift+D or Cmd+D.
  for (const key of document.querySelectorAll("key[key]")) {
    if (key.getAttribute("key").toUpperCase() != "D" || Object.keys(WhimsyShortcuts.SHORTCUTS).includes(key.id)) {
      continue;
    }
    const mods = (key.getAttribute("modifiers") || "").split(",").sort().join(",");
    ok(mods != "accel" && mods != "accel,shift", `${key.id} doesn't use Cmd+D or Cmd+Shift+D`);
  }
});

add_task(async function test_duplicate_with_shortcut() {
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.com/");
  const onOpen = BrowserTestUtils.waitForEvent(gBrowser.tabContainer, "TabOpen");
  EventUtils.synthesizeKey("D", { accelKey: true, shiftKey: true });
  const { target: copy } = await onOpen;
  await BrowserTestUtils.browserLoaded(copy.linkedBrowser);
  is(copy.linkedBrowser.currentURI.spec, "https://example.com/", "The copy has the same page");
  is(gBrowser.tabs.indexOf(copy), gBrowser.tabs.indexOf(tab) + 1, "The copy sits right after the original");
  ok(!tab.pinned, "Cmd+Shift+D didn't pin the tab");
  BrowserTestUtils.removeTab(copy);

  BrowserTestUtils.removeTab(tab);
});

add_task(async function test_pin_with_cmd_d() {
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.com/");
  EventUtils.synthesizeKey("d", { accelKey: true });
  await TestUtils.waitForCondition(() => tab.pinned, "Cmd+D pins the tab");
  EventUtils.synthesizeKey("d", { accelKey: true });
  await TestUtils.waitForCondition(() => !tab.pinned, "Cmd+D again unpins it");
  ok(!document.getElementById("editBookmarkPanel")?.state?.startsWith("open"), "No bookmark panel opened");
  BrowserTestUtils.removeTab(tab);
});

add_task(async function test_feature_switch_off() {
  await SpecialPowers.pushPrefEnv({ set: [["whimsy.feature.duplicate-shortcut", false]] });
  const win = await BrowserTestUtils.openNewBrowserWindow();
  const key = id => win.document.getElementById(id);
  is(key("zen-toggle-pin-tab").getAttribute("modifiers"), "accel,shift", "Zen's Cmd+Shift+D pin shortcut is back");
  ok(!key("zen-duplicate-tab").getAttribute("key"), "Duplicate Tab is unbound, as in Zen");
  is(key("addBookmarkAsKb").getAttribute("data-l10n-id"), "bookmark-this-page-shortcut", "Firefox's Cmd+D is back");
  await BrowserTestUtils.closeWindow(win);
  await SpecialPowers.popPrefEnv();
});
