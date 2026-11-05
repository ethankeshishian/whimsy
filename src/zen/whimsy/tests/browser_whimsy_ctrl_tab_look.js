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
// - Private and normal tabs never share the card (Arc keeps incognito tabs
//   to their window), locked or not.
// - Switching whimsy.feature.ctrl-tab off gives back Firefox's panel.

const { WhimsyCtrlTab, MAX_THUMB_WIDTH, VISIBLE_ROWS, POOL_SIZE } = ChromeUtils.importESModule(
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
// The tiles inside the card's three rows (the rest scroll).
function inView() {
  const grid = ctrlTab.previewsContainer.getBoundingClientRect();
  return shownPreviews().filter(p => {
    const r = p.getBoundingClientRect();
    return r.top >= grid.top - 1 && r.bottom <= grid.bottom + 1;
  });
}
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
  const tabs = await openTabs(13);
  is(ctrlTab.maxTabPreviews, POOL_SIZE, "W16-8: the panel has a fixed pool of 20 tiles, however many tabs");
  try {
    Assert.greaterOrEqual(ctrlTab.tabCount, 13, "More than 12 tabs to switch between");
    await holdCtrlTab();
    const panel = ctrlTab.panel;
    ok(panel.hasAttribute("whimsy-look"), "The panel wears Whimsy's card");

    // 12 tiles in view, three rows of four (the rest scroll).
    const previews = inView();
    is(previews.length, 12, "12 tabs in the card, not Firefox's 7");
    is(VISIBLE_ROWS, 3, "Three rows show");
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

add_task(async function test_private_tabs_stay_apart() {
  const { WhimsyPrivate } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyPrivate.sys.mjs");
  const { WhimsyPrivateLock } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyPrivateLock.sys.mjs");
  const { WhimsyAuth } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyAuth.sys.mjs");
  WhimsyAuth._reauthenticator = { asyncReauthenticateUser: async () => [false, false] };
  Services.prefs.setIntPref("whimsy.privateLock.tabs", 1);
  const tabs = await openTabs(3);
  const privs = [];
  try {
    for (let i = 0; i < 3; i++) {
      const url = `https://example.com/?ctrltab-private=${i}-${Date.now()}`;
      const priv = WhimsyPrivate.openPrivateTab(window, { url });
      privs.push(priv);
      await TestUtils.waitForCondition(() => priv.linkedBrowser.currentURI?.spec == url && !priv.hasAttribute("busy"),
        "The private page loaded");
    }
    // Like Arc's incognito windows: from a normal tab, no private tab.
    gBrowser.selectedTab = tabs[0];
    gBrowser.selectedTab = tabs[1];
    await holdCtrlTab();
    ok(ctrlTab.panel.hasAttribute("whimsy-look"), "The new card");
    ok(privs.every(p => !previewOf(p)), "No private tab from a normal one, though they're in this space");
    ok(previewOf(tabs[0]), "The normal tabs are there");
    await releaseCtrl();
    await letGo();

    // From a private tab, only private tabs.
    gBrowser.selectedTab = privs[0];
    gBrowser.selectedTab = privs[1];
    await holdCtrlTab();
    ok(previewOf(privs[0]), "From a private tab, the private tabs");
    ok(tabs.every(t => !previewOf(t)), "and no normal tab");
    await releaseCtrl();
    await letGo();

    // Locked, still none from a normal tab.
    gBrowser.selectedTab = tabs[2];
    WhimsyPrivateLock.lockNow();
    ok(WhimsyPrivateLock.isLocked("tabs"), "Private tabs are locked");
    await holdCtrlTab();
    ok(privs.every(p => !previewOf(p)), "Locked private tabs don't show either");
    await releaseCtrl();
    ok(!privs.includes(gBrowser.selectedTab), "Releasing picks a normal tab, so nothing asks to unlock");
  } finally {
    await letGo();
    WhimsyPrivateLock.unlockAll();
    WhimsyAuth._reauthenticator = null;
    Services.prefs.clearUserPref("whimsy.privateLock.tabs");
    removeTabs([...tabs, ...privs]);
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

// W14 21.8 (design/ctrltab A): every space's tabs, newest first, with the
// space pill on other spaces' tiles only; the list survives a space switch;
// pressing Tab past the 12th scrolls the grid a row at a time with "13 of N"
// under it; picking another space's tile switches there. Essentials and
// pinned tabs are in it; a hidden space's tabs aren't.
add_task(async function test_every_space_and_scrolling_by_row() {
  const { WhimsySpaceArchive } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsySpaceArchive.sys.mjs");
  const home = gZenWorkspaces.activeWorkspace;
  const aTabs = await openTabs(14);
  const pinned = aTabs[0];
  gBrowser.pinTab(pinned);
  const work = await gZenWorkspaces.createAndSaveWorkspace("Work", undefined, true);
  const secret = await gZenWorkspaces.createAndSaveWorkspace("Secret", undefined, true);
  const bTabs = [];
  let hiddenTab = null;
  try {
    await gZenWorkspaces.changeWorkspaceWithID(secret.uuid);
    hiddenTab = await BrowserTestUtils.openNewForegroundTab(gBrowser, page(300));
    await gZenWorkspaces.changeWorkspaceWithID(work.uuid);
    for (let i = 0; i < 3; i++) {
      bTabs.push(await BrowserTestUtils.openNewForegroundTab(gBrowser, page(200 + i)));
    }
    await WhimsySpaceArchive.toggleHidden(window, secret.uuid);
    closeToasts();
    await gZenWorkspaces.changeWorkspaceWithID(home);
    gBrowser.selectedTab = aTabs[13];
    await TestUtils.waitForCondition(() => gZenWorkspaces.activeWorkspace == home, "Back in the first space");

    const list = ctrlTab.tabList;
    for (const tab of bTabs) {
      ok(list.includes(tab), `${tab.label}, in Work, is listed after switching spaces`);
    }
    ok(list.includes(pinned), "A pinned tab is listed");
    ok(!list.includes(hiddenTab), "A hidden space's tab isn't");
    Assert.deepEqual(list.slice(1, 4), [...bTabs].reverse(), "Work's tabs, newest first, right after the current tab");

    await holdCtrlTab();
    is(inView().length, 12, "12 tiles show");
    Assert.greater(shownPreviews().length, 12, "...with more below");
    ok(ctrlTab.previewsContainer.hasAttribute("whimsy-more"), "...faded at the bottom");
    for (const tab of bTabs) {
      is(previewOf(tab)._canvas.getAttribute("whimsy-space-name"), "Work", `${tab.label} carries Work's pill`);
    }
    for (const tab of [aTabs[13], aTabs[12]]) {
      ok(!previewOf(tab)._canvas.hasAttribute("whimsy-space-name"), `${tab.label}, in this space: no pill`);
    }
    const foot = document.getElementById("whimsy-ctrltab-foot");
    ok(foot && !foot.hidden, "The count shows under the grid");
    const card1 = card().getBoundingClientRect();

    // Tab to the 12th, then the 13th: one row scrolls in.
    for (let i = 3; i <= 12; i++) {
      await pressTab();
    }
    const twelfth = shownPreviews()[11];
    is(document.activeElement, twelfth, "The 12th tile is selected");
    is(ctrlTab.previewsContainer.scrollTop, 0, "...without scrolling");
    await pressTab();
    const thirteenth = shownPreviews()[12];
    is(document.activeElement, thirteenth, "Tab past the 12th selects the 13th");
    const pitch = WhimsyCtrlTab.rowPitch(ctrlTab);
    Assert.less(Math.abs(ctrlTab.previewsContainer.scrollTop - pitch), 1, "...and the grid scrolls one row");
    ok(inView().includes(thirteenth), "...bringing it into view");
    const countLabel = foot.querySelector(".whimsy-ctrltab-count");
    await TestUtils.waitForCondition(() => countLabel.textContent == `13 of ${ctrlTab.tabCount}`, "13 of N");
    ok(!countLabel.hasAttribute("data-l10n-id"), "W16-21: the count is set as text, not by a Fluent attribute");
    is(foot.querySelector(".whimsy-ctrltab-title").value, thirteenth._tab.label, "...beside its title");
    const card2 = card().getBoundingClientRect();
    ok(card2.width == card1.width && card2.height == card1.height, "The card never changes size");

    // Open again: the next tile after the previous tab is Work's newest.
    const thirteenthTab = thirteenth._tab;
    await releaseCtrl();
    await TestUtils.waitForCondition(() => gBrowser.selectedTab == thirteenthTab, "Releasing picks the 13th");
    gBrowser.selectedTab = aTabs[13];
    await holdCtrlTab();
    is(document.activeElement, previewOf(ctrlTab.tabList[1]), "The previous tab is selected");
    is(document.activeElement._tab, thirteenthTab, "...the one just picked");
    await pressTab();
    is(document.activeElement, previewOf(bTabs[2]), "Next: Work's newest tab");
    await releaseCtrl();
    is(gBrowser.selectedTab, bTabs[2], "Releasing Ctrl picks it");
    await TestUtils.waitForCondition(() => gZenWorkspaces.activeWorkspace == work.uuid, "...and switches to Work");
  } finally {
    await letGo();
    if (gZenWorkspaces.activeWorkspace != home) {
      await gZenWorkspaces.changeWorkspaceWithID(home);
    }
    WhimsySpaceArchive.restore(window, secret.uuid);
    closeToasts();
    gBrowser.unpinTab(pinned);
    removeTabs([...aTabs, ...bTabs, hiddenTab].filter(Boolean));
    await gZenWorkspaces.removeWorkspace(work.uuid);
    await gZenWorkspaces.removeWorkspace(secret.uuid);
  }
});

// W16-1: the Private Space has no theme, so Zen's default dark accent made
// the selected tile nearly invisible there. It wears the private violet.
add_task(async function test_private_space_selection_shows() {
  const { WhimsyPrivate } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyPrivate.sys.mjs");
  const home = gZenWorkspaces.activeWorkspace;
  const root = document.documentElement;
  const accentOf = () => getComputedStyle(root).getPropertyValue("--zen-primary-color").trim();
  const homeAccent = accentOf();
  const settle = async () => {
    await TestUtils.waitForCondition(() => !gZenWorkspaces.isChangingWorkspace, "The space switch finished");
    await new Promise(resolve => setTimeout(resolve, 100));
  };
  try {
    EventUtils.synthesizeKey("n", { accelKey: true, shiftKey: true });
    await TestUtils.waitForCondition(() => WhimsyPrivate.activeSpaceIsScratch(window), "The Private Space shows");
    await settle();
    for (const n of [1, 2]) {
      const tab = WhimsyPrivate.openPrivateTab(window, { url: "https://example.com/browser/?look" + n });
      await BrowserTestUtils.browserLoaded(tab.linkedBrowser);
      gBrowser.selectedTab = tab;
    }
    await settle();
    ok(root.hasAttribute("whimsy-scratch-active"), "The Private Space is active");
    is(accentOf(), "rgb(152, 110, 255)", "The Private Space wears the private violet accent");

    await holdCtrlTab();
    await pressTab();
    const focused = document.activeElement;
    ok(focused?.classList.contains("ctrlTab-preview"), "A tile is selected");
    const inner = focused.querySelector(".ctrlTab-preview-inner") ?? focused;
    const fill = getComputedStyle(inner).backgroundColor;
    Assert.greater(alphaOf(fill), 0, `The selected tile has a fill (${fill})`);
    isnot(fill, getComputedStyle(card()).backgroundColor, "...that differs from the card");
    await releaseCtrl();
  } finally {
    await letGo();
    await gZenWorkspaces.changeWorkspaceWithID(home);
    await settle();
    await WhimsyPrivate.closeScratch(window);
  }
  ok(!root.hasAttribute("whimsy-scratch-active"), "Back in a normal space");
  is(accentOf(), homeAccent, "...with its own accent back");
});

// W16-8: with many tabs the card builds a pool of 20 tiles and fills only
// those (with their thumbnails); Tab and Shift+Tab move through every tab,
// the pool following, and the footer counts the whole list.
add_task(async function test_many_tabs_use_a_pool_of_tiles() {
  const tabs = [];
  for (let i = 0; i < 60; i++) {
    tabs.push(BrowserTestUtils.addTab(gBrowser, page(400 + i), { skipAnimation: true }));
  }
  const gets = { count: 0 };
  const get = tabPreviews.get;
  try {
    await TestUtils.waitForCondition(() => ctrlTab.tabCount >= 60, "Sixty tabs to switch between");
    // Loaded, so no tile is redrawn for a tab's title or icon arriving.
    await TestUtils.waitForCondition(() => tabs.every(t => !t.hasAttribute("busy")), "…all loaded");
    const total = ctrlTab.tabCount;
    tabPreviews.get = function (...args) {
      gets.count++;
      return get.apply(this, args);
    };
    await holdCtrlTab();
    tabPreviews.get = get;
    const tiles = ctrlTab.previewsContainer.querySelectorAll(".ctrlTab-preview");
    Assert.lessOrEqual(tiles.length, POOL_SIZE, `At most ${POOL_SIZE} tiles (${tiles.length})`);
    Assert.lessOrEqual(gets.count, POOL_SIZE, `At most ${POOL_SIZE} thumbnails asked for on open (${gets.count})`);
    const pitch = WhimsyCtrlTab.rowPitch(ctrlTab);
    const rows = Math.ceil(total / WhimsyCtrlTab.PER_ROW);
    Assert.less(Math.abs(ctrlTab.previewsContainer.scrollHeight - (rows * pitch - 4)), 3,
      "The grid scrolls as far as every tab's row (the spacers keep it true)");
    is(document.activeElement._tab, ctrlTab.tabList[1], "The previous tab is selected");

    const foot = document.getElementById("whimsy-ctrltab-foot");
    const list = ctrlTab.tabList;
    for (let i = 2; i <= 40; i++) {
      await pressTab();
      if (document.activeElement._tab != list[i]) {
        is(document.activeElement._tab?.label, list[i].label, `Tab ${i - 1}: tab ${i + 1} is selected`);
        break;
      }
      if (i == 13) {
        const label = foot.querySelector(".whimsy-ctrltab-count");
        await TestUtils.waitForCondition(() => label.textContent == `14 of ${total}`, "The footer counts the whole list");
      }
    }
    is(document.activeElement._tab, list[40], "Tab reaches the 41st tab, well past the first pool");
    Assert.less(Math.abs(ctrlTab.previewsContainer.scrollTop - (Math.floor(40 / 4) - 2) * pitch), 1,
      "…with its row the last in view");
    ok(inView().includes(document.activeElement), "…and in view");
    Assert.lessOrEqual(ctrlTab.previewsContainer.querySelectorAll(".ctrlTab-preview").length, POOL_SIZE, "Still 20 tiles");

    // Back with Shift+Tab, a few rows.
    for (let i = 39; i >= 30; i--) {
      const keyup = BrowserTestUtils.waitForEvent(document, "keyup");
      EventUtils.synthesizeKey("VK_TAB", { ctrlKey: true, shiftKey: true });
      await keyup;
    }
    is(document.activeElement._tab, list[30], "Shift+Tab goes back through them");
    ok(inView().includes(document.activeElement), "…in view");
    const picked = document.activeElement._tab;
    await releaseCtrl();
    is(gBrowser.selectedTab, picked, "Releasing Ctrl picks the tab the tile shows");

    // Wrapping back from the first tab reaches the last one.
    await holdCtrlTab();
    for (let i = 0; i < 2; i++) {
      const keyup = BrowserTestUtils.waitForEvent(document, "keyup");
      EventUtils.synthesizeKey("VK_TAB", { ctrlKey: true, shiftKey: true });
      await keyup;
    }
    is(document.activeElement._tab, ctrlTab.tabList.at(-1), "Shift+Tab from the first tab wraps to the last");
    ok(inView().includes(document.activeElement), "…which is in view");
    await releaseCtrl();
  } finally {
    tabPreviews.get = get;
    await letGo();
    removeTabs(tabs);
  }
});
