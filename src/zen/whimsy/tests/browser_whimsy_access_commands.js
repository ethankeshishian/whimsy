/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// wave7/keys: a command, with an assignable shortcut, for each feature that
// only had Settings, a sidebar control or a context menu
// (WhimsyAccessCommands).

const { WhimsyAccessCommands, nextZoomStep, UI_ZOOM_STEPS } = ChromeUtils.importESModule(
  "resource:///modules/whimsy/WhimsyAccessCommands.sys.mjs"
);
const { WhimsyCommands } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyCommands.sys.mjs");
const { CustomKeys } = ChromeUtils.importESModule("moz-src:///browser/components/customkeys/CustomKeys.sys.mjs");
const { globalActions } = ChromeUtils.importESModule("resource:///modules/ZenUBGlobalActions.sys.mjs");

const COMMANDS = {
  cmd_whimsyShowHiddenSpaces: "whimsy-action-show-hidden-spaces",
  cmd_whimsyToggleSpaceSwitcher: "whimsy-action-space-switcher-toggle",
  cmd_whimsyZoomInterfaceIn: "whimsy-action-ui-zoom-in",
  cmd_whimsyZoomInterfaceOut: "whimsy-action-ui-zoom-out",
  cmd_whimsyZoomInterfaceReset: "whimsy-action-ui-zoom-reset",
  cmd_whimsyToggleBackgroundMute: "whimsy-action-background-mute-toggle",
  cmd_whimsyToggleBionic: "whimsy-action-bionic-toggle",
  cmd_whimsyToggleDarkPdf: "whimsy-action-dark-pdf-toggle",
  cmd_whimsyNewLiveFolder: "whimsy-action-new-live-folder",
  cmd_zenOpenFolderCreation: "whimsy-action-new-folder",
  cmd_zenManageWorkspaces: "whimsy-action-manage-spaces",
  cmd_zenOpenSpaceRoutingSettings: "whimsy-action-air-traffic-control",
  cmd_whimsyAddFinderFolder: "whimsy-action-add-finder-folder",
  cmd_whimsyWhatsNew: "whimsy-action-whats-new",
  cmd_whimsyViewClaudeReplays: "whimsy-action-view-claude-replays",
  cmd_whimsyChangeTabIcon: "whimsy-action-change-tab-icon",
};

// Unused on macOS (the registry test uses Cmd+Shift+Y).
const FREE = { modifiers: "accel,alt,shift", key: "Y" };

function action(l10nId) {
  return globalActions.find(a => a.l10nId == l10nId);
}

function available(l10nId) {
  return !!action(l10nId)?.isAvailable(window);
}

registerCleanupFunction(() => CustomKeys.resetAll());

add_task(function test_each_command_is_registered_and_unbound() {
  for (const [id, l10nId] of Object.entries(COMMANDS)) {
    const entry = WhimsyCommands.get(id);
    ok(entry, `${id} is registered`);
    is(entry?.l10nId, l10nId, `${id} has its name`);
    ok(WhimsyCommands.title(entry), `${id}: "${WhimsyCommands.title(entry)}"`);
    ok(document.getElementById(id), `${id} has a <command>`);
    const keyEl = entry?.keyId && document.getElementById(entry.keyId);
    ok(keyEl, `${id} has a <key> in Whimsy's keyset, so about:keyboard lists it`);
    is(keyEl?.parentElement.id, "whimsyKeyset", `${id}'s key is Whimsy's`);
    ok(!keyEl?.hasAttribute("key") && !keyEl?.hasAttribute("keycode"), `${id} has no default shortcut`);
    ok(
      globalActions.some(a => a.command == id || a.whimsyCommand == id),
      `${id} is in the command bar`
    );
  }
  is(document.getElementById("key_whimsyNewFolder").getAttribute("command"), "cmd_zenOpenFolderCreation", "New Folder… runs Zen's command");
  is(action("zen-action-new-folder")?.label, "New Folder…", "Zen's command-bar row has Arc's name");
  is(action("zen-action-open-space-routing")?.label, "Air Traffic Control…", "Space routing is Air Traffic Control…");
  ok(!action("whimsy-action-new-folder"), "No second New Folder row in the command bar");
});

