/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

const { AppConstants } = ChromeUtils.importESModule("resource://gre/modules/AppConstants.sys.mjs");

const { Downloads } = ChromeUtils.importESModule("resource://gre/modules/Downloads.sys.mjs");
const { WhimsyDownloads } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyDownloads.sys.mjs");

function dockSupportOrNull() {
  try {
    return AppConstants.platform == "macosx"
      ? Cc["@mozilla.org/widget/macdocksupport;1"].getService(Ci.nsIMacDockSupport)
      : null;
  } catch (e) {
    return null;
  }
}

add_task(async function test_dock_badge_in_progress_and_done() {
  const dock = dockSupportOrNull();
  if (!dock) {
    info("No nsIMacDockSupport on this platform; the badge/bounce path is covered on macOS CI.");
    return;
  }
  await WhimsyDownloads.init();
  const url = getRootDirectory(gTestPath) + "whimsy_slow_download.sjs";
  const publicList = await Downloads.getList(Downloads.PUBLIC);
  const download = await Downloads.createDownload({
    source: url,
    target: PathUtils.join(PathUtils.tempDir, "whimsy-slow.bin"),
  });
  await publicList.add(download);
  const started = download.start();

  await TestUtils.waitForCondition(() => dock.badgeText == "1", "Badge shows one in-progress download");
  await started;
  await TestUtils.waitForCondition(() => dock.badgeText == "", "Badge clears once the download finishes");

  await publicList.remove(download);
  await IOUtils.remove(download.target.path, { ignoreAbsent: true });
});

add_task(async function test_quicklook_menuitem_wiring() {
  if (AppConstants.platform != "macosx") {
    info("Quick Look is macOS-only.");
    return;
  }
  WhimsyDownloads.initQuickLook(window);
  const menu = document.getElementById("downloadsContextMenu");

  Services.prefs.setBoolPref("whimsy.feature.quick-look", false);
  menu.dispatchEvent(new Event("popupshowing"));
  ok(!menu.querySelector("#whimsyQuickLookMenuItem"), "No item with the feature off");

  Services.prefs.setBoolPref("whimsy.feature.quick-look", true);
  menu.dispatchEvent(new Event("popupshowing"));
  ok(menu.querySelector("#whimsyQuickLookMenuItem"), "The item appears once the feature is on");

  Services.prefs.clearUserPref("whimsy.feature.quick-look");
  menu.querySelector("#whimsyQuickLookMenuItem")?.remove();
});

add_task(async function test_drag_keeps_panel_open() {
  WhimsyDownloads.initDragKeepOpen(window);
  const panel = document.createXULElement("panel");
  const draggable = document.createXULElement("box");
  draggable.setAttribute("draggable", "true");
  panel.appendChild(draggable);
  document.documentElement.appendChild(panel);
  registerCleanupFunction(() => panel.remove());

  draggable.dispatchEvent(new Event("dragstart", { bubbles: true }));
  is(panel.getAttribute("noautohide"), "true", "noautohide is set for the drag");

  draggable.dispatchEvent(new Event("dragend", { bubbles: true }));
  ok(!panel.hasAttribute("noautohide"), "noautohide is cleared once the drag ends");
});
