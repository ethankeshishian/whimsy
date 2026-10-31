/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// Snooze a tab: it closes right away and reopens on its own once the wake
// time passes, in the same space, with an undo entry in between.

const { WhimsySnooze } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsySnooze.sys.mjs");
const { WhimsyUndo } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyUndo.sys.mjs");

const startTabs = new Set(gBrowser.tabs);
registerCleanupFunction(() => {
  for (const tab of gBrowser.tabs.filter(t => !startTabs.has(t))) {
    if (tab.isConnected && !tab.closing) {
      BrowserTestUtils.removeTab(tab);
    }
  }
});

add_task(async function test_snooze_closes_and_wakes() {
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.com/?snooze-me");
  const before = gBrowser.tabs.length;
  await WhimsySnooze.snooze(window, tab, Date.now() + 200);
  await TestUtils.waitForCondition(() => gBrowser.tabs.length == before - 1, "Closes immediately");
  ok(!tab.isConnected, "The original tab element is gone");
  await TestUtils.waitForCondition(
    () => gBrowser.tabs.some(t => t.linkedBrowser?.currentURI?.spec == "https://example.com/?snooze-me"),
    "It reappears once the wake time passes",
    100,
    50
  );
  const woken = gBrowser.tabs.find(t => t.linkedBrowser?.currentURI?.spec == "https://example.com/?snooze-me");
  BrowserTestUtils.removeTab(woken);
});

add_task(async function test_snooze_undo_cancels_the_wake() {
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.com/?snooze-undo");
  const before = gBrowser.tabs.length;
  await WhimsySnooze.snooze(window, tab, Date.now() + 60000);
  await TestUtils.waitForCondition(() => gBrowser.tabs.length == before - 1, "Closed");
  ok(WhimsyUndo.canUndo(window), "Pushed an undo entry");
  ok(WhimsyUndo.undo(window), "Undo it");
  await TestUtils.waitForCondition(() => gBrowser.tabs.length == before, "Restored right away, not in a minute");
  const restored = await TestUtils.waitForCondition(
    () => gBrowser.tabs.find(t => t.linkedBrowser?.currentURI?.spec == "https://example.com/?snooze-undo"),
    "The restored tab finished navigating"
  );
  BrowserTestUtils.removeTab(restored);
});

// wave8/snooze (W8-37): the Snooze picker. Five presets in fixed places,
// each saying where it lands; the field reads typed times; Pick Date &
// Time opens date and time fields; Esc steps back before it closes.

const { WhimsyToast } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyToast.sys.mjs");

async function openPicker(tab) {
  const shown = BrowserTestUtils.waitForEvent(document, "popupshown", true, e => e.target.id == "whimsySnoozePanel");
  WhimsySnooze.openPanel(window, tab);
  await shown;
  const panel = document.getElementById("whimsySnoozePanel");
  await document.l10n.translateFragment(panel);
  return panel;
}

async function closePicker(panel) {
  if (panel?.isConnected && panel.state == "open") {
    const hidden = BrowserTestUtils.waitForEvent(panel, "popuphidden");
    panel.hidePopup();
    await hidden;
  }
}

function presetRows(panel) {
  return [...panel.querySelectorAll(".whimsy-sheet-item[data-preset]")];
}

async function typeInField(panel, text) {
  const field = panel.querySelector(".whimsy-snooze-field");
  field.focus();
  field.value = "";
  EventUtils.sendString(text, window);
  await document.l10n.translateFragment(panel);
  return field;
}

