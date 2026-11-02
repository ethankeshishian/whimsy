/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// W11-14: lock private browsing (private tabs, the Private Space, private
// windows; one switch each). The OS prompt is a stand-in that answers yes
// or no (WhimsyAuth._reauthenticator).

const { WhimsyPrivateLock } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyPrivateLock.sys.mjs");
const { WhimsyPrivate } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyPrivate.sys.mjs");
const { WhimsyAuth } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyAuth.sys.mjs");

let answer = false;
const asked = [];

add_setup(async function () {
  WhimsyAuth._reauthenticator = {
    async asyncReauthenticateUser(prompt, caption, parentWindow) {
      asked.push({ prompt, parentWindow });
      return [answer, false];
    },
  };
  const startTabs = new Set(gBrowser.tabs);
  registerCleanupFunction(async () => {
    WhimsyAuth._reauthenticator = null;
    WhimsyPrivateLock.unlockAll();
    for (const tab of gBrowser.tabs.filter(t => !startTabs.has(t))) {
      if (tab.isConnected && !tab.closing) {
        BrowserTestUtils.removeTab(tab, { animate: false });
      }
    }
    for (const kind of WhimsyPrivateLock.KINDS) {
      Services.prefs.clearUserPref(`whimsy.privateLock.${kind}`);
    }
    Services.prefs.clearUserPref("whimsy.privateLock.afterSeconds");
  });
});

function uniqueURL(tag) {
  return `https://example.com/?${tag}=${Date.now()}${Math.random().toString(36).slice(2)}`;
}

async function openPrivateTab(tag) {
  const url = uniqueURL(tag);
  const tab = WhimsyPrivate.openPrivateTab(window, { url });
  await TestUtils.waitForCondition(() => tab.linkedBrowser.currentURI?.spec == url && !tab.hasAttribute("busy"),
    "The private page loaded");
  return tab;
}

function askPanel() {
  const panel = document.getElementById(WhimsyPrivateLock.ASK_ID);
  return panel?.state == "open" ? panel : null;
}

add_task(async function test_first_run_question() {
  await SpecialPowers.pushPrefEnv({ clear: [["whimsy.privateLock.askDismissals.tabs"]] });
  is(WhimsyPrivateLock.choice("tabs"), -1, "Not chosen to start with");
  const first = await openPrivateTab("ask1");
  const panel = await TestUtils.waitForCondition(askPanel, "Asked the first time a private tab opens");
  is(panel.dataset.kind, "tabs", "...about private tabs");
  ok(!panel.querySelector("[default='true']"), "Neither answer is the default");
  ok(!panel.querySelector("button")?.matches(":focus"), "...and no answer has focus");
  let hidden = BrowserTestUtils.waitForEvent(panel, "popuphidden");
  EventUtils.synthesizeKey("KEY_Escape", {}, window);
  await hidden;
  is(WhimsyPrivateLock.choice("tabs"), -1, "Esc saves nothing");
  is(Services.prefs.getIntPref("whimsy.privateLock.askDismissals.tabs", 0), 1, "...and counts a dismissal");

  // Asked again next time; a second Esc stops the asking.
  gBrowser.selectedTab = gBrowser.tabs[0];
  gBrowser.selectedTab = first;
  const again = await TestUtils.waitForCondition(askPanel, "Asked again");
  hidden = BrowserTestUtils.waitForEvent(again, "popuphidden");
  EventUtils.synthesizeKey("KEY_Escape", {}, window);
  await hidden;
  gBrowser.selectedTab = gBrowser.tabs[0];
  gBrowser.selectedTab = first;
  await new Promise(resolve => setTimeout(resolve, 300));
  ok(!askPanel(), "Not asked after two dismissals");
  is(WhimsyPrivateLock.isOn("tabs"), false, "Not chosen acts as off");

  // Answering Lock turns it on.
  Services.prefs.clearUserPref("whimsy.privateLock.askDismissals.tabs");
  WhimsyPrivateLock._asked?.clear();
  gBrowser.selectedTab = gBrowser.tabs[0];
  gBrowser.selectedTab = first;
  const third = await TestUtils.waitForCondition(askPanel, "Asked once more after a reset");
  hidden = BrowserTestUtils.waitForEvent(third, "popuphidden");
  third.querySelector("#whimsy-private-lock-yes").doCommand();
  await hidden;
  is(WhimsyPrivateLock.choice("tabs"), 1, "Lock turns it on");
  BrowserTestUtils.removeTab(first, { animate: false });
  await SpecialPowers.popPrefEnv();
});

