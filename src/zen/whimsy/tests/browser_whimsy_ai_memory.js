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
  const again = await WhimsyAIMemory.extract("thread-2", { userText: "I live in Austin, still", aiText: "ok" });
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
    ask("My cat Miso is a tabby");
    await TestUtils.waitForCondition(() => memoryAsks == 1, "Asked again");
    await chat.memoryNote;
    ok((await WhimsyAIMemory.list()).some(m => m.text == "Has a cat named Miso"), "Left open, the fact is saved");
    const note = await TestUtils.waitForCondition(() => document.querySelector("#whimsy-chat [data-kind='memory-saved']"),
      "...with its note line in the chat");
    const undo = note.querySelector(".whimsy-chat-link");
    ok(undo, "The note has Undo");
    undo.scrollIntoView({ block: "center" });
    const hit = () => {
      const r = undo.getBoundingClientRect();
      return document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    };
    await TestUtils.waitForCondition(() => undo.isConnected && hit() == undo, "Undo is on screen, nothing over it")
      .catch(e => info(`Undo hit test: ${hit()?.outerHTML?.slice(0, 160)} connected=${undo.isConnected}`) ?? Promise.reject(e));
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

// ---- W24 memory (owner 2026-11-10, item 8) ----
// Apple's on-device model answers the extraction prompt with one invented
// fact per category it names ("Name: Sam", "Places: none mentioned"), for
// any message at all. This stub does the same, so these tests see what the
// owner saw: "Saved 6 facts to memory" under every answer, in every tab.

const { WhimsyChatPanel } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyChatPanel.sys.mjs");
const { WhimsyAIContext } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyAIContext.sys.mjs");

const INVENTED = ["Name: Sam", "Role: Developer", "Preference: Coffee", "Ongoing projects: none mentioned", "People: Alex, Jamie", "Places: Berlin, Tokyo"];

function eagerProvider(requests, answer = request => `Answer to ${request.lastUserText}`) {
  return async request => {
    requests.push(request);
    if (request.task == "memory") {
      const said = /The person wrote: (.*)/s.exec(request.prompt)?.[1] ?? "";
      return JSON.stringify([...(/pilot/i.test(said) ? ["Is a pilot"] : []), ...(/Austin/.test(said) ? ["Lives in Austin"] : []), ...INVENTED]);
    }
    return answer(request);
  };
}

async function withChat(fn) {
  await WhimsyAIStore._resetForTesting(PathUtils.join(PathUtils.tempDir, "whimsy-w24-memory-" + Math.random().toString(16).slice(2)));
  await SpecialPowers.pushPrefEnv({ set: [[WhimsyAIMemory.USE_PREF, true], ["whimsy.feature.ai-hints", false]] });
  const chat = WhimsyChatPanel.forWindow(window);
  const tabs = [];
  const api = {
    chat,
    async open(url) {
      const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, url);
      tabs.push(tab);
      return tab;
    },
    async show() {
      if (!chat.isOpen) {
        EventUtils.synthesizeKey("e", { accelKey: true });
      }
      await TestUtils.waitForCondition(() => chat.isOpen && chat.ready, "Chat is open");
    },
    cards: () => [...chat.body.querySelectorAll("[data-kind='memory-saved']")],
    answers: () => [...chat.body.querySelectorAll(".whimsy-chat-msg[data-role='ai']")].filter(m => !m.hasAttribute("busy")),
    async ask(text) {
      const before = api.answers().length;
      chat.composer.focus();
      EventUtils.sendString(text);
      EventUtils.synthesizeKey("KEY_Enter");
      await TestUtils.waitForCondition(() => api.answers().length == before + 1, `"${text}" was answered`);
      // The background save is part of the answer: wait for it to settle.
      await chat.memoryNote;
      await chat.doc.l10n.translateFragment(chat.body);
      return api.answers().at(-1);
    },
  };
  try {
    await fn(api);
  } finally {
    if (chat.isOpen) {
      chat.close({ reason: "key" });
    }
    for (const tab of tabs) {
      BrowserTestUtils.removeTab(tab);
    }
    WhimsyAIProviders.setTestProvider(null);
    await clearAllMemories();
    await WhimsyAIStore._resetForTesting(null);
    await SpecialPowers.popPrefEnv();
  }
}

