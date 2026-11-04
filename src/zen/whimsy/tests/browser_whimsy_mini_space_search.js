/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// W10-29 / F19 (Arc parity): ⌘⇧O in Mini turns its "Open in Space" pill into a search
// field and drops the spaces down under it: one flat list, the current space
// first and the rest in sidebar order, each space's profile as a small trailing label. Typing filters by space or
// profile name; Return opens the page in the highlighted space; Esc puts
// Open in Space back, leaving the address strip untouched.

const { WhimsyQuickWindow } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyQuickWindow.sys.mjs");
const { WhimsyProfiles } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyProfiles.sys.mjs");
const { WhimsyProfileMoves } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyProfileMoves.sys.mjs");
const { ContextualIdentityService } = ChromeUtils.importESModule(
  "moz-src:///toolkit/components/contextualidentity/ContextualIdentityService.sys.mjs"
);

let home, work, workSpace, cafe;
const startTabs = new Set(gBrowser.tabs);
const realConfirm = WhimsyProfileMoves.confirm;

add_setup(async function () {
  home = gZenWorkspaces.getActiveWorkspace();
  work = WhimsyProfiles.create("Whimsy Search Work");
  workSpace = await gZenWorkspaces.createAndSaveWorkspace("Quarterly Plans", undefined, true, work);
  cafe = await gZenWorkspaces.createAndSaveWorkspace("Café Notes", undefined, true);
  // Opening Mini remembers its window size.
  const SIZE_PREF = "whimsy.quick-window.size";
  const hadSize = Services.prefs.prefHasUserValue(SIZE_PREF);
  const size = hadSize ? Services.prefs.getStringPref(SIZE_PREF) : undefined;
  registerCleanupFunction(() => {
    if (hadSize) {
      Services.prefs.setStringPref(SIZE_PREF, size);
    } else {
      Services.prefs.clearUserPref(SIZE_PREF);
    }
  });
  registerCleanupFunction(async () => {
    WhimsyProfileMoves.confirm = realConfirm;
    if (gZenWorkspaces.activeWorkspace != home.uuid) {
      await gZenWorkspaces.changeWorkspace(home);
    }
    for (const tab of gBrowser.tabs.filter(t => !startTabs.has(t) && t.linkedBrowser.currentURI.spec == "about:blank")) {
      BrowserTestUtils.removeTab(tab);
    }
    for (const tab of gBrowser.tabs.filter(t => t.userContextId == work && !t.hasAttribute("zen-essential"))) {
      BrowserTestUtils.removeTab(tab);
    }
    await gZenWorkspaces.removeWorkspace(workSpace.uuid);
    await gZenWorkspaces.removeWorkspace(cafe.uuid);
    ContextualIdentityService.remove(work);
  });
});

async function openMini() {
  const win = WhimsyQuickWindow.open("https://example.com/", { opener: window });
  await WhimsyQuickWindow.whenReady(win);
  await TestUtils.waitForCondition(
    () => win.document.getElementById("whimsy-quick-window-move-to-space")?.getAttribute("label"),
    "Mini is ready"
  );
  await SimpleTest.promiseFocus(win);
  return win;
}

async function openSearch(win) {
  EventUtils.synthesizeKey("o", { accelKey: true, shiftKey: true }, win);
  const doc = win.document;
  await TestUtils.waitForCondition(() => doc.getElementById("whimsy-quick-window-space-picker")?.state == "open", "The list drops down");
  return { doc, panel: doc.getElementById("whimsy-quick-window-space-picker"), input: doc.getElementById("whimsy-mini-picker-search") };
}

function sidebarOrder() {
  return gZenWorkspaces.getWorkspaces().filter(s => !s.whimsyScratch).map(s => s.uuid);
}

function currentFirst(id) {
  const order = sidebarOrder();
  return order.includes(id) ? [id, ...order.filter(x => x != id)] : order;
}

function typeInto(win, input, text) {
  input.focus();
  input.value = "";
  EventUtils.sendString(text, win);
}

const shownRows = panel => [...panel.querySelectorAll(".whimsy-mini-picker-space")].filter(row => !row.hidden);

