/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// W23 routines-engine: routines run on a schedule or a trigger while
// Whimsy is open, write each run to their thread, and leave results in
// the command bar's Updates. A fake clock, a fake provider, and stand-in
// calendar events drive them; nothing touches the network.

const { WhimsyRoutines } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyRoutines.sys.mjs");
const { WhimsyRoutineTriggers } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyRoutineTriggers.sys.mjs");
const { WhimsyAIProviders, WhimsyAIError } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyAIProviders.sys.mjs");
const { WhimsyAIStore } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyAIStore.sys.mjs");
const { WhimsyAIUpdates } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyAIUpdates.sys.mjs");
const { WhimsyChat } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyChat.sys.mjs");
const { WhimsyChatPanel } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyChatPanel.sys.mjs");

const MINUTE = 60 * 1000;
// Monday, November 9, 2026, 7:50 AM local time.
const MONDAY = new Date(2026, 10, 9, 7, 50).getTime();
const PAGE = "https://example.com/browser/zen/whimsy/tests/whimsy_ai_page.html";

let clock = MONDAY;
let answer = () => "3 meetings, Priya needs a reply today\n\n- 10:00 Design review";
const asked = [];
const notified = [];

add_setup(async () => {
  await WhimsyAIStore._resetForTesting(PathUtils.join(PathUtils.tempDir, `whimsy-routines-${Date.now()}`));
  WhimsyAIUpdates._resetForTesting();
  WhimsyRoutines.setTestClock(() => clock);
  WhimsyRoutines.setTestNotify(n => notified.push(n));
  WhimsyAIProviders.setTestProvider(request => {
    asked.push(request);
    return answer(request);
  });
  await WhimsyRoutines._resetForTesting();
  await WhimsyRoutines.init();
  registerCleanupFunction(async () => {
    await WhimsyRoutines._resetForTesting();
    WhimsyRoutineTriggers.setTestSource("calendar", null);
    WhimsyRoutines.setTestClock(null);
    WhimsyRoutines.setTestNotify(null);
    WhimsyAIProviders.setTestProvider(null);
    WhimsyAIUpdates._resetForTesting();
    await WhimsyAIStore._resetForTesting(null);
  });
});

async function fresh() {
  clock = MONDAY;
  answer = () => "3 meetings, Priya needs a reply today\n\n- 10:00 Design review";
  asked.length = 0;
  notified.length = 0;
  await WhimsyRoutines._resetForTesting();
  WhimsyAIUpdates._resetForTesting();
  await WhimsyAIStore.clear({ kinds: ["routineResults"] });
}

const BRIEF = { title: "Daily brief", prompt: "Summarize today’s meetings and the emails that need a reply.", trigger: { kind: "schedule", days: [1, 2, 3, 4, 5], hour: 8, minute: 0 } };

async function tickAt(ms) {
  clock = ms;
  await WhimsyRoutines.tick();
  await WhimsyRoutines.idle();
}

async function runCards(threadId) {
  return (await WhimsyAIStore.messages(threadId)).filter(m => m.role == "card");
}

add_task(async function chat_draft_never_turns_on_itself() {
  await fresh();
  await Assert.rejects(WhimsyRoutines.save(BRIEF), /confirms/, "Saving without the person's press is refused");
  is((await WhimsyRoutines.list()).filter(r => r.kind == "routine").length, 0, "Nothing was turned on");
  const tried = await WhimsyRoutines.tryOnce(BRIEF);
  is(tried.headline, "3 meetings, Priya needs a reply today", "Try it now runs once and says what it found");
  is((await WhimsyRoutines.list()).filter(r => r.kind == "routine").length, 0, "and saves nothing");
  is((await WhimsyAIUpdates.list()).updates.length, 0, "and posts nothing");
});

