/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// B7 (F15, the user: "looks exactly like it used to"): the real tab menu,
// right-clicked in the sidebar, has exactly one "… Tabs Below" row, in the
// Close Multiple Tabs submenu, worded Archive Tabs Below; for one tab,
// several selected, an Essential and a pinned tab. The command bar has one
// such row too: Archive when closed tabs are archived, else Close.

const vis = el => !el.hidden && getComputedStyle(el).display != "none";

async function rowsOf(menu) {
  await document.l10n.translateFragment(menu);
  const out = [];
  for (const el of menu.children) {
    if (el.localName == "menuseparator" || !vis(el)) {
      continue;
    }
    if (el.localName == "menu") {
      const popup = el.menupopup;
      const shown = BrowserTestUtils.waitForPopupEvent(popup, "shown");
      el.openMenu(true);
      await shown;
      await document.l10n.translateFragment(popup);
      for (const sub of popup.children) {
        if (sub.localName != "menuseparator" && !sub.hidden) {
          out.push({ id: sub.id, label: sub.label, top: false });
        }
      }
      const hidden = BrowserTestUtils.waitForPopupEvent(popup, "hidden");
      popup.hidePopup();
      await hidden;
    } else {
      out.push({ id: el.id, label: el.label, top: true });
    }
  }
  return out;
}

for (const mode of ["one", "multi", "essential", "pinned"]) {
  add_task(async function one_tabs_below_row() {
    const a = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.com/?below-a");
    const b = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.com/?below-b");
    const c = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.com/?below-c");
    gBrowser.selectedTab = a;
    if (mode == "multi") {
      gBrowser.addToMultiSelectedTabs(b);
    } else if (mode == "essential") {
      gZenPinnedTabManager.addToEssentials(a);
    } else if (mode == "pinned") {
      gBrowser.pinTab(a);
    }
    try {
      const menu = document.getElementById("tabContextMenu");
      const shown = BrowserTestUtils.waitForPopupEvent(menu, "shown");
      EventUtils.synthesizeMouseAtCenter(a, { type: "contextmenu", button: 2 });
      await shown;
      const rows = await rowsOf(menu);
      const hidden = BrowserTestUtils.waitForPopupEvent(menu, "hidden");
      menu.hidePopup();
      await hidden;
      const below = rows.filter(r => /Tabs Below/.test(r.label ?? ""));
      is(below.length, 1, `${mode}: one "Tabs Below" row (${below.map(r => r.label).join(", ")})`);
      is(below[0]?.label, "Archive Tabs Below", `${mode}: ...worded Archive`);
      ok(!below[0]?.top, `${mode}: ...in the Close Multiple Tabs submenu`);
    } finally {
      if (mode == "essential") {
        gZenPinnedTabManager.removeEssentials(a);
      } else if (mode == "pinned") {
        gBrowser.unpinTab(a);
      }
      gBrowser.clearMultiSelectedTabs();
      for (const tab of [a, b, c]) {
        if (tab.isConnected) {
          BrowserTestUtils.removeTab(tab);
        }
      }
    }
  });
}

add_task(async function one_tabs_below_command() {
  const { globalActions } = ChromeUtils.importESModule("resource:///modules/ZenUBGlobalActions.sys.mjs");
  const action = id => globalActions.find(a => a.l10nId == id);
  const a = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.com/?below-cmd-a");
  const b = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.com/?below-cmd-b");
  gBrowser.selectedTab = a;
  ok(action("whimsy-action-archive-tabs-below").isAvailable(window), "Archive Tabs Below is offered");
  ok(!action("whimsy-action-close-tabs-below").isAvailable(window), "...and not Close Tabs Below as well");
  await SpecialPowers.pushPrefEnv({ set: [["whimsy.feature.archive-view", false]] });
  const { WhimsyArchive } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyArchive.sys.mjs");
  ok(!WhimsyArchive.viewEnabled, "The Archive is off");
  ok(!action("whimsy-action-archive-tabs-below").isAvailable(window), "Archive off: no Archive Tabs Below");
  ok(action("whimsy-action-close-tabs-below").isAvailable(window), "...Close Tabs Below instead");
  await SpecialPowers.popPrefEnv();
  BrowserTestUtils.removeTab(b);
  BrowserTestUtils.removeTab(a);
});
