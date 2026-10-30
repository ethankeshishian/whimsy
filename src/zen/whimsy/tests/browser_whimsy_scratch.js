/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// Scratch and private tabs (whimsy.feature.scratch): Firefox's real private
// browsing (originAttributes.privateBrowsingId = 1) per tab, in a normal
// window. Needs the engine patches (src/dom/base/whimsy-nsFrameLoader-cpp.patch
// and friends).

const { WhimsyPrivate } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyPrivate.sys.mjs");
const { PrivateBrowsingUtils } = ChromeUtils.importESModule("resource://gre/modules/PrivateBrowsingUtils.sys.mjs");
const { PrivacyFilter } = ChromeUtils.importESModule("resource://gre/modules/sessionstore/PrivacyFilter.sys.mjs");
const { SessionStore } = ChromeUtils.importESModule("moz-src:///browser/components/sessionstore/SessionStore.sys.mjs");
const { TabStateFlusher } = ChromeUtils.importESModule("moz-src:///browser/components/sessionstore/TabStateFlusher.sys.mjs");
const { TabState } = ChromeUtils.importESModule("moz-src:///browser/components/sessionstore/TabState.sys.mjs");
const { PlacesUtils } = ChromeUtils.importESModule("resource://gre/modules/PlacesUtils.sys.mjs");

const ROOT = getRootDirectory(gTestPath).replace("chrome://mochitests/content", "https://example.com");
const PAGE = ROOT + "whimsy_article.html";

function uniqueURL(tag) {
  return `${PAGE}?${tag}=${Date.now()}${Math.random().toString(36).slice(2)}`;
}

async function openPrivateTab(url) {
  const tab = WhimsyPrivate.openPrivateTab(window, { url });
  ok(tab, "A private tab opened");
  await BrowserTestUtils.browserLoaded(tab.linkedBrowser, false, url);
  return tab;
}

// TabOpen and a BrowsingContext alone don't mean the initial navigation or
// deferred extension TabOpen handlers have finished. Don't tear it down then.
async function waitForPage(tab, url = "about:privatebrowsing") {
  await TestUtils.waitForCondition(() =>
    tab.linkedBrowser.browsingContext?.currentWindowGlobal?.documentURI.spec == url &&
    !tab.linkedBrowser.webProgress.isLoadingDocument,
    "The initial page finished opening"
  );
  await SpecialPowers.spawn(tab.linkedBrowser, [], () => {});
  await TestUtils.waitForTick();
}

async function closeTab(tab) {
  BrowserTestUtils.removeTab(tab, { animate: false });
  await TestUtils.waitForCondition(() => !tab.isConnected, "The tab was removed");
  await TestUtils.waitForTick();
}

function savedURLs() {
  const state = SessionStore.getCurrentState(true);
  PrivacyFilter.filterPrivateWindowsAndTabs(state);
  return state.windows.flatMap(win => (win.tabs || []).flatMap(tab => (tab.entries || []).map(e => e.url)));
}

function assertPrivate(tab, what) {
  const bc = tab.linkedBrowser.browsingContext;
  ok(tab.hasAttribute("whimsy-private"), `${what}: marked private`);
  ok(bc.usePrivateBrowsing, `${what}: its BrowsingContext browses privately`);
  is(bc.originAttributes.privateBrowsingId, 1, `${what}: privateBrowsingId is 1`);
  ok(PrivateBrowsingUtils.isBrowserPrivate(tab.linkedBrowser), `${what}: isBrowserPrivate agrees`);
  // Privileged about: pages use a dedicated process type without origin
  // attributes in its name. Web pages must run in a private web process.
  if (/^https?:/.test(tab.linkedBrowser.currentURI.spec)) {
    ok(/privateBrowsingId=1/.test(tab.linkedBrowser.remoteType), `${what}: runs in a private process`);
  }
}

registerCleanupFunction(async () => {
  await WhimsyPrivate.closeScratch(window);
});

