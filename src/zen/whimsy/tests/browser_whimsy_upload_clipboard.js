/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

const { Downloads } = ChromeUtils.importESModule("resource://gre/modules/Downloads.sys.mjs");

const TEST_PAGE = getRootDirectory(gTestPath) + "whimsy_upload.html";

add_task(async function test_click_offers_a_recent_download() {
  // A finished download for the picker to offer.
  const list = await Downloads.getList(Downloads.PUBLIC);
  const target = PathUtils.join(PathUtils.tempDir, "whimsy-upload-test.txt");
  const download = await Downloads.createDownload({
    source: "data:text/plain,whimsy",
    target,
  });
  await list.add(download);
  await download.start();
  registerCleanupFunction(async () => {
    await list.remove(download);
    await IOUtils.remove(target, { ignoreAbsent: true });
  });

  await BrowserTestUtils.withNewTab(TEST_PAGE, async browser => {
    const panelShown = BrowserTestUtils.waitForEvent(document, "popupshown", true, e =>
      e.target.id == "whimsy-upload-panel"
    );
    await BrowserTestUtils.synthesizeMouseAtCenter("#file-input", {}, browser);
    await panelShown;

    const panel = document.getElementById("whimsy-upload-panel");
    const row = [...panel.querySelectorAll("toolbarbutton")].find(b => b.label == "whimsy-upload-test.txt");
    ok(row, "The recent download is offered");

    row.click();
    await TestUtils.waitForCondition(async () => {
      return (await SpecialPowers.spawn(browser, [], () => content.whimsyChangeCount)) > 0;
    }, "The file input's change event fires");

    const fileName = await SpecialPowers.spawn(browser, [], () =>
      content.document.getElementById("file-input").files[0]?.name
    );
    is(fileName, "whimsy-upload-test.txt", "The chosen download is set on the input");
  });
});
