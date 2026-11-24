/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// W30 (owner: "When scrolling they move with the page instead of staying
// where they belong on the vid"): every piece of the video overlay (the
// speed bar, the top-right plates, the seek plate, and the caption box)
// stays anchored to its video through every scroll frame (page, a scrollable
// box, an iframe, instant and smooth), layout shifts, player size changes,
// and zoom, and the overlay hides once its video leaves the viewport.

Services.scriptloader.loadSubScript(getRootDirectory(gTestPath) + "head_video_w23.js", this);

const SCROLL_PAGE = getRootDirectory(gTestPath).replace("chrome://mochitests/content", "https://example.com") + "whimsy_video_scroll.html";

add_setup(async function () {
  await SpecialPowers.pushPrefEnv({
    set: [
      ["whimsy.feature.video-speed", true],
      ["whimsy.feature.ai-hints", false],
      ["general.smoothScroll", true],
      ["media.autoplay.default", 0],
      ["media.autoplay.blocking_policy", 0],
    ],
  });
});

async function openScrollPage(query, selector, framed = false) {
  const tab = ownVideoTab(await BrowserTestUtils.openNewForegroundTab(gBrowser, SCROLL_PAGE + query));
  const browser = tab.linkedBrowser;
  const context = framed ? await TestUtils.waitForCondition(() => browser.browsingContext.children[0], "The iframe is there") : browser.browsingContext;
  await SpecialPowers.spawn(context, [selector], async sel => {
    await ContentTaskUtils.waitForCondition(() => content.document.querySelector(sel), "The video is there");
    const video = content.document.querySelector(sel);
    await ContentTaskUtils.waitForCondition(() => {
      if (video.error) {
        throw new Error(`Video load failed: ${video.error.code}`);
      }
      const actor = content.windowGlobalChild.getExistingActor("WhimsyVideoSpeed");
      return video.readyState >= 1 && actor?.videos.has(video) && actor.siteRate !== null;
    }, "The control knows the video");
    // The test video is a fraction of a second long, too short for the seek
    // plate; a longer duration (as browser_whimsy_video_speed.js does) shows it.
    Object.defineProperty(video, "duration", { value: 120, configurable: true });
  });
  browser.focus();
  return { tab, browser, context };
}

// Hovers the video and waits until every plate has finished fading in.
async function showOverlay(browser, selector, context) {
  await BrowserTestUtils.synthesizeMouseAtCenter(selector, { type: "mousemove" }, context);
  await shownControl(browser, true, context);
  await TestUtils.waitForCondition(async () => {
    const { opacity, seek } = await videoControl(browser, context);
    return opacity.bar == 1 && opacity.right == 1 && seek.shown && opacity.seekplate == 1;
  }, "Every plate has faded in");
}

