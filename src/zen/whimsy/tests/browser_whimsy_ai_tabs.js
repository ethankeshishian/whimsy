/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// AI Tabs mochitest:
// (1) Arc Tidy Tabs (with strict Arc parity on the >6 Today Tabs boundary)
// (2) Auto-rename tabs to short titles, with strict manual-name preservation

const { WhimsyAI } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyAI.sys.mjs");
const { WhimsyAIProviders } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyAIProviders.sys.mjs");
const { WhimsyAITabs } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyAITabs.sys.mjs");

const initialTabs = new Set(gBrowser.tabs);

registerCleanupFunction(async () => {
  Services.prefs.clearUserPref("whimsy.ai.provider");
  Services.prefs.clearUserPref("whimsy.ai.blocked");
  Services.prefs.clearUserPref("whimsy.feature.tidy-tabs");
  Services.prefs.clearUserPref("whimsy.ai.auto-rename-tabs");
  WhimsyAIProviders.setFakeHandler(null);

  for (const tab of gBrowser.tabs) {
    if (!initialTabs.has(tab)) {
      BrowserTestUtils.removeTab(tab);
    }
  }
});

add_task(async function test_tidy_tabs_boundary_and_grouping() {
  WhimsyAIProviders.provider = "fake";

  // Clean initial tabs
  const createdTabs = [];
  // Create 6 tabs (Arc rule: needs MORE than 6 tabs to tidy)
  for (let i = 0; i < 6; i++) {
    const tab = BrowserTestUtils.addTab(gBrowser, "https://example.com/page" + i);
    tab.label = `Page ${i}`;
    createdTabs.push(tab);
  }

  // Boundary check: With 6 tabs or fewer, tidyTabs must refuse
  const result6 = await WhimsyAITabs.tidyTabs(window);
  ok(!result6.success, "tidyTabs refused with 6 tabs");
  is(result6.reason, "min-tabs", "Reason is min-tabs (strictly more than six required)");

  // Add the 7th tab to cross the boundary (>6)
  const tab7 = BrowserTestUtils.addTab(gBrowser, "https://example.com/page6");
  tab7.label = "Page 6";
  createdTabs.push(tab7);

  // Set mock cluster response
  WhimsyAIProviders.setFakeHandler(({ prompt }) => {
    ok(prompt.includes("Page 0"), "Prompt included tab data");
    return {
      text: JSON.stringify([
        { name: "Research", indices: [0, 1, 2] },
        { name: "Reference", indices: [3, 4] },
      ]),
    };
  });

  // Tidy Tabs with 7 tabs
  const result7 = await WhimsyAITabs.tidyTabs(window);
  ok(result7.success, "tidyTabs succeeded with 7 tabs");
  ok(result7.groupsCreated >= 1, "Topic folders created");

  // Clean up added tabs
  for (const tab of createdTabs) {
    BrowserTestUtils.removeTab(tab);
  }
});

add_task(async function test_tidy_tabs_blocked_by_kill_switch() {
  WhimsyAIProviders.provider = "fake";
  Services.prefs.setBoolPref(WhimsyAI.PREF, true);

  const res = await WhimsyAITabs.tidyTabs(window);
  ok(!res.success, "tidyTabs failed when kill switch was active");
  is(res.reason, "blocked", "Failed due to kill switch");

  Services.prefs.setBoolPref(WhimsyAI.PREF, false);
});

add_task(async function test_auto_rename_preserves_manual_names() {
  WhimsyAIProviders.provider = "fake";
  WhimsyAIProviders.setFakeHandler(() => ({
    text: "Short Title",
  }));

  const tab = BrowserTestUtils.addTab(gBrowser, "https://example.com/docs/api/long-title");
  tab.label = "Example Domain - Long Noisy Title With Suffix - Official Docs";

  // 1. Auto-rename standard noisy tab
  const shortened = await WhimsyAITabs.autoRenameTab(tab);
  is(shortened, "Short Title", "Tab was auto-renamed to short title");
  is(tab.zenStaticLabel, "Short Title", "Tab static label set");
  ok(tab._whimsyAutoRenamed, "Marked as auto-renamed");

  // 2. User manually renames the tab
  tab.zenStaticLabel = "My Custom Manual Name";
  tab._whimsyAutoRenamed = false; // Manual edit clears auto-renamed flag

  // 3. Attempting auto-rename again must NOT overwrite manual name!
  const secondAttempt = await WhimsyAITabs.autoRenameTab(tab);
  is(secondAttempt, null, "autoRenameTab returned null when manual name was present");
  is(tab.zenStaticLabel, "My Custom Manual Name", "Manual name strictly preserved");

  BrowserTestUtils.removeTab(tab);
});
