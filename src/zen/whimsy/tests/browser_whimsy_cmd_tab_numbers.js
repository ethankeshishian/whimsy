/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

const { WhimsyCmdTabNumbers: Numbers } = ChromeUtils.importESModule(
  "resource:///modules/whimsy/WhimsyCmdTabNumbers.sys.mjs"
);
const { WhimsyPrivate } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyPrivate.sys.mjs");
const root = document.documentElement;
const showing = () => root.hasAttribute("whimsy-tab-numbers");
const badge = tab => tab.querySelector(".whimsy-tab-number");
let originalSpace, startTabs, essential, pinned;

function release() {
  EventUtils.synthesizeKey("KEY_Meta", { type: "keyup" });
}
async function hold() {
  gBrowser.selectedBrowser.focus();
  EventUtils.synthesizeKey("KEY_Meta", { type: "keydown", metaKey: true });
  await TestUtils.waitForCondition(showing, "Holding Command past the shared delay reveals numbers");
}

// Negative cases wait for the production deadline, rather than asserting
// immediately before a still-pending reveal timer could have fired.
async function pastDeadline() {
  await new Promise(resolve => window.setTimeout(resolve, Numbers.HOLD_MS + 1)); // eslint-disable-line mozilla/no-arbitrary-setTimeout
  await new Promise(resolve => window.requestAnimationFrame(resolve));
}

async function assertShortcutTargets() {
  await hold();
  const tabs = [...gBrowser.visibleTabs];
  const entries = [...Numbers.targets(window)];
  for (const [tab, label] of entries) {
    is(badge(tab)?.textContent, label, "A badge marks the shortcut's actual row");
    is(badge(tab).getAttribute("aria-hidden"), "true", "Numbers are decorative");
    ok(!tab.getAttribute("aria-label")?.includes(" · 9"), "No number is added to the tab's accessible label");
  }
  // Check all nine real commands against the visible badges, not just a
  // second calculation of their order. The first digit must hide the hints
  // without consuming or changing the native shortcut.
  for (let digit = 1; digit <= 9; digit++) {
    if (!showing()) {
      await hold();
    }
    const direct = entries.find(([, label]) => label.split(" · ").includes(String(digit)));
    const expected = direct?.[0] ?? entries.find(([, label]) => label.split(" · ").includes("9"))?.[0];
    ok(expected, `A badge identifies ⌘${digit}`);
    // With content focused, Firefox waits for the remote key reply before
    // executing its <key>. Observe the real command even when a short list
    // clamps several digits to the tab that is already selected.
    // Capture is required: mainKeyset's handler passes the command event
    // to selectTabAtIndex, which stops propagation before document's bubble
    // listener can see it. waitForEvent resolves on a later main-thread turn,
    // after that handler has selected the tab.
    const keyId = digit == 9 ? "key_selectLastTab" : `key_selectTab${digit}`;
    const commanded = BrowserTestUtils.waitForEvent(document, "command", true,
      event => event.target.id == keyId);
    EventUtils.synthesizeKey(String(digit), { metaKey: true });
    ok(!showing(), "A digit hides the badges immediately");
    await commanded;
    is(gBrowser.selectedTab, expected, `⌘${digit} selected the badged tab`);
    release();
  }
  for (const tab of tabs.filter(t => !entries.some(([target]) => target == t))) {
    ok(!badge(tab) || getComputedStyle(badge(tab)).opacity == "0", "Unreachable middle tabs have no visible badge");
  }
}