add_task(async function schedule_runs_at_time() {
  await fresh();
  const r = await WhimsyRoutines.save(BRIEF, { confirmed: true });
  await tickAt(MONDAY + 9 * MINUTE);
  is(asked.length, 0, "Not before 8:00");
  await tickAt(MONDAY + 10 * MINUTE);
  is(asked.length, 1, "Runs at 8:00");
  ok(asked[0].prompt.includes(BRIEF.prompt), "with the routine's words");
  await tickAt(MONDAY + 11 * MINUTE);
  is(asked.length, 1, "and only once for that time");
  const saved = await WhimsyRoutines.get(r.id);
  ok(saved.lastRun, "The run is recorded");
});

add_task(async function results_to_thread_and_updates() {
  await fresh();
  const r = await WhimsyRoutines.save(BRIEF, { confirmed: true });
  await tickAt(MONDAY + 10 * MINUTE);
  const saved = await WhimsyRoutines.get(r.id);
  const thread = await WhimsyAIStore.thread(saved.threadId);
  is(thread.kind, "routine", "The routine has its own thread");
  const [card] = await runCards(saved.threadId);
  is(card.kind, "routine-run", "with a dated run");
  ok(!card.running && card.tookMs >= 0, "whose steps fold into how long it took");
  ok(card.text.includes("Design review"), "and the result");
  const { updates } = await WhimsyAIUpdates.list();
  is(updates.length, 1, "The result waits in Updates");
  is(updates[0].title, "Daily brief: 3 meetings, Priya needs a reply today", "named by the routine and its first line");
  is(updates[0].threadId, saved.threadId, "and opens its thread");
  is(notified.length, 0, "No notification unless asked for");

  // A second run: the older one folds to a line.
  await tickAt(MONDAY + 24 * 60 * MINUTE + 10 * MINUTE);
  const cards = await runCards(saved.threadId);
  is(cards.length, 2, "Each run is its own entry");
  ok(cards[0].folded && !cards[1].folded, "The newest stays open; older ones fold");
});

add_task(async function show_in_thread_only_posts_no_update() {
  await fresh();
  const r = await WhimsyRoutines.save({ ...BRIEF, showIn: "thread" }, { confirmed: true });
  await tickAt(MONDAY + 10 * MINUTE);
  is((await WhimsyAIUpdates.list()).updates.length, 0, "Only its chat thread: nothing in Updates");
  is((await runCards((await WhimsyRoutines.get(r.id)).threadId)).length, 1, "but the thread has it");

  await fresh();
  await WhimsyRoutines.save({ ...BRIEF, showIn: "bar+notify" }, { confirmed: true });
  await tickAt(MONDAY + 10 * MINUTE);
  is((await WhimsyAIUpdates.list()).updates.length, 1, "The command bar and a notification: in Updates");
  is(notified.length, 1, "and one notification");
  is(notified[0].title, "Daily brief", "titled by the routine");
});

add_task(async function return_after_lock_threshold() {
  await fresh();
  await WhimsyRoutines.save({ title: "Catch-up", prompt: "What did I miss?", trigger: { kind: "return", awayMinutes: 120 } }, { confirmed: true });
  is(WhimsyRoutineTriggers._idle, 120 * 60, "The idle check waits the routine's own two hours, not a fixed time");
  WhimsyRoutineTriggers._simulateAway(60 * MINUTE);
  await WhimsyRoutines.idle();
  is(asked.length, 0, "An hour away is under the routine's two hours");
  WhimsyRoutineTriggers._simulateAway(130 * MINUTE);
  await WhimsyRoutines.idle();
  is(asked.length, 1, "Back after more than two hours: it runs once");
  ok(asked[0].prompt.includes("awayMs"), "knowing how long you were away");
});

