/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// W10-26: New Note opens the Quick Note card: you write right away, it
// saves as you type, "This page" keeps it with the page (and stays kept),
// closing says "Note saved" with Open, and an empty card leaves nothing.

const { WhimsyNotes, gWhimsyNotesStore, QUICK_NOTE_SAVE_MS } = ChromeUtils.importESModule(
  "resource:///modules/whimsy/WhimsyNotesSection.sys.mjs"
);
const { WhimsyToast } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyToast.sys.mjs");
const { WhimsyPrivate } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyPrivate.sys.mjs");

add_setup(async function () {
  await SpecialPowers.pushPrefEnv({ set: [["browser.tabs.notes.enabled", true], ["whimsy.feature.notes", true]] });
});

async function notesNow() {
  return gWhimsyNotesStore.list();
}

async function openCard(opts) {
  const shown = BrowserTestUtils.waitForEvent(document, "popupshown", true, e => e.target.id == "whimsy-quick-note");
  const opening = opts ? WhimsyNotes.openQuickNote(window, opts) : document.getElementById("cmd_whimsyCreateNote").doCommand();
  await shown;
  await opening;
  return document.getElementById("whimsy-quick-note");
}

async function closeCard(panel, how = () => EventUtils.synthesizeKey("KEY_Escape")) {
  const gone = TestUtils.waitForCondition(() => !panel.isConnected, "The card is gone");
  how();
  await gone;
}

function type(el, text) {
  el.focus();
  EventUtils.sendString(text);
}

add_task(async function command_writes_a_note() {
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.com/quick-note");
  const before = (await notesNow()).length;
  const panel = await openCard();
  const body = panel.querySelector(".whimsy-quick-note-body");
  await TestUtils.waitForCondition(() => document.activeElement == body, "The keyboard is in the note");
  is((await notesNow()).length, before, "Nothing is stored before you type");
  type(body, "Buy milk");
  await TestUtils.waitForCondition(async () => (await notesNow()).length == before + 1, "One note, once typing settles");
  await new Promise(r => setTimeout(r, QUICK_NOTE_SAVE_MS + 100)); // eslint-disable-line mozilla/no-arbitrary-setTimeout
  type(body, ", eggs");
  await TestUtils.waitForCondition(async () => (await notesNow()).some(n => n.text == "Buy milk, eggs"), "Saved as you type");
  is((await notesNow()).length, before + 1, "Still exactly one note");
  ok(panel.querySelector(".whimsy-quick-note-attach").getAttribute("aria-checked") == "false", "Not kept with the page");

  await closeCard(panel);
  const toast = await TestUtils.waitForCondition(() => WhimsyToast.current(window), "A toast says so");
  is(toast._messageId, "whimsy-note-saved-toast", "Note saved");
  const note = (await notesNow()).find(n => n.text == "Buy milk, eggs");
  toast.querySelector(".whimsy-toast-action").click();
  const section = await TestUtils.waitForCondition(() => document.querySelector("whimsy-library-notes-section"), "Notes in the Library");
  await TestUtils.waitForCondition(() => section.editingId == note.id, "Open opens that note for editing");
  await gWhimsyNotesStore.remove(note.id);
  window.customElements.get("zen-library")?.close?.();
  BrowserTestUtils.removeTab(tab);
});

add_task(async function empty_card_leaves_nothing() {
  const before = (await notesNow()).length;
  const panel = await openCard({ attach: false });
  await closeCard(panel, () => panel.querySelector(".whimsy-quick-note-done").doCommand());
  is((await notesNow()).length, before, "An empty card stores nothing");
  const panel2 = await openCard({ attach: false });
  const body = panel2.querySelector(".whimsy-quick-note-body");
  type(body, "x");
  await TestUtils.waitForCondition(async () => (await notesNow()).length == before + 1, "Typing made one");
  body.value = "";
  body.dispatchEvent(new InputEvent("input", { bubbles: true }));
  await closeCard(panel2);
  await TestUtils.waitForCondition(async () => (await notesNow()).length == before, "Cleared again: removed silently");
});

