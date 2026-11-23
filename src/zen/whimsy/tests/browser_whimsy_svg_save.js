/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// W30 svg-save (whimsy.feature.svg-save): Save Image As on an SVG opens the
// Save image dialog (SVG, PNG or JPG; background; size). Covers where the
// menu rows show (an SVG <img>, an inline <svg>, an <object>, a PNG), the
// dialog's first state, the locked proportions both ways, JPG and Clear,
// the page colour, the clamp and its note, file names, the PNG and JPG
// files (decoded: size and background pixels), the SVG option saving the
// original bytes, Esc and Enter, and the note's contrast.

const DIR = getRootDirectory(gTestPath).replace("chrome://mochitests/content", "https://example.com");
const PAGE = DIR + "whimsy_svg_save.html";
const LOGO = DIR + "whimsy_svg_save_logo.svg";
const { WhimsySvgSave, clampSize, fileNameFor, MAX_SIDE, MAX_AREA } = ChromeUtils.importESModule(
  "resource:///modules/whimsy/WhimsySvgSave.sys.mjs"
);
const { Downloads } = ChromeUtils.importESModule("resource://gre/modules/Downloads.sys.mjs");
const BACKGROUND_PREF = "whimsy.svg-save.background";

let downloadDir = null;

add_setup(async function () {
  downloadDir = await useTempDownloadDir();
  await SpecialPowers.pushPrefEnv({
    set: [
      ["whimsy.feature.svg-save", true],
      ["browser.download.alwaysOpenPanel", false],
      ["browser.download.always_ask_before_handling_new_types", false],
    ],
  });
  Services.prefs.clearUserPref(BACKGROUND_PREF);
  registerCleanupFunction(async () => {
    Services.prefs.clearUserPref(BACKGROUND_PREF);
    const list = await Downloads.getList(Downloads.PUBLIC);
    for (const download of await list.getAll()) {
      await list.remove(download);
      await download.finalize(true);
    }
    closeToasts();
  });
});

const menu = () => document.getElementById("contentAreaContextMenu");
const row = () => document.getElementById(WhimsySvgSave.MENU_ID);
const shown = item => !!item && !item.hidden && !item.collapsed;
const $ = id => document.getElementById(`${WhimsySvgSave.PANEL_ID}-${id}`);

async function openMenuOn(browser, selector) {
  const popup = menu();
  const opened = BrowserTestUtils.waitForPopupEvent(popup, "shown");
  await BrowserTestUtils.synthesizeMouseAtCenter(selector, { type: "contextmenu", button: 2 }, browser);
  await opened;
  return popup;
}

async function closeMenu() {
  const popup = menu();
  if (popup.state == "closed") {
    return;
  }
  const hidden = BrowserTestUtils.waitForPopupEvent(popup, "hidden");
  popup.hidePopup();
  await hidden;
}

// The visible row right after `item` in the menu.
function nextShown(item) {
  let next = item.nextElementSibling;
  while (next && !shown(next)) {
    next = next.nextElementSibling;
  }
  return next;
}

// Right-clicks `selector`, uses the row `itemId`, and waits for the dialog.
async function openDialog(browser, selector, itemId) {
  WhimsySvgSave._dialog = null;
  const popup = await openMenuOn(browser, selector);
  const item = document.getElementById(itemId);
  ok(shown(item), `${itemId} shows`);
  const hidden = BrowserTestUtils.waitForPopupEvent(popup, "hidden");
  popup.activateItem(item);
  await hidden;
  await TestUtils.waitForCondition(() => WhimsySvgSave._dialog?.panel.state == "open", "the Save image dialog opened");
  const dialog = WhimsySvgSave._dialog;
  await TestUtils.waitForCondition(() => $("save").label, "the dialog's strings are in");
  return dialog;
}

async function closeDialog(dialog) {
  if (dialog.panel.state == "closed") {
    return;
  }
  const hidden = BrowserTestUtils.waitForPopupEvent(dialog.panel, "hidden");
  dialog.panel.hidePopup();
  await hidden;
}

function click(node) {
  EventUtils.synthesizeMouseAtCenter(node, {}, node.ownerDocument.defaultView);
}

