/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// W23 agent-tabs: the unpinned task folder for Background tabs. A Whimsy
// header row (not Firefox's tab-group, see WhimsyTaskFolder.sys.mjs) at the
// end of the space's Today tabs, folded by default, dissolving like Zap.

const { WhimsyTaskFolder } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyTaskFolder.sys.mjs");
const { WhimsyAgentTasks } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyAgentTasks.sys.mjs");
const { WhimsyClaude } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyClaude.sys.mjs");
const { TabStateFlusher } = ChromeUtils.importESModule("moz-src:///browser/components/sessionstore/TabStateFlusher.sys.mjs");
const { WhimsyCtrlTab } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyCtrlTab.sys.mjs");

const ROOT = getRootDirectory(gTestPath).replace("chrome://mochitests/content", "https://example.com");
const PAGE = ROOT + "whimsy_claude.html";

const MEMBER = "whimsy-task-tab";
const today = () => gBrowser.tabs.filter(t => !t.pinned && !t.hasAttribute("zen-essential") &&
  t.getAttribute("zen-workspace-id") == gZenWorkspaces.activeWorkspace && !t.hasAttribute("zen-empty-tab"));

async function backgroundTask(n = 2, title = "Lisbon hotels") {
  const task = WhimsyAgentTasks.start({ client: "whimsy", mode: "background", title, spaceId: gZenWorkspaces.activeWorkspace });
  const tabs = [];
  for (let i = 0; i < n; i++) {
    tabs.push(await WhimsyClaude.openTab(`${PAGE}?${i}`, task));
  }
  const [folder] = WhimsyTaskFolder.foldersFor(task);
  return { task, tabs, folder };
}

async function gone(folder) {
  await TestUtils.waitForCondition(() => !folder.isConnected, "The folder is gone", 100, 100);
}

async function cleanup(...tabs) {
  WhimsyTaskFolder._setDissolveClockForTesting(null);
  for (const task of WhimsyAgentTasks.list()) {
    WhimsyAgentTasks.stop(task.id);
  }
  await TestUtils.waitForCondition(() => !document.querySelector(".whimsy-task-folder"), "No folders left", 100, 100);
  for (const tab of tabs.flat()) {
    if (tab.isConnected && !tab.closing) {
      BrowserTestUtils.removeTab(tab);
    }
  }
  closeToasts();
}

const frames = () => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));

add_setup(async function () {
  await gZenWorkspaces.promiseInitialized;
  registerCleanupFunction(() => WhimsyAgentTasks._resetForTesting());
});

add_task(async function folder_at_end_of_today_nothing_moves() {
  const mine = [BrowserTestUtils.addTab(gBrowser, "about:blank", { skipAnimation: true }),
    BrowserTestUtils.addTab(gBrowser, "about:blank", { skipAnimation: true })];
  const before = today();
  const { tabs, folder } = await backgroundTask(2);
  ok(folder?.isConnected, "A Background task's tabs get a folder");
  ok(gZenWorkspaces.activeWorkspaceStrip.contains(folder), "in the space the chat is in, among its Today tabs");
  is(folder.nextElementSibling, tabs[0], "The row sits right before its tabs");
  is(tabs[0].nextElementSibling, tabs[1], "which stay together");
  ok(!today().slice(today().indexOf(tabs[1]) + 1).length, "and the folder is last");
  Assert.deepEqual(today().filter(t => !t.hasAttribute(MEMBER)), before, "None of your tabs moved");
  ok(!gBrowser.tabs.includes(folder), "The row isn't a tab");

  // It slides in (height 0 to 44px); measure once it's in.
  await Promise.all(folder.getAnimations().map(a => a.finished));
  is(Math.round(folder.getBoundingClientRect().height), 44, "The row is 44px, title over the working line");
  ok(folder.hasAttribute("collapsed") && folder.getAttribute("aria-expanded") == "false", "It starts folded");
  ok(tabs.every(t => t.getBoundingClientRect().height == 0), "so its tabs don't show");
  is(folder.querySelector(".whimsy-task-folder-count").textContent, "2", "The count says 2");
  ok(folder.querySelector(".whimsy-task-folder-icon > svg"), "with Zen's own folder icon");

  EventUtils.synthesizeMouseAtCenter(folder, {});
  ok(!folder.hasAttribute("collapsed") && folder.getAttribute("aria-expanded") == "true", "A click opens it");
  is(folder.querySelector("svg").getAttribute("state"), "open", "the icon opens like a Zen folder");
  await frames();
  ok(tabs.every(t => t.getBoundingClientRect().height > 0), "and its tabs show");
  ok(tabs[0].getBoundingClientRect().left > mine[0].getBoundingClientRect().left, "indented under it");
  EventUtils.synthesizeMouseAtCenter(folder, {});
  ok(folder.hasAttribute("collapsed"), "Another click folds it");

  const fresh = BrowserTestUtils.addTab(gBrowser, "about:blank", { skipAnimation: true });
  await TestUtils.waitForCondition(() => fresh.nextElementSibling == folder || (folder.compareDocumentPosition(fresh) & Node.DOCUMENT_POSITION_PRECEDING),
    "A tab you open lands above the folder");
  ok(!fresh.hasAttribute(MEMBER), "and isn't in it");
  ok(!today().slice(today().indexOf(tabs[1]) + 1).length, "The folder stays last");
  await cleanup(mine, fresh, tabs);
});

