/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// Fire button: one press ends the session, closing its tabs and clearing
// what they left, so you can start fresh. Pinned tabs and Essentials stay
// open (their data is still cleared). The real ForgetAboutSite /
// Services.clearData calls are stubbed or recorded so the shared test
// profile isn't wiped.

const { WhimsyFireButton } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyFireButton.sys.mjs");

const startTabs = new Set(gBrowser.tabs);
registerCleanupFunction(() => {
  for (const tab of gBrowser.tabs.filter(t => !startTabs.has(t))) {
    if (tab.isConnected && !tab.closing) {
      if (tab.pinned) {
        gBrowser.unpinTab(tab);
      }
      BrowserTestUtils.removeTab(tab);
    }
  }
});

add_task(function test_closable_tabs_excludes_pinned_and_essentials() {
  const fakeEssential = { pinned: false, closing: false, hasAttribute: name => name == "zen-essential" };
  const fakePinned = { pinned: true, closing: false, hasAttribute: () => false };
  const fakeNormal = { pinned: false, closing: false, hasAttribute: () => false };
  const result = WhimsyFireButton.closableTabs(window, [fakeEssential, fakePinned, fakeNormal]);
  is(result.length, 1, "Only the plain tab is closable");
  is(result[0], fakeNormal, "...and it's the right one");
});

add_task(async function test_burn_tabs_closes_only_closable_ones() {
  const pinned = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.com/?pinned-survivor");
  gBrowser.pinTab(pinned);
  const plain = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.com/?burn-me");
  const before = gBrowser.tabs.length;

  WhimsyFireButton.burnTabs(window, [pinned, plain], "test");

  await TestUtils.waitForCondition(() => gBrowser.tabs.length == before - 1, "Only the plain tab closed");
  ok(pinned.isConnected, "The pinned tab survived");
  ok(!plain.isConnected, "The plain tab didn't");
});

// wave7/fire: the sheet serves the Fire Button's point (end the session,
// start fresh): two rows, ending this space's session first, then
// Everything (red). Each row says how many tabs it closes; the note under
// them says exactly what's cleared and kept. Closing the sheet burns nothing.
add_task(async function test_fire_sheet() {
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.com/?fire-sheet");
  const expected = WhimsyFireButton.closableTabs(window, WhimsyFireButton.spaceTabs(window)).length;
  ok(WhimsyFireButton.spaceTabs(window).includes(tab), "The new tab is in this space's session");
  const shown = BrowserTestUtils.waitForEvent(document, "popupshown", true, e => e.target.id == "whimsyFirePanel");
  WhimsyFireButton.openPanel(window);
  await shown;
  const panel = document.getElementById("whimsyFirePanel");
  ok(panel.classList.contains("whimsy-sheet"), "It is a Whimsy sheet");
  const scopes = [...panel.querySelectorAll(".whimsy-fire-scope")].map(i => i.getAttribute("whimsy-fire-scope"));
  Assert.deepEqual(scopes, ["session", "everything"], "Two choices: this session, then everything");
  const session = panel.querySelector('[whimsy-fire-scope="session"]');
  is(document.l10n.getAttributes(session.querySelector(".whimsy-sheet-item-title")).id, "whimsy-fire-session",
    "The first row says it closes tabs and clears the last hour");
  is(document.l10n.getAttributes(session.querySelector(".whimsy-sheet-item-subtitle")).args.count, expected,
    "...and counts the tabs it will close");
  ok(panel.querySelector('[whimsy-fire-scope="everything"]').hasAttribute("destructive"), "Everything is marked destructive");
  const summary = panel.querySelector("#whimsy-fire-summary");
  is(document.l10n.getAttributes(summary).id, "whimsy-fire-session-summary", "The note spells out the chosen row");
  await TestUtils.waitForCondition(() => summary.textContent.includes("last hour"), "...in words");
  ok(/history, cookies, site data and cache/.test(summary.textContent), "...naming what goes");
  ok(summary.textContent.includes("Pinned tabs"), "...and what stays");
  for (const id of ["site", "last-15-min", "space"]) {
    ok(!panel.querySelector(`[whimsy-fire-scope="${id}"]`), `No "${id}" row any more`);
  }

  const hidden = BrowserTestUtils.waitForEvent(panel, "popuphidden");
  panel.querySelector(".whimsy-sheet-close").doCommand();
  await hidden;
  ok(tab.isConnected, "Closing the sheet burns nothing");
  BrowserTestUtils.removeTab(tab);
});

