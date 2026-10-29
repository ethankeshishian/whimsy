/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// Edit text on page: the page menu's "Edit Text on Page" (or the command
// bar) turns on designMode, typing changes the text, Esc or the address
// bar pill ends it, and leaving the page ends it too.

const PAGE = "https://example.com/document-builder.sjs?html=" + encodeURIComponent("<p id=p>Hello</p>");
const { WhimsyPage } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyPage.sys.mjs");

const designMode = browser => SpecialPowers.spawn(browser, [], () => content.document.designMode);
const pill = () => document.getElementById("whimsy-editing-pill");

add_task(async function test_menu_type_escape() {
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE);
  const browser = tab.linkedBrowser;
  const menu = document.getElementById("contentAreaContextMenu");
  const shown = BrowserTestUtils.waitForPopupEvent(menu, "shown");
  await BrowserTestUtils.synthesizeMouseAtCenter("#p", { type: "contextmenu", button: 2 }, browser);
  await shown;
  const item = document.getElementById("context-whimsy-edit-page");
  ok(item && !item.hidden, "The page menu offers Edit Text on Page");
  const hidden = BrowserTestUtils.waitForPopupEvent(menu, "hidden");
  menu.activateItem(item);
  await hidden;
  await TestUtils.waitForCondition(async () => (await designMode(browser)) == "on", "The page is editable");
  await TestUtils.waitForCondition(() => pill() && !pill().hidden, "The Editing pill shows");

  // Type into the paragraph.
  await SpecialPowers.spawn(browser, [], () => {
    const p = content.document.getElementById("p");
    const range = content.document.createRange();
    range.selectNodeContents(p);
    range.collapse(false);
    content.getSelection().removeAllRanges();
    content.getSelection().addRange(range);
  });
  browser.focus();
  EventUtils.sendString(" world");
  await TestUtils.waitForCondition(
    () => SpecialPowers.spawn(browser, [], () => content.document.getElementById("p").textContent == "Hello world"),
    "Typing edits the text"
  );

  EventUtils.synthesizeKey("KEY_Escape");
  await TestUtils.waitForCondition(async () => (await designMode(browser)) == "off", "Esc finishes editing");
  await TestUtils.waitForCondition(() => pill().hidden, "and the pill goes");
  BrowserTestUtils.removeTab(tab);
});

add_task(async function test_pill_navigation_and_switch() {
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE);
  const browser = tab.linkedBrowser;
  ok(await WhimsyPage.toggleEditing(window), "The command turns editing on");
  EventUtils.synthesizeMouseAtCenter(pill(), {});
  await TestUtils.waitForCondition(async () => (await designMode(browser)) == "off", "Clicking the pill finishes");

  await WhimsyPage.toggleEditing(window, true);
  const other = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.com/");
  ok(pill().hidden, "Another tab has no pill");
  gBrowser.selectedTab = tab;
  ok(!pill().hidden, "back on the edited tab it shows again");
  BrowserTestUtils.startLoadingURIString(browser, "https://example.com/?next");
  await BrowserTestUtils.browserLoaded(browser);
  ok(!browser.whimsyEditing && pill().hidden, "Leaving the page ends editing");
  BrowserTestUtils.removeTab(other);

  await SpecialPowers.pushPrefEnv({ set: [["whimsy.feature.edit-page", false]] });
  ok(!(await WhimsyPage.toggleEditing(window, true)), "The switch turns it off");
  is(await designMode(browser), "off", "page untouched");
  await SpecialPowers.popPrefEnv();
  BrowserTestUtils.removeTab(tab);
});
