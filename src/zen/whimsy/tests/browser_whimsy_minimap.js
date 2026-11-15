/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// W28: Page Minimap (WhimsyMinimap). Off by default; Show Page Minimap in
// the command bar turns it on in every window. It shows only on pages more
// than two screens long (a toast says so on a short one), a click centres
// that spot, dragging the outline scrolls, it fades when idle, it sits under
// an open find card, and the setting holds in a new window.

const { WhimsyMinimap } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyMinimap.sys.mjs");
const { WhimsyCommands } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyCommands.sys.mjs");
const { globalActions } = ChromeUtils.importESModule("resource:///modules/ZenUBGlobalActions.sys.mjs");

const ID = "cmd_whimsyPageMinimap";
const PREF = "whimsy.minimap.enabled";
const IDLE_PREF = "whimsy.minimap.idle-ms";
const DIR = getRootDirectory(gTestPath).replace("chrome://mochitests/content", "https://example.com");
const LONG = DIR + "whimsy_minimap_long.html";
const SHORT = DIR + "whimsy_minimap_short.html";

function action(l10nId) {
  return globalActions.find(a => a.whimsyCommand == ID && a.l10nId == l10nId);
}

function minimapFor(browser) {
  const container = browser.closest(".browserContainer");
  return container?.querySelector(":scope > .whimsy-minimap") ?? null;
}

function shown(browser) {
  const el = minimapFor(browser);
  return !!el && !el.hidden;
}

function awake(browser) {
  return shown(browser) && !minimapFor(browser).classList.contains("is-idle");
}

function pageScroll(browser) {
  return SpecialPowers.spawn(browser, [], () => ({
    y: content.scrollY,
    max: content.scrollMaxY,
    view: content.innerHeight,
  }));
}

function scrollPage(browser, y) {
  return SpecialPowers.spawn(browser, [y], top => content.scrollTo({ top, behavior: "instant" }));
}

// The picture's height in the track, from the page's own numbers.
function pictureHeight(browser) {
  const state = WhimsyMinimap.view(browser).state;
  return (state.height * 86) / state.width;
}

// Moves the pointer onto the page, away from the minimap.
function pointerOff(browser) {
  EventUtils.synthesizeMouse(browser, 40, 40, { type: "mousemove" }, window);
}

async function turnOn() {
  ok(action("whimsy-action-page-minimap-show")?.isAvailable(window), "Show Page Minimap is offered");
  document.getElementById(ID).doCommand();
  await TestUtils.waitForCondition(() => Services.prefs.getBoolPref(PREF), "It's on");
}

async function openLong() {
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, LONG);
  const browser = tab.linkedBrowser;
  try {
    await TestUtils.waitForCondition(() => shown(browser), "The minimap shows on a five-screen page");
  } catch (e) {
    BrowserTestUtils.removeTab(tab);
    throw e;
  }
  return { tab, browser, el: minimapFor(browser) };
}

registerCleanupFunction(() => {
  Services.prefs.clearUserPref(PREF);
  Services.prefs.clearUserPref(IDLE_PREF);
  closeToasts();
});

add_setup(async () => {
  closeToasts();
  // Long enough that it never fades mid-check; the idle task shortens it.
  Services.prefs.setIntPref(IDLE_PREF, 600000);
});

add_task(async function test_off_by_default_and_named() {
  ok(!Services.prefs.getBoolPref(PREF), "Off by default");
  const entry = WhimsyCommands.get(ID);
  ok(entry, "The command is registered");
  is(entry?.l10nId, "whimsy-action-page-minimap-toggle", "Its neutral name is for about:keyboard");
  const keyEl = entry?.keyId && document.getElementById(entry.keyId);
  ok(!keyEl?.hasAttribute("key") && !keyEl?.hasAttribute("keycode"), "No default shortcut");
  is(action("whimsy-action-page-minimap-show")?.label, "Show Page Minimap", "The command bar's show row");
  is(action("whimsy-action-page-minimap-hide")?.label, "Hide Page Minimap", "The command bar's hide row");
  ok(!action("whimsy-action-page-minimap-hide")?.isAvailable(window), "Hide isn't offered while it's off");
  ok(action("whimsy-action-page-minimap-show")?.whimsyKeywords?.includes("scroll map"), "Found by scroll map too");

  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, LONG);
  try {
    ok(!minimapFor(tab.linkedBrowser), "No minimap while it's off, even on a long page");
    Assert.throws(
      () => tab.linkedBrowser.browsingContext.currentWindowGlobal.getActor("WhimsyMinimap"),
      /./,
      "No page side runs while it's off"
    );
  } finally {
    BrowserTestUtils.removeTab(tab);
  }
});

