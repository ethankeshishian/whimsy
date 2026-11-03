/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

// wave8/cheatsheet: the Cmd+/ sheet. Cmd+/ opens it with the search
// focused; shortcuts are grouped by menu with one key cap per key; typing
// filters at once (by name, menu, key names or "custom") with an empty
// state; arrows move through the rows and back to the search; rows run
// nothing; Esc clears a search, then closes; Cmd+/ again closes;
// "Edit Shortcuts…" opens about:keyboard; a customized shortcut says so.
// W13 F03: a WhimsySurface over the page, 88% of its height, with the
// menus on a rail on its left; matches are marked; a changed shortcut has
// an accent dot explained in the footer.

const { WhimsyCommands } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyCommands.sys.mjs");
const { Preferences } = ChromeUtils.importESModule("resource://gre/modules/Preferences.sys.mjs");

const PANEL_ID = "whimsy-cheatsheet-panel";

// Opening the extra windows/tabs this file uses to test the sheet at
// different sizes trips Whimsy's own tab-count stat and update-seen check;
// neither is this file's to leave behind.
const LEAKED_PREFS = ["whimsy.stats.tabs-opened", "whimsy.updates.seen-install"];

add_setup(function () {
  const original = new Map(
    LEAKED_PREFS.filter(name => Services.prefs.prefHasUserValue(name)).map(name => [name, Preferences.get(name)])
  );
  registerCleanupFunction(() => {
    for (const name of LEAKED_PREFS) {
      if (original.has(name)) {
        Preferences.set(name, original.get(name));
      } else {
        Services.prefs.clearUserPref(name);
      }
    }
  });
});

async function openSheet(how = () => document.getElementById("whimsy-cheatsheet").doCommand()) {
  const shown = BrowserTestUtils.waitForEvent(document, "popupshown", true, e => e.target.id == PANEL_ID);
  how();
  await shown;
  return document.getElementById(PANEL_ID);
}

async function closeSheet(panel) {
  if (panel?.state == "open") {
    const hidden = BrowserTestUtils.waitForPopupEvent(panel, "hidden");
    panel.hidePopup();
    await hidden;
  }
}

function type(panel, text) {
  const search = panel.querySelector("#whimsy-cheatsheet-search");
  search.value = text;
  search.dispatchEvent(new Event("input"));
}

const visibleRows = panel => [...panel.querySelectorAll(".whimsy-cheatsheet-row")].filter(
  row => !row.hidden && !row.closest(".whimsy-cheatsheet-group").hidden);

add_task(async function test_opens_grouped_with_key_caps() {
  const panel = await openSheet(() => EventUtils.synthesizeKey("/", { accelKey: true }, window));
  try {
    ok(panel.classList.contains("whimsy-surface"), "It is a Whimsy surface");
    is(panel.getAttribute("hidepopovertail"), "true", "with no arrow tail");
    is(document.activeElement, panel.querySelector("#whimsy-cheatsheet-search"), "The search field has focus");
    is(panel.querySelector(".whimsy-surface-title").textContent, "Keyboard Shortcuts", "Titled, start-aligned");

    const groups = panel.querySelectorAll(".whimsy-cheatsheet-group");
    Assert.greaterOrEqual(groups.length, 4, "Shortcuts are grouped");
    const file = panel.querySelector('.whimsy-cheatsheet-group[data-menu="file-menu"]');
    is(file?.querySelector("h2").textContent, document.getElementById("file-menu").label, "...by menu-bar menu");
    const other = panel.querySelector('.whimsy-cheatsheet-group[data-menu="other"]');
    ok(!other || other == groups[groups.length - 1], "Other, when there is one, comes last");

    const row = panel.querySelector('.whimsy-cheatsheet-row[data-key-id="zen-duplicate-tab"]');
    ok(row, "Duplicate Tab is listed");
    const caps = [...row.querySelectorAll("kbd")].map(kbd => kbd.textContent);
    Assert.greaterOrEqual(caps.length, 2, "...as separate key caps");
    is(caps.at(-1), "D", "...ending with its key");
    ok(row.getAttribute("aria-label").includes(row.querySelector(".whimsy-cheatsheet-title").textContent),
      "Rows have an accessible name with the command");

    // Exactly one action: Edit Shortcuts….
    const footerButtons = panel.querySelectorAll(".whimsy-surface-footer .footer-button");
    is(footerButtons.length, 1, "One footer action");
    ok(footerButtons[0].classList.contains("whimsy-cheatsheet-edit"), "...Edit Shortcuts…");
    ok(!panel.querySelector(".whimsy-cheatsheet-row toolbarbutton, .whimsy-cheatsheet-row button"),
      "Rows hold no buttons of their own");
  } finally {
    await closeSheet(panel);
  }
});

