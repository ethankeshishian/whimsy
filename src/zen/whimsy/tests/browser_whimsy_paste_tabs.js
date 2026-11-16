/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// w27-tabkeys: Paste Tabs (WhimsyPasteTabs.sys.mjs). Copy already exists
// (WhimsyCopy, browser_whimsy_copy.js); this is the paste side, scoped to
// the sidebar's keyboard focus so it never competes with the native Cmd+V/
// Cmd+X a text field or the page itself expects. The clipboard itself is
// emptied after every test file by head.js's own whimsyEmptyClipboard
// cleanup (registered for every test), so this file doesn't need its own.

const { WhimsyPasteTabs, MAX_PASTE_URLS, parseUrls } = ChromeUtils.importESModule(
  "resource:///modules/whimsy/WhimsyPasteTabs.sys.mjs"
);
const { WhimsySidebarNav } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsySidebarNav.sys.mjs");
const { WhimsyCommands } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyCommands.sys.mjs");

const startTabs = new Set(gBrowser.tabs);
registerCleanupFunction(async () => {
  for (const tab of gBrowser.tabs.filter(t => !startTabs.has(t))) {
    if (tab.isConnected && !tab.closing) {
      await BrowserTestUtils.removeTab(tab);
    }
  }
});

function clipboard(flavor) {
  return SpecialPowers.getClipboardData(flavor);
}

async function waitForClipboard(expected, message) {
  await TestUtils.waitForCondition(() => clipboard("text/plain") == expected, message).catch(() => {});
  is(clipboard("text/plain"), expected, message);
}

async function clearClipboard() {
  SpecialPowers.clipboardCopyString("");
  await TestUtils.waitForCondition(() => clipboard("text/plain") == "");
}

function focusSidebarOn(tab) {
  gBrowser.selectedTab = tab;
  document.getElementById("whimsy-focus-sidebar").doCommand();
}

async function removeRow(tabs) {
  for (const tab of tabs) {
    if (tab?.isConnected && !tab.closing) {
      await BrowserTestUtils.removeTab(tab);
    }
  }
}

add_task(function test_parse_urls() {
  is(parseUrls("").length, 0, "Empty text: no URLs");
  is(parseUrls(null).length, 0, "null text: no URLs");
  Assert.deepEqual(
    parseUrls("https://example.org/a\nnot a url\nhttps://example.org/b\n\nftp://example.org/c"),
    ["https://example.org/a", "https://example.org/b"],
    "Only http(s) lines, one per line; blank lines and non-http(s) lines are ignored"
  );
  is(parseUrls("  https://example.org/trim  ")[0], "https://example.org/trim", "Lines are trimmed");

  const many = Array.from({ length: MAX_PASTE_URLS + 10 }, (_, i) => `https://example.org/${i}`).join("\n");
  is(parseUrls(many).length, MAX_PASTE_URLS, `Capped at ${MAX_PASTE_URLS}`);
});

