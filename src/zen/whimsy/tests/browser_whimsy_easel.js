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

const { WhimsyEasel, gWhimsyEaselStore, easelIdFromURL, easelURL, migrateEasels, profileKeyOf } = ChromeUtils.importESModule(
  "resource:///modules/whimsy/WhimsyEasel.sys.mjs"
);
const { WhimsyProfiles } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyProfiles.sys.mjs");
const { WhimsyPrivate } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyPrivate.sys.mjs");
const { ScreenshotsUtils } = ChromeUtils.importESModule(
  "moz-src:///browser/components/screenshots/ScreenshotsUtils.sys.mjs"
);

const PAGE = "https://example.com/";
const LIVE_PAGE = getRootDirectory(gTestPath).replace("chrome://mochitests/content", "https://example.com") + "whimsy_easel_live.html";
// Its own site (and so its own web process) for the crash test, so crashing
// it takes down no other tab's page.
const CRASH_PAGE = getRootDirectory(gTestPath).replace("chrome://mochitests/content", "https://example.org") + "whimsy_easel_live.html";

// wave8/isolation: a container tab lives in a space of its own container,
// so the test opens one there (the isolation guard would move it anyway).
async function containerSpace(userContextId) {
  const space = await gZenWorkspaces.createAndSaveWorkspace(`Container ${userContextId}`, undefined, true, userContextId);
  registerCleanupFunction(async () => {
    for (const tab of gZenWorkspaces.allStoredTabs.filter(t => t.getAttribute("zen-workspace-id") == space.uuid &&
      !t.hasAttribute("zen-essential") && !t.hasAttribute("zen-empty-tab"))) {
      BrowserTestUtils.removeTab(tab);
    }
    if (gZenWorkspaces.getWorkspaces().some(w => w.uuid == space.uuid)) {
      await gZenWorkspaces.removeWorkspace(space.uuid);
    }
  });
  return space;
}

