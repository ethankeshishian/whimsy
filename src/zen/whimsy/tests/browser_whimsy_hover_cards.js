/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// W25 hover cards: one card for a tab and for a link. A picture on top (the
// tab itself, or the link's preview image; with none, the site tile in the
// same space), then the title, the address, and a one- or two-sentence AI
// description. It opens after resting 500ms and swaps with no delay as you
// move along. AI off: no description. A private tab: a tab gets no
// description, and a link shows only its text and address (nothing is
// loaded). One switch, Settings › General › Hover cards. No real network or
// AI: the page fetch, the reader, and the provider are stand-ins.

const { WhimsyHoverCards } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyHoverCards.sys.mjs");
const { WhimsyLinkHover } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyLinkHover.sys.mjs");
const { WhimsyAIProviders } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyAIProviders.sys.mjs");
const { WhimsyAIReader } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyAIReader.sys.mjs");
const { WhimsyAIPage } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyAIPage.sys.mjs");
const { WhimsyPrivate } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyPrivate.sys.mjs");

const ROOT = getRootDirectory(gTestPath).replace("chrome://mochitests/content", "https://example.com");
const PAGE = ROOT + "whimsy_ai_page.html";
const LINKS = ROOT + "whimsy_ai_links.html";
const IMAGE = ROOT + "whimsy_test_image.png";
const DESCRIPTION = "Planning notes for the Lisbon offsite on March 14, with the budget and the espresso machine.";
const POINTS = ["The offsite is in Lisbon on March 14.", "The espresso machine costs $129.", "The budget is still open."];

const linkPanel = () => document.getElementById(WhimsyLinkHover.PANEL_ID);
const tabPanel = () => document.getElementById(WhimsyHoverCards.TAB_PANEL_ID);
const host = WhimsyLinkHover.forWindow(window);

let asked = [];
let reads = [];
let fetches = [];
let imageBytes = null;
let answer = () => JSON.stringify({ title: "Planning notes", description: DESCRIPTION, points: POINTS });

add_setup(async () => {
  await SimpleTest.promiseFocus(window);
  await SpecialPowers.pushPrefEnv({
    set: [
      ["whimsy.feature.hover-cards", true],
      ["whimsy.feature.people-cards", false],
      ["whimsy.ai.enabled", true],
      ["zen.view.sidebar-expanded", true],
    ],
  });
  imageBytes = new Uint8Array(await (await fetch(IMAGE)).arrayBuffer());
  // Descriptions kept from an earlier run go (as Fire does), so each run reads.
  Services.obs.notifyObservers(null, "whimsy-ai-store-cleared");
  WhimsyAIProviders.setTestProvider(request => {
    asked.push(request);
    return answer(request);
  });
  WhimsyAIReader.setTestReader((url, options) => {
    reads.push({ url, ...options });
    return "The offsite is on March 14 in Lisbon. The espresso machine costs $129.";
  });
  WhimsyHoverCards.setTestFetcher(async (url, { kind }) => {
    fetches.push({ url, kind });
    if (kind == "image") {
      return { bytes: imageBytes, type: "image/png" };
    }
    return {
      text: `<html><head><title>Quarterly planning</title>
        <meta property="og:title" content="Quarterly planning notes">
        <meta property="og:image" content="${IMAGE}"></head><body></body></html>`,
    };
  });
  registerCleanupFunction(() => {
    host.hide({ animate: false });
    WhimsyHoverCards.forWindow(window)?.hide();
    WhimsyAIProviders.setTestProvider(null);
    WhimsyAIReader.setTestReader(null);
    WhimsyHoverCards.setTestFetcher(null);
  });
});

function reset() {
  asked = [];
  reads = [];
  fetches = [];
  answer = () => JSON.stringify({ title: "Planning notes", description: DESCRIPTION, points: POINTS });
}

const described = request => /hover card/.test(request.system);

// The AI summary's three bullets, right under the description.
function checkPoints(card, what) {
  const desc = card.querySelector(".whimsy-hc-desc.is-text");
  const list = card.querySelector("ul.whimsy-hc-points");
  ok(list, `${what}: the bullets show`);
  is(desc.nextElementSibling, list, `${what}: under the description`);
  Assert.deepEqual([...list.children].map(li => li.localName), ["li", "li", "li"], `${what}: exactly three`);
  Assert.deepEqual([...list.children].map(li => li.textContent), POINTS, `${what}: the AI's bullets`);
}