add_task(async function test_search_filters_instantly() {
  const panel = await openSheet();
  try {
    const all = visibleRows(panel).length;
    type(panel, "duplicate");
    ok(visibleRows(panel).some(row => row.dataset.keyId == "zen-duplicate-tab"), "The matching row stays");
    ok(visibleRows(panel).every(row => row.dataset.keyId != "key_find"), "Others hide at once");
    ok(panel.querySelectorAll(".whimsy-cheatsheet-group:not([hidden])").length < panel.querySelectorAll(".whimsy-cheatsheet-group").length,
      "Groups with nothing left hide");
    ok(panel.querySelector(".whimsy-cheatsheet-status").textContent, "The count is announced");

    type(panel, document.getElementById("file-menu").label);
    ok(visibleRows(panel).some(row => row.dataset.keyId == "key_newNavigatorTab"), "A menu's name shows its shortcuts");

    const caps = [...panel.querySelectorAll('.whimsy-cheatsheet-row[data-key-id="key_newNavigatorTab"] kbd')].map(k => k.textContent);
    type(panel, caps.join(AppConstants.platform == "macosx" ? "" : "+"));
    ok(visibleRows(panel).some(row => row.dataset.keyId == "key_newNavigatorTab"), "Typing the keys finds the shortcut");
    if (AppConstants.platform == "macosx") {
      type(panel, "cmd t");
      ok(visibleRows(panel).some(row => row.dataset.keyId == "key_newNavigatorTab"), "So do key names");
    }

    type(panel, "no such shortcut 824831");
    is(visibleRows(panel).length, 0, "No rows for a miss");
    ok(!panel.querySelector(".whimsy-cheatsheet-empty").hidden, "...and an empty state");

    type(panel, "");
    is(visibleRows(panel).length, all, "Clearing the search shows everything again");
    ok(panel.querySelector(".whimsy-cheatsheet-empty").hidden, "...without the empty state");
  } finally {
    await closeSheet(panel);
  }
});

add_task(async function test_keyboard() {
  const panel = await openSheet();
  try {
    const search = panel.querySelector("#whimsy-cheatsheet-search");
    const rows = visibleRows(panel);
    EventUtils.synthesizeKey("KEY_ArrowDown", {}, window);
    is(document.activeElement, rows[0], "Down moves into the list");
    EventUtils.synthesizeKey("KEY_ArrowDown", {}, window);
    is(document.activeElement, rows[1], "...and along it");
    EventUtils.synthesizeKey("KEY_End", {}, window);
    is(document.activeElement, rows.at(-1), "End goes to the last shortcut");
    EventUtils.synthesizeKey("KEY_Home", {}, window);
    is(document.activeElement, rows[0], "Home to the first");
    EventUtils.synthesizeKey("KEY_Enter", {}, window);
    is(panel.state, "open", "Enter on a row runs nothing; the sheet stays");
    EventUtils.synthesizeKey("KEY_ArrowUp", {}, window);
    is(document.activeElement, search, "Up from the first row returns to the search");

    EventUtils.synthesizeKey("KEY_ArrowDown", {}, window);
    EventUtils.sendString("dup", window);
    is(document.activeElement, search, "Typing on a row goes back to the search");
    is(search.value, "dup", "...with what was typed");

    EventUtils.synthesizeKey("KEY_Escape", {}, window);
    is(panel.state, "open", "Esc with a search clears it");
    is(search.value, "", "...emptying the field");
    is(visibleRows(panel).length, rows.length, "...and showing everything");

    const hidden = BrowserTestUtils.waitForPopupEvent(panel, "hidden");
    EventUtils.synthesizeKey("KEY_Escape", {}, window);
    await hidden;
    ok(!document.getElementById(PANEL_ID), "A second Esc closes and removes the sheet");
  } finally {
    await closeSheet(document.getElementById(PANEL_ID));
  }
});