// Runs in the page: scrolls by each step and measures every overlay piece
// against the video in each frame. Returns the frames where a piece drifted
// more than 1px from where it sat before the scrolling, and how many frames
// were measured.
async function scrollAndMeasure(context, selector, steps, { captions = false } = {}) {
  return SpecialPowers.spawn(context, [selector, steps, captions], async (sel, list, withCaptions) => {
    const doc = content.document;
    const actor = content.windowGlobalChild.getExistingActor("WhimsyVideoSpeed");
    const video = doc.querySelector(sel);
    const frame = () => new Promise(resolve => content.requestAnimationFrame(() => resolve()));
    if (withCaptions) {
      actor.captions.notice("Anchored", video);
      await ContentTaskUtils.waitForCondition(() => actor.els.captions.hasAttribute("data-shown"), "The caption box shows");
    }
    const anchors = () => {
      const v = video.getBoundingClientRect();
      const rect = el => el.getBoundingClientRect();
      const { bar, right, seekplate } = actor.els;
      const out = {
        bar: [rect(bar).left - v.left, rect(bar).top - v.top],
        right: [rect(right).right - v.right, rect(right).top - v.top],
        seekplate: [rect(seekplate).left + rect(seekplate).width / 2 - (v.left + v.width / 2), rect(seekplate).bottom - v.bottom],
      };
      if (withCaptions) {
        const c = rect(actor.els.captions);
        out.captions = [c.left + c.width / 2 - (v.left + v.width / 2), c.bottom - v.bottom];
      }
      return out;
    };
    const base = anchors();
    const drifts = [];
    let frames = 0;
    const check = label => {
      frames++;
      const now = anchors();
      for (const piece of Object.keys(base)) {
        const drift = Math.max(Math.abs(now[piece][0] - base[piece][0]), Math.abs(now[piece][1] - base[piece][1]));
        if (drift > 1) {
          drifts.push({ label, piece, drift: Math.round(drift * 10) / 10 });
        }
      }
    };
    const scroller = sel == "#inner" ? doc.getElementById("scroller") : content;
    const position = () => (scroller == content ? content.scrollY : scroller.scrollTop);
    for (const step of list) {
      const target = position() + step.by;
      if (step.smooth) {
        scroller.scrollBy({ top: step.by, behavior: "smooth" });
        // Every frame of the smooth scroll, until it arrives.
        while (Math.abs(position() - target) > 0.5) {
          await frame();
          check(`smooth ${step.by}px at ${Math.round(position())}`);
        }
      } else {
        scroller.scrollBy({ top: step.by, behavior: "instant" });
        if (scroller == content) {
          // The root scroller moves the overlay with the page itself: right
          // after the scroll, before any scroll event or frame.
          check(`instant ${step.by}px, before the scroll event`);
        }
        await new Promise(resolve => scroller.addEventListener("scroll", resolve, { once: true }));
        await frame();
        check(`instant ${step.by}px, next frame`);
      }
    }
    return { drifts, frames, shown: actor.els.bar.hasAttribute("data-shown") };
  });
}

function assertAnchored(result, what) {
  Assert.greater(result.frames, 0, `${what}: frames were measured`);
  Assert.deepEqual(result.drifts, [], `${what}: every piece stays on the video in every frame`);
}

const STEPS = [{ by: 40 }, { by: 30 }, { by: -50 }, { by: 60, smooth: true }, { by: -60, smooth: true }];

add_task(async function page_scroll_keeps_every_piece_on_the_video() {
  const { tab, browser, context } = await openScrollPage("", "#video");
  await showOverlay(browser, "#video", context);
  assertAnchored(await scrollAndMeasure(context, "#video", STEPS, { captions: true }), "Page scroll");
  await closeVideoTab(tab);
});

add_task(async function scrollable_box_keeps_every_piece_on_the_video() {
  const { tab, browser, context } = await openScrollPage("?nested", "#inner");
  await showOverlay(browser, "#inner", context);
  assertAnchored(await scrollAndMeasure(context, "#inner", STEPS, { captions: true }), "Scrollable box");
  await closeVideoTab(tab);
});

add_task(async function iframe_scroll_keeps_every_piece_on_the_video() {
  const { tab, browser, context } = await openScrollPage("?frame", "#video", true);
  await showOverlay(browser, "#video", context);
  assertAnchored(await scrollAndMeasure(context, "#video", STEPS), "Scrolling inside an iframe");
  await closeVideoTab(tab);
});