add_task(async function test_snooze_picker_layout_and_keys() {
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.com/?snooze-sheet");
  const panel = await openPicker(tab);
  try {
    ok(panel.classList.contains("whimsy-sheet"), "It is a Whimsy sheet");
    ok(panel.querySelector(".panel-header .whimsy-sheet-close"), "It has a close button");
    Assert.deepEqual(
      presetRows(panel).map(r => r.getAttribute("data-preset")),
      ["later-today", "tonight", "tomorrow", "weekend", "next-week"],
      "Five presets, always in the same order"
    );
    for (const row of presetRows(panel)) {
      const title = row.querySelector(".whimsy-sheet-item-title").textContent;
      const detail = row.querySelector(".whimsy-sheet-item-detail").textContent;
      ok(title, `${row.getAttribute("data-preset")} has a name`);
      ok(detail, `${row.getAttribute("data-preset")} says where it lands (${detail})`);
    }
    ok(panel.querySelector(".whimsy-snooze-pick"), "Pick Date & Time is offered");
    const field = panel.querySelector(".whimsy-snooze-field");
    is(document.activeElement, field, "The field has focus: type a time straight away");

    // The rectangle is on screen and every row has room (dev.580 was
    // "completely unusable").
    const rect = panel.getBoundingClientRect();
    Assert.greater(rect.width, 300, "The picker is wide enough for names and times");
    for (const row of presetRows(panel)) {
      Assert.greaterOrEqual(row.getBoundingClientRect().height, 24, "Each row is a real target");
    }

    EventUtils.synthesizeKey("KEY_ArrowDown", {}, window);
    const enabled = presetRows(panel).filter(r => !r.hasAttribute("disabled"));
    is(document.activeElement, enabled[0], "Down moves to the first preset you can pick");
    EventUtils.synthesizeKey("KEY_ArrowDown", {}, window);
    is(document.activeElement, enabled[1], "...and on, skipping any that are too late today");
    EventUtils.synthesizeKey("f", {}, window);
    is(document.activeElement, field, "Typing on a row goes back to the field");

    // Esc clears the field first, then closes.
    await typeInField(panel, "fri");
    EventUtils.synthesizeKey("KEY_Escape", {}, window);
    is(field.value, "", "Esc clears the typed text");
    is(panel.state, "open", "...and leaves the picker open");
    const hidden = BrowserTestUtils.waitForEvent(panel, "popuphidden");
    EventUtils.synthesizeKey("KEY_Escape", {}, window);
    await hidden;
    ok(tab.isConnected, "Esc closes the picker without snoozing the tab");
    ok(!document.getElementById("whimsySnoozePanel"), "The picker is removed once hidden");
  } finally {
    await closePicker(panel);
    BrowserTestUtils.removeTab(tab);
  }
});

add_task(async function test_snooze_picker_reads_typed_times() {
  const url = "https://example.com/?snooze-typed";
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, url);
  const title = tab.label;
  const panel = await openPicker(tab);
  try {
    await typeInField(panel, "tom 3pm");
    const typed = panel.querySelector(".whimsy-snooze-typed");
    ok(typed && !typed.hasAttribute("disabled"), "“tom 3pm” is read");
    is(panel.querySelector(".whimsy-sheet-body .whimsy-sheet-item"), typed, "...and comes first");
    ok(typed.querySelector(".whimsy-sheet-item-title").textContent.startsWith("Tomorrow"), "It says Tomorrow");
    ok(typed.querySelector(".whimsy-sheet-item-detail").getAttribute("value").startsWith("in "), "...and how far off");
    ok(!panel.querySelector(".whimsy-snooze-pick"), "Pick Date & Time steps aside while typing");

    await typeInField(panel, "banana");
    ok(!panel.querySelector(".whimsy-snooze-typed"), "Nonsense isn't guessed at");
    ok(panel.querySelector(".whimsy-sheet-empty"), "...an example of what works shows instead");

    await typeInField(panel, "in 2 hours");
    const before = gBrowser.tabs.length;
    const start = Date.now();
    EventUtils.synthesizeKey("KEY_Enter", {}, window);
    await TestUtils.waitForCondition(() => gBrowser.tabs.length == before - 1, "Enter snoozes with the typed time");
    const record = await TestUtils.waitForCondition(
      async () => (await WhimsySnooze.list()).find(r => r.url == url), "The snooze is saved");
    Assert.greaterOrEqual(record.wakeAt, start + 2 * 3600 * 1000 - 1000, "Two hours from now");
    Assert.lessOrEqual(record.wakeAt, Date.now() + 2 * 3600 * 1000 + 1000, "...not later");

    // The toast says until when, names the tab, and offers Undo in words.
    const toast = await TestUtils.waitForCondition(() => WhimsyToast.current(window), "A toast confirms it");
    await document.l10n.translateFragment(toast);
    is(toast.getAttribute("role"), "status", "Read out by screen readers");
    ok(toast.querySelector(".whimsy-toast-message").textContent.startsWith("Snoozed until"), "Says until when");
    is(toast.querySelector(".whimsy-toast-detail").textContent, title, "Names the tab");
    const button = toast.querySelector(".whimsy-toast-action");
    is(button.querySelector(".whimsy-toast-action-label").textContent, "Undo", "The button says Undo");
    is(button.querySelector(".whimsy-toast-keys").textContent, WhimsyToast.undoKeys(), "...with its shortcut");

    // Cmd+Z undoes it and the toast goes with it.
    ok(WhimsyUndo.undo(window), "Cmd+Z's undo runs");
    await TestUtils.waitForCondition(() => !toast.isConnected, "The toast leaves once its action is undone");
    const restored = await TestUtils.waitForCondition(
      () => gBrowser.tabs.find(t => t.linkedBrowser?.currentURI?.spec == url), "The tab is back");
    ok(!(await WhimsySnooze.list()).some(r => r.url == url), "...and won't wake again");
    BrowserTestUtils.removeTab(restored);
  } finally {
    await closePicker(panel);
  }
});

