/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// Whimsy: a screenshot tool, so changes can be checked by eye without macOS
// Screen Recording permission. It draws the real window from inside Gecko.
// W11-P1: the second half of browser_whimsy_screens.js (sheets, private
// pages, AI, seasonal, settings shots), split off because the whole file ran
// 90s against a 90s limit.
// Without WHIMSY_SHOTS it only does a quick smoke check.

// Screenshot tasks open and close windows and spaces; Zen can leave a
// blank placeholder tab behind in this window. Take any extra tabs along.
const screensStartTabs = new Set(gBrowser.tabs);
registerCleanupFunction(() => {
  for (const tab of gBrowser.tabs.filter(t => !screensStartTabs.has(t))) {
    BrowserTestUtils.removeTab(tab);
  }
});

// Twenty-odd screenshot tasks in one file.
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
  const bitmap = await whimsySnapshot(windowGlobal, rect);
  const canvas = document.createElementNS("http://www.w3.org/1999/xhtml", "canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  canvas.getContext("2d").drawImage(bitmap, 0, 0);
  const blob = await new Promise(resolve => canvas.toBlob(resolve));
  const path = PathUtils.join(SHOTS, `${name}.png`);
  await IOUtils.write(path, new Uint8Array(await blob.arrayBuffer()));
  info(`Saved ${path}`);
}

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