// 8a: the save card shows once, in the thread that saved, and only for
// facts that are new.
add_task(async function w24_save_card_only_in_the_saving_thread_for_new_facts() {
  const requests = [];
  WhimsyAIProviders.setTestProvider(eagerProvider(requests));
  await withChat(async ({ open, show, ask, cards, chat }) => {
    const a = await open("https://example.com/?memory-a");
    const b = await open("https://example.org/?memory-b");
    await BrowserTestUtils.switchTab(gBrowser, a);
    await show();
    await ask("I'm a pilot and I live in Austin");
    is(cards().length, 1, "Tab A: one save card under the answer");
    const savedTexts = (await WhimsyAIMemory.list()).map(m => m.text).sort();
    Assert.deepEqual(savedTexts, ["Is a pilot", "Lives in Austin"], "Only the facts the person said were saved, none of the invented ones");
    ok(/2 facts/.test(cards()[0].textContent), `The card counts the 2 new facts: "${cards()[0].textContent.trim()}"`);

    await BrowserTestUtils.switchTab(gBrowser, b);
    await TestUtils.waitForCondition(() => chat.ready && !chat.body.querySelector(".whimsy-chat-msg"), "Tab B shows its own chat");
    await ask("what's on this tab");
    is(cards().length, 0, "Tab B: a question about the page saves nothing and shows no card");

    await BrowserTestUtils.switchTab(gBrowser, a);
    await TestUtils.waitForCondition(() => chat.ready && chat.body.querySelectorAll(".whimsy-chat-msg[data-role='user']").length == 1, "Back on tab A");
    is(cards().length, 1, "Tab A still has just its one card");
    await ask("I live in Austin, as I said");
    is(cards().length, 1, "Saying a known fact again adds no second card");
    is((await WhimsyAIMemory.list()).length, 2, "...and saves no duplicate");
    const aThread = (await WhimsyAIStore.threads({ tabKey: WhimsyAIContext.tabKey(a) }))[0];
    const bThread = (await WhimsyAIStore.threads({ tabKey: WhimsyAIContext.tabKey(b) }))[0];
    is((await WhimsyAIStore.messages(aThread.id)).filter(m => m.kind == "memory-saved").length, 1, "A's thread stores one save note");
    is((await WhimsyAIStore.messages(bThread.id)).filter(m => m.kind == "memory-saved").length, 0, "B's thread stores none");

    // Undo still works on the one card.
    const undo = cards()[0].querySelector(".whimsy-chat-link");
    ok(undo, "The card has Undo");
    undo.scrollIntoView({ block: "center" });
    EventUtils.synthesizeMouseAtCenter(undo, {});
    await TestUtils.waitForCondition(async () => !(await WhimsyAIMemory.list()).length, "Undo deletes both facts");
  });
});

// 8b: questions about the page or the browser never produce facts, and
// don't even cost a model call.
add_task(async function w24_trivial_questions_save_nothing() {
  await clearAllMemories();
  const requests = [];
  WhimsyAIProviders.setTestProvider(eagerProvider(requests));
  try {
    for (const userText of ["what's on this tab", "what website am i on", "Tell me what's on this tab", "what did you just save to memory?", "what have you saved to memory", "summarize this page"]) {
      const saved = await WhimsyAIMemory.extract("thread-trivial", { userText, aiText: "Google" });
      Assert.deepEqual(saved.map(m => m.text), [], `"${userText}" saves nothing`);
    }
    is(requests.filter(r => r.task == "memory").length, 0, "...and never asks the model");
    const kept = await WhimsyAIMemory.extract("thread-trivial", { userText: "My name is Ada", aiText: "Hi Ada" });
    Assert.deepEqual(kept.map(m => m.text), [], "A message about yourself asks, but invented category facts are still dropped");
    is(requests.filter(r => r.task == "memory").length, 1, "(that one did ask)");
    is((await WhimsyAIMemory.list()).length, 0, "Nothing reached storage");
  } finally {
    WhimsyAIProviders.setTestProvider(null);
    await clearAllMemories();
  }
});

