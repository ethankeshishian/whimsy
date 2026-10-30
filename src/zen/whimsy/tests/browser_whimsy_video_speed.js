/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// wave3/speed: pointing at a video shows its speed ("1×"); the arrow opens
// quarter steps 0.25×–4×, clicking the number lets you type a speed (Enter
// applies, clamped to 0.25–4×). The speed is remembered per site, the
// Cmd+Opt shortcuts remember theirs too, and the page's own player never
// sees a click or key meant for the control.

const PAGE = getRootDirectory(gTestPath).replace("chrome://mochitests/content", "https://example.com") + "whimsy_video_speed.html";

const { WhimsyVideoSpeed } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyVideoSpeed.sys.mjs");
const { WhimsyMedia } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyMedia.sys.mjs");

const rate = browser => SpecialPowers.spawn(browser, [], () => content.document.getElementById("video").playbackRate);
const page = browser =>
  SpecialPowers.spawn(browser, [], () => ({ keys: content.wrappedJSObject.pageKeys, clicks: content.wrappedJSObject.pageClicks }));
const control = browser =>
  SpecialPowers.spawn(browser, [], () => {
    const actor = content.windowGlobalChild.getExistingActor("WhimsyVideoSpeed");
    return actor ? JSON.parse(JSON.stringify(actor.testState())) : null;
  });

async function openPage() {
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE);
  const browser = tab.linkedBrowser;
  await SpecialPowers.spawn(browser, [], async () => {
    const video = content.document.getElementById("video");
    await ContentTaskUtils.waitForCondition(() => video.readyState >= 1, "The video has its metadata");
    await ContentTaskUtils.waitForCondition(() => {
      const actor = content.windowGlobalChild.getExistingActor("WhimsyVideoSpeed");
      return actor?.videos.has(video) && actor.siteRate !== null;
    }, "The speed control knows the video");
  });
  browser.focus();
  return { tab, browser };
}

async function hover(browser, selector = "#shield") {
  await BrowserTestUtils.synthesizeMouseAtCenter(selector, { type: "mousemove" }, browser);
}

async function waitShown(browser, shown = true) {
  await TestUtils.waitForCondition(async () => (await control(browser))?.shown == shown, shown ? "The control shows" : "The control hides");
  return control(browser);
}

async function clickAt(browser, point) {
  await BrowserTestUtils.synthesizeMouseAtPoint(point.x, point.y, {}, browser);
}

async function typeSpeed(browser, text) {
  // Point at the video again: the control fades when the pointer rests.
  await hover(browser);
  await clickAt(browser, (await waitShown(browser)).value);
  await TestUtils.waitForCondition(async () => (await control(browser)).editing, "The number turns into a field");
  // Select-all on start: typing replaces the old speed.
  for (const key of text) {
    EventUtils.synthesizeKey(key, {});
  }
  EventUtils.synthesizeKey("KEY_Enter", {});
  await TestUtils.waitForCondition(async () => !(await control(browser)).editing, "Enter applies");
}

add_setup(async function () {
  await SpecialPowers.pushPrefEnv({
    set: [
      ["whimsy.feature.video-speed", true],
      ["media.autoplay.default", 0],
      ["media.autoplay.blocking_policy", 0],
    ],
  });
  registerCleanupFunction(async () => {
    const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE);
    await WhimsyVideoSpeed.remember(tab.linkedBrowser.browsingContext, 1);
    BrowserTestUtils.removeTab(tab);
  });
});

add_task(async function test_hover_and_presets() {
  const { tab, browser } = await openPage();
  is((await control(browser))?.shown ?? false, false, "Hidden until the pointer is over the video");

  // Through the player's click-catching layer, like YouTube's.
  await hover(browser);
  let state = await waitShown(browser);
  is(state.text, "1×", "Says the current speed");
  ok(!state.menuOpen, "Presets closed");

  await clickAt(browser, state.toggle);
  await TestUtils.waitForCondition(async () => (await control(browser)).menuOpen, "The arrow opens the presets");
  state = await control(browser);
  Assert.deepEqual(
    Object.keys(state.items).map(Number),
    [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.25, 2.5, 2.75, 3, 3.25, 3.5, 3.75, 4],
    "Quarter steps from 0.25× to 4×"
  );
  is(state.checked, "1", "The current speed is checked");

  await clickAt(browser, state.items["2"]);
  await TestUtils.waitForCondition(async () => (await rate(browser)) == 2, "Picking 2× plays at 2×");
  state = await control(browser);
  ok(!state.menuOpen, "Picking closes the presets");
  is(state.text, "2×", "and the control says 2×");
  Assert.deepEqual(await page(browser), { keys: 0, clicks: 0 }, "The page never saw the clicks");
  await TestUtils.waitForCondition(async () => (await WhimsyVideoSpeed.getRate(browser.browsingContext)) == 2, "Remembered for the site");

  // Escape closes the presets without changing anything.
  await hover(browser);
  await clickAt(browser, (await waitShown(browser)).toggle);
  await TestUtils.waitForCondition(async () => (await control(browser)).menuOpen, "Open again");
  EventUtils.synthesizeKey("KEY_Escape", {});
  await TestUtils.waitForCondition(async () => !(await control(browser)).menuOpen, "Escape closes");
  is(await rate(browser), 2, "Still 2×");
  BrowserTestUtils.removeTab(tab);
});