add_task(async function test_paste_opens_clipboard_urls_below_focused_tab() {
  const anchor = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.com/?paste-anchor");
  const after = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.com/?paste-after");
  gBrowser.moveTabTo(after, { tabIndex: anchor.index + 1 });
  focusSidebarOn(anchor);

  await clearClipboard();
  const lines = ["https://example.org/paste-1", "ftp://example.org/ignored", "https://example.org/paste-2", "   "];
  SpecialPowers.clipboardCopyString(lines.join("\n"));
  await waitForClipboard(lines.join("\n"), "Clipboard set to two http(s) URLs plus noise");

  const before = new Set(gBrowser.tabs);
  EventUtils.synthesizeKey("v", { metaKey: true }, window);
  await TestUtils.waitForCondition(() => gBrowser.tabs.length == before.size + 2, "Two valid http(s) URLs opened as tabs");
  const opened = gBrowser.tabs.filter(t => !before.has(t));
  is(opened.length, 2, "The ftp:// line and the blank line are ignored");
  // Both background navigations start together and can finish in either
  // order. Wait for URI state, so an already-completed load isn't missed.
  await TestUtils.waitForCondition(
    () => opened[0].linkedBrowser.currentURI.spec == "https://example.org/paste-1" &&
      opened[1].linkedBrowser.currentURI.spec == "https://example.org/paste-2",
    "Both pasted tabs reached their target URLs"
  );
  is(opened[0].linkedBrowser.currentURI.spec, "https://example.org/paste-1", "In clipboard order");
  is(opened[1].linkedBrowser.currentURI.spec, "https://example.org/paste-2", "");
  is(gBrowser.tabs[anchor.index + 1], opened[0], "Placed right below the focused tab");
  is(gBrowser.tabs[anchor.index + 2], opened[1], "...both of them");
  is(gBrowser.tabs[anchor.index + 3], after, "...in front of the tab that was already there");
  is(gBrowser.selectedTab, anchor, "Opened in the background: the selection doesn't change");
  ok(toastFor("whimsy-paste-tabs-open-toast"), "A toast confirms the open");

  closeToasts();
  await clearClipboard();
  await removeRow([...opened, after, anchor]);
});

add_task(async function test_cut_then_paste_moves_tabs() {
  await clearClipboard();
  const anchor = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.com/?cut-anchor");
  const victim = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.com/?cut-victim");
  const target = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.com/?cut-target");
  gBrowser.moveTabTo(victim, { tabIndex: anchor.index + 1 });
  gBrowser.moveTabTo(target, { tabIndex: victim.index + 1 });

  focusSidebarOn(victim);
  EventUtils.synthesizeKey("x", { metaKey: true }, window);

  focusSidebarOn(target);
  EventUtils.synthesizeKey("v", { metaKey: true }, window);

  is(gBrowser.tabs[target.index + 1], victim, "The cut tab moved right after the newly focused tab");
  ok(toastFor("whimsy-paste-tabs-move-toast"), "A toast confirms the move");

  // One-shot: a second Cmd+V with nothing pending, and an empty clipboard, is a no-op.
  const tabsBefore = [...gBrowser.tabs];
  EventUtils.synthesizeKey("v", { metaKey: true }, window);
  is(gBrowser.tabs.length, tabsBefore.length, "Nothing left to paste and no clipboard URLs: no change");
  ok(tabsBefore.every((t, i) => gBrowser.tabs[i] == t), "...same order too");

  closeToasts();
  await removeRow([anchor, victim, target]);
});

add_task(async function test_cut_then_paste_moves_across_spaces() {
  await clearClipboard();
  const home = gZenWorkspaces.activeWorkspace;
  const other = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.com/?cut-space-anchor");
  const victim = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.com/?cut-space-victim");
  gBrowser.moveTabTo(victim, { tabIndex: other.index + 1 });

  focusSidebarOn(victim);
  EventUtils.synthesizeKey("x", { metaKey: true }, window);

  const space = await gZenWorkspaces.createAndSaveWorkspace("Paste Tabs Target Space", undefined, true, 0);
  try {
    await gZenWorkspaces.changeWorkspaceWithID(space.uuid);
    const anchor = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.com/?cut-space-target");
    focusSidebarOn(anchor);
    EventUtils.synthesizeKey("v", { metaKey: true }, window);

    await TestUtils.waitForCondition(
      () => victim.getAttribute("zen-workspace-id") == space.uuid,
      "The cut tab followed into the new space"
    );
    is(gBrowser.tabs[anchor.index + 1], victim, "...landing right after the newly focused tab");
    ok(toastFor("whimsy-paste-tabs-move-toast"), "A toast confirms the move");

    closeToasts();
    await gZenWorkspaces.changeWorkspaceWithID(home);
    await removeRow([other, anchor, victim]);
  } finally {
    await gZenWorkspaces.removeWorkspace(space.uuid);
  }
});

