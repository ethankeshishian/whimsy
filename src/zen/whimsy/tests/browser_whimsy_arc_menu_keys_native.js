/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// wave10 (W10-47, W10-61): Arc's browser-level menu keys with real
// (native) key events, which need a real window: verify.sh runs this file
// headed in its whimsy-native suite. The model is checked headless in
// browser_whimsy_press_again.js.

// A real Cmd+Shift+L (a native key event, through the app's menu bar and
// the window's keys, as a keyboard sends it) opens the Library and a
// second one closes it, with the page or the address bar focused. On a
// page that handles Cmd+Shift+L itself, the page gets the first press and
// the second press in a row opens the Library (W10-61, Arc's press again).
Services.scriptloader.loadSubScript("chrome://mochikit/content/tests/SimpleTest/NativeKeyCodes.js", this);

add_task(async function test_native_library_key() {
  const { AppConstants } = ChromeUtils.importESModule("resource://gre/modules/AppConstants.sys.mjs");
  if (AppConstants.platform != "macosx") {
    ok(true, "Native key synthesis below is macOS only");
    return;
  }
  await TestUtils.waitForCondition(() => gBrowserInit.delayedStartupFinished, "Delayed startup");
  const ZenLibrary = customElements.get("zen-library");
  const press = () =>
    new Promise(resolve =>
      EventUtils.synthesizeNativeKey(EventUtils.KEYBOARD_LAYOUT_EN_US, MAC_VK_ANSI_L, { metaKey: true, shiftKey: true }, "l", "L", resolve)
    );
  // A page that doesn't use the key: the first press is the browser's.
  const plain = await BrowserTestUtils.openNewForegroundTab(gBrowser, "data:text/html,<input id=field>");
  const focusField = () =>
    SpecialPowers.spawn(plain.linkedBrowser, [], () => content.document.getElementById("field").focus());
  for (const [name, focus] of [["the page", () => plain.linkedBrowser.focus()], ["a field in the page", focusField], ["the address bar", () => gURLBar.focus()]]) {
    await focus();
    await press();
    await TestUtils.waitForCondition(() => ZenLibrary.isLibraryOpen, `Cmd+Shift+L opens the Library from ${name}`);
    await press();
    await TestUtils.waitForCondition(() => !ZenLibrary.isLibraryOpen, "and closes it again");
  }
  BrowserTestUtils.removeTab(plain);

  // A page that wants Cmd+Shift+L for itself gets the first press.
  const html =
    "<script>window.took = 0; addEventListener('keydown', e => { if (e.metaKey && e.shiftKey && e.code == 'KeyL') " +
    "{ e.preventDefault(); window.took++; } }, true);</script>";
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, "data:text/html," + encodeURIComponent(html));
  const took = () => SpecialPowers.spawn(tab.linkedBrowser, [], () => content.wrappedJSObject.took);
  tab.linkedBrowser.focus();
  await press();
  await TestUtils.waitForCondition(async () => (await took()) == 1, "The page got the first press");
  await TestUtils.waitForCondition(() => currentToast()?.messageId == "whimsy-press-again-toast", "Press again hint");
  ok(!ZenLibrary.isLibraryOpen, "The first press didn't open the Library");
  await press();
  await TestUtils.waitForCondition(() => ZenLibrary.isLibraryOpen, "The second press opens the Library");
  is(await took(), 1, "The page didn't see the second press");
  const { WhimsyShortcuts } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyShortcuts.sys.mjs");
  WhimsyShortcuts.runKey(window, document.getElementById("zen-library-toggle"));
  await TestUtils.waitForCondition(() => !ZenLibrary.isLibraryOpen, "Library closed");
  BrowserTestUtils.removeTab(tab);
});

add_task(async function test_native_pin_key_on_a_greedy_page() {
  await TestUtils.waitForCondition(() => gBrowserInit.delayedStartupFinished, "Delayed startup");
  // A page that takes every ⌘ key gets the first ⌘D; the second pins (W10-61).
  const { AppConstants } = ChromeUtils.importESModule("resource://gre/modules/AppConstants.sys.mjs");
  if (AppConstants.platform != "macosx") {
    return;
  }
  const html =
    "<script>addEventListener('keydown', e => { if (e.metaKey) { e.preventDefault(); document.title = 'page took ' + e.code; } }, true);</script>";
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, "data:text/html," + encodeURIComponent(html));
  tab.linkedBrowser.focus();
  const press = () =>
    new Promise(resolve =>
      EventUtils.synthesizeNativeKey(EventUtils.KEYBOARD_LAYOUT_EN_US, MAC_VK_ANSI_D, { metaKey: true }, "d", "d", resolve)
    );
  await press();
  await TestUtils.waitForCondition(
    async () => (await SpecialPowers.spawn(tab.linkedBrowser, [], () => content.document.title)) == "page took KeyD",
    "The page got the first ⌘D"
  );
  ok(!tab.pinned, "not pinned yet");
  await press();
  await TestUtils.waitForCondition(() => tab.pinned, "The second ⌘D pins the tab");
  gBrowser.unpinTab(tab);
  BrowserTestUtils.removeTab(tab);
});
