/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// Whimsy: a screenshot tool, so changes can be checked by eye without macOS
// Screen Recording permission. It draws the real window from inside Gecko.
//   WHIMSY_SHOTS=/some/dir npm test -- ui/browser_whimsy_screens_4.js
// Without WHIMSY_SHOTS it only does a quick smoke check.

// Screenshot tasks open and close windows and spaces; Zen can leave a
// blank placeholder tab behind in this window. Take any extra tabs along.
const screensStartTabs = new Set(gBrowser.tabs);
registerCleanupFunction(() => {
  for (const tab of gBrowser.tabs.filter(t => !screensStartTabs.has(t))) {
    BrowserTestUtils.removeTab(tab);
  }
});

// wave10's surface shots (split from browser_whimsy_screens.js so each
// file stays under the time limit).
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

// Helpers shared with browser_whimsy_screens.js.

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

// wave7: the shots wave 7 added, split from browser_whimsy_screens.js so
// each file stays under the harness's time limit.


// wave5: the seasonal balloon - homepage hero (light/dark), the offline
// error page, and Balloon Dash in both looks - for each season.
// wave10 design pass A: every new surface, light and dark (shots named
// w10-<surface>-<state>-<light|dark>), for side-by-side checks against the
// mockups (artifact 525AvMQg54ssXqojjzLqT6).
async function w10ToastShot(name, show) {
  const { WhimsyToast } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyToast.sys.mjs");
  for (const dark of [0, 1]) {
    await setScheme(dark);
    let toast = null;
    try {
      toast = await show();
      ok(toast, `${name}: the toast shows`);
      await document.l10n.translateFragment(toast);
      await settled();
      await shot(`w10-${name}-${dark ? "dark" : "light"}`);
    } finally {
      if (toast?.isConnected) {
        WhimsyToast._dismissNow(toast);
      }
      await SpecialPowers.popPrefEnv();
    }
  }
}

async function w10SurfaceShot(name, panelId, open, ready = null) {
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
      await shot(`w10-${name}-${dark ? "dark" : "light"}`);
    } finally {
      if (panel.state == "open" || panel.state == "showing") {
        const hidden = BrowserTestUtils.waitForEvent(panel, "popuphidden");
        panel.hidePopup();
        await hidden;
      }
      await SpecialPowers.popPrefEnv();
    }
  }
}

// W10-15: the dead-page offer, looking, and the error state.
add_task(async function w10_dead_page_toast() {
  const { WhimsyToast } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyToast.sys.mjs");
  const icon = "chrome://browser/skin/zen-icons/selectable/time.svg";
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.com/nope-123");
  try {
    await w10ToastShot("dead-page-offer", () => WhimsyToast.show(window, {
      l10nId: "whimsy-archive-toast", detailL10nId: "whimsy-archive-toast-detail", icon, timeout: 0,
      action: { l10nId: "whimsy-archive-look", onCommand: () => "keep" },
    }));
    await w10ToastShot("dead-page-looking", () => {
      const toast = WhimsyToast.show(window, {
        l10nId: "whimsy-archive-toast", detailL10nId: "whimsy-archive-toast-detail", icon, timeout: 0,
        action: { l10nId: "whimsy-archive-look", onCommand: () => "keep" },
      });
      toast.update({ detailL10nId: "whimsy-archive-looking", busy: true, action: { l10nId: "whimsy-archive-looking-button" } });
      return toast;
    });
    await w10ToastShot("dead-page-error", () => WhimsyToast.show(window, {
      l10nId: "whimsy-archive-error", detailL10nId: "whimsy-archive-error-detail", icon, timeout: 0,
      action: { l10nId: "whimsy-archive-retry", onCommand: () => "keep" },
    }));
  } finally {
    BrowserTestUtils.removeTab(tab);
  }
});

