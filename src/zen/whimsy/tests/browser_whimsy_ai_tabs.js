/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// Tidy Tabs (Arc Max): with more than six Today tabs, a broom on the
// pinned/Today line sorts them into named sections under headers, still in
// Today. New tabs open above the sections; a header can be removed, turned
// into a folder or close its tabs. Tidy tab titles (Arc parity): only
// pinning renames a tab, Today tabs keep the page's title, typed names are
// never touched. Everything uses a fake AI provider.

const { WhimsyAIProviders } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyAIProviders.sys.mjs");
const { WhimsyAITabs, MIN_TIDY_TABS } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyAITabs.sys.mjs");

const PAGE = getRootDirectory(gTestPath).replace("chrome://mochitests/content", "https://example.com") + "whimsy_ai_page.html";
const SHORT = "Planning Notes";

const startTabs = new Set(gBrowser.tabs);
let requests = [];

// Sections by site: every line of the tab list is "i. title (host/path)".
function fakeProvider({ prompt, system }) {
  requests.push({ prompt, system });
  if (/tab titles/i.test(system)) {
    return SHORT;
  }
  const bySite = new Map();
  for (const [, index, host] of prompt.matchAll(/^(\d+)\. .* \(([^/)]+)/gm)) {
    const name = host.includes("example.org") ? "Org Reading" : "Com Research";
    if (!bySite.has(name)) {
      bySite.set(name, []);
    }
    bySite.get(name).push(Number(index));
  }
  return JSON.stringify({ sections: [...bySite].map(([name, tabs]) => ({ name, tabs })) });
}

add_setup(async () => {
  WhimsyAIProviders.setTestProvider(fakeProvider);
  registerCleanupFunction(async () => {
    WhimsyAIProviders.setTestProvider(null);
    Services.prefs.clearUserPref("whimsy.ai.blocked");
    Services.prefs.clearUserPref("whimsy.feature.tidy-tabs");
    Services.prefs.clearUserPref("whimsy.feature.tidy-titles");
    for (const folder of gBrowser.tabGroups.filter(g => g.isZenFolder && g.label == "Org Reading")) {
      const removed = BrowserTestUtils.waitForEvent(folder, "TabGroupRemoved");
      folder.delete();
      await removed;
    }
    for (const tab of gBrowser.tabs.filter(t => !startTabs.has(t))) {
      BrowserTestUtils.removeTab(tab);
    }
  });
});

function broom() {
  return gZenWorkspaces.activeWorkspaceElement?.querySelector(".pinned-tabs-container-separator .whimsy-tidy-broom");
}

function headers() {
  return [...gZenWorkspaces.activeWorkspaceElement.querySelectorAll(".whimsy-tidy-header")];
}

async function openTodayTabs(count) {
  const tabs = [];
  for (let i = 0; i < count; i++) {
    const host = i % 2 ? "example.org" : "example.com";
    tabs.push(await BrowserTestUtils.openNewForegroundTab(gBrowser, `https://${host}/tidy-${i}`));
  }
  return tabs;
}

add_task(async function test_six_seven_boundary() {
  ok(Services.prefs.getBoolPref("whimsy.feature.tidy-tabs"), "The feature switch is on");
  is(MIN_TIDY_TABS, 7, "Arc: more than six Today tabs");
  const have = WhimsyAITabs.todayTabs(window).length;
  const opened = await openTodayTabs(Math.max(0, 6 - have));
  is(WhimsyAITabs.todayTabs(window).length, 6, "Six Today tabs");
  await TestUtils.waitForTick();
  await new Promise(r => requestAnimationFrame(r));
  ok(!broom() || broom().hidden, "No broom with six");
  requests = [];
  is(await WhimsyAITabs.tidy(window), null, "Tidying six does nothing");
  is(requests.length, 0, "and asks no AI");

  opened.push(...(await openTodayTabs(1)));
  await TestUtils.waitForCondition(() => broom() && !broom().hidden, "The broom shows with seven");
  ok(broom().nextElementSibling?.classList.contains("zen-workspace-close-unpinned-tabs-button"), "next to Clear");
});

