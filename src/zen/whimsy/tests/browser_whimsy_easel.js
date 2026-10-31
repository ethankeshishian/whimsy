/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// Easel (Arc's Easels, whimsy.feature.easel): New Easel opens a pinned
// easel tab; text, drawings and shapes go on the canvas with the pointer;
// items move and resize; Cmd+Z / Cmd+Shift+Z undo and redo; everything
// persists across reopening; the capture tool adds static captures (from
// its "Add to Easel" button and picker) that Play turns live in the tab's
// container; private tabs are refused; the easel exports to PNG; and the
// switch turns it all off.

const { WhimsyEasel, gWhimsyEaselStore, easelIdFromURL, easelURL } = ChromeUtils.importESModule(
  "resource:///modules/whimsy/WhimsyEasel.sys.mjs"
);
const { ScreenshotsUtils } = ChromeUtils.importESModule(
  "moz-src:///browser/components/screenshots/ScreenshotsUtils.sys.mjs"
);

const PAGE = "https://example.com/";

add_setup(async function () {
  await SpecialPowers.pushPrefEnv({
    set: [
      ["whimsy.feature.easel", true],
      ["ui.prefersReducedMotion", 1],
      // Sync only where a test turns it on (test_sync).
      ["whimsy.easel.sync", false],
    ],
  });
});

async function openNewEasel() {
  const easel = await WhimsyEasel.newEasel(window);
  const tab = gBrowser.selectedTab;
  const browser = tab.linkedBrowser;
  await TestUtils.waitForCondition(
    () => browser.contentDocument?.documentElement?.getAttribute("ready") == "true",
    "The easel page is ready"
  );
  registerCleanupFunction(async () => {
    if (tab.isConnected) {
      gBrowser.unpinTab(tab);
      BrowserTestUtils.removeTab(tab);
    }
    await gWhimsyEaselStore.remove(easel.id);
  });
  return { easel, tab, browser, win: browser.contentWindow, app: browser.contentWindow.gWhimsyEasel };
}

// Synthesizes a pointer drag inside the easel page, in client px.
async function drag(win, from, to, { steps = 6, modifiers = {} } = {}) {
  const viewport = win.document.getElementById("viewport");
  EventUtils.synthesizeMouseAtPoint(from.x, from.y, { type: "mousedown", ...modifiers }, win);
  for (let i = 1; i <= steps; i++) {
    const x = from.x + ((to.x - from.x) * i) / steps;
    const y = from.y + ((to.y - from.y) * i) / steps;
    EventUtils.synthesizeMouseAtPoint(x, y, { type: "mousemove", ...modifiers }, win);
  }
  EventUtils.synthesizeMouseAtPoint(to.x, to.y, { type: "mouseup", ...modifiers }, win);
  await new Promise(r => win.requestAnimationFrame(r));
  return viewport;
}

add_task(async function test_new_easel_from_command() {
  const command = document.getElementById("cmd_whimsyNewEasel");
  ok(command, "New Easel is a window command");
  const key = document.getElementById("key_whimsyNewEasel");
  if (AppConstants.platform == "macosx") {
    is(key?.getAttribute("modifiers"), "control,shift", "Ctrl+Shift+E, Arc's New Easel");
    const mods = k => (k.getAttribute("modifiers") || "").split(/[ ,]+/).filter(Boolean).sort().join();
    const clash = [...document.querySelectorAll("key")].filter(
      k => k != key && k.getAttribute("disabled") != "true" && (k.getAttribute("key") || "").toUpperCase() == "E" && mods(k) == mods(key)
    );
    Assert.deepEqual(clash.map(k => k.id), [], "Ctrl+Shift+E doesn't clash");
  }
  const { globalActions } = ChromeUtils.importESModule("resource:///modules/ZenUBGlobalActions.sys.mjs");
  const action = globalActions.find(a => a.l10nId == "whimsy-action-new-easel");
  ok(action?.isAvailable(window), "The command bar offers New Easel");

  const { easel, tab, browser, app } = await openNewEasel();
  ok(tab.pinned, "A new easel opens pinned, like Arc");
  is(easelIdFromURL(browser.currentURI.spec), easel.id, "The tab shows that easel");
  is(app.id, easel.id, "The page loaded it");
  ok(!browser.contentDocument.getElementById("empty").hidden, "An empty easel says how to start");
  is(browser.contentDocument.title, "Untitled Easel", "Untitled until named");

  // Renaming updates the tab and the store.
  const title = browser.contentDocument.getElementById("easel-title");
  title.focus();
  EventUtils.sendString("Trip ideas", browser.contentWindow);
  await TestUtils.waitForCondition(() => browser.contentDocument.title == "Trip ideas", "Title follows the name");
  await app.flush();
  is((await gWhimsyEaselStore.get(easel.id)).title, "Trip ideas", "The name is saved");

  // Opening it again selects the same tab.
  gBrowser.selectedTab = gBrowser.tabs.find(t => t != tab && !t.pinned) ?? gBrowser.tabs[0];
  is(WhimsyEasel.openEasel(window, easel.id), tab, "An open easel is reused");
  is(gBrowser.selectedTab, tab, "and selected");
});

