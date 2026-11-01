/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// wave6/parity: Arc's menu keys. Open Library Cmd+Shift+L, View Downloads
// Cmd+Shift+J (Browser Console to Cmd+Opt+J when free), Save Page As
// Cmd+Shift+S (Screenshots keeps Cmd+Shift+2), Blank Window Cmd+Ctrl+N,
// Copy URL as Quote Cmd+Ctrl+Shift+C, Paste and Match Style Cmd+Shift+V.

const { WhimsyShortcuts } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyShortcuts.sys.mjs");
const { WhimsyCommands } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyCommands.sys.mjs");
const { WhimsyCopy } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyCopy.sys.mjs");

function binding(id) {
  const key = document.getElementById(id);
  return key ? `${key.getAttribute("modifiers") ?? ""}|${(key.getAttribute("key") ?? "").toUpperCase()}` : null;
}

function noOtherKey(id) {
  const key = document.getElementById(id);
  const conflict = WhimsyCommands.findConflict(document, key, id);
  ok(!conflict, `${id} shares its shortcut with no other key${conflict ? ` (${conflict.id})` : ""}`);
}

add_task(function test_library_and_save_page() {
  is(binding("zen-library-toggle"), "accel,shift|L", "Open Library is Cmd+Shift+L");
  noOtherKey("zen-library-toggle");
  is(binding("key_savePage"), "accel,shift|S", "Save Page As is Cmd+Shift+S");
  noOtherKey("key_savePage");
  ok(!document.getElementById("key_screenshot").getAttribute("key"), "Screenshots gave up Cmd+Shift+S");
  is(document.getElementById("key_whimsyScreenshotArc")?.getAttribute("keycode"), "VK_2", "and keeps Cmd+Shift+2");
});

add_task(async function test_downloads_and_console() {
  await TestUtils.waitForCondition(() => gBrowserInit.delayedStartupFinished, "Delayed startup");
  const result = WhimsyShortcuts.moveConsoleAndDownloads(window);
  const consoleKey = document.getElementById("key_browserConsole");
  if (result == "kept") {
    info("Cmd+Opt+J is taken: the console and Downloads keep Firefox's keys");
    is(binding("key_openDownloads"), "accel|J", "Downloads stays on Cmd+J");
    return;
  }
  is(binding("key_openDownloads"), "accel,shift|J", "View Downloads is Cmd+Shift+J");
  noOtherKey("key_openDownloads");
  if (consoleKey) {
    is(consoleKey.getAttribute("modifiers"), "accel,alt", "The Browser Console moved to Cmd+Opt+J");
    noOtherKey("key_browserConsole");
  }
  is(binding("zen-library-toggle"), "accel,shift|L", "Open Library remains Cmd+Shift+L after delayed startup");
  noOtherKey("zen-library-toggle");
});

add_task(function test_blank_window() {
  if (!Services.prefs.getBoolPref("whimsy.feature.scratch", true)) {
    return;
  }
  const key = document.getElementById("zen-new-unsynced-window");
  is(key.getAttribute("command"), "cmd_zenNewNavigatorUnsynced", "Zen's Blank Window command");
  is(binding("zen-new-unsynced-window"), "accel,control|N", "Blank Window is Cmd+Ctrl+N");
  noOtherKey("zen-new-unsynced-window");
});

add_task(function test_copy_quote_and_paste_style() {
  is(binding("key_whimsyCopyURLQuote"), "accel,control,shift|C", "Copy URL as Quote is Cmd+Ctrl+Shift+C");
  noOtherKey("key_whimsyCopyURLQuote");
  const { text, html } = WhimsyCopy.formatQuote({ url: "https://example.com/", title: "Example" }, "Line one\nLine two");
  is(text, "> Line one\n> Line two\n\n[Example](https://example.com/)", "A Markdown quote with its source");
  ok(html.startsWith("<blockquote>Line one<br>Line two</blockquote>"), "and the same as HTML");
  is(WhimsyCopy.formatQuote({ url: "https://example.com/", title: "Example" }, "").text, "> Example\n\n[Example](https://example.com/)", "No selection quotes the title");

  for (const id of ["menu_whimsyCopyURL", "menu_whimsyCopyURLMarkdown", "menu_whimsyCopyURLQuote", "menu_whimsyPasteMatchStyle"]) {
    ok(document.getElementById(id), `Edit menu has ${id}`);
  }
  const paste = document.getElementById("key_whimsyPasteMatchStyle");
  is(paste.getAttribute("internal"), "true", "Paste and Match Style's key is display-only (the editor runs it)");
  is(binding("key_whimsyPasteMatchStyle"), "accel,shift|V", "shown as Cmd+Shift+V");
});

