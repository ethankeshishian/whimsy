/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// W23 routines-engine screenshots, light and dark: w23-routines-engine-<state>-<scheme>.
// Compare with docs/superpowers/mockups/ai/06-routines.html#rout-<state> and
// followup/fu-routines.html.

Services.scriptloader.loadSubScript(getRootDirectory(gTestPath) + "head_cmdbar_ai.js", this);

const { WhimsyRoutines } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyRoutines.sys.mjs");
const { WhimsyRoutineTriggers } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyRoutineTriggers.sys.mjs");
const { WhimsyAIError } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyAIProviders.sys.mjs");
const { WhimsyChatPanel } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyChatPanel.sys.mjs");
const { WhimsyChat } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyChat.sys.mjs");
const { WhimsyPageWatch } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyPageWatch.sys.mjs");
const { WhimsyAIReader } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyAIReader.sys.mjs");

const NAME = id => `w23-routines-engine-${id}`;
const MINUTE = 60000;
const BRIEF = { title: "Daily brief", prompt: "Summarize today’s meetings and the emails that need a reply. Flag anything due today.", trigger: { kind: "schedule", days: [1, 2, 3, 4, 5], hour: 8, minute: 0 } };
const RESULT =
  "3 meetings, Priya needs a reply today\n\n" +
  "- **10:00** Design review with Sam and Priya\n- **1:00** 1:1 with Alex\n- **4:30** Vendor call (Zoom)\n\n" +
  "Two emails need a reply: **Priya** on the Q4 budget (due today) and **your landlord** about Friday’s visit.";

let reply = () => RESULT;
let hold = null;

add_setup(async () => {
  await WhimsyAIStore._resetForTesting(PathUtils.join(PathUtils.tempDir, "whimsy-routines-shots-" + Math.random().toString(16).slice(2)));
  WhimsyAIUpdates._resetForTesting();
  await WhimsyRoutines._resetForTesting();
  await WhimsyRoutines.init();
  WhimsyRoutines.setTestNotify(() => {});
  WhimsyAIProviders.setTestProvider(async () => {
    await hold;
    return reply();
  });
  registerCleanupFunction(async () => {
    if (WhimsyChatPanel.forWindow(window).isOpen) {
      WhimsyChatPanel.forWindow(window).close({ reason: "key" });
    }
    await WhimsyRoutines._resetForTesting();
    WhimsyRoutines.setTestNotify(null);
    WhimsyRoutineTriggers.setTestSource("calendar", null);
    WhimsyAIProviders.setTestProvider(null);
    WhimsyAIReader.setTestReader(null);
    WhimsyAIUpdates._resetForTesting();
    await WhimsyAIStore._resetForTesting(null);
  });
});

async function fresh() {
  reply = () => RESULT;
  hold = null;
  await WhimsyRoutines._resetForTesting();
  WhimsyAIUpdates._resetForTesting();
  await WhimsyAIStore.clear({ kinds: ["routineResults"] });
}

async function openThread(threadId) {
  const panel = WhimsyChatPanel.forWindow(window);
  await WhimsyChat.open(window, { threadId });
  await TestUtils.waitForCondition(() => panel.ready && panel.thread?.id == threadId, "The thread is open");
  await TestUtils.waitForCondition(() => panel.el.querySelector(".whimsy-routine-bar button"), "The thread bar is filled");
  return () => panel.close({ reason: "key" });
}

