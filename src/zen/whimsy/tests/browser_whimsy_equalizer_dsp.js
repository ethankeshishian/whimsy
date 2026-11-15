/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// W29 tab equalizer, the DSP: Gecko's per-element filter
// (src/zen/whimsy/equalizer) changes the level of the band it boosts or
// cuts, leaves other frequencies alone, and when flat leaves every sample
// bit-identical. Both output paths are covered: the captured one (Web
// Audio reads the element's filtered output) and the AudioSink one (the
// tab's speaker goes quiet when the tone is cut below audibility). A
// cross-origin audio element with the equalizer on stays audible.

const DIR = getRootDirectory(gTestPath).replace("chrome://mochitests/content", "https://example.com");
const PAGE = DIR + "whimsy_eq.html";
const FLAT = [0, 0, 0, 0, 0, 0, 0, 0];

add_setup(async function () {
  await SpecialPowers.pushPrefEnv({
    set: [
      ["media.autoplay.default", 0],
      ["media.autoplay.blocking_policy", 0],
      ["whimsy.media.background-mute", "off"],
      // Quiet for 0.2 s counts as silent, and the speaker goes at once.
      ["dom.media.silence_duration_for_audibility", 0.2],
      ["browser.tabs.delayHidingAudioPlayingIconMS", 0],
    ],
  });
});

const setGains = (browser, gains) =>
  SpecialPowers.spawn(browser, [gains], g => content.document.getElementById("audio").whimsySetEqualizer(g));
const measure = browser => SpecialPowers.spawn(browser, [], () => content.wrappedJSObject.measure());

// The RMS once it has settled on a value that passes `test` (the 50 ms
// ramp and the analyser's window take a moment).
async function settled(browser, test, message) {
  let last = null;
  try {
    await TestUtils.waitForCondition(async () => {
      last = await measure(browser);
      return last.rms > 0 && test(last);
    }, message);
  } catch (e) {
    ok(false, `${message}: last measured ${JSON.stringify(last)}`);
    throw e;
  }
  return last;
}

add_task(async function test_band_gain_and_bit_identical_flat() {
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, `${PAGE}?src=whimsy_eq_tone.sjs%3Ffreq%3D1000%26amp%3D3277`);
  const browser = tab.linkedBrowser;
  const applies = await SpecialPowers.spawn(browser, [], () => content.document.getElementById("audio").whimsyEqualizerApplies);
  ok(applies, "A file the page plays can be equalized");
  await SpecialPowers.spawn(browser, [], () => content.wrappedJSObject.startAnalysis());
  info(`Graph: ${JSON.stringify(await SpecialPowers.spawn(browser, [], () => content.wrappedJSObject.graphInfo()))}`);

  // Flat: every sample is, bit for bit, the decoded 16-bit value in the file.
  // The tone's own level; the analyser's window must be full of it (not
  // the silence before playback starts) before anything is compared.
  const base = 3277 / 32768 / Math.SQRT2;
  const full = m => Math.abs(m.rms - base) < 0.002;
  const flat = await settled(browser, m => full(m) && m.exact == m.total, "Flat output is bit-identical");
  is(flat.exact, flat.total, "Every sample is untouched when flat");
  ok(full(flat), `The tone plays at its own level (${flat.rms})`);

  // +12 dB at 1 kHz: about 4x the level.
  await setGains(browser, [0, 0, 0, 12, 0, 0, 0, 0]);
  const boosted = await settled(browser, m => m.rms / base > 3.5, "+12 dB at 1 kHz boosts the tone");
  ok(boosted.rms / base < 4.5, `+12 dB at 1 kHz is about 4x (${(boosted.rms / base).toFixed(2)})`);
  ok(boosted.exact < boosted.total, "The equalizer changed the samples");

  // -12 dB at 1 kHz: about a quarter.
  await setGains(browser, [0, 0, 0, -12, 0, 0, 0, 0]);
  const cut = await settled(browser, m => m.rms / base < 0.3, "-12 dB at 1 kHz cuts the tone");
  ok(cut.rms / base > 0.2, `-12 dB at 1 kHz is about a quarter (${(cut.rms / base).toFixed(2)})`);

  // A band far from the tone leaves it alone.
  await setGains(browser, [0, 0, 0, 0, 0, 0, 0, 12]);
  const other = await settled(browser, m => Math.abs(m.rms / base - 1) < 0.05, "+12 dB at 15 kHz leaves 1 kHz alone");
  ok(Math.abs(other.rms / base - 1) < 0.05, `1 kHz is unchanged by the 15 kHz band (${(other.rms / base).toFixed(3)})`);

  // Back to flat: bit-identical again once the ramp ends.
  await setGains(browser, FLAT);
  const again = await settled(browser, m => full(m) && m.exact == m.total, "Flat again is bit-identical");
  is(again.exact, again.total, "Every sample is untouched after going back to flat");
  BrowserTestUtils.removeTab(tab);
});

add_task(async function test_audio_sink_path() {
  // A tone just above the audibility floor (-72 dBFS): cutting every band
  // takes it below, so the tab's speaker goes; flat brings it back.
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, `${PAGE}?src=whimsy_eq_tone.sjs%3Ffreq%3D1000%26amp%3D16`);
  const browser = tab.linkedBrowser;
  await SpecialPowers.spawn(browser, [], () => content.document.getElementById("audio").play());
  await TestUtils.waitForCondition(() => tab.soundPlaying, "The quiet tone is audible");
  await setGains(browser, new Array(8).fill(-12));
  await TestUtils.waitForCondition(() => !tab.soundPlaying, "Every band at -12 dB makes it inaudible");
  await setGains(browser, FLAT);
  await TestUtils.waitForCondition(() => tab.soundPlaying, "Flat makes it audible again");
  BrowserTestUtils.removeTab(tab);
});

add_task(async function test_cross_origin_stays_audible() {
  // example.com plays a tone from example.org with no CORS headers.
  const remote = DIR.replace("https://example.com", "https://example.org") + "whimsy_eq_tone.sjs?freq=1000&amp=8000";
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, `${PAGE}?src=${encodeURIComponent(remote)}`);
  const browser = tab.linkedBrowser;
  await setGains(browser, [-6, -3, 0, 3, 5, 4, 1, -2]);
  await SpecialPowers.spawn(browser, [], () => content.document.getElementById("audio").play());
  await TestUtils.waitForCondition(() => tab.soundPlaying, "Cross-origin audio with the equalizer on is audible");
  ok(
    await SpecialPowers.spawn(browser, [], () => content.document.getElementById("audio").whimsyEqualizerApplies),
    "Cross-origin audio is equalized"
  );
  await setGains(browser, FLAT);
  BrowserTestUtils.removeTab(tab);
});
