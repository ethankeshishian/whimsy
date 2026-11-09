/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// W23 routines-ui: Library › Routines. Routines and page watches in one
// list, row buttons on hover or focus, the keyboard map, delete confirmed in
// the row with Undo, the AI-off card, the built-ins as switches, and the
// form in place (Turn on for new, Save for an edit, Try it now saves
// nothing). A fake provider stands in; nothing touches the network.

const { WhimsyRoutines } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyRoutines.sys.mjs");
const { WhimsyRoutinesUI } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyRoutinesUI.sys.mjs");
const { WhimsyAIProviders } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyAIProviders.sys.mjs");
const { WhimsyAIStore } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyAIStore.sys.mjs");
const { WhimsyAIUpdates } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyAIUpdates.sys.mjs");
const { WhimsyAI } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyAI.sys.mjs");
const { WhimsyConnectors } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyConnectors.sys.mjs");

const BRIEF = { title: "Daily brief", prompt: "Summarize today’s meetings.", trigger: { kind: "schedule", days: [1, 2, 3, 4, 5], hour: 8, minute: 0 } };
const asked = [];

add_setup(async () => {
  await WhimsyAIStore._resetForTesting(PathUtils.join(PathUtils.tempDir, `whimsy-library-routines-${Date.now()}`));
  WhimsyAIUpdates._resetForTesting();
  WhimsyAIProviders.setTestProvider(request => {
    asked.push(request);
    return "3 meetings today\n\n- 10:00 Design review";
  });
  await WhimsyRoutines._resetForTesting();
  registerCleanupFunction(async () => {
    await closeLibrary();
    await WhimsyRoutines._resetForTesting();
    WhimsyAIProviders.setTestProvider(null);
    WhimsyAIUpdates._resetForTesting();
    await WhimsyAIStore._resetForTesting(null);
    Services.prefs.setBoolPref("whimsy.ai.enabled", true);
    await WhimsyAI.pending;
  });
});

function lib() {
  return document.querySelector("zen-library");
}

function section() {
  return document.querySelector("whimsy-library-routines-section");
}

async function openRoutines() {
  ok(WhimsyRoutinesUI.openLibrary(window), "The Library opens on Routines");
  const s = await TestUtils.waitForCondition(() => section()?.loaded && section(), "The Routines section is up");
  await TestUtils.waitForCondition(() => lib().hasAttribute("open") || window.customElements.get("zen-library").isLibraryOpen, "The Library is open");
  await s.updateComplete;
  await document.l10n.translateFragment(s);
  await visible(s, "The Library has slid in");
  return s;
}

async function closeLibrary() {
  const ZenLibrary = window.customElements.get("zen-library");
  if (ZenLibrary?.isLibraryOpen) {
    ZenLibrary.animateProgress(0);
    await TestUtils.waitForCondition(() => !ZenLibrary.isLibraryOpen, "The Library closes");
  }
}

async function fresh() {
  await closeLibrary();
  asked.length = 0;
  await WhimsyRoutines._resetForTesting();
  WhimsyAIUpdates._resetForTesting();
}

async function rowOf(s, id) {
  return TestUtils.waitForCondition(() => s.querySelector(`.whimsy-routine-row[data-id="${id}"]`), "The row is there");
}

// Laid out, shown, and still: the Library slides in and the form's panel
// grows, so a node is clicked only once it stops moving.
async function visible(node, what) {
  node.scrollIntoView?.({ block: "nearest" });
  let last = "";
  await TestUtils.waitForCondition(() => {
    const r = node.getBoundingClientRect();
    const where = `${r.left},${r.top},${r.width},${r.height}`;
    const still = where == last;
    last = where;
    return still && r.width > 0 && node.checkVisibility?.({ visibilityProperty: true, opacityProperty: true });
  }, what, 50, 100);
  return node;
}

