/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// W23 video: screenshots of the plates (fu-media dec-1 with its fade-in
// frame, media-1.3 focus, 1.5, dec-3), the summary (media-1.6 opening frame,
// 1.7 with its chips, 1.9 transcript, key quotes, 1.12 live with Update), the
// speed note (media-2.3), back to default (fu-media 2.5 with its frame), and
// Settings › Media (media-2.8 with sites, 2.9 menu open).

Services.scriptloader.loadSubScript(getRootDirectory(gTestPath) + "head_video_w23.js", this);

async function shootPage(name, browser, prepare) {
  await whimsyBothSchemes(name, async dark => {
    // Forward prepare's own cleanup (dec-3's reopen) so whimsyBothSchemes
    // actually runs it between rounds; dropping it silently left the light
    // round's "hide" never undone, so the dark round's press reopened
    // instead of hiding (never reaching "hidden"). Most prepare functions
    // return something else incidentally (state objects, etc.); only a
    // real function is a cleanup.
    const cleanup = await prepare?.(dark);
    await new Promise(r => setTimeout(r, 200));
    return typeof cleanup == "function" ? cleanup : undefined;
  });
  ok(true, `Shot ${name}`);
}

add_setup(async function () {
  await SpecialPowers.pushPrefEnv({
    set: [
      ["whimsy.feature.ai-hints", false],
      ["whimsy.ai.order", "claude,openai"],
      ["whimsy.ai.off", ""],
      ["media.autoplay.default", 0],
      ["media.autoplay.blocking_policy", 0],
    ],
  });
  stubProvider();
  registerCleanupFunction(async () => {
    await closeChat();
    WhimsyAIProviders.setTestProvider(null);
  });
});

// In the page: replays the plates' fade-in (or the back-to-default button's
// arrival) and holds it `ms` in, for a mid-animation frame.
function holdContent(browser, which, ms) {
  return SpecialPowers.spawn(browser, [which, ms], async (part, at) => {
    const actor = content.windowGlobalChild.getExistingActor("WhimsyVideoSpeed");
    const video = content.document.getElementById("video");
    const frame = () => new Promise(r => content.requestAnimationFrame(() => content.requestAnimationFrame(r)));
    if (part == "plates") {
      actor.hide();
      // eslint-disable-next-line mozilla/no-arbitrary-setTimeout
      await new Promise(r => content.setTimeout(r, 400));
      actor.show(video);
      // The fade runs from [data-shown]: wait for it, so the frame held
      // below is really 60ms into the fade, not before it began.
      await ContentTaskUtils.waitForCondition(() => actor.els.bar.closest("[data-shown]") || actor.els.bar.hasAttribute("data-shown"), "The plates are shown");
      // Flush styles so the fade-in transitions exist to hold, then wait a
      // frame and for the CSS transitions to actually start (same pattern
      // as the "reset" branch's WAAPI animation below) before pausing them
      // — pausing before they start left the plates fully invisible.
      actor.els.bar.getBoundingClientRect();
      actor.els.right.getBoundingClientRect();
      await frame();
      await ContentTaskUtils.waitForCondition(
        () => actor.els.bar.getAnimations().length && actor.els.right.getAnimations().length,
        "The plates' fade-in starts"
      );
      for (const a of [...actor.els.bar.getAnimations(), ...actor.els.right.getAnimations()]) {
        a.pause();
        a.currentTime = at;
      }
    } else {
      video.playbackRate = 1;
      actor.show(video);
      await frame();
      video.playbackRate = 2;
      await ContentTaskUtils.waitForCondition(() => actor.els.reset.getAnimations().length, "The button arrives");
      for (const a of actor.els.reset.getAnimations()) {
        a.pause();
        a.currentTime = at;
      }
    }
    await frame();
    return Number(content.getComputedStyle(part == "plates" ? actor.els.bar : actor.els.reset).opacity);
  });
}

function releaseContent(browser) {
  return SpecialPowers.spawn(browser, [], () => {
    const actor = content.windowGlobalChild.getExistingActor("WhimsyVideoSpeed");
    for (const el of [actor.els.bar, actor.els.right, actor.els.reset]) {
      for (const a of el.getAnimations()) {
        a.finish();
      }
    }
  });
}

