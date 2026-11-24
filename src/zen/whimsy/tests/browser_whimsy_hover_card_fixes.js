/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// W30 hover card fixes (owner: "this UI seems broken", hovering a pull
// request's own "Checks 86" tab). A link that only switches a view of the
// page you're on (its tab bar, a role="tab", a control for a panel, a
// hash) gets no card; a link to another page still does. The title is the
// link's words with their spaces ("Checks 86", never "Checks86 (86)"), and
// the page's own title once it's fetched. The picture shows only for a
// real preview image: none, a logo or icon, the page's own image again, or
// one too small collapses it. No real network or AI.

const { WhimsyHoverCards } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyHoverCards.sys.mjs");
const { WhimsyLinkHover } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyLinkHover.sys.mjs");

const ROOT = getRootDirectory(gTestPath).replace("chrome://mochitests/content", "https://example.com");
const TABS = ROOT + "whimsy_hover_tabs.html";
const IMAGE = ROOT + "whimsy_test_image.png";
const HTML_NS = "http://www.w3.org/1999/xhtml";

const linkPanel = () => document.getElementById(WhimsyLinkHover.PANEL_ID);
const host = WhimsyLinkHover.forWindow(window);

let entered = [];
let fetches = [];
let tags = "";
let images = new Map();

add_setup(async () => {
  await SimpleTest.promiseFocus(window);
  await SpecialPowers.pushPrefEnv({
    set: [
      ["whimsy.feature.hover-cards", true],
      ["whimsy.feature.people-cards", false],
      ["whimsy.ai.enabled", false],
    ],
  });
  EventUtils.synthesizeMouse(document.documentElement, 2, 2, { type: "mousemove" });
  const enter = host.enter;
  host.enter = function (req) {
    entered.push({ url: req.url, title: req.title, pageImage: req.pageImage });
    return enter.call(this, req);
  };
  images.set(IMAGE, { bytes: new Uint8Array(await (await fetch(IMAGE)).arrayBuffer()), type: "image/png" });
  WhimsyHoverCards.setTestFetcher(async (url, { kind }) => {
    fetches.push({ url, kind });
    if (kind == "image") {
      const found = images.get(url);
      if (!found) {
        throw new Error("Not available");
      }
      return found;
    }
    return { text: tags };
  });
  registerCleanupFunction(() => {
    host.hide({ animate: false });
    delete host.enter;
    WhimsyHoverCards.setTestFetcher(null);
  });
});

function reset(html = "<html><head></head><body></body></html>") {
  entered = [];
  fetches = [];
  tags = html;
}

async function closeAll() {
  host.hide({ animate: false });
  await TestUtils.waitForCondition(() => !linkPanel() || linkPanel().state == "closed", "The card is closed");
}

async function openLinkCard() {
  await TestUtils.waitForCondition(() => linkPanel()?.state == "open" && linkPanel().querySelector(".whimsy-hc"), "The link's card opens");
  return linkPanel().querySelector(".whimsy-hc");
}

async function hover(browser, selector) {
  await BrowserTestUtils.synthesizeMouseAtCenter("#away", { type: "mousemove" }, browser);
  await BrowserTestUtils.synthesizeMouseAtCenter(selector, { type: "mousemove" }, browser);
}