// W10-30: Fire, its three choices and the Fire Everywhere step, and the
// result toast.
add_task(async function w10_fire() {
  const { WhimsyFireButton } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyFireButton.sys.mjs");
  const { WhimsyToast } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyToast.sys.mjs");
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://www.example.com/?w10-fire");
  try {
    await w10SurfaceShot("fire-choices", "whimsyFirePanel", () => WhimsyFireButton.openPanel(window));
    await w10SurfaceShot("fire-site", "whimsyFirePanel", () => WhimsyFireButton.openPanel(window, { choice: "site" }));
    await w10SurfaceShot("fire-everywhere-confirm", "whimsyFirePanel",
      () => WhimsyFireButton.openPanel(window, { choice: "everything", confirm: true }));
    await w10ToastShot("fire-result", () => {
      const toast = WhimsyToast.show(window, {
        l10nId: "whimsy-fire-done-profile-title", l10nArgs: { profile: "Work" },
        detailL10nId: "whimsy-fire-done-profile-detail", detailArgs: { count: 12, visits: 340, sites: 21 },
        icon: "chrome://browser/skin/zen-icons/history.svg", timeout: 0,
      });
      return toast;
    });
  } finally {
    BrowserTestUtils.removeTab(tab);
  }
});

// W10-14: the paste guard, over the page (no field) and under a field.
add_task(async function w10_paste_guard() {
  const key = "AKIA" + "IOSFODNN7EXAMPLE";
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.com/?w10-paste-guard");
  const browser = tab.linkedBrowser;
  await SpecialPowers.spawn(browser, [], () => {
    content.document.body.innerHTML = `<h1>New chat</h1><p>Paste your key below.</p>
      <input id="field" style="width: 320px; margin-top: 40px" placeholder="Message…">`;
  });
  await SimpleTest.promiseClipboardChange(key, () => SpecialPowers.clipboardCopyString(key));
  try {
    await w10SurfaceShot("paste-guard-page", "whimsy-paste-guard", async () => {
      await SpecialPowers.spawn(browser, [], () => {
        content.document.activeElement?.blur?.();
        content.focus();
        content.docShell.doCommand("cmd_paste");
      });
    });
    await w10SurfaceShot("paste-guard-field", "whimsy-paste-guard", async () => {
      await SpecialPowers.spawn(browser, [], () => {
        content.document.getElementById("field").focus();
        content.docShell.doCommand("cmd_paste");
      });
    });
  } finally {
    BrowserTestUtils.removeTab(tab);
  }
});

// W10-17: What Font Is This? on a web page's selection, and on a page it
// can't read.
add_task(async function w10_font_card() {
  const { WhimsyInspector } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyInspector.sys.mjs");
  const page = "https://example.com/document-builder.sjs?html=" + encodeURIComponent(`
    <h1 style="font: 600 15px/24px -apple-system, system-ui; letter-spacing: -0.01em; color: #1f2937; margin: 80px 30px">
      <span id="t">Build momentum</span> with a calm, steady workflow</h1>`);
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, page);
  try {
    const select = () => SpecialPowers.spawn(tab.linkedBrowser, [], () => {
      const range = content.document.createRange();
      range.selectNodeContents(content.document.getElementById("t"));
      content.getSelection().removeAllRanges();
      content.getSelection().addRange(range);
    });
    await w10SurfaceShot("font-card", "whimsy-font-inspector-panel", async () => {
      await select();
      await WhimsyInspector.inspectFont(window);
    }, panel => panel.querySelector(".whimsy-font-fact"));
    BrowserTestUtils.startLoadingURIString(tab.linkedBrowser, "about:robots");
    await BrowserTestUtils.browserLoaded(tab.linkedBrowser);
    await w10SurfaceShot("font-card-unavailable", "whimsy-font-inspector-panel", () => WhimsyInspector.inspectFont(window));
  } finally {
    BrowserTestUtils.removeTab(tab);
  }
});