add_task(async function shots_plates() {
  const { tab, browser } = await openVideo();
  await shootPage("w23-video-dec-1", browser, () => hoverVideo(browser).then(() => shownControl(browser)));
  await shootPage("w23-video-dec-1-mid-60", browser, async () => {
    await hoverVideo(browser);
    await shownControl(browser);
    const opacity = await holdContent(browser, "plates", 60);
    ok(opacity > 0.2 && opacity < 1, `dec-1 mid: the plates are part way in at 60ms (opacity ${opacity})`);
    return () => releaseContent(browser);
  });
  // media-1.3: the keyboard ring on the number.
  await shootPage("w23-video-media-1.3", browser, async () => {
    await hoverVideo(browser);
    await shownControl(browser);
    await SpecialPowers.spawn(browser, [], () => content.windowGlobalChild.getExistingActor("WhimsyVideoSpeed").els.summ.focus({ focusVisible: true }));
  });
  BrowserTestUtils.removeTab(tab);
  const small = await openVideo("", "#small");
  await shootPage("w23-video-media-1.5", small.browser, () => hoverVideo(small.browser, "#small").then(() => shownControl(small.browser)));
  BrowserTestUtils.removeTab(small.tab);
});

add_task(async function shots_speed() {
  const { tab, browser } = await openVideo();
  await shootPage("w23-video-2.5", browser, async () => {
    await SpecialPowers.spawn(browser, [], () => (content.document.getElementById("video").playbackRate = 2));
    await hoverVideo(browser);
    await TestUtils.waitForCondition(async () => (await videoControl(browser)).reset.shown, "Back to default shows");
  });
  await shootPage("w23-video-2.5-mid-75", browser, async () => {
    await hoverVideo(browser);
    await shownControl(browser);
    await holdContent(browser, "reset", 75);
    return () => releaseContent(browser);
  });
  // media-2.3: past 16×, the one-line note.
  await shootPage("w23-video-media-2.3", browser, async () => {
    await hoverVideo(browser);
    await shownControl(browser);
    await SpecialPowers.spawn(browser, [], () => content.windowGlobalChild.getExistingActor("WhimsyVideoSpeed").setRate(20));
    // The back-to-default button finishes arriving; the note stays 2s.
    await TestUtils.waitForCondition(async () => (await videoControl(browser)).reset.shown, "Back to default shows");
    // eslint-disable-next-line mozilla/no-arbitrary-setTimeout
    await new Promise(r => setTimeout(r, 300));
  });
  await SpecialPowers.spawn(browser, [], () => (content.document.getElementById("video").playbackRate = 1));
  // The site keeps no speed for the shots after this one.
  const { WhimsyVideoSpeed } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyVideoSpeed.sys.mjs");
  await WhimsyVideoSpeed.forget(browser.browsingContext);
  BrowserTestUtils.removeTab(tab);
});

// Clicks a chip under the summary once a person could: the panel has
// finished opening (dec-3 just reopened it), and the chip is the live,
// enabled one, in view. Clicking the moment isOpen flips can land on the
// panel mid-slide or on a node the reopen is about to replace.
async function clickChip(id) {
  const panel = chatPanel();
  await Promise.all((panel.el?.getAnimations({ subtree: true }) ?? []).map(a => a.finished));
  const chip = await TestUtils.waitForCondition(() => {
    const found = panel.body.querySelector(`.whimsy-video-chip[data-chip='${id}']`);
    return found?.isConnected && !found.hasAttribute("disabled") && found.checkVisibility() ? found : null;
  }, `The ${id} chip is ready`);
  chip.scrollIntoView({ block: "nearest" });
  await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
  EventUtils.synthesizeMouseAtCenter(chip, {});
}

add_task(async function shots_summary() {
  await freshChatStore();
  stubProvider("Night trains nearly vanished from Europe by 2016, then came back as flying got pricier.\n\nChapters\n- 0:00 Why they disappeared\n- 0:01 ÖBB’s bet on Nightjet\n- 0:02 Riding Vienna to Paris");
  const { tab, browser } = await openVideo();
  // media-1.6: the chat panel half open as the summary starts.
  // The answer waits a moment, so the opening frame shows Summarizing….
  const reply = "Night trains nearly vanished from Europe by 2016, then came back as flying got pricier.\n\nChapters\n- 0:00 Why they disappeared\n- 0:01 ÖBB’s bet on Nightjet\n- 0:02 Riding Vienna to Paris";
  WhimsyAIProviders.setTestProvider(async function* () {
    // eslint-disable-next-line mozilla/no-arbitrary-setTimeout
    await new Promise(r => setTimeout(r, 1500));
    yield { type: "text", delta: reply };
  });
  await whimsySetScheme(false);
  await pressSummarize(browser);
  await whimsyShotMid("w23-video-media-1.6", () => chatPanel().el?.getAnimations()[0], 120);
  await SpecialPowers.popPrefEnv();
  await summaryAnswered();
  const body = chatPanel().body;
  await TestUtils.waitForCondition(() => body.querySelector(".whimsy-video-chip[data-chip='quotes']"), "The chips are in");
  await shootPage("w23-video-media-1.7", browser, () => hoverVideo(browser));
  // fu-media dec-3: pressed again, the summary hides and Summarize says it'll show it.
  const press = () => SpecialPowers.spawn(browser, [], () => content.windowGlobalChild.getExistingActor("WhimsyVideoSpeed").pressSummarize());
  await shootPage("w23-video-dec-3", browser, async () => {
    await hoverVideo(browser);
    await shownControl(browser);
    await press();
    await TestUtils.waitForCondition(async () => (await videoControl(browser)).summ.state == "hidden", "Summarize would show it again");
    return async () => {
      await press();
      await TestUtils.waitForCondition(() => chatPanel().isOpen, "The summary is back");
    };
  });
  await clickChip("transcript");
  await TestUtils.waitForCondition(() => chatPanel().body.querySelector(".whimsy-video-transcript > li"), "The transcript is in");
  await shootPage("w23-video-media-1.9", browser, () => hoverVideo(browser));
  stubProvider("- 0:00 “Night trains nearly vanished from Europe.”\n- 0:01 “Then Austria bought the sleepers.”");
  await clickChip("quotes");
  await TestUtils.waitForCondition(() => chatPanel().body.querySelectorAll(".whimsy-chat-msg[data-role='ai']:not([busy])").length == 2, "The quotes are in");
  await shootPage("w23-video-key-quotes", browser, () => hoverVideo(browser));
  await closeChat();
  BrowserTestUtils.removeTab(tab);
});

