/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// Emoji search in the space icon picker: Zen's single-word tag search,
// plus every word must match, Enter picks the first result, and an empty
// result says so. The feature switch leaves Zen's search alone.

const FEATURE = "whimsy.feature.emoji-search";

registerCleanupFunction(() => Services.prefs.clearUserPref(FEATURE));

async function openPicker() {
  const panel = document.getElementById("PanelUI-zen-emojis-picker");
  const shown = BrowserTestUtils.waitForEvent(panel, "popupshown");
  // Any visible element will do; the switcher hides with one space.
  const anchor = gBrowser.selectedTab;
  const picked = gZenEmojiPicker.open(anchor);
  await shown;
  return { panel, picked };
}

async function closePicker(panel, picked) {
  if (panel.state == "closed") {
    return;
  }
  const hidden = BrowserTestUtils.waitForEvent(panel, "popuphidden");
  panel.hidePopup();
  await hidden;
  await picked?.catch(() => {});
}

function search(text) {
  const input = document.getElementById("PanelUI-zen-emojis-picker-search");
  input.focus();
  input.value = "";
  EventUtils.sendString(text);
}

function visibleEmojis() {
  return [...document.getElementById("PanelUI-zen-emojis-picker-list").children]
    .filter(b => !b.hidden)
    .map(b => b.getAttribute("label"));
}

add_task(async function test_words_and_empty_state() {
  ok(Services.prefs.getBoolPref(FEATURE), "The feature switch is on");
  const { panel, picked } = await openPicker();

  search("rocket");
  ok(visibleEmojis().includes("🚀"), "One word finds the rocket (Zen's search)");

  search("red heart");
  const hearts = visibleEmojis();
  ok(hearts.includes("❤️") || hearts.includes("❤"), "Two words find the red heart");
  ok(!hearts.includes("🚀"), "and nothing else");

  search("zzqqxx");
  is(visibleEmojis().length, 0, "Nonsense matches nothing");
  const empty = document.getElementById("whimsy-emoji-search-empty");
  ok(empty && !empty.hidden, "An empty state shows");
  await TestUtils.waitForCondition(() => empty.getAttribute("value")?.includes("zzqqxx"), "naming the query");

  search("rocket");
  ok(empty.hidden, "The empty state hides once something matches");
  await closePicker(panel, picked);
});

add_task(async function test_enter_picks_first() {
  const { panel, picked } = await openPicker();
  search("rocket");
  const first = [...document.getElementById("PanelUI-zen-emojis-picker-list").children]
    .filter(b => !b.hidden)
    .sort((a, b) => (parseInt(a.style.order) || 0) - (parseInt(b.style.order) || 0))[0]
    .getAttribute("label");
  ok(visibleEmojis().includes("🚀"), "The rocket is among the results");
  const hidden = BrowserTestUtils.waitForEvent(panel, "popuphidden");
  EventUtils.synthesizeKey("KEY_Enter");
  await hidden;
  is(await picked, first, "Enter picks the first result shown");
});

add_task(async function test_switch_off() {
  Services.prefs.setBoolPref(FEATURE, false);
  const { panel, picked } = await openPicker();
  search("zzqqxx");
  const empty = document.getElementById("whimsy-emoji-search-empty");
  ok(!empty || empty.hidden, "No empty state with the switch off");
  await closePicker(panel, picked);
  Services.prefs.clearUserPref(FEATURE);
});