function setField(input, value) {
  input.focus();
  input.select();
  EventUtils.sendString(String(value), window);
}

// The next file that lands in the temp Downloads folder.
async function nextFile(before) {
  let path = null;
  await TestUtils.waitForCondition(async () => {
    const list = await Downloads.getList(Downloads.PUBLIC);
    const done = (await list.getAll()).find(d => d.succeeded && !before.has(d.target.path));
    path = done?.target.path ?? null;
    return !!path;
  }, "a file was saved");
  return path;
}

async function savedPaths() {
  const list = await Downloads.getList(Downloads.PUBLIC);
  return new Set((await list.getAll()).map(d => d.target.path));
}

// The saved image decoded: its size and the RGBA at (x, y).
async function decode(path, points) {
  const bytes = await IOUtils.read(path);
  const type = path.endsWith(".png") ? "image/png" : "image/jpeg";
  const bitmap = await window.createImageBitmap(new Blob([bytes], { type }));
  const canvas = document.createElementNS("http://www.w3.org/1999/xhtml", "canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(bitmap, 0, 0);
  const pixels = points.map(([x, y]) => [...ctx.getImageData(x, y, 1, 1).data]);
  return { width: bitmap.width, height: bitmap.height, pixels, bytes };
}

function near(actual, expected, label, tolerance = 6) {
  ok(
    expected.every((c, i) => Math.abs(actual[i] - c) <= tolerance),
    `${label}: ${actual.join(",")} is about ${expected.join(",")}`
  );
}

function contrast(a, b) {
  const lum = ([r, g, b2]) => {
    const lin = c => ((c /= 255) <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
    return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b2);
  };
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

// A CSS colour as it shows over the panel's background.
function shownRGB(el) {
  const canvas = document.createElementNS("http://www.w3.org/1999/xhtml", "canvas");
  canvas.width = canvas.height = 1;
  const ctx = canvas.getContext("2d");
  const paint = value => {
    ctx.fillStyle = value;
    ctx.fillRect(0, 0, 1, 1);
    return [...ctx.getImageData(0, 0, 1, 1).data.slice(0, 3)];
  };
  const chain = [];
  for (let node = el; node && node.nodeType == 1; node = node.parentElement) {
    chain.unshift(getComputedStyle(node).backgroundColor);
  }
  paint("white");
  let bg = null;
  for (const value of chain) {
    bg = paint(value);
  }
  return { bg, fg: paint(getComputedStyle(el).color) };
}

add_task(async function test_menu_rows() {
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE);
  const browser = tab.linkedBrowser;

  // An SVG <img>: Firefox's own Save Image As, no page row.
  await openMenuOn(browser, "#img");
  ok(shown(document.getElementById("context-saveimage")), "an SVG image keeps Firefox's Save Image As");
  ok(!shown(row()), "no page row on an SVG <img>");
  await closeMenu();

  // An inline <svg>: the page row, right below Save Page As.
  await openMenuOn(browser, "#inline");
  ok(shown(row()), "an inline SVG gets Save Image As in the page menu");
  is(nextShown(document.getElementById("context-savepage")), row(), "directly below Save Page As");
  ok(!shown(document.getElementById("context-saveimage")), "Firefox's image row stays hidden");
  await TestUtils.waitForCondition(() => row().label, "the row's string is in");
  is(row().label, "Save Image As…", "the row's label");
  await closeMenu();

  // An SVG in an <object>.
  await openMenuOn(browser, "#obj");
  ok(shown(row()), "an <object> SVG gets the page row");
  await closeMenu();

  // A PNG and plain text: Firefox's menus, untouched.
  await openMenuOn(browser, "#png");
  ok(shown(document.getElementById("context-saveimage")), "a PNG keeps Firefox's Save Image As");
  ok(!shown(row()), "no page row on a PNG");
  await closeMenu();
  await openMenuOn(browser, "#text");
  ok(!shown(row()), "no row on plain text");
  await closeMenu();

  // The switch.
  await SpecialPowers.pushPrefEnv({ set: [["whimsy.feature.svg-save", false]] });
  await openMenuOn(browser, "#inline");
  ok(!shown(row()), "the switch hides the row");
  await closeMenu();
  await SpecialPowers.popPrefEnv();

  BrowserTestUtils.removeTab(tab);
});

add_task(async function test_dialog_first_state_and_ratio() {
  Services.prefs.clearUserPref(BACKGROUND_PREF);
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE);
  const dialog = await openDialog(tab.linkedBrowser, "#inline", WhimsySvgSave.MENU_ID);
  const { panel } = dialog;

  is(dialog.state.format, "svg", "opens on SVG");
  is($("format-svg").getAttribute("aria-checked"), "true", "the SVG segment is checked");
  await TestUtils.waitForCondition(() => document.activeElement == $("format-svg"), "focus starts on the checked Format segment");
  is(dialog.state.background, "clear", "Clear the first time");
  ok(!panel.querySelector(".whimsy-surface-close"), "no ✕");
  is(panel.querySelector(".whimsy-surface-title").textContent, "Save image", "the title");
  for (const id of ["background-clear", "background-white", "background-page", "width", "height"]) {
    ok($(id).disabled, `${id} is disabled while SVG is picked`);
  }
  const sections = panel.querySelectorAll(".whimsy-svg-save-section");
  is(sections.length, 3, "Format, Background, and Size");
  ok(sections[1].classList.contains("whimsy-svg-save-off") && sections[2].classList.contains("whimsy-svg-save-off"),
    "Background and Size dim in place");
  ok(!$("save").disabled, "Save works for SVG");

  // The drawn size, and the viewBox's 2:1.
  is(dialog.width.value, "100", "width starts at the drawn size");
  is(dialog.height.value, "50", "height starts at the drawn size");
  const link = panel.querySelector(".whimsy-svg-save-link");
  is(link.getAttribute("role"), "img", "the chain link is a mark, not a button");
  await TestUtils.waitForCondition(() => link.getAttribute("aria-label"), "the mark's label is in");
  is(link.getAttribute("aria-label"), "Proportions locked to the original", "the mark's label");
  is(link.getAttribute("title"), "Proportions locked to the original", "the mark's tooltip");

  click($("format-png"));
  is(dialog.state.format, "png", "PNG picked");
  ok(!dialog.width.disabled && !$("background-clear").disabled, "PNG turns Background and Size on");
  ok(!sections[2].classList.contains("whimsy-svg-save-off"), "Size no longer dimmed");

  setField(dialog.width, "300");
  is(dialog.height.value, "150", "width sets the height");
  setField(dialog.height, "41");
  is(dialog.width.value, "82", "height sets the width");
  setField(dialog.width, "1");
  is(dialog.height.value, "1", "rounded, at least 1");
  setField(dialog.width, "0");
  ok($("save").disabled, "a side under 1 disables Save");
  click($("format-svg"));
  ok(!$("save").disabled, "SVG saves whatever the size says");

  // Esc cancels.
  const hidden = BrowserTestUtils.waitForPopupEvent(panel, "hidden");
  $("format-svg").focus();
  EventUtils.synthesizeKey("KEY_Escape", {}, window);
  await hidden;
  ok(true, "Esc closes the dialog");

  BrowserTestUtils.removeTab(tab);
});

