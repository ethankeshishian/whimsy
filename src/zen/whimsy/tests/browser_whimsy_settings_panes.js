/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// fix/panes: Firefox's Appearance and Tabs and browsing panes are merged into
// Zen's Look and Feel and Tab Management. Every Firefox control keeps one
// visible home, old links land there, and Settings search finds them.
// Inventory: docs/whimsy/settings-panes.md.

// [setting id, pane, setting whose visibility it also needs]
const LOOKS = [
  ["web-appearance-chooser", "paneZenLooks"],
  ["uiDensity", "paneZenLooks"],
  ["uiDensityAutoTouchMode", "paneZenLooks", "uiDensity"],
  ["browser-icon-box-group", "paneZenLooks"],
];
const TABS = [
  ["linkTargeting", "paneZenTabManagement"],
  ["switchToNewTabs", "paneZenTabManagement"],
  ["openAppLinksNextToActiveTab", "paneZenTabManagement"],
  ["warnOpenMany", "paneZenTabManagement"],
  ["ctrlTabRecentlyUsedOrder", "paneZenTabManagement"],
  ["tabPreviewShowThumbnails", "paneZenTabManagement"],
  ["tabGroupSuggestions", "paneZenTabManagement"],
  ["tabGroupDragToCreate", "paneZenTabManagement"],
  ["showTabsInTaskbar", "paneZenTabManagement"],
  ["browserContainersCheckbox", "paneZenTabManagement", "browserContainersbox"],
  ["browserContainersSettings", "paneZenTabManagement", "browserContainersbox"],
  ["warnCloseMultiple", "paneZenTabManagement"],
  ["warnOnQuitKey", "paneZenTabManagement"],
  ["useCursorNavigation", "paneZenTabManagement"],
  ["searchStartTyping", "paneZenTabManagement"],
  ["linkPreviewEnabled", "paneZenTabManagement"],
  ["highlightToSearchEnabled", "paneZenTabManagement"],
  ["pictureInPictureToggleEnabled", "paneZenTabManagement"],
  ["pictureInPictureEnableWhenSwitchingTabs", "paneZenTabManagement", "pictureInPictureToggleEnabled"],
  ["playDRMContent", "paneZenTabManagement"],
  ["useRecommendedPerformanceSettings", "paneZenTabManagement"],
  ["allowHWAccel", "paneZenTabManagement"],
  ["cfrRecommendations", "paneZenTabManagement"],
  ["cfrRecommendations-features", "paneZenTabManagement"],
];
// Firefox's Home pane has these too; they come to Tab Management only while
// Zen hides Home (zen.urlbar.replace-newtab, on by default).
const STARTUP = [
  ["browserRestoreSession", "paneZenTabManagement"],
  ["zenWorkspaceContinueWhereLeftOff", "paneZenTabManagement"],
  ["alwaysCheckDefault", "paneZenTabManagement"],
];
// Always shown here, whatever the platform.
const CORE = [
  "web-appearance-chooser",
  "web-appearance-manage-themes-link",
  "linkTargeting",
  "switchToNewTabs",
  "ctrlTabRecentlyUsedOrder",
  "warnCloseMultiple",
  "useCursorNavigation",
  "searchStartTyping",
  "useRecommendedPerformanceSettings",
  "cfrRecommendations",
];

function shown(el) {
  for (let node = el; node && node.id != "mainPrefPane"; node = node.parentElement) {
    if (node.hidden || node.classList.contains("visually-hidden")) {
      return false;
    }
  }
  return !!el?.isConnected && el.checkVisibility();
}

const control = (doc, id) => doc.getElementById(`setting-control-${id}`);
const paneOf = el => el?.closest("#mainPrefPane > [data-category]")?.getAttribute("data-category");

async function settled(win) {
  await Promise.all([...win.document.querySelectorAll("setting-group")].map(g => g.updateComplete));
}

