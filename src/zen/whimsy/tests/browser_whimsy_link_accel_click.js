/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// W29-tabclicks: Cmd+click (Ctrl+click off macOS) on a plain page link is
// Firefox's own "open in a new background tab", same as a middle-click.
// The current tab must not navigate.

async function linkTab() {
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.com/?accel-click");
  await SpecialPowers.spawn(tab.linkedBrowser, [], () => {
    content.document.body.innerHTML = "<a id='l' href='https://example.org/?accel-target' style='font-size:40px'>link</a>";
  });
  return tab;
}

add_task(async function test_accel_click_opens_new_background_tab() {
  const tab = await linkTab();
  const startCount = gBrowser.tabs.length;
  try {
    const newTabPromise = BrowserTestUtils.waitForNewTab(gBrowser, "https://example.org/?accel-target", false);
    await BrowserTestUtils.synthesizeMouseAtCenter("#l", { accelKey: true }, tab.linkedBrowser);
    const newTab = await newTabPromise;
    is(gBrowser.tabs.length, startCount + 1, "One new tab, not a replace");
    is(gBrowser.selectedTab, tab, "The new tab opens in the background: the clicked tab stays selected");
    is(tab.linkedBrowser.currentURI.spec, "https://example.com/?accel-click", "The clicked tab never navigated");
    is(newTab.linkedBrowser.currentURI.spec, "https://example.org/?accel-target", "...the link's address is in the new tab");
    BrowserTestUtils.removeTab(newTab);
  } finally {
    BrowserTestUtils.removeTab(tab);
  }
});
