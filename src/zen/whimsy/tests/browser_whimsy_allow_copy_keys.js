/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// W10-41: on a copy-protected page (WP Content Copy Protection, as on
// ratzillacosme.com) the page cancels the right-click, so the page menu's
// Allow Copy and Paste row never shows: a toast offers it instead. With it
// on, Cmd+C copies even though the page cancels Cmd/Ctrl keys. Copy URL
// (Cmd+Shift+C) works there whether or not copying is allowed: the page
// gets the first press and the second one copies (W10-61, Arc's press
// again).

const PAGE =
  getRootDirectory(gTestPath).replace("chrome://mochitests/content", "https://example.com") + "whimsy_no_copy_keys.html";
const { WhimsyPage } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyPage.sys.mjs");
const { RESERVED_KEYS } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyShortcuts.sys.mjs");
const site = Services.scriptSecurityManager.createContentPrincipal(Services.io.newURI("https://example.com"), {});

registerCleanupFunction(() => Services.perms.removeFromPrincipal(site, "whimsy-allow-copy"));

const clipboardText = () => SpecialPowers.getClipboardData("text/plain");
const blockedKeys = browser => SpecialPowers.spawn(browser, [], () => content.wrappedJSObject.blockedKeys);

async function selectWords(browser) {
  await SpecialPowers.spawn(browser, [], () => {
    const p = content.document.getElementById("p");
    const range = content.document.createRange();
    range.selectNodeContents(p);
    const selection = content.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  });
  browser.focus();
}

add_task(async function test_copy_url_keys_press_again() {
  for (const id of ["zen-copy-url", "zen-copy-url-markdown"]) {
    ok(RESERVED_KEYS.includes(id), `${id} is one of the browser's keys (press again)`);
    isnot(document.getElementById(id)?.getAttribute("reserved"), "true", `${id} isn't reserved: the page gets the first press`);
  }
});

add_task(async function test_blocked_menu_offers_allow_copy() {
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE);
  const browser = tab.linkedBrowser;
  ok(!WhimsyPage.copyAllowed(browser), "Not allowed yet");

  // Copy URL works although the page cancels every Cmd key: the page gets
  // the first press, the second copies (W10-61).
  SpecialPowers.clipboardCopyString("");
  browser.focus();
  const firstBlocked = await blockedKeys(browser);
  EventUtils.synthesizeKey("C", { accelKey: true, shiftKey: true });
  await TestUtils.waitForCondition(async () => (await blockedKeys(browser)) > firstBlocked, "The page cancelled the first Cmd+Shift+C");
  await TestUtils.waitForCondition(
    () => currentToast()?.messageId == "whimsy-press-again-toast",
    "A toast says to press it again"
  );
  ok(!clipboardText().includes("whimsy_no_copy_keys.html"), "The first press didn't copy");
  EventUtils.synthesizeKey("C", { accelKey: true, shiftKey: true });
  await TestUtils.waitForCondition(() => clipboardText().includes("whimsy_no_copy_keys.html"), "The second Cmd+Shift+C copies the URL");
  ok(clipboardText().includes("whimsy_no_copy_keys.html"), "Copy URL wasn't swallowed by the page");

  // The page cancels Cmd+C.
  await selectWords(browser);
  const before = await blockedKeys(browser);
  EventUtils.synthesizeKey("c", { accelKey: true });
  await TestUtils.waitForCondition(async () => (await blockedKeys(browser)) > before, "The page saw and cancelled Cmd+C");

  // The page cancels the right-click: no menu, a toast offers Allow instead.
  const menu = document.getElementById("contentAreaContextMenu");
  let menuShown = false;
  const onShown = () => (menuShown = true);
  menu.addEventListener("popupshown", onShown);
  await BrowserTestUtils.synthesizeMouseAtCenter("#p", { type: "contextmenu", button: 2 }, browser);
  await TestUtils.waitForCondition(
    () => currentToast()?.messageId == "whimsy-allow-copy-offer-toast",
    "A toast offers Allow Copy and Paste"
  );
  menu.removeEventListener("popupshown", onShown);
  ok(!menuShown, "The page really did cancel its right-click menu");
  const action = document.getElementById("whimsy-allow-copy-offer-action");
  ok(action, "with an Allow Copy and Paste button");

  // Only once per page.
  currentToast()?.close({ instant: true });
  await BrowserTestUtils.synthesizeMouseAtCenter("#p", { type: "contextmenu", button: 2 }, browser);
  await new Promise(r => setTimeout(r, 300));
  isnot(currentToast()?.messageId, "whimsy-allow-copy-offer-toast", "Not offered twice on one page");

  // Reload, offer again, take it.
  BrowserTestUtils.reloadTab(tab);
  await BrowserTestUtils.browserLoaded(browser);
  await BrowserTestUtils.synthesizeMouseAtCenter("#p", { type: "contextmenu", button: 2 }, browser);
  await TestUtils.waitForCondition(() => document.getElementById("whimsy-allow-copy-offer-action"), "Offered again after a reload");
  // Measured once it has arrived (it springs in from scale 0): clicking
  // mid-animation lands on a zero-size node.
  await currentToast().shown;
  document.getElementById("whimsy-allow-copy-offer-action").click();
  await TestUtils.waitForCondition(() => WhimsyPage.copyAllowed(browser), "The button allows copy and paste on the site");

  // Now Cmd+C copies: the page never sees the key.
  await TestUtils.waitForCondition(
    () => SpecialPowers.spawn(browser, [], () => content.getComputedStyle(content.document.body).userSelect == "text"),
    "Allowed in the page"
  );
  await selectWords(browser);
  const seen = await blockedKeys(browser);
  await SimpleTest.promiseClipboardChange("Protected words to copy", () => EventUtils.synthesizeKey("c", { accelKey: true }));
  is(await blockedKeys(browser), seen, "The page's key blocker didn't run");

  // Other keys still reach the page (only the copy keys are kept from it).
  EventUtils.synthesizeKey("k", { accelKey: true });
  await TestUtils.waitForCondition(async () => (await blockedKeys(browser)) > seen, "Cmd+K still reaches the page");

  // Allowed: right-clicking no longer offers it, and the menu opens.
  const shown = BrowserTestUtils.waitForEvent(menu, "popupshown");
  await BrowserTestUtils.synthesizeMouseAtCenter("#p", { type: "contextmenu", button: 2 }, browser);
  await shown;
  ok(true, "The page can't cancel the right-click menu any more");
  const hidden = BrowserTestUtils.waitForEvent(menu, "popuphidden");
  menu.hidePopup();
  await hidden;
  isnot(currentToast()?.messageId, "whimsy-allow-copy-offer-toast", "No offer once allowed");

  WhimsyPage.toggleAllowCopy(window, browser);
  BrowserTestUtils.removeTab(tab);
});

add_task(async function test_offer_follows_the_switch() {
  await SpecialPowers.pushPrefEnv({ set: [["whimsy.feature.allow-copy", false]] });
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE);
  ok(!WhimsyPage.offerAllowCopy(window, tab.linkedBrowser), "No offer with the switch off");
  BrowserTestUtils.removeTab(tab);
  await SpecialPowers.popPrefEnv();
});
