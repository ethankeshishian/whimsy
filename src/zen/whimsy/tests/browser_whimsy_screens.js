/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// Whimsy: a screenshot tool, so changes can be checked by eye without macOS
// Screen Recording permission. It draws the real window from inside Gecko.
//   WHIMSY_SHOTS=/some/dir npm test -- ui/browser_whimsy_screens.js
// Without WHIMSY_SHOTS it only does a quick smoke check.

// Screenshot tasks open and close windows and spaces; Zen can leave a
// blank placeholder tab behind in this window. Take any extra tabs along.
const screensStartTabs = new Set(gBrowser.tabs);
registerCleanupFunction(() => {
  for (const tab of gBrowser.tabs.filter(t => !screensStartTabs.has(t))) {
    BrowserTestUtils.removeTab(tab);
  }
});

// Forty-odd screenshot tasks in one file.
requestLongerTimeout(2);

const SHOTS = Services.env.get("WHIMSY_SHOTS");

async function shot(name, windowGlobal = window.browsingContext.currentWindowGlobal) {
  if (!SHOTS) {
    return;
  }
  // A page's snapshot defaults to the window's size; crop it to the page's
  // own viewport so no white margin shows beside or below it.
  const embedder = windowGlobal.browsingContext.embedderElement;
  const rect = embedder?.localName == "browser" ?
    new DOMRect(0, 0, embedder.clientWidth, embedder.clientHeight) : null;
  const bitmap = await windowGlobal.drawSnapshot(rect, 1, "white");
  const canvas = document.createElementNS("http://www.w3.org/1999/xhtml", "canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  canvas.getContext("2d").drawImage(bitmap, 0, 0);
  const blob = await new Promise(resolve => canvas.toBlob(resolve));
  const path = PathUtils.join(SHOTS, `${name}.png`);
  await IOUtils.write(path, new Uint8Array(await blob.arrayBuffer()));
  info(`Saved ${path}`);
}

add_task(async function window_with_tabs() {
  const tabs = [];
  for (const url of ["https://example.com/", "https://example.org/"]) {
    tabs.push(await BrowserTestUtils.openNewForegroundTab(gBrowser, url));
  }
  await shot("01-window");

  // The tab context menu: every item labelled, and wide enough to read.
  const menu = document.getElementById("tabContextMenu");
  const shown = BrowserTestUtils.waitForPopupEvent(menu, "shown");
  EventUtils.synthesizeMouseAtCenter(tabs[0], { type: "contextmenu", button: 2 });
  await shown;
  const items = [...menu.children].filter(
    el => el.localName == "menuitem" && !el.hidden && el.checkVisibility()
  );
  ok(items.length > 3, "The tab context menu has items");
  // Some labels (like Mute Tab) are set as the menu opens and arrive a moment later.
  await TestUtils.waitForCondition(
    () => items.every(item => item.getAttribute("label")),
    "Every menu item gets a label"
  ).catch(() => {});
  for (const item of items) {
    ok(item.getAttribute("label"), `Menu item ${item.id} has a label`);
  }
  Assert.greater(menu.getBoundingClientRect().width, 150, "The menu is wide enough to read");
  const hidden = BrowserTestUtils.waitForPopupEvent(menu, "hidden");
  menu.hidePopup();
  await hidden;

  for (const tab of tabs) {
    BrowserTestUtils.removeTab(tab);
  }
});

add_task(async function settings_app_icon() {
  await BrowserTestUtils.withNewTab("about:preferences#zenLooks", async browser => {
    const doc = browser.contentDocument;
    const group = await TestUtils.waitForCondition(() => doc.getElementById("whimsyAppIconGroup"));
    await TestUtils.waitForCondition(() => group.checkVisibility(), "App icon settings visible");
    group.scrollIntoView({ block: "start" });
    await new Promise(resolve => browser.contentWindow.requestAnimationFrame(resolve));
    await shot("02-settings-app-icon", browser.browsingContext.currentWindowGlobal);
  });
});

add_task(async function settings_updates() {
  const { WhimsyUpdates } = ChromeUtils.importESModule(
    "resource:///modules/whimsy/WhimsyUpdates.sys.mjs"
  );
  const dir = await IOUtils.createUniqueDirectory(PathUtils.tempDir, "whimsy-shots");
  await IOUtils.writeJSON(PathUtils.join(dir, "state.json"), {
    status: "idle",
    last_run: new Date().toISOString(),
    last_result: "up-to-date",
    installed: { id: "b", version: "1.24b-w2" },
    previous: { id: "a", version: "1.24b-w1" },
  });
  await IOUtils.writeJSON(PathUtils.join(dir, "whimsy-version.json"), {
    version: "1.24b-w2",
    zen: "1.24b",
    zen_label: "dev (2026-10-27)",
    firefox: "159.0",
    released: true,
    history: [
      {
        version: "1.24b-w2", zen: "1.24b", date: "2026-10-28",
        notes: ["GitHub live folders: My Review Requests, Team Review Requests", "Version history in Settings"],
      },
      { version: "1.24b-w1", zen: "1.24b", date: "2026-10-28", notes: ["First public release"] },
      { version: "1.23.4b-w3", zen: "1.23.4b", date: "2026-10-20", notes: [] },
    ],
  });
  await IOUtils.makeDirectory(PathUtils.join(dir, "logs"));
  await IOUtils.writeUTF8(
    PathUtils.join(dir, "logs", "update.log"),
    "[03:30] Checking Zen releases\n[03:31] Zen 1.24b is newer than 1.23.4b\n[04:12] Build passed, tests passed\n[04:13] Staged Zen 1.24b\n"
  );
  const saved = {
    dataDir: WhimsyUpdates.dataDir,
    versionFile: WhimsyUpdates.versionFile,
    isInstalled: WhimsyUpdates.isInstalled,
  };
  WhimsyUpdates.dataDir = dir;
  WhimsyUpdates.versionFile = PathUtils.join(dir, "whimsy-version.json");
  WhimsyUpdates.isInstalled = () => true;
  try {
    await BrowserTestUtils.withNewTab("about:preferences#about", async browser => {
      const doc = browser.contentDocument;
      const group = await TestUtils.waitForCondition(() => doc.getElementById("whimsyUpdatesGroup"));
      await TestUtils.waitForCondition(() => group.checkVisibility(), "Updates settings visible");
      const firefox = group.closest('setting-group[groupid="updates"]');
      const info = firefox.querySelector("update-information");
      await TestUtils.waitForCondition(() => info.distribution?.includes("Based on Zen"), "Whimsy's version line");
      await TestUtils.waitForCondition(() =>
        doc.getElementById("whimsyUpdatesRollback").getAttribute("label")?.includes("1.24b-w1")
      );
      firefox.scrollIntoView({ block: "start" });
      await new Promise(resolve => browser.contentWindow.requestAnimationFrame(resolve));
      await shot("03-settings-updates", browser.browsingContext.currentWindowGlobal);
    });
  } finally {
    Object.assign(WhimsyUpdates, saved);
    await IOUtils.remove(dir, { recursive: true });
  }
});

// Firefox's About window, with Whimsy's logo and name.
add_task(async function about_dialog() {
  const opened = BrowserTestUtils.domWindowOpenedAndLoaded(null, win => win.document.documentURI == "chrome://browser/content/aboutDialog.xhtml");
  window.openAboutDialog();
  const dialog = await opened;
  const logo = dialog.getComputedStyle(dialog.document.getElementById("leftBox")).backgroundImage;
  ok(logo.includes("about-logo"), "The About window shows the branding logo");
  // legacy: Whimsy's wording, no Mozilla donation ask (overlay.py hotfixes).
  await dialog.document.l10n.ready;
  const community = dialog.document.getElementById("communityDesc");
  await TestUtils.waitForCondition(() => community.textContent.includes("built on"), "Whimsy's About wording");
  await new Promise(resolve => dialog.requestAnimationFrame(() => dialog.setTimeout(resolve, 300)));
  await shot("03b-about-dialog", dialog.browsingContext.currentWindowGlobal);
  await BrowserTestUtils.closeWindow(dialog);
});

add_task(async function updated_notice() {
  const notification = await window.WhimsyWindow.showUpdatedNotice(
    { id: "shot", version: "1.24b-w2", zen: "1.24b", notes_url: "https://example.com/notes" },
    { force: true }
  );
  ok(notification, "The after-update notice appears in the sidebar");
  await TestUtils.waitForCondition(
    () => notification.shadowRoot?.textContent.includes("What's new"),
    "The notice is labelled"
  );
  // Let its slide-in animation finish.
  await Promise.all(notification.getAnimations({ subtree: true }).map(a => a.finished.catch(() => {})));
  await new Promise(resolve => setTimeout(resolve, 600));
  await shot("04-updated-notice");
  notification.remove();
});

add_task(async function copy_link_toast() {
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.com/");
  await SpecialPowers.pushPrefEnv({ set: [["ui.popup.disable_autohide", true]] });
  document.getElementById("cmd_zenCopyCurrentURL").doCommand();
  const container = document.getElementById("zen-toast-container");
  const toast = await TestUtils.waitForCondition(() =>
    [...container.children].find(t => t._messageId == "whimsy-copy-toast")
  );
  await TestUtils.waitForCondition(() => toast.querySelector("label").textContent, "Toast text arrives");
  await Promise.all(toast.getAnimations({ subtree: true }).map(a => a.finished.catch(() => {})));
  await new Promise(resolve => setTimeout(resolve, 400));
  ok(toast.checkVisibility(), "The copy toast shows");
  await shot("05-copy-toast");
  toast.remove();
  container.setAttribute("hidden", true);
  await SpecialPowers.popPrefEnv();
  BrowserTestUtils.removeTab(tab);
});

add_task(async function settings_strip_tracking() {
  await BrowserTestUtils.withNewTab("about:preferences#privacy", async browser => {
    const doc = browser.contentDocument;
    const group = await TestUtils.waitForCondition(() => doc.getElementById("whimsyStripTrackingGroup"));
    await TestUtils.waitForCondition(() => group.checkVisibility(), "Tracking in links visible");
    group.scrollIntoView({ block: "center" });
    await new Promise(resolve => browser.contentWindow.requestAnimationFrame(resolve));
    await shot("06-settings-strip-tracking", browser.browsingContext.currentWindowGlobal);
  });
});

add_task(async function settings_cookie_banners() {
  await BrowserTestUtils.withNewTab("about:preferences#privacy", async browser => {
    const doc = browser.contentDocument;
    const group = await TestUtils.waitForCondition(() => doc.getElementById("whimsyCookieBannersGroup"));
    await TestUtils.waitForCondition(() => group.checkVisibility(), "Cookie banners visible");
    group.scrollIntoView({ block: "center" });
    await new Promise(resolve => browser.contentWindow.requestAnimationFrame(resolve));
    await shot("07-settings-cookie-banners", browser.browsingContext.currentWindowGlobal);
  });
});

add_task(async function private_window() {
  const win = await BrowserTestUtils.openNewBrowserWindow({ private: true });
  await win.gZenWorkspaces?.promiseInitialized;
  BrowserTestUtils.startLoadingURIString(win.gBrowser.selectedBrowser, "https://example.com/");
  await BrowserTestUtils.browserLoaded(win.gBrowser.selectedBrowser);
  await BrowserTestUtils.openNewForegroundTab(win.gBrowser, "https://example.org/");
  await new Promise(resolve => win.requestAnimationFrame(resolve));
  await shot("08-private-window", win.browsingContext.currentWindowGlobal);
  await BrowserTestUtils.closeWindow(win);
});

add_task(async function settings_tabs() {
  await BrowserTestUtils.withNewTab("about:preferences#zenTabManagement", async browser => {
    const doc = browser.contentDocument;
    const group = await TestUtils.waitForCondition(() => doc.getElementById("whimsyTabsGroup"));
    await TestUtils.waitForCondition(() => group.checkVisibility(), "Tabs group visible");
    group.scrollIntoView({ block: "center" });
    await new Promise(resolve => browser.contentWindow.requestAnimationFrame(resolve));
    await shot("09-settings-tabs", browser.browsingContext.currentWindowGlobal);
  });
});

add_task(async function dim_sleeping_tabs() {
  await SpecialPowers.pushPrefEnv({ set: [["whimsy.tabs.dim-sleeping", true]] });
  const awake = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.com/");
  const asleep = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.org/");
  gBrowser.selectedTab = awake;
  await gBrowser.explicitUnloadTabs([asleep]);
  await TestUtils.waitForCondition(() => asleep.hasAttribute("pending"), "Tab asleep");
  // Let the fade finish.
  // eslint-disable-next-line mozilla/no-arbitrary-setTimeout
  await new Promise(resolve => setTimeout(resolve, 400));
  await shot("10-dim-sleeping-tabs");
  BrowserTestUtils.removeTab(asleep);
  BrowserTestUtils.removeTab(awake);
  await SpecialPowers.popPrefEnv();
});

add_task(async function tab_title_lines() {
  await SpecialPowers.pushPrefEnv({ set: [["whimsy.tabs.title-lines", 2]] });
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.com/");
  const long = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.org/");
  long.setAttribute("label", "A very long page title that needs more than one line to read in full");
  gBrowser._setTabLabel?.(long, "A very long page title that needs more than one line to read in full");
  await new Promise(resolve => requestAnimationFrame(resolve));
  await shot("11-tab-title-lines");
  BrowserTestUtils.removeTab(long);
  BrowserTestUtils.removeTab(tab);
  await SpecialPowers.popPrefEnv();
});

add_task(async function newtab_button_bottom() {
  await SpecialPowers.pushPrefEnv({ set: [["whimsy.tabs.newtab-button-bottom", true]] });
  const tabs = [];
  for (const url of ["https://example.com/", "https://example.org/"]) {
    tabs.push(await BrowserTestUtils.openNewForegroundTab(gBrowser, url));
  }
  await new Promise(resolve => requestAnimationFrame(resolve));
  await shot("12-newtab-bottom");
  for (const tab of tabs) {
    BrowserTestUtils.removeTab(tab);
  }
  await SpecialPowers.popPrefEnv();
  Services.prefs.clearUserPref("zen.view.show-newtab-button-top");
});

add_task(async function folder_colors() {
  const folders = [];
  const colors = {};
  for (const [label, color] of [["Work", "blue"], ["Reading", "orange"], ["Fun", "pink"], ["Plain", null]]) {
    const tab = BrowserTestUtils.addTab(gBrowser, "about:blank");
    const folder = await gZenFolders.createFolder([tab], { renameFolder: false, label });
    folders.push(folder);
    if (color) {
      colors[folder.id] = color;
    }
  }
  Services.prefs.setStringPref("whimsy.folders.colors", JSON.stringify(colors));
  // wave7/ux: wait for the newest folder to finish expanding; a shot taken
  // mid-animation drew the pinned/normal line through its child.
  await settled();
  await shot("13-folder-colors");
  for (const folder of folders) {
    const removed = BrowserTestUtils.waitForEvent(folder, "TabGroupRemoved");
    folder.delete();
    await removed;
  }
  Services.prefs.clearUserPref("whimsy.folders.colors");
});

add_task(async function loading_line() {
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.com/");
  const url = "http://mochi.test:8888/browser/zen/whimsy/tests/whimsy_slow_load.sjs?delay=3000";
  const loaded = BrowserTestUtils.browserLoaded(tab.linkedBrowser, false, url);
  BrowserTestUtils.startLoadingURIString(tab.linkedBrowser, url);
  await TestUtils.waitForCondition(() => document.getElementById("zen-loading-progress-bar"), "Loading");
  await new Promise(resolve => setTimeout(resolve, 1200)); // eslint-disable-line mozilla/no-arbitrary-setTimeout
  await shot("14-loading-line");
  await loaded;
  BrowserTestUtils.removeTab(tab);
});

add_task(async function tab_badges() {
  const setTitle = (tab, title) =>
    SpecialPowers.spawn(tab.linkedBrowser, [title], t => {
      content.document.title = t;
    });
  const tabs = [];
  for (const [url, essential] of [["https://example.com/?e1", true], ["https://example.org/?e2", true], ["https://example.com/?p1", false], ["https://example.org/?p2", false]]) {
    const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, url);
    if (essential) {
      gZenPinnedTabManager.addToEssentials(tab);
    } else {
      gBrowser.pinTab(tab);
    }
    tabs.push(tab);
  }
  const current = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.net/");
  await setTitle(tabs[0], "(3) Chat");
  await setTitle(tabs[2], "Inbox (128) - Mail");
  await setTitle(tabs[1], "Something changed");
  await setTitle(tabs[3], "Also changed");
  await TestUtils.waitForCondition(() => tabs[3].hasAttribute("titlechanged"), "Dots");
  await new Promise(resolve => setTimeout(resolve, 300)); // eslint-disable-line mozilla/no-arbitrary-setTimeout
  await shot("15-tab-badges");
  for (const tab of tabs) {
    if (tab.hasAttribute("zen-essential")) {
      gZenPinnedTabManager.removeEssentials(tab);
    }
    BrowserTestUtils.removeTab(tab);
  }
  BrowserTestUtils.removeTab(current);
});

