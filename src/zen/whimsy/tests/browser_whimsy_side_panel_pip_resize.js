/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

Services.scriptloader.loadSubScript(getRootDirectory(gTestPath) + "head_side_panel.js", this);

// PiP geometry, header drag, and Glance lifecycle regressions.

addPanelTask(async function resize_is_clamped_and_kept_per_site() {
  const a = await makeEssential("https://example.org/?wide");
  const b = await makeEssential("https://example.com/?narrow");
  await clickTile(a, true);
  ok(grip(a).checkVisibility(), "A grip on the free edge");
  await TestUtils.waitForCondition(() => grip(a).getAttribute("aria-label") == "Resize side panel", "Named");
  await drag(a, 100);
  is(widthOf(a), 480, "Dragging the edge follows the pointer");
  is(saved()["example.org"]?.width, 480, "and is kept for that site");
  await drag(a, 2000);
  is(widthOf(a), Math.floor(window.innerWidth / 2), "No wider than half the window");
  await drag(a, -2000);
  is(widthOf(a), WhimsySidePanel.MIN_WIDTH, "No narrower than 320px");
  await drag(a, 80);
  const kept = widthOf(a);
  is(kept, 400, "400px");

  await clickTile(b, true);
  is(widthOf(b), WhimsySidePanel.DEFAULT_WIDTH, "Another site keeps its own width");
  await clickTile(a, true);
  is(widthOf(a), kept, "and the first site comes back at its width");

  EventUtils.synthesizeMouse(grip(a), 3, 100, { clickCount: 1 });
  EventUtils.synthesizeMouse(grip(a), 3, 100, { clickCount: 2 });
  await settle(a);
  is(widthOf(a), WhimsySidePanel.DEFAULT_WIDTH, "Double-click resets the width");
  ok(!("example.org" in saved()), "and forgets it");

  // A window under 1000px: 320px.
  window.resizeTo(960, 800);
  await TestUtils.waitForCondition(() => window.innerWidth < 1000, "Narrow window");
  await TestUtils.waitForCondition(() => widthOf(a) == WhimsySidePanel.MIN_WIDTH, "320px in a narrow window");
  window.resizeTo(1400, 900);
  await TestUtils.waitForCondition(() => window.innerWidth >= 1300, "Wide again");
  await TestUtils.waitForCondition(() => widthOf(a) == WhimsySidePanel.DEFAULT_WIDTH, "380px again");
  sp().hide({ animate: false });
});