// W10-16: This Site in Zen's site panel (pick B: Pretend to Be as a
// dropdown row), with a few things remembered, and its Pretend to Be list.
add_task(async function w10_this_site() {
  const { WhimsySiteSettings } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsySiteSettings.sys.mjs");
  const { WhimsyUserAgent } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyUserAgent.sys.mjs");
  const host = "example.com";
  const oa = { userContextId: 0, privateBrowsingId: 0 };
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, `https://${host}/`);
  WhimsySiteSettings.setFlag("reader", host, oa, true);
  WhimsyUserAgent.set(host, "chrome-mac");
  await FullZoom.enlarge(tab.linkedBrowser);
  gNavToolbox.setAttribute("zen-has-implicit-hover", "true");
  try {
    await w10SurfaceShot("this-site", "zen-unified-site-data-panel", () => WhimsySiteSettings.open(window),
      panel => panel.querySelector("#whimsy-site-settings-section:not([hidden])"));
    for (const dark of [0, 1]) {
      await setScheme(dark);
      await WhimsySiteSettings.open(window);
      const shown = BrowserTestUtils.waitForEvent(document, "popupshown", true,
        e => e.target.id == "whimsy-site-settings-useragent-button-list");
      document.getElementById("whimsy-site-settings-useragent-button").click();
      await shown;
      const list = document.getElementById("whimsy-site-settings-useragent-button-list");
      await document.l10n.translateFragment(list);
      await settled();
      await shot(`w10-this-site-pretend-${dark ? "dark" : "light"}`);
      list.hidePopup();
      const site = document.getElementById("zen-unified-site-data-panel");
      const hidden = BrowserTestUtils.waitForPopupEvent(site, "hidden");
      site.hidePopup(true);
      await hidden;
      await SpecialPowers.popPrefEnv();
    }
  } finally {
    gNavToolbox.removeAttribute("zen-has-implicit-hover");
    WhimsySiteSettings.setFlag("reader", host, oa, false);
    WhimsyUserAgent.clear(host);
    await FullZoom.reset(tab.linkedBrowser);
    BrowserTestUtils.removeTab(tab);
  }
});

// W10-18: the page tools, one per tab, light and dark.
add_task(async function w10_page_tools() {
  const { WhimsyPageDev } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyPageDev.sys.mjs");
  const root = getRootDirectory(gTestPath).replace("chrome://mochitests/content", "https://example.com");
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, root + "whimsy_pagedev.html");
  // fonts.ready resolves to the FontFaceSet, which can't cross processes.
  await SpecialPowers.spawn(tab.linkedBrowser, [], async () => {
    await content.document.fonts.ready;
  });
  try {
    for (const t of ["fonts", "colors", "built-with"]) {
      await w10SurfaceShot(`page-tools-${t}`, "whimsy-pagedev", () => WhimsyPageDev.open(window, t),
        panel => panel.dataset.tab == t && !panel.querySelector(".whimsy-pagedev-reading"));
    }
  } finally {
    BrowserTestUtils.removeTab(tab);
  }
});

// W10-19: the cheat sheet, and the cheat sheet filtered.
add_task(async function w10_cheat_sheet() {
  const { WhimsyCheatSheet } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyCheatSheet.sys.mjs");
  await w10SurfaceShot("cheat-sheet", "whimsy-cheatsheet-panel", () => WhimsyCheatSheet.open(window),
    panel => panel.querySelector(".whimsy-cheatsheet-row"));
  await w10SurfaceShot("cheat-sheet-search", "whimsy-cheatsheet-panel", () => WhimsyCheatSheet.open(window), panel => {
    const search = panel.querySelector("#whimsy-cheatsheet-search");
    if (search.value != "split") {
      search.value = "split";
      search.dispatchEvent(new Event("input"));
    }
    return true;
  });
});