add_task(async function group_by_domain() {
  const { WhimsyTabs } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyTabs.sys.mjs");
  const tabs = [];
  for (const url of ["https://example.com/a", "https://example.org/", "https://example.com/b", "https://example.com/c"]) {
    tabs.push(await BrowserTestUtils.openNewForegroundTab(gBrowser, url));
  }
  const folder = WhimsyTabs.groupByDomain(window, tabs[0]);
  await new Promise(resolve => setTimeout(resolve, 500)); // eslint-disable-line mozilla/no-arbitrary-setTimeout
  await shot("16-group-by-domain");
  const removed = BrowserTestUtils.waitForEvent(folder, "TabGroupRemoved");
  folder.delete();
  await removed;
  for (const tab of tabs.filter(t => !t.closing && t.isConnected)) {
    BrowserTestUtils.removeTab(tab);
  }
});

add_task(async function space_drop_target() {
  const space = await gZenWorkspaces.createAndSaveWorkspace("Work", "💼", true);
  const button = await TestUtils.waitForCondition(() =>
    document.querySelector(`#zen-workspaces-button toolbarbutton[zen-workspace-id="${space.uuid}"]`)
  );
  button.setAttribute("whimsy-drop-target", "");
  await new Promise(resolve => setTimeout(resolve, 300)); // eslint-disable-line mozilla/no-arbitrary-setTimeout
  await shot("17-space-drop-target");
  button.removeAttribute("whimsy-drop-target");
  await gZenWorkspaces.removeWorkspace(space.uuid);
});

add_task(async function settings_look() {
  await BrowserTestUtils.withNewTab("about:preferences#zenLooks", async browser => {
    const doc = browser.contentDocument;
    const group = await TestUtils.waitForCondition(() => doc.getElementById("whimsyLookGroup"));
    await TestUtils.waitForCondition(() => group.checkVisibility(), "Look group visible");
    group.scrollIntoView({ block: "center" });
    await new Promise(resolve => browser.contentWindow.requestAnimationFrame(resolve));
    await shot("18-settings-look", browser.browsingContext.currentWindowGlobal);
  });
});

add_task(async function tab_volume_panel() {
  await SimpleTest.promiseFocus(window); // Panels open only in a focused window.
  const { WhimsyMedia } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyMedia.sys.mjs");
  const panel = WhimsyMedia.openVolumePanel(window, gBrowser.selectedTab);
  try {
    await TestUtils.waitForCondition(() => panel.state == "open");
    await document.l10n.translateFragment(panel);
    await shot("19-tab-volume");
  } finally {
    const hidden = BrowserTestUtils.waitForPopupEvent(panel, "hidden");
    panel.hidePopup();
    await hidden;
  }
});

// wave1/fun: both about:neterror layouts and a real certificate warning.
add_task(async function whimsy_network_errors() {
  for (const felt of [false, true]) {
    await SpecialPowers.pushPrefEnv({ set: [
      ["security.certerrors.felt-privacy-v1", felt],
      ["whimsy.feature.net-error-branding", true],
      ["browser.netError.searchCTA.enabled", false],
    ] });
    try {
      for (const error of ["dnsNotFound", "netOffline", "certificate"]) {
        const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, "about:blank");
        const browser = tab.linkedBrowser;
        try {
          const loaded = BrowserTestUtils.waitForErrorPage(browser);
          if (error === "certificate") {
            BrowserTestUtils.startLoadingURIString(browser, "https://expired.example.com/");
          } else {
            await SpecialPowers.spawn(browser, [error], error => {
              content.location = `about:neterror?e=${error}&u=https%3A%2F%2Fexample.com%2F&d=Connection%20failed`;
            });
          }
          await loaded;
          await SpecialPowers.spawn(browser, [], async () => {
            const doc = content.document;
            const root = doc.querySelector("net-error-card")?.shadowRoot || doc;
            await ContentTaskUtils.waitForCondition(
              () => root.querySelector("#whimsy-neterror-brand"), "Whimsy error branding is ready"
            );
            await doc.l10n.translateRoots();
            await ContentTaskUtils.waitForCondition(
              () => root.querySelector("#whimsy-neterror-style")?.sheet, "Whimsy error stylesheet loaded"
            );
            await content.document.fonts.ready;
            await new Promise(resolve => content.requestAnimationFrame(() => content.requestAnimationFrame(resolve)));
          });
          await shot(`20-neterror-${felt ? "felt" : "legacy"}-${error}`, browser.browsingContext.currentWindowGlobal);
        } finally {
          BrowserTestUtils.removeTab(tab);
        }
      }
    } finally {
      await SpecialPowers.popPrefEnv();
    }
  }
});