add_task(async function test_snooze_picker_custom_date_and_time() {
  const url = "https://example.com/?snooze-custom";
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, url);
  const panel = await openPicker(tab);
  try {
    panel.querySelector(".whimsy-snooze-pick").doCommand();
    const date = await TestUtils.waitForCondition(() => panel.querySelector(".whimsy-snooze-date"), "Date field");
    const time = panel.querySelector(".whimsy-snooze-time");
    is(document.activeElement, date, "The date field takes focus");
    ok(date.value && time.value, "Both start filled in (tomorrow morning)");
    is(panel.querySelector(".whimsy-snooze-pick").getAttribute("aria-expanded"), "true", "The row says it's open");
    const button = panel.querySelector(".whimsy-snooze-custom-button");
    ok(button && !button.hasAttribute("disabled"), "Snooze is ready");

    // A time in the past says so and can't be picked.
    const yesterday = new Date(Date.now() - 24 * 3600 * 1000);
    date.value = `${yesterday.getFullYear()}-${String(yesterday.getMonth() + 1).padStart(2, "0")}-${String(yesterday.getDate()).padStart(2, "0")}`;
    date.dispatchEvent(new Event("input", { bubbles: true }));
    const status = panel.querySelector(".whimsy-snooze-custom-status");
    ok(status.hasAttribute("invalid"), "A past time is flagged");
    ok(button.hasAttribute("disabled"), "...and Snooze waits for a future one");

    // Esc closes the fields first, then the picker.
    EventUtils.synthesizeKey("KEY_Escape", {}, window);
    ok(!panel.querySelector(".whimsy-snooze-date"), "Esc closes the date fields");
    is(panel.state, "open", "...not the picker");

    panel.querySelector(".whimsy-snooze-pick").doCommand();
    const next = new Date(Date.now() + 3 * 24 * 3600 * 1000);
    const d = panel.querySelector(".whimsy-snooze-date");
    d.value = `${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, "0")}-${String(next.getDate()).padStart(2, "0")}`;
    d.dispatchEvent(new Event("input", { bubbles: true }));
    panel.querySelector(".whimsy-snooze-time").value = "10:30";
    panel.querySelector(".whimsy-snooze-time").dispatchEvent(new Event("input", { bubbles: true }));
    const before = gBrowser.tabs.length;
    panel.querySelector(".whimsy-snooze-custom-button").doCommand();
    await TestUtils.waitForCondition(() => gBrowser.tabs.length == before - 1, "Snoozed for the picked time");
    const record = await TestUtils.waitForCondition(
      async () => (await WhimsySnooze.list()).find(r => r.url == url), "Saved");
    const wake = new Date(record.wakeAt);
    is(wake.getDate(), next.getDate(), "On the picked day");
    is(`${wake.getHours()}:${wake.getMinutes()}`, "10:30", "At the picked time");
    for (const r of await WhimsySnooze.list()) {
      WhimsySnooze.cancelSnooze(null, r);
    }
  } finally {
    await closePicker(panel);
    const left = WhimsyToast.current(window);
    if (left) {
      WhimsyToast._dismissNow(left);
    }
  }
});

// Every action is a command: the picker, each preset, the list, Undo.
add_task(async function test_snooze_commands() {
  const { WhimsyCommands } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyCommands.sys.mjs");
  for (const id of [
    "cmd_whimsySnoozeTab",
    "cmd_whimsySnoozeLaterToday",
    "cmd_whimsySnoozeTonight",
    "cmd_whimsySnoozeTomorrow",
    "cmd_whimsySnoozeWeekend",
    "cmd_whimsySnoozeNextWeek",
    "cmd_whimsyViewSnoozedTabs",
    "cmd_whimsyUndoTabAction",
    "cmd_whimsyRedoTabAction",
  ]) {
    ok(document.getElementById(id), `${id} exists`);
    ok(WhimsyCommands.get(id)?.l10nId, `${id} has a name in the command bar`);
  }

  const url = "https://example.com/?snooze-command";
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, url);
  const before = gBrowser.tabs.length;
  document.getElementById("cmd_whimsySnoozeTomorrow").doCommand();
  await TestUtils.waitForCondition(() => gBrowser.tabs.length == before - 1, "Snooze Tab Until Tomorrow snoozes now");
  const record = await TestUtils.waitForCondition(
    async () => (await WhimsySnooze.list()).find(r => r.url == url), "Saved");
  const wake = new Date(record.wakeAt);
  is(wake.getHours(), 9, "Tomorrow at 9");
  ok(!tab.isConnected, "The tab closed");
  ok(WhimsyUndo.undo(window), "Undo brings it back");
  const restored = await TestUtils.waitForCondition(
    () => gBrowser.tabs.find(t => t.linkedBrowser?.currentURI?.spec == url), "Restored");
  BrowserTestUtils.removeTab(restored);
});
