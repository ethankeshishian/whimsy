/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// W13 F07: every floating surface drags by its header (wave12 F07's rule):
// a 6-dot grip before the title and a grab cursor; the shadow deepens while
// it moves; it stays where you leave it for the rest of the session (the
// next open goes there); a double-click on the header puts it back where
// it opened by itself. Driven with real mouse presses and moves on the
// header, for Page tools, the font card (What Font) and Quick Note.

const { WhimsySurface } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsySurface.sys.mjs");
const { WhimsyPageDev } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyPageDev.sys.mjs");
const { WhimsyInspector } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyInspector.sys.mjs");
const { WhimsyNotes } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyNotesSection.sys.mjs");

const PAGE =
  getRootDirectory(gTestPath).replace("chrome://mochitests/content", "https://example.com") + "whimsy_pagedev.html";

registerCleanupFunction(() => WhimsySurface.forgetDragPositions());

async function shown(id) {
  const panel = await TestUtils.waitForCondition(() => {
    const p = document.getElementById(id);
    return p?.state == "open" ? p : null;
  }, `${id} opens`);
  await TestUtils.waitForTick();
  return panel;
}

async function close(panel) {
  const hidden = BrowserTestUtils.waitForEvent(panel, "popuphidden");
  panel.hidePopup();
  await hidden;
}

// A spot on the header that isn't a button: just past the grip.
function grabPoint(header) {
  const grip = header.querySelector(".whimsy-surface-grip");
  const r = grip.getBoundingClientRect();
  return { x: r.right + 4, y: r.top + r.height / 2 };
}

// Press on the header, move in two steps, let go. Returns the shadow seen
// mid-drag.
async function drag(panel, header, dx, dy) {
  const { x, y } = grabPoint(header);
  const before = getComputedStyle(panel).getPropertyValue("--panel-shadow");
  EventUtils.synthesizeMouseAtPoint(x, y, { type: "mousedown" });
  EventUtils.synthesizeMouseAtPoint(x + dx / 2, y + dy / 2, { type: "mousemove" });
  const during = {
    dragging: panel.hasAttribute("dragging"),
    shadow: getComputedStyle(panel).getPropertyValue("--panel-shadow"),
    cursor: getComputedStyle(header).cursor,
  };
  EventUtils.synthesizeMouseAtPoint(x + dx, y + dy, { type: "mousemove" });
  EventUtils.synthesizeMouseAtPoint(x + dx, y + dy, { type: "mouseup" });
  await TestUtils.waitForTick();
  return { before, during };
}

function near(a, b, what) {
  Assert.less(Math.abs(a - b), 2, `${what} (${a} vs ${b})`);
}

add_task(async function test_page_tools_drag_and_stay() {
  WhimsySurface.forgetDragPositions();
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE);
  WhimsyPageDev.showColors(window);
  let panel = await shown("whimsy-pagedev");
  let header = panel.querySelector(".whimsy-surface-header");
  ok(header.classList.contains("whimsy-surface-drag-handle"), "The header is the handle");
  const grip = header.firstElementChild;
  ok(grip.classList.contains("whimsy-surface-grip") && grip.getAttribute("aria-hidden") == "true", "A grip before the title");
  is(getComputedStyle(header).cursor, "grab", "Grab cursor");

  const home = panel.getOuterScreenRect();
  const { before, during } = await drag(panel, header, -140, 90);
  ok(during.dragging, "[dragging] while it moves");
  isnot(during.shadow, before, "Its shadow deepens while lifted");
  is(during.cursor, "grabbing", "Grabbing cursor");
  ok(!panel.hasAttribute("dragging"), "Let go");
  const moved = panel.getOuterScreenRect();
  near(moved.left, home.left - 140, "Moved across");
  near(moved.top, home.top + 90, "Moved down");
  is(panel.state, "open", "Dragging doesn't close it");

  // A press on the close button doesn't drag.
  const closeButton = header.querySelector(".whimsy-surface-close");
  EventUtils.synthesizeMouseAtCenter(closeButton, { type: "mousedown" });
  ok(!panel.hasAttribute("dragging"), "The close button isn't a handle");
  EventUtils.synthesizeMouseAtCenter(closeButton, { type: "mouseup" });
  await TestUtils.waitForCondition(() => !document.getElementById("whimsy-pagedev"), "…it closes");

  // Opened again: where it was left.
  WhimsyPageDev.showColors(window);
  panel = await shown("whimsy-pagedev");
  header = panel.querySelector(".whimsy-surface-header");
  const again = panel.getOuterScreenRect();
  near(again.left, moved.left, "Reopens where it was left (x)");
  near(again.top, moved.top, "…and y");

  // Double-click the header: back home, and forgotten.
  const { x, y } = grabPoint(header);
  EventUtils.synthesizeMouseAtPoint(x, y, {});
  EventUtils.synthesizeMouseAtPoint(x, y, {});
  await TestUtils.waitForCondition(() => Math.abs(panel.getOuterScreenRect().left - home.left) < 2, "A double-click puts it back");
  near(panel.getOuterScreenRect().top, home.top, "…all the way");
  await close(panel);
  WhimsyPageDev.showColors(window);
  panel = await shown("whimsy-pagedev");
  near(panel.getOuterScreenRect().left, home.left, "…and the next open is home too");
  await close(panel);
  BrowserTestUtils.removeTab(tab);
});

add_task(async function test_font_card_drags_for_this_card_only() {
  WhimsySurface.forgetDragPositions();
  let panel = WhimsyInspector.showFontPopover(window, null, { state: "unavailable" });
  panel = await shown(panel.id);
  const header = panel.querySelector(".whimsy-surface-header");
  ok(header?.querySelector(".whimsy-surface-grip"), "What Font has a header with a grip");
  await document.l10n.translateFragment(header);
  ok(header.querySelector(".whimsy-surface-title").textContent, "…and a title");
  const home = panel.getOuterScreenRect();
  await drag(panel, header, 120, 60);
  near(panel.getOuterScreenRect().left, home.left + 120, "It drags");
  await close(panel);
  panel = await shown(WhimsyInspector.showFontPopover(window, null, { state: "unavailable" }).id);
  near(panel.getOuterScreenRect().left, home.left, "The next card opens at its text again, not where the last was left");
  await close(panel);
});

add_task(async function test_quick_note_drags_and_stays() {
  WhimsySurface.forgetDragPositions();
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.com/");
  await WhimsyNotes.openQuickNote(window);
  let panel = await shown("whimsy-quick-note");
  const header = panel.querySelector(".whimsy-look-picker-header");
  ok(header.querySelector(".whimsy-surface-grip"), "Quick Note's header has the grip");
  is(getComputedStyle(header).cursor, "grab", "…and drags");
  const home = panel.getOuterScreenRect();
  await drag(panel, header, 160, 40);
  const moved = panel.getOuterScreenRect();
  near(moved.left, home.left + 160, "It moves");
  // Esc keeps nothing (empty) and closes it.
  const hidden = BrowserTestUtils.waitForEvent(panel, "popuphidden");
  EventUtils.synthesizeKey("KEY_Escape");
  await hidden;
  await WhimsyNotes.openQuickNote(window);
  panel = await shown("whimsy-quick-note");
  near(panel.getOuterScreenRect().left, moved.left, "Reopens where it was left");
  await close(panel);
  BrowserTestUtils.removeTab(tab);
});