add_task(async function test_text_drawing_shapes_move_resize_undo() {
  const { easel, win, app } = await openNewEasel();
  const doc = win.document;
  const rect = doc.getElementById("viewport").getBoundingClientRect();
  const at = (x, y) => ({ x: rect.left + x, y: rect.top + y });

  // Text: click with the text tool and type.
  app.setTool("text");
  EventUtils.synthesizeMouseAtPoint(at(200, 200).x, at(200, 200).y, {}, win);
  await TestUtils.waitForCondition(() => app.editingId, "Typing starts where you click");
  EventUtils.sendString("Hello easel", win);
  EventUtils.synthesizeKey("KEY_Escape", {}, win);
  let text = app.items.find(i => i.type == "text");
  is(text?.text, "Hello easel", "The text is kept");
  // wave7: this page is privileged, so its pointerdown preventDefault()
  // doesn't stop the compat mousedown; the page cancels that itself, or its
  // default action focused the canvas and deleted the new, empty text box.
  ok(!win.getSelection().toString(), "The press started no page selection");
  ok(text.w > 20 && text.h > 10, "Text measures its own box");
  ok(doc.getElementById("empty").hidden, "The empty state goes away");

  // The text tool on existing text edits it, and the click keeps focus there.
  app.setTool("text");
  const box = doc.querySelector(`.item[data-id="${text.id}"] .text`).getBoundingClientRect();
  EventUtils.synthesizeMouseAtPoint(box.left + box.width / 2, box.top + box.height / 2, {}, win);
  await TestUtils.waitForCondition(() => app.editingId == text.id, "Clicking text with the text tool edits it");
  await new Promise(r => win.requestAnimationFrame(() => win.requestAnimationFrame(r)));
  is(app.editingId, text.id, "and stays in it after the click");
  is(doc.activeElement, doc.querySelector(`.item[data-id="${text.id}"] .text`), "with the caret in the text");
  EventUtils.synthesizeKey("KEY_Escape", {}, win);
  is(app.items.filter(i => i.type == "text").length, 1, "Still one text item");

  // Pen: a freehand stroke.
  app.setTool("pen");
  await drag(win, at(320, 320), at(420, 360), { steps: 12 });
  const pen = app.items.find(i => i.type == "pen");
  ok(pen?.d?.startsWith("M"), "A drawn stroke becomes a path");
  ok(pen.w >= 100, "The stroke's box covers the drawing");

  // Shape: a dragged rectangle, then back to the pointer.
  app.setTool("rect");
  await drag(win, at(500, 120), at(640, 220));
  const shape = app.items.find(i => i.type == "shape");
  is(shape?.shape, "rect", "A rectangle");
  ok(Math.abs(shape.w - 140 / app.view.zoom) < 2 && Math.abs(shape.h - 100 / app.view.zoom) < 2, "Sized by the drag");
  is(app.tool, "select", "Shapes hand back to the pointer");
  ok(app.selection.has(shape.id), "The new shape is selected");
  is(app.items.length, 3, "Three items");

  // Move the shape by dragging it.
  const before = { x: shape.x, y: shape.y };
  const s = app.toScreen(shape);
  // Grab the outline (an unfilled shape is picked by its line).
  await drag(win, at(s.x + 3, s.y + s.h / 2), at(s.x + 63, s.y + s.h / 2 + 40), { modifiers: { altKey: true } });
  ok(Math.abs(shape.x - before.x - 60 / app.view.zoom) < 1, "Moved right");
  ok(Math.abs(shape.y - before.y - 40 / app.view.zoom) < 1, "Moved down");

  // Resize from the bottom-right handle.
  const handle = doc.querySelector('#selection .handle[data-handle="se"]');
  const h = handle.getBoundingClientRect();
  const width = shape.w;
  await drag(win, { x: h.left + h.width / 2, y: h.top + h.height / 2 }, { x: h.left + h.width / 2 + 50, y: h.top + h.height / 2 + 30 });
  ok(Math.abs(shape.w - width - 50 / app.view.zoom) < 1, "Resized wider");

  // Keyboard nudging.
  doc.getElementById("viewport").focus();
  const x = shape.x;
  EventUtils.synthesizeKey("KEY_ArrowRight", { shiftKey: true }, win);
  is(shape.x, x + 10, "Shift+Arrow nudges 10px");

  // Undo and redo, one step each.
  const accel = { accelKey: true };
  EventUtils.synthesizeKey("z", accel, win); // nudge
  is(app.find(shape.id).x, x, "Undo the nudge");
  EventUtils.synthesizeKey("z", accel, win); // resize
  ok(Math.abs(app.find(shape.id).w - width) < 0.5, "Undo the resize");
  EventUtils.synthesizeKey("z", accel, win); // move
  ok(Math.abs(app.find(shape.id).x - before.x) < 0.5, "Undo the move");
  EventUtils.synthesizeKey("z", accel, win); // shape
  ok(!app.find(shape.id), "Undo the shape");
  EventUtils.synthesizeKey("z", { accelKey: true, shiftKey: true }, win);
  ok(app.find(shape.id), "Redo brings it back");

  // Delete and duplicate.
  app.select([shape.id]);
  EventUtils.synthesizeKey("d", accel, win);
  is(app.items.filter(i => i.type == "shape").length, 2, "Cmd+D duplicates");
  EventUtils.synthesizeKey("KEY_Backspace", {}, win);
  is(app.items.filter(i => i.type == "shape").length, 1, "Delete removes the selection");

  // Colour applies to the selection.
  app.select([pen.id]);
  doc.querySelector('.swatch[data-color="blue"]').click();
  is(app.find(pen.id).color, "blue", "A swatch recolours the selection");

  // Everything persists across closing and reopening.
  await app.flush();
  const saved = JSON.stringify(app.items);
  const tab = gBrowser.selectedTab;
  gBrowser.unpinTab(tab);
  BrowserTestUtils.removeTab(tab);
  const reopened = WhimsyEasel.openEasel(window, easel.id);
  await TestUtils.waitForCondition(
    () => reopened.linkedBrowser.contentDocument?.documentElement?.getAttribute("ready") == "true",
    "The reopened easel is ready"
  );
  const app2 = reopened.linkedBrowser.contentWindow.gWhimsyEasel;
  is(JSON.stringify(app2.items), saved, "Items persist across reopening");
  ok(app2.els.size == 3, "And render again");
  BrowserTestUtils.removeTab(reopened);
});