// W10-24: Add to Easel with a capture and two easels, the first-easel
// state, and Library ▸ Screenshots as a grid.
add_task(async function w10_easel_picker_and_library() {
  const { WhimsyEasel, gWhimsyEaselStore } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyEasel.sys.mjs");
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.com/?w10-easel");
  const canvas = new OffscreenCanvas(640, 400);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#e9e4f5";
  ctx.fillRect(0, 0, 640, 400);
  ctx.fillStyle = "#7a6ad8";
  ctx.fillRect(40, 40, 300, 40);
  const blob = await canvas.convertToBlob();
  const capture = { blob, item: { type: "capture", live: false, crop: { x: 0, y: 0, w: 1280, h: 720 }, profileKey: "default" } };
  const created = [];
  try {
    await w10SurfaceShot("easel-picker-first", "whimsy-easel-picker",
      () => WhimsyEasel.showPicker(window, tab.linkedBrowser, null, () => {}, "w10-shot-empty-profile", { capture }));
    for (const title of ["Mood board", "Launch plan for the autumn campaign and its many moving parts"]) {
      const easel = await gWhimsyEaselStore.create({ title });
      created.push(easel);
      const image = await gWhimsyEaselStore.saveImage(easel.id, new Uint8Array(await blob.arrayBuffer()));
      await gWhimsyEaselStore.addItem(easel.id, { type: "capture", image, w: 320, h: 200 });
    }
    await w10SurfaceShot("easel-picker", "whimsy-easel-picker",
      () => WhimsyEasel.showPicker(window, tab.linkedBrowser, null, () => {}, "default", { capture }),
      panel => panel.querySelectorAll(".whimsy-easel-tile-thumb img").length >= 2);
  } finally {
    for (const easel of created) {
      await gWhimsyEaselStore.remove(easel.id);
    }
    BrowserTestUtils.removeTab(tab);
  }
});

// W10-24: Library ▸ Screenshots as a grid of thumbnails with the size slider.
add_task(async function w10_library_screenshots() {
  const library = document.querySelector("zen-library");
  if (!library) {
    return;
  }
  const sub = Services.prefs.getStringPref("whimsy.captures.folder", "") || "whimsy-captures";
  const dir = PathUtils.isAbsolute(sub) ? sub : PathUtils.join(PathUtils.profileDir, sub);
  await IOUtils.makeDirectory(dir, { ignoreExisting: true });
  const paths = [];
  for (const [i, color] of ["#7a6ad8", "#e9590c", "#1d8a4a", "#0b5cad"].entries()) {
    const canvas = new OffscreenCanvas(640, 400);
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#f4f4f4";
    ctx.fillRect(0, 0, 640, 400);
    ctx.fillStyle = color;
    ctx.fillRect(40, 40, 360, 60);
    ctx.fillRect(40, 140, 560, 200);
    const path = PathUtils.join(dir, `Screenshot ${i + 1} w10 shot.png`);
    await IOUtils.write(path, new Uint8Array(await (await canvas.convertToBlob()).arrayBuffer()));
    paths.push(path);
  }
  Services.obs.notifyObservers(null, "whimsy-capture-saved", paths[0]);
  const wasOpen = library.constructor.isLibraryOpen;
  try {
    await TestUtils.waitForCondition(() => library.zenLibrarySections["whimsy-files"]);
    library.activeTab = "whimsy-files";
    await library.constructor.animateProgress(1);
    await TestUtils.waitForCondition(() => library.querySelectorAll(".whimsy-library-shot-image").length >= 4, "Tiles");
    for (const dark of [0, 1]) {
      await setScheme(dark);
      await settled();
      await shot(`w10-library-screenshots-${dark ? "dark" : "light"}`);
      await SpecialPowers.popPrefEnv();
    }
  } finally {
    await library.constructor.animateProgress(wasOpen ? 1 : 0);
    for (const path of paths) {
      await IOUtils.remove(path, { ignoreAbsent: true });
    }
  }
});

