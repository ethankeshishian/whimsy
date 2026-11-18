/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// W29 side panels: an Essential opens in a popover next to the sidebar by
// default, without becoming the selected tab and without moving the page.
// It floats across page clicks and tab switches; Minimize keeps state,
// Expand selects it once, and close-tab follows focus. Eight grips resize
// all edges and remember geometry per host.

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
  await SpecialPowers.pushPrefEnv({ set: [["whimsy.feature.side-panels", true]] });
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
        BrowserTestUtils.removeTab(tab);
      }
    }
    for (const pref of PREFS) {
      Services.prefs.clearUserPref(pref);
    }
    WhimsyAIProviders.setTestProvider(null);
    window.resizeTo(outerWidth, outerHeight);
  });
});

addPanelTask(async function click_shows_beside_sidebar_without_selecting() {
  const ess = await makeEssential("https://example.org/?mail");
  const pageWidth = home.linkedBrowser.getBoundingClientRect().width;
  await clickTile(ess, true);
  is(gBrowser.selectedTab, home, "The page stays the selected tab");
  is(home.linkedBrowser.getBoundingClientRect().width, pageWidth, "The page doesn't move or shrink");
  is(widthOf(ess), WhimsySidePanel.DEFAULT_WIDTH, "380px wide");
  const panels = document.getElementById("tabbrowser-tabpanels").getBoundingClientRect();
  const rect = box(ess).getBoundingClientRect();
  Assert.lessOrEqual(Math.abs(rect.top - panels.top - (panels.bottom - rect.bottom)), 2, "Centred top to bottom");
  Assert.less(rect.left - panels.left, 40, "Next to the sidebar");
  is(box(ess).getAttribute("role"), "dialog", "A dialog");
  is(box(ess).getAttribute("aria-label"), "example.org", "named for its site");
  is(ess.getAttribute("visuallyselected"), "true", "Its tile looks selected while it shows");
  const host = box(ess).querySelector(".whimsy-side-panel-host");
  is(host.textContent, "example.org", "The header shows the site");

  await clickTile(ess, false);
  ok(!ess.hasAttribute("visuallyselected"), "A second click on its tile hides it");
  is(gBrowser.selectedTab, home, "and nothing was selected");
});

addPanelTask(async function page_click_and_tab_switch_keep_floating() {
  const ess = await makeEssential("https://example.org/?chat");
  await clickTile(ess, true);
  await SpecialPowers.spawn(home.linkedBrowser, [], () => {
    content.document.addEventListener("click", () => content.document.body.dataset.clicked = "yes", { once: true });
  });
  await BrowserTestUtils.synthesizeMouseAtPoint(home.linkedBrowser.clientWidth - 40, 200, {}, home.linkedBrowser);
  await TestUtils.waitForCondition(() => SpecialPowers.spawn(home.linkedBrowser, [], () => content.document.body.dataset.clicked == "yes"), "The page receives the click");
  ok(shown(ess), "Page clicks keep the popover open");
  const other = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.com/?other");
  ok(shown(ess), "A tab switch keeps it floating");
  gBrowser.selectedTab = home;
  BrowserTestUtils.removeTab(other);
  window.dispatchEvent(new CustomEvent("GlanceOpen", { bubbles: true }));
  await hidden(ess, "A Glance opening hides it");
  await clickTile(ess, true);
  window.dispatchEvent(new CustomEvent("ZenWorkspaceChanged"));
  await hidden(ess, "A space switch hides it");
  await clickTile(ess, true);
  gZenPinnedTabManager.removeEssentials(ess);
  BrowserTestUtils.removeTab(ess);
  await TestUtils.waitForCondition(() => !sp().tab, "Closing the Essential hides it");
});

addPanelTask(async function esc_goes_to_the_site_and_hide_button_hides() {
  const ess = await makeEssential("https://example.org/?esc");
  // The first show reloads it once with the phone user agent.
  const loaded = BrowserTestUtils.browserLoaded(ess.linkedBrowser);
  await clickTile(ess, true);
  await loaded;
  await TestUtils.waitForCondition(() => document.activeElement == ess.linkedBrowser, "Focus moves into the site");
  await SpecialPowers.spawn(ess.linkedBrowser, [], () => {
    content.document.addEventListener("keydown", e => {
      if (e.key == "Escape") {
        content.document.body.dataset.esc = "1";
      }
    });
  });
  EventUtils.synthesizeKey("KEY_Escape");
  await TestUtils.waitForCondition(
    () => SpecialPowers.spawn(ess.linkedBrowser, [], () => content.document.body.dataset.esc == "1"),
    "Esc reaches the site"
  );
  ok(shown(ess), "and never hides the popover");

  const button = box(ess).querySelector(".whimsy-side-panel-hide");
  await TestUtils.waitForCondition(() => button.getAttribute("aria-label") == "Minimize", "The hide button is named");
  is(button.title, "Minimize", "with a tooltip");
  EventUtils.synthesizeMouseAtCenter(button, {});
  await hidden(ess, "The hide button hides it");
  is(document.activeElement, home.linkedBrowser, "Focus goes back to the page");
});

