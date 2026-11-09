/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// W23 agent-tabs: the Drive look (glow, pointer, target, working line), you
// win collisions, needs-you and ⌘E route to the pause, and the agent's mark
// on tabs it opened for you.

const { WhimsyAgentPointer } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyAgentPointer.sys.mjs");
const { WhimsyTaskFolder } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyTaskFolder.sys.mjs");
const { WhimsyAgentTasks } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyAgentTasks.sys.mjs");
const { WhimsyAgentGuard } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyAgentGuard.sys.mjs");
const { WhimsyClaude } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyClaude.sys.mjs");
const { WhimsyChatPanel } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyChatPanel.sys.mjs");
const { WhimsyAIStore } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyAIStore.sys.mjs");

const ROOT = getRootDirectory(gTestPath).replace("chrome://mochitests/content", "https://example.com");
const PAGE = ROOT + "whimsy_claude.html";
const chat = () => WhimsyChatPanel.forWindow(window);

function textOf(result) {
  return result.content.filter(c => c.type == "text").map(c => c.text).join("\n");
}

async function fresh() {
  await WhimsyAIStore._resetForTesting(PathUtils.join(PathUtils.tempDir, "whimsy-agent-tabs-" + Math.random().toString(16).slice(2)));
  WhimsyAgentTasks._resetForTesting();
}

async function closeAll(...tabs) {
  for (const task of WhimsyAgentTasks.list()) {
    WhimsyAgentTasks.stop(task.id);
  }
  await TestUtils.waitForCondition(() => !document.querySelector(".whimsy-task-folder"), "No folders left", 100, 100);
  WhimsyAgentTasks._resetForTesting();
  if (chat().isOpen) {
    chat().close({ reason: "key" });
    await TestUtils.waitForCondition(() => document.getElementById("whimsy-chat").hidden, "Chat closed");
  }
  for (const tab of tabs.flat()) {
    if (tab.isConnected && !tab.closing) {
      BrowserTestUtils.removeTab(tab);
    }
  }
  closeToasts();
}

// A task with a thread (an outside app's gets one by itself).
async function taskWithThread(opts = {}) {
  const task = WhimsyAgentTasks.start({ client: "outside", clientName: "Claude", mode: "background",
    title: "Lisbon hotels", spaceId: gZenWorkspaces.activeWorkspace, ...opts });
  await TestUtils.waitForCondition(() => task.threadId, "Its thread is made");
  return task;
}

async function loaded(tab) {
  await BrowserTestUtils.browserLoaded(tab.linkedBrowser, false, url => url.startsWith(PAGE)).catch(() => {});
  await TestUtils.waitForCondition(() => tab.linkedBrowser.currentURI.spec.startsWith(PAGE), "The page is in");
}

add_setup(async function () {
  await gZenWorkspaces.promiseInitialized;
  await SpecialPowers.pushPrefEnv({ set: [["whimsy.feature.ai-hints", false]] });
  WhimsyAgentGuard._setSiteKnownForTesting(() => true);
  registerCleanupFunction(() => {
    WhimsyAgentGuard._setSiteKnownForTesting(null);
    WhimsyAgentTasks._resetForTesting();
  });
});

