/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// Per-tab volume: a level per tab scales every media element in it (the
// page's own volume times the level), follows volumes the page sets
// later, survives a reload, and is set from a slider panel that opens
// from the tab menu's "Volume…" or by right-clicking the tab's speaker.

const PAGE = getRootDirectory(gTestPath).replace("chrome://mochitests/content", "https://example.com") + "whimsy_media.html";
const { WhimsyMedia } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyMedia.sys.mjs");

add_setup(async function () {
  await SpecialPowers.pushPrefEnv({
    set: [
      ["media.autoplay.default", 0],
      ["media.autoplay.blocking_policy", 0],
      ["whimsy.media.background-mute", "off"],
    ],
  });
});

const volume = browser => SpecialPowers.spawn(browser, [], () => content.document.getElementById("audio").volume);

async function play(browser) {
  await SpecialPowers.spawn(browser, [], () => content.document.getElementById("audio").play());
}

add_task(async function test_volume_scales_media() {
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE);
  const browser = tab.linkedBrowser;
  is(WhimsyMedia.volumeFor(tab), 1, "A tab starts at full volume");
  await play(browser);
  await TestUtils.waitForCondition(() => tab.soundPlaying, "playing");

  WhimsyMedia.setTabVolume(tab, 0.5);
  await TestUtils.waitForCondition(async () => (await volume(browser)) == 0.5, "The audio plays at half volume");

  // The page changes its own volume: Whimsy scales that too.
  await SpecialPowers.spawn(browser, [], () => {
    content.document.getElementById("audio").volume = 0.8;
  });
  await TestUtils.waitForCondition(async () => Math.abs((await volume(browser)) - 0.4) < 0.001, "0.8 plays at 0.4");

  // After a reload the level comes back once the media plays.
  BrowserTestUtils.reloadTab(tab);
  await BrowserTestUtils.browserLoaded(browser);
  await play(browser);
  await TestUtils.waitForCondition(async () => (await volume(browser)) == 0.5, "The level survives a reload");

  // Back to 100%: the page's own volume returns.
  WhimsyMedia.setTabVolume(tab, 1);
  await TestUtils.waitForCondition(async () => (await volume(browser)) == 1, "Full volume again");
  is(SessionStore.getCustomTabValue(tab, "whimsy-volume"), "", "Nothing saved at 100%");
  BrowserTestUtils.removeTab(tab);
});

add_task(async function test_panel_and_menu() {
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE);
  const quiet = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.com/");
  gBrowser.selectedTab = tab;
  await play(tab.linkedBrowser);
  await TestUtils.waitForCondition(() => tab.soundPlaying, "playing");

  const menu = document.getElementById("tabContextMenu");
  const open = async t => {
    const shown = BrowserTestUtils.waitForPopupEvent(menu, "shown");
    EventUtils.synthesizeMouseAtCenter(t, { type: "contextmenu", button: 2 });
    await shown;
    return document.getElementById("context_whimsyTabVolume");
  };
  let item = await open(quiet);
  ok(!item || item.hidden, "A quiet tab has no Volume item");
  let hidden = BrowserTestUtils.waitForPopupEvent(menu, "hidden");
  menu.hidePopup();
  await hidden;

  item = await open(tab);
  ok(item && !item.hidden, "A playing tab offers Volume…");
  hidden = BrowserTestUtils.waitForPopupEvent(menu, "hidden");
  menu.activateItem(item);
  await hidden;
  const panel = document.getElementById("whimsy-volume-panel");
  await TestUtils.waitForCondition(() => panel.state == "open", "The volume panel opens");
  const slider = panel.querySelector(".whimsy-volume-slider");
  is(slider.value, "100", "It shows the tab's level");
  slider.value = "30";
  slider.dispatchEvent(new Event("input"));
  is(WhimsyMedia.volumeFor(tab), 0.3, "Dragging the slider sets the level");
  is(SessionStore.getCustomTabValue(tab, "whimsy-volume"), "0.3", "saved with the session");
  await TestUtils.waitForCondition(
    async () => Math.abs((await volume(tab.linkedBrowser)) - 0.3) < 0.001,
    "and the audio follows"
  );
  is(panel.querySelector(".whimsy-volume-value").textContent, "30%", "The panel shows 30%");
  const panelHidden = BrowserTestUtils.waitForPopupEvent(panel, "hidden");
  panel.hidePopup();
  await panelHidden;

  // Right-clicking the speaker opens the slider, not the tab menu.
  const speaker = tab.audioButton;
  if (speaker?.getBoundingClientRect().width) {
    EventUtils.synthesizeMouseAtCenter(speaker, { type: "contextmenu", button: 2 });
    await TestUtils.waitForCondition(() => panel.state == "open", "The speaker's right-click opens the panel");
    isnot(menu.state, "open", "and not the tab menu");
    const closed = BrowserTestUtils.waitForPopupEvent(panel, "hidden");
    panel.hidePopup();
    await closed;
  } else {
    info("The speaker isn't visible in this layout");
  }
  BrowserTestUtils.removeTab(tab);
  BrowserTestUtils.removeTab(quiet);
});

add_task(async function test_switch_off() {
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE);
  await play(tab.linkedBrowser);
  WhimsyMedia.setTabVolume(tab, 0.5);
  await TestUtils.waitForCondition(async () => (await volume(tab.linkedBrowser)) == 0.5);
  await SpecialPowers.pushPrefEnv({ set: [["whimsy.feature.tab-volume", false]] });
  is(WhimsyMedia.volumeFor(tab), 1, "With the switch off, every tab is at full volume");
  ok(!WhimsyMedia.canAdjustVolume(tab), "and there's no slider");
  await TestUtils.waitForCondition(async () => (await volume(tab.linkedBrowser)) == 1, "Disabling restores already playing media");
  BrowserTestUtils.reloadTab(tab);
  await BrowserTestUtils.browserLoaded(tab.linkedBrowser);
  await play(tab.linkedBrowser);
  await new Promise(r => setTimeout(r, 300));
  is(await volume(tab.linkedBrowser), 1, "Media plays at the page's own volume");
  await SpecialPowers.popPrefEnv();
  BrowserTestUtils.removeTab(tab);
});

// fixD: the native macOS slider ignores accent-color; on some themes its
// filled part came out dark against a white track and looked like it
// filled from the right. Whimsy draws it: accent fill from the start side.
add_task(async function test_slider_fills_from_the_start_in_the_accent() {
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE);
  const panel = WhimsyMedia.openVolumePanel(window, tab);
  await TestUtils.waitForCondition(() => panel.state == "open", "The volume panel opens");
  const slider = panel.querySelector(".whimsy-volume-slider");
  const style = getComputedStyle(slider);
  is(style.appearance, "none", "Drawn by Whimsy, not the OS");
  is(style.direction, "ltr", "Fills from the left in a left-to-right UI");
  ok(style.getPropertyValue("--whimsy-volume-fill").trim(), "The fill color is set");
  const background = pseudo =>
    InspectorUtils.getMatchingCSSRules(slider, pseudo)
      .map(rule => rule.style?.getPropertyValue("background") ?? "")
      .join(" ");
  ok(background("::-moz-range-progress").includes("--whimsy-volume-fill"), "The filled part is the accent");
  ok(background("::-moz-range-track").includes("--whimsy-volume-track"), "The rest is a faint track");
  const hidden = BrowserTestUtils.waitForPopupEvent(panel, "hidden");
  panel.hidePopup();
  await hidden;
  BrowserTestUtils.removeTab(tab);
});