add_task(async function test_shortcuts() {
  ok(Services.prefs.getBoolPref("whimsy.feature.scratch"), "The feature switch is on");
  ok(Services.prefs.getBoolPref("whimsy.private.in-window"), "The setting is on by default");
  const scratchKey = document.getElementById("key_whimsyNewScratch");
  is(scratchKey?.getAttribute("key"), "N", "Scratch is on N");
  is(scratchKey?.getAttribute("modifiers"), "accel,shift", "... with Cmd+Shift");
  const tabKey = document.getElementById("key_whimsyNewPrivateTab");
  is(tabKey?.getAttribute("key"), "T", "Private tab is on T");
  is(tabKey?.getAttribute("modifiers"), "accel,alt", "... with Cmd+Option");

  // The shortcut itself opens a private tab.
  const opened = BrowserTestUtils.waitForEvent(gBrowser.tabContainer, "TabOpen");
  EventUtils.synthesizeKey("t", { accelKey: true, altKey: true });
  const { target: tab } = await opened;
  ok(tab.hasAttribute("whimsy-private"), "Cmd+Option+T opened a private tab");
  await waitForPage(tab);
  ok(tab.linkedBrowser.browsingContext.usePrivateBrowsing, "... that browses privately");
  await closeTab(tab);
});

add_task(async function test_private_tab_is_private() {
  ok(!PrivateBrowsingUtils.isWindowPrivate(window), "The window itself isn't private");
  const normal = await BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE);
  ok(!normal.hasAttribute("whimsy-private"), "A normal tab isn't marked");
  ok(!normal.linkedBrowser.browsingContext.usePrivateBrowsing, "A normal tab isn't private");

  const tab = await openPrivateTab(uniqueURL("private"));
  assertPrivate(tab, "Cmd+Option+T tab");
  is(gBrowser.selectedTab, tab, "The private tab is selected");
  await TestUtils.waitForCondition(
    () => tab.getAttribute("zen-workspace-id") == gZenWorkspaces.activeWorkspace,
    "It opened in the current space"
  );
  ok(document.documentElement.hasAttribute("whimsy-private-tab"), "The window shows a private tab is selected");
  ok(gURLBar.isPrivate, "The address bar treats it as private");
  const pbId = await SpecialPowers.spawn(
    tab.linkedBrowser,
    [],
    () => content.document.nodePrincipal.originAttributes.privateBrowsingId
  );
  is(pbId, 1, "The page's principal is private");

  // Its own cookie jar.
  await SpecialPowers.spawn(tab.linkedBrowser, [], () => {
    content.document.cookie = "whimsyPrivate=1; path=/";
  });
  const normalCookies = await SpecialPowers.spawn(normal.linkedBrowser, [], () => content.document.cookie);
  ok(!normalCookies.includes("whimsyPrivate"), "A normal tab on the same site can't see its cookie");

  // Pinning (saved and synced) is refused.
  gBrowser.pinTab(tab);
  ok(!tab.pinned, "A private tab can't be pinned");

  gBrowser.selectedTab = normal;
  ok(!gURLBar.isPrivate, "Back on a normal tab, the address bar isn't private");
  ok(!document.documentElement.hasAttribute("whimsy-private-tab"), "... and the window isn't marked");

  await closeTab(tab);
  await closeTab(normal);
});

add_task(async function test_not_saved_no_history() {
  const normalURL = uniqueURL("normal");
  const privateURL = uniqueURL("private");
  const normal = await BrowserTestUtils.openNewForegroundTab(gBrowser, normalURL);
  const tab = await openPrivateTab(privateURL);

  ok(TabState.collect(tab).isPrivate, "Its session data is marked private");
  await TabStateFlusher.flush(normal.linkedBrowser);
  await TabStateFlusher.flush(tab.linkedBrowser);
  const urls = savedURLs();
  ok(urls.includes(normalURL), "The normal tab is in the saved session");
  ok(!urls.includes(privateURL), "The private tab is not");

  await TestUtils.waitForCondition(() => PlacesUtils.history.hasVisits(normalURL), "The normal visit lands in history");
  ok(!(await PlacesUtils.history.hasVisits(privateURL)), "The private visit doesn't");

  const closedBefore = SessionStore.getClosedTabCountForWindow(window);
  await closeTab(tab);
  is(SessionStore.getClosedTabCountForWindow(window), closedBefore, "Undo Close Tab doesn't offer it");
  await closeTab(normal);
  await PlacesUtils.history.remove(normalURL);
});

