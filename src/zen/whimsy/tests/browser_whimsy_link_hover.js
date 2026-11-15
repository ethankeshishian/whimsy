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
  await TestUtils.waitForCondition(() => !panel() || panel().state == "closed", "The cards are gone").catch(e => {
    info(`Still open: target ${host.target?.key} kind ${host.target?.kind} shown ${host.target?.shown}, pending ${host.pending?.key}, overPanel ${host.overPanel}, panel ${panel()?.state}, open-attr ${panel()?.hasAttribute("whimsy-open")}`);
    throw e;
  });
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

// The card as drawn, on screen. The popup's window is bigger than the card:
// it keeps --whimsy-hc-shadow-room on every side for the card's shadow
// (whimsy-ai.css), transparent and click-through, so the window's own rect
// isn't what covers anything.
function cardRect(p) {
  const room = parseFloat(getComputedStyle(p).getPropertyValue("--whimsy-hc-shadow-room")) || 0;
  const r = p.getOuterScreenRect();
  return { x: r.x + room, y: r.y + room, width: r.width - 2 * room, height: r.height - 2 * room };
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
    ok(!intersects(cardRect(p), link), "The card doesn't cover the link");

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
    const box = cardRect(p);
    Assert.lessOrEqual(box.y + box.height, link.y + 1, "The card flips above the link");
    ok(!intersects(box, link), "...and still doesn't cover it");
    is(p.getAttribute("side"), "top", "...rising from below");
  } finally {
    host.hide({ animate: false });
    await closed();
    restore();
  }
});

// W26 hover-scroll: an open card never stops the page from scrolling, and
// never takes a click meant for the page. "Scrolling breaks when the hover
// popup comes up" and "I always have to click on links twice": the card's
// popup was a rollup popup, and macOS swallows every wheel outside an open
// rollup popup that isn't an arrow panel; and its see-through shadow room
// (34px all round, over the link itself) took the mouse, since macOS can't
// let the pointer through part of a window.
const ROOT = getRootDirectory(gTestPath).replace("chrome://mochitests/content", "https://example.com");
const TARGET = ROOT + "whimsy_ai_page.html";

// A tall page with the link 400px down, scrolled 200px so a wheel either
// way moves it; a second link right beside the first, and a profile link
// (People card) beside that.
async function tallPage(browser) {
  await SpecialPowers.spawn(browser, [TARGET], target => {
    content.document.body.style.cssText = "margin: 0; height: 4000px";
    content.document.body.innerHTML = `
      <p style="margin: 0; padding: 20px; position: fixed; top: 0; left: 0"><a id="away" href="#">away</a></p>
      <p style="margin: 380px 40px 0"><a id="link" href="${target}?clicked">a link</a>
        <a id="next" href="${target}?next">next link</a>
        <a id="person" href="https://github.com/octocat">The Octocat</a></p>`;
    content.scrollTo(0, 200);
  });
}

// Like tallPage, but with nothing beside the link: a big link right under
// it, in the hover card's own footprint, for the regression test below
// (whatever's there gets the click once a plain card is gone). Its own page
// because the other tests here scroll a little with the pointer still
// resting where the link was, and a page-wide #below would end up under
// that resting pointer too.
async function pageWithLinkBelow(browser) {
  await SpecialPowers.spawn(browser, [TARGET], target => {
    content.document.body.style.cssText = "margin: 0; height: 4000px";
    content.document.body.innerHTML = `
      <p style="margin: 0; padding: 20px; position: fixed; top: 0; left: 0"><a id="away" href="#">away</a></p>
      <p style="margin: 380px 40px 0"><a id="link" href="${target}?clicked">a link</a></p>
      <p style="margin: 0 40px 0"><a id="below" href="${target}?below" style="display: block; width: 300px; height: 300px">below the link</a></p>`;
    content.scrollTo(0, 200);
  });
}

const pageY = browser => SpecialPowers.spawn(browser, [], () => content.scrollY);