// wave2/wave4: Mini Whimsy in Arc's Little Arc layout (one slim bar on the
// space's colours over the page card), in light and dark, plus its blank
// state with the command bar open.
add_task(async function mini_whimsy_destination() {
  const { WhimsyQuickWindow } = ChromeUtils.importESModule(
    "resource:///modules/whimsy/WhimsyQuickWindow.sys.mjs"
  );
  for (const dark of [0, 1]) {
    await SpecialPowers.pushPrefEnv({ set: [["ui.systemUsesDarkTheme", dark]] });
    const scheme = dark ? "dark" : "light";
    let win = WhimsyQuickWindow.open("https://example.com/", { opener: window });
    try {
      await WhimsyQuickWindow.whenReady(win);
      const button = () => win.document.getElementById("whimsy-quick-window-move-to-space");
      await TestUtils.waitForCondition(() => button()?.getAttribute("label"));
      await TestUtils.waitForCondition(() =>
        win.document.l10n.getAttributes(button()).args?.space == gZenWorkspaces.getActiveWorkspace().name
      );
      const host = win.document.querySelector("#whimsy-quick-window-address .whimsy-mini-host");
      await TestUtils.waitForCondition(() => host.textContent == "example.com", "Mini shows the host");
      ok(win.document.getElementById("whimsy-quick-window-bar").checkVisibility(), `Mini's bar shows (${scheme})`);
      await new Promise(resolve => win.requestAnimationFrame(resolve));
      await shot(`mini-whimsy-${scheme}`, win.browsingContext.currentWindowGlobal);

      // fix7: the space dropdown from the caret (also Cmd+Shift+O).
      const picker = () => win.document.getElementById("whimsy-quick-window-space-picker");
      win.document.getElementById("whimsy-quick-window-choose-space").doCommand();
      await TestUtils.waitForCondition(() => picker()?.state == "open", `Space dropdown opens (${scheme})`);
      ok([...picker().querySelectorAll(".whimsy-mini-picker-space")].every(row => row.checkVisibility()),
        `Every space row is visible (${scheme})`);
      await new Promise(resolve => win.requestAnimationFrame(resolve));
      await shot(`mini-whimsy-space-dropdown-${scheme}`, win.browsingContext.currentWindowGlobal);
      const hidden = BrowserTestUtils.waitForEvent(picker(), "popuphidden");
      picker().hidePopup();
      await hidden;
    } finally {
      await BrowserTestUtils.closeWindow(win);
    }

    win = WhimsyQuickWindow.open(null, { opener: window });
    try {
      await WhimsyQuickWindow.whenReady(win);
      await SimpleTest.promiseFocus(win);
      await TestUtils.waitForCondition(() => win.gURLBar.focused, "Blank Mini opens into the command bar");
      EventUtils.sendString("example", win);
      await TestUtils.waitForCondition(() => win.gURLBar.view.isOpen, "Mini command bar opens");
      const bounds = win.gURLBar.panel.getBoundingClientRect();
      ok(win.gURLBar.panel.checkVisibility() && bounds.width > 0 && bounds.height > 0,
        "Command bar is visible with nonzero bounds");
      await new Promise(resolve => win.requestAnimationFrame(resolve));
      await shot(`mini-whimsy-command-bar-${scheme}`, win.browsingContext.currentWindowGlobal);
    } finally {
      await BrowserTestUtils.closeWindow(win);
    }
    await SpecialPowers.popPrefEnv();
  }
});

// batch hist: the existing History tab with visit-time space labels.
add_task(async function library_space_history() {
  await SpecialPowers.pushPrefEnv({ set: [
    ["whimsy.feature.space-history", true],
    ["zen.library.history.closed-tabs", false],
  ] });
  const library = document.querySelector("zen-library");
  const previous = library.activeTab;
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser,
    "https://example.com/?whimsy-history-screenshot");
  try {
    library.activeTab = "history";
    await library.constructor.animateProgress(1);
    await TestUtils.waitForCondition(() => library.querySelector("whimsy-space-history-section"));
    const section = library.querySelector("whimsy-space-history-section");
    await TestUtils.waitForCondition(async () => {
      await section.refresh();
      return section._flatVisits?.some(visit => visit.url.includes("whimsy-history-screenshot") && visit.spaceId);
    }, "The screenshot includes a recorded space label");
    await section.updateComplete;
    await document.l10n.translateFragment(section);
    section.filtersOpen = true;
    await section.updateComplete;
    await document.l10n.translateFragment(section);
    ok(section.querySelector('[data-l10n-id="whimsy-history-space-filter"]'),
      "History offers spaces beside date and sort filters");
    await shot("history-spaces");
  } finally {
    await library.constructor.animateProgress(0);
    library.activeTab = previous;
    BrowserTestUtils.removeTab(tab);
    await SpecialPowers.popPrefEnv();
  }
});

// home: every tab, light and dark, ready for the integration build's
// screenshot review (legacy: 22-privacy is the About dialog's Privacy Notice).
// Reduced motion keeps the hero's floating balloon still for the shot.
add_task(async function whimsy_home_and_changelog() {
  for (const dark of [0, 1]) {
    await SpecialPowers.pushPrefEnv({ set: [
      ["whimsy.feature.home", true],
      ["ui.systemUsesDarkTheme", dark],
      ["ui.prefersReducedMotion", 1],
    ] });
    try {
      for (const [suffix, name] of [["", "20-home"], ["?tab=changelog", "21-changelog"], ["?tab=privacy", "22-privacy"]]) {
        await BrowserTestUtils.withNewTab(`about:whimsy${suffix}`, async browser => {
          const doc = browser.contentDocument;
          await doc.l10n.ready;
          if (suffix == "?tab=changelog") {
            await TestUtils.waitForCondition(() => doc.getElementById("whimsy-changelog-list").children.length);
            await doc.l10n.translateRoots();
          }
          await new Promise(r => browser.contentWindow.requestAnimationFrame(() => browser.contentWindow.requestAnimationFrame(r)));
          await shot(`${name}-${dark ? "dark" : "light"}`, browser.browsingContext.currentWindowGlobal);
        });
      }
    } finally {
      await SpecialPowers.popPrefEnv();
    }
  }
});

// vpnspace: capture the native panel with its scope extension.
add_task(async function vpn_scope_panel() {
  if (!SHOTS || !Services.prefs.getBoolPref("whimsy.feature.vpnspace", true)) {
    return;
  }
  const button = await TestUtils.waitForCondition(() => document.getElementById("ipprotection-button"));
  button.click();
  const scope = await TestUtils.waitForCondition(() => document.getElementById("whimsy-vpn-scope"));
  const panel = scope.closest("panel");
  try {
    await TestUtils.waitForCondition(() => panel?.state === "open");
    await document.l10n.translateFragment(scope);
    await shot("vpn-space-scope");
  } finally {
    panel?.hidePopup();
  }
});

// batch3glance: a Compact and a Wide Glance (Standard is Zen's own).
add_task(async function glance_sizes() {
  const { openGlanceOnTab } = ChromeUtils.importESModule("resource://testing-common/GlanceTestUtils.sys.mjs");
  await SpecialPowers.pushPrefEnv({ set: [["whimsy.feature.glance-size", true]] });
  const parent = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.org/");
  try {
    for (const size of ["compact", "wide"]) {
      Services.prefs.setStringPref("whimsy.glance.size", size);
      await openGlanceOnTab(window, async glanceTab => {
        const wrapper = glanceTab.linkedBrowser.closest(".browserContainer");
        await TestUtils.waitForCondition(() => wrapper.getAttribute("has-finished-animation") == "true");
        ok(wrapper.getBoundingClientRect().width > 0, `${size} Glance is drawn`);
        await shot(`30-glance-${size}`);
      });
    }
  } finally {
    Services.prefs.clearUserPref("whimsy.glance.size");
    BrowserTestUtils.removeTab(parent);
    await SpecialPowers.popPrefEnv();
  }
});

// wave3/tree: Tree/Islands disclosure buttons and a folded branch.
add_task(async function tree_disclosure() {
  const { WhimsyTreeTabs } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyTreeTabs.sys.mjs");
  await SpecialPowers.pushPrefEnv({ set: [["whimsy.feature.tree-tabs", true]] });
  const root = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.com/?tree-root");
  const child = BrowserTestUtils.addTab(gBrowser, "https://example.com/?tree-child", { openerBrowser: root.linkedBrowser });
  await BrowserTestUtils.browserLoaded(child.linkedBrowser);
  try {
    WhimsyTreeTabs.render(window);
    await document.l10n.translateFragment(root);
    await shot("24-tree-expanded");
    WhimsyTreeTabs.toggleBranch(window, root);
    await shot("24-tree-collapsed");
    await SpecialPowers.pushPrefEnv({ set: [["whimsy.tabs.tree-style", "islands"]] });
    WhimsyTreeTabs.toggleBranch(window, root);
    await shot("24-islands-expanded");
    await SpecialPowers.popPrefEnv();
  } finally {
    await BrowserTestUtils.removeTab(child);
    await BrowserTestUtils.removeTab(root);
    await SpecialPowers.popPrefEnv();
  }
});

// batch3glance: a three-pane split built Arc's way (Add Bottom Split), then
// turned with Change Orientation.
add_task(async function split_layouts() {
  const { WhimsySplitLayouts } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsySplitLayouts.sys.mjs");
  await SpecialPowers.pushPrefEnv({ set: [["whimsy.feature.split-layouts", true]] });
  const tabs = [];
  try {
    for (let i = 0; i < 3; i++) {
      tabs.push(await BrowserTestUtils.openNewForegroundTab(gBrowser, `data:text/html,<h1>Pane ${i + 1}</h1>`));
    }
    gZenViewSplitter.splitTabs(tabs.slice(0, 2), "vsep", 0);
    await TestUtils.waitForCondition(() => tabs[0].splitView);
    WhimsySplitLayouts.insertBeside(window, tabs[0], tabs[2], "bottom");
    ok(tabs[2].splitView, "Three panes");
    await new Promise(resolve => setTimeout(resolve, 400));
    await shot("31-split-add-bottom");
    WhimsySplitLayouts.changeOrientation(window);
    await new Promise(resolve => setTimeout(resolve, 400));
    await shot("32-split-change-orientation");
  } finally {
    if (gZenViewSplitter.currentView >= 0) {
      gZenViewSplitter.unsplitCurrentView();
    }
    for (const tab of tabs) {
      BrowserTestUtils.removeTab(tab);
    }
    await SpecialPowers.popPrefEnv();
  }
});

// wave3/cmdbar: recent tabs when the command bar opens empty.
add_task(async function command_bar_recent_tabs() {
  const { UrlbarTestUtils } = ChromeUtils.importESModule("resource://testing-common/UrlbarTestUtils.sys.mjs");
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.com/?recent-screenshot");
  const anchor = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.org/");
  try {
    gURLBar.value = "";
    await UrlbarTestUtils.promiseAutocompleteResultPopup({ window, waitForFocus, value: "" });
    await TestUtils.waitForCondition(
      () => UrlbarTestUtils.getResultCount(window) && UrlbarTestUtils.getRowAt(window, 0).result.providerName == "WhimsyRecentTabs"
    );
    await document.l10n.translateFragment(gURLBar.view.panel);
    await shot("command-recent-tabs");
  } finally {
    await UrlbarTestUtils.promisePopupClose(window);
    BrowserTestUtils.removeTab(tab);
    BrowserTestUtils.removeTab(anchor);
  }
});

// wave3/cmdbar: a bang in the command bar, and Settings → Search → Bang Shortcuts.
add_task(async function offline_bangs() {
  const { UrlbarTestUtils } = ChromeUtils.importESModule("resource://testing-common/UrlbarTestUtils.sys.mjs");
  try {
    await UrlbarTestUtils.promiseAutocompleteResultPopup({ window, waitForFocus, value: "!w black holes" });
    await TestUtils.waitForCondition(
      () => UrlbarTestUtils.getResultCount(window) && UrlbarTestUtils.getRowAt(window, 0).result.providerName == "WhimsyBangs"
    );
    await shot("command-bang");
  } finally {
    await UrlbarTestUtils.promisePopupClose(window);
  }
  await BrowserTestUtils.withNewTab("about:preferences#search", async browser => {
    const doc = browser.contentDocument;
    await TestUtils.waitForCondition(() => doc.getElementById("whimsyBangsList"));
    await doc.l10n.ready;
    doc.getElementById("whimsyBangsGroup").scrollIntoView();
    await shot("settings-bangs", browser.browsingContext.currentWindowGlobal);
  });
});
// wave3/tree: the full, grouped shortcut list and a search.
add_task(async function full_shortcut_catalogue() {
  const { WhimsyCheatSheet } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyCheatSheet.sys.mjs");
  await SpecialPowers.pushPrefEnv({ set: [["whimsy.feature.cheatsheet", true]] });
  const shown = BrowserTestUtils.waitForEvent(document, "popupshown", true,
    event => event.target.id == "whimsy-cheatsheet-panel");
  WhimsyCheatSheet.open(window);
  await shown;
  const panel = document.getElementById("whimsy-cheatsheet-panel");
  try {
    await TestUtils.waitForCondition(() => panel.querySelectorAll(".whimsy-cheatsheet-group").length > 2);
    await shot("25-shortcuts-full");
    const search = panel.querySelector("input");
    search.value = "tab";
    search.dispatchEvent(new Event("input"));
    await shot("25-shortcuts-search");
  } finally {
    const hidden = BrowserTestUtils.waitForPopupEvent(panel, "hidden");
    panel.hidePopup();
    await hidden;
    await SpecialPowers.popPrefEnv();
  }
});

