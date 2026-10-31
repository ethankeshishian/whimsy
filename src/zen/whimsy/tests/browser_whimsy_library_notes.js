/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// Notes: a markdown scratchpad in the Library sidebar (whimsy.feature.notes).
// Free notes persist in Whimsy's own store; a note can optionally attach to
// the current page, in which case its text also lives in Firefox's TabNotes
// storage, keyed by canonical URL.

const { gWhimsyNotesStore } = ChromeUtils.importESModule(
  "resource:///modules/whimsy/WhimsyNotesSection.sys.mjs"
);
const { TabNotes } = ChromeUtils.importESModule(
  "moz-src:///browser/components/tabnotes/TabNotes.sys.mjs"
);

function getLibrary() {
  return window.document.querySelector("zen-library");
}

async function cleanupNote(id) {
  await gWhimsyNotesStore.remove(id);
}

add_setup(async function () {
  await SpecialPowers.pushPrefEnv({ set: [["browser.tabs.notes.enabled", true]] });
});

async function openNoteTab() {
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.com/");
  registerCleanupFunction(() => BrowserTestUtils.removeTab(tab));
  await TestUtils.waitForCondition(() => TabNotes.isEligible(tab), "Canonical URL is ready for TabNotes");
  return tab;
}

add_task(async function test_create_update_delete() {
  const note = await gWhimsyNotesStore.create();
  registerCleanupFunction(() => cleanupNote(note.id));

  let list = await gWhimsyNotesStore.list();
  ok(
    list.some(n => n.id == note.id),
    "A freshly created note shows up in the list"
  );
  is(note.pageAttached, false, "A new note starts unattached");

  await gWhimsyNotesStore.update(note.id, { text: "- buy milk", title: "Errands" });
  list = await gWhimsyNotesStore.list();
  const updated = list.find(n => n.id == note.id);
  is(updated.text, "- buy milk", "Text persists");
  is(updated.title, "Errands", "Title persists");

  await gWhimsyNotesStore.remove(note.id);
  list = await gWhimsyNotesStore.list();
  ok(!list.some(n => n.id == note.id), "A deleted note is gone from the list");
});

add_task(async function test_page_attached_note_uses_tab_notes() {
  const tab = await openNoteTab();

  const note = await gWhimsyNotesStore.create();
  registerCleanupFunction(() => cleanupNote(note.id));
  await gWhimsyNotesStore.update(note.id, { text: "page notes", pageAttached: true, url: tab.canonicalUrl });
  await TabNotes.set(tab, "page notes");

  const stored = await TabNotes.get(tab);
  is(stored?.text, "page notes", "The page-attached text lives in TabNotes, keyed by the page's URL");

  await TabNotes.delete(tab);
});

add_task(async function test_switch_off_removes_the_tab() {
  const lib = getLibrary();
  if (!lib) {
    ok(true, "No <zen-library> in this window; nothing to check");
    return;
  }
  // The feature is on by default; the hook should already have added it.
  ok("whimsy-notes" in lib.zenLibrarySections, "Notes is in the Library rail by default");

  Services.prefs.setBoolPref("whimsy.feature.notes", false);
  registerCleanupFunction(() => Services.prefs.clearUserPref("whimsy.feature.notes"));
  await TestUtils.waitForCondition(
    () => !("whimsy-notes" in lib.zenLibrarySections),
    "Turning the switch off removes the tab without reopening the window"
  );

  Services.prefs.setBoolPref("whimsy.feature.notes", true);
  await TestUtils.waitForCondition(() => "whimsy-notes" in lib.zenLibrarySections, "Turning it back on restores the tab");
});

add_task(async function test_empty_text_does_not_throw_tab_notes() {
  const tab = await openNoteTab();
  // TabNotes.set throws RangeError on an empty string; the section guards
  // against that so clearing an attached note's text can't crash the UI.
  await TabNotes.set(tab, " ");
  const stored = await TabNotes.get(tab);
  ok(stored, "Setting whitespace, not empty, keeps TabNotes.set from throwing");
  await TabNotes.delete(tab);
});

// W8-49: Notes are strictly partitioned per profile.
add_task(async function test_w8_49_notes_per_profile() {
  const noteDef = await gWhimsyNotesStore.create({ profileKey: "default", title: "Default Note" });
  const noteWork = await gWhimsyNotesStore.create({ profileKey: "work-profile", title: "Work Note" });
  registerCleanupFunction(async () => {
    await gWhimsyNotesStore.remove(noteDef.id);
    await gWhimsyNotesStore.remove(noteWork.id);
  });

  const defNotes = await gWhimsyNotesStore.list("default");
  ok(defNotes.some(n => n.id == noteDef.id), "Default profile sees default note");
  ok(!defNotes.some(n => n.id == noteWork.id), "Default profile does not see work note");

  const workNotes = await gWhimsyNotesStore.list("work-profile");
  ok(workNotes.some(n => n.id == noteWork.id), "Work profile sees work note");
  ok(!workNotes.some(n => n.id == noteDef.id), "Work profile does not see default note");

  // Deleting a profile cleans up its notes
  await gWhimsyNotesStore.removeForProfile("work-profile");
  const postDelete = await gWhimsyNotesStore.list("work-profile");
  is(postDelete.length, 0, "Deleting profile cleans up its notes");
});