// Scrolls the page and waits until it has stopped: no scroll event for
// three frames. A scroll still settling (a smooth wheel scroll, or the
// event for a jump, which comes a frame later) would otherwise land on the
// next hover, and a scroll ends a hover.
function scrollPageTo(browser, y) {
  return SpecialPowers.spawn(browser, [y], async y => {
    let quiet = 0;
    const moved = () => (quiet = 0);
    content.addEventListener("scroll", moved, true);
    content.scrollTo({ top: y, behavior: "instant" });
    while (quiet < 3) {
      await new Promise(r => content.requestAnimationFrame(r));
      quiet++;
    }
    content.removeEventListener("scroll", moved, true);
  });
}

async function hoverLinkCard(browser, { loading = false } = {}) {
  await scrollPageTo(browser, 200);
  // The real pointer, which the native wheel moves too.
  await whimsyNativeMoveTo(browser, "#away");
  await closed();
  await whimsyNativeMoveTo(browser, "#link");
  const p = await openCards().catch(async e => {
    // What the card's host and the page knew, for a failure.
    const hovered = await SpecialPowers.spawn(browser, [], () => [...content.document.querySelectorAll(":hover")].map(n => n.id || n.localName).join(">"));
    info(`No card: target ${host.target?.key} shown ${host.target?.shown}, pending ${host.pending?.key}, overPanel ${host.overPanel}, panel ${panel()?.state}, hovered ${hovered}`);
    throw e;
  });
  if (loading) {
    await TestUtils.waitForCondition(() => p.querySelector(".whimsy-hc-desc.is-loading"), "The card is still loading");
  }
  ok(p.hasAttribute("noautohide"), "The card's popup isn't a rollup popup, so nothing outside it is swallowed");
  is(getComputedStyle(p).pointerEvents, "none", "...and its window lets the pointer through until it's on the card");
  return p;
}

// Same, but on the profile link: the People card, which keeps the hover
// bridge and survives the pointer reaching it (unlike the plain card
// above).
async function hoverPeopleCard(browser) {
  await scrollPageTo(browser, 200);
  await whimsyNativeMoveTo(browser, "#away");
  await closed();
  await whimsyNativeMoveTo(browser, "#person");
  const p = await openCards();
  Assert.deepEqual(cards(), ["people"], "The profile link: the People card");
  return p;
}

async function pageScrolls(browser, what, wheel) {
  const before = await pageY(browser);
  await wheel();
  await TestUtils.waitForCondition(async () => (await pageY(browser)) != before, `${what}: the page scrolls`);
}

// The real pointer onto the card.
async function pointerOnCard(p) {
  const r = cardRect(p);
  await whimsyNativeMove(r.x + r.width / 2, r.y + r.height / 2);
}

// The card on screen, and a point in its see-through room beside it.
function roomBeside(p) {
  const card = cardRect(p);
  const outer = p.getOuterScreenRect();
  const point = { x: card.x + card.width + 12, y: card.y + Math.min(40, card.height / 2) };
  Assert.less(point.x, outer.x + outer.width, "The point is in the card's popup window");
  return point;
}

add_task(async function page_scrolls_under_an_open_card() {
  const restore = stubAI(true);
  try {
    await BrowserTestUtils.withNewTab("https://example.com/browser/", async browser => {
      await tallPage(browser);

      // Over the page, away from the card, while it loads: the bug itself.
      let p = await hoverLinkCard(browser, { loading: true });
      const box = browser.getBoundingClientRect();
      await pageScrolls(browser, "A wheel over the page", () =>
        whimsyNativeWheel(window.mozInnerScreenX + box.right - 60, window.mozInnerScreenY + box.bottom - 60, -3)
      );
      // The link moved out from under the pointer: the card goes.
      await closed();

      // Over the card's see-through room.
      p = await hoverLinkCard(browser, { loading: true });
      const room = roomBeside(p);
      await pageScrolls(browser, "A wheel over the card's shadow room", () => whimsyWheelAt(room.x, room.y, 3));
      await closed();
      p = await hoverLinkCard(browser);
      await pageScrolls(browser, "A real wheel over the card's shadow room", () => whimsyNativeWheel(room.x, room.y, -3));
      await closed();

      // Over the card itself: the plain card has nothing to click or
      // scroll, so leaving the link already closed it (W29) and this
      // scenario only still applies to the People card, which keeps the
      // hover bridge. It isn't the card's to scroll either: the page
      // scrolls, and the card goes at once so the rest of the gesture
      // lands there.
      p = await hoverPeopleCard(browser);
      await pointerOnCard(p);
      await TestUtils.waitForCondition(() => host.overPanel, "The pointer is on the card");
      is(getComputedStyle(p).pointerEvents, "auto", "...which takes the mouse now");
      await pageScrolls(browser, "A wheel over the card", () => whimsyWheelAt(cardRect(p).x + 20, cardRect(p).y + 20, 3));
      await closed();
    });
  } finally {
    host.hide({ animate: false });
    await whimsyParkPointer();
    await closed();
    restore();
  }
});

