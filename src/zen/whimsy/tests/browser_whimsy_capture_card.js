/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// W15 screenshots: one viewer, one save. After a drag the page's toolbar
// is one Capture button (Enter does the same; Esc closes Screenshots). Capture, Visible, Full Page
// and Portrait all open Firefox's preview with Retry · Add to Easel ·
// Copy · Download · Edit · Save and Close · Cancel. Copy and Download keep
// it open and write no Library file; Save and Close writes exactly one and
// shows the Library's Screenshots. The editor (W13 F04: Backdrop, Shape,
// Hide private details, Redact by hand) keeps Copy and Download open, ✕
// discards, Done goes back to the viewer with the edits, Save and Close
// saves once. A Library screenshot's Edit has Save (that file) and Save
// Copy (a new one). A private page's viewer can't save.

requestLongerTimeout(4);

const { WhimsyCaptureCard, layoutFor } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyCaptureCard.sys.mjs");
const { WhimsyRedact } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyRedactParent.sys.mjs");
const { WhimsyCommands } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyCommands.sys.mjs");
const { WhimsyPrivate } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyPrivate.sys.mjs");
const { listCaptures } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyFilesSection.sys.mjs");
const { ScreenshotsUtils } = ChromeUtils.importESModule("moz-src:///browser/components/screenshots/ScreenshotsUtils.sys.mjs");
const { Downloads } = ChromeUtils.importESModule("resource://gre/modules/Downloads.sys.mjs");
const { globalActions } = ChromeUtils.importESModule("resource:///modules/ZenUBGlobalActions.sys.mjs");
const PAGE = getRootDirectory(gTestPath).replace("chrome://mochitests/content", "https://example.com") + "whimsy_redact.html";

const SAVED_METHOD_PREF = "screenshots.browser.component.last-saved-method";
const LAST_METHOD_PREF = "screenshots.browser.component.last-screenshot-method";
const VIEWER_ORDER = ["retry", "whimsy-capture-easel", "copy", "download", "whimsy-capture-edit", "whimsy-capture-save-close", "cancel"];

const editor = () => document.getElementById("whimsy-capture-editor");
const openEditor = () => TestUtils.waitForCondition(() => (editor()?.state == "open" ? editor() : null), "The editor opens");
const footerButton = (ed, name) => ed.querySelector(`.whimsy-surface-footer [data-action="${name}"]`);
const added = [];

function restorePref(name) {
  const had = Services.prefs.prefHasUserValue(name);
  const value = had ? Services.prefs.getStringPref(name) : null;
  registerCleanupFunction(() => (had ? Services.prefs.setStringPref(name, value) : Services.prefs.clearUserPref(name)));
}

add_setup(async function () {
  const dir = PathUtils.join(PathUtils.tempDir, `whimsy-capture-downloads-${Date.now()}`);
  await IOUtils.makeDirectory(dir);
  await SpecialPowers.pushPrefEnv({
    set: [
      ["screenshots.browser.component.enabled", true],
      ["whimsy.feature.redact", true],
      ["whimsy.feature.capture-card", true],
      ["whimsy.capture.redact-style", "black"],
      ["whimsy.capture.backdrop", "none"],
      ["whimsy.capture.shape", "auto"],
      ["browser.download.useDownloadDir", true],
      ["browser.download.folderList", 2],
      ["browser.download.dir", dir],
      // The downloads panel would open over the viewer and take the next click.
      ["browser.download.alwaysOpenPanel", false],
    ],
  });
  // Copying and taking screenshots make Screenshots itself remember the
  // method used; restore those, as they're not ours.
  restorePref(SAVED_METHOD_PREF);
  restorePref(LAST_METHOD_PREF);
  const known = new Set(listCaptures().map(f => f.path));
  registerCleanupFunction(async () => {
    for (const file of listCaptures()) {
      if (!known.has(file.path)) {
        await IOUtils.remove(file.path, { ignoreAbsent: true });
      }
    }
    const list = await Downloads.getList(Downloads.PUBLIC);
    for (const download of await list.getAll()) {
      await list.remove(download);
      await download.finalize(true);
    }
    await IOUtils.remove(dir, { recursive: true, ignoreAbsent: true });
    for (const tab of added) {
      if (tab.isConnected) {
        BrowserTestUtils.removeTab(tab);
      }
    }
  });
});

async function openTab(url = PAGE, win = window) {
  const tab = await BrowserTestUtils.openNewForegroundTab(win.gBrowser, url);
  added.push(tab);
  return tab;
}

function newFiles(before) {
  const known = new Set(before.map(f => f.path));
  return listCaptures().filter(f => !known.has(f.path));
}