// W10-54: the drawn trail (A → B → C, back twice, then D).
add_task(async function w10_trail() {
  const { WhimsyTrails } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyTrails.sys.mjs");
  await SpecialPowers.pushPrefEnv({ set: [["browser.navigation.requireUserInteraction", false]] });
  const base = "https://example.com/browser/whimsy-trails-shot";
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, `${base}?a`);
  const browser = tab.linkedBrowser;
  const load = async url => {
    const loaded = BrowserTestUtils.browserLoaded(browser, false, url);
    BrowserTestUtils.startLoadingURIString(browser, url);
    await loaded;
  };
  const back = async url => {
    const changed = BrowserTestUtils.waitForLocationChange(gBrowser, url);
    browser.goBack();
    await changed;
  };
  try {
    await load(`${base}?b`);
    await load(`${base}?c`);
    await back(`${base}?b`);
    await back(`${base}?a`);
    await load(`${base}?d`);
    await load(`${base}?e`);
    await w10SurfaceShot("trail", "whimsy-trail", () => WhimsyTrails.openTrail(window, document.getElementById("back-button")));
  } finally {
    BrowserTestUtils.removeTab(tab);
    await SpecialPowers.popPrefEnv();
  }
});

// W10-25: a tab with a typed form (its glyph in the sidebar) beside a tab
// protected by hand (its lock), the unload question, and the refill offer.
add_task(async function w10_form_protection() {
  const { WhimsyFormProtection } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyFormProtection.sys.mjs");
  const { WhimsyToast } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyToast.sys.mjs");
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.com/?w10-form");
  const other = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.org/");
  try {
    WhimsyFormProtection.updateTabProtection(tab, true);
    // Protected by hand with nothing typed: the lock.
    WhimsyFormProtection.toggleTabProtection(other);
    const toast = WhimsyToast.current(window);
    if (toast) {
      WhimsyToast._dismissNow(toast);
    }
    for (const dark of [0, 1]) {
      await setScheme(dark);
      await settled();
      await shot(`w10-form-marker-${dark ? "dark" : "light"}`);
      await SpecialPowers.popPrefEnv();
    }
    WhimsyFormProtection.toggleTabProtection(other);
    let unloading = null;
    await w10SurfaceShot("form-unload", "whimsy-form-unload", () => {
      unloading = WhimsyFormProtection.confirmUnload(window, [tab]);
    });
    await unloading;
    await BrowserTestUtils.switchTab(gBrowser, tab);
    await w10ToastShot("form-refill", () => WhimsyToast.show(window, {
      l10nId: "whimsy-form-refill-ask", l10nArgs: { count: 3 },
      detailL10nId: "whimsy-form-refill-ask-detail",
      icon: "chrome://browser/content/whimsy/whimsy-form-badge.svg", timeout: 0,
      action: { l10nId: "whimsy-form-refill-fill", onCommand: () => {} },
    }));
  } finally {
    WhimsyFormProtection.updateTabProtection(tab, false);
    BrowserTestUtils.removeTab(other);
    BrowserTestUtils.removeTab(tab);
  }
});

// W10-16: Change User Agent… with Site Settings off (just Pretend to Be).
add_task(async function w10_pretend_only() {
  const { WhimsySiteSettings } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsySiteSettings.sys.mjs");
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.com/?w10-pretend");
  try {
    await w10SurfaceShot("pretend-only", "whimsy-pretend-panel", () => WhimsySiteSettings.openPretend(window));
  } finally {
    BrowserTestUtils.removeTab(tab);
  }
});

