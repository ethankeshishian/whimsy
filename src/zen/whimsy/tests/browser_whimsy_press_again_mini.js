/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// B16: Arc's "press again" (W10-61) for every Whimsy key, in every kind of
// window. In Mini Whimsy a page that uses ⌘O (Google Sheets opens its own
// file picker) took the first press, and the second press moved the page,
// but no hint ever said so: only the fixed list of Arc's browser keys took
// part, and Mini's ⌘O / ⇧⌘O weren't on it. Now every bound Whimsy key a page
// can cancel offers the second press, and the hint shows inside Mini.

const PAGE =
  getRootDirectory(gTestPath).replace("chrome://mochitests/content", "https://example.com") +
  "whimsy_press_again_mini.html";
const { WhimsyShortcuts, PRESS_AGAIN_SHARED_KEY, bindingOf } = ChromeUtils.importESModule(
  "resource:///modules/whimsy/WhimsyShortcuts.sys.mjs"
);
const { WhimsyQuickWindow } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyQuickWindow.sys.mjs");
const HINT = "whimsy-press-again-toast";

const took = browser => SpecialPowers.spawn(browser, [], () => [...content.wrappedJSObject.took]);

add_setup(async function () {
  await SpecialPowers.pushPrefEnv({ set: [["whimsy.quick-window.size", ""]] });
});

registerCleanupFunction(async () => {
  for (const win of WhimsyQuickWindow.windows()) {
    await WhimsyQuickWindow.whenReady(win);
    await BrowserTestUtils.closeWindow(win);
  }
});

async function openMini() {
  const win = WhimsyQuickWindow.open(PAGE, { opener: window });
  await WhimsyQuickWindow.whenReady(win);
  await TestUtils.waitForCondition(
    () => win.document.getElementById("whimsy-quick-window-move-to-space"),
    "Mini chrome is ready"
  );
  await TestUtils.waitForCondition(
    () => win.gBrowser.selectedBrowser.currentURI.spec == PAGE,
    "Mini loaded the page"
  );
  await SpecialPowers.spawn(win.gBrowser.selectedBrowser, [], () =>
    ContentTaskUtils.waitForCondition(() => content.wrappedJSObject.took, "The page's key handler is in")
  );
  await SimpleTest.promiseFocus(win);
  win.gBrowser.selectedBrowser.focus();
  return win;
}

// The hint, if it's showing in `win` and a person can see it there.
function visibleHint(win) {
  const toast = win.gZenUIManager?.toasts?.getToasts().find(t => t.messageId == HINT);
  if (!toast?.element?.checkVisibility({ visibilityProperty: true, opacityProperty: false })) {
    return null;
  }
  const rect = toast.element.getBoundingClientRect();
  const inside =
    rect.width > 0 &&
    rect.height > 0 &&
    rect.left >= 0 &&
    rect.top >= 0 &&
    rect.right <= win.innerWidth &&
    rect.bottom <= win.innerHeight;
  return inside ? toast : null;
}

function hintArgs(toast) {
  return toast.element.ownerDocument.l10n.getAttributes(toast.element.querySelector("label")).args ?? {};
}

add_task(async function test_every_bound_whimsy_key_takes_part() {
  await TestUtils.waitForCondition(() => gBrowserInit.delayedStartupFinished, "Delayed startup");
  const win = await openMini();
  try {
    await TestUtils.waitForCondition(() => win.gBrowserInit?.delayedStartupFinished, "Mini's delayed startup");
    await new Promise(resolve => win.setTimeout(resolve, 0));
    const published = Services.ppmm.sharedData.get(PRESS_AGAIN_SHARED_KEY) ?? [];
    for (const w of [window, win]) {
      const where = w == win ? "Mini" : "a main window";
      const keys = [...w.document.querySelectorAll("key[whimsy-command-key]")].filter(
        key => key.getAttribute("disabled") != "true" && !bindingOf(key).endsWith("|") && /accel|meta|control|alt/.test(bindingOf(key))
      );
      ok(keys.length > 5, `${where} has bound Whimsy keys (${keys.length})`);
      const missing = keys.filter(key => {
        const found = WhimsyShortcuts.pressAgainKeyFor(w.document, [bindingOf(key)]);
        return !found || bindingOf(found) != bindingOf(key) || !published.includes(bindingOf(key));
      });
      Assert.deepEqual(missing.map(key => `${key.id} ${bindingOf(key)}`), [], `Every bound Whimsy key in ${where} offers the second press`);
    }
    for (const id of ["key_whimsyQuickWindowOpenInSpace", "key_whimsyQuickWindowChooseSpace"]) {
      is(WhimsyShortcuts.pressAgainKeyFor(win.document, [bindingOf(win.document.getElementById(id))])?.id, id, `${id} in Mini`);
      ok(!WhimsyShortcuts.pressAgainKeyFor(document, [bindingOf(document.getElementById(id))]) ||
        WhimsyShortcuts.pressAgainKeyFor(document, [bindingOf(document.getElementById(id))]).id != id,
        `${id}'s disabled stand-in in a main window never does`);
    }
  } finally {
    await BrowserTestUtils.closeWindow(win);
  }
});