add_task(async function test_toggle_and_edit_link() {
  let panel = await openSheet();
  const hidden = BrowserTestUtils.waitForPopupEvent(panel, "hidden");
  document.getElementById("whimsy-cheatsheet").doCommand();
  await hidden;
  ok(!document.getElementById(PANEL_ID), "The shortcut again closes it");

  // On a page of its own, so about:keyboard never takes over Zen's blank
  // placeholder tab (which would then count as a tab left behind).
  const host = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.com/?cheatsheet-edit");
  panel = await openSheet();
  // about:keyboard loads in the parent process, often before a load
  // listener on the new tab is in place: wait for its address instead.
  const before = new Set(gBrowser.tabs);
  panel.querySelector(".whimsy-cheatsheet-edit").doCommand();
  await TestUtils.waitForCondition(() => gBrowser.selectedBrowser.currentURI?.spec == "about:keyboard",
    "about:keyboard opened");
  const tab = gBrowser.selectedTab;
  info(`about:keyboard ${before.has(tab) ? "reused the blank tab" : "opened in a new tab"}`);
  ok(!document.getElementById(PANEL_ID), "Edit Shortcuts… closes the sheet");
  is(gBrowser.selectedBrowser.currentURI.spec, "about:keyboard", "...and opens about:keyboard");
  if (tab != host) {
    BrowserTestUtils.removeTab(tab);
  }
  BrowserTestUtils.removeTab(host);
});

add_task(async function test_customized_rows() {
  registerCleanupFunction(() => WhimsyCommands.reset("whimsy-tab-next"));
  ok(WhimsyCommands.rebind("whimsy-tab-next", { modifiers: "accel,alt,shift", key: "U" }).ok, "Next Tab gets a custom key");
  const panel = await openSheet();
  try {
    const row = panel.querySelector('.whimsy-cheatsheet-row[data-key-id="key_whimsyTabNext"]');
    is(row?.getAttribute("customized"), "true", "The row is marked customized");
    ok(row.querySelector(".whimsy-cheatsheet-custom-dot"), "...with an accent dot");
    ok(row.getAttribute("aria-label").includes("custom shortcut"), "...said in words to assistive tech");
    ok(row.title.startsWith("Changed from"), "...and the default in its tooltip");
    const legend = panel.querySelector(".whimsy-cheatsheet-legend");
    ok(!legend.hidden, "The footer explains the dot");
    await document.l10n.translateFragment(legend);
    is(legend.textContent, "Changed by you", "...as Changed by you");
    is(row.querySelector("kbd:last-child").textContent, "U", "...showing the custom key");
    ok(!panel.querySelector('.whimsy-cheatsheet-row[data-key-id="key_whimsyCheatsheet"]').hasAttribute("customized"),
      "Default shortcuts aren't marked");

    type(panel, "custom");
    ok(visibleRows(panel).includes(row), "Searching \"custom\" finds it");
  } finally {
    await closeSheet(panel);
    WhimsyCommands.reset("whimsy-tab-next");
  }
});

add_task(async function test_disabled_feature_does_nothing() {
  await SpecialPowers.pushPrefEnv({ set: [["whimsy.feature.cheatsheet", false]] });
  document.getElementById("whimsy-cheatsheet").doCommand();
  await new Promise(resolve => setTimeout(resolve, 100));
  ok(!document.getElementById(PANEL_ID), "With the feature off, nothing opens");
  await SpecialPowers.popPrefEnv();
});

// W13 F03 (option B at 88%, wave13/design/cheatsheet): in a 1280×900
// window the sheet is 760px wide with a 150px rail, 88% of the page
// area's height, centred in it, and keeps that size while open. The rail
// lists the menus in menu-bar order with their counts; a real click on one
// shows its rows; arrows move along the rail. Typing searches every menu
// and dims the rail; Esc returns to the picked menu. The header drags it.
// Matches are marked; a miss has an empty state naming the query.

const { WhimsySurface } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsySurface.sys.mjs");
const { WhimsyCheatSheet } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyCheatSheet.sys.mjs");