// Zooming (Ctrl with the wheel; a trackpad pinch goes through the same
// rollup check in nsCocoaWindow, which the card's popup no longer has)
// reaches the page with a card open, and from over the card itself.
add_task(async function page_zooms_with_a_card_open() {
  // macOS keeps Ctrl with the wheel a scroll by default (firefox.js); make it
  // the zoom it is elsewhere, so the forwarded modifiers show.
  await SpecialPowers.pushPrefEnv({ set: [["browser.zoom.siteSpecific", false], ["mousewheel.with_control.action", 3]] });
  const restore = stubAI(true);
  try {
    await BrowserTestUtils.withNewTab("https://example.com/browser/", async browser => {
      await tallPage(browser);
      const zoom = () => ZoomManager.getZoomForBrowser(browser);
      const zooms = async (what, wheel) => {
        const before = zoom();
        await wheel();
        await TestUtils.waitForCondition(() => zoom() != before, `${what}: the page zooms`);
      };

      let p = await hoverLinkCard(browser, { loading: true });
      const box = browser.getBoundingClientRect();
      await zooms("Ctrl and the wheel over the page, the card loading", () =>
        whimsyWheelAt(window.mozInnerScreenX + box.right - 60, window.mozInnerScreenY + box.bottom - 60, -1, window, { ctrlKey: true })
      );
      FullZoom.reset(browser);
      await TestUtils.waitForCondition(() => zoom() == 1, "Zoom back to 100%");

      // Over the card: the People card, since a plain one is gone by the
      // time the pointer gets there (W29). It isn't the card's to scroll
      // either; the page zooms.
      p = await hoverPeopleCard(browser);
      await pointerOnCard(p);
      await TestUtils.waitForCondition(() => host.overPanel, "The pointer is on the card");
      await zooms("Ctrl and the wheel over the card", () =>
        whimsyWheelAt(cardRect(p).x + 20, cardRect(p).y + 20, -1, window, { ctrlKey: true })
      );
      await closed();
      FullZoom.reset(browser);
      await TestUtils.waitForCondition(() => zoom() == 1, "Zoom back to 100%");
    });
  } finally {
    host.hide({ animate: false });
    await whimsyParkPointer();
    await closed();
    restore();
    await SpecialPowers.popPrefEnv();
  }
});

// A scroll under a pointer resting on the link ends its card; the
// pointer's next move on the link brings it back (no new mouseover comes
// while the pointer stays on it).
add_task(async function card_comes_back_after_a_scroll_under_a_still_pointer() {
  const restore = stubAI(true);
  try {
    await BrowserTestUtils.withNewTab("https://example.com/browser/", async browser => {
      await tallPage(browser);
      await hoverLinkCard(browser);
      await scrollPageTo(browser, 202);
      await closed();
      const link = await whimsyContentRect(browser, "#link");
      await whimsyNativeMove(link.x + 4, link.y + 4);
      await openCards();
      ok(true, "The pointer moved on the link: its card is back");
    });
  } finally {
    host.hide({ animate: false });
    await whimsyParkPointer();
    await closed();
    restore();
  }
});

