/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// W32 P2 (perf-sheets-css): each panel's sheet loads the first time that
// panel opens, not with every window. A new window has none of them; each
// panel then finds its sheet already applied when it is first put in the
// document or about to show, so its first frame is the styled one. The
// command bar's mic and the address bar's page actions show from window
// start, so their rules moved into whimsy-browser.css.

ChromeUtils.defineESModuleGetters(this, {
  UrlbarTestUtils: "resource://testing-common/UrlbarTestUtils.sys.mjs",
  WhimsyAmbient: "resource:///modules/whimsy/WhimsyAmbient.sys.mjs",
  WhimsyDictation: "resource:///modules/whimsy/WhimsyDictation.sys.mjs",
  WhimsyPageActions: "resource:///modules/whimsy/WhimsyPageActions.sys.mjs",
  WhimsyReadAloud: "resource:///modules/whimsy/WhimsyReadAloud.sys.mjs",
  WhimsySheets: "resource:///modules/whimsy/WhimsySheets.sys.mjs",
});

const BASE = "chrome://browser/content/whimsy/";
const LAZY = [
  "whimsy-ambient.css",
  "whimsy-dictation.css",
  "whimsy-emoji.css",
  "whimsy-find-card.css",
  "whimsy-minimap.css",
  "whimsy-navigation.css",
  "whimsy-read-aloud.css",
  "whimsy-tabsearch.css",
];
const DIR = getRootDirectory(gTestPath).replace("chrome://mochitests/content", "https://example.com");
const LONG = DIR + "whimsy_minimap_long.html";
const TRAIL = "https://example.com/browser/whimsy-lazy-sheets";

// Sheets added with loadSheetUsingURIString aren't listed by
// InspectorUtils.getAllStyleSheets, so ask the loader.
function sheetIn(win, name) {
  return WhimsySheets.isLoaded(win, BASE + name);
}

// Resolves with what `check` returned the moment `selector` first matched
// in the window (a MutationObserver callback runs before the next paint).
function onFirstMatch(win, selector, check) {
  return new Promise(resolve => {
    const doc = win.document;
    const found = doc.querySelector(selector);
    if (found) {
      resolve(check(found));
      return;
    }
    const observer = new win.MutationObserver(() => {
      const el = doc.querySelector(selector);
      if (el) {
        observer.disconnect();
        resolve(check(el));
      }
    });
    observer.observe(doc.documentElement, { childList: true, subtree: true, attributes: true });
  });
}

// Resolves with what `check` returned when the popup `id` began to show.
function onPopupShowing(win, id, check) {
  return new Promise(resolve => {
    const listener = event => {
      if (event.target.id == id) {
        win.removeEventListener("popupshowing", listener, true);
        resolve(check(event.target));
      }
    };
    win.addEventListener("popupshowing", listener, true);
  });
}

async function hide(popup) {
  if (popup?.state == "open" || popup?.state == "showing") {
    const hidden = BrowserTestUtils.waitForPopupEvent(popup, "hidden");
    popup.hidePopup();
    await hidden;
  }
}

let win;

add_setup(async function () {
  await SpecialPowers.pushPrefEnv({
    set: [
      ["whimsy.feature.ambient-audio", true],
      ["whimsy.feature.command-bar-emoji", true],
      ["whimsy.feature.dictation", true],
      ["whimsy.feature.find-card", true],
      ["whimsy.feature.page-actions", true],
      ["whimsy.feature.page-minimap", true],
      ["whimsy.feature.read-aloud", true],
      ["whimsy.feature.trails", true],
      ["whimsy.minimap.enabled", false],
      ["browser.navigation.requireUserInteraction", false],
    ],
  });
  win = await BrowserTestUtils.openNewBrowserWindow();
  registerCleanupFunction(async () => {
    WhimsyAmbient.stop?.(win, { immediate: true });
    await BrowserTestUtils.closeWindow(win);
  });
});

add_task(async function a_new_window_loads_none_of_them() {
  await TestUtils.waitForCondition(() => win.document.getElementById("whimsy-dictation-mic"), "The command bar's mic is mounted");
  for (const name of LAZY) {
    ok(!sheetIn(win, name), `${name} isn't loaded at window start`);
  }
  // The mic's rules now live in whimsy-browser.css, so it is styled already.
  const mic = getComputedStyle(win.document.getElementById("whimsy-dictation-mic"));
  is(mic.borderTopLeftRadius, "8px", "The mic has its shape before dictation's sheet loads");
  is(mic.width, "28px", "and its size");
});

add_task(async function ambient_sheet() {
  const showing = onPopupShowing(win, "whimsy-ambient-sheet", panel => ({
    loaded: sheetIn(win, "whimsy-ambient.css"),
    display: getComputedStyle(panel.querySelector(".whimsy-ambient-grid")).display,
  }));
  WhimsyAmbient.openSheet(win);
  const seen = await showing;
  ok(seen.loaded, "Ambient's sheet is loaded before its sheet shows");
  is(seen.display, "grid", "and its tiles are laid out on the first frame");
  await hide(win.document.getElementById("whimsy-ambient-sheet"));
});

