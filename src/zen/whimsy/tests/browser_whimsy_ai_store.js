/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// W23: AI's local store (0600 files in a 0700 folder, bounded, cleared by
// range and kind), the Updates feed's ranking, Remind me, Dismiss and Undo,
// the 10-minute Recent answer, and the chat facade's queue.

const { WhimsyAIStore } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyAIStore.sys.mjs");
const { WhimsyAIUpdates } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyAIUpdates.sys.mjs");
const { WhimsyChat } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyChat.sys.mjs");

let scratch;

add_setup(async function () {
  scratch = await IOUtils.createUniqueDirectory(PathUtils.tempDir, "whimsy-ai-store");
  const dir = PathUtils.join(scratch, "whimsy-ai");
  await WhimsyAIStore._resetForTesting(dir);
  WhimsyAIUpdates._resetForTesting();
  registerCleanupFunction(async () => {
    WhimsyAIUpdates._setClockForTesting(null);
    WhimsyAIUpdates._resetForTesting();
    await WhimsyAIStore._resetForTesting(null);
    await IOUtils.remove(scratch, { recursive: true });
  });
});

async function modeOf(path) {
  return (await IOUtils.stat(path)).permissions & 0o777;
}

add_task(async function store_files_are_0600_and_bounded() {
  const thread = await WhimsyAIStore.createThread({ kind: "tab", tabKey: "k1", title: "Hearth Coffee" });
  await WhimsyAIStore.append(thread.id, { role: "user", text: "What did I order?" });
  await WhimsyAIStore.append(thread.id, { role: "ai", text: "A bag of Lisbon roast." });
  await WhimsyAIStore.flush();
  const dir = WhimsyAIStore.dir;
  is(await modeOf(dir), 0o700, "The folder is 0700");
  const files = [];
  const walk = async path => {
    for (const child of await IOUtils.getChildren(path)) {
      const stat = await IOUtils.stat(child);
      if (stat.type == "directory") {
        is(await modeOf(child), 0o700, `${PathUtils.filename(child)}/ is 0700`);
        await walk(child);
      } else {
        files.push(child);
      }
    }
  };
  await walk(dir);
  ok(files.length >= 2, "Threads and messages are on disk");
  for (const file of files) {
    is(await modeOf(file), 0o600, `${PathUtils.filename(file)} is 0600`);
  }
  Assert.deepEqual((await WhimsyAIStore.messages(thread.id)).map(m => m.role), ["user", "ai"], "Messages in order");
  is((await WhimsyAIStore.threads({ tabKey: "k1" }))[0].id, thread.id, "Found by tab");
  is((await WhimsyAIStore.search("lisbon"))[0]?.id, thread.id, "Search reads message text");

  // A cold start reads the same back.
  await WhimsyAIStore._resetForTesting(dir);
  is((await WhimsyAIStore.messages(thread.id)).length, 2, "Saved across a restart");

  // Bounds: 2,000 messages a thread, 500 threads; the oldest go first.
  for (let i = 0; i < WhimsyAIStore.MAX_MESSAGES + 5; i++) {
    await WhimsyAIStore.append(thread.id, { role: "user", text: `m${i}` });
  }
  const kept = await WhimsyAIStore.messages(thread.id);
  is(kept.length, WhimsyAIStore.MAX_MESSAGES, "A thread keeps 2,000 messages");
  is(kept.at(-1).text, `m${WhimsyAIStore.MAX_MESSAGES + 4}`, "The newest are kept");
  for (let i = 0; i < WhimsyAIStore.MAX_THREADS + 3; i++) {
    await WhimsyAIStore.createThread({ kind: "cmdbar", title: `t${i}`, created: 10_000 + i, updated: 10_000 + i });
  }
  const threads = await WhimsyAIStore.threads();
  is(threads.length, WhimsyAIStore.MAX_THREADS, "500 threads at most");
  ok(!threads.some(t => t.title == "t0"), "The oldest went first");
  await WhimsyAIStore.clear();
});

