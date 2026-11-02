/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// W10-61: Arc's "press again" for the browser's keys (RESERVED_KEYS). A
// page that uses a key itself (cancels its keydown) gets the first press;
// a toast says to press it again, and a second press in a row runs the
// browser's command without reaching the page. A page that doesn't use the
// key never notices: the browser acts on the first press. This covers ⌘S
// Hide Sidebar and ⌘D Pin Tab; ⇧⌘C Copy URL is in
// browser_whimsy_allow_copy_keys.js, real (native) keys in
// browser_whimsy_arc_menu_keys_native.js.

const PAGE =
  getRootDirectory(gTestPath).replace("chrome://mochitests/content", "https://example.com") + "whimsy_press_again.html";
const { WhimsyShortcuts, RESERVED_KEYS, bindingOf, eventSignatures } = ChromeUtils.importESModule(
  "resource:///modules/whimsy/WhimsyShortcuts.sys.mjs"
);
const { AppConstants } = ChromeUtils.importESModule("resource://gre/modules/AppConstants.sys.mjs");
const HINT = "whimsy-press-again-toast";

const took = browser => SpecialPowers.spawn(browser, [], () => [...content.wrappedJSObject.took]);
const hint = () => toastFor(HINT);

// Counts runs of a <key>'s command and keeps it from doing anything.
function watchKey(id) {
  const key = document.getElementById(id);
  const target = key.getAttribute("command") || id;
  const watcher = { runs: 0 };
  watcher.listener = event => {
    if (event.target.id == target) {
      watcher.runs++;
      event.stopPropagation();
    }
  };
  document.addEventListener("command", watcher.listener, true);
  watcher.stop = () => document.removeEventListener("command", watcher.listener, true);
  return watcher;
}

// Presses a letter <key> as bound now.
function press(id) {
  const key = document.getElementById(id);
  const mods = (key.getAttribute("modifiers") || "").split(/[,\s]+/);
  EventUtils.synthesizeKey(key.getAttribute("key").toLowerCase(), {
    accelKey: mods.includes("accel"),
    shiftKey: mods.includes("shift"),
    altKey: mods.includes("alt"),
    ctrlKey: mods.includes("control") || mods.includes("ctrl"),
    metaKey: mods.includes("meta"),
  });
}

async function openPage() {
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE);
  tab.linkedBrowser.focus();
  return tab;
}

add_task(function test_signatures_match_bindings() {
  ok(RESERVED_KEYS.includes("zen-compact-mode-toggle"), "⌘S Hide Sidebar takes part");
  ok(RESERVED_KEYS.includes("zen-copy-url"), "⇧⌘C Copy URL takes part");
  const accel = AppConstants.platform == "macosx" ? { metaKey: true } : { ctrlKey: true };
  const event = (key, code, extra = {}) => ({ key, code, keyCode: 0, ...accel, ...extra });
  ok(eventSignatures(event("s", "KeyS")).includes("accel|S"), "⌘S");
  ok(eventSignatures(event("C", "KeyC", { shiftKey: true })).includes("accel,shift|C"), "⇧⌘C");
  // ⌥ changes the character on a Mac: the key's code still matches.
  ok(eventSignatures(event("ç", "KeyC", { altKey: true, shiftKey: true })).includes("accel,alt,shift|C"), "⌥⇧⌘C");
  ok(
    eventSignatures({ key: "ArrowRight", code: "ArrowRight", keyCode: 39, ctrlKey: true, altKey: true }).some(s => s.endsWith("|VK_RIGHT")),
    "Arrow keys by keycode"
  );
  const key = document.createXULElement("key");
  key.setAttribute("modifiers", "accel,shift");
  key.setAttribute("key", "c");
  is(bindingOf(key), "accel,shift|C", "bindingOf sorts and upper-cases");
});