async function inWindow(width, height, fn) {
  // Zen's window sync copies the new window's blank tab into this one;
  // take it along when the window closes.
  const startTabs = new Set(gBrowser.tabs);
  const win = await BrowserTestUtils.openNewBrowserWindow();
  try {
    win.resizeTo(width, height);
    // Zen's browser windows are at least 500×495 (zen-theme.css). A real
    // screen also caps the size (headless doesn't).
    const minW = Math.max(width, 500);
    const minH = Math.max(height, 495);
    const near = (a, b) => Math.abs(a - b) < 40;
    await TestUtils.waitForCondition(() =>
      (near(win.outerWidth, minW) || near(win.outerWidth, Math.min(minW, win.screen.availWidth))) &&
      (near(win.outerHeight, minH) || near(win.outerHeight, Math.min(minH, win.screen.availHeight))),
      `The window is ${minW}×${minH} (or the screen's size)`)
      .catch(e => { throw new Error(`${e} (it is ${win.outerWidth}×${win.outerHeight}, screen ${win.screen.availWidth}×${win.screen.availHeight})`); });
    await new Promise(resolve => win.requestAnimationFrame(() => win.requestAnimationFrame(resolve)));
    await fn(win);
  } finally {
    await BrowserTestUtils.closeWindow(win);
    for (const tab of gBrowser.tabs.filter(t => !startTabs.has(t))) {
      BrowserTestUtils.removeTab(tab);
    }
  }
}

async function openIn(win) {
  const shown = BrowserTestUtils.waitForEvent(win.document, "popupshown", true, e => e.target.id == PANEL_ID);
  EventUtils.synthesizeKey("/", { accelKey: true }, win);
  await shown;
  return win.document.getElementById(PANEL_ID);
}

async function closeIn(win, panel) {
  if (panel?.state == "open") {
    const hidden = BrowserTestUtils.waitForPopupEvent(panel, "hidden");
    panel.hidePopup();
    await hidden;
  }
}

const cardOf = panel => panel.shadowRoot.querySelector("[part~='content']");
const shownRowsIn = panel => [...panel.querySelectorAll(".whimsy-cheatsheet-row")].filter(r => r.checkVisibility());
const shownGroupsIn = panel => [...panel.querySelectorAll(".whimsy-cheatsheet-group")].filter(g => !g.hidden);

