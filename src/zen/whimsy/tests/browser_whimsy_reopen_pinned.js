/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// B1: ⌘⇧T reopens the most recently closed tab of any kind: a normal tab,
// a pinned tab and an Essential, closed the ways a person closes them.

const { SessionStore } = ChromeUtils.importESModule("moz-src:///browser/components/sessionstore/SessionStore.sys.mjs");

function uniqueURL(tag) {
  return `https://example.com/?${tag}=${Date.now()}${Math.random().toString(36).slice(2)}`;
}

async function reopenWithKey() {
  await SimpleTest.promiseFocus(window);
  EventUtils.synthesizeKey("t", { accelKey: true, shiftKey: true });
}

const found = url => gBrowser.tabs.find(t => !t.closing && t.linkedBrowser.currentURI?.spec == url);

// ⌘W on a pinned tab or Essential, as Zen does it: reset, unload and move
// off it (it stays in the sidebar). ⌘⇧T brings it back to the front, unless
// a tab closed after it (then that one comes back, as before).
for (const kind of ["pinned", "essential"]) {
  add_task(async function command_w_then_command_shift_t() {
    const url = uniqueURL(`cmdw-${kind}`);
    const normal = await BrowserTestUtils.openNewForegroundTab(gBrowser, uniqueURL("cmdw-normal"));
    const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, url);
    if (kind == "pinned") {
      gBrowser.pinTab(tab);
    } else {
      gZenPinnedTabManager.addToEssentials(tab);
    }
    await TestUtils.waitForCondition(() => tab.pinned, "Set up");
    gBrowser.selectedTab = tab;
    await SimpleTest.promiseFocus(window);
    EventUtils.synthesizeKey("w", { accelKey: true });
    await TestUtils.waitForCondition(() => !tab.selected, `⌘W moved off the ${kind} tab`);
    ok(tab.isConnected, "...which stays in the sidebar");
    await reopenWithKey();
    await TestUtils.waitForCondition(() => gBrowser.selectedTab == tab, `⌘⇧T brings the ${kind} tab back`);

    // A normal tab closed after it: ⌘⇧T reopens that one instead.
    EventUtils.synthesizeKey("w", { accelKey: true });
    await TestUtils.waitForCondition(() => !tab.selected, "⌘W again");
    const normalURL = normal.linkedBrowser.currentURI.spec;
    gBrowser.selectedTab = normal;
    const closed = BrowserTestUtils.waitForSessionStoreUpdate(normal);
    gBrowser.removeTab(normal);
    await closed;
    await reopenWithKey();
    const back = await TestUtils.waitForCondition(() => found(normalURL), "The later close comes back first");
    if (kind == "essential") {
      gZenPinnedTabManager.removeEssentials(tab);
    }
    if (tab.pinned) {
      gBrowser.unpinTab(tab);
    }
    BrowserTestUtils.removeTab(tab);
    BrowserTestUtils.removeTab(back);
  });
}

for (const kind of ["normal", "pinned", "essential"]) {
  add_task(async function reopen_closed_tab() {
    const url = uniqueURL(`reopen-${kind}`);
    const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, url);
    if (kind == "pinned") {
      gBrowser.pinTab(tab);
    } else if (kind == "essential") {
      gZenPinnedTabManager.addToEssentials(tab);
    }
    await TestUtils.waitForCondition(() => kind == "normal" || tab.pinned, "Set up");
    const saved = BrowserTestUtils.waitForSessionStoreUpdate(tab);
    gBrowser.removeTab(tab);
    await saved;
    await TestUtils.waitForCondition(() => !tab.isConnected, `The ${kind} tab closed`);
    info(`closed list: ${SessionStore.getClosedTabCountForWindow(window)}`);
    await reopenWithKey();
    const back = await TestUtils.waitForCondition(() => found(url), `⌘⇧T reopens the ${kind} tab`);
    if (kind == "pinned") {
      ok(back.pinned, "...pinned again");
    } else if (kind == "essential") {
      ok(back.hasAttribute("zen-essential"), "...as an Essential again");
      gZenPinnedTabManager.removeEssentials(back);
    }
    if (back.pinned) {
      gBrowser.unpinTab(back);
    }
    BrowserTestUtils.removeTab(back);
  });
}

// R1 v2: with saving off, ⌘W on a pinned tab with unsaved typing warns
// first and resets nothing; a second ⌘W would reset it, but the first
// alone must not count as a close, so ⌘⇧T later must not jump back to
// that tab: it reopens the tab that really closed last.
add_task(async function cancelled_pinned_close_is_not_a_close() {
  await SpecialPowers.pushPrefEnv({
    set: [
      ["whimsy.feature.form-protection", true],
      ["whimsy.forms.saveDrafts", false],
      ["zen.pinned-tab-manager.close-shortcut-behavior", "reset-unload-switch"],
    ],
  });
  const root = getRootDirectory(gTestPath).replace("chrome://mochitests/content", "https://example.com");
  const formTab = await BrowserTestUtils.openNewForegroundTab(gBrowser, root + "whimsy_email_form.html");
  gBrowser.pinTab(formTab);
  const closedURL = uniqueURL("really-closed");
  const closing = await BrowserTestUtils.openNewForegroundTab(gBrowser, closedURL);
  const saved = BrowserTestUtils.waitForSessionStoreUpdate(closing);
  gBrowser.removeTab(closing);
  await saved;
  const other = await BrowserTestUtils.openNewForegroundTab(gBrowser, uniqueURL("other"));
  gBrowser.selectedTab = formTab;
  const browser = formTab.linkedBrowser;
  await SpecialPowers.spawn(browser, [], () => content.document.getElementById("name").focus());
  for (const key of "Ada") {
    await BrowserTestUtils.synthesizeKey(key, {}, browser);
  }
  await TestUtils.waitForCondition(() => formTab.hasAttribute("whimsy-form-typed"), "Typed");

  await SimpleTest.promiseFocus(window);
  EventUtils.synthesizeKey("w", { accelKey: true });
  await TestUtils.waitForCondition(() => toastFor("whimsy-form-close-warning"), "The close warning shows");
  await new Promise(resolve => setTimeout(resolve, 200)); // eslint-disable-line mozilla/no-arbitrary-setTimeout
  is(gBrowser.selectedTab, formTab, "A single ⌘W: the pinned tab stays, not reset");

  gBrowser.selectedTab = other;
  await reopenWithKey();
  const back = await TestUtils.waitForCondition(() => found(closedURL), "⌘⇧T reopens the tab that really closed");
  isnot(gBrowser.selectedTab, formTab, "not the pinned tab whose close was cancelled");

  gBrowser.unpinTab(formTab);
  for (const tab of [formTab, other, back]) {
    BrowserTestUtils.removeTab(tab);
  }
  await SpecialPowers.popPrefEnv();
});