async function downloadCount() {
  return (await (await Downloads.getList(Downloads.PUBLIC)).getAll()).length;
}

// The Screenshots bar and overlay, ready for input.
async function startScreenshots(browser) {
  await ScreenshotsUtils.start(browser, "Shortcut");
  await TestUtils.waitForCondition(() => {
    const panel = ScreenshotsUtils.panelForBrowser(browser);
    return panel && !panel.hidden && panel.querySelector("screenshots-buttons")?.shadowRoot?.getElementById("visible-page");
  }, "The Screenshots bar shows");
  await TestUtils.waitForCondition(
    () => SpecialPowers.spawn(browser, [], () => !!content.windowGlobalChild.getExistingActor("ScreenshotsComponent")?.overlay?.initialized),
    "The overlay is up"
  );
}

function bar(browser) {
  return ScreenshotsUtils.panelForBrowser(browser).querySelector("screenshots-buttons").shadowRoot;
}

function overlayState(browser) {
  return SpecialPowers.spawn(browser, [], () => content.windowGlobalChild.getActor("ScreenshotsComponent").overlay.state);
}

async function mouse(browser, type, x, y) {
  await BrowserTestUtils.synthesizeMouse(":root", x, y, { type }, browser.browsingContext);
}

// Drags a region on the page, as a person does.
async function drag(browser, [x1, y1, x2, y2]) {
  await TestUtils.waitForCondition(async () => (await overlayState(browser)) == "crosshairs", "Ready to select");
  await mouse(browser, "mousedown", x1, y1);
  await mouse(browser, "mousemove", (x1 + x2) / 2, (y1 + y2) / 2);
  await mouse(browser, "mousemove", x2, y2);
  await mouse(browser, "mouseup", x2, y2);
  await TestUtils.waitForCondition(async () => (await overlayState(browser)) == "selected", "A region is selected");
}

