/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// ext → wave5/profiles: extensions per profile ("Run in Profiles", which
// replaced "Show in Spaces…"). Outside its profiles an extension's toolbar
// button hides, Firefox's container restriction keeps its tabs/webRequest/
// proxy APIs away, and Whimsy's process script keeps its content scripts
// off the pages. Default (container 0) is a profile like any other.

const { WhimsySpaceExtensions } = ChromeUtils.importESModule(
  "resource:///modules/whimsy/WhimsySpaceExtensions.sys.mjs"
);
const { WhimsyProfiles } = ChromeUtils.importESModule(
  "resource:///modules/whimsy/WhimsyProfiles.sys.mjs"
);
const { ContextualIdentityService } = ChromeUtils.importESModule(
  "moz-src:///toolkit/components/contextualidentity/ContextualIdentityService.sys.mjs"
);
const { ExtensionCommon } = ChromeUtils.importESModule("resource://gre/modules/ExtensionCommon.sys.mjs");

const FEATURE = "whimsy.feature.space-extensions";
const PROFILES_PREF = "whimsy.profiles.extensions";
const OLD_PREF = "whimsy.extensions.space-visibility";
const MANAGED_PREF = "whimsy.extensions.space-isolation-managed";
const PAGE = "https://example.com/";

let firstSpace, containerSpace, container, containerKey;
let extension, extensionId, widgetId;

function restrictedPref() {
  return `extensions.userContextIsolation.${extensionId}.restricted`;
}

function restricted() {
  return JSON.parse(Services.prefs.getStringPref(restrictedPref(), "[]"));
}

add_setup(async function () {
  firstSpace = gZenWorkspaces.getWorkspaces().find(w => w.uuid == gZenWorkspaces.activeWorkspace);
  container = ContextualIdentityService.create("Whimsy Test Profile", "fingerprint", "blue");
  containerKey = WhimsyProfiles.keyFor(container.userContextId);
  containerSpace = await gZenWorkspaces.createAndSaveWorkspace(
    "Container Space",
    undefined,
    true,
    container.userContextId
  );

  // Registered before loadExtension, whose own cleanup (which runs first,
  // in registration order) would otherwise flag the extension as left running.
  registerCleanupFunction(async () => {
    Services.prefs.clearUserPref(FEATURE);
    WhimsySpaceExtensions.setAllowedProfiles(extensionId, null);
    for (const pref of [PROFILES_PREF, OLD_PREF, MANAGED_PREF]) {
      Services.prefs.clearUserPref(pref);
    }
    await extension?.unload();
    if (gZenWorkspaces.activeWorkspace != firstSpace.uuid) {
      await gZenWorkspaces.changeWorkspaceWithID(firstSpace.uuid);
    }
    await gZenWorkspaces.removeWorkspace(containerSpace.uuid);
    ContextualIdentityService.remove(container.userContextId);
  });

  extension = ExtensionTestUtils.loadExtension({
    useAddonManager: "temporary",
    manifest: {
      browser_action: { default_title: "Whimsy test" },
      content_scripts: [{ matches: ["https://example.com/*"], js: ["cs.js"], run_at: "document_end" }],
    },
    files: {
      "cs.js": "document.documentElement.dataset.whimsyExtension = 'ran';",
    },
  });
  await extension.startup();
  extensionId = extension.id;
  widgetId = `${ExtensionCommon.makeWidgetId(extensionId)}-browser-action`;
  WhimsySpaceExtensions.initWindow(window);
  // Force the CUI node into existence in the always-present toolbar, so
  // .forWindow(window).node isn't null before the panel has ever opened.
  await gUnifiedExtensions.pinToToolbar(widgetId, true);
});

function widgetNode() {
  return CustomizableUI.getWidget(widgetId)?.forWindow(window)?.node;
}