add_task(async function clear_by_range_and_kind() {
  const old = await WhimsyAIStore.createThread({ kind: "tab", title: "old", created: 1000, updated: 1000 });
  await WhimsyAIStore.append(old.id, { role: "user", text: "old message", time: 1000 });
  const since = Date.now();
  await WhimsyAIStore.append(old.id, { role: "user", text: "new message", time: since + 1 });
  const fresh = await WhimsyAIStore.createThread({ kind: "tab", title: "fresh" });
  const routine = await WhimsyAIStore.createThread({ kind: "routine", title: "Morning brief" });
  const reports = await WhimsyAIStore.folder("reports");
  await WhimsyAIStore.writeFile(PathUtils.join(reports, "r1.json"), { title: "Research" });
  await WhimsyAIUpdates.post({ id: "uRoutine", source: "routine", title: "Morning brief" });
  await WhimsyAIUpdates.post({ id: "uResearch", source: "research", title: "Laptops" });

  await WhimsyAIStore.clear({ since, kinds: ["chats"] });
  const left = (await WhimsyAIStore.threads()).map(t => t.title).sort();
  Assert.deepEqual(left, ["Morning brief", "old"], "Chats from the range went; the routine thread stayed");
  Assert.deepEqual((await WhimsyAIStore.messages(old.id)).map(m => m.text), ["old message"], "An older chat lost only the new message");
  ok(await IOUtils.exists(PathUtils.join(reports, "r1.json")), "Reports weren't asked for");
  is((await WhimsyAIUpdates.list()).updates.length, 2, "Updates stay");

  await WhimsyAIStore.clear({ kinds: ["routineResults", "reports"] });
  ok(!(await WhimsyAIStore.thread(routine.id)), "Routine threads cleared");
  ok(!(await IOUtils.exists(PathUtils.join(reports, "r1.json"))), "Reports cleared");
  Assert.deepEqual((await WhimsyAIUpdates.list()).updates.map(u => u.id), [], "Their updates went too");
  ok(!(await WhimsyAIStore.thread(fresh.id)), "Fresh chat is gone");
  ok(await WhimsyAIStore.thread(old.id), "The old chat is still there");
  await WhimsyAIStore.clear();
  is((await WhimsyAIStore.threads()).length, 0, "Everything clears");
});

add_task(async function updates_rank_needs_you_first_then_due_then_newest() {
  let t = 1_000_000;
  WhimsyAIUpdates._setClockForTesting(() => t);
  await WhimsyAIUpdates.post({ id: "plainOld", source: "watch", title: "Price watch" });
  t += 10;
  await WhimsyAIUpdates.post({ id: "dueLater", source: "routine", title: "Pay rent", dueAt: t + 60 * 60_000 });
  t += 10;
  await WhimsyAIUpdates.post({ id: "dueSoon", source: "routine", title: "Standup notes", dueAt: t + 5 * 60_000 });
  t += 10;
  await WhimsyAIUpdates.post({ id: "plainNew", source: "research", title: "Laptops" });
  t += 10;
  await WhimsyAIUpdates.post({ id: "needsYou", source: "agent", title: "Sign in", needsYou: true,
    nextStep: { l10nId: "whimsy-ai-hint-got-it", command: "x" } });
  t += 10;
  await WhimsyAIUpdates.post({ id: "closed", source: "routine", title: "Overnight", whileClosed: true });
  const list = await WhimsyAIUpdates.list();
  Assert.deepEqual(list.updates.map(u => u.id), ["needsYou", "dueSoon", "dueLater", "plainNew", "plainOld"],
    "Needs you, then due (soonest first), then newest");
  Assert.deepEqual(list.whileClosed.map(u => u.id), ["closed"], "While Whimsy was closed is its own group");
  await WhimsyAIStore.clear();
  WhimsyAIUpdates._setClockForTesting(null);
});

add_task(async function remind_returns_at_top() {
  let t = 2_000_000;
  WhimsyAIUpdates._setClockForTesting(() => t);
  await WhimsyAIUpdates.post({ id: "a", source: "watch", title: "A" });
  t += 10;
  await WhimsyAIUpdates.post({ id: "b", source: "watch", title: "B" });
  await WhimsyAIUpdates.remind("a", t + 60_000);
  Assert.deepEqual((await WhimsyAIUpdates.list()).updates.map(u => u.id), ["b"], "Hidden until the reminder");
  t += 60_000;
  await WhimsyAIUpdates.post({ id: "c", source: "watch", title: "C" });
  Assert.deepEqual((await WhimsyAIUpdates.list()).updates.map(u => u.id), ["a", "c", "b"], "Back on top when it's due");
  await WhimsyAIStore.clear();
  WhimsyAIUpdates._setClockForTesting(null);
});