// The page toolbar's buttons a person can see, and the Capture button's centre.
function pageToolbar(browser) {
  return SpecialPowers.spawn(browser, [], async () => {
    const overlay = content.windowGlobalChild.getActor("ScreenshotsComponent").overlay;
    await ContentTaskUtils.waitForCondition(() => overlay.getElementById("whimsy-capture-confirm"), "The Capture button");
    const shown = [...overlay.buttonsContainer.querySelectorAll("button")].filter(b => {
      const r = b.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    });
    const r = overlay.getElementById("whimsy-capture-confirm").getBoundingClientRect();
    return { shown: shown.map(b => b.id), x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
}

async function pressCapture(browser) {
  const { x, y } = await pageToolbar(browser);
  await mouse(browser, "mousedown", x, y);
  await mouse(browser, "mouseup", x, y);
}

// The viewer, once Whimsy has decorated it.
async function viewer(browser) {
  const dialog = await TestUtils.waitForCondition(() => ScreenshotsUtils.browserToScreenshotsState.get(browser)?.previewDialog,
    "The viewer opens");
  await dialog._dialogReady;
  const preview = await TestUtils.waitForCondition(() => dialog._frame.contentDocument?.querySelector("screenshots-preview"));
  const root = await TestUtils.waitForCondition(() =>
    preview.renderRoot?.getElementById?.("whimsy-capture-save-close") && preview.renderRoot, "…with Whimsy's buttons");
  await TestUtils.waitForCondition(() => preview.previewImg.complete && preview.previewImg.naturalWidth > 0, "…showing the image");
  const win = dialog._frame.contentWindow;
  const capture = WhimsyCaptureCard.viewerOf(window);
  return {
    dialog,
    preview,
    root,
    capture,
    win,
    button: id => root.getElementById(id),
    shown: () => [...root.querySelector(".preview-buttons").children]
      .filter(el => el.localName == "moz-button" && el.getBoundingClientRect().width > 0)
      .map(el => el.id),
    // Zen's toasts (Copied, a download) sit over the viewer's top end for a moment.
    click: async id => {
      await TestUtils.waitForCondition(() => !document.querySelector(".zen-toast"), "No toast over the viewer", 100, 100);
      EventUtils.synthesizeMouseAtCenter(root.getElementById(id), {}, win);
    },
  };
}

// W16-16: one overlay at a time; the viewer hides while the editor is open.
function viewerHidden(v, hidden, when) {
  const overlay = v.dialog._overlay;
  is(getComputedStyle(overlay).visibility, hidden ? "hidden" : "visible", `${when}: the viewer is ${hidden ? "hidden" : "shown"}`);
  is(overlay.inert, hidden, `…and ${hidden ? "" : "not "}inert`);
}

function viewerOpen(browser) {
  return !!ScreenshotsUtils.browserToScreenshotsState.get(browser)?.previewDialog;
}

async function closeViewer(browser, v) {
  await v.click("cancel");
  await TestUtils.waitForCondition(() => !ScreenshotsUtils.browserToScreenshotsState.has(browser), "Cancel closes the viewer");
}


async function pixelAt(blob, fx, fy) {
  const bitmap = await createImageBitmap(blob);
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  canvas.getContext("2d").drawImage(bitmap, 0, 0);
  return [...canvas.getContext("2d").getImageData(Math.round(bitmap.width * fx), Math.round(bitmap.height * fy), 1, 1).data.slice(0, 3)];
}

// Draws a box over the editor's preview, from and to fractions of it.
function drawBox(ed, [fx1, fy1, fx2, fy2]) {
  const preview = ed.querySelector(".whimsy-capture-preview");
  const p = preview.getBoundingClientRect();
  const from = { x: p.left + p.width * fx1, y: p.top + p.height * fy1 };
  const to = { x: p.left + p.width * fx2, y: p.top + p.height * fy2 };
  EventUtils.synthesizeMouseAtPoint(from.x, from.y, { type: "mousedown" });
  EventUtils.synthesizeMouseAtPoint((from.x + to.x) / 2, (from.y + to.y) / 2, { type: "mousemove" });
  EventUtils.synthesizeMouseAtPoint(to.x, to.y, { type: "mousemove" });
  EventUtils.synthesizeMouseAtPoint(to.x, to.y, { type: "mouseup" });
  const mid = { x: (fx1 + fx2) / 2, y: (fy1 + fy2) / 2 };
  const px = preview.getContext("2d").getImageData(Math.round(mid.x * preview.width), Math.round(mid.y * preview.height), 1, 1).data;
  return { mid, preview: [...px.slice(0, 3)] };
}

add_task(function test_defaults_and_layout() {
  ok(Services.prefs.getDefaultBranch("").getBoolPref("whimsy.capture.redact"), "Hide private details is on by default");
  Assert.deepEqual(layoutFor(400, 200), { width: 400, height: 200, x: 0, y: 0, radius: 0 }, "No backdrop, Auto: the image as it is");
  const square = layoutFor(400, 200, { backdrop: "white", shape: "1:1" });
  is(square.width, square.height, "1:1 is square");
  Assert.greater(square.x, 0, "…with the image inset");
  const wide = layoutFor(300, 300, { backdrop: "dark", shape: "16:9" });
  Assert.less(Math.abs(wide.width / wide.height - 16 / 9), 0.01, "16:9");
  const tall = layoutFor(300, 300, { backdrop: "gradient", shape: "4:5" });
  Assert.less(Math.abs(tall.width / tall.height - 4 / 5), 0.01, "4:5");
});

// 1: after a drag, one button; it opens the viewer. One Esc closes (W16-15).
add_task(async function test_a_drag_shows_one_capture_button() {
  const tab = await openTab();
  const browser = tab.linkedBrowser;
  await startScreenshots(browser);
  await drag(browser, [20, 20, 420, 260]);
  const { shown } = await pageToolbar(browser);
  Assert.deepEqual(shown, ["whimsy-capture-confirm"], "The page's toolbar has exactly one button: Capture");

  // W16-15: with a box drawn, one Esc closes Screenshots (Firefox's first
  // Esc only dropped the box).
  await BrowserTestUtils.synthesizeKey("KEY_Escape", {}, browser.browsingContext);
  await TestUtils.waitForCondition(() => !ScreenshotsUtils.browserToScreenshotsState.has(browser), "One Esc closes Screenshots");

  const before = listCaptures();
  await startScreenshots(browser);
  await drag(browser, [20, 20, 420, 260]);
  await pressCapture(browser);
  const v = await viewer(browser);
  ok(v.preview, "Capture opens Firefox's screenshot preview");
  Assert.deepEqual(v.shown(), VIEWER_ORDER, "Retry · Add to Easel · Copy · Download · Edit · Save and Close · Cancel");
  const ratio = window.devicePixelRatio;
  Assert.less(Math.abs(v.preview.previewImg.naturalWidth - 400 * ratio), 2 * ratio, "…showing the region dragged");
  is(v.button("whimsy-capture-save-close").getAttribute("type"), "primary", "Save and Close is the main button");
  await closeViewer(browser, v);
  is(newFiles(before).length, 0, "Cancel saves nothing");
  BrowserTestUtils.removeTab(tab);
});

// 2: Visible, Full Page, Portrait and Capture open the same viewer.
add_task(async function test_every_way_in_opens_the_same_viewer() {
  const tab = await openTab();
  const browser = tab.linkedBrowser;
  for (const id of ["visible-page", "full-page", "whimsy-portrait"]) {
    await startScreenshots(browser);
    const tile = await TestUtils.waitForCondition(() => bar(browser).getElementById(id), `The bar has ${id}`);
    EventUtils.synthesizeMouseAtCenter(tile, {}, window);
    const v = await viewer(browser);
    Assert.deepEqual(v.shown(), VIEWER_ORDER, `${id}: the same viewer`);
    await closeViewer(browser, v);
  }
  BrowserTestUtils.removeTab(tab);
});

// 3: Copy and Download keep the viewer open and write no Library file.
add_task(async function test_copy_and_download_keep_the_viewer_open() {
  const tab = await openTab();
  const browser = tab.linkedBrowser;
  const before = listCaptures();
  await startScreenshots(browser);
  EventUtils.synthesizeMouseAtCenter(bar(browser).getElementById("visible-page"), {}, window);
  const v = await viewer(browser);

  Services.clipboard.emptyClipboard(Services.clipboard.kGlobalClipboard);
  await v.click("copy");
  await TestUtils.waitForCondition(
    () => Services.clipboard.hasDataMatchingFlavors(["image/png"], Services.clipboard.kGlobalClipboard), "Copy puts the image on the clipboard");
  await TestUtils.waitForCondition(() => v.win.document.l10n.getAttributes(v.button("copy")).id == "whimsy-capture-copied", "Copy says Copied");
  await new Promise(resolve => setTimeout(resolve, 300)); // eslint-disable-line mozilla/no-arbitrary-setTimeout
  ok(viewerOpen(browser), "…and the viewer stays open");

  const downloads = await downloadCount();
  await v.click("download");
  await TestUtils.waitForCondition(async () => (await downloadCount()) == downloads + 1, "Download makes one download");
  await TestUtils.waitForCondition(() => v.win.document.l10n.getAttributes(v.button("download")).id == "whimsy-capture-downloaded",
    "Download says Downloaded");
  ok(viewerOpen(browser), "…and the viewer stays open");
  is(newFiles(before).length, 0, "Neither wrote a file to the Library's Screenshots");
  await closeViewer(browser, v);
  BrowserTestUtils.removeTab(tab);
});

function library() {
  return document.querySelector("zen-library");
}

async function closeLibrary() {
  const lib = library();
  if (lib?.openProgress > 0) {
    await lib.constructor.animateProgress(0);
    await TestUtils.waitForCondition(() => lib.openProgress == 0 && !lib.hasAttribute("transitioning"), "The Library closes");
  }
}

function libraryShows(section) {
  const lib = library();
  return lib?.constructor.isLibraryOpen && lib.activeTab == section;
}

// 4: Save and Close writes exactly one file, closes, and shows the Library.
add_task(async function test_save_and_close_saves_once_and_shows_the_library() {
  await closeLibrary();
  const tab = await openTab();
  const browser = tab.linkedBrowser;
  for (const libraryWasOpen of [false, true]) {
    const before = listCaptures();
    await startScreenshots(browser);
    EventUtils.synthesizeMouseAtCenter(bar(browser).getElementById("visible-page"), {}, window);
    const v = await viewer(browser);
    if (libraryWasOpen) {
      // A click in the page puts Zen's Library away; saving directly doesn't.
      WhimsyCaptureCard.saveAndClose(v.capture);
    } else {
      await v.click("whimsy-capture-save-close");
    }
    await TestUtils.waitForCondition(() => newFiles(before).length == 1, "Save and Close writes a file");
    await TestUtils.waitForCondition(() => !ScreenshotsUtils.browserToScreenshotsState.has(browser), "…closes the viewer");
    await TestUtils.waitForCondition(() => libraryShows("whimsy-files"), "…and the Library shows Screenshots");
    // Settled, so the next viewer is sized for the page beside it.
    await TestUtils.waitForCondition(() => library().openProgress == 1 && !library().hasAttribute("transitioning"));
    if (libraryWasOpen) {
      await new Promise(resolve => setTimeout(resolve, 500)); // eslint-disable-line mozilla/no-arbitrary-setTimeout
      ok(libraryShows("whimsy-files"), "Already open there, it stays open");
    }
    is(newFiles(before).length, 1, "Exactly one file");
  }
  await closeLibrary();
  BrowserTestUtils.removeTab(tab);
});

// 5: Edit, a box, Done: nothing written; Save and Close then writes one file with the box.
add_task(async function test_done_keeps_the_edit_and_save_writes_it_once() {
  await SpecialPowers.pushPrefEnv({ set: [["whimsy.capture.redact", true]] });
  await closeLibrary();
  const tab = await openTab();
  const browser = tab.linkedBrowser;
  await startScreenshots(browser);
  ok(!bar(browser).getElementById("whimsy-redact"), "No Redact toggle in the bar: Redact comes after the capture");
  await TestUtils.waitForCondition(async () => (await WhimsyRedact.state(browser))?.active, "Private details are hidden while framing");
  await drag(browser, [0, 0, 700, 420]);
  await pressCapture(browser);
  const v = await viewer(browser);
  ok(!(await WhimsyRedact.state(browser))?.active, "The page is back to normal");
  const before = listCaptures();

  await v.click("whimsy-capture-edit");
  const ed = await openEditor();
  viewerHidden(v, true, "Edit");
  ok(ed.querySelector(".whimsy-surface-header").classList.contains("whimsy-surface-drag-handle"), "Its header drags it");
  ok(ed.querySelector("#whimsy-capture-hide").checked, "Hide private details is on, as captured");
  Assert.deepEqual([...ed.querySelectorAll(".whimsy-surface-footer [data-action]")].map(b => b.dataset.action),
    ["copy", "download", "done", "save-close"], "Copy · Download · Done · Save and Close");
  const preview = ed.querySelector(".whimsy-capture-preview");
  await TestUtils.waitForCondition(() => preview.width > 50, "The image is drawn");
  EventUtils.synthesizeMouseAtCenter(ed.querySelector(".whimsy-capture-hand"), {});
  is(ed.querySelector(".whimsy-capture-hand").getAttribute("aria-pressed"), "true", "Redact by hand is picked");
  // The fixture's "Plain: Nothing secret here" row is around y=300 of 420.
  const box = drawBox(ed, [0.1, 0.6, 0.5, 0.75]);
  Assert.deepEqual(box.preview, [0, 0, 0], "The box is blacked out in the preview");

  EventUtils.synthesizeMouseAtCenter(footerButton(ed, "done"), {});
  await TestUtils.waitForCondition(() => !editor(), "Done closes the editor");
  ok(viewerOpen(browser), "…back to the viewer");
  viewerHidden(v, false, "Done");
  const capture = WhimsyCaptureCard.viewerOf(window);
  ok(capture.edited, "The viewer has the edit");
  await TestUtils.waitForCondition(() => v.preview.previewImg.src == capture.editedURL && v.preview.previewImg.complete,
    "…and shows it");
  is(newFiles(before).length, 0, "Done writes nothing");

  // Editing again starts from the edit.
  await v.click("whimsy-capture-edit");
  const again = await openEditor();
  viewerHidden(v, true, "A second Edit");
  is(again.querySelector(".whimsy-capture-hint").getAttribute("data-l10n-id"), "whimsy-capture-hint", "Edit opens with no tool picked");
  EventUtils.synthesizeKey("KEY_Escape", {}, window);
  await TestUtils.waitForCondition(() => !editor(), "Esc closes it");
  ok(viewerOpen(browser), "…not the viewer");
  viewerHidden(v, false, "Esc");

  await v.click("whimsy-capture-save-close");
  await TestUtils.waitForCondition(() => newFiles(before).length == 1, "Save and Close writes one file");
  const [file] = newFiles(before);
  const bytes = await IOUtils.read(file.path);
  Assert.deepEqual(await pixelAt(new Blob([bytes]), box.mid.x, box.mid.y), [0, 0, 0], "…with the box in it");
  await TestUtils.waitForCondition(() => !ScreenshotsUtils.browserToScreenshotsState.has(browser), "The viewer closed");
  await closeLibrary();
  BrowserTestUtils.removeTab(tab);
  await SpecialPowers.popPrefEnv();
});

// 6: in the editor Copy and Download keep it open; ✕ discards and writes nothing.
add_task(async function test_editor_copy_download_stay_and_close_discards() {
  await SpecialPowers.pushPrefEnv({ set: [["whimsy.capture.redact", true]] });
  await closeLibrary();
  const tab = await openTab();
  const browser = tab.linkedBrowser;
  await startScreenshots(browser);
  await drag(browser, [0, 0, 600, 300]);
  await pressCapture(browser);
  const v = await viewer(browser);
  const before = listCaptures();

  const shownBefore = v.preview.previewImg.src;
  await v.click("whimsy-capture-edit");
  const ed = await openEditor();
  viewerHidden(v, true, "Edit");
  const white = ed.querySelector('.whimsy-capture-backdrop[data-backdrop="white"]');
  EventUtils.synthesizeMouseAtCenter(white, {});
  is(Services.prefs.getStringPref("whimsy.capture.backdrop"), "white", "The backdrop is remembered");
  is(white.getAttribute("aria-checked"), "true", "…and picked");
  EventUtils.synthesizeMouseAtCenter(ed.querySelector('.whimsy-surface-segment[data-value="1:1"]'), {});
  is(Services.prefs.getStringPref("whimsy.capture.shape"), "1:1", "The shape is remembered");

  Services.clipboard.emptyClipboard(Services.clipboard.kGlobalClipboard);
  EventUtils.synthesizeMouseAtCenter(footerButton(ed, "copy"), {});
  await TestUtils.waitForCondition(
    () => Services.clipboard.hasDataMatchingFlavors(["image/png"], Services.clipboard.kGlobalClipboard), "Copy copies the edit");
  const downloads = await downloadCount();
  EventUtils.synthesizeMouseAtCenter(footerButton(ed, "download"), {});
  await TestUtils.waitForCondition(async () => (await downloadCount()) == downloads + 1, "Download makes one download");
  const [download] = (await (await Downloads.getList(Downloads.PUBLIC)).getAll()).slice(-1);
  await TestUtils.waitForCondition(() => download.succeeded, "…which finishes");
  const square = await createImageBitmap(new Blob([await IOUtils.read(download.target.path)]));
  is(square.width, square.height, "1:1 came out square");
  is(editor()?.state, "open", "The editor stays open after both");

  // Hide private details off: the same region again, unhidden.
  const hide = ed.querySelector("#whimsy-capture-hide");
  EventUtils.synthesizeMouseAtCenter(hide, {});
  await TestUtils.waitForCondition(() => !hide.checked && !hide.disabled, "Off: the same region again, unhidden");
  ok(!Services.prefs.getBoolPref("whimsy.capture.redact"), "…and remembered for the next capture");
  ok(!(await WhimsyRedact.state(browser))?.active, "The page is left normal");

  EventUtils.synthesizeMouseAtCenter(ed.querySelector(".whimsy-surface-close"), {});
  await TestUtils.waitForCondition(() => !editor(), "✕ closes the editor");
  ok(!WhimsyCaptureCard.viewerOf(window).edited, "…without the edits");
  ok(viewerOpen(browser), "The viewer is still open");
  viewerHidden(v, false, "✕");
  is(v.preview.previewImg.src, shownBefore, "…showing what it did before Edit");
  is(newFiles(before).length, 0, "Nothing was written");
  await closeViewer(browser, v);
  BrowserTestUtils.removeTab(tab);
  await SpecialPowers.popPrefEnv();
});

async function pngFile(color) {
  const canvas = new OffscreenCanvas(120, 80);
  const c = canvas.getContext("2d");
  c.fillStyle = color;
  c.fillRect(0, 0, 120, 80);
  const dir = PathUtils.join(PathUtils.profileDir, Services.prefs.getStringPref("whimsy.captures.folder", "") || "whimsy-captures");
  await IOUtils.makeDirectory(dir, { ignoreExisting: true });
  const path = PathUtils.join(dir, `whimsy-capture-edit-test-${Date.now()}.png`);
  await IOUtils.write(path, new Uint8Array(await (await canvas.convertToBlob()).arrayBuffer()));
  Services.obs.notifyObservers(null, "whimsy-capture-saved", path);
  return path;
}

async function openLibraryScreenshots() {
  const lib = library();
  lib.activeTab = "whimsy-files";
  await lib.constructor.animateProgress(1);
  await TestUtils.waitForCondition(() => lib.openProgress == 1 && !lib.hasAttribute("transitioning"), "The Library has slid in");
  return TestUtils.waitForCondition(() => lib.querySelector("whimsy-library-files-section"));
}

// 7: a Library screenshot's Edit (on hover and in its menu): Save replaces it, Save Copy adds one.
add_task(async function test_library_edit_save_and_save_copy() {
  const path = await pngFile("rgb(200, 40, 40)");
  const section = await openLibraryScreenshots();
  const name = PathUtils.filename(path);
  const findRow = () => [...section.querySelectorAll(".whimsy-library-shot-cell")].find(r => r.textContent.includes(name));
  const row = await TestUtils.waitForCondition(findRow, "The screenshot has a tile");
  const tools = row.querySelector(".whimsy-library-shot-tools");
  EventUtils.synthesizeMouseAtCenter(row.querySelector(".whimsy-library-shot"), { type: "mousemove" });
  await TestUtils.waitForCondition(() => getComputedStyle(tools).opacity == "1", "Hovering shows its buttons");
  const edit = tools.querySelector(".whimsy-library-shot-edit");
  is(edit.getAttribute("data-l10n-id"), "whimsy-library-files-edit", "Edit, beside…");
  ok(tools.querySelector(".whimsy-library-shot-delete"), "…Delete");

  // The menu: Open, Edit, Show in Finder, Copy, Delete.
  row.querySelector(".whimsy-library-shot").dispatchEvent(
    new MouseEvent("contextmenu", { bubbles: true, cancelable: true, screenX: 100, screenY: 100 }));
  const menu = await TestUtils.waitForCondition(() => document.querySelector(".whimsy-library-files-menu"), "A menu");
  if (menu.state != "open") {
    await BrowserTestUtils.waitForPopupEvent(menu, "shown");
  }
  Assert.deepEqual([...menu.querySelectorAll("menuitem")].map(i => i.dataset.action), ["open", "edit", "reveal", "copy", "delete"],
    "Edit is in the menu");
  const hidden = BrowserTestUtils.waitForPopupEvent(menu, "hidden");
  menu.activateItem(menu.querySelector('[data-action="edit"]'));
  await hidden;
  let ed = await openEditor();
  Assert.deepEqual([...ed.querySelectorAll(".whimsy-surface-footer [data-action]")].map(b => b.dataset.action),
    ["copy", "download", "save-copy", "save"], "Copy · Download · Save Copy · Save");
  ok(ed.querySelector("#whimsy-capture-hide").closest("[hidden]"), "No page to hide details in");
  await TestUtils.waitForCondition(() => ed.querySelector(".whimsy-capture-preview").width > 50, "The image is drawn");
  EventUtils.synthesizeMouseAtCenter(ed.querySelector(".whimsy-capture-hand"), {});
  const box = drawBox(ed, [0.2, 0.2, 0.6, 0.6]);
  const count = listCaptures().length;
  const original = await IOUtils.read(path);
  EventUtils.synthesizeMouseAtCenter(footerButton(ed, "save"), {});
  await TestUtils.waitForCondition(() => !editor(), "Save closes the editor");
  const saved = await IOUtils.read(path);
  isnot(saved.length == original.length && saved.every((b, i) => b == original[i]), true, "Save changed the file");
  is(listCaptures().length, count, "…without adding one");
  Assert.deepEqual(await pixelAt(new Blob([saved]), box.mid.x, box.mid.y), [0, 0, 0], "…and it has the box");

  // Edit on hover, then Save Copy.
  EventUtils.synthesizeMouseAtCenter(findRow().querySelector(".whimsy-library-shot"), { type: "mousemove" });
  await TestUtils.waitForCondition(() => getComputedStyle(findRow().querySelector(".whimsy-library-shot-tools")).opacity == "1");
  EventUtils.synthesizeMouseAtCenter(findRow().querySelector(".whimsy-library-shot-edit"), {});
  ed = await openEditor();
  await TestUtils.waitForCondition(() => ed.querySelector(".whimsy-capture-preview").width > 50, "The image is drawn");
  EventUtils.synthesizeMouseAtCenter(ed.querySelector('.whimsy-capture-backdrop[data-backdrop="dark"]'), {});
  EventUtils.synthesizeMouseAtCenter(footerButton(ed, "save-copy"), {});
  await TestUtils.waitForCondition(() => !editor(), "Save Copy closes the editor");
  await TestUtils.waitForCondition(() => listCaptures().length == count + 1, "Save Copy adds one file");
  Assert.deepEqual(await IOUtils.read(path), saved, "…and leaves the original alone");
  await closeLibrary();
});

// 8: a private page's viewer has no working Save and Close; nothing is written.
add_task(async function test_a_private_viewer_cannot_save() {
  const tab = WhimsyPrivate.openPrivateTab(window, { url: PAGE, force: true });
  added.push(tab);
  await BrowserTestUtils.browserLoaded(tab.linkedBrowser, false, PAGE);
  const browser = tab.linkedBrowser;
  const before = listCaptures();
  await startScreenshots(browser);
  EventUtils.synthesizeMouseAtCenter(bar(browser).getElementById("visible-page"), {}, window);
  const v = await viewer(browser);
  ok(!v.shown().includes("whimsy-capture-save-close"), "No Save and Close");
  ok(!v.shown().includes("whimsy-capture-easel"), "No Add to Easel");
  is(await WhimsyCaptureCard.saveAndClose(v.capture), null, "Saving is refused");
  is(newFiles(before).length, 0, "Nothing is written");
  ok(viewerOpen(browser), "The viewer is still open");
  await closeViewer(browser, v);
  BrowserTestUtils.removeTab(tab);
});

// Every feature is a command with a key Settings can bind and an icon that
// exists. W16-15: the user removed Capture Selected Area, Save Screenshot
// and Close and Add Screenshot to Easel; with a box drawn, Enter captures.
add_task(async function test_commands() {
  for (const id of ["cmd_whimsyCaptureEdit", "cmd_whimsyCaptureRedactLast", "cmd_whimsyCaptureRedact"]) {
    const entry = WhimsyCommands.get(id);
    ok(entry?.keyId && document.getElementById(entry.keyId), `${id} has a key Settings can bind`);
    const action = globalActions.find(a => a.commandId == id);
    ok(action?.icon, `${id} has an icon`);
    const response = await fetch(action.icon);
    ok(response.ok && (await response.text()).includes("<svg"), `…that exists (${action.icon})`);
  }
  for (const id of ["cmd_whimsyCaptureConfirm", "cmd_whimsyCaptureSaveClose", "cmd_whimsyCaptureAddToEasel"]) {
    ok(!WhimsyCommands.get(id), `${id} is gone`);
    ok(!document.getElementById(id), "…with no command element");
    ok(!globalActions.find(a => a.commandId == id), "…and nothing in the command bar");
  }

  let opened = 0;
  const count = () => opened++;
  Services.obs.addObserver(count, "whimsy-capture-viewer-ready");
  try {
    // Enter, wherever focus is: the drawn box opens in the viewer.
    const tab = await openTab();
    const browser = tab.linkedBrowser;
    await startScreenshots(browser);
    await drag(browser, [30, 30, 330, 230]);
    await BrowserTestUtils.synthesizeKey("KEY_Enter", {}, browser.browsingContext);
    let v = await viewer(browser);
    const ratio = window.devicePixelRatio;
    Assert.less(Math.abs(v.preview.previewImg.naturalWidth - 300 * ratio), 2 * ratio, "Enter captures the box drawn");
    document.getElementById("cmd_whimsyCaptureEdit").doCommand();
    await openEditor();
    EventUtils.synthesizeKey("KEY_Escape", {}, window);
    await TestUtils.waitForCondition(() => !editor(), "The editor closes");
    await closeViewer(browser, v);

    // Tab to Capture, then Enter: the viewer opens once.
    opened = 0;
    await startScreenshots(browser);
    await drag(browser, [30, 30, 330, 230]);
    await SpecialPowers.spawn(browser, [], () => {
      content.windowGlobalChild.getActor("ScreenshotsComponent").overlay.getElementById("whimsy-capture-confirm").focus();
    });
    await BrowserTestUtils.synthesizeKey("KEY_Enter", {}, browser.browsingContext);
    v = await viewer(browser);
    await new Promise(resolve => setTimeout(resolve, 500)); // eslint-disable-line mozilla/no-arbitrary-setTimeout
    is(opened, 1, "Enter on the Capture button opens the viewer once");
    await closeViewer(browser, v);
    BrowserTestUtils.removeTab(tab);
  } finally {
    Services.obs.removeObserver(count, "whimsy-capture-viewer-ready");
  }
});

// W16-19: the viewer is centred both ways: in the page it covers, which
// with the sidebar collapsed (compact mode) is the whole window, and never
// cut off at the top. Edit still hides it while the editor is open.
add_task(async function test_viewer_is_centred_in_the_window() {
  const tab = await openTab();
  const browser = tab.linkedBrowser;
  await startScreenshots(browser);
  EventUtils.synthesizeMouseAtCenter(bar(browser).getElementById("visible-page"), {}, window);
  const v = await viewer(browser);
  // Once its opening animation has settled.
  let last = null;
  await TestUtils.waitForCondition(async () => {
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const now = JSON.stringify(v.dialog._box.getBoundingClientRect());
    const still = now == last;
    last = now;
    return still;
  }, "The viewer has settled");
  const box = v.dialog._box.getBoundingClientRect();
  const page = v.dialog._overlay.getBoundingClientRect();
  info(JSON.stringify({ win: [window.innerWidth, window.innerHeight], page, box }));
  Assert.less(Math.abs((box.top + box.bottom) / 2 - (page.top + page.bottom) / 2), 3, "Centred vertically in the page");
  Assert.less(Math.abs((box.left + box.right) / 2 - (page.left + page.right) / 2), 3, "…and horizontally");
  Assert.greaterOrEqual(box.top, Math.max(0, page.top) - 0.5, "…its top on screen");
  Assert.less(Math.abs((page.top + page.bottom) / 2 - window.innerHeight / 2), 12, "The page is the window's height, so it's centred in the window too");

  await v.click("whimsy-capture-edit");
  await openEditor();
  viewerHidden(v, true, "Edit");
  EventUtils.synthesizeKey("KEY_Escape", {}, window);
  await TestUtils.waitForCondition(() => !editor(), "Esc closes the editor");
  viewerHidden(v, false, "Esc");
  const again = v.dialog._box.getBoundingClientRect();
  is(Math.round(again.top), Math.round(box.top), "…back where it was");
  await closeViewer(browser, v);
  BrowserTestUtils.removeTab(tab);
});
