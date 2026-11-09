/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// Memory: stable facts about you, saved automatically after a chat answer
// (task "memory", Apple-first) with a note line and Undo; Undo deletes the
// fact and blocks its text from being saved again. One switch pauses both
// saving and using at once. Never for a private tab. Settings › AI › Memory
// (list, edit in place, delete with Undo, Export Markdown) is covered by
// browser_whimsy_ai_settings.js's shared harness; this file owns
// WhimsyAIMemory itself.

const { WhimsyAIMemory } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyAIMemory.sys.mjs");
const { WhimsyAIProviders } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyAIProviders.sys.mjs");
const { WhimsyAIStore } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyAIStore.sys.mjs");
const { WhimsyChat } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyChat.sys.mjs");

async function clearAllMemories() {
  for (const m of await WhimsyAIMemory.list()) {
    await WhimsyAIMemory.remove(m.id, { block: false });
  }
  await WhimsyAIStore.clear({ kinds: ["memory"] });
}

registerCleanupFunction(async () => {
  WhimsyAIProviders.setTestProvider(null);
  await clearAllMemories();
});

add_setup(async () => {
  // browser.toml's [DEFAULT] keeps memory off so other features' tests
  // never see its extra "memory" provider call; this file owns it.
  await SpecialPowers.pushPrefEnv({ set: [[WhimsyAIMemory.USE_PREF, true]] });
  await clearAllMemories();
});

add_task(async function remove_with_block_blocks_before_delete() {
  const saved = await WhimsyAIMemory.save("Has a dog named Rex");
  ok(saved, "Saved");
  const removing = WhimsyAIMemory.remove(saved.id, { block: true });
  // The moment the fact's file is gone, its text must already be blocked.
  await TestUtils.waitForCondition(async () => !(await WhimsyAIMemory.get(saved.id)), "Deleted");
  const blocked = await WhimsyAIStore.readDoc("memory-blocked", []);
  info(`blocked list when the file disappeared: ${JSON.stringify(blocked)}`);
  ok(blocked.some(b => b.fact == "has a dog named rex"), "Blocked by the time it's deleted");
  await removing;
  is(await WhimsyAIMemory.save("has a  dog named REX"), null, "Saving it again is refused");
});

add_task(async function auto_save_note_line_undo_blocks() {
  WhimsyAIProviders.setTestProvider(({ task }) => task == "memory" ? JSON.stringify(["Lives in Austin"]) : "");
  const saved = await WhimsyAIMemory.extract("thread-1", { userText: "I live in Austin", aiText: "Got it." });
  is(saved.length, 1, "One fact extracted and saved");
  is(saved[0].text, "Lives in Austin", "The fact's text");
  is(saved[0].source, "thread-1", "Its source is the thread it came from");
  const listed = await WhimsyAIMemory.list();
  ok(listed.some(m => m.id == saved[0].id), "It shows up in the list");

  // The note line a chat panel renders (WhimsyChat.registerCard); pressing
  // its Undo for real is panel_tracks_and_cancels_memory_note's job.
  const render = WhimsyChat.cardRenderer("note:memory-saved");
  ok(render, "The memory-saved card is registered");
  const msg = { role: "ai", facts: saved.map(m => m.text), memoryIds: saved.map(m => m.id) };
  const node = render(document, msg, { thread: { id: "thread-1" } });
  is(node.dataset.kind, "memory-saved", "The note is a memory-saved card");
  ok(node.querySelector(".whimsy-chat-link"), "It has an Undo link");
  await WhimsyAIMemory._undoFromNote({ id: "thread-1" }, msg, node);
  ok(!(await WhimsyAIMemory.get(saved[0].id)), "Undo deletes the fact");
  ok(!node.querySelector(".whimsy-chat-link"), "...and the link goes");
  info(`blocked list after Undo: ${JSON.stringify(await WhimsyAIStore.readDoc("memory-blocked", []))}`);

  // Undo blocks the exact fact text (case/whitespace aside) from being
  // saved again, even from an unrelated exchange.
  const again = await WhimsyAIMemory.extract("thread-2", { userText: "unrelated", aiText: "ok" });
  info(`re-extract saved: ${JSON.stringify(again.map(m => m.text))}`);
  is(again.length, 0, "The blocked fact isn't saved again");
  is((await WhimsyAIMemory.save("Lives in Austin")), null, "...and a direct save() of the same text is blocked too");
});

