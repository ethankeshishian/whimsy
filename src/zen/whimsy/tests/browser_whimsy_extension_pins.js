/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// W26 extpin (owner): "extensions should not be pinned to the url bar by
// default." A new extension's button starts in the site panel's Extensions
// section even when its manifest asks for the nav bar (default_area
// "navbar", which Zen's single toolbar shows in the URL bar). Pin to
// Toolbar still pins it, and the pin survives a restart. Buttons pinned
// before the change: a toolbar-default extension's goes back to the panel
// once; a panel-default extension's can only have been pinned by the user,
// so it stays.

const { CustomizableUI } = ChromeUtils.importESModule("moz-src:///browser/components/customizableui/CustomizableUI.sys.mjs");
const { AddonManager } = ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs");
const { WhimsySiteSettings } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsySiteSettings.sys.mjs");
const { MIGRATION_PREF } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyExtensionPins.sys.mjs");

const PAGE = "https://example.com/";

function widgetIdOf(id) {
  return id.toLowerCase().replace(/[^a-z0-9_-]/g, "_") + "-browser-action";
}

async function loadExtension(id, name, area) {
  const browser_action = { default_title: name };
  if (area) {
    browser_action.default_area = area;
  }
  const extension = ExtensionTestUtils.loadExtension({
    useAddonManager: "temporary",
    manifest: { name, browser_specific_settings: { gecko: { id } }, browser_action },
  });
  await extension.startup();
  const widgetId = widgetIdOf(id);
  registerCleanupFunction(() => {
    CustomizableUI.removeWidgetFromArea(widgetId);
    CustomizableUI.getTestOnlyInternalProp("gSeenWidgets").delete(widgetId);
  });
  return { extension, id, widgetId };
}

const areaOf = ext => CustomizableUI.getPlacementOfWidget(ext.widgetId, false)?.area;

// Where a pinned button shows: the nav bar, or with Zen's single toolbar the
// URL bar (before the page actions), the sidebar's top buttons or the URL
// bar's overflow list.
const TOOLBAR_PLACES = ["urlbar", "nav-bar", "zen-sidebar-top-buttons", "zen-overflow-extensions-list",
  "TabsToolbar", "PersonalToolbar"];

function toolbarButtonOf(ext) {
  for (const place of TOOLBAR_PLACES) {
    const node = document.getElementById(place)?.querySelector(`[data-extensionid="${ext.id}"]`);
    if (node) {
      return node;
    }
  }
  return null;
}

function sitePanel() {
  return document.getElementById("zen-unified-site-data-panel");
}

function panelItemOf(ext) {
  return sitePanel().querySelector(`#unified-extensions-area .unified-extensions-item[data-extensionid="${ext.id}"]`);
}

async function openSitePanel() {
  await closeSitePanel();
  gNavToolbox.setAttribute("zen-has-implicit-hover", "true");
  ok(await WhimsySiteSettings.open(window), "The site panel opened");
  is(sitePanel().state, "open", "Zen's site panel is open");
}

async function closeSitePanel() {
  if (sitePanel().state != "closed") {
    const hidden = BrowserTestUtils.waitForPopupEvent(sitePanel(), "hidden");
    sitePanel().hidePopup(true);
    await hidden;
  }
  gNavToolbox.removeAttribute("zen-has-implicit-hover");
}

async function assertInPanelOnly(ext, label) {
  is(areaOf(ext), CustomizableUI.AREA_ADDONS, `${label}: placed in the site panel's Extensions section`);
  is(toolbarButtonOf(ext), null, `${label}: no button in the URL bar or a toolbar`);
  await openSitePanel();
  try {
    await TestUtils.waitForCondition(() => panelItemOf(ext)?.checkVisibility(),
      `${label}: listed in the site panel's Extensions section`);
    ok(panelItemOf(ext).closest("#zen-site-data-section-addons"), `${label}: ...under Extensions`);
  } finally {
    await closeSitePanel();
  }
}

// What a restart does to one extension: its button is torn down and built
// again from the saved placements (ext-browserAction.js build()).
async function restartExtension(ext) {
  const addon = await AddonManager.getAddonByID(ext.id);
  await addon.disable();
  await TestUtils.waitForCondition(() => CustomizableUI.getWidget(ext.widgetId)?.provider != CustomizableUI.PROVIDER_API,
    `${ext.id}: its button is gone while it's off`);
  await addon.enable();
  await TestUtils.waitForCondition(() => CustomizableUI.getWidget(ext.widgetId)?.provider == CustomizableUI.PROVIDER_API,
    `${ext.id}: its button is back`);
}

let tab;
add_setup(async function () {
  tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE);
  registerCleanupFunction(() => BrowserTestUtils.removeTab(tab));
});