function readoutContrast(node) {
  const canvas = document.createElementNS("http://www.w3.org/1999/xhtml", "canvas");
  canvas.width = canvas.height = 1;
  const ctx = canvas.getContext("2d");
  const light = value => {
    ctx.fillStyle = value;
    ctx.fillRect(0, 0, 1, 1);
    const rgb = [...ctx.getImageData(0, 0, 1, 1).data].slice(0, 3).map(c =>
      (c /= 255) <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
    return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
  };
  const style = getComputedStyle(node);
  const a = light(style.color), b = light(style.backgroundColor);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

addPanelTask(async function eight_grips_geometry_compatibility_and_shots() {
  Services.prefs.setStringPref(WIDTHS, JSON.stringify({ "example.org": 420 }));
  const ess = await makeEssential("https://example.org/?geometry");
  await clickTile(ess, true);
  is(widthOf(ess), 420, "Legacy numeric width reads correctly");
  for (const edge of ["e", "w", "n", "s", "ne", "nw", "se", "sw"]) {
    const available = document.getElementById("tabbrowser-tabpanels").clientHeight - 40;
    const height = Math.min(450, available);
    const top = 20 + Math.min(80, Math.max(0, available - height));
    Services.prefs.setStringPref(WIDTHS, JSON.stringify({ "example.org": { width: 380, height, left: 240, top } }));
    const before = sp().geometry(ess);
    await drag(ess, edge.includes("w") ? -30 : 30, edge.includes("n") ? 40 : -40, edge);
    const after = sp().geometry(ess);
    const rect = box(ess).getBoundingClientRect();
    is(Math.round(rect.width), Math.round(after.width), `${edge}: rendered width follows geometry`);
    is(Math.round(rect.height), Math.round(after.height), `${edge}: rendered height follows geometry`);
    is(after.width, before.width + (/[ew]/.test(edge) ? 30 : 0), `${edge}: correct width`);
    is(after.height, before.height - (/[ns]/.test(edge) ? Math.min(40, before.height - Math.min(320, available)) : 0), `${edge}: correct height`);
    is(after.top, before.top + (edge.includes("n") ? Math.min(40, before.height - Math.min(320, available)) : 0), `${edge}: top edge follows pointer`);
    is(after.left + after.width * (edge.includes("w") ? 1 : 0), before.left + before.width * (edge.includes("w") ? 1 : 0), `${edge}: opposite horizontal edge fixed`);
    is(after.top + (edge.includes("n") ? after.height : 0), before.top + (edge.includes("n") ? before.height : 0), `${edge}: opposite vertical edge fixed`);
    Assert.deepEqual(saved()["example.org"], Object.fromEntries(Object.entries(after).map(([k, v]) => [k, Math.round(v)])), "Saves full geometry");
    await drag(ess, 0, edge.includes("n") ? 2000 : -2000, edge);
    if (/[ns]/.test(edge)) {
      is(sp().geometry(ess).height, Math.min(320, available), "Height minimum");
    }
    const g = box(ess).querySelector(`[data-edge="${edge}"]`);
    EventUtils.synthesizeMouseAtCenter(g, { clickCount: 2 });
    await settle(ess);
    is(widthOf(ess), 380, "Any grip double-click resets width");
    is(Math.round(sp().geometry(ess).height), Math.round(Math.min(680, document.getElementById("tabbrowser-tabpanels").clientHeight - 40)), "Resets height");
  }
  await drag(ess, 0, 2000, "s");
  const size = sp().geometry(ess);
  Assert.lessOrEqual(size.top + size.height, document.getElementById("tabbrowser-tabpanels").clientHeight - 20, "Bottom gap remains");
  await drag(ess, 0, -2000, "n");
  is(sp().geometry(ess).top, 20, "Top gap remains");
  await clickTile(ess, false);
  await clickTile(ess, true);
  is(sp().geometry(ess).top, 20, "Saved vertical offset restored");
  sp().resetWidth();
  for (const dark of [false, true]) {
    await whimsySetScheme(dark);
    try {
      await settle(ess);
      Assert.greaterOrEqual(readoutContrast(box(ess).querySelector(".whimsy-side-panel-size")), 4.5, "Readout ink meets AA in both schemes");
      await whimsyShot(`w29-pip-${dark ? "dark" : "light"}`);
    } finally {
      await SpecialPowers.popPrefEnv();
    }
  }
  const start = pointerAt(grip(ess));
  try {
    pointerMove(start, 35, 30);
    ok(box(ess).hasAttribute("resizing"), "Readout only while dragging");
    ok(box(ess).querySelector(".whimsy-side-panel-size").textContent.includes(" × "), "Size readout");
    await whimsyShot("w29-pip-drag");
    pointerMove(start, 35, 30, "mouseup");
    ok(!box(ess).hasAttribute("resizing"), "Readout hidden on release");
    ok(!document.querySelector(".whimsy-side-panel-drag-shield"), "Release removes shield");
  } finally {
    sp().cancelDrag?.();
  }
  const root = document.documentElement;
  const oldSide = root.getAttribute("zen-right-side");
  try {
    root.setAttribute("zen-right-side", "true");
    sp().resetWidth();
    sp().layout();
    const before = sp().geometry(ess);
    await drag(ess, -40, -40, "sw");
    is(sp().geometry(ess).width, before.width + 40, "Left grip resizes with right edge fixed");
    is(sp().geometry(ess).height, before.height - 40, "Right corner still resizes height");
    const rect = box(ess).getBoundingClientRect();
    const panels = document.getElementById("tabbrowser-tabpanels").getBoundingClientRect();
    Assert.less(panels.right - rect.right, 40, "Right sidebar edge stays docked");
  } finally {
    if (oldSide === null) {
      root.removeAttribute("zen-right-side");
    } else {
      root.setAttribute("zen-right-side", oldSide);
    }
    sp().layout();
  }
  sp().hide({ animate: false });
  Services.prefs.clearUserPref(WIDTHS);
});

addPanelTask(async function header_moves_clamps_persists_and_resets() {
  const ess = await makeEssential("https://example.org/?move");
  const other = await makeEssential("https://example.com/?move-other");
  Services.prefs.setStringPref(WIDTHS, JSON.stringify({ "example.org": { width: 380, height: 400, top: 60 } }));
  await clickTile(ess, true);
  const before = sp().geometry(ess);
  await moveHeader(ess, 2, 0);
  Assert.deepEqual(sp().geometry(ess), before, "Below 4px remains a click");
  await moveHeader(ess, 160, 35);
  const moved = sp().geometry(ess);
  is(moved.left, before.left + 160, "Header tracks horizontal pointer 1:1");
  is(moved.top, before.top + 35, "Header tracks vertical pointer 1:1");
  is(moved.width, before.width, "Move preserves size");
  Assert.deepEqual(saved()["example.org"], moved, "Position and size persisted together");
  await clickTile(other, true);
  await clickTile(ess, true);
  Assert.deepEqual(sp().geometry(ess), moved, "Per-host position restored");
  const panels = document.getElementById("tabbrowser-tabpanels");
  await moveHeader(ess, panels.clientWidth, panels.clientHeight);
  let g = sp().geometry(ess);
  is(g.left + g.width, panels.clientWidth - 20, "Right gap clamped");
  is(g.top + g.height, panels.clientHeight - 20, "Bottom gap clamped");
  window.resizeTo(1050, 800);
  await TestUtils.waitForCondition(() => window.innerWidth < 1100, "Smaller window");
  g = sp().geometry(ess);
  Assert.lessOrEqual(g.left + g.width, panels.clientWidth - 20, "Window resize clamps horizontal position");
  Assert.lessOrEqual(g.top + g.height, panels.clientHeight - 20, "Window resize clamps vertical position");
  window.resizeTo(1400, 900);
  await TestUtils.waitForCondition(() => window.innerWidth >= 1300, "Wide again");
  await moveHeader(ess, -panels.clientWidth, -panels.clientHeight);
  is(sp().geometry(ess).left, 20, "Left gap clamped");
  is(sp().geometry(ess).top, 20, "Top gap clamped");
  sp().resetWidth();
  is(sp().geometry(ess).left, 20, "Reset docks beside left sidebar");
  await moveHeader(ess, Math.round((panels.clientWidth - 380) / 2) - 20, 0);
  for (const dark of [false, true]) {
    await whimsySetScheme(dark);
    try {
      await whimsyShot(`w29-pip-moved-${dark ? "dark" : "light"}`);
    } finally {
      await SpecialPowers.popPrefEnv();
    }
  }
  EventUtils.synthesizeMouseAtCenter(grip(ess), { clickCount: 2 });
  is(sp().geometry(ess).left, 20, "Grip double-click resets position");
  is(sp().geometry(ess).width, 380, "Grip double-click resets size");
  sp().hide({ animate: false });
  Services.prefs.clearUserPref(WIDTHS);
});

addPanelTask(async function interrupted_drag_cleans_up_input_and_reset() {
  const ess = await makeEssential("https://example.org/?cancel-drag");
  await clickTile(ess, true);
  for (const moving of [false, true]) {
    const target = moving ? box(ess).querySelector(".whimsy-side-panel-host") : grip(ess);
    const start = pointerAt(target);
    pointerMove(start, 35, 30);
    ok(document.querySelector(".whimsy-side-panel-drag-shield"), "Active drag shields content");
    sp().hide({ animate: false });
    ok(!sp().cancelDrag && !sp().dragSize, "Hide removes drag handlers and transient geometry");
    ok(!document.querySelector(".whimsy-side-panel-drag-shield"), "Hide removes shield");
    await clickTile(ess, true);
    const before = sp().geometry(ess);
    pointerMove(start, 100, 100);
    pointerMove(start, 100, 100, "mouseup");
    Assert.deepEqual(sp().geometry(ess), before, "A stale move/up cannot change a reopened popover");
  }
  const start = pointerAt(grip(ess));
  pointerMove(start, 35, 0);
  sp().resetWidth();
  pointerMove(start, 100, 0, "mouseup");
  is(sp().geometry(ess).width, 380, "Reset during drag survives a late release");
  ok(!document.querySelector(".whimsy-side-panel-drag-shield"), "Reset removes shield");
});

// Exercise the real Glance lifecycle, including its nested tab and selection
// bookkeeping; a synthetic GlanceOpen cannot reproduce those side effects.
addPanelTask(async function glance_from_popover_keeps_essential_routing() {
  const a = await makeEssential("https://example.org/?glance-parent");
  const b = await makeEssential("https://example.com/?glance-other");
  const state = (label, tab) => info(`${label}: ${JSON.stringify({
    selected: tab.selected, actualSelected: gBrowser.selectedTab == tab,
    routes: sp().routes(tab), elsewhere: sp().pageElsewhere(tab),
    glance: tab.getAttribute("glance-id"), floating: sp().tab == tab,
    pressed: sp().pressed?.id, box: box(tab)?.hasAttribute("whimsy-popover"),
    visible: tab._zenContentsVisible, active: tab.linkedBrowser.zenModeActive,
  })}`);
  for (const explicitParent of [false, true]) {
    for (const expand of [false, true]) {
      gBrowser.selectedTab = home;
      sp().hide({ animate: false });
      await clickTile(a, true);
      const geometry = sp().geometry(a);
      state(`before owner=${explicitParent} expand=${expand}`, a);
      const glance = await gZenGlanceManager.openGlance({
        url: "https://example.com/?popover-glance",
        clientX: 0, clientY: 0, width: 0, height: 0,
        triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
      }, null, explicitParent ? a : null);
      state("opened", a);
      is(gZenGlanceManager.getTabOrGlanceParent(glance), a, "Glance belongs to the popover site context");
      ok(!sp().tab, "Glance temporarily hides the popover");
      if (expand) {
        await gZenGlanceManager.fullyOpenGlance();
      } else {
        await gZenGlanceManager.closeGlance({ onTabClose: true });
      }
      state("finished", a);
      await TestUtils.waitForCondition(() => shown(a), "The original popover returns");
      Assert.deepEqual(sp().geometry(a), geometry, "Position and size survive Glance");
      is(gBrowser.selectedTab, expand ? glance : home, "Closing restores the underlying page; Expand selects the new page");
      ok(!a.selected && !a.hasAttribute("glance-id"), "Essential selection and Glance ID cleaned up");
      await clickTile(a, false);
      state("same tile before reopening", a);
      await clickTile(a, true);
      state("different tile before reopening", b);
      await clickTile(b, true);
      sp().hide({ animate: false });
      gBrowser.selectedTab = home;
      if (expand) {
        BrowserTestUtils.removeTab(glance);
      }
    }
  }
});

