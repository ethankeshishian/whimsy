/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// External links: where a link from another app (OPEN_EXTERNAL) lands.
// "glance" previews it over the current tab; "quick-window" (batch12) opens
// it in Mini Whimsy, WhimsyQuickWindow's take on Arc's Little Arc; "tab" is
// Firefox's own behavior. WhimsyExternalLinks wraps BrowserDOMWindow's
// openURI to branch on these.

const SYSTEM_PRINCIPAL = Services.scriptSecurityManager.getSystemPrincipal();

function openExternal(url) {
  return window.browserDOMWindow.openURI(
    Services.io.newURI(url),
    null,
    Ci.nsIBrowserDOMWindow.OPEN_NEWTAB,
    Ci.nsIBrowserDOMWindow.OPEN_EXTERNAL,
    SYSTEM_PRINCIPAL
  );
}

function closeGlanceIfAny() {
  return gBrowser.selectedTab.hasAttribute("glance-id") ? gZenGlanceManager.closeGlance({ onTabClose: true }) : null;
}

registerCleanupFunction(() => Services.prefs.clearUserPref("whimsy.external-links.target"));

// Opening a quick-window makes WhimsyQuickWindow remember its size. Nothing
// here cares about that, so just restore whatever it held before.
const SIZE_PREF = "whimsy.quick-window.size";
const HAD_SIZE = Services.prefs.prefHasUserValue(SIZE_PREF);
const SIZE_VALUE = HAD_SIZE ? Services.prefs.getStringPref(SIZE_PREF) : "";
registerCleanupFunction(() => {
  if (HAD_SIZE) {
    Services.prefs.setStringPref(SIZE_PREF, SIZE_VALUE);
  } else {
    Services.prefs.clearUserPref(SIZE_PREF);
  }
});

add_task(async function test_glance_target_opens_a_glance_and_returns_null() {
  Services.prefs.setStringPref("whimsy.external-links.target", "glance");
  const context = openExternal("https://example.com/");
  is(context, null, "openURI returns null: the link was handled as a Glance, not a new browsing context");
  await TestUtils.waitForCondition(
    () => gBrowser.tabs.some(t => t.hasAttribute("glance-id")),
    "A Glance opens over the current tab"
  );
  await closeGlanceIfAny();
});

add_task(async function test_tab_target_opens_a_normal_tab() {
  Services.prefs.setStringPref("whimsy.external-links.target", "tab");
  const context = openExternal("https://example.com/");
  ok(context, "openURI returns the new browsing context");
  const tab = gBrowser.getTabForBrowser(context.embedderElement);
  ok(tab && !tab.hasAttribute("glance-id"), "A plain tab, not a Glance");
  BrowserTestUtils.removeTab(tab);
});

// batch12: opens in Whimsy's quick window, not a tab in this window.
add_task(async function test_quick_window_target_opens_a_quick_window() {
  Services.prefs.setStringPref("whimsy.external-links.target", "quick-window");
  const tabCountBefore = gBrowser.tabs.length;
  const newWindow = BrowserTestUtils.waitForNewWindow();
  const context = openExternal("https://example.com/");
  is(context, null, "openURI returns null: handled by the quick window, not a new browsing context here");
  is(gBrowser.tabs.length, tabCountBefore, "No new tab opened in this window");
  const win = await newWindow;
  ok(win._whimsyQuickWindow, "Opened Whimsy's quick window");
  await BrowserTestUtils.closeWindow(win);
});