add_task(async function test_rail_height_and_centre() {
  await inWindow(1280, 740, async win => {
    const catalogue = await WhimsyCheatSheet.catalogue(win);
    const panel = await openIn(win);
    try {
      const area = WhimsySurface.pageArea(win).getBoundingClientRect();
      const card = cardOf(panel);
      const box = card.getBoundingClientRect();
      Assert.less(Math.abs(box.height - Math.round(area.height * 0.88)), 1.5,
        `The sheet is 88% of the page area's height (${Math.round(area.height * 0.88)}px)`);
      Assert.less(Math.abs((box.top - area.top) - (area.bottom - box.bottom)), 3, "...centred: the gaps above and below match");
      Assert.less(Math.abs((box.left - area.left) - (area.right - box.right)), 3, "...and across the page");
      Assert.less(Math.abs(box.width - 760), 1.5, "760px wide");

      // The rail: every menu in menu-bar order, with its count, 150px.
      const rail = panel.querySelector(".whimsy-cheatsheet-rail");
      is(rail.getAttribute("role"), "tablist", "The rail is a list of tabs");
      Assert.less(Math.abs(rail.getBoundingClientRect().width - 150), 1, "150px wide");
      const items = [...rail.querySelectorAll(".whimsy-cheatsheet-rail-item")];
      Assert.deepEqual(items.map(i => i.querySelector(".whimsy-cheatsheet-rail-name").textContent),
        catalogue.map(g => g.heading), "The menus, in menu-bar order");
      Assert.deepEqual(items.map(i => Number(i.querySelector(".whimsy-cheatsheet-rail-count").textContent)),
        catalogue.map(g => g.rows.length), "...each with its count");
      is(items[0].getAttribute("aria-selected"), "true", "The first menu is picked");
      const probe = win.document.createElementNS("http://www.w3.org/1999/xhtml", "div");
      probe.style.backgroundColor = "var(--whimsy-surface-selected)";
      rail.append(probe);
      const selectedFill = win.getComputedStyle(probe).backgroundColor;
      probe.remove();
      is(win.getComputedStyle(items[0]).backgroundColor, selectedFill, "...in the surface's selected fill");
      is(win.getComputedStyle(items[0]).fontWeight, "600", "...semibold");
      is(shownGroupsIn(panel).length, 1, "One menu's rows show");
      is(shownRowsIn(panel).length, catalogue[0].rows.length, "...all of them");
      is(win.getComputedStyle(shownGroupsIn(panel)[0].querySelector("h2")).display, "none",
        "...without a heading (the rail names it)");
      const kbd = shownRowsIn(panel)[0].querySelector("kbd");
      is(win.getComputedStyle(kbd).height, "20px", "Key caps are 20px");
      isnot(win.getComputedStyle(kbd).borderTopWidth, "0px", "...with a hairline");

      // A real click on the biggest menu shows its rows; the size stays.
      const biggest = catalogue.reduce((a, b) => (b.rows.length > a.rows.length ? b : a));
      const item = items.find(i => i.dataset.menu == biggest.id);
      EventUtils.synthesizeMouseAtCenter(item, {}, win);
      await TestUtils.waitForCondition(() => item.getAttribute("aria-selected") == "true", "The click picks it");
      is(items[0].getAttribute("aria-selected"), "false", "...and only it");
      Assert.deepEqual(shownGroupsIn(panel).map(g => g.dataset.menu), [biggest.id], "Its rows show");
      is(shownRowsIn(panel).length, biggest.rows.length, "...all of them");
      Assert.less(Math.abs(card.getBoundingClientRect().height - box.height), 0.5, "The height doesn't change");
      const smallest = catalogue.reduce((a, b) => (b.rows.length < a.rows.length ? b : a));
      EventUtils.synthesizeMouseAtCenter(items.find(i => i.dataset.menu == smallest.id), {}, win);
      await TestUtils.waitForCondition(() => shownGroupsIn(panel)[0]?.dataset.menu == smallest.id, "A small menu");
      Assert.less(Math.abs(card.getBoundingClientRect().height - box.height), 0.5, "...the height still doesn't change");

      // Arrows move along the rail and pick.
      const at = items.findIndex(i => i.dataset.menu == smallest.id);
      items[at].focus();
      EventUtils.synthesizeKey(at < items.length - 1 ? "KEY_ArrowDown" : "KEY_ArrowUp", {}, win);
      const moved = items[at < items.length - 1 ? at + 1 : at - 1];
      is(win.document.activeElement, moved, "Arrows move along the rail");
      is(moved.getAttribute("aria-selected"), "true", "...and pick");
      is(shownGroupsIn(panel)[0].dataset.menu, moved.dataset.menu, "...showing that menu");

      // Typing (on the rail) searches every menu; the rail steps back.
      EventUtils.sendString("split", win);
      const search = panel.querySelector("#whimsy-cheatsheet-search");
      is(search.value, "split", "Typing on the rail goes to the search");
      ok(panel.hasAttribute("searching"), "Searching");
      await TestUtils.waitForCondition(() => win.getComputedStyle(rail).opacity == "0.45", "The rail dims");
      const hits = shownRowsIn(panel);
      ok(hits.length, "Split shortcuts show");
      ok(hits.some(r => r.querySelector("mark.whimsy-cheatsheet-match")?.textContent.toLowerCase() == "split"),
        "The match is marked");
      ok(shownGroupsIn(panel).every(g => win.getComputedStyle(g.querySelector("h2")).display != "none"),
        "Each menu with a match is headed by its name");
      EventUtils.sendString(" zzqx no such", win);
      const empty = panel.querySelector(".whimsy-cheatsheet-empty");
      ok(!empty.hidden, "A miss: the empty state");
      await win.document.l10n.translateFragment(empty);
      ok(empty.textContent.includes("split zzqx no such"), "...naming the query");
      ok(empty.textContent.includes("cmd shift d"), "...with a hint");
      Assert.less(Math.abs(card.getBoundingClientRect().height - box.height), 0.5, "The height is fixed while searching");
      EventUtils.synthesizeKey("KEY_Escape", {}, win);
      is(search.value, "", "Esc clears the search");
      ok(!panel.hasAttribute("searching"), "...the rail comes back");
      Assert.deepEqual(shownGroupsIn(panel).map(g => g.dataset.menu), [moved.dataset.menu], "...on the picked menu");

      // A click on the rail during a search shows that menu.
      EventUtils.sendString("tab", win);
      ok(panel.hasAttribute("searching"), "Searching again");
      EventUtils.synthesizeMouseAtCenter(items[0], {}, win);
      await TestUtils.waitForCondition(() => !panel.hasAttribute("searching"), "A rail click ends the search");
      is(search.value, "", "...clearing it");
      Assert.deepEqual(shownGroupsIn(panel).map(g => g.dataset.menu), [catalogue[0].id], "...and shows that menu");

      // The header is the drag handle.
      const header = panel.querySelector(".whimsy-surface-header");
      ok(header.classList.contains("whimsy-surface-drag-handle"), "The header drags");
      is(win.getComputedStyle(header).cursor, "grab", "...with a grab cursor");
      const before = panel.getOuterScreenRect();
      const start = header.getBoundingClientRect();
      const x = start.left + 60;
      const y = start.top + start.height / 2;
      EventUtils.synthesizeMouseAtPoint(x, y, { type: "mousedown" }, win);
      // 20px down: the sheet fills 88% of the page, so a bigger drag on a
      // short screen would be clamped at the screen's bottom edge.
      EventUtils.synthesizeMouseAtPoint(x + 40, y + 10, { type: "mousemove" }, win);
      EventUtils.synthesizeMouseAtPoint(x + 120, y + 20, { type: "mousemove" }, win);
      EventUtils.synthesizeMouseAtPoint(x + 120, y + 20, { type: "mouseup" }, win);
      await TestUtils.waitForCondition(() => panel.getOuterScreenRect().left != before.left, "The sheet moves");
      const after = panel.getOuterScreenRect();
      Assert.less(Math.abs(after.left - before.left - 120), 2, "...by the drag across");
      Assert.less(Math.abs(after.top - before.top - 20), 2, "...and down");
      ok(!panel.hasAttribute("dragging"), "...and lets go");
      is(panel.state, "open", "Dragging doesn't close it");
    } finally {
      await closeIn(win, panel);
    }
  });
});

