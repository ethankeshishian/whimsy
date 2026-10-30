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

// Cmd+V on a focused upload button (or the label a site styles as one) sets
// the clipboard's copied file or image with no popup; Cmd+V in the popup
// takes the clipboard row. The clipboard read itself is stubbed.
add_task(async function test_cmd_v_pastes_into_upload_button() {
  const { WhimsyUploadParent } = ChromeUtils.importESModule(
    "resource:///modules/whimsy/WhimsyUploadParent.sys.mjs"
  );
  const path = PathUtils.join(PathUtils.tempDir, "whimsy-paste-test.txt");
  await IOUtils.writeUTF8(path, "pasted");
  const original = WhimsyUploadParent.clipboardUpload;
  WhimsyUploadParent.clipboardUpload = async () => ({ path, isFile: true });
  registerCleanupFunction(async () => {
    WhimsyUploadParent.clipboardUpload = original;
    await IOUtils.remove(path, { ignoreAbsent: true });
  });
  const fileName = (browser, id) =>
    SpecialPowers.spawn(browser, [id], i => content.document.getElementById(i).files[0]?.name);

  await BrowserTestUtils.withNewTab(TEST_PAGE, async browser => {
    await SpecialPowers.spawn(browser, [], () => content.document.getElementById("file-input").focus());
    EventUtils.synthesizeKey("v", { accelKey: true });
    await TestUtils.waitForCondition(async () => (await fileName(browser, "file-input")) == "whimsy-paste-test.txt",
      "Cmd+V on the focused input sets the copied file");
    ok(!document.getElementById("whimsy-upload-panel")?.matches("[panelopen]"), "...without the popup");

    await SpecialPowers.spawn(browser, [], () => content.document.getElementById("styled").focus());
    EventUtils.synthesizeKey("v", { accelKey: true });
    await TestUtils.waitForCondition(async () => (await fileName(browser, "hidden-input")) == "whimsy-paste-test.txt",
      "Cmd+V on a styled label button sets its hidden input");
  });

  // In the popup: Cmd+V takes the clipboard row, named after the copied file.
  await BrowserTestUtils.withNewTab(TEST_PAGE, async browser => {
    const panelShown = BrowserTestUtils.waitForEvent(document, "popupshown", true, e =>
      e.target.id == "whimsy-upload-panel"
    );
    await BrowserTestUtils.synthesizeMouseAtCenter("#file-input", {}, browser);
    await panelShown;
    const panel = document.getElementById("whimsy-upload-panel");
    const row = panel.querySelector(".whimsy-upload-clipboard-row");
    is(document.l10n.getAttributes(row).id, "whimsy-upload-clipboard-file", "A copied file gets its own row");
    is(document.l10n.getAttributes(row).args.name, "whimsy-paste-test.txt", "...named after the file");
    const mac = AppConstants.platform == "macosx";
    panel.dispatchEvent(new KeyboardEvent("keydown", { key: "v", metaKey: mac, ctrlKey: !mac, bubbles: true }));
    await TestUtils.waitForCondition(async () => (await fileName(browser, "file-input")) == "whimsy-paste-test.txt",
      "Cmd+V in the popup takes the clipboard row");
  });

  // Switch off: Cmd+V does nothing to the input.
  await SpecialPowers.pushPrefEnv({ set: [["whimsy.feature.upload-clipboard", false]] });
  await BrowserTestUtils.withNewTab(TEST_PAGE, async browser => {
    await SpecialPowers.spawn(browser, [], () => content.document.getElementById("file-input").focus());
    EventUtils.synthesizeKey("v", { accelKey: true });
    // eslint-disable-next-line mozilla/no-arbitrary-setTimeout
    await new Promise(r => setTimeout(r, 300));
    is(await fileName(browser, "file-input"), undefined, "Switch off: nothing is set");
  });
  await SpecialPowers.popPrefEnv();
});