add_task(async function test_window_open_stays_private() {
  await SpecialPowers.pushPrefEnv({
    set: [
      ["dom.disable_open_during_load", false],
      ["browser.link.open_newwindow", 3],
    ],
  });
  const tab = await openPrivateTab(uniqueURL("opener"));
  const popupURL = uniqueURL("popup");
  const opened = BrowserTestUtils.waitForNewTab(gBrowser, popupURL, true);
  await SpecialPowers.spawn(tab.linkedBrowser, [popupURL], url => {
    content.open(url);
  });
  const popup = await opened;
  assertPrivate(popup, "window.open tab");
  ok(!savedURLs().includes(popupURL), "The opened tab isn't saved either");
  ok(!(await PlacesUtils.history.hasVisits(popupURL)), "... nor in history");
  await closeTab(popup);
  await closeTab(tab);
  await SpecialPowers.popPrefEnv();
});

add_task(async function test_scratch_space() {
  const startSpace = gZenWorkspaces.activeWorkspace;
  const before = gZenWorkspaces.getWorkspaces().length;
  const scratch = await WhimsyPrivate.openScratch(window);
  ok(scratch?.whimsyScratch, "Scratch was created");
  const spaces = gZenWorkspaces.getWorkspaces();
  is(spaces.length, before + 1, "One more space");
  is(spaces.at(-1).uuid, scratch.uuid, "Scratch is right of every space");
  is(gZenWorkspaces.activeWorkspace, scratch.uuid, "Scratch is the active space");
  const first = gBrowser.selectedTab;
  await waitForPage(first);
  assertPrivate(first, "Scratch's first tab");
  await TestUtils.waitForCondition(() => first.getAttribute("zen-workspace-id") == scratch.uuid, "It is in Scratch");
  ok(gZenWorkspaces.workspaceElement(scratch.uuid)?.hasAttribute("whimsy-scratch"), "Scratch's space is marked");
  await TestUtils.waitForCondition(
    () => document.querySelector(`toolbarbutton[zen-workspace-id="${scratch.uuid}"][whimsy-scratch]`),
    "Scratch's switcher icon is marked"
  );
  ok(
    !gZenWorkspaces.getWorkspacesForSessionStore().some(space => space.uuid == scratch.uuid),
    "Scratch is never saved"
  );

  // Anything opened in Scratch is private.
  const url = uniqueURL("scratch");
  const other = gBrowser.addTrustedTab(url);
  await BrowserTestUtils.browserLoaded(other.linkedBrowser, false, url);
  assertPrivate(other, "A tab opened in Scratch");

  // Cmd+Shift+N again goes back to the same Scratch.
  const again = await WhimsyPrivate.openScratch(window);
  is(again.uuid, scratch.uuid, "There is only one Scratch");
  is(gZenWorkspaces.getWorkspaces().length, before + 1, "No second space");
  await waitForPage(gBrowser.selectedTab);
  // Zen keeps an internal empty-tab sentinel for each workspace; it isn't
  // a user tab and removeTabs deliberately excludes it.
  const scratchTabs = gBrowser.tabs.filter(t =>
    t.getAttribute("zen-workspace-id") == scratch.uuid && !t.hasAttribute("zen-empty-tab")
  );

  const closed = await Promise.all([
    WhimsyPrivate.closeScratch(window),
    WhimsyPrivate.closeScratch(window),
  ]);
  ok(closed.every(Boolean), "Concurrent Close Scratch calls complete together");
  ok(!gZenWorkspaces.getWorkspaces().some(space => space.uuid == scratch.uuid), "Scratch is gone");
  ok(
    scratchTabs.every(t => t.closing || !t.isConnected),
    "Its tabs are closed"
  );
  isnot(gZenWorkspaces.activeWorkspace, scratch.uuid, "Another space is active");
  if (gZenWorkspaces.activeWorkspace != startSpace) {
    await gZenWorkspaces.changeWorkspaceWithID(startSpace);
  }
});