// batch hover: the History hover card's text fallback (no saved thumbnail).
add_task(async function hover_card_history() {
  await SimpleTest.promiseFocus(window); // Panels open only in a focused window.
  const { WhimsyHoverCard } = ChromeUtils.importESModule(
    "resource:///modules/whimsy/WhimsyHoverCard.sys.mjs"
  );
  const card = WhimsyHoverCard.forWindow(window);
  card.show(gBrowser.selectedTab, {
    title: "A page you visited last week",
    url: "https://example.com/history",
    emptyImageL10nId: "whimsy-hover-no-preview",
  });
  try {
    await TestUtils.waitForCondition(() => card.panel.state == "open");
    await document.l10n.translateFragment(card.panel);
    await shot("hover-card-history");
  } finally {
    card.hide();
  }
});

// fixB: every rebuilt panel ("sheet"), in light and dark, plus Zen's
// Delete Space confirm (now in-window) and the Archive in the Library.
// wave5/uxfix: dark shots must really be dark. The system pref alone flips
// prefers-color-scheme, but Zen paints the window from its space theme in
// JS, so repaint it and wait for the change to land before drawing.
async function setScheme(dark) {
  await SpecialPowers.pushPrefEnv({ set: [
    ["ui.systemUsesDarkTheme", dark],
    ["browser.theme.toolbar-theme", dark ? 0 : 1],
    ["browser.theme.content-theme", dark ? 0 : 1],
  ] });
  const want = dark ? "dark" : "light";
  await TestUtils.waitForCondition(() =>
    window.matchMedia(`(prefers-color-scheme: ${want})`).matches, `The window is ${want}`);
  window.gZenThemePicker?.onWorkspaceChange?.(window.gZenWorkspaces?.getActiveWorkspace?.());
  await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
}

// Waits until every finite animation in the window has finished, so a
// sheet or dialog isn't caught mid-fade.
async function settled(doc = document) {
  await TestUtils.waitForCondition(() =>
    doc.getAnimations().every(a =>
      a.playState != "running" || a.effect?.getComputedTiming().iterations == Infinity),
  "Animations have settled").catch(() => info("Some animation kept running"));
}

async function sheetShot(name, panelId, open, ready = null) {
  for (const dark of [0, 1]) {
    await setScheme(dark);
    const shown = BrowserTestUtils.waitForEvent(document, "popupshown", true, e => e.target.id == panelId);
    await open();
    await shown;
    const panel = document.getElementById(panelId);
    try {
      if (ready) {
        await TestUtils.waitForCondition(() => ready(panel), `${name} is ready`);
      }
      await document.l10n.translateFragment(panel);
      await settled();
      await shot(`fixB-${name}-${dark ? "dark" : "light"}`);
    } finally {
      const hidden = BrowserTestUtils.waitForEvent(panel, "popuphidden");
      panel.hidePopup();
      await hidden;
      await SpecialPowers.popPrefEnv();
    }
  }
}

add_task(async function fixB_sheets() {
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.com/?whimsy-sheets");
  await SpecialPowers.spawn(tab.linkedBrowser, [], () => {
    content.document.cookie = "session_id=3f9a1c2e8b7d4e6f";
    content.document.cookie = "theme=dark";
  });
  const { WhimsySnooze } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsySnooze.sys.mjs");
  const { WhimsyFireButton } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyFireButton.sys.mjs");
  const { WhimsyHeavyTabs } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyHeavyTabs.sys.mjs");
  const { WhimsySplitFavorites } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsySplitFavorites.sys.mjs");
  const { WhimsyCookieEditor } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyCookieEditor.sys.mjs");
  const { WhimsyUserAgent } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyUserAgent.sys.mjs");
  const { WhimsyCheatSheet } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyCheatSheet.sys.mjs");
  const favorites = await WhimsySplitFavorites._load();
  const savedFavorites = favorites.splice(0);
  favorites.push({ id: "shot", name: "Mail + Calendar", urls: ["https://example.com/", "https://example.org/"], gridType: "vsep" });
  try {
    await sheetShot("snooze", "whimsySnoozePanel", () => WhimsySnooze.openPanel(window, tab));
    await sheetShot("fire", "whimsyFirePanel", () => WhimsyFireButton.openPanel(window));
    await sheetShot("heavy-tabs", "whimsyHeavyTabsPanel", async () => {
      WhimsyHeavyTabs.openPanel(window);
    }, panel => panel.querySelector(".whimsy-heavy-tabs-group"));
    await sheetShot("split-favorites", "whimsySplitFavoritesPanel", () => WhimsySplitFavorites.openFavoritesPanel(window));
    await sheetShot("cookies", "whimsy-cookie-editor-panel", () => WhimsyCookieEditor.open(window));
    await sheetShot("pretend-to-be", "whimsy-useragent-panel", () => WhimsyUserAgent.openPicker(window));
    await sheetShot("cheat-sheet", "whimsy-cheatsheet-panel", () => WhimsyCheatSheet.open(window));
  } finally {
    favorites.splice(0, favorites.length, ...savedFavorites);
    await SpecialPowers.spawn(tab.linkedBrowser, [], () => {
      for (const name of ["session_id", "theme"]) {
        content.document.cookie = `${name}=; expires=Thu, 01 Jan 1970 00:00:00 GMT`;
      }
    });
    BrowserTestUtils.removeTab(tab);
  }
});

add_task(async function fixB_delete_space_confirm() {
  const space = await gZenWorkspaces.createAndSaveWorkspace("Old Projects", undefined, true);
  const original = gZenWorkspaces.getActiveWorkspace();
  await gZenWorkspaces.changeWorkspace(space);
  try {
    const dialog = BrowserTestUtils.promiseAlertDialogOpen(null);
    const deleting = gZenWorkspaces.contextDeleteWorkspace();
    const win = await dialog;
    await settled();
    await shot("fixB-delete-space-confirm");
    win.document.querySelector("dialog").getButton("cancel").click();
    await deleting;
  } finally {
    await gZenWorkspaces.removeWorkspace(space.uuid);
    if (original && gZenWorkspaces.getWorkspaceFromId(original.uuid)) {
      await gZenWorkspaces.changeWorkspace(original);
    }
  }
});

// System pass: History's Closed (the Archive) and Snoozed filters, light
// and dark.
add_task(async function system_history_filters() {
  const { WhimsyArchive } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyArchive.sys.mjs");
  const { WhimsySnooze } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsySnooze.sys.mjs");
  const { WhimsyLibrarySection } = ChromeUtils.importESModule(
    "resource:///modules/whimsy/WhimsyLibrarySection.sys.mjs"
  );
  const library = document.querySelector("zen-library");
  const previous = library.activeTab;
  const keep = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.org/?whimsy-archive-keep");
  const idle = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.com/?whimsy-archive-idle");
  const closed = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.net/?whimsy-archive-closed");
  const snoozed = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.com/?whimsy-snoozed");
  WhimsyArchive.archiveTabs(window, [idle], { reason: "idle", groupId: "idle-shot" });
  BrowserTestUtils.removeTab(closed);
  await WhimsySnooze.snooze(window, snoozed, Date.now() + 20 * 3600 * 1000);
  try {
    for (const view of ["closed", "snoozed"]) {
      for (const dark of [0, 1]) {
        await SpecialPowers.pushPrefEnv({ set: [["ui.systemUsesDarkTheme", dark]] });
        try {
          ok(WhimsyLibrarySection.openHistory(window, view), `History opens on ${view}`);
          const section = await TestUtils.waitForCondition(() => library.querySelector("whimsy-space-history-section"));
          await TestUtils.waitForCondition(() => section.whimsyView == view);
          await section.refresh();
          await section.updateComplete;
          await document.l10n.translateFragment(section);
          await new Promise(r => setTimeout(r, 400)); // the Library's spring
          await shot(`system-history-${view}-${dark ? "dark" : "light"}`);
        } finally {
          await SpecialPowers.popPrefEnv();
        }
      }
    }
  } finally {
    for (const record of await WhimsySnooze.list()) {
      WhimsySnooze.cancelSnooze(null, record);
    }
    await library.constructor.animateProgress(0);
    library.activeTab = previous;
    Services.prefs.clearUserPref("whimsy.library.history.view");
    BrowserTestUtils.removeTab(keep);
  }
});

// System pass: Settings → Links, one pane for where links open, light and
// dark.
add_task(async function system_links_settings() {
  for (const dark of [0, 1]) {
    await SpecialPowers.pushPrefEnv({ set: [["ui.systemUsesDarkTheme", dark]] });
    try {
      await BrowserTestUtils.withNewTab("about:preferences#whimsyLinks", async browser => {
        const doc = browser.contentDocument;
        const heading = await TestUtils.waitForCondition(() => doc.getElementById("whimsyLinksCategory"));
        await TestUtils.waitForCondition(() => heading.checkVisibility(), "Links is showing");
        await doc.l10n.translateFragment(doc.getElementById("mainPrefPane"));
        heading.scrollIntoView({ block: "start" });
        await new Promise(resolve => browser.contentWindow.requestAnimationFrame(resolve));
        await shot(`system-links-${dark ? "dark" : "light"}`, browser.browsingContext.currentWindowGlobal);
      });
    } finally {
      await SpecialPowers.popPrefEnv();
    }
  }
});

// fixC: a private tab's page (about:privatebrowsing), Whimsy-branded.
// fix7/private: calm, with no search box and no command bar over it.
add_task(async function private_tab_page() {
  const { WhimsyPrivate } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyPrivate.sys.mjs");
  const tab = WhimsyPrivate.openPrivateTab(window);
  if (!tab) {
    ok(true, "Private tabs don't open in the window here");
    return;
  }
  try {
    await TestUtils.waitForCondition(
      () => tab.linkedBrowser.browsingContext?.currentWindowGlobal?.documentURI.spec == "about:privatebrowsing" &&
        !tab.linkedBrowser.webProgress.isLoadingDocument
    );
    gURLBar.blur();
    gBrowser.selectedBrowser.focus();
    await SpecialPowers.spawn(tab.linkedBrowser, [], async () => {
      await content.document.l10n.ready;
      await new Promise(resolve => content.requestAnimationFrame(resolve));
    });
    await shot("fixC-private-page", tab.linkedBrowser.browsingContext.currentWindowGlobal);
    await shot("fixC-private-tab-window");
  } finally {
    BrowserTestUtils.removeTab(tab, { animate: false });
  }
});

// fix7/private: a private window opens on the calm page, not the command bar.
add_task(async function private_window_page() {
  const win = await BrowserTestUtils.openNewBrowserWindow({ private: true });
  try {
    await win.delayedStartupPromise;
    const browser = win.gBrowser.selectedBrowser;
    await TestUtils.waitForCondition(
      () => browser.browsingContext?.currentWindowGlobal?.documentURI.spec == "about:privatebrowsing" &&
        !browser.webProgress.isLoadingDocument
    );
    await SpecialPowers.spawn(browser, [], async () => {
      await content.document.l10n.ready;
      await new Promise(resolve => content.requestAnimationFrame(resolve));
    });
    await new Promise(resolve => win.setTimeout(resolve, 300));
    await shot("fix7-private-window", win.browsingContext.currentWindowGlobal);
    await shot("fix7-private-window-page", browser.browsingContext.currentWindowGlobal);
  } finally {
    await BrowserTestUtils.closeWindow(win);
  }
});

