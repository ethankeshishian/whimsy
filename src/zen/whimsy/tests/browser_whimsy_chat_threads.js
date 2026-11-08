/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// W23 chat-shell: per-tab chats, the conversation list (this tab, then
// routines, then by date; local search), a thread that outlives its tab,
// the private wall, and the Tasks strip.

const { WhimsyChatPanel } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyChatPanel.sys.mjs");
const { WhimsyChatThreads } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyChatThreads.sys.mjs");
const { WhimsyChat } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyChat.sys.mjs");
const { WhimsyAIProviders } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyAIProviders.sys.mjs");
const { WhimsyAIStore } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyAIStore.sys.mjs");
const { WhimsyAIContext } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyAIContext.sys.mjs");
const { WhimsyPrivate } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyPrivate.sys.mjs");

const PAGE_A = "https://example.com/?a";
const PAGE_B = "https://example.org/?b";

const chat = () => WhimsyChatPanel.forWindow(window);
const el = () => document.getElementById("whimsy-chat");
const part = sel => el().querySelector(sel);
const parts = sel => [...el().querySelectorAll(sel)];

let calls = [];

async function settle() {
  await TestUtils.waitForCondition(
    () => el().getAnimations({ subtree: true }).every(a => a.playState != "running"),
    "The panel's motion has finished"
  );
}

async function freshStore() {
  await WhimsyAIStore._resetForTesting(PathUtils.join(PathUtils.tempDir, "whimsy-chat-threads-" + Math.random().toString(16).slice(2)));
}

async function openChat() {
  if (!chat().isOpen) {
    EventUtils.synthesizeKey("e", { accelKey: true });
  }
  await TestUtils.waitForCondition(() => chat().isOpen && chat().ready, "Chat is open on this tab's thread");
  await settle();
}

async function closeChat() {
  if (chat().isOpen) {
    chat().close({ reason: "key" });
    await settle();
  }
}

async function send(text) {
  chat().composer.focus();
  EventUtils.sendString(text);
  EventUtils.synthesizeKey("KEY_Enter");
  await TestUtils.waitForCondition(
    () => parts(".whimsy-chat-msg[data-role='ai']").some(m => !m.hasAttribute("busy") && m.textContent.includes("Answer to " + text)),
    "The answer streamed in"
  );
}

add_setup(async function () {
  registerCleanupFunction(() => Services.prefs.clearUserPref("whimsy.ai.hints.seen"));
  await SpecialPowers.pushPrefEnv({ set: [["whimsy.ai.enabled", true], ["whimsy.feature.ai-hints", false]] });
  WhimsyAIProviders.setTestProvider(async function* (provider, request) {
    calls.push({ provider, request });
    yield { type: "text", delta: "Answer to " };
    yield { type: "text", delta: request.lastUserText };
  });
  WhimsyAIProviders.setOrder(["claude"]);
  const { outerWidth, outerHeight } = window;
  window.resizeTo(1400, 900);
  registerCleanupFunction(async () => {
    await closeChat();
    WhimsyAIProviders.setTestProvider(null);
    Services.prefs.clearUserPref("whimsy.ai.order");
    window.resizeTo(outerWidth, outerHeight);
    await WhimsyAIStore._resetForTesting(null);
  });
});

add_task(async function switching_tabs_switches_chat() {
  await freshStore();
  const a = await BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE_A);
  const b = await BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE_B);
  await BrowserTestUtils.switchTab(gBrowser, a);
  await openChat();
  await send("hello");
  ok(parts(".whimsy-chat-msg[data-role='user']").some(m => m.textContent == "hello"), "The question shows");
  await BrowserTestUtils.switchTab(gBrowser, b);
  await TestUtils.waitForCondition(() => chat().ready && !parts(".whimsy-chat-msg").length, "Tab B shows its own (empty) chat");
  ok(part(".whimsy-chat-empty"), "with the empty state");
  await BrowserTestUtils.switchTab(gBrowser, a);
  await TestUtils.waitForCondition(() => parts(".whimsy-chat-msg[data-role='user']").length == 1, "Back on A, its chat returns");
  const threads = await WhimsyAIStore.threads({ tabKey: WhimsyAIContext.tabKey(a) });
  is(threads.length, 1, "One thread is stored for tab A");
  is((await WhimsyAIStore.threads({ tabKey: WhimsyAIContext.tabKey(b) })).length, 0, "and nothing for B, which never asked");
  await closeChat();
  BrowserTestUtils.removeTab(a);
  BrowserTestUtils.removeTab(b);
});

