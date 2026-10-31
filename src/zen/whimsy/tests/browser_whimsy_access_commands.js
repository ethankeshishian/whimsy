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
  cmd_whimsyTreeToggleBranch: "whimsy-action-tree-toggle",
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
  cmd_whimsyOpenClaudeSpace: "whimsy-action-open-claude-space",
  cmd_whimsyWhatsNew: "whimsy-action-whats-new",
  cmd_whimsyViewClaudeReplays: "whimsy-action-view-claude-replays",
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
  is(keyEl.getAttribute("key"), "Y", "Zoom Interface In takes it");
  await SpecialPowers.pushPrefEnv({ set: [["whimsy.ui-zoom", 100]] });
  EventUtils.synthesizeKey("y", { accelKey: true, altKey: true, shiftKey: true });
  await TestUtils.waitForCondition(() => Services.prefs.getIntPref("whimsy.ui-zoom") == 110, "The shortcut zooms the interface");
  await SpecialPowers.popPrefEnv();
  WhimsyCommands.reset(entry.id);
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

  ok(available("whimsy-action-background-mute-off"), "Stop Muting Background Tabs while muting");
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

add_task(async function test_tree_branch() {
  await SpecialPowers.pushPrefEnv({ set: [["whimsy.feature.tree-tabs", true], ["whimsy.tabs.tree-style", "tree"]] });
  const parent = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.com/?tree-parent");
  ok(!WhimsyAccessCommands.branchTab(window), "A tab without children has no branch");
  ok(!available("whimsy-action-tree-collapse"), "so Collapse isn't offered");
  const child = BrowserTestUtils.addTab(gBrowser, "https://example.com/?tree-child", { openerBrowser: parent.linkedBrowser });
  await BrowserTestUtils.browserLoaded(child.linkedBrowser);
  is(WhimsyAccessCommands.branchTab(window), parent, "The current tab's branch");
  ok(available("whimsy-action-tree-collapse"), "Collapse Tab Children");
  document.getElementById("cmd_whimsyTreeToggleBranch").doCommand();
  ok(parent.hasAttribute("whimsy-tree-collapsed"), "The branch collapses");
  ok(available("whimsy-action-tree-expand"), "then Expand Tab Children");
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
  ok(!available("whimsy-action-show-hidden-spaces") || WhimsyAccessCommands.hiddenSpaces(window).length, "Show Hidden Spaces… only when a space is hidden");
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