add_task(async function test_tab_locks_right_away_and_unlocks() {
  Services.prefs.setIntPref("whimsy.privateLock.tabs", 1);
  Services.prefs.setIntPref("whimsy.privateLock.afterSeconds", 0);
  const normal = gBrowser.tabs[0];
  const priv = await openPrivateTab("lock");
  const title = priv.label;
  ok(!WhimsyPrivateLock.isLocked("tabs"), "Unlocked while in front");

  // Leaving it locks it right away.
  gBrowser.selectedTab = normal;
  await TestUtils.waitForCondition(() => WhimsyPrivateLock.isLocked("tabs"), "Leaving the private tab locks it");
  ok(priv.hasAttribute(WhimsyPrivateLock.LOCKED_ATTR), "The tab row is masked");
  is(priv.label, "Private tab", "...and reads Private tab");
  ok(!document.querySelector(".whimsy-lock-cover"), "No cover over a normal tab");

  // Landing on it covers the page and asks at once; a cancel keeps it.
  answer = false;
  asked.length = 0;
  gBrowser.selectedTab = priv;
  const cover = await TestUtils.waitForCondition(() => document.querySelector(".whimsy-lock-cover"), "The cover shows");
  is(cover.dataset.kind, "tabs", "The private tab's cover");
  await TestUtils.waitForCondition(() => asked.length == 1, "Touch ID is asked for on landing");
  is(asked[0].prompt, "show your private tabs", "...saying why");
  await TestUtils.waitForCondition(() => cover.hasAttribute("failed"), "A cancel shows Didn't unlock");
  ok(document.documentElement.hasAttribute("whimsy-private-selected-locked"), "The address bar reads Locked");
  ok(gURLBar.readOnly, "...and can't be edited");
  ok(!document.title.includes("example.com") && !document.title.includes(title), "The window title names nothing");

  // Not asked again until you leave and come back; the button asks.
  await new Promise(resolve => setTimeout(resolve, 200));
  is(asked.length, 1, "No second automatic prompt");
  answer = true;
  cover.querySelector(".whimsy-lock-cover-button").doCommand();
  await TestUtils.waitForCondition(() => !document.querySelector(".whimsy-lock-cover"), "Unlock removes the cover");
  ok(!WhimsyPrivateLock.isLocked("tabs"), "Unlocked");
  ok(!priv.hasAttribute(WhimsyPrivateLock.LOCKED_ATTR), "The row is back");
  await TestUtils.waitForCondition(() => priv.label != "Private tab", "...with its title");
  ok(!gURLBar.readOnly, "The address bar is editable again");
  BrowserTestUtils.removeTab(priv, { animate: false });
});

add_task(async function test_lock_after_waits() {
  Services.prefs.setIntPref("whimsy.privateLock.tabs", 1);
  Services.prefs.setIntPref("whimsy.privateLock.afterSeconds", 60);
  const priv = await openPrivateTab("after");
  gBrowser.selectedTab = gBrowser.tabs[0];
  await new Promise(resolve => setTimeout(resolve, 200));
  ok(!WhimsyPrivateLock.isLocked("tabs"), "With Lock after 1 minute, leaving doesn't lock yet");
  // Mac sleep always locks.
  Services.obs.notifyObservers(null, "sleep_notification");
  ok(WhimsyPrivateLock.isLocked("tabs"), "Sleep locks at once");
  WhimsyPrivateLock.unlockAll();
  Services.prefs.setIntPref("whimsy.privateLock.afterSeconds", 0);
  BrowserTestUtils.removeTab(priv, { animate: false });
});