add_task(async function list_orders_this_tab_then_routines_then_date() {
  await freshStore();
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE_A);
  const key = WhimsyAIContext.tabKey(tab);
  const now = Date.now();
  const older = await WhimsyAIStore.createThread({ kind: "tab", tabKey: "other-1", title: "Older chat", updated: now - 3 * 86400000 });
  const routine = await WhimsyAIStore.createThread({ kind: "routine", title: "Daily brief", updated: now - 3600000 });
  const watch = await WhimsyAIStore.createThread({ kind: "watch", title: "Desk price watch", updated: now - 7200000 });
  const newer = await WhimsyAIStore.createThread({ kind: "cmdbar", title: "From the bar", updated: now - 60000 });
  const mine = await WhimsyAIStore.createThread({ kind: "tab", tabKey: key, title: "This tab's chat", updated: now - 86400000 * 5 });
  const list = await WhimsyChatThreads.list(window, {});
  Assert.deepEqual(list.thisTab.map(t => t.id), [mine.id], "This tab's chats first");
  Assert.deepEqual(list.routines.map(t => t.id), [routine.id, watch.id], "then routine and watch threads");
  Assert.deepEqual(list.all.map(t => t.id), [newer.id, older.id], "then everything else by date");
  await openChat();
  EventUtils.synthesizeMouseAtCenter(part("#whimsy-chat-list-button"), {});
  await settle();
  const labels = parts(".whimsy-chat-group-label").map(l => l.getAttribute("data-l10n-id"));
  Assert.deepEqual(labels, ["whimsy-chat-list-this-tab", "whimsy-chat-list-routines", "whimsy-chat-list-earlier"], "Groups in that order");
  ok(parts(".whimsy-chat-conv")[1].querySelector(".whimsy-chat-conv-icon[data-kind='routine']"), "Routines carry the clock icon");
  EventUtils.synthesizeMouseAtCenter(parts(".whimsy-chat-conv")[1], {});
  await settle();
  ok(part(".whimsy-chat-list").hidden, "Picking a chat closes the list");
  is(part(".whimsy-chat-head-title").textContent, "Daily brief", "and shows that chat");
  await closeChat();
  BrowserTestUtils.removeTab(tab);
});

add_task(async function local_search_titles_and_text() {
  await freshStore();
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE_A);
  const t1 = await WhimsyAIStore.createThread({ kind: "tab", tabKey: "x", title: "Parking rules" });
  const t2 = await WhimsyAIStore.createThread({ kind: "tab", tabKey: "y", title: "Q4 plan" });
  await WhimsyAIStore.append(t2.id, { role: "ai", text: "A garage parking space adds $30k per unit." });
  await WhimsyAIStore.createThread({ kind: "tab", tabKey: "z", title: "Lisbon hotels" });
  await openChat();
  EventUtils.synthesizeMouseAtCenter(part("#whimsy-chat-list-button"), {});
  await settle();
  const search = part(".whimsy-chat-search");
  is(document.activeElement, search, "The list opens with the search field focused");
  EventUtils.sendString("parking");
  await TestUtils.waitForCondition(() => parts(".whimsy-chat-conv").length == 2, "Two chats match");
  const ids = parts(".whimsy-chat-conv").map(r => r.dataset.threadId);
  ok(ids.includes(t1.id) && ids.includes(t2.id), "by title and by message text");
  ok(parts(".whimsy-chat-conv mark").length >= 2, "Matches are marked");
  ok(parts(".whimsy-chat-conv-sub").some(s => s.textContent.includes("garage parking")), "The snippet shows the matching line");
  EventUtils.synthesizeKey("KEY_Escape");
  await settle();
  ok(part(".whimsy-chat-list").hidden, "Esc closes the list");
  await closeChat();
  BrowserTestUtils.removeTab(tab);
});

