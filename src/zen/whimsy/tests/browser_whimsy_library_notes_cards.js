/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// W13 notes (option C, wave13/design/notes-sidebar): notes stay in the
// Library and look like notes. Driven with real clicks, hovers and keys:
// - the Notes tab gets a count badge while the page in front has notes;
// - each note is a two-line card (title, next line, page chip, how long
//   ago) with Edit and Delete on hover;
// - an open note is the F09 A card: title, note, page chip, Done; Return
//   in the title goes to the note; Esc and Done close it; an empty note
//   isn't kept;
// - no notes: the sprite, No notes yet, New Note and a hint.

const { gWhimsyNotesStore, NOTE_COUNT_ATTR } = ChromeUtils.importESModule(
  "resource:///modules/whimsy/WhimsyNotesSection.sys.mjs"
);
const { TabNotes } = ChromeUtils.importESModule("moz-src:///browser/components/tabnotes/TabNotes.sys.mjs");

const library = () => document.querySelector("zen-library");
const notesTab = () => library()?.querySelector('.zen-library-tab[data-section="whimsy-notes"]');
const section = () => document.querySelector("whimsy-library-notes-section");
const stored = async id => (await gWhimsyNotesStore.list()).find(n => n.id == id);
const cardFor = id => section()?.querySelector(`.whimsy-note-item[data-note-id="${CSS.escape(id)}"] .whimsy-note-card`);
const editorFor = id => section()?.querySelector(`.whimsy-note-item[data-note-id="${CSS.escape(id)}"] .whimsy-note-open`);
const frames = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));

add_setup(async function () {
  await SpecialPowers.pushPrefEnv({ set: [["browser.tabs.notes.enabled", true]] });
  // Start from no notes; put back whatever the profile had.
  const before = await gWhimsyNotesStore.list();
  for (const note of before) {
    await gWhimsyNotesStore.remove(note.id);
  }
  const wasOpen = library()?.constructor.isLibraryOpen;
  registerCleanupFunction(async () => {
    for (const note of await gWhimsyNotesStore.list()) {
      await gWhimsyNotesStore.remove(note.id);
    }
    for (const note of before) {
      await gWhimsyNotesStore.restore(note);
    }
    await library()?.constructor.animateProgress(wasOpen ? 1 : 0);
  });
});

async function openPage(tag) {
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, `https://example.com/?${tag}`);
  registerCleanupFunction(() => tab.isConnected && BrowserTestUtils.removeTab(tab));
  await TestUtils.waitForCondition(() => TabNotes.isEligible(tab), "The page can keep notes");
  return tab;
}

const pageURL = tab => tab.canonicalUrl ?? tab.linkedBrowser.currentURI.spec;

// Notes in the Library, opened the way the user does: Open Notes.
async function openNotes() {
  document.getElementById("cmd_whimsyOpenNotes").doCommand();
  await TestUtils.waitForCondition(() => library()?.constructor.isLibraryOpen && library().activeTab == "whimsy-notes",
    "The Library is open on Notes");
  // It slides in on a spring; a click before it settles lands beside the
  // button it aimed at.
  await TestUtils.waitForCondition(() => library().openProgress == 1 && !library().hasAttribute("transitioning"),
    "...and has finished sliding in");
  const el = await TestUtils.waitForCondition(section, "The Notes section");
  await el.updateComplete;
  await frames();
  return el;
}