add_task(async function last_in_rail_after_easels() {
  await fresh();
  await openRoutines();
  const ids = Object.keys(lib().zenLibrarySections);
  is(ids.at(-1), "whimsy-routines", "Routines is last in the rail");
  is(ids.at(-2), "whimsy-easels", "right after Easels");
  const tab = document.querySelector(`zen-library .zen-library-tab[data-section="whimsy-routines"]`);
  ok(tab, "with a rail tab");
  const image = tab.querySelector(".zen-library-tab-icon-image");
  ok(getComputedStyle(image).backgroundImage.includes("library-routines-sprite.svg"), "drawn by its own sprite");
  await closeLibrary();
});

add_task(async function absent_in_private_window() {
  const win = await BrowserTestUtils.openNewBrowserWindow({ private: true });
  await TestUtils.waitForCondition(() => win.document.querySelector("zen-library")?._whimsySectionsHooked, "The private window's Library is hooked");
  ok(!("whimsy-routines" in win.document.querySelector("zen-library").zenLibrarySections), "No Routines section in a private window");
  ok(!WhimsyRoutinesUI.openForm(win, {}), "and no routine form");
  await BrowserTestUtils.closeWindow(win);
});

add_task(async function row_buttons_on_focus() {
  await fresh();
  const r = await WhimsyRoutines.save(BRIEF, { confirmed: true });
  const s = await openRoutines();
  const row = await rowOf(s, r.id);
  const acts = row.querySelector(".whimsy-routine-acts");
  is(getComputedStyle(acts).visibility, "hidden", "The buttons wait out of sight");
  row.focus();
  await visible(acts, "Focus shows Run now, Pause, Edit, and Delete");
  Assert.deepEqual([...acts.querySelectorAll("button")].map(b => b.dataset.action), ["run", "pause", "edit", "delete"], "in that order");
  const time = row.querySelector(".whimsy-routine-time");
  await TestUtils.waitForCondition(() => getComputedStyle(time).opacity == "0", "The time fades out");
  is(getComputedStyle(time).opacity, "0", "in place of the time");
  for (const button of acts.querySelectorAll("button")) {
    ok(button.getAttribute("aria-label"), `${button.dataset.action} has a label`);
  }
  await closeLibrary();
});

add_task(async function keyboard_map() {
  await fresh();
  const a = await WhimsyRoutines.save(BRIEF, { confirmed: true });
  const b = await WhimsyRoutines.save({ ...BRIEF, title: "Standup digest", prompt: "List what moved." }, { confirmed: true });
  const s = await openRoutines();
  const first = await rowOf(s, a.id);
  const second = await rowOf(s, b.id);
  first.focus();
  EventUtils.synthesizeKey("KEY_ArrowDown");
  is(document.activeElement, second, "↓ moves to the next row");
  EventUtils.synthesizeKey("KEY_ArrowUp");
  is(document.activeElement, first, "↑ moves back");
  EventUtils.synthesizeKey(" ");
  await TestUtils.waitForCondition(async () => (await WhimsyRoutines.get(a.id)).paused, "Space pauses");
  const paused = await TestUtils.waitForCondition(() => s.querySelector(`.whimsy-routine-row[data-id="${a.id}"][paused]`), "The row shows paused");
  await TestUtils.waitForCondition(() => getComputedStyle(paused).opacity == "0.55", "The row fades");
  is(getComputedStyle(paused).opacity, "0.55", "at 55%");
  paused.focus();
  EventUtils.synthesizeKey(" ");
  await TestUtils.waitForCondition(async () => !(await WhimsyRoutines.get(a.id)).paused, "Space resumes");
  const row = await rowOf(s, a.id);
  row.focus();
  EventUtils.synthesizeKey("KEY_Tab");
  is(document.activeElement.dataset.action, "run", "Tab reaches the row's buttons, Run now first");
  row.focus();
  const opened = new Promise(resolve => {
    const real = WhimsyRoutinesUI.threadFor;
    WhimsyRoutinesUI.threadFor = async id => {
      WhimsyRoutinesUI.threadFor = real;
      resolve(id);
      return null;
    };
  });
  EventUtils.synthesizeKey("KEY_Enter");
  is(await opened, a.id, "Enter opens its thread");
  row.focus();
  EventUtils.synthesizeKey("KEY_Backspace");
  const cancel = await TestUtils.waitForCondition(() => s.querySelector(".whimsy-routine-confirm-cancel"), "⌫ asks to delete");
  await TestUtils.waitForCondition(() => document.activeElement == cancel, "with Cancel focused");
  EventUtils.synthesizeKey("KEY_Enter");
  await TestUtils.waitForCondition(() => !s.querySelector(".whimsy-routine-confirm"), "Return on Cancel keeps it");
  ok(await WhimsyRoutines.get(a.id), "Nothing was deleted");
  await closeLibrary();
});

