/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// wave7/ux: one hover host for page links (WhimsyLinkHover). Card 1 is the
// People card on a profile link, otherwise the link card, never both. With
// the AI previews on, the summary is a second card stacked beneath: same
// width, never overlapping card 1 or the link, flipping above together, and
// opening and leaving with the very same transition. No real network or AI.

const { WhimsyLinkHover } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyLinkHover.sys.mjs");
const { WhimsyPeople } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyPeople.sys.mjs");
const { WhimsyAIPage } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyAIPage.sys.mjs");

const panel = () => document.getElementById(WhimsyLinkHover.PANEL_ID);
const cards = () => [...(panel()?.querySelectorAll(".whimsy-link-hover-card") ?? [])].map(c => c.dataset.card);
const host = WhimsyLinkHover.forWindow(window);

add_setup(async () => {
  await SimpleTest.promiseFocus(window);
  await SpecialPowers.pushPrefEnv({
    set: [
      ["whimsy.feature.people-cards", true],
      ["whimsy.feature.link-cards", true],
      ["ui.prefersReducedMotion", 0],
    ],
  });
  const fetchProfile = WhimsyPeople.fetchProfile;
  WhimsyPeople.fetchProfile = async (_win, url) => ({ title: "The Octocat", url, description: "GitHub mascot", image: null });
  WhimsyPeople._resetForTests();
  registerCleanupFunction(() => {
    host.hide({ animate: false });
    WhimsyPeople.fetchProfile = fetchProfile;
    WhimsyPeople._resetForTests();
  });
});

async function closed() {
  await TestUtils.waitForCondition(() => !panel() || panel().state == "closed", "The cards are gone");
}

async function openCards() {
  await TestUtils.waitForCondition(() => panel()?.state == "open" && panel().hasAttribute("whimsy-open"), "Cards open");
  return panel();
}

// Stubs the AI side: on or off, and a summary that stays loading.
function stubAI(on) {
  const { previewMode, summarize } = WhimsyAIPage;
  WhimsyAIPage.previewMode = async () => (on ? "ready" : null);
  WhimsyAIPage.summarize = () => new Promise(() => {});
  return () => {
    WhimsyAIPage.previewMode = previewMode;
    WhimsyAIPage.summarize = summarize;
  };
}

function enterAt({ x, y, url = "https://example.org/article" }) {
  const link = { x, y, width: 140, height: 18 };
  host.enter({ source: "link", browser: gBrowser.selectedBrowser, how: "shift", url, title: "An article", ...link });
  return link;
}

function intersects(a, b) {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

add_task(async function profile_link_people_only_normal_link_link_only() {
  const restore = stubAI(false);
  try {
    await BrowserTestUtils.withNewTab("https://example.com/browser/", async browser => {
      await SpecialPowers.spawn(browser, [], () => {
        content.document.body.innerHTML = `
          <p><a id="away" href="#">away</a></p>
          <p><a id="p" href="https://github.com/octocat">octocat</a></p>
          <p><a id="n" href="https://example.org/page">a page</a></p>`;
      });
      await BrowserTestUtils.synthesizeMouseAtCenter("#p", { type: "mousemove" }, browser);
      await openCards();
      Assert.deepEqual(cards(), ["people"], "A profile link: the People card only");
      await TestUtils.waitForCondition(
        () => panel().querySelector('[data-card="people"] .whimsy-hover-title')?.textContent == "The Octocat",
        "...filled in with who it is"
      );

      await BrowserTestUtils.synthesizeMouseAtCenter("#away", { type: "mousemove" }, browser);
      await closed();

      await BrowserTestUtils.synthesizeMouseAtCenter("#n", { type: "mousemove", shiftKey: true }, browser);
      await openCards();
      Assert.deepEqual(cards(), ["link"], "A normal link: the link card only");
      is(panel().querySelector(".whimsy-link-hover-title").textContent, "a page", "It shows the link's text");
      await BrowserTestUtils.synthesizeMouseAtCenter("#away", { type: "mousemove" }, browser);
      await closed();
    });
  } finally {
    restore();
  }
});

add_task(async function ai_off_one_card() {
  const restore = stubAI(false);
  try {
    enterAt({ x: window.mozInnerScreenX + 200, y: window.mozInnerScreenY + 150 });
    await openCards();
    Assert.deepEqual(cards(), ["link"], "AI off: one card");
  } finally {
    host.hide({ animate: false });
    await closed();
    restore();
  }
});

add_task(async function ai_on_second_card_below_same_motion() {
  const restore = stubAI(true);
  try {
    const link = enterAt({ x: window.mozInnerScreenX + 200, y: window.mozInnerScreenY + 150 });
    const p = await openCards();
    Assert.deepEqual(cards(), ["link", "ai"], "AI on: the summary is a second card, under the first");
    ok(p.querySelector('[data-card="ai"] .whimsy-ai-shimmer'), "It opened with card 1, still loading");

    // Both cards' transitions: same tick, same duration and curve.
    const [first, second] = p.querySelectorAll(".whimsy-link-hover-card");
    const motion = card => card.getAnimations().filter(a => a.transitionProperty == "opacity");
    const [a] = motion(first);
    const [b] = motion(second);
    ok(a && b, "Both cards animate in");
    await Promise.all([a.ready, b.ready]);
    is(a.startTime, b.startTime, "...starting on the same tick");
    is(a.effect.getComputedTiming().duration, b.effect.getComputedTiming().duration, "...for the same time");
    is(getComputedStyle(first).transitionTimingFunction, getComputedStyle(second).transitionTimingFunction,
      "...on the same curve");
    await Promise.all([a.finished, b.finished]);

    const r1 = first.getBoundingClientRect();
    const r2 = second.getBoundingClientRect();
    is(Math.round(r1.width), Math.round(r2.width), "One width for both cards");
    Assert.lessOrEqual(r1.bottom, r2.top, "The summary sits below card 1 without overlapping it");
    ok(!intersects(p.getOuterScreenRect(), link), "Neither card covers the link");

    // Leaving: both cards go together, on one transition.
    host.hide();
    const [c] = motion(first);
    const [d] = motion(second);
    ok(c && d, "Both cards animate out");
    await Promise.all([c.ready, d.ready]);
    is(c.startTime, d.startTime, "...on the same tick");
    is(c.effect.getComputedTiming().duration, d.effect.getComputedTiming().duration, "...for the same time");
    await closed();
  } finally {
    host.hide({ animate: false });
    restore();
  }
});

add_task(async function no_room_below_flips_both_above() {
  const restore = stubAI(true);
  try {
    const bottom = window.screen.availTop + window.screen.availHeight;
    const link = enterAt({ x: window.mozInnerScreenX + 200, y: bottom - 30 });
    const p = await openCards();
    Assert.deepEqual(cards(), ["link", "ai"], "Both cards");
    const box = p.getOuterScreenRect();
    Assert.lessOrEqual(box.y + box.height, link.y + 1, "The stack flips above the link, together");
    ok(!intersects(box, link), "...and still doesn't cover it");
    is(p.getAttribute("side"), "top", "...rising from below");
    const [first, second] = p.querySelectorAll(".whimsy-link-hover-card");
    Assert.lessOrEqual(first.getBoundingClientRect().bottom, second.getBoundingClientRect().top, "...without overlapping");
  } finally {
    host.hide({ animate: false });
    await closed();
    restore();
  }
});