add_task(async function same_container_as_space() {
  const space = gZenWorkspaces.getActiveWorkspace();
  const real = gZenWorkspaces.getWorkspaces;
  gZenWorkspaces.getWorkspaces = function () {
    return real.call(this).map(ws => (ws.uuid == space.uuid ? { ...ws, containerTabId: 2 } : ws));
  };
  let tabs = [];
  try {
    ({ tabs } = await backgroundTask(1));
  } finally {
    gZenWorkspaces.getWorkspaces = real;
  }
  is(tabs[0].userContextId, 2, "Its tab opens in the space's container");
  is(tabs[0].getAttribute("zen-workspace-id"), space.uuid, "in the chat's space");
  ok(tabs[0].hasAttribute(MEMBER), "inside the folder");
  await cleanup(tabs);
});

add_task(async function excluded_from_ctrl_tab_while_running() {
  const mine = BrowserTestUtils.addTab(gBrowser, "about:blank", { skipAnimation: true });
  const { task, tabs, folder } = await backgroundTask(2);
  ok(WhimsyCtrlTab.eligible(window, mine), "Your tab is in Ctrl+Tab");
  ok(tabs.every(t => !WhimsyCtrlTab.eligible(window, t)), "The task's running tabs aren't (nor in its count)");
  WhimsyAgentTasks.stop(task.id);
  await gone(folder);
  ok(tabs.every(t => WhimsyCtrlTab.eligible(window, t)), "Once it ends, kept tabs are ordinary tabs again");
  await cleanup(mine, tabs);
});

add_task(async function dissolve_keeps_kept_archives_rest() {
  const { task, tabs, folder } = await backgroundTask(3);
  const after = tabs[0].previousElementSibling;
  is(after, folder, "The folder sits where its tabs are");
  let elapsed = 300;
  WhimsyTaskFolder._setDissolveClockForTesting(() => elapsed);
  const loose = WhimsyTaskFolder.end(task, { archive: [tabs[2]] });
  Assert.deepEqual(loose, [], "Every archived tab was the folder's");
  await TestUtils.waitForCondition(() => folder.style.getPropertyValue("opacity") == "0", "Zap's dissolve takes the row");
  ok(folder.isConnected, "The row stays while its particles fly (held at 300ms)");
  elapsed = 5000;
  await gone(folder);
  await TestUtils.waitForCondition(() => !tabs[2].isConnected, "The rest are archived");
  ok(tabs.slice(0, 2).every(t => t.isConnected && !t.hasAttribute(MEMBER) && !t.hasAttribute("whimsy-task-collapsed")), "Kept tabs are ordinary");
  ok(today().includes(tabs[0]) && tabs[0].nextElementSibling == tabs[1], "in place, where the folder was");
  ok(tabs.slice(0, 2).every(t => t.hasAttribute("whimsy-agent-opened")), "with the agent's mark");
  ok(toastFor("whimsy-agent-tabs-moved"), "and a toast says where they went, with Undo");
  WhimsyAgentTasks.finish(task.id);
  await cleanup(tabs);
});

