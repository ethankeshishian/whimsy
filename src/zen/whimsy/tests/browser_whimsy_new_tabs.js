/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// New tab position: new tabs open right below the current tab, and tabs
// opened from a tab in a folder stay in that folder. Both have a toggle in
// Settings → Tab Management.

const startTabs = new Set(gBrowser.tabs);
registerCleanupFunction(() => {
  for (const tab of gBrowser.tabs.filter(t => !startTabs.has(t))) {
    BrowserTestUtils.removeTab(tab);
  }
});

async function openTabs(urls) {
  const tabs = [];
  for (const url of urls) {
    tabs.push(await BrowserTestUtils.openNewForegroundTab(gBrowser, url));
  }
  return tabs;
}

async function newTabWithShortcut() {
  const onOpen = BrowserTestUtils.waitForEvent(gBrowser.tabContainer, "TabOpen");
  EventUtils.synthesizeKey("t", { accelKey: true });
  const { target } = await onOpen;
  return target;
}

add_task(async function test_defaults() {
  ok(Services.prefs.getBoolPref("whimsy.feature.new-tab-position"), "The feature switch is on");
  const defaults = Services.prefs.getDefaultBranch("");
  ok(defaults.getBoolPref("browser.tabs.insertAfterCurrent"), "New tabs open below the current one by default");
  ok(defaults.getBoolPref("zen.folders.owned-tabs-in-folder"), "Tabs opened from a folder stay in it by default");
});

add_task(async function test_new_tab_below_current() {
  await SpecialPowers.pushPrefEnv({ set: [["zen.urlbar.replace-newtab", false]] });
  const [a, b, c] = await openTabs(["https://example.com/a", "https://example.com/b", "https://example.com/c"]);
  gBrowser.selectedTab = a;
  const tab = await newTabWithShortcut();
  is(gBrowser.tabs.indexOf(tab), gBrowser.tabs.indexOf(a) + 1, "Cmd+T opens the tab right below the current one");
  BrowserTestUtils.removeTab(tab);

  // From the last tab, it's simply the next one.
  gBrowser.selectedTab = c;
  const last = await newTabWithShortcut();
  is(gBrowser.tabs.indexOf(last), gBrowser.tabs.indexOf(c) + 1, "Below the last tab too");
  BrowserTestUtils.removeTab(last);

  // Toggle off: Zen's own placement (the end of the list).
  await SpecialPowers.pushPrefEnv({ set: [["browser.tabs.insertAfterCurrent", false]] });
  gBrowser.selectedTab = a;
  const atEnd = await newTabWithShortcut();
  isnot(gBrowser.tabs.indexOf(atEnd), gBrowser.tabs.indexOf(a) + 1, "With the toggle off, it isn't placed below");
  BrowserTestUtils.removeTab(atEnd);
  await SpecialPowers.popPrefEnv();

  for (const t of [a, b, c]) {
    BrowserTestUtils.removeTab(t);
  }
  await SpecialPowers.popPrefEnv();
});

add_task(async function test_url_bar_new_tab_below_current() {
  // Zen's default Cmd+T: the floating URL bar, then a tab for what you type.
  // (Tests skip it unless asked, hence the override.)
  await SpecialPowers.pushPrefEnv({ set: [["zen.urlbar.replace-newtab", true]] });
  const [a, b] = await openTabs(["https://example.com/a", "https://example.com/b"]);
  gBrowser.selectedTab = a;
  ok(gZenUIManager.handleNewTab(false, false, "tab", true), "The floating URL bar opens");
  await TestUtils.waitForCondition(() => gURLBar.focused, "It has focus");
  const onOpen = BrowserTestUtils.waitForEvent(gBrowser.tabContainer, "TabOpen");
  EventUtils.sendString("https://example.com/typed");
  EventUtils.synthesizeKey("KEY_Enter");
  const { target: tab } = await onOpen;
  is(gBrowser.tabs.indexOf(tab), gBrowser.tabs.indexOf(a) + 1, "The typed page opens right below the current tab");
  for (const t of [tab, a, b]) {
    BrowserTestUtils.removeTab(t);
  }
  await SpecialPowers.popPrefEnv();
});

// Zen's own tab tests (browser_tabs_close_recently.js,
// browser_drag_drop_vertical.js) pin browser.tabs.insertAfterCurrent to false,
// because they assert Zen's tab order. These two cover the same behaviour
// under Whimsy's real default, where each new tab lands below the current one.