add_task(async function return_counts_sleep_and_untouched_mac() {
  await fresh();
  const realIdle = WhimsyRoutineTriggers._idleTime;
  WhimsyRoutineTriggers._idleTime = () => 0;
  const r = await WhimsyRoutines.save({ title: "Catch-up", prompt: "What did I miss?", trigger: { kind: "return", awayMinutes: 120 } }, { confirmed: true });
  const short = await WhimsyRoutines.save({ title: "Quick look", prompt: "Anything new?", trigger: { kind: "return", awayMinutes: 30 } }, { confirmed: true });
  is(WhimsyRoutineTriggers._idle, 30 * 60, "The idle check waits the shortest time any routine asks for");
  await WhimsyRoutines.pause(short.id, true);
  is(WhimsyRoutineTriggers._idle, 120 * 60, "A paused routine doesn't count");

  // Asleep for an hour: under two hours, nothing runs.
  WhimsyRoutineTriggers.observe(null, "sleep_notification");
  clock += 60 * MINUTE;
  WhimsyRoutineTriggers.observe(null, "wake_notification");
  ok(WhimsyRoutineTriggers._wakeWatch, "After a wake, it waits for your first input");
  is(asked.length, 0, "Waking alone isn't coming back");
  WhimsyRoutineTriggers._wakeWatch.observe(null, "active");
  await WhimsyRoutines.idle();
  is(asked.length, 0, "An hour asleep is under the routine's two hours");

  // Asleep for three hours: it runs on the first input.
  WhimsyRoutineTriggers.observe(null, "sleep_notification");
  clock += 180 * MINUTE;
  WhimsyRoutineTriggers.observe(null, "wake_notification");
  WhimsyRoutineTriggers._wakeWatch.observe(null, "active");
  await WhimsyRoutines.idle();
  is(asked.length, 1, "Three hours asleep: it runs");
  ok(!WhimsyRoutineTriggers._wakeWatch, "and stops waiting for input");

  // Locked (nobody touched the Mac) for the routine's time: it runs on the way back.
  clock += 10 * MINUTE;
  WhimsyRoutineTriggers.observe(null, "idle");
  WhimsyRoutineTriggers.observe(null, "active");
  await WhimsyRoutines.idle();
  is(asked.length, 2, "Untouched for two hours, as a locked screen is: it runs");

  await WhimsyRoutines.remove(r.id);
  await WhimsyRoutines.remove(short.id);
  is(WhimsyRoutineTriggers._idle, null, "No I come back routines: no idle check");
  WhimsyRoutineTriggers._idleTime = realIdle;
});

async function openThread(threadId) {
  const panel = WhimsyChatPanel.forWindow(window);
  await WhimsyChat.open(window, { threadId });
  await TestUtils.waitForCondition(() => panel.ready && panel.thread?.id == threadId, "The thread is open");
  await TestUtils.waitForCondition(() => panel.el.querySelector(".whimsy-routine-bar button"), "The thread bar is filled");
  return panel;
}

add_task(async function stop_a_running_routine_from_its_thread() {
  await fresh();
  const r = await WhimsyRoutines.save(BRIEF, { confirmed: true });
  let started;
  const begun = new Promise(resolve => (started = resolve));
  // Never answers: only Stop ends it.
  answer = () => new Promise(() => started());
  const run = WhimsyRoutines.runNow(r.id);
  await begun;
  info("The run started");
  const panel = await openThread((await WhimsyRoutines.get(r.id)).threadId);
  const stop = await TestUtils.waitForCondition(() => panel.el.querySelector('.whimsy-routine-bar button[data-action="stop"]'), "Stop is in the bar, in Run now's place");
  ok(!panel.el.querySelector('.whimsy-routine-bar button[data-action="run"]'), "with no Run now beside it");
  await TestUtils.waitForCondition(() => stop.textContent == "Stop", "labelled Stop");
  info(`Stop is connected: ${stop.isConnected}`);
  EventUtils.synthesizeMouseAtCenter(stop, {}, window);
  info(`Clicked; status ${(await WhimsyRoutines.get(r.id)).status}`);
  await run;
  const [card] = await runCards((await WhimsyRoutines.get(r.id)).threadId);
  ok(card.stopped && !card.running && !card.failed, "The run says it was stopped, not failed");
  is((await WhimsyRoutines.get(r.id)).status, null, "The routine is idle again");
  is((await WhimsyAIUpdates.list()).updates.length, 0, "Nothing goes to Updates");
  is(notified.length, 0, "and nothing notifies");
  await TestUtils.waitForCondition(() => panel.el.querySelector('.whimsy-routine-bar button[data-action="run"]'), "The open thread follows: Run now is back");
  await TestUtils.waitForCondition(
    () => panel.el.querySelector(".whimsy-routine-run .whimsy-routine-run-head > span")?.textContent == "stopped",
    "and the run reads stopped"
  );
  panel.close({ reason: "key" });
});