add_task(async function test_paste_tabs_command() {
  const entry = WhimsyCommands.get("cmd_whimsyPasteTabs");
  ok(entry, "Paste Tabs is a registered command");
  is(WhimsyCommands.title(entry), "Paste Tabs", "...named Paste Tabs");
  ok(!document.getElementById("key_whimsyPasteTabs")?.hasAttribute("key"), "No default shortcut: Cmd+V/Cmd+X stay sidebar-only");

  const anchor = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.com/?paste-cmd");
  let opened = null;
  try {
    ok(!WhimsyPasteTabs.anchorTab(window), "Not available without sidebar focus");
    focusSidebarOn(anchor);
    is(WhimsyPasteTabs.anchorTab(window), anchor, "Available once the sidebar is focused");

    await clearClipboard();
    SpecialPowers.clipboardCopyString("https://example.org/command-paste");
    await waitForClipboard("https://example.org/command-paste", "Clipboard set");

    const before = new Set(gBrowser.tabs);
    document.getElementById("cmd_whimsyPasteTabs").doCommand();
    await TestUtils.waitForCondition(() => gBrowser.tabs.length == before.size + 1, "The command pastes too");
    opened = gBrowser.tabs.find(t => !before.has(t));
    closeToasts();
  } finally {
    await clearClipboard();
    await removeRow([opened, anchor]);
  }
});

add_task(async function test_cmd_v_untouched_outside_the_sidebar() {
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.com/?paste-untouched");
  try {
    await clearClipboard();
    SpecialPowers.clipboardCopyString("https://example.org/should-not-open");
    await waitForClipboard("https://example.org/should-not-open", "Clipboard set");
    const before = gBrowser.tabs.length;

    gURLBar.focus();
    ok(!WhimsySidebarNav.focusedTab(window), "The sidebar doesn't hold focus once the URL bar does");
    EventUtils.synthesizeKey("v", { metaKey: true }, window);
    is(gBrowser.tabs.length, before, "Cmd+V in the URL bar is untouched (left to its own native paste)");
    EventUtils.synthesizeKey("x", { metaKey: true }, window);
    is(gBrowser.tabs.length, before, "Cmd+X there is untouched too");

    // A text field inside the tab strip (e.g. a folder/space being renamed).
    const input = document.createElement("input");
    gZenWorkspaces.workspaceElement(gZenWorkspaces.activeWorkspace).append(input);
    input.focus();
    ok(!WhimsySidebarNav.focusedTab(window), "...nor does a text field in the tab strip count as sidebar focus");
    EventUtils.synthesizeKey("v", { metaKey: true }, window);
    is(gBrowser.tabs.length, before, "Cmd+V in a tab-strip text field is untouched");
    input.remove();

    // The page itself.
    gBrowser.selectedTab = tab;
    tab.linkedBrowser.focus();
    ok(!WhimsySidebarNav.focusedTab(window), "...nor does the page");
    EventUtils.synthesizeKey("v", { metaKey: true }, window);
    is(gBrowser.tabs.length, before, "Cmd+V with the page focused is untouched");
  } finally {
    await clearClipboard();
    await removeRow([tab]);
  }
});

add_task(async function test_feature_off_disables_paste_tabs() {
  await SpecialPowers.pushPrefEnv({ set: [["whimsy.feature.paste-tabs", false]] });
  const anchor = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.com/?paste-off");
  try {
    focusSidebarOn(anchor);
    await clearClipboard();
    SpecialPowers.clipboardCopyString("https://example.org/should-not-open-either");
    await waitForClipboard("https://example.org/should-not-open-either", "Clipboard set");

    const before = gBrowser.tabs.length;
    EventUtils.synthesizeKey("v", { metaKey: true }, window);
    is(gBrowser.tabs.length, before, "With the feature off, Cmd+V in the sidebar is left to Zen/Firefox");

    document.getElementById("cmd_whimsyPasteTabs").doCommand();
    is(gBrowser.tabs.length, before, "...and the Paste Tabs command itself no-ops too");
  } finally {
    await clearClipboard();
    await removeRow([anchor]);
    await SpecialPowers.popPrefEnv();
  }
});