add_task(async function test_captures_static_live_and_private() {
  const pageTab = await BrowserTestUtils.openNewForegroundTab({ gBrowser, opening: PAGE, forceNewProcess: true });
  const container = BrowserTestUtils.addTab(gBrowser, PAGE, { userContextId: 2 });
  await BrowserTestUtils.browserLoaded(container.linkedBrowser);
  registerCleanupFunction(() => {
    BrowserTestUtils.removeTab(pageTab);
    BrowserTestUtils.removeTab(container);
  });
  const region = { left: 0, top: 0, right: 400, bottom: 200, width: 400, height: 200 };
  gBrowser.selectedTab = container;

  // A static capture keeps its page, crop and container.
  const capture = await WhimsyEasel.captureRegion(container.linkedBrowser, { region, devicePixelRatio: 1, viewportWidth: 1200, viewportHeight: 800 });
  ok(capture.blob?.size > 0, "The region is captured as an image");
  is(capture.item.url, PAGE, "It remembers the page");
  is(capture.item.userContextId, 2, "and the container");
  Assert.deepEqual(capture.item.crop, { x: 0, y: 0, w: 400, h: 200 }, "and the region");
  is(capture.item.live, false, "Captures start still, like Arc");

  // Nonsense regions are refused.
  is((await WhimsyEasel.captureRegion(pageTab.linkedBrowser, { region: { left: 0, top: 0, right: 1, bottom: 1 } })).error, "whimsy-capture-failed-toast", "Tiny regions are refused");
  is((await WhimsyEasel.captureRegion(pageTab.linkedBrowser, { region: { left: "x" } })).error, "whimsy-capture-failed-toast", "Bad data is refused");

  // Private tabs never reach an easel.
  const privateWin = await BrowserTestUtils.openNewBrowserWindow({ private: true });
  const privateTab = await BrowserTestUtils.openNewForegroundTab(privateWin.gBrowser, PAGE);
  is((await WhimsyEasel.captureRegion(privateTab.linkedBrowser, { region })).error, "whimsy-easel-capture-private", "Private captures are refused");
  await BrowserTestUtils.closeWindow(privateWin);

  // Into an open easel: the page picks it up and selects it.
  const { easel, win, app } = await openNewEasel();
  await WhimsyEasel.addCaptureTo(window, easel.id, capture);
  await TestUtils.waitForCondition(() => app.items.some(i => i.type == "capture"), "The open easel shows the capture");
  const item = app.items.find(i => i.type == "capture");
  ok(item.image, "Its image is saved in the profile");
  const bytes = await gWhimsyEaselStore.readImage(easel.id, item.image);
  ok(bytes?.length > 8, "The image file exists");
  ok(app.selection.has(item.id), "The new capture is selected");
  const el = app.els.get(item.id);
  await TestUtils.waitForCondition(() => el.querySelector("img")?.complete && el.querySelector("img").naturalWidth > 0, "The capture image shows");

  // Play makes it live: a sandboxed page in the same container, cropped.
  const play = win.document.querySelector('#contextbar [data-action="live"]');
  ok(!play.closest("[hidden]"), "Play is offered for a capture");
  play.click();
  ok(app.find(item.id).live, "Live");
  const browser = await TestUtils.waitForCondition(() => el.querySelector(".capture-browser"), "A live page loads");
  is(browser.getAttribute("usercontextid"), "2", "In the capture's container");
  is(browser.getAttribute("disableglobalhistory"), "true", "Out of history");
  await TestUtils.waitForCondition(() => browser.currentURI?.spec == PAGE, "Showing the page");
  ok(browser.browsingContext.sandboxFlags & 0x2, "Sandboxed like note blocks");
  ok(el.classList.contains("active"), "Playing enters the live page");
  const stage = el.querySelector(".capture-stage");
  ok(stage.style.transform.includes("scale("), "Cropped by scaling the stage");
  await TestUtils.waitForCondition(() => stage.classList.contains("ready"), "The live page shows once it has loaded");

  // wave7: a <browser> bound again gets a new frame loader on about:blank;
  // the capture loads its page into it again.
  stage.append(browser);
  await TestUtils.waitForCondition(() => browser.currentURI?.spec == PAGE, "The page comes back after the frame is re-made");

  // Pause goes back to the still capture.
  play.click();
  ok(!app.find(item.id).live, "Paused");
  ok(!el.querySelector(".capture-browser"), "The live page is gone");
});