async function openPane(win, pane, groupId) {
  await win.gotoPref(pane);
  await TestUtils.waitForCondition(
    () => win.document.querySelector(`setting-group[groupid="${groupId}"][data-category="${pane}"]`),
    `${pane} has Firefox's ${groupId} group`
  );
  await settled(win);
}

function checkControls(win, list) {
  const doc = win.document;
  for (const [id, pane, parent] of list) {
    const setting = win.Preferences.getSetting(id);
    ok(setting, `${id} is still a Firefox setting`);
    const wanted = setting.visible && (!parent || win.Preferences.getSetting(parent).visible);
    if (CORE.includes(id)) {
      ok(wanted, `${id} is shown on every platform`);
    }
    const el = control(doc, id);
    if (!wanted) {
      ok(!el || !shown(el), `${id} stays hidden, as in Firefox`);
      continue;
    }
    ok(el, `${id} has a control`);
    is(paneOf(el), pane, `${id} is in ${pane}`);
    ok(shown(el), `${id} is visible`);
    is(doc.querySelectorAll(`[id="setting-control-${id}"]`).length, 1, `${id} has one control`);
  }
}

add_task(async function test_panes_are_merged() {
  await BrowserTestUtils.withNewTab("about:preferences#zenLooks", async browser => {
    const win = browser.contentWindow;
    const doc = browser.contentDocument;
    await openPane(win, "paneZenLooks", "appearance");

    ok(!doc.getElementById("category-appearance"), "Appearance is out of the sidebar");
    ok(!doc.getElementById("category-tabs-browsing"), "Tabs and browsing is out of the sidebar");
    ok(!doc.querySelector('setting-pane[data-category="paneAppearance"]'), "No Appearance page");
    ok(!doc.querySelector('setting-pane[data-category="paneTabsBrowsing"]'), "No Tabs and browsing page");
    ok(doc.getElementById("category-zen-looks") && doc.getElementById("category-zen-tabs-management"), "Zen's panes stay");

    checkControls(win, LOOKS);
    ok(
      !doc.querySelector('setting-group[groupid="browserTheme"]'),
      "W8-39: Browser theme group is removed (lightweight themes do not affect Zen chrome)"
    );

    // The theme chooser still drives Firefox's pref.
    registerCleanupFunction(() => Services.prefs.clearUserPref("layout.css.prefers-color-scheme.content-override"));
    doc.getElementById("preferences-web-appearance-choice-dark").click();
    await TestUtils.waitForCondition(
      () => Services.prefs.getIntPref("layout.css.prefers-color-scheme.content-override") == 0,
      "Dark sets the website appearance pref"
    );
    doc.getElementById("preferences-web-appearance-choice-auto").click();
    await TestUtils.waitForCondition(
      () => Services.prefs.getIntPref("layout.css.prefers-color-scheme.content-override") == 2,
      "System sets it back"
    );

    await openPane(win, "paneZenTabManagement", "tabs");
    const heading = doc.getElementById("whimsyTabsBrowsingCategory");
    ok(heading && paneOf(heading) == "paneZenTabManagement", "Tab Management has a Tabs and browsing section");
    checkControls(win, TABS);
    if (Services.prefs.getBoolPref("zen.urlbar.replace-newtab", true)) {
      checkControls(win, STARTUP);
    }
    // A tab setting still drives its pref.
    const pref = "browser.tabs.warnOnClose";
    const was = Services.prefs.getBoolPref(pref);
    registerCleanupFunction(() => Services.prefs.setBoolPref(pref, was));
    control(doc, "warnCloseMultiple").controlEl.click();
    await TestUtils.waitForCondition(() => Services.prefs.getBoolPref(pref) == !was, "Confirm before closing follows its checkbox");

    // Whimsy's Hardware video decoding stays right after Firefox's Performance.
    const hw = doc.getElementById("whimsyPerformanceGroup");
    if (hw) {
      is(hw.previousElementSibling?.getAttribute("groupid"), "performance", "Hardware video decoding follows Performance");
      is(hw.dataset.category, "paneZenTabManagement", "in Tab Management");
    }
  });
});