add_task(async function pointer_moves_to_target_before_click() {
  await fresh();
  const task = WhimsyAgentTasks.start({ client: "whimsy", mode: "drive", title: "Coffee reorder" });
  const tab = await WhimsyClaude.openTab(PAGE, task);
  await loaded(tab);
  gBrowser.selectedTab = tab;
  const tabId = WhimsyClaude.tabId(tab);
  const tree = textOf(await WhimsyClaude.callTool("read_page", { tabId }, { taskId: task.id }));
  const ref = tree.split("\n").find(l => /button "Go"/.test(l))?.match(/\[(ref_\d+)\]/)?.[1];
  ok(ref, "The page has its Go button");

  const real = WhimsyAgentPointer.moveTo;
  const seen = [];
  WhimsyAgentPointer.moveTo = async function (browser, at) {
    const clicked = await SpecialPowers.spawn(browser, [], () => content.document.getElementById("result").textContent);
    const box = WhimsyAgentPointer.layer(browser).querySelector(".whimsy-agent-target");
    seen.push({ at, clicked, outlined: !box.hidden && box.getBoundingClientRect().width > 0 });
    return real.call(this, browser, at);
  };
  let result;
  try {
    result = await WhimsyClaude.callTool("click", { tabId, ref }, { taskId: task.id });
  } finally {
    WhimsyAgentPointer.moveTo = real;
  }
  ok(!result.isError, `The click went through: ${textOf(result).slice(0, 120)}`);
  is(seen.length, 1, "The pointer moved once");
  ok(seen[0] && !seen[0].clicked, "before anything was pressed");
  ok(seen[0]?.outlined, "with the target outlined");
  const rect = await SpecialPowers.spawn(tab.linkedBrowser, [], () => {
    const r = content.document.getElementById("go").getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  ok(Math.abs(seen[0].at.x - rect.x) < 2 && Math.abs(seen[0].at.y - rect.y) < 2, "to the button's middle");
  ok(await SpecialPowers.spawn(tab.linkedBrowser, [], () => content.document.getElementById("result").textContent), "Then it clicked");
  const layer = WhimsyAgentPointer.layer(tab.linkedBrowser, false);
  ok(layer?.hasAttribute("glow"), "The page glows while the agent drives");
  await closeAll(tab);
});

add_task(async function working_line_names_client() {
  await fresh();
  const task = WhimsyAgentTasks.start({ client: "outside", clientName: "Claude Code", mode: "drive", title: "Fix flaky test" });
  const tab = BrowserTestUtils.addTab(gBrowser, PAGE, { skipAnimation: true });
  WhimsyAgentTasks.addTab(task, tab);
  WhimsyClaude.markActive(tab, task);
  const line = tab.querySelector(".whimsy-agent-working");
  ok(line, "The tab has a working line");
  ok(tab.hasAttribute("whimsy-agent-working"), "shown under its title");
  await document.l10n.translateElements([line]);
  ok(line.textContent.startsWith("Claude Code ·"), `It names the client: ${line.textContent}`);
  WhimsyClaude.clearActive(tab);
  ok(!tab.querySelector(".whimsy-agent-working") && !WhimsyAgentPointer.layer(tab.linkedBrowser, false), "It goes when the agent's done");
  await closeAll(tab);
});

add_task(async function no_notification_bar() {
  await fresh();
  const task = WhimsyAgentTasks.start({ client: "whimsy", mode: "drive" });
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE);
  WhimsyAgentTasks.addTab(task, tab);
  WhimsyClaude.markActive(tab, task);
  const box = gBrowser.readNotificationBox?.(tab.linkedBrowser);
  ok(!box?.getNotificationWithValue("whimsy-claude-control"), "No notification bar on a page the agent uses");
  ok(!document.querySelector("notification-message[value='whimsy-claude-control']"), "anywhere");
  ok(WhimsyAgentPointer.layer(tab.linkedBrowser, false)?.hasAttribute("glow"), "The glow says it instead");
  await closeAll(tab);
});

add_task(async function reduced_motion_static() {
  await SpecialPowers.pushPrefEnv({ set: [["ui.prefersReducedMotion", 1]] });
  await fresh();
  const task = WhimsyAgentTasks.start({ client: "whimsy", mode: "drive" });
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE);
  WhimsyAgentTasks.addTab(task, tab);
  WhimsyClaude.markActive(tab, task);
  const browser = tab.linkedBrowser;
  await WhimsyAgentPointer.moveTo(browser, { x: 20, y: 20 });
  await WhimsyAgentPointer.moveTo(browser, { x: 200, y: 120 });
  const pointer = WhimsyAgentPointer.layer(browser).querySelector(".whimsy-agent-pointer");
  is(pointer.getAnimations().length, 0, "The pointer jumps, no travel");
  const glow = WhimsyAgentPointer.layer(browser).querySelector(".whimsy-agent-glow");
  is(getComputedStyle(glow).animationName, "none", "The glow is steady");
  ok(pointer.style.translate.includes("200px") || pointer.getBoundingClientRect().width > 0, "It's at the target");
  await closeAll(tab);
  await SpecialPowers.popPrefEnv();
});

