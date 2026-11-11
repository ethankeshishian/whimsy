/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

const { WhimsyClaude } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyClaude.sys.mjs");
const { WhimsyAgentTasks } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyAgentTasks.sys.mjs");
const { WhimsyAgentGuard } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyAgentGuard.sys.mjs");
const { WhimsyOutsideAgents } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyOutsideAgents.sys.mjs");
const PAGE = "https://example.com/";
const textOf = result => result.content.filter(c => c.type == "text").map(c => c.text).join("\n");
const call = (session, name = "tabs_create", args = { url: PAGE }) =>
  WhimsyClaude.callTool(name, args, { session, clientName: "Approval test" });
const prompt = win => win.document.getElementById("whimsy-mcp-approvals");
const visiblePrompt = win => TestUtils.waitForCondition(() =>
  prompt(win)?.querySelector("article") && prompt(win).getBoundingClientRect().width > 0,
"The approval is visible in browser chrome");
function choose(win, choice) {
  EventUtils.synthesizeMouseAtCenter(prompt(win).querySelector(`[data-choice="${choice}"]`), {}, win);
}

add_setup(async function () {
  await SpecialPowers.pushPrefEnv({ set: [
    ["whimsy.ai.enabled", true], ["whimsy.ai.outside-agents", true], ["whimsy.claude.port", 0],
    // Approval rendering must not depend on the chat feature.
    ["whimsy.feature.ai-chat", false],
  ] });
  WhimsyAgentGuard._setTrustedSitesForTesting(null);
  WhimsyAgentGuard._setSiteKnownForTesting(() => false);
  await WhimsyClaude.start();
  registerCleanupFunction(() => {
    WhimsyAgentTasks._resetForTesting();
    WhimsyAgentGuard._setSiteKnownForTesting(null);
    WhimsyClaude.shutdown();
  });
});

add_task(async function frontmost_approval_and_repeat_open_once() {
  await SimpleTest.promiseFocus(window);
  const first = call("approval-create");
  await visiblePrompt(window);
  const task = WhimsyAgentTasks.forSession("approval-create");
  const pauseId = task.pause.id;
  const surface = prompt(window);
  const repeat = call("approval-create");
  is(prompt(window), surface, "Repeat reuses the visible surface");
  is(task.pause.id, pauseId, "Repeat reuses the same pending request");
  is(surface.querySelectorAll("article").length, 1, "No duplicate prompt");
  const other = await call("approval-create", "tabs_create", { url: "https://example.org/" });
  ok(other.isError && textOf(other).includes("Another request"), "A different action is refused explicitly");
  choose(window, "do");
  const [a, b] = await Promise.all([first, repeat]);
  ok(!a.isError, "Approval succeeds");
  const created = JSON.parse(textOf(a));
  is(JSON.parse(textOf(b)).tabId, created.tabId, "Both calls return the same tabId");
  const tab = WhimsyClaude.tabById(created.tabId);
  ok(tab, "The approved tab exists");
  ok(!prompt(window), "Answered requests leave the pending surface");
  WhimsyAgentTasks.finish(task.id);
  await BrowserTestUtils.removeTab(tab);
});

add_task(async function denying_returns_error() {
  const pending = call("approval-deny");
  await visiblePrompt(window);
  choose(window, "skip");
  const result = await pending;
  ok(result.isError && textOf(result).includes("denied approval"), "Denial is an actionable tool error");
});

add_task(async function unanswered_expires_without_polling() {
  const original = WhimsyAgentTasks.approvalTimeoutMs;
  let expire;
  const restore = WhimsyAgentTasks._setTimerForTesting((ms, callback) => {
    if (ms == 20) {
      expire = callback;
    }
    return () => {};
  });
  WhimsyAgentTasks.approvalTimeoutMs = 20;
  try {
    const pending = call("approval-timeout");
    await visiblePrompt(window);
    expire();
    const result = await pending;
    ok(result.isError && textOf(result).includes("wasn't answered in time"), "A short test deadline returns a clear error");
    ok(!prompt(window), "Expiry removes the prompt");
  } finally {
    restore();
    WhimsyAgentTasks.approvalTimeoutMs = original;
  }
});

add_task(async function retry_resurfaces_in_frontmost_window() {
  const original = WhimsyAgentGuard.holdMs;
  const restore = WhimsyAgentTasks._setTimerForTesting((ms, callback) => {
    if (ms == 10) {
      Promise.resolve().then(callback);
    }
    return () => {};
  });
  WhimsyAgentGuard.holdMs = 10;
  let second;
  try {
    const result = await call("approval-two-windows");
    is(textOf(result), WhimsyAgentGuard.WAITING_TEXT, "First call releases its transport hold");
    const task = WhimsyAgentTasks.forSession("approval-two-windows");
    const id = task.pause.id;
    second = await BrowserTestUtils.openNewBrowserWindow({
      zenSyncedWindow: Services.prefs.getBoolPref("zen.window-sync.prefer-unsynced-windows", false),
    });
    await SimpleTest.promiseFocus(second);
    await TestUtils.waitForCondition(() => WhimsyOutsideAgents.window() == second, "Second window is most recent");
    // Lose the old prompt as if its chrome were rebuilt.
    prompt(window)?.remove();
    const repeat = call("approval-two-windows");
    await visiblePrompt(second);
    is(task.pause.id, id, "Retry surfaces the same request in the frontmost window");
    ok(!prompt(window), "No prompt remains in the older window");
    choose(second, "skip");
    await repeat;
    const fresh = call("approval-frontmost-fresh");
    await visiblePrompt(second);
    ok(!prompt(window), "A fresh request also appears only in the frontmost window");
    choose(second, "skip");
    await fresh;
  } finally {
    restore();
    WhimsyAgentGuard.holdMs = original;
    if (second) {
      await BrowserTestUtils.closeWindow(second);
    }
  }
});

add_task(async function no_window_returns_actionable_error() {
  const original = WhimsyOutsideAgents.window;
  WhimsyOutsideAgents.window = () => null;
  try {
    const result = await call("approval-no-window");
    ok(result.isError && textOf(result).includes("No browser window can show"), "No invisible queue when chrome is unavailable");
  } finally {
    WhimsyOutsideAgents.window = original;
  }
});

add_task(async function tabs_list_pages_and_filters() {
  const tabs = [];
  try {
    for (let i = 0; i < 3; i++) {
      const tab = BrowserTestUtils.addTab(gBrowser, "about:blank");
      tab.label = `approval-pagination-${i}`;
      tabs.push(tab);
    }
    const args = { query: "approval-pagination-", limit: 2, windowId: window.windowUtils.outerWindowID };
    const page = JSON.parse(textOf(await call("approval-pages", "tabs_list", args)));
    is(page.tabs.length, 2, "First page is bounded");
    is(page.nextCursor, 2, "Cursor points to the next page");
    const last = JSON.parse(textOf(await call("approval-pages", "tabs_list", { ...args, cursor: page.nextCursor })));
    is(last.tabs.length, 1, "Second page has the remaining tab");
    is(last.nextCursor, null, "Final page ends pagination");
    is(new Set([...page.tabs, ...last.tabs].map(t => t.tabId)).size, 3, "Pages don't duplicate tabs");
    const defaults = JSON.parse(textOf(await call("approval-pages", "tabs_list", {})));
    ok(defaults.tabs.length <= 25, "Default list is bounded");
    ok((await call("approval-pages", "tabs_list", { limit: 0 })).isError, "Invalid limits are rejected");
  } finally {
    for (const tab of tabs) {
      await BrowserTestUtils.removeTab(tab);
    }
  }
});