add_task(async function delete_in_row_confirm_undo_2s() {
  await fresh();
  const r = await WhimsyRoutines.save(BRIEF, { confirmed: true });
  const s = await openRoutines();
  const row = await rowOf(s, r.id);
  row.focus();
  const del = await visible(row.querySelector("[data-action='delete']"), "Delete shows");
  EventUtils.synthesizeMouseAtCenter(del, {});
  const confirm = await TestUtils.waitForCondition(() => row.querySelector(".whimsy-routine-confirm-delete"), "The row asks in place");
  await visible(confirm, "The confirm strip is laid out");
  EventUtils.synthesizeMouseAtCenter(confirm, {});
  await TestUtils.waitForCondition(async () => !(await WhimsyRoutines.get(r.id)), "It's deleted");
  const toast = await TestUtils.waitForCondition(() => document.querySelector(".zen-toast #whimsy-undo-toast-button"), "An Undo toast shows");
  await visible(toast, "The Undo button is laid out");
  EventUtils.synthesizeMouseAtCenter(toast, {});
  await TestUtils.waitForCondition(async () => !!(await WhimsyRoutines.get(r.id)), "Undo brings it back");
  await rowOf(s, r.id);
  await closeLibrary();
});

add_task(async function ai_off_opt_in_card() {
  await fresh();
  await WhimsyRoutines.save(BRIEF, { confirmed: true });
  Services.prefs.setBoolPref("whimsy.ai.enabled", false);
  await WhimsyAI.pending;
  try {
    const s = await openRoutines();
    await TestUtils.waitForCondition(() => s.hasAttribute("needs-opt-in"), "The section knows AI is off");
    const card = await TestUtils.waitForCondition(() => s.querySelector(".whimsy-routines-opt-in"), "It shows the opt-in card");
    await document.l10n.translateFragment(s);
    is(card.querySelector("h3").textContent, "Routines need AI", "Routines need AI");
    ok(card.querySelector(".whimsy-routines-set-up"), "with Set up AI");
    is(getComputedStyle(s.querySelector(".zen-library-search-top")).display, "none", "and no search or New");
    ok(card.querySelector(".zen-library-media-opt-in-note").textContent.includes("Your routine is kept"), "It says what's kept");
    ok(!WhimsyRoutinesUI.openForm(window, {}), "The form doesn't open while AI is off");
  } finally {
    Services.prefs.setBoolPref("whimsy.ai.enabled", true);
    await WhimsyAI.pending;
    await closeLibrary();
  }
});

add_task(async function sprite_plays_on_select() {
  await fresh();
  await openRoutines();
  lib().activeTab = "history";
  await TestUtils.waitForCondition(() => lib().activeTab == "history", "History is in front");
  const tab = document.querySelector(`zen-library .zen-library-tab[data-section="whimsy-routines"]`);
  // Last in the rail, it may sit below the fold of a short window.
  tab.scrollIntoView({ block: "nearest" });
  await visible(tab, "The Routines tab is laid out");
  EventUtils.synthesizeMouseAtCenter(tab, {});
  const image = tab.querySelector(".zen-library-tab-icon-image");
  await TestUtils.waitForCondition(() => image.getAnimations().some(a => a.animationName == "zen-library-sprite-play"), "Choosing it plays the sprite");
  await closeLibrary();
});