add_task(async function test_new_extensions_start_in_the_site_panel() {
  const plain = await loadExtension("plain@extpin.whimsy", "Plain Action", null);
  const navbar = await loadExtension("navbar@extpin.whimsy", "Navbar Action", "navbar");
  try {
    await assertInPanelOnly(plain, "No default_area");
    await assertInPanelOnly(navbar, "default_area navbar");

    await whimsyBothSchemes("w26-extpin-urlbar", async () => {
      is(toolbarButtonOf(navbar), null, "The URL bar shows no extension button");
    });
    await whimsyBothSchemes("w26-extpin-site-panel", async () => {
      await openSitePanel();
      await TestUtils.waitForCondition(() => panelItemOf(plain)?.checkVisibility() && panelItemOf(navbar)?.checkVisibility(),
        "Both extensions are listed");
      const undo = whimsyStandInPopups();
      return async () => {
        undo();
        await closeSitePanel();
      };
    });
  } finally {
    await plain.extension.unload();
    await navbar.extension.unload();
  }
});

add_task(async function test_pin_to_toolbar_survives_a_restart() {
  const navbar = await loadExtension("pinned@extpin.whimsy", "Pinned Action", "navbar");
  try {
    await assertInPanelOnly(navbar, "Before pinning");

    // Pin to Toolbar on the extension's own menu in the site panel.
    await openSitePanel();
    await TestUtils.waitForCondition(() => panelItemOf(navbar)?.checkVisibility(), "The extension is listed");
    const menu = document.getElementById("unified-extensions-context-menu");
    const shown = BrowserTestUtils.waitForPopupEvent(menu, "shown");
    EventUtils.synthesizeMouseAtCenter(panelItemOf(navbar), { type: "contextmenu", button: 2 });
    await shown;
    const pin = menu.querySelector(".unified-extensions-context-menu-pin-to-toolbar");
    ok(BrowserTestUtils.isVisible(pin), "Pin to Toolbar is offered");
    isnot(pin.getAttribute("checked"), "true", "...and isn't checked yet");
    const hidden = BrowserTestUtils.waitForPopupEvent(menu, "hidden");
    menu.activateItem(pin);
    await hidden;
    await TestUtils.waitForCondition(() => areaOf(navbar) == CustomizableUI.AREA_NAVBAR, "Pinned to the toolbar");
    await closeSitePanel();
    await TestUtils.waitForCondition(() => toolbarButtonOf(navbar), "Its button shows in the URL bar or toolbar");

    await restartExtension(navbar);
    is(areaOf(navbar), CustomizableUI.AREA_NAVBAR, "Still pinned after a restart");
    await TestUtils.waitForCondition(() => toolbarButtonOf(navbar), "...and its button shows again");
  } finally {
    await closeSitePanel();
    await navbar.extension.unload();
  }
});

add_task(async function test_migration_unpins_only_auto_pinned_buttons() {
  const hadSnapshot = Services.prefs.prefHasUserValue(MIGRATION_PREF);
  const snapshot = Services.prefs.getStringPref(MIGRATION_PREF, "");
  const auto = await loadExtension("auto@extpin.whimsy", "Auto Pinned", "navbar");
  const chosen = await loadExtension("chosen@extpin.whimsy", "User Pinned", null);
  try {
    // Before the change: Firefox pinned the "navbar" extension by itself,
    // and the user pinned the other one.
    CustomizableUI.addWidgetToArea(auto.widgetId, CustomizableUI.AREA_NAVBAR);
    CustomizableUI.addWidgetToArea(chosen.widgetId, CustomizableUI.AREA_NAVBAR);
    // The first run with the change, which hasn't looked at pins yet.
    Services.prefs.clearUserPref(MIGRATION_PREF);

    await restartExtension(auto);
    await restartExtension(chosen);
    is(areaOf(auto), CustomizableUI.AREA_ADDONS, "The auto-pinned button went back to the site panel");
    is(toolbarButtonOf(auto), null, "...and left the URL bar");
    is(areaOf(chosen), CustomizableUI.AREA_NAVBAR, "The button the user pinned stays pinned");
    await TestUtils.waitForCondition(() => toolbarButtonOf(chosen), "...and still shows");
    const pending = JSON.parse(Services.prefs.getStringPref(MIGRATION_PREF));
    ok(!pending.includes(auto.widgetId) && !pending.includes(chosen.widgetId), "Each was checked once");

    // Migration is once per extension: pinning it now sticks.
    CustomizableUI.addWidgetToArea(auto.widgetId, CustomizableUI.AREA_NAVBAR);
    await restartExtension(auto);
    is(areaOf(auto), CustomizableUI.AREA_NAVBAR, "Pinned again after the migration, it stays pinned");
  } finally {
    await auto.extension.unload();
    await chosen.extension.unload();
    if (hadSnapshot) {
      Services.prefs.setStringPref(MIGRATION_PREF, snapshot);
    } else {
      Services.prefs.clearUserPref(MIGRATION_PREF);
    }
  }
});
