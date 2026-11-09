/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// wave3/speed: pointing at a video shows its speed ("1×"); the arrow opens
// quarter steps 0.25×–4×, clicking the number lets you type a speed (Enter
// applies, within 1/16×–16×). The speed is remembered per site, the
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

async function typeSpeed(browser, text, { beforeTyping } = {}) {
  // Point at the video again: the control fades when the pointer rests.
  await hover(browser);
  await clickAt(browser, (await waitShown(browser)).value);
  await TestUtils.waitForCondition(async () => (await control(browser)).editing, "The number turns into a field");
  await beforeTyping?.();
  // Select-all on start: typing replaces the old speed.
  for (const key of text) {
    EventUtils.synthesizeKey(key, {});
  }
  EventUtils.synthesizeKey("KEY_Enter", {});
  await TestUtils.waitForCondition(async () => !(await control(browser)).editing, "Enter applies");
}

// Resolves with the speed note's text the moment it unhides.
const watchNote = browser =>
  SpecialPowers.spawn(browser, [], () => {
    const actor = content.windowGlobalChild.getExistingActor("WhimsyVideoSpeed");
    const { speednote } = actor.els;
    actor.testNoteShown = new Promise(resolve => {
      const observer = new content.MutationObserver(() => {
        if (!speednote.hidden) {
          observer.disconnect();
          resolve(speednote.textContent);
        }
      });
      // The control is anonymous content: only chromeOnlyNodes sees it.
      observer.observe(speednote, { attributes: true, attributeFilter: ["hidden"], chromeOnlyNodes: true });
    });
  });
const noteShown = browser =>
  SpecialPowers.spawn(browser, [], async () => {
    const actor = content.windowGlobalChild.getExistingActor("WhimsyVideoSpeed");
    const text = await actor.testNoteShown;
    delete actor.testNoteShown;
    return text;
  });

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
    state.itemOrder,
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
  // W23 video: Gecko's range, 1/16× to 16×.
  await typeSpeed(browser, "9");
  is(await rate(browser), 9, "9× is fine now");
  is((await control(browser)).note, null, "with no note");
  await typeSpeed(browser, "0.1");
  is(await rate(browser), 0.1, "and 0.1×");
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

add_task(async function test_skips_calls_and_live_streams() {
  const { tab, browser } = await openPage();

  // Test 1: WebRTC / MediaStream call video (srcObject set)
  await SpecialPowers.spawn(browser, [], async () => {
    const video = content.document.getElementById("callVideo");
    video.srcObject = new content.MediaStream();
    const actor = content.windowGlobalChild.getExistingActor("WhimsyVideoSpeed");
    actor?.videos.add(video);
  });

  await hover(browser, "#callVideo");
  // eslint-disable-next-line mozilla/no-arbitrary-setTimeout
  await new Promise(resolve => setTimeout(resolve, 400));
  ok(!(await control(browser))?.shown, "No speed control on a call video (srcObject)");

  // Test 2: Live stream video (duration Infinity)
  await SpecialPowers.spawn(browser, [], async () => {
    const video = content.document.getElementById("callVideo");
    video.srcObject = null;
    video.src = "whimsy_video.mp4";
    Object.defineProperty(video, "duration", { value: Infinity, configurable: true });
    const actor = content.windowGlobalChild.getExistingActor("WhimsyVideoSpeed");
    actor?.videos.add(video);
  });

  await hover(browser, "#callVideo");
  // eslint-disable-next-line mozilla/no-arbitrary-setTimeout
  await new Promise(resolve => setTimeout(resolve, 400));
  ok(!(await control(browser))?.shown, "No speed control on a live stream (duration Infinity)");

  // Unit eligibility checks
  const eligible = await SpecialPowers.spawn(browser, [], () => {
    const actor = content.windowGlobalChild.getExistingActor("WhimsyVideoSpeed");
    const callVideo = content.document.getElementById("callVideo");
    const normalVideo = content.document.getElementById("video");
    return {
      callEligible: actor?.isEligible(callVideo),
      normalEligible: actor?.isEligible(normalVideo),
    };
  });
  is(eligible.callEligible, false, "Call/live video is not eligible");
  is(eligible.normalEligible, true, "Standard video is eligible");

  BrowserTestUtils.removeTab(tab);
});

