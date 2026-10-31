/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// Hex colors in the theme picker (W8-40): the hex field and Zen's color
// well edit one live custom color. Typing a valid hex changes the space's
// theme at once (no Return, no refocus), and a pick in the well shows in
// the field and the theme. Bad text is flagged and never replaces the last
// good color; Esc undoes; Return keeps the color and starts a new one; a
// color in the list can be edited in place; copy copies the hex. The
// switch puts Zen's own row back.

const FEATURE = "whimsy.feature.hex-colors";
const { parseHex, couldBeHex, extractHex, WhimsyHexPicker } = ChromeUtils.importESModule(
  "resource:///modules/whimsy/WhimsyHexPicker.sys.mjs"
);

registerCleanupFunction(() => Services.prefs.clearUserPref(FEATURE));

const $ = id => document.getElementById(id);
const field = () => $("whimsy-hex-input");
const well = () => $("PanelUI-zen-gradient-generator-custom-input");
const list = () => $("PanelUI-zen-gradient-generator-custom-list");

// The space's custom colors, in list order.
function customs() {
  return [...list().querySelectorAll(".zen-theme-picker-custom-list-item")].map(i => i.getAttribute("data-color"));
}

function background() {
  return gZenThemePicker.browserBackgroundElement.style.getPropertyValue("--zen-main-browser-background");
}

function type(text) {
  field().focus();
  field().value = text;
  field().dispatchEvent(new Event("input", { bubbles: true }));
}

function pick(color) {
  well().value = color;
  well().dispatchEvent(new Event("input", { bubbles: true }));
}

// Removes custom colors this test added and ends any edit.
function reset(keep) {
  WhimsyHexPicker.forWindow(window)?.end();
  for (const item of list().querySelectorAll(".zen-theme-picker-custom-list-item")) {
    if (!keep.includes(item.getAttribute("data-color"))) {
      item.remove();
    }
  }
  gZenThemePicker.updateCurrentWorkspace();
}

add_setup(async function () {
  await gZenThemePicker.promiseInitialized;
});

add_task(async function test_parse() {
  Assert.deepEqual(parseHex("#5B8CFF"), { rgb: "#5b8cff", alpha: 1, hex: "#5b8cff" }, "#RRGGBB");
  Assert.deepEqual(parseHex("5b8cff"), { rgb: "#5b8cff", alpha: 1, hex: "#5b8cff" }, "without #");
  Assert.deepEqual(parseHex(" #abc "), { rgb: "#aabbcc", alpha: 1, hex: "#aabbcc" }, "#RGB, trimmed");
  Assert.deepEqual(parseHex("abc"), { rgb: "#aabbcc", alpha: 1, hex: "#aabbcc" }, "RGB without #");
  Assert.deepEqual(parseHex("#5b8cff80"), { rgb: "#5b8cff", alpha: 0.5, hex: "#5b8cff80" }, "#RRGGBBAA");
  is(parseHex("#5b8cffff").hex, "#5b8cff", "opaque alpha drops");
  is(parseHex("#5b8cf"), null, "five digits isn't a color");
  is(parseHex("blue"), null, "names aren't hex");
  is(parseHex(""), null, "empty");
  ok(couldBeHex("#5B8C"), "unfinished hex can still become one");
  ok(!couldBeHex("#zz"), "letters past f can't");
  ok(!couldBeHex("#123456789"), "nor nine digits");
  is(extractHex("color: #5B8CFF;").hex, "#5b8cff", "a hex inside pasted text");
  is(extractHex("  abc\n").hex, "#aabbcc", "a bare short hex");
  is(extractHex("no color here"), null, "nothing to find");
});

add_task(async function test_row() {
  ok(Services.prefs.getBoolPref("zen.theme.gradient.show-custom-colors"), "Zen's custom color row shows");
  ok(field(), "The theme picker has a hex field");
  is(field().previousElementSibling, well(), "right after the color well");
  is(field().nextElementSibling.id, "whimsy-hex-copy", "then copy");
  await TestUtils.waitForCondition(() => field().getAttribute("placeholder"), "The field has a placeholder");
  await TestUtils.waitForCondition(() => field().getAttribute("aria-label"), "and a name");
  await TestUtils.waitForCondition(() => well().getAttribute("aria-label"), "The well has a name");
  await TestUtils.waitForCondition(() => $("whimsy-hex-copy").getAttribute("aria-label"), "Copy has a name");
  const add = $("PanelUI-zen-gradient-generator-color-custom-add");
  await TestUtils.waitForCondition(() => add.getAttribute("aria-label"), "The + button has a name");
  is($("whimsy-hex-status").getAttribute("aria-live"), "polite", "Copies are announced");
  const opacity = $("PanelUI-zen-gradient-generator-custom-opacity");
  is(getComputedStyle(opacity).display, "none", "Zen's 0-1 opacity spinner is hidden");
});