add_task(async function test_old_links_redirect() {
  const cases = [
    ["appearance", "paneZenLooks", null],
    ["paneAppearance", "paneZenLooks", null],
    ["appearance-windowDensity", "paneZenLooks", "windowDensity"],
    ["tabsBrowsing", "paneZenTabManagement", "tabsBrowsing"],
    ["paneTabsBrowsing", "paneZenTabManagement", "tabsBrowsing"],
    ["tabsBrowsing-drm", "paneZenTabManagement", "drm"],
    ["tabsBrowsing-link-preview", "paneZenTabManagement", "link-preview"],
    ["general-cfraddons", "paneZenTabManagement", "cfraddons"],
    ["tabsBrowsing-layout", "paneZenLooks", "layout"],
    ["general-layout", "paneZenLooks", "layout"],
  ];
  await BrowserTestUtils.withNewTab("about:preferences#appearance", async browser => {
    const win = browser.contentWindow;
    const doc = browser.contentDocument;
    await TestUtils.waitForCondition(() => win.gLastCategory.category == "paneZenLooks", "about:preferences#appearance opens Look and Feel");

    for (const [hash, pane, subcategory] of cases) {
      await win.gotoPref("paneSearch");
      await win.gotoPref(hash);
      is(win.gLastCategory.category, pane, `#${hash} opens ${pane}`);
      is(win.gLastCategory.subcategory, subcategory, `#${hash} keeps its subcategory`);
      is(doc.getElementById("categories").currentView, pane, `The sidebar selects ${pane}`);
      if (subcategory) {
        const targets = [...doc.querySelectorAll(`[data-subcategory~="${subcategory}"]`)];
        ok(targets.some(el => paneOf(el) == pane), `#${hash} has a target in ${pane}`);
      }
    }

    // Containers hangs off Tab Management now.
    await win.gotoPref("containers");
    is(win.gLastCategory.category, "paneContainers", "Containers still opens");
    is(doc.getElementById("categories").currentView, "paneZenTabManagement", "under Tab Management");
  });
});

add_task(async function test_search_finds_moved_controls() {
  await BrowserTestUtils.withNewTab("about:preferences#privacy", async browser => {
    const win = browser.contentWindow;
    const doc = browser.contentDocument;
    await win.gSearchResultsPane.initializeCategories();
    await settled(win);

    const cases = [
      ["Website appearance", () => doc.querySelector('setting-group[groupid="appearance"]')],
      ["Ctrl+Tab cycles", () => control(doc, "ctrlTabRecentlyUsedOrder")],
      ["cursor keys", () => control(doc, "useCursorNavigation")],
      ["recommended performance", () => control(doc, "useRecommendedPerformanceSettings")],
      ["Recommend extensions", () => control(doc, "cfrRecommendations")],
    ];
    if (Services.prefs.getBoolPref("zen.urlbar.replace-newtab", true)) {
      cases.push(["Open previous windows and tabs", () => control(doc, "browserRestoreSession")]);
    }
    const input = doc.getElementById("searchInput");
    for (const [query, find] of cases) {
      input.value = query;
      input.dispatchEvent(new win.InputEvent("input", { bubbles: true }));
      await TestUtils.waitForCondition(() => shown(find()), `Searching "${query}" shows it`);
      ok(paneOf(find()).startsWith("paneZen"), `"${query}" is found in Zen's pane`);
      const id = find().id;
      if (id) {
        is([...doc.querySelectorAll(`[id="${id}"]`)].filter(shown).length, 1, `"${query}" shows one result`);
      }
    }
    input.value = "";
    input.dispatchEvent(new win.InputEvent("input", { bubbles: true }));
  });
});