add_task(async function shots_live() {
  await freshChatStore();
  stubProvider("Spain lead 1–0 after a header from a corner. England have had more of the ball since.\n\nChapters\n- 0:00 Spain score\n- 0:01 Yellow card for Walsh");
  const { tab, browser } = await openVideo("?drawn");
  await SpecialPowers.spawn(browser, [], () => {
    content.windowGlobalChild.getExistingActor("WhimsyVideoSpeed").isLive = el => el.id == "video";
  });
  await hoverVideo(browser);
  const state = await TestUtils.waitForCondition(async () => {
    const s = await videoControl(browser);
    return s?.right.shown && s;
  }, "The live plates show");
  await clickPoint(browser, state.summ);
  await summaryAnswered();
  await TestUtils.waitForCondition(() => chatPanel().body.querySelector(".whimsy-video-chip[data-chip='update']"), "Update is in");
  await shootPage("w23-video-media-1.12", browser, () => hoverVideo(browser));
  await closeChat();
  BrowserTestUtils.removeTab(tab);
});

add_task(async function shots_settings() {
  const { WhimsyVideoSpeed } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyVideoSpeed.sys.mjs");
  const cps = Cc["@mozilla.org/content-pref/service;1"].getService(Ci.nsIContentPrefService2);
  for (const [site, rate] of [["youtube.com", 2], ["vimeo.com", 1.25], ["example.com", 1.5], ["example.org", 3]].reverse()) {
    await new Promise(resolve => cps.set(`https://${site}/`, "whimsy.video-speed", rate, Cu.createLoadContext(), { handleCompletion: resolve, handleError: resolve }));
  }
  await SpecialPowers.pushPrefEnv({ set: [["whimsy.video.default-speed", "1.5"]] });
  await BrowserTestUtils.withNewTab("about:preferences#whimsyMedia", async browser => {
    const doc = browser.contentDocument;
    await TestUtils.waitForCondition(() => doc.getElementById("whimsyMediaSitesRow") && !doc.getElementById("whimsyMediaSitesRow").hidden, "Media shows with its sites");
    await whimsyBothSchemes("w23-video-media-2.8", async () => {
      await new Promise(r => setTimeout(r, 200));
    });
    ok(true, "media-2.8 shot");
    await whimsyBothSchemes("w23-video-media-2.9", async () => {
      const button = doc.getElementById("whimsyMediaDefaultSpeedMenu");
      EventUtils.synthesizeMouseAtCenter(button, {}, browser.contentWindow);
      await TestUtils.waitForCondition(() => doc.querySelector("[role=option][data-value='1.5']") ?? window.document.querySelector("[role=option][data-value='1.5']"), "The menu opens");
      // MUST 6: the menu is a panel of its own; copy it in for the shot.
      await whimsySettled();
      // Settings opens it in its own document, not the window's.
      const undo = whimsyStandInPopups(doc);
      ok(doc.querySelector("div.whimsy-surface-tokens [role=option][data-value='1.5']"), "media-2.9: the speed menu is in the shot");
      return () => {
        undo();
        EventUtils.synthesizeKey("KEY_Escape", {}, browser.contentWindow);
      };
    });
    ok(true, "media-2.9 shot");
  });
  await WhimsyVideoSpeed.forgetAll();
  await SpecialPowers.popPrefEnv();
});