add_setup(async function () {
  await SpecialPowers.pushPrefEnv({ set: [[Numbers.PREF, true]] });
  Numbers.initWindow(window);
  originalSpace = gZenWorkspaces.activeWorkspace;
  startTabs = new Set(gBrowser.tabs);
  registerCleanupFunction(async () => {
    release();
    Numbers.hide(window);
    await gZenWorkspaces.changeWorkspaceWithID(originalSpace);
    for (const tab of gBrowser.tabs.filter(t => !startTabs.has(t))) {
      if (tab.isConnected && !tab.closing) {
        if (tab.hasAttribute("zen-essential")) {
          gZenPinnedTabManager.removeEssentials(tab);
        }
        BrowserTestUtils.removeTab(tab, { animate: false });
      }
    }
  });
  essential = await BrowserTestUtils.openNewForegroundTab(gBrowser, "about:blank");
  gZenPinnedTabManager.addToEssentials(essential);
  await TestUtils.waitForCondition(() => essential.hasAttribute("zen-essential"), "An Essential exists");
  pinned = await BrowserTestUtils.openNewForegroundTab(gBrowser, "about:blank");
  gBrowser.pinTab(pinned);
  for (let i = 0; i < 11; i++) {
    await BrowserTestUtils.openNewForegroundTab(gBrowser, "about:blank");
  }
});

add_task(async function real_digits_match_badges() {
  await hold();
  ok(badge(essential), "Essentials follow the native shortcut order");
  ok(badge(pinned), "Pinned tabs follow the native shortcut order");
  release();
  await assertShortcutTargets();
});

add_task(async function cancel_on_release_key_pointer_and_blur() {
  await hold();
  release();
  ok(!showing(), "Release hides immediately");
  await hold();
  EventUtils.synthesizeKey("KEY_Shift", { type: "keydown", metaKey: true });
  ok(!showing(), "Another key hides immediately");
  EventUtils.synthesizeKey("KEY_Shift", { type: "keyup", metaKey: true });
  release();
  await hold();
  const tab = gBrowser.selectedTab;
  EventUtils.synthesizeMouseAtCenter(tab, { type: "mousedown" }, window);
  ok(!showing(), "Pointer press hides immediately");
  EventUtils.synthesizeMouseAtCenter(tab, { type: "mouseup" }, window);
  release();
  await hold();
  const other = await BrowserTestUtils.openNewBrowserWindow();
  try {
    await SimpleTest.promiseFocus(other);
    ok(!showing(), "Losing window focus hides immediately");
  } finally {
    await BrowserTestUtils.closeWindow(other);
    await SimpleTest.promiseFocus(window);
    release();
  }
});

add_task(async function quick_tap_and_chords_never_reveal() {
  EventUtils.synthesizeKey("KEY_Meta", { type: "keydown", metaKey: true });
  release();
  await pastDeadline();
  ok(!showing(), "A quick Command tap never reveals badges");
  EventUtils.synthesizeKey("KEY_Meta", { type: "keydown", metaKey: true });
  EventUtils.synthesizeKey("c", { metaKey: true });
  await pastDeadline();
  ok(!showing(), "A quick shortcut cancels the pending reveal");
  release();
  EventUtils.synthesizeKey("KEY_Shift", { type: "keydown" });
  EventUtils.synthesizeKey("KEY_Meta", { type: "keydown", metaKey: true, shiftKey: true });
  await pastDeadline();
  ok(!showing(), "Command held with another modifier never starts a reveal");
  release();
  EventUtils.synthesizeKey("KEY_Shift", { type: "keyup" });
});

add_task(async function pointer_down_before_command_and_pending_cancellation() {
  const tab = gBrowser.selectedTab;
  EventUtils.synthesizeMouseAtCenter(tab, { type: "mousedown" }, window);
  EventUtils.synthesizeKey("KEY_Meta", { type: "keydown", metaKey: true });
  await pastDeadline();
  ok(!showing(), "Command with a mouse button held never reveals numbers");
  release();
  EventUtils.synthesizeMouseAtCenter(tab, { type: "mouseup" }, window);
  EventUtils.synthesizeKey("KEY_Meta", { type: "keydown", metaKey: true });
  EventUtils.synthesizeMouseAtCenter(tab, { type: "mousedown" }, window);
  EventUtils.synthesizeMouseAtCenter(tab, { type: "mouseup" }, window);
  await pastDeadline();
  ok(!showing(), "A pointer press cancels the pending timer");
  release();
});