// wave8/snooze (W8-37): the one Undo toast (Snooze, Hide Space, the
// archive sweep): message, the tab's title, "Undo" in words and ⌘Z; light,
// dark, and with keyboard focus on Undo. (The Snooze picker is a popup,
// which drawSnapshot doesn't draw; browser_whimsy_snooze.js checks it.)
add_task(async function w8_undo_toast() {
  const { WhimsyUndo } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyUndo.sys.mjs");
  for (const dark of [0, 1]) {
    await setScheme(dark);
    let toast = null;
    try {
      toast = WhimsyUndo.showToast(
        window,
        "whimsy-snooze-undo-toast",
        { type: "shot", undo() {}, redo: null },
        { when: "tomorrow", time: "9:00 AM", day: "" },
        { detail: "Quarterly planning notes — Google Docs" }
      );
      ok(toast, "The undo toast shows");
      await document.l10n.translateFragment(toast.element);
      await toast.shown;
      await settled();
      ok(toast.element.checkVisibility(), "It is visible");
      await shot(`w8-undo-toast-${dark ? "dark" : "light"}`);
      if (!dark) {
        toast.element.querySelector(".whimsy-toast-button").focus();
        await settled();
        await shot("w8-undo-toast-focus-light");
      }
    } finally {
      toast?.close({ instant: true });
      WhimsyUndo.undo(window);
      await SpecialPowers.popPrefEnv();
    }
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
  const scratch = await WhimsyPrivate.openScratch(window, { withTab: true });
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
    // wave7/scratch: Zen's New Space form first ("Save Space"), the
    // dialog after it.
    document.getElementById("cmd_whimsyKeepScratch").doCommand();
    const form = await TestUtils.waitForCondition(
      () => document.querySelector("zen-workspace-creation[whimsy-scratch-save]")
    );
    await TestUtils.waitForCondition(() => form.inputName?.matches(":focus"));
    await new Promise(resolve => setTimeout(resolve, 400));
    await shot("wave7-scratch-save-form");
    EventUtils.sendString("Reading");
    await settled();
    await shot("wave7-scratch-save-form-filled");
    const dialog = BrowserTestUtils.promiseAlertDialogOpen(null);
    form.createButton.doCommand();
    const confirmWin = await dialog;
    await settled();
    await shot("fixC-scratch-keep-confirm");
    confirmWin.document.querySelector("dialog").getButton("accept").click();
    await TestUtils.waitForCondition(() => !WhimsyPrivate.getScratch(window));
    keptId = scratch.uuid;
    await new Promise(resolve => setTimeout(resolve, 300));
    // wave7/scratch: the header shows the name given in the form.
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
  // Zen remembers the last toggle for the next launch.
  const STARTUP = "zen.view.compact.enable-at-startup";
  const startup = Services.prefs.prefHasUserValue(STARTUP) ? Services.prefs.getBoolPref(STARTUP) : null;
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
    if (startup === null) {
      Services.prefs.clearUserPref(STARTUP);
    } else {
      Services.prefs.setBoolPref(STARTUP, startup);
    }
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
  await BrowserTestUtils.withNewTab("about:preferences#whimsyAI", async browser => {
    const doc = browser.contentDocument;
    const group = await TestUtils.waitForCondition(() => doc.getElementById("whimsyAIProviderList"));
    await TestUtils.waitForCondition(() => group.checkVisibility(), "AI provider list visible");
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
    // Tidy also sorts the tabs that were already open: take them out of
    // their sections, so no header is left for later files (it moved
    // agent-tabs' new tabs above it).
    for (const tab of gBrowser.tabs) {
      WhimsyAITabs.setSection(tab, null);
    }
    WhimsyAITabs.queueRender(window);
    await TestUtils.waitForCondition(() => !document.querySelector(".whimsy-tidy-header"), "No sections are left");
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

    // Watch This Page builds its panel after reading the watch list.
    await WhimsyPageWatch.openDialog(window, tab);
    const dialog = await TestUtils.waitForCondition(() => document.getElementById("whimsy-watch-panel"), "The watch panel is made");
    await TestUtils.waitForCondition(() => dialog.state == "open", "The watch panel is open");
    await document.l10n.translateFragment(dialog);
    await shot("wave3-ai-watch-dialog");
    const hidden = BrowserTestUtils.waitForPopupEvent(dialog, "hidden");
    dialog.hidePopup();
    await hidden;
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
// The snapshot helper paints again when a frame is lost mid-paint (the
// release quick verify failed seasonal_loading_colors with
// NS_ERROR_LOSS_OF_SIGNIFICANT_DATA as the loading tab's frame changed), and
// still reports any other failure.
add_task(async function snapshot_repaints_a_lost_frame() {
  let calls = 0;
  const lost = { drawSnapshot: async () => {
    if (++calls == 1) {
      throw Components.Exception("lost", Cr.NS_ERROR_LOSS_OF_SIGNIFICANT_DATA);
    }
    return "bitmap";
  } };
  is(await whimsySnapshot(lost, null), "bitmap", "Painted again after a lost frame");
  is(calls, 2, "...once");
  const broken = { drawSnapshot: async () => {
    throw Components.Exception("other", Cr.NS_ERROR_FAILURE);
  } };
  await Assert.rejects(whimsySnapshot(broken, null), /other/, "Other failures still fail");
});

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
        // wave7/profiles: "Run in Profiles…" replaced "Show in Spaces…".
        card.querySelector("[data-whimsy-profile-picker]"), "Whimsy profile picker is attached");
      card.querySelector(".more-options-button").click();
      // The gear's menu opens asynchronously; pick from it once it shows.
      await TestUtils.waitForCondition(() => BrowserTestUtils.isVisible(item), "The gear menu is open");
      item.click();
      const choices = await TestUtils.waitForCondition(() => card.querySelector("[data-whimsy-profile-choices]"),
        "Extension profile choices are visible in Add-ons");
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

// wave10/fixes W10-09: the Private Space opens empty, on its empty state.
add_task(async function private_space_empty_state() {
  const { WhimsyPrivate } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyPrivate.sys.mjs");
  const startSpace = gZenWorkspaces.activeWorkspace;
  const space = await WhimsyPrivate.openScratch(window);
  if (!space) {
    ok(true, "The Private Space isn't available here");
    return;
  }
  try {
    const el = await TestUtils.waitForCondition(() => {
      const node = document.getElementById("whimsy-private-empty");
      return node && !node.hidden && node;
    }, "The empty state shows");
    await document.l10n.translateFragment(el);
    await settled();
    await new Promise(resolve => setTimeout(resolve, 300));
    await shot("w10-private-space-empty");
  } finally {
    await WhimsyPrivate.closeScratch(window);
    if (gZenWorkspaces.activeWorkspace != startSpace) {
      await gZenWorkspaces.changeWorkspaceWithID(startSpace);
    }
  }
});

// wave10's surface shots are in browser_whimsy_screens_4.js.

// W15: the screenshot viewer (Firefox's preview): Retry · Add to Easel ·
// Copy · Download · Edit · Save and Close · Cancel, in light and dark.
add_task(async function w15_screenshot_viewer() {
  const { ScreenshotsUtils } = ChromeUtils.importESModule("moz-src:///browser/components/screenshots/ScreenshotsUtils.sys.mjs");
  const SAVED = "screenshots.browser.component.last-screenshot-method";
  const had = Services.prefs.prefHasUserValue(SAVED);
  const value = had ? Services.prefs.getStringPref(SAVED) : null;
  await SpecialPowers.pushPrefEnv({ set: [["screenshots.browser.component.enabled", true], ["whimsy.capture.redact", false]] });
  let tab = null;
  try {
    for (const dark of [0, 1]) {
      await setScheme(dark);
      tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.com/");
      const browser = tab.linkedBrowser;
      await ScreenshotsUtils.start(browser, "Shortcut");
      const visible = await TestUtils.waitForCondition(() => !ScreenshotsUtils.panelForBrowser(browser)?.hidden &&
        ScreenshotsUtils.panelForBrowser(browser)?.querySelector("screenshots-buttons")?.shadowRoot?.getElementById("visible-page"),
      "The Screenshots bar");
      await TestUtils.waitForCondition(
        () => SpecialPowers.spawn(browser, [], () => !!content.windowGlobalChild.getExistingActor("ScreenshotsComponent")?.overlay?.initialized),
        "The overlay");
      EventUtils.synthesizeMouseAtCenter(visible, {}, window);
      const dialog = await TestUtils.waitForCondition(() => ScreenshotsUtils.browserToScreenshotsState.get(browser)?.previewDialog,
        "The viewer");
      await dialog._dialogReady;
      const preview = await TestUtils.waitForCondition(() => dialog._frame.contentDocument.querySelector("screenshots-preview"));
      await TestUtils.waitForCondition(() => preview.renderRoot?.getElementById("whimsy-capture-save-close"), "Whimsy's buttons");
      await TestUtils.waitForCondition(() => preview.previewImg.complete && preview.previewImg.naturalWidth);
      await dialog._frame.contentDocument.l10n.translateRoots();
      await new Promise(resolve => setTimeout(resolve, 600)); // eslint-disable-line mozilla/no-arbitrary-setTimeout
      ok(preview.renderRoot.getElementById("whimsy-capture-save-close").textContent.trim() ||
        preview.renderRoot.getElementById("whimsy-capture-save-close").label, "Save and Close has its label");
      await shot(`w15-screenshot-viewer-${dark ? "dark" : "light"}`);
      ScreenshotsUtils.exit(browser);
      await TestUtils.waitForCondition(() => !ScreenshotsUtils.browserToScreenshotsState.has(browser) &&
        ScreenshotsUtils.panelForBrowser(browser)?.hidden !== false, "Screenshots closed");
      BrowserTestUtils.removeTab(tab);
      tab = null;
    }
  } finally {
    if (tab) {
      BrowserTestUtils.removeTab(tab);
    }
    await SpecialPowers.popPrefEnv();
    if (had) {
      Services.prefs.setStringPref(SAVED, value);
    } else {
      Services.prefs.clearUserPref(SAVED);
    }
  }
});
