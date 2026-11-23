/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

// W30 AppleScript: what Whimsy.sdef's classes ask WhimsyScripting.sys.mjs
// (@whimsy/scripting;1) for. Listing windows, tabs, and spaces; private
// windows and tabs, Scratch, hidden spaces, and locked spaces never
// appearing or taking commands; every command; addresses refused; and the
// switch. browser_whimsy_applescript_osascript.js runs real AppleScript.

const { PrivateBrowsingUtils } = ChromeUtils.importESModule("resource://gre/modules/PrivateBrowsingUtils.sys.mjs");
const { WhimsyHiddenSpaces } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyHiddenSpaces.sys.mjs");
const { WhimsyPrivate } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyPrivate.sys.mjs");
const { WhimsyScripting } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyScripting.sys.mjs");

const PAGE = "https://example.com/document-builder.sjs?html=" + encodeURIComponent("<title>Scripted A</title>A");
const OTHER = "https://example.com/document-builder.sjs?html=" + encodeURIComponent("<title>Scripted B</title>B");

const service = Cc["@whimsy/scripting;1"].getService(Ci.nsIWhimsyScripting);
const winId = String(window.docShell.outerWindowID);

const json = value => JSON.parse(value);
const selectedId = () => json(service.window(winId)).activeTabId;

function throwsResult(fn, result, message) {
  try {
    fn();
    ok(false, `${message}: didn't throw`);
  } catch (e) {
    is(e.result, result, message);
  }
}

// Swaps `obj[name]` for the test's length.
function stub(obj, name, value) {
  const real = obj[name];
  obj[name] = value;
  return () => {
    obj[name] = real;
  };
}

function loaded(tab, url) {
  return BrowserTestUtils.browserLoaded(tab.linkedBrowser, false, url);
}

// Back and forward may come out of the back-forward cache, which fires no
// load event, so these wait for the address and for the tab to settle.
function settledAt(tab, url, message) {
  return TestUtils.waitForCondition(
    () => tab.linkedBrowser.currentURI.spec == url && !tab.hasAttribute("busy"),
    message
  );
}

function describeTab(tab) {
  const flags = ["zen-empty-tab", "zen-essential", "pinned", "hidden", "pending", "busy"].filter(a => tab.hasAttribute(a));
  return `${tab.linkedBrowser?.currentURI?.spec} space=${tab.getAttribute("zen-workspace-id")} ${flags.join(",")}`;
}

// Each task leaves the window's tabs as it found them.
function add_tab_task(fn) {
  add_task(async function () {
    const before = new Set(gBrowser.tabs);
    info(`${fn.name} starts with: ${[...before].map(describeTab).join(" | ")}`);
    await fn();
    const left = gBrowser.tabs.filter(tab => !before.has(tab) && !tab.closing);
    info(`${fn.name} ends with: ${gBrowser.tabs.map(describeTab).join(" | ")}`);
    Assert.deepEqual(left.map(describeTab), [], `${fn.name} left no tab behind`);
  });
}

add_tab_task(async function test_windows_never_private() {
  ok(json(service.windows()).includes(winId), "This window is listed");
  const record = json(service.window(winId));
  is(record.mode, "normal", "Normal mode");
  is(record.activeSpaceId, gZenWorkspaces.activeWorkspace, "Its active space");
  is(record.activeTabId, json(service.tabs(winId, ""))[record.activeTabIndex - 1], "Active tab index points at the active tab");

  const privateWin = await BrowserTestUtils.openNewBrowserWindow({ private: true });
  const privateId = String(privateWin.docShell.outerWindowID);
  const privateTabs = privateWin.gBrowser.tabs.length;
  try {
    ok(!json(service.windows()).includes(privateId), "A private window isn't listed");
    for (const [name, fn] of [
      ["window", () => service.window(privateId)],
      ["tabs", () => service.tabs(privateId, "")],
      ["spaces", () => service.spaces(privateId)],
      ["make tab", () => service.makeTab(privateId, "", PAGE)],
      ["close", () => service.closeWindow(privateId)],
      ["active tab index", () => service.setActiveTabIndex(privateId, 1)],
    ]) {
      throwsResult(fn, Cr.NS_ERROR_INVALID_ARG, `A private window: ${name} refused`);
    }
    ok(!privateWin.closed, "It stayed open");
    is(privateWin.gBrowser.tabs.length, privateTabs, "And got no tab");
  } finally {
    await BrowserTestUtils.closeWindow(privateWin);
  }
});