add_task(async function dissolve_reduced_motion_fades() {
  await SpecialPowers.pushPrefEnv({ set: [["ui.prefersReducedMotion", 1]] });
  const { task, tabs, folder } = await backgroundTask(1);
  const start = Date.now();
  await WhimsyTaskFolder.dissolve(folder, { keep: tabs });
  ok(!folder.isConnected && Date.now() - start < 1000, "With reduced motion the row just fades");
  ok(tabs[0].isConnected && !tabs[0].hasAttribute(MEMBER), "and the kept tab stays");
  WhimsyAgentTasks.stop(task.id);
  await SpecialPowers.popPrefEnv();
  await cleanup(tabs);
});

add_task(async function dissolve_without_webgl_fades() {
  // A blocklisted GPU or a lost context: no particles, but the folder still
  // leaves cleanly with the 150ms fade.
  await SpecialPowers.pushPrefEnv({ set: [["webgl.disabled", true]] });
  const { task, tabs, folder } = await backgroundTask(2);
  try {
    const start = Date.now();
    const end = WhimsyTaskFolder.end(task, { archive: [tabs[1]] });
    is(end.length, 0, "Every archived tab was the folder's");
    await TestUtils.waitForCondition(() => !folder.isConnected || folder.hasAttribute("dissolving"), "The row starts to go");
    is(folder.getAttribute("dissolving"), "fade", "Without WebGL the row fades");
    await gone(folder);
    ok(Date.now() - start < 2000, "quickly");
    await TestUtils.waitForCondition(() => !tabs[1].isConnected, "The archived tab goes");
    ok(tabs[0].isConnected && !tabs[0].hasAttribute(MEMBER), "and the kept tab stays, ordinary");
  } finally {
    WhimsyAgentTasks.finish(task.id);
    await SpecialPowers.popPrefEnv();
    await cleanup(tabs);
  }
});

add_task(async function restart_restores_tabs_as_ordinary() {
  const { tabs, folder, task } = await backgroundTask(2);
  await TabStateFlusher.flushWindow(window);
  const windowState = JSON.stringify(SessionStore.getWindowState(window));
  ok(!windowState.includes(MEMBER) && !windowState.includes(task.id) && !windowState.includes("whimsy-task-folder"),
    "Session restore never saves the folder, its tabs' marks, or the task");
  const tabState = SessionStore.getTabState(tabs[0]);
  const restored = BrowserTestUtils.addTab(gBrowser, "about:blank", { skipAnimation: true });
  // A background tab restores on demand, so SSTabRestored waits for a
  // select; its attributes are back by SSTabRestoring.
  const done = BrowserTestUtils.waitForEvent(restored, "SSTabRestoring");
  SessionStore.setTabState(restored, tabState);
  await done;
  ok(!restored.hasAttribute(MEMBER) && !restored.hasAttribute("whimsy-task-folder-id"), "A restored tab comes back ordinary");
  ok(folder.nextElementSibling == tabs[0], "and stays out of the folder");
  await cleanup(tabs, restored);
});

add_task(async function drag_out_releases() {
  const mine = BrowserTestUtils.addTab(gBrowser, "about:blank", { skipAnimation: true });
  const { task, tabs, folder } = await backgroundTask(2);
  gBrowser.moveTabBefore(tabs[1], mine);
  ok(!tabs[1].hasAttribute(MEMBER), "A tab dragged out of the folder leaves it");
  ok(!task.tabs.has(tabs[1]) && WhimsyClaude.offLimits(tabs[1], task) == "released", "and the task leaves it alone");
  is(folder.querySelector(".whimsy-task-folder-count").textContent, "1", "The count follows");
  ok(task.state == "running", "The task carries on");
  await cleanup(mine, tabs);
});