// Every shadow on `el`, as how far it reaches past each side.
function shadowExtent(el) {
  const extent = { top: 0, right: 0, bottom: 0, left: 0 };
  const value = getComputedStyle(el).boxShadow;
  if (value == "none") {
    return extent;
  }
  for (const shadow of value.split(/,(?![^(]*\))/)) {
    if (/inset/.test(shadow)) {
      continue;
    }
    const [x = 0, y = 0, blur = 0, spread = 0] = shadow.replace(/rgba?\([^)]*\)/, "").match(/-?[\d.]+px/g).map(parseFloat);
    extent.top = Math.max(extent.top, blur + spread - y);
    extent.bottom = Math.max(extent.bottom, blur + spread + y);
    extent.left = Math.max(extent.left, blur + spread - x);
    extent.right = Math.max(extent.right, blur + spread + x);
  }
  return extent;
}

// -moz-window-shadow is chrome-only, so getComputedStyle can't read it:
// take the winning declaration from the rules that match `el` (cascade
// order, !important last).
function windowShadow(el) {
  let value = "auto";
  let important = false;
  for (const rule of InspectorUtils.getCSSStyleRules(el)) {
    for (const [, v, imp] of rule.style.cssText.matchAll(/-moz-window-shadow:\s*([a-z-]+)\s*(!important)?/g)) {
      if (imp || !important) {
        value = v;
        important ||= !!imp;
      }
    }
  }
  return value;
}

// The look of a card's surface and of everything around it in its popup.
function surfaceLook(panel) {
  const frame = panel.querySelector(".whimsy-link-hover-card");
  const content = panel.shadowRoot?.querySelector("[part~='content']");
  const pick = (el, names) => Object.fromEntries(names.map(n => [n, el ? getComputedStyle(el).getPropertyValue(n) : null]));
  return {
    card: pick(frame, ["background-color", "border-top-width", "border-top-style", "border-top-color", "border-radius", "box-shadow", "width", "padding-top", "padding-left"]),
    panel: pick(panel, ["appearance", "background-color", "border-top-width", "box-shadow", "margin-top", "margin-left", "padding-top"]),
    content: pick(content, ["appearance", "background-color", "border-top-width", "box-shadow", "padding-top", "margin-top", "border-radius"]),
    stack: pick(panel.querySelector(".whimsy-link-hover-stack"), ["background-color", "box-shadow", "padding-top", "padding-left", "padding-bottom"]),
    windowShadow: windowShadow(panel),
    attributes: [...panel.attributes].map(a => a.name).filter(n => !["id", "whimsy-open", "side", "state", "style"].includes(n)).sort(),
  };
}

// Nothing between the card and its popup's window cuts its shadow: the
// card inflated by its shadow's reach fits in every clipping box around it
// and in the popup itself, on all four sides.
function checkShadowRoom(panel, what) {
  const frame = panel.querySelector(".whimsy-link-hover-card");
  const reach = shadowExtent(frame);
  ok(reach.bottom > 0, `${what}: the card has a shadow`);
  const box = frame.getBoundingClientRect();
  const needed = {
    top: box.top - reach.top,
    right: box.right + reach.right,
    bottom: box.bottom + reach.bottom,
    left: box.left - reach.left,
  };
  const clips = [panel];
  const content = panel.shadowRoot?.querySelector("[part~='content']");
  if (content) {
    clips.push(content);
  }
  for (let el = frame.parentElement; el && el != panel; el = el.parentElement) {
    if (getComputedStyle(el).overflow != "visible") {
      clips.push(el);
    }
  }
  for (const clip of clips) {
    const room = clip.getBoundingClientRect();
    const name = clip == panel ? "the popup" : clip.getAttribute?.("part") || clip.className;
    Assert.lessOrEqual(room.top, needed.top + 0.5, `${what}: ${name} leaves the shadow room above`);
    Assert.greaterOrEqual(room.right, needed.right - 0.5, `${what}: ...on the right`);
    Assert.greaterOrEqual(room.bottom, needed.bottom - 0.5, `${what}: ...below`);
    Assert.lessOrEqual(room.left, needed.left + 0.5, `${what}: ...on the left`);
  }
  // The popup's own window is as big as the popup.
  const outer = panel.getOuterScreenRect();
  const inner = panel.getBoundingClientRect();
  Assert.greaterOrEqual(outer.width + 0.5, inner.width, `${what}: the popup's window holds the room across`);
  Assert.greaterOrEqual(outer.height + 0.5, inner.height, `${what}: ...and down`);
  info(`${what}: card ${JSON.stringify(box)} reach ${JSON.stringify(reach)} popup ${JSON.stringify(inner)} window ${JSON.stringify(outer)}`);
}