add_task(async function test_short_page_toast_then_long_page() {
  const shortTab = await BrowserTestUtils.openNewForegroundTab(gBrowser, SHORT);
  try {
    await turnOn();
    // DEBUG
    let dbg;
    try {
      const r = await shortTab.linkedBrowser.browsingContext.currentWindowGlobal.getActor("WhimsyMinimap").sendQuery("WhimsyMinimap:Start");
      dbg = JSON.stringify(r);
    } catch (e) {
      dbg = "ERR " + e;
    }
    ok(true, "DEBUG start " + dbg);
    try {
      dbg = JSON.stringify(await WhimsyMinimap.start(shortTab.linkedBrowser));
    } catch (e) {
      dbg = "ERR " + e;
    }
    ok(true, "DEBUG module start " + dbg + " on=" + WhimsyMinimap.on);
    const toast = await TestUtils.waitForCondition(() => toastFor("whimsy-minimap-short-toast"), "A short page says why");
    ok(toast, "Page Minimap shows on long pages");
    ok(!shown(shortTab.linkedBrowser), "No minimap on a one-screen page");
    ok(action("whimsy-action-page-minimap-hide")?.isAvailable(window), "Hide Page Minimap is offered now");
    closeToasts();

    const { browser, el, tab } = await openLong();
    try {
      is(el.getAttribute("role"), "scrollbar", "It's a scrollbar to assistive tech");
      await TestUtils.waitForCondition(() => el.getAttribute("aria-label") == "Page minimap", "It's labelled");
      is(el.getAttribute("aria-valuenow"), "0", "At the top");
      const box = el.getBoundingClientRect();
      const page = browser.getBoundingClientRect();
      is(Math.round(box.width), 104, "104px wide");
      is(Math.round(page.right - box.right), 10, "10px from the page's right edge");
      is(Math.round(box.top - page.top), 10, "10px from the page's top");

      // Light and dark, a screen down the page.
      await scrollPage(browser, (await pageScroll(browser)).view);
      await whimsyBothSchemes("w28-minimap", async () => {
        WhimsyMinimap.view(browser).wake();
        await TestUtils.waitForCondition(() => awake(browser), "Awake for the shot");
        await TestUtils.waitForCondition(() => el.querySelector("canvas").width > 0, "The page is pictured");
      });
    } finally {
      BrowserTestUtils.removeTab(tab);
    }
  } finally {
    BrowserTestUtils.removeTab(shortTab);
  }
});