add_task(async function preference_disables_pending_and_visible_hints() {
  await hold();
  await SpecialPowers.pushPrefEnv({ set: [[Numbers.PREF, false]] });
  ok(!showing(), "Turning the switch off hides existing hints");
  release();
  EventUtils.synthesizeKey("KEY_Meta", { type: "keydown", metaKey: true });
  await pastDeadline();
  ok(!showing(), "No reveal while the switch is off");
  release();
  await SpecialPowers.popPrefEnv();
  EventUtils.synthesizeKey("KEY_Meta", { type: "keydown", metaKey: true });
  await SpecialPowers.pushPrefEnv({ set: [[Numbers.PREF, false]] });
  await pastDeadline();
  ok(!showing(), "Turning the switch off cancels a pending reveal");
  release();
  await SpecialPowers.popPrefEnv();
});

add_task(async function other_spaces_have_no_badges() {
  const other = await gZenWorkspaces.createAndSaveWorkspace("Tab numbers test", undefined, true);
  try {
    await gZenWorkspaces.changeWorkspaceWithID(other.uuid);
    const foreign = [];
    for (let i = 0; i < 2; i++) {
      foreign.push(await BrowserTestUtils.openNewForegroundTab(gBrowser, "about:blank"));
    }
    await assertShortcutTargets(); // Also checks Firefox's short-list clamp.
    for (let i = 0; i < 9; i++) {
      foreign.push(await BrowserTestUtils.openNewForegroundTab(gBrowser, "about:blank"));
    }
    await assertShortcutTargets();
    await gZenWorkspaces.changeWorkspaceWithID(originalSpace);
    await hold();
    for (const tab of foreign) {
      ok(!Numbers.targets(window).has(tab), "Other-space tabs are unreachable");
      ok(!badge(tab), "No stale badge on an unreachable tab");
    }
    release();
    await assertShortcutTargets();
  } finally {
    release();
    await gZenWorkspaces.changeWorkspaceWithID(originalSpace);
    await gZenWorkspaces.removeWorkspace(other.uuid);
  }
});

add_task(async function private_space_excludes_essentials() {
  document.getElementById("cmd_whimsyNewScratch").doCommand();
  await TestUtils.waitForCondition(() => WhimsyPrivate.activeSpaceIsScratch(window), "Private Space active");
  const tabs = [];
  try {
    for (let i = 0; i < 10; i++) {
      tabs.push(WhimsyPrivate.openPrivateTab(window, { url: "about:blank" }));
    }
    await hold();
    for (const tab of Numbers.targets(window).keys()) {
      ok(!tab.hasAttribute("zen-essential") && !tab.hasAttribute("zen-empty-tab"), "Only Private Space tabs are badged");
    }
    release();
    await assertShortcutTargets();
  } finally {
    release();
    for (const tab of tabs) {
      if (tab.isConnected && !tab.closing) {
        BrowserTestUtils.removeTab(tab, { animate: false });
      }
    }
    await gZenWorkspaces.changeWorkspaceWithID(originalSpace);
  }
});

add_task(async function expanded_and_compact_screenshots() {
  const expanded = root.getAttribute("zen-sidebar-expanded");
  const compact = gZenCompactModeManager.preference;
  try {
    for (const state of ["expanded", "compact"]) {
      gZenCompactModeManager.preference = state == "compact";
      root.setAttribute("zen-sidebar-expanded", state == "expanded" ? "true" : "false");
      await whimsyBothSchemes(`w24-cmdhints-${state}`, async () => {
        const flags = ["zen-has-hover", "has-popup-menu", "flash-popup", "zen-user-show"];
        const before = flags.map(attr => gNavToolbox.hasAttribute(attr));
        await hold();
        Assert.deepEqual(flags.map(attr => gNavToolbox.hasAttribute(attr)), before, "Hints never force compact mode open");
        return release;
      });
    }
  } finally {
    release();
    gZenCompactModeManager.preference = compact;
    if (expanded == null) {
      root.removeAttribute("zen-sidebar-expanded");
    } else {
      root.setAttribute("zen-sidebar-expanded", expanded);
    }
  }
});
