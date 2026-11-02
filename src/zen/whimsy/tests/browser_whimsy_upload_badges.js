/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// W13-R2 paste to upload, the indicator (option D; wave13/r2-paste-design.md
// §6): "⌘V Paste" badges drawn by Whimsy above the page, on the upload boxes
// in view while the clipboard holds an image; at most 3; the pill on hover
// or focus; click to paste; reachable by keyboard; gone after a text copy,
// after 5 minutes (only the pill then), with the setting off and in private
// windows. Real clipboard, real keys, real clicks.

requestLongerTimeout(3);

const { WhimsyUploadBadges } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyUploadBadges.sys.mjs");

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

// eslint-disable-next-line mozilla/no-arbitrary-setTimeout
const settle = (ms = 1800) => new Promise(resolve => setTimeout(resolve, ms));

function shownBadges(win = window) {
  const layer = win.gBrowser.selectedBrowser.closest(".browserStack")?.querySelector(".whimsy-paste-layer");
  return layer && !layer.hidden ? [...layer.querySelectorAll(".whimsy-paste-badge")] : [];
}

function highlight() {
  const layer = gBrowser.selectedBrowser.closest(".browserStack")?.querySelector(".whimsy-paste-layer");
  return layer?.querySelector(".whimsy-paste-highlight");
}

async function openWithImage(page) {
  putImageOnClipboard();
  return BrowserTestUtils.openNewForegroundTab(gBrowser, ROOT + page);
}

const accepted = browser => SpecialPowers.spawn(browser, [], () => content.wrappedJSObject.accepted.length);

add_setup(async function () {
  await SpecialPowers.pushPrefEnv({
    set: [
      ["whimsy.feature.upload-clipboard", true],
      ["whimsy.uploadClipboard.badges", true],
    ],
  });
});

// At most three, in reading order, only for boxes in view; each a button
// named "Paste image to upload".
add_task(async function test_badges_in_view_at_most_three() {
  const tab = await openWithImage("whimsy_upload_many.html");
  const browser = tab.linkedBrowser;
  await TestUtils.waitForCondition(() => shownBadges().length == 3, "Three badges for four boxes in view");
  const badges = shownBadges();
  const tops = badges.map(b => b.getBoundingClientRect().top);
  Assert.deepEqual(tops, [...tops].sort((a, b) => a - b), "In reading order");
  for (const badge of badges) {
    is(badge.localName, "button", "A badge is a button");
    is(document.l10n.getAttributes(badge).id, "whimsy-upload-badge-image", "…named for the image");
  }
  await TestUtils.waitForCondition(
    () => badges[0].getAttribute("aria-label") == "Paste image to upload",
    "Screen readers hear “Paste image to upload”"
  );
  is(document.l10n.getAttributes(badges[0].querySelector(".whimsy-paste-text")).id, "whimsy-upload-badge-paste", "It says Paste");

  // Scroll the far box in and the others out.
  await SpecialPowers.spawn(browser, [], () => content.document.getElementById("far").scrollIntoView({ block: "center" }));
  await TestUtils.waitForCondition(() => shownBadges().length == 1, "Only the box now in view has a badge");
  BrowserTestUtils.removeTab(tab);
});

// Hover grows the badge into the pill, with the drag highlight on the box;
// moving away shrinks it back. A click on it pastes, once, and says so.
add_task(async function test_hover_pill_and_click() {
  const tab = await openWithImage("whimsy_upload_react.html");
  const browser = tab.linkedBrowser;
  await TestUtils.waitForCondition(() => shownBadges().length == 1, "react-dropzone's box has a badge");
  ok(!shownBadges()[0].classList.contains("whimsy-paste-hot"), "Not hovered: the small badge");

  await BrowserTestUtils.synthesizeMouseAtCenter("#rdz", { type: "mousemove" }, browser);
  await TestUtils.waitForCondition(() => shownBadges()[0]?.classList.contains("whimsy-paste-hot"), "Hover grows it into the pill");
  is(
    document.l10n.getAttributes(shownBadges()[0].querySelector(".whimsy-paste-text")).id,
    "whimsy-upload-pill-image",
    "“Image on clipboard · ⌘V to upload”"
  );
  ok(!highlight().hidden, "The box gets the drag highlight");

  await BrowserTestUtils.synthesizeMouseAtCenter("#elsewhere", { type: "mousemove" }, browser);
  await TestUtils.waitForCondition(() => !shownBadges()[0]?.classList.contains("whimsy-paste-hot"), "Away: the badge again");
  ok(highlight().hidden, "…and no highlight");

  EventUtils.synthesizeMouseAtCenter(shownBadges()[0], {});
  await TestUtils.waitForCondition(async () => (await accepted(browser)) >= 1, "The click pasted into the box");
  await TestUtils.waitForCondition(() => shownBadges()[0]?.dataset.status == "done", "“Uploading… ✓”");
  await settle();
  is(await accepted(browser), 1, "Exactly once");
  BrowserTestUtils.removeTab(tab);
});