async function closeAll() {
  host.hide({ animate: false });
  WhimsyHoverCards.forWindow(window)?.hide();
  await TestUtils.waitForCondition(
    () => (!linkPanel() || linkPanel().state == "closed") && (!tabPanel() || tabPanel().state == "closed"),
    "The cards are closed"
  );
}

function hoverTab(tab) {
  // What the tab strip itself dispatches when the pointer enters a tab.
  tab.dispatchEvent(new CustomEvent("TabHoverStart", { bubbles: true }));
}

function leaveTab(tab) {
  tab.dispatchEvent(new CustomEvent("TabHoverEnd", { bubbles: true }));
}

async function openTabCard() {
  await TestUtils.waitForCondition(() => tabPanel()?.state == "open" && tabPanel().querySelector(".whimsy-hc"), "The tab's card opens");
  return tabPanel().querySelector(".whimsy-hc");
}

async function openLinkCard() {
  await TestUtils.waitForCondition(() => linkPanel()?.state == "open" && linkPanel().querySelector(".whimsy-hc"), "The link's card opens");
  return linkPanel().querySelector(".whimsy-hc");
}

async function hoverLink(browser, selector = "#link") {
  await BrowserTestUtils.synthesizeMouseAtCenter("#away", { type: "mousemove" }, browser);
  await BrowserTestUtils.synthesizeMouseAtCenter(selector, { type: "mousemove" }, browser);
}

add_task(async function switch_is_on_by_default_and_firefox_preview_is_off() {
  ok(Services.prefs.getDefaultBranch("").getBoolPref("whimsy.feature.hover-cards"), "Hover cards are on by default");
  ok(!Services.prefs.getDefaultBranch("").getBoolPref("browser.tabs.hoverPreview.enabled"),
    "Firefox's tab hover preview is off: the hover card replaces it");
  ok(WhimsyHoverCards.forWindow(window), "Every window has the tab card");
});

// H.1: a tab. The card opens after the delay, with the tab's picture, its
// title and address, and a description of the page already loaded.
add_task(async function tab_card() {
  reset();
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE);
  const other = await BrowserTestUtils.openNewForegroundTab(gBrowser, LINKS);
  try {
    const started = Date.now();
    hoverTab(tab);
    const card = await openTabCard();
    Assert.greaterOrEqual(Date.now() - started, WhimsyHoverCards.ENTER_DELAY_MS - 50, "It opened after resting 500ms");
    is(card.dataset.kind, "tab", "A tab's card");
    is(card.querySelector(".whimsy-hc-title").textContent, tab.label, "Its title");
    is(card.querySelector(".whimsy-hc-host").textContent, "example.com", "Its address");
    ok(card.querySelector(".whimsy-hc-picture"), "The picture's space is on top");
    is(card.firstElementChild, card.querySelector(".whimsy-hc-picture"), "...first in the card");
    await TestUtils.waitForCondition(
      () => card.querySelector('.whimsy-hc-picture[data-kind="image"] canvas'),
      "The picture is the tab itself"
    );
    const desc = await TestUtils.waitForCondition(
      () => card.querySelector(".whimsy-hc-desc.is-text"),
      "The description arrives"
    ).catch(error => {
      const now = card.querySelector(".whimsy-hc-desc");
      info(`Description state: ${now?.className} "${now?.textContent}"; asked ${asked.length}; card connected ${card.isConnected}`);
      throw error;
    });
    is(desc.textContent, DESCRIPTION, "It's the AI's description");
    checkPoints(card, "A tab");
    is(asked.filter(described).length, 1, "The description and its bullets came from one request");
    const request = asked.find(described);
    ok(request?.prompt.includes("espresso machine"), "Written from the loaded page's own text");
    is(reads.length, 0, "Nothing was fetched for a tab");
    ok(!tabPanel().querySelector("button, menu, [role='menu']"), "No buttons or menus on the card");

    // Moving to the next tab: the card swaps at once, with no delay.
    leaveTab(tab);
    hoverTab(other);
    is(tabPanel().querySelector(".whimsy-hc-title").textContent, other.label, "The card swapped to the next tab at once");
    ok(tabPanel().state == "open" || tabPanel().state == "showing", "...without closing");

    // Choosing a tab closes the card.
    gBrowser.selectedTab = tab;
    await TestUtils.waitForCondition(() => tabPanel().state == "closed", "Selecting a tab closes it");
  } finally {
    await closeAll();
    BrowserTestUtils.removeTab(other);
    BrowserTestUtils.removeTab(tab);
  }
});

