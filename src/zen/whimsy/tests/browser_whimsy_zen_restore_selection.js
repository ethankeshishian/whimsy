/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// Zen's pinned restore bug, second half (overlay hotfix
// space-init-keeps-selected-tab). A window's first space change (onInit)
// picks a tab to select but never selects it, and used to strip the
// "selected" attribute from the tab that stays selected. Firefox moves the
// selection off a closing tab only when that attribute is set, so closing
// it, or restoring a session over the window (SessionStore keeps only the
// tab marked selected), left gBrowser.selectedTab on a removed tab and the
// next tab switch threw in AsyncTabSwitcher (initialBrowser is null).

const { SessionStore } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sessionstore/SessionStore.sys.mjs"
);

const triggeringPrincipal_base64 = E10SUtils.SERIALIZED_SYSTEMPRINCIPAL;

add_task(async function test_space_init_keeps_the_selected_tab_selected() {
  const other = await BrowserTestUtils.openNewForegroundTab(
    gBrowser,
    "https://example.com/whimsy-init-other"
  );
  const current = await BrowserTestUtils.openNewForegroundTab(
    gBrowser,
    "https://example.com/whimsy-init-current"
  );
  is(gBrowser.selectedTab, current, "The second tab is selected");

  const space = gZenWorkspaces.getActiveWorkspace();
  ok(space, "There is an active space");
  // Make Zen's init path pick a different tab than the selected one, as it
  // does in a new window whose first unpinned tab isn't the initial tab.
  const remembered = gZenWorkspaces.lastSelectedWorkspaceTabs[space.uuid];
  gZenWorkspaces.lastSelectedWorkspaceTabs[space.uuid] = other;
  let picked;
  try {
    picked = await gZenWorkspaces._handleTabSelection(space, true, space.uuid);
  } finally {
    if (remembered) {
      gZenWorkspaces.lastSelectedWorkspaceTabs[space.uuid] = remembered;
    } else {
      delete gZenWorkspaces.lastSelectedWorkspaceTabs[space.uuid];
    }
  }
  is(picked, other, "Zen's init path picks the remembered tab");
  is(gBrowser.selectedTab, current, "The init path doesn't change the selection");
  ok(current.selected, "The selected tab keeps its selected attribute");
  ok(!other.selected, "The picked tab isn't marked selected");

  // What the attribute is for: closing the selected tab moves the selection.
  const closed = BrowserTestUtils.waitForEvent(current, "TabClose");
  gBrowser.removeTab(current, { animate: false });
  await closed;
  isnot(gBrowser.selectedTab, current, "The selection left the closed tab");
  ok(gBrowser.selectedTab.isConnected, "The selected tab is still in the window");
  ok(gBrowser.selectedTab.linkedBrowser, "The selected tab has a browser");
  ok(gBrowser.selectedTab.selected, "The new selected tab is marked selected");

  BrowserTestUtils.removeTab(other);
});

add_task(async function test_restore_over_window_with_cloned_pinned_tab() {
  // Window sync off, as in browser_whimsy_zen_parity.js: Zen still copies
  // every other window's pinned tabs into a new window.
  await SpecialPowers.pushPrefEnv({
    set: [["zen.window-sync.enabled", false]],
  });

  const mainPinned = await BrowserTestUtils.openNewForegroundTab(
    gBrowser,
    "https://example.org/whimsy-cloned-pinned"
  );
  gBrowser.pinTab(mainPinned);
  await gBrowser.TabStateFlusher.flush(mainPinned.linkedBrowser);

  const win = await BrowserTestUtils.openNewBrowserWindow();
  await win.gZenWorkspaces.promiseInitialized;
  ok(win.gBrowser.selectedTab.selected, "The new window's selected tab is marked selected");

  const pinnedUrl = "https://example.com/whimsy-restored-pinned";
  const normalUrl = "https://example.com/whimsy-restored-normal";
  const state = {
    windows: [
      {
        tabs: [
          {
            entries: [{ url: pinnedUrl, triggeringPrincipal_base64 }],
            pinned: true,
          },
          {
            entries: [{ url: normalUrl, triggeringPrincipal_base64 }],
          },
        ],
        selected: 2,
      },
    ],
  };
  const restored = BrowserTestUtils.waitForEvent(win, "SSWindowRestored");
  SessionStore.setWindowState(win, JSON.stringify(state), true);
  await restored;

  const selected = win.gBrowser.selectedTab;
  ok(selected.isConnected, "The selection isn't left on a removed tab");
  ok(selected.linkedBrowser, "The selected tab has a browser");
  ok(selected.selected, "The selected tab is marked selected");
  is(selected._originalUrl, normalUrl, "The session's selected tab is selected");

  const pinned = win.gBrowser.tabs.find(
    t => t.pinned && t._originalUrl == pinnedUrl
  );
  ok(pinned, "The session's pinned tab was restored");
  const loaded = BrowserTestUtils.browserLoaded(
    pinned.linkedBrowser,
    false,
    pinnedUrl
  );
  win.gBrowser.selectedTab = pinned;
  await loaded;
  is(win.gBrowser.selectedTab, pinned, "Switching to the pinned tab works");

  await BrowserTestUtils.closeWindow(win);
  gBrowser.unpinTab(mainPinned);
  BrowserTestUtils.removeTab(mainPinned);
  await SpecialPowers.popPrefEnv();
});