add_task(async function test_click_jumps_and_drag_scrolls() {
  await SpecialPowers.pushPrefEnv({ set: [["ui.prefersReducedMotion", 1]] });
  const { browser, el, tab } = await openLong();
  try {
    WhimsyMinimap.view(browser).wake();
    await TestUtils.waitForCondition(() => awake(browser), "Awake");
    const track = el.querySelector(".whimsy-minimap-track");
    const picture = pictureHeight(browser);

    // A click halfway down the picture centres the page's middle.
    EventUtils.synthesizeMouse(track, 43, picture / 2, {}, window);
    const { max } = await pageScroll(browser);
    await TestUtils.waitForCondition(async () => {
      const { y } = await pageScroll(browser);
      return Math.abs(y - max / 2) < max * 0.05;
    }, "The page scrolled to about its middle");
    await TestUtils.waitForCondition(() => el.getAttribute("aria-valuenow") == "50", "aria-valuenow is 50");

    // Dragging the outline scrolls with it.
    await scrollPage(browser, 0);
    await TestUtils.waitForCondition(() => WhimsyMinimap.view(browser).state.y == 0, "Back at the top");
    const outline = el.querySelector(".whimsy-minimap-view");
    const grab = outline.getBoundingClientRect().height / 2;
    const scale = 86 / WhimsyMinimap.view(browser).state.width;
    EventUtils.synthesizeMouse(track, 43, grab, { type: "mousedown" }, window);
    ok(el.classList.contains("is-dragging"), "Dragging");
    EventUtils.synthesizeMouse(track, 43, grab + 30, { type: "mousemove" }, window);
    EventUtils.synthesizeMouse(track, 43, grab + 60, { type: "mousemove" }, window);
    EventUtils.synthesizeMouse(track, 43, grab + 60, { type: "mouseup" }, window);
    ok(!el.classList.contains("is-dragging"), "The drag ended");
    const want = Math.min(60 / scale, max);
    await TestUtils.waitForCondition(async () => {
      const { y } = await pageScroll(browser);
      return Math.abs(y - want) < want * 0.1;
    }, "The page followed the outline");
  } finally {
    BrowserTestUtils.removeTab(tab);
    await SpecialPowers.popPrefEnv();
  }
});

add_task(async function test_fades_when_idle_and_returns_on_scroll() {
  const { browser, el, tab } = await openLong();
  try {
    pointerOff(browser);
    Services.prefs.setIntPref(IDLE_PREF, 300);
    WhimsyMinimap.view(browser).wake();
    await TestUtils.waitForCondition(() => awake(browser), "Awake");
    await TestUtils.waitForCondition(() => el.classList.contains("is-idle"), "It fades when idle");
    is(getComputedStyle(el).pointerEvents, "none", "A faded minimap can't be clicked");

    Services.prefs.setIntPref(IDLE_PREF, 600000);
    await scrollPage(browser, 400);
    await TestUtils.waitForCondition(() => awake(browser), "Scrolling brings it back");
  } finally {
    Services.prefs.setIntPref(IDLE_PREF, 600000);
    BrowserTestUtils.removeTab(tab);
  }
});

add_task(async function test_sits_under_the_find_card() {
  const { browser, el, tab } = await openLong();
  try {
    WhimsyMinimap.view(browser).wake();
    EventUtils.synthesizeKey("f", { accelKey: true });
    const findbar = await TestUtils.waitForCondition(
      () => gBrowser.isFindBarInitialized() && gBrowser.getCachedFindBar(),
      "The find bar exists"
    );
    await TestUtils.waitForCondition(() => !findbar.hidden, "Cmd+F opens it");
    await TestUtils.waitForCondition(() => getComputedStyle(el).marginTop == "62px", "It moves down under the card");
    await whimsySettled();
    ok(
      el.getBoundingClientRect().top >= findbar.getBoundingClientRect().bottom,
      "It starts below the find card"
    );
    findbar.close(true);
    await TestUtils.waitForCondition(() => getComputedStyle(el).marginTop == "10px", "Back up when Find closes");
  } finally {
    BrowserTestUtils.removeTab(tab);
  }
});

add_task(async function test_holds_in_a_new_window_then_off() {
  const win = await BrowserTestUtils.openNewBrowserWindow();
  try {
    ok(
      globalActions.find(a => a.whimsyCommand == ID && a.l10nId == "whimsy-action-page-minimap-hide")?.isAvailable(win),
      "Still on in a new window"
    );
    await BrowserTestUtils.openNewForegroundTab(win.gBrowser, LONG);
    await TestUtils.waitForCondition(() => shown(win.gBrowser.selectedBrowser), "It shows on a long page there");

    win.document.getElementById(ID).doCommand();
    await TestUtils.waitForCondition(() => !Services.prefs.getBoolPref(PREF), "Hide Page Minimap turns it off");
    await TestUtils.waitForCondition(
      () => !win.document.querySelector(".whimsy-minimap") && !document.querySelector(".whimsy-minimap"),
      "Gone from every window"
    );
  } finally {
    await BrowserTestUtils.closeWindow(win);
  }
});