// W10-27: the command bar caught mid-open (60 of 160ms), light and dark, to
// check the scale-and-fade reads as one subtle step from the top edge.
add_task(async function w10_command_bar_motion() {
  const { UrlbarTestUtils } = ChromeUtils.importESModule("resource://testing-common/UrlbarTestUtils.sys.mjs");
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.com/");
  gReduceMotionOverride = false;
  try {
    for (const dark of [0, 1]) {
      await setScheme(dark);
      gURLBar.blur();
      await SimpleTest.promiseFocus(window);
      document.getElementById("Browser:OpenLocation").doCommand();
      await UrlbarTestUtils.promiseAutocompleteResultPopup({ window, waitForFocus: SimpleTest.waitForFocus, value: "whimsy" });
      const open = await TestUtils.waitForCondition(
        () => gURLBar.getAnimations().find(a => a.id == "whimsy-command-bar-open"), "The bar animates open");
      open.pause();
      open.currentTime = 60;
      await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
      await shot(`w10-command-bar-opening-${dark ? "dark" : "light"}`);
      open.finish();
      await settled();
      await shot(`w10-command-bar-open-${dark ? "dark" : "light"}`);
      await UrlbarTestUtils.promisePopupClose(window);
      gURLBar.blur();
      await TestUtils.waitForCondition(() => !gURLBar.hasAttribute("whimsy-closing"), "The bar has closed");
      await SpecialPowers.popPrefEnv();
    }
  } finally {
    gReduceMotionOverride = undefined;
    BrowserTestUtils.removeTab(tab);
  }
});

// W10-20: the selected-text menu, regrouped, and its Quick Actions ▸
// submenu open, light and dark. (A native NSMenu in the app; the shot shows
// it where the build draws XUL menus.)
add_task(async function w10_selection_menu() {
  const page = getRootDirectory(gTestPath).replace("chrome://mochitests/content", "https://example.com") + "whimsy_verbs.html";
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, page);
  try {
    for (const dark of [0, 1]) {
      await setScheme(dark);
      await SpecialPowers.spawn(tab.linkedBrowser, [], () => {
        const range = content.document.createRange();
        range.selectNodeContents(content.document.getElementById("event"));
        content.getSelection().removeAllRanges();
        content.getSelection().addRange(range);
      });
      const menu = document.getElementById("contentAreaContextMenu");
      const shown = BrowserTestUtils.waitForEvent(menu, "popupshown");
      await BrowserTestUtils.synthesizeMouseAtCenter("#event", { type: "contextmenu", button: 2 }, tab.linkedBrowser);
      await shown;
      await document.l10n.translateFragment(menu);
      await settled();
      await shot(`w10-selection-menu-${dark ? "dark" : "light"}`);
      const quick = document.getElementById("context-whimsy-quick-actions");
      if (quick && !quick.hidden && quick.getAttribute("collapsed") != "true") {
        const sub = BrowserTestUtils.waitForEvent(quick.menupopup, "popupshown");
        quick.openMenu(true);
        await sub;
        await settled();
        await shot(`w10-selection-menu-quick-actions-${dark ? "dark" : "light"}`);
      }
      const hidden = BrowserTestUtils.waitForEvent(menu, "popuphidden");
      menu.hidePopup();
      await hidden;
      await SpecialPowers.popPrefEnv();
    }
  } finally {
    BrowserTestUtils.removeTab(tab);
  }
});

// W10-21: Settings → Menus as one card (menus on the left, Selected Text's
// rows on the right), light and dark; and a menu with every row off.
add_task(async function w10_settings_menus() {
  for (const dark of [0, 1]) {
    await setScheme(dark);
    await BrowserTestUtils.withNewTab("about:preferences#whimsyMenus-selection", async browser => {
      const doc = browser.contentDocument;
      const card = await TestUtils.waitForCondition(() => doc.querySelector(".whimsy-menus-card"), "The card is built");
      const detail = doc.getElementById("whimsyMenus-selection");
      await TestUtils.waitForCondition(() => detail.checkVisibility(), "Selected Text shows");
      await TestUtils.waitForCondition(
        () => [...detail.querySelectorAll(".whimsy-menus-row-label")].every(l => l.textContent.trim()), "Rows are named");
      await doc.l10n.translateFragment(card);
      card.scrollIntoView({ block: "start" });
      await settled(doc);
      await shot(`w10-settings-menus-${dark ? "dark" : "light"}`, browser.browsingContext.currentWindowGlobal);
      const { WhimsyMenuPrefs } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyMenuPrefs.sys.mjs");
      for (const item of WhimsyMenuPrefs.items("folder")) {
        WhimsyMenuPrefs.setHidden("folder", item.id, true);
      }
      doc.getElementById("whimsyMenusNav-folder").click();
      await TestUtils.waitForCondition(() => doc.getElementById("whimsyMenus-folder-note").textContent.trim(), "All-off note");
      await shot(`w10-settings-menus-all-off-${dark ? "dark" : "light"}`, browser.browsingContext.currentWindowGlobal);
      WhimsyMenuPrefs.restoreDefaults("folder");
    });
    await SpecialPowers.popPrefEnv();
  }
  Services.prefs.clearUserPref("whimsy.menus.settings-last");
});