// The tab's tooltip gives way to the card (the speaker's tips stay).
add_task(async function tab_tooltip_gives_way() {
  const tab = gBrowser.selectedTab;
  const event = new Event("popupshowing", { cancelable: true });
  Object.defineProperty(event, "target", { value: { triggerNode: tab, removeAttribute() {} } });
  gBrowser.createTooltip(event);
  ok(event.defaultPrevented, "No tooltip over the tab while hover cards are on");
});

// H.8: a tab that isn't loaded says when its description will come.
add_task(async function unloaded_tab() {
  reset();
  const tab = gBrowser.addTab("https://example.com/?whimsy-hover-unloaded", {
    createLazyBrowser: true,
    triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
  });
  try {
    hoverTab(tab);
    const card = await openTabCard();
    const note = await TestUtils.waitForCondition(() => card.querySelector(".whimsy-hc-desc.is-note"), "A note");
    is(note.dataset.note, "unloaded", "Not loaded: the description comes once it has loaded");
    is(card.querySelector(".whimsy-hc-picture").dataset.kind, "site", "No saved picture: the site tile");
    is(asked.filter(described).length, 0, "Nothing is asked");
  } finally {
    await closeAll();
    BrowserTestUtils.removeTab(tab);
  }
});

// H.2: a link. Every link gets the card after resting 500ms: the link's own
// preview image, its text and real address, and a description of the public
// page, read without sign-ins.
add_task(async function link_card() {
  reset();
  await BrowserTestUtils.withNewTab(LINKS, async browser => {
    await SpecialPowers.spawn(browser, [], () => {
      const p = content.document.createElement("p");
      p.innerHTML = '<a id="link2" href="https://example.org/browser/zen/whimsy/tests/whimsy_ai_page.html?second">Second link</a>';
      content.document.getElementById("link").parentElement.after(p);
    });
    const started = Date.now();
    await hoverLink(browser);
    const card = await openLinkCard();
    Assert.greaterOrEqual(Date.now() - started, WhimsyLinkHover.ENTER_DELAY_MS - 50, "It opened after resting 500ms");
    is(card.dataset.kind, "link", "A link's card");
    is(card.querySelector(".whimsy-hc-title").textContent, "Quarterly planning notes", "The link's text");
    is(card.querySelector(".whimsy-hc-host").textContent, "example.com", "Where it really goes");
    await TestUtils.waitForCondition(
      () => card.querySelector('.whimsy-hc-picture[data-kind="image"] img.whimsy-hc-image'),
      "The picture is the page's own preview image"
    );
    Assert.deepEqual(fetches.map(f => f.kind), ["page", "image"], "Fetched the page's tags, then its image");
    const desc = await TestUtils.waitForCondition(() => card.querySelector(".whimsy-hc-desc.is-text"), "The description");
    is(desc.textContent, DESCRIPTION, "The AI's one- or two-sentence description");
    checkPoints(card, "A link");
    is(asked.filter(described).length, 1, "The description and its bullets came from one request");
    is(reads[0]?.url, PAGE, "The linked page was read");
    ok(reads[0].anonymous, "...without sign-ins");
    is(reads[0].userContextId, WhimsyAIReader.anonymousContextId(), "...in Firefox's background container");
    ok(!linkPanel().querySelector("button, menu, [role='menu']"), "No buttons or menus on the card");

    // Moving on to another link swaps the card with no delay.
    const moved = Date.now();
    await BrowserTestUtils.synthesizeMouseAtCenter("#link2", { type: "mousemove" }, browser);
    await TestUtils.waitForCondition(
      () => linkPanel()?.state == "open" && linkPanel().querySelector(".whimsy-hc-title")?.textContent == "Second link",
      "The card swapped to the next link"
    );
    Assert.less(Date.now() - moved, WhimsyLinkHover.ENTER_DELAY_MS, "...without waiting the delay again");
    is(linkPanel().querySelector(".whimsy-hc-host").textContent, "example.org", "...and its address");

    // Again: the description comes from the cache, with no second read.
    await BrowserTestUtils.synthesizeMouseAtCenter("#away", { type: "mousemove" }, browser);
    await TestUtils.waitForCondition(() => linkPanel().state == "closed", "Leaving the link closes the card");
    const readsBefore = reads.length;
    await hoverLink(browser);
    const again = await openLinkCard();
    await TestUtils.waitForCondition(() => again.querySelector(".whimsy-hc-desc.is-text"), "Described again");
    is(reads.length, readsBefore, "from the cache");
  });
  await closeAll();
});

