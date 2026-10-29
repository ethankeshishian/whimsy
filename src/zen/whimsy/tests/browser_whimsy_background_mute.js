/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// Mute background tabs: in "prioritize" mode a background tab is muted only
// while the current tab plays sound; in "background" mode only the current
// tab plays. A mute you set by hand is left alone, and the feature switch
// or "off" leaves every tab playing.

const PAGE = getRootDirectory(gTestPath).replace("chrome://mochitests/content", "https://example.com") + "whimsy_media.html";
const startTabs = new Set(gBrowser.tabs);

registerCleanupFunction(() => {
  for (const tab of gBrowser.tabs.filter(t => !startTabs.has(t))) {
    BrowserTestUtils.removeTab(tab);
  }
});

async function openPlaying() {
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE);
  await SpecialPowers.spawn(tab.linkedBrowser, [], async () => {
    const audio = content.document.getElementById("audio");
    await audio.play();
  });
  await TestUtils.waitForCondition(() => tab.soundPlaying, "the tab plays sound");
  return tab;
}

async function pause(tab) {
  await SpecialPowers.spawn(tab.linkedBrowser, [], () => content.document.getElementById("audio").pause());
  await TestUtils.waitForCondition(() => !tab.soundPlaying, "the tab went quiet", 100, 100);
}

const muted = tab => tab.hasAttribute("muted");

add_setup(async function () {
  await SpecialPowers.pushPrefEnv({
    set: [
      ["media.autoplay.default", 0],
      ["media.autoplay.blocking_policy", 0],
      ["whimsy.media.background-mute", "prioritize"],
    ],
  });
});

add_task(async function test_prioritize() {
  is(Services.prefs.getDefaultBranch("").getStringPref("whimsy.media.background-mute"), "prioritize", "Default mode");
  const a = await openPlaying();
  const b = await openPlaying();
  await TestUtils.waitForCondition(() => muted(a), "A goes quiet while B plays");
  ok(!muted(b), "B, the current tab, plays");

  gBrowser.selectedTab = a;
  await TestUtils.waitForCondition(() => !muted(a) && muted(b), "Selecting A swaps them");

  // The current tab stops: background tabs come back.
  await pause(a);
  await TestUtils.waitForCondition(() => !muted(b), "B plays again once A is quiet");

  // A quiet current tab (about:blank) leaves background sound alone.
  const blank = await BrowserTestUtils.openNewForegroundTab(gBrowser, "about:blank");
  ok(!muted(b), "B keeps playing behind a quiet tab");
  for (const tab of [a, b, blank]) {
    BrowserTestUtils.removeTab(tab);
  }
});

add_task(async function test_background_mode_and_manual_mute() {
  await SpecialPowers.pushPrefEnv({ set: [["whimsy.media.background-mute", "background"]] });
  const a = await openPlaying();
  const blank = await BrowserTestUtils.openNewForegroundTab(gBrowser, "about:blank");
  await TestUtils.waitForCondition(() => muted(a), "Leaving A mutes it");
  gBrowser.selectedTab = a;
  await TestUtils.waitForCondition(() => !muted(a), "Back on A, it plays");

  // A mute set by hand survives switching tabs.
  a.toggleMuteAudio();
  ok(muted(a), "muted by hand");
  gBrowser.selectedTab = blank;
  gBrowser.selectedTab = a;
  await new Promise(r => setTimeout(r, 300));
  ok(muted(a), "Whimsy doesn't unmute a tab muted by hand");
  a.toggleMuteAudio();

  // Unmuting a background tab by hand keeps it audible.
  gBrowser.selectedTab = blank;
  await TestUtils.waitForCondition(() => muted(a), "muted again in the background");
  a.toggleMuteAudio();
  gBrowser.selectedTab = gBrowser.tabs[0];
  gBrowser.selectedTab = blank;
  await new Promise(r => setTimeout(r, 300));
  ok(!muted(a), "A tab unmuted by hand stays unmuted");
  BrowserTestUtils.removeTab(a);
  BrowserTestUtils.removeTab(blank);
  await SpecialPowers.popPrefEnv();
});

add_task(async function test_off_and_switch() {
  for (const [pref, value] of [
    ["whimsy.media.background-mute", "off"],
    ["whimsy.feature.background-mute", false],
  ]) {
    await SpecialPowers.pushPrefEnv({ set: [[pref, value]] });
    const a = await openPlaying();
    const b = await openPlaying();
    await new Promise(r => setTimeout(r, 500));
    ok(!muted(a) && !muted(b), `${pref}=${value}: both tabs play`);
    BrowserTestUtils.removeTab(a);
    BrowserTestUtils.removeTab(b);
    await SpecialPowers.popPrefEnv();
  }
});

add_task(async function test_turning_off_unmutes() {
  const a = await openPlaying();
  const b = await openPlaying();
  await TestUtils.waitForCondition(() => muted(a), "A muted");
  await SpecialPowers.pushPrefEnv({ set: [["whimsy.media.background-mute", "off"]] });
  await TestUtils.waitForCondition(() => !muted(a), "Turning the mode off gives A its sound back");
  await SpecialPowers.popPrefEnv();
  BrowserTestUtils.removeTab(a);
  BrowserTestUtils.removeTab(b);
});

add_task(async function test_settings() {
  await BrowserTestUtils.withNewTab("about:preferences#zenTabManagement", async browser => {
    const doc = browser.contentDocument;
    const menulist = await TestUtils.waitForCondition(() => doc.getElementById("whimsyBackgroundMute"), "Menu shown");
    await TestUtils.waitForCondition(() => menulist.value == "prioritize", "Shows the default mode");
    menulist.value = "background";
    menulist.dispatchEvent(new browser.contentWindow.Event("command", { bubbles: true }));
    await TestUtils.waitForCondition(
      () => Services.prefs.getStringPref("whimsy.media.background-mute") == "background",
      "Choosing a mode sets the pref"
    );
  });
  Services.prefs.clearUserPref("whimsy.media.background-mute");
});
