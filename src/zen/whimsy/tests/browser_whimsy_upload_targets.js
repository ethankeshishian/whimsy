/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// W13-R2 paste to upload (wave13/r2-paste-design.md §7): each kind of site
// gets a copied image exactly once, through its own real code path. A real
// image on the real clipboard, a real Cmd+V (the browser's own paste runs),
// real clicks on Whimsy's badge; nothing is stubbed. The fixtures mirror
// dropzone.dev (the real Dropzone.js), a React app (react-dropzone under a
// root that listens for every event), GitHub, Gmail/Slack and Drive.

requestLongerTimeout(3);

const ROOT = getRootDirectory(gTestPath).replace("chrome://mochitests/content", "https://example.com");

// A 2x2 red PNG.
const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEElEQVR4nGP4z8AARAwQCgAf7gP9i18U1AAAAABJRU5ErkJggg==";

function putImageOnClipboard() {
  const bytes = Uint8Array.from(atob(PNG_BASE64), c => c.charCodeAt(0));
  const imgTools = Cc["@mozilla.org/image/tools;1"].getService(Ci.imgITools);
  const image = imgTools.decodeImageFromArrayBuffer(bytes.buffer, "image/png");
  const transferable = Cc["@mozilla.org/widget/transferable;1"].createInstance(Ci.nsITransferable);
  transferable.init(null);
  transferable.addDataFlavor("image/png");
  transferable.setTransferData("image/png", image);
  Services.clipboard.setData(transferable, null, Ci.nsIClipboard.kGlobalClipboard);
}

// Long enough for every path to finish: the page's turn (500 ms), the
// no-paste fallback (1 s), the clipboard read.
// eslint-disable-next-line mozilla/no-arbitrary-setTimeout
const settle = (ms = 1800) => new Promise(resolve => setTimeout(resolve, ms));

function shownBadges() {
  const layer = gBrowser.selectedBrowser.closest(".browserStack")?.querySelector(".whimsy-paste-layer");
  return layer && !layer.hidden ? [...layer.querySelectorAll(".whimsy-paste-badge")] : [];
}

// The clipboard holds an image, then the tab opens (selecting a tab checks
// the clipboard's type).
async function openWithImage(page) {
  putImageOnClipboard();
  return BrowserTestUtils.openNewForegroundTab(gBrowser, ROOT + page);
}

// A value the page keeps on its window, by path ("accepted.length").
const pageValue = (browser, path) =>
  SpecialPowers.spawn(browser, [path], p => p.split(".").reduce((value, key) => value?.[key], content.wrappedJSObject));

const dropzoneState = browser =>
  SpecialPowers.spawn(browser, [], () => ({
    previews: content.document.querySelectorAll(".dz-preview").length,
    added: content.wrappedJSObject.dzAdded,
    files: content.document.getElementById("demo").wrappedJSObject.dropzone.files.length,
  }));

add_setup(async function () {
  await SpecialPowers.pushPrefEnv({
    set: [
      ["whimsy.feature.upload-clipboard", true],
      ["whimsy.uploadClipboard.badges", true],
      ["dom.events.dataTransfer.imageAsFile.enabled", true],
    ],
  });
});

// dropzone.dev, hovering the box: Dropzone.js (not a fake) adds the file
// once, through its own hidden input.
add_task(async function test_dropzone_dev_hover() {
  const tab = await openWithImage("whimsy_upload_dropzone_real.html");
  const browser = tab.linkedBrowser;
  await BrowserTestUtils.synthesizeMouseAtCenter("#demo-text", { type: "mousemove" }, browser);
  EventUtils.synthesizeKey("v", { accelKey: true });
  await TestUtils.waitForCondition(async () => (await dropzoneState(browser)).previews >= 1, "Dropzone shows the pasted file");
  await settle();
  Assert.deepEqual(await dropzoneState(browser), { previews: 1, added: 1, files: 1 }, "Exactly once, added by Dropzone.js itself");
  BrowserTestUtils.removeTab(tab);
});

