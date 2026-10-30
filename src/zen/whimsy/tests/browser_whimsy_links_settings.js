/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// System pass: Settings → Links holds every setting about where links open
// (links from other apps, Glance, split view, space routing), each in one
// place only, and each still drives its pref.

const LINK_SETTINGS = [
  "whimsyExternalLinksTarget",
  "whimsyGlanceSize",
  "whimsyPeekEssentialLinks",
  "whimsySplitLinkShiftClick",
  "whimsyFollowerTabs",
  "whimsyAtcButton",
  "zenLooksAndFeelGlanceEnabled",
  "zenGlanceTrigger",
];

const inLinksPane = el => !!el?.closest('[data-category="paneWhimsyLinks"]');

add_task(async function test_links_pane_has_every_link_setting() {
  await BrowserTestUtils.withNewTab("about:preferences#whimsyLinks", async browser => {
    const doc = browser.contentDocument;
    const nav = await TestUtils.waitForCondition(() => doc.getElementById("category-whimsy-links"), "Links is in the sidebar");
    is(nav.getAttribute("view"), "paneWhimsyLinks", "It opens the Links pane");
    const heading = await TestUtils.waitForCondition(() => doc.getElementById("whimsyLinksCategory"), "The pane is built");
    await TestUtils.waitForCondition(() => heading.checkVisibility(), "It's showing");
    for (const id of LINK_SETTINGS) {
      const el = doc.getElementById(id);
      ok(el, `${id} exists`);
      ok(inLinksPane(el), `${id} is in Links`);
      is(doc.querySelectorAll(`#${id}`).length, 1, `${id} is in one place only`);
    }
    ok(!doc.getElementById("zenGlanceCategory"), "Look and Feel's Glance heading is gone");
    ok(!doc.getElementById("whimsyLinksGlanceGroup"), "Whimsy's Glance rows joined Zen's Glance group");
    is(doc.getElementById("whimsyGlanceSize").closest("groupbox").id, "zenGlanceGroup", "One Glance group");

    // Each still drives its pref.
    const target = doc.getElementById("whimsyExternalLinksTarget");
    target.value = "tab";
    target.dispatchEvent(new browser.contentWindow.Event("command", { bubbles: true }));
    await TestUtils.waitForCondition(
      () => Services.prefs.getStringPref("whimsy.external-links.target") == "tab",
      "Links from other apps → a new tab"
    );
    const shift = doc.getElementById("whimsySplitLinkShiftClick");
    const was = Services.prefs.getBoolPref("whimsy.splitlink.shift-click");
    shift.checked = !was;
    shift.dispatchEvent(new browser.contentWindow.Event("command", { bubbles: true }));
    await TestUtils.waitForCondition(
      () => Services.prefs.getBoolPref("whimsy.splitlink.shift-click") == !was,
      "Shift-click to split follows its checkbox"
    );
    const follower = doc.getElementById("whimsyFollowerTabs");
    follower.checked = false;
    follower.dispatchEvent(new browser.contentWindow.Event("command", { bubbles: true }));
    await TestUtils.waitForCondition(
      () => !Services.prefs.getBoolPref("whimsy.feature.follower-tabs"),
      "Follower splits follows its checkbox"
    );
  });
  for (const pref of ["whimsy.external-links.target", "whimsy.splitlink.shift-click", "whimsy.feature.follower-tabs"]) {
    Services.prefs.clearUserPref(pref);
  }
});

add_task(async function test_old_places_no_longer_have_them() {
  for (const pane of ["zenLooks", "zenTabManagement"]) {
    await BrowserTestUtils.withNewTab(`about:preferences#${pane}`, async browser => {
      const doc = browser.contentDocument;
      const group = pane == "zenLooks" ? "whimsyLookGroup" : "whimsyTabsGroup";
      await TestUtils.waitForCondition(() => doc.getElementById(group), `${pane} is built`);
      for (const id of LINK_SETTINGS) {
        const el = doc.getElementById(id);
        ok(!el || (inLinksPane(el) && !el.checkVisibility()), `${id} isn't shown in ${pane}`);
      }
      // Opening Links after Look and Feel still gathers Zen's Glance group.
      if (pane == "zenLooks") {
        await browser.contentWindow.gotoPref("paneWhimsyLinks");
        const glance = await TestUtils.waitForCondition(() => doc.getElementById("zenGlanceGroup"));
        await TestUtils.waitForCondition(() => glance.checkVisibility(), "Glance shows under Links");
        ok(doc.getElementById("whimsyGlanceSize").closest("#zenGlanceGroup"), "With the Glance size row");
      }
    });
  }
});

add_task(async function test_feature_switch_removes_a_row() {
  await SpecialPowers.pushPrefEnv({ set: [["whimsy.feature.follower-tabs", false], ["whimsy.feature.atc-settings", false]] });
  await BrowserTestUtils.withNewTab("about:preferences#whimsyLinks", async browser => {
    const doc = browser.contentDocument;
    await TestUtils.waitForCondition(() => doc.getElementById("whimsyLinksCategory"), "The pane is built");
    ok(!doc.getElementById("whimsyLinksSpacesGroup"), "No space routing while its feature is off, and its emptied group goes");
    const follower = doc.getElementById("whimsyFollowerTabs");
    ok(follower, "A checkbox that is its own switch stays, so it can be turned back on");
    await TestUtils.waitForCondition(() => !follower.checked, "…unchecked");
    ok(doc.getElementById("whimsySplitLinkShiftClick"), "Its neighbours stay");
  });
  await SpecialPowers.popPrefEnv();
});
