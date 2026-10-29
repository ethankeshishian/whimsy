/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// Peek from pinned tabs / Essentials: Zen's shouldOpenTabInGlance already
// opens a link to a different site from a pinned (or Essential) tab as a
// Glance, gated by zen.glance.open-essential-external-links. Whimsy only
// adds a Settings checkbox for that pref (Settings → Look and Feel → Look);
// the behavior itself is Zen's. Known limitation, not fixed here: the host
// comparison is exact (example.com and sub.example.com count as different
// sites), since fixing it needs a Zen-file edit.

registerCleanupFunction(() => {
  Services.prefs.clearUserPref("zen.glance.open-essential-external-links");
});

async function openFromPinnedTab(pinnedTab, url) {
  const onOpen = BrowserTestUtils.waitForNewTab(gBrowser, url, false);
  await SpecialPowers.spawn(pinnedTab.linkedBrowser, [url], u => {
    content.open(u, "_blank");
  });
  return onOpen;
}

add_task(async function test_peek_opens_glance_from_pinned_tab() {
  ok(
    Services.prefs.getBoolPref("zen.glance.open-essential-external-links"),
    "On by default"
  );
  const pinnedTab = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.com/");
  gBrowser.pinTab(pinnedTab);

  const glanceTab = await openFromPinnedTab(pinnedTab, "https://example.org/");
  ok(glanceTab.hasAttribute("zen-glance-tab"), "A different-site link from a pinned tab opens as a Glance");

  await gZenGlanceManager.closeGlance({ onTabClose: true });
  BrowserTestUtils.removeTab(pinnedTab);
});

add_task(async function test_pref_off_opens_a_normal_tab() {
  await SpecialPowers.pushPrefEnv({ set: [["zen.glance.open-essential-external-links", false]] });
  const pinnedTab = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.com/");
  gBrowser.pinTab(pinnedTab);

  const tab = await openFromPinnedTab(pinnedTab, "https://example.org/");
  ok(!tab.hasAttribute("zen-glance-tab"), "Pref off: the link opens as a normal tab");

  BrowserTestUtils.removeTab(tab);
  BrowserTestUtils.removeTab(pinnedTab);
  await SpecialPowers.popPrefEnv();
});

add_task(async function test_settings() {
  await BrowserTestUtils.withNewTab("about:preferences#zenLooks", async browser => {
    const doc = browser.contentDocument;
    const checkbox = await TestUtils.waitForCondition(
      () => doc.getElementById("whimsyPeekEssentialLinks"),
      "Settings row shown"
    );
    ok(checkbox.checked, "Reflects the pref (on by default)");
    checkbox.checked = false;
    checkbox.dispatchEvent(new browser.contentWindow.Event("command", { bubbles: true }));
    await TestUtils.waitForCondition(
      () => !Services.prefs.getBoolPref("zen.glance.open-essential-external-links"),
      "Unchecking the row turns the Zen pref off"
    );
  });
});

add_task(async function test_feature_switch_hides_the_row() {
  await SpecialPowers.pushPrefEnv({ set: [["whimsy.feature.peek-essential-links", false]] });
  await BrowserTestUtils.withNewTab("about:preferences#zenLooks", async browser => {
    const doc = browser.contentDocument;
    await TestUtils.waitForCondition(() => doc.getElementById("whimsyLookGroup"), "Look group shown");
    is(doc.getElementById("whimsyPeekEssentialLinks"), null, "The row isn't added when the feature is off");
  });
  await SpecialPowers.popPrefEnv();
});
