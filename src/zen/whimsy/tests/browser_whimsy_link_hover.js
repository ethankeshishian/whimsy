/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// wave7/ux, W25: one hover host for page links (WhimsyLinkHover). One card
// at a time: the People card on a profile link, otherwise the hover card,
// never both and never stacked. It never covers the link, flips above it
// when there's no room below, and opens and leaves on one transition. No
// real network or AI.

const { WhimsyLinkHover } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyLinkHover.sys.mjs");
const { WhimsyPeople } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyPeople.sys.mjs");
const { WhimsyAIPage } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyAIPage.sys.mjs");
const { WhimsyHoverCards } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyHoverCards.sys.mjs");

const panel = () => document.getElementById(WhimsyLinkHover.PANEL_ID);
const cards = () => [...(panel()?.querySelectorAll(".whimsy-link-hover-card") ?? [])].map(c => c.dataset.card);
const host = WhimsyLinkHover.forWindow(window);

add_setup(async () => {
  await SimpleTest.promiseFocus(window);
  await SpecialPowers.pushPrefEnv({
    set: [
      ["whimsy.feature.people-cards", true],
      ["whimsy.feature.hover-cards", true],
      ["ui.prefersReducedMotion", 0],
    ],
  });
  const fetchProfile = WhimsyPeople.fetchProfile;
  WhimsyPeople.fetchProfile = async (_win, url) => ({ title: "The Octocat", url, description: "GitHub mascot", image: null });
  WhimsyPeople._resetForTests();
  // The page's tags never arrive: the card keeps its site tile.
  WhimsyHoverCards.setTestFetcher(() => new Promise(() => {}));
  registerCleanupFunction(() => {
    WhimsyHoverCards.setTestFetcher(null);
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

// Stubs the AI side: on or off, and a description that stays loading.
function stubAI(on) {
  const { canDescribe, describe } = WhimsyAIPage;
  WhimsyAIPage.canDescribe = async () => on;
  WhimsyAIPage.describe = () => new Promise(() => {});
  return () => {
    WhimsyAIPage.canDescribe = canDescribe;
    WhimsyAIPage.describe = describe;
  };
}

function enterAt({ x, y, url = "https://example.org/article" }) {
  const link = { x, y, width: 140, height: 18 };
  host.enter({ source: "link", browser: gBrowser.selectedBrowser, url, title: "An article", ...link });
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
        () => panel().querySelector('[data-card="people"] .whimsy-person-name')?.textContent == "The Octocat",
        "...filled in with who it is"
      );

      await BrowserTestUtils.synthesizeMouseAtCenter("#away", { type: "mousemove" }, browser);
      await closed();

      await BrowserTestUtils.synthesizeMouseAtCenter("#n", { type: "mousemove" }, browser);
      await openCards();
      Assert.deepEqual(cards(), ["link"], "A normal link: the hover card only");
      is(panel().querySelector(".whimsy-hc-title").textContent, "a page", "It shows the link's text");
      await BrowserTestUtils.synthesizeMouseAtCenter("#away", { type: "mousemove" }, browser);
      await closed();
    });
  } finally {
    restore();
  }
});

add_task(async function one_card_one_motion() {
  const restore = stubAI(true);
  try {
    const link = enterAt({ x: window.mozInnerScreenX + 200, y: window.mozInnerScreenY + 150 });
    const p = await openCards();
    Assert.deepEqual(cards(), ["link"], "AI on: still one card, the description inside it");
    ok(p.querySelector(".whimsy-hc-desc.is-loading"), "It opened with the description's place loading");
    ok(!intersects(p.getOuterScreenRect(), link), "The card doesn't cover the link");

    const card = p.querySelector(".whimsy-link-hover-card");
    const motion = () => card.getAnimations().filter(a => a.transitionProperty == "opacity");
    // Leaving: one transition, then the popup closes.
    host.hide();
    const [out] = motion();
    ok(out, "The card animates out");
    await closed();
  } finally {
    host.hide({ animate: false });
    restore();
  }
});

add_task(async function no_room_below_flips_above() {
  const restore = stubAI(true);
  try {
    const bottom = window.screen.availTop + window.screen.availHeight;
    const link = enterAt({ x: window.mozInnerScreenX + 200, y: bottom - 30 });
    const p = await openCards();
    Assert.deepEqual(cards(), ["link"], "One card");
    const box = p.getOuterScreenRect();
    Assert.lessOrEqual(box.y + box.height, link.y + 1, "The card flips above the link");
    ok(!intersects(box, link), "...and still doesn't cover it");
    is(p.getAttribute("side"), "top", "...rising from below");
  } finally {
    host.hide({ animate: false });
    await closed();
    restore();
  }
});

// B3: wheel scrolling reaches the page both beside and over an open card.
add_task(async function page_still_scrolls_under_an_open_card() {
  const restore = stubAI(false);
  try {
    await BrowserTestUtils.withNewTab("https://example.com/browser/", async browser => {
      await SpecialPowers.spawn(browser, [], () => {
        content.document.body.style.height = "4000px";
      });

      enterAt({ x: window.mozInnerScreenX + 20, y: window.mozInnerScreenY + 20, url: "https://example.org/page" });
      const p = await openCards();
      Assert.deepEqual(cards(), ["link"], "The hover card is open");

      const scrollY = () => SpecialPowers.spawn(browser, [], () => content.scrollY);
      is(await scrollY(), 0, "Starts unscrolled");

      await new Promise(resolve =>
        EventUtils.synthesizeWheel(browser, 400, 500, { deltaMode: WheelEvent.DOM_DELTA_LINE, deltaY: 10 }, window, resolve)
      );
      await TestUtils.waitForCondition(async () => (await scrollY()) > 0, "The page scrolled away from the card");

      const before = await scrollY();
      const card = p.querySelector(".whimsy-link-hover-card");
      await new Promise(resolve =>
        EventUtils.synthesizeWheel(card, 10, 10, { deltaMode: WheelEvent.DOM_DELTA_LINE, deltaY: 10 }, window, resolve)
      );
      await TestUtils.waitForCondition(
        async () => (await scrollY()) > before,
        "The page scrolled further while the wheel was over the card itself"
      );
      ok(p.state == "open", "...and the card was still open while it happened");
    });
  } finally {
    host.hide({ animate: false });
    await closed();
    restore();
  }
});
