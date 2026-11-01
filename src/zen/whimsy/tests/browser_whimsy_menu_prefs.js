/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// wave7/menuprefs: Settings → Menus. Turning an item off hides the real
// row of the real menu, the separators it leaves behind collapse, each menu
// keeps its own list (a tab's and an Essential's, a link's and the page's),
// Restore Defaults brings everything back, a menu with every item off
// doesn't open, and Settings search finds the pane.

const { WhimsyMenuPrefs, HIDDEN_ATTR, COLLAPSED_ATTR, ADDED_HIDDEN, ALWAYS_HIDDEN, defaultHiddenIdsFor } = ChromeUtils.importESModule(
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

// wave9/menus: rows that start off (W9-09/W9-10) are collapsed by default;
// nothing else is, apart from the separators they leave behind.
function onlyDefaultsMarked(menu, menuId, what) {
  const defaults = WhimsyMenuPrefs.items(menuId)
    .filter(item => WhimsyMenuPrefs.defaultHiddenIds(menuId).has(item.id))
    .flatMap(item => item.selectors);
  // W10-42: Firefox's container rows are always off.
  for (const [popup, rows] of Object.entries(ALWAYS_HIDDEN)) {
    if (menu.matches(popup)) {
      defaults.push(...rows);
    }
  }
  const others = [...menu.querySelectorAll(`:scope > [${HIDDEN_ATTR}]`)].filter(
    node => node.localName != "menuseparator" && !defaults.some(selector => node.matches(selector))
  );
  Assert.deepEqual(others.map(node => node.id), [], what);
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
    // wave9/menus: only the rows W9-09/W9-10 (and W10-20) list start off.
    Assert.deepEqual(
      [...WhimsyMenuPrefs.defaultHiddenIds(menu.id)].sort(),
      defaultHiddenIdsFor(menu.id).sort(),
      `${menu.id}: only the listed rows are hidden by default`
    );
    for (const id of defaultHiddenIdsFor(menu.id)) {
      ok(items.some(item => item.id == id), `${menu.id}: ${id} (off by default) is a row of the menu`);
    }
  }
  // Stored in the menu's order, whatever order they were turned off in.
  WhimsyMenuPrefs.setHidden("tab", "mute", true);
  WhimsyMenuPrefs.setHidden("tab", "reload", true);
  ok(Services.prefs.getStringPref("whimsy.menus.hidden.tab").startsWith("reload,mute,"), "The pref reads in menu order");
  WhimsyMenuPrefs.setHidden("tab", "reload", false);
  WhimsyMenuPrefs.setHidden("tab", "mute", false);
  ok(WhimsyMenuPrefs.isDefault("tab"), "Turning both back on is the default again");
});

add_task(async function test_tab_menu_hides_rows_and_separators() {
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.com/?menuprefs");
  let menu = await openTabMenu(tab);
  ok(shows(document.getElementById("context_reloadTab")), "Reload Tab shows by default");
  ok(shows(document.getElementById("context_duplicateTab")), "Duplicate Tab shows by default");
  onlyDefaultsMarked(menu, "tab", "Only the rows that start off are marked");
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
  // (Its only hidden rows are its own defaults: W9-09/W9-10 rows off.)
  Assert.deepEqual(
    [...WhimsyMenuPrefs.hiddenIds("essential")].sort(),
    [...WhimsyMenuPrefs.defaultHiddenIds("essential")].sort(),
    "Hiding Tab menu rows leaves the Essential menu as it was"
  );

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
  onlyDefaultsMarked(menu, "tab", "Only the rows that start off are marked after Restore Defaults");
  await closeMenu(menu);
  BrowserTestUtils.removeTab(tab);
});

