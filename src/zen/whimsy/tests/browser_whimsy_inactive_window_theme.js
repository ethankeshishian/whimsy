/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// W10-31: the space theme keeps its colors when the window loses focus
// (Arc). Zen greys an inactive window out behind
// zen.view.grey-out-inactive-windows: #zen-main-app-wrapper turns
// InactiveCaption (zen-browser-ui.css) and the macOS window material follows
// the window's active state (nsCocoaWindow-mm.patch). Whimsy turns the pref
// off by default (whimsy/overlay.py PREF_OVERRIDES), so the theme surfaces
// compute the same colors with the window active and inactive.

const GREY_OUT = "zen.view.grey-out-inactive-windows";

// The surfaces that paint the space theme.
const SURFACES = [
  "#zen-main-app-wrapper",
  "#navigator-toolbox",
  "#zen-appcontent-wrapper",
  "#browser",
  ".zen-browser-generic-background",
  ".zen-toolbar-background",
];
const THEME_VARS = ["--zen-primary-color", "--zen-main-browser-background", "--zen-themed-toolbar-bg-transparent"];

function snapshot(win) {
  const doc = win.document;
  const out = {};
  for (const selector of SURFACES) {
    doc.querySelectorAll(selector).forEach((el, i) => {
      const cs = win.getComputedStyle(el);
      out[`${selector}[${i}]`] = `${cs.backgroundColor} | ${cs.backgroundImage}`;
    });
  }
  const rootStyle = win.getComputedStyle(doc.documentElement);
  for (const name of THEME_VARS) {
    out[name] = rootStyle.getPropertyValue(name).trim();
  }
  return out;
}

// Let any color transition started by the activation change finish, so the
// computed values are the settled ones.
async function settle(win) {
  const transitions = win.document.getAnimations().filter(a => a instanceof win.CSSTransition);
  transitions.forEach(a => a.finish());
  await new Promise(r => win.requestAnimationFrame(() => win.requestAnimationFrame(r)));
}

function isInactive(win) {
  return win.document.getElementById("zen-main-app-wrapper").matches(":-moz-window-inactive");
}

async function activate(win) {
  await SimpleTest.promiseFocus(win);
  await TestUtils.waitForCondition(() => !isInactive(win), "window is active");
  await settle(win);
}

// Opens a second window so `window` turns inactive; returns that window.
async function deactivateMainWindow() {
  const other = await BrowserTestUtils.openNewBrowserWindow();
  await SimpleTest.promiseFocus(other);
  await TestUtils.waitForCondition(() => isInactive(window), "main window is inactive behind another window");
  await settle(window);
  return other;
}

add_task(async function test_default_keeps_theme_colors() {
  is(Services.prefs.getDefaultBranch("").getBoolPref(GREY_OUT), false,
    "Whimsy doesn't grey inactive windows out by default");
  ok(!Services.prefs.prefHasUserValue(GREY_OUT), "the test runs on the default value");

  await activate(window);
  const active = snapshot(window);
  ok(Object.keys(active).some(k => k.startsWith("#zen-main-app-wrapper")), "the theme surfaces are measured");

  const other = await deactivateMainWindow();
  const inactive = snapshot(window);
  for (const key of Object.keys(active)) {
    is(inactive[key], active[key], `${key} keeps its color while the window is inactive`);
  }

  await BrowserTestUtils.closeWindow(other);
  await activate(window);
  Assert.deepEqual(snapshot(window), active, "the colors are unchanged after the window is active again");
});

// Control: with Zen's grey-out switched back on the same measurement sees the
// inactive color, so the check above would catch the regression.
add_task(async function test_grey_out_pref_is_what_changes_it() {
  await SpecialPowers.pushPrefEnv({ set: [[GREY_OUT, true]] });
  await activate(window);
  const active = snapshot(window);

  const other = await deactivateMainWindow();
  const key = "#zen-main-app-wrapper[0]";
  isnot(snapshot(window)[key], active[key], "Zen's grey-out repaints the window when it is inactive");

  await BrowserTestUtils.closeWindow(other);
  await SpecialPowers.popPrefEnv();
  await activate(window);
});