// H.4: a page with no preview image gets the site tile in the same space.
// H.7: a description that can't be made says so in one muted line.
add_task(async function link_without_image_and_failed_description() {
  reset();
  WhimsyHoverCards.setTestFetcher(async (url, { kind }) => {
    fetches.push({ url, kind });
    return { text: "<html><head><title>No image here</title></head></html>" };
  });
  answer = () => "{}";
  try {
    const url = PAGE + "?no-image";
    host.enter({ source: "link", browser: gBrowser.selectedBrowser, url, title: "No image", x: 200, y: 200, width: 80, height: 18 });
    const card = await openLinkCard();
    await TestUtils.waitForCondition(() => fetches.length, "The page's tags were read");
    is(card.querySelector(".whimsy-hc-picture").dataset.kind, "site", "No image: the site tile");
    ok(card.querySelector(".whimsy-hc-site-icon"), "...with the site's icon");
    const note = await TestUtils.waitForCondition(() => card.querySelector(".whimsy-hc-desc.is-note"), "A muted note");
    is(note.dataset.note, "failed", "It couldn't be described");
    ok(!card.querySelector(".whimsy-hc-points"), "...and has no bullets");
    ok(!fetches.some(f => f.kind == "image"), "No image was fetched");
  } finally {
    await closeAll();
    WhimsyHoverCards.setTestFetcher(async (url, { kind }) => {
      fetches.push({ url, kind });
      return kind == "image"
        ? { bytes: imageBytes, type: "image/png" }
        : { text: `<html><head><meta property="og:image" content="${IMAGE}"></head></html>` };
    });
  }
});

// A hover never reads a local-network page (security M5): the card shows
// the link's text and address only.
add_task(async function local_links_load_nothing() {
  reset();
  host.enter({
    source: "link",
    browser: gBrowser.selectedBrowser,
    url: "http://192.168.1.1/apply.cgi?reset=1",
    title: "Router",
    x: 200,
    y: 200,
    width: 80,
    height: 18,
  });
  const card = await openLinkCard();
  is(card.querySelector(".whimsy-hc-host").textContent, "192.168.1.1", "The address");
  ok(!card.querySelector(".whimsy-hc-desc"), "No description");
  is(fetches.length, 0, "Nothing was fetched");
  is(reads.length, 0, "Nothing was read");
  await closeAll();
});

// A public name that resolves to a private address is refused when the
// fetch connects (DNS rebinding).
add_task(async function connected_address_must_be_public() {
  for (const ip of ["127.0.0.1", "10.0.0.2", "192.168.1.1", "169.254.169.254", "::1", "fd00::1", ""]) {
    ok(!WhimsyHoverCards.isPublicAddress(ip), `${ip || "(none)"} is not public`);
  }
  for (const ip of ["93.184.215.14", "2606:2800:21f:cb07:6820:80da:af6b:8b2c"]) {
    ok(WhimsyHoverCards.isPublicAddress(ip), `${ip} is public`);
  }
});