add_task(async function test_a_shortcut_can_be_assigned() {
  const entry = WhimsyCommands.get("cmd_whimsyZoomInterfaceIn");
  ok(WhimsyCommands.rebind(entry.id, FREE).ok, "A free shortcut is accepted");
  const keyEl = document.getElementById(entry.keyId);
  try {
    is(keyEl.getAttribute("key"), "Y", "Zoom Interface In takes it");
    await SpecialPowers.pushPrefEnv({ set: [["whimsy.ui-zoom", 100]] });
    // A key shortcut reaches only the focused window: make sure it's this one
    // (as a file's first test, another browser starting at the same moment
    // can hold the OS focus; the key then did nothing).
    await SimpleTest.promiseFocus(window);
    EventUtils.synthesizeKey("y", { accelKey: true, altKey: true, shiftKey: true });
    await TestUtils.waitForCondition(() => Services.prefs.getIntPref("whimsy.ui-zoom") == 110, "The shortcut zooms the interface");
    await SpecialPowers.popPrefEnv();
  } finally {
    // Released even if the check failed, so the next test can take it.
    WhimsyCommands.reset(entry.id);
  }
  ok(!keyEl.hasAttribute("key"), "Reset leaves it unbound again");
});

add_task(async function test_interface_zoom_steps() {
  is(nextZoomStep(100, 1), 110, "In: the next Settings step");
  is(nextZoomStep(100, -1), 90, "Out: the previous one");
  is(nextZoomStep(105, 1), 110, "An odd value snaps to a step");
  is(nextZoomStep(UI_ZOOM_STEPS.at(-1), 1), null, "Nothing past 200%");
  is(nextZoomStep(UI_ZOOM_STEPS[0], -1), null, "Nothing under 80%");
  await SpecialPowers.pushPrefEnv({ set: [["whimsy.ui-zoom", 200]] });
  ok(!available("whimsy-action-ui-zoom-in"), "Zoom In is gone at 200%");
  ok(available("whimsy-action-ui-zoom-reset"), "Reset is offered when zoomed");
  document.getElementById("cmd_whimsyZoomInterfaceOut").doCommand();
  is(Services.prefs.getIntPref("whimsy.ui-zoom"), 175, "Zoom Out steps down");
  document.getElementById("cmd_whimsyZoomInterfaceReset").doCommand();
  is(Services.prefs.getIntPref("whimsy.ui-zoom"), 100, "Reset goes back to 100%");
  ok(!available("whimsy-action-ui-zoom-reset"), "and is no longer offered");
  await SpecialPowers.pushPrefEnv({ set: [["whimsy.feature.ui-zoom", false]] });
  document.getElementById("cmd_whimsyZoomInterfaceIn").doCommand();
  is(Services.prefs.getIntPref("whimsy.ui-zoom"), 100, "With the switch off the command does nothing");
  ok(!available("whimsy-action-ui-zoom-in"), "and isn't offered");
  await SpecialPowers.popPrefEnv();
  await SpecialPowers.popPrefEnv();
});

