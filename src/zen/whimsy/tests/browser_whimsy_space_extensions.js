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
  "resource://gre/modules/ContextualIdentityService.sys.mjs"
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

  extension = ExtensionTestUtils.loadExtension({
    manifest: {
      browser_action: { default_title: "Whimsy test" },
    },
  });
  await extension.startup();
  extensionId = extension.extension.id;
  widgetId = `${ExtensionCommon.makeWidgetId(extensionId)}-browser-action`;
  // Force the CUI node into existence in the always-present toolbar, so
  // .forWindow(window).node isn't null before the panel has ever opened.
  await gUnifiedExtensions.pinToToolbar(widgetId, true);

  registerCleanupFunction(async () => {
    Services.prefs.clearUserPref(FEATURE);
    // Clears the map entry and re-applies, which resets the per-extension
    // container restriction (and whimsy.extensions.space-isolation-managed)
    // before the final clearUserPref below, regardless of which task last ran.
    WhimsySpaceExtensions.setAllowedSpaces(window, extensionId, null);
    Services.prefs.clearUserPref(VISIBILITY_PREF);
    Services.prefs.clearUserPref(MANAGED_PREF);
    await extension.unload();
    if (gZenWorkspaces.activeWorkspace != firstSpace.uuid) {
      await gZenWorkspaces.changeWorkspaceWithID(firstSpace.uuid);
    }
    await gZenWorkspaces.removeWorkspace(containerSpace.uuid);
    ContextualIdentityService.remove(container.userContextId);
  });
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

add_task(async function test_show_in_spaces_menu_is_injected() {
  const menu = WhimsySpaceExtensions.ensureMenuItems(window);
  ok(menu, "The unified-extensions-context-menu popup exists");
  const item = document.getElementById("whimsy-space-extensions-menu");
  ok(item, "The Show in Spaces submenu was injected");
  is(document.l10n.getAttributes(item).id, "whimsy-space-extensions-menu");

  WhimsySpaceExtensions._pendingExtensionId = extensionId;
  WhimsySpaceExtensions.setAllowedSpaces(window, extensionId, [containerSpace.uuid]);
  const popup = document.getElementById("whimsy-space-extensions-menupopup");
  WhimsySpaceExtensions.updateSpacePicker(window, popup);
  const allItem = popup.firstElementChild;
  ok(!allItem.hasAttribute("checked"), "\"All Spaces\" isn't checked while restricted");
  const spaceItem = [...popup.children].find(child => child.getAttribute("label") == containerSpace.name);
  ok(spaceItem?.hasAttribute("checked"), "The allowed space is checked");

  WhimsySpaceExtensions.setAllowedSpaces(window, extensionId, null);
});
