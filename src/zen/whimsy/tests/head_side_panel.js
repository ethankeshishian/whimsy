/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// Shared setup and per-task Essential/pref cleanup for the side-panel suites.

const { WhimsySidePanel } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsySidePanel.sys.mjs");
const { WhimsyCommands } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyCommands.sys.mjs");
const { WhimsyChatPanel } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyChatPanel.sys.mjs");
const { WhimsyAIProviders } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyAIProviders.sys.mjs");
const { WhimsyAIStore } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyAIStore.sys.mjs");
const { SessionStore } = ChromeUtils.importESModule("moz-src:///browser/components/sessionstore/SessionStore.sys.mjs");

const WIDTHS = "whimsy.side-panel.widths";
const PREFS = [WIDTHS, "whimsy.chat.popover", "whimsy.chat.side", "whimsy.chat.width", "whimsy.chat.ai-off-toast-seen", "whimsy.ai.order", "whimsy.ai.hints.seen"];

const sp = () => WhimsySidePanel.forWindow(window);
const box = tab => tab.linkedBrowser.closest(".browserSidebarContainer");
const shown = tab => box(tab)?.hasAttribute("whimsy-popover") && sp().tab == tab;
const grip = tab => box(tab).querySelector(":scope > .whimsy-side-panel-grip");
const widthOf = tab => Math.round(box(tab).getBoundingClientRect().width);

const chat = () => WhimsyChatPanel.forWindow(window);
const initialPrefs = PREFS.map(name => {
  const type = Services.prefs.getPrefType(name);
  return { name, type, value: Services.prefs.prefHasUserValue(name) ? whimsyReadPref(name, type) : undefined };
});

const startTabs = new Set(gBrowser.tabs);
let home;

// File-level cleanup runs too late: leaving each task's Essentials alive hits
// Zen's 12-Essential cap before the Glance repro can even start. Always unwind
// the task, including a failed assertion/await or an interrupted drag.
function addPanelTask(task) {
  const wrapped = async function () {
    const tabs = new Set([...gBrowser.tabs, ...(gZenWorkspaces.allStoredTabs ?? [])]);
    const prefs = PREFS.map(name => {
      const type = Services.prefs.getPrefType(name);
      return { name, type, value: Services.prefs.prefHasUserValue(name) ? whimsyReadPref(name, type) : undefined };
    });
    const { outerWidth, outerHeight } = window;
    try {
      await task();
    } finally {
      sp().hide({ animate: false });
      ok(!sp().cancelDrag && !sp().dragSize, "Task leaves no drag listeners or transient geometry");
      ok(!document.querySelector(".whimsy-side-panel-drag-shield"), "Task leaves no input shield");
      // Also cancel if a future bug makes hide return before cancelling.
      sp().cancelDrag?.();
      sp().pressed = null;
      sp().expanded = null;
      sp().glanceSession = null;
      await gZenGlanceManager.closeGlance({ onTabClose: true, skipPermitUnload: true });
      for (const menu of [document.getElementById("tabContextMenu"), chat().headMenu]) {
        if (menu?.state == "open" || menu?.state == "showing") {
          menu.hidePopup();
        }
      }
      chat().close({ reason: "test" });
      gBrowser.selectedTab = home;
      for (const tab of new Set([...gBrowser.tabs, ...(gZenWorkspaces.allStoredTabs ?? [])])) {
        if (tabs.has(tab)) {
          continue;
        }
        if (tab.hasAttribute("zen-essential")) {
          gZenPinnedTabManager.removeEssentials(tab);
        }
        if (!tab.closing && tab.isConnected) {
          await BrowserTestUtils.removeTab(tab);
        }
      }
      for (const { name, type, value } of prefs) {
        if (value === undefined) {
          Services.prefs.clearUserPref(name);
        } else {
          whimsyWritePref(name, type, value);
        }
      }
      WhimsyAIProviders.setTestProvider(null);
      window.resizeTo(outerWidth, outerHeight);
    }
  };
  Object.defineProperty(wrapped, "name", { value: task.name });
  add_task(wrapped);
}

async function settle(tab) {
  await TestUtils.waitForCondition(
    () => !box(tab) || box(tab).getAnimations().every(a => a.playState != "running"),
    "The popover's motion has finished"
  );
}