// wave7/fire: per-site forgetting left the sheet but stays reachable as the
// "Forget About This Site…" command (only on a website), which names the
// site and asks first with Cancel as the default. Return there forgets
// nothing.
add_task(async function test_forget_site_is_a_command_that_confirms() {
  const { WhimsyCommands } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyCommands.sys.mjs");
  ok(WhimsyCommands.get("cmd_whimsyForgetSite"), "Forget About This Site… is a registered command");
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://www.example.com/?forget-site");
  const original = WhimsyFireButton.burnSite;
  let burned = 0;
  WhimsyFireButton.burnSite = async () => {
    burned++;
    return 0;
  };
  try {
    const dialogOpen = BrowserTestUtils.promiseAlertDialogOpen();
    const forgetting = WhimsyFireButton.forgetSite(window);
    const dialogWin = await dialogOpen;
    is(dialogWin.Dialog.args.defaultButtonNum, 1, "Cancel is the default button");
    ok(dialogWin.Dialog.args.title.includes("example.com"), "The question names the base domain");
    ok(dialogWin.Dialog.args.text.includes("subdomains"), "...and says subdomains and tabs go too");
    EventUtils.synthesizeKey("KEY_Enter", {}, dialogWin);
    await forgetting;
    is(burned, 0, "Return forgets nothing");
    ok(tab.isConnected, "...and closes nothing");
  } finally {
    WhimsyFireButton.burnSite = original;
    BrowserTestUtils.removeTab(tab);
  }
});

// wave5/uxfix: the flame flash stays under Zen's toasts, and reduced motion
// drops it entirely (the toast confirms instead).
add_task(async function test_fire_flash_layering_and_reduced_motion() {
  const root = document.documentElement;
  root.setAttribute("whimsy-fire-burning", "");
  try {
    const flash = getComputedStyle(root, "::after");
    Assert.less(Number(flash.zIndex), 1000, "The flash sits below Zen's toast layer");
    await SpecialPowers.pushPrefEnv({ set: [["ui.prefersReducedMotion", 1]] });
    await TestUtils.waitForCondition(() => getComputedStyle(root, "::after").display == "none",
      "Reduced motion hides the flash");
    await SpecialPowers.popPrefEnv();
  } finally {
    root.removeAttribute("whimsy-fire-burning");
  }
});

// wave5/uxfix: rows only choose a scope. Focus starts on the list, Return on
// a row clears nothing, and only the red footer button runs it, followed
// by a toast saying what closed and what was cleared. burnSession is
// stubbed (it would clear the shared profile's last hour) but closes the
// space's tabs for real.
add_task(async function test_fire_needs_the_explicit_button() {
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.com/?fire-explicit");
  const original = WhimsyFireButton.burnSession;
  let burned = 0;
  WhimsyFireButton.burnSession = async win => {
    burned++;
    return WhimsyFireButton.burnTabs(win, [tab], "session");
  };
  try {
    const shown = BrowserTestUtils.waitForEvent(document, "popupshown", true, e => e.target.id == "whimsyFirePanel");
    WhimsyFireButton.openPanel(window);
    await shown;
    const panel = document.getElementById("whimsyFirePanel");
    const session = panel.querySelector('[whimsy-fire-scope="session"]');
    await TestUtils.waitForCondition(() => document.activeElement == session, "Focus starts on the first row");
    is(session.getAttribute("role"), "radio", "Rows are radios");
    is(session.getAttribute("aria-checked"), "true", "Ending this session starts chosen");
    const forget = panel.querySelector("#whimsy-fire-forget");
    ok(forget.hasAttribute("destructive"), "The action is the red footer button");
    is(document.l10n.getAttributes(forget).id, "whimsy-fire-forget-session", "It says it closes tabs and clears");

    EventUtils.synthesizeKey("KEY_Enter", {}, window);
    is(panel.state, "open", "Return on a row keeps the sheet open");
    is(burned, 0, "...and clears nothing");

    const everything = panel.querySelector('[whimsy-fire-scope="everything"]');
    everything.doCommand();
    is(everything.getAttribute("aria-checked"), "true", "Choosing the other row moves the choice");
    is(session.getAttribute("aria-checked"), "false", "...off the first");
    is(document.l10n.getAttributes(forget).id, "whimsy-fire-forget-everything", "The button follows the choice");
    is(document.l10n.getAttributes(panel.querySelector("#whimsy-fire-summary")).id, "whimsy-fire-everything-summary",
      "...and so does the note");

    session.doCommand();
    const hidden = BrowserTestUtils.waitForEvent(panel, "popuphidden");
    const toastShown = TestUtils.waitForCondition(() =>
      [...document.querySelectorAll("#zen-toast-container label")].some(l =>
        document.l10n.getAttributes(l).id == "whimsy-fire-done-session"),
    "A toast says what closed and what was cleared");
    forget.doCommand();
    await hidden;
    await TestUtils.waitForCondition(() => !tab.isConnected, "The space's tabs close");
    is(burned, 1, "It ran once");
    await toastShown;
  } finally {
    WhimsyFireButton.burnSession = original;
    if (tab.isConnected) {
      BrowserTestUtils.removeTab(tab);
    }
  }
});