// wave6: Cmd+N = New Space (BUILD-PLAN); New Window keeps a key.
add_task(function test_cmd_n_new_space() {
  is(binding("key_whimsyNewSpace"), "accel|N", "Cmd+N is New Space");
  is(document.getElementById("key_whimsyNewSpace").getAttribute("command"), "cmd_zenOpenWorkspaceCreation", "Zen's create-space command");
  noOtherKey("key_whimsyNewSpace");
  is(binding("key_newNavigator"), "accel,alt,shift|N", "New Window moved to Cmd+Opt+Shift+N");
  is(document.getElementById("key_newNavigator").getAttribute("command"), "cmd_newNavigator", "and still opens a window");
  noOtherKey("key_newNavigator");
});

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

// wave10 (W10-47): Arc's other browser-level menu keys are reserved too;
// the keys pages use for their content never are, and a rebinding moves the
// reservation with the key (and drops it on a content key).
add_task(async function test_browser_keys_reserved_content_keys_not() {
  const { RESERVED_KEYS, CONTENT_BINDINGS, bindingOf } = ChromeUtils.importESModule(
    "resource:///modules/whimsy/WhimsyShortcuts.sys.mjs"
  );
  const { CustomKeys } = ChromeUtils.importESModule("moz-src:///browser/components/customkeys/CustomKeys.sys.mjs");
  await TestUtils.waitForCondition(() => gBrowserInit.delayedStartupFinished, "Delayed startup");
  const reserved = id => document.getElementById(id)?.getAttribute("reserved") == "true";

  for (const id of ["zen-library-toggle", "zen-copy-url", "zen-toggle-pin-tab", "focusURLBar", "key_openDownloads", "zen-workspace-forward"]) {
    ok(RESERVED_KEYS.includes(id), `${id} is one of Arc's browser keys`);
    ok(reserved(id), `${id} is reserved`);
  }
  for (const id of ["key_copy", "key_selectAll", "key_undo", "key_find", "zen-compact-mode-toggle"]) {
    const key = document.getElementById(id);
    if (key) {
      ok(!RESERVED_KEYS.includes(id) && !key.hasAttribute("whimsy-reserved"), `${id} stays the page's`);
    }
  }
  for (const id of RESERVED_KEYS) {
    const key = document.getElementById(id);
    if (key) {
      ok(!CONTENT_BINDINGS.includes(bindingOf(key)), `${id} (${bindingOf(key)}) isn't on a content key`);
    }
  }

  // Rebinding Pin Tab onto Bold gives Bold back to pages; another key keeps
  // the reservation; resetting brings Arc's ⌘D back, reserved.
  CustomKeys.changeKey("zen-toggle-pin-tab", { modifiers: "accel", key: "B" });
  await TestUtils.waitForCondition(() => !reserved("zen-toggle-pin-tab"), "Rebound onto ⌘B: not reserved");
  CustomKeys.changeKey("zen-toggle-pin-tab", { modifiers: "accel,alt", key: "P" });
  await TestUtils.waitForCondition(() => reserved("zen-toggle-pin-tab"), "Rebound onto ⌥⌘P: reserved");
  CustomKeys.resetKey("zen-toggle-pin-tab");
  await TestUtils.waitForCondition(
    () => bindingOf(document.getElementById("zen-toggle-pin-tab")) == "accel|D" && reserved("zen-toggle-pin-tab"),
    "Reset: ⌘D, reserved"
  );

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
