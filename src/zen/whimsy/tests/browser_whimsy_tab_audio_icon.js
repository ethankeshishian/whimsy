/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// wave5/audioicon: Arc's tab speaker. Every tab with sound shows an outline
// speaker between its favicon and title (sidebar rows and pinned tabs) or as
// a badge on the icon (Essentials); muted tabs, including ones background
// muting silenced, show the struck-through speaker. One click toggles mute
// at once, without selecting the tab; right-click still opens the volume
// slider.

const PAGE = getRootDirectory(gTestPath).replace("chrome://mochitests/content", "https://example.com") + "whimsy_media.html";
const PLAYING = "whimsy-tab-audio-playing.svg";
const MUTED = "whimsy-tab-audio-muted.svg";
const startTabs = new Set(gBrowser.tabs);

registerCleanupFunction(async () => {
  for (const tab of gBrowser.tabs.filter(t => !startTabs.has(t))) {
    if (tab.hasAttribute("zen-essential")) {
      gZenPinnedTabManager.removeEssentials(tab);
    }
    BrowserTestUtils.removeTab(tab);
  }
});

add_setup(async function () {
  await SpecialPowers.pushPrefEnv({
    set: [
      ["media.autoplay.default", 0],
      ["media.autoplay.blocking_policy", 0],
      ["whimsy.media.background-mute", "off"],
      ["whimsy.feature.arc-audio-icon", true],
      ["zen.view.sidebar-expanded", true],
    ],
  });
});

const settle = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));

function shown(el) {
  if (!el) {
    return false;
  }
  const rect = el.getBoundingClientRect();
  return getComputedStyle(el).display != "none" && rect.width > 0 && rect.height > 0;
}

// The glyph a row's speaker button draws.
const rowGlyph = tab => getComputedStyle(tab.audioButton.buttonEl).backgroundImage;
// The glyph an icon badge (Essentials, collapsed sidebar) draws.
const badgeGlyph = tab => getComputedStyle(tab.overlayIcon).listStyleImage;

// A tab really playing the local audio fixture, in the background.
async function openPlaying() {
  const back = gBrowser.selectedTab;
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE);
  await SpecialPowers.spawn(tab.linkedBrowser, [], () => content.document.getElementById("audio").play());
  await TestUtils.waitForCondition(() => tab.soundPlaying, "the tab plays sound");
  gBrowser.selectedTab = back;
  await settle();
  return tab;
}

async function clickToggles(tab, target, label) {
  const selected = gBrowser.selectedTab;
  const was = tab.hasAttribute("muted");
  EventUtils.synthesizeMouseAtCenter(target(), {});
  // Instant: the attribute flips in the click's own task, no menu, no delay.
  is(tab.hasAttribute("muted"), !was, `${label}: one click ${was ? "unmutes" : "mutes"} at once`);
  is(gBrowser.selectedTab, selected, `${label}: without switching to the tab`);
  await settle();
}

add_task(async function test_row_speaker() {
  const tab = await openPlaying();
  const speaker = tab.audioButton;
  ok(shown(speaker), "A playing tab shows its speaker");
  ok(rowGlyph(tab).includes(PLAYING), "Arc's speaker-with-waves glyph");
  const name = speaker.getAttribute("aria-label");
  ok(name, `The speaker has an accessible name: "${name}"`);

  // Arc's place: after the favicon, before the title.
  const icon = tab.querySelector(".tab-icon-stack").getBoundingClientRect();
  const label = tab.querySelector(".tab-label-container").getBoundingClientRect();
  const box = speaker.getBoundingClientRect();
  Assert.greaterOrEqual(Math.round(box.left), Math.round(icon.right) - 1, "right of the favicon");
  Assert.lessOrEqual(Math.round(box.right), Math.round(label.left) + 1, "left of the title");

  await clickToggles(tab, () => tab.audioButton, "Row");
  ok(shown(tab.audioButton), "The muted tab keeps its speaker");
  ok(rowGlyph(tab).includes(MUTED), "struck through");
  ok(speaker.getAttribute("aria-label") && speaker.getAttribute("aria-label") != name, "and its name now offers to unmute");
  await clickToggles(tab, () => tab.audioButton, "Row");
  ok(rowGlyph(tab).includes(PLAYING), "Unmuted: the playing glyph is back");
  BrowserTestUtils.removeTab(tab);
});