add_task(async function test_settings_toggles() {
  await SpecialPowers.pushPrefEnv({
    set: [
      ["whimsy.spaces.hide-switcher", false],
      ["whimsy.media.background-mute", "prioritize"],
      ["whimsy.pdf.dark", false],
    ],
  });
  ok(available("whimsy-action-space-switcher-hide"), "Hide Space Switcher while it shows");
  ok(!available("whimsy-action-space-switcher-show"), "not Show");
  document.getElementById("cmd_whimsyToggleSpaceSwitcher").doCommand();
  ok(Services.prefs.getBoolPref("whimsy.spaces.hide-switcher"), "The switcher hides");
  ok(available("whimsy-action-space-switcher-show"), "then Show Space Switcher");

  ok(available("whimsy-action-background-mute-off"), "Unmute Background Tabs while muting");
  document.getElementById("cmd_whimsyToggleBackgroundMute").doCommand();
  is(Services.prefs.getStringPref("whimsy.media.background-mute"), "off", "Background tabs play");
  ok(available("whimsy-action-background-mute-on"), "then Mute Background Tabs");
  document.getElementById("cmd_whimsyToggleBackgroundMute").doCommand();
  is(Services.prefs.getStringPref("whimsy.media.background-mute"), "prioritize", "Muting comes back in the default mode");

  ok(available("whimsy-action-dark-pdf-on"), "Turn Dark PDFs On");
  document.getElementById("cmd_whimsyToggleDarkPdf").doCommand();
  ok(Services.prefs.getBoolPref("whimsy.pdf.dark"), "Dark PDFs are on");
  ok(available("whimsy-action-dark-pdf-off"), "then Turn Dark PDFs Off");

  await SpecialPowers.pushPrefEnv({ set: [["whimsy.feature.hide-switcher", false]] });
  document.getElementById("cmd_whimsyToggleSpaceSwitcher").doCommand();
  ok(Services.prefs.getBoolPref("whimsy.spaces.hide-switcher"), "With its switch off the command leaves the setting");
  ok(!available("whimsy-action-space-switcher-show") && !available("whimsy-action-space-switcher-hide"), "and isn't offered");
  await SpecialPowers.popPrefEnv();
  await SpecialPowers.popPrefEnv();
});

add_task(async function test_bionic_only_in_reader() {
  ok(!available("whimsy-action-bionic-on") && !available("whimsy-action-bionic-off"), "Not offered outside Reader View");
  await SpecialPowers.pushPrefEnv({ set: [["whimsy.reader.bionic", false]] });
  WhimsyAccessCommands.toggleBionic(window);
  ok(Services.prefs.getBoolPref("whimsy.reader.bionic"), "Toggling saves the choice for the next reader page");
  await SpecialPowers.popPrefEnv();
});

// wave9/menus (design-full-4 L7): tree tabs are off, so their command isn't
// listed anywhere (no about:keyboard row, no command-bar row).
add_task(function test_tree_command_unlisted_while_tree_tabs_off() {
  ok(!Services.prefs.getBoolPref("whimsy.feature.tree-tabs"), "Tree tabs are off by default");
  ok(document.getElementById("cmd_whimsyTreeToggleBranch"), "The <command> still works");
  const entry = WhimsyCommands.get("cmd_whimsyTreeToggleBranch");
  ok(!entry?.l10nId, "It has no listed name");
  ok(!entry?.keyId || !document.getElementById(entry.keyId), "…so no <key> for about:keyboard");
  ok(!action("whimsy-action-tree-collapse") && !action("whimsy-action-tree-expand"), "…and no command-bar rows");
});

add_task(async function test_tree_branch() {
  await SpecialPowers.pushPrefEnv({ set: [["whimsy.feature.tree-tabs", true], ["whimsy.tabs.tree-style", "tree"]] });
  const parent = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.com/?tree-parent");
  ok(!WhimsyAccessCommands.branchTab(window), "A tab without children has no branch");
  const child = BrowserTestUtils.addTab(gBrowser, "https://example.com/?tree-child", { openerBrowser: parent.linkedBrowser });
  await BrowserTestUtils.browserLoaded(child.linkedBrowser);
  is(WhimsyAccessCommands.branchTab(window), parent, "The current tab's branch");
  document.getElementById("cmd_whimsyTreeToggleBranch").doCommand();
  ok(parent.hasAttribute("whimsy-tree-collapsed"), "The branch collapses");
  document.getElementById("cmd_whimsyTreeToggleBranch").doCommand();
  ok(!parent.hasAttribute("whimsy-tree-collapsed"), "and expands");
  gBrowser.selectedTab = child;
  is(WhimsyAccessCommands.branchTab(window), parent, "From a child, its parent's branch");
  await SpecialPowers.pushPrefEnv({ set: [["whimsy.feature.tree-tabs", false]] });
  ok(!WhimsyAccessCommands.branchTab(window), "Nothing to fold with tree tabs off");
  // Closed with the switch off, so closing the parent doesn't take the branch.
  BrowserTestUtils.removeTab(child);
  BrowserTestUtils.removeTab(parent);
  await SpecialPowers.popPrefEnv();
  await SpecialPowers.popPrefEnv();
});

