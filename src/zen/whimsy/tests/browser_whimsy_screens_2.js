/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// Whimsy: a screenshot tool, so changes can be checked by eye without macOS
// Screen Recording permission. It draws the real window from inside Gecko.
//   WHIMSY_SHOTS=/some/dir npm test -- ui/browser_whimsy_screens_2.js
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


// Helpers shared with browser_whimsy_screens.js (split for the per-file
// time limit; the shots are the same).
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

// wave5: Easel, light and dark: text, a drawing, shapes, a link and a
// selected capture with its bar, plus the empty state.
add_task(async function wave5_easel() {
  const { WhimsyEasel, gWhimsyEaselStore } = ChromeUtils.importESModule(
    "resource:///modules/whimsy/WhimsyEasel.sys.mjs"
  );
  for (const dark of [0, 1]) {
    await SpecialPowers.pushPrefEnv({
      set: [
        ["whimsy.feature.easel", true],
        ["ui.systemUsesDarkTheme", dark],
        ["ui.prefersReducedMotion", 1],
      ],
    });
    const scheme = dark ? "dark" : "light";
    const empty = await WhimsyEasel.newEasel(window);
    const easel = await gWhimsyEaselStore.create({ title: "Weekend in Lisbon" });
    try {
      let browser = gBrowser.selectedBrowser;
      await TestUtils.waitForCondition(() => browser.contentDocument?.documentElement?.getAttribute("ready") == "true");
      await shot(`wave5-easel-empty-${scheme}`, browser.browsingContext.currentWindowGlobal);
      gBrowser.unpinTab(gBrowser.selectedTab);
      BrowserTestUtils.removeTab(gBrowser.selectedTab);

      const pageTab = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.com/");
      const capture = await WhimsyEasel.captureRegion(pageTab.linkedBrowser, {
        region: { left: 0, top: 0, right: 640, bottom: 300 },
        devicePixelRatio: 2,
        viewportWidth: 1280,
        viewportHeight: 800,
      });
      BrowserTestUtils.removeTab(pageTab);
      const image = await gWhimsyEaselStore.saveImage(easel.id, new Uint8Array(await capture.blob.arrayBuffer()));
      const items = [
        { id: "t1", type: "text", x: 0, y: 0, w: 360, h: 58, text: "Weekend in Lisbon", font: "serif", size: 44, color: "ink", auto: false },
        { id: "t2", type: "text", x: 2, y: 70, w: 320, h: 24, text: "Pastéis, tram 28, sunset at the miradouro", font: "sans", size: 18, color: "gray", auto: false },
        { id: "c1", type: "capture", ...capture.item, image, x: 0, y: 130, w: 420, h: 197 },
        { id: "s1", type: "shape", shape: "rect", x: 470, y: 130, w: 220, h: 120, color: "orange", width: 4, fill: "tint" },
        { id: "s2", type: "shape", shape: "arrow", x: 430, y: 255, w: 90, h: 60, color: "purple", width: 4, fill: null, flipX: true, flipY: false },
        { id: "p1", type: "pen", x: 490, y: 160, w: 180, h: 60, vw: 180, vh: 60, d: "M4 40Q30 6 60 30Q90 54 120 24Q150 2 176 30", color: "blue", width: 4 },
        { id: "h1", type: "pen", x: 0, y: 64, w: 230, h: 36, vw: 230, vh: 36, d: "M8 18L222 18", color: "yellow", width: 16, highlighter: true },
        { id: "l1", type: "link", x: 470, y: 280, w: 300, h: 72, url: "https://example.com/", title: "Example Domain" },
      ];
      await gWhimsyEaselStore.update(easel.id, { items, view: { x: 120, y: 120, zoom: 1 } });
      const tab = WhimsyEasel.openEasel(window, easel.id);
      browser = tab.linkedBrowser;
      await TestUtils.waitForCondition(() => browser.contentDocument?.documentElement?.getAttribute("ready") == "true");
      const app = browser.contentWindow.gWhimsyEasel;
      app.select(["c1"]);
      await TestUtils.waitForCondition(() => [...browser.contentDocument.images].every(i => i.complete));
      await new Promise(r => browser.contentWindow.requestAnimationFrame(() => browser.contentWindow.requestAnimationFrame(r)));
      await shot(`wave5-easel-${scheme}`, browser.browsingContext.currentWindowGlobal);
      BrowserTestUtils.removeTab(tab);
    } finally {
      await gWhimsyEaselStore.remove(easel.id);
      await gWhimsyEaselStore.remove(empty.id);
      await SpecialPowers.popPrefEnv();
    }
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

// wave5/profiles: Settings → Profiles and the Profile Name sheet (with its
// inline error), light and dark.
add_task(async function profiles_ui() {
  const { WhimsyProfiles } = ChromeUtils.importESModule(
    "resource:///modules/whimsy/WhimsyProfiles.sys.mjs"
  );
  const { ContextualIdentityService } = ChromeUtils.importESModule(
    "moz-src:///toolkit/components/contextualidentity/ContextualIdentityService.sys.mjs"
  );
  const work = WhimsyProfiles.create("Screens Work");
  const space = await gZenWorkspaces.createAndSaveWorkspace("Screens Work Space", undefined, true, work);
  try {
    for (const dark of [0, 1]) {
      const scheme = dark ? "dark" : "light";
      await SpecialPowers.pushPrefEnv({ set: [["ui.systemUsesDarkTheme", dark]] });
      await BrowserTestUtils.withNewTab("about:preferences#zenTabManagement", async browser => {
        const doc = browser.contentDocument;
        const group = await TestUtils.waitForCondition(() => doc.getElementById("whimsyProfilesGroup"));
        await TestUtils.waitForCondition(() => group.checkVisibility(), "Profiles group visible");
        group.scrollIntoView({ block: "start" });
        await new Promise(resolve => browser.contentWindow.requestAnimationFrame(resolve));
        await shot(`wave5-profiles-settings-${scheme}`, browser.browsingContext.currentWindowGlobal);

        doc.getElementById("whimsyProfilesCreate").doCommand();
        const form = doc.querySelector("#whimsyProfilesCreateSlot .whimsy-profile-name-form");
        form.querySelector("input").value = "screens work";
        form.requestSubmit();
        await TestUtils.waitForCondition(() => !form.querySelector(".whimsy-profile-name-error").hidden);
        form.scrollIntoView({ block: "center" });
        await new Promise(resolve => browser.contentWindow.requestAnimationFrame(resolve));
        await shot(`wave5-profiles-settings-error-${scheme}`, browser.browsingContext.currentWindowGlobal);
      });

      const pending = WhimsyProfiles.promptName(window, {});
      const panel = await TestUtils.waitForCondition(() => {
        const p = document.getElementById("whimsy-profile-name-panel");
        return p?.state == "open" && p;
      });
      panel.querySelector(".whimsy-profile-name-input").value = "Screens Work";
      EventUtils.synthesizeKey("KEY_Enter", {}, window);
      await TestUtils.waitForCondition(() => !panel.querySelector(".whimsy-profile-name-error").hidden);
      await new Promise(resolve => requestAnimationFrame(resolve));
      await shot(`wave5-profiles-name-sheet-${scheme}`);
      panel.hidePopup();
      is(await pending, null, "Closed without creating");
      await SpecialPowers.popPrefEnv();
    }
  } finally {
    await gZenWorkspaces.removeWorkspace(space.uuid);
    ContextualIdentityService.remove(work);
  }
});

// wave6/zap: zap mode entered with Whimsy's command (Zen's zap bar, one zap
// listed for restore).
add_task(async function wave6_zap_mode() {
  const { gZenBoostsManager } = ChromeUtils.importESModule("resource:///modules/zen/boosts/ZenBoostsManager.sys.mjs");
  const { WhimsyZap } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyZap.sys.mjs");
  await SpecialPowers.pushPrefEnv({
    set: [
      ["whimsy.feature.zap", true],
      ["zen.boosts.enabled", true],
      ["zen.boosts.dissolve-on-zap", false],
    ],
  });
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.com/");
  try {
    document.getElementById(WhimsyZap.COMMAND_ID).doCommand();
    const bar = await TestUtils.waitForCondition(
      () => tab.linkedBrowser.closest(".browserContainer")?.querySelector("zen-zap-bar"),
      "The zap bar shows"
    );
    gZenBoostsManager.addZapSelectorToActive("h1", "example.com");
    await TestUtils.waitForCondition(() => bar.entries?.length == 1, "The zap is listed");
    await bar.updateComplete;
    await new Promise(resolve => setTimeout(resolve, 300));
    ok(bar.checkVisibility(), "The zap bar is visible");
    await shot("wave6-zap-mode");
    document.getElementById(WhimsyZap.COMMAND_ID).doCommand();
    await TestUtils.waitForCondition(() => !bar.isConnected, "Zap mode ends");
  } finally {
    for (const boost of gZenBoostsManager.loadBoostsFromStore("example.com") ?? []) {
      gZenBoostsManager.deleteBoost(boost);
    }
    BrowserTestUtils.removeTab(tab);
    await SpecialPowers.popPrefEnv();
  }
});

// wave6/zap: Link hints on a page (badges in the space's accent, help pill).
add_task(async function wave6_link_hints() {
  const { WhimsyLinkHints } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyLinkHints.sys.mjs");
  await SpecialPowers.pushPrefEnv({ set: [["whimsy.feature.link-hints", true]] });
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.com/");
  const browser = tab.linkedBrowser;
  const peek = () =>
    browser.browsingContext.currentWindowGlobal.getActor("WhimsyLinkHints").sendQuery("Whimsy:Hints:Peek");
  try {
    await SpecialPowers.spawn(browser, [], () => {
      const doc = content.document;
      doc.body.innerHTML = `
        <h1>Reading list</h1>
        <p><a href="#a">An essay on calm technology</a> and <a href="#b">a follow-up</a>.</p>
        <nav><a href="#c">Home</a> · <a href="#d">Archive</a> · <a href="#e">About</a></nav>
        <p><button>Subscribe</button> <input placeholder="Search" aria-label="Search"></p>`;
    });
    document.getElementById(WhimsyLinkHints.COMMAND_ID).doCommand();
    await TestUtils.waitForCondition(async () => (await peek()).active, "Hints show");
    await new Promise(resolve => setTimeout(resolve, 400));
    const { labels } = await peek();
    Assert.greaterOrEqual(labels.length, 7, "Every link, the button and the field have a badge");
    await shot("wave6-link-hints", browser.browsingContext.currentWindowGlobal);
    EventUtils.synthesizeKey("KEY_Escape", {}, window);
    await TestUtils.waitForCondition(async () => !(await peek()).active, "Esc puts them away");
  } finally {
    BrowserTestUtils.removeTab(tab);
    await SpecialPowers.popPrefEnv();
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