add_task(async function day_lines_between_runs() {
  await fresh();
  const r = await WhimsyRoutines.save(BRIEF, { confirmed: true });
  const today = new Date();
  today.setHours(8, 0, 0, 0);
  const DAY = 24 * 60 * MINUTE;
  for (const at of [today.getTime() - 2 * DAY, today.getTime() - 2 * DAY + 60 * MINUTE, today.getTime() - DAY, today.getTime()]) {
    clock = at;
    await WhimsyRoutines.runNow(r.id);
  }
  const panel = await openThread((await WhimsyRoutines.get(r.id)).threadId);
  await TestUtils.waitForCondition(() => [...panel.el.querySelectorAll(".whimsy-routine-day")].every(d => d.textContent), "The day lines are filled");
  const days = [...panel.el.querySelectorAll(".whimsy-routine-day")].map(d => d.textContent);
  const weekday = new Date(today.getTime() - 2 * DAY).toLocaleDateString([], { weekday: "long" });
  Assert.deepEqual(days, [weekday, "Yesterday", "Today"], "One line for each day with runs, two runs on one day share it");
  const firstRun = panel.el.querySelector(".whimsy-routine-day + .whimsy-routine-run");
  ok(firstRun, "Each day line sits right above its first run");
  is(firstRun.querySelector(".whimsy-routine-run-head > b").textContent, new Date(today.getTime() - 2 * DAY).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }), "The run itself shows only its time");
  panel.close({ reason: "key" });
});

add_task(async function open_site_trigger_ignores_private_tab() {
  await fresh();
  await WhimsyRoutines.save({ title: "Linear", prompt: "What changed?", trigger: { kind: "open-site", host: "example.com" } }, { confirmed: true });
  const win = await BrowserTestUtils.openNewBrowserWindow({ private: true });
  WhimsyRoutineTriggers.initWindow(win);
  const privateTab = await BrowserTestUtils.openNewForegroundTab(win.gBrowser, PAGE);
  await WhimsyRoutines.idle();
  is(asked.length, 0, "A private tab never sets it off");
  BrowserTestUtils.removeTab(privateTab);
  await BrowserTestUtils.closeWindow(win);

  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE);
  await TestUtils.waitForCondition(() => asked.length == 1, "The first visit today sets it off");
  ok(asked[0].prompt.includes("example.com"), "with the site");
  BrowserTestUtils.startLoadingURIString(tab.linkedBrowser, PAGE + "?again");
  await BrowserTestUtils.browserLoaded(tab.linkedBrowser);
  await WhimsyRoutines.idle();
  is(asked.length, 1, "Only the first visit each day");
  BrowserTestUtils.removeTab(tab);
});

add_task(async function meeting_prep_ten_minutes_before() {
  await fresh();
  const start = MONDAY + 30 * MINUTE;
  WhimsyRoutineTriggers.setTestSource("calendar", () => [{ title: "Design review", start, end: start + 30 * MINUTE }]);
  await WhimsyRoutines.save({ title: "Meeting prep", prompt: "Prep me.", trigger: { kind: "meeting", leadMinutes: 10 } }, { confirmed: true });
  await tickAt(start - 11 * MINUTE);
  is(asked.length, 0, "Not before ten minutes ahead");
  await tickAt(start - 10 * MINUTE);
  is(asked.length, 1, "Ten minutes before, it preps");
  ok(asked[0].prompt.includes("Design review"), "for that meeting");
  await tickAt(start - 9 * MINUTE);
  is(asked.length, 1, "once");
  WhimsyRoutineTriggers.setTestSource("calendar", null);
});