add_task(async function dismiss_and_undo() {
  await WhimsyAIUpdates.post({ id: "d1", source: "routine", title: "One" });
  await WhimsyAIUpdates.post({ id: "d2", source: "routine", title: "Two", whileClosed: true });
  const changed = TestUtils.topicObserved(WhimsyAIUpdates.TOPIC);
  ok(await WhimsyAIUpdates.dismiss("d1"), "Dismissed");
  await changed;
  ok(!(await WhimsyAIUpdates.list()).updates.some(u => u.id == "d1"), "Gone from the list");
  ok(await WhimsyAIUpdates.undoDismiss("d1"), "Undone");
  ok((await WhimsyAIUpdates.list()).updates.some(u => u.id == "d1"), "Back");
  Assert.deepEqual(await WhimsyAIUpdates.dismissAll("whileClosed"), ["d2"], "Dismiss all in a group");
  is((await WhimsyAIUpdates.list()).whileClosed.length, 0, "The group is empty");
  await Assert.rejects(WhimsyAIUpdates.post({ source: "nope", title: "x" }), /source/, "Only known sources post");
  await WhimsyAIStore.clear();
});

add_task(async function recent_answer_expires_after_10_minutes() {
  let t = 3_000_000;
  WhimsyAIUpdates._setClockForTesting(() => t);
  WhimsyAIUpdates.setRecentAnswer({ question: "How far is Lisbon?", answer: "2,700 km" });
  is((await WhimsyAIUpdates.list()).recent?.question, "How far is Lisbon?", "The Recent answer shows");
  t += WhimsyAIUpdates.RECENT_MS - 1;
  ok((await WhimsyAIUpdates.list()).recent, "Still there just before 10 minutes");
  t += 1;
  ok(!(await WhimsyAIUpdates.list()).recent, "Gone at 10 minutes");
  WhimsyAIUpdates.setRecentAnswer({ question: "q" });
  WhimsyAIUpdates.setRecentAnswer(null);
  ok(!WhimsyAIUpdates.recentAnswer(), "Removed by hand");
  WhimsyAIUpdates._setClockForTesting(null);
  await WhimsyAIStore.clear();
});

add_task(async function chat_facade_queues_until_attach() {
  const win = { name: "fake window" };
  ok(!WhimsyChat.isOpen(win), "Closed before a panel attaches");
  const calls = [];
  const opened = WhimsyChat.open(win, { prompt: "hi", send: false });
  const toggled = WhimsyChat.toggle(win);
  is(calls.length, 0, "Nothing ran yet");
  let open = false;
  const detach = WhimsyChat.attach(win, {
    open(opts) {
      calls.push(["open", opts.prompt]);
      open = true;
      return "opened";
    },
    toggle() {
      calls.push(["toggle"]);
      open = !open;
      return open;
    },
    close(opts) {
      calls.push(["close", opts.reason]);
      open = false;
    },
    isOpen: () => open,
  });
  is(await opened, "opened", "The queued open resolves with the panel's answer");
  is(await toggled, false, "Then the toggle");
  Assert.deepEqual(calls, [["open", "hi"], ["toggle"]], "Replayed in order");
  WhimsyChat.open(win, {});
  ok(WhimsyChat.isOpen(win), "Later calls go straight through");
  WhimsyChat.close(win, { reason: "key" });
  is(calls.at(-1)[1], "key", "close gets its reason");

  const offCard = WhimsyChat.registerCard("test-card", doc => doc.createElement("div"));
  ok(WhimsyChat.cardRenderer("test-card"), "A card renderer registers");
  const offAction = WhimsyChat.registerAnswerAction({
    id: "testCopy", l10nId: "whimsy-ai-hint-got-it", icon: "chrome://browser/content/whimsy/icons/eye.svg",
    isAvailable: msg => msg.role == "ai", run() {},
  });
  // The chat's own actions (Retry) apply too once its panel has loaded.
  const ours = msg => WhimsyChat.answerActions(msg).filter(a => a.id == "testCopy");
  is(ours({ role: "ai" }).length, 1, "An answer action applies to answers");
  is(ours({ role: "user" }).length, 0, "Not to your own messages");
  const offTasks = WhimsyChat.registerTaskSource({ id: "testAgent", list: () => [{ id: "t1", title: "Booking" }], show() {}, stop() {} });
  Assert.deepEqual(WhimsyChat.tasks(win).map(t => [t.id, t.source]), [["t1", "testAgent"]], "Tasks come with their source");
  offCard();
  offAction();
  offTasks();
  detach();
  ok(!WhimsyChat.isAttached(win), "Detached");
});
