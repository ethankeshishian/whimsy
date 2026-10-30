/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// Playback speed: Cmd+Opt+. / Cmd+Opt+, / Cmd+Opt+0 change the speed of
// the page's video in 0.25× steps (with a toast), the command bar offers
// the same, and the PiP player's speed control is on.

const PAGE = getRootDirectory(gTestPath).replace("chrome://mochitests/content", "https://example.com") + "whimsy_video.html";

const rate = browser => SpecialPowers.spawn(browser, [], () => content.document.getElementById("video").playbackRate);

add_setup(async function () {
  await SpecialPowers.pushPrefEnv({
    set: [
      ["media.autoplay.default", 0],
      ["media.autoplay.blocking_policy", 0],
    ],
  });
});

add_task(async function test_pref_and_keys() {
  ok(Services.prefs.getBoolPref("media.videocontrols.picture-in-picture.playback-speed.enabled"), "PiP speed control on");
  for (const [id, key] of [
    ["key_whimsySpeedUp", "."],
    ["key_whimsySlowDown", ","],
    ["key_whimsySpeedReset", "0"],
  ]) {
    const el = document.getElementById(id);
    ok(el, `${id} exists`);
    is(el.getAttribute("key"), key, `${id} key`);
    const clash = [...document.querySelectorAll("key")].filter(
      k =>
        k != el &&
        k.getAttribute("disabled") != "true" &&
        (k.getAttribute("key") || "").toLowerCase() == key &&
        (k.getAttribute("modifiers") || "").replace("accel", "meta").split(/[ ,]+/).sort().join() ==
          el.getAttribute("modifiers").replace("accel", "meta").split(/[ ,]+/).sort().join()
    );
    Assert.deepEqual(clash.map(k => k.id), [], `${id} doesn't clash with another shortcut`);
  }
});

add_task(async function test_shortcuts_change_speed() {
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE);
  const browser = tab.linkedBrowser;
  await SpecialPowers.spawn(browser, [], () => content.document.getElementById("video").play());
  browser.focus();
  EventUtils.synthesizeKey(".", { accelKey: true, altKey: true });
  await TestUtils.waitForCondition(async () => (await rate(browser)) == 1.25, "Cmd+Opt+. plays at 1.25×");
  EventUtils.synthesizeKey(".", { accelKey: true, altKey: true });
  await TestUtils.waitForCondition(async () => (await rate(browser)) == 1.5, "and again at 1.5×");
  EventUtils.synthesizeKey(",", { accelKey: true, altKey: true });
  await TestUtils.waitForCondition(async () => (await rate(browser)) == 1.25, "Cmd+Opt+, slows it");
  EventUtils.synthesizeKey("0", { accelKey: true, altKey: true });
  await TestUtils.waitForCondition(async () => (await rate(browser)) == 1, "Cmd+Opt+0 resets");

  // The commands clamp at the ends.
  const { WhimsyMedia } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyMedia.sys.mjs");
  for (let i = 0; i < 20; i++) {
    await WhimsyMedia.changePlaybackRate(window, { delta: 0.25 });
  }
  is(await rate(browser), 4, "No faster than 4×");
  is(await WhimsyMedia.changePlaybackRate(window, { reset: true }), 1, "Reset returns 1");
  BrowserTestUtils.removeTab(tab);
});

add_task(async function test_empty_and_switch() {
  const { WhimsyMedia } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyMedia.sys.mjs");
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.com/");
  is(await WhimsyMedia.changePlaybackRate(window, { delta: 0.25 }), null, "A page without media: nothing to change");
  BrowserTestUtils.removeTab(tab);

  const video = await BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE);
  await SpecialPowers.pushPrefEnv({ set: [["whimsy.feature.playback-speed", false]] });
  is(await WhimsyMedia.changePlaybackRate(window, { delta: 0.25 }), null, "The switch turns it off");
  is(await rate(video.linkedBrowser), 1, "speed unchanged");
  await SpecialPowers.popPrefEnv();
  BrowserTestUtils.removeTab(video);
});

add_task(async function test_command_bar() {
  const { globalActions } = ChromeUtils.importESModule("resource:///modules/ZenUBGlobalActions.sys.mjs");
  const action = globalActions.find(a => a.l10nId == "whimsy-action-speed-up");
  ok(action, "The command bar has Speed Up Video");
  is(action.label, "Speed Up Video", "labelled");
  is(action.command, "cmd_whimsySpeedUp", "runs the same command");
});

// Pressing the shortcut again while the toast is still up reuses Zen's toast;
// it must say the new speed, not the first one (hotfix
// "toast-reuse-updates-args" in whimsy/overlay.py).
add_task(async function test_toast_shows_current_speed() {
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE);
  await SpecialPowers.spawn(tab.linkedBrowser, [], () => content.document.getElementById("video").play());
  const { WhimsyMedia } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyMedia.sys.mjs");
  const toastLabels = () =>
    [...document.querySelectorAll("label")].filter(l => document.l10n.getAttributes(l).id == "whimsy-speed-toast");

  await WhimsyMedia.changePlaybackRate(window, { delta: 0.25 });
  await TestUtils.waitForCondition(() => toastLabels().length == 1, "The speed toast shows");
  await WhimsyMedia.changePlaybackRate(window, { delta: 0.25 });
  await WhimsyMedia.changePlaybackRate(window, { delta: 0.25 });
  const labels = toastLabels();
  is(labels.length, 1, "One toast, reused");
  is(document.l10n.getAttributes(labels[0]).args.rate, 1.75, "It says the current speed");
  await TestUtils.waitForCondition(() => labels[0].textContent.includes("1.75"), "...in its text too");

  await WhimsyMedia.changePlaybackRate(window, { reset: true });
  BrowserTestUtils.removeTab(tab);
});
