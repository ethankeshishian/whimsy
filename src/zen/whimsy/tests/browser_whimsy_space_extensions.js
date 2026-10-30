/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// ext: per-space extensions
//
// "Show in Spaces…" (an extension's gear menu, unified extensions panel):
// hides its toolbar button/panel row outside the chosen spaces. Where a
// space has its own container, Whimsy also restricts the extension's
// tabs/webNavigation/webRequest/proxy access to that container (real
// Firefox isolation, extensions.userContextIsolation.*) — but never
// content scripts, and never the default "no container" (0).

const { WhimsySpaceExtensions } = ChromeUtils.importESModule(
  "resource:///modules/whimsy/WhimsySpaceExtensions.sys.mjs"
);
const { ContextualIdentityService } = ChromeUtils.importESModule(
  "moz-src:///toolkit/components/contextualidentity/ContextualIdentityService.sys.mjs"
);
const { ExtensionCommon } = ChromeUtils.importESModule("resource://gre/modules/ExtensionCommon.sys.mjs");

const FEATURE = "whimsy.feature.space-extensions";
const VISIBILITY_PREF = "whimsy.extensions.space-visibility";
const MANAGED_PREF = "whimsy.extensions.space-isolation-managed";
const ISOLATION_ENABLED_PREF = "extensions.userContextIsolation.enabled";

let firstSpace, containerSpace, container;
let extension, extensionId, widgetId;

function restrictedPref() {
  return `extensions.userContextIsolation.${extensionId}.restricted`;
}

add_setup(async function () {
  firstSpace = gZenWorkspaces.getWorkspaces().find(w => w.uuid == gZenWorkspaces.activeWorkspace);
  container = ContextualIdentityService.create("Whimsy Test Container", "fingerprint", "blue");
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
    // Clears the map entry and re-applies, which resets the per-extension
    // container restriction (and whimsy.extensions.space-isolation-managed)
    // before the final clearUserPref below, regardless of which task last ran.
    WhimsySpaceExtensions.setAllowedSpaces(window, extensionId, null);
    Services.prefs.clearUserPref(VISIBILITY_PREF);
    Services.prefs.clearUserPref(MANAGED_PREF);
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
    },
  });
  await extension.startup();
  extensionId = extension.id;
  widgetId = `${ExtensionCommon.makeWidgetId(extensionId)}-browser-action`;
  // Force the CUI node into existence in the always-present toolbar, so
  // .forWindow(window).node isn't null before the panel has ever opened.
  await gUnifiedExtensions.pinToToolbar(widgetId, true);
});

function widgetNode() {
  return CustomizableUI.getWidget(widgetId)?.forWindow(window)?.node;
}

add_task(async function test_default_is_visible_everywhere() {
  is(WhimsySpaceExtensions.getAllowedSpaces(extensionId), null, "No restriction by default");
  ok(WhimsySpaceExtensions.isVisibleInSpace(extensionId, firstSpace.uuid), "Visible in the first space");
  ok(WhimsySpaceExtensions.isVisibleInSpace(extensionId, containerSpace.uuid), "Visible in the container space");
});

add_task(async function test_visibility_across_space_switches() {
  WhimsySpaceExtensions.setAllowedSpaces(window, extensionId, [containerSpace.uuid]);

  await gZenWorkspaces.changeWorkspaceWithID(firstSpace.uuid);
  ok(widgetNode().hidden, "Hidden in a space that isn't allowed");

  await gZenWorkspaces.changeWorkspaceWithID(containerSpace.uuid);
  ok(!widgetNode().hidden, "Shown in the allowed space");

  await gZenWorkspaces.changeWorkspaceWithID(firstSpace.uuid);
  ok(widgetNode().hidden, "Hidden again switching back");
});

add_task(async function test_persistence() {
  const stored = JSON.parse(Services.prefs.getStringPref(VISIBILITY_PREF, "{}"));
  Assert.deepEqual(
    stored[extensionId]?.spaces,
    [containerSpace.uuid],
    "The choice persisted to the real pref, not just in memory"
  );
  // A fresh read (simulating a later session) sees the same value.
  Assert.deepEqual(WhimsySpaceExtensions.getAllowedSpaces(extensionId), [containerSpace.uuid]);
});

add_task(async function test_feature_switch_off_restores_everything() {
  is(gZenWorkspaces.activeWorkspace, firstSpace.uuid, "Starting hidden (from the previous task)");
  ok(widgetNode().hidden, "Confirmed hidden with the feature on");

  Services.prefs.setBoolPref(FEATURE, false);
  WhimsySpaceExtensions.applyVisibility(window);
  ok(!widgetNode().hidden, "The feature switch restores visibility everywhere, choice still stored");
  Assert.deepEqual(
    WhimsySpaceExtensions.getAllowedSpaces(extensionId),
    [containerSpace.uuid],
    "Turning the switch off doesn't discard the per-extension choice"
  );

  Services.prefs.clearUserPref(FEATURE);
  WhimsySpaceExtensions.applyVisibility(window);
  ok(widgetNode().hidden, "Re-enabling the switch re-applies the stored choice");
});

add_task(async function test_container_isolation_only_for_a_real_container() {
  // Restricted away from firstSpace, whose container is 0 ("no container");
  // container 0 is never restricted, so the restricted list stays empty —
  // the gap the feature doesn't close.
  WhimsySpaceExtensions.setAllowedSpaces(window, extensionId, [containerSpace.uuid]);
  is(
    Services.prefs.getStringPref(restrictedPref(), "[]"),
    "[]",
    "The default container is never isolated"
  );

  // Restricted away from containerSpace, whose container is real and not
  // shared with any allowed space: it does get isolated.
  WhimsySpaceExtensions.setAllowedSpaces(window, extensionId, [firstSpace.uuid]);
  Assert.deepEqual(
    JSON.parse(Services.prefs.getStringPref(restrictedPref(), "[]")),
    [container.userContextId],
    "A space's own container is restricted when the extension isn't allowed there"
  );
  ok(Services.prefs.getBoolPref(ISOLATION_ENABLED_PREF), "Isolation enabled while any extension is restricted");
});

