/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// Arc's space icon picker (WhimsySpaceIcons.sys.mjs): Arc's 56 glyphs
// first, in Arc's order, then Zen's after a rule; the current icon on a
// plate and the Icon tab for a glyph; a pick or the trash closes the card
// for a space (not for a tab); emoji skin tones; the switch off leaves
// Zen's picker as it was.

const FEATURE = "whimsy.feature.space-icon-picker";
const TONE = "whimsy.spaces.emoji-skin-tone";
const { WhimsySpaceIcons } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsySpaceIcons.sys.mjs");

let originalIcon;

add_setup(async function () {
  originalIcon = space().icon;
  registerCleanupFunction(async () => {
    Services.prefs.clearUserPref(FEATURE);
    Services.prefs.clearUserPref(TONE);
    await setSpaceIcon(originalIcon);
  });
});

function panel() {
  return document.getElementById("PanelUI-zen-emojis-picker");
}

function space() {
  return gZenWorkspaces.getWorkspaceFromId(gZenWorkspaces.activeWorkspace);
}

async function setSpaceIcon(icon) {
  const workspace = space();
  workspace.icon = icon;
  await gZenWorkspaces.saveWorkspace(workspace);
}

// Opens the picker the way the header's icon (and Change Icon…) does.
async function openForSpace() {
  await TestUtils.waitForCondition(
    () => gZenWorkspaces.activeWorkspaceIndicator?.querySelector(".zen-current-workspace-indicator-icon"),
    "The space header's icon is there"
  );
  const shown = BrowserTestUtils.waitForEvent(panel(), "popupshown");
  gZenWorkspaces.changeWorkspaceIcon();
  await shown;
}

async function pick(button) {
  const hidden = BrowserTestUtils.waitForEvent(panel(), "popuphidden");
  button.doCommand();
  await hidden;
}

function glyphButtons() {
  return [...gZenEmojiPicker.svgList.children].filter(b => b.hasAttribute("icon"));
}

function glyph(name) {
  return glyphButtons().find(b => b.getAttribute("icon") == name);
}

function emojiButton(base) {
  return [...gZenEmojiPicker.emojiList.children].find(
    b => (b.getAttribute("whimsy-base") || b.getAttribute("label")) == base
  );
}

function search(text) {
  const input = gZenEmojiPicker.searchInput;
  input.focus();
  input.value = "";
  EventUtils.sendString(text);
}

add_task(async function test_arc_glyphs_first_and_pick_closes() {
  ok(Services.prefs.getBoolPref(FEATURE), "The feature switch is on");
  await setSpaceIcon("");
  await openForSpace();
  ok(panel().hasAttribute("whimsy-arc-icons"), "The picker is in Arc's layout");

  const names = glyphButtons().map(b => b.getAttribute("icon"));
  Assert.deepEqual(names.slice(0, 56), WhimsySpaceIcons.ARC_GLYPHS, "Arc's 56 glyphs come first, in Arc's order");
  const rule = gZenEmojiPicker.svgList.querySelector(".whimsy-glyph-rule");
  ok(rule, "A rule separates Zen's own glyphs");
  is(rule.previousElementSibling, glyph("whimsy-train.svg"), "right after Arc's last glyph");
  ok(names.includes("briefcase.svg") && names.includes("rocket.svg"), "Zen's extra glyphs stay in the picker");
  is(new Set(names).size, names.length, "No glyph shows twice");
  ok(
    document.getElementById("PanelUI-zen-emojis-picker-change-emojis").classList.contains("selected"),
    "A space without an icon opens on Emoji, like Zen"
  );

  await pick(glyph("whimsy-train.svg"));
  const url = "chrome://browser/content/whimsy/space-icons/train.svg";
  await TestUtils.waitForCondition(() => space().icon == url, "The space keeps Whimsy's glyph");
  const img = await TestUtils.waitForCondition(() =>
    gZenWorkspaces.activeWorkspaceIndicator?.querySelector(".zen-current-workspace-indicator-icon img")
  );
  is(img.getAttribute("src"), url, "The space's header shows it before the name");
  const image = new Image();
  image.src = url;
  await image.decode();
  ok(image.naturalWidth > 0, "The glyph ships");
});