// A PNG of the given size, as the fetch stand-in returns it.
async function png(width, height) {
  const canvas = document.createElementNS(HTML_NS, "canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#3a7";
  ctx.fillRect(0, 0, width, height);
  const blob = await new Promise(resolve => canvas.toBlob(resolve, "image/png"));
  return { bytes: new Uint8Array(await blob.arrayBuffer()), type: "image/png" };
}

function pictureCollapsed(card) {
  const picture = card.querySelector(".whimsy-hc-picture");
  return !picture || (picture.dataset.kind == "none" && picture.getBoundingClientRect().height == 0);
}

// 1. In-page links (a tab bar of the page you're on, role="tab", a control
// for a panel, a hash) never make a card; links to other pages, the site's
// own navigation included, still do.
add_task(async function in_page_links_get_no_card() {
  reset();
  await BrowserTestUtils.withNewTab(TABS, async browser => {
    for (const id of ["tab-here", "tab-checks", "tab-files", "role-tab", "controls", "hash"]) {
      entered = [];
      await hover(browser, `#${id}`);
      // Hovering another page's link afterwards: its report arrives after
      // anything the in-page link would have sent (one actor, in order).
      await BrowserTestUtils.synthesizeMouseAtCenter("#other", { type: "mousemove" }, browser);
      await TestUtils.waitForCondition(() => entered.some(e => e.url.endsWith("?other")), `#${id}, then a link to another page`);
      Assert.deepEqual(entered.map(e => e.url.split("/").pop()), ["whimsy_ai_page.html?other"], `#${id}: no card, the next page's link gets one`);
      await closeAll();
    }
    entered = [];
    await hover(browser, "#site-nav");
    await openLinkCard();
    ok(entered.some(e => e.url.endsWith("?site")), "A link in the site's navigation to another page still gets a card");
    await closeAll();
  });
});

// 2. The title: the link's words with spaces between its parts, a count
// once, then the page's own title when it's fetched.
add_task(async function badge_link_title_has_its_spaces() {
  reset();
  await BrowserTestUtils.withNewTab(TABS, async browser => {
    await hover(browser, "#badge");
    const card = await openLinkCard();
    await TestUtils.waitForCondition(() => fetches.some(f => f.kind == "page"), "The page's tags were read");
    is(entered.at(-1).title, "Checks 86", "The link's words, spaced, with its count once");
    is(card.querySelector(".whimsy-hc-title").textContent, "Checks 86", "...on the card while the page has no title");
    await closeAll();

    reset('<html><head><title>Checks · Pull request #12</title><meta property="og:title" content="Fix the hover card · Pull request #12"></head></html>');
    host.enter({
      source: "link",
      browser,
      url: `${ROOT}whimsy_ai_page.html?titled`,
      title: "Checks 86",
      x: 200,
      y: 200,
      width: 80,
      height: 18,
    });
    const titled = await openLinkCard();
    await TestUtils.waitForCondition(
      () => titled.querySelector(".whimsy-hc-title").textContent == "Fix the hover card · Pull request #12",
      "The page's own title replaces the link's words once it's fetched"
    );
    await closeAll();
  });
});

// 3. The picture shows only for a real preview image.
add_task(async function picture_only_for_a_real_image() {
  const small = ROOT + "whimsy_small.png";
  const logo = ROOT + "assets/site-logo.png";
  const pageImage = "https://example.com/browser/zen/whimsy/tests/whimsy_site_default.png";
  images.set(small, await png(16, 16));
  images.set(logo, await png(600, 315));
  images.set(pageImage, await png(600, 315));
  const head = image => `<html><head><title>A page</title>${image ? `<meta property="og:image" content="${image}">` : ""}<link rel="icon" href="/favicon.ico"></head></html>`;
  const open = async (image, n) => {
    reset(head(image));
    host.enter({
      source: "link",
      browser: gBrowser.selectedBrowser,
      url: `${ROOT}whimsy_ai_page.html?picture-${n}`,
      title: "A page",
      pageImage,
      x: 200,
      y: 200,
      width: 80,
      height: 18,
    });
    const card = await openLinkCard();
    await TestUtils.waitForCondition(() => fetches.some(f => f.kind == "page"), "The page's tags were read");
    return card;
  };
  const settledImage = async (card, url) => {
    if (fetches.some(f => f.kind == "image" && f.url == url)) {
      await TestUtils.waitForCondition(() => card.dataset.picture, "The image was judged");
    }
  };

  for (const [what, image] of [
    ["no og:image", null],
    ["an image that fails", ROOT + "missing.png"],
    ["one too small to be a preview", small],
    ["the site's logo", logo],
    ["the same image as the page you're on", pageImage],
  ]) {
    const card = await open(image, what.length);
    await settledImage(card, image);
    ok(pictureCollapsed(card), `${what}: no picture space; the card is compact`);
    ok(!card.querySelector(".whimsy-hc-site-icon"), `${what}: no site tile in its place`);
    await closeAll();
  }

  const card = await open(IMAGE, 99);
  await TestUtils.waitForCondition(() => card.querySelector('.whimsy-hc-picture[data-kind="image"] img.whimsy-hc-image'), "A real preview image");
  Assert.greater(card.querySelector(".whimsy-hc-picture").getBoundingClientRect().height, 0, "...shows in the picture space");
  await closeAll();
});
