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
  Services.prefs.clearUserPref(WhimsyAIMemory.USE_PREF);
  await clearAllMemories();
});

add_setup(async () => {
  await clearAllMemories();
});

add_task(async function auto_save_note_line_undo_blocks() {
  WhimsyAIProviders.setTestProvider(({ task }) => task == "memory" ? JSON.stringify(["Lives in Austin"]) : "");
  const saved = await WhimsyAIMemory.extract("thread-1", { userText: "I live in Austin", aiText: "Got it." });
  is(saved.length, 1, "One fact extracted and saved");
  is(saved[0].text, "Lives in Austin", "The fact's text");
  is(saved[0].source, "thread-1", "Its source is the thread it came from");
  const listed = await WhimsyAIMemory.list();
  ok(listed.some(m => m.id == saved[0].id), "It shows up in the list");

  // The note line a chat panel renders (WhimsyChat.registerCard).
  const render = WhimsyChat.cardRenderer("note:memory-saved");
  ok(render, "The memory-saved card is registered");
  const msg = { role: "ai", facts: saved.map(m => m.text), memoryIds: saved.map(m => m.id) };
  const node = render(document, msg, { thread: { id: "thread-1" } });
  is(node.dataset.kind, "memory-saved", "The note is a memory-saved card");
  document.documentElement.append(node);
  try {
    const undo = node.querySelector(".whimsy-chat-link");
    ok(undo, "It has an Undo link");
    undo.click();
    await TestUtils.waitForCondition(async () => !(await WhimsyAIMemory.get(saved[0].id)), "Undo deletes the fact");
  } finally {
    node.remove();
  }

  // Undo blocks the exact fact text (case/whitespace aside) from being
  // saved again, even from an unrelated exchange.
  const again = await WhimsyAIMemory.extract("thread-2", { userText: "unrelated", aiText: "ok" });
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