add_task(async function test_closing_last_scratch_tab_removes_it() {
  const startSpace = gZenWorkspaces.activeWorkspace;
  const scratch = await WhimsyPrivate.openScratch(window);
  ok(scratch, "Scratch opened");
  await waitForPage(gBrowser.selectedTab);
  await closeTab(gBrowser.selectedTab);
  await TestUtils.waitForCondition(() => !WhimsyPrivate.getScratch(window), "Closing its last tab removes Scratch");
  if (gZenWorkspaces.activeWorkspace != startSpace) {
    await gZenWorkspaces.changeWorkspaceWithID(startSpace);
  }
});

add_task(async function test_keep_scratch_as_space() {
  const startSpace = gZenWorkspaces.activeWorkspace;
  const scratch = await WhimsyPrivate.openScratch(window);
  await waitForPage(gBrowser.selectedTab);
  const url = uniqueURL("keep");
  BrowserTestUtils.startLoadingURIString(gBrowser.selectedBrowser, url);
  await BrowserTestUtils.browserLoaded(gBrowser.selectedBrowser, false, url);
  const kept = await WhimsyPrivate.keepScratch(window);
  is(kept?.uuid, scratch.uuid, "The same space stays");
  ok(!WhimsyPrivate.getScratch(window), "It isn't Scratch any more");
  // fixC: none of the private look stays behind.
  ok(!document.querySelector("[whimsy-scratch]"), "No element keeps Scratch's violet marks");
  const indicator = gZenWorkspaces.workspaceElement(kept.uuid)?.indicator;
  is(
    indicator?.querySelector(".zen-current-workspace-indicator-name")?.textContent,
    kept.name,
    "The space's header shows its new name right away"
  );
  ok(
    gZenWorkspaces.getWorkspacesForSessionStore().some(space => space.uuid == kept.uuid),
    "It is saved like any space"
  );
  const reopened = await TestUtils.waitForCondition(() =>
    gBrowser.tabs.find(t => !t.closing && t.linkedBrowser.currentURI?.spec == url)
  );
  ok(!reopened.hasAttribute("whimsy-private"), "Its page reopened as a normal tab");
  ok(!reopened.linkedBrowser.browsingContext.usePrivateBrowsing, "... outside private browsing");
  await waitForPage(reopened, url);
  await gZenWorkspaces.changeWorkspaceWithID(startSpace);
  await closeTab(reopened);
  await gZenWorkspaces.removeWorkspace(kept.uuid);
  if (gZenWorkspaces.activeWorkspace != startSpace) {
    await gZenWorkspaces.changeWorkspaceWithID(startSpace);
  }
  await PlacesUtils.history.remove(url);
});

add_task(async function test_keep_empty_scratch_as_space() {
  const startSpace = gZenWorkspaces.activeWorkspace;
  const scratch = await WhimsyPrivate.openScratch(window);
  const privateTab = gBrowser.selectedTab;
  await waitForPage(privateTab);
  const kept = await WhimsyPrivate.keepScratch(window);
  is(kept.uuid, scratch.uuid, "Keeping an empty Scratch preserves its space");
  ok(!privateTab.isConnected, "The private new-tab browser was removed");
  const replacement = gBrowser.selectedTab;
  is(replacement.getAttribute("zen-workspace-id"), kept.uuid, "A replacement stays in the kept space");
  ok(!WhimsyPrivate.isPrivateTab(replacement), "The replacement tab is normal");
  ok(!replacement.linkedBrowser.browsingContext.usePrivateBrowsing, "Its context is normal too");
  await waitForPage(replacement, BROWSER_NEW_TAB_URL);
  await gZenWorkspaces.changeWorkspaceWithID(startSpace);
  await closeTab(replacement);
  await gZenWorkspaces.removeWorkspace(kept.uuid);
});

add_task(async function test_switch_and_setting_off() {
  const tabs = gBrowser.tabs.length;
  const spaces = gZenWorkspaces.getWorkspaces().length;
  for (const [pref, what] of [
    ["whimsy.feature.scratch", "With the switch off"],
    ["whimsy.private.in-window", "With the setting off"],
  ]) {
    await SpecialPowers.pushPrefEnv({ set: [[pref, false]] });
    is(WhimsyPrivate.openPrivateTab(window), null, `${what}, no private tab opens in the window`);
    is(await WhimsyPrivate.openScratch(window), null, `${what}, no Scratch`);
    is(gBrowser.tabs.length, tabs, `${what}, no tab was added`);
    is(gZenWorkspaces.getWorkspaces().length, spaces, `${what}, no space was added`);
    await SpecialPowers.popPrefEnv();
  }
});

