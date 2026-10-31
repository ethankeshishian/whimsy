/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// wave7/ux (review HIG 15): the line between pinned and normal tabs sits
// below an expanded folder's children, never through them. The review's
// shot caught the newest folder mid-expansion (Zen animates its height), so
// this checks the settled layout, and the screenshot now waits for it too.

add_task(async function test_separator_below_expanded_folder_children() {
  const normal = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.com/?normal-tab");
  const folders = [];
  try {
    for (const label of ["Work", "Plain"]) {
      const tab = BrowserTestUtils.addTab(gBrowser, "about:blank");
      folders.push(await gZenFolders.createFolder([tab], { renameFolder: false, label }));
    }
    const last = folders.at(-1);
    last.collapsed = false;
    await TestUtils.waitForCondition(
      () => document.getAnimations().every(a => a.playState != "running" || a.effect?.getComputedTiming().iterations == Infinity),
      "The sidebar settles"
    );
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    const section = last.closest(".zen-workspace-pinned-tabs-section");
    ok(section, "The folder is in the space's pinned section");
    const separator = section.separatorElement ?? section.querySelector(".pinned-tabs-container-separator");
    if (section.hasAttribute("hide-separator")) {
      ok(true, "No separator shown here, nothing to cut through");
      return;
    }
    const line = separator.getBoundingClientRect();
    for (const folder of folders) {
      for (const tab of folder.tabs) {
        const row = tab.getBoundingClientRect();
        Assert.lessOrEqual(Math.round(row.bottom), Math.round(line.top) + 1,
          `${folder.label}'s child sits above the separator`);
      }
    }
    Assert.greaterOrEqual(Math.round(normal.getBoundingClientRect().top), Math.round(line.bottom) - 1,
      "...and normal tabs sit below it");
  } finally {
    for (const folder of folders) {
      const removed = BrowserTestUtils.waitForEvent(folder, "TabGroupRemoved");
      folder.delete();
      await removed;
    }
    BrowserTestUtils.removeTab(normal);
  }
});