add_task(async function test_capture_button_and_picker() {
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE);
  registerCleanupFunction(() => BrowserTestUtils.removeTab(tab));
  const browser = tab.linkedBrowser;
  ScreenshotsUtils.start(browser);
  await TestUtils.waitForCondition(
    () => SpecialPowers.spawn(browser, [], () => {
      const overlay = content.windowGlobalChild.getActor("ScreenshotsComponent").overlay;
      return !!overlay?.getElementById("whimsy-easel-add");
    }),
    "Add to Easel joins the capture toolbar"
  );
  const order = await SpecialPowers.spawn(browser, [], () => {
    const overlay = content.windowGlobalChild.getActor("ScreenshotsComponent").overlay;
    return [...overlay.getElementById("whimsy-easel-add").parentElement.children].map(b => b.id);
  });
  ok(order.indexOf("whimsy-easel-add") < order.indexOf("copy"), "Before Copy");
  ScreenshotsUtils.exit(browser);

  // The picker: New Easel, then recent easels.
  const existing = await gWhimsyEaselStore.create({ title: "Mood board" });
  registerCleanupFunction(() => gWhimsyEaselStore.remove(existing.id));
  const shown = BrowserTestUtils.waitForEvent(document, "popupshown", false, e => e.target.id == "whimsy-easel-capture-menu");
  const region = { left: 0, top: 0, right: 300, bottom: 150 };
  WhimsyEasel.onCaptureRequest(browser, { region, devicePixelRatio: 1, viewportWidth: 1000, viewportHeight: 700 }, { x: 10, y: 10 });
  const menu = (await shown).target;
  const labels = [...menu.querySelectorAll("menuitem")].map(m => m.label);
  is(labels[0], "New Easel", "New Easel comes first");
  ok(labels.includes("Mood board"), "Existing easels are listed");
  const hidden = BrowserTestUtils.waitForEvent(menu, "popuphidden");
  menu.activateItem([...menu.querySelectorAll("menuitem")].find(m => m.label == "Mood board"));
  await hidden;
  await TestUtils.waitForCondition(async () => (await gWhimsyEaselStore.get(existing.id)).items.length == 1, "The capture lands in the chosen easel");
});