// fixC: a private tab split with a normal one (tab segment and pane marked).
add_task(async function private_tab_in_split() {
  const { WhimsyPrivate } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyPrivate.sys.mjs");
  const normal = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.com/");
  const url = "https://example.org/";
  const priv = WhimsyPrivate.openPrivateTab(window, { url });
  if (!priv) {
    BrowserTestUtils.removeTab(normal);
    ok(true, "Private tabs don't open in the window here");
    return;
  }
  try {
    await BrowserTestUtils.browserLoaded(priv.linkedBrowser, false, url);
    gZenViewSplitter.splitTabs([normal, priv], "vsep");
    await TestUtils.waitForCondition(
      () => gZenViewSplitter._data.find(group => group.tabs.includes(priv))?.tabs.length == 2
    );
    gBrowser.selectedTab = priv;
    gURLBar.blur();
    await TestUtils.waitForCondition(
      () => !priv.linkedBrowser.closest(".browserSidebarContainer").getAnimations().length
    );
    await shot("fixC-private-split");
  } finally {
    if (gZenViewSplitter.currentView >= 0) {
      gZenViewSplitter.unsplitCurrentView();
    }
    BrowserTestUtils.removeTab(priv, { animate: false });
    BrowserTestUtils.removeTab(normal);
  }
});

// fixC: Scratch asks before becoming a normal space, then loses its violet.
// fix7/private: the ask is the modal prompt dialog (Cancel default).
add_task(async function scratch_keep() {
  const { WhimsyPrivate } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyPrivate.sys.mjs");
  const startSpace = gZenWorkspaces.activeWorkspace;
  const scratch = await WhimsyPrivate.openScratch(window);
  if (!scratch) {
    ok(true, "Scratch isn't available here");
    return;
  }
  let keptId = null;
  try {
    await TestUtils.waitForCondition(
      () => gBrowser.selectedBrowser.browsingContext?.currentWindowGlobal?.documentURI.spec == "about:privatebrowsing"
    );
    await shot("fixC-scratch-before-keep");
    const dialog = BrowserTestUtils.promiseAlertDialogOpen(null);
    document.getElementById("cmd_whimsyKeepScratch").doCommand();
    const confirmWin = await dialog;
    await settled();
    await shot("fixC-scratch-keep-confirm");
    confirmWin.document.querySelector("dialog").getButton("accept").click();
    await TestUtils.waitForCondition(() => !WhimsyPrivate.getScratch(window));
    keptId = scratch.uuid;
    await new Promise(resolve => setTimeout(resolve, 300));
    // fix7/private: the header still says "Scratch", not "Space".
    await shot("fixC-scratch-kept");
  } finally {
    if (keptId) {
      await gZenWorkspaces.changeWorkspaceWithID(startSpace);
      await gZenWorkspaces.removeWorkspace(keptId);
    } else {
      await WhimsyPrivate.closeScratch(window);
    }
  }
});

// fixC: compact mode with transparency on, the sidebar peeking out over a
// page: it must stay readable (the page doesn't show through).
add_task(async function compact_peek_with_transparency() {
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.com/");
  const wasCompact = gZenCompactModeManager.preference;
  await SpecialPowers.pushPrefEnv({ set: [["whimsy.look.transparency", 50]] });
  const toolbox = document.getElementById("navigator-toolbox");
  try {
    gZenCompactModeManager.preference = true;
    await TestUtils.waitForCondition(() => !document.documentElement.hasAttribute("zen-compact-animating"));
    toolbox.setAttribute("zen-user-show", "true");
    await new Promise(resolve => setTimeout(resolve, 700)); // the slide-out
    await shot("fixC-compact-peek-transparency");
  } finally {
    toolbox.removeAttribute("zen-user-show");
    gZenCompactModeManager.preference = wasCompact;
    await TestUtils.waitForCondition(() => !document.documentElement.hasAttribute("zen-compact-animating"));
    await SpecialPowers.popPrefEnv();
    BrowserTestUtils.removeTab(tab);
  }
});

// fixC: Whimsy's onboarding pages, drawn in Zen's onboarding markup and
// styles (zen-welcome.css) with Zen's own option cards.
add_task(async function welcome_look_pages() {
  const { WhimsyWelcome } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyWelcome.sys.mjs");
  const win = await BrowserTestUtils.openNewBrowserWindow();
  // Let Zen finish its window setup (compact mode, then Whimsy) first:
  // closing the window mid-setup made Zen's compact mode throw.
  await TestUtils.waitForCondition(() => win.document.getElementById("whimsyKeyset"), "The window finished setting up");
  const doc = win.document;
  const html = (tag, attrs = {}, elementId = "") => {
    const el = doc.createElementNS("http://www.w3.org/1999/xhtml", tag);
    if (elementId) {
      el.id = elementId;
    }
    for (const [name, value] of Object.entries(attrs)) {
      el.setAttribute(name, value);
    }
    return el;
  };
  // ZenWelcome.mjs's createOption().
  const createOption = ({ id, group, checked, l10n, text }) => {
    const label = html("label", { class: "zen-welcome-option", for: id });
    const input = html("input", { type: "radio", id, name: group });
    input.checked = !!checked;
    const radio = html("span", { class: "zen-welcome-option-radio no-squircles" });
    const labelText = html("span", { class: "zen-welcome-option-label" });
    if (l10n) {
      doc.l10n.setAttributes(labelText, l10n);
    } else {
      labelText.textContent = text;
    }
    label.append(input, radio, labelText);
    return label;
  };
  const pages = WhimsyWelcome.extendPages(win, [{ id: "colors" }, { id: "finish" }], {
    createOption,
    kNextButton: { l10n: "zen-generic-next", primary: true },
  }).filter(page => page.id.startsWith("whimsy-"));
  const root = html("div", { style: "position: fixed; inset: 0; z-index: 10000;" }, "zen-welcome");
  try {
    for (const page of pages) {
      root.replaceChildren();
      const card = html("div", { style: "display: flex; opacity: 1;" }, "zen-welcome-pages");
      const sidebar = html("div", {}, "zen-welcome-page-sidebar");
      const text = html("div", {}, "zen-welcome-page-sidebar-content");
      const words = html("div", { class: "zen-welcome-text" });
      const title = html("h1");
      doc.l10n.setAttributes(title, page.title);
      words.append(title);
      for (const id of page.descriptions) {
        const p = html("p");
        doc.l10n.setAttributes(p, id);
        words.append(p);
      }
      text.append(words);
      const buttons = html("div", {}, "zen-welcome-page-sidebar-buttons");
      const next = html("button", { class: "zen-big-accent-button primary" });
      doc.l10n.setAttributes(next, "zen-generic-next");
      buttons.append(next);
      sidebar.append(text, buttons);
      const contentArea = html("div", {}, "zen-welcome-page-content");
      const content = html("div", { class: "zen-welcome-page", page: page.id, style: "opacity: 1;" });
      contentArea.append(content);
      card.append(sidebar, contentArea);
      root.append(card);
      doc.getElementById("browser").append(root);
      await page.render(content);
      await doc.l10n.translateFragment(root);
      await new Promise(resolve => win.requestAnimationFrame(() => win.requestAnimationFrame(resolve)));
      await shot(`fixC-welcome-${page.id}`, win.browsingContext.currentWindowGlobal);
    }
  } finally {
    root.remove();
    await BrowserTestUtils.closeWindow(win);
  }
});

// wave3/icons: Arc's space icon picker: the Icon tab (Arc's 56 glyphs, the
// current one on a plate, Zen's after the rule) and the Emoji tab in a
// skin tone.
add_task(async function space_icon_picker() {
  if (!SHOTS || !Services.prefs.getBoolPref("whimsy.feature.space-icon-picker", true)) {
    return;
  }
  const workspace = gZenWorkspaces.getWorkspaceFromId(gZenWorkspaces.activeWorkspace);
  const before = workspace.icon;
  workspace.icon = "chrome://browser/content/whimsy/space-icons/thumbs-up.svg";
  await gZenWorkspaces.saveWorkspace(workspace);
  Services.prefs.setIntPref("whimsy.spaces.emoji-skin-tone", 3);
  const panel = document.getElementById("PanelUI-zen-emojis-picker");
  try {
    await TestUtils.waitForCondition(() =>
      gZenWorkspaces.activeWorkspaceIndicator?.querySelector(".zen-current-workspace-indicator-icon")
    );
    const shown = BrowserTestUtils.waitForEvent(panel, "popupshown");
    gZenWorkspaces.changeWorkspaceIcon();
    await shown;
    await document.l10n.translateFragment(panel);
    await new Promise(resolve => setTimeout(resolve, 300)); // eslint-disable-line mozilla/no-arbitrary-setTimeout
    await shot("wave3-space-icon-picker");
    document.getElementById("PanelUI-zen-emojis-picker-change-emojis").doCommand();
    await new Promise(resolve => setTimeout(resolve, 500)); // eslint-disable-line mozilla/no-arbitrary-setTimeout
    await shot("wave3-space-icon-picker-emoji-tone");
  } finally {
    // Picking the current glyph closes the card without an unhandled
    // "closed without selection" rejection.
    const hidden = BrowserTestUtils.waitForEvent(panel, "popuphidden");
    panel.querySelector("[whimsy-current]")?.doCommand();
    if (panel.state != "closed") {
      panel.hidePopup();
    }
    await hidden;
    Services.prefs.clearUserPref("whimsy.spaces.emoji-skin-tone");
    workspace.icon = before;
    await gZenWorkspaces.saveWorkspace(workspace);
  }
});

// wave3/speed: the speed control over a hovered video, presets open.
add_task(async function video_speed_control() {
  await SpecialPowers.pushPrefEnv({ set: [["whimsy.feature.video-speed", true]] });
  const url =
    getRootDirectory(gTestPath).replace("chrome://mochitests/content", "https://example.com") + "whimsy_video_speed.html";
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, url);
  const browser = tab.linkedBrowser;
  const state = () =>
    SpecialPowers.spawn(browser, [], () => {
      const actor = content.windowGlobalChild.getExistingActor("WhimsyVideoSpeed");
      return actor ? JSON.parse(JSON.stringify(actor.testState())) : null;
    });
  try {
    await SpecialPowers.spawn(browser, [], async () => {
      const video = content.document.getElementById("video");
      await ContentTaskUtils.waitForCondition(() => video.readyState >= 2, "The video has a frame");
      await ContentTaskUtils.waitForCondition(
        () => content.windowGlobalChild.getExistingActor("WhimsyVideoSpeed")?.videos.has(video),
        "The speed control knows the video"
      );
    });
    await BrowserTestUtils.synthesizeMouseAtCenter("#shield", { type: "mousemove" }, browser);
    await TestUtils.waitForCondition(async () => (await state())?.shown, "The control shows");
    await shot("wave3-video-speed-hover", browser.browsingContext.currentWindowGlobal);
    const { toggle } = await state();
    await BrowserTestUtils.synthesizeMouseAtPoint(toggle.x, toggle.y, {}, browser);
    await TestUtils.waitForCondition(async () => (await state())?.menuOpen, "The presets open");
    await new Promise(resolve => setTimeout(resolve, 200)); // The menu's 140ms entrance.
    await shot("wave3-video-speed-presets", browser.browsingContext.currentWindowGlobal);
  } finally {
    BrowserTestUtils.removeTab(tab);
    await SpecialPowers.popPrefEnv();
  }
});


// wave3/glass: Liquid Glass on, Transparency off: the sidebar and toolbars
// at the light glass level. Gecko draws the shot itself, so the native glass
// behind the window isn't in it; this checks the chrome's side.
add_task(async function liquid_glass() {
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.com/");
  await SpecialPowers.pushPrefEnv({ set: [["whimsy.look.liquid-glass", true]] });
  try {
    await new Promise(resolve => setTimeout(resolve, 300)); // the fade
    await shot("wave3-liquid-glass");
  } finally {
    await SpecialPowers.popPrefEnv();
    BrowserTestUtils.removeTab(tab);
  }
});