// H.5: with AI off, the card keeps the picture, title, and address, and
// drops the description, with no note.
add_task(async function ai_off() {
  reset();
  Services.prefs.setBoolPref("whimsy.ai.enabled", false);
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE);
  const other = await BrowserTestUtils.openNewForegroundTab(gBrowser, LINKS);
  try {
    hoverTab(tab);
    const card = await openTabCard();
    await TestUtils.waitForCondition(() => card.querySelector('.whimsy-hc-picture[data-kind="image"]'), "The picture");
    ok(!card.querySelector(".whimsy-hc-desc"), "A tab: no description and no note");
    ok(!card.querySelector(".whimsy-hc-points"), "...and no bullets");
    await closeAll();

    await hoverLink(other.linkedBrowser);
    const link = await openLinkCard();
    await TestUtils.waitForCondition(() => link.querySelector('.whimsy-hc-picture[data-kind="image"]'), "The link's picture");
    ok(!link.querySelector(".whimsy-hc-desc"), "A link: no description and no note");
    ok(!link.querySelector(".whimsy-hc-points"), "...and no bullets");
    is(reads.length, 0, "No page was read for AI");
    is(asked.length, 0, "Nothing was asked");
  } finally {
    Services.prefs.setBoolPref("whimsy.ai.enabled", true);
    await closeAll();
    BrowserTestUtils.removeTab(other);
    BrowserTestUtils.removeTab(tab);
  }
});

// H.6 and H.9: private tabs. A private tab's card has its picture, title,
// and address and says it gets no description; a link in a private tab
// shows only its text and address, and the linked page isn't loaded.
add_task(async function private_tabs() {
  reset();
  const tab = WhimsyPrivate.openPrivateTab(window, { url: LINKS, force: true });
  try {
    await BrowserTestUtils.browserLoaded(tab.linkedBrowser, false, LINKS);
    const other = await BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE);
    hoverTab(tab);
    const card = await openTabCard();
    const note = await TestUtils.waitForCondition(() => card.querySelector(".whimsy-hc-desc.is-note"), "A note");
    is(note.dataset.note, "private", "Private tabs don't get descriptions");
    ok(!card.querySelector(".whimsy-hc-points"), "...or bullets");
    await closeAll();
    BrowserTestUtils.removeTab(other);

    gBrowser.selectedTab = tab;
    await hoverLink(tab.linkedBrowser);
    const link = await openLinkCard();
    is(link.dataset.private, "true", "A link in a private tab");
    is(link.querySelector(".whimsy-hc-title").textContent, "Quarterly planning notes", "...shows its text");
    is(link.querySelector(".whimsy-hc-host").textContent, "example.com", "...and its address");
    is(link.querySelector(".whimsy-hc-picture").dataset.kind, "site", "...with the site tile, no picture");
    is(link.querySelector(".whimsy-hc-desc.is-note")?.dataset.note, "private-link", "...and says why");
    ok(!link.querySelector(".whimsy-hc-points"), "...with no bullets");
    is(fetches.length, 0, "The linked page isn't loaded");
    is(reads.length, 0, "...or read");
    is(asked.length, 0, "Nothing goes to AI");
  } finally {
    await closeAll();
    BrowserTestUtils.removeTab(tab);
  }
});

// The summary loads as one: quiet lines for the description and for its
// bullets, filled together from the one answer.
add_task(async function summary_loads_with_bullets() {
  reset();
  let release;
  const gate = new Promise(r => (release = r));
  answer = async () => {
    await gate;
    return JSON.stringify({ title: "Planning notes", description: DESCRIPTION, points: POINTS });
  };
  try {
    // A page not described before, so nothing comes from the cache.
    host.enter({ source: "link", browser: gBrowser.selectedBrowser, url: PAGE + "?loading", title: "Loading", x: 200, y: 200, width: 80, height: 18 });
    const card = await openLinkCard();
    await TestUtils.waitForCondition(() => card.querySelector(".whimsy-hc-desc.is-loading"), "The summary is loading");
    is(card.querySelectorAll(".whimsy-hc-points.is-loading > i").length, 3, "...with the bullets' place held");
    release();
    await TestUtils.waitForCondition(() => card.querySelector(".whimsy-hc-desc.is-text"), "Filled");
    checkPoints(card, "After loading");
    ok(!card.querySelector(".is-loading"), "No loading lines are left");
    is(asked.filter(described).length, 1, "One request");
    // A tall summary scrolls inside the card rather than growing past it.
    const frame = linkPanel().querySelector(".whimsy-link-hover-card");
    is(getComputedStyle(frame).overflowY, "auto", "The card scrolls when the summary is tall");
    Assert.lessOrEqual(frame.getBoundingClientRect().height, parseFloat(getComputedStyle(frame).maxHeight) + 0.5, "...within its max height");
  } finally {
    release();
    await closeAll();
  }
});