add_task(async function test_close_selects_next_in_strip_order() {
  await SpecialPowers.pushPrefEnv({
    set: [
      ["zen.tabs.select-recently-used-on-close", false],
      ["zen.view.show-newtab-button-top", false],
    ],
  });
  ok(Services.prefs.getBoolPref("browser.tabs.insertAfterCurrent"), "Runs with Whimsy's default");
  const anchor = gBrowser.selectedTab;
  const tab1 = BrowserTestUtils.addTab(gBrowser, "data:text/plain,tab1");
  const tab2 = BrowserTestUtils.addTab(gBrowser, "data:text/plain,tab2");
  const tab3 = BrowserTestUtils.addTab(gBrowser, "data:text/plain,tab3");
  const pos = t => gBrowser.tabs.indexOf(t);
  const at = pos(anchor);
  Assert.deepEqual(
    [tab3, tab2, tab1].map(pos),
    [at + 1, at + 2, at + 3],
    "Each new tab opens right below the current tab, so the newest is first"
  );

  // Closing the selected tab moves to the next tab down the strip.
  gBrowser.selectedTab = tab2;
  gBrowser.removeTab(tab2);
  is(gBrowser.selectedTab, tab1, "Closing a middle tab selects the next one below it");

  // The last of the run has nothing below it among these tabs, so the
  // selection goes to the next tab in strip order, or back up if it's last.
  const below = gBrowser.tabs[pos(tab1) + 1];
  gBrowser.removeTab(tab1);
  is(gBrowser.selectedTab, below ?? tab3, "Closing the last tab of the run selects the next in strip order");

  BrowserTestUtils.removeTab(tab3);
  gBrowser.selectedTab = anchor;
  await SpecialPowers.popPrefEnv();
});

add_task(async function test_drag_reorders_tabs_opened_below_current() {
  await SpecialPowers.pushPrefEnv({ set: [["zen.view.show-newtab-button-top", false]] });
  ok(Services.prefs.getBoolPref("browser.tabs.insertAfterCurrent"), "Runs with Whimsy's default");
  await SidebarController.waitUntilStable();
  const anchor = gBrowser.selectedTab;
  const tab1 = BrowserTestUtils.addTab(gBrowser, "data:text/plain,tab1");
  const tab2 = BrowserTestUtils.addTab(gBrowser, "data:text/plain,tab2");
  const tab3 = BrowserTestUtils.addTab(gBrowser, "data:text/plain,tab3");
  const order = () => gBrowser.tabs.filter(t => [tab1, tab2, tab3].includes(t));
  Assert.deepEqual(order(), [tab3, tab2, tab1], "New tabs open below the current one, newest first");
  // Loading changes each tab's label and layout; drag once they've settled.
  await Promise.all([tab1, tab2, tab3].map(t => BrowserTestUtils.browserLoaded(t.linkedBrowser)));
  info(`tabs: ${gBrowser.tabs.map(t => t.label + "@" + Math.round(window.windowUtils.getBoundsWithoutFlushing(t).top)).join(", ")}`);

  const threshold = Math.min(
    1.0,
    Math.max(0.5, Services.prefs.getIntPref("browser.tabs.dragDrop.moveOverThresholdPercent") / 100) + 0.01
  );
  const bounds = el => window.windowUtils.getBoundsWithoutFlushing(el);
  async function drop(source, target, clientY) {
    await TestUtils.waitForCondition(() => {
      const r = bounds(source);
      return r.width && r.height &&
        document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)?.closest?.(".tabbrowser-tab") == source;
    }, "The tab to drag is hit-testable");
    const r = bounds(target);
    const moved = BrowserTestUtils.waitForEvent(source, "TabMove");
    EventUtils.synthesizeDrop(source, target, null, "move", window, window, {
      clientX: r.left + r.width / 2,
      clientY,
    });
    await moved;
    // A real drag session ends with dragend on the dragged tab, which is where
    // Zen removes its drag image (a clone of the tab). The synthesized session
    // has no native source, so it never sends one; send it like the real one.
    const dt = new DataTransfer();
    dt.mozSetDataAt("application/x-moz-tabbrowser-tab", source, 0);
    source.dispatchEvent(new DragEvent("dragend", { bubbles: true, dataTransfer: dt }));
    ok(!gBrowser.tabContainer.tabDragAndDrop._tempDragImageParent, "The drag image goes away when the drag ends");
  }
  const dropAfter = (source, target) => {
    const r = bounds(target);
    return drop(source, target, Math.ceil(r.top + (threshold + 0.5) * r.height) - bounds(source).height / 2);
  };
  const dropBefore = (source, target) => {
    const r = bounds(target);
    return drop(source, target, Math.floor(r.top + (0.5 - threshold) * r.height) + bounds(source).height / 2);
  };

  await dropAfter(tab3, tab2);
  Assert.deepEqual(order(), [tab2, tab3, tab1], "Dragging down moves the tab after its target");
  await dropAfter(tab3, tab1);
  Assert.deepEqual(order(), [tab2, tab1, tab3], "And past the last one");
  await dropBefore(tab3, tab2);
  Assert.deepEqual(order(), [tab3, tab2, tab1], "Dragging up moves it back before its target");

  is(document.querySelectorAll("[drag-image]").length, 0, "No drag image is left behind");

  for (const t of [tab1, tab2, tab3]) {
    BrowserTestUtils.removeTab(t);
  }
  gBrowser.selectedTab = anchor;
  await SpecialPowers.popPrefEnv();
});