add_task(async function test_rail_badge_follows_the_page() {
  const tab = await openPage("notes-badge");
  const other = await openPage("notes-badge-other");
  gBrowser.selectedTab = tab;
  const lib = library();
  lib.activeTab = "history";
  await lib.constructor.animateProgress(1);
  const railTab = await TestUtils.waitForCondition(notesTab, "The Notes tab is on the rail");
  ok(!railTab.hasAttribute(NOTE_COUNT_ATTR), "No badge while the page has no notes");

  const first = await gWhimsyNotesStore.create({ title: "Kept here", pageAttached: true, url: pageURL(tab) });
  await TestUtils.waitForCondition(() => notesTab().getAttribute(NOTE_COUNT_ATTR) == "1", "A note for this page: 1");
  const badge = getComputedStyle(notesTab(), "::after");
  is(badge.position, "absolute", "The badge sits on the tab's corner");
  is(badge.height, "15px", "...15px high");
  isnot(badge.backgroundColor, "rgba(0, 0, 0, 0)", "...filled");
  is(notesTab().getAttribute("aria-description"), "One note for this page", "...and said in words");
  await gWhimsyNotesStore.create({ title: "Not kept here" });
  const second = await gWhimsyNotesStore.create({ title: "Also here", pageAttached: true, url: pageURL(tab) });
  await TestUtils.waitForCondition(() => notesTab().getAttribute(NOTE_COUNT_ATTR) == "2", "Two notes for this page: 2");

  gBrowser.selectedTab = other;
  await TestUtils.waitForCondition(() => !notesTab().hasAttribute(NOTE_COUNT_ATTR), "Another page: no badge");
  ok(!notesTab().hasAttribute("aria-description"), "...nor its words");
  gBrowser.selectedTab = tab;
  await TestUtils.waitForCondition(() => notesTab().getAttribute(NOTE_COUNT_ATTR) == "2", "Back: the badge returns");

  // Choosing Notes redraws the rail; the badge stays.
  lib.activeTab = "whimsy-notes";
  await TestUtils.waitForCondition(() => notesTab()?.hasAttribute("active"), "Notes chosen");
  is(notesTab().getAttribute(NOTE_COUNT_ATTR), "2", "The badge stays on the chosen tab");

  await gWhimsyNotesStore.remove(first.id);
  await gWhimsyNotesStore.remove(second.id);
  await TestUtils.waitForCondition(() => !notesTab().hasAttribute(NOTE_COUNT_ATTR), "No notes left for it: no badge");
  for (const note of await gWhimsyNotesStore.list()) {
    await gWhimsyNotesStore.remove(note.id);
  }
});

add_task(async function test_empty_state_and_new_note() {
  await openPage("notes-empty");
  is((await gWhimsyNotesStore.list()).length, 0, "No notes");
  const el = await openNotes();
  const empty = await TestUtils.waitForCondition(() => el.querySelector(".whimsy-notes-empty"), "The empty state");
  await document.l10n.translateFragment(empty);
  ok(getComputedStyle(empty.querySelector(".empty-state-icon-image")).backgroundImage.includes("library-notes-sprite"),
    "The notes sprite");
  is(empty.querySelector(".whimsy-notes-empty-title").textContent, "No notes yet", "No notes yet");
  const newNote = empty.querySelector(".whimsy-notes-empty-new");
  is(newNote.textContent, "New Note", "A New Note button");
  ok(empty.querySelector(".whimsy-notes-empty-hint").textContent.includes("New Note"), "...and a hint");
  ok(!el.querySelector(".zen-library-filter-button"), "No second New note button in the footer");

  // New Note: the card opens with the cursor in the title (F09).
  EventUtils.synthesizeMouseAtCenter(newNote, {}, window);
  const editor = await TestUtils.waitForCondition(() => el.querySelector(".whimsy-note-open"), "The note card opens");
  const title = editor.querySelector(".whimsy-note-open-title");
  await TestUtils.waitForCondition(() => document.activeElement == title, "The cursor is in the title");
  // Done on an empty note: nothing is kept.
  EventUtils.synthesizeMouseAtCenter(editor.querySelector(".whimsy-note-done"), {}, window);
  await TestUtils.waitForCondition(async () => !(await gWhimsyNotesStore.list()).length, "An empty note isn't kept");
  await TestUtils.waitForCondition(() => el.querySelector(".whimsy-notes-empty"), "...the empty state is back");

  // New Note, a title, Return, the note, Done.
  EventUtils.synthesizeMouseAtCenter(el.querySelector(".whimsy-notes-empty-new"), {}, window);
  const again = await TestUtils.waitForCondition(() => el.querySelector(".whimsy-note-open"), "The card opens again");
  await TestUtils.waitForCondition(() => document.activeElement == again.querySelector(".whimsy-note-open-title"), "In the title");
  EventUtils.sendString("Groceries", window);
  EventUtils.synthesizeKey("KEY_Enter", {}, window);
  is(document.activeElement, again.querySelector("textarea"), "Return goes to the note");
  EventUtils.sendString("oat milk", window);
  EventUtils.synthesizeKey("KEY_Enter", {}, window);
  EventUtils.sendString("limes", window);
  EventUtils.synthesizeMouseAtCenter(again.querySelector(".whimsy-note-done"), {}, window);
  const note = await TestUtils.waitForCondition(async () => {
    const [n] = await gWhimsyNotesStore.list();
    return n?.title == "Groceries" && n.text == "oat milk\nlimes" && n;
  }, "Done keeps what was typed");
  const card = await TestUtils.waitForCondition(() => cardFor(note.id), "...and shows it as a card");
  is(card.querySelector(".whimsy-note-card-title").textContent, "Groceries", "The card's title");
  is(card.querySelector(".whimsy-note-card-line").textContent, "oat milk", "...and the note's first line");
  ok(el.querySelector(".zen-library-filter-button"), "With notes, the footer's New note is back");
  await gWhimsyNotesStore.remove(note.id);
});