add_task(async function test_jpg_clear_and_page_colour() {
  Services.prefs.clearUserPref(BACKGROUND_PREF);
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE);
  let dialog = await openDialog(tab.linkedBrowser, "#inline", WhimsySvgSave.MENU_ID);

  click($("format-png"));
  is(dialog.state.background, "clear", "PNG keeps Clear");
  click($("format-jpg"));
  ok($("background-clear").disabled, "JPG disables Clear");
  is(dialog.state.background, "white", "a Clear choice becomes White");
  is($("background-white").getAttribute("aria-checked"), "true", "White is checked");
  await TestUtils.waitForCondition(() => $("background-clear").getAttribute("title"), "Clear's tooltip is in");
  is($("background-clear").getAttribute("title"), "JPG can’t be transparent", "Clear says why");
  click($("format-png"));
  ok(!$("background-clear").disabled, "PNG turns Clear back on");
  ok(!$("background-clear").hasAttribute("title"), "and drops the tooltip");

  // Page: the nearest solid colour behind the SVG.
  is(dialog.info.background, "#FDF1E7", "the card's colour, behind the inline SVG");
  ok(!$("page-color").textContent.trim(), "no colour shown until Page is picked");
  click($("background-page"));
  is(Services.prefs.getStringPref(BACKGROUND_PREF), "page", "the choice is remembered");
  await TestUtils.waitForCondition(() => $("page-color").textContent.includes("#FDF1E7"), "the page colour shows");
  is($("page-color").textContent.trim(), "#FDF1E7, behind the SVG", "the caption's detail");
  const dot = $("page-color").querySelector(".whimsy-svg-save-dot");
  ok(dot, "with a colour dot");
  is(getComputedStyle(dot).backgroundColor, "rgb(253, 241, 231)", "the dot is the page colour");
  await closeDialog(dialog);

  // Remembered next time; a page with no colour behind it falls to body.
  dialog = await openDialog(tab.linkedBrowser, "#untitled", WhimsySvgSave.MENU_ID);
  is(dialog.state.background, "page", "the dialog opens on the remembered background");
  is(dialog.state.format, "svg", "but always on SVG");
  is(dialog.info.background, "#FFFFFF", "body's white when nothing nearer has a colour");
  await closeDialog(dialog);

  BrowserTestUtils.removeTab(tab);
});