// One look for both: a tab's card and a link's card have the same single
// surface (background, border, radius, shadow) in hosts that add none of
// their own, and neither host clips the card's shadow on any side.
add_task(async function tab_and_link_cards_look_the_same() {
  reset();
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE);
  const other = await BrowserTestUtils.openNewForegroundTab(gBrowser, LINKS);
  try {
    hoverTab(tab);
    const tabCard = await openTabCard();
    await TestUtils.waitForCondition(() => tabPanel().hasAttribute("whimsy-open") && tabCard.querySelector(".whimsy-hc-desc.is-text"), "The tab's card is open");
    await whimsySettled();
    const tabLook = surfaceLook(tabPanel());
    info(`Tab card: ${JSON.stringify(tabLook)}`);
    const open = [...document.querySelectorAll("panel, menupopup, tooltip")].filter(p => p.state == "open").map(p => p.id || p.localName);
    Assert.deepEqual(open, [WhimsyHoverCards.TAB_PANEL_ID], "The tab's card is the only popup open: nothing is stacked around it");
    checkShadowRoom(tabPanel(), "Tab card");
    await closeAll();

    await hoverLink(other.linkedBrowser);
    const linkCard = await openLinkCard();
    await TestUtils.waitForCondition(() => linkPanel().hasAttribute("whimsy-open") && linkCard.querySelector(".whimsy-hc-desc.is-text"), "The link's card is open");
    await whimsySettled();
    const linkLook = surfaceLook(linkPanel());
    info(`Link card: ${JSON.stringify(linkLook)}`);
    checkShadowRoom(linkPanel(), "Link card");

    for (const name of ["background-color", "border-top-width", "border-top-style", "border-top-color", "border-radius", "box-shadow", "width"]) {
      is(tabLook.card[name], linkLook.card[name], `Same card ${name}`);
    }
    Assert.deepEqual(tabLook.panel, linkLook.panel, "The same host popup");
    Assert.deepEqual(tabLook.content, linkLook.content, "...with the same (bare) content box");
    Assert.deepEqual(tabLook.stack, linkLook.stack, "...and the same room around the card");
    Assert.deepEqual(tabLook.attributes, linkLook.attributes, "...made the same way");
    // Zen's widget.macos.native-popovers shows an anchored panel (the tab's)
    // as an NSPopover with its own material, arrow, and shadow, unless it
    // is nonnative.
    ok(tabPanel().hasAttribute("nonnative"), "The tab's card is never a native popover");
    ok(linkPanel().hasAttribute("nonnative"), "...nor is the link's");
    // One surface: nothing around the card paints a background, border, or shadow.
    for (const [what, look] of [["tab", tabLook], ["link", linkLook]]) {
      ok(/rgba\(0, 0, 0, 0\)|transparent/.test(look.content["background-color"]), `${what}: the popup's box has no background`);
      is(look.content["box-shadow"], "none", `${what}: ...no shadow`);
      is(look.content["border-top-width"], "0px", `${what}: ...no border`);
      is(look.panel.appearance, "none", `${what}: ...and no native material`);
      is(look.windowShadow, "none", `${what}: ...or window shadow`);
      ok(/rgba\(0, 0, 0, 0\)|transparent/.test(look.stack["background-color"]), `${what}: the shadow's room is see-through`);
    }
    is(getComputedStyle(linkPanel().querySelector(".whimsy-link-hover-stack")).pointerEvents, "none", "The shadow's room lets the pointer through");
    is(getComputedStyle(linkPanel().querySelector(".whimsy-link-hover-card")).pointerEvents, "auto", "...the card takes it");
  } finally {
    await closeAll();
    BrowserTestUtils.removeTab(other);
    BrowserTestUtils.removeTab(tab);
  }
});