addPanelTask(async function switching_sites_keeps_pages_and_phone_layout() {
  const a = await makeEssential("https://example.org/?a");
  const b = await makeEssential("https://example.com/?b");
  const loaded = BrowserTestUtils.browserLoaded(a.linkedBrowser);
  await clickTile(a, true);
  await loaded;
  const ua = await SpecialPowers.spawn(a.linkedBrowser, [], () => content.navigator.userAgent);
  ok(ua.includes("iPhone"), "The popover's site gets the phone layout");
  await SpecialPowers.spawn(a.linkedBrowser, [], () => {
    content.wrappedJSObject.kept = 1;
  });
  await clickTile(b, true);
  ok(!shown(a), "Another tile swaps the site");
  await clickTile(a, true);
  is(await SpecialPowers.spawn(a.linkedBrowser, [], () => content.wrappedJSObject.kept), 1, "Coming back doesn't reload it");
  sp().hide({ animate: false });

  // Picked as a page (here by keyboard): desktop again.
  const reloaded = BrowserTestUtils.browserLoaded(a.linkedBrowser);
  gBrowser.selectedTab = a;
  await reloaded;
  const desktop = await SpecialPowers.spawn(a.linkedBrowser, [], () => content.navigator.userAgent);
  ok(!desktop.includes("iPhone"), "As a page it's desktop");
  ok(!sp().tab, "and nothing floats");
  gBrowser.selectedTab = home;
});