add_task(async function test_default_is_all_profiles() {
  is(WhimsySpaceExtensions.getAllowedProfiles(extensionId), null, "No limit by default");
  ok(WhimsySpaceExtensions.isAllowedIn(extensionId, "default"), "Runs in Default");
  ok(WhimsySpaceExtensions.isAllowedIn(extensionId, containerKey), "Runs in the other profile");
  Assert.deepEqual(restricted(), [], "Nothing restricted");
});

add_task(async function test_visibility_follows_the_space_profile() {
  WhimsySpaceExtensions.setAllowedProfiles(extensionId, [containerKey]);
  await gZenWorkspaces.changeWorkspaceWithID(firstSpace.uuid);
  ok(widgetNode().hidden, "Hidden in a Default space");
  await gZenWorkspaces.changeWorkspaceWithID(containerSpace.uuid);
  ok(!widgetNode().hidden, "Shown in a space of its profile");
  await gZenWorkspaces.changeWorkspaceWithID(firstSpace.uuid);
  ok(widgetNode().hidden, "Hidden again switching back");
  Assert.deepEqual(JSON.parse(Services.prefs.getStringPref(PROFILES_PREF))[extensionId][0], [containerKey],
    "Stored by profile key, in the synced map");
});

add_task(async function test_isolation_includes_default() {
  WhimsySpaceExtensions.setAllowedProfiles(extensionId, [containerKey]);
  ok(restricted().includes(0), "Default (container 0) is restricted too: it's a profile");
  ok(!restricted().includes(container.userContextId), "Its own profile isn't");
  is(WebExtensionPolicy.getByID(extensionId).extension.userContextIsolation, true,
    "The running extension honours the restriction");

  const fresh = WhimsyProfiles.create("Whimsy Ext Fresh");
  try {
    await TestUtils.waitForCondition(() => restricted().includes(fresh), "A new profile starts restricted");
  } finally {
    ContextualIdentityService.remove(fresh);
  }

  WhimsySpaceExtensions.setAllowedProfiles(extensionId, ["default"]);
  // Every profile but Default, whatever this profile already has (the test
  // profile keeps Firefox's stock containers, which are profiles too).
  const others = WhimsyProfiles.list().filter(p => p.key != "default").map(p => p.id);
  ok(others.includes(container.userContextId), "The other profile is among them");
  Assert.deepEqual([...restricted()].sort((a, b) => a - b), others.sort((a, b) => a - b),
    "Only Default: every other profile is off-limits");
});

add_task(async function test_content_scripts_stay_in_their_profiles() {
  const ran = async userContextId => {
    const tab = BrowserTestUtils.addTab(gBrowser, PAGE, { userContextId });
    try {
      await BrowserTestUtils.browserLoaded(tab.linkedBrowser);
      return await SpecialPowers.spawn(tab.linkedBrowser, [], async () => {
        await new Promise(resolve => content.setTimeout(resolve, 500));
        return content.document.documentElement.dataset.whimsyExtension ?? "";
      });
    } finally {
      BrowserTestUtils.removeTab(tab);
    }
  };
  WhimsySpaceExtensions.setAllowedProfiles(extensionId, [containerKey]);
  is(await ran(container.userContextId), "ran", "Runs on pages of its profile");
  is(await ran(0), "", "Doesn't run on Default's pages");
  Services.prefs.setBoolPref(FEATURE, false);
  is(await ran(0), "ran", "Feature off: runs everywhere again");
  Services.prefs.clearUserPref(FEATURE);
  WhimsySpaceExtensions.setAllowedProfiles(extensionId, null);
  is(await ran(0), "ran", "All Profiles: runs everywhere");
});

add_task(async function test_feature_switch_off_restores_everything() {
  WhimsySpaceExtensions.setAllowedProfiles(extensionId, [containerKey]);
  ok(widgetNode().hidden, "Hidden in Default with the feature on");
  Services.prefs.setBoolPref(FEATURE, false);
  WhimsySpaceExtensions.applyVisibility(window);
  ok(!widgetNode().hidden, "The feature switch restores visibility everywhere");
  ok(!Services.prefs.prefHasUserValue(restrictedPref()), "…and clears the restriction");
  Assert.deepEqual(WhimsySpaceExtensions.getAllowedProfiles(extensionId), [containerKey],
    "Turning the switch off keeps the choice");
  Services.prefs.clearUserPref(FEATURE);
  WhimsySpaceExtensions.applyVisibility(window);
  ok(widgetNode().hidden, "Re-enabling re-applies it");
  WhimsySpaceExtensions.setAllowedProfiles(extensionId, null);
});