add_task(async function used_n_memories_list() {
  const a = await WhimsyAIMemory.save("Prefers dark mode");
  const b = await WhimsyAIMemory.save("Works at Acme");
  const forPrompt = await WhimsyAIMemory.forPrompt("Does dark mode work at Acme?");
  ok(forPrompt.some(m => m.id == a.id) && forPrompt.some(m => m.id == b.id),
    "forPrompt returns memories matching the text");

  const action = WhimsyChat.answerActions({ role: "ai", usedMemories: [{ id: a.id, text: a.text }] })
    .find(x => x.id == "used-memories");
  ok(action, "The 'Used N memories' answer action is registered and available when a message used any");
  is(action.l10nArgs({ usedMemories: [{ id: a.id }, { id: b.id }] }).count, 2, "It counts how many");
  ok(!WhimsyChat.answerActions({ role: "ai", usedMemories: [] }).find(x => x.id == "used-memories"),
    "...and absent when none were used");
});

add_task(async function switch_off_keeps_but_unused() {
  const kept = await WhimsyAIMemory.save("A fact to keep");
  Services.prefs.setBoolPref(WhimsyAIMemory.USE_PREF, false);
  try {
    ok(!WhimsyAIMemory.on, "The switch off turns off both halves");
    is((await WhimsyAIMemory.forPrompt("keep")).length, 0, "Off: nothing is used in a prompt");
    is((await WhimsyAIMemory.list()).some(m => m.id == kept.id), true, "...but it's still kept");
    WhimsyAIProviders.setTestProvider(() => JSON.stringify(["A brand new fact"]));
    const saved = await WhimsyAIMemory.extract("thread-off", { userText: "hi", aiText: "hi" });
    is(saved.length, 0, "Off: nothing new is saved either");
  } finally {
    Services.prefs.setBoolPref(WhimsyAIMemory.USE_PREF, true);
  }
});

add_task(async function never_from_private() {
  WhimsyAIProviders.setTestProvider(() => JSON.stringify(["Should never be saved"]));
  const saved = await WhimsyAIMemory.extract("thread-private", { userText: "secret", aiText: "ok" }, { isPrivate: true });
  is(saved.length, 0, "extract() refuses a private exchange outright, without asking the model");
  is((await WhimsyAIMemory.list()).some(m => m.text == "Should never be saved"), false,
    "Nothing from it ever reached storage");
});

// The chat panel's background memory save is tracked (one at a time,
// awaitable through memoryNote) and cancelled when the panel closes, so
// it never asks the provider or saves anything after you've left.
add_task(async function panel_tracks_and_cancels_memory_note() {
  const { WhimsyChatPanel } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyChatPanel.sys.mjs");
  await clearAllMemories();
  let memoryAsks = 0;
  let release;
  let held = new Promise(r => (release = r));
  WhimsyAIProviders.setTestProvider(async request => {
    if (request.task == "memory") {
      memoryAsks++;
      await held;
      return JSON.stringify(["Has a cat named Miso"]);
    }
    return "Cats are great.";
  });
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.com/");
  const chat = WhimsyChatPanel.forWindow(window);
  const openChat = async () => {
    if (!chat.isOpen) {
      EventUtils.synthesizeKey("e", { accelKey: true });
    }
    await TestUtils.waitForCondition(() => chat.isOpen && chat.ready, "Chat is open");
  };
  const ask = text => {
    chat.composer.focus();
    EventUtils.sendString(text);
    EventUtils.synthesizeKey("KEY_Enter");
  };
  try {
    await openChat();
    ask("I have a cat named Miso");
    await TestUtils.waitForCondition(() => memoryAsks == 1, "The answer starts a background memory save");
    const pending = chat.memoryNote;
    chat.close({ reason: "key" });
    release();
    await pending;
    is((await WhimsyAIMemory.list()).length, 0, "Closing the panel cancelled it: nothing saved");

    memoryAsks = 0;
    held = Promise.resolve();
    await openChat();
    ask("Miso is a tabby");
    await TestUtils.waitForCondition(() => memoryAsks == 1, "Asked again");
    await chat.memoryNote;
    ok((await WhimsyAIMemory.list()).some(m => m.text == "Has a cat named Miso"), "Left open, the fact is saved");
    const note = await TestUtils.waitForCondition(() => document.querySelector("#whimsy-chat [data-kind='memory-saved']"),
      "...with its note line in the chat");
    const undo = note.querySelector(".whimsy-chat-link");
    ok(undo, "The note has Undo");
    EventUtils.synthesizeMouseAtCenter(undo, {});
    await TestUtils.waitForCondition(async () => !(await WhimsyAIMemory.list()).length, "Undo in the chat deletes it");
    await TestUtils.waitForCondition(() => !note.querySelector(".whimsy-chat-link"), "...and the Undo link goes");
    is(await WhimsyAIMemory.save("Has a cat named Miso"), null, "...and blocks it from coming back");
  } finally {
    if (chat.isOpen) {
      chat.close({ reason: "key" });
    }
    BrowserTestUtils.removeTab(tab);
    WhimsyAIProviders.setTestProvider(null);
    await clearAllMemories();
  }
});