add_task(async function download_finished_trigger() {
  await fresh();
  await WhimsyRoutines.save({ title: "PDFs", prompt: "Summarize it.", trigger: { kind: "download", match: "pdf" } }, { confirmed: true });
  const download = (name, type, isPrivate = false) => ({
    succeeded: true,
    source: { url: `https://example.com/${name}`, isPrivate },
    target: { path: PathUtils.join(PathUtils.tempDir, name) },
    contentType: type,
  });
  WhimsyRoutineTriggers._downloaded(download("photo.png", "image/png"));
  WhimsyRoutineTriggers._downloaded(download("secret.pdf", "application/pdf", true));
  await WhimsyRoutines.idle();
  is(asked.length, 0, "Not an image, and never a private download");
  WhimsyRoutineTriggers._downloaded(download("lease.pdf", "application/pdf"));
  await WhimsyRoutines.idle();
  is(asked.length, 1, "A finished PDF sets it off");
  ok(asked[0].prompt.includes("lease.pdf"), "with the file");
});

add_task(async function missed_runs_once_on_launch_grouped() {
  await fresh();
  const r = await WhimsyRoutines.save(BRIEF, { confirmed: true });
  await tickAt(MONDAY + 10 * MINUTE);
  asked.length = 0;
  // Whimsy quits after Monday's run and opens Wednesday at 9:14.
  await WhimsyRoutines._resetForTesting({ keep: true });
  clock = new Date(2026, 10, 11, 9, 14).getTime();
  await WhimsyRoutines._launchForTesting();
  is(asked.length, 1, "Two missed runs run once");
  const { whileClosed, updates } = await WhimsyAIUpdates.list();
  is(whileClosed.length, 1, "under While Whimsy was closed");
  is(updates.length, 0, "not with the other updates");
  is(whileClosed[0].detail, "Ran once for 2 misses", "saying how many it covered");
  const [, card] = await runCards((await WhimsyRoutines.get(r.id)).threadId);
  ok(card.whileClosed && card.misses == 2, "The thread says it caught up");
});

add_task(async function late_meeting_prep_skipped_dimmed_no_notification() {
  await fresh();
  const start = MONDAY + 60 * MINUTE;
  WhimsyRoutineTriggers.setTestSource("calendar", () => [{ title: "Design review", start, end: start + 60 * MINUTE }]);
  const r = await WhimsyRoutines.save({ title: "Meeting prep", prompt: "Prep me.", trigger: { kind: "meeting", leadMinutes: 10 } }, { confirmed: true });
  await WhimsyRoutines._resetForTesting({ keep: true });
  clock = start + 25 * MINUTE;
  await WhimsyRoutines._launchForTesting();
  is(asked.length, 0, "Prep more than ten minutes late doesn't run");
  is(notified.length, 0, "and doesn't notify");
  const [row] = (await WhimsyAIUpdates.list()).whileClosed;
  ok(row?.dimmed, "It's a dimmed row under While Whimsy was closed");
  is(row.title, "Meeting prep skipped Design review: it started at " + new Date(start).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }), "saying why");
  is(row.nextStep?.action, "prep-anyway", "with Prep anyway");
  const [card] = await runCards((await WhimsyRoutines.get(r.id)).threadId);
  is(card.kind, "routine-skip", "The thread records the skip");
  is((await WhimsyRoutines.get(r.id)).status, "skipped", "and so does its row");

  // Prep anyway runs it.
  ok(await WhimsyAIUpdates.handle(window, row), "Prep anyway is handled by the routine");
  await WhimsyRoutines.idle();
  is(asked.length, 1, "and preps that meeting");
  WhimsyRoutineTriggers.setTestSource("calendar", null);
});