// W23 video: Gecko's range, your default, and back to it.

add_task(async function typed_speed_up_to_16_note_above() {
  const { tab, browser } = await openPage();
  await typeSpeed(browser, "16");
  is(await rate(browser), 16, "16× is fine");
  is((await control(browser)).note, null, "with no note");
  // The note shows for 2s; on a loaded machine typeSpeed's own polling can
  // outlast it, so watch for it from before the keys go in.
  await typeSpeed(browser, "25", { beforeTyping: () => watchNote(browser) });
  is(await rate(browser), 16, "25 is set to 16×");
  ok((await noteShown(browser)).includes("as fast as videos go"), "One line says why");
  await typeSpeed(browser, "1");
  BrowserTestUtils.removeTab(tab);
});

add_task(async function below_sixteenth_becomes_006() {
  const { tab, browser } = await openPage();
  await typeSpeed(browser, "0.01");
  is(await rate(browser), 0.0625, "0.01 becomes 1/16×");
  const state = await control(browser);
  is(state.text, "0.06×", "shown as 0.06×");
  is(state.note, null, "with no note");
  await typeSpeed(browser, "1");
  BrowserTestUtils.removeTab(tab);
});

async function forgetSite() {
  const t = await BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE);
  await WhimsyVideoSpeed.forget(t.linkedBrowser.browsingContext);
  BrowserTestUtils.removeTab(t);
}

add_task(async function back_to_default_only_when_off_default_and_forgets_site() {
  await forgetSite();
  await SpecialPowers.pushPrefEnv({ set: [["whimsy.video.default-speed", "1.5"]] });
  const { tab, browser } = await openPage();
  await TestUtils.waitForCondition(async () => (await rate(browser)) == 1.5, "A site with no speed plays at your default");
  await hover(browser);
  let state = await waitShown(browser);
  ok(!state.reset.shown, "At your default: no back-to-default button");
  await typeSpeed(browser, "3");
  await TestUtils.waitForCondition(async () => (await WhimsyVideoSpeed.getRate(browser.browsingContext)) == 3, "3× is saved for the site");
  await hover(browser);
  state = await waitShown(browser);
  ok(state.reset.shown, "Off your default: the button shows");
  is(state.reset.title, "Back to 1.5×", "It says where it goes");
  ok(state.reset.x < state.value.x, "left of the number");
  // The button grows in over 150ms, on its own timer apart from the bar's
  // (animateReset); click where it lands, not where it started.
  await TestUtils.waitForCondition(async () => !(await control(browser)).reset.animating, "The reset button settles");
  state = await control(browser);
  await clickAt(browser, state.reset);
  await TestUtils.waitForCondition(async () => (await rate(browser)) == 1.5, "A click plays at your default");
  await TestUtils.waitForCondition(async () => !(await control(browser)).reset.shown, "and the button goes");
  await TestUtils.waitForCondition(async () => (await WhimsyVideoSpeed.getRate(browser.browsingContext)) == 1.5, "The site's speed is forgotten");
  Assert.deepEqual(await page(browser), { keys: 0, clicks: 0 }, "The page never saw the click");
  BrowserTestUtils.removeTab(tab);
  await SpecialPowers.popPrefEnv();
});

add_task(async function reset_command_goes_to_default() {
  await SpecialPowers.pushPrefEnv({ set: [["whimsy.video.default-speed", "1.25"]] });
  const { tab, browser } = await openPage();
  await SpecialPowers.spawn(browser, [], () => {
    const video = content.document.getElementById("video");
    video.play();
    video.playbackRate = 2;
  });
  is(await WhimsyMedia.changePlaybackRate(window, { reset: true }), 1.25, "Reset Video Speed goes to your default");
  is(await rate(browser), 1.25, "and the video plays at it");
  BrowserTestUtils.removeTab(tab);
  await SpecialPowers.popPrefEnv();
});