add_task(async function test_choosers() {
  // W11-15 (d15): always available; with nothing hidden it shows an empty panel.
  ok(available("whimsy-action-show-hidden-spaces"), "Show Hidden Spaces… is always available");
  if (!WhimsyAccessCommands.liveFoldersAvailable(window)) {
    info("No live folders in this build; skipped");
    return;
  }
  const popup = WhimsyAccessCommands.newLiveFolder(window);
  ok(popup, "New Live Folder… opens a menu");
  await BrowserTestUtils.waitForPopupEvent(popup, "shown");
  const ids = [...popup.children].map(item => item.getAttribute("data-l10n-id"));
  ok(ids.includes("zen-live-folder-type-rss"), "with Zen's kinds");
  ok(ids.every(id => id), "each named by the id its handler reads");
  ok([...popup.children].every(item => item.getAttribute("command") == "cmd_zenNewLiveFolder"), "each runs Zen's command");
  popup.hidePopup();
  await BrowserTestUtils.waitForPopupEvent(popup, "hidden");
  await SpecialPowers.pushPrefEnv({ set: [["whimsy.feature.live-folders-jira", false]] });
  const again = WhimsyAccessCommands.newLiveFolder(window);
  await BrowserTestUtils.waitForPopupEvent(again, "shown");
  ok(
    ![...again.children].some(item => item.getAttribute("data-l10n-id") == "whimsy-live-folder-jira-create"),
    "Jira is left out with its switch off"
  );
  again.hidePopup();
  await BrowserTestUtils.waitForPopupEvent(again, "hidden");
  await SpecialPowers.popPrefEnv();
});

add_task(async function test_whats_new() {
  const opened = BrowserTestUtils.waitForNewTab(gBrowser, url => url.startsWith("about:whimsy"), true);
  document.getElementById("cmd_whimsyWhatsNew").doCommand();
  const tab = await opened;
  is(tab.linkedBrowser.currentURI.spec, "about:whimsy?tab=changelog", "What's New opens the changelog");
  BrowserTestUtils.removeTab(tab);
});