add_task(async function test_tidy() {
  if (WhimsyAITabs.todayTabs(window).length < 7) {
    await openTodayTabs(7 - WhimsyAITabs.todayTabs(window).length);
  }
  const pinned = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.net/pinned");
  gBrowser.pinTab(pinned);
  requests = [];
  const done = TestUtils.waitForCondition(() => headers().length >= 2, "Headers appear");
  broom().doCommand();
  await done;
  ok(requests.length >= 1, "The provider was asked");
  ok(!/example\.net\/pinned/.test(requests.at(-1).prompt), "Pinned tabs are never sent or tidied");

  const names = headers().map(h => h.getAttribute("whimsy-tidy-name"));
  ok(names.includes("Com Research") && names.includes("Org Reading"), "Sections are named by the AI");
  for (const header of headers()) {
    const first = header.nextElementSibling;
    is(first.localName, "tab", "A header sits right above a tab");
    is(first.getAttribute("whimsy-tidy-section"), header.getAttribute("whimsy-tidy-section"), "of its section");
    ok(!first.pinned, "still in Today");
  }
  const org = gBrowser.tabs.filter(t => t.getAttribute("whimsy-tidy-name") == "Org Reading");
  for (let i = 1; i < org.length; i++) {
    is(WhimsyAITabs.neighborTab(org[i - 1], true), org[i], "A section's tabs are together");
  }
  ok(!pinned.hasAttribute("whimsy-tidy-section"), "The pinned tab isn't in a section");
  await TestUtils.waitForCondition(
    () => [...(document.getElementById("zen-toast-container")?.children ?? [])].some(t => t._messageId == "whimsy-tidy-done"),
    "A toast says what happened"
  );
  BrowserTestUtils.removeTab(pinned);
});

add_task(async function test_new_tab_above_sections() {
  const firstHeader = headers()[0];
  const lastTab = WhimsyAITabs.todayTabs(window).at(-1);
  gBrowser.selectedTab = lastTab;
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.com/new");
  await TestUtils.waitForCondition(
    () => firstHeader.compareDocumentPosition(tab) & Node.DOCUMENT_POSITION_PRECEDING,
    "A new tab goes above the sections"
  );
  ok(!tab.hasAttribute("whimsy-tidy-section"), "and isn't in one");
  BrowserTestUtils.removeTab(tab);
});

add_task(async function test_header_actions() {
  let header = headers().find(h => h.getAttribute("whimsy-tidy-name") == "Com Research");
  const id = header.getAttribute("whimsy-tidy-section");
  const members = WhimsyAITabs.sectionTabs(window, id);
  ok(members.length >= 2, "The section has tabs");

  // Right-click → Remove Header keeps the tabs.
  const menu = document.getElementById("whimsy-tidy-header-menu");
  ok(menu, "Headers have a context menu");
  const shown = BrowserTestUtils.waitForPopupEvent(menu, "shown");
  EventUtils.synthesizeMouseAtCenter(header, { type: "contextmenu", button: 2 });
  await shown;
  const hidden = BrowserTestUtils.waitForPopupEvent(menu, "hidden");
  menu.activateItem(menu.children[0]);
  await hidden;
  await TestUtils.waitForCondition(() => !header.isConnected, "Remove Header removes it");
  for (const tab of members) {
    ok(tab.isConnected && !tab.closing, "its tabs stay open");
    ok(!tab.hasAttribute("whimsy-tidy-section"), "out of the section");
  }

  // Move to Folder: a pinned folder named after the section.
  header = headers().find(h => h.getAttribute("whimsy-tidy-name") == "Org Reading");
  const orgTabs = WhimsyAITabs.sectionTabs(window, header.getAttribute("whimsy-tidy-section"));
  header.querySelector(".whimsy-tidy-header-folder").doCommand();
  const folder = await TestUtils.waitForCondition(() => orgTabs[0].group?.isZenFolder && orgTabs[0].group, "The tabs went into a folder");
  is(folder.label, "Org Reading", "named after the section");
  ok(orgTabs.every(t => t.group == folder), "every tab of the section");
  await TestUtils.waitForCondition(() => !headers().length, "No headers left");
});

