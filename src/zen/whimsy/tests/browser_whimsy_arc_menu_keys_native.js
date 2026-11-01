/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// wave10 (W10-47): Arc's browser-level menu keys with real (native) key
// events, which need a real window: verify.sh runs this file headed in its
// whimsy-native suite. The reservation itself is checked headless in
// browser_whimsy_arc_menu_keys.js.

// wave10 (W10-47): a real Cmd+Shift+L (a native key event, through the
// app's menu bar and the window's keys, as a keyboard sends it) opens the
// Library and a second one closes it, with the page or the address bar
// focused, and even on a page that handles Cmd+Shift+L itself: in Arc it is
// a menu key equivalent the page never sees, so here the <key> is reserved.
Services.scriptloader.loadSubScript("chrome://mochikit/content/tests/SimpleTest/NativeKeyCodes.js", this);

add_task(async function test_native_library_key() {
  const { AppConstants } = ChromeUtils.importESModule("resource://gre/modules/AppConstants.sys.mjs");
  is(document.getElementById("zen-library-toggle").getAttribute("reserved"), "true", "Pages can't take the Library key");
  if (AppConstants.platform != "macosx") {
    ok(true, "Native key synthesis below is macOS only");
    return;
  }
  await TestUtils.waitForCondition(() => gBrowserInit.delayedStartupFinished, "Delayed startup");
  const ZenLibrary = customElements.get("zen-library");
  // A page that wants Cmd+Shift+L for itself.
  const html =
    "<script>addEventListener('keydown', e => { if (e.metaKey && e.shiftKey && e.code == 'KeyL') " +
    "{ e.preventDefault(); document.title = 'page took it'; } }, true);</script><input id=field>";
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, "data:text/html," + encodeURIComponent(html));
  const press = () =>
    new Promise(resolve =>
      EventUtils.synthesizeNativeKey(EventUtils.KEYBOARD_LAYOUT_EN_US, MAC_VK_ANSI_L, { metaKey: true, shiftKey: true }, "l", "L", resolve)
    );
  const focusField = () =>
    SpecialPowers.spawn(tab.linkedBrowser, [], () => content.document.getElementById("field").focus());
  for (const [name, focus] of [["the page", () => tab.linkedBrowser.focus()], ["a field in the page", focusField], ["the address bar", () => gURLBar.focus()]]) {
    await focus();
    await press();
    await TestUtils.waitForCondition(() => ZenLibrary.isLibraryOpen, `Cmd+Shift+L opens the Library from ${name}`);
    await press();
    await TestUtils.waitForCondition(() => !ZenLibrary.isLibraryOpen, "and closes it again");
  }
  const title = await SpecialPowers.spawn(tab.linkedBrowser, [], () => content.document.title);
  isnot(title, "page took it", "The page never got the key");
  BrowserTestUtils.removeTab(tab);
});

add_task(async function test_native_pin_key_on_a_greedy_page() {
  await TestUtils.waitForCondition(() => gBrowserInit.delayedStartupFinished, "Delayed startup");
  // A page that takes every ⌘ key still can't take Pin Tab (⌘D).
  const { AppConstants } = ChromeUtils.importESModule("resource://gre/modules/AppConstants.sys.mjs");
  if (AppConstants.platform != "macosx") {
    return;
  }
  const html =
    "<script>addEventListener('keydown', e => { if (e.metaKey) { e.preventDefault(); document.title = 'page took ' + e.code; } }, true);</script>";
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, "data:text/html," + encodeURIComponent(html));
  tab.linkedBrowser.focus();
  await new Promise(resolve =>
    EventUtils.synthesizeNativeKey(EventUtils.KEYBOARD_LAYOUT_EN_US, MAC_VK_ANSI_D, { metaKey: true }, "d", "d", resolve)
  );
  await TestUtils.waitForCondition(() => tab.pinned, "⌘D pins the tab");
  isnot(await SpecialPowers.spawn(tab.linkedBrowser, [], () => content.document.title), "page took KeyD", "The page never got ⌘D");
  gBrowser.unpinTab(tab);
  BrowserTestUtils.removeTab(tab);
});
