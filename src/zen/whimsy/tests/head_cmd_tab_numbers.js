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
const { UrlbarTestUtils } = ChromeUtils.importESModule("resource://testing-common/UrlbarTestUtils.sys.mjs");
UrlbarTestUtils.init(this);
const { sinon } = ChromeUtils.importESModule("resource://testing-common/Sinon.sys.mjs");

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
  const revealed = BrowserTestUtils.waitForMutationCondition(root,
    { attributes: true, attributeFilter: ["whimsy-tab-numbers"] }, showing);
  key("KEY_Meta", { type: "keydown", metaKey: true });
  logChord("Hold keydown");
  try {
    await revealed;
  } finally {
    logChord("Hold completed or timed out");
  }
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
    ok(badge(tab).classList.contains("whimsy-number-badge"), "Each number uses the shared keycap");
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
    logChord(`After native Command-${digit}`);
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

function logChord(label) {
  const state = Numbers.chordState(win);
  info(`${label}: meta=${state.meta}, keys=${JSON.stringify(state.keys)}, pending timer=${state.timer}, active=${state.active}, buttons=${state.buttons}, bar=${win.gURLBar.view.isOpen}, tabs=${showing()}`);
  return state;
}