// wave3/ai: the AI provider card, and Tidy Tabs' sections in Today.
add_task(async function ai_provider_and_tidy_tabs() {
  await BrowserTestUtils.withNewTab("about:preferences#privacy", async browser => {
    const doc = browser.contentDocument;
    const group = await TestUtils.waitForCondition(() => doc.getElementById("whimsyAIProvidersGroup"));
    await TestUtils.waitForCondition(() => group.checkVisibility(), "AI provider card visible");
    group.scrollIntoView({ block: "center" });
    await new Promise(resolve => browser.contentWindow.requestAnimationFrame(resolve));
    await shot("wave3-ai-provider", browser.browsingContext.currentWindowGlobal);
  });

  const { WhimsyAIProviders } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyAIProviders.sys.mjs");
  const { WhimsyAITabs } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyAITabs.sys.mjs");
  WhimsyAIProviders.setTestProvider(({ prompt }) => {
    const lines = [...prompt.matchAll(/^(\d+)\. /gm)].map(m => Number(m[1]));
    const half = Math.ceil(lines.length / 2);
    return JSON.stringify({
      sections: [
        { name: "Trip Planning", tabs: lines.slice(0, half) },
        { name: "Reading", tabs: lines.slice(half) },
      ],
    });
  });
  const tabs = [];
  try {
    for (let i = 0; i < 8; i++) {
      tabs.push(await BrowserTestUtils.openNewForegroundTab(gBrowser, `https://example.com/tidy-shot-${i}`));
    }
    await WhimsyAITabs.tidy(window);
    await TestUtils.waitForCondition(() => document.querySelector(".whimsy-tidy-header"), "Sections drawn");
    await shot("wave3-ai-tidy-tabs");
  } finally {
    WhimsyAIProviders.setTestProvider(null);
    for (const tab of tabs) {
      BrowserTestUtils.removeTab(tab);
    }
  }
});

// wave3/ai: the 5-second preview card and the Watch a page dialog.
add_task(async function ai_preview_and_watch() {
  const { WhimsyAIPage } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyAIPage.sys.mjs");
  const { WhimsyPageWatch } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyPageWatch.sys.mjs");
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.com/");
  try {
    // wave7/ux: the link card with the AI summary stacked beneath it.
    const { WhimsyLinkHover } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyLinkHover.sys.mjs");
    const { previewMode, summarize } = WhimsyAIPage;
    WhimsyAIPage.previewMode = async () => "ready";
    WhimsyAIPage.summarize = async () => ({
      title: "How espresso machines work",
      points: ["Pumps push water at 9 bars", "Boilers hold it near 93 °C", "Grind size sets the flow"],
    });
    const host = WhimsyLinkHover.forWindow(window);
    try {
      host.enter({
        source: "link", browser: gBrowser.selectedBrowser, how: "shift",
        url: "https://example.org/article", title: "How espresso machines work",
        x: window.mozInnerScreenX + 300, y: window.mozInnerScreenY + 200, width: 160, height: 18,
      });
      const panel = await TestUtils.waitForCondition(() => {
        const p = document.getElementById(WhimsyLinkHover.PANEL_ID);
        return p?.hasAttribute("whimsy-open") && p.querySelector(".whimsy-preview-points") && p;
      }, "Both cards are open");
      await document.l10n.translateFragment(panel);
      await settled();
      await shot("wave3-ai-preview-card");
    } finally {
      host.hide({ animate: false });
      WhimsyAIPage.previewMode = previewMode;
      WhimsyAIPage.summarize = summarize;
    }

    WhimsyPageWatch.openDialog(window, tab);
    const dialog = document.getElementById("whimsy-watch-panel");
    await BrowserTestUtils.waitForPopupEvent(dialog, "shown");
    await document.l10n.translateFragment(dialog);
    await shot("wave3-ai-watch-dialog");
    dialog.hidePopup();
  } finally {
    BrowserTestUtils.removeTab(tab);
  }
});



// wave4: the compact meeting card in Zen's light and dark sidebar.
add_task(async function next_meeting_card() {
  const { WhimsyNextMeeting: service } = ChromeUtils.importESModule(
    "resource:///modules/whimsy/WhimsyNextMeeting.sys.mjs"
  );
  const sources = service._sources;
  const expanded = document.documentElement.getAttribute("zen-sidebar-expanded");
  await SpecialPowers.pushPrefEnv({ set: [
    ["whimsy.feature.next-meeting", true],
    ["whimsy.next-meeting.sidebar-card", true],
    ["whimsy.next-meeting.apple-calendar", false],
    ["whimsy.next-meeting.google-calendars", ""],
  ] });
  try {
    service.initWindow(window);
    document.documentElement.setAttribute("zen-sidebar-expanded", "true");
    for (const dark of [0, 1]) {
      await SpecialPowers.pushPrefEnv({ set: [["ui.systemUsesDarkTheme", dark]] });
      try {
        const now = Date.now();
        service._sources = new Map([["screenshot", { events: [{
          id: "meeting-shot", title: "Design review", start: now + 5 * 60000,
          end: now + 35 * 60000, url: "https://meet.google.com/abc-defg-hij",
        }] }]]);
        service._notify();
        const card = await TestUtils.waitForCondition(() => document.getElementById("whimsy-meeting-card"));
        await TestUtils.waitForCondition(() => card.checkVisibility(), "Meeting card is visible");
        await document.l10n.translateFragment(card);
        await Promise.all(card.getAnimations({ subtree: true }).map(animation => animation.finished));
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        ok(card.querySelector(".zen-library-row-title"), "Uses the Library title style");
        ok(card.querySelector(".zen-library-filter-button"), "Uses the Library button");
        await shot("wave4-meeting-card-" + (dark ? "dark" : "light"));
      } finally {
        await SpecialPowers.popPrefEnv();
      }
    }
  } finally {
    service._sources = sources;
    if (expanded === null) {
      document.documentElement.removeAttribute("zen-sidebar-expanded");
    } else {
      document.documentElement.setAttribute("zen-sidebar-expanded", expanded);
    }
    await SpecialPowers.popPrefEnv();
    service._notify();
  }
});


// wave4: Seasonal loading colors on real busy tabs and the progress line.
add_task(async function seasonal_loading_colors() {
  const { WhimsySeasons } = ChromeUtils.importESModule(
    "resource:///modules/whimsy/WhimsySeasons.sys.mjs"
  );
  const original = WhimsySeasons._now;
  await SpecialPowers.pushPrefEnv({ set: [
    ["whimsy.feature.seasonal-themes", true], ["whimsy.seasons.enabled", true],
    ["zen.view.enable-loading-indicator", true],
    ["whimsy.feature.loading-line", true], ["whimsy.tabs.loading-line", true],
    ["zen.theme.hide-tab-throbber", false], ["ui.prefersReducedMotion", 1],
  ] });
  try {
    for (const [season, month] of [["autumn", 10], ["winter", 12], ["spring", 4], ["summer", 7]]) {
      WhimsySeasons._now = () => new Date(2026, month - 1, 15, 12);
      WhimsySeasons.apply(window);
      const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, "about:blank");
      try {
        const url = `http://mochi.test:8888/browser/zen/whimsy/tests/whimsy_slow_load.sjs?delay=2500&season=${season}`;
        const loaded = BrowserTestUtils.browserLoaded(tab.linkedBrowser, false, url);
        BrowserTestUtils.startLoadingURIString(tab.linkedBrowser, url);
        await TestUtils.waitForCondition(() => document.getElementById("zen-loading-progress-bar"), "Loading");
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        await shot(`seasonal-loading-${season}`);
        await loaded;
      } finally {
        BrowserTestUtils.removeTab(tab);
      }
    }
  } finally {
    WhimsySeasons._now = original;
    await SpecialPowers.popPrefEnv();
    WhimsySeasons.apply(window);
  }
});


// wave4: per-space extensions use a short Settings subtitle.
add_task(async function settings_space_extensions() {
  await BrowserTestUtils.withNewTab("about:preferences#zenTabManagement", async browser => {
    const doc = browser.contentDocument;
    const group = await TestUtils.waitForCondition(() => doc.getElementById("whimsyExtensionsGroup"));
    await TestUtils.waitForCondition(() => group.checkVisibility(), "Extension settings visible");
    group.scrollIntoView({ block: "center" });
    await doc.l10n.translateFragment(group);
    await shot("wave4-settings-extensions", browser.browsingContext.currentWindowGlobal);
  });
});

add_task(async function addons_space_choices() {
  const extension = ExtensionTestUtils.loadExtension({
    useAddonManager: "temporary",
    manifest: { name: "Space choices", browser_action: { default_title: "Space choices" } },
  });
  await extension.startup();
  try {
    await BrowserTestUtils.withNewTab("about:addons", async browser => {
      const doc = browser.contentDocument;
      const manager = browser.contentWindow;
      await TestUtils.waitForCondition(() => "promiseInitialized" in manager);
      await manager.promiseInitialized;
      manager.loadView("addons://list/extension");
      const card = await TestUtils.waitForCondition(() =>
        [...doc.querySelectorAll("addon-card")].find(c => c.addon?.id === extension.id), "Screenshot extension card appears");
      const item = await TestUtils.waitForCondition(() =>
        card.querySelector("[data-whimsy-space-picker]"), "Whimsy space picker is attached");
      card.querySelector(".more-options-button").click();
      item.click();
      const choices = card.querySelector("[data-whimsy-space-choices]");
      ok(choices, "Extension space choices are visible in Add-ons");
      choices.scrollIntoView({ block: "center" });
      await doc.l10n.translateFragment(choices);
      await shot("wave4-addons-spaces", browser.browsingContext.currentWindowGlobal);
    });
  } finally {
    await extension.unload();
  }
});

// batch4: the rail must show glyphs for all enabled Whimsy sections. Meetings
// is deliberately optional: this screenshot still works after its removal.
add_task(async function library_rail_icons() {
  await SpecialPowers.pushPrefEnv({
    set: [["zen.library.hidden-tabs", ""]],
  });
  const library = document.querySelector("zen-library");
  const wasOpen = library.constructor.isLibraryOpen;
  try {
    await TestUtils.waitForCondition(() => library.zenLibrarySections["whimsy-notes"]);
    await library.constructor.animateProgress(1);
    await library.updateComplete;
    await shot("batch4-library-rail-icons");
  } finally {
    await library.constructor.animateProgress(wasOpen ? 1 : 0);
    await SpecialPowers.popPrefEnv();
  }
});