add_task(async function shots_threads() {
  // rout-4.2: a routine's thread, the older run folded, the newest open.
  await fresh();
  const r = await WhimsyRoutines.save(BRIEF, { confirmed: true });
  reply = () => "2 meetings, 4 emails need a reply\n\nQuiet day.";
  await WhimsyRoutines.runNow(r.id);
  reply = () => RESULT;
  await WhimsyRoutines.runNow(r.id);
  const { threadId } = await WhimsyRoutines.get(r.id);
  await whimsyBothSchemes(NAME("4.2"), () => openThread(threadId));

  // rout-4.3: running, in its thread.
  let release;
  hold = new Promise(resolve => (release = resolve));
  const running = WhimsyRoutines.runNow(r.id);
  await TestUtils.waitForCondition(async () => (await WhimsyRoutines.get(r.id)).status == "running", "Running");
  await whimsyBothSchemes(NAME("4.3"), () => openThread(threadId));
  release();
  hold = null;
  await running;

  // rout-4.7: failed, needs you.
  await fresh();
  const failing = await WhimsyRoutines.save(BRIEF, { confirmed: true });
  reply = () => {
    throw new WhimsyAIError("claude-code-signed-out");
  };
  await WhimsyRoutines.runNow(failing.id);
  await whimsyBothSchemes(NAME("4.7"), async () => openThread((await WhimsyRoutines.get(failing.id)).threadId));

  // rout-4.6: meeting prep skipped.
  await fresh();
  const start = Date.now() - 25 * MINUTE;
  WhimsyRoutineTriggers.setTestSource("calendar", () => [{ title: "Design review", start, end: start + 60 * MINUTE }]);
  const prep = await WhimsyRoutines.save({ title: "Meeting prep", prompt: "Pull my last notes with these people.", trigger: { kind: "meeting", leadMinutes: 10 } }, { confirmed: true });
  await WhimsyRoutines._launchForTesting();
  await whimsyBothSchemes(NAME("4.6"), async () => openThread((await WhimsyRoutines.get(prep.id)).threadId));

  // rout-4.5 / fu-routines 4.5: missed while closed, with the skipped prep.
  await WhimsyAIUpdates.post({ source: "routine", whileClosed: true, title: "Daily brief: 2 meetings, 1 email needs a reply", detail: "Ran once for 2 misses" });
  await whimsyBothSchemes(NAME("4.5"), async () => {
    await openEmptyBar();
    return () => closeBar();
  });
  WhimsyRoutineTriggers.setTestSource("calendar", null);
});

add_task(async function shots_updates() {
  // rout-4.8: failures in Updates (needs you leads with its next step; a quota wait is dimmed).
  await fresh();
  const a = await WhimsyRoutines.save(BRIEF, { confirmed: true });
  reply = () => {
    throw new WhimsyAIError("claude-code-signed-out");
  };
  await WhimsyRoutines.runNow(a.id);
  const b = await WhimsyRoutines.save({ ...BRIEF, title: "Weekly recap" }, { confirmed: true });
  reply = () => {
    throw Object.assign(new WhimsyAIError("plan-limit"), { until: Date.now() + 200 });
  };
  await WhimsyRoutines.runNow(b.id);
  await TestUtils.waitForCondition(() => !WhimsyAIProviders.resting("test"), "The stand-in provider is back");
  await whimsyBothSchemes(NAME("4.8"), async () => {
    await openEmptyBar();
    return () => closeBar();
  });
});

add_task(async function shots_watch() {
  // fu-routines 5.7 and rout-5.6: a watch's thread and its hit in Updates.
  await fresh();
  let text = "MacBook Air 13-inch: $999.";
  WhimsyAIReader.setTestReader(() => text);
  WhimsyAIProviders.setTestProvider(({ prompt }) => {
    const met = /\$899/.test(prompt.split("<page>")[1] || "");
    return JSON.stringify({ met, title: met ? "MacBook Air 13-inch: $899" : "", detail: met ? "The price dropped to $899 (was $999). Free delivery by Tuesday." : "Still $999." });
  });
  WhimsyPageWatch._testNotify = () => {};
  const url = "https://example.com/browser/zen/whimsy/tests/whimsy_chat_article.html";
  const watch = await WhimsyPageWatch.add({ url, title: "MacBook Air 13-inch - Apple", condition: "the price drops below $900" });
  await TestUtils.waitForCondition(() => watch.lastChecked && !WhimsyPageWatch._checking, "Checked");
  for (let i = 0; i < 3; i++) {
    await WhimsyPageWatch.checkNow(watch.id);
  }
  text = "MacBook Air 13-inch: $899.";
  await WhimsyPageWatch.checkNow(watch.id);
  await whimsyBothSchemes(NAME("5.7"), () => openThread(watch.threadId));
  await whimsyBothSchemes(NAME("5.6"), async () => {
    await openEmptyBar();
    return () => closeBar();
  });
  WhimsyPageWatch._testNotify = null;
  await WhimsyPageWatch.remove(watch.id);
});
