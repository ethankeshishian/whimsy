/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// wave7/menus: the space menu reads Rename · Change Icon · Edit Theme ·
// (Look and Feel) · Profile ▸ ┃ New Space · Manage · Routing ┃ Unload ·
// Unload Others · Share ┃ Lock · Hide ┃ Delete, with Scratch's rows after;
// the tab menu has no "Volume…" row (the speaker and the command bar open
// the slider); and an Essential's unread badge never sits under the Glance
// chip Zen floats on the same corner.

const { openGlanceOnTab } = ChromeUtils.importESModule("resource://testing-common/GlanceTestUtils.sys.mjs");
const { WhimsyCommands } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyCommands.sys.mjs");

const startTabs = new Set(gBrowser.tabs);
registerCleanupFunction(() => {
  for (const tab of gBrowser.tabs.filter(t => !startTabs.has(t))) {
    if (tab.hasAttribute("zen-essential")) {
      gZenPinnedTabManager.removeEssentials(tab);
    }
    BrowserTestUtils.removeTab(tab);
  }
});

const NEW_SPACE = ':scope > menuitem[command="cmd_zenOpenWorkspaceCreation"]';

function visible(node) {
  return !node.hidden && node.getAttribute("hidden") != "true";
}

// The menu as it shows: visible rows, each separator as "|".
function rows(menu) {
  return [...menu.children].filter(visible).map(node => {
    if (node.localName == "menuseparator") {
      return "|";
    }
    // matches() scopes :scope to the node itself, so drop the ":scope > ".
    if (node.matches(NEW_SPACE.replace(":scope > ", ""))) {
      return "new-space";
    }
    return node.id || node.getAttribute("data-l10n-id") || node.localName;
  });
}

async function openSpaceMenu() {
  const menu = document.getElementById("zenWorkspaceMoreActions");
  const shown = BrowserTestUtils.waitForPopupEvent(menu, "shown");
  menu.openPopup(gZenWorkspaces.activeWorkspaceElement, "after_start");
  await shown;
  return menu;
}

async function closeMenu(menu) {
  const hidden = BrowserTestUtils.waitForPopupEvent(menu, "hidden");
  menu.hidePopup();
  await hidden;
}

function checkSeparators(list, what) {
  isnot(list[0], "|", `${what}: no separator first`);
  isnot(list.at(-1), "|", `${what}: no separator last`);
  ok(!list.some((row, i) => row == "|" && list[i + 1] == "|"), `${what}: no two separators touch`);
}

// The group (separator-bounded run) each row is in.
function groupsOf(list) {
  const groups = [[]];
  for (const row of list) {
    if (row == "|") {
      groups.push([]);
    } else {
      groups.at(-1).push(row);
    }
  }
  return groups.filter(g => g.length);
}

add_task(async function test_space_menu_order() {
  await SpecialPowers.pushPrefEnv({
    set: [
      ["whimsy.feature.space-lock", true],
      ["whimsy.feature.archive-space", true],
    ],
  });
  const menu = await openSpaceMenu();
  const list = rows(menu);
  info(list.join(" "));
  checkSeparators(list, "Space menu");

  const at = id => list.indexOf(id);
  const order = [
    "context_zenEditWorkspace",
    "context_zenEditWorkspaceIcon",
    "context_zenChangeWorkspaceTheme",
    "new-space",
    "context_zenSpaceRoutingSettings",
    "context_zenUnloadWorkspace",
    "context_zenUnloadAllOtherWorkspace",
    "whimsy-lock-space-menuitem",
    "whimsy-hide-space-menuitem",
    "context_zenDeleteWorkspace",
  ].filter(id => at(id) >= 0);
  for (const id of ["new-space", "whimsy-lock-space-menuitem", "whimsy-hide-space-menuitem", "context_zenDeleteWorkspace"]) {
    Assert.greaterOrEqual(at(id), 0, `${id} shows`);
  }
  for (let i = 1; i < order.length; i++) {
    Assert.less(at(order[i - 1]), at(order[i]), `${order[i - 1]} comes before ${order[i]}`);
  }

  const groups = groupsOf(list);
  const deleteGroup = groups.find(g => g.includes("context_zenDeleteWorkspace"));
  Assert.deepEqual(deleteGroup, ["context_zenDeleteWorkspace"], "Delete has a group of its own");
  is(groups.at(-1), deleteGroup, "and it's the last group (Scratch's rows are hidden outside Scratch)");
  const lockGroup = groups.find(g => g.includes("whimsy-lock-space-menuitem"));
  Assert.deepEqual(lockGroup, ["whimsy-lock-space-menuitem", "whimsy-hide-space-menuitem"], "Lock and Hide share a group");
  is(groups.indexOf(lockGroup), groups.indexOf(deleteGroup) - 1, "just above Delete");
  const newGroup = groups.find(g => g.includes("new-space"));
  ok(newGroup.includes("context_zenSpaceRoutingSettings"), "Routing sits with New Space and Manage");
  const unloadGroup = groups.find(g => g.includes("context_zenUnloadWorkspace"));
  if (at("context_zenShareWorkspace") >= 0) {
    ok(unloadGroup.includes("context_zenShareWorkspace"), "Share sits with Unload");
  }
  // Look and Feel… stays: it's the only way to an existing space's look
  // (the form's button is on the New Space form only).
  const look = at("whimsy-space-look-menuitem");
  if (look >= 0) {
    is(groups.indexOf(groups.find(g => g.includes("whimsy-space-look-menuitem"))), 0, "Look and Feel… is in the first group");
  }

  // Scratch's block stays after Delete in the DOM.
  const scratch = document.getElementById("context_whimsyScratchSeparator");
  if (scratch) {
    ok(
      document.getElementById("context_zenDeleteWorkspace").compareDocumentPosition(scratch) &
        Node.DOCUMENT_POSITION_FOLLOWING,
      "Scratch's rows come after Delete"
    );
  }
  await closeMenu(menu);

  // Lock and Hide off: their group goes, with its separator.
  await SpecialPowers.pushPrefEnv({
    set: [
      ["whimsy.feature.space-lock", false],
      ["whimsy.feature.archive-space", false],
    ],
  });
  const again = await openSpaceMenu();
  const off = rows(again);
  info(off.join(" "));
  checkSeparators(off, "Without Lock and Hide");
  ok(!off.includes("whimsy-lock-space-menuitem") && !off.includes("whimsy-hide-space-menuitem"), "Lock and Hide are gone");
  is(off.at(-1), "context_zenDeleteWorkspace", "Delete is still last");
  is(off.at(-2), "|", "on its own");
  await closeMenu(again);

  // A second show keeps the same order (the arrangement is stable).
  await SpecialPowers.popPrefEnv();
  const third = await openSpaceMenu();
  Assert.deepEqual(rows(third), list, "Same order every time");
  await closeMenu(third);
  await SpecialPowers.popPrefEnv();
});