// While the page underneath is still loading.
add_task(async function page_scrolls_under_a_card_while_loading() {
  const restore = stubAI(true);
  const tab = await BrowserTestUtils.openNewForegroundTab({
    gBrowser,
    url: ROOT + "whimsy_slow_load.sjs?delay=20000",
    waitForLoad: false,
  });
  try {
    const browser = tab.linkedBrowser;
    await TestUtils.waitForCondition(
      () => SpecialPowers.spawn(browser, [], () => !!content.document.body && content.location.href.includes("slow_load")).catch(() => false),
      "The page has started"
    );
    await tallPage(browser);
    is(await SpecialPowers.spawn(browser, [], () => content.document.readyState), "loading", "The page is still loading");
    await hoverLinkCard(browser, { loading: true });
    const box = browser.getBoundingClientRect();
    await pageScrolls(browser, "Mid-load, a wheel over the page", () =>
      whimsyNativeWheel(window.mozInnerScreenX + box.right - 60, window.mozInnerScreenY + box.bottom - 60, -3)
    );
    await closed();
  } finally {
    host.hide({ animate: false });
    await whimsyParkPointer();
    BrowserTestUtils.removeTab(tab);
    restore();
  }
});

// One click: on the link under the card's room, and on the link beside it.
add_task(async function one_click_with_a_card_open() {
  const restore = stubAI(true);
  try {
    await BrowserTestUtils.withNewTab("https://example.com/browser/", async browser => {
      for (const [selector, query] of [["#link", "?clicked"], ["#next", "?next"]]) {
        await tallPage(browser);
        const p = await hoverLinkCard(browser);
        const link = await whimsyContentRect(browser, selector);
        const at = { x: link.x + link.width / 2, y: link.y + link.height / 2 };
        ok(intersects({ ...at, width: 1, height: 1 }, p.getOuterScreenRect()), `${selector}: the card's popup window covers it`);
        const loaded = BrowserTestUtils.browserLoaded(browser, false, url => url.endsWith(query));
        whimsyMouseAt(at.x, at.y);
        await loaded;
        ok(true, `${selector}: one click followed it`);
        await closed();
        BrowserTestUtils.startLoadingURIString(browser, "https://example.com/browser/");
        await BrowserTestUtils.browserLoaded(browser);
      }
      // The plain card itself no longer takes a click (W29): it's gone by
      // the time the pointer gets there. See
      // plain_card_closes_and_lets_the_page_through below, and the People
      // card equivalent is still covered by the bridge tests.
    });
  } finally {
    host.hide({ animate: false });
    await whimsyParkPointer();
    await closed();
    restore();
  }
});

// W29: "the hover card tends to cover things below it" - a plain card used
// to keep the hover bridge too, so moving the pointer down onto it (as you
// naturally would, reaching for whatever's under it) kept it open and
// covering that content. Now leaving the link closes it, pointer or not,
// and whatever's underneath takes the hover and the click.
add_task(async function plain_card_closes_and_lets_the_page_through() {
  const restore = stubAI(true);
  try {
    await BrowserTestUtils.withNewTab("https://example.com/browser/", async browser => {
      await pageWithLinkBelow(browser);
      const p = await hoverLinkCard(browser);
      const card = cardRect(p);
      await pointerOnCard(p);
      await closed();
      is(host.overPanel, false, "The pointer reaching the card never kept it open");

      // The link below the card (#below) now gets the hover and the click
      // the card used to sit on top of.
      const loaded = BrowserTestUtils.browserLoaded(browser, false, url => url.endsWith("?below"));
      whimsyMouseAt(card.x + card.width / 2, card.y + card.height / 2);
      await loaded;
      ok(true, "The element under the card took the click");
    });
  } finally {
    host.hide({ animate: false });
    await whimsyParkPointer();
    await closed();
    restore();
  }
});

// The People card is the opposite: it has buttons, so the pointer reaching
// it (the hover bridge) keeps it open past CARD_LEAVE_MS and LEAVE_GRACE_MS.
add_task(async function people_card_survives_the_pointer_reaching_it() {
  const restore = stubAI(false);
  try {
    await BrowserTestUtils.withNewTab("https://example.com/browser/", async browser => {
      await tallPage(browser);
      const p = await hoverPeopleCard(browser);
      await pointerOnCard(p);
      await TestUtils.waitForCondition(() => host.overPanel, "The pointer is on the card");
      await new Promise(resolve => setTimeout(resolve, WhimsyLinkHover.LEAVE_GRACE_MS + 150)); // eslint-disable-line mozilla/no-arbitrary-setTimeout
      is(panel()?.state, "open", "The People card stays while the pointer rests on it");
    });
  } finally {
    host.hide({ animate: false });
    await whimsyParkPointer();
    await closed();
    restore();
  }
});
