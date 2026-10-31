/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// wave7/menuprefs: Settings → Menus. Turning an item off hides the real
// row of the real menu, the separators it leaves behind collapse, each menu
// keeps its own list (a tab's and an Essential's, a link's and the page's),
// Restore Defaults brings everything back, a menu with every item off
// doesn't open, and Settings search finds the pane.

const { WhimsyMenuPrefs, HIDDEN_ATTR } = ChromeUtils.importESModule(
  "resource:///modules/whimsy/WhimsyMenuPrefs.sys.mjs"
);

const FEATURE = "whimsy.feature.menu-prefs";
const PAGE = `data:text/html,<a id="l" href="https://example.com/" style="display:block;padding:40px">go</a><div id="blank" style="height:200px"></div>`;

const startTabs = new Set(gBrowser.tabs);
add_setup(async function () {
  registerCleanupFunction(() => {
    Services.prefs.clearUserPref(FEATURE);
    for (const menu of WhimsyMenuPrefs.menus) {
      WhimsyMenuPrefs.restoreDefaults(menu.id);
    }
    for (const tab of gBrowser.tabs.filter(t => !startTabs.has(t))) {
      BrowserTestUtils.removeTab(tab);
    }
  });
});

function shows(node) {
  return (
    !!node &&
    !node.hidden &&
    node.getAttribute("hidden") != "true" &&
    !node.collapsed &&
    window.getComputedStyle(node).display != "none"
  );
}

// No separator first, last or next to another one.
function checkSeparators(menu, what) {
  const rows = [...menu.children].filter(shows);
  ok(rows.length, `${what}: rows show`);
  isnot(rows[0]?.localName, "menuseparator", `${what}: no separator first`);
  isnot(rows.at(-1)?.localName, "menuseparator", `${what}: no separator last`);
  for (let i = 1; i < rows.length; i++) {
    if (rows[i].localName == "menuseparator") {
      isnot(rows[i - 1].localName, "menuseparator", `${what}: no two separators together (${rows[i].id || i})`);
    }
  }
}

async function openTabMenu(tab) {
  const menu = document.getElementById("tabContextMenu");
  const shown = BrowserTestUtils.waitForEvent(menu, "popupshown");
  EventUtils.synthesizeMouseAtCenter(tab, { type: "contextmenu", button: 2 });
  await shown;
  return menu;
}

async function closeMenu(menu) {
  const hidden = BrowserTestUtils.waitForEvent(menu, "popuphidden");
  menu.hidePopup();
  await hidden;
}

async function withContentMenu(tab, selector, fn) {
  const menu = document.getElementById("contentAreaContextMenu");
  const shown = BrowserTestUtils.waitForEvent(menu, "popupshown");
  await BrowserTestUtils.synthesizeMouseAtCenter(selector, { type: "contextmenu", button: 2 }, tab.linkedBrowser);
  await shown;
  try {
    await fn(menu);
  } finally {
    await closeMenu(menu);
  }
}

add_task(async function test_registry() {
  const ids = WhimsyMenuPrefs.menus.map(menu => menu.id);
  for (const id of ["tab", "essential", "link", "page", "selection", "image", "space", "sidebar", "folder"]) {
    ok(ids.includes(id), `The ${id} menu is listed`);
  }
  ok(ids.includes("split-row") && ids.includes("split-pane"), "The split menus are registered too");
  const tabItems = WhimsyMenuPrefs.items("tab").map(item => item.id);
  for (const id of ["close", "archive-below", "reopen", "copy-links", "snooze", "follower"]) {
    ok(tabItems.includes(id), `The tab menu lists ${id}`);
  }
  for (const menu of WhimsyMenuPrefs.menus) {
    const items = WhimsyMenuPrefs.items(menu.id);
    is(new Set(items.map(item => item.id)).size, items.length, `${menu.id}: item ids are unique`);
    ok(
      items.every(item => item.l10n && item.selectors.length),
      `${menu.id}: every item has a label and a row to match`
    );
    is(Services.prefs.getStringPref(WhimsyMenuPrefs.prefName(menu.id), "x"), "", `${menu.id}: nothing hidden by default`);
  }
  // Stored in the menu's order, whatever order they were turned off in.
  WhimsyMenuPrefs.setHidden("tab", "mute", true);
  WhimsyMenuPrefs.setHidden("tab", "reload", true);
  is(Services.prefs.getStringPref("whimsy.menus.hidden.tab"), "reload,mute", "The pref reads in menu order");
  WhimsyMenuPrefs.setHidden("tab", "reload", false);
  WhimsyMenuPrefs.setHidden("tab", "mute", false);
  ok(WhimsyMenuPrefs.isDefault("tab"), "Turning both back on is the default again");
});

