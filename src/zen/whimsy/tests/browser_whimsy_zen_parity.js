/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// Verify-only tests for Zen features Whimsy relies on but does not build:
// 1. Back on a tab with no history closes it and returns to its opener
//    (zen.tabs.close-on-back-with-no-history, gZenCommonActions).
// 2. Pinned tabs don't load at startup: restored pinned tabs stay pending
//    until selected (browser.sessionstore.restore_pinned_tabs_on_demand).
// 3. Edit a pinned tab's URL (gZenPinnedTabManager.editPinnedUrl).
// 4. Folder previews: hovering a collapsed folder lists its hidden tabs
//    (zen.folders.search.enabled, gZenFolders.openTabsPopup).
// If one of these fails after a Zen merge, upstream changed the feature.

const { SessionStore } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sessionstore/SessionStore.sys.mjs"
);

async function waitForTabGone(tab) {
  await TestUtils.waitForCondition(
    () => !tab.isConnected || tab.closing,
    "tab to close"
  );
}

add_task(async function test_back_closes_tab_with_no_history() {
  is(
    Services.prefs
      .getDefaultBranch("")
      .getBoolPref("zen.tabs.close-on-back-with-no-history"),
    true,
    "Back-closes-tab is on by default"
  );

  const opener = await BrowserTestUtils.openNewForegroundTab(
    gBrowser,
    "https://example.com/opener"
  );

  const child = BrowserTestUtils.addTab(gBrowser, "https://example.com/child", {
    ownerTab: opener,
  });
  await BrowserTestUtils.browserLoaded(child.linkedBrowser);
  gBrowser.selectedTab = child;

  is(child.owner, opener, "Child tab remembers its opener");
  ok(!gBrowser.webNavigation.canGoBack, "Child tab has no back history");
  await TestUtils.waitForCondition(
    () => !document.getElementById("Browser:Back").hasAttribute("disabled"),
    "Back to stay enabled so it can close the tab"
  );

  BrowserCommands.back();
  await waitForTabGone(child);
  is(gBrowser.selectedTab, opener, "The opener is selected again");

  // Pref off: Back does nothing on a tab without history.
  await SpecialPowers.pushPrefEnv({
    set: [["zen.tabs.close-on-back-with-no-history", false]],
  });
  const child2 = BrowserTestUtils.addTab(
    gBrowser,
    "https://example.com/child2",
    { ownerTab: opener }
  );
  await BrowserTestUtils.browserLoaded(child2.linkedBrowser);
  gBrowser.selectedTab = child2;
  ok(
    !gZenCommonActions.shouldCloseTabOnBack(),
    "No close-on-back when the pref is off"
  );
  BrowserCommands.back();
  // eslint-disable-next-line mozilla/no-arbitrary-setTimeout
  await new Promise(r => setTimeout(r, 300));
  ok(child2.isConnected && !child2.closing, "Tab stays open with pref off");
  BrowserTestUtils.removeTab(child2);
  await SpecialPowers.popPrefEnv();

  // A tab nobody opened (no owner) is never closed by Back.
  const independent = await BrowserTestUtils.openNewForegroundTab(
    gBrowser,
    "https://example.com/independent"
  );
  ok(!independent.owner, "Independent tab has no owner");
  ok(
    !gZenCommonActions.shouldCloseTabOnBack(),
    "No close-on-back for a tab without an opener"
  );

  // Pinned tabs never close on Back either.
  independent.owner = opener;
  gBrowser.pinTab(independent);
  ok(
    !gZenCommonActions.shouldCloseTabOnBack(),
    "No close-on-back for a pinned tab"
  );
  gBrowser.unpinTab(independent);

  BrowserTestUtils.removeTab(independent);
  BrowserTestUtils.removeTab(opener);
});

add_task(async function test_pinned_tabs_lazy_on_startup() {
  const defaults = Services.prefs.getDefaultBranch("");
  is(
    defaults.getBoolPref("browser.sessionstore.restore_pinned_tabs_on_demand"),
    true,
    "Zen restores pinned tabs on demand (Firefox's default is false)"
  );
  is(
    defaults.getBoolPref("browser.sessionstore.restore_on_demand"),
    true,
    "Restore on demand is on"
  );

  // Keep the restored pinned tab out of the main window.
  await SpecialPowers.pushPrefEnv({
    set: [["zen.window-sync.enabled", false]],
  });

  const triggeringPrincipal_base64 = E10SUtils.SERIALIZED_SYSTEMPRINCIPAL;
  const pinnedUrl = "https://example.com/pinned-startup";
  const state = {
    windows: [
      {
        tabs: [
          {
            entries: [{ url: pinnedUrl, triggeringPrincipal_base64 }],
            pinned: true,
          },
          {
            entries: [
              {
                url: "https://example.com/normal-startup",
                triggeringPrincipal_base64,
              },
            ],
          },
        ],
        selected: 2,
      },
    ],
  };

  const win = await BrowserTestUtils.openNewBrowserWindow();
  const restored = BrowserTestUtils.waitForEvent(win, "SSWindowRestored");
  SessionStore.setWindowState(win, JSON.stringify(state), true);
  await restored;

  const pinned = win.gBrowser.tabs.find(t => t.pinned);
  ok(pinned, "The pinned tab was restored");
  isnot(win.gBrowser.selectedTab, pinned, "The pinned tab isn't selected");
  ok(
    pinned.hasAttribute("pending"),
    "The unselected pinned tab didn't load at startup"
  );

  const loaded = BrowserTestUtils.browserLoaded(
    pinned.linkedBrowser,
    false,
    pinnedUrl
  );
  win.gBrowser.selectedTab = pinned;
  await loaded;
  ok(!pinned.hasAttribute("pending"), "Selecting the pinned tab loads it");

  await BrowserTestUtils.closeWindow(win);
  await SpecialPowers.popPrefEnv();
});