// fixC: Keep asks first, because the space stops being private.
// fix7/private: in a real modal dialog, the window-modal prompt Firefox uses
// for its close-window warning and Whimsy for Delete Space (not a toast or
// notification): title, one sentence, Cancel + "Keep Space"; Cancel is the
// default button and Esc cancels.
add_task(async function test_keep_asks_first() {
  const startSpace = gZenWorkspaces.activeWorkspace;
  const scratch = await WhimsyPrivate.openScratch(window);
  await waitForPage(gBrowser.selectedTab);
  let dialog = BrowserTestUtils.promiseAlertDialogOpen(null);
  document.getElementById("cmd_whimsyKeepScratch").doCommand();
  let win = await dialog;
  ok(window.gDialogBox.isOpen, "It asks in the window-modal dialog");
  is(win.document.documentURI, "chrome://global/content/commonDialog.xhtml", "Firefox's own prompt dialog");
  ok(
    ![...(document.getElementById("zen-toast-container")?.children ?? [])].some(t => t._messageId?.startsWith("whimsy-scratch")),
    "No toast asks instead"
  );
  let dialogEl = win.document.querySelector("dialog");
  is(dialogEl.getButton("accept").label, "Keep Space", "The button says what it does");
  ok(!dialogEl.getButton("cancel").hidden, "There's a Cancel button");
  is(dialogEl.defaultButton, "cancel", "Cancel, the safe button, is the default");
  is(win.document.getElementById("infoTitle").textContent, "Keep as a Normal Space?", "It has a title");
  ok(win.document.getElementById("infoBody").textContent.includes("private browsing"), "One sentence says what changes");
  ok(win.document.getElementById("loginContainer").hidden, "No text field takes the focus");
  EventUtils.synthesizeKey("KEY_Escape", {}, win);
  await TestUtils.waitForCondition(() => !window.gDialogBox.isOpen, "Esc closes the dialog");
  ok(WhimsyPrivate.getScratch(window), "Esc changes nothing");

  dialog = BrowserTestUtils.promiseAlertDialogOpen(null);
  document.getElementById("cmd_whimsyKeepScratch").doCommand();
  win = await dialog;
  EventUtils.synthesizeKey("KEY_Enter", {}, win);
  await TestUtils.waitForCondition(() => !window.gDialogBox.isOpen, "Return closes the dialog");
  ok(WhimsyPrivate.getScratch(window), "Return picks Cancel and changes nothing");

  dialog = BrowserTestUtils.promiseAlertDialogOpen(null);
  document.getElementById("cmd_whimsyKeepScratch").doCommand();
  win = await dialog;
  win.document.querySelector("dialog").getButton("cancel").click();
  await TestUtils.waitForCondition(() => !window.gDialogBox.isOpen, "Cancel closes the dialog");
  ok(WhimsyPrivate.getScratch(window), "Cancel changes nothing");

  dialog = BrowserTestUtils.promiseAlertDialogOpen(null);
  document.getElementById("cmd_whimsyKeepScratch").doCommand();
  win = await dialog;
  ok(WhimsyPrivate.getScratch(window), "Nothing changed yet");
  win.document.querySelector("dialog").getButton("accept").click();
  await TestUtils.waitForCondition(() => !WhimsyPrivate.getScratch(window), "Keep made it a normal space");
  const kept = gZenWorkspaces.getWorkspaces().find(space => space.uuid == scratch.uuid);
  ok(kept && !kept.whimsyScratch, "The same space is now normal");
  await TestUtils.waitForCondition(
    () => gBrowser.selectedTab.getAttribute("zen-workspace-id") == kept.uuid && !WhimsyPrivate.isPrivateTab(gBrowser.selectedTab),
    "A normal tab replaced the private one"
  );
  const replacement = gBrowser.selectedTab;
  await waitForPage(replacement, BROWSER_NEW_TAB_URL);
  await gZenWorkspaces.changeWorkspaceWithID(startSpace);
  await closeTab(replacement);
  await gZenWorkspaces.removeWorkspace(kept.uuid);
});
