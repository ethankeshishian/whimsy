/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// B1: ⌘⇧T reopens the most recently closed tab of any kind: a normal tab,
// a pinned tab and an Essential, closed the ways a person closes them.

const { SessionStore } = ChromeUtils.importESModule("moz-src:///browser/components/sessionstore/SessionStore.sys.mjs");
const { TabStateFlusher } = ChromeUtils.importESModule("moz-src:///browser/components/sessionstore/TabStateFlusher.sys.mjs");

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
    // Firefox's ⌘⇧T replaces a lone blank tab with the one it reopens (bug
    // 343895), which would take the window's starting tab with it and leave
    // the files after this one with no tab but Zen's empty one. Keep a
    // second tab up so only the closed tab's return is under test.
    const keep = await BrowserTestUtils.openNewForegroundTab(gBrowser, uniqueURL("keep"));
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
    BrowserTestUtils.removeTab(keep);
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

// W14-5: a pinned tab or Essential that navigated away from its pinned page
// comes back where it was (with its back history), by ⌘⇧T and by the tab
// context menu's Reopen Closed Tab; ⌘W after that still resets it home, and
// a tab picked by hand after ⌘W stays at home.
async function setUpNavigated(kind) {
  const keep = await BrowserTestUtils.openNewForegroundTab(gBrowser, uniqueURL("keep"));
  const home = uniqueURL(`home-${kind}`);
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, home);
  if (kind == "pinned") {
    gBrowser.pinTab(tab);
  } else {
    gZenPinnedTabManager.addToEssentials(tab);
  }
  await TestUtils.waitForCondition(() => tab.pinned, "Set up");
  gBrowser.selectedTab = tab;
  const away = uniqueURL(`away-${kind}`);
  const loaded = BrowserTestUtils.browserLoaded(tab.linkedBrowser, false, away);
  await SpecialPowers.spawn(tab.linkedBrowser, [away], url => {
    content.location.href = url;
  });
  await loaded;
  await TestUtils.waitForCondition(() => tab.linkedBrowser.canGoBack, "The page has back history");
  await TabStateFlusher.flush(tab.linkedBrowser);
  return { keep, home, tab, away };
}

async function closeWithKey(tab) {
  await SimpleTest.promiseFocus(window);
  EventUtils.synthesizeKey("w", { accelKey: true });
  await TestUtils.waitForCondition(() => !tab.selected, "⌘W moved off the tab");
}

async function closeAndWaitForReset(tab) {
  await closeWithKey(tab);
  await TestUtils.waitForCondition(() => JSON.parse(SessionStore.getTabState(tab)).entries.length == 1, "...and reset it to its pinned page");
}

async function cleanUp(kind, tab, keep) {
  if (kind == "essential") {
    gZenPinnedTabManager.removeEssentials(tab);
  }
  if (tab.pinned) {
    gBrowser.unpinTab(tab);
  }
  BrowserTestUtils.removeTab(tab);
  BrowserTestUtils.removeTab(keep);
}

async function reopenFromTabMenu(onTab) {
  const menu = document.getElementById("tabContextMenu");
  const shown = BrowserTestUtils.waitForPopupEvent(menu, "shown");
  EventUtils.synthesizeMouseAtCenter(onTab, { type: "contextmenu", button: 2 });
  await shown;
  const item = document.getElementById("context_undoCloseTab");
  ok(!item.disabled && !item.hidden, "Reopen Closed Tab is offered");
  const hidden = BrowserTestUtils.waitForPopupEvent(menu, "hidden");
  menu.activateItem(item);
  await hidden;
}

for (const kind of ["pinned", "essential"]) {
  for (const how of ["key", "menu"]) {
    add_task(async function navigated_pinned_reopens_where_it_was() {
      const { keep, home, tab, away } = await setUpNavigated(kind);
      await closeWithKey(tab);
      if (how == "key") {
        await reopenWithKey();
      } else {
        await reopenFromTabMenu(keep);
      }
      await TestUtils.waitForCondition(() => gBrowser.selectedTab == tab, `${how} brings the ${kind} tab back`);
      await TestUtils.waitForCondition(() => tab.linkedBrowser.currentURI.spec == away, `...at the page it navigated to (${away})`);
      await TestUtils.waitForCondition(() => tab.linkedBrowser.canGoBack, "...with its back history");

      await closeAndWaitForReset(tab);
      EventUtils.synthesizeMouseAtCenter(tab, {});
      await TestUtils.waitForCondition(() => gBrowser.selectedTab == tab, "Picked by hand");
      await TestUtils.waitForCondition(() => tab.linkedBrowser.currentURI.spec == home, "A second ⌘W reset it home");
      ok(!tab.linkedBrowser.canGoBack, "...with no back history");
      await cleanUp(kind, tab, keep);
    });
  }
}

add_task(async function picked_by_hand_after_reset_stays_home() {
  const { keep, home, tab } = await setUpNavigated("pinned");
  await closeAndWaitForReset(tab);
  EventUtils.synthesizeMouseAtCenter(tab, {});
  await TestUtils.waitForCondition(() => gBrowser.selectedTab == tab, "Picked by hand");
  await TestUtils.waitForCondition(() => tab.linkedBrowser.currentURI.spec == home, "It loads its pinned page");
  ok(!tab._whimsyPreResetState, "The saved history is dropped");
  gBrowser.selectedTab = keep;
  const before = new Set(gBrowser.tabs);
  await reopenWithKey();
  await new Promise(resolve => setTimeout(resolve, 300)); // eslint-disable-line mozilla/no-arbitrary-setTimeout
  is(tab.linkedBrowser.currentURI.spec, home, "⌘⇧T later doesn't put the old page back");
  isnot(gBrowser.selectedTab, tab, "...nor jump to the tab picked by hand");
  for (const reopened of gBrowser.tabs.filter(t => !before.has(t))) {
    BrowserTestUtils.removeTab(reopened);
  }
  await cleanUp("pinned", tab, keep);
});