// The user's flow on dropzone.dev: click the box (Dropzone opens the file
// picker), take a while, cancel, move away, Cmd+V. Nothing is focused or
// hovered and the click is old: the paste goes to the badged box.
// (dev.1100: nothing happened.)
add_task(async function test_dropzone_dev_click_cancel_then_paste() {
  const MockFilePicker = SpecialPowers.MockFilePicker;
  MockFilePicker.init(window.browsingContext);
  MockFilePicker.returnValue = MockFilePicker.returnCancel;
  let pickerShown = false;
  MockFilePicker.showCallback = () => {
    pickerShown = true;
  };
  try {
    const tab = await openWithImage("whimsy_upload_dropzone_real.html");
    const browser = tab.linkedBrowser;
    await TestUtils.waitForCondition(() => shownBadges().length == 1, "dropzone.dev's box has its badge");
    await BrowserTestUtils.synthesizeMouseAtCenter("#demo-text", {}, browser);
    await TestUtils.waitForCondition(() => pickerShown, "Clicking the box opened Dropzone's file picker");
    // The time spent in the picker, then the pointer off the page.
    await settle(5500);
    EventUtils.synthesizeMouseAtCenter(gURLBar.inputField, { type: "mousemove" });
    await SpecialPowers.spawn(browser, [], () => {
      Assert.ok(!content.document.getElementById("demo").matches(":hover"), "The pointer isn't over the box");
      Assert.equal(content.document.activeElement, content.document.body, "Nothing is focused");
    });
    EventUtils.synthesizeKey("v", { accelKey: true });
    await TestUtils.waitForCondition(async () => (await dropzoneState(browser)).previews >= 1, "The paste went to the badged box");
    await settle();
    Assert.deepEqual(await dropzoneState(browser), { previews: 1, added: 1, files: 1 }, "Exactly once");
    BrowserTestUtils.removeTab(tab);
  } finally {
    MockFilePicker.cleanup();
  }
});

// Dropzone's documented paste handler adds the file itself and doesn't
// prevent the paste: Whimsy sees the file arrive and adds nothing.
add_task(async function test_dropzone_docs_paste_handler() {
  const tab = await openWithImage("whimsy_upload_dropzone_real.html?docs=1");
  const browser = tab.linkedBrowser;
  await BrowserTestUtils.synthesizeMouseAtCenter("#demo-text", { type: "mousemove" }, browser);
  EventUtils.synthesizeKey("v", { accelKey: true });
  await TestUtils.waitForCondition(async () => (await dropzoneState(browser)).previews >= 1, "The page's paste handler added the file");
  await settle();
  Assert.deepEqual(await dropzoneState(browser), { previews: 1, added: 1, files: 1 }, "Exactly once: Whimsy didn't add it again");
  is(await pageValue(browser, "pageHandled"), 1, "…and it was the page's own");
  BrowserTestUtils.removeTab(tab);
});

// A React app: its root listens for paste (as every React root does), but no
// component takes pasted files. Whimsy waits for the page, then delivers to
// react-dropzone's input. (dev.1100: it saw the root's listener and gave up.)
add_task(async function test_react_root_without_on_paste() {
  const tab = await openWithImage("whimsy_upload_react.html");
  const browser = tab.linkedBrowser;
  await SpecialPowers.spawn(browser, [], () => content.document.getElementById("rdz").focus());
  EventUtils.synthesizeKey("v", { accelKey: true });
  await TestUtils.waitForCondition(async () => (await pageValue(browser, "accepted.length")) >= 1, "react-dropzone got the file");
  await settle();
  is(await pageValue(browser, "accepted.length"), 1, "Exactly once");
  BrowserTestUtils.removeTab(tab);
});

// The same app with an onPaste that takes files (and prevents the paste):
// the page's own paste wins, and Whimsy adds nothing.
add_task(async function test_react_root_with_on_paste() {
  const tab = await openWithImage("whimsy_upload_react.html?onPaste=1");
  const browser = tab.linkedBrowser;
  await SpecialPowers.spawn(browser, [], () => content.document.getElementById("rdz").focus());
  EventUtils.synthesizeKey("v", { accelKey: true });
  await TestUtils.waitForCondition(async () => (await pageValue(browser, "accepted.length")) >= 1, "The page's onPaste took it");
  await settle();
  is(await pageValue(browser, "accepted.length"), 1, "Exactly once");
  BrowserTestUtils.removeTab(tab);
});