// Same mocking approach as Zen's own pinned/browser_pinned_edit_url.js:
// XPCOM service methods can't be stubbed in place, so swap the service.
function mockPrompt(value) {
  const original = Services.prompt;
  Services.prompt = {
    QueryInterface: ChromeUtils.generateQI([Ci.nsIPromptService]),
    prompt(win, title, label, result) {
      if (value === null) {
        return false;
      }
      result.value = value;
      return true;
    },
  };
  return () => {
    Services.prompt = original;
  };
}

add_task(async function test_edit_pinned_tab_url() {
  const tab = await BrowserTestUtils.openNewForegroundTab(
    gBrowser,
    "https://example.com/initial-pinned"
  );
  gBrowser.pinTab(tab);
  await gBrowser.TabStateFlusher.flush(tab.linkedBrowser);
  await TestUtils.waitForCondition(
    () => tab._zenPinnedInitialState?.entry?.url,
    "pinned state to be recorded"
  );

  const editedUrl = "https://example.com/edited-pinned";
  let restore = mockPrompt(editedUrl);
  try {
    await gZenPinnedTabManager.editPinnedUrl(tab);
    is(
      tab._zenPinnedInitialState.entry.url,
      editedUrl,
      "The pinned URL is the edited one"
    );
    await TestUtils.waitForCondition(
      () => tab.linkedBrowser.currentURI.spec === editedUrl,
      "the active pinned tab to navigate to the edited URL"
    );
  } finally {
    restore();
  }

  // Cancelling the prompt changes nothing.
  restore = mockPrompt(null);
  try {
    await gZenPinnedTabManager.editPinnedUrl(tab);
    is(
      tab._zenPinnedInitialState.entry.url,
      editedUrl,
      "Cancel leaves the pinned URL alone"
    );
  } finally {
    restore();
  }

  gBrowser.unpinTab(tab);
  BrowserTestUtils.removeTab(tab);
});

add_task(async function test_folder_preview_on_hover() {
  await SpecialPowers.pushPrefEnv({
    set: [
      ["zen.folders.search.enabled", true],
      ["zen.folders.search.hover-delay", 50],
    ],
  });
  const outside = gBrowser.selectedTab;

  const tab1 = BrowserTestUtils.addTab(gBrowser, "https://example.com/one");
  const tab2 = BrowserTestUtils.addTab(gBrowser, "https://example.com/two");
  await Promise.all([
    BrowserTestUtils.browserLoaded(tab1.linkedBrowser),
    BrowserTestUtils.browserLoaded(tab2.linkedBrowser),
  ]);
  const folder = await gZenFolders.createFolder([tab1, tab2], {
    renameFolder: false,
    label: "Parity Folder",
  });
  ok(folder, "Folder was created");

  // Keep the selection outside the folder: a collapsed folder still shows its
  // active tab, and the preview lists only the hidden ones.
  gBrowser.selectedTab = outside;
  // Zen shows no preview while the URL bar has focus (an earlier test can
  // leave a blank tab selected with the URL bar focused); focus the page.
  gBrowser.selectedBrowser.focus();
  await TestUtils.waitForCondition(() => !gURLBar.focused, "The page, not the URL bar, has focus");

  const popup = document.getElementById("zen-folder-tabs-popup");
  const label = folder.querySelector(".tab-group-label-container");

  // Expanded folder: no preview.
  label.dispatchEvent(new MouseEvent("mouseenter"));
  // eslint-disable-next-line mozilla/no-arbitrary-setTimeout
  await new Promise(r => setTimeout(r, 300));
  isnot(popup.state, "open", "No preview while the folder is expanded");

  folder.collapsed = true;
  ok(folder.collapsed, "Folder is collapsed");

  const shown = BrowserTestUtils.waitForPopupEvent(popup, "shown");
  label.dispatchEvent(new MouseEvent("mouseenter"));
  await shown;

  const items = popup.querySelectorAll(
    "#zen-folder-tabs-list .folders-tabs-list-item"
  );
  is(items.length, 2, "The preview lists both folder tabs");
  ok(
    [...items].every(i => i.dataset.label.includes("example.com")),
    "Items carry the tabs' hosts"
  );

  const hidden = BrowserTestUtils.waitForPopupEvent(popup, "hidden");
  items[0].click();
  is(gBrowser.selectedTab, tab1, "Clicking a preview item selects that tab");
  popup.hidePopup(true);
  await hidden;

  gBrowser.selectedTab = outside;
  const removed = BrowserTestUtils.waitForEvent(folder, "TabGroupRemoved");
  folder.delete();
  await removed;
  for (const tab of [tab1, tab2]) {
    if (tab.isConnected) {
      BrowserTestUtils.removeTab(tab);
    }
  }
  await SpecialPowers.popPrefEnv();
});