add_task(async function test_typing_changes_theme_without_enter() {
  const before = customs();
  type("#5B8CFF");
  await TestUtils.waitForCondition(() => customs().includes("#5b8cff"), "Typing a hex adds it to the theme");
  is(customs().length, before.length + 1, "as one new custom color");
  await TestUtils.waitForCondition(() => background().includes("#5b8cff"), "and the window repaints with it");
  is(document.activeElement, field(), "focus stays in the field");

  // Further edits change the same color, live.
  type("ff6600");
  await TestUtils.waitForCondition(() => customs().includes("#ff6600"), "The next hex replaces it in place");
  ok(!customs().includes("#5b8cff"), "the old value is gone");
  is(customs().length, before.length + 1, "still one color");
  await TestUtils.waitForCondition(() => background().includes("#ff6600"), "repainted");
  ok(
    list().querySelector(".zen-theme-picker-custom-list-item[whimsy-editing]")?.getAttribute("data-color") == "#ff6600",
    "The live color is marked in the list"
  );

  // Unfinished or bad text never throws the last good color away.
  type("#ff66001122");
  ok(field().hasAttribute("invalid"), "Ten digits: flagged");
  is(field().getAttribute("aria-invalid"), "true", "and said to assistive tech");
  type("#zz");
  ok(field().hasAttribute("invalid"), "Not hex: flagged");
  type("#ff66");
  ok(!field().hasAttribute("invalid"), "#RGBA is valid");
  type("#ff660");
  ok(!field().hasAttribute("invalid"), "Unfinished hex isn't flagged while typing");
  ok(customs().includes("#ff6600"), "The theme kept the last good color");
  field().blur();
  is(field().value, "#FF6600", "Leaving the field shows the last good color again");
  ok(!field().hasAttribute("invalid"), "unflagged");

  // Short forms apply after a beat.
  type("abc");
  await TestUtils.waitForCondition(() => customs().includes("#aabbcc"), "#RGB without # applies");

  // Alpha.
  type("#11223380");
  await TestUtils.waitForCondition(() => customs().includes("#11223380"), "#RRGGBBAA keeps its alpha exactly");

  // Paste pulls the hex out of surrounding text.
  const data = new DataTransfer();
  data.setData("text/plain", "color: #123456;");
  field().dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
  is(field().value, "#123456", "Paste keeps just the hex");
  await TestUtils.waitForCondition(() => customs().includes("#123456"), "and applies it");

  // Esc removes a color that was new.
  field().focus();
  EventUtils.synthesizeKey("KEY_Escape");
  Assert.deepEqual(customs(), before, "Esc took the new color back out");
  is(field().value, "", "and emptied the field");
  reset(before);
});

add_task(async function test_well_updates_field_and_theme() {
  const before = customs();
  pick("#00ff00");
  is(field().value, "#00FF00", "The well's pick shows in the field");
  await TestUtils.waitForCondition(() => customs().includes("#00ff00"), "and in the theme, with no Return");
  pick("#0000ff");
  await TestUtils.waitForCondition(() => customs().includes("#0000ff"), "Dragging in the system panel follows live");
  is(customs().length, before.length + 1, "one color, changed in place");
  is(field().value, "#0000FF", "field follows");
  reset(before);
});

add_task(async function test_return_keeps_and_starts_another() {
  const before = customs();
  type("#123456");
  field().focus();
  EventUtils.synthesizeKey("KEY_Enter");
  ok(customs().includes("#123456"), "Return keeps the color");
  is(field().value, "", "and empties the field");
  type("#654321");
  await TestUtils.waitForCondition(() => customs().includes("#654321"), "The next hex is a new color");
  ok(customs().includes("#123456"), "the kept one stays");
  is(customs().length, before.length + 2, "two colors");

  type("#12");
  EventUtils.synthesizeKey("KEY_Enter");
  ok(field().hasAttribute("invalid"), "Return on unfinished text flags it");
  ok(customs().includes("#654321"), "and keeps the live color");

  // + is "New color": keeps the live one, doesn't add it twice.
  type("#abcdef");
  await TestUtils.waitForCondition(() => customs().includes("#abcdef"), "live");
  const count = customs().length;
  $("PanelUI-zen-gradient-generator-color-custom-add").doCommand();
  is(customs().length, count, "+ didn't add the live color a second time");
  is(field().value, "", "+ empties the field for the next color");
  reset(before);
});

add_task(async function test_edit_existing() {
  const before = customs();
  type("#336699");
  EventUtils.synthesizeKey("KEY_Enter");
  const item = () =>
    [...list().querySelectorAll(".zen-theme-picker-custom-list-item")].find(
      i => i.getAttribute("data-color") == "#336699"
    );
  ok(item(), "kept");
  const dot = item().querySelector(".zen-theme-picker-dot");
  await TestUtils.waitForCondition(() => dot.getAttribute("aria-label"), "List colors have a name");
  is(dot.getAttribute("role"), "button", "and are buttons");
  dot.click();
  is(field().value, "#336699", "Clicking a list color loads it into the field");
  type("#993366");
  await TestUtils.waitForCondition(() => customs().includes("#993366"), "Editing changes it in place");
  ok(!customs().includes("#336699"), "not a copy");
  field().focus();
  EventUtils.synthesizeKey("KEY_Escape");
  ok(customs().includes("#336699"), "Esc restores the color you were editing");
  ok(!customs().includes("#993366"), "and drops the edit");
  reset(before);
});

add_task(async function test_copy() {
  type("#5b8cff");
  await SimpleTest.promiseClipboardChange("#5B8CFF", () => $("whimsy-hex-copy").doCommand());
  ok($("whimsy-hex-copy").hasAttribute("copied"), "Copy shows a check");
  await TestUtils.waitForCondition(() => $("whimsy-hex-status").textContent.includes("#5B8CFF"), "and announces it");
  WhimsyHexPicker.forWindow(window).revert();
});

add_task(async function test_switch_off() {
  const before = customs();
  Services.prefs.setBoolPref(FEATURE, false);
  ok(field().hidden, "The switch hides the field");
  ok($("whimsy-hex-copy").hidden, "and copy");
  // Zen's + adds the well's color again.
  well().value = "#ff0000";
  $("PanelUI-zen-gradient-generator-color-custom-add").doCommand();
  ok(customs().includes("#ff0000"), "Zen's own add works with the switch off");
  Services.prefs.clearUserPref(FEATURE);
  ok(!field().hidden, "and the field comes back");
  reset(before);
});