add_task(async function builtins_all_off_switch_opens_filled_form() {
  await fresh();
  const s = await openRoutines();
  const switches = await TestUtils.waitForCondition(() => {
    const all = s.querySelectorAll(".whimsy-routine-builtin .whimsy-routine-switch");
    return all.length == 8 && all;
  }, "Eight built-ins");
  ok([...switches].every(x => !x.checked), "all off");
  const brief = s.querySelector(".whimsy-routine-builtin[data-builtin='daily-brief'] .whimsy-routine-switch");
  await visible(brief, "Daily brief's switch is laid out");
  EventUtils.synthesizeMouseAtCenter(brief, {});
  const form = await TestUtils.waitForCondition(() => s.querySelector(".whimsy-routine-form"), "Turning it on opens its form");
  await TestUtils.waitForCondition(() => s.querySelector(".zen-library-search-top[open]"), "in place of the search");
  ok(form.querySelector(".whimsy-routine-form-prompt").value.startsWith("Summarize today"), "filled with its prompt");
  ok(form.querySelector(".whimsy-routine-chip[data-kind='schedule'][active]"), "and its trigger");
  await closeLibrary();
});

add_task(async function cancel_turns_back_off() {
  await fresh();
  const s = await openRoutines();
  const sw = await TestUtils.waitForCondition(() => s.querySelector(".whimsy-routine-builtin[data-builtin='weekly-recap'] .whimsy-routine-switch"), "Weekly recap's switch");
  await visible(sw, "laid out");
  EventUtils.synthesizeMouseAtCenter(sw, {});
  const cancel = await TestUtils.waitForCondition(() => s.querySelector(".whimsy-routine-form-cancel"), "The form opens");
  await visible(cancel, "Cancel is laid out");
  EventUtils.synthesizeMouseAtCenter(cancel, {});
  await TestUtils.waitForCondition(() => !s.querySelector(".zen-library-search-top[open]"), "Cancel returns to the list");
  await TestUtils.waitForCondition(() => !s.querySelector(".whimsy-routine-builtin[data-builtin='weekly-recap'] .whimsy-routine-switch").checked, "and the switch is off again");
  is((await WhimsyRoutines.list()).length, 0, "Nothing was saved");
  await closeLibrary();
});

add_task(async function turn_on_for_new_save_for_edit() {
  await fresh();
  const s = await openRoutines();
  WhimsyRoutinesUI.openForm(window, { prefill: { prompt: "Give me the top 5 stories.", trigger: { kind: "schedule" } } });
  const primary = await TestUtils.waitForCondition(() => s.querySelector(".whimsy-routine-form-primary"), "The form opens");
  await document.l10n.translateFragment(s);
  is(primary.textContent, "Turn on", "A new routine says Turn on");
  await visible(primary, "Turn on is laid out");
  EventUtils.synthesizeMouseAtCenter(primary, {});
  const saved = await TestUtils.waitForCondition(async () => (await WhimsyRoutines.list())[0], "It's saved");
  is(saved.prompt, "Give me the top 5 stories.", "with what it does");
  await TestUtils.waitForCondition(() => !s.querySelector(".zen-library-search-top[open]"), "and the list comes back");
  const row = await rowOf(s, saved.id);
  row.focus();
  const edit = await visible(row.querySelector("[data-action='edit']"), "Edit shows");
  EventUtils.synthesizeMouseAtCenter(edit, {});
  const save = await TestUtils.waitForCondition(() => s.querySelector(".zen-library-search-top[open]") && s.querySelector(".whimsy-routine-form-primary"), "Edit opens the form");
  await document.l10n.translateFragment(s);
  is(save.textContent, "Save", "An edit says Save");
  await closeLibrary();
});