// W10-22: Settings search for "trails": the one row boxed and tagged, the
// rest of its group folded, the breadcrumb and count; light and dark.
add_task(async function w10_settings_search() {
  for (const dark of [0, 1]) {
    await setScheme(dark);
    await BrowserTestUtils.withNewTab("about:preferences#home", async browser => {
      const doc = browser.contentDocument;
      const win = browser.contentWindow;
      await win.gSearchResultsPane.initializeCategories();
      for (const query of ["trails", "trailzzqx"]) {
        const done = BrowserTestUtils.waitForEvent(win, "PreferencesSearchCompleted", false, e => e.detail == query);
        const input = doc.getElementById("searchInput");
        input.value = query;
        input.dispatchEvent(new win.InputEvent("input", { bubbles: true }));
        await done;
        await doc.l10n.ready;
        await settled(doc);
        await new Promise(r => setTimeout(r, 400)); // eslint-disable-line mozilla/no-arbitrary-setTimeout
        await shot(`w10-settings-search-${query == "trails" ? "trails" : "none"}-${dark ? "dark" : "light"}`,
          browser.browsingContext.currentWindowGlobal);
      }
    });
    await SpecialPowers.popPrefEnv();
  }
});

// W10-28: Settings → AI, light and dark: Enable AI, the provider cards with
// Claude's key field (left-aligned in its grid), the features; then AI off.
add_task(async function w10_settings_ai() {
  for (const dark of [0, 1]) {
    await setScheme(dark);
    await SpecialPowers.pushPrefEnv({ set: [["whimsy.ai.provider", "claude"]] });
    await BrowserTestUtils.withNewTab("about:preferences#whimsyAI", async browser => {
      const doc = browser.contentDocument;
      const header = await TestUtils.waitForCondition(() => doc.getElementById("whimsyAICategory"));
      await TestUtils.waitForCondition(() => doc.getElementById("whimsyAIEnable")?.checkVisibility(), "The AI pane shows");
      await TestUtils.waitForCondition(() => doc.getElementById("whimsyAIClaudeStatus").textContent, "Claude's status");
      await doc.l10n.translateFragment(doc.getElementById("mainPrefPane"));
      header.scrollIntoView({ block: "start" });
      await settled(doc);
      await shot(`w10-settings-ai-${dark ? "dark" : "light"}`, browser.browsingContext.currentWindowGlobal);
      doc.getElementById("whimsyAIFeaturesGroup").scrollIntoView({ block: "start" });
      await settled(doc);
      await shot(`w10-settings-ai-features-${dark ? "dark" : "light"}`, browser.browsingContext.currentWindowGlobal);
      Services.prefs.setBoolPref("whimsy.ai.enabled", false);
      await TestUtils.waitForCondition(() => !doc.getElementById("whimsyAIOffNote").hidden, "AI off");
      header.scrollIntoView({ block: "start" });
      await settled(doc);
      await shot(`w10-settings-ai-off-${dark ? "dark" : "light"}`, browser.browsingContext.currentWindowGlobal);
      Services.prefs.clearUserPref("whimsy.ai.enabled");
    });
    await SpecialPowers.popPrefEnv();
    await SpecialPowers.popPrefEnv();
  }
});