add_task(async function test_tabs_stay_in_folder() {
  const selected = gBrowser.selectedTab;
  const tab = BrowserTestUtils.addTab(gBrowser, "about:blank");
  const folder = await gZenFolders.createFolder([tab], { renameFolder: false });
  gBrowser.selectedTab = tab;
  const triggeringPrincipal = Services.scriptSecurityManager.getSystemPrincipal();
  const link = gBrowser.addTab("https://example.com/", {
    relatedToCurrent: true,
    ownerTab: tab,
    triggeringPrincipal,
  });
  await TestUtils.waitForCondition(() => link.group == folder, "A link opened from a folder tab joins the folder");
  ok(folder.tabs.includes(link), "The folder holds it");

  await SpecialPowers.pushPrefEnv({ set: [["zen.folders.owned-tabs-in-folder", false]] });
  gBrowser.selectedTab = tab;
  const outside = gBrowser.addTab("https://example.org/", {
    relatedToCurrent: true,
    ownerTab: tab,
    triggeringPrincipal,
  });
  // eslint-disable-next-line mozilla/no-arbitrary-setTimeout
  await new Promise(resolve => setTimeout(resolve, 100));
  ok(!folder.tabs.includes(outside), "With the toggle off, it opens outside the folder");
  BrowserTestUtils.removeTab(outside);
  await SpecialPowers.popPrefEnv();

  gBrowser.selectedTab = selected;
  const removed = BrowserTestUtils.waitForEvent(folder, "TabGroupRemoved");
  folder.delete();
  await removed;
});

add_task(async function test_settings() {
  await BrowserTestUtils.withNewTab("about:preferences#zenTabManagement", async browser => {
    const doc = browser.contentDocument;
    const below = await TestUtils.waitForCondition(() => doc.getElementById("whimsyNewTabBelow"), "Toggle shown");
    const inFolder = doc.getElementById("whimsyNewTabInFolder");
    await TestUtils.waitForCondition(() => below.checked && inFolder.checked, "Both toggles are on");
    below.click();
    await TestUtils.waitForCondition(() => !Services.prefs.getBoolPref("browser.tabs.insertAfterCurrent"), "Unchecking turns it off");
    below.click();
    inFolder.click();
    await TestUtils.waitForCondition(() => !Services.prefs.getBoolPref("zen.folders.owned-tabs-in-folder"), "Folder toggle off");
    inFolder.click();
  });
  Services.prefs.clearUserPref("browser.tabs.insertAfterCurrent");
  Services.prefs.clearUserPref("zen.folders.owned-tabs-in-folder");

  await SpecialPowers.pushPrefEnv({ set: [["whimsy.feature.new-tab-position", false]] });
  await BrowserTestUtils.withNewTab("about:preferences#zenTabManagement", async browser => {
    const doc = browser.contentDocument;
    await TestUtils.waitForCondition(() => doc.getElementById("zenPinnedTabsManagerGroup")?.checkVisibility());
    ok(!doc.getElementById("whimsyNewTabBelow"), "With the switch off, the toggles are gone");
  });
  await SpecialPowers.popPrefEnv();
});