add_task(async function flat_list_with_profile_labels() {
  const win = await openMini();
  try {
    const { doc, panel, input } = await openSearch(win);
    is(doc.activeElement, input, "The search field in Open in Space is focused");
    is(input.getAttribute("role"), "combobox", "It's a combobox");
    is(input.getAttribute("aria-controls"), "whimsy-mini-picker-list", "for the list");
    ok(doc.getElementById("whimsy-quick-window-open").hasAttribute("searching"), "Open in Space is searching");
    ok(!doc.getElementById("whimsy-quick-window-address-field").hasAttribute("searching"), "Address field is untouched");
    ok(doc.getElementById("whimsy-quick-window-address").checkVisibility(), "Address remains visible");
    ok(!panel.querySelector(".whimsy-mini-picker-profile-heading, menuseparator, menucaption"), "No profile groups");
    const rows = shownRows(panel);
    Assert.deepEqual(rows.map(r => r.getAttribute("zen-workspace-id")), currentFirst(gZenWorkspaces.activeWorkspace),
      "Current space first, then sidebar order");
    ok(rows[0].hasAttribute("default"), "The first row is the one ⌘O uses");
    const workRow = rows.find(r => r.getAttribute("zen-workspace-id") == workSpace.uuid);
    is(workRow.querySelector(".whimsy-mini-picker-profile")?.textContent, "Whimsy Search Work", "Its profile is a trailing label");
    const box = workRow.getBoundingClientRect();
    const label = workRow.querySelector(".whimsy-mini-picker-profile").getBoundingClientRect();
    ok(label.left > workRow.querySelector(".whimsy-mini-picker-name").getBoundingClientRect().left && label.right <= box.right,
      "The label trails the name");
    is(input.getAttribute("aria-activedescendant"), rows[0].id, "The first space is highlighted");
    const hidden = BrowserTestUtils.waitForEvent(panel, "popuphidden");
    EventUtils.synthesizeKey("KEY_Escape", {}, win);
    await hidden;
    ok(!doc.getElementById("whimsy-quick-window-open").hasAttribute("searching"), "Esc puts Open in Space back");
    ok(doc.getElementById("whimsy-quick-window-move-to-space").checkVisibility(), "Open in Space button is visible again");
    // F19: ⌘⇧O came from the page, so the keyboard goes back there (the
    // caret used to be left lit).
    is(doc.activeElement, win.gBrowser.selectedBrowser, "and the keyboard back on the page");
  } finally {
    await BrowserTestUtils.closeWindow(win);
  }
});

add_task(async function filter_by_space_and_profile() {
  const win = await openMini();
  try {
    const { doc, panel, input } = await openSearch(win);
    typeInto(win, input, "quarterly");
    let rows = shownRows(panel);
    is(rows.length, 1, "A space name leaves one row");
    is(input.getAttribute("aria-activedescendant"), rows[0].id, "and highlights it");
    is(rows[0].querySelector(".whimsy-mini-picker-name b")?.textContent, "Quarterly", "The match is bold");

    typeInto(win, input, "cafe");
    rows = shownRows(panel);
    is(rows.length, 1, "Accents don't matter");
    is(rows[0].getAttribute("zen-workspace-id"), cafe.uuid, "Café Notes");

    typeInto(win, input, "search work");
    rows = shownRows(panel);
    ok(rows.every(r => r.querySelector(".whimsy-mini-picker-profile b")), "A profile name finds its spaces, marked in the label");
    ok(rows.some(r => r.getAttribute("zen-workspace-id") == workSpace.uuid), "including Quarterly Plans");

    typeInto(win, input, "zzznothing");
    is(shownRows(panel).length, 0, "No match");
    ok(!panel.querySelector(".whimsy-mini-picker-empty").hidden, "says so");
    EventUtils.synthesizeKey("KEY_Enter", {}, win);
    ok(!win.closed && panel.state == "open", "Return does nothing without a row");
    panel.hidePopup();
  } finally {
    if (!win.closed) {
      await BrowserTestUtils.closeWindow(win);
    }
  }
});

add_task(async function arrows_and_return_open_in_the_space() {
  WhimsyProfileMoves.confirm = async () => true;
  const win = await openMini();
  const { panel, input } = await openSearch(win);
  const rows = shownRows(panel);
  EventUtils.synthesizeKey("KEY_End", {}, win);
  is(input.getAttribute("aria-activedescendant"), rows.at(-1).id, "End goes to the last space");
  EventUtils.synthesizeKey("KEY_ArrowDown", {}, win);
  is(input.getAttribute("aria-activedescendant"), rows[0].id, "Down wraps to the first");
  typeInto(win, input, "quarterly");
  EventUtils.synthesizeKey("KEY_Enter", {}, win);
  await TestUtils.waitForCondition(() => win.closed, "Return opens the page in that space (after the profile confirm)");
  await TestUtils.waitForCondition(
    () => gBrowser.tabs.some(t => t.userContextId == work && t.linkedBrowser.currentURI.spec == "https://example.com/"),
    "The page is in Quarterly Plans' profile"
  );
});