// GitHub: Cmd+V in the comment box is GitHub's own paste (Whimsy adds
// nothing); the badge on "Paste, drop, or click to add files" uploads
// through its input.
add_task(async function test_github_comment_box() {
  const tab = await openWithImage("whimsy_upload_github.html");
  const browser = tab.linkedBrowser;
  await SpecialPowers.spawn(browser, [], () => content.document.getElementById("comment").focus());
  EventUtils.synthesizeKey("v", { accelKey: true });
  await TestUtils.waitForCondition(async () => (await pageValue(browser, "attached.length")) >= 1, "GitHub attached the pasted image");
  await settle();
  is(await pageValue(browser, "attached.length"), 1, "Once");
  is(await pageValue(browser, "inputChanges"), 0, "…by GitHub's paste, not through Whimsy");

  await TestUtils.waitForCondition(() => shownBadges().length == 1, "The upload label has a badge");
  EventUtils.synthesizeMouseAtCenter(shownBadges()[0], {});
  await TestUtils.waitForCondition(async () => (await pageValue(browser, "attached.length")) >= 2, "The badge uploaded the image");
  await settle();
  is(await pageValue(browser, "attached.length"), 2, "One more, once");
  is(await pageValue(browser, "inputChanges"), 1, "…through the label's input");
  BrowserTestUtils.removeTab(tab);
});

// Gmail or Slack: the composer's paste is the page's; its attachment input
// has no visible owner, so there is no badge and Whimsy adds nothing.
add_task(async function test_compose_box() {
  const tab = await openWithImage("whimsy_upload_compose.html");
  const browser = tab.linkedBrowser;
  await SpecialPowers.spawn(browser, [], () => content.document.getElementById("composer").focus());
  EventUtils.synthesizeKey("v", { accelKey: true });
  await TestUtils.waitForCondition(async () => (await pageValue(browser, "attached.length")) >= 1, "The composer attached the image");
  await settle();
  is(await pageValue(browser, "attached.length"), 1, "Once");
  is(await pageValue(browser, "inputChanges"), 0, "Whimsy didn't add it to the attachment input");
  is(shownBadges().length, 0, "No badge on a page with no visible upload box");
  BrowserTestUtils.removeTab(tab);
});

// Drive: no target Whimsy can find, so no badge, and Cmd+V adds nothing (no
// promise it can't keep).
add_task(async function test_drive_has_no_target() {
  const tab = await openWithImage("whimsy_upload_drive.html");
  const browser = tab.linkedBrowser;
  await settle(800);
  is(shownBadges().length, 0, "No badge");
  await BrowserTestUtils.synthesizeMouseAtCenter("#list", { type: "mousemove" }, browser);
  EventUtils.synthesizeKey("v", { accelKey: true });
  await settle();
  is(await pageValue(browser, "dropped"), 0, "Nothing dropped on the list");
  is(await pageValue(browser, "uploaded"), 0, "Nothing uploaded");
  BrowserTestUtils.removeTab(tab);
});

// dropzone.dev takes four files; a fifth is refused by the site, and the
// pill says so instead of pretending.
add_task(async function test_dropzone_dev_refuses_a_fifth_file() {
  const tab = await openWithImage("whimsy_upload_dropzone_real.html");
  const browser = tab.linkedBrowser;
  await SpecialPowers.spawn(browser, [], () => {
    const dz = content.document.getElementById("demo").wrappedJSObject.dropzone;
    for (let i = 0; i < 4; i++) {
      dz.addFile(new content.File(["x"], `file${i}.txt`, { type: "text/plain" }));
    }
  });
  is((await dropzoneState(browser)).files, 4, "The demo holds its four files");
  await TestUtils.waitForCondition(() => shownBadges().length == 1, "The box has its badge");
  EventUtils.synthesizeMouseAtCenter(shownBadges()[0], {});
  await TestUtils.waitForCondition(() => shownBadges()[0]?.dataset.status == "failed", "The pill says the paste failed");
  const text = shownBadges()[0].querySelector(".whimsy-paste-text");
  is(document.l10n.getAttributes(text).id, "whimsy-upload-status-failed", "“Couldn't upload: the site didn't accept it”");
  is((await dropzoneState(browser)).files, 4, "The site kept four");
  BrowserTestUtils.removeTab(tab);
});
