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

// fix7: Cmd+V failed on Benepass. Most upload buttons aren't a file input or
// its label: a styled div clicks a hidden input, a drop zone wraps one, a
// clicked drop zone can't even take focus. Each common pattern now gets the
// copied file; a text field keeps its normal paste.
add_task(async function test_cmd_v_on_custom_upload_widgets() {
  const { WhimsyUploadParent } = ChromeUtils.importESModule(
    "resource:///modules/whimsy/WhimsyUploadParent.sys.mjs"
  );
  const path = PathUtils.join(PathUtils.tempDir, "whimsy-widget-paste.txt");
  await IOUtils.writeUTF8(path, "pasted");
  const original = WhimsyUploadParent.clipboardUpload;
  WhimsyUploadParent.clipboardUpload = async () => ({ path, isFile: true });
  const page = getRootDirectory(gTestPath) + "whimsy_upload_widgets.html";
  const fileName = (browser, id) =>
    SpecialPowers.spawn(browser, [id], i => content.document.getElementById(i).files[0]?.name);
  const pasteOn = async (browser, id) => {
    await SpecialPowers.spawn(browser, [id], i => content.document.getElementById(i).focus());
    EventUtils.synthesizeKey("v", { accelKey: true });
  };
  try {
    await BrowserTestUtils.withNewTab(page, async browser => {
      for (const [focus, input, what] of [
        ["fake-button", "widget-input", "A styled div button sets its hidden input"],
        ["dropzone-root", "dropzone-input", "A react-dropzone root sets the input it wraps"],
        ["aria-button", "aria-input", "A button with aria-controls sets that input"],
        ["dropzone-dev-btn", "dropzone-dev-input", "Dropzone.js on dropzone.dev sets its hidden input"],
      ]) {
        await pasteOn(browser, focus);
        await TestUtils.waitForCondition(async () => (await fileName(browser, input)) == "whimsy-widget-paste.txt", what);
      }

      // Clicked, but it can't take focus: the keystroke lands on <body>.
      await BrowserTestUtils.synthesizeMouseAtCenter("#clickzone-text", {}, browser);
      await SpecialPowers.spawn(browser, [], () => {
        Assert.equal(content.document.activeElement, content.document.body, "Nothing is focused");
      });
      EventUtils.synthesizeKey("v", { accelKey: true });
      await TestUtils.waitForCondition(
        async () => (await fileName(browser, "clickzone-input")) == "whimsy-widget-paste.txt",
        "The drop zone you just clicked gets the file"
      );

      // No input at all: the file is dropped on it.
      await pasteOn(browser, "pure-drop");
      await TestUtils.waitForCondition(
        () => SpecialPowers.spawn(browser, [], () => content.wrappedJSObject.whimsyDropped),
        "A drop zone without an input gets the file as a drop"
      );
      is(
        await SpecialPowers.spawn(browser, [], () => content.wrappedJSObject.whimsyDropped),
        "whimsy-widget-paste.txt",
        "...with the copied file"
      );

      // A text field keeps its normal paste.
      await pasteOn(browser, "notes");
      // eslint-disable-next-line mozilla/no-arbitrary-setTimeout
      await new Promise(r => setTimeout(r, 300));
      is(await fileName(browser, "notes-file"), undefined, "Cmd+V in a text field isn't taken for an upload");
    });
  } finally {
    WhimsyUploadParent.clipboardUpload = original;
    await IOUtils.remove(path, { ignoreAbsent: true });
  }
});

// wave7/security L1: the parent hands out the clipboard's file only right
// after a Cmd+V it saw itself, and an aria-label alone doesn't make a drop
// zone.
add_task(async function test_paste_needs_a_real_cmd_v() {
  const { WhimsyUploadParent } = ChromeUtils.importESModule(
    "resource:///modules/whimsy/WhimsyUploadParent.sys.mjs"
  );
  const path = PathUtils.join(PathUtils.tempDir, "whimsy-gesture-paste.txt");
  await IOUtils.writeUTF8(path, "pasted");
  const original = WhimsyUploadParent.clipboardUpload;
  WhimsyUploadParent.clipboardUpload = async () => ({ path, isFile: true });
  try {
    await BrowserTestUtils.withNewTab(TEST_PAGE, async browser => {
      const parent = browser.browsingContext.currentWindowGlobal.getActor("WhimsyUpload");
      // eslint-disable-next-line mozilla/no-arbitrary-setTimeout
      await new Promise(r => setTimeout(r, 2100));
      is(await parent.receiveMessage({ name: "WhimsyUpload:Paste" }), null,
        "Without a Cmd+V just now, a page's request gets nothing");

      await SpecialPowers.spawn(browser, [], () => content.document.getElementById("file-input").focus());
      EventUtils.synthesizeKey("v", { accelKey: true });
      await TestUtils.waitForCondition(
        () => SpecialPowers.spawn(browser, [], () => content.document.getElementById("file-input").files[0]?.name),
        "A real Cmd+V still uploads"
      );

      const labelled = await SpecialPowers.spawn(browser, [], () => {
        const { uploadTargetFor } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyUploadChild.sys.mjs");
        const doc = content.document;
        const wrap = doc.createElement("div");
        wrap.setAttribute("aria-label", "Upload anything");
        const inner = doc.createElement("span");
        wrap.append(inner);
        doc.body.append(wrap);
        return !!uploadTargetFor(inner);
      });
      ok(!labelled, "An aria-label alone doesn't make a drop zone");
    });
  } finally {
    WhimsyUploadParent.clipboardUpload = original;
    await IOUtils.remove(path, { ignoreAbsent: true });
  }
});