// W8-04: Collapse All Folders reaches nested folders, and a folder you
// open again keeps its collapsed subfolder shut. Zen's command-bar rows are
// the only ones; the commands exist for a shortcut.
add_task(async function test_collapse_and_expand_all_folders() {
  for (const id of ["cmd_whimsyCollapseAllFolders", "cmd_whimsyExpandAllFolders"]) {
    const entry = WhimsyCommands.get(id);
    ok(entry && document.getElementById(entry.keyId), `${id} has a <key>, so a shortcut can be assigned`);
    ok(!globalActions.some(a => a.whimsyCommand == id), `${id} adds no second command-bar row`);
  }
  ok(action("zen-action-collapse-all-folders"), "Zen's Collapse All Folders row stays");

  const parentTab = BrowserTestUtils.addTab(gBrowser, "data:text/html,parent");
  const childTab = BrowserTestUtils.addTab(gBrowser, "data:text/html,child");
  const subfolder = await gZenFolders.createFolder([childTab], { renameFolder: false, label: "Sub" });
  const parent = await gZenFolders.createFolder([parentTab], { renameFolder: false, label: "Parent" });
  parentTab.after(subfolder);
  await new Promise(resolve => setTimeout(resolve, 0));
  try {
    is(subfolder.parentElement?.closest("zen-folder"), parent, "The subfolder is nested");
    document.getElementById("cmd_whimsyCollapseAllFolders").doCommand();
    await TestUtils.waitForCondition(() => parent.collapsed && subfolder.collapsed, "Both levels collapse");
    await TestUtils.waitForCondition(() => childTab.getBoundingClientRect().height == 0, "The nested tab is hidden");

    parent.collapsed = false;
    await TestUtils.waitForCondition(() => parentTab.getBoundingClientRect().height > 0, "The parent opens");
    await new Promise(resolve => setTimeout(resolve, 400)); // eslint-disable-line mozilla/no-arbitrary-setTimeout
    ok(subfolder.collapsed, "The subfolder stays collapsed");
    is(childTab.getBoundingClientRect().height, 0, "…and its tab stays hidden");

    document.getElementById("cmd_whimsyExpandAllFolders").doCommand();
    await TestUtils.waitForCondition(() => !parent.collapsed && !subfolder.collapsed, "Expand All opens both");
    await TestUtils.waitForCondition(() => childTab.getBoundingClientRect().height > 0, "The nested tab shows");
  } finally {
    for (const folder of [subfolder, parent]) {
      if (folder.isConnected) {
        const removed = BrowserTestUtils.waitForEvent(folder, "TabGroupRemoved");
        folder.delete();
        await removed;
      }
    }
    for (const tab of [parentTab, childTab]) {
      if (tab.isConnected && !tab.closing) {
        BrowserTestUtils.removeTab(tab);
      }
    }
  }
});

// W9-07: an Essential gets a custom icon from Zen's Change Icon (its
// right-click menu) or from Change Tab Icon…, a command that can take a
// shortcut. Both open the same picker and save the same icon.
add_task(async function test_change_tab_icon_on_an_essential() {
  const picker = document.getElementById("PanelUI-zen-emojis-picker");
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, "data:text/html,<title>essential</title>icon");
  gZenPinnedTabManager.addToEssentials(tab);
  await TestUtils.waitForCondition(() => tab.hasAttribute("zen-essential"), "An Essential");
  gBrowser.selectedTab = tab;
  try {
    // The right-click entry.
    const menu = document.getElementById("tabContextMenu");
    let shown = BrowserTestUtils.waitForEvent(menu, "popupshown");
    EventUtils.synthesizeMouseAtCenter(tab, { type: "contextmenu", button: 2 });
    await shown;
    const item = document.getElementById("context_zen-edit-tab-icon");
    ok(item && !item.hidden, "The Essential's menu has Change Icon");
    let hidden = BrowserTestUtils.waitForEvent(menu, "popuphidden");
    menu.hidePopup();
    await hidden;

    // The command, with a shortcut the person can assign.
    ok(available("whimsy-action-change-tab-icon"), "The command bar offers Change Tab Icon… for the Essential");
    const entry = WhimsyCommands.get("cmd_whimsyChangeTabIcon");
    ok(WhimsyCommands.rebind(entry.id, FREE).ok, "A shortcut can be assigned");
    shown = BrowserTestUtils.waitForEvent(picker, "popupshown");
    await SimpleTest.promiseFocus(window);
    EventUtils.synthesizeKey("y", { accelKey: true, altKey: true, shiftKey: true });
    await shown;
    ok(true, "The shortcut opens Zen's icon picker");
    const glyph = await TestUtils.waitForCondition(
      () => [...gZenEmojiPicker.svgList.children].find(b => b.hasAttribute("icon")),
      "The picker lists its glyphs"
    );
    glyph.doCommand();
    await TestUtils.waitForCondition(() => tab.zenStaticIcon, "The Essential keeps the picked icon");
    is(gBrowser.getIcon(tab), tab.zenStaticIcon, "The Essential shows it");
    hidden = BrowserTestUtils.waitForEvent(picker, "popuphidden");
    picker.hidePopup();
    await hidden;
    WhimsyCommands.reset(entry.id);
  } finally {
    gZenPinnedTabManager.removeEssentials(tab);
    BrowserTestUtils.removeTab(tab);
  }
});