add_task(async function test_commands_and_turning_off() {
  Services.prefs.setIntPref("whimsy.privateLock.tabs", 1);
  const priv = await openPrivateTab("cmd");
  const { globalActions } = ChromeUtils.importESModule("resource:///modules/ZenUBGlobalActions.sys.mjs");
  const action = id => globalActions.find(a => a.l10nId == id);
  ok(action("whimsy-action-lock-private-now")?.isAvailable(window), "Lock Private Browsing Now is offered");
  ok(!action("whimsy-action-unlock-private")?.isAvailable(window), "Unlock isn't, while unlocked");
  document.getElementById("cmd_whimsyLockPrivateNow").doCommand();
  ok(WhimsyPrivateLock.isLocked("tabs"), "Lock Now locks");
  ok(action("whimsy-action-unlock-private")?.isAvailable(window), "Unlock is offered while locked");

  // Turning the switch off while locked asks first (d8).
  answer = false;
  ok(!(await WhimsyPrivateLock.setChoice(window, "tabs", false)), "A cancel keeps it on");
  is(WhimsyPrivateLock.choice("tabs"), 1, "...still on");
  answer = true;
  ok(await WhimsyPrivateLock.setChoice(window, "tabs", false), "Authenticated, it turns off");
  is(WhimsyPrivateLock.choice("tabs"), 0, "Off");
  ok(!WhimsyPrivateLock.isLocked("tabs"), "...and unlocked");
  asked.length = 0;
  ok(await WhimsyPrivateLock.setChoice(window, "tabs", true), "Turning it on needs no unlock");
  is(asked.length, 0, "...no prompt");

  // Closing a locked tab needs no unlock (d10).
  WhimsyPrivateLock.lockNow();
  BrowserTestUtils.removeTab(priv, { animate: false });
  await TestUtils.waitForCondition(() => !priv.isConnected, "A locked tab closes without unlocking");
  // Its private data is gone with it: the next private tab starts unlocked.
  await TestUtils.waitForCondition(() => !WhimsyPrivateLock.isLocked("tabs"), "Nothing left to lock: unlocked");
});

add_task(async function test_private_window_cover() {
  Services.prefs.setIntPref("whimsy.privateLock.windows", 1);
  const win = await BrowserTestUtils.openNewBrowserWindow({ private: true });
  const url = uniqueURL("win");
  BrowserTestUtils.startLoadingURIString(win.gBrowser.selectedBrowser, url);
  await BrowserTestUtils.browserLoaded(win.gBrowser.selectedBrowser, false, url);
  ok(WhimsyPrivateLock.lockNow(), "Lock Now locks the private window");
  const cover = await TestUtils.waitForCondition(() => win.document.querySelector(".whimsy-lock-cover[whole]"),
    "The whole window is covered");
  is(cover.dataset.kind, "windows", "The window's cover");
  await TestUtils.waitForCondition(() => win.document.title.startsWith("Private Window"), "Its title is generic");
  answer = true;
  cover.querySelector(".whimsy-lock-cover-button").doCommand();
  await TestUtils.waitForCondition(() => !win.document.querySelector(".whimsy-lock-cover"), "Unlocked");
  WhimsyPrivateLock.lockNow();
  await BrowserTestUtils.closeWindow(win);
  ok(true, "A locked private window closes without unlocking");
  WhimsyPrivateLock.unlockAll();
  Services.prefs.clearUserPref("whimsy.privateLock.windows");
});

add_task(async function test_settings_card() {
  await BrowserTestUtils.withNewTab("about:preferences#privacy", async browser => {
    const doc = browser.contentDocument;
    const tabs = await TestUtils.waitForCondition(() => doc.getElementById("whimsyPrivateLockTabs"), "The card is in Privacy");
    ok(doc.getElementById("whimsyPrivateLockSpace") && doc.getElementById("whimsyPrivateLockWindows"),
      "One switch each for tabs, the Private Space and windows");
    is(tabs.checked, WhimsyPrivateLock.choice("tabs") == 1, "The tabs switch shows the choice");
    ok(doc.getElementById("whimsyPrivateLockAfter"), "Lock after");
    ok(doc.getElementById("whimsyPrivateLockSharing"), "Stay unlocked while sharing");
  });
});