add_task(async function thread_outlives_tab_and_reopen_restores() {
  await freshStore();
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE_B);
  await openChat();
  await send("spacing");
  const [thread] = await WhimsyAIStore.threads({ tabKey: WhimsyAIContext.tabKey(tab) });
  await closeChat();
  BrowserTestUtils.removeTab(tab);
  await TestUtils.waitForCondition(async () => (await WhimsyAIStore.thread(thread.id))?.closedTab, "The thread remembers its tab closed");
  is((await WhimsyAIStore.thread(thread.id)).closedTab.url, PAGE_B, "with its address");
  ok((await WhimsyChatThreads.savedPage(thread.id))?.title, "and the copy of the page it read");
  ok(!WhimsyChatThreads.tabOf(await WhimsyAIStore.thread(thread.id)), "Its tab is gone");
  const other = await BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE_A);
  await WhimsyChat.open(window, { threadId: thread.id });
  // The reopen link sits at the panel's far edge: wait for the opening motion, or it may still be past the window.
  await settle();
  await TestUtils.waitForCondition(() => part(".whimsy-chat-note[data-kind='closed-tab']"), "A note says the tab closed");
  const before = calls.length;
  await send("again");
  const last = calls.at(-1).request;
  is(calls.length, before + 1, "One request for the follow-up");
  ok(last.system.includes("Address: " + PAGE_B), "Follow-ups use the copy of the closed tab's page");
  info("Reopening the tab");
  const tabsBefore = gBrowser.tabs.length;
  const reopen = part(".whimsy-chat-note[data-kind='closed-tab'] button");
  reopen.scrollIntoView({ block: "center" });
  await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
  const r = reopen.getBoundingClientRect();
  const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
  ok(hit == reopen || reopen.contains(hit), `The reopen button is under the pointer (found ${hit?.localName}.${hit?.className})`);
  EventUtils.synthesizeMouseAtCenter(reopen, {});
  await TestUtils.waitForCondition(() => gBrowser.tabs.length == tabsBefore + 1, "A tab opens");
  const back = gBrowser.selectedTab;
  info("Selected: " + back.linkedBrowser.currentURI.spec);
  await TestUtils.waitForCondition(() => back.linkedBrowser.currentURI.spec == PAGE_B, "It loads the chat's page");
  info("The tab is back");
  is(gBrowser.selectedTab, back, "Reopen brings the tab back");
  await TestUtils.waitForCondition(async () => !(await WhimsyAIStore.thread(thread.id)).closedTab, "and the thread is tied to it again");
  await TestUtils.waitForCondition(() => parts(".whimsy-chat-msg[data-role='user']").length == 2, "showing the same chat");
  await closeChat();
  BrowserTestUtils.removeTab(back);
  BrowserTestUtils.removeTab(other);
});

add_task(async function private_tab_is_a_wall_nothing_stored() {
  await freshStore();
  const normal = await BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE_A);
  await openChat();
  await send("before");
  const priv = WhimsyPrivate.openPrivateTab(window, { url: PAGE_B, force: true });
  await BrowserTestUtils.browserLoaded(priv.linkedBrowser, false, PAGE_B);
  await TestUtils.waitForCondition(() => el().hasAttribute("private"), "Chat turns into the wall");
  ok(chat().isOpen, "and stays open");
  ok(part(".whimsy-chat-wall"), "The wall shows");
  ok(chat().composer.disabled, "The composer is off");
  is(parts(".whimsy-chat-msg").length, 0, "No conversation shows");
  const before = calls.length;
  chat().composer.removeAttribute("disabled");
  chat().composer.value = "leak";
  await chat().send();
  is(calls.length, before, "Nothing reaches a provider");
  is((await WhimsyAIStore.threads({ tabKey: WhimsyAIContext.tabKey(priv) })).length, 0, "Nothing is stored");
  await BrowserTestUtils.switchTab(gBrowser, normal);
  await TestUtils.waitForCondition(() => !el().hasAttribute("private") && parts(".whimsy-chat-msg[data-role='user']").length == 1, "Switching back restores the thread");
  ok(!chat().composer.disabled, "and the composer");
  await closeChat();
  BrowserTestUtils.removeTab(priv);
  BrowserTestUtils.removeTab(normal);
});