add_tab_task(async function test_tabs_never_private() {
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE);
  // The load event can come before the tab stops being busy.
  await settledAt(tab, PAGE, "The tab finished loading");
  const id = selectedId();
  ok(json(service.tabs(winId, "")).includes(id), "The tab is listed");
  const record = json(service.tab(id));
  is(record.url, PAGE, "URL");
  is(record.title, "Scripted A", "Title");
  is(record.loading, false, "Loaded");
  is(record.pinned, false, "Not pinned");
  is(record.windowId, winId, "Its window");
  is(record.spaceId, gZenWorkspaces.activeWorkspace, "Its space");
  is(json(service.window(winId)).name, "Scripted A", "The window is named for it");
  is(id, selectedId(), "Its id stays the same");

  const count = json(service.tabs(winId, "")).length;
  const privateTab = WhimsyPrivate.openPrivateTab(window, { url: OTHER, force: true });
  await loaded(privateTab, OTHER);
  gBrowser.selectedTab = privateTab;
  try {
    is(json(service.tabs(winId, "")).length, count, "A private tab isn't listed");
    const over = json(service.window(winId));
    is(over.activeTabId, null, "Nor is it the active tab");
    is(over.activeTabIndex, null, "Nor has an index");
    is(over.name, "", "And its title doesn't name the window");
  } finally {
    BrowserTestUtils.removeTab(privateTab);
    BrowserTestUtils.removeTab(tab);
  }
});

add_tab_task(async function test_spaces_scratch_hidden_and_locked() {
  const home = gZenWorkspaces.activeWorkspace;
  // Made without switching to it: the user stays in their space.
  const space = await gZenWorkspaces.createAndSaveWorkspace("Scripting test space", undefined, true);
  is(gZenWorkspaces.activeWorkspace, home, "Still in the home space");
  try {
    const listed = json(service.spaces(winId)).find(s => s.id == space.uuid);
    is(listed?.name, "Scripting test space", "The space is listed with its name");

    const selected = gBrowser.selectedTab;
    const id = service.makeTab(winId, space.uuid, PAGE);
    ok(json(service.tabs(winId, space.uuid)).includes(id), "A tab made in the space is in it");
    ok(!json(service.tabs(winId, "")).includes(id), "Not among the window's current tabs");
    is(json(service.tab(id)).spaceId, space.uuid, "It knows its space");
    is(gZenWorkspaces.activeWorkspace, home, "Making it didn't switch spaces");
    is(gBrowser.selectedTab, selected, "Nor select it");

    const off = [
      ["hidden", () => stub(WhimsyHiddenSpaces, "hidden", () => [{ uuid: space.uuid, name: space.name }])],
      ["Scratch", () => stub(WhimsyPrivate, "getScratch", () => ({ uuid: space.uuid, whimsyScratch: true }))],
      [
        "locked",
        () => {
          gZenWorkspaces.getWorkspaceFromId(space.uuid).whimsyLocked = true;
          return () => delete gZenWorkspaces.getWorkspaceFromId(space.uuid).whimsyLocked;
        },
      ],
    ];
    for (const [kind, apply] of off) {
      const restore = apply();
      try {
        ok(!json(service.spaces(winId)).some(s => s.id == space.uuid), `A ${kind} space isn't listed`);
        throwsResult(() => service.tabs(winId, space.uuid), Cr.NS_ERROR_INVALID_ARG, `Nor its tabs (${kind})`);
        throwsResult(() => service.tab(id), Cr.NS_ERROR_INVALID_ARG, `Nor its tab (${kind})`);
        throwsResult(() => service.makeTab(winId, space.uuid, PAGE), Cr.NS_ERROR_INVALID_ARG, `No new tab in it (${kind})`);
        throwsResult(() => service.closeTab(id), Cr.NS_ERROR_INVALID_ARG, `No closing its tab (${kind})`);
        throwsResult(() => service.selectSpace(winId, space.uuid), Cr.NS_ERROR_INVALID_ARG, `No switching to it (${kind})`);
      } finally {
        restore();
      }
    }
    ok(json(service.tab(id)), "Visible again once it isn't");

    service.selectSpace(winId, space.uuid);
    await TestUtils.waitForCondition(() => gZenWorkspaces.activeWorkspace == space.uuid, "select space switches to it");
    is(json(service.window(winId)).activeSpaceId, space.uuid, "And it's the active space");
    service.selectSpace(winId, home);
    await TestUtils.waitForCondition(() => gZenWorkspaces.activeWorkspace == home, "And back");

    service.selectTab(id);
    await TestUtils.waitForCondition(
      () => gZenWorkspaces.activeWorkspace == space.uuid && selectedId() == id,
      "select tab switches to its space and selects it"
    );
  } finally {
    if (gZenWorkspaces.activeWorkspace != home) {
      await gZenWorkspaces.changeWorkspaceWithID(home);
    }
    await gZenWorkspaces.removeWorkspace(space.uuid);
  }
});