addPanelTask(async function menu_checkbox_and_open_in_tab() {
  const ess = await makeEssential("https://example.org/?menu");
  let menu = await openTabMenu(ess);
  const item = document.getElementById("context_whimsySidePanel");
  ok(item && !item.hidden, "An Essential's menu has Open in Side Panel");
  is(item.getAttribute("type"), "checkbox", "as a checkbox");
  is(item.getAttribute("checked"), "true", "on by default");
  // The regroup puts Side Panel beside Essentials in Where it lives;
  // Show Unread Badge belongs to the later Label group.
  is(item.previousElementSibling?.id, "context_zen-remove-essential", "under Remove from Essentials");
  await TestUtils.waitForCondition(() => item.label == "Open in Side Panel", "Its name");
  menu.activateItem(item);
  await BrowserTestUtils.waitForEvent(menu, "popuphidden");
  ok(ess.hasAttribute(WhimsySidePanel.OFF_ATTR), "Unchecked");
  is(SessionStore.getCustomTabValue(ess, WhimsySidePanel.OFF_KEY), "true", "and saved with the tab");

  EventUtils.synthesizeMouseAtCenter(ess, {});
  await TestUtils.waitForCondition(() => gBrowser.selectedTab == ess, "Unchecked, it opens as a normal tab");
  ok(!sp().tab, "not in the popover");

  // Checked again while on it: the page you were on comes back.
  menu = await openTabMenu(ess);
  ok(!item.hasAttribute("checked"), "Shown unchecked");
  menu.activateItem(item);
  await BrowserTestUtils.waitForEvent(menu, "popuphidden");
  await TestUtils.waitForCondition(() => gBrowser.selectedTab == home, "Checking it goes back to the page");
  ok(!ess.hasAttribute(WhimsySidePanel.OFF_ATTR), "Checked");
  ok(!SessionStore.getCustomTabValue(ess, WhimsySidePanel.OFF_KEY), "Nothing saved when on");

  menu = await openTabMenu(home);
  ok(!item.checkVisibility(), "A normal tab has no Open in Side Panel");
  await closeMenu(menu);

  // Open in Tab, from the command bar's command.
  const entry = WhimsyCommands.get("cmd_whimsySidePanel");
  ok(entry, "A command");
  Assert.deepEqual(entry.variants, ["whimsy-action-open-in-side-panel", "whimsy-action-open-in-tab"], "named for what it does");
  await clickTile(ess, true);
  document.getElementById("cmd_whimsySidePanel").doCommand();
  await TestUtils.waitForCondition(() => gBrowser.selectedTab == ess, "Open in Tab makes it the page");
  ok(ess.hasAttribute(WhimsySidePanel.OFF_ATTR), "and opens it as a tab from then on");
  ok(!box(ess).hasAttribute("whimsy-popover"), "No longer floating");
  document.getElementById("cmd_whimsySidePanel").doCommand();
  await TestUtils.waitForCondition(() => gBrowser.selectedTab == home, "Open in Side Panel sends it back to the sidebar");
  ok(!ess.hasAttribute(WhimsySidePanel.OFF_ATTR), "on again");
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

addPanelTask(async function resize_is_clamped_and_kept_per_site() {
  const a = await makeEssential("https://example.org/?wide");
  const b = await makeEssential("https://example.com/?narrow");
  await clickTile(a, true);
  ok(grip(a).checkVisibility(), "A grip on the free edge");
  await TestUtils.waitForCondition(() => grip(a).getAttribute("aria-label") == "Resize side panel", "Named");
  await drag(a, 100);
  is(widthOf(a), 480, "Dragging the edge follows the pointer");
  is(saved()["example.org"]?.width, 480, "and is kept for that site");
  await drag(a, 2000);
  is(widthOf(a), Math.floor(window.innerWidth / 2), "No wider than half the window");
  await drag(a, -2000);
  is(widthOf(a), WhimsySidePanel.MIN_WIDTH, "No narrower than 320px");
  await drag(a, 80);
  const kept = widthOf(a);
  is(kept, 400, "400px");

  await clickTile(b, true);
  is(widthOf(b), WhimsySidePanel.DEFAULT_WIDTH, "Another site keeps its own width");
  await clickTile(a, true);
  is(widthOf(a), kept, "and the first site comes back at its width");

  EventUtils.synthesizeMouse(grip(a), 3, 100, { clickCount: 1 });
  EventUtils.synthesizeMouse(grip(a), 3, 100, { clickCount: 2 });
  await settle(a);
  is(widthOf(a), WhimsySidePanel.DEFAULT_WIDTH, "Double-click resets the width");
  ok(!("example.org" in saved()), "and forgets it");

  // A window under 1000px: 320px.
  window.resizeTo(960, 800);
  await TestUtils.waitForCondition(() => window.innerWidth < 1000, "Narrow window");
  await TestUtils.waitForCondition(() => widthOf(a) == WhimsySidePanel.MIN_WIDTH, "320px in a narrow window");
  window.resizeTo(1400, 900);
  await TestUtils.waitForCondition(() => window.innerWidth >= 1300, "Wide again");
  await TestUtils.waitForCondition(() => widthOf(a) == WhimsySidePanel.DEFAULT_WIDTH, "380px again");
  sp().hide({ animate: false });
});

addPanelTask(async function minimize_keeps_state_and_expand_is_only_once() {
  const ess = await makeEssential("https://example.org/?expand");
  const loaded = BrowserTestUtils.browserLoaded(ess.linkedBrowser);
  await clickTile(ess, true);
  await loaded;
  await SpecialPowers.spawn(ess.linkedBrowser, [], () => { content.wrappedJSObject.kept = 42; });
  await drag(ess, 35, -60, "se");
  await moveHeader(ess, 120, 0);
  const before = sp().geometry(ess);
  EventUtils.synthesizeMouseAtCenter(box(ess).querySelector(".whimsy-side-panel-hide"), {});
  await hidden(ess, "Minimized");
  ok(ess.undiscardable && !ess.hasAttribute("pending"), "Minimize does not unload");
  await clickTile(ess, true);
  Assert.deepEqual(sp().geometry(ess), before, "Same size on next tile click");
  is(await SpecialPowers.spawn(ess.linkedBrowser, [], () => content.wrappedJSObject.kept), 42, "Same page state");
  const desktop = BrowserTestUtils.browserLoaded(ess.linkedBrowser);
  EventUtils.synthesizeMouseAtCenter(box(ess).querySelector(".whimsy-side-panel-expand"), {});
  await TestUtils.waitForCondition(() => ess.selected && !box(ess).hasAttribute("whimsy-popover"), "Expanded into the page");
  await desktop;
  ok(!ess.hasAttribute(WhimsySidePanel.OFF_ATTR), "Expand preserves popover-by-default");
  ok(!ess.linkedBrowser._whimsySidePanelUA, "Phone override cleared");
  ok(!(await SpecialPowers.spawn(ess.linkedBrowser, [], () => content.navigator.userAgent)).includes("iPhone"), "Desktop UA");
  gBrowser.selectedTab = home;
  await clickTile(ess, true);
  const expanded = BrowserTestUtils.waitForEvent(gBrowser.tabContainer, "TabSelect");
  EventUtils.synthesizeMouseAtCenter(box(ess).querySelector(".whimsy-side-panel-host"), { clickCount: 2 });
  await expanded;
  is(gBrowser.selectedTab, ess, "Header double-click also expands");
  gBrowser.selectedTab = home;
});

// Keep the failing route visible in the test log, including before a fix:
// selected tiles used to return null, and expanded close had no floating tab.
function pipbackState(label, tab) {
  const tile = sp().tileFor({ target: tab, button: 0, getModifierState: () => false });
  info(`pipback ${label}: ${JSON.stringify({ selected: tab.selected,
    actualSelected: gBrowser.selectedTab == tab, tileFor: tile?.id ?? null,
    off: tab.hasAttribute(WhimsySidePanel.OFF_ATTR),
    phone: !!tab.linkedBrowser._whimsySidePanelUA, floating: shown(tab),
    expanded: sp().expanded?.tab == tab,
  })}`);
}

for (const headerDoubleClick of [false, true]) {
  for (const route of ["tile", "menu", "close", "tab", "space", "minimize"]) {
    addPanelTask(async function expanded_essential_returns_to_popover() {
      info(`pipback Expand=${headerDoubleClick ? "header double-click" : "button"}; route=${route}`);
      const methods = ["onMouseDown", "onClick", "toggle", "show", "hide", "setOn", "shrink", "closeFocused"];
      const original = new Map(methods.filter(name => typeof sp()[name] == "function")
        .map(name => [name, sp()[name]]));
      for (const [name, run] of original) {
        sp()[name] = function (...args) {
          info(`pipback code path: ${name}`);
          return run.apply(this, args);
        };
      }
      try {
        const ess = await makeEssential("https://example.org/?pipback");
        await clickTile(ess, true);
        const geometry = sp().geometry(ess);
        const count = gBrowser.tabs.length;
        EventUtils.synthesizeMouseAtCenter(box(ess).querySelector(headerDoubleClick ?
          ".whimsy-side-panel-host" : ".whimsy-side-panel-expand"),
          headerDoubleClick ? { clickCount: 2 } : {});
        await TestUtils.waitForCondition(() => ess.selected && !shown(ess), "Expanded");
        pipbackState("before " + route, ess);
        if (route == "tile") {
          await clickTile(ess, true);
        } else if (route == "menu") {
          const menu = await openTabMenu(ess);
          const item = document.getElementById("context_whimsySidePanel");
          is(item.getAttribute("checked"), "true", "Expanded remains popover-by-default");
          const closed = BrowserTestUtils.waitForEvent(menu, "popuphidden");
          menu.activateItem(item);
          await closed;
          await TestUtils.waitForCondition(() => shown(ess), "Menu shrinks the expanded Essential");
        } else if (route == "close") {
          ess.linkedBrowser.focus();
          EventUtils.synthesizeKey("w", { accelKey: true });
          await TestUtils.waitForCondition(() => gBrowser.selectedTab == home && !sp().tab,
            "Close returns to the page with the Essential tucked away");
          ok(ess.isConnected && !ess.closing, "Essential survives Close");
          is(gBrowser.tabs.length, count, "Close removes no tab");
          await clickTile(ess, true);
        } else {
          if (route == "space") {
            window.dispatchEvent(new CustomEvent("ZenWorkspaceChanged"));
          }
          if (route != "minimize") {
            gBrowser.selectedTab = home;
          }
          await clickTile(ess, true);
          if (route == "minimize") {
            EventUtils.synthesizeMouseAtCenter(box(ess).querySelector(".whimsy-side-panel-hide"), {});
            await hidden(ess, "Minimize after shrinking tucks into tile");
            await clickTile(ess, true);
          }
        }
        await settle(ess);
        pipbackState("after " + route, ess);
        is(gBrowser.selectedTab, home, "Previous page restored");
        ok(shown(ess) && !ess.selected, "Essential floats again");
        ok(!ess.hasAttribute(WhimsySidePanel.OFF_ATTR), "Routing preference stays on");
        ok(ess.linkedBrowser._whimsySidePanelUA, "Phone UA restored");
        Assert.deepEqual(sp().geometry(ess), geometry, "Saved geometry restored");
      } finally {
        for (const [name, run] of original) {
          sp()[name] = run;
        }
      }
    });
  }
}

addPanelTask(async function shrink_fallback_reduced_motion_and_interruption() {
  const ess = await makeEssential("https://example.org/?shrink-fallback");
  const page = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.com/?previous-page");
  await clickTile(ess, true);
  await sp().expand();
  is(sp().expanded.page, page, "Expand remembers the actual underlying page");
  await BrowserTestUtils.removeTab(page);
  await SpecialPowers.pushPrefEnv({ set: [["ui.prefersReducedMotion", 1]] });
  try {
    const shrinking = sp().shrink(ess);
    const animation = sp().shrinking.animation;
    Assert.deepEqual(animation.effect.getKeyframes().map(frame => frame.opacity), ["0", "1"],
      "Reduced motion crossfades without growing or moving");
    await shrinking;
    is(gBrowser.selectedTab, home, "Missing previous page falls back to the recent page in this space");
    ok(shown(ess), "Fallback still floats the Essential");
    await sp().expand();
    const interrupted = sp().shrink(ess, { minimize: true });
    sp().hide({ animate: false });
    sp().show(ess);
    await interrupted;
    ok(shown(ess), "Cancelled shrink cannot minimize a reopened popover");
    ok(!sp().shrinking, "No stale shrink state");
  } finally {
    await SpecialPowers.popPrefEnv();
  }
});

addPanelTask(async function expanded_shrink_motion_and_off_essential() {
  const ess = await makeEssential("https://example.org/?shrink-motion");
  await clickTile(ess, true);
  await sp().expand();
  await SpecialPowers.pushPrefEnv({ set: [["ui.prefersReducedMotion", 0]] });
  try {
    EventUtils.synthesizeMouseAtCenter(ess, {});
    await TestUtils.waitForCondition(() => shown(ess) && sp().shrinking, "Shrink animation running");
    const animation = sp().shrinking.animation;
    animation.pause();
    animation.currentTime = 140;
    is(animation.effect.getTiming().duration, 280, "Reverse Expand lasts 280ms");
    await whimsyShot("w29-pipback-shrink");
    animation.finish();
    await settle(ess);
  } finally {
    await SpecialPowers.popPrefEnv();
  }
  sp().setOn(ess, false);
  EventUtils.synthesizeMouseAtCenter(ess, {});
  await TestUtils.waitForCondition(() => ess.selected, "OFF Essential selects normally");
  pipbackState("OFF selected tile", ess);
  EventUtils.synthesizeMouseAtCenter(ess, {});
  ok(!sp().tab && ess.selected, "OFF selected tile stays a normal page");
  ok(!ess.linkedBrowser._whimsySidePanelUA, "OFF keeps desktop UA");
  gBrowser.selectedTab = home;
  EventUtils.synthesizeMouseAtCenter(ess, {});
  await TestUtils.waitForCondition(() => ess.selected, "OFF still selects after leaving");
});

addPanelTask(async function close_tab_follows_focus() {
  const ess = await makeEssential("https://example.org/?focus");
  await clickTile(ess, true);
  let count = gBrowser.tabs.length;
  ess.linkedBrowser.focus();
  EventUtils.synthesizeKey("w", { accelKey: true });
  await hidden(ess, "Close with browser focus minimizes");
  is(gBrowser.tabs.length, count, "No tab closed");
  await clickTile(ess, true);
  box(ess).querySelector(".whimsy-side-panel-expand").focus();
  EventUtils.synthesizeKey("w", { accelKey: true });
  await hidden(ess, "Close with header focus minimizes");
  is(gBrowser.tabs.length, count, "No tab closed from header");
  const page = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.com/?close-me");
  await clickTile(ess, true);
  page.linkedBrowser.focus();
  const closed = BrowserTestUtils.waitForEvent(page, "TabClose");
  EventUtils.synthesizeKey("w", { accelKey: true });
  await closed;
  ok(shown(ess), "Closing the focused page leaves PiP open");
  sp().hide({ animate: false });
  gBrowser.selectedTab = home;
});

function readoutContrast(node) {
  const canvas = document.createElementNS("http://www.w3.org/1999/xhtml", "canvas");
  canvas.width = canvas.height = 1;
  const ctx = canvas.getContext("2d");
  const light = value => {
    ctx.fillStyle = value;
    ctx.fillRect(0, 0, 1, 1);
    const rgb = [...ctx.getImageData(0, 0, 1, 1).data].slice(0, 3).map(c =>
      (c /= 255) <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
    return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
  };
  const style = getComputedStyle(node);
  const a = light(style.color), b = light(style.backgroundColor);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

addPanelTask(async function eight_grips_geometry_compatibility_and_shots() {
  Services.prefs.setStringPref(WIDTHS, JSON.stringify({ "example.org": 420 }));
  const ess = await makeEssential("https://example.org/?geometry");
  await clickTile(ess, true);
  is(widthOf(ess), 420, "Legacy numeric width reads correctly");
  for (const edge of ["e", "w", "n", "s", "ne", "nw", "se", "sw"]) {
    const available = document.getElementById("tabbrowser-tabpanels").clientHeight - 40;
    const height = Math.min(450, available);
    const top = 20 + Math.min(80, Math.max(0, available - height));
    Services.prefs.setStringPref(WIDTHS, JSON.stringify({ "example.org": { width: 380, height, left: 240, top } }));
    const before = sp().geometry(ess);
    await drag(ess, edge.includes("w") ? -30 : 30, edge.includes("n") ? 40 : -40, edge);
    const after = sp().geometry(ess);
    const rect = box(ess).getBoundingClientRect();
    is(Math.round(rect.width), Math.round(after.width), `${edge}: rendered width follows geometry`);
    is(Math.round(rect.height), Math.round(after.height), `${edge}: rendered height follows geometry`);
    is(after.width, before.width + (/[ew]/.test(edge) ? 30 : 0), `${edge}: correct width`);
    is(after.height, before.height - (/[ns]/.test(edge) ? Math.min(40, before.height - Math.min(320, available)) : 0), `${edge}: correct height`);
    is(after.top, before.top + (edge.includes("n") ? Math.min(40, before.height - Math.min(320, available)) : 0), `${edge}: top edge follows pointer`);
    is(after.left + after.width * (edge.includes("w") ? 1 : 0), before.left + before.width * (edge.includes("w") ? 1 : 0), `${edge}: opposite horizontal edge fixed`);
    is(after.top + (edge.includes("n") ? after.height : 0), before.top + (edge.includes("n") ? before.height : 0), `${edge}: opposite vertical edge fixed`);
    Assert.deepEqual(saved()["example.org"], Object.fromEntries(Object.entries(after).map(([k, v]) => [k, Math.round(v)])), "Saves full geometry");
    await drag(ess, 0, edge.includes("n") ? 2000 : -2000, edge);
    if (/[ns]/.test(edge)) {
      is(sp().geometry(ess).height, Math.min(320, available), "Height minimum");
    }
    const g = box(ess).querySelector(`[data-edge="${edge}"]`);
    EventUtils.synthesizeMouseAtCenter(g, { clickCount: 2 });
    await settle(ess);
    is(widthOf(ess), 380, "Any grip double-click resets width");
    is(Math.round(sp().geometry(ess).height), Math.round(Math.min(680, document.getElementById("tabbrowser-tabpanels").clientHeight - 40)), "Resets height");
  }
  await drag(ess, 0, 2000, "s");
  const size = sp().geometry(ess);
  Assert.lessOrEqual(size.top + size.height, document.getElementById("tabbrowser-tabpanels").clientHeight - 20, "Bottom gap remains");
  await drag(ess, 0, -2000, "n");
  is(sp().geometry(ess).top, 20, "Top gap remains");
  await clickTile(ess, false);
  await clickTile(ess, true);
  is(sp().geometry(ess).top, 20, "Saved vertical offset restored");
  sp().resetWidth();
  for (const dark of [false, true]) {
    await whimsySetScheme(dark);
    try {
      await settle(ess);
      Assert.greaterOrEqual(readoutContrast(box(ess).querySelector(".whimsy-side-panel-size")), 4.5, "Readout ink meets AA in both schemes");
      await whimsyShot(`w29-pip-${dark ? "dark" : "light"}`);
    } finally {
      await SpecialPowers.popPrefEnv();
    }
  }
  const start = pointerAt(grip(ess));
  try {
    pointerMove(start, 35, 30);
    ok(box(ess).hasAttribute("resizing"), "Readout only while dragging");
    ok(box(ess).querySelector(".whimsy-side-panel-size").textContent.includes(" × "), "Size readout");
    await whimsyShot("w29-pip-drag");
    pointerMove(start, 35, 30, "mouseup");
    ok(!box(ess).hasAttribute("resizing"), "Readout hidden on release");
    ok(!document.querySelector(".whimsy-side-panel-drag-shield"), "Release removes shield");
  } finally {
    sp().cancelDrag?.();
  }
  const root = document.documentElement;
  const oldSide = root.getAttribute("zen-right-side");
  try {
    root.setAttribute("zen-right-side", "true");
    sp().resetWidth();
    sp().layout();
    const before = sp().geometry(ess);
    await drag(ess, -40, -40, "sw");
    is(sp().geometry(ess).width, before.width + 40, "Left grip resizes with right edge fixed");
    is(sp().geometry(ess).height, before.height - 40, "Right corner still resizes height");
    const rect = box(ess).getBoundingClientRect();
    const panels = document.getElementById("tabbrowser-tabpanels").getBoundingClientRect();
    Assert.less(panels.right - rect.right, 40, "Right sidebar edge stays docked");
  } finally {
    if (oldSide === null) {
      root.removeAttribute("zen-right-side");
    } else {
      root.setAttribute("zen-right-side", oldSide);
    }
    sp().layout();
  }
  sp().hide({ animate: false });
  Services.prefs.clearUserPref(WIDTHS);
});

addPanelTask(async function header_moves_clamps_persists_and_resets() {
  const ess = await makeEssential("https://example.org/?move");
  const other = await makeEssential("https://example.com/?move-other");
  Services.prefs.setStringPref(WIDTHS, JSON.stringify({ "example.org": { width: 380, height: 400, top: 60 } }));
  await clickTile(ess, true);
  const before = sp().geometry(ess);
  await moveHeader(ess, 2, 0);
  Assert.deepEqual(sp().geometry(ess), before, "Below 4px remains a click");
  await moveHeader(ess, 160, 35);
  const moved = sp().geometry(ess);
  is(moved.left, before.left + 160, "Header tracks horizontal pointer 1:1");
  is(moved.top, before.top + 35, "Header tracks vertical pointer 1:1");
  is(moved.width, before.width, "Move preserves size");
  Assert.deepEqual(saved()["example.org"], moved, "Position and size persisted together");
  await clickTile(other, true);
  await clickTile(ess, true);
  Assert.deepEqual(sp().geometry(ess), moved, "Per-host position restored");
  const panels = document.getElementById("tabbrowser-tabpanels");
  await moveHeader(ess, panels.clientWidth, panels.clientHeight);
  let g = sp().geometry(ess);
  is(g.left + g.width, panels.clientWidth - 20, "Right gap clamped");
  is(g.top + g.height, panels.clientHeight - 20, "Bottom gap clamped");
  window.resizeTo(1050, 800);
  await TestUtils.waitForCondition(() => window.innerWidth < 1100, "Smaller window");
  g = sp().geometry(ess);
  Assert.lessOrEqual(g.left + g.width, panels.clientWidth - 20, "Window resize clamps horizontal position");
  Assert.lessOrEqual(g.top + g.height, panels.clientHeight - 20, "Window resize clamps vertical position");
  window.resizeTo(1400, 900);
  await TestUtils.waitForCondition(() => window.innerWidth >= 1300, "Wide again");
  await moveHeader(ess, -panels.clientWidth, -panels.clientHeight);
  is(sp().geometry(ess).left, 20, "Left gap clamped");
  is(sp().geometry(ess).top, 20, "Top gap clamped");
  sp().resetWidth();
  is(sp().geometry(ess).left, 20, "Reset docks beside left sidebar");
  await moveHeader(ess, Math.round((panels.clientWidth - 380) / 2) - 20, 0);
  for (const dark of [false, true]) {
    await whimsySetScheme(dark);
    try {
      await whimsyShot(`w29-pip-moved-${dark ? "dark" : "light"}`);
    } finally {
      await SpecialPowers.popPrefEnv();
    }
  }
  EventUtils.synthesizeMouseAtCenter(grip(ess), { clickCount: 2 });
  is(sp().geometry(ess).left, 20, "Grip double-click resets position");
  is(sp().geometry(ess).width, 380, "Grip double-click resets size");
  sp().hide({ animate: false });
  Services.prefs.clearUserPref(WIDTHS);
});

addPanelTask(async function interrupted_drag_cleans_up_input_and_reset() {
  const ess = await makeEssential("https://example.org/?cancel-drag");
  await clickTile(ess, true);
  for (const moving of [false, true]) {
    const target = moving ? box(ess).querySelector(".whimsy-side-panel-host") : grip(ess);
    const start = pointerAt(target);
    pointerMove(start, 35, 30);
    ok(document.querySelector(".whimsy-side-panel-drag-shield"), "Active drag shields content");
    sp().hide({ animate: false });
    ok(!sp().cancelDrag && !sp().dragSize, "Hide removes drag handlers and transient geometry");
    ok(!document.querySelector(".whimsy-side-panel-drag-shield"), "Hide removes shield");
    await clickTile(ess, true);
    const before = sp().geometry(ess);
    pointerMove(start, 100, 100);
    pointerMove(start, 100, 100, "mouseup");
    Assert.deepEqual(sp().geometry(ess), before, "A stale move/up cannot change a reopened popover");
  }
  const start = pointerAt(grip(ess));
  pointerMove(start, 35, 0);
  sp().resetWidth();
  pointerMove(start, 100, 0, "mouseup");
  is(sp().geometry(ess).width, 380, "Reset during drag survives a late release");
  ok(!document.querySelector(".whimsy-side-panel-drag-shield"), "Reset removes shield");
});

// Exercise the real Glance lifecycle, including its nested tab and selection
// bookkeeping; a synthetic GlanceOpen cannot reproduce those side effects.
addPanelTask(async function glance_from_popover_keeps_essential_routing() {
  const a = await makeEssential("https://example.org/?glance-parent");
  const b = await makeEssential("https://example.com/?glance-other");
  const state = (label, tab) => info(`${label}: ${JSON.stringify({
    selected: tab.selected, actualSelected: gBrowser.selectedTab == tab,
    routes: sp().routes(tab), elsewhere: sp().pageElsewhere(tab),
    glance: tab.getAttribute("glance-id"), floating: sp().tab == tab,
    pressed: sp().pressed?.id, box: box(tab)?.hasAttribute("whimsy-popover"),
    visible: tab._zenContentsVisible, active: tab.linkedBrowser.zenModeActive,
  })}`);
  for (const explicitParent of [false, true]) {
    for (const expand of [false, true]) {
      gBrowser.selectedTab = home;
      sp().hide({ animate: false });
      await clickTile(a, true);
      const geometry = sp().geometry(a);
      state(`before owner=${explicitParent} expand=${expand}`, a);
      const glance = await gZenGlanceManager.openGlance({
        url: "https://example.com/?popover-glance",
        clientX: 0, clientY: 0, width: 0, height: 0,
        triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
      }, null, explicitParent ? a : null);
      state("opened", a);
      is(gZenGlanceManager.getTabOrGlanceParent(glance), a, "Glance belongs to the popover site context");
      ok(!sp().tab, "Glance temporarily hides the popover");
      if (expand) {
        await gZenGlanceManager.fullyOpenGlance();
      } else {
        await gZenGlanceManager.closeGlance({ onTabClose: true });
      }
      state("finished", a);
      await TestUtils.waitForCondition(() => shown(a), "The original popover returns");
      Assert.deepEqual(sp().geometry(a), geometry, "Position and size survive Glance");
      is(gBrowser.selectedTab, expand ? glance : home, "Closing restores the underlying page; Expand selects the new page");
      ok(!a.selected && !a.hasAttribute("glance-id"), "Essential selection and Glance ID cleaned up");
      await clickTile(a, false);
      state("same tile before reopening", a);
      await clickTile(a, true);
      state("different tile before reopening", b);
      await clickTile(b, true);
      sp().hide({ animate: false });
      gBrowser.selectedTab = home;
      if (expand) {
        BrowserTestUtils.removeTab(glance);
      }
    }
  }
});

// ---- Chat on the same surface ----

const chat = () => WhimsyChatPanel.forWindow(window);
const chatEl = () => document.getElementById("whimsy-chat");

async function settleChat() {
  await TestUtils.waitForCondition(
    () => !chatEl() || chatEl().getAnimations({ subtree: true }).every(a => a.playState != "running"),
    "Chat's motion has finished"
  );
}

async function pressCmdE() {
  const was = chat().isOpen;
  EventUtils.synthesizeKey("e", { accelKey: true });
  await TestUtils.waitForCondition(() => chat().isOpen != was, "⌘E reached chat");
  await settleChat();
}

addPanelTask(async function chat_as_popover_toggle() {
  await SpecialPowers.pushPrefEnv({ set: [["whimsy.ai.enabled", true], ["whimsy.feature.ai-hints", false]] });
  try {
  await WhimsyAIStore._resetForTesting(PathUtils.join(PathUtils.tempDir, "whimsy-side-panels-" + Date.now()));
  WhimsyAIProviders.setTestProvider(async function* () {
    yield { type: "text", delta: "Hello." };
  });
  WhimsyAIProviders.setOrder(["claude"]);
  is(Services.prefs.getDefaultBranch("").getBoolPref("whimsy.chat.popover"), false, "Off by default");
  await SimpleTest.promiseFocus(window);
  gBrowser.selectedBrowser.focus();

  // Off: chat is its own column and the page narrows.
  const pageWidth = home.linkedBrowser.getBoundingClientRect().width;
  await pressCmdE();
  ok(!chatEl().hasAttribute("whimsy-popover"), "A column when off");
  chat().close({ reason: "key" });
  await settleChat();

  Services.prefs.setBoolPref("whimsy.chat.popover", true);
  await pressCmdE();
  ok(chatEl().hasAttribute("whimsy-popover"), "On: chat floats in the popover");
  is(home.linkedBrowser.getBoundingClientRect().width, pageWidth, "The page doesn't move");
  const panels = document.getElementById("tabbrowser-tabpanels").getBoundingClientRect();
  Assert.less(chatEl().getBoundingClientRect().left - panels.left, 40, "Next to the sidebar");

  const menu = chat().headMenu;
  const shownEvent = BrowserTestUtils.waitForEvent(menu, "popupshown");
  menu.openPopup(chatEl(), "after_start");
  await shownEvent;
  const popover = document.getElementById("whimsy-chat-menu-popover");
  await TestUtils.waitForCondition(() => popover.label == "Show Chat as Popover", "Its name");
  is(popover.getAttribute("checked"), "true", "Checked");
  ok(popover.previousElementSibling.disabled, "Moving chat is off while it floats");
  await closeMenu(menu);

  // One thing at a time.
  const ess = await makeEssential("https://example.org/?with-chat");
  await pressCmdE();
  ok(chat().isOpen, "Chat open again");
  await clickTile(ess, true);
  await TestUtils.waitForCondition(() => !chat().isOpen, "A site in the popover closes chat");
  await pressCmdE();
  await hidden(ess, "Chat in the popover hides the site");
  EventUtils.synthesizeMouse(home.linkedBrowser, home.linkedBrowser.getBoundingClientRect().width - 40, 200, {});
  await TestUtils.waitForCondition(() => !chat().isOpen, "A page click closes chat in the popover");
  await settleChat();

  Services.prefs.setBoolPref("whimsy.chat.popover", false);
  await pressCmdE();
  ok(!chatEl().hasAttribute("whimsy-popover"), "Off again: a column");
  chat().close({ reason: "key" });
  await settleChat();
  } finally {
    await WhimsyAIStore._resetForTesting(null);
    await SpecialPowers.popPrefEnv();
  }
});
