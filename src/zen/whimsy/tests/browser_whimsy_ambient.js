/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// W29 ambient-audio: six bundled loops (rain, café, woods, fireplace,
// ocean, brown noise) played from the chrome window's own AudioContext,
// not a tab. One home (the Ambient sound sheet, ⌘K's "Ambient Sound…"),
// only one sound at a time, closing the sheet doesn't stop it, muting a
// tab doesn't touch it.

const { WhimsyAmbient } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyAmbient.sys.mjs");
const { globalActions } = ChromeUtils.importESModule("resource:///modules/ZenUBGlobalActions.sys.mjs");

const SHEET_ID = "whimsy-ambient-sheet";
const VOLUME_PREF = "whimsy.ambient.volume";
const LAST_PREF = "whimsy.ambient.last";

const action = id => globalActions.find(a => a.l10nId == id);
const sheet = () => document.getElementById(SHEET_ID);

function tile(id) {
  return sheet()?.querySelector(`.whimsy-ambient-tile[data-sound="${id}"]`);
}

async function closeSheetIfOpen() {
  const el = sheet();
  if (!el) {
    return;
  }
  const hidden = BrowserTestUtils.waitForPopupEvent(el, "hidden");
  el.hidePopup();
  await hidden;
}

registerCleanupFunction(async () => {
  WhimsyAmbient.stop(window, { immediate: true });
  await closeSheetIfOpen();
  Services.prefs.clearUserPref(VOLUME_PREF);
  Services.prefs.clearUserPref(LAST_PREF);
});

add_task(async function test_sheet_has_six_tiles_and_a_slider() {
  ok(action("whimsy-action-ambient-sound")?.isAvailable(window), "The command bar offers Ambient Sound…");
  ok(document.getElementById("whimsy-ambient-open"), "backed by a real <command>");
  WhimsyAmbient.openSheet(window);
  await TestUtils.waitForCondition(() => sheet(), "The sheet opens");
  const grid = sheet().querySelector(".whimsy-ambient-grid");
  is(grid.getAttribute("role"), "grid", "A grid, for arrow-key navigation");
  is(grid.dataset.columns, "3", "Laid out 3 wide");
  is(grid.querySelectorAll(".whimsy-ambient-tile").length, 6, "Six tiles: rain, café, woods, fireplace, ocean, brown noise");
  ok(sheet().querySelector(".whimsy-ambient-volume-slider"), "and a volume slider");
  is(sheet().querySelector(".whimsy-surface-title")?.textContent, "Ambient sound", "Titled “Ambient sound”");
  await closeSheetIfOpen();
  ok(!sheet(), "Closing removes it");
});

add_task(async function test_one_sound_at_a_time() {
  WhimsyAmbient.openSheet(window);
  await TestUtils.waitForCondition(() => sheet());

  is(WhimsyAmbient.playingSound(window), null, "Nothing playing at first");
  await WhimsyAmbient.toggle(window, "brown");
  is(WhimsyAmbient.playingSound(window), "brown", "Brown noise starts");
  ok(tile("brown").classList.contains("is-on"), "Its tile shows the playing state");
  is(Services.prefs.getStringPref(LAST_PREF, ""), "brown", "and is remembered");

  await WhimsyAmbient.toggle(window, "rain");
  is(WhimsyAmbient.playingSound(window), "rain", "Switching crossfades to the new one");
  ok(!tile("brown").classList.contains("is-on"), "Brown noise's tile is no longer marked");
  ok(tile("rain").classList.contains("is-on"), "Rain's is");

  await WhimsyAmbient.toggle(window, "rain");
  is(WhimsyAmbient.playingSound(window), null, "Clicking the playing one again stops it");
  is(Services.prefs.getStringPref(LAST_PREF, ""), "", "and clears the remembered sound");

  await closeSheetIfOpen();
});

add_task(async function test_closing_the_sheet_does_not_stop_the_sound() {
  WhimsyAmbient.openSheet(window);
  await TestUtils.waitForCondition(() => sheet());
  await WhimsyAmbient.toggle(window, "brown");
  ok(WhimsyAmbient.isPlaying(window), "Playing");

  await closeSheetIfOpen();
  ok(WhimsyAmbient.isPlaying(window), "Still playing once the sheet is gone");
  WhimsyAmbient.stop(window, { immediate: true });
});

