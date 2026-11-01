/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// W10-63 (Arc): Copy URL (⇧⌘C) with text selected on the page copies the
// URL as usual, and its toast offers "Share a link directly to this text
// instead?". The offer runs Copy Link to Highlight (WhimsyMenuParity), so
// the clipboard ends up with a link to the selected text. With nothing
// selected, or text selected in a field, it's the usual toast.

const PAGE =
  getRootDirectory(gTestPath).replace("chrome://mochitests/content", "https://example.com") + "whimsy_highlight.html";
const { WhimsyToast } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyToast.sys.mjs");
const OFFER_ID = "whimsy-copy-highlight-action";

const clipboardText = () => SpecialPowers.getClipboardData("text/plain");

async function clearClipboard() {
  SpecialPowers.clipboardCopyString("");
  await TestUtils.waitForCondition(() => clipboardText() == "");
}

async function selectParagraph(browser) {
  await SpecialPowers.spawn(browser, [], async () => {
    const doc = content.document;
    const range = doc.createRange();
    range.selectNodeContents(doc.getElementById("p"));
    content.getSelection().removeAllRanges();
    content.getSelection().addRange(range);
    await ContentTaskUtils.waitForCondition(
      () => content.getSelection().toString() == "The quick brown fox jumps over the lazy dog",
      "The paragraph is selected"
    );
    await new Promise(r => content.requestAnimationFrame(() => content.requestAnimationFrame(r)));
  });
}

function zenCopyToast() {
  return [...document.getElementById("zen-toast-container").children].find(
    t => t._messageId == "whimsy-copy-toast" && !t.classList.contains("whimsy-toast")
  );
}

// copy.js runs just before this file and its last copies can still be
// showing; Zen reuses a toast with the same id, so wait for them to time out
// before checking which toasts a press shows.
add_setup(async function () {
  await TestUtils.waitForCondition(
    () => !document.querySelector("#zen-toast-container > *"),
    "Earlier toasts are gone",
    100,
    150
  );
});

add_task(async function test_selection_offers_link_to_highlight() {
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE);
  const browser = tab.linkedBrowser;
  await selectParagraph(browser);
  await clearClipboard();
  document.getElementById("cmd_zenCopyCurrentURL").doCommand();
  await TestUtils.waitForCondition(() => clipboardText() == PAGE, "Copy URL copies the page's URL first");
  const button = await TestUtils.waitForCondition(() => document.getElementById(OFFER_ID), "The toast offers a link to the text");
  const toast = WhimsyToast.current(window);
  is(toast?._messageId, "whimsy-copy-toast", "It's the Copy URL toast");
  is(document.l10n.getAttributes(toast.querySelector(".whimsy-toast-message")).args.count, 1, "for one URL");
  is(
    document.l10n.getAttributes(button.querySelector(".whimsy-toast-action-label")).id,
    "whimsy-copy-highlight-offer",
    "Share a link directly to this text instead?"
  );
  await TestUtils.waitForCondition(
    () => button.textContent.includes("Share a link directly to this text instead?"),
    "Arc's wording"
  );
  ok(!zenCopyToast(), "Only one copy toast");

  button.click();
  const url = await TestUtils.waitForCondition(
    () => clipboardText().includes("#:~:text=") && clipboardText(),
    "The offer copies Link to Highlight"
  );
  ok(url.startsWith(PAGE), `A link to the selected text on this page: ${url}`);
  BrowserTestUtils.removeTab(tab);
});

add_task(async function test_no_selection_no_offer() {
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE);
  await clearClipboard();
  document.getElementById("cmd_zenCopyCurrentURL").doCommand();
  await TestUtils.waitForCondition(() => clipboardText() == PAGE, "Copied");
  await TestUtils.waitForCondition(zenCopyToast, "The usual toast");
  ok(!document.getElementById(OFFER_ID), "No offer without a selection");
  BrowserTestUtils.removeTab(tab);
});

add_task(async function test_field_selection_no_offer() {
  const tab = await BrowserTestUtils.openNewForegroundTab(
    gBrowser,
    "https://example.com/document-builder.sjs?html=" + encodeURIComponent("<input id=f value='some typed words'>")
  );
  await SpecialPowers.spawn(tab.linkedBrowser, [], () => {
    const field = content.document.getElementById("f");
    field.focus();
    field.select();
  });
  await clearClipboard();
  document.getElementById("cmd_zenCopyCurrentURL").doCommand();
  await TestUtils.waitForCondition(() => clipboardText().startsWith("https://example.com/"), "Copied");
  await TestUtils.waitForCondition(zenCopyToast, "The usual toast");
  ok(!document.getElementById(OFFER_ID), "A field's text can't be linked to: no offer");
  BrowserTestUtils.removeTab(tab);
});

add_task(async function test_markdown_copy_no_offer() {
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE);
  await selectParagraph(tab.linkedBrowser);
  await clearClipboard();
  document.getElementById("cmd_zenCopyCurrentURLMarkdown").doCommand();
  await TestUtils.waitForCondition(() => clipboardText().includes(PAGE), "Copied as Markdown");
  await new Promise(r => setTimeout(r, 300));
  ok(!document.getElementById(OFFER_ID), "Only Copy URL offers it");
  BrowserTestUtils.removeTab(tab);
});