add_task(async function try_it_now_does_not_save() {
  await fresh();
  const s = await openRoutines();
  WhimsyRoutinesUI.openForm(window, { prefill: { prompt: "Summarize today’s meetings.", trigger: { kind: "schedule" } } });
  const tryButton = await TestUtils.waitForCondition(() => s.querySelector(".whimsy-routine-form-try"), "The form opens");
  await visible(tryButton, "Try it now is laid out");
  EventUtils.synthesizeMouseAtCenter(tryButton, {});
  const tried = await TestUtils.waitForCondition(() => {
    const t = s.querySelector(".whimsy-routine-form-tried");
    return t && !t.hidden && t;
  }, "Try it now shows what it found");
  is(tried.querySelector(".whimsy-routine-form-tried-head").textContent, "3 meetings today", "with its headline");
  is((await WhimsyRoutines.list()).length, 0, "and saves nothing");
  is((await WhimsyAIUpdates.list()).updates.length, 0, "and posts nothing");
  await closeLibrary();
});

add_task(async function show_in_labels() {
  await fresh();
  const s = await openRoutines();
  WhimsyRoutinesUI.openForm(window, { prefill: { prompt: "x", trigger: { kind: "schedule" } } });
  const show = await TestUtils.waitForCondition(() => s.querySelector(".whimsy-routine-form [data-field='show']"), "The form opens");
  await visible(show, "Show it in is laid out");
  EventUtils.synthesizeMouseAtCenter(show, {});
  const list = await TestUtils.waitForCondition(() => document.getElementById("whimsy-routine-form-show-list")?.state == "open" && document.getElementById("whimsy-routine-form-show-list"), "Its menu opens");
  await document.l10n.translateFragment(list);
  Assert.deepEqual(
    [...list.querySelectorAll(".whimsy-surface-option-label")].map(x => x.textContent),
    ["The command bar", "The command bar and a notification", "Only its chat thread"],
    "Show it in: the command bar, with a notification, or only its thread"
  );
  ok(![...list.querySelectorAll("[role=option]")].some(x => /\bNow\b/.test(x.textContent)), "Never “Now”");
  const hidden = BrowserTestUtils.waitForPopupEvent(list, "hidden");
  EventUtils.synthesizeKey("KEY_Escape");
  await hidden;
  await closeLibrary();
});

add_task(async function using_dims_incapable() {
  await fresh();
  const s = await openRoutines();
  const realFits = WhimsyAIProviders.capabilities;
  WhimsyRoutinesUI.openForm(window, { prefill: { prompt: "x", trigger: { kind: "email", match: "anyone" } } });
  const using = await TestUtils.waitForCondition(() => s.querySelector(".whimsy-routine-form [data-field='using']"), "The form opens");
  await visible(using, "Using is laid out");
  EventUtils.synthesizeMouseAtCenter(using, {});
  const list = await TestUtils.waitForCondition(() => document.getElementById("whimsy-routine-form-using-list")?.state == "open" && document.getElementById("whimsy-routine-form-using-list"), "Its menu opens");
  const auto = list.querySelector("[role=option][data-value='auto']");
  ok(auto, "Automatic leads");
  for (const option of list.querySelectorAll("[role=option]:not([data-value='auto'])")) {
    const can = WhimsyAIProviders.capabilities(option.dataset.value).tools;
    is(option.getAttribute("aria-disabled") == "true", !can, `${option.dataset.value} is ${can ? "offered" : "dimmed with why"}`);
  }
  WhimsyAIProviders.capabilities = realFits;
  const hidden = BrowserTestUtils.waitForPopupEvent(list, "hidden");
  EventUtils.synthesizeKey("KEY_Escape");
  await hidden;
  await closeLibrary();
});