add_task(async function test_cards_and_the_open_card() {
  const tab = await openPage("notes-cards");
  const url = pageURL(tab);
  const here = await gWhimsyNotesStore.create({
    title: "Arc notes review",
    text: "Pinned by default\nTitle first",
    pageAttached: true,
    url,
  });
  const free = await gWhimsyNotesStore.create({ text: "Trip plan\nLisbon, 12–16 Dec" });
  const el = await openNotes();

  // Two-line cards.
  const hereCard = await TestUtils.waitForCondition(() => cardFor(here.id), "The page's note has a card");
  await document.l10n.translateFragment(el);
  is(hereCard.querySelector(".whimsy-note-card-title").textContent, "Arc notes review", "The title");
  is(hereCard.querySelector(".whimsy-note-card-line").textContent, "Pinned by default", "...then the note's first line");
  is(getComputedStyle(hereCard.querySelector(".whimsy-note-card-title")).fontWeight, "600", "The title is semibold");
  const chip = hereCard.querySelector(".whimsy-note-chip");
  ok(chip, "A page chip");
  is(chip.querySelector("img").getAttribute("src"), `page-icon:${url}`, "...with the page's favicon");
  is(chip.querySelector(".whimsy-note-chip-label").textContent, tab.label, "...and its title (it's the page in front)");
  is(hereCard.querySelector(".whimsy-note-card-age").textContent, "Now", "How long ago: Now");
  const freeCard = cardFor(free.id);
  is(freeCard.querySelector(".whimsy-note-card-title").textContent, "Trip plan", "Untitled: the first line is the title");
  is(freeCard.querySelector(".whimsy-note-card-line").textContent, "Lisbon, 12–16 Dec", "...and the second the line");
  ok(!freeCard.querySelector(".whimsy-note-chip"), "No chip without a page");
  ok(el.querySelector(".whimsy-notes-this-page"), "Notes for this page come first, under This page");

  // Edit and Delete show on hover.
  const actions = hereCard.querySelector(".whimsy-note-card-actions");
  EventUtils.synthesizeMouseAtCenter(gBrowser.selectedBrowser, { type: "mousemove" }, window);
  await TestUtils.waitForCondition(() => getComputedStyle(actions).opacity == "0", "Edit and Delete hide at rest");
  EventUtils.synthesizeMouseAtCenter(hereCard.querySelector(".whimsy-note-card-title"), { type: "mousemove" }, window);
  await TestUtils.waitForCondition(() => getComputedStyle(actions).opacity == "1", "...and show on hover");
  is(getComputedStyle(actions.querySelector(".whimsy-note-card-edit")).width, "20px", "20px buttons");

  // Edit: the F09 A card in place of the row, the cursor at the note's end.
  EventUtils.synthesizeMouseAtCenter(actions.querySelector(".whimsy-note-card-edit"), {}, window);
  const editor = await TestUtils.waitForCondition(() => editorFor(here.id), "Edit opens the note's card");
  ok(!cardFor(here.id), "...in place of its row");
  is(editor.querySelector(".whimsy-note-open-title").value, "Arc notes review", "Title first");
  is(getComputedStyle(editor.querySelector(".whimsy-note-open-title")).fontWeight, "600", "...semibold");
  const body = editor.querySelector("textarea");
  is(body.value, "Pinned by default\nTitle first", "Then the note");
  await TestUtils.waitForCondition(() => document.activeElement == body, "The cursor is in the note");
  is(body.selectionStart, body.value.length, "...at its end");
  const footer = editor.querySelector(".whimsy-note-open-footer");
  ok(footer.querySelector(".whimsy-note-chip"), "The page chip in the footer");
  ok(footer.querySelector(".whimsy-note-done"), "...and Done");
  is(getComputedStyle(editor).borderTopLeftRadius, "12px", "A 12px card");

  // Typing saves as you go.
  EventUtils.sendString(" and drafts", window);
  await TestUtils.waitForCondition(async () => (await stored(here.id))?.text.endsWith("Title first and drafts"), "Typing saves");

  // The chip's ✕ lets go of the page; the + chip keeps it again.
  EventUtils.synthesizeMouseAtCenter(footer.querySelector(".whimsy-note-chip-remove"), {}, window);
  await TestUtils.waitForCondition(async () => !(await stored(here.id))?.pageAttached, "✕ lets go of the page");
  const add = await TestUtils.waitForCondition(() => editorFor(here.id)?.querySelector(".whimsy-note-chip-add"),
    "A chip to keep it with this page again");
  EventUtils.synthesizeMouseAtCenter(add, {}, window);
  await TestUtils.waitForCondition(async () => (await stored(here.id))?.pageAttached, "...which keeps it");

  // Done closes it back to a card.
  EventUtils.synthesizeMouseAtCenter(editorFor(here.id).querySelector(".whimsy-note-done"), {}, window);
  await TestUtils.waitForCondition(() => cardFor(here.id) && !editorFor(here.id), "Done: a card again");

  // A click on a card opens it; with no title the cursor goes there.
  EventUtils.synthesizeMouseAtCenter(cardFor(free.id).querySelector(".whimsy-note-card-line"), {}, window);
  const freeEditor = await TestUtils.waitForCondition(() => editorFor(free.id), "A click on a card opens it");
  const freeTitle = freeEditor.querySelector(".whimsy-note-open-title");
  await TestUtils.waitForCondition(() => document.activeElement == freeTitle, "No title yet: the cursor is there");
  EventUtils.sendString("Lisbon", window);
  // Esc closes the note, not the Library.
  EventUtils.synthesizeKey("KEY_Escape", {}, window);
  await TestUtils.waitForCondition(() => cardFor(free.id) && !editorFor(free.id), "Esc closes the note");
  ok(library().constructor.isLibraryOpen, "...and the Library stays open");
  await TestUtils.waitForCondition(async () => (await stored(free.id))?.title == "Lisbon", "...keeping its title");

  // Delete on hover.
  const freeCard2 = cardFor(free.id);
  EventUtils.synthesizeMouseAtCenter(freeCard2.querySelector(".whimsy-note-card-title"), { type: "mousemove" }, window);
  const trash = freeCard2.querySelector(".whimsy-note-card-delete");
  await TestUtils.waitForCondition(() => getComputedStyle(trash.parentNode).opacity == "1", "Delete shows on hover");
  EventUtils.synthesizeMouseAtCenter(trash, {}, window);
  await TestUtils.waitForCondition(async () => !(await stored(free.id)), "Delete removes it");

  await gWhimsyNotesStore.remove(here.id);
  try {
    await TabNotes.delete(tab);
  } catch (e) {}
});