add_task(async function test_page_gets_first_press_browser_the_second() {
  await TestUtils.waitForCondition(() => gBrowserInit.delayedStartupFinished, "Delayed startup");
  const id = "zen-compact-mode-toggle";
  const key = document.getElementById(id);
  ok(key, "Hide Sidebar has a key");
  if (bindingOf(key) != "accel|S") {
    todo(false, `Hide Sidebar is on ${bindingOf(key)}, not ⌘S`);
    return;
  }
  const watcher = watchKey(id);
  const tab = await openPage();
  const browser = tab.linkedBrowser;

  press(id);
  await TestUtils.waitForCondition(async () => (await took(browser)).length == 1, "The page got the first ⌘S");
  await TestUtils.waitForCondition(hint, "A toast says to press it again");
  is(watcher.runs, 0, "The first press didn't hide the sidebar");
  Assert.deepEqual(WhimsyShortcuts.pendingPressAgain(window), { keyId: id, signature: "accel|S" }, "Waiting for the second press");
  const args = document.l10n.getAttributes(hint().element.querySelector("label")).args;
  ok(args.shortcut.includes("S"), `The hint names the key (${args.shortcut})`);
  ok(args.action && !args.action.endsWith("…"), `and the command (${args.action})`);

  press(id);
  await TestUtils.waitForCondition(() => watcher.runs == 1, "The second ⌘S hides the sidebar");
  is((await took(browser)).length, 1, "The page didn't see the second press");
  ok(!WhimsyShortcuts.pendingPressAgain(window), "Nothing waiting any more");
  await TestUtils.waitForCondition(() => !hint(), "The hint went");

  // The next ⌘S starts over: the page's again.
  press(id);
  await TestUtils.waitForCondition(async () => (await took(browser)).length == 2, "The page gets the next first press");
  is(watcher.runs, 1, "and the browser waits again");

  // Another key in between: start over.
  EventUtils.synthesizeKey("x", {});
  ok(!WhimsyShortcuts.pendingPressAgain(window), "Another key cancels the second press");
  press(id);
  await TestUtils.waitForCondition(async () => (await took(browser)).length == 3, "So the page gets this one");
  is(watcher.runs, 1, "and the browser didn't act");

  // Switching tabs in between: start over too.
  const other = await BrowserTestUtils.openNewForegroundTab(gBrowser, "about:blank");
  await BrowserTestUtils.switchTab(gBrowser, tab);
  browser.focus();
  ok(!WhimsyShortcuts.pendingPressAgain(window), "The tab switch started over");
  ok(!hint(), "and the hint went");
  press(id);
  await TestUtils.waitForCondition(async () => (await took(browser)).length == 4, "After a tab switch the page gets the press");
  is(watcher.runs, 1, "and the browser didn't act");
  BrowserTestUtils.removeTab(other);

  watcher.stop();
  BrowserTestUtils.removeTab(tab);
});

add_task(async function test_pin_tab_second_press() {
  const id = "zen-toggle-pin-tab";
  const key = document.getElementById(id);
  if (!key || bindingOf(key) != "accel|D") {
    todo(false, "Pin Tab isn't on ⌘D");
    return;
  }
  const tab = await openPage();
  press(id);
  await TestUtils.waitForCondition(async () => (await took(tab.linkedBrowser)).includes("KeyD"), "The page got ⌘D");
  await TestUtils.waitForCondition(hint, "Press again hint");
  ok(!tab.pinned, "Not pinned on the first press");
  press(id);
  await TestUtils.waitForCondition(() => tab.pinned, "The second ⌘D pins the tab");
  gBrowser.unpinTab(tab);
  BrowserTestUtils.removeTab(tab);
});

add_task(async function test_page_that_doesnt_use_the_key() {
  // The browser acts on the first press, as before.
  const id = "zen-compact-mode-toggle";
  if (bindingOf(document.getElementById(id)) != "accel|S") {
    return;
  }
  const watcher = watchKey(id);
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.com/");
  tab.linkedBrowser.focus();
  press(id);
  await TestUtils.waitForCondition(() => watcher.runs == 1, "The first ⌘S hides the sidebar");
  ok(!hint(), "No hint");
  ok(!WhimsyShortcuts.pendingPressAgain(window), "Nothing waiting");
  watcher.stop();
  BrowserTestUtils.removeTab(tab);
});

add_task(async function test_switch_off() {
  await SpecialPowers.pushPrefEnv({ set: [["whimsy.feature.press-again", false]] });
  const id = "zen-compact-mode-toggle";
  if (bindingOf(document.getElementById(id)) != "accel|S") {
    await SpecialPowers.popPrefEnv();
    return;
  }
  const watcher = watchKey(id);
  const tab = await openPage();
  press(id);
  press(id);
  await TestUtils.waitForCondition(async () => (await took(tab.linkedBrowser)).length == 2, "The page gets both presses");
  is(watcher.runs, 0, "Switched off: the page keeps the key");
  ok(!hint(), "and no hint");
  watcher.stop();
  BrowserTestUtils.removeTab(tab);
  await SpecialPowers.popPrefEnv();
});