// wave9/secfix (security-full-1 L7): the Cmd+V has to be in that tab's
// page: one in the address bar or in another tab doesn't hand this tab
// the clipboard's file.
add_task(async function test_paste_gesture_is_per_tab() {
  const { WhimsyUploadParent } = ChromeUtils.importESModule(
    "resource:///modules/whimsy/WhimsyUploadParent.sys.mjs"
  );
  const other = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.org/?secfix-l7");
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, TEST_PAGE);
  const browser = tab.linkedBrowser;

  gURLBar.focus();
  EventUtils.synthesizeKey("v", { accelKey: true });
  ok(!WhimsyUploadParent.pastedJustNow(window, browser.browsingContext), "Cmd+V in the address bar doesn't count for the page");

  gBrowser.selectedTab = other;
  other.linkedBrowser.focus();
  EventUtils.synthesizeKey("v", { accelKey: true });
  ok(WhimsyUploadParent.pastedJustNow(window, other.linkedBrowser.browsingContext), "Cmd+V in a page counts for that page");
  ok(!WhimsyUploadParent.pastedJustNow(window, browser.browsingContext), "…not for another tab");

  BrowserTestUtils.removeTab(tab);
  BrowserTestUtils.removeTab(other);
});

// W10-48: dropzone.dev. Its Dropzone.js element sits in a wrapper whose
// class also says "dropzone", isn't clickable (no hidden input), and only
// takes files through dropzone.addFile(). Cmd+V over it went to the
// wrapper, and a File handed to the page's addFile was a chrome object it
// couldn't read. A clickable one's own hidden input lost mozSetFileArray
// through the waiver.
add_task(async function test_cmd_v_on_dropzone_js() {
  const { WhimsyUploadParent } = ChromeUtils.importESModule(
    "resource:///modules/whimsy/WhimsyUploadParent.sys.mjs"
  );
  const path = PathUtils.join(PathUtils.tempDir, "whimsy-dropzone-paste.txt");
  await IOUtils.writeUTF8(path, "pasted");
  const original = WhimsyUploadParent.clipboardUpload;
  WhimsyUploadParent.clipboardUpload = async () => ({ path, isFile: true });
  // A web page, as dropzone.dev is (from chrome://, the page's own objects
  // aren't behind an Xray, so there'd be no wrappedJSObject to read).
  const page = getRootDirectory(gTestPath).replace("chrome://mochitests/content", "https://example.com") +
    "whimsy_upload_dropzone.html";
  try {
    await BrowserTestUtils.withNewTab(page, async browser => {
      // Hover the demo (nothing focused, nothing clicked), then Cmd+V.
      await BrowserTestUtils.synthesizeMouseAtCenter("#demo-text", { type: "mousemove" }, browser);
      await SpecialPowers.spawn(browser, [], () => {
        Assert.ok(content.document.getElementById("demo").matches(":hover"), "The pointer is over the drop zone");
        Assert.equal(content.document.activeElement, content.document.body, "Nothing is focused");
      });
      EventUtils.synthesizeKey("v", { accelKey: true });
      await TestUtils.waitForCondition(
        () => SpecialPowers.spawn(browser, [], () => content.wrappedJSObject.dzAdded),
        "Dropzone.js got the file through addFile"
      );
      is(
        await SpecialPowers.spawn(browser, [], () => content.wrappedJSObject.dzAdded),
        "whimsy-dropzone-paste.txt:6",
        "…a file the page can read, once"
      );

      // A clickable Dropzone.js: its own hidden input gets the file.
      await BrowserTestUtils.synthesizeMouseAtCenter("#clickable-text", {}, browser);
      EventUtils.synthesizeKey("v", { accelKey: true });
      await TestUtils.waitForCondition(
        () =>
          SpecialPowers.spawn(browser, [], () => content.document.getElementById("clickable-input").files[0]?.name),
        "The clickable drop zone's hidden input gets the file"
      );
    });
  } finally {
    WhimsyUploadParent.clipboardUpload = original;
    await IOUtils.remove(path, { ignoreAbsent: true });
  }
});
