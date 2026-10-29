/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// External links in Glance: where a link from another app (OPEN_EXTERNAL)
// lands. "glance" previews it over the current tab, via
// WhimsyExternalLinks wrapping BrowserDOMWindow's openURI. "quick-window" is
// for a future Little-Arc-style quick window Whimsy doesn't have yet (not
// in this repo: no "quick window" or "Little Arc" code exists), so it's
// plumbed through now and falls back to "tab" behavior until it does.

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

// Not wired up yet (no quick window in this build): falls back to a tab.
add_task(async function test_quick_window_target_falls_back_to_a_tab() {
  Services.prefs.setStringPref("whimsy.external-links.target", "quick-window");
  const context = openExternal("https://example.com/");
  ok(context, "Falls back to Firefox's own handling");
  const tab = gBrowser.getTabForBrowser(context.embedderElement);
  ok(tab && !tab.hasAttribute("glance-id"), "Opens as a plain tab until Whimsy has a quick window");
  BrowserTestUtils.removeTab(tab);
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
  await BrowserTestUtils.withNewTab("about:preferences#zenTabManagement", async browser => {
    const doc = browser.contentDocument;
    const group = await TestUtils.waitForCondition(() => doc.getElementById("whimsyExternalLinksTarget"), "Settings row shown");
    await TestUtils.waitForCondition(() => group.value == "tab", "Shows the default target");
    group.value = "glance";
    group.dispatchEvent(new browser.contentWindow.Event("command", { bubbles: true }));
    await TestUtils.waitForCondition(
      () => Services.prefs.getStringPref("whimsy.external-links.target") == "glance",
      "Choosing a target sets the pref"
    );
  });
  Services.prefs.clearUserPref("whimsy.external-links.target");
});
