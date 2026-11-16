/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// W29: Pass Keys to Page (WhimsyKeysToPage.sys.mjs,
// whimsy-GlobalKeyListener-cpp.patch).

const { WhimsyCommands } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyCommands.sys.mjs");
const { WhimsyKeysToPage } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyKeysToPage.sys.mjs");
const { WhimsyShortcuts } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyShortcuts.sys.mjs");
const { globalActions } = ChromeUtils.importESModule("resource:///modules/ZenUBGlobalActions.sys.mjs");

const ID = "cmd_whimsyPassKeysToPage";
const DIR = getRootDirectory(gTestPath);
const PAGE = DIR.replace("chrome://mochitests/content", "https://example.com") + "whimsy_pass_keys.html";
const OTHER_SITE = DIR.replace("chrome://mochitests/content", "https://example.org") + "whimsy_pass_keys.html";
const TOAST_SHOWN_PREF = "whimsy.pass-keys-to-page.toast-shown";
const LONG_PRESS_PREF = "dom.fullscreen.keyboard_lock.long_press_interval";
const WARNING_PREF = "dom.fullscreen.keyboard_lock.long_press_warning_interval";

function action() {
  return globalActions.find(a => a.whimsyCommand == ID);
}

async function openPage(url = PAGE) {
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, url);
  const browser = tab.linkedBrowser;
  await focusPage(browser);
  return tab;
}

// Keys go to the focused <browser> whether or not the app is in front (the
// lane runs chunks side by side, so it may not be), as in
// browser_whimsy_allow_copy_keys.js.
async function focusPage(browser) {
  browser.focus();
  await TestUtils.waitForCondition(() => document.activeElement == browser, "The page has focus");
}

function pageKeys(browser) {
  return SpecialPowers.spawn(browser, [], () => [...content.wrappedJSObject.keys]);
}

function clearPageKeys(browser) {
  return SpecialPowers.spawn(browser, [], () => {
    content.wrappedJSObject.keys.length = 0;
  });
}

async function pageSaw(browser, key, message) {
  await TestUtils.waitForCondition(async () => (await pageKeys(browser)).includes(key), message);
}

function pill() {
  return document.getElementById("whimsy-pass-keys-pill");
}

async function passKeys(browser) {
  document.getElementById(ID).doCommand();
  ok(browser.whimsyPassKeys, "The tab passes keys");
  await focusPage(browser);
}