add_tab_task(async function test_commands() {
  const id = service.makeTab(winId, "", PAGE);
  const tab = gBrowser.selectedTab;
  let newWin = null;
  let copy = null;
  try {
    is(selectedId(), id, "make tab selects the new tab in the active space");
    await settledAt(tab, PAGE, "make tab loads its URL");
    const history = () => tab.linkedBrowser.browsingContext.sessionHistory;
    const first = history().index;

    service.setURL(id, OTHER);
    await settledAt(tab, OTHER, "set URL loads it");
    is(json(service.tab(id)).url, OTHER, "set URL: the tab reports the new URL");

    // Nobody interacts with either page, so this is the case the toolbar's
    // Back skips; the script's command still steps back. The parent's
    // history can trail the address by a moment, so wait for its entry.
    await TestUtils.waitForCondition(() => history()?.index == first + 1, "set URL adds a history entry");
    service.goBack(id);
    await settledAt(tab, PAGE, "go back");
    await TestUtils.waitForCondition(() => history()?.index == first, "go back steps one entry");
    service.goForward(id);
    await settledAt(tab, OTHER, "go forward");
    await TestUtils.waitForCondition(() => history()?.index == first + 1, "go forward steps one entry");

    const reloaded = loaded(tab, OTHER);
    service.reload(id);
    await reloaded;
    ok(true, "reload");

    const ids = json(service.tabs(winId, ""));
    gBrowser.selectedTab = gBrowser.tabs.find(t => t != tab && !t.hasAttribute("zen-empty-tab")) ?? gBrowser.selectedTab;
    service.setActiveTabIndex(winId, ids.indexOf(id) + 1);
    is(gBrowser.selectedTab, tab, "active tab index selects by position");
    throwsResult(() => service.setActiveTabIndex(winId, 0), Cr.NS_ERROR_INVALID_ARG, "Index 0 refused");
    throwsResult(() => service.setActiveTabIndex(winId, ids.length + 1), Cr.NS_ERROR_INVALID_ARG, "Past the end refused");

    const blankId = service.makeTab(winId, "", "");
    const blank = gBrowser.selectedTab;
    is(blank.linkedBrowser.currentURI.spec, "about:blank", "make tab without a URL is about:blank");
    service.closeTab(blankId);
    await TestUtils.waitForCondition(() => !blank.isConnected, "close closes the blank tab");

    service.closeTab(id);
    await TestUtils.waitForCondition(() => !tab.isConnected, "close closes the tab");
    throwsResult(() => service.tab(id), Cr.NS_ERROR_INVALID_ARG, "And it's gone");

    const newId = await new Promise((resolve, reject) =>
      service.makeWindow(PAGE, { onWindow: resolve, onError: reject })
    );
    newWin = [...Services.wm.getEnumerator("navigator:browser")].find(w => String(w.docShell.outerWindowID) == newId);
    ok(json(service.windows()).includes(newId), "make window answers with the new window, already listed");
    ok(newWin && newWin != window && !PrivateBrowsingUtils.isWindowPrivate(newWin), "A new normal window");
    await TestUtils.waitForCondition(() => newWin.gBrowser.selectedBrowser.currentURI.spec == PAGE, "With the URL");
    // Zen's window sync keeps a copy of the new window's tab in this one,
    // and closing the window hands its page to that copy, so the tab isn't
    // lost. The copy is this test's to close.
    const synced = Services.prefs.getBoolPref("zen.window-sync.enabled", false);
    const newTab = newWin.gBrowser.selectedTab;
    if (synced) {
      await TestUtils.waitForCondition(() => document.getElementById(newTab.id), "Window sync copies its tab here");
      copy = document.getElementById(newTab.id);
    }
    service.closeWindow(newId);
    await TestUtils.waitForCondition(() => newWin.closed, "close closes the window");
    ok(!window.closed, "The test's own window stayed open");
    if (copy) {
      await TestUtils.waitForCondition(
        () => copy.linkedBrowser?.currentURI.spec == PAGE,
        "Closing it hands its page to the copy here"
      );
    }
  } finally {
    for (const leftover of [tab, copy]) {
      if (leftover?.isConnected) {
        await BrowserTestUtils.removeTab(leftover);
      }
    }
    if (newWin && !newWin.closed) {
      await BrowserTestUtils.closeWindow(newWin);
    }
  }
});