add_task(async function emoji_sheet() {
  const mounted = onFirstMatch(win, ".whimsy-emoji-card", card => ({
    loaded: sheetIn(win, "whimsy-emoji.css"),
    display: getComputedStyle(card).display,
  }));
  await UrlbarTestUtils.promiseAutocompleteResultPopup({ window: win, waitForFocus: SimpleTest.waitForFocus, value: ":smile" });
  const seen = await mounted;
  ok(seen.loaded, "Emoji's sheet is loaded before its card is in the bar");
  const grid = await TestUtils.waitForCondition(() => win.gURLBar.view.panel.querySelector(".whimsy-emoji-grid"), "The grid drew");
  is(getComputedStyle(grid).display, "grid", "and the grid is laid out");
  win.gURLBar.view.close();
  win.gURLBar.handleRevert();
});

add_task(async function find_card_and_minimap_sheets() {
  const tab = await BrowserTestUtils.openNewForegroundTab(win.gBrowser, LONG);
  const attached = onFirstMatch(win, "findbar[whimsy-find-card]", findbar => ({
    loaded: sheetIn(win, "whimsy-find-card.css"),
    track: getComputedStyle(findbar).getPropertyValue("--whimsy-find-track"),
  }));
  tab.linkedBrowser.focus();
  EventUtils.synthesizeKey("f", { accelKey: true }, win);
  const seen = await attached;
  ok(seen.loaded, "The find card's sheet is loaded before the find bar becomes the card");
  ok(seen.track, "and the card's tokens apply at once");
  const findbar = win.gBrowser.getCachedFindBar();
  findbar.close(true);

  const built = onFirstMatch(win, ".browserContainer > .whimsy-minimap", el => ({
    loaded: sheetIn(win, "whimsy-minimap.css"),
    justify: getComputedStyle(el).justifySelf,
  }));
  Services.prefs.setBoolPref("whimsy.minimap.enabled", true);
  const map = await built;
  ok(map.loaded, "The minimap's sheet is loaded before the minimap is built");
  is(map.justify, "end", "and it sits at the page's right edge from the start");
  Services.prefs.setBoolPref("whimsy.minimap.enabled", false);
  BrowserTestUtils.removeTab(tab);
});

add_task(async function read_aloud_and_dictation_sheets() {
  const made = onFirstMatch(win, "#whimsy-read-aloud-player", holder => ({
    loaded: sheetIn(win, "whimsy-read-aloud.css"),
    peek: getComputedStyle(holder).getPropertyValue("--zen-media-stack-peek").trim(),
  }));
  ok(WhimsyReadAloud.holder(win), "The player's holder is made");
  const player = await made;
  ok(player.loaded, "Read aloud's sheet is loaded before its player is in the sidebar");
  is(player.peek, "8px", "and the player's tokens apply at once");

  const pill = onFirstMatch(win, "#whimsy-dictation-pill", el => ({
    loaded: sheetIn(win, "whimsy-dictation.css"),
    position: getComputedStyle(el).position,
  }));
  ok(WhimsyDictation.pill(win), "Dictation's pill is made");
  const seen = await pill;
  ok(seen.loaded, "Dictation's sheet is loaded before its pill is in the window");
  is(seen.position, "fixed", "and the pill is placed from the start");
});

add_task(async function navigation_sheet() {
  const tab = await BrowserTestUtils.openNewForegroundTab(win.gBrowser, `${TRAIL}?a`);
  const browser = tab.linkedBrowser;
  const loaded = BrowserTestUtils.browserLoaded(browser, false, `${TRAIL}?b`);
  BrowserTestUtils.startLoadingURIString(browser, `${TRAIL}?b`);
  await loaded;
  ok(!sheetIn(win, "whimsy-navigation.css"), "Navigation's sheet waits for a trail or Cook mode");

  const showing = onPopupShowing(win, "whimsy-trail", panel => ({
    loaded: sheetIn(win, "whimsy-navigation.css"),
    display: getComputedStyle(panel.querySelector(".whimsy-trail-list")).display,
  }));
  const shown = BrowserTestUtils.waitForEvent(win.document, "popupshown", true, e => e.target.id == "whimsy-trail");
  win.document.getElementById("backForwardMenu").openPopup(win.document.getElementById("back-button"), "after_start");
  const seen = await showing;
  await shown;
  ok(seen.loaded, "Navigation's sheet is loaded before the trail shows");
  is(seen.display, "flex", "and its rows are laid out on the first frame");
  await hide(win.document.getElementById("whimsy-trail"));

  const cook = onPopupShowing(win, "whimsy-cook-panel", panel => getComputedStyle(panel.querySelector(".whimsy-cook-body")).width);
  WhimsyPageActions.openCookMode(win, { name: "Soup", ingredients: ["Water"], steps: ["Boil the water."], yield: "", totalTime: "" });
  is(await cook, "380px", "Cook mode's panel is styled before it shows");
  await hide(win.document.getElementById("whimsy-cook-panel"));
  BrowserTestUtils.removeTab(tab);
});
