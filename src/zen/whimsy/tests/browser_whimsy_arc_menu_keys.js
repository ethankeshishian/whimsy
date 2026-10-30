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
