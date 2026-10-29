/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// Tab title lines: whimsy.tabs.title-lines (1, 2 or 3) lets long tab titles
// wrap onto that many lines in the sidebar; short titles keep the usual
// height; Essentials never wrap.

const LONG = "A very long page title that needs more than one line, and then some more, to read in full";

const startTabs = new Set(gBrowser.tabs);
registerCleanupFunction(() => {
  for (const tab of gBrowser.tabs.filter(t => !startTabs.has(t))) {
    BrowserTestUtils.removeTab(tab);
  }
});

function height(tab) {
  return tab.getBoundingClientRect().height;
}

function lines(tab) {
  const label = tab.querySelector(".tab-label");
  const lineHeight = parseFloat(window.getComputedStyle(label).lineHeight);
  const style = window.getComputedStyle(label);
  const content = label.getBoundingClientRect().height - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom);
  return Math.round(content / lineHeight);
}

async function setLines(n) {
  await SpecialPowers.pushPrefEnv({ set: [["whimsy.tabs.title-lines", n]] });
  await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
}

add_task(async function test_lines() {
  ok(Services.prefs.getBoolPref("whimsy.feature.title-lines"), "The feature switch is on");
  is(Services.prefs.getIntPref("whimsy.tabs.title-lines"), 1, "One line by default");
  const short = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.com/");
  const long = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.org/");
  long.setAttribute("label", LONG);
  short.setAttribute("label", "Short");
  await new Promise(resolve => requestAnimationFrame(resolve));
  const oneLineHeight = height(long);
  is(height(short), oneLineHeight, "One line: every tab is the same height");

  await setLines(2);
  is(lines(long), 2, "Two lines: the long title wraps onto two lines");
  Assert.greater(height(long), oneLineHeight, "and its tab grows");
  is(height(short), oneLineHeight, "A short title keeps the usual height");

  await setLines(3);
  is(lines(long), 3, "Three lines");

  await SpecialPowers.pushPrefEnv({ set: [["whimsy.feature.title-lines", false]] });
  await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  is(height(long), oneLineHeight, "With the feature switch off, titles stay on one line");
  await SpecialPowers.popPrefEnv();

  await SpecialPowers.popPrefEnv();
  await SpecialPowers.popPrefEnv();
  await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  is(height(long), oneLineHeight, "Back to one line");
  BrowserTestUtils.removeTab(long);
  BrowserTestUtils.removeTab(short);
});

add_task(async function test_essentials_never_wrap() {
  await setLines(3);
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.com/");
  tab.setAttribute("label", LONG);
  gZenPinnedTabManager.addToEssentials(tab);
  await TestUtils.waitForCondition(() => tab.hasAttribute("zen-essential"), "Tab is an Essential");
  isnot(window.getComputedStyle(tab.querySelector(".tab-label")).webkitLineClamp, "3", "An Essential's title isn't clamped");
  gZenPinnedTabManager.removeEssentials(tab);
  BrowserTestUtils.removeTab(tab);
  await SpecialPowers.popPrefEnv();
});

add_task(async function test_settings() {
  await BrowserTestUtils.withNewTab("about:preferences#zenTabManagement", async browser => {
    const doc = browser.contentDocument;
    const menulist = await TestUtils.waitForCondition(() => doc.getElementById("whimsyTitleLines"), "Menu shown");
    await TestUtils.waitForCondition(() => menulist.value == "1", "Shows one line");
    menulist.value = "2";
    menulist.dispatchEvent(new browser.contentWindow.Event("command", { bubbles: true }));
    await TestUtils.waitForCondition(() => Services.prefs.getIntPref("whimsy.tabs.title-lines") == 2, "Choosing 2 lines sets the pref");
  });
  Services.prefs.clearUserPref("whimsy.tabs.title-lines");
});
