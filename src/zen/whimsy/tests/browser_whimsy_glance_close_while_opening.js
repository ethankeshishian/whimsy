/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// W32 flaky (external_links): a Glance opened from a link first draws a
// snapshot of the link, and its tab can close during that wait. Zen then
// read the gone Glance's entry and the opening threw ("this.#glances.get(...)
// is undefined"). The overlay's glance-closed-while-opening hotfix ends the
// opening quietly, and the next Glance opens as usual.

const { openGlanceOnTab } = ChromeUtils.importESModule("resource://testing-common/GlanceTestUtils.sys.mjs");

const SYSTEM_PRINCIPAL = Services.scriptSecurityManager.getSystemPrincipal();

add_task(async function test_glance_closed_while_its_preview_is_drawn() {
  const parent = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.org/");
  // A link's rect, as a click sends it: the opening awaits its snapshot.
  const opening = gZenGlanceManager.openGlance({
    url: "https://example.com/",
    clientX: 10,
    clientY: 10,
    width: 40,
    height: 20,
    triggeringPrincipal: SYSTEM_PRINCIPAL,
  });
  const glanceTab = gBrowser.selectedTab;
  ok(glanceTab.hasAttribute("zen-glance-tab"), "The Glance's tab is selected before the snapshot");
  // Closing with its tab is allowed mid-opening (Escape isn't).
  await gZenGlanceManager.closeGlance({ onTabClose: true, skipPermitUnload: true });
  is(await opening, null, "The opening ends without a Glance and doesn't throw");
  await TestUtils.waitForCondition(() => !glanceTab.isConnected, "The Glance's tab is gone");
  ok(!parent.hasAttribute("glance-id"), "The parent has no Glance");

  // Nothing is left stuck: the next Glance opens all the way.
  await openGlanceOnTab(window, async tab => {
    const wrapper = tab.linkedBrowser.closest(".browserContainer");
    await TestUtils.waitForCondition(
      () => wrapper.getAttribute("has-finished-animation") == "true",
      "The next Glance finishes opening"
    );
  });
  BrowserTestUtils.removeTab(parent);
});