add_task(async function test_close_section() {
  await WhimsyAITabs.tidy(window);
  if (!headers().length) {
    await openTodayTabs(7);
    await WhimsyAITabs.tidy(window);
  }
  const header = headers()[0];
  const tabs = WhimsyAITabs.sectionTabs(window, header.getAttribute("whimsy-tidy-section"));
  header.querySelector(".whimsy-tidy-header-close").doCommand();
  await TestUtils.waitForCondition(() => tabs.every(t => !t.isConnected || t.closing), "Close closes the section's tabs");
  await TestUtils.waitForCondition(() => !header.isConnected, "and its header");
});

add_task(async function test_switches_hide_the_broom() {
  if (WhimsyAITabs.todayTabs(window).length < 7) {
    await openTodayTabs(7 - WhimsyAITabs.todayTabs(window).length);
  }
  await TestUtils.waitForCondition(() => broom() && !broom().hidden, "The broom shows");
  Services.prefs.setBoolPref("whimsy.ai.blocked", true);
  await TestUtils.waitForCondition(() => broom().hidden, "The AI kill switch hides it");
  requests = [];
  is(await WhimsyAITabs.tidy(window), null, "and tidying does nothing");
  is(requests.length, 0, "without asking the AI");
  Services.prefs.clearUserPref("whimsy.ai.blocked");
  await TestUtils.waitForCondition(() => !broom().hidden, "Back on");
  Services.prefs.setBoolPref("whimsy.feature.tidy-tabs", false);
  await TestUtils.waitForCondition(() => broom().hidden, "The feature switch hides it too");
  Services.prefs.clearUserPref("whimsy.feature.tidy-tabs");
});

add_task(async function test_tidy_titles() {
  ok(Services.prefs.getBoolPref("whimsy.feature.tidy-titles"), "The feature switch is on");
  requests = [];
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE);
  const longTitle = tab.label;
  await new Promise(r => setTimeout(r, 1500));
  is(tab.label, longTitle, "A Today tab keeps the page's title");
  ok(!requests.some(r => /tab titles/i.test(r.system)), "No AI request until the tab is pinned");

  // Pinning renames it (Arc's Tidy Tab Titles), as the tab's name.
  gBrowser.pinTab(tab);
  await TestUtils.waitForCondition(() => tab.zenStaticLabel == SHORT, "Pinning gives the tab a short name");
  is(tab.label, SHORT, "The short name shows");
  gBrowser.unpinTab(tab);
  BrowserTestUtils.removeTab(tab);

  // A name the person typed is never replaced, pinned or not.
  const named = await BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE);
  named.zenStaticLabel = "My Name";
  requests = [];
  gBrowser.pinTab(named);
  await new Promise(r => setTimeout(r, 1500));
  ok(!requests.some(r => /tab titles/i.test(r.system)), "No AI request for a named tab");
  is(named.zenStaticLabel, "My Name", "Its name isn't replaced");
  gBrowser.unpinTab(named);
  BrowserTestUtils.removeTab(named);

  // Off: pinning keeps the page's title.
  Services.prefs.setBoolPref("whimsy.feature.tidy-titles", false);
  const plain = await BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE);
  gBrowser.pinTab(plain);
  await new Promise(r => setTimeout(r, 1500));
  ok(!plain.zenStaticLabel, "With the switch off, pinning doesn't rename");
  isnot(plain.label, SHORT, "and the title stays long");
  Services.prefs.clearUserPref("whimsy.feature.tidy-titles");
  gBrowser.unpinTab(plain);
  BrowserTestUtils.removeTab(plain);
});