// A narrow window: the window less 40px, still with the rail.
add_task(async function test_narrow_window() {
  await inWindow(480, 800, async win => {
    const panel = await openIn(win);
    try {
      const box = cardOf(panel).getBoundingClientRect();
      Assert.less(Math.abs(box.width - (win.innerWidth - 40)), 1.5, `The window less 40px (${win.innerWidth - 40}px)`);
      ok(panel.querySelector(".whimsy-cheatsheet-rail").checkVisibility(), "The rail stays");
      Assert.greaterOrEqual(Math.round(box.left), 19, "Inside the window on the left");
      Assert.lessOrEqual(Math.round(box.right), win.innerWidth - 19, "...and the right");
    } finally {
      await closeIn(win, panel);
    }
  });
});

// A popup window a page opened (window.open with "popup"): Zen's 495px
// minimum doesn't apply to those, so it can be short.
async function inPopupWindow(width, height, fn) {
  const startTabs = new Set(gBrowser.tabs);
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.com/");
  const opened = BrowserTestUtils.waitForNewWindow();
  await SpecialPowers.spawn(tab.linkedBrowser, [width, height], (w, h) => {
    content.window.open("https://example.com/", "_blank", `popup,width=${w},height=${h}`);
  });
  const win = await opened;
  try {
    ok(win.document.documentElement.hasAttribute("popup-window"), "A popup window");
    win.resizeTo(width, height);
    await TestUtils.waitForCondition(() => Math.abs(win.outerHeight - height) < 40, `The window is ${width}×${height}`);
    await new Promise(resolve => win.requestAnimationFrame(() => win.requestAnimationFrame(resolve)));
    await fn(win);
  } finally {
    await BrowserTestUtils.closeWindow(win);
    for (const t of gBrowser.tabs.filter(t => !startTabs.has(t))) {
      BrowserTestUtils.removeTab(t);
    }
  }
}

// Under 360px of page height: no rail, one list with every menu headed.
add_task(async function test_short_window_is_one_list() {
  await inPopupWindow(1000, 380, async win => {
    const height = WhimsySurface.pageArea(win).getBoundingClientRect().height;
    Assert.less(height, 360, `The page area is short (${height}px)`);
    const panel = await openIn(win);
    try {
      ok(panel.hasAttribute("one-list"), "One list");
      ok(!panel.querySelector(".whimsy-cheatsheet-rail").checkVisibility(), "The rail hides");
      const groups = shownGroupsIn(panel);
      Assert.greater(groups.length, 1, "Every menu shows");
      ok(groups.every(g => win.getComputedStyle(g.querySelector("h2")).display != "none"), "...each under its heading");
      Assert.less(Math.abs(cardOf(panel).getBoundingClientRect().height - Math.round(height * 0.88)), 1.5,
        "Still 88% of the page area");
    } finally {
      await closeIn(win, panel);
    }
  });
});