add_task(async function test_export_png() {
  const { easel, app } = await openNewEasel();
  app.addItems([
    { id: "a", type: "shape", shape: "rect", x: 0, y: 0, w: 200, h: 100, color: "red", width: 4, fill: "tint" },
    { id: "b", type: "text", x: 20, y: 140, w: 120, h: 30, text: "Export me", font: "sans", size: 18, color: "ink", auto: false },
  ]);
  const canvas = await app.renderCanvas({ dark: false, scale: 1 });
  is(canvas.width, 200 + 96, "The export fits the items plus padding");
  const path = PathUtils.join(PathUtils.tempDir, `whimsy-easel-${easel.id}.png`);
  registerCleanupFunction(() => IOUtils.remove(path, { ignoreAbsent: true }));
  ok(await app.exportAs("png-dark", { path }), "Saved as PNG");
  const bytes = await IOUtils.read(path);
  Assert.deepEqual([...bytes.slice(0, 4)], [0x89, 0x50, 0x4e, 0x47], "A real PNG file");
});

add_task(async function test_library_lists_easels() {
  const easel = await gWhimsyEaselStore.create({ title: "Library easel" });
  registerCleanupFunction(() => gWhimsyEaselStore.remove(easel.id));
  const list = await gWhimsyEaselStore.list();
  is(list[0].id, easel.id, "Newest first");
  const library = document.querySelector("zen-library");
  await TestUtils.waitForCondition(() => library?.zenLibrarySections["whimsy-easels"], "The Library has Easels");

  // Deleting can be undone.
  await gWhimsyEaselStore.remove(easel.id);
  ok(!(await gWhimsyEaselStore.get(easel.id)), "Deleted");
  await gWhimsyEaselStore.restore(easel.id);
  ok(await gWhimsyEaselStore.get(easel.id), "Restored");
});

add_task(async function test_switch_off() {
  const { easel, browser } = await openNewEasel();
  await SpecialPowers.pushPrefEnv({ set: [["whimsy.feature.easel", false]] });
  const { globalActions } = ChromeUtils.importESModule("resource:///modules/ZenUBGlobalActions.sys.mjs");
  ok(!globalActions.find(a => a.l10nId == "whimsy-action-new-easel").isAvailable(window), "No New Easel in the command bar");
  is(await WhimsyEasel.newEasel(window), null, "New Easel does nothing");
  const library = document.querySelector("zen-library");
  await TestUtils.waitForCondition(() => !("whimsy-easels" in library.zenLibrarySections), "Easels leave the Library");
  await BrowserTestUtils.reloadTab(gBrowser.selectedTab);
  await TestUtils.waitForCondition(() => browser.contentDocument?.documentElement?.getAttribute("ready") == "true", "Reloaded");
  ok(!browser.contentDocument.getElementById("off").hidden, "The page says Easels are off");
  ok(browser.contentDocument.getElementById("easel").hidden, "No canvas");
  ok(await gWhimsyEaselStore.get(easel.id), "Turning it off keeps your easels");
  await SpecialPowers.popPrefEnv();
});

add_task(function test_url_helpers() {
  is(easelIdFromURL(easelURL("0a1b2c3d-1111-2222-3333-444455556666")), "0a1b2c3d-1111-2222-3333-444455556666", "Round trip");
  is(easelIdFromURL("about:whimsy?game"), null, "Other pages aren't easels");
  is(easelIdFromURL("https://example.com/?easel&id=0a1b2c3d"), null, "Web pages aren't easels");
});

