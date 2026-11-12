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

const linkPanel = () => document.getElementById(WhimsyLinkHover.PANEL_ID);
const tabPanel = () => document.getElementById(WhimsyHoverCards.TAB_PANEL_ID);
const host = WhimsyLinkHover.forWindow(window);

let asked = [];
let reads = [];
let fetches = [];
let imageBytes = null;
let answer = () => JSON.stringify({ title: "Planning notes", description: DESCRIPTION });

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
  answer = () => JSON.stringify({ title: "Planning notes", description: DESCRIPTION });
}

const described = request => /hover card/.test(request.system);

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
    );
    is(desc.textContent, DESCRIPTION, "It's the AI's description");
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
    await closeAll();

    await hoverLink(other.linkedBrowser);
    const link = await openLinkCard();
    await TestUtils.waitForCondition(() => link.querySelector('.whimsy-hc-picture[data-kind="image"]'), "The link's picture");
    ok(!link.querySelector(".whimsy-hc-desc"), "A link: no description and no note");
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
    is(fetches.length, 0, "The linked page isn't loaded");
    is(reads.length, 0, "...or read");
    is(asked.length, 0, "Nothing goes to AI");
  } finally {
    await closeAll();
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
