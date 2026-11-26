/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// wave7/small: lazy init. A new window gets its shortcuts and visible parts
// at once and its command-bar-only parts once it's idle; with
// whimsy.startup.lazy-init off, everything starts at once.

const EARLY = ["key_whimsyCopyFullPage", "cmd_whimsyCapturePortrait"];
const DEFERRED = ["cmd_whimsyCast", "cmd_whimsyCreateEmailAlias", "whimsy-cookie-editor"];

// Zen's window sync mirrors each new window's first tab into this one; the
// mirrors outlive the test windows, so remove them like other tests do.
const tabsBefore = new Set(gBrowser.tabs);
registerCleanupFunction(() => {
  for (const tab of gBrowser.tabs.filter(t => !tabsBefore.has(t))) {
    BrowserTestUtils.removeTab(tab);
  }
});

async function initialized(win) {
  // A boolean: waitForCondition awaits a returned promise, and this one
  // resolves to undefined.
  await TestUtils.waitForCondition(() => !!win.whimsyDeferredInit, "Whimsy started in the new window");
}

add_task(async function test_deferred_parts_arrive_when_idle() {
  const win = await BrowserTestUtils.openNewBrowserWindow();
  await initialized(win);
  for (const id of EARLY) {
    ok(win.document.getElementById(id), `${id} is there from the start`);
  }
  await win.whimsyDeferredInit;
  for (const id of DEFERRED) {
    ok(win.document.getElementById(id), `${id} arrived once the window was idle`);
  }
  await BrowserTestUtils.closeWindow(win);
});

add_task(async function test_switch_off_starts_everything_at_once() {
  await SpecialPowers.pushPrefEnv({ set: [["whimsy.startup.lazy-init", false]] });
  const win = await BrowserTestUtils.openNewBrowserWindow();
  await initialized(win);
  for (const id of [...EARLY, ...DEFERRED]) {
    ok(win.document.getElementById(id), `${id} is there at once`);
  }
  await BrowserTestUtils.closeWindow(win);
  await SpecialPowers.popPrefEnv();
});

add_task(async function test_closing_before_idle_is_harmless() {
  const win = await BrowserTestUtils.openNewBrowserWindow();
  await initialized(win);
  const done = win.whimsyDeferredInit;
  await BrowserTestUtils.closeWindow(win);
  await done;
  ok(true, "The deferred init settles even for a window that closed");
});

// W32 perf: tiers. Fewer steps run in initWindow; the idle ones' commands
// still arrive, and the tab card starts on the first tab hover and works.
const { WhimsyPerfMarks } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyPerfMarks.sys.mjs");
const { WhimsyHoverCards } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyHoverCards.sys.mjs");
const IDLE = ["cmd_whimsyPasteGuard", "cmd_whimsyAIDraftReply", "cmd_whimsyOpenHomeSettings", "whimsy-ai-summarize-page"];

function stepsOf(win) {
  const record = WhimsyPerfMarks.forWindow(win);
  ok(record, "The window's init was timed");
  return record;
}

add_task(async function test_fewer_steps_run_at_once() {
  await SpecialPowers.pushPrefEnv({ set: [["whimsy.perf.marks", true], ["whimsy.startup.lazy-init", false]] });
  const eagerWin = await BrowserTestUtils.openNewBrowserWindow();
  await initialized(eagerWin);
  await eagerWin.whimsyDeferredInit;
  const eager = stepsOf(eagerWin);
  is(eager.planned["first-use"], 0, "With lazy init off nothing waits for its first use");
  const all = eager.planned.window + eager.planned.idle;
  is(eager.ran.window + eager.ran.idle, all, "and every step ran within initWindow");
  is(eager.steps.find(s => s.name == "hover-cards")?.tier, "window", "and the tab card starts at once");
  await BrowserTestUtils.closeWindow(eagerWin);
  await SpecialPowers.popPrefEnv();

  await SpecialPowers.pushPrefEnv({ set: [["whimsy.perf.marks", true]] });
  const win = await BrowserTestUtils.openNewBrowserWindow();
  await initialized(win);
  const lazy = stepsOf(win);
  Assert.less(lazy.planned.window, eager.planned.window, "Fewer steps run in initWindow");
  is(lazy.planned.window + lazy.planned.idle + lazy.planned["first-use"], all, "and none is lost");
  Assert.greaterOrEqual(lazy.planned["first-use"], 1, "Some wait for their first use");
  // W32 added the settings, paste guard, draft reply, Ask on Page and
  // update steps to the 21 that waited before.
  Assert.greater(lazy.planned.idle, 21, "More steps wait for idle than before");
  ok(Number.isFinite(lazy.initMs), "initWindow's own time is measured");
  await win.whimsyDeferredInit;
  for (const id of [...IDLE, ...DEFERRED]) {
    ok(win.document.getElementById(id), `${id} arrived once the window was idle`);
  }
  for (const name of ["settings-commands", "paste-guard", "ask-on-page", "hover-cards"]) {
    ok(!stepsOf(win).steps.some(s => s.name == name && s.tier == "window"), `${name} didn't run in initWindow`);
  }
  ok(JSON.parse(JSON.stringify(WhimsyPerfMarks.snapshot())).windows.length, "The snapshot is plain JSON");

  // The first hover starts the tab card, and that same hover reaches it.
  const tab = win.gBrowser.selectedTab;
  tab.dispatchEvent(new CustomEvent("TabHoverStart", { bubbles: true }));
  is(stepsOf(win).steps.find(s => s.name == "hover-cards")?.tier, "first-use", "The tab card started on first use");
  const card = WhimsyHoverCards.forWindow(win);
  ok(card, "The window has its tab card");
  is(card.tab, tab, "and it's on the hovered tab");
  card.hide();
  tab.dispatchEvent(new CustomEvent("TabHoverEnd", { bubbles: true }));
  is(stepsOf(win).steps.filter(s => s.name == "hover-cards").length, 1, "It starts once");

  // A find bar opened in the window gets Ask on Page.
  const findbar = await win.gBrowser.getFindBar();
  ok(findbar, "The find bar opened");
  ok(win.document.getElementById("whimsy-find-options"), "with the find card's command");
  is(stepsOf(win).steps.filter(s => s.name == "ask-on-page").length, 1, "Ask on Page started once");

  await BrowserTestUtils.closeWindow(win);
  await SpecialPowers.popPrefEnv();
});