add_task(async function test_feature_off_clears_container_isolation() {
  Services.prefs.setBoolPref(FEATURE, false);
  WhimsySpaceExtensions.applyContainerIsolation(window);
  is(
    Services.prefs.getStringPref(restrictedPref(), "[]"),
    "[]",
    "Turning the feature off resets the container restriction Whimsy had set"
  );

  Services.prefs.clearUserPref(FEATURE);
  WhimsySpaceExtensions.setAllowedSpaces(window, extensionId, null);
});

// Exercise the user's entry points; calling ensureMenuItems directly used to
// hide missing wiring and never tested the trigger extension ID.
add_task(async function test_panel_gear_space_choice() {
  await BrowserTestUtils.withNewTab("https://example.com/", async () => {
    WhimsySpaceExtensions.setAllowedSpaces(window, extensionId, null);
    await gUnifiedExtensions.pinToToolbar(widgetId, false);
    const panel = gUnifiedExtensions.panel;
    const panelShown = BrowserTestUtils.waitForPopupEvent(panel, "shown");
    const view = panel.querySelector("panelmultiview").getAttribute("mainViewId");
    await gUnifiedExtensions.togglePanel(undefined, undefined, panel, view);
    await panelShown;
    const gear = widgetNode().querySelector(".unified-extensions-item-menu-button");
    const menu = document.getElementById("unified-extensions-context-menu");
    const shown = BrowserTestUtils.waitForPopupEvent(menu, "shown");
    EventUtils.synthesizeMouseAtCenter(gear, {});
    await shown;
    const item = menu.querySelector("[data-whimsy-space-menu]");
    ok(item && !item.hidden, "Space choice is reachable from the real gear menu");
    is(item.extensionId, extensionId, "Gear resolves the extension without test state");
    const popup = item.firstElementChild;
    const pickerShown = BrowserTestUtils.waitForPopupEvent(popup, "shown");
    item.open = true;
    await pickerShown;
    const spaceItem = [...popup.children].find(child => child.getAttribute("label") === containerSpace.name);
    ok(spaceItem, "Picker contains the other space");
    spaceItem.doCommand();
    Assert.deepEqual(WhimsySpaceExtensions.getAllowedSpaces(extensionId), [containerSpace.uuid]);
    popup.hidePopup();
    menu.hidePopup();
    panel.hidePopup();
    WhimsySpaceExtensions.setAllowedSpaces(window, extensionId, null);
    await gUnifiedExtensions.pinToToolbar(widgetId, true);
  });
});

add_task(async function test_toolbar_context_choice_and_switch() {
  const menu = document.getElementById("toolbar-context-menu");
  const shown = BrowserTestUtils.waitForPopupEvent(menu, "shown");
  EventUtils.synthesizeMouseAtCenter(widgetNode().querySelector(".unified-extensions-item-action-button"),
    { type: "contextmenu", button: 2 });
  await shown;
  const item = menu.querySelector("[data-whimsy-space-menu]");
  ok(item && !item.hidden, "Pinned extension has the same choice");
  is(item.extensionId, extensionId, "Toolbar resolves the target extension");
  Services.prefs.setBoolPref(FEATURE, false);
  WhimsySpaceExtensions.updateContextMenu(window, menu);
  ok(item.hidden, "Feature off hides the choice");
  Services.prefs.clearUserPref(FEATURE);
  menu.hidePopup();
});

add_task(async function test_about_addons_can_recover_hidden_extension() {
  WhimsySpaceExtensions.setAllowedSpaces(window, extensionId, []);
  ok(widgetNode().hidden, "Extension hidden everywhere before opening Add-ons");
  await BrowserTestUtils.withNewTab("about:addons", async browser => {
    const doc = browser.contentDocument;
    const manager = browser.contentWindow;
    await TestUtils.waitForCondition(() => manager.promiseInitialized, "Add-ons manager ready");
    await manager.promiseInitialized;
    manager.loadView("addons://list/extension");
    const card = await TestUtils.waitForCondition(() =>
      [...doc.querySelectorAll("addon-card")].find(c => c.addon?.id === extensionId));
    const item = await TestUtils.waitForCondition(() =>
      card.querySelector("[data-whimsy-space-picker]"));
    ok(!item.hidden, "Hidden extension remains manageable in about:addons");
    card.querySelector(".more-options-button").click();
    item.click();
    const choices = card.querySelector("[data-whimsy-space-choices]");
    ok(choices, "Gear action opens the space choices");
    ok([...choices.querySelectorAll("input")].every(input => !input.checked), "Empty selection is preserved");
    choices.querySelector("input").click();
    is(WhimsySpaceExtensions.getAllowedSpaces(extensionId), null, "All Spaces restores visibility");
    ok(!widgetNode().hidden, "Toolbar returns after using the Add-ons picker");
    Services.prefs.setBoolPref(FEATURE, false);
    await TestUtils.waitForCondition(() => item.hidden, "Feature off hides Add-ons action");
    ok(!card.querySelector("[data-whimsy-space-choices]"), "Feature off removes open choices");
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
    is(help.textContent.trim(), "Each space can have its own extensions.", "Settings uses one plain line");
  });
});
