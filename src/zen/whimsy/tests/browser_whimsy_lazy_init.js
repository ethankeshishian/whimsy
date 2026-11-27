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

// w32: a command reached with no key or click (AppleScript, a whimsy://
// command, the agent, a menu VoiceOver opens) still finds an idle-tier
// command: the registry runs the window's idle steps first, once.
add_task(async function test_registry_runs_idle_steps_first() {
  const { WhimsyCommands } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyCommands.sys.mjs");
  const { WhimsyPasteGuard } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyPasteGuard.sys.mjs");
  registerCleanupFunction(() => Services.prefs.clearUserPref(WhimsyPasteGuard.ENABLED_PREF));
  const id = "cmd_whimsyPasteGuard";
  const wasOn = WhimsyPasteGuard.active;
  await SpecialPowers.pushPrefEnv({ set: [["whimsy.perf.marks", true]] });
  let seen = null;
  // Runs the command right after the new window's initWindow returns (a
  // microtask after it sets whimsyDeferredInit), before any idle callback.
  const observer = (subject, topic) => {
    if (topic != "domwindowopened") {
      return;
    }
    Services.ww.unregisterNotification(observer);
    let value;
    Object.defineProperty(subject, "whimsyDeferredInit", {
      configurable: true,
      get: () => value,
      set(promise) {
        value = promise;
        Promise.resolve().then(() => {
          const before = !!subject.document.getElementById(id);
          seen = { before, ran: WhimsyCommands.run(subject, id), after: !!subject.document.getElementById(id) };
        });
      },
    });
  };
  Services.ww.registerNotification(observer);
  const win = await BrowserTestUtils.openNewBrowserWindow();
  await TestUtils.waitForCondition(() => !!seen, "The command ran in the new window");
  ok(!seen.before, "The command was still waiting for the window to be idle");
  ok(seen.ran, "Running it through the registry succeeded");
  ok(seen.after, "and the window has the command");
  is(WhimsyPasteGuard.active, !wasOn, "The command did what it does");
  // forWindow returns a copy, so each check reads the steps afresh.
  const steps = () => stepsOf(win).steps;
  is(steps().filter(s => s.name == "paste-guard").length, 1, "Its step ran once");
  ok(!steps().some(s => s.name == "paste-guard" && s.tier == "window"), "and not in initWindow");
  await win.whimsyDeferredInit;
  is(steps().filter(s => s.name == "paste-guard").length, 1, "The idle callback didn't run it again");
  WhimsyCommands.ready(win);
  is(steps().filter(s => s.name == "settings-commands").length, 1, "Every idle step ran once");
  await BrowserTestUtils.closeWindow(win);
  await SpecialPowers.popPrefEnv();
});
