/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

const { AppConstants } = ChromeUtils.importESModule("resource://gre/modules/AppConstants.sys.mjs");

// Whimsy: Ctrl+Tab pressed through the native macOS key path (NSEvent), the
// way a real keyboard reaches the app, including menu key equivalents.

Services.scriptloader.loadSubScript(
  "chrome://mochikit/content/tests/SimpleTest/NativeKeyCodes.js",
  this
);

function nativeKey(code, modifiers, chars = "") {
  return new Promise(resolve =>
    EventUtils.synthesizeNativeKey(
      EventUtils.KEYBOARD_LAYOUT_EN_US,
      code,
      modifiers,
      chars,
      chars,
      resolve
    )
  );
}

// What a keyboard sends for a quick tap: Control down, Tab, Control up.
async function nativeCtrlTab() {
  await nativeKey(MAC_VK_Control, { ctrlKey: true });
  await nativeKey(MAC_VK_Tab, { ctrlKey: true }, "\t");
  await nativeKey(MAC_VK_Control, {});
}

add_task(async function test_native_ctrl_tab_alternates() {
  if (AppConstants.platform != "macosx") {
    ok(true, "macOS only");
    return;
  }
  const tabs = [];
  registerCleanupFunction(() => tabs.forEach(t => t.isConnected && BrowserTestUtils.removeTab(t)));
  for (let i = 1; i <= 3; i++) {
    tabs.push(await BrowserTestUtils.openNewForegroundTab(gBrowser, `data:text/plain,n${i}`));
  }
  const [a, b] = [tabs[0], tabs[2]];
  const onSelect = BrowserTestUtils.waitForEvent(gBrowser.tabContainer, "TabSelect");
  gBrowser.selectedTab = a;
  await onSelect;

  info(`visibleTabs=${gBrowser.visibleTabs.length} ctrlTab list=${ctrlTab._recentlyUsedTabs?.length}`);
  await nativeCtrlTab();
  await TestUtils.waitForCondition(() => gBrowser.selectedTab == b, "Native Ctrl+Tab goes to the last-used tab")
    .catch(() => {});
  is(gBrowser.selectedTab, b, "Native Ctrl+Tab goes to the last-used tab");

  for (const tab of tabs) {
    BrowserTestUtils.removeTab(tab);
  }
});