add_task(async function routine_signed_out_posts_needs_you_update() {
  await fresh();
  answer = () => {
    throw new WhimsyAIError("claude-code-signed-out");
  };
  const r = await WhimsyRoutines.save({ ...BRIEF, showIn: "thread" }, { confirmed: true });
  await tickAt(MONDAY + 10 * MINUTE);
  const [row] = (await WhimsyAIUpdates.list()).updates;
  ok(row?.needsYou, "A signed-out provider needs you, even for Only its chat thread");
  is(row.nextStep.l10nId, "whimsy-routine-step-sign-in", "and the row leads with Sign in");
  is(notified.length, 1, "Needs you: always a notification");
  is(notified[0].title, "Daily brief needs you", "saying which routine");
  const [card] = (await runCards((await WhimsyRoutines.get(r.id)).threadId)).filter(m => m.kind == "routine-fail");
  is(card?.step?.action, "sign-in", "The thread says what to do");
});

add_task(async function quota_wait_dimmed_clears() {
  await fresh();
  let out = true;
  answer = () => {
    if (out) {
      throw Object.assign(new WhimsyAIError("plan-limit"), { until: Date.now() + 300 });
    }
    return "Recap ready\n\nThree projects moved.";
  };
  const r = await WhimsyRoutines.save(BRIEF, { confirmed: true });
  await tickAt(MONDAY + 10 * MINUTE);
  let [row] = (await WhimsyAIUpdates.list()).updates;
  ok(row?.dimmed && !row.needsYou, "Out of room: a dimmed row that doesn't need you");
  is(notified.length, 0, "and no notification");
  ok((await WhimsyRoutines.get(r.id)).status == "waiting", "The routine waits");
  out = false;
  await TestUtils.waitForCondition(() => !WhimsyAIProviders.resting("test"), "The provider is back");
  await tickAt(MONDAY + 75 * MINUTE);
  [row] = (await WhimsyAIUpdates.list()).updates;
  ok(row && !row.dimmed, "Once it runs, the wait clears itself");
  is(row.title, "Daily brief: Recap ready", "into the result");
});

add_task(async function transient_failures_retry_bounded() {
  await fresh();
  answer = () => {
    throw new WhimsyAIError("network");
  };
  await WhimsyRoutines.save(BRIEF, { confirmed: true });
  let t = MONDAY + 10 * MINUTE;
  await tickAt(t);
  is((await WhimsyAIUpdates.list()).updates.length, 0, "A passing failure tries again quietly");
  for (const wait of [5, 15, 45]) {
    t += wait * MINUTE;
    await tickAt(t);
  }
  is(asked.length, 4, "Three more tries, no more");
  const [row] = (await WhimsyAIUpdates.list()).updates;
  ok(row?.needsYou && row.nextStep.action == "try-again", "Then it needs you, with Try again");
  await tickAt(t + 6 * 60 * MINUTE);
  is(asked.length, 4, "and it doesn't keep trying by itself");
});

add_task(async function delete_keeps_thread_and_undo() {
  await fresh();
  const r = await WhimsyRoutines.save(BRIEF, { confirmed: true });
  await tickAt(MONDAY + 10 * MINUTE);
  const { threadId } = await WhimsyRoutines.get(r.id);
  ok(await WhimsyRoutines.remove(r.id), "Deleted");
  ok((await WhimsyAIStore.thread(threadId)).routineDeleted, "Its thread is kept, marked as deleted");
  ok(await WhimsyRoutines.undoRemove(r.id), "Undo within 2 seconds brings it back");
  ok(await WhimsyRoutines.get(r.id), "with everything");
  ok(!(await WhimsyAIStore.thread(threadId)).routineDeleted, "and its thread unmarked");
  await WhimsyRoutines.remove(r.id);
  clock += 3000;
  ok(!(await WhimsyRoutines.undoRemove(r.id)), "After 2 seconds there's no undo");
});

add_task(async function store_file_is_private() {
  await fresh();
  await WhimsyRoutines.save(BRIEF, { confirmed: true });
  await WhimsyAIStore.flush();
  const path = PathUtils.join(WhimsyAIStore.dir, "docs", "routines.json");
  is((await IOUtils.stat(path)).permissions, 0o600, "Routines are kept owner-only");
});