async function makeEssential(url) {
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, url);
  info(`makeEssential: count=${gBrowser._numZenEssentials} limit=${gZenPinnedTabManager.maxEssentialTabs}`);
  ok(gZenPinnedTabManager.canEssentialBeAdded(tab), "Essential setup has capacity and the correct container");
  gZenPinnedTabManager.addToEssentials(tab);
  await TestUtils.waitForCondition(() => tab.hasAttribute("zen-essential"), "An Essential");
  gBrowser.selectedTab = home;
  await TestUtils.waitForCondition(() => !tab.selected, "A background tile");
  return tab;
}

async function clickTile(tab, expectShown) {
  EventUtils.synthesizeMouseAtCenter(tab, {});
  await TestUtils.waitForCondition(() => shown(tab) == expectShown, expectShown ? "The popover shows" : "The popover hides");
  await settle(tab);
}

async function hidden(tab, why) {
  await TestUtils.waitForCondition(() => !sp().tab, why);
  await TestUtils.waitForCondition(() => !box(tab).hasAttribute("whimsy-popover"), "...and its panel goes back");
}

async function openTabMenu(tab) {
  const menu = document.getElementById("tabContextMenu");
  const shownEvent = BrowserTestUtils.waitForEvent(menu, "popupshown");
  EventUtils.synthesizeMouseAtCenter(tab, { type: "contextmenu", button: 2 });
  await shownEvent;
  return menu;
}

async function closeMenu(menu) {
  const hiddenEvent = BrowserTestUtils.waitForEvent(menu, "popuphidden");
  menu.hidePopup();
  await hiddenEvent;
}

add_setup(async function () {
  await SpecialPowers.pushPrefEnv({ set: [["whimsy.feature.side-panels", true], ["zen.tabs.essentials.max", 12]] });
  const { outerWidth, outerHeight } = window;
  window.resizeTo(1400, 900);
  await TestUtils.waitForCondition(() => window.innerWidth >= 1300, "Wide window");
  home = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.com/?home");
  registerCleanupFunction(async () => {
    sp().hide({ animate: false });
    for (const tab of [...gBrowser.tabs, ...(gZenWorkspaces.allStoredTabs ?? [])].filter(t => !startTabs.has(t))) {
      if (tab.hasAttribute("zen-essential")) {
        gZenPinnedTabManager.removeEssentials(tab);
      }
      if (!tab.closing && tab.isConnected) {
        await BrowserTestUtils.removeTab(tab);
      }
    }
    for (const { name, type, value } of initialPrefs) {
      if (value === undefined) {
        Services.prefs.clearUserPref(name);
      } else {
        whimsyWritePref(name, type, value);
      }
    }
    WhimsyAIProviders.setTestProvider(null);
    window.resizeTo(outerWidth, outerHeight);
  });
});

// Hit-test the actual grip on press. Subsequent events belong to the chrome
// window, using screen coordinates even beyond the window (clamp coverage).
function pointerAt(target) {
  const rect = target.getBoundingClientRect();
  const x = rect.x + rect.width / 2, y = rect.y + rect.height / 2;
  is(document.elementFromPoint(x, y), target, "Pointer hits the visible drag control");
  let start;
  const capture = e => { start = { screenX: e.screenX, screenY: e.screenY }; };
  window.addEventListener("mousedown", capture, { capture: true, once: true });
  try {
    EventUtils.synthesizeMouseAtCenter(target, { type: "mousedown", clickCount: 1 });
  } finally {
    window.removeEventListener("mousedown", capture, true);
  }
  ok(start, "Press reaches the chrome window");
  return start;
}

// Real pointer events target an element (window listeners read
// event.target.documentGlobal), so dispatch on the root and let it bubble.
function pointerMove(start, dx, dy, type = "mousemove") {
  document.documentElement.dispatchEvent(new MouseEvent(type, {
    bubbles: true, cancelable: true, button: 0,
    buttons: type == "mouseup" ? 0 : 1,
    screenX: start.screenX + dx, screenY: start.screenY + dy,
  }));
}

async function drag(tab, dx, dy = 0, edge = "e") {
  const start = pointerAt(box(tab).querySelector(`[data-edge="${edge}"]`));
  try {
    pointerMove(start, dx / 2, dy / 2);
    pointerMove(start, dx, dy);
    pointerMove(start, dx, dy, "mouseup");
  } finally {
    sp().cancelDrag?.();
  }
  await settle(tab);
}

async function moveHeader(tab, dx, dy) {
  const start = pointerAt(box(tab).querySelector(".whimsy-side-panel-host"));
  try {
    pointerMove(start, dx, dy);
    pointerMove(start, dx, dy, "mouseup");
  } finally {
    sp().cancelDrag?.();
  }
}

const saved = () => JSON.parse(Services.prefs.getStringPref(WIDTHS, "{}"));

