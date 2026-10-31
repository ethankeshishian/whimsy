/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// wave9/secfix (security-full-2 M1): the paste guard only looked at pastes
// into fields, and only in http(s) and file documents. A phishing page
// could read a pasted key from its own paste listener with no field
// focused, or put its "field" in a srcdoc or about:blank frame where the
// guard never ran. Every trusted paste in every web frame is checked now.

const PAGE = "https://example.com/?secfix-paste-frames";
const PANEL_ID = "whimsy-paste-guard";
// AWS's documentation example key, built in two parts.
const KEY = "AKIA" + "IOSFODNN7EXAMPLE";

const sheet = () => document.getElementById(PANEL_ID);
const sheetOpen = () => sheet()?.state == "open";

async function cancelSheet() {
  sheet().querySelector(".whimsy-sheet-footer-button.primary").doCommand();
  await TestUtils.waitForCondition(() => !sheet(), "Cancelled");
}

// A page that reads every paste on document, as a phishing page would.
async function openPage(html) {
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE);
  await SpecialPowers.spawn(tab.linkedBrowser, [html], markup => {
    const doc = content.document;
    doc.body.innerHTML = markup;
    doc.body.dataset.read = "";
    doc.addEventListener("paste", event => {
      doc.body.dataset.read += event.clipboardData.getData("text/plain");
    });
  });
  return tab;
}

const readByPage = browser => SpecialPowers.spawn(browser, [], () => content.document.body.dataset.read);

// Runs the paste command in that frame's own docShell: a trusted paste,
// as Cmd+V there would be, without waiting for chrome's command state.
function pasteIn(browsingContext) {
  return SpecialPowers.spawn(browsingContext, [], () => content.docShell.doCommand("cmd_paste"));
}

async function copy(text) {
  await SimpleTest.promiseClipboardChange(text, () => SpecialPowers.clipboardCopyString(text));
}

add_task(async function a_paste_with_no_field_is_checked() {
  const tab = await openPage("<p>Press Cmd+V to verify</p>");
  const browser = tab.linkedBrowser;
  await copy(KEY);
  await SpecialPowers.spawn(browser, [], () => {
    content.document.activeElement?.blur?.();
    content.focus();
  });
  await pasteIn(browser.browsingContext);
  await TestUtils.waitForCondition(sheetOpen, "The sheet asks, though no field is focused");
  is(await readByPage(browser), "", "The page's paste listener never saw the key");
  await cancelSheet();
  is(await readByPage(browser), "", "…nor after Cancel");

  // Ordinary text still reaches the page at once.
  await copy("hello there");
  await pasteIn(browser.browsingContext);
  await TestUtils.waitForCondition(async () => (await readByPage(browser)) == "hello there", "Ordinary text pastes");
  ok(!sheetOpen(), "…without a sheet");
  BrowserTestUtils.removeTab(tab);
});

add_task(async function a_field_in_a_srcdoc_frame_is_checked() {
  const tab = await openPage(`<iframe id="frame" srcdoc="<div id='ed' contenteditable='true' style='min-height:2em'></div>"></iframe>`);
  const browser = tab.linkedBrowser;
  await SpecialPowers.spawn(browser, [], async () => {
    const frame = content.document.getElementById("frame");
    if (frame.contentDocument?.readyState != "complete" || !frame.contentDocument.getElementById("ed")) {
      await new Promise(resolve => frame.addEventListener("load", resolve, { once: true }));
    }
    // The parent page reads the frame's DOM (same origin).
    const ed = frame.contentDocument.getElementById("ed");
    ed.focus();
  });
  await copy(KEY);
  await pasteIn(browser.browsingContext.children[0]);
  await TestUtils.waitForCondition(sheetOpen, "The sheet asks for a srcdoc frame's field");
  const inFrame = await SpecialPowers.spawn(browser, [], () =>
    content.document.getElementById("frame").contentDocument.getElementById("ed").textContent);
  is(inFrame, "", "Nothing landed in the frame");
  await cancelSheet();
  BrowserTestUtils.removeTab(tab);
});

add_task(async function a_field_in_an_about_blank_frame_is_checked() {
  const tab = await openPage(`<iframe id="frame"></iframe>`);
  const browser = tab.linkedBrowser;
  await SpecialPowers.spawn(browser, [], () => {
    const doc = content.document.getElementById("frame").contentDocument;
    doc.body.innerHTML = "<div id='ed' contenteditable='true' style='min-height:2em'></div>";
    doc.getElementById("ed").focus();
  });
  await copy(KEY);
  await pasteIn(browser.browsingContext.children[0]);
  await TestUtils.waitForCondition(sheetOpen, "The sheet asks for an about:blank frame's field");
  await cancelSheet();
  BrowserTestUtils.removeTab(tab);
});