add_task(async function test_clamp() {
  is(clampSize(100, 50), null, "a size that fits isn't changed");
  const side = clampSize(40000, 20000, 2, 1);
  ok(side.width <= MAX_SIDE && side.height <= MAX_SIDE && side.width * side.height <= MAX_AREA, "inside both limits");
  is(side.height, Math.round(side.width / 2), "proportions kept");
  const area = clampSize(30000, 30000, 1, 1);
  ok(area.width * area.height <= MAX_AREA && area.width == area.height, "the area limit, square kept");

  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE);
  const dialog = await openDialog(tab.linkedBrowser, "#inline", WhimsySvgSave.MENU_ID);
  click($("format-png"));
  ok(!dialog.note.textContent.trim(), "no note at first");
  setField(dialog.width, "90000");
  is(dialog.height.value, "45000", "the height follows before the clamp");
  dialog.height.focus(); // blur clamps
  const expected = clampSize(90000, 45000, 200, 100);
  is(dialog.width.value, String(expected.width), "width reduced");
  is(dialog.height.value, String(expected.height), "height reduced");
  ok(dialog.note.classList.contains("whimsy-svg-save-warn"), "the note turns amber");
  const fmt = n => n.toLocaleString("en-US");
  await TestUtils.waitForCondition(() => dialog.note.textContent.includes("Reduced"), "the note's string is in");
  is(dialog.note.textContent, `Reduced to ${fmt(expected.width)} × ${fmt(expected.height)}, Firefox’s largest size.`,
    "says what it was reduced to, with separators");

  // The amber note meets WCAG AA (11px text: 4.5:1).
  const { fg, bg } = shownRGB(dialog.note);
  const ratio = contrast(fg, bg);
  Assert.greaterOrEqual(ratio, 4.5, `the amber note's contrast is ${ratio.toFixed(2)}:1`);

  setField(dialog.width, "200");
  ok(!dialog.note.textContent.trim(), "typing again clears the note");
  await closeDialog(dialog);
  BrowserTestUtils.removeTab(tab);
});

add_task(async function test_file_names() {
  is(fileNameFor({ baseName: "logo", title: "Brand" }, "png"), "logo.png", "the SVG's file name first");
  is(fileNameFor({ baseName: "", title: "Brand mark" }, "jpg"), "Brand mark.jpg", "else its <title>");
  is(fileNameFor({ baseName: "", title: "" }, "svg"), "image.svg", "else image");
  ok(!fileNameFor({ baseName: "", title: "a/b:c" }, "png").includes("/"), "no path characters");
  is(fileNameFor({ baseName: "...", title: "" }, "png"), "image.png", "nothing left means image");
});