// wave4/fun: Balloon Dash (smooth and retro) and the Year in tabs story.
add_task(async function wave4_fun_game() {
  await BrowserTestUtils.withNewTab("about:whimsy?game", async browser => {
    const win = browser.contentWindow;
    const doc = browser.contentDocument;
    const wg = browser.browsingContext.currentWindowGlobal;
    const game = await TestUtils.waitForCondition(() => win.__whimsyGame, "The game has loaded");
    const frames = () => new Promise(resolve => win.requestAnimationFrame(() => win.requestAnimationFrame(resolve)));
    game.freeze();
    game.setAutoSpawn(false);
    await doc.l10n.ready;
    await frames();
    await shot("wave4-game-ready", wg);

    const scene = () => {
      game.clear();
      game.spawn("seed", { x: 260, y: 60, vx: -30 });
      game.spawn("plane", { x: 330, y: 40, vx: -120, vy: 20 });
      game.spawn("bird", { cx: 400, cy: 90, R: 16, a: 1, vx: -40 });
      game.spawn("zap", { x: 200, t: 1.05, seed: 3 });
      game.spawn("sparkle", { x: 170, y: 100 });
      game.spawn("shield", { x: 420, y: 50 });
      game.spawn("magnet", { x: 60, y: 40 });
      game.warn("plane");
      game.state.player.shield = 5;
      game.state.player.invuln = 5;
      game.state.combo = 3;
      game.state.comboAt = game.state.clock;
      game.tick(0.1);
    };
    game.start();
    scene();
    await frames();
    await shot("wave4-game-running", wg);

    doc.getElementById("whimsy-game-style-retro").click();
    game.state.runTime = 180;
    scene();
    await frames();
    await shot("wave4-game-retro-night", wg);

    game.clear();
    game.state.player.shield = 0;
    game.state.player.invuln = 0;
    game.spawn("seed");
    game.tick(0.4);
    await frames();
    await shot("wave4-game-retro-over", wg);

    doc.getElementById("whimsy-game-style-gradient").click();
    game.render();
    await new Promise(resolve => setTimeout(resolve, 700)); // eslint-disable-line mozilla/no-arbitrary-setTimeout
    await shot("wave4-game-over", wg);
  });
  for (const pref of ["whimsy.game.style", "whimsy.game.high-score"]) {
    Services.prefs.clearUserPref(pref);
  }
});

add_task(async function wave4_fun_year() {
  const { PlacesTestUtils } = ChromeUtils.importESModule("resource://testing-common/PlacesTestUtils.sys.mjs");
  await PlacesUtils.history.clear();
  for (const [url, n] of [["https://example.com/", 6], ["https://example.org/", 3], ["https://mozilla.org/", 1]]) {
    for (let i = 0; i < n; i++) {
      await PlacesTestUtils.addVisits(url);
    }
  }
  await BrowserTestUtils.withNewTab("about:whimsy?year", async browser => {
    const win = browser.contentWindow;
    const wg = browser.browsingContext.currentWindowGlobal;
    const year = await TestUtils.waitForCondition(() => win.__whimsyYear, "The recap has loaded");
    for (const [i, kind] of year.kinds.entries()) {
      year.goTo(i);
      year.skip();
      // Let the slide wipe and the reveal transitions settle.
      await new Promise(resolve => setTimeout(resolve, 1200)); // eslint-disable-line mozilla/no-arbitrary-setTimeout
      await shot(`wave4-year-${i}-${kind}`, wg);
    }
  });
  await PlacesUtils.history.clear();
});

// wave5: the seasonal balloon - homepage hero (light/dark), the offline
// error page, and Balloon Dash in both looks - for each season.
add_task(async function wave5_seasonal_balloon() {
  const SEASONS_URL = "resource:///modules/whimsy/WhimsySeasons.sys.mjs";
  const { WhimsySeasons } = ChromeUtils.importESModule(SEASONS_URL);
  const original = WhimsySeasons._now;
  const months = [["autumn", 10], ["winter", 12], ["spring", 4], ["summer", 7]];
  await SpecialPowers.pushPrefEnv({ set: [
    ["whimsy.feature.seasonal-themes", true], ["whimsy.seasons.enabled", true],
    ["whimsy.feature.home", true], ["whimsy.feature.game", true],
    ["whimsy.feature.net-error-branding", true],
    ["security.certerrors.felt-privacy-v1", false],
    ["browser.netError.searchCTA.enabled", false],
    ["ui.prefersReducedMotion", 1],
  ] });
  try {
    for (const dark of [0, 1]) {
      await SpecialPowers.pushPrefEnv({ set: [["ui.systemUsesDarkTheme", dark]] });
      try {
        for (const [season, month] of months) {
          WhimsySeasons._now = () => new Date(2026, month - 1, 15, 12);
          await BrowserTestUtils.withNewTab("about:whimsy", async browser => {
            const doc = browser.contentDocument;
            await doc.l10n.ready;
            await new Promise(r => browser.contentWindow.requestAnimationFrame(() => browser.contentWindow.requestAnimationFrame(r)));
            await shot(`wave5-home-${season}-${dark ? "dark" : "light"}`, browser.browsingContext.currentWindowGlobal);
          });
        }
      } finally {
        await SpecialPowers.popPrefEnv();
      }
    }

    for (const [season, month] of months) {
      const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, "about:blank");
      const browser = tab.linkedBrowser;
      try {
        const loaded = BrowserTestUtils.waitForErrorPage(browser);
        await SpecialPowers.spawn(browser, [], () => {
          content.location = "about:neterror?e=netOffline&u=https%3A%2F%2Fexample.com%2F&d=Offline";
        });
        await loaded;
        await SpecialPowers.spawn(browser, [month, SEASONS_URL], async (month, url) => {
          const doc = content.document;
          await ContentTaskUtils.waitForCondition(() => doc.getElementById("whimsy-neterror-brand"), "Branded");
          const { WhimsySeasons: seasons } = ChromeUtils.importESModule(url);
          const real = seasons._now;
          seasons._now = () => new Date(2026, month - 1, 15, 12);
          content.windowGlobalChild.getActor("WhimsyNetError").handleEvent({ type: "DOMContentLoaded" });
          seasons._now = real;
          await doc.l10n.translateRoots();
          await ContentTaskUtils.waitForCondition(() => doc.getElementById("whimsy-neterror-style")?.sheet, "Styled");
          // Let the accent SVG decode before the snapshot.
          await new Promise(resolve => content.setTimeout(resolve, 300)); // eslint-disable-line mozilla/no-arbitrary-setTimeout
          await new Promise(resolve => content.requestAnimationFrame(() => content.requestAnimationFrame(resolve)));
        });
        await shot(`wave5-neterror-${season}`, browser.browsingContext.currentWindowGlobal);
      } finally {
        BrowserTestUtils.removeTab(tab);
      }
    }

    await BrowserTestUtils.withNewTab("about:whimsy?game", async browser => {
      const win = browser.contentWindow;
      const doc = browser.contentDocument;
      const wg = browser.browsingContext.currentWindowGlobal;
      const game = await TestUtils.waitForCondition(() => win.__whimsyGame, "The game has loaded");
      const frames = () => new Promise(resolve => win.requestAnimationFrame(() => win.requestAnimationFrame(resolve)));
      game.freeze();
      game.setAutoSpawn(false);
      await doc.l10n.ready;
      for (const [season] of months) {
        game.setSeason(season);
        for (const style of ["gradient", "retro"]) {
          doc.getElementById(`whimsy-game-style-${style}`).click();
          game.start();
          game.clear();
          game.spawn("seed", { x: 260, y: 60, vx: -30 });
          game.spawn("seed", { x: 380, y: 100, vx: -30, phase: 1 });
          game.spawn("plane", { x: 330, y: 40, vx: -120, vy: 20 });
          game.spawn("bird", { cx: 420, cy: 70, R: 16, a: 1, vx: -40 });
          game.spawn("sparkle", { x: 170, y: 100 });
          game.spawn("sparkle", { x: 200, y: 70 });
          game.state.player.invuln = 0;
          game.tick(0.05);
          await frames();
          await shot(`wave5-game-${season}-${style}`, wg);
        }
      }
    });
  } finally {
    WhimsySeasons._now = original;
    await SpecialPowers.popPrefEnv();
    for (const pref of ["whimsy.game.style", "whimsy.game.high-score"]) {
      Services.prefs.clearUserPref(pref);
    }
  }
});

// wave5: a live block in a note, cropped to part of the page.
add_task(async function wave5_note_live_block() {
  await SpecialPowers.pushPrefEnv({
    set: [
      ["whimsy.feature.notes", true],
      ["whimsy.feature.note-blocks", true],
      ["zen.library.hidden-tabs", ""],
    ],
  });
  const { gWhimsyNotesStore } = ChromeUtils.importESModule(
    "resource:///modules/whimsy/WhimsyNotesSection.sys.mjs"
  );
  const library = document.querySelector("zen-library");
  const wasOpen = library.constructor.isLibraryOpen;
  const note = await gWhimsyNotesStore.create();
  try {
    await customElements.whenDefined("whimsy-note-block");
    const { blockFromURL } = customElements.get("whimsy-note-block").helpers;
    const { block } = blockFromURL("https://example.com/", { title: "Example Domain" });
    block.crop = { x: 0, y: 0, w: 1024, h: 420 };
    await gWhimsyNotesStore.update(note.id, { title: "Trip", text: "Check the weather", blocks: [block] });
    await TestUtils.waitForCondition(() => library.zenLibrarySections["whimsy-notes"], "Notes section registered");
    library.activeTab = "whimsy-notes";
    await library.constructor.animateProgress(1);
    const section = await TestUtils.waitForCondition(
      () => library.querySelector("whimsy-library-notes-section"),
      "Notes section shown"
    );
    await section.updateComplete;
    section.editingId = note.id;
    await section.updateComplete;
    const el = await TestUtils.waitForCondition(() => section.querySelector("whimsy-note-block"), "Block shown");
    const browser = await TestUtils.waitForCondition(() => el.browser, "The visible block loads");
    await TestUtils.waitForCondition(
      () => browser.currentURI?.spec == "https://example.com/" && !browser.webProgress?.isLoadingDocument,
      "The block's page has loaded"
    );
    await new Promise(r => setTimeout(r, 400));
    await shot("wave5-note-live-block");
  } finally {
    await gWhimsyNotesStore.remove(note.id);
    await library.constructor.animateProgress(wasOpen ? 1 : 0);
    await SpecialPowers.popPrefEnv();
  }
});

// wave5/captions: CC pressed, a cue translated (fake translator) over the
// video. The page and track are installed by browser_whimsy_video_captions.js.
add_task(async function video_captions() {
  const { WhimsyCaptions } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyCaptions.sys.mjs");
  await SpecialPowers.pushPrefEnv({
    set: [
      ["whimsy.feature.video-speed", true],
      ["whimsy.feature.video-captions", true],
    ],
  });
  WhimsyCaptions.testTargetLanguage = "en";
  WhimsyCaptions.testTranslate = async () => "Where is the library?";
  const url =
    getRootDirectory(gTestPath).replace("chrome://mochitests/content", "https://example.com") + "whimsy_video_captions.html";
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, url);
  const browser = tab.linkedBrowser;
  const state = () =>
    SpecialPowers.spawn(browser, [], () => {
      const actor = content.windowGlobalChild.getExistingActor("WhimsyVideoSpeed");
      return actor ? JSON.parse(JSON.stringify(actor.testState())) : null;
    });
  try {
    await SpecialPowers.spawn(browser, [], async () => {
      const video = content.document.getElementById("video");
      await ContentTaskUtils.waitForCondition(() => video.readyState >= 2, "The video has a frame");
      await ContentTaskUtils.waitForCondition(
        () => content.windowGlobalChild.getExistingActor("WhimsyVideoSpeed")?.videos.has(video),
        "The speed control knows the video"
      );
    });
    await BrowserTestUtils.synthesizeMouseAtCenter("#video", { type: "mousemove" }, browser);
    await TestUtils.waitForCondition(async () => (await state())?.shown, "The control shows");
    const { cc } = await state();
    await BrowserTestUtils.synthesizeMouseAtPoint(cc.x, cc.y, {}, browser);
    await SpecialPowers.spawn(browser, [], async () => {
      const video = content.document.getElementById("video");
      const seeked = new Promise(resolve => video.addEventListener("seeked", resolve, { once: true }));
      video.currentTime = 0.2;
      await seeked;
    });
    await TestUtils.waitForCondition(
      async () => (await state())?.captions?.text == "Where is the library?",
      "The translated cue shows"
    );
    await BrowserTestUtils.synthesizeMouseAtCenter("#video", { type: "mousemove" }, browser);
    await new Promise(resolve => setTimeout(resolve, 200)); // The 120ms fades.
    await shot("wave5-video-captions", browser.browsingContext.currentWindowGlobal);
  } finally {
    WhimsyCaptions.testTranslate = null;
    WhimsyCaptions.testTargetLanguage = null;
    BrowserTestUtils.removeTab(tab);
    await SpecialPowers.popPrefEnv();
  }
});