add_task(async function test_current_icon_plate_and_trash() {
  const url = "chrome://browser/content/whimsy/space-icons/train.svg";
  await setSpaceIcon(url);
  await openForSpace();
  ok(
    document.getElementById("PanelUI-zen-emojis-picker-change-svg").classList.contains("selected"),
    "A space with a glyph opens on the Icon tab"
  );
  ok(glyph("whimsy-train.svg").hasAttribute("whimsy-current"), "The current glyph is on a plate");
  is(panel().querySelectorAll("[whimsy-current]").length, 1, "Only one");

  await pick(document.getElementById("PanelUI-zen-emojis-picker-none"));
  await TestUtils.waitForCondition(() => !gZenWorkspaces.workspaceHasIcon(space()), "The trash takes the icon away");

  // A Zen glyph works the same way, and typing goes to the Emoji tab.
  await setSpaceIcon(gZenEmojiPicker.getSVGURL("heart.svg"));
  await openForSpace();
  ok(glyph("heart.svg").hasAttribute("whimsy-current"), "Zen's glyphs get the plate too");
  search("rocket");
  ok(
    document.getElementById("PanelUI-zen-emojis-picker-change-emojis").classList.contains("selected"),
    "Typing shows the emoji it searches"
  );
  await pick(glyph("heart.svg"));
});

add_task(async function test_skin_tones() {
  Services.prefs.setIntPref(TONE, 3);
  await setSpaceIcon("");
  await openForSpace();
  const tone = document.getElementById("whimsy-emoji-skin-tone");
  ok(tone && !tone.hidden, "The skin tone button is beside the search");
  is(tone.getAttribute("label"), "✋\u{1F3FD}", "showing the hand in the tone");

  // Zen's data spells thumbs up with the emoji presentation selector.
  const thumbs = emojiButton("👍\uFE0F");
  is(thumbs.getAttribute("label"), "👍\u{1F3FD}", "Hands show in the tone");
  is(emojiButton("😀").getAttribute("label"), "😀", "Faces don't take a tone");

  search("thumb"); // Zen's tags for 👍: +1, good, hand, like, thumb, up, yes
  ok(!thumbs.hidden, "Search still finds toned emoji");
  ok(emojiButton("🚀").hidden, "and only what matches");

  Services.prefs.setIntPref(TONE, 0);
  is(thumbs.getAttribute("label"), "👍\uFE0F", "Back to the default tone while open");
  ok(!thumbs.hidden, "and the search keeps it");
  Services.prefs.setIntPref(TONE, 5);
  is(thumbs.getAttribute("label"), "👍\u{1F3FF}", "Another tone applies at once");

  await pick(thumbs);
  await TestUtils.waitForCondition(() => space().icon == "👍\u{1F3FF}", "The space keeps the toned emoji");
  Services.prefs.clearUserPref(TONE);
});

add_task(async function test_tab_icon_picker_stays_open() {
  const picked = gZenEmojiPicker.open(gBrowser.selectedTab, { closeOnSelect: false, onSelect: () => {} });
  await BrowserTestUtils.waitForEvent(panel(), "popupshown");
  is(glyphButtons()[0].getAttribute("icon"), WhimsySpaceIcons.ARC_GLYPHS[0], "The shared picker has Arc's order");
  glyph("heart.svg").doCommand();
  is(panel().state, "open", "A tab's icon picker keeps Zen's behavior (stays open)");
  const hidden = BrowserTestUtils.waitForEvent(panel(), "popuphidden");
  panel().hidePopup();
  await hidden;
  await picked.catch(() => {});
});

add_task(async function test_switch_off() {
  Services.prefs.setBoolPref(FEATURE, false);
  Services.prefs.setIntPref(TONE, 3);
  await setSpaceIcon("");
  await openForSpace();
  ok(!panel().hasAttribute("whimsy-arc-icons"), "Zen's layout");
  is(glyphButtons()[0].getAttribute("icon"), "airplane.svg", "Zen's own order");
  ok(!gZenEmojiPicker.svgList.querySelector(".whimsy-glyph-rule"), "No rule");
  ok(!glyph("whimsy-train.svg"), "No extra glyphs");
  ok(document.getElementById("whimsy-emoji-skin-tone").hidden, "No skin tone button");
  is(emojiButton("👍\uFE0F").getAttribute("label"), "👍\uFE0F", "No tones");

  glyph("heart.svg").doCommand();
  await TestUtils.waitForCondition(() => space().icon == gZenEmojiPicker.getSVGURL("heart.svg"));
  is(panel().state, "open", "Zen keeps the picker open after a pick");
  const hidden = BrowserTestUtils.waitForEvent(panel(), "popuphidden");
  panel().hidePopup();
  await hidden;
  Services.prefs.clearUserPref(FEATURE);
  Services.prefs.clearUserPref(TONE);
});
