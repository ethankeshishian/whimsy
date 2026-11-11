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
let originalSpace, startTabs, essential, pinned, focus;

// Exercise this window's input listener directly: native synthesized keys
// can be routed to another Firefox instance by the OS during full verify.
function key(key, options = {}) {
  const { type = "keydown", ...modifiers } = options;
  window.dispatchEvent(new KeyboardEvent(type, {
    key: key.replace(/^KEY_/, ""), code: key == "KEY_Meta" ? "MetaLeft" : key,
    bubbles: true, ...modifiers,
  }));
}

function release() {
  key("KEY_Meta", { type: "keyup" });
}
async function hold() {
  key("KEY_Meta", { type: "keydown", metaKey: true });
  await TestUtils.waitForCondition(showing, "Holding Command past the shared delay reveals numbers");
}

// Negative cases wait for the production deadline, rather than asserting
// immediately before a still-pending reveal timer could have fired.
async function pastDeadline() {
  await new Promise(resolve => window.setTimeout(resolve, Numbers.HOLD_MS + 1)); // eslint-disable-line mozilla/no-arbitrary-setTimeout
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
    // Verify the native key binding and execute that key's real command,
    // including when a short list clamps digits to the already-selected tab.
    // Native keyboard routing itself requires OS focus and belongs to Firefox.
    // Capture is required: mainKeyset's handler passes the command event
    // to selectTabAtIndex, which stops propagation before document's bubble
    // listener can see it. waitForEvent resolves on a later main-thread turn,
    // after that handler has selected the tab.
    const keyId = digit == 9 ? "key_selectLastTab" : `key_selectTab${digit}`;
    const commanded = BrowserTestUtils.waitForEvent(document, "command", true,
      event => event.target.id == keyId);
    const nativeKey = document.getElementById(keyId);
    is(nativeKey.getAttribute("key"), String(digit), "The native key binds this digit");
    ok(nativeKey.getAttribute("modifiers").split(/[ ,]+/).includes("accel"), "The native shortcut uses Command");
    key(String(digit), { metaKey: true });
    nativeKey.doCommand();
    key(String(digit), { type: "keyup", metaKey: true });
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
  const { sinon } = ChromeUtils.importESModule("resource://testing-common/Sinon.sys.mjs");
  // Every task exercises delivered input in an OS-background window. Real
  // activation changes from concurrent Firefox instances cannot race a hold.
  focus = sinon.stub(Numbers, "isActiveWindow").returns(false);
  originalSpace = gZenWorkspaces.activeWorkspace;
  startTabs = new Set(gBrowser.tabs);
  registerCleanupFunction(async () => {
    release();
    Numbers.hide(window);
    focus.restore();
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

add_task(async function chrome_document_blur_preserves_hold() {
  key("KEY_Meta", { type: "keydown", metaKey: true });
  try {
    // Reproduce the window-targeted blur delivered as chrome hands focus to
    // content after a tab switch. No top-level window deactivation occurs.
    // Dispatch during the pending hold so cancelling its timer is observable.
    window.dispatchEvent(new FocusEvent("blur"));
    await TestUtils.waitForCondition(showing, "Document blur preserves the pending Command hold");
    window.dispatchEvent(new FocusEvent("blur"));
    ok(showing(), "Document blur preserves visible badges in the active window");
  } finally {
    release();
  }
  ok(!showing(), "Release still ends the hold after document blur");
});

add_task(async function cancel_on_release_key_pointer_and_deactivate() {
  await hold();
  release();
  ok(!showing(), "Release hides immediately");
  await hold();
  key("KEY_Shift", { type: "keydown", metaKey: true });
  ok(!showing(), "Another key hides immediately");
  key("KEY_Shift", { type: "keyup", metaKey: true });
  release();
  await hold();
  const tab = gBrowser.selectedTab;
  tab.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, buttons: 1 }));
  ok(!showing(), "Pointer press hides immediately");
  tab.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, buttons: 0 }));
  release();
  // Model activation transitions without competing for the OS-active window.
  focus.returns(true);
  try {
    await hold();
    focus.returns(false);
    window.dispatchEvent(new Event("deactivate"));
    ok(!showing(), "Losing window activation hides immediately");
    key("KEY_Meta", { metaKey: true });
    window.dispatchEvent(new Event("deactivate"));
    await TestUtils.waitForCondition(showing, "Keys delivered without activation survive pending deactivation");
    window.dispatchEvent(new Event("deactivate"));
    ok(showing(), "Keys delivered without activation survive visible deactivation");
    // No keyup and no activation transition: a new non-repeat keydown is
    // evidence of a new physical press and must repair the missed release.
    key("KEY_Meta", { metaKey: true });
    ok(!showing(), "A fresh press starts a fresh delay after a missed release");
    await TestUtils.waitForCondition(showing, "A missed release cannot block the next Command hold");
  } finally {
    focus.returns(false);
    release();
  }
  await hold();
  release();
});

add_task(async function quick_tap_and_chords_never_reveal() {
  key("KEY_Meta", { type: "keydown", metaKey: true });
  release();
  await pastDeadline();
  ok(!showing(), "A quick Command tap never reveals badges");
  key("KEY_Meta", { type: "keydown", metaKey: true });
  key("c", { metaKey: true });
  key("c", { type: "keyup", metaKey: true });
  await pastDeadline();
  ok(!showing(), "A quick shortcut cancels the pending reveal");
  release();
  key("c");
  key("KEY_Meta", { metaKey: true });
  await pastDeadline();
  ok(!showing(), "A non-modifier already held prevents a reveal");
  key("c", { type: "keyup", metaKey: true });
  release();
  key("KEY_Shift", { type: "keydown" });
  key("KEY_Meta", { type: "keydown", metaKey: true, shiftKey: true });
  await pastDeadline();
  ok(!showing(), "Command held with another modifier never starts a reveal");
  release();
  key("KEY_Shift", { type: "keyup" });
});

add_task(async function pointer_down_before_command_and_pending_cancellation() {
  const tab = gBrowser.selectedTab;
  tab.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, buttons: 1 }));
  key("KEY_Meta", { type: "keydown", metaKey: true });
  await pastDeadline();
  ok(!showing(), "Command with a mouse button held never reveals numbers");
  release();
  tab.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, buttons: 0 }));
  key("KEY_Meta", { type: "keydown", metaKey: true });
  tab.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, buttons: 1 }));
  tab.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, buttons: 0 }));
  await pastDeadline();
  ok(!showing(), "A pointer press cancels the pending timer");
  release();
});

add_task(async function preference_disables_pending_and_visible_hints() {
  await hold();
  await SpecialPowers.pushPrefEnv({ set: [[Numbers.PREF, false]] });
  ok(!showing(), "Turning the switch off hides existing hints");
  release();
  key("KEY_Meta", { type: "keydown", metaKey: true });
  await pastDeadline();
  ok(!showing(), "No reveal while the switch is off");
  release();
  await SpecialPowers.popPrefEnv();
  key("KEY_Meta", { type: "keydown", metaKey: true });
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