add_task(async function tasks_strip_collapses_with_two() {
  await freshStore();
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE_A);
  let tasks = [{ id: "t1", title: "Lisbon hotels", detail: "Reading reviews · step 3 of 4" }];
  const shown = [];
  const stopped = [];
  const off = WhimsyChat.registerTaskSource({
    id: "test-tasks",
    list: () => tasks,
    show: (win, task) => shown.push(task.id),
    stop: task => stopped.push(task.id),
  });
  await openChat();
  const strip = part(".whimsy-chat-tasks");
  await TestUtils.waitForCondition(() => !strip.hidden, "The Tasks strip shows a running task");
  is(parts(".whimsy-chat-task").length, 1, "one row");
  EventUtils.synthesizeMouseAtCenter(part(".whimsy-chat-task [data-action='show']"), {});
  Assert.deepEqual(shown, ["t1"], "Show goes to the task");
  tasks = [...tasks, { id: "t2", title: "Fill the expense form", detail: "Background", waiting: true }];
  WhimsyChat.tasksChanged();
  await TestUtils.waitForCondition(() => strip.hasAttribute("collapsed"), "Two tasks collapse to one line");
  is(parts(".whimsy-chat-task:not([hidden])").length, 0, "The rows fold away");
  ok(!part(".whimsy-chat-task-summary").hidden, "into one line");
  await document.l10n.translateFragment(part(".whimsy-chat-task-summary"));
  ok(part(".whimsy-chat-task-summary").textContent.includes("2 tasks"), "that counts the tasks");
  EventUtils.synthesizeMouseAtCenter(part(".whimsy-chat-task-summary [data-action='expand']"), {});
  await TestUtils.waitForCondition(() => !strip.hasAttribute("collapsed"), "Expanding lists both");
  const second = parts(".whimsy-chat-task").find(r => r.dataset.taskId == "t2");
  ok(second.hasAttribute("waiting"), "A task that needs you is marked");
  EventUtils.synthesizeMouseAtCenter(second.querySelector("[data-action='stop']"), {});
  Assert.deepEqual(stopped, ["t2"], "Stop stops only that task");
  tasks = [];
  WhimsyChat.tasksChanged();
  await TestUtils.waitForCondition(() => strip.hidden, "The strip goes with the last task");
  off();
  await closeChat();
  BrowserTestUtils.removeTab(tab);
});

add_task(async function new_chat_and_title() {
  await freshStore();
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE_A);
  await openChat();
  is(part(".whimsy-chat-head-title").textContent, tab.label, "An empty chat takes the tab's title");
  is(parts(".whimsy-chat-suggest button").length, 3, "with three suggestions");
  const suggestion = parts(".whimsy-chat-suggest button")[0];
  EventUtils.synthesizeMouseAtCenter(suggestion, {});
  is(chat().composer.value, suggestion.textContent, "A suggestion fills the composer");
  is(calls.filter(c => c.request.lastUserText == suggestion.textContent).length, 0, "and doesn't send");
  chat().composer.value = "";
  await send("first");
  EventUtils.synthesizeMouseAtCenter(part("#whimsy-chat-new-button"), {});
  await TestUtils.waitForCondition(() => !parts(".whimsy-chat-msg").length, "New chat starts empty");
  is(document.activeElement, chat().composer, "with focus in the composer");
  await send("second");
  const threads = await WhimsyAIStore.threads({ tabKey: WhimsyAIContext.tabKey(tab) });
  is(threads.length, 2, "The tab has two chats");
  ok(threads.every(t => t.title == tab.label), "each titled after the tab");
  await closeChat();
  BrowserTestUtils.removeTab(tab);
});