add_task(async function test_type_a_speed() {
  const { tab, browser } = await openPage();
  await TestUtils.waitForCondition(async () => (await rate(browser)) == 2, "The site's speed applies to its next video");
  await hover(browser);
  await waitShown(browser);

  await typeSpeed(browser, "1.7");
  is(await rate(browser), 1.7, "Any speed can be typed");
  is((await control(browser)).text, "1.7×", "and shows");
  await typeSpeed(browser, "9");
  is(await rate(browser), 4, "Clamped to 4×");
  await typeSpeed(browser, "0.1");
  is(await rate(browser), 0.25, "Clamped to 0.25×");
  await typeSpeed(browser, "1,5x");
  is(await rate(browser), 1.5, "A comma and a trailing x are fine");
  await typeSpeed(browser, "fast");
  is(await rate(browser), 1.5, "Nonsense changes nothing");

  // Escape cancels the edit.
  await hover(browser);
  await clickAt(browser, (await waitShown(browser)).value);
  await TestUtils.waitForCondition(async () => (await control(browser)).editing, "Editing");
  EventUtils.synthesizeKey("3", {});
  EventUtils.synthesizeKey("KEY_Escape", {});
  await TestUtils.waitForCondition(async () => !(await control(browser)).editing, "Escape cancels");
  is(await rate(browser), 1.5, "unchanged");

  // Digits are YouTube's seek keys: the page's player must never see them.
  Assert.deepEqual(await page(browser), { keys: 0, clicks: 0 }, "The page never saw the keys or clicks");
  await TestUtils.waitForCondition(async () => (await WhimsyVideoSpeed.getRate(browser.browsingContext)) == 1.5, "The last speed is remembered");

  // After a speed is set the keyboard is the page's again (Space pauses).
  EventUtils.synthesizeKey(" ", {});
  await TestUtils.waitForCondition(async () => (await page(browser)).keys == 1, "The page gets keys again");
  BrowserTestUtils.removeTab(tab);
});

add_task(async function test_hides_and_skips_small_videos() {
  const { tab, browser } = await openPage();
  await hover(browser);
  await waitShown(browser);
  await hover(browser, "#outside");
  await waitShown(browser, false);

  await hover(browser, "#tiny");
  await new Promise(resolve => setTimeout(resolve, 400));
  is((await control(browser)).shown, false, "No control on a thumbnail-sized video");
  BrowserTestUtils.removeTab(tab);
});

add_task(async function test_shortcuts_remember() {
  const { tab, browser } = await openPage();
  await TestUtils.waitForCondition(async () => (await rate(browser)) == 1.5, "Remembered speed applied");
  await SpecialPowers.spawn(browser, [], () => content.document.getElementById("video").play());
  is(await WhimsyMedia.changePlaybackRate(window, { reset: true }), 1, "Cmd+Opt+0 resets");
  await TestUtils.waitForCondition(async () => (await WhimsyVideoSpeed.getRate(browser.browsingContext)) == 1, "and forgets the site's speed");
  await hover(browser);
  is((await waitShown(browser)).text, "1×", "The control follows the shortcut");
  await WhimsyMedia.changePlaybackRate(window, { delta: 0.25 });
  await TestUtils.waitForCondition(async () => (await WhimsyVideoSpeed.getRate(browser.browsingContext)) == 1.25, "Cmd+Opt+. remembers too");
  await TestUtils.waitForCondition(async () => (await control(browser)).text == "1.25×", "and the control says so");
  BrowserTestUtils.removeTab(tab);
});

add_task(async function test_switch_off() {
  await SpecialPowers.pushPrefEnv({ set: [["whimsy.feature.video-speed", false]] });
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE);
  const browser = tab.linkedBrowser;
  await SpecialPowers.spawn(browser, [], () =>
    ContentTaskUtils.waitForCondition(() => content.document.getElementById("video").readyState >= 1, "metadata")
  );
  await hover(browser);
  await new Promise(resolve => setTimeout(resolve, 400));
  ok(!(await control(browser))?.shown, "No control with the switch off");
  is(await rate(browser), 1, "The site's speed isn't applied");
  is(await WhimsyVideoSpeed.getRate(browser.browsingContext), 1, "nor read");
  BrowserTestUtils.removeTab(tab);
  await SpecialPowers.popPrefEnv();
});
