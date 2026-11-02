/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// W13 ctrltab (option B): Firefox's Ctrl+Tab panel as one rounded Whimsy
// card. Every task drives the real keys, as Firefox's own browser_ctrlTab.js
// does: Ctrl held, Tab pressed (the panel shows after 200ms), Tab again to
// move, Ctrl released to pick.
// - The card: 20px corners, rounded tiles and thumbnails, the favicon
//   beside the title, no text shadow, the selection the space accent at 22%.
// - Up to 12 tabs (browser.ctrlTab.maxPreviews), in rows of four, with
//   thumbnails at most 200px; the 8th tab can be reached and picked.
// - The panel is the card's own size, centred on the screen.
// - A tab from another space carries that space's badge; Essentials and
//   tabs of the current space don't.
// - A locked private tab is still blanked (WhimsyPrivateLock) in the card.
// - Switching whimsy.feature.ctrl-tab off gives back Firefox's panel.

const { WhimsyCtrlTab, MAX_THUMB_WIDTH } = ChromeUtils.importESModule(
  "resource:///modules/whimsy/WhimsyCtrlTab.sys.mjs"
);

add_setup(async function () {
  await SpecialPowers.pushPrefEnv({ set: [["browser.ctrlTab.sortByRecentlyUsed", true]] });
});

function page(n) {
  const hue = (n * 47) % 360;
  return `data:text/html,<title>Look ${n}</title><body style="background:hsl(${hue} 70% 60%)">${n}`;
}

async function openTabs(count) {
  const tabs = [];
  for (let i = 0; i < count; i++) {
    tabs.push(await BrowserTestUtils.openNewForegroundTab(gBrowser, page(i)));
  }
  return tabs;
}

function removeTabs(tabs) {
  for (const tab of tabs) {
    if (tab.isConnected && !tab.closing) {
      BrowserTestUtils.removeTab(tab, { animate: false });
    }
  }
}

// Ctrl held, Tab pressed: the panel opens after Firefox's 200ms.
async function holdCtrlTab() {
  const shown = BrowserTestUtils.waitForEvent(ctrlTab.panel, "popupshown");
  EventUtils.synthesizeKey("VK_TAB", { ctrlKey: true });
  await shown;
  await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
}

// Tab again, Ctrl still held: the selection moves on.
async function pressTab() {
  const keyup = BrowserTestUtils.waitForEvent(document, "keyup");
  EventUtils.synthesizeKey("VK_TAB", { ctrlKey: true });
  await keyup;
}

// Ctrl released: the selected tile is picked and the panel closes.
async function releaseCtrl() {
  const hidden = BrowserTestUtils.waitForEvent(ctrlTab.panel, "popuphidden");
  EventUtils.synthesizeKey("VK_CONTROL", { type: "keyup" });
  await hidden;
}

// After a failure part-way: let go of Ctrl whatever state the panel is in.
async function letGo() {
  if (ctrlTab.isOpen) {
    await releaseCtrl();
  } else {
    EventUtils.synthesizeKey("VK_CONTROL", { type: "keyup" });
  }
}

const shownPreviews = () => ctrlTab.previews.filter(p => p != ctrlTab.showAllButton && !p.hidden);
const previewOf = tab => shownPreviews().find(p => p._tab == tab);
const card = () => ctrlTab.panel.shadowRoot?.querySelector("[part~='content']");

// rgb(a)() or color() (color-mix computes to color(srgb r g b / a)).
function alphaOf(color) {
  const rgb = color.match(/rgba?\(([^)]+)\)/);
  if (rgb) {
    const parts = rgb[1].split(/[\s,/]+/).filter(Boolean);
    return parts.length > 3 ? parseFloat(parts[3]) : 1;
  }
  const fn = color.match(/color\([^)]*\/\s*([\d.]+)\s*\)/);
  if (fn) {
    return parseFloat(fn[1]);
  }
  return color == "transparent" ? 0 : 1;
}