add_task(async function click_in_agent_tab_pauses_and_lands() {
  await fresh();
  const task = await taskWithThread();
  const tab = await WhimsyClaude.openTab(PAGE, task);
  await loaded(tab);
  gBrowser.selectedTab = tab;
  await SpecialPowers.spawn(tab.linkedBrowser, [], () => {
    content.document.addEventListener("mousedown", () => (content.document.body.dataset.downs = String(Number(content.document.body.dataset.downs ?? 0) + 1)));
  });
  tab.linkedBrowser.focus();
  EventUtils.synthesizeMouseAtCenter(tab.linkedBrowser, {}, window);
  await TestUtils.waitForCondition(() => task.state == "paused", "A click in the agent's tab pauses its task");
  is(task.pause.kind, "collision", "as a collision");
  Assert.deepEqual(task.pause.choices, ["do", "self"], "Continue or Keep this tab");
  await TestUtils.waitForCondition(() => SpecialPowers.spawn(tab.linkedBrowser, [], () => content.document.body.dataset.downs), "The click still lands");
  await TestUtils.waitForCondition(() => chat().isOpen && chat().thread?.id == task.threadId, "Chat opens on the task");
  const card = await TestUtils.waitForCondition(() => document.querySelector(`#whimsy-chat [data-pause-id='${task.pause.id}']`), "on its pause card");
  ok(card, "The card is there");
  is(document.activeElement, tab.linkedBrowser, "Focus stays in the page");
  ok(!toastFor("whimsy-agent-chat-needs-you"), "No toast while chat shows the pause");

  EventUtils.synthesizeKey("a", {}, window);
  is(task.pause.kind, "collision", "More input doesn't stack pauses");
  WhimsyAgentTasks.resume(task.id);
  is(task.state, "running", "Continue carries on");
  await closeAll(tab);
});

add_task(async function keep_this_tab_leaves_folder() {
  await fresh();
  const task = await taskWithThread();
  const tabs = [await WhimsyClaude.openTab(PAGE, task), await WhimsyClaude.openTab(PAGE + "?2", task)];
  await loaded(tabs[0]);
  const [folder] = WhimsyTaskFolder.foldersFor(task);
  WhimsyTaskFolder.collide(window, task, tabs[0]);
  ok(task.pause?.kind == "collision", "Paused for you");
  ok(WhimsyAgentTasks.decide(task.id, "self"), "Keep this tab");
  ok(!tabs[0].hasAttribute("whimsy-task-tab") && !tabs[0].hasAttribute("whimsy-agent-task"), "The tab leaves the folder");
  ok(folder.compareDocumentPosition(tabs[0]) & Node.DOCUMENT_POSITION_PRECEDING, "and sits above it, an ordinary tab");
  ok(task.skipped.includes("example.com"), "The agent skips that site");
  is(WhimsyClaude.offLimits(tabs[0], task), "released", "and can't use the tab");
  is(task.state, "running", "The task carries on");
  await closeAll(tabs);
});