// A link a Space Routing rule claims goes to that rule's space as a tab,
// not into Mini Whimsy or a Glance (owner, W29: a "unicorner" rule still
// opened the link in Mini Whimsy).
add_task(async function test_routed_link_skips_mini_and_glance() {
  const { gZenSpaceRoutingManager: routing } = ChromeUtils.importESModule(
    "resource:///modules/zen/spacerouting/ZenSpaceRoutingManager.sys.mjs"
  );
  const home = gZenWorkspaces.activeWorkspace;
  const space = await gZenWorkspaces.createAndSaveWorkspace("Routed", undefined, true);
  await gZenWorkspaces.changeWorkspaceWithID(home);
  const route = routing.createNewRoute();
  route.reference = "routed-here";
  route.openIn = space.uuid;
  routing.updateRoute(route);
  try {
    for (const target of ["quick-window", "glance"]) {
      Services.prefs.setStringPref("whimsy.external-links.target", target);
      const context = openExternal("https://example.com/?routed-here");
      ok(context, `${target}: a routed link opens as a tab, not in ${target}`);
      const tab = gBrowser.getTabForBrowser(context.embedderElement);
      ok(tab && !tab.hasAttribute("glance-id"), `${target}: a plain tab`);
      await TestUtils.waitForCondition(
        () => tab.getAttribute("zen-workspace-id") == space.uuid,
        `${target}: the tab lands in the rule's space`
      );
      BrowserTestUtils.removeTab(tab);
      await gZenWorkspaces.changeWorkspaceWithID(home);
    }

    // A link no rule claims still goes to Mini Whimsy.
    Services.prefs.setStringPref("whimsy.external-links.target", "quick-window");
    const newWindow = BrowserTestUtils.waitForNewWindow();
    is(openExternal("https://example.com/?elsewhere"), null, "An unrouted link still goes to Mini Whimsy");
    await BrowserTestUtils.closeWindow(await newWindow);
  } finally {
    routing.removeRoute(route.id);
    await gZenWorkspaces.changeWorkspaceWithID(home);
    await gZenWorkspaces.removeWorkspace(space.uuid);
  }
});

// The feature off (not external-link-target; quick-window itself): falls
// back to a tab, same as Firefox's own handling.
add_task(async function test_quick_window_feature_off_falls_back_to_a_tab() {
  Services.prefs.setStringPref("whimsy.external-links.target", "quick-window");
  await SpecialPowers.pushPrefEnv({ set: [["whimsy.feature.quick-window", false]] });
  const context = openExternal("https://example.com/");
  ok(context, "Falls back to Firefox's own handling with the quick-window feature off");
  const tab = gBrowser.getTabForBrowser(context.embedderElement);
  ok(tab && !tab.hasAttribute("glance-id"), "Opens as a plain tab");
  BrowserTestUtils.removeTab(tab);
  await SpecialPowers.popPrefEnv();
});

add_task(async function test_feature_off_ignores_the_glance_target() {
  Services.prefs.setStringPref("whimsy.external-links.target", "glance");
  await SpecialPowers.pushPrefEnv({ set: [["whimsy.feature.external-link-target", false]] });
  const context = openExternal("https://example.com/");
  ok(context, "The switch off: openURI behaves exactly as Firefox's own, even with target=glance");
  const tab = gBrowser.getTabForBrowser(context.embedderElement);
  ok(tab && !tab.hasAttribute("glance-id"), "No Glance when the feature is off");
  BrowserTestUtils.removeTab(tab);
  await SpecialPowers.popPrefEnv();
});

add_task(async function test_settings() {
  Services.prefs.clearUserPref("whimsy.external-links.target");
  await BrowserTestUtils.withNewTab("about:preferences#whimsyLinks", async browser => {
    const doc = browser.contentDocument;
    const group = await TestUtils.waitForCondition(() => doc.getElementById("whimsyExternalLinksTarget"), "Settings row shown");
    await TestUtils.waitForCondition(() => group.value == "quick-window", "Shows the default target (Mini Whimsy)");
    group.value = "glance";
    group.dispatchEvent(new browser.contentWindow.Event("command", { bubbles: true }));
    await TestUtils.waitForCondition(
      () => Services.prefs.getStringPref("whimsy.external-links.target") == "glance",
      "Choosing a target sets the pref"
    );
  });
  Services.prefs.clearUserPref("whimsy.external-links.target");
});