add_task(async function test_pinned_speaker() {
  const tab = await openPlaying();
  gBrowser.pinTab(tab);
  await TestUtils.waitForCondition(() => tab.pinned, "pinned");
  await settle();
  ok(shown(tab.audioButton), "A playing pinned tab shows its speaker");
  ok(rowGlyph(tab).includes(PLAYING), "with Arc's glyph");
  await clickToggles(tab, () => tab.audioButton, "Pinned");
  ok(rowGlyph(tab).includes(MUTED), "Pinned and muted: struck through");
  await clickToggles(tab, () => tab.audioButton, "Pinned");
  gBrowser.unpinTab(tab);
  BrowserTestUtils.removeTab(tab);
});

add_task(async function test_essentials_badge() {
  const tab = await openPlaying();
  gZenPinnedTabManager.addToEssentials(tab);
  await TestUtils.waitForCondition(() => tab.hasAttribute("zen-essential"), "An Essential");
  await settle();
  ok(shown(tab.overlayIcon), "A playing Essential shows the speaker badge on its tile");
  ok(badgeGlyph(tab).includes(PLAYING), "with Arc's glyph");
  await clickToggles(tab, () => tab.overlayIcon, "Essential");
  ok(shown(tab.overlayIcon), "The muted Essential keeps its badge");
  ok(badgeGlyph(tab).includes(MUTED), "struck through");
  await clickToggles(tab, () => tab.overlayIcon, "Essential");
  gZenPinnedTabManager.removeEssentials(tab);
  BrowserTestUtils.removeTab(tab);
});

add_task(async function test_auto_muted_shows_speaker() {
  await SpecialPowers.pushPrefEnv({ set: [["whimsy.media.background-mute", "background"]] });
  const tab = await openPlaying();
  await TestUtils.waitForCondition(() => tab.hasAttribute("muted"), "Background muting silences the tab");
  await settle();
  ok(shown(tab.audioButton), "An auto-muted tab shows its speaker");
  ok(rowGlyph(tab).includes(MUTED), "struck through");
  await clickToggles(tab, () => tab.audioButton, "Auto-muted");
  ok(!tab.hasAttribute("muted"), "and stays audible after you unmute it");
  BrowserTestUtils.removeTab(tab);
  await SpecialPowers.popPrefEnv();
});

add_task(async function test_volume_slider_still_on_right_click() {
  await SimpleTest.promiseFocus(window);
  const tab = await openPlaying();
  const panel = () => document.getElementById("whimsy-volume-panel");
  EventUtils.synthesizeMouseAtCenter(tab.audioButton, { type: "contextmenu", button: 2 });
  await TestUtils.waitForCondition(() => panel()?.state == "open", "Right-clicking the speaker opens the volume slider");
  ok(!tab.hasAttribute("muted"), "without muting the tab");
  isnot(document.getElementById("tabContextMenu").state, "open", "and not the tab menu");
  const hidden = BrowserTestUtils.waitForPopupEvent(panel(), "hidden");
  panel().hidePopup();
  await hidden;
  BrowserTestUtils.removeTab(tab);
});

add_task(async function test_switch_off() {
  await SpecialPowers.pushPrefEnv({ set: [["whimsy.feature.arc-audio-icon", false]] });
  const tab = await openPlaying();
  ok(shown(tab.audioButton), "With the switch off, Firefox's speaker still shows");
  ok(!rowGlyph(tab).includes(PLAYING), "in Firefox's own glyph");
  await clickToggles(tab, () => tab.audioButton, "Switch off");
  BrowserTestUtils.removeTab(tab);
  await SpecialPowers.popPrefEnv();
});