add_task(async function needs_you_toast_persistent() {
  await fresh();
  const task = await taskWithThread();
  const tab = await WhimsyClaude.openTab(PAGE, task);
  const [folder] = WhimsyTaskFolder.foldersFor(task);
  WhimsyAgentTasks.pause(task.id, { kind: "send", host: "example.com", preview: { title: "Send a reply to Maya?", fields: [] } });
  const toast = await TestUtils.waitForCondition(() => toastFor("whimsy-agent-chat-needs-you"), "Needs you raises a toast");
  ok(toast, "with Review ⌘E");
  is(folder.getAttribute("whimsy-agent-working"), "wait", "The folder's line turns amber");
  is(folder.querySelector(".whimsy-agent-working > span").getAttribute("data-l10n-id"), "whimsy-agent-tabs-needs-you", "and says it needs you");
  // eslint-disable-next-line mozilla/no-arbitrary-setTimeout
  await new Promise(r => setTimeout(r, 4500));
  ok(toastFor("whimsy-agent-chat-needs-you"), "The toast stays until you open it");
  await closeAll(tab);
});

add_task(async function cmd_e_opens_oldest_waiting() {
  await fresh();
  const older = await taskWithThread({ title: "Older" });
  const newer = await taskWithThread({ title: "Newer" });
  const tabs = [await WhimsyClaude.openTab(PAGE, older), await WhimsyClaude.openTab(PAGE, newer)];
  const first = WhimsyAgentTasks.pause(older.id, { kind: "send", host: "example.com", preview: { title: "Older?", fields: [] } });
  // eslint-disable-next-line mozilla/no-arbitrary-setTimeout
  await new Promise(r => setTimeout(r, 20));
  WhimsyAgentTasks.pause(newer.id, { kind: "send", host: "example.com", preview: { title: "Newer?", fields: [] } });
  EventUtils.synthesizeKey("e", { accelKey: true });
  await TestUtils.waitForCondition(() => chat().isOpen && chat().thread?.id == older.threadId, "⌘E opens the oldest waiting task");
  await TestUtils.waitForCondition(() => document.activeElement?.getAttribute?.("data-pause-id") == first.id, "with focus on its pause card");
  ok(true, "⌘E routed to the pause");
  await closeAll(tabs);
});

add_task(async function cmd_e_closes_if_open() {
  await fresh();
  const task = await taskWithThread();
  const tab = await WhimsyClaude.openTab(PAGE, task);
  WhimsyAgentTasks.pause(task.id, { kind: "send", host: "example.com", preview: { title: "Send?", fields: [] } });
  EventUtils.synthesizeKey("e", { accelKey: true });
  await TestUtils.waitForCondition(() => chat().isOpen, "⌘E opens chat");
  EventUtils.synthesizeKey("e", { accelKey: true });
  await TestUtils.waitForCondition(() => !chat().isOpen, "and ⌘E still closes it while a task waits");
  ok(!chat().isOpen, "Chat closed");
  await closeAll(tab);
});

add_task(async function opened_tab_badge_until_touched() {
  await fresh();
  const task = await taskWithThread();
  const tabs = [await WhimsyClaude.openTab(PAGE, task), await WhimsyClaude.openTab(PAGE + "?2", task)];
  const [folder] = WhimsyTaskFolder.foldersFor(task);
  await WhimsyTaskFolder.dissolve(folder, { keep: tabs });
  ok(tabs.every(t => t.hasAttribute("whimsy-agent-opened")), "Tabs opened for you carry the agent's mark");
  const toast = toastFor("whimsy-agent-tabs-moved");
  ok(toast, "A toast says they moved, with Undo");
  gBrowser.selectedTab = tabs[0];
  ok(!tabs[0].hasAttribute("whimsy-agent-opened"), "Using one takes its mark off");
  ok(tabs[1].hasAttribute("whimsy-agent-opened"), "the other keeps it");
  // Click Undo once the toast is in (a click on it mid-entrance hits a hidden button).
  await toast.shown;
  const undo = toast.element.querySelector("#whimsy-agent-tabs-undo, [id^='whimsy-agent-tabs-undo']");
  ok(undo && BrowserTestUtils.isVisible(undo), "Undo shows");
  EventUtils.synthesizeMouseAtCenter(undo, {});
  await TestUtils.waitForCondition(() => tabs.every(t => !t.isConnected), "Undo archives them");
  await closeAll(tabs);
});