add_task(async function test_card_rows_of_four_and_twelve_tabs() {
  is(Services.prefs.getDefaultBranch("").getIntPref("browser.ctrlTab.maxPreviews"), 12,
    "Whimsy ships 12 previews");
  is(ctrlTab.maxTabPreviews, 12, "...and the panel reads 12");
  const tabs = await openTabs(13);
  try {
    Assert.greaterOrEqual(ctrlTab.tabCount, 13, "More than 12 tabs to switch between");
    await holdCtrlTab();
    const panel = ctrlTab.panel;
    ok(panel.hasAttribute("whimsy-look"), "The panel wears Whimsy's card");

    // 12 tiles, three rows of four.
    const previews = shownPreviews();
    is(previews.length, 12, "12 tabs in the panel, not Firefox's 7");
    is(WhimsyCtrlTab.PER_ROW, 4, "Rows of four");
    is(ctrlTab.previewsPerRow, 4, "...is what Firefox's panel lays out");
    const rows = new Map();
    for (const preview of previews) {
      const top = Math.round(preview.getBoundingClientRect().top);
      rows.set(top, (rows.get(top) ?? 0) + 1);
    }
    is(rows.size, 3, "Three rows");
    ok([...rows.values()].every(n => n == 4), "...of four tiles each");
    is(getComputedStyle(ctrlTab.previewsContainer).gridTemplateColumns.split(" ").length, 4, "A four-column grid");

    // Thumbnails at most 200px.
    Assert.lessOrEqual(ctrlTab.canvasWidth, MAX_THUMB_WIDTH, "Thumbnails are capped at 200px");
    for (const preview of previews) {
      Assert.lessOrEqual(preview._canvas.getBoundingClientRect().width, MAX_THUMB_WIDTH + 0.5,
        `${preview._tab.label}: its thumbnail is at most 200px wide`);
    }

    // The card: 20px corners, 8px padding; tiles 12px, thumbnails 6px.
    const content = card();
    ok(content, "The panel's card");
    const cardStyle = getComputedStyle(content);
    is(cardStyle.borderTopLeftRadius, "20px", "The card has 20px corners");
    is(cardStyle.paddingTop, "8px", "...and 8px padding");
    const selected = document.activeElement;
    ok(previews.includes(selected), "A tile has the focus (Firefox's selection)");
    is(selected, previews[1], "...the previous tab, as before");
    const inner = selected.querySelector(".ctrlTab-preview-inner");
    is(getComputedStyle(inner).borderTopLeftRadius, "12px", "Tiles have 12px corners");
    is(getComputedStyle(inner).paddingTop, "6px", "...and 6px padding");
    is(getComputedStyle(selected._canvas).borderTopLeftRadius, "6px", "Thumbnails have 6px corners");
    is(getComputedStyle(selected._canvas).boxShadow, "none", "...and no hard drop shadow");
    is(getComputedStyle(selected).textShadow, "none", "No text shadow");

    // The favicon beside the title, under the thumbnail.
    const other = previews[2];
    const favicon = other._favicon.getBoundingClientRect();
    const label = other._label.getBoundingClientRect();
    const thumb = other._canvas.getBoundingClientRect();
    Assert.greaterOrEqual(Math.round(favicon.top), Math.round(thumb.bottom), "The favicon is under the thumbnail");
    Assert.lessOrEqual(Math.round(favicon.right), Math.round(label.left), "...beside the title, before it");
    Assert.less(Math.abs((favicon.top + favicon.bottom) / 2 - (label.top + label.bottom) / 2), 3,
      "...on the same line");
    is(getComputedStyle(other._label).textAlign, "start", "The title is start-aligned");

    // The selection: the space accent at 22%, no ring; others clear.
    const probe = document.createXULElement("box");
    probe.style.backgroundColor = "var(--whimsy-surface-selected)";
    panel.appendChild(probe);
    const token = getComputedStyle(probe).backgroundColor;
    probe.remove();
    const fill = getComputedStyle(inner).backgroundColor;
    is(fill, token, "The selected tile takes --whimsy-surface-selected");
    Assert.less(Math.abs(alphaOf(fill) - 0.22), 0.03, "...the accent at 22%");
    is(getComputedStyle(inner).borderTopWidth, "0px", "...with no ring");
    is(getComputedStyle(selected._label).fontWeight, "600", "The selected title goes semibold");
    const otherFill = getComputedStyle(other.querySelector(".ctrlTab-preview-inner")).backgroundColor;
    is(alphaOf(otherFill), 0, "Other tiles have no fill");

    // The card's own size, centred on the screen.
    const outer = panel.getOuterScreenRect();
    const { width, height } = WhimsyCtrlTab.cardSize(ctrlTab);
    const box = content.getBoundingClientRect();
    Assert.less(Math.abs(box.width - width), 1.5, `The card is ${width}px wide, as sized`);
    Assert.less(Math.abs(box.height - height), 3, `...and about ${height}px tall, as estimated`);
    const centreX = outer.left + outer.width / 2;
    const centreY = outer.top + outer.height / 2;
    Assert.less(Math.abs(centreX - (screen.availLeft + screen.availWidth / 2)), 2, "Centred across the screen");
    Assert.less(Math.abs(centreY - (screen.availTop + screen.availHeight / 2)), 3, "...and down it");

    // The 8th tab (Firefox's 7 left it out): Tab six more times, release.
    const eighth = ctrlTab.tabList[7];
    ok(previewOf(eighth), "The 8th most recent tab has a tile");
    for (let i = 0; i < 6; i++) {
      await pressTab();
    }
    is(document.activeElement, previewOf(eighth), "Tab presses reach it");
    is(getComputedStyle(previewOf(eighth).querySelector(".ctrlTab-preview-inner")).backgroundColor, token,
      "...and it wears the selection");
    await releaseCtrl();
    is(gBrowser.selectedTab, eighth, "Releasing Ctrl switches to the 8th tab");
  } finally {
    await letGo();
    removeTabs(tabs);
  }
});

