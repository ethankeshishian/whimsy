/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// wave5/captions: CC in the speed control shows the video's captions
// translated into your language. Here a local Spanish WebVTT track and a
// fake translator stand in for Firefox Translations: the cues show
// translated, follow the video's time, can be dragged, and CC off puts the
// track back. A video without captions says so; the switch hides CC.

const PAGE = getRootDirectory(gTestPath).replace("chrome://mochitests/content", "https://example.com") + "whimsy_video_captions.html";

const { WhimsyCaptions } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyCaptions.sys.mjs");

const calls = [];

const control = browser =>
  SpecialPowers.spawn(browser, [], () => {
    const actor = content.windowGlobalChild.getExistingActor("WhimsyVideoSpeed");
    return actor ? JSON.parse(JSON.stringify(actor.testState())) : null;
  });
const trackMode = browser => SpecialPowers.spawn(browser, [], () => content.document.getElementById("video").textTracks[0].mode);
const seek = (browser, time) =>
  SpecialPowers.spawn(browser, [time], async t => {
    const video = content.document.getElementById("video");
    const seeked = new Promise(resolve => video.addEventListener("seeked", resolve, { once: true }));
    video.currentTime = t;
    await seeked;
  });

async function openPage() {
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE);
  const browser = tab.linkedBrowser;
  await SpecialPowers.spawn(browser, [], async () => {
    const actor = () => content.windowGlobalChild.getExistingActor("WhimsyVideoSpeed");
    for (const id of ["video", "plain"]) {
      const video = content.document.getElementById(id);
      await ContentTaskUtils.waitForCondition(() => video.readyState >= 1, `${id} has its metadata`);
      await ContentTaskUtils.waitForCondition(() => actor()?.videos.has(video), `The speed control knows ${id}`);
    }
  });
  browser.focus();
  return { tab, browser };
}

// Points at a video and clicks CC.
async function clickCC(browser, selector = "#video") {
  await BrowserTestUtils.synthesizeMouseAtCenter(selector, { type: "mousemove" }, browser);
  await TestUtils.waitForCondition(async () => (await control(browser))?.shown, "The control shows");
  const { cc } = await control(browser);
  ok(cc.shown, "CC is in the control");
  await BrowserTestUtils.synthesizeMouseAtPoint(cc.x, cc.y, {}, browser);
}

async function waitCaption(browser, text, message) {
  await TestUtils.waitForCondition(async () => {
    const captions = (await control(browser))?.captions;
    return captions?.shown && captions.text == text;
  }, message);
  return (await control(browser)).captions;
}

add_setup(async function () {
  await SpecialPowers.pushPrefEnv({
    set: [
      ["whimsy.feature.video-speed", true],
      ["whimsy.feature.video-captions", true],
      ["browser.translations.enable", true],
    ],
  });
  WhimsyCaptions.testTargetLanguage = "en";
  WhimsyCaptions.testTranslate = async (text, { from, to }) => {
    calls.push({ text, from, to });
    return `[${to}] ${text}`;
  };
  registerCleanupFunction(() => {
    WhimsyCaptions.testTranslate = null;
    WhimsyCaptions.testTargetLanguage = null;
  });
});

