/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// W11-14: lock private browsing (private tabs, the Private Space, private
// windows; one switch each). The OS prompt is a stand-in that answers yes
// or no (WhimsyAuth._reauthenticator).

const { WhimsyPrivateLock } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyPrivateLock.sys.mjs");
const { WhimsyPrivate } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyPrivate.sys.mjs");
const { WhimsyAuth } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyAuth.sys.mjs");
const { WhimsySurface } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsySurface.sys.mjs");

let answer = false;
const asked = [];

add_setup(async function () {
  // Most tasks check "Lock as Soon as I Leave" (W13-C2, the user's
  // setting); test_leaving_doesnt_lock_by_default checks the default (off).
  await SpecialPowers.pushPrefEnv({ set: [["whimsy.privateLock.onLeave", true]] });
  WhimsyAuth._reauthenticator = {
    async asyncReauthenticateUser(prompt, caption, parentWindow) {
      asked.push({ prompt, parentWindow });
      return [answer, false];
    },
  };
  const startTabs = new Set(gBrowser.tabs);
  // The manifest presets these to 2 so no other file sees the first-run
  // question; put them back to that, not to unset.
  const dismissals = new Map(
    WhimsyPrivateLock.KINDS.map(kind => [kind, Services.prefs.getIntPref(`whimsy.privateLock.askDismissals.${kind}`, 0)])
  );
  registerCleanupFunction(async () => {
    WhimsyAuth._reauthenticator = null;
    WhimsyPrivateLock.unlockAll();
    for (const tab of gBrowser.tabs.filter(t => !startTabs.has(t))) {
      if (tab.isConnected && !tab.closing) {
        BrowserTestUtils.removeTab(tab, { animate: false });
      }
    }
    // Closing the tabs can still count an ask dismissal a moment later, and
    // undoing a pushed pref env can put a counted value back; settle both first.
    await new Promise(resolve => setTimeout(resolve, 250));
    await SpecialPowers.flushPrefEnv();
    // A question still open when the file ends would count a dismissal as it
    // closes; close it first so nothing lands after the prefs are cleared.
    const ask = document.getElementById(WhimsyPrivateLock.ASK_ID);
    if (ask?.state == "open" || ask?.state == "showing") {
      const hidden = BrowserTestUtils.waitForPopupEvent(ask, "hidden");
      ask.hidePopup();
      await hidden;
    }
    for (const kind of WhimsyPrivateLock.KINDS) {
      Services.prefs.clearUserPref(`whimsy.privateLock.${kind}`);
      Services.prefs.setIntPref(`whimsy.privateLock.askDismissals.${kind}`, dismissals.get(kind));
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

// W13-C2 (the user): by default leaving a private tab, inside Whimsy, never
// locks it, whatever "Lock after" says; Lock Now, Mac sleep and Whimsy
// being away for "Lock after" still do.
add_task(async function test_leaving_doesnt_lock_by_default() {
  await SpecialPowers.pushPrefEnv({ set: [["whimsy.privateLock.onLeave", false]] });
  Services.prefs.setIntPref("whimsy.privateLock.tabs", 1);
  const priv = await openPrivateTab("after");
  for (const after of [0, 60]) {
    Services.prefs.setIntPref("whimsy.privateLock.afterSeconds", after);
    gBrowser.selectedTab = gBrowser.tabs[0];
    await new Promise(resolve => setTimeout(resolve, 200));
    ok(!WhimsyPrivateLock.isLocked("tabs"), `Lock after ${after}s: leaving the private tab doesn't lock it`);
    gBrowser.selectedTab = priv;
    ok(!document.querySelector(".whimsy-lock-cover"), "...and coming back shows it");
  }
  gBrowser.selectedTab = gBrowser.tabs[0];
  // Mac sleep always locks.
  Services.obs.notifyObservers(null, "sleep_notification");
  ok(WhimsyPrivateLock.isLocked("tabs"), "Sleep locks at once");
  WhimsyPrivateLock.unlockAll();
  // Turning the setting on locks what you've left.
  Services.prefs.setBoolPref("whimsy.privateLock.onLeave", true);
  await TestUtils.waitForCondition(() => WhimsyPrivateLock.isLocked("tabs"), "With the setting on, it locks");
  WhimsyPrivateLock.unlockAll();
  Services.prefs.setIntPref("whimsy.privateLock.afterSeconds", 0);
  await SpecialPowers.popPrefEnv();
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

  // W13-C2: Lock as Soon as I Leave is a command with an assignable shortcut.
  ok(action("whimsy-action-private-lock-on-leave-off")?.isAvailable(window), "Turn Lock as Soon as I Leave Off is offered");
  ok(document.getElementById("key_cmd_whimsyTogglePrivateLockOnLeave"), "...and can take a shortcut");
  document.getElementById("cmd_whimsyTogglePrivateLockOnLeave").doCommand();
  ok(!Services.prefs.getBoolPref("whimsy.privateLock.onLeave"), "The command turns it off");
  ok(action("whimsy-action-private-lock-on-leave-on")?.isAvailable(window), "...then offers Turn On");
  document.getElementById("cmd_whimsyTogglePrivateLockOnLeave").doCommand();
  ok(Services.prefs.getBoolPref("whimsy.privateLock.onLeave"), "...and back on");

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
    const onLeave = doc.getElementById("whimsyPrivateLockOnLeave");
    ok(onLeave, "Lock as Soon as I Leave");
    await doc.l10n.translateFragment(onLeave);
    is(onLeave.label, "Lock as Soon as I Leave", "...named as the user asked");
    is(onLeave.checked, true, "...shows the setting");
    onLeave.click();
    await TestUtils.waitForCondition(() => !Services.prefs.getBoolPref("whimsy.privateLock.onLeave"), "Unchecking turns it off");
    onLeave.click();
    await TestUtils.waitForCondition(() => Services.prefs.getBoolPref("whimsy.privateLock.onLeave"), "...and on");
  });
});

// W13-C2 (wave13/c2-lock-design.md). Zen's gBrowser.tabs lists only the
// active space's tabs, so the lock used to think a private tab in another
// space was closed: leaving the Private Space never locked it (11-01) and
// a space switch dropped a lock (11-02). These drive the real paths and
// check after each that the cover is up, over the page, and that only the
// auth stand-in unlocks.

function cover() {
  return document.querySelector(".whimsy-lock-cover");
}

// The cover is up, of this kind, and over the whole page.
function assertCovered(kind, what) {
  const el = cover();
  ok(el?.checkVisibility(), `${what}: the cover shows`);
  is(el?.dataset.kind, kind, `${what}: ...the ${kind} cover`);
  const page = gBrowser.selectedBrowser.getBoundingClientRect();
  const box = el.getBoundingClientRect();
  ok(box.left <= page.left && box.top <= page.top && box.right >= page.right && box.bottom >= page.bottom,
    `${what}: ...over the whole page`);
  ok(document.documentElement.hasAttribute("whimsy-private-selected-locked"), `${what}: the address bar reads Locked`);
}

async function changeSpace(uuid) {
  await gZenWorkspaces.changeWorkspace(gZenWorkspaces.getWorkspaceFromId(uuid));
  is(gZenWorkspaces.activeWorkspace, uuid, "Switched space");
}

add_task(async function test_private_space_locks_on_leaving_and_stays_locked() {
  Services.prefs.setIntPref("whimsy.privateLock.space", 1);
  Services.prefs.setIntPref("whimsy.privateLock.afterSeconds", 0);
  const home = gZenWorkspaces.activeWorkspace;
  const scratch = await WhimsyPrivate.openScratch(window, { withTab: true });
  const priv = gBrowser.selectedTab;
  const url = uniqueURL("space");
  BrowserTestUtils.startLoadingURIString(priv.linkedBrowser, url);
  await BrowserTestUtils.browserLoaded(priv.linkedBrowser, false, url);
  is(WhimsyPrivateLock.kindOfTab(window, priv), "space", "A Private Space tab");
  ok(!WhimsyPrivateLock.isLocked("space"), "Unlocked while you're in it");
  asked.length = 0;
  answer = false;

  // 11-01: switching spaces away locks it.
  await changeSpace(home);
  ok(WhimsyPrivateLock.hasOpen("space"), "Its tab still counts from another space");
  ok(WhimsyPrivateLock.isLocked("space"), "Leaving the Private Space locks it");
  ok(priv.hasAttribute(WhimsyPrivateLock.LOCKED_ATTR), "Its row is masked though it's in another space");
  ok(!cover(), "No cover over the normal space");

  // 11-02: coming back finds it locked, behind the cover, asking at once.
  await changeSpace(scratch.uuid);
  is(gBrowser.selectedTab, priv, "Back on the private tab");
  assertCovered("space", "Back in the Private Space");
  await TestUtils.waitForCondition(() => asked.length == 1, "Touch ID is asked for on landing");
  await TestUtils.waitForCondition(() => cover()?.hasAttribute("failed"), "The cancel shows Didn't unlock");
  ok(WhimsyPrivateLock.isLocked("space"), "A cancel keeps it locked");

  // Leaving and coming back again (the 11-02 report) doesn't unlock it.
  await changeSpace(home);
  ok(WhimsyPrivateLock.isLocked("space"), "Still locked after leaving again");
  await changeSpace(scratch.uuid);
  assertCovered("space", "Back a second time");
  await TestUtils.waitForCondition(() => asked.length == 2, "Asked again on the new landing");
  ok(WhimsyPrivateLock.isLocked("space"), "...and still locked");

  // Only a yes from the auth stand-in unlocks.
  await TestUtils.waitForCondition(() => !WhimsyPrivateLock._prompting, "The landing prompt was answered");
  answer = true;
  cover().querySelector(".whimsy-lock-cover-button").doCommand();
  await TestUtils.waitForCondition(() => !cover(), "Unlocked: the cover goes");
  ok(!WhimsyPrivateLock.isLocked("space"), "Unlocked");
  ok(!priv.hasAttribute(WhimsyPrivateLock.LOCKED_ATTR), "The row is back");

  answer = false;
  await changeSpace(home);
  await WhimsyPrivate.closeScratch(window);
  WhimsyPrivateLock.unlockAll();
  Services.prefs.clearUserPref("whimsy.privateLock.space");
  Services.prefs.clearUserPref("whimsy.privateLock.askDismissals.space");
});

add_task(async function test_private_tab_stays_locked_across_spaces_and_keys() {
  Services.prefs.setIntPref("whimsy.privateLock.tabs", 1);
  Services.prefs.setIntPref("whimsy.privateLock.afterSeconds", 0);
  const home = gZenWorkspaces.activeWorkspace;
  const other = await gZenWorkspaces.createAndSaveWorkspace("Elsewhere", undefined, true);
  // Open it last in the space, so ⌘9 (the last tab) reaches it.
  const normal = gBrowser.visibleTabs.filter(t => !t.pinned && !t.hasAttribute("zen-empty-tab")).at(-1);
  gBrowser.selectedTab = normal;
  const priv = await openPrivateTab("keys");
  is(gBrowser.visibleTabs.at(-1), priv, "The private tab is the last in its space");
  answer = false;
  asked.length = 0;

  // Leaving the tab locks it.
  gBrowser.selectedTab = normal;
  ok(WhimsyPrivateLock.isLocked("tabs"), "Selecting another tab locks it");

  // 11-02: a space switch there and back keeps it locked.
  await changeSpace(other.uuid);
  ok(WhimsyPrivateLock.isLocked("tabs"), "Locked while in another space");
  await changeSpace(home);
  ok(WhimsyPrivateLock.isLocked("tabs"), "Still locked back in its space");
  ok(priv.hasAttribute(WhimsyPrivateLock.LOCKED_ATTR), "...its row masked");
  is(asked.length, 0, "Nothing asked while it isn't in front");

  // ⌘9 lands on it: covered, asked at once.
  EventUtils.synthesizeKey("9", { accelKey: true });
  await TestUtils.waitForCondition(() => gBrowser.selectedTab == priv, "⌘9 selects it");
  assertCovered("tabs", "After ⌘9");
  await TestUtils.waitForCondition(() => asked.length == 1, "Asked on landing");
  ok(WhimsyPrivateLock.isLocked("tabs"), "A cancel keeps it locked");

  // Side doors while locked: Ctrl+Tab's thumbnail, the hover preview.
  is(await tabPreviews.get(priv), null, "Ctrl+Tab gets no thumbnail of a locked tab");
  let hoverSeen = false;
  const onHover = () => (hoverSeen = true);
  gBrowser.tabContainer.addEventListener("TabHoverStart", onHover);
  priv.dispatchEvent(new CustomEvent("TabHoverStart", { bubbles: true }));
  gBrowser.tabContainer.removeEventListener("TabHoverStart", onHover);
  ok(!hoverSeen, "The hover preview never hears about a locked tab");

  // Select it from the other space with gBrowser.selectedTab: covered.
  gBrowser.selectedTab = normal;
  await changeSpace(other.uuid);
  gBrowser.selectedTab = priv;
  // Zen first switches to the tab's space, then selects it.
  await TestUtils.waitForCondition(() => gBrowser.selectedTab == priv, "Selected, in its own space");
  assertCovered("tabs", "Selected directly");
  ok(WhimsyPrivateLock.isLocked("tabs"), "Still locked");
  await TestUtils.waitForCondition(() => asked.length == 2 && !WhimsyPrivateLock._prompting, "Asked on this landing too");
  ok(WhimsyPrivateLock.isLocked("tabs"), "...and a cancel keeps it");

  answer = true;
  cover().querySelector(".whimsy-lock-cover-button").doCommand();
  await TestUtils.waitForCondition(() => !cover(), "Unlocked");
  ok(!WhimsyPrivateLock.isLocked("tabs"), "Only the auth stand-in unlocked it");

  answer = false;
  gBrowser.selectedTab = normal;
  if (gZenWorkspaces.activeWorkspace != home) {
    await changeSpace(home);
  }
  BrowserTestUtils.removeTab(priv, { animate: false });
  await gZenWorkspaces.removeWorkspace(other.uuid);
  WhimsyPrivateLock.unlockAll();
});

// W13-C2 follow-up: the private command bar never lists a locked private
// tab (its Switch to Tab row would show the page's title and address).
add_task(async function test_command_bar_hides_locked_tabs() {
  const { UrlbarTestUtils } = ChromeUtils.importESModule("resource://testing-common/UrlbarTestUtils.sys.mjs");
  await SpecialPowers.pushPrefEnv({ set: [["whimsy.privateLock.onLeave", false]] });
  Services.prefs.setIntPref("whimsy.privateLock.tabs", 1);
  const url = uniqueURL("lockedrow");
  const priv = WhimsyPrivate.openPrivateTab(window, { url });
  await TestUtils.waitForCondition(() => priv.linkedBrowser.currentURI?.spec == url, "The private page loaded");
  gBrowser.selectedTab = gBrowser.tabs[0];
  await SimpleTest.promiseFocus(window);
  const rowsFor = async () => {
    const count = UrlbarTestUtils.getResultCount(window);
    const out = [];
    for (let i = 0; i < count; i++) {
      out.push((await UrlbarTestUtils.getDetailsOfResultAt(window, i)).result);
    }
    return out.filter(r => !r.heuristic && r.payload?.url == url);
  };
  const search = async () => {
    EventUtils.synthesizeKey("t", { accelKey: true, altKey: true });
    await TestUtils.waitForCondition(() => gURLBar.focused && gURLBar.hasAttribute("zen-newtab"), "The private command bar");
    gURLBar.search("lockedrow");
    await UrlbarTestUtils.promiseSearchComplete(window);
    const rows = await rowsFor();
    EventUtils.synthesizeKey("KEY_Escape");
    EventUtils.synthesizeKey("KEY_Escape");
    gBrowser.selectedBrowser.focus();
    await TestUtils.waitForTick();
    if (gURLBar.hasAttribute("zen-newtab")) {
      gURLBar._zenHandleUrlbarClose?.();
    }
    await TestUtils.waitForCondition(() => !gURLBar.hasAttribute("zen-newtab"), "The bar closed");
    return rows;
  };
  const before = await search();
  WhimsyPrivateLock.lockNow();
  ok(WhimsyPrivateLock.isLocked("tabs"), "Locked");
  const after = await search();
  is(after.length, 0, `No row for the locked tab (unlocked it had ${before.length})`);
  WhimsyPrivateLock.unlockAll();
  await SpecialPowers.popPrefEnv();
  BrowserTestUtils.removeTab(priv, { animate: false });
});

add_task(async function test_ask_prompt_opens_centred_on_the_window() {
  // B4: the lock prompt has no anchor, so it lands centred on the page.
  await SpecialPowers.pushPrefEnv({ clear: [["whimsy.privateLock.askDismissals.tabs"], ["whimsy.privateLock.tabs"]] });
  WhimsyPrivateLock._asked?.clear();
  const tab = await openPrivateTab("centred");
  const panel = await TestUtils.waitForCondition(askPanel, "Asked about the new private tab");
  const area = WhimsySurface.pageArea(window).getBoundingClientRect();
  const box = panel.getBoundingClientRect();
  const gapStart = box.left - area.left;
  const gapEnd = area.right - box.right;
  Assert.less(Math.abs(gapStart - gapEnd), 3, "Centred horizontally on the page: the side gaps match");
  const hidden = BrowserTestUtils.waitForEvent(panel, "popuphidden");
  EventUtils.synthesizeKey("KEY_Escape", {}, window);
  await hidden;
  Services.prefs.clearUserPref("whimsy.privateLock.askDismissals.tabs");
  WhimsyPrivateLock._asked?.clear();
  await SpecialPowers.popPrefEnv();
  BrowserTestUtils.removeTab(tab, { animate: false });
});
