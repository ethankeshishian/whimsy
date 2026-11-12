/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

const { WhimsyCmdTabNumbers: Numbers } = ChromeUtils.importESModule(
  "resource:///modules/whimsy/WhimsyCmdTabNumbers.sys.mjs"
);
const { WhimsyPrivate } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyPrivate.sys.mjs");
const { WhimsySpaceSwitchQueue } = ChromeUtils.importESModule(
  "resource:///modules/whimsy/WhimsySpaceSwitchQueue.sys.mjs"
);
let win, root;
const showing = () => root.hasAttribute("whimsy-tab-numbers");
const badge = tab => Numbers.hint(win, tab);
let originalSpace, startTabs, mainStartTabs, essential, pinned, focus;

// A space switch sets activeWorkspace first and selects its tab when the
// slide ends; queued switches play after it. Wait for all of that, so a tab
// opened or a hint read afterwards sees the space the test asked for.
async function settled(what) {
  await TestUtils.waitForCondition(
    () => !win.gZenWorkspaces.isChangingWorkspace && !WhimsySpaceSwitchQueue.isSwitching(win),
    what
  );
}

// Exercise this window's input listener directly: native synthesized keys
// can be routed to another Firefox instance by the OS during full verify.
function key(key, options = {}) {
  const { type = "keydown", ...modifiers } = options;
  win.dispatchEvent(new win.KeyboardEvent(type, {
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
  await new Promise(resolve => win.setTimeout(resolve, Numbers.HOLD_MS + 1)); // eslint-disable-line mozilla/no-arbitrary-setTimeout
}

async function assertShortcutTargets() {
  await hold();
  const tabs = [...win.gBrowser.visibleTabs];
  const entries = [...Numbers.targets(win)];
  for (const [tab, label] of entries) {
    is(badge(tab)?.textContent, label, "A badge marks the shortcut's actual row");
    is(badge(tab).className, "hint", "Each number is a ⌘J link hint");
    is(badge(tab).getRootNode().host.getAttribute("aria-hidden"), "true", "Numbers are decorative");
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
    const commanded = BrowserTestUtils.waitForEvent(win.document, "command", true,
      event => event.target.id == keyId);
    const nativeKey = win.document.getElementById(keyId);
    is(nativeKey.getAttribute("key"), String(digit), "The native key binds this digit");
    ok(nativeKey.getAttribute("modifiers").split(/[ ,]+/).includes("accel"), "The native shortcut uses Command");
    key(String(digit), { metaKey: true });
    nativeKey.doCommand();
    key(String(digit), { type: "keyup", metaKey: true });
    ok(!showing(), "A digit hides the badges immediately");
    await commanded;
    is(win.gBrowser.selectedTab, expected, `⌘${digit} selected the badged tab`);
    release();
  }
  for (const tab of tabs.filter(t => !entries.some(([target]) => target == t))) {
    ok(!badge(tab), "Unreachable middle tabs have no hint");
  }
}

add_setup(async function () {
  await SpecialPowers.pushPrefEnv({ set: [[Numbers.PREF, true]] });
  mainStartTabs = new Set(gBrowser.tabs);
  // The suite's main window has already received other tests' key/pointer
  // events. A fresh window gives this input-listener test a fresh hold state.
  win = await BrowserTestUtils.openNewBrowserWindow();
  registerCleanupFunction(async () => {
    release();
    Numbers.hide(win);
    focus?.restore();
    try {
      if (originalSpace) {
        await win.gZenWorkspaces.changeWorkspaceWithID(originalSpace);
      }
      for (const tab of [...win.gBrowser.tabs]) {
        if (startTabs && !startTabs.has(tab) && !tab.closing) {
          if (tab.hasAttribute("zen-essential")) {
            win.gZenPinnedTabManager.removeEssentials(tab);
          }
          await BrowserTestUtils.removeTab(tab, { animate: false });
        }
      }
    } finally {
      await BrowserTestUtils.closeWindow(win);
      // Pinned tabs and Essentials are mirrored into the main window; drop
      // any copy whose original was closed with this window.
      for (const tab of [...gBrowser.tabs]) {
        if (mainStartTabs && !mainStartTabs.has(tab) && !tab.closing) {
          if (tab.hasAttribute("zen-essential")) {
            gZenPinnedTabManager.removeEssentials(tab);
          }
          await BrowserTestUtils.removeTab(tab, { animate: false });
        }
      }
    }
  });
  root = win.document.documentElement;
  await win.gZenWorkspaces.promiseInitialized;
  win.gURLBar.view.close();
  await TestUtils.waitForCondition(() => !win.gURLBar.view.isOpen, "The command bar is closed before holding Command");
  Numbers.initWindow(win);
  const { sinon } = ChromeUtils.importESModule("resource://testing-common/Sinon.sys.mjs");
  // Every task exercises delivered input in an OS-background window. Real
  // activation changes from concurrent Firefox instances cannot race a hold.
  focus = sinon.stub(Numbers, "isActiveWindow").returns(false);
  originalSpace = win.gZenWorkspaces.activeWorkspace;
  startTabs = new Set(win.gBrowser.tabs);
  essential = await BrowserTestUtils.openNewForegroundTab(win.gBrowser, "about:blank");
  win.gZenPinnedTabManager.addToEssentials(essential);
  await TestUtils.waitForCondition(() => essential.hasAttribute("zen-essential"), "An Essential exists");
  pinned = await BrowserTestUtils.openNewForegroundTab(win.gBrowser, "about:blank");
  win.gBrowser.pinTab(pinned);
  for (let i = 0; i < 11; i++) {
    await BrowserTestUtils.openNewForegroundTab(win.gBrowser, "about:blank");
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
    win.dispatchEvent(new win.FocusEvent("blur"));
    await TestUtils.waitForCondition(showing, "Document blur preserves the pending Command hold");
    win.dispatchEvent(new win.FocusEvent("blur"));
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
  const tab = win.gBrowser.selectedTab;
  tab.dispatchEvent(new win.PointerEvent("pointerdown", { bubbles: true, buttons: 1 }));
  ok(!showing(), "Pointer press hides immediately");
  tab.dispatchEvent(new win.PointerEvent("pointerup", { bubbles: true, buttons: 0 }));
  release();
  await hold();
  win.dispatchEvent(new win.MouseEvent("mousemove", { bubbles: true, metaKey: true }));
  ok(showing(), "Moving the pointer while Command is held keeps the numbers");
  win.dispatchEvent(new win.MouseEvent("mousemove", { bubbles: true }));
  ok(!showing(), "Any later input with Command up repairs a missed release");
  release();
  // Model activation transitions without competing for the OS-active window.
  focus.returns(true);
  try {
    await hold();
    focus.returns(false);
    win.dispatchEvent(new win.Event("deactivate"));
    ok(!showing(), "Losing win activation hides immediately");
    await TestUtils.waitForCondition(() => win.getComputedStyle(Numbers.layer(win)).opacity == "0",
      "Window blur while Command is held fades the hints out");
    key("KEY_Meta", { metaKey: true });
    win.dispatchEvent(new win.Event("deactivate"));
    await TestUtils.waitForCondition(showing, "Keys delivered without activation survive pending deactivation");
    win.dispatchEvent(new win.Event("deactivate"));
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

// Real key synthesis routed by focus (web page, URL bar, sidebar), not a
// window-dispatched event: the release must fade the badges out to opacity 0.
add_task(async function release_fades_out_in_every_focus_state() {
  const tab = await BrowserTestUtils.openNewForegroundTab(win.gBrowser,
    "data:text/html,<input id=field>");
  const browser = tab.linkedBrowser;
  const faded = () => win.getComputedStyle(Numbers.layer(win)).opacity == "0";
  const synth = type => EventUtils.synthesizeKey("KEY_Meta", { type }, win);
  const focusers = {
    async page() {
      browser.focus();
      await SpecialPowers.spawn(browser, [], () => content.document.getElementById("field").focus());
      await TestUtils.waitForCondition(() => win.document.activeElement == browser, "The web page has focus");
    },
    async urlbar() {
      win.gURLBar.inputField.focus();
      await TestUtils.waitForCondition(() => win.gURLBar.focused, "The URL bar has focus");
      win.gURLBar.view.close();
    },
    async sidebar() {
      win.gBrowser.selectedTab.focus();
      await TestUtils.waitForCondition(() => win.gNavToolbox.contains(win.document.activeElement),
        "The sidebar has focus");
    },
  };
  try {
    for (const [where, focusIt] of Object.entries(focusers)) {
      await focusIt();
      let contentKeyup;
      if (where == "page") {
        contentKeyup = SpecialPowers.spawn(browser, [], () => new Promise(resolve =>
          content.addEventListener("keyup", e => e.key == "Meta" && resolve(), { once: false })));
      }
      synth("keydown");
      await TestUtils.waitForCondition(showing, `Holding Command with the ${where} focused reveals numbers`);
      await TestUtils.waitForCondition(() => !faded(), `Badges are visible with the ${where} focused`);
      synth("keyup");
      if (contentKeyup) {
        await contentKeyup;
        ok(true, "The release went through the web page");
      }
      await TestUtils.waitForCondition(faded, `Releasing Command with the ${where} focused fades the badges out`);
      ok(!showing(), `The hold ended with the ${where} focused`);
    }
  } finally {
    synth("keyup");
    release();
    await BrowserTestUtils.removeTab(tab, { animate: false });
  }
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
  const tab = win.gBrowser.selectedTab;
  tab.dispatchEvent(new win.PointerEvent("pointerdown", { bubbles: true, buttons: 1 }));
  key("KEY_Meta", { type: "keydown", metaKey: true });
  await pastDeadline();
  ok(!showing(), "Command with a mouse button held never reveals numbers");
  release();
  tab.dispatchEvent(new win.PointerEvent("pointerup", { bubbles: true, buttons: 0 }));
  key("KEY_Meta", { type: "keydown", metaKey: true });
  tab.dispatchEvent(new win.PointerEvent("pointerdown", { bubbles: true, buttons: 1 }));
  tab.dispatchEvent(new win.PointerEvent("pointerup", { bubbles: true, buttons: 0 }));
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
  const other = await win.gZenWorkspaces.createAndSaveWorkspace("Tab numbers test", undefined, true);
  try {
    await win.gZenWorkspaces.changeWorkspaceWithID(other.uuid);
    const foreign = [];
    for (let i = 0; i < 2; i++) {
      foreign.push(await BrowserTestUtils.openNewForegroundTab(win.gBrowser, "about:blank"));
    }
    await assertShortcutTargets(); // Also checks Firefox's short-list clamp.
    for (let i = 0; i < 9; i++) {
      foreign.push(await BrowserTestUtils.openNewForegroundTab(win.gBrowser, "about:blank"));
    }
    await assertShortcutTargets();
    await win.gZenWorkspaces.changeWorkspaceWithID(originalSpace);
    await hold();
    for (const tab of foreign) {
      ok(!Numbers.targets(win).has(tab), "Other-space tabs are unreachable");
      ok(!badge(tab), "No stale badge on an unreachable tab");
    }
    release();
    await assertShortcutTargets();
    // Hold Command through a space switch, then release in the new space:
    // the hints follow the current space and no space keeps any.
    const faded = () => win.getComputedStyle(Numbers.layer(win)).opacity == "0";
    await hold();
    await win.gZenWorkspaces.changeWorkspaceWithID(other.uuid);
    await settled("Switched space while holding Command");
    if (showing()) {
      await TestUtils.waitForCondition(() => foreign.some(tab => badge(tab)), "Hints follow the new space");
      for (const tab of startTabs) {
        ok(!badge(tab) || win.gBrowser.visibleTabs.includes(tab), "No hint stays on the previous space's tabs");
      }
    }
    release();
    await TestUtils.waitForCondition(faded, "Releasing after a space switch fades every hint");
    await win.gZenWorkspaces.changeWorkspaceWithID(originalSpace);
    await settled("Back on the original space");
    ok(faded() && !showing(), "No hint is left in the original space either");
  } finally {
    release();
    await win.gZenWorkspaces.changeWorkspaceWithID(originalSpace);
    await win.gZenWorkspaces.removeWorkspace(other.uuid);
  }
});

add_task(async function private_space_excludes_essentials() {
  // The previous task's space removal and switch back must be over, or its
  // queued switch lands after the Private Space opens.
  await settled("The previous space switch finished");
  win.document.getElementById("cmd_whimsyNewScratch").doCommand();
  await TestUtils.waitForCondition(() => WhimsyPrivate.activeSpaceIsScratch(win), "Private Space active");
  // Tabs opened mid-slide are overridden by the slide's own selection.
  await settled("The switch to the Private Space finished");
  // This window is synced with the suite's main window, which lists the
  // Private Space too without showing it: it must not close it as left empty.
  await new Promise(resolve => win.setTimeout(resolve, 300)); // eslint-disable-line mozilla/no-arbitrary-setTimeout
  await settled("No space switch follows the Private Space opening");
  ok(WhimsyPrivate.activeSpaceIsScratch(win), "The empty Private Space stays open");
  const scratchId = WhimsyPrivate.getScratch(win)?.uuid;
  ok(scratchId, "The Private Space exists");
  const tabs = [];
  try {
    for (let i = 0; i < 10; i++) {
      tabs.push(WhimsyPrivate.openPrivateTab(win, { url: "about:blank" }));
    }
    await TestUtils.waitForCondition(() =>
      tabs.every(tab => tab?.getAttribute("zen-workspace-id") == scratchId) &&
      win.gBrowser.selectedTab == tabs.at(-1),
    "Every private tab is in the Private Space, the last one selected");
    await settled("No space switch follows the private tabs");
    ok(WhimsyPrivate.activeSpaceIsScratch(win), "Still on the Private Space");
    await hold();
    for (const tab of Numbers.targets(win).keys()) {
      ok(!tab.hasAttribute("zen-essential") && !tab.hasAttribute("zen-empty-tab"), "Only Private Space tabs are badged");
    }
    release();
    await assertShortcutTargets();
  } finally {
    release();
    for (const tab of tabs) {
      if (tab?.isConnected && !tab.closing) {
        await BrowserTestUtils.removeTab(tab, { animate: false });
      }
    }
    await WhimsyPrivate.closeScratch(win);
    await settled("Back from the Private Space");
    if (win.gZenWorkspaces.activeWorkspace != originalSpace) {
      await win.gZenWorkspaces.changeWorkspaceWithID(originalSpace);
      await settled("Back on the original space");
    }
  }
});

add_task(async function expanded_and_compact_screenshots() {
  const expanded = root.getAttribute("zen-sidebar-expanded");
  const compact = win.gZenCompactModeManager.preference;
  try {
    for (const state of ["expanded", "compact"]) {
      win.gZenCompactModeManager.preference = state == "compact";
      root.setAttribute("zen-sidebar-expanded", state == "expanded" ? "true" : "false");
      for (const dark of [false, true]) {
        await whimsySetScheme(dark);
        try {
          await TestUtils.waitForCondition(() =>
            win.matchMedia(`(prefers-color-scheme: ${dark ? "dark" : "light"})`).matches,
          "The hints window has the requested color scheme");
          const flags = ["zen-has-hover", "has-popup-menu", "flash-popup", "zen-user-show"];
          const before = flags.map(attr => win.gNavToolbox.hasAttribute(attr));
          await hold();
          Assert.deepEqual(flags.map(attr => win.gNavToolbox.hasAttribute(attr)), before, "Hints never force compact mode open");
          await whimsySettled(win.document);
          await whimsyShot(`w24-cmdhints-${state}-${dark ? "dark" : "light"}`, win.browsingContext.currentWindowGlobal);
        } finally {
          release();
          await SpecialPowers.popPrefEnv();
        }
      }
    }
  } finally {
    release();
    win.gZenCompactModeManager.preference = compact;
    if (expanded == null) {
      root.removeAttribute("zen-sidebar-expanded");
    } else {
      root.setAttribute("zen-sidebar-expanded", expanded);
    }
  }
});