add_task(async function test_no_volume_row() {
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.com/");
  const menu = document.getElementById("tabContextMenu");
  const shown = BrowserTestUtils.waitForPopupEvent(menu, "shown");
  EventUtils.synthesizeMouseAtCenter(tab, { type: "contextmenu", button: 2 });
  await shown;
  ok(!document.getElementById("context_whimsyTabVolume"), "The tab menu has no Volume… row");
  await closeMenu(menu);
  const entry = WhimsyCommands.get("cmd_whimsyTabVolume");
  ok(entry?.l10nId, "Tab Volume… stays a command (command bar, about:keyboard)");
  ok(document.getElementById("cmd_whimsyTabVolume"), "with its <command>");
  BrowserTestUtils.removeTab(tab);
});

// The badge's box, from its computed position in the tile's content box.
function badgeRect(tab) {
  const stack = tab.querySelector(":scope > .tab-stack > .tab-content > .tab-icon-stack");
  const style = getComputedStyle(stack, "::after");
  if (style.display == "none" || style.content == "none") {
    return null;
  }
  const tile = tab.querySelector(":scope > .tab-stack > .tab-content").getBoundingClientRect();
  const width = Math.max(parseFloat(style.width) || 0, parseFloat(style.minWidth) || 0);
  const height = parseFloat(style.height) || 0;
  const top = tile.top + parseFloat(style.top);
  const right = tile.right - parseFloat(style.right);
  return { left: right - width, right, top, bottom: top + height };
}

function overlaps(a, b) {
  return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
}

add_task(async function test_glance_chip_and_badge() {
  const essential = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.com/?badge");
  gZenPinnedTabManager.addToEssentials(essential);
  await TestUtils.waitForCondition(() => essential.hasAttribute("zen-essential"), "An Essential");
  await SpecialPowers.spawn(essential.linkedBrowser, [], () => {
    content.document.title = "(3) Chat";
  });
  const stack = essential.querySelector(".tab-icon-stack");
  await TestUtils.waitForCondition(() => stack.getAttribute("whimsy-unread") == "3", "The Essential shows 3");
  ok(badgeRect(essential), "The badge shows before the Glance");

  gBrowser.selectedTab = essential;
  await openGlanceOnTab(window, async glanceTab => {
    await TestUtils.waitForCondition(() => essential.hasAttribute("glance-id"), "The Essential has a Glance");
    ok(essential.contains(glanceTab), "Zen nests the Glance chip in the tile");
    const chip = glanceTab.getBoundingClientRect();
    ok(chip.width > 0, "The chip shows");
    const badge = badgeRect(essential);
    ok(!badge || !overlaps(badge, chip), "The badge and the chip don't overlap");
    is(badge, null, "The badge steps aside while the Glance is open");
    const glanceStack = glanceTab.querySelector(".tab-icon-stack");
    isnot(getComputedStyle(glanceStack).position, "static", "The chip's own icon isn't restyled as the tile's");
  });
  await TestUtils.waitForCondition(() => !essential.hasAttribute("glance-id"), "Glance closed");
  ok(badgeRect(essential), "The badge comes back when the Glance closes");

  gZenPinnedTabManager.removeEssentials(essential);
  BrowserTestUtils.removeTab(essential);
});