add_task(async function test_space_badge() {
  const home = gZenWorkspaces.activeWorkspace;
  const work = await gZenWorkspaces.createAndSaveWorkspace("Work", undefined, true);
  ok(work?.uuid, "A second space, Work");
  const essential = await BrowserTestUtils.openNewForegroundTab(gBrowser, page(100));
  gZenPinnedTabManager.addToEssentials(essential);
  const moved = await BrowserTestUtils.openNewForegroundTab(gBrowser, page(101));
  const [a, b] = await openTabs(2);
  try {
    // Move one tab to Work, as the tab menu's Move To does; it stays in
    // the recently used list.
    gZenWorkspaces.moveTabToWorkspace(moved, work.uuid);
    is(moved.getAttribute("zen-workspace-id"), work.uuid, "The tab is in Work now");
    is(gZenWorkspaces.activeWorkspace, home, "...while you stay where you are");
    ok(ctrlTab.tabList.includes(moved), "...and Ctrl+Tab still lists it");
    ok(ctrlTab.tabList.includes(essential), "The Essential is listed too");

    await holdCtrlTab();
    const badged = previewOf(moved);
    ok(badged, "The moved tab has a tile");
    is(badged._canvas.getAttribute("whimsy-space-name"), "Work", "Its thumbnail carries Work's badge");
    const before = getComputedStyle(badged._canvas, "::before");
    ok(before.content.includes("Work"), "...drawn as a pill with the space's name");
    is(before.position, "absolute", "...over the thumbnail's corner");
    is(before.top, "5px", "...5px in from the top");
    const square = getComputedStyle(badged._canvas, "::after");
    is(square.width, "8px", "...with the space's colour square");
    Assert.greater(alphaOf(square.backgroundColor), 0, "...filled");

    for (const tab of [essential, a, b]) {
      const preview = previewOf(tab);
      ok(preview, `${tab.label} has a tile`);
      ok(!preview._canvas.hasAttribute("whimsy-space-name"), `${tab.label}: no badge`);
      is(getComputedStyle(preview._canvas, "::before").content, "none", `${tab.label}: nothing drawn`);
    }

    // Picking the badged tile takes you to its space.
    const index = shownPreviews().indexOf(badged);
    for (let i = 1; i < index; i++) {
      await pressTab();
    }
    is(document.activeElement, badged, "Tab presses reach the badged tile");
    await releaseCtrl();
    is(gBrowser.selectedTab, moved, "Releasing Ctrl picks it");
    await TestUtils.waitForCondition(() => gZenWorkspaces.activeWorkspace == work.uuid, "...and switches to Work");
  } finally {
    await letGo();
    if (gZenWorkspaces.activeWorkspace != home) {
      await gZenWorkspaces.changeWorkspace(gZenWorkspaces.getWorkspaceFromId(home));
    }
    gZenPinnedTabManager.removeEssentials(essential);
    removeTabs([moved, a, b, essential]);
    await gZenWorkspaces.removeWorkspace(work.uuid);
  }
});