add_task(async function test_show_in_spaces_migrates_to_profiles() {
  WhimsySpaceExtensions.setAllowedProfiles(extensionId, null);
  Services.prefs.setStringPref(OLD_PREF, JSON.stringify({ [extensionId]: { spaces: [containerSpace.uuid] } }));
  WhimsySpaceExtensions.migrateSpaceChoices(window);
  Assert.deepEqual(WhimsySpaceExtensions.getAllowedProfiles(extensionId), [containerKey],
    "A space choice becomes that space's profile");
  ok(!Services.prefs.prefHasUserValue(OLD_PREF), "The old choice is gone");
  WhimsySpaceExtensions.setAllowedProfiles(extensionId, null);
});

add_task(async function test_panel_context_space_choice() {
  await BrowserTestUtils.withNewTab("https://example.com/", async () => {
    WhimsySpaceExtensions.setAllowedProfiles(extensionId, null);
    await gUnifiedExtensions.pinToToolbar(widgetId, false);
    const panel = gUnifiedExtensions.panel;
    const panelShown = BrowserTestUtils.waitForPopupEvent(panel, "shown");
    const anchor = document.getElementById("zen-site-data-icon-button");
    ok(anchor.checkVisibility(), "Zen's site-controls entry point is visible");
    info("Opening the extensions panel from site controls");
    anchor.click();
    await panelShown;
    // Zen deliberately hides Firefox's gear button in its compact panel.
    // Its visible extension icon exposes the same actions on right-click.
    const action = widgetNode().querySelector(".unified-extensions-item-action-button");
    ok(action.getBoundingClientRect().width > 0, "The extension action is visible in the panel");
    const shown = BrowserTestUtils.waitForEvent(document, "popupshown", false, event =>
      ["unified-extensions-context-menu", "toolbar-context-menu"].includes(event.target.id));
    info("Opening the visible extension's context menu");
    EventUtils.synthesizeMouseAtCenter(action, { type: "contextmenu", button: 2 });
    const { target: menu } = await shown;
    const item = menu.querySelector("[data-whimsy-profile-menu]");
    ok(item && !item.hidden, "Run in Profiles is reachable from the visible panel icon");
    is(item.extensionId, extensionId, "Panel context menu resolves the extension without test state");
    const popup = item.menupopup;
    const pickerShown = BrowserTestUtils.waitForPopupEvent(popup, "shown");
    info("Opening Run in Profiles");
    item.openMenu(true);
    await pickerShown;
    const defaultItem = [...popup.children].find(child => child.dataset?.profileKey === "default");
    ok(defaultItem?.hasAttribute("checked"), "Picker lists Default, checked (All Profiles)");
    defaultItem.doCommand();
    ok(!WhimsySpaceExtensions.getAllowedProfiles(extensionId).includes("default"),
      "Unchecking Default limits it to the other profiles");
    ok(WhimsySpaceExtensions.getAllowedProfiles(extensionId).includes(containerKey), "…which stay");
    // Close every layer and wait, so the next test's context menu can open.
    for (const layer of [popup, menu, panel]) {
      if (layer.state != "closed") {
        const hidden = BrowserTestUtils.waitForPopupEvent(layer, "hidden");
        layer.hidePopup();
        await hidden;
      }
    }
    WhimsySpaceExtensions.setAllowedProfiles(extensionId, null);
    await gUnifiedExtensions.pinToToolbar(widgetId, true);
  });
});