add_task(async function test_cmd_o_in_mini_page_first_then_open_in_space() {
  const win = await openMini();
  const browser = win.gBrowser.selectedBrowser;
  const tabCountBefore = gBrowser.tabs.length;

  EventUtils.synthesizeKey("o", { accelKey: true }, win);
  await TestUtils.waitForCondition(async () => (await took(browser)).length == 1, "The page got the first ⌘O");
  await TestUtils.waitForCondition(() => visibleHint(win), "A hint inside Mini says to press it again");
  ok(!win.closed, "The first press didn't move the page");
  is(gBrowser.tabs.length, tabCountBefore, "Nothing landed in the main window yet");
  Assert.deepEqual(
    WhimsyShortcuts.pendingPressAgain(win),
    { keyId: "key_whimsyQuickWindowOpenInSpace", signature: "accel|O" },
    "Waiting for the second ⌘O"
  );
  const args = hintArgs(visibleHint(win));
  ok(args.shortcut?.includes("O") && !args.shortcut.includes("⇧") && !/shift/i.test(args.shortcut),
    `The hint names ⌘O (${args.shortcut})`);
  is(args.action, "Open in Current Space", "and Mini's command");
  ok(!toastFor(HINT), "The main window shows no hint");

  EventUtils.synthesizeKey("o", { accelKey: true }, win);
  await TestUtils.waitForCondition(() => win.closed, "The second ⌘O moves the page into the space");
  is(gBrowser.tabs.length, tabCountBefore + 1, "The page landed in the main window");
  const adopted = gBrowser.tabs[gBrowser.tabs.length - 1];
  is(adopted.linkedBrowser.currentURI.spec, PAGE, "It's Mini's page");
  is((await took(adopted.linkedBrowser)).length, 1, "The page never saw the second press");
  BrowserTestUtils.removeTab(adopted);
});

add_task(async function test_cmd_shift_o_in_mini_page_first_then_space_picker() {
  const win = await openMini();
  try {
    const browser = win.gBrowser.selectedBrowser;
    const picker = () => win.document.getElementById("whimsy-quick-window-space-picker");

    EventUtils.synthesizeKey("o", { accelKey: true, shiftKey: true }, win);
    await TestUtils.waitForCondition(async () => (await took(browser)).length == 1, "The page got the first ⇧⌘O");
    await TestUtils.waitForCondition(() => visibleHint(win), "A hint inside Mini says to press it again");
    ok(picker()?.state != "open", "The first press didn't open the space list");
    Assert.deepEqual(
      WhimsyShortcuts.pendingPressAgain(win),
      { keyId: "key_whimsyQuickWindowChooseSpace", signature: "accel,shift|O" },
      "Waiting for the second ⇧⌘O"
    );
    const args = hintArgs(visibleHint(win));
    ok(args.shortcut?.includes("O") && (args.shortcut.includes("⇧") || /shift/i.test(args.shortcut)),
      `The hint names ⇧⌘O (${args.shortcut})`);
    is(args.action, "Open in Another Space", "and Mini's command, without its ellipsis");

    EventUtils.synthesizeKey("o", { accelKey: true, shiftKey: true }, win);
    await TestUtils.waitForCondition(() => picker()?.state == "open", "The second ⇧⌘O opens the space list");
    is((await took(browser)).length, 1, "The page never saw the second press");
    await TestUtils.waitForCondition(() => !visibleHint(win), "The hint went");
    const hidden = BrowserTestUtils.waitForEvent(picker(), "popuphidden");
    picker().hidePopup();
    await hidden;
  } finally {
    await BrowserTestUtils.closeWindow(win);
  }
});

add_task(async function test_mini_page_that_doesnt_use_the_key() {
  // A page that leaves ⌘O alone: Mini acts on the first press, no hint.
  const win = WhimsyQuickWindow.open("https://example.com/", { opener: window });
  await WhimsyQuickWindow.whenReady(win);
  await TestUtils.waitForCondition(
    () => win.gBrowser.selectedBrowser.currentURI.spec == "https://example.com/",
    "Mini loaded its page"
  );
  await SimpleTest.promiseFocus(win);
  win.gBrowser.selectedBrowser.focus();
  const tabCountBefore = gBrowser.tabs.length;
  EventUtils.synthesizeKey("o", { accelKey: true }, win);
  await TestUtils.waitForCondition(() => win.closed, "The first ⌘O moves the page");
  is(gBrowser.tabs.length, tabCountBefore + 1, "It landed in the main window");
  ok(!toastFor(HINT), "No hint");
  BrowserTestUtils.removeTab(gBrowser.tabs[gBrowser.tabs.length - 1]);
});