// F19: after ⌘⇧O from the page, Esc gives the keyboard back to the page;
// the caret isn't left lit with a focus ring.
add_task(async function esc_after_shortcut_leaves_no_lit_button() {
  const win = await openMini();
  try {
    win.gBrowser.selectedBrowser.focus();
    const { doc, panel } = await openSearch(win);
    EventUtils.synthesizeKey("KEY_Escape", {}, win);
    await TestUtils.waitForCondition(() => panel.state == "closed", "Esc closes the list");
    const caret = doc.getElementById("whimsy-quick-window-choose-space");
    ok(!caret.matches(":focus-visible"), "The caret has no focus ring");
    ok(!caret.hasAttribute("open"), "...and doesn't read as pressed");
    is(doc.activeElement, win.gBrowser.selectedBrowser, "The page has the keyboard again");
  } finally {
    await BrowserTestUtils.closeWindow(win);
  }
});

add_task(async function current_space_is_first_and_return_opens_it() {
  const order = sidebarOrder();
  Assert.greater(order.length, 2, "Three or more spaces");
  const middle = order[1];
  await gZenWorkspaces.changeWorkspace(gZenWorkspaces.getWorkspaces().find(s => s.uuid == middle));
  const win = await openMini();
  try {
    const { panel, input } = await openSearch(win);
    const rows = shownRows(panel);
    Assert.deepEqual(rows.map(r => r.getAttribute("zen-workspace-id")), [middle, ...order.filter(x => x != middle)],
      "The active space first, the rest in sidebar order");
    ok(rows[0].hasAttribute("default") && rows[0].querySelector(".whimsy-mini-picker-keys"), "It carries ⌘O");
    is(input.getAttribute("aria-activedescendant"), rows[0].id, "and is highlighted");

    typeInto(win, input, "a");
    const ids = shownRows(panel).map(r => r.getAttribute("zen-workspace-id"));
    const cafeAt = ids.indexOf(cafe.uuid);
    const planAt = ids.indexOf(workSpace.uuid);
    ok(cafeAt != -1 && planAt != -1, "A query matching two spaces shows both");
    is(ids.indexOf(middle) == -1 || ids.indexOf(middle) == 0, true, "The current space stays first among the matches");
    typeInto(win, input, "");
    const before = gBrowser.tabs.length;
    EventUtils.synthesizeKey("KEY_Enter", {}, win);
    await TestUtils.waitForCondition(() => win.closed, "Return with no typing opens the page");
    const adopted = gBrowser.tabs.find(t => t.linkedBrowser.currentURI.spec == "https://example.com/" && t.getAttribute("zen-workspace-id") == middle);
    ok(adopted, "in the current space");
    is(gBrowser.tabs.length, before + 1, "as one new tab");
    BrowserTestUtils.removeTab(adopted);
  } finally {
    if (!win.closed) {
      await BrowserTestUtils.closeWindow(win);
    }
    await gZenWorkspaces.changeWorkspace(home);
  }
});

add_task(async function first_space_active_keeps_sidebar_order() {
  const order = sidebarOrder();
  await gZenWorkspaces.changeWorkspace(gZenWorkspaces.getWorkspaces().find(s => s.uuid == order[0]));
  const win = await openMini();
  try {
    const { panel } = await openSearch(win);
    Assert.deepEqual(shownRows(panel).map(r => r.getAttribute("zen-workspace-id")), order, "No reordering beyond the move");
  } finally {
    await BrowserTestUtils.closeWindow(win);
    await gZenWorkspaces.changeWorkspace(home);
  }
});

add_task(async function no_opener_uses_the_most_recent_window() {
  const other = await BrowserTestUtils.openNewBrowserWindow();
  try {
    await other.gZenWorkspaces.promiseInitialized;
    await other.gZenWorkspaces.changeWorkspace(other.gZenWorkspaces.getWorkspaces().find(s => s.uuid == cafe.uuid));
    await SimpleTest.promiseFocus(other);
    const win = WhimsyQuickWindow.open("https://example.com/");
    await WhimsyQuickWindow.whenReady(win);
    await TestUtils.waitForCondition(
      () => win.document.getElementById("whimsy-quick-window-move-to-space")?.getAttribute("label"),
      "Mini is ready"
    );
    await SimpleTest.promiseFocus(win);
    const { panel } = await openSearch(win);
    const rows = shownRows(panel);
    is(rows[0].getAttribute("zen-workspace-id"), cafe.uuid, "The list starts with the space of the window used last");
    ok(rows[0].hasAttribute("default"), "and ⌘O uses it");
    EventUtils.synthesizeKey("KEY_Enter", {}, win);
    await TestUtils.waitForCondition(() => win.closed, "Return opens the page");
    const adopted = other.gBrowser.tabs.find(t => t.linkedBrowser.currentURI.spec == "https://example.com/" && t.getAttribute("zen-workspace-id") == cafe.uuid);
    ok(adopted, "in the other window's space");
  } finally {
    await BrowserTestUtils.closeWindow(other);
  }
});
