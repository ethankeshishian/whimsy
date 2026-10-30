/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// Hex colors in the theme picker: a field next to Zen's color well takes a
// typed or pasted hex (#RGB, #RRGGBB, #RRGGBBAA, # optional), drives the
// well as you type, flags what isn't a color, and Enter adds it as a custom
// color. The well's pick shows in the field. The switch hides the field.

const FEATURE = "whimsy.feature.hex-colors";

registerCleanupFunction(() => Services.prefs.clearUserPref(FEATURE));

function type(field, text) {
  field.value = text;
  field.dispatchEvent(new Event("input", { bubbles: true }));
}

add_task(async function test_parse() {
  const { parseHex } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyLook.sys.mjs");
  Assert.deepEqual(parseHex("#5B8CFF"), { rgb: "#5b8cff", alpha: 1 }, "#RRGGBB");
  Assert.deepEqual(parseHex("5b8cff"), { rgb: "#5b8cff", alpha: 1 }, "without #");
  Assert.deepEqual(parseHex(" #abc "), { rgb: "#aabbcc", alpha: 1 }, "#RGB, trimmed");
  Assert.deepEqual(parseHex("#5b8cff80"), { rgb: "#5b8cff", alpha: 0.5 }, "#RRGGBBAA");
  is(parseHex("#5b8cf"), null, "five digits isn't a color");
  is(parseHex("blue"), null, "names aren't hex");
  is(parseHex(""), null, "empty");
});

add_task(async function test_field() {
  ok(Services.prefs.getBoolPref("zen.theme.gradient.show-custom-colors"), "Zen's custom color row shows");
  const field = document.getElementById("whimsy-hex-input");
  const well = document.getElementById("PanelUI-zen-gradient-generator-custom-input");
  ok(field, "The theme picker has a hex field");
  is(field.previousElementSibling, well, "right after the color well");
  await TestUtils.waitForCondition(() => field.getAttribute("placeholder"), "It has a placeholder");

  type(field, "#ff6600");
  is(well.value, "#ff6600", "The well follows the field");
  ok(!field.hasAttribute("invalid"), "A valid color isn't flagged");
  type(field, "#ff66");
  ok(!field.hasAttribute("invalid"), "#RGBA is valid too");
  type(field, "#zz");
  ok(field.hasAttribute("invalid"), "Not a color: flagged");
  is(field.getAttribute("aria-invalid"), "true", "and says so to assistive tech");

  // One field: the opacity spinner hides (the hex carries alpha) and the
  // add button has a name.
  const opacity = document.getElementById("PanelUI-zen-gradient-generator-custom-opacity");
  is(getComputedStyle(opacity).display, "none", "Zen's 0-1 opacity spinner is hidden");
  type(field, "#11223380");
  is(Number(opacity.value), 0.5, "#RRGGBBAA sets the opacity");
  const add = document.getElementById("PanelUI-zen-gradient-generator-color-custom-add");
  await TestUtils.waitForCondition(() => add.getAttribute("aria-label"), "The add button has a name");

  well.value = "#123456";
  well.dispatchEvent(new Event("input", { bubbles: true }));
  is(field.value, "#123456", "The well's pick shows in the field");

  // Enter adds the color to Zen's custom colors.
  const list = document.getElementById("PanelUI-zen-gradient-generator-custom-list");
  const before = list.querySelectorAll(".zen-theme-picker-dot.custom").length;
  type(field, "5B8CFF");
  field.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
  const dots = list.querySelectorAll(".zen-theme-picker-dot.custom");
  is(dots.length, before + 1, "Enter added a custom color");
  is(dots[0].style.getPropertyValue("--zen-theme-picker-dot-color"), "#5b8cff", "the typed one");
  is(field.value, "", "and the field clears");
  dots[0].remove();
  gZenThemePicker.updateCurrentWorkspace();

  type(field, "nope");
  field.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
  is(list.querySelectorAll(".zen-theme-picker-dot.custom").length, before, "Enter on a non-color adds nothing");
  type(field, "");
});

add_task(async function test_switch_off() {
  Services.prefs.setBoolPref(FEATURE, false);
  ok(document.getElementById("whimsy-hex-input").hidden, "The switch hides the field");
  Services.prefs.clearUserPref(FEATURE);
  ok(!document.getElementById("whimsy-hex-input").hidden, "and it comes back");
});
