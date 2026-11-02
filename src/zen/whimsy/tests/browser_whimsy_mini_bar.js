/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// wave9/mini W8-21: Arc's "Open in <Space> ⌘O" is one target: the hover
// highlight runs behind the ⌘O keycap too, and clicking the keycap opens
// the page in the space.
// wave9/mini W8-22: the space dropdown is Arc's popover (Mini's own frame
// colour, hairline edge, rounded rows in the bar's hover fill), not the
// system menu.

const { WhimsyQuickWindow } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyQuickWindow.sys.mjs");

add_setup(async function () {
  await SpecialPowers.pushPrefEnv({ set: [["whimsy.quick-window.size", ""]] });
});

registerCleanupFunction(async () => {
  for (const win of WhimsyQuickWindow.windows()) {
    await WhimsyQuickWindow.whenReady(win);
    await BrowserTestUtils.closeWindow(win);
  }
});

async function openMini() {
  const win = WhimsyQuickWindow.open("https://example.com/", { opener: window });
  await WhimsyQuickWindow.whenReady(win);
  const move = () => win.document.getElementById("whimsy-quick-window-move-to-space");
  await TestUtils.waitForCondition(() => move()?.getAttribute("label") && !move().disabled, "Open in <Space> is ready");
  await TestUtils.waitForCondition(
    () => win.gBrowser.selectedBrowser.currentURI.spec == "https://example.com/",
    "Mini loaded its page"
  );
  await SimpleTest.promiseFocus(win);
  return win;
}

// The colour a Mini token resolves to, read from a probe in the bar.
function tokenColor(win, token) {
  const probe = win.document.createElementNS("http://www.w3.org/1999/xhtml", "div");
  probe.style.background = `var(${token})`;
  win.document.getElementById("whimsy-quick-window-bar").append(probe);
  const color = win.getComputedStyle(probe).backgroundColor;
  probe.remove();
  return color;
}

add_task(async function test_open_in_highlight_covers_the_keycap() {
  const win = await openMini();
  try {
    const doc = win.document;
    const move = doc.getElementById("whimsy-quick-window-move-to-space");
    const kbd = doc.querySelector("#whimsy-quick-window-open > kbd");
    ok(kbd, "The ⌘O keycap sits in the Open in pill");
    const hover = tokenColor(win, "--whimsy-mini-fill-hover");

    EventUtils.synthesizeMouseAtCenter(move, { type: "mousemove" }, win);
    await TestUtils.waitForCondition(() => move.matches(":hover"), "Pointer over Open in");
    await TestUtils.waitForCondition(() => win.getComputedStyle(move).backgroundColor == hover, "Open in lights up");
    await TestUtils.waitForCondition(() => win.getComputedStyle(kbd).backgroundColor == hover,
      "...and the highlight extends behind ⌘O (W8-21)");
    is(kbd.getBoundingClientRect().height, move.getBoundingClientRect().height,
      "The keycap's highlight fills the pill's full height");

    EventUtils.synthesizeMouseAtCenter(kbd, { type: "mousemove" }, win);
    await TestUtils.waitForCondition(() => kbd.matches(":hover"), "Pointer over ⌘O");
    await TestUtils.waitForCondition(() => win.getComputedStyle(move).backgroundColor == hover,
      "Hovering ⌘O lights the whole Open in segment");

    const caret = doc.getElementById("whimsy-quick-window-choose-space");
    EventUtils.synthesizeMouseAtCenter(caret, { type: "mousemove" }, win);
    await TestUtils.waitForCondition(() => caret.matches(":hover"), "Pointer over the caret");
    isnot(win.getComputedStyle(kbd).backgroundColor, hover, "The caret keeps its own highlight");

    const tabCountBefore = gBrowser.tabs.length;
    EventUtils.synthesizeMouseAtCenter(kbd, {}, win);
    await TestUtils.waitForCondition(() => win.closed, "Clicking ⌘O opens the page in the space");
    is(gBrowser.tabs.length, tabCountBefore + 1, "The tab landed in the current space");
    const adopted = gBrowser.tabs[gBrowser.tabs.length - 1];
    is(adopted.linkedBrowser.currentURI.spec, "https://example.com/", "It's Mini's page");
    BrowserTestUtils.removeTab(adopted);
  } finally {
    if (!win.closed) {
      await BrowserTestUtils.closeWindow(win);
    }
  }
});

// W10-29 / F19: the search field replaces the "Open in Space" text as in
// Arc; drawn in Mini's frame colour, never a system menu.
add_task(async function test_space_dropdown_is_arcs_popover() {
  const win = await openMini();
  try {
    const doc = win.document;
    const picker = () => doc.getElementById("whimsy-quick-window-space-picker");
    doc.getElementById("whimsy-quick-window-choose-space").doCommand();
    await TestUtils.waitForCondition(() => picker()?.state == "open", "The list opens");
    const popup = picker();
    is(popup.localName, "panel", "A Whimsy panel, not a system menu (W8-22)");
    const openGroup = doc.getElementById("whimsy-quick-window-open");
    ok(openGroup.hasAttribute("searching"), "Open in Space holds the search field now");
    const input = doc.getElementById("whimsy-mini-picker-search");
    is(doc.activeElement, input, "with the keyboard in it");
    ok(!doc.getElementById("whimsy-quick-window-move-to-space").checkVisibility(), "Open in Space gives way to it");
    ok(doc.getElementById("whimsy-quick-window-address").checkVisibility(), "The address strip stays visible");

    // Keyboard drives it: Down highlights the next row in the bar's hover fill.
    const rows = [...popup.querySelectorAll(".whimsy-mini-picker-space")];
    EventUtils.synthesizeKey("KEY_ArrowDown", {}, win);
    const active = popup.querySelector('.whimsy-mini-picker-space[aria-selected="true"]');
    ok(active, "Arrow keys move through the spaces");
    if (rows.length > 1) {
      is(active, rows[1], "Down moves to the next space");
    }
    const fill = tokenColor(win, "--whimsy-mini-fill-hover");
    await TestUtils.waitForCondition(() => win.getComputedStyle(active).backgroundColor == fill,
      "The highlighted row uses Mini's hover fill, not the system highlight");
    is(win.getComputedStyle(active).borderTopLeftRadius, "6px", "Rows are rounded inside the list");

    const hidden = BrowserTestUtils.waitForEvent(popup, "popuphidden");
    EventUtils.synthesizeKey("KEY_Escape", {}, win);
    await hidden;
    ok(!win.closed, "Esc closes the list, not Mini");
    ok(!openGroup.hasAttribute("searching"), "and puts Open in Space back");
    ok(doc.getElementById("whimsy-quick-window-move-to-space").checkVisibility(), "Open in Space shows again");
  } finally {
    await BrowserTestUtils.closeWindow(win);
  }
});