// wave7: View Easels… is a registered command (command bar, about:keyboard)
// and a Window menu item, and opens the Library on Easels.
add_task(async function test_view_easels_command() {
  const { WhimsyCommands } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyCommands.sys.mjs");
  ok(document.getElementById("cmd_whimsyViewEasels"), "View Easels… is a window command");
  is(WhimsyCommands.get("cmd_whimsyViewEasels")?.l10nId, "whimsy-action-view-easels", "in the command registry");
  const { globalActions } = ChromeUtils.importESModule("resource:///modules/ZenUBGlobalActions.sys.mjs");
  ok(globalActions.find(a => a.l10nId == "whimsy-action-view-easels")?.isAvailable(window), "and the command bar");

  WhimsyEasel.addWindowMenuItem(document);
  const item = document.getElementById("menu_whimsyViewEasels");
  is(item?.getAttribute("command"), "cmd_whimsyViewEasels", "The Window menu lists it");

  const library = document.querySelector("zen-library");
  await TestUtils.waitForCondition(() => library?.zenLibrarySections?.["whimsy-easels"], "The Library has Easels");
  const ZenLibrary = customElements.get("zen-library");
  ok(WhimsyEasel.viewEasels(window), "View Easels… runs");
  await TestUtils.waitForCondition(() => ZenLibrary.isLibraryOpen && library.activeTab == "whimsy-easels", "The Library opens on Easels");
  ZenLibrary.close();
  await TestUtils.waitForCondition(() => !ZenLibrary.isLibraryOpen, "Closed again");
});

// wave7: resizing snaps the moving edge to other items' edges and centres.
add_task(async function test_resize_snaps() {
  const M = ChromeUtils.importESModule("chrome://browser/content/whimsy/whimsy-easel-model.mjs");
  const other = { x: 0, y: 0, w: 200, h: 100 };
  const snapped = M.snapResize({ x: 300, y: 0, w: 96, h: 50 }, "e", [other], 6);
  is(snapped.dx, 0, "Nothing near: no snap");
  const near = M.snapResize({ x: 50, y: 150, w: 147, h: 50 }, "se", [other], 6);
  is(near.dx, 3, "The right edge snaps to the other item's right edge");
  is(near.guides[0]?.axis, "x", "with a guide");

  const { win, app } = await openNewEasel();
  app.addItems([
    { id: "a", type: "shape", shape: "rect", x: 0, y: 0, w: 200, h: 100, color: "ink", width: 2, fill: "tint" },
    { id: "b", type: "shape", shape: "rect", x: 0, y: 160, w: 120, h: 80, color: "ink", width: 2, fill: "tint" },
  ]);
  app.view.zoom = 1;
  app.applyView();
  app.select(["b"]);
  const handle = win.document.querySelector('#selection .handle[data-handle="e"]').getBoundingClientRect();
  const from = { x: handle.left + handle.width / 2, y: handle.top + handle.height / 2 };
  await drag(win, from, { x: from.x + 77, y: from.y });
  is(app.find("b").w, 200, "Dragged to within a few px of A's edge, B's edge lands on it");
  await drag(win, { x: from.x + 80, y: from.y }, { x: from.x + 157, y: from.y }, { modifiers: { altKey: true } });
  is(Math.round(app.find("b").w), 277, "Option resizes freely");
});

// wave7: Copy Link puts the easel's address on the clipboard.
add_task(async function test_copy_link() {
  const { easel, app } = await openNewEasel();
  ok(await app.exportAs("link"), "Copy Link");
  is(SpecialPowers.getClipboardData("text/plain"), easelURL(easel.id), "The easel's own address");
});

// wave7: the easel takes its space's colour, and its own when there's none.
add_task(async function test_space_color() {
  const { win, app } = await openNewEasel();
  const root = win.document.documentElement;
  const accent = () => win.getComputedStyle(root).getPropertyValue("--ez-accent").trim();
  const plain = accent();
  app.spaceRGB = () => [20, 60, 160];
  app.applySpaceColor();
  ok(root.hasAttribute("space-color"), "A space colour applies");
  isnot(accent(), plain, "The accent follows the space");
  is(win.getComputedStyle(root).getPropertyValue("--ez-space-text").trim(), "#ffffff", "White ink on a deep blue");
  app.spaceRGB = () => null;
  app.applySpaceColor();
  ok(!root.hasAttribute("space-color"), "Zen's default theme keeps the easel's own colour");
  is(accent(), plain, "back to it");
});