add_task(async function test_tab_menu_hides_rows_and_separators() {
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.com/?menuprefs");
  let menu = await openTabMenu(tab);
  ok(shows(document.getElementById("context_reloadTab")), "Reload Tab shows by default");
  ok(shows(document.getElementById("context_duplicateTab")), "Duplicate Tab shows by default");
  ok(!menu.querySelector(`[${HIDDEN_ATTR}]`), "Nothing is marked while every item is on");
  await closeMenu(menu);

  // A whole group (Reload … Snooze), and the first row of the menu.
  for (const id of ["new-tab", "reload", "play", "mute", "mute-site", "snooze", "duplicate"]) {
    WhimsyMenuPrefs.setHidden("tab", id, true);
  }
  menu = await openTabMenu(tab);
  ok(!shows(document.getElementById("context_openANewTab")), "New Tab is gone");
  ok(!shows(document.getElementById("context_reloadTab")), "Reload Tab is gone");
  ok(!shows(document.getElementById("context_toggleMuteTab")), "Mute Tab is gone");
  ok(!shows(document.getElementById("context_duplicateTab")), "Duplicate Tab is gone");
  ok(shows(document.getElementById("context_unloadTab")), "Its neighbour Unload Tab stays");
  checkSeparators(menu, "Tab menu");
  await closeMenu(menu);

  // An Essential's list is its own.
  is(WhimsyMenuPrefs.hiddenIds("essential").size, 0, "The Essential menu still shows everything");

  // The feature switch brings every row back.
  Services.prefs.setBoolPref(FEATURE, false);
  menu = await openTabMenu(tab);
  ok(shows(document.getElementById("context_reloadTab")), "Switch off: Reload Tab is back");
  ok(!menu.querySelector(`[${HIDDEN_ATTR}]`), "Switch off: nothing is marked");
  await closeMenu(menu);
  Services.prefs.clearUserPref(FEATURE);

  // Restore Defaults.
  WhimsyMenuPrefs.restoreDefaults("tab");
  ok(WhimsyMenuPrefs.isDefault("tab"), "Restored");
  menu = await openTabMenu(tab);
  ok(shows(document.getElementById("context_reloadTab")), "Reload Tab is back");
  ok(shows(document.getElementById("context_duplicateTab")), "Duplicate Tab is back");
  ok(!menu.querySelector(`[${HIDDEN_ATTR}]`), "Nothing is marked after Restore Defaults");
  await closeMenu(menu);
  BrowserTestUtils.removeTab(tab);
});