function resolvedRGB(value) {
  const canvas = document.createElementNS("http://www.w3.org/1999/xhtml", "canvas");
  canvas.width = canvas.height = 1;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, 1, 1);
  ctx.fillStyle = value;
  ctx.fillRect(0, 0, 1, 1);
  return [...ctx.getImageData(0, 0, 1, 1).data.slice(0, 3)];
}
function luminance([r, g, b]) {
  const lin = c => ((c /= 255) <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}
function contrastRatio(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

registerCleanupFunction(() => closeToasts());

add_setup(async function () {
  // DIAG: which prefs this file leaves changed.
  const before = new Set(await SpecialPowers.comparePrefsToBaseline([]));
  registerCleanupFunction(async () => {
    await SpecialPowers.flushPrefEnv();
    const after = [].concat(await SpecialPowers.comparePrefsToBaseline([]));
    info(`WHIMSYDIAG changed: ${after.filter(k => !before.has(k)).join(", ")}`);
  });
  await SpecialPowers.pushPrefEnv({
    set: [
      [TOAST_SHOWN_PREF, false],
      ["whimsy.feature.pass-keys-to-page", true],
    ],
  });
  closeToasts();
});

add_task(function test_registered_without_key_or_detail() {
  const entry = WhimsyCommands.get(ID);
  ok(entry, "The command is registered");
  is(entry?.l10nId, "whimsy-action-pass-keys-to-page", "Named for the command bar and about:keyboard");
  const keyEl = entry?.keyId && document.getElementById(entry.keyId);
  ok(keyEl, "It has a <key>, so a shortcut can be assigned");
  ok(!keyEl?.hasAttribute("key") && !keyEl?.hasAttribute("keycode"), "No default shortcut");
  is(action()?.label, "Pass Keys to Page", "The command bar's row");
  ok(!action()?.description && !action()?.detail, "No detail line (owner, W29)");
  ok(action()?.whimsyKeywords?.includes("Vim"), "Found by Vim too");
});

add_task(async function test_reserved_keys_reach_the_page() {
  const tab = await openPage();
  const browser = tab.linkedBrowser;
  try {
    // Without it, ⌘T is the browser's and the page never sees it.
    const tabs = gBrowser.tabs.length;
    EventUtils.synthesizeKey("t", { accelKey: true });
    await TestUtils.waitForCondition(() => gBrowser.tabs.length == tabs + 1, "⌘T opens a tab as usual");
    BrowserTestUtils.removeTab(gBrowser.selectedTab);
    // switchTab waits for a switch, which never comes if closing the new
    // tab already went back to this one.
    if (gBrowser.selectedTab != tab) {
      await BrowserTestUtils.switchTab(gBrowser, tab);
    }
    await focusPage(browser);
    ok(!(await pageKeys(browser)).includes("M-t"), "The page never saw ⌘T");

    ok(action()?.isAvailable(window), "Offered on a web page");
    await passKeys(browser);
    ok(browser.hasAttribute("whimsy-pass-keys"), "The <browser> is marked for the engine");
    ok(WhimsyShortcuts.isPassing(window), "The shared check says so");
    ok(!action()?.isAvailable(window), "Not offered again while it's on");
    await TestUtils.waitForCondition(() => pill() && BrowserTestUtils.isVisible(pill()), "The pill shows");
    is(pill().getAttribute("tooltiptext"), "Keys go to this page. Hold Esc or click to stop.", "Its tooltip");
    await TestUtils.waitForCondition(() => toastFor("whimsy-pass-keys-on-toast"), "The one-time toast shows");
    ok(Services.prefs.getBoolPref(TOAST_SHOWN_PREF), "and won't show again");

    EventUtils.synthesizeKey("t", { accelKey: true });
    EventUtils.synthesizeKey("w", { accelKey: true });
    await pageSaw(browser, "M-t", "⌘T reaches the page");
    await pageSaw(browser, "M-w", "⌘W reaches the page");
    is(gBrowser.tabs.length, tabs, "No tab opened");
    ok(tab.isConnected && gBrowser.selectedTab == tab, "and none closed");

    // ⌘L waits for the page; the page lets it through, and the browser
    // still doesn't act on it.
    EventUtils.synthesizeKey("l", { accelKey: true });
    await pageSaw(browser, "M-l", "⌘L reaches the page");
    await TestUtils.waitForTick();
    is(document.activeElement, browser, "The address bar didn't take focus");

    // macOS keeps Quit, Hide, and Minimize: menu keys the engine never
    // hands to a page (internal <key>s, run by the app menu).
    for (const id of ["key_quitApplication", "key_hideThisAppCmdMac", "key_minimizeWindow"]) {
      is(document.getElementById(id)?.getAttribute("internal"), "true", `${id} stays macOS's`);
    }
  } finally {
    WhimsyKeysToPage.stop(window, browser);
    BrowserTestUtils.removeTab(tab);
    closeToasts();
  }
});

add_task(async function test_whimsy_listeners_are_skipped() {
  const tab = await openPage();
  const browser = tab.linkedBrowser;
  const seen = [];
  const spy = event => seen.push(event.key);
  window.addEventListener("keydown", spy, true);
  try {
    await passKeys(browser);
    EventUtils.synthesizeKey("a");
    await pageSaw(browser, "a", "The page gets the key");
    is(seen.length, 0, "A capture listener in the window never sees it");

    WhimsyKeysToPage.stop(window, browser);
    await focusPage(browser);
    EventUtils.synthesizeKey("b");
    await pageSaw(browser, "b", "Afterwards the page still gets keys");
    Assert.deepEqual(seen, ["b"], "and the window's listeners see them again");
  } finally {
    window.removeEventListener("keydown", spy, true);
    WhimsyKeysToPage.stop(window, browser);
    BrowserTestUtils.removeTab(tab);
    closeToasts();
  }
});

add_task(async function test_hold_escape() {
  await SpecialPowers.pushPrefEnv({
    set: [
      [LONG_PRESS_PREF, 300],
      [WARNING_PREF, 100],
    ],
  });
  const tab = await openPage();
  const browser = tab.linkedBrowser;
  try {
    await passKeys(browser);
    EventUtils.synthesizeKey("KEY_Escape");
    await pageSaw(browser, "Escape", "A short Esc goes to the page");
    ok(browser.whimsyPassKeys, "and keys still pass");
    ok(!toastFor("whimsy-pass-keys-hold"), "No hold notice for a short press");

    await clearPageKeys(browser);
    EventUtils.synthesizeKey("KEY_Escape", { type: "keydown" });
    await TestUtils.waitForCondition(() => toastFor("whimsy-pass-keys-hold"), "Holding shows the notice");
    ok(
      toastFor("whimsy-pass-keys-hold").element.querySelector(".whimsy-pass-keys-ring"),
      "with its ring"
    );
    await TestUtils.waitForCondition(() => !browser.whimsyPassKeys, "Holding Esc ends it");
    EventUtils.synthesizeKey("KEY_Escape", { type: "keyup" });
    await pageSaw(browser, "Escape", "The held Esc went to the page too");
    ok(!browser.hasAttribute("whimsy-pass-keys"), "The engine mark is gone");
    ok(pill().hidden, "The pill hides");
    await TestUtils.waitForCondition(() => toastFor("whimsy-pass-keys-off-toast"), "The off toast shows");
    is(toastFor("whimsy-pass-keys-off-toast").element.textContent.includes("shortcuts are back"), true, "Its words");
    await TestUtils.waitForCondition(() => !toastFor("whimsy-pass-keys-hold"), "The hold notice goes");
  } finally {
    WhimsyKeysToPage.stop(window, browser);
    BrowserTestUtils.removeTab(tab);
    closeToasts();
    await SpecialPowers.popPrefEnv();
  }
});

add_task(async function test_tab_switch_pill_and_site_end_it() {
  const other = await BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE);
  const tab = await openPage();
  const browser = tab.linkedBrowser;
  try {
    // Switching tabs.
    await passKeys(browser);
    await BrowserTestUtils.switchTab(gBrowser, other);
    ok(!browser.whimsyPassKeys, "Switching tabs ends it");
    ok(pill().hidden, "No pill on the other tab");
    await BrowserTestUtils.switchTab(gBrowser, tab);
    ok(!browser.whimsyPassKeys, "Coming back doesn't turn it on again");

    // The pill.
    await passKeys(browser);
    await TestUtils.waitForCondition(() => BrowserTestUtils.isVisible(pill()), "The pill shows");
    EventUtils.synthesizeMouseAtCenter(pill(), {});
    ok(!browser.whimsyPassKeys, "Clicking the pill ends it");

    // The same site keeps it; another site ends it.
    await passKeys(browser);
    let loaded = BrowserTestUtils.browserLoaded(browser);
    BrowserTestUtils.startLoadingURIString(browser, PAGE + "?again");
    await loaded;
    ok(browser.whimsyPassKeys, "Moving within the site keeps it");
    loaded = BrowserTestUtils.browserLoaded(browser);
    browser.reload();
    await loaded;
    ok(browser.whimsyPassKeys, "Reloading keeps it");
    loaded = BrowserTestUtils.browserLoaded(browser);
    BrowserTestUtils.startLoadingURIString(browser, OTHER_SITE);
    await loaded;
    ok(!browser.whimsyPassKeys, "Another site ends it");
    ok(!browser.hasAttribute("whimsy-pass-keys"), "and the engine mark goes with it");
  } finally {
    WhimsyKeysToPage.stop(window, browser);
    BrowserTestUtils.removeTab(tab);
    BrowserTestUtils.removeTab(other);
    closeToasts();
  }
});

add_task(async function test_feature_switch() {
  const tab = await openPage();
  try {
    await SpecialPowers.pushPrefEnv({ set: [["whimsy.feature.pass-keys-to-page", false]] });
    ok(!action()?.isAvailable(window), "Not offered with its switch off");
    document.getElementById(ID).doCommand();
    ok(!tab.linkedBrowser.whimsyPassKeys, "Running it does nothing");
    await SpecialPowers.popPrefEnv();
  } finally {
    BrowserTestUtils.removeTab(tab);
  }
});

add_task(async function test_pill_contrast_and_shots() {
  const tab = await openPage();
  const browser = tab.linkedBrowser;
  try {
    await passKeys(browser);
    await TestUtils.waitForCondition(() => BrowserTestUtils.isVisible(pill()), "The pill shows");
    for (const dark of [false, true]) {
      await whimsySetScheme(dark);
      const style = getComputedStyle(pill());
      const ratio = contrastRatio(resolvedRGB(style.color), resolvedRGB(style.backgroundColor));
      Assert.greaterOrEqual(ratio, 4.5, `The pill's words clear WCAG AA (${dark ? "dark" : "light"}: ${ratio.toFixed(2)})`);
      await SpecialPowers.popPrefEnv();
    }
    await whimsyBothSchemes("w29-pass-keys-pill", async () => {
      closeToasts();
      await focusPage(browser);
      await SpecialPowers.pushPrefEnv({ set: [[LONG_PRESS_PREF, 600000], [WARNING_PREF, 0]] });
      EventUtils.synthesizeKey("KEY_Escape", { type: "keydown" });
      await TestUtils.waitForCondition(() => toastFor("whimsy-pass-keys-hold"), "The hold notice shows");
      // The ring held two-thirds full for the shot.
      for (const animation of toastFor("whimsy-pass-keys-hold").element.querySelector(".whimsy-pass-keys-ring").getAnimations()) {
        animation.pause();
        animation.currentTime = 400000;
      }
      return async () => {
        EventUtils.synthesizeKey("KEY_Escape", { type: "keyup" });
        await TestUtils.waitForCondition(() => !toastFor("whimsy-pass-keys-hold"), "Letting go takes it down");
        await SpecialPowers.popPrefEnv();
      };
    });
    ok(browser.whimsyPassKeys, "Letting go early keeps keys passing");
  } finally {
    WhimsyKeysToPage.stop(window, browser);
    BrowserTestUtils.removeTab(tab);
    closeToasts();
  }
});