// wave7: Add Page to Easel captures the whole page, live-croppable.
add_task(async function test_add_page_to_easel() {
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE);
  registerCleanupFunction(() => BrowserTestUtils.removeTab(tab));
  ok(document.getElementById("cmd_whimsyAddPageToEasel"), "Add Page to Easel is a command");
  const height = await SpecialPowers.spawn(tab.linkedBrowser, [], () =>
    Math.max(content.document.documentElement.scrollHeight, content.document.documentElement.clientHeight)
  );
  const capture = await WhimsyEasel.capturePage(tab.linkedBrowser);
  ok(capture.blob?.size > 0, "The page is captured");
  is(capture.item.crop.y, 0, "From the top");
  is(capture.item.crop.h, Math.min(height, 12000), "To the bottom");
  is(capture.item.url, PAGE, "Keeping its page");
  const about = await BrowserTestUtils.openNewForegroundTab(gBrowser, "about:robots");
  is((await WhimsyEasel.capturePage(about.linkedBrowser)).error, "whimsy-capture-failed-toast", "Only web pages");
  BrowserTestUtils.removeTab(about);
});

// wave7: easels sync over the prefs engine: images stay local, each easel
// and the whole pref have size caps, deletions travel as tombstones.
add_task(async function test_sync() {
  const Sync = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyEaselSync.sys.mjs");
  const { WhimsyEaselSync, SYNC_PREF, packEasels, syncableEasel, MAX_EASEL_BYTES, MAX_BYTES } = Sync;
  ok(Services.prefs.getBoolPref(`services.sync.prefs.sync.${SYNC_PREF}`), "The prefs engine carries it");

  const packed = syncableEasel({
    title: "T",
    updated: 5,
    items: [
      { id: "i", type: "image", src: "x.png", x: 0, y: 0, w: 1, h: 1 },
      { id: "c", type: "capture", image: "y.png", url: PAGE, x: 0, y: 0, w: 1, h: 1 },
      { id: "p", type: "pen", d: "M0 0" + "L1 1".repeat(5000), x: 0, y: 0, w: 1, h: 1 },
    ],
  });
  Assert.deepEqual(packed.items.map(i => i.id), ["c"], "Images and the oversized drawing stay local");
  ok(!("image" in packed.items[0]), "A capture syncs its page, not its picture");
  const big = Array.from({ length: 12 }, (_, n) => ({ id: `e${n}`, title: "x".repeat(MAX_EASEL_BYTES - 200), items: [], updated: n }));
  const all = packEasels(big);
  Assert.lessOrEqual(new TextEncoder().encode(JSON.stringify(all)).length, MAX_BYTES, "The pref stays under its cap");
  ok("e11" in all.easels && !("e0" in all.easels), "Newest easels first");

  await SpecialPowers.pushPrefEnv({ set: [["whimsy.easel.sync", true]] });
  WhimsyEaselSync.init();
  // Another device's easel arrives.
  const id = "0a1b2c3d-1111-2222-3333-444455556666";
  const now = Date.now();
  Services.prefs.setStringPref(SYNC_PREF, JSON.stringify({ v: 1, easels: { [id]: [{ title: "From the laptop", items: [{ id: "t", type: "text", x: 0, y: 0, w: 50, h: 20, text: "hi", font: "sans", size: 18, color: "ink", auto: true }], updated: now }, now] } }));
  await TestUtils.waitForCondition(async () => (await gWhimsyEaselStore.get(id))?.title == "From the laptop", "The synced easel appears");
  await WhimsyEaselSync.sync();
  ok(JSON.parse(Services.prefs.getStringPref(SYNC_PREF)).easels[id][0], "and stays in the synced copy");
  // Deleting it here sends a tombstone.
  await gWhimsyEaselStore.remove(id);
  await WhimsyEaselSync.sync();
  is(JSON.parse(Services.prefs.getStringPref(SYNC_PREF)).easels[id]?.[0], null, "A deletion syncs as a tombstone");
  Services.prefs.clearUserPref(SYNC_PREF);
  Services.prefs.clearUserPref("whimsy.easel.sync-known");
  await SpecialPowers.popPrefEnv();
});