// Shots: the tab's card and the link's card, described with bullets, in
// light and dark.
add_task(async function shots() {
  reset();
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE);
  const other = await BrowserTestUtils.openNewForegroundTab(gBrowser, LINKS);
  try {
    await whimsyBothSchemes("w25-hover-card-tab", async () => {
      hoverTab(tab);
      const card = await openTabCard();
      await TestUtils.waitForCondition(() => tabPanel().hasAttribute("whimsy-open") && card.querySelector("ul.whimsy-hc-points"), "Described");
      await whimsySettled();
      const undo = whimsyStandInPopups();
      return async () => {
        undo();
        leaveTab(tab);
        await closeAll();
      };
    });
    await whimsyBothSchemes("w25-hover-card-link", async () => {
      await hoverLink(other.linkedBrowser);
      const card = await openLinkCard();
      await TestUtils.waitForCondition(() => linkPanel().hasAttribute("whimsy-open") && card.querySelector("ul.whimsy-hc-points"), "Described");
      await whimsySettled();
      const undo = whimsyStandInPopups();
      return async () => {
        undo();
        await closeAll();
      };
    });
  } finally {
    await closeAll();
    BrowserTestUtils.removeTab(other);
    BrowserTestUtils.removeTab(tab);
  }
});

// H.10: one switch, Settings › General › Hover cards, for tabs and links.
add_task(async function the_one_switch() {
  reset();
  Services.prefs.setBoolPref("whimsy.feature.hover-cards", false);
  try {
    const tab = gBrowser.selectedTab;
    hoverTab(tab);
    const tabs = WhimsyHoverCards.forWindow(window);
    ok(!tabs.timer && !tabs.isOpen, "Off: hovering a tab starts no card");
    host.enter({ source: "link", browser: gBrowser.selectedBrowser, url: PAGE, title: "A link", x: 200, y: 200, width: 80, height: 18 });
    ok(!host.target, "Off: hovering a link starts no card");
    leaveTab(tab);
  } finally {
    Services.prefs.setBoolPref("whimsy.feature.hover-cards", true);
  }

  await BrowserTestUtils.withNewTab("about:preferences#general", async browser => {
    const doc = browser.contentDocument;
    const checkbox = await TestUtils.waitForCondition(() => doc.getElementById("whimsyHoverCards"), "The switch is in Settings");
    const group = doc.getElementById("whimsyHoverGroup");
    ok(group.contains(checkbox), "In the Hover cards group");
    ok(["paneGeneral", "paneSync"].includes(group.dataset.category), "...in General");
    is(checkbox.getAttribute("preference"), "whimsy.feature.hover-cards", "One switch for tabs and links");
    ok(!doc.getElementById("whimsyHoverLinks"), "W23's link card switch is gone");
    ok(!doc.getElementById("whimsyAILinkPreviews"), "...and so is 5-second previews'");
    checkbox.scrollIntoView();
    is(checkbox.checked, true, "It starts on");
    checkbox.click();
    await TestUtils.waitForCondition(() => !Services.prefs.getBoolPref("whimsy.feature.hover-cards"), "Turning it off");
    checkbox.click();
    await TestUtils.waitForCondition(() => Services.prefs.getBoolPref("whimsy.feature.hover-cards"), "...and on again");
  });
});

// One description path, kept per page and container.
add_task(async function descriptions_are_cached_per_container() {
  reset();
  WhimsyAIReader.setTestReader((_url, { userContextId }) => {
    reads.push(userContextId);
    return `Account ${userContextId} private dashboard`;
  });
  answer = ({ prompt }) => JSON.stringify({
    title: "Dashboard",
    description: prompt.includes("Account 1 private") ? "Account one." : "Account two.",
  });
  try {
    const url = PAGE + "?cache-isolation";
    is((await WhimsyAIPage.describe(url, { userContextId: 1 })).description, "Account one.", "First account");
    is((await WhimsyAIPage.describe(url, { userContextId: 2 })).description, "Account two.", "Second account never sees the first's");
    await WhimsyAIPage.describe(url, { userContextId: 1 });
    Assert.deepEqual(reads, [1, 2], "Each container keeps its own");
    is(asked.filter(described).length, 2, "asked as hover-card descriptions");
    is(asked[0].task, "preview", "through the router's preview task");
  } finally {
    WhimsyAIReader.setTestReader((url, options) => {
      reads.push({ url, ...options });
      return "The offsite is on March 14 in Lisbon. The espresso machine costs $129.";
    });
  }
});