// wave9/menus (design-full-4 H1): macOS shows right-click menus as native
// NSMenus, which skip only rows whose `hidden` or `collapsed` attribute is
// true and ignore CSS. A row turned off must carry collapsed="true" (and a
// separator it would leave behind too), whatever the stylesheet does; turning
// it back on clears only what Whimsy collapsed.
add_task(async function test_hidden_rows_are_collapsed_for_native_menus() {
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.com/?menuprefs-native");
  const reload = document.getElementById("context_reloadTab");
  const duplicate = document.getElementById("context_duplicateTab");
  // A row someone else collapsed stays theirs.
  const unload = document.getElementById("context_unloadTab");
  for (const id of ["new-tab", "reload", "play", "mute", "mute-site", "snooze"]) {
    WhimsyMenuPrefs.setHidden("tab", id, true);
  }
  let menu = await openTabMenu(tab);
  is(reload.getAttribute("collapsed"), "true", "Reload Tab is collapsed (what NSMenu reads)");
  is(document.getElementById("context_openANewTab").getAttribute("collapsed"), "true", "New Tab is collapsed");
  ok(reload.hasAttribute(COLLAPSED_ATTR), "…and marked as Whimsy's collapse");
  ok(!duplicate.hasAttribute("collapsed"), "Duplicate Tab is not collapsed");
  // Native menus ignore CSS: with the stylesheet rule out of the picture
  // (no display:none), what's left must still hide the row.
  const nativeHidden = node => node.hidden || node.getAttribute("collapsed") == "true";
  const rows = [...menu.children].filter(node => !nativeHidden(node));
  isnot(rows[0]?.localName, "menuseparator", "Native view: no separator first");
  for (let i = 1; i < rows.length; i++) {
    if (rows[i].localName == "menuseparator") {
      isnot(rows[i - 1].localName, "menuseparator", `Native view: no two separators together (${rows[i].id || i})`);
    }
  }
  isnot(rows.at(-1)?.localName, "menuseparator", "Native view: no separator last");
  await closeMenu(menu);

  WhimsyMenuPrefs.restoreDefaults("tab");
  unload.setAttribute("collapsed", "true");
  menu = await openTabMenu(tab);
  ok(!reload.hasAttribute("collapsed"), "Back on: Reload Tab is no longer collapsed");
  onlyDefaultsMarked(menu, "tab", "Back on: no other Whimsy collapse is left");
  is(unload.getAttribute("collapsed"), "true", "A row collapsed by someone else is left alone");
  await closeMenu(menu);
  unload.removeAttribute("collapsed");
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

// W10-21: one card. The menus on the left (a listbox), the chosen menu's
// rows on the right with checkboxes, separators in the same box.
add_task(async function test_settings_pane() {
  await BrowserTestUtils.withNewTab("about:preferences#whimsyMenus", async browser => {
    const doc = browser.contentDocument;
    const win = browser.contentWindow;
    const nav = await TestUtils.waitForCondition(() => doc.getElementById("category-whimsy-menus"), "Menus is in the sidebar");
    is(nav.getAttribute("view"), "paneWhimsyMenus", "It opens the Menus pane");
    const group = await TestUtils.waitForCondition(() => doc.getElementById("whimsyMenusGroup"), "The pane is built");
    await TestUtils.waitForCondition(() => group.checkVisibility(), "The card shows");
    is(doc.querySelectorAll(".whimsy-menus-group").length, 1, "One group, not one per menu");
    const options = [...doc.querySelectorAll('.whimsy-menus-nav [role="option"]')];
    const available = WhimsyMenuPrefs.menus.filter(menu => WhimsyMenuPrefs.available(menu));
    is(options.length, available.length, "One list entry per menu");
    for (const id of ["tab", "essential", "link", "page", "selection", "image", "space", "sidebar", "folder"]) {
      ok(doc.getElementById(`whimsyMenus-${id}`), `A panel for the ${id} menu`);
    }

    // Choose Tab, by click.
    doc.getElementById("whimsyMenusNav-tab").click();
    const detail = doc.getElementById("whimsyMenus-tab");
    ok(!detail.hasAttribute("data-inactive") && detail.checkVisibility(), "The Tab menu's rows show");
    is(doc.getElementById("whimsyMenusNav-tab").getAttribute("aria-selected"), "true", "…and it is selected");
    is(Services.prefs.getStringPref("whimsy.menus.settings-last"), "tab", "The choice is remembered");

    // One checkbox per row, in the menu's order.
    const boxes = [...detail.querySelectorAll(".whimsy-menus-check")];
    Assert.deepEqual(boxes.map(b => b.dataset.item), WhimsyMenuPrefs.items("tab").map(item => item.id), "Every tab menu row, in order");
    await TestUtils.waitForCondition(
      () => [...detail.querySelectorAll(".whimsy-menus-row-label")].every(l => l.textContent.trim()),
      "Every row has a name"
    );
    const startOff = WhimsyMenuPrefs.defaultHiddenIds("tab");
    ok(boxes.every(b => b.checked == !startOff.has(b.dataset.item)), "Every row is on, except the ones that start off");
    const restore = doc.getElementById("whimsyMenus-tab-restore");
    ok(restore.disabled, "Restore Defaults waits until something changes");
    is(restore.getAttribute("aria-describedby"), "whimsyMenus-tab-header", "Restore Defaults names its menu");

    // The bug the user saw: every checkbox on one edge, every separator
    // ending 8px in from the rows' box.
    const rows = detail.querySelector(".whimsy-menus-rows");
    const box = rows.getBoundingClientRect();
    const tops = [...rows.querySelectorAll(":scope > .whimsy-menus-row:not(.whimsy-menus-row-child) .whimsy-menus-check")]
      .map(b => Math.round(b.getBoundingClientRect().left));
    is(new Set(tops).size, 1, "Every checkbox shares one left edge");
    const seps = [...rows.querySelectorAll(".whimsy-menus-sep")];
    ok(seps.length, "The menu's separators are drawn");
    const inner = { left: box.left + 1 + 4 + 8, right: box.right - 1 - 4 - 8 };
    for (const sep of seps) {
      const r = sep.getBoundingClientRect();
      ok(Math.abs(r.left - inner.left) <= 1 && Math.abs(r.right - inner.right) <= 1,
        `A separator meets the rows' edges (${r.left}-${r.right} vs ${inner.left}-${inner.right})`);
    }

    // The nav's count.
    const count = doc.querySelector("#whimsyMenusNav-tab .whimsy-menus-nav-count");
    await TestUtils.waitForCondition(() => /\d+\/\d+/.test(count.textContent), "The list shows how many rows show");

    // A checkbox drives the pref.
    const reload = detail.querySelector('.whimsy-menus-check[data-item="reload"]');
    reload.click();
    await TestUtils.waitForCondition(() => WhimsyMenuPrefs.isHidden("tab", "reload"), "Off: Reload Tab is hidden");
    await TestUtils.waitForCondition(() => !restore.disabled, "Restore Defaults is available");

    // Arrow keys move between rows.
    boxes[0].focus();
    EventUtils.synthesizeKey("KEY_ArrowDown", {}, win);
    is(doc.activeElement, boxes[1], "Down goes to the next row");
    EventUtils.synthesizeKey("KEY_End", {}, win);
    is(doc.activeElement, boxes.at(-1), "End goes to the last");

    restore.dispatchEvent(new win.Event("command", { bubbles: true }));
    await TestUtils.waitForCondition(() => WhimsyMenuPrefs.isDefault("tab"), "Restore Defaults clears the menu's pref");
    await TestUtils.waitForCondition(() => reload.checked, "…and the row is on again");
    ok(restore.disabled, "Restore Defaults is spent");

    // The list is a listbox: arrows change the menu shown.
    doc.getElementById("whimsyMenusNav-tab").focus();
    EventUtils.synthesizeKey("KEY_ArrowDown", {}, win);
    const second = doc.querySelector('.whimsy-menus-nav-item[aria-selected="true"]');
    isnot(second.dataset.menu, "tab", "Down shows the next menu");
    is(doc.activeElement, second, "…and focus follows");
    ok(doc.getElementById(`whimsyMenus-${second.dataset.menu}`).checkVisibility() && !detail.checkVisibility(), "Its rows replace the Tab menu's");

    // Selected Text: Quick Actions' rows sit under it; turning it off
    // disables (not unchecks) them.
    doc.getElementById("whimsyMenusNav-selection").click();
    const selection = doc.getElementById("whimsyMenus-selection");
    const calendar = selection.querySelector('.whimsy-menus-row-child[data-item="calendar"] .whimsy-menus-check');
    ok(calendar, "Add to Calendar is listed under Quick Actions");
    WhimsyMenuPrefs.setHidden("selection", "quick-actions", true);
    await TestUtils.waitForCondition(() => calendar.disabled, "Its rows are disabled while Quick Actions is off");
    ok(calendar.checked, "…but stay checked");
    WhimsyMenuPrefs.restoreDefaults("selection");

    // Every row of a menu off: the note says so, and the list says Off.
    const folder = doc.getElementById("whimsyMenus-folder");
    const note = folder.querySelector(".whimsy-menus-note");
    is(note.textContent, "", "No note while rows are on");
    for (const item of WhimsyMenuPrefs.items("folder")) {
      WhimsyMenuPrefs.setHidden("folder", item.id, true);
    }
    await TestUtils.waitForCondition(() => note.textContent.trim(), "The all-off note shows");
    is(note.getAttribute("role"), "status", "…as a status message");
    ok(doc.getElementById("whimsyMenusNav-folder").hasAttribute("data-all-off"), "The list marks the menu Off");
    ok([...folder.querySelectorAll(".whimsy-menus-check")].every(b => !b.checked), "Every folder row is off");
    WhimsyMenuPrefs.restoreDefaults("folder");
    await TestUtils.waitForCondition(() => !note.textContent, "The note goes");
  });
  Services.prefs.clearUserPref("whimsy.menus.settings-last");
});

// W10-21: about:preferences#whimsyMenus-<menu> opens on that menu.
add_task(async function test_settings_deep_link() {
  await BrowserTestUtils.withNewTab("about:preferences#whimsyMenus-link", async browser => {
    const doc = browser.contentDocument;
    const detail = await TestUtils.waitForCondition(() => doc.getElementById("whimsyMenus-link"), "Built");
    await TestUtils.waitForCondition(() => detail.checkVisibility(), "The Link menu shows");
  });
  Services.prefs.clearUserPref("whimsy.menus.settings-last");
});

// W10-21: in a narrow window the list becomes a menu picker above the rows.
add_task(async function test_settings_narrow() {
  const win = await BrowserTestUtils.openNewBrowserWindow();
  win.resizeTo(600, 700);
  await TestUtils.waitForCondition(() => win.outerWidth <= 620, "The window is narrow");
  const tab = await BrowserTestUtils.openNewForegroundTab(win.gBrowser, "about:preferences#whimsyMenus");
  const doc = tab.linkedBrowser.contentDocument;
  const group = await TestUtils.waitForCondition(() => doc.getElementById("whimsyMenusGroup"), "Built");
  await TestUtils.waitForCondition(() => group.checkVisibility(), "The card shows");
  const picker = doc.getElementById("whimsyMenusPicker");
  await TestUtils.waitForCondition(
    () => picker.checkVisibility() && !doc.querySelector(".whimsy-menus-nav").checkVisibility(),
    "The picker replaces the list"
  );
  picker.value = "page";
  picker.dispatchEvent(new tab.linkedBrowser.contentWindow.Event("command", { bubbles: true }));
  ok(doc.getElementById("whimsyMenus-page").checkVisibility(), "Picking a menu shows its rows");
  await BrowserTestUtils.closeWindow(win);
  Services.prefs.clearUserPref("whimsy.menus.settings-last");
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
    const group = doc.getElementById("whimsyMenusGroup");
    ok(group, "Search setup built the Menus pane");
    ok(!shown(group), "It stays hidden on another pane");
    for (const [query, id] of [
      ["Menus", "whimsyMenusCategory"],
      ["right-click", "whimsyMenusGroup"],
      ["Archive Tabs Below", "whimsyMenus-tab"],
      ["Copy Page as Markdown", "whimsyMenus-page"],
      ["Live Folder", "whimsyMenus-sidebar"],
    ]) {
      search(query);
      await TestUtils.waitForCondition(
        () => shown(doc.getElementById(id)) && doc.getElementById(id).checkVisibility(),
        `Searching "${query}" shows #${id}`
      );
    }
    search("");
  });
  Services.prefs.clearUserPref("whimsy.menus.settings-last");
});