// Keyboard: Tab from the focused box lands on its badge; Return pastes; Tab
// goes on to what follows the box.
add_task(async function test_keyboard() {
  const tab = await openWithImage("whimsy_upload_react.html");
  const browser = tab.linkedBrowser;
  await TestUtils.waitForCondition(() => shownBadges().length == 1, "The box has a badge");
  browser.focus();
  await SpecialPowers.spawn(browser, [], () => content.document.getElementById("rdz").focus());
  await TestUtils.waitForCondition(() => shownBadges()[0]?.classList.contains("whimsy-paste-hot"), "Focus grows it into the pill");
  EventUtils.synthesizeKey("KEY_Tab");
  await TestUtils.waitForCondition(() => document.activeElement?.classList.contains("whimsy-paste-badge"), "Tab moved to the badge");
  EventUtils.synthesizeKey("KEY_Enter");
  await TestUtils.waitForCondition(async () => (await accepted(browser)) >= 1, "Return pasted");
  await settle();
  is(await accepted(browser), 1, "Once");
  EventUtils.synthesizeKey("KEY_Tab");
  await TestUtils.waitForCondition(
    () => SpecialPowers.spawn(browser, [], () => content.document.activeElement?.id == "after"),
    "Tab from the badge goes on to the element after the box"
  );
  BrowserTestUtils.removeTab(tab);
});

// A copy in Whimsy (Cmd+C on page text) replaces the image: the badges go.
// An image again, then a tab switch: they're back.
add_task(async function test_text_copy_removes_badges() {
  const tab = await openWithImage("whimsy_upload_react.html");
  const browser = tab.linkedBrowser;
  await TestUtils.waitForCondition(() => shownBadges().length == 1, "A badge while the image is copied");
  await SpecialPowers.spawn(browser, [], () => {
    const doc = content.document;
    const range = doc.createRange();
    range.selectNodeContents(doc.getElementById("elsewhere"));
    content.getSelection().removeAllRanges();
    content.getSelection().addRange(range);
  });
  EventUtils.synthesizeKey("c", { accelKey: true });
  await TestUtils.waitForCondition(() => shownBadges().length == 0, "Copying text took the badges away");
  is(WhimsyUploadBadges.clipboardState, null, "The clipboard holds no image now");

  putImageOnClipboard();
  const other = await BrowserTestUtils.openNewForegroundTab(gBrowser, "about:blank");
  gBrowser.selectedTab = tab;
  await TestUtils.waitForCondition(() => shownBadges().length == 1, "An image again: the badge is back");
  BrowserTestUtils.removeTab(other);
  BrowserTestUtils.removeTab(tab);
});

// Five minutes after the image was first seen: no badges, but hovering a
// box still shows the pill.
add_task(async function test_badges_expire_to_the_pill() {
  const tab = await openWithImage("whimsy_upload_react.html");
  const browser = tab.linkedBrowser;
  await TestUtils.waitForCondition(() => shownBadges().length == 1, "A badge at first");
  WhimsyUploadBadges._testFirstSeen(WhimsyUploadBadges.FRESH_MS + 1000);
  await TestUtils.waitForCondition(() => shownBadges().length == 0, "After 5 minutes, no badge");
  await BrowserTestUtils.synthesizeMouseAtCenter("#rdz", { type: "mousemove" }, browser);
  await TestUtils.waitForCondition(
    () => shownBadges().length == 1 && shownBadges()[0].classList.contains("whimsy-paste-hot"),
    "Hovering the box still shows the pill"
  );
  BrowserTestUtils.removeTab(tab);
});

// The setting off: nothing shows (Cmd+V still uploads).
add_task(async function test_setting_off() {
  const tab = await openWithImage("whimsy_upload_react.html");
  const browser = tab.linkedBrowser;
  await TestUtils.waitForCondition(() => shownBadges().length == 1, "A badge with the setting on");
  await SpecialPowers.pushPrefEnv({ set: [["whimsy.uploadClipboard.badges", false]] });
  await TestUtils.waitForCondition(() => shownBadges().length == 0, "Setting off: no badge");
  await BrowserTestUtils.synthesizeMouseAtCenter("#rdz", { type: "mousemove" }, browser);
  await settle(600);
  is(shownBadges().length, 0, "…and no pill on hover");
  await SpecialPowers.spawn(browser, [], () => content.document.getElementById("rdz").focus());
  EventUtils.synthesizeKey("v", { accelKey: true });
  await TestUtils.waitForCondition(async () => (await accepted(browser)) >= 1, "Cmd+V still uploads");
  await settle();
  is(await accepted(browser), 1, "Once");
  await SpecialPowers.popPrefEnv();
  BrowserTestUtils.removeTab(tab);
});

// Private windows never show the indicator.
add_task(async function test_private_window() {
  const win = await BrowserTestUtils.openNewBrowserWindow({ private: true });
  putImageOnClipboard();
  const tab = await BrowserTestUtils.openNewForegroundTab(win.gBrowser, ROOT + "whimsy_upload_react.html");
  await BrowserTestUtils.synthesizeMouseAtCenter("#rdz", { type: "mousemove" }, tab.linkedBrowser);
  await settle(1000);
  is(shownBadges(win).length, 0, "No badge or pill in a private window");
  await BrowserTestUtils.closeWindow(win);
});

// Paste Image to Upload (a command with an assignable shortcut): into the
// box Cmd+V would choose.
add_task(async function test_command() {
  const tab = await openWithImage("whimsy_upload_react.html");
  const browser = tab.linkedBrowser;
  await TestUtils.waitForCondition(() => shownBadges().length == 1, "A badge");
  const command = document.getElementById("cmd_whimsyPasteToUpload");
  ok(command, "The command exists");
  command.doCommand();
  await TestUtils.waitForCondition(async () => (await accepted(browser)) >= 1, "The command pasted into the box");
  await settle();
  is(await accepted(browser), 1, "Once");
  BrowserTestUtils.removeTab(tab);
});