add_task(async function test_translated_track() {
  calls.length = 0;
  const { tab, browser } = await openPage();
  is(await trackMode(browser), "disabled", "The track starts off");

  await clickCC(browser);
  // A seek makes the media element run its cue timeline at once.
  await seek(browser, 0.01);
  let captions = await waitCaption(browser, "[en] Hola & adiós", "The cue shows translated, tags and escapes gone");
  is(captions.lang, "en", "in the target language");
  ok(!captions.pending, "and no longer dimmed");
  ok((await control(browser)).cc.pressed, "CC is pressed");
  is(await trackMode(browser), "hidden", "The track loads but the browser doesn't draw it");
  Assert.deepEqual(calls[0], { text: "Hola & adiós", from: "es", to: "en" }, "Translated from the track's srclang");
  ok(["sans-serif", "serif", "monospace"].includes(captions.font), "In Reader View's typeface");

  // The caption sits centred near the bottom of the video.
  const video = await SpecialPowers.spawn(browser, [], () => {
    const r = content.document.getElementById("video").getBoundingClientRect();
    return { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
  });
  Assert.less(Math.abs(captions.center.x - (video.left + video.right) / 2), 2, "Centred on the video");
  Assert.lessOrEqual(captions.bottom, video.bottom, "inside it");
  Assert.greater(captions.bottom, video.bottom - 60, "near its bottom");

  await seek(browser, 0.2);
  captions = await waitCaption(browser, "[en] ¿Dónde está\nla biblioteca?", "The next cue follows the video's time, lines kept");
  is(calls.length, 2, "One translation per cue");

  // Drag the caption up.
  const before = captions.center;
  await BrowserTestUtils.synthesizeMouseAtPoint(before.x, before.y, { type: "mousedown" }, browser);
  await BrowserTestUtils.synthesizeMouseAtPoint(before.x + 30, before.y - 80, { type: "mousemove" }, browser);
  await BrowserTestUtils.synthesizeMouseAtPoint(before.x + 30, before.y - 80, { type: "mouseup" }, browser);
  await TestUtils.waitForCondition(
    async () => (await control(browser)).captions.center.y < before.y - 60,
    "Dragging moves the caption"
  );
  captions = (await control(browser)).captions;
  Assert.less(Math.abs(captions.center.x - (before.x + 30)), 4, "both ways");

  // Seeking back reuses the translation already made, in the dragged place.
  await seek(browser, 0.01);
  captions = await waitCaption(browser, "[en] Hola & adiós", "Back to the first cue");
  is(calls.length, 2, "from the cache");
  Assert.less(captions.bottom, video.bottom - 60, "The caption keeps its dragged place");

  // CC off puts the track back.
  await clickCC(browser);
  await TestUtils.waitForCondition(async () => !(await control(browser)).captions.shown, "CC off hides the captions");
  ok(!(await control(browser)).cc.pressed, "CC isn't pressed");
  is(await trackMode(browser), "disabled", "The track's mode is put back");

  BrowserTestUtils.removeTab(tab);
});

add_task(async function test_same_language() {
  calls.length = 0;
  WhimsyCaptions.testTargetLanguage = "es";
  const { tab, browser } = await openPage();
  await clickCC(browser);
  await seek(browser, 0.2);
  await waitCaption(browser, "¿Dónde está\nla biblioteca?", "Captions already in your language show as they are");
  is(calls.length, 0, "with nothing translated");
  BrowserTestUtils.removeTab(tab);
  WhimsyCaptions.testTargetLanguage = "en";
});

add_task(async function test_translation_fails() {
  const fake = WhimsyCaptions.testTranslate;
  WhimsyCaptions.testTranslate = async () => {
    throw new Error("No model");
  };
  const { tab, browser } = await openPage();
  await clickCC(browser);
  await seek(browser, 0.2);
  const captions = await waitCaption(browser, "¿Dónde está\nla biblioteca?", "The original shows when translating fails");
  ok(!captions.pending, "not dimmed");
  ok(captions.note.length, "with a note saying so");
  BrowserTestUtils.removeTab(tab);
  WhimsyCaptions.testTranslate = fake;
});

add_task(async function test_no_captions() {
  calls.length = 0;
  // Live captions from speech have their own test
  // (browser_whimsy_video_speech_captions.js).
  await SpecialPowers.pushPrefEnv({ set: [["whimsy.feature.video-speech-captions", false]] });
  const { tab, browser } = await openPage();
  await clickCC(browser, "#plain");
  await TestUtils.waitForCondition(async () => (await control(browser))?.captions?.note, "A video without captions says so");
  const state = await control(browser);
  ok(state.captions.shown && !state.captions.text, "with only the note");
  ok(!state.cc.pressed, "and CC stays off");
  is(calls.length, 0, "Nothing translated");
  BrowserTestUtils.removeTab(tab);
  await SpecialPowers.popPrefEnv();
});

add_task(async function test_switch_off() {
  await SpecialPowers.pushPrefEnv({ set: [["whimsy.feature.video-captions", false]] });
  const { tab, browser } = await openPage();
  await BrowserTestUtils.synthesizeMouseAtCenter("#video", { type: "mousemove" }, browser);
  await TestUtils.waitForCondition(async () => (await control(browser))?.shown, "The speed control still shows");
  ok(!(await control(browser)).cc.shown, "without CC");
  is(await trackMode(browser), "disabled", "and the track is untouched");
  BrowserTestUtils.removeTab(tab);
  await SpecialPowers.popPrefEnv();
});

add_task(async function test_translator_input() {
  // The parent takes only a caption's worth of text.
  calls.length = 0;
  const result = await WhimsyCaptions.translate({ text: "x".repeat(5000), lang: "es" });
  ok(!result.error, "Translated");
  is(calls[0].text.length, 2000, "Long text is cut to a caption's length");
  is(await WhimsyCaptions.translate({ text: "  " }).then(r => r.text), "", "Blank text isn't sent to the engine");
  await SpecialPowers.pushPrefEnv({ set: [["whimsy.feature.video-captions", false]] });
  is((await WhimsyCaptions.translate({ text: "hola", lang: "es" })).error, "off", "Nothing is translated with the switch off");
  await SpecialPowers.popPrefEnv();
});