add_task(async function page_menu_keeps_it_with_the_page() {
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.com/quick-note-page");
  const panel = await openCard({ attach: true });
  const chip = panel.querySelector(".whimsy-quick-note-attach");
  await TestUtils.waitForCondition(() => chip.getAttribute("aria-checked") == "true", "The chip is on");
  const note = (await notesNow()).find(n => n.pageAttached && n.url?.includes("quick-note-page"));
  ok(note, "Kept with the page before any typing");
  // Something written (an empty card leaves nothing, attached or not).
  type(panel.querySelector(".whimsy-quick-note-body"), "for later");
  await closeCard(panel, () => panel.querySelector(".whimsy-quick-note-done").doCommand());
  // The user's bug: leaving and coming back lost it.
  const other = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.org/");
  await BrowserTestUtils.switchTab(gBrowser, tab);
  const again = (await notesNow()).find(n => n.id == note.id);
  ok(again?.pageAttached, "Still kept with the page after switching tabs");
  await gWhimsyNotesStore.remove(note.id);
  BrowserTestUtils.removeTab(other);
  BrowserTestUtils.removeTab(tab);
});

add_task(async function page_without_canonical_url() {
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, "data:text/html,<p>no canonical</p>");
  const panel = await openCard({ attach: true });
  const chip = panel.querySelector(".whimsy-quick-note-attach");
  await TestUtils.waitForCondition(() => chip.getAttribute("aria-checked") == "true", "It attaches anyway");
  const note = (await notesNow()).find(n => n.pageAttached && n.url?.startsWith("data:"));
  ok(note, "by the address the page shows");
  await closeCard(panel);
  await gWhimsyNotesStore.remove(note.id);
  BrowserTestUtils.removeTab(tab);
});

add_task(async function private_page() {
  const tab = WhimsyPrivate.openPrivateTab(window, { url: "https://example.com/private-note", force: true });
  if (!tab) {
    ok(true, "No private tabs here");
    return;
  }
  await BrowserTestUtils.browserLoaded(tab.linkedBrowser);
  gBrowser.selectedTab = tab;
  const panel = await openCard({ attach: true });
  const chip = panel.querySelector(".whimsy-quick-note-attach");
  ok(chip.disabled, "Private: the chip can't be turned on");
  is(chip.getAttribute("aria-checked"), "false", "and isn't");
  type(panel.querySelector(".whimsy-quick-note-body"), "secret-free");
  await TestUtils.waitForCondition(async () => (await notesNow()).some(n => n.text == "secret-free"), "The note is kept");
  const note = (await notesNow()).find(n => n.text == "secret-free");
  is(note.url, null, "without the private page's address");
  await closeCard(panel);
  await gWhimsyNotesStore.remove(note.id);
  BrowserTestUtils.removeTab(tab);
});

add_task(async function open_notes_command() {
  ok(document.getElementById("cmd_whimsyOpenNotes"), "Open Notes is a command (it can take a shortcut)");
});

// The Library: typing then clicking elsewhere (no change event first) keeps
// what was typed.
add_task(async function library_saves_as_you_type() {
  const note = await gWhimsyNotesStore.create({ title: "Draft", text: "" });
  ok(WhimsyNotes.openInLibrary(window, note.id), "The Library opens on Notes");
  const section = await TestUtils.waitForCondition(() => document.querySelector("whimsy-library-notes-section"));
  await TestUtils.waitForCondition(() => section.editingId == note.id, "on that note");
  const textarea = await TestUtils.waitForCondition(() => section.querySelector(".whimsy-note-editor textarea"));
  textarea.focus();
  textarea.value = "typed in the library";
  textarea.dispatchEvent(new InputEvent("input", { bubbles: true }));
  await TestUtils.waitForCondition(
    async () => (await notesNow()).find(n => n.id == note.id)?.text == "typed in the library",
    "Saved without leaving the field"
  );
  await gWhimsyNotesStore.remove(note.id);
  window.customElements.get("zen-library")?.close?.();
});