// W10-26: the Quick Note card beside the sidebar, kept with the page, with
// a title and a few lines; light and dark.
add_task(async function w10_quick_note() {
  const { WhimsyNotes, gWhimsyNotesStore } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyNotesSection.sys.mjs");
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.com/");
  try {
    for (const dark of [0, 1]) {
      await setScheme(dark);
      const shown = BrowserTestUtils.waitForEvent(document, "popupshown", true, e => e.target.id == "whimsy-quick-note");
      const opening = WhimsyNotes.openQuickNote(window, { attach: true });
      await shown;
      const panel = await opening;
      panel.querySelector(".whimsy-quick-note-name").value = "Halloween potluck";
      const body = panel.querySelector(".whimsy-quick-note-body");
      body.value = "Bring a dish and a costume.\nKids' parade at 7.\n- pumpkin pie\n- cider";
      body.dispatchEvent(new InputEvent("input", { bubbles: true }));
      await TestUtils.waitForCondition(
        () => panel.querySelector(".whimsy-quick-note-attach").getAttribute("aria-checked") == "true", "Kept with the page");
      await document.l10n.translateFragment(panel);
      await settled();
      await shot(`w10-quick-note-${dark ? "dark" : "light"}`);
      const gone = TestUtils.waitForCondition(() => !panel.isConnected);
      panel.querySelector(".whimsy-quick-note-done").doCommand();
      await gone;
      await settled();
      await shot(`w10-quick-note-saved-toast-${dark ? "dark" : "light"}`);
      for (const note of await gWhimsyNotesStore.list()) {
        if (note.title == "Halloween potluck") {
          await gWhimsyNotesStore.remove(note.id);
        }
      }
      await SpecialPowers.popPrefEnv();
    }
  } finally {
    BrowserTestUtils.removeTab(tab);
  }
});

// W10-29: Mini's ⌘⇧O: the address strip as the search field, the flat
// list under it (profile labels trailing), and a typed filter; light and dark.
add_task(async function w10_mini_space_search() {
  const { WhimsyQuickWindow } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyQuickWindow.sys.mjs");
  const { WhimsyProfiles } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyProfiles.sys.mjs");
  const { ContextualIdentityService } = ChromeUtils.importESModule(
    "moz-src:///toolkit/components/contextualidentity/ContextualIdentityService.sys.mjs"
  );
  const work = WhimsyProfiles.create("Screens Search Work");
  const space = await gZenWorkspaces.createAndSaveWorkspace("Quarterly Plans", undefined, true, work);
  try {
    for (const dark of [0, 1]) {
      await setScheme(dark);
      const win = WhimsyQuickWindow.open("https://example.com/", { opener: window });
      try {
        await WhimsyQuickWindow.whenReady(win);
        await SimpleTest.promiseFocus(win);
        const doc = win.document;
        doc.getElementById("whimsy-quick-window-choose-space").doCommand();
        const panel = await TestUtils.waitForCondition(() => {
          const p = doc.getElementById("whimsy-quick-window-space-picker");
          return p?.state == "open" && p;
        }, "The list drops down");
        await doc.l10n.translateFragment(doc.documentElement);
        await settled(doc);
        await shot(`w10-mini-space-search-${dark ? "dark" : "light"}`, win.browsingContext.currentWindowGlobal);
        const input = doc.getElementById("whimsy-mini-picker-search");
        input.value = "quar";
        input.dispatchEvent(new win.InputEvent("input", { bubbles: true }));
        await settled(doc);
        await shot(`w10-mini-space-search-typed-${dark ? "dark" : "light"}`, win.browsingContext.currentWindowGlobal);
        panel.hidePopup();
      } finally {
        await BrowserTestUtils.closeWindow(win);
      }
      await SpecialPowers.popPrefEnv();
    }
  } finally {
    await gZenWorkspaces.removeWorkspace(space.uuid);
    ContextualIdentityService.remove(work);
  }
});