// wave7/fire: ending the session clears the last hour (time-scoped, never
// all time) and closes only this space's unpinned tabs. clearData is
// recorded, not run, so the shared profile keeps its data; the flags are
// exactly what the sheet names.
add_task(async function test_burn_session_clears_the_last_hour_and_this_space() {
  const C = Ci.nsIClearDataService;
  is(WhimsyFireButton.forgetFlags, C.CLEAR_HISTORY | C.CLEAR_COOKIES_AND_SITE_DATA | C.CLEAR_ALL_CACHES,
    "It clears history, cookies, site data and cache, as the sheet says");
  const pinned = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.com/?session-pinned");
  gBrowser.pinTab(pinned);
  const plain = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.com/?session-plain");
  const calls = [];
  const original = WhimsyFireButton.clearData;
  WhimsyFireButton.clearData = async sinceMs => {
    calls.push(sinceMs);
  };
  try {
    const closed = await WhimsyFireButton.burnSession(window);
    Assert.deepEqual(calls, [60 * 60 * 1000], "One clear, of the last hour");
    Assert.greaterOrEqual(closed, 1, "It reports the tabs it closed");
    await TestUtils.waitForCondition(() => !plain.isConnected, "This space's plain tab closes");
    ok(pinned.isConnected, "The pinned tab stays");
  } finally {
    WhimsyFireButton.clearData = original;
    gBrowser.unpinTab(pinned);
    BrowserTestUtils.removeTab(pinned);
  }
});

// wave7/ux: "Everything" can't be undone, so the Forget button asks once
// more in the window's own dialog (as Delete Space does), with Cancel as
// the default. Return there forgets nothing; only "Forget Everything" runs
// it, and then the toast says what went. burnEverything is stubbed so the
// shared test profile isn't wiped.
add_task(async function test_fire_everything_confirms_with_cancel_default() {
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.com/?fire-everything");
  const original = WhimsyFireButton.burnEverything;
  let burned = 0;
  WhimsyFireButton.burnEverything = async () => {
    burned++;
    return 0;
  };
  try {
    async function openEverything() {
      const shown = BrowserTestUtils.waitForEvent(document, "popupshown", true, e => e.target.id == "whimsyFirePanel");
      WhimsyFireButton.openPanel(window);
      await shown;
      const panel = document.getElementById("whimsyFirePanel");
      panel.querySelector('[whimsy-fire-scope="everything"]').doCommand();
      is(panel.dataset.scope, "everything", "Everything is chosen");
      return panel;
    }

    // Return in the dialog picks Cancel.
    let panel = await openEverything();
    let dialogOpen = BrowserTestUtils.promiseAlertDialogOpen();
    let forgetting = WhimsyFireButton.forget(window, panel);
    let dialogWin = await dialogOpen;
    is(dialogWin.Dialog.args.defaultButtonNum, 1, "Cancel is the default button");
    const dialogEl = dialogWin.document.querySelector("dialog");
    is(dialogEl.defaultButton, "cancel", "...so Return cancels");
    is(dialogEl.getButton("accept").label, "Clear Everything", "The accept button names the action");
    EventUtils.synthesizeKey("KEY_Enter", {}, dialogWin);
    await forgetting;
    is(burned, 0, "Return in the confirm forgets nothing");
    ok(tab.isConnected, "...and closes no tabs");

    // The explicit button runs it, and the toast reports it.
    panel = await openEverything();
    dialogOpen = BrowserTestUtils.promiseAlertDialogOpen();
    const toastShown = TestUtils.waitForCondition(() =>
      [...document.querySelectorAll("#zen-toast-container label")].some(l =>
        document.l10n.getAttributes(l).id == "whimsy-fire-done-everything"),
    "A toast says everything was forgotten");
    forgetting = WhimsyFireButton.forget(window, panel);
    dialogWin = await dialogOpen;
    dialogWin.document.querySelector("dialog").getButton("accept").click();
    await forgetting;
    is(burned, 1, "Forget Everything runs once accepted");
    await toastShown;
  } finally {
    WhimsyFireButton.burnEverything = original;
    BrowserTestUtils.removeTab(tab);
  }
});

// wave7/ux: ending the session doesn't ask again; the sheet's explicit
// button (which names it) is enough.
add_task(async function test_fire_session_does_not_confirm() {
  const original = WhimsyFireButton.confirmEverything;
  let asked = 0;
  WhimsyFireButton.confirmEverything = async () => {
    asked++;
    return false;
  };
  const originalSession = WhimsyFireButton.burnSession;
  WhimsyFireButton.burnSession = async () => 0;
  try {
    const shown = BrowserTestUtils.waitForEvent(document, "popupshown", true, e => e.target.id == "whimsyFirePanel");
    WhimsyFireButton.openPanel(window);
    await shown;
    const panel = document.getElementById("whimsyFirePanel");
    await WhimsyFireButton.forget(window, panel);
    is(asked, 0, "Ending the session doesn't ask a second time");
  } finally {
    WhimsyFireButton.confirmEverything = original;
    WhimsyFireButton.burnSession = originalSession;
  }
});