add_task(async function test_stop_command_only_while_playing_with_live_detail() {
  ok(!action("whimsy-action-ambient-stop")?.isAvailable(window), "No Stop Ambient Sound while idle");
  is(action("whimsy-action-ambient-sound").extraPayload.prettyName,
    await document.l10n.formatValue("whimsy-ambient-detail-idle"),
    "Ambient Sound…'s detail lists the sounds");

  await WhimsyAmbient.toggle(window, "rain");
  ok(action("whimsy-action-ambient-stop")?.isAvailable(window), "Stop Ambient Sound appears once one plays");
  is(action("whimsy-action-ambient-stop").extraPayload.prettyName,
    await document.l10n.formatValue("whimsy-ambient-tile-rain"),
    "...naming the sound that's playing");
  is(action("whimsy-action-ambient-sound").extraPayload.prettyName,
    await document.l10n.formatValue("whimsy-ambient-detail-playing"),
    "and Ambient Sound…'s own detail now offers to change it");

  document.getElementById("whimsy-ambient-stop").doCommand();
  ok(!WhimsyAmbient.isPlaying(window), "The Stop command stops it");
  ok(!action("whimsy-action-ambient-stop")?.isAvailable(window), "and itself disappears again");
});

add_task(async function test_muting_the_tab_does_not_affect_it() {
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.com/");
  await WhimsyAmbient.toggle(window, "brown");
  ok(WhimsyAmbient.isPlaying(window), "Playing");

  tab.toggleMuteAudio();
  ok(tab.hasAttribute("muted"), "The tab is muted");
  ok(WhimsyAmbient.isPlaying(window), "Ambient sound plays from the chrome window, so muting a tab leaves it alone");

  tab.toggleMuteAudio();
  WhimsyAmbient.stop(window, { immediate: true });
  BrowserTestUtils.removeTab(tab);
});

// RULES-WORKER: text on a filled surface needs 4.5:1. The playing tile's
// label switches off the idle, muted colour back to full strength rather
// than the raw accent, because the accent tint alone doesn't carry it.
add_task(async function test_playing_tile_label_contrast() {
  WhimsyAmbient.openSheet(window);
  await TestUtils.waitForCondition(() => sheet());
  await WhimsyAmbient.toggle(window, "rain");
  await TestUtils.waitForCondition(() => tile("rain").classList.contains("is-on"));

  const lum = rgb => {
    const [r, g, b] = rgb.match(/[\d.]+/g).slice(0, 3).map(Number).map(c => {
      c /= 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const label = tile("rain").querySelector(".whimsy-ambient-label");
  const style = window.getComputedStyle(tile("rain"));
  const textColor = window.getComputedStyle(label).color;
  const [hi, lo] = [lum(textColor), lum(style.backgroundColor)].sort((a, b) => b - a);

  // Diagnostic only (temporary): document.styleSheets showed zero rules
  // mentioning whimsy-ambient-tile at all, which means loadSheetUsingURIString
  // sheets don't enumerate there - a dead end. Check instead whether the real
  // tile even lives in the document the sheet was loaded onto, and whether a
  // probe element with the same two classes, appended straight to that
  // document, gets the .is-on background - isolating a context problem from
  // a selector/sheet one.
  const tileEl = tile("rain");
  const sameDoc = tileEl.ownerDocument == document;
  const probeDoc = tileEl.ownerDocument;
  const probe = probeDoc.createElement("div");
  probe.className = "whimsy-ambient-tile is-on";
  probeDoc.documentElement.appendChild(probe);
  const probeBg = probeDoc.defaultView.getComputedStyle(probe).backgroundColor;
  probe.remove();

  Assert.greaterOrEqual(
    (hi + 0.05) / (lo + 0.05),
    4.5,
    `The playing tile's label passes 4.5:1 against its filled background (text=${textColor} bg=${style.backgroundColor}) sameDoc=${sameDoc} docURI=${probeDoc.documentURI} probeBg=${probeBg}`
  );

  WhimsyAmbient.stop(window, { immediate: true });
  await closeSheetIfOpen();
});

// Shots: the sheet with a playing tile (rain), light and dark.
// WHIMSY_SHOTS=<dir> writes w29-ambient-playing-{light,dark}.png.
add_task(async function shots() {
  for (const dark of [false, true]) {
    await whimsySetScheme(dark);
    WhimsyAmbient.openSheet(window);
    await TestUtils.waitForCondition(() => sheet());
    await WhimsyAmbient.toggle(window, "rain");
    await TestUtils.waitForCondition(() => tile("rain").classList.contains("is-on"));
    await whimsySettled();
    const undo = whimsyStandInPopups();
    await whimsyShot(`w29-ambient-playing-${dark ? "dark" : "light"}`);
    undo();
    WhimsyAmbient.stop(window, { immediate: true });
    await closeSheetIfOpen();
    await SpecialPowers.popPrefEnv();
  }
});