add_task(async function layout_shift_and_player_size_follow() {
  const { tab, browser, context } = await openScrollPage("", "#video");
  await showOverlay(browser, "#video", context);
  const result = await SpecialPowers.spawn(context, [], async () => {
    const doc = content.document;
    const actor = content.windowGlobalChild.getExistingActor("WhimsyVideoSpeed");
    const video = doc.getElementById("video");
    const frame = () => new Promise(resolve => content.requestAnimationFrame(() => resolve()));
    const offsets = () => {
      const v = video.getBoundingClientRect();
      const { bar, right, seekplate } = actor.els;
      const s = seekplate.getBoundingClientRect();
      return [
        bar.getBoundingClientRect().left - v.left,
        bar.getBoundingClientRect().top - v.top,
        right.getBoundingClientRect().right - v.right,
        s.left + s.width / 2 - (v.left + v.width / 2),
        s.bottom - v.bottom,
      ].map(n => Math.round(n));
    };
    const before = offsets();
    // Something loads above the player: the page shifts without scrolling.
    const ad = doc.createElement("div");
    ad.style.height = "50px";
    doc.body.prepend(ad);
    await frame();
    await frame();
    const shifted = offsets();
    // The player grows.
    video.style.width = "400px";
    video.style.height = "225px";
    await frame();
    await frame();
    return { before, shifted, resized: offsets() };
  });
  Assert.deepEqual(result.shifted, result.before, "A layout shift above the video moves every piece with it");
  Assert.deepEqual(result.resized, result.before, "A player that changes size keeps every piece at its edges");
  await closeVideoTab(tab);
});

add_task(async function zoom_follows() {
  const { tab, browser, context } = await openScrollPage("", "#video");
  await showOverlay(browser, "#video", context);
  const measure = () =>
    SpecialPowers.spawn(context, [], () => {
      const actor = content.windowGlobalChild.getExistingActor("WhimsyVideoSpeed");
      const v = content.document.getElementById("video").getBoundingClientRect();
      const s = actor.els.seekplate.getBoundingClientRect();
      return [actor.els.bar.getBoundingClientRect().left - v.left, actor.els.right.getBoundingClientRect().right - v.right, s.bottom - v.bottom].map(n => Math.round(n));
    });
  const before = await measure();
  const ratio = await SpecialPowers.spawn(context, [], () => content.devicePixelRatio);
  ZoomManager.setZoomForBrowser(browser, 1.5);
  await SpecialPowers.spawn(context, [ratio], async before => {
    await ContentTaskUtils.waitForCondition(() => content.devicePixelRatio != before, "The page zoomed");
    await new Promise(resolve => content.requestAnimationFrame(() => content.requestAnimationFrame(resolve)));
  });
  Assert.deepEqual(await measure(), before, "Zooming keeps every piece on the video");
  FullZoom.reset(browser);
  await closeVideoTab(tab);
});

add_task(async function hides_when_the_video_leaves_the_viewport() {
  const { tab, browser, context } = await openScrollPage("", "#video");
  await showOverlay(browser, "#video", context);
  const shown = await SpecialPowers.spawn(context, [], async () => {
    const actor = content.windowGlobalChild.getExistingActor("WhimsyVideoSpeed");
    const scrolled = new Promise(resolve => content.addEventListener("scroll", resolve, { once: true }));
    content.scrollTo({ top: 1500, behavior: "instant" });
    await scrolled;
    await new Promise(resolve => content.requestAnimationFrame(() => resolve()));
    const { bar, right, seekplate } = actor.els;
    return [bar, right, seekplate].some(el => el.hasAttribute("data-shown"));
  });
  ok(!shown, "Scrolled out of view, the overlay hides at once");
  is((await videoControl(browser, context)).tracking, false, "and stops following the page");
  await closeVideoTab(tab);
});

add_task(async function no_listeners_until_shown() {
  const { tab, browser, context } = await openScrollPage("", "#video");
  is((await videoControl(browser, context))?.tracking ?? false, false, "A page with a video but no hover follows nothing");
  await showOverlay(browser, "#video", context);
  is((await videoControl(browser, context)).tracking, true, "Shown, it follows the page");
  await BrowserTestUtils.synthesizeMouse("body", 600, 600, { type: "mousemove" }, browser);
  await shownControl(browser, false, context);
  await TestUtils.waitForCondition(async () => (await videoControl(browser, context)).tracking === false, "Hidden, it stops following");
  await closeVideoTab(tab);
});