add_task(async function connector_inline_waits() {
  await fresh();
  const realList = WhimsyConnectors.list;
  const realConnect = WhimsyConnectors.connect;
  let connected = false;
  WhimsyConnectors.list = async () => [{ id: "google", connected, status: connected ? "ok" : "off" }];
  WhimsyConnectors.connect = async () => {
    connected = true;
  };
  try {
    const s = await openRoutines();
    WhimsyRoutinesUI.openForm(window, { prefill: { prompt: "If it’s a receipt, tell me the total.", trigger: { kind: "email", match: "anyone" } } });
    const row = await TestUtils.waitForCondition(() => {
      const c = s.querySelector(".whimsy-routine-form-connect");
      return c && !c.hidden && c.querySelector("[data-connector='google']") && c;
    }, "Mail triggers offer the connector in place");
    const primary = s.querySelector(".whimsy-routine-form-primary");
    ok(primary.disabled, "Turn on waits for it");
    const gmail = row.querySelector("[data-connector='google']");
    await visible(gmail, "Connect Gmail is laid out");
    EventUtils.synthesizeMouseAtCenter(gmail, {});
    await TestUtils.waitForCondition(() => !primary.disabled, "Connected, Turn on is ready");
    ok(s.querySelector(".whimsy-routine-form-connected"), "and the row says Connected");
  } finally {
    WhimsyConnectors.list = realList;
    WhimsyConnectors.connect = realConnect;
    await closeLibrary();
  }
});

add_task(async function chat_card_outlined_never_auto_on() {
  await fresh();
  WhimsyRoutinesUI.openForm(window, { prefill: { title: "Weekly recap", prompt: "Recap my week.", trigger: { kind: "schedule", days: [5], hour: 16, minute: 0 } }, outlined: true });
  const sheet = await TestUtils.waitForCondition(() => document.getElementById("whimsy-routine-sheet")?.state == "open" && document.getElementById("whimsy-routine-sheet"), "Chat's routine opens in a sheet");
  const filled = sheet.querySelectorAll(".is-filled");
  ok(filled.length >= 4, "Its fields are outlined");
  ok(sheet.querySelector(".whimsy-routine-form-prompt.is-filled"), "do this among them");
  is((await WhimsyRoutines.list()).length, 0, "Nothing turned on by itself");
  const prompt = sheet.querySelector(".whimsy-routine-form-prompt");
  prompt.focus();
  EventUtils.sendString(" Group by project.");
  ok(!prompt.classList.contains("is-filled"), "Touching a field drops its outline");
  const hidden = BrowserTestUtils.waitForPopupEvent(sheet, "hidden");
  EventUtils.synthesizeKey("KEY_Escape");
  await hidden;
  is((await WhimsyRoutines.list()).length, 0, "Closing it saves nothing");
});