add_setup(async function () {
  await SpecialPowers.pushPrefEnv({
    set: [
      ["whimsy.feature.easel", true],
      ["ui.prefersReducedMotion", 1],
      // Sync only where a test turns it on (test_sync).
      ["whimsy.easel.sync", false],
    ],
  });
  // Drawing a shape (color swatches) and test_sync write these directly,
  // outside pushPrefEnv's reach.
  for (const pref of ["whimsy.easel.color", "whimsy.easel.synced", "whimsy.easel.sync-known"]) {
    const had = Services.prefs.prefHasUserValue(pref);
    const value = had ? Services.prefs.getStringPref(pref) : null;
    registerCleanupFunction(() => {
      if (had) {
        Services.prefs.setStringPref(pref, value);
      } else {
        Services.prefs.clearUserPref(pref);
      }
    });
  }
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

// Waits for the Library's spring (a JS animation: "transitioning" until it
// ends) and every finite CSS/Web animation in the browser window to finish.
async function settleWindow() {
  const library = document.querySelector("zen-library");
  await TestUtils.waitForCondition(() => !library?.hasAttribute("transitioning"), "The Library is still");
  for (let i = 0; i < 5; i++) {
    const running = document.getAnimations().filter(a => a.playState == "running" && a.effect?.getComputedTiming().endTime != Infinity);
    if (!running.length) {
      break;
    }
    await Promise.all(running.map(a => a.finished.catch(() => {})));
  }
  await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
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

  // Shape: a dragged rectangle; the rectangle tool stays picked.
  app.setTool("rect");
  await drag(win, at(500, 120), at(640, 220));
  const shape = app.items.find(i => i.type == "shape");
  is(shape?.shape, "rect", "A rectangle");
  ok(Math.abs(shape.w - 140 / app.view.zoom) < 2 && Math.abs(shape.h - 100 / app.view.zoom) < 2, "Sized by the drag");
  is(app.tool, "rect", "Drawing a shape keeps the shape tool");
  ok(app.selection.has(shape.id), "The new shape is selected");
  is(app.items.length, 3, "Three items");
  doc.getElementById("viewport").focus();
  EventUtils.synthesizeKey("v", {}, win);
  is(app.tool, "select", "V picks the pointer");

  // Move the shape by dragging it.
  const before = { x: shape.x, y: shape.y };
  const s = app.toScreen(shape);
  // Grab the outline (an unfilled shape is picked by its line), away from
  // the selected shape's edge-midpoint resize handles.
  await drag(win, at(s.x + 3, s.y + s.h / 4), at(s.x + 63, s.y + s.h / 4 + 40), { modifiers: { altKey: true } });
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

// F11 (W13, the user: "a bug, not a design"): the three size buttons must
// draw three different sizes and look different. Real clicks on each size
// button, then a pen stroke, a highlighter stroke and text at that size:
// the model holds 2/4/8 (highlighter ×4) and 18/28/44, the page paints
// them (stroke-width, font-size), the export canvas draws strokes that
// thick (counted in pixels), and the buttons' dots are clearly different.
// The selection bar's dividers sit only between groups that show.
function checkContextDividers(win, what) {
  const groups = [...win.document.querySelectorAll("#contextbar .ctx-group")].filter(g => !g.hidden);
  ok(groups.length, `${what}: the selection bar shows a group`);
  is(win.getComputedStyle(groups[0]).borderLeftWidth, "0px", `${what}: no divider before the first group`);
  for (const group of groups.slice(1)) {
    is(win.getComputedStyle(group).borderLeftWidth, "1px", `${what}: a divider between groups`);
  }
}

add_task(async function test_shape_tools_stay_and_bar_dividers() {
  const { win, app } = await openNewEasel();
  const doc = win.document;
  const rect = doc.getElementById("viewport").getBoundingClientRect();
  const at = (x, y) => ({ x: rect.left + x, y: rect.top + y });
  EventUtils.synthesizeMouseAtCenter(doc.querySelector('.tool[data-tool="line"]'), {}, win);
  await drag(win, at(120, 120), at(320, 160));
  await drag(win, at(120, 220), at(320, 260));
  is(app.items.filter(i => i.shape == "line").length, 2, "Two lines in a row without picking the tool again");
  is(app.tool, "line", "The line tool stays picked");
  await TestUtils.waitForCondition(() => !doc.getElementById("contextbar").hidden, "The selection bar shows");
  checkContextDividers(win, "A line");

  doc.getElementById("viewport").focus();
  EventUtils.synthesizeKey("r", {}, win);
  is(app.tool, "rect", "R picks the rectangle");
  await drag(win, at(420, 120), at(560, 220));
  is(app.tool, "rect", "The rectangle tool stays picked");
  ok(!doc.querySelector('#contextbar .ctx-group[data-for="shape"]').hidden, "A rectangle offers Fill");
  checkContextDividers(win, "A rectangle");

  doc.getElementById("viewport").focus();
  EventUtils.synthesizeKey("KEY_Escape", {}, win);
  is(app.selection.size, 0, "Esc clears the selection");
  EventUtils.synthesizeKey("a", {}, win);
  const before = app.items.length;
  EventUtils.synthesizeKey("KEY_Enter", {}, win);
  is(app.items.length, before + 1, "Enter makes an arrow");
  is(app.tool, "arrow", "Making an arrow from the keyboard keeps the arrow tool");
});

add_task(async function test_size_buttons_draw_three_sizes() {
  await SpecialPowers.pushPrefEnv({ set: [["whimsy.easel.size", 1]] });
  const { win, app } = await openNewEasel();
  const doc = win.document;
  const rect = doc.getElementById("viewport").getBoundingClientRect();
  const at = (x, y) => ({ x: rect.left + x, y: rect.top + y });
  const sizeButton = size => doc.querySelector(`.size[data-size="${size}"]`);
  const pickTool = tool => EventUtils.synthesizeMouseAtCenter(doc.querySelector(`.tool[data-tool="${tool}"]`), {}, win);
  const pickSize = async size => {
    is(app.selection.size, 0, "Nothing selected, so the size is for what's drawn next");
    EventUtils.synthesizeMouseAtCenter(sizeButton(size), {}, win);
    await TestUtils.waitForCondition(() => app.size == size, `Size ${size} picked`);
    is(sizeButton(size).getAttribute("aria-checked"), "true", "...and shown as picked");
  };

  // The glyphs: dots at true doubling, the picked one marked by its fill.
  const dots = [0, 1, 2].map(size => sizeButton(size).querySelector(".dot").getBoundingClientRect().width);
  info(`Dots: ${dots.join(" / ")}px`);
  Assert.greaterOrEqual(dots[1] / dots[0], 1.8, "The medium dot is clearly bigger than the small one");
  Assert.greaterOrEqual(dots[2] / dots[1], 1.8, "The large dot is clearly bigger than the medium one (they looked the same)");
  Assert.lessOrEqual(dots[2], sizeButton(2).getBoundingClientRect().width - 8, "The large dot fits its button with room around it");
  await pickSize(2);
  is(win.getComputedStyle(sizeButton(2)).boxShadow, "none", "The picked size has no ring crowding its dot");

  const pens = [];
  const marks = [];
  for (const size of [0, 1, 2]) {
    await pickSize(size);
    pickTool("pen");
    await drag(win, at(120, 120 + size * 70), at(420, 120 + size * 70), { steps: 10 });
    pens.push(app.items.at(-1));
    pickTool("highlighter");
    await drag(win, at(520, 120 + size * 70), at(820, 120 + size * 70), { steps: 10 });
    marks.push(app.items.at(-1));
  }
  Assert.deepEqual(pens.map(p => p.width), [2, 4, 8], "Pen strokes: 2, 4 and 8 wide");
  Assert.deepEqual(marks.map(p => p.width), [8, 16, 32], "Highlighter: ×4, 8, 16 and 32 wide");
  ok(marks.every(m => m.highlighter), "...as highlighter strokes");
  // What the page paints.
  const inkWidth = item => win.getComputedStyle(doc.querySelector(`.item[data-id="${item.id}"] path.ink`)).strokeWidth;
  Assert.deepEqual(pens.map(inkWidth), ["2px", "4px", "8px"], "The page paints the pen at 2, 4 and 8px");
  Assert.deepEqual(marks.map(inkWidth), ["8px", "16px", "32px"], "...and the highlighter at 8, 16 and 32px");

  // Text at each size.
  const texts = [];
  for (const size of [0, 1, 2]) {
    await pickSize(size);
    pickTool("text");
    EventUtils.synthesizeMouseAtPoint(at(120, 330 + size * 75).x, at(120, 330 + size * 75).y, {}, win);
    await TestUtils.waitForCondition(() => app.editingId, "Typing starts where you click");
    EventUtils.sendString("Aa", win);
    const id = app.editingId;
    EventUtils.synthesizeKey("KEY_Escape", {}, win);
    if (app.selection.size) {
      EventUtils.synthesizeKey("KEY_Escape", {}, win);
    }
    texts.push(app.find(id));
  }
  Assert.deepEqual(texts.map(t => t.size), [18, 28, 44], "Text: 18, 28 and 44");
  const fontSize = item => win.getComputedStyle(doc.querySelector(`.item[data-id="${item.id}"] .text`)).fontSize;
  Assert.deepEqual(texts.map(fontSize), ["18px", "28px", "44px"], "The page sets them at 18, 28 and 44px");
  const heights = texts.map(t => doc.querySelector(`.item[data-id="${t.id}"] .text`).getBoundingClientRect().height);
  ok(heights[0] < heights[1] && heights[1] < heights[2], `...and they're drawn taller each time (${heights.join(" / ")})`);

  // The export canvas: count the stroke's pixels down its middle.
  const canvas = await app.renderCanvas({ dark: false, scale: 1 });
  const { box } = (() => {
    const b = { x: Infinity, y: Infinity };
    for (const item of app.items) {
      b.x = Math.min(b.x, item.x);
      b.y = Math.min(b.y, item.y);
    }
    return { box: { x: b.x - 48, y: b.y - 48 } };
  })();
  const ctx = canvas.getContext("2d");
  const thickness = item => {
    const x = Math.round(item.x + item.w / 2 - box.x);
    const data = ctx.getImageData(x, Math.floor(item.y - box.y), 1, Math.ceil(item.h)).data;
    // How far each pixel is from the background (#fbfaf8); the stroke's
    // thickness is the run of pixels at least half as far as its core
    // (its width at half strength, so antialiased edges count once).
    const diffs = [];
    for (let i = 0; i < data.length; i += 4) {
      diffs.push(Math.abs(data[i] - 0xfb) + Math.abs(data[i + 1] - 0xfa) + Math.abs(data[i + 2] - 0xf8));
    }
    const core = Math.max(...diffs);
    return core > 20 ? diffs.filter(d => d >= core / 2).length : 0;
  };
  const drawn = pens.map(thickness);
  const highlighted = marks.map(thickness);
  info(`Drawn pen: ${drawn.join(" / ")}px; highlighter: ${highlighted.join(" / ")}px`);
  pens.forEach((pen, i) => Assert.less(Math.abs(drawn[i] - pen.width), 1.6, `The pen at size ${i} is drawn ${pen.width}px thick`));
  marks.forEach((mark, i) =>
    Assert.less(Math.abs(highlighted[i] - mark.width), 2.6, `The highlighter at size ${i} is drawn ${mark.width}px thick`));
  ok(drawn[0] < drawn[1] && drawn[1] < drawn[2], "Three different pen thicknesses");
  ok(highlighted[0] < highlighted[1] && highlighted[1] < highlighted[2], "Three different highlighter thicknesses");
  await SpecialPowers.popPrefEnv();
});

add_task(async function test_captures_static_live_and_private() {
  const pageTab = await BrowserTestUtils.openNewForegroundTab({ gBrowser, opening: PAGE, forceNewProcess: true });
  registerCleanupFunction(() => BrowserTestUtils.removeTab(pageTab));
  const home = gZenWorkspaces.getActiveWorkspace();
  const space = await containerSpace(2);
  await gZenWorkspaces.changeWorkspace(space);
  const container = BrowserTestUtils.addTab(gBrowser, PAGE, { userContextId: 2 });
  await BrowserTestUtils.browserLoaded(container.linkedBrowser);
  registerCleanupFunction(() => {
    if (container.isConnected) {
      BrowserTestUtils.removeTab(container);
    }
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

  // Into an open easel of the same profile (made in the container's space):
  // the page picks it up and selects it.
  const { easel, tab: easelTab, win, app } = await openNewEasel();
  is(easel.profileKey, WhimsyProfiles.keyFor(2), "The easel belongs to the space's profile");
  is(easelTab.userContextId, 2, "Its tab opens in that profile's container");
  await WhimsyEasel.addCaptureTo(window, easel.id, capture);
  await TestUtils.waitForCondition(() => app.items.some(i => i.type == "capture"), "The open easel shows the capture");
  const item = app.items.find(i => i.type == "capture");
  ok(item.image, "Its image is saved in the profile");
  const bytes = await gWhimsyEaselStore.readImage(easel.id, item.image);
  ok(bytes?.length > 8, "The image file exists");
  ok(app.selection.has(item.id), "The new capture is selected");
  // The item is in the list before the easel has drawn its element (a
  // frame later, longer on a loaded machine).
  const el = await TestUtils.waitForCondition(() => app.els.get(item.id), "The item is drawn");
  await TestUtils.waitForCondition(() => el.querySelector("img")?.complete && el.querySelector("img").naturalWidth > 0, "The capture image shows");

  // Play makes it live: a sandboxed page in the same container, cropped.
  const play = win.document.querySelector('#contextbar [data-action="live"]');
  ok(!play.closest("[hidden]"), "Play is offered for a capture");
  checkContextDividers(win, "A capture with a page");
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
  await gZenWorkspaces.changeWorkspace(home);
});

add_task(async function test_capture_button_and_picker() {
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE);
  registerCleanupFunction(() => BrowserTestUtils.removeTab(tab));
  const browser = tab.linkedBrowser;
  ScreenshotsUtils.start(browser, "ToolbarButton");
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
  // W10-24: the picker is a surface with the capture's thumbnail and a
  // grid of easel tiles, not a native menu.
  const shown = BrowserTestUtils.waitForEvent(document, "popupshown", true, e => e.target.id == "whimsy-easel-picker");
  const region = { left: 0, top: 0, right: 300, bottom: 150 };
  WhimsyEasel.onCaptureRequest(browser, { region, devicePixelRatio: 1, viewportWidth: 1000, viewportHeight: 700 }, { x: 10, y: 10 });
  const picker = (await shown).target;
  ok(picker.classList.contains("whimsy-surface"), "A Whimsy surface");
  ok(!document.getElementById("whimsy-easel-capture-menu") && !picker.querySelector("menuitem"), "No native menu");
  const preview = picker.querySelector("img.whimsy-easel-picker-preview");
  ok(preview?.src.startsWith("blob:"), "The capture's own thumbnail");
  await document.l10n.translateFragment(picker);
  is(picker.querySelector(".whimsy-easel-picker-size").textContent.replace(/[\u2068\u2069]/g, ""), "300 × 150", "with its size");
  const tiles = [...picker.querySelectorAll(".whimsy-easel-tile")];
  is(tiles[0].dataset.easel, "new", "New Easel comes first");
  const mood = tiles.find(t => t.textContent.includes("Mood board"));
  ok(mood, "Existing easels are listed");
  ok(mood.querySelector(".whimsy-easel-tile-thumb"), "with a thumbnail");
  ok(mood.querySelector(".whimsy-easel-tile-when").textContent.startsWith("Edited"), "and when it was edited");
  await TestUtils.waitForCondition(() => document.activeElement == tiles[0], "New Easel has the keyboard");
  // Arrows move in the grid; Return adds to the focused easel.
  EventUtils.synthesizeKey("KEY_End", {}, window);
  ok(document.activeElement.classList.contains("whimsy-easel-tile"), "Arrow keys move through the tiles");
  mood.focus();
  const hidden = BrowserTestUtils.waitForEvent(picker, "popuphidden");
  EventUtils.synthesizeKey("KEY_Enter", {}, window);
  await hidden;
  await TestUtils.waitForCondition(async () => (await gWhimsyEaselStore.get(existing.id)).items.length == 1, "The capture lands in the chosen easel");
  const toast = await TestUtils.waitForCondition(() => toastFor("whimsy-easel-capture-added"), "A toast says where it went");
  ok(toast.element.querySelector(".whimsy-toast-button"), "Added to Mood board, with Open");
  toast.close({ instant: true });

  // The next picker shows Mood board's first capture as its thumbnail.
  const thumb = await gWhimsyEaselStore.thumbnail(existing.id);
  ok(thumb?.bytes?.length, "The easel has a thumbnail now");
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
  // isLibraryOpen turns false as the Library's spring starts; the next test
  // drags in the page, which moves until the spring ends.
  await settleWindow();
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
  // Nothing in the window still moving (a panel or the Library sliding
  // away from an earlier test moves the page under the pointer).
  await settleWindow();
  // The selection overlay draws on the next frame: wait for the east handle
  // to sit on B's right edge before grabbing it.
  const handleEl = () => win.document.querySelector('#selection .handle[data-handle="e"]');
  await TestUtils.waitForCondition(() => {
    const r = handleEl()?.getBoundingClientRect();
    const b = app.toScreen(app.find("b"));
    return r?.width && Math.abs(r.left + r.width / 2 - (b.x + b.w + win.document.getElementById("viewport").getBoundingClientRect().left)) < 3;
  }, "The resize handle is in place");
  const handle = handleEl().getBoundingClientRect();
  const from = { x: handle.left + handle.width / 2, y: handle.top + handle.height / 2 };
  // The easel page lives in the parent process, so synthesized mouse events
  // are hit-tested against the whole browser window: a toast or panel left
  // over from an earlier test that covers the handle takes the drag. Wait
  // until the page itself is what's under the handle and the next point.
  const pageBrowser = gBrowser.selectedBrowser;
  const covered = pt => {
    const r = pageBrowser.getBoundingClientRect();
    return document.elementFromPoint(r.left + pt.x, r.top + pt.y) != pageBrowser;
  };
  await TestUtils.waitForCondition(
    () => !covered(from) && !covered({ x: from.x + 157, y: from.y }),
    "Nothing in the window covers the handle"
  );
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

// wave9: a live capture's <browser> sits in the easel page, a system-principal
// document in a tab's (content) docshell. Gecko only lets such a document
// host a remote <browser> when it's allowed (about:addons, and about:whimsy
// ?easel via whimsy-nsFrameLoader-cpp.patch); otherwise the browser never gets
// a content process and fires oop-browser-crashed with childID 0 (wave 7).
// Play must give it a live web process that runs and paints the page.
add_task(async function test_live_capture_gets_a_live_process_and_renders() {
  const pageTab = await BrowserTestUtils.openNewForegroundTab(gBrowser, LIVE_PAGE);
  registerCleanupFunction(() => pageTab.isConnected && BrowserTestUtils.removeTab(pageTab));
  const region = { left: 0, top: 0, right: 300, bottom: 150, width: 300, height: 150 };
  const capture = await WhimsyEasel.captureRegion(pageTab.linkedBrowser, { region, devicePixelRatio: 1, viewportWidth: 800, viewportHeight: 600 });
  is(capture.item?.url, LIVE_PAGE, "The test page is captured");

  const { easel, tab, win, app } = await openNewEasel();
  const crashes = [];
  // Capture phase on the easel window: hears the event before the capture's
  // own handler stops it.
  win.addEventListener("oop-browser-crashed", e => crashes.push(e.childID), true);
  // And the tab browser must never hear a crash from inside the easel.
  const tabCrashes = [];
  const onTabCrash = e => tabCrashes.push(e.originalTarget);
  gBrowser.tabpanels.addEventListener("oop-browser-crashed", onTabCrash);
  registerCleanupFunction(() => gBrowser.tabpanels.removeEventListener("oop-browser-crashed", onTabCrash));

  await WhimsyEasel.addCaptureTo(window, easel.id, capture);
  const item = await TestUtils.waitForCondition(() => app.items.find(i => i.type == "capture"), "The capture is on the easel");
  // The item is in the list before the easel has drawn its element (a
  // frame later, longer on a loaded machine).
  const el = await TestUtils.waitForCondition(() => app.els.get(item.id), "The item is drawn");
  app.select([item.id]);
  win.document.querySelector('#contextbar [data-action="live"]').click();
  ok(app.find(item.id).live, "Play makes it live");

  const browser = await TestUtils.waitForCondition(() => el.querySelector(".capture-browser"), "The live <browser> is made");
  await TestUtils.waitForCondition(
    () => browser.currentURI?.spec == LIVE_PAGE && browser.browsingContext?.currentWindowGlobal && !browser.webProgress?.isLoadingDocument,
    "The live capture loads the test page"
  );
  Assert.deepEqual(crashes, [], "No oop-browser-crashed from the live capture");
  Assert.deepEqual(tabCrashes, [], "No crash reached the tab browser");
  ok(browser.isConnected && el.contains(browser), "The live browser is still on the easel");
  ok(!el.querySelector(".capture-note"), "No stopped note");
  ok(browser.isRemoteBrowser, "The live capture runs out of process");
  ok(browser.frameLoader.childID > 0, `It has a content process (childID ${browser.frameLoader.childID})`);
  ok(browser.remoteType?.startsWith("web"), `In a web process (${browser.remoteType})`);
  const wgp = browser.browsingContext.currentWindowGlobal;
  ok(wgp.osPid > 0 && wgp.osPid != Services.appinfo.processID, "Not in the parent process");
  ok(browser.browsingContext.sandboxFlags & 0x2, "Sandboxed like note blocks");

  // The page's own script ran in that process.
  const ran = await SpecialPowers.spawn(browser, [], () => content.document.getElementById("marker")?.dataset.ran);
  is(ran, "yes", "The page's script runs in the live capture");

  // It paints: the content process draws the page's magenta background.
  const stage = el.querySelector(".capture-stage");
  await TestUtils.waitForCondition(() => stage.classList.contains("ready"), "The stage shows the live page");
  const box = browser.getBoundingClientRect();
  ok(box.width > 0 && box.height > 0, "The live browser has a size on the easel");
  const bitmap = await whimsySnapshot(wgp, new DOMRect(0, 60, 40, 40));
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(bitmap, 0, 0);
  const [r, g, b] = ctx.getImageData(Math.floor(bitmap.width / 2), Math.floor(bitmap.height / 2), 1, 1).data;
  ok(r > 230 && g < 30 && b > 150 && b < 190, `The live capture renders the page (rgb ${r}, ${g}, ${b})`);

  // Still alive after the tab goes to the background and comes back.
  gBrowser.selectedTab = pageTab;
  gBrowser.selectedTab = tab;
  await new Promise(r => win.requestAnimationFrame(r));
  Assert.deepEqual(crashes, [], "Still no crash after switching tabs");
  ok(browser.isRemoteBrowser && browser.frameLoader.childID > 0, "Still live");

  // Pause drops the live page.
  app.select([item.id]);
  win.document.querySelector('#contextbar [data-action="live"]').click();
  ok(!el.querySelector(".capture-browser"), "Paused: the live page is gone");
  gBrowser.tabpanels.removeEventListener("oop-browser-crashed", onTabCrash);
  BrowserTestUtils.removeTab(pageTab);
});

// A live capture whose <browser> crashes goes back to the still capture with
// a note, and the crash never reaches the tab browser; Cmd+R tries again.
add_task(async function test_live_capture_crash_falls_back_to_still() {
  const pageTab = await BrowserTestUtils.openNewForegroundTab(gBrowser, CRASH_PAGE);
  registerCleanupFunction(() => pageTab.isConnected && BrowserTestUtils.removeTab(pageTab));
  const region = { left: 0, top: 0, right: 300, bottom: 150, width: 300, height: 150 };
  const capture = await WhimsyEasel.captureRegion(pageTab.linkedBrowser, { region, devicePixelRatio: 1, viewportWidth: 800, viewportHeight: 600 });
  const { easel, win, app } = await openNewEasel();
  await WhimsyEasel.addCaptureTo(window, easel.id, capture);
  const item = await TestUtils.waitForCondition(() => app.items.find(i => i.type == "capture"), "The capture is on the easel");
  // The item is in the list before the easel has drawn its element (a
  // frame later, longer on a loaded machine).
  const el = await TestUtils.waitForCondition(() => app.els.get(item.id), "The item is drawn");
  app.select([item.id]);
  win.document.querySelector('#contextbar [data-action="live"]').click();
  const browser = await TestUtils.waitForCondition(() => el.querySelector(".capture-browser"), "The live <browser> is made");
  await TestUtils.waitForCondition(() => browser.browsingContext?.currentWindowGlobal?.documentURI?.spec == CRASH_PAGE, "Loaded");

  // The test page's tab shares the capture's web process: close it first so
  // only the capture crashes.
  BrowserTestUtils.removeTab(pageTab);
  const tabCrashes = [];
  const onTabCrash = e => e.originalTarget == browser && tabCrashes.push(e.originalTarget);
  gBrowser.tabpanels.addEventListener("oop-browser-crashed", onTabCrash);
  registerCleanupFunction(() => gBrowser.tabpanels.removeEventListener("oop-browser-crashed", onTabCrash));
  await BrowserTestUtils.crashFrame(browser, /* shouldShowTabCrashPage */ false);
  await TestUtils.waitForCondition(() => !el.querySelector(".capture-stage"), "The crashed live page is taken down");
  ok(el.querySelector("img"), "The still capture shows");
  const note = el.querySelector(".capture-note");
  is(note?.getAttribute("data-l10n-id"), "whimsy-easel-live-stopped", "A note says the live page stopped");
  Assert.deepEqual(tabCrashes, [], "The crash never reached the tab browser");
  ok(app.find(item.id).live, "The capture stays live in the easel's document");

  // Cmd+R (refresh) tries again.
  app.refreshLive();
  const again = await TestUtils.waitForCondition(() => el.querySelector(".capture-browser"), "Refresh makes a new live <browser>");
  await TestUtils.waitForCondition(() => again.isRemoteBrowser && again.frameLoader.childID > 0, "with a live process");
  ok(!el.querySelector(".capture-note"), "The note is gone");
});

// wave9: easels are per profile, like Notes (W8-49). Each profile sees only
// its own easels (Library list, Add to Easel picker, the page itself); a
// capture only lands on its profile's easels; easels from before profiles
// are Default's; private windows, private tabs and Scratch (whose tabs are
// private) make no persistent easel; a deleted profile's easels go with it.
add_task(async function test_easels_are_per_profile() {
  const workKey = WhimsyProfiles.keyFor(2);
  isnot(workKey, "default", "Container 2 is a profile of its own");

  // Migration: an easel saved before profiles is Default's.
  const old = [{ id: "a", items: [] }, { id: "b", profileKey: workKey, items: [] }];
  ok(migrateEasels(old), "Old easels are migrated");
  is(old[0].profileKey, "default", "to the Default profile");
  is(old[1].profileKey, workKey, "and a profile's easel keeps its profile");
  ok(!migrateEasels(old), "Only once");
  is(profileKeyOf({}), "default", "No key reads as Default");

  // The store keeps them apart.
  const mine = await gWhimsyEaselStore.create({ title: "Default board" });
  const work = await gWhimsyEaselStore.create({ title: "Work board", profileKey: workKey });
  registerCleanupFunction(async () => {
    await gWhimsyEaselStore.remove(mine.id);
    await gWhimsyEaselStore.remove(work.id);
  });
  is(mine.profileKey, "default", "A new easel is Default's unless told otherwise");
  const defaults = await gWhimsyEaselStore.list("default");
  ok(defaults.some(e => e.id == mine.id) && !defaults.some(e => e.id == work.id), "Default sees only its easels");
  const works = await gWhimsyEaselStore.list(workKey);
  ok(works.some(e => e.id == work.id) && !works.some(e => e.id == mine.id), "Work sees only its easels");

  // A synced copy without a profile (an older Whimsy) is Default's.
  const remoteId = "0a1b2c3d-9999-2222-3333-444455556666";
  await gWhimsyEaselStore.applyRemote({ id: remoteId, title: "Old device", items: [], updated: Date.now() });
  registerCleanupFunction(() => gWhimsyEaselStore.remove(remoteId));
  is((await gWhimsyEaselStore.get(remoteId)).profileKey, "default", "Synced easels without a profile are Default's");

  // In a space of the Work profile: New Easel makes a Work easel in a Work tab.
  const home = gZenWorkspaces.getActiveWorkspace();
  const space = await containerSpace(2);
  await gZenWorkspaces.changeWorkspace(space);
  is(WhimsyEasel.profileKeyForWindow(window), workKey, "The window's profile follows its space");
  const { easel: fresh, tab: freshTab, app } = await openNewEasel();
  is(fresh.profileKey, workKey, "New Easel in a Work space makes a Work easel");
  is(freshTab.userContextId, 2, "opened in Work's container");
  is(app.profileKey, workKey, "The page knows its profile");

  // The Add to Easel picker lists only the capture's profile's easels.
  const menu = await WhimsyEasel.showPicker(window, gBrowser.selectedBrowser, { x: 0, y: 0 }, () => {}, workKey);
  const labels = [...menu.querySelectorAll(".whimsy-easel-tile-name")].map(n => n.textContent);
  ok(labels.includes("Work board"), "The picker lists Work's easels");
  ok(!labels.includes("Default board"), "and not Default's");
  menu.hidePopup();

  // A capture never lands on another profile's easel.
  const blob = new Blob([new Uint8Array([137, 80, 78, 71])], { type: "image/png" });
  const crossed = await WhimsyEasel.addCaptureTo(window, mine.id, { blob, item: { type: "capture", url: PAGE, profileKey: workKey, w: 10, h: 10, crop: { x: 0, y: 0, w: 10, h: 10 } } });
  is(crossed, null, "A Work capture is refused by a Default easel");
  is((await gWhimsyEaselStore.get(mine.id)).items.length, 0, "and nothing was added");
  const added = await WhimsyEasel.addCaptureTo(window, work.id, { blob, item: { type: "capture", url: PAGE, userContextId: 0, profileKey: workKey, w: 10, h: 10, crop: { x: 0, y: 0, w: 10, h: 10 } } });
  is(added, work.id, "It goes on a Work easel");
  const [capture] = (await gWhimsyEaselStore.get(work.id)).items;
  is(capture.userContextId, 2, "and its live view will load in Work's container");
  ok(!("profileKey" in capture), "The item doesn't carry a profile of its own");

  // A Default easel's address opened in a Work tab stays closed.
  const crossTab = gBrowser.addTrustedTab(easelURL(mine.id), { userContextId: 2 });
  registerCleanupFunction(() => crossTab.isConnected && BrowserTestUtils.removeTab(crossTab));
  await TestUtils.waitForCondition(
    () => crossTab.linkedBrowser.contentDocument?.documentElement?.getAttribute("ready") == "true",
    "The cross-profile page settles"
  );
  const crossDoc = crossTab.linkedBrowser.contentDocument;
  ok(!crossDoc.getElementById("off").hidden, "It shows the closed state");
  is(crossDoc.querySelector("#off h1").getAttribute("data-l10n-id"), "whimsy-easel-other-profile-title", "saying the easel is another profile's");
  ok(crossDoc.getElementById("easel").hidden, "and none of its items");
  BrowserTestUtils.removeTab(crossTab);
  await gZenWorkspaces.changeWorkspace(home);

  // Deleting a profile takes its easels (and only its).
  const removed = await gWhimsyEaselStore.removeForProfile(workKey);
  ok(removed.includes(work.id) && removed.includes(fresh.id), "The profile's easels are deleted with it");
  ok(await gWhimsyEaselStore.get(mine.id), "Default's stay");
  Assert.deepEqual(await gWhimsyEaselStore.removeForProfile("default"), [], "Default's easels are never removed this way");
});

// wave9: private tabs, private windows and Scratch keep no easel.
add_task(async function test_private_never_makes_an_easel() {
  const before = (await gWhimsyEaselStore.list()).length;

  const privateWin = await BrowserTestUtils.openNewBrowserWindow({ private: true });
  ok(!WhimsyEasel.canPersistIn(privateWin), "A private window can't keep easels");
  is(await WhimsyEasel.newEasel(privateWin), null, "New Easel does nothing there");
  await BrowserTestUtils.closeWindow(privateWin);

  // A private tab in a normal window (what Scratch opens).
  await SpecialPowers.pushPrefEnv({ set: [["whimsy.private.in-window", true]] });
  const privateTab = WhimsyPrivate.openPrivateTab(window, { url: PAGE, force: true });
  ok(privateTab && WhimsyPrivate.isPrivateTab(privateTab), "A private tab is open");
  registerCleanupFunction(() => privateTab.isConnected && BrowserTestUtils.removeTab(privateTab));
  gBrowser.selectedTab = privateTab;
  ok(!WhimsyEasel.canPersistIn(window), "With a private tab in front, no easel is kept");
  is(await WhimsyEasel.newEasel(window), null, "New Easel does nothing");
  BrowserTestUtils.removeTab(privateTab);
  await SpecialPowers.popPrefEnv();

  // whimsy://easel in a private window: the page makes nothing.
  const privateWin2 = await BrowserTestUtils.openNewBrowserWindow({ private: true });
  const pageTab = privateWin2.gBrowser.addTrustedTab("about:whimsy?easel");
  privateWin2.gBrowser.selectedTab = pageTab;
  await TestUtils.waitForCondition(
    () => pageTab.linkedBrowser.contentDocument?.documentElement?.getAttribute("ready") == "true",
    "The private easel page settles"
  );
  is(pageTab.linkedBrowser.contentDocument.querySelector("#off h1").getAttribute("data-l10n-id"), "whimsy-easel-private-title", "It says easels aren't kept in private browsing");
  await BrowserTestUtils.closeWindow(privateWin2);

  is((await gWhimsyEaselStore.list()).length, before, "No easel was made");
});