add_task(async function test_every_item_off_opens_no_menu() {
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.com/?menuprefs-all");
  for (const item of WhimsyMenuPrefs.items("tab")) {
    WhimsyMenuPrefs.setHidden("tab", item.id, true);
  }
  ok(WhimsyMenuPrefs.allHidden("tab"), "Every tab menu item is off");
  const menu = document.getElementById("tabContextMenu");
  // Added after WhimsyMenuPrefs' window listener, so it runs after it.
  const seen = new Promise(resolve => {
    const listener = event => {
      if (event.target != menu) {
        return;
      }
      window.removeEventListener("popupshowing", listener);
      resolve({
        prevented: event.defaultPrevented,
        registered: WhimsyMenuPrefs.items("tab")
          .flatMap(item => item.selectors)
          .flatMap(selector => [...menu.children].filter(node => node.matches(selector)))
          .filter(shows)
          .map(node => node.id),
        others: [...menu.children].filter(node => node.localName != "menuseparator" && shows(node)).map(node => node.id),
      });
    };
    window.addEventListener("popupshowing", listener);
  });
  EventUtils.synthesizeMouseAtCenter(tab, { type: "contextmenu", button: 2 });
  const { prevented, registered, others } = await seen;
  Assert.deepEqual(registered, [], "No row of the tab menu shows");
  if (others.length) {
    // A row this build adds that the registry doesn't know yet: the menu
    // opens with just that.
    ok(!prevented, `The menu still opens for ${others.join(", ")}`);
  } else {
    ok(prevented, "No empty menu opens");
  }
  await TestUtils.waitForTick();
  if (menu.state != "closed") {
    await closeMenu(menu);
  }
  WhimsyMenuPrefs.restoreDefaults("tab");
  BrowserTestUtils.removeTab(tab);
});

add_task(async function test_content_menus_are_separate() {
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE);
  WhimsyMenuPrefs.setHidden("link", "open-in-tab", true);
  WhimsyMenuPrefs.setHidden("link", "bookmark", true);
  WhimsyMenuPrefs.setHidden("link", "save", true);
  await withContentMenu(tab, "#l", menu => {
    ok(!shows(document.getElementById("context-openlinkintab")), "Link: Open Link in New Tab is gone");
    ok(!shows(document.getElementById("context-bookmarklink")), "Link: Bookmark Link is gone");
    ok(shows(document.getElementById("context-copylink")), "Link: Copy Link stays");
    checkSeparators(menu, "Link menu");
  });

  // The page menu's first group, so its separator would lead.
  for (const id of ["back", "forward", "reload", "bookmark"]) {
    WhimsyMenuPrefs.setHidden("page", id, true);
  }
  await withContentMenu(tab, "#blank", menu => {
    ok(!shows(document.getElementById("context-back")), "Page: Back is gone");
    ok(!shows(document.getElementById("context-reload")), "Page: Reload is gone");
    ok(shows(document.getElementById("context-savepage")), "Page: Save Page As stays");
    checkSeparators(menu, "Page menu");
  });

  // The link menu's own list doesn't touch the page menu and back.
  WhimsyMenuPrefs.restoreDefaults("page");
  await withContentMenu(tab, "#blank", () => {
    ok(shows(document.getElementById("context-back")), "Page: Back is back");
  });
  WhimsyMenuPrefs.restoreDefaults("link");
  await withContentMenu(tab, "#l", () => {
    ok(shows(document.getElementById("context-openlinkintab")), "Link: Open Link in New Tab is back");
  });
  BrowserTestUtils.removeTab(tab);
});