// 8c: the model is told what memory is, which memories it got, and what
// this conversation saved, so it can answer questions about memory.
add_task(async function w24_memory_question_prompt_lists_used_and_saved() {
  const requests = [];
  WhimsyAIProviders.setTestProvider(eagerProvider(requests));
  await withChat(async ({ open, show, ask }) => {
    await WhimsyAIMemory.save("Prefers dark mode");
    await open("https://example.com/?memory-c");
    await show();
    await ask("I'm a pilot");
    await ask("what did you just save to memory?");
    const sent = requests.filter(r => r.task == "chat").at(-1);
    ok(sent, "The memory question went to the model");
    info(sent.system.split("\n").filter(l => /memor|^- /i.test(l)).join(" | "));
    ok(/Whimsy has a memory/.test(sent.system), "The system prompt explains Whimsy's memory");
    const usedBlock = sent.system.split("Memories given to you for this answer")[1]?.split("Saved to memory earlier")[0] ?? "";
    ok(usedBlock.includes("- Prefers dark mode") && usedBlock.includes("- Is a pilot"), "...lists the memories it was given");
    const savedBlock = sent.system.split("Saved to memory earlier in this conversation")[1] ?? "";
    ok(savedBlock.includes("- Is a pilot"), "...and what this conversation saved");
    ok(!savedBlock.includes("Prefers dark mode"), "...which is only this conversation's");
    const answer = [...WhimsyChatPanel.forWindow(window).body.querySelectorAll(".whimsy-chat-msg[data-role='ai']")].at(-1);
    ok(answer.querySelector("[data-action='used-memories']"), "The answer shows which memories it used");
  });
});

// 8d: two different questions send two different user messages, and the
// second answer is never the first one reused. One-shot providers (Apple)
// get the new question set apart as the one to answer.
add_task(async function w24_two_questions_two_messages_no_reuse() {
  const requests = [];
  WhimsyAIProviders.setTestProvider(eagerProvider(requests, request => request.lastUserText == "what website am i on" ? "Google" : `About memory: ${request.lastUserText}`));
  await withChat(async ({ open, show, ask }) => {
    await open("https://example.com/?memory-d");
    await show();
    const first = await ask("what website am i on");
    const second = await ask("what have you saved to memory");
    const chats = requests.filter(r => r.task == "chat");
    is(chats.length, 2, "Two questions, two requests");
    is(chats[0].lastUserText, "what website am i on", "The first sends the first question");
    is(chats[1].lastUserText, "what have you saved to memory", "The second sends the second question");
    is(chats[1].messages.filter(m => m.role == "user").length, 2, "...with the first kept as history");
    ok(/The person's new message, the one to answer now:\nwhat have you saved to memory$/.test(chats[1].prompt),
      "A one-shot provider reads the new question last, marked as the one to answer");
    ok(chats[1].prompt.indexOf("Assistant: Google") < chats[1].prompt.indexOf("the one to answer now"), "...after the earlier answer");
    ok(first.textContent.includes("Google"), "The first answer");
    ok(second.textContent.includes("About memory: what have you saved to memory") && !second.textContent.includes("Google"),
      "The second answer is its own, not the first reused");
  });
});

// 8e: a tab whose text can't be read (a browser page) is still named, so
// "what's on this tab" isn't answered "nothing".
add_task(async function w24_browser_page_tab_is_named_in_the_prompt() {
  const requests = [];
  WhimsyAIProviders.setTestProvider(eagerProvider(requests));
  await withChat(async ({ open, show, ask }) => {
    const tab = await open("about:robots");
    await TestUtils.waitForCondition(() => tab.label && tab.label != "about:robots", "The page has its title");
    await show();
    await ask("tell me what's on this tab");
    const sent = requests.filter(r => r.task == "chat").at(-1);
    ok(sent.system.includes("Address: about:robots"), "The prompt names the tab's address");
    ok(sent.system.includes(`Page title: ${tab.label}`), `...and its title (${tab.label})`);
    ok(/can't read/.test(sent.system), "...and says its text can't be read");
  });
});