add_task(async function test_toolbar_context_choice_and_switch() {
  const menu = document.getElementById("toolbar-context-menu");
  // Zen reveals pinned extension icons in the address bar only while the
  // pointer is over the sidebar, so hover there first as a user would.
  const action = widgetNode().querySelector(".unified-extensions-item-action-button");
  EventUtils.synthesizeMouseAtCenter(gURLBar.inputField, { type: "mousemove" });
  await TestUtils.waitForCondition(() => action.checkVisibility({ visibilityProperty: true }) &&
    action.getBoundingClientRect().height > 0, "Hovering the sidebar shows the pinned extension");
  const shown = BrowserTestUtils.waitForPopupEvent(menu, "shown");
  EventUtils.synthesizeMouseAtCenter(action, { type: "contextmenu", button: 2 });
  await shown;
  const item = menu.querySelector("[data-whimsy-profile-menu]");
  ok(item && !item.hidden, "Pinned extension has the same choice");
  is(item.extensionId, extensionId, "Toolbar resolves the target extension");
  Services.prefs.setBoolPref(FEATURE, false);
  WhimsySpaceExtensions.updateContextMenu(window, menu);
  ok(item.hidden, "Feature off hides the choice");
  Services.prefs.clearUserPref(FEATURE);
  menu.hidePopup();
});

add_task(async function test_about_addons_can_recover_hidden_extension() {
  WhimsySpaceExtensions.setAllowedProfiles(extensionId, []);
  ok(widgetNode().hidden, "Extension hidden everywhere before opening Add-ons");
  await BrowserTestUtils.withNewTab("about:addons", async browser => {
    const doc = browser.contentDocument;
    const manager = browser.contentWindow;
    await TestUtils.waitForCondition(() => "promiseInitialized" in manager, "Add-ons manager ready");
    await manager.promiseInitialized;
    manager.loadView("addons://list/extension");
    const card = await TestUtils.waitForCondition(() =>
      [...doc.querySelectorAll("addon-card")].find(c => c.addon?.id === extensionId), "Installed extension card appears");
    const item = await TestUtils.waitForCondition(() =>
      card.querySelector("[data-whimsy-profile-picker]"), "Run in Profiles is attached");
    ok(!item.hidden, "Hidden extension remains manageable in about:addons");
    card.querySelector(".more-options-button").click();
    item.click();
    const choices = card.querySelector("[data-whimsy-profile-choices]");
    ok(choices, "Gear action opens the profile choices");
    ok([...choices.querySelectorAll("input")].every(input => !input.checked), "Empty selection is preserved");
    const profileInput = choices.querySelectorAll("input")[1];
    profileInput.focus();
    const key = profileInput.dataset.profile;
    profileInput.click();
    is(card.ownerDocument.activeElement.dataset.profile, key, "Toggling a profile keeps keyboard focus on it");
    ok(card.querySelector("[data-whimsy-profile-choices] .whimsy-profile-choices-note"),
      "The picker says the extension's data is shared");
    card.querySelector("[data-whimsy-profile-choices] input").click();
    is(WhimsySpaceExtensions.getAllowedProfiles(extensionId), null, "All Profiles restores it everywhere");
    ok(!widgetNode().hidden, "Toolbar returns after using the Add-ons picker");
    Services.prefs.setBoolPref(FEATURE, false);
    await TestUtils.waitForCondition(() => item.hidden, "Feature off hides Add-ons action");
    ok(!card.querySelector("[data-whimsy-profile-choices]"), "Feature off removes open choices");
    Services.prefs.clearUserPref(FEATURE);
    await TestUtils.waitForCondition(() => !item.hidden, "Re-enable restores Add-ons action");
  });
});

add_task(async function test_settings_plain_subtitle() {
  await BrowserTestUtils.withNewTab("about:preferences#zenTabManagement", async browser => {
    const doc = browser.contentDocument;
    const help = await TestUtils.waitForCondition(() =>
      doc.querySelector('#whimsyExtensionsGroup [data-l10n-id="whimsy-space-extensions-help"]'));
    await doc.l10n.translateElements([help]);
    ok(help.textContent.includes("shared by every profile"), "Settings says plainly what isn't separate");
  });
});