add_task(async function test_png_and_jpg_files() {
  Services.prefs.clearUserPref(BACKGROUND_PREF);
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE);
  const browser = tab.linkedBrowser;

  // PNG, clear, at twice the drawn size: sharp at 200 × 100, corners clear.
  let before = await savedPaths();
  let dialog = await openDialog(browser, "#inline", WhimsySvgSave.MENU_ID);
  click($("format-png"));
  setField(dialog.width, "200");
  is(dialog.height.value, "100", "2:1 kept");
  // Enter saves from a field.
  let hidden = BrowserTestUtils.waitForPopupEvent(dialog.panel, "hidden");
  EventUtils.synthesizeKey("KEY_Enter", {}, window);
  await hidden;
  let path = await nextFile(before);
  is(PathUtils.filename(path), "Brand mark.png", "named for the <title>");
  is(PathUtils.parent(path), downloadDir, "into the Downloads folder setting");
  let image = await decode(path, [[1, 1], [100, 50]]);
  is(image.width, 200, "PNG width");
  is(image.height, 100, "PNG height");
  is(image.pixels[0][3], 0, "Clear leaves the corner transparent");
  near(image.pixels[1], [0x1a, 0x73, 0xe8, 255], "the drawing in the middle");
  ok(!toastFor("whimsy-svg-save-failed-toast"), "no toast on success");

  // JPG, Page: the card's colour fills the corner.
  before = await savedPaths();
  dialog = await openDialog(browser, "#inline", WhimsySvgSave.MENU_ID);
  click($("format-jpg"));
  click($("background-page"));
  setField(dialog.width, "120");
  click($("save"));
  path = await nextFile(before);
  is(PathUtils.filename(path), "Brand mark.jpg", "JPG extension");
  image = await decode(path, [[2, 2]]);
  is(image.width, 120, "JPG width");
  is(image.height, 60, "JPG height");
  near(image.pixels[0], [0xfd, 0xf1, 0xe7, 255], "Page fills the background");

  // An SVG <img>: Firefox's Save Image As opens the dialog; White.
  before = await savedPaths();
  dialog = await openDialog(browser, "#img", "context-saveimage");
  is(dialog.info.kind, "img", "an <img>");
  is(dialog.width.value, "64", "the drawn width");
  click($("format-png"));
  click($("background-white"));
  click($("save"));
  path = await nextFile(before);
  is(PathUtils.filename(path), "whimsy_svg_save_logo.png", "named for the SVG's file");
  image = await decode(path, [[0, 0], [32, 32]]);
  is(image.width, 64, "the <img>'s size");
  near(image.pixels[0], [255, 255, 255, 255], "White fills the corner");
  near(image.pixels[1], [0xe8, 0x45, 0x3c, 255], "the circle, drawn sharp at the new size");

  BrowserTestUtils.removeTab(tab);
});

add_task(async function test_svg_saves_the_original() {
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE);
  const browser = tab.linkedBrowser;
  const original = await (await fetch(LOGO)).text();

  // An SVG <img>: the file itself.
  let before = await savedPaths();
  let dialog = await openDialog(browser, "#img", "context-saveimage");
  let hidden = BrowserTestUtils.waitForPopupEvent(dialog.panel, "hidden");
  EventUtils.synthesizeKey("KEY_Enter", {}, window);
  await hidden;
  let path = await nextFile(before);
  is(PathUtils.filename(path), "whimsy_svg_save_logo.svg", "the SVG's own name");
  is(await IOUtils.readUTF8(path), original, "the original bytes");

  // An inline SVG: its markup as a file, without scripts or handlers.
  before = await savedPaths();
  dialog = await openDialog(browser, "#inline", WhimsySvgSave.MENU_ID);
  click($("save"));
  path = await nextFile(before);
  is(PathUtils.filename(path), "Brand mark.svg", "named for the <title>");
  const text = await IOUtils.readUTF8(path);
  ok(text.startsWith("<svg") && text.includes('viewBox="0 0 200 100"') && text.includes("#1A73E8"), "the inline SVG's markup");
  ok(!text.includes("<script") && !text.includes("onclick"), "no scripts or handlers");

  // Untitled inline SVG: image.svg.
  before = await savedPaths();
  dialog = await openDialog(browser, "#untitled", WhimsySvgSave.MENU_ID);
  click($("save"));
  path = await nextFile(before);
  is(PathUtils.filename(path), "image.svg", "no name or title: image");

  BrowserTestUtils.removeTab(tab);
});