add_task(async function test_settings_pane() {
  await BrowserTestUtils.withNewTab("about:preferences#whimsyMenus", async browser => {
    const doc = browser.contentDocument;
    const win = browser.contentWindow;
    const nav = await TestUtils.waitForCondition(() => doc.getElementById("category-whimsy-menus"), "Menus is in the sidebar");
    is(nav.getAttribute("view"), "paneWhimsyMenus", "It opens the Menus pane");
    const group = await TestUtils.waitForCondition(() => doc.getElementById("whimsyMenus-tab"), "The pane is built");
    await TestUtils.waitForCondition(() => group.checkVisibility(), "The Tab group shows");
    for (const id of ["tab", "essential", "link", "page", "selection", "image", "space", "sidebar", "folder"]) {
      ok(doc.getElementById(`whimsyMenus-${id}`), `A group for the ${id} menu`);
    }
    if (!Services.prefs.getPrefType("whimsy.feature.split-row-menu")) {
      ok(!doc.getElementById("whimsyMenus-split-row"), "No split row group without the split row menu");
    }

    // One switch per item, in the menu's order, each named.
    const toggles = [...group.querySelectorAll("moz-toggle")];
    Assert.deepEqual(
      toggles.map(t => t.dataset.item),
      WhimsyMenuPrefs.items("tab").map(item => item.id),
      "Every tab menu item, in order"
    );
    await TestUtils.waitForCondition(() => toggles.every(t => t.label), "Every switch has a label");
    ok(toggles.every(t => t.pressed), "Every switch is on");
    const restore = doc.getElementById("whimsyMenus-tab-restore");
    ok(restore.disabled, "Restore Defaults waits until something changes");
    is(restore.getAttribute("aria-describedby"), "whimsyMenus-tab-header", "Restore Defaults names its menu");

    // A switch drives the pref.
    const reload = group.querySelector('moz-toggle[data-item="reload"]');
    reload.click();
    await TestUtils.waitForCondition(() => WhimsyMenuPrefs.isHidden("tab", "reload"), "Off: Reload Tab is hidden");
    await TestUtils.waitForCondition(() => !restore.disabled, "Restore Defaults is available");

    // Arrow keys move between switches.
    toggles[0].focus();
    EventUtils.synthesizeKey("KEY_ArrowDown", {}, win);
    is(doc.activeElement, toggles[1], "Down goes to the next switch");
    EventUtils.synthesizeKey("KEY_End", {}, win);
    is(doc.activeElement, toggles.at(-1), "End goes to the last");

    restore.dispatchEvent(new win.Event("command", { bubbles: true }));
    await TestUtils.waitForCondition(() => WhimsyMenuPrefs.isDefault("tab"), "Restore Defaults clears the menu's pref");
    await TestUtils.waitForCondition(() => reload.pressed, "…and the switch is on again");
    ok(restore.disabled, "Restore Defaults is spent");

    // Every item of a menu off: the note says so.
    const folder = doc.getElementById("whimsyMenus-folder");
    const note = folder.querySelector(".whimsy-menus-note");
    is(note.textContent, "", "No note while items are on");
    for (const item of WhimsyMenuPrefs.items("folder")) {
      WhimsyMenuPrefs.setHidden("folder", item.id, true);
    }
    await TestUtils.waitForCondition(() => note.textContent.trim(), "The all-off note shows");
    is(note.getAttribute("role"), "status", "…as a status message");
    ok([...folder.querySelectorAll("moz-toggle")].every(t => !t.pressed), "Every folder switch is off");
    WhimsyMenuPrefs.restoreDefaults("folder");
    await TestUtils.waitForCondition(() => !note.textContent, "The note goes");
  });
});

add_task(async function test_settings_search_finds_menus() {
  await BrowserTestUtils.withNewTab("about:preferences#home", async browser => {
    const doc = browser.contentDocument;
    const win = browser.contentWindow;
    await win.gSearchResultsPane.initializeCategories();
    const shown = el => {
      for (let node = el; node && node.id != "mainPrefPane"; node = node.parentElement) {
        if (node.hidden || node.classList.contains("visually-hidden")) {
          return false;
        }
      }
      return !!el?.isConnected;
    };
    const search = query => {
      const input = doc.getElementById("searchInput");
      input.value = query;
      input.dispatchEvent(new win.InputEvent("input", { bubbles: true }));
    };
    const group = doc.getElementById("whimsyMenus-tab");
    ok(group, "Search setup built the Menus pane");
    ok(!shown(group), "It stays hidden on another pane");
    for (const [query, id] of [
      ["Menus", "whimsyMenusCategory"],
      ["right-click", "whimsyMenus-tab"],
      ["Archive Tabs Below", "whimsyMenus-tab"],
      ["Copy Page as Markdown", "whimsyMenus-page"],
      ["Live Folder", "whimsyMenus-sidebar"],
    ]) {
      search(query);
      await TestUtils.waitForCondition(() => shown(doc.getElementById(id)), `Searching "${query}" shows #${id}`);
    }
    search("");
  });
});