add_task(async function test_private_lock_still_blanks() {
  const { WhimsyPrivate } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyPrivate.sys.mjs");
  const { WhimsyPrivateLock } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyPrivateLock.sys.mjs");
  const { WhimsyAuth } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyAuth.sys.mjs");
  WhimsyAuth._reauthenticator = { asyncReauthenticateUser: async () => [false, false] };
  Services.prefs.setIntPref("whimsy.privateLock.tabs", 1);
  const tabs = await openTabs(2);
  const url = `https://example.com/?ctrltab-lock=${Date.now()}`;
  const priv = WhimsyPrivate.openPrivateTab(window, { url });
  try {
    await TestUtils.waitForCondition(() => priv.linkedBrowser.currentURI?.spec == url && !priv.hasAttribute("busy"),
      "The private page loaded");
    const title = priv.label;
    // Two other tabs since, so the private tab isn't the one Ctrl+Tab picks.
    gBrowser.selectedTab = tabs[0];
    gBrowser.selectedTab = tabs[1];
    WhimsyPrivateLock.lockNow();
    ok(WhimsyPrivateLock.isLocked("tabs"), "Private tabs are locked");

    await holdCtrlTab();
    ok(ctrlTab.panel.hasAttribute("whimsy-look"), "The new card");
    const preview = previewOf(priv);
    ok(preview, "The locked tab has a tile");
    isnot(preview._label.value, title, "Its title is hidden");
    is(preview._label.value, "Private tab", "...it reads Private tab");
    is(preview.getAttribute("tooltiptext"), "Private tab", "...in its tooltip too");
    ok(!preview._favicon.hasAttribute("src"), "No favicon");
    ok(!preview._canvas.querySelector("img:not(.ctrlTab-placeholder), canvas"), "No thumbnail of the page");
    is(getComputedStyle(preview.querySelector(".ctrlTab-preview-inner")).borderTopLeftRadius, "12px",
      "The blank tile is the same rounded tile");
    isnot(document.activeElement, preview, "The locked tab isn't the one selected");
    await releaseCtrl();
    isnot(gBrowser.selectedTab, priv, "Releasing picks another tab, so nothing asks to unlock");
  } finally {
    await letGo();
    WhimsyPrivateLock.unlockAll();
    WhimsyAuth._reauthenticator = null;
    Services.prefs.clearUserPref("whimsy.privateLock.tabs");
    removeTabs([...tabs, priv]);
  }
});

add_task(async function test_switch_off_gives_back_firefoxs_panel() {
  await SpecialPowers.pushPrefEnv({ set: [["whimsy.feature.ctrl-tab", false]] });
  const tabs = await openTabs(4);
  try {
    await holdCtrlTab();
    ok(!ctrlTab.panel.hasAttribute("whimsy-look"), "No Whimsy card");
    is(ctrlTab.previewsPerRow, 7, "Firefox's seven per row");
    is(ctrlTab.canvasWidth, Math.ceil((screen.availWidth * 0.85) / 7), "Firefox's thumbnail size");
    isnot(getComputedStyle(card()).borderTopLeftRadius, "20px", "Firefox's panel corners");
    ok(!shownPreviews().some(p => p._canvas.hasAttribute("whimsy-space-name")), "No badges");
    await releaseCtrl();
  } finally {
    await letGo();
    removeTabs(tabs);
    await SpecialPowers.popPrefEnv();
  }
});