// The sheet's sentence: lowercase tokens, days and time as one token, and
// "Pick days and time…" turning the menu into day chips and a time field.
add_task(async function sheet_schedule_token_and_day_chips() {
  await fresh();
  WhimsyRoutinesUI.openForm(window, { prefill: { title: "Weekly recap", prompt: "Recap my week.", trigger: { kind: "schedule", days: [1, 2, 3, 4, 5], hour: 8, minute: 0 } }, outlined: true });
  const sheet = await TestUtils.waitForCondition(() => document.getElementById("whimsy-routine-sheet")?.state == "open" && document.getElementById("whimsy-routine-sheet"), "The sheet opens");
  await document.l10n.translateFragment(sheet);
  const trigger = sheet.querySelector("[data-field='trigger']");
  const token = sheet.querySelector("[data-field='schedule']");
  ok(token, "Days and time are one token");
  ok(!sheet.querySelector("[data-field='days'], [data-field='time']"), "No separate days or time token");
  is(trigger.querySelector(".whimsy-surface-dropdown-value").getAttribute("data-l10n-id"), "whimsy-routine-form-token-schedule", "The trigger token reads in lowercase");
  const value = token.querySelector(".whimsy-surface-dropdown-value");
  await TestUtils.waitForCondition(() => value.textContent.startsWith("weekdays at "), "The token reads “weekdays at 8:00 AM”");

  await visible(token, "The schedule token is still");
  const shown = BrowserTestUtils.waitForEvent(document, "popupshown", true, e => e.target.id == "whimsy-routine-sheet-schedule-list");
  EventUtils.synthesizeMouseAtCenter(token, {});
  await shown;
  const menu = document.getElementById("whimsy-routine-sheet-schedule-list");
  await document.l10n.translateFragment(menu);
  const pick = menu.querySelector("[data-value='pick']");
  ok(pick, "The menu ends with Pick days and time…");
  is(menu.querySelector("[aria-selected='true']")?.dataset.value, "1,2,3,4,5@8:0", "Weekdays at 8:00 AM is checked");
  await visible(pick, "Pick days and time… is still");
  EventUtils.synthesizeMouseAtCenter(pick, {});
  const editor = await TestUtils.waitForCondition(() => menu.querySelector(".whimsy-routine-schedule-editor"), "The menu turns into the editor in place");
  is(menu.state, "open", "The menu stays open");
  is(editor.querySelectorAll(".whimsy-routine-schedule-day[aria-pressed='true']").length, 5, "Weekdays are on");
  const done = editor.querySelector(".whimsy-routine-schedule-done");
  for (const day of [1, 2, 3, 4, 5]) {
    editor.querySelector(`[data-day='${day}']`).click();
  }
  ok(done.disabled, "No days, no Done");
  ok(!editor.querySelector(".whimsy-routine-schedule-hint").hidden, "It says to pick a day");
  editor.querySelector("[data-day='1']").click();
  editor.querySelector("[data-day='3']").click();
  editor.querySelector(".whimsy-routine-schedule-time").value = "18:30";
  editor.querySelector(".whimsy-routine-schedule-time").dispatchEvent(new Event("input"));
  ok(!done.disabled, "Days and a time: Done");
  const hidden = BrowserTestUtils.waitForPopupEvent(menu, "hidden");
  done.click();
  await hidden;
  const after = sheet.querySelector("[data-field='schedule']");
  await document.l10n.translateFragment(sheet);
  is(after.querySelector(".whimsy-surface-dropdown-value").getAttribute("data-l10n-id"), "whimsy-routine-form-schedule-token", "The token shows the new schedule");
  is(JSON.parse(after.querySelector(".whimsy-surface-dropdown-value").getAttribute("data-l10n-args")).days, "list", "Monday and Wednesday read as a list");
  ok(!after.classList.contains("is-filled"), "A touched token stays plain");
  const sheetHidden = BrowserTestUtils.waitForPopupEvent(sheet, "hidden");
  sheet.hidePopup();
  await sheetHidden;
  is((await WhimsyRoutines.list()).length, 0, "Nothing saved");
});

add_task(async function sheet_site_token() {
  await fresh();
  WhimsyRoutinesUI.openForm(window, { prefill: { prompt: "Show me what changed.", trigger: { kind: "open-site", host: "linear.app" } }, outlined: true });
  const sheet = await TestUtils.waitForCondition(() => document.getElementById("whimsy-routine-sheet")?.state == "open" && document.getElementById("whimsy-routine-sheet"), "The sheet opens");
  await document.l10n.translateFragment(sheet);
  const site = sheet.querySelector("[data-field='site']");
  ok(site, "The site is a token");
  is(site.querySelector(".whimsy-surface-dropdown-value").textContent, "linear.app", "It reads the site");
  ok(sheet.querySelector(".whimsy-routine-token.is-fixed"), "first visit each day follows it");
  is(sheet.querySelector(".whimsy-routine-form-note").getAttribute("data-l10n-id"), "whimsy-routine-form-note-site", "The note says private tabs never run it");
  const hidden = BrowserTestUtils.waitForPopupEvent(sheet, "hidden");
  sheet.hidePopup();
  await hidden;
});