add_tab_task(async function test_addresses_refused() {
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE);
  try {
    const id = selectedId();
    const count = gBrowser.tabs.length;
    const windows = json(service.windows()).length;
    for (const bad of [
      "javascript:alert(1)",
      "file:///etc/passwd",
      "data:text/html,hi",
      "about:config",
      "about:blank#x",
      "chrome://browser/content/browser.xhtml",
      "view-source:https://example.com/",
      "https://user:pw@example.com/",
      "not a url",
    ]) {
      throwsResult(() => service.makeTab(winId, "", bad), Cr.NS_ERROR_MALFORMED_URI, `make tab refuses ${bad}`);
      throwsResult(() => service.setURL(id, bad), Cr.NS_ERROR_MALFORMED_URI, `set URL refuses ${bad}`);
      throwsResult(
        () => service.makeWindow(bad, { onWindow() {}, onError() {} }),
        Cr.NS_ERROR_MALFORMED_URI,
        `make window refuses ${bad}`
      );
    }
    is(gBrowser.tabs.length, count, "No tab was made");
    is(json(service.windows()).length, windows, "No window was made");
    is(tab.linkedBrowser.currentURI.spec, PAGE, "The tab didn't navigate");
  } finally {
    BrowserTestUtils.removeTab(tab);
  }
});

add_tab_task(async function test_switch_off() {
  const id = selectedId();
  await SpecialPowers.pushPrefEnv({ set: [["whimsy.feature.applescript", false]] });
  try {
    ok(!WhimsyScripting.enabled, "Off");
    for (const [name, fn] of [
      ["windows", () => service.windows()],
      ["window", () => service.window(winId)],
      ["tabs", () => service.tabs(winId, "")],
      ["tab", () => service.tab(id)],
      ["spaces", () => service.spaces(winId)],
      ["make tab", () => service.makeTab(winId, "", PAGE)],
      ["make window", () => service.makeWindow(PAGE, { onWindow() {}, onError() {} })],
      ["close tab", () => service.closeTab(id)],
      ["close window", () => service.closeWindow(winId)],
      ["set URL", () => service.setURL(id, PAGE)],
      ["reload", () => service.reload(id)],
      ["go back", () => service.goBack(id)],
      ["go forward", () => service.goForward(id)],
      ["select tab", () => service.selectTab(id)],
      ["active tab index", () => service.setActiveTabIndex(winId, 1)],
      ["select space", () => service.selectSpace(winId, gZenWorkspaces.activeWorkspace)],
    ]) {
      throwsResult(fn, Cr.NS_ERROR_NOT_AVAILABLE, `Off: ${name} refused`);
    }
    ok(!window.closed, "Nothing happened");
  } finally {
    await SpecialPowers.popPrefEnv();
  }
});