// wave5/look: the per-space Look and Feel editor, and its button in Zen's
// space creation form, in light and dark.
add_task(async function wave5_space_look() {
  const { WhimsySpaceLook } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsySpaceLook.sys.mjs");
  const home = gZenWorkspaces.getActiveWorkspace();
  const space = await gZenWorkspaces.createAndSaveWorkspace("Reading", undefined, true);
  try {
    WhimsySpaceLook.setLook(window, space.uuid, { density: "roomy", lines: 2 });
    for (const dark of [0, 1]) {
      await SpecialPowers.pushPrefEnv({ set: [["ui.systemUsesDarkTheme", dark]] });
      const scheme = dark ? "dark" : "light";
      try {
        const panel = WhimsySpaceLook.openEditor(window, space.uuid);
        await BrowserTestUtils.waitForPopupEvent(panel, "shown");
        await document.l10n.translateFragment(panel);
        await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
        ok(panel.querySelector(".whimsy-space-look-chip[aria-checked='true']"), "A density is selected");
        await shot(`wave5-space-look-editor-${scheme}`);
        const hidden = BrowserTestUtils.waitForPopupEvent(panel, "hidden");
        panel.hidePopup();
        await hidden;

        await gZenWorkspaces.openWorkspaceCreation();
        const button = await TestUtils.waitForCondition(
          () => document.querySelector("zen-workspace-creation .whimsy-space-look-button"),
          "The creation form offers Look and Feel"
        );
        const form = button.closest("zen-workspace-creation");
        await document.l10n.translateFragment(form);
        await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
        ok(button.getAttribute("label"), "The form's button is labelled");
        await shot(`wave5-space-look-form-${scheme}`);
        await form.onCancelButtonCommand();
        await TestUtils.waitForCondition(() => !document.querySelector("zen-workspace-creation"), "The form is gone");
      } finally {
        await SpecialPowers.popPrefEnv();
      }
    }
  } finally {
    WhimsySpaceLook.reset(window, space.uuid);
    if (gZenWorkspaces.activeWorkspace != home.uuid) {
      await gZenWorkspaces.changeWorkspaceWithID(home.uuid);
    }
    await gZenWorkspaces.removeWorkspace(space.uuid);
  }
});

// wave5/uxfix: naming a Split Favorite asks in the window's own sheet (the
// Delete Space style), in light and dark, once the sheet has settled.
add_task(async function uxfix_split_favorite_name_sheet() {
  const { WhimsyPanels } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyPanels.sys.mjs");
  const l10n = new Localization(["browser/whimsy.ftl"], true);
  const [title, body] = l10n.formatValuesSync([
    "whimsy-split-favorite-name-title",
    "whimsy-split-favorite-name-prompt",
  ]);
  for (const dark of [0, 1]) {
    await setScheme(dark);
    const dialog = BrowserTestUtils.promiseAlertDialogOpen(null);
    const asking = WhimsyPanels.ask(window, { title, body, value: "Mail + Calendar" });
    const win = await dialog;
    await settled();
    await shot(`uxfix-split-favorite-name-${dark ? "dark" : "light"}`);
    win.document.querySelector("dialog").getButton("cancel").click();
    is(await asking, null, "Cancel leaves no favorite");
    await SpecialPowers.popPrefEnv();
  }
});

// wave5/audioicon: Arc's tab speaker on a playing row, a muted row and a
// playing Essential, in light and dark.
add_task(async function tab_audio_icon() {
  const playing = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.com/?playing");
  const muted = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.com/?muted");
  const essential = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.org/?essential");
  gZenPinnedTabManager.addToEssentials(essential);
  await TestUtils.waitForCondition(() => essential.hasAttribute("zen-essential"));
  const home = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.org/");
  for (const tab of [playing, muted, essential]) {
    tab.setAttribute("soundplaying", "true");
  }
  muted.toggleMuteAudio();
  try {
    for (const dark of [0, 1]) {
      await SpecialPowers.pushPrefEnv({ set: [["ui.systemUsesDarkTheme", dark]] });
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      await shot(`wave5-tab-audio-${dark ? "dark" : "light"}`);
      await SpecialPowers.popPrefEnv();
    }
  } finally {
    muted.toggleMuteAudio();
    gZenPinnedTabManager.removeEssentials(essential);
    for (const tab of [playing, muted, essential, home]) {
      BrowserTestUtils.removeTab(tab);
    }
  }
});

// fix7/tabs: pinned tabs in the space's own container (no line), in another
// container (a short pill on the leading edge), and an Essential with an
// unread count on its tile's corner.
add_task(async function fix7_pinned_marks_and_essential_badge() {
  const space = gZenWorkspaces.getActiveWorkspaceFromCache();
  const oldContainer = space.containerTabId;
  space.containerTabId = 1;
  const tabs = [];
  try {
    for (const [url, userContextId] of [["https://example.com/?own", 1], ["https://example.org/?other", 2]]) {
      const tab = BrowserTestUtils.addTab(gBrowser, url, { userContextId });
      await BrowserTestUtils.browserLoaded(tab.linkedBrowser);
      gBrowser.pinTab(tab);
      tabs.push(tab);
    }
    const essential = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.com/?mail");
    gZenPinnedTabManager.addToEssentials(essential);
    tabs.push(essential);
    await SpecialPowers.spawn(essential.linkedBrowser, [], () => {
      content.document.title = "Inbox (12) - Mail";
    });
    await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.net/").then(t => tabs.push(t));
    await TestUtils.waitForCondition(() => essential.hasAttribute("whimsy-unread"), "Badge");
    await new Promise(resolve => setTimeout(resolve, 300)); // eslint-disable-line mozilla/no-arbitrary-setTimeout
    await shot("fix7-pinned-marks-essential-badge");
  } finally {
    space.containerTabId = oldContainer;
    for (const tab of tabs) {
      if (tab.hasAttribute("zen-essential")) {
        gZenPinnedTabManager.removeEssentials(tab);
      }
      BrowserTestUtils.removeTab(tab);
    }
  }
});

// fix7/tabs: Whimsy's Library icons are sprites in Zen's style; each one is
// caught a third of the way through its play.
add_task(async function fix7_library_icons_mid_play() {
  await SpecialPowers.pushPrefEnv({ set: [["zen.library.hidden-tabs", ""]] });
  const library = document.querySelector("zen-library");
  const wasOpen = library.constructor.isLibraryOpen;
  try {
    await TestUtils.waitForCondition(() => library.zenLibrarySections["whimsy-notes"]);
    await library.constructor.animateProgress(1);
    await library.updateComplete;
    for (const tab of library.querySelectorAll('.zen-library-tab[data-section^="whimsy-"]')) {
      tab.setAttribute("animate", "true");
      for (const animation of tab.querySelector(".zen-library-tab-icon-image").getAnimations()) {
        animation.pause();
        animation.currentTime = 200;
      }
    }
    await shot("fix7-library-icons-mid-play");
  } finally {
    for (const tab of library.querySelectorAll('.zen-library-tab[data-section^="whimsy-"]')) {
      tab.removeAttribute("animate");
    }
    await library.constructor.animateProgress(wasOpen ? 1 : 0);
    await SpecialPowers.popPrefEnv();
  }
});

// fix7/tabs: the email alias button, filled, alone and beside a password
// manager's inline button (a stand-in for 1Password's).
add_task(async function fix7_email_alias_button() {
  await BrowserTestUtils.withNewTab("https://example.com/", async browser => {
    for (const withOther of [false, true]) {
      await SpecialPowers.spawn(browser, [withOther], other => {
        const doc = content.document;
        doc.body.innerHTML = `<form style="padding:40px;font:16px system-ui">
          <input id="email" type="email" placeholder="you@example.com"
            style="width:320px;height:40px;padding:0 12px;border:1px solid #ccc;border-radius:8px;font:inherit">
        </form>`;
        if (other) {
          const field = doc.getElementById("email").getBoundingClientRect();
          const badge = doc.createElement("com-1password-button");
          Object.assign(badge.style, {
            position: "absolute", display: "block", width: "24px", height: "24px", borderRadius: "12px",
            background: "#1a8cff", left: `${field.right - 32}px`, top: `${field.top + 8}px`,
          });
          doc.body.append(badge);
        }
        doc.getElementById("email").focus();
      });
      await TestUtils.waitForCondition(() => SpecialPowers.spawn(browser, [], () =>
        !!content.document.getElementById("whimsy-email-aliases-host")), "Alias button");
      await new Promise(resolve => setTimeout(resolve, 700)); // eslint-disable-line mozilla/no-arbitrary-setTimeout
      await shot(`fix7-email-alias-button${withOther ? "-beside-1password" : ""}`,
        browser.browsingContext.currentWindowGlobal);
    }
  });
});

// fix7/tabs: the People card, loaded (initials, name, handle, bio, stats,
// actions) and while loading, in light and dark.
add_task(async function fix7_people_card() {
  await SimpleTest.promiseFocus(window);
  const { WhimsyHoverCard } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyHoverCard.sys.mjs");
  const { WhimsyPeople } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyPeople.sys.mjs");
  const card = WhimsyHoverCard.forWindow(window);
  const url = "https://github.com/monalisa";
  const loaded = WhimsyPeople.card({
    title: "monalisa (Mona Lisa Octocat) · GitHub",
    description: "Designer and octocat at large. Making the web a little more whimsical, one pull request at a time. 1,204 followers · 87 following",
  }, url);
  try {
    for (const dark of [0, 1]) {
      await setScheme(dark);
      for (const [name, person] of [["loaded", loaded], ["loading", WhimsyPeople.card(null, url, { loading: true })]]) {
        card.hide();
        card.show(gBrowser.selectedTab, { person });
        await TestUtils.waitForCondition(() => card.panel.state == "open");
        await document.l10n.translateFragment(card.panel);
        await settled();
        await shot(`fix7-people-card-${name}-${dark ? "dark" : "light"}`);
      }
      await SpecialPowers.popPrefEnv();
    }
  } finally {
    card.hide();
  }
});

// wave7/focus: the paste guard's sheet under a field, in light and dark.
add_task(async function paste_guard_sheet() {
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.com/?whimsy-paste-guard-shot");
  const browser = tab.linkedBrowser;
  await SpecialPowers.spawn(browser, [], () => {
    content.document.body.innerHTML =
      '<label style="font: 15px system-ui; display: block; margin: 40px 40px 6px">Message</label>' +
      '<input id="field" style="margin: 0 40px; width: 360px; font: 15px system-ui; padding: 8px">';
  });
  const key = "AKIAIOSFODNN7EXAMPLE";
  await SimpleTest.promiseClipboardChange(key, () => SpecialPowers.clipboardCopyString(key));
  try {
    for (const dark of [0, 1]) {
      await SpecialPowers.pushPrefEnv({ set: [["ui.systemUsesDarkTheme", dark]] });
      await SpecialPowers.spawn(browser, [], () => content.document.getElementById("field").focus());
      browser.focus();
      goDoCommand("cmd_paste");
      await TestUtils.waitForCondition(() => document.getElementById("whimsy-paste-guard")?.state == "open");
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      await shot(`wave7-paste-guard-${dark ? "dark" : "light"}`);
      document.getElementById("whimsy-paste-guard").hidePopup();
      await TestUtils.waitForCondition(() => !document.getElementById("whimsy-paste-guard"));
      await SpecialPowers.popPrefEnv();
    }
  } finally {
    BrowserTestUtils.removeTab(tab);
  }
});
