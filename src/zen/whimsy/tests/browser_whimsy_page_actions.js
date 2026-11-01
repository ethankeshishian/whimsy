/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// wave6: Page actions (Safari Highlights). A page's schema.org data (JSON-LD
// or microdata) puts one pill in the address bar: Add to Calendar, Maps with
// Open now, Cook mode, Watch price, Track. Listings, unsafe links, the switch
// and navigating away leave no pill.

ChromeUtils.defineESModuleGetters(this, {
  WhimsyPageActions: "resource:///modules/whimsy/WhimsyPageActions.sys.mjs",
});

const FEATURE = "whimsy.feature.page-actions";
const PAGE =
  getRootDirectory(gTestPath).replace("chrome://mochitests/content", "https://example.com") +
  "whimsy_page_actions.html";

add_setup(async function () {
  await SpecialPowers.pushPrefEnv({ set: [[FEATURE, true]] });
  WhimsyPageActions._testing = true;
  registerCleanupFunction(() => (WhimsyPageActions._testing = false));
});

const pill = () => document.getElementById("whimsy-page-action");

async function openPage(kind) {
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, `${PAGE}?${kind}`);
  // The page's message to the parent travels before this round trip's reply.
  await SpecialPowers.spawn(tab.linkedBrowser, [], () => {});
  await TestUtils.waitForTick();
  return tab;
}

async function waitForPill(kind) {
  await TestUtils.waitForCondition(() => pill() && !pill().hidden && pill().getAttribute("kind") == kind, `${kind} pill`);
  return pill();
}

function pillHidden() {
  return !pill() || pill().hidden;
}

add_task(async function test_event_add_to_calendar() {
  const tab = await openPage("event");
  const el = await waitForPill("event");
  is(el.querySelector(".whimsy-page-action-label").getAttribute("data-l10n-id"), "whimsy-page-action-event", "Add to Calendar");
  is(el.getAttribute("role"), "button", "A button");
  is(el.getAttribute("tabindex"), "0", "reachable by keyboard");
  const action = WhimsyPageActions.actionFor(tab.linkedBrowser);
  is(action.location, "The Hall, 1 Main St, Springfield", "Place name and address");
  const path = await WhimsyPageActions.addToCalendar(window, action, tab.linkedBrowser.currentURI.spec);
  const ics = await IOUtils.readUTF8(path);
  ok(ics.includes("SUMMARY:Night Gig\r\n"), "Event title");
  ok(ics.includes("DTSTART:20261106T003000Z\r\n"), "Start in UTC");
  ok(ics.includes("DTEND:20261106T013000Z\r\n"), "An hour long when the page gives no end");
  ok(ics.includes("LOCATION:The Hall\\, 1 Main St\\, Springfield\r\n"), "Escaped location");
  ok(ics.includes(`URL:${tab.linkedBrowser.currentURI.spec}`), "Links back to the page");
  await IOUtils.remove(path);

  // Navigating away forgets the action.
  const loaded = BrowserTestUtils.browserLoaded(tab.linkedBrowser, false, `${PAGE}?none`);
  BrowserTestUtils.startLoadingURIString(tab.linkedBrowser, `${PAGE}?none`);
  await loaded;
  await TestUtils.waitForCondition(pillHidden, "No pill on a page without data");
  BrowserTestUtils.removeTab(tab);
});

add_task(async function test_recipe_cook_mode() {
  const tab = await openPage("recipe");
  const el = await waitForPill("recipe");
  el.click();
  await TestUtils.waitForCondition(() => document.getElementById("whimsy-cook-panel")?.state == "open", "Cook mode opens");
  const panel = document.getElementById("whimsy-cook-panel");
  is(panel.querySelector(".whimsy-cook-title").textContent, "Tomato Soup", "The recipe, not the site's Organization");
  is(panel.querySelectorAll(".whimsy-cook-ingredients input[type=checkbox]").length, 2, "Ingredients to tick off");
  is(panel.querySelectorAll(".whimsy-cook-steps > li").length, 2, "Numbered steps");
  ok(panel.querySelector(".whimsy-cook-facts").textContent.includes("45 min"), "Total time, readable");
  const label = panel.querySelector(".whimsy-cook-ingredients label");
  is(label.control?.type, "checkbox", "Each ingredient labels its checkbox");
  const hidden = BrowserTestUtils.waitForEvent(panel, "popuphidden");
  panel.hidePopup();
  await hidden;
  ok(!document.getElementById("whimsy-cook-panel"), "Closing removes it (and releases the screen)");
  BrowserTestUtils.removeTab(tab);
});

add_task(async function test_place_microdata() {
  const tab = await openPage("place");
  const el = await waitForPill("place");
  const label = el.querySelector(".whimsy-page-action-label");
  is(label.getAttribute("data-l10n-id"), "whimsy-page-action-place", "Maps");
  is(JSON.parse(label.getAttribute("data-l10n-args")).state, "open", "Open now, from its round-the-clock hours");
  const action = WhimsyPageActions.actionFor(tab.linkedBrowser);
  is(action.name, "Corner Café", "Read from microdata");
  is(action.address, "2 Side St", "with its nested address");
  ok(WhimsyPageActions.mapsUrl(action).startsWith("q=Corner+Caf"), "Maps query names it");
  BrowserTestUtils.removeTab(tab);
});

add_task(async function test_parcel_track() {
  const tab = await openPage("parcel");
  const el = await waitForPill("parcel");
  const opened = BrowserTestUtils.waitForNewTab(gBrowser, "https://example.com/track?id=1");
  el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  const tracking = await opened;
  ok(tracking, "Return on the pill opens the carrier's page");
  BrowserTestUtils.removeTab(tracking);
  BrowserTestUtils.removeTab(tab);
});

// wave7/security L3: the tracking URL comes from the page, so it opens with
// the page's principal (not the system's), and the tooltip names its host.
add_task(async function test_parcel_opens_as_the_page() {
  const tab = await openPage("parcel");
  const el = await waitForPill("parcel");
  is(document.l10n.getAttributes(el).args.host, "example.com", "The tooltip names where Track goes");
  const principals = [];
  const addTab = gBrowser.addTab;
  gBrowser.addTab = function (url, options = {}) {
    principals.push(options.triggeringPrincipal);
    return addTab.call(this, url, options);
  };
  try {
    const opened = BrowserTestUtils.waitForNewTab(gBrowser, "https://example.com/track?id=1");
    el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    const tracking = await opened;
    ok(principals.length && !principals[0].isSystemPrincipal, "Not opened as the browser");
    ok(principals[0].equals(tab.linkedBrowser.contentPrincipal), "but as the page's own link");
    BrowserTestUtils.removeTab(tracking);
  } finally {
    gBrowser.addTab = addTab;
  }
  BrowserTestUtils.removeTab(tab);
});

add_task(async function test_no_pill_cases() {
  for (const kind of ["events", "bad", "none", "product"]) {
    const tab = await openPage(kind);
    ok(pillHidden(), `No pill for ?${kind}`);
    BrowserTestUtils.removeTab(tab);
  }
  ok(
    WhimsyPageActions.validate({ kind: "product", name: "Desk Lamp", offer: { price: "49.00", currency: "USD" } }),
    "A product is understood; Watch price only shows where Watch a page can run (AI set up)"
  );
});

add_task(async function test_switch_off() {
  const tab = await openPage("event");
  await waitForPill("event");
  await SpecialPowers.pushPrefEnv({ set: [[FEATURE, false]] });
  await TestUtils.waitForCondition(pillHidden, "Switch off hides the pill at once");
  const other = await openPage("recipe");
  ok(pillHidden(), "and no new pills");
  BrowserTestUtils.removeTab(other);
  await SpecialPowers.popPrefEnv();
  BrowserTestUtils.removeTab(tab);
});

add_task(async function test_opening_hours() {
  const wed10 = new Date(2026, 9, 28, 10, 0);
  is(WhimsyPageActions.openNow({ specs: [], strings: ["Mo-Fr 09:00-17:00"] }, wed10), true, "Weekday hours");
  is(WhimsyPageActions.openNow({ specs: [], strings: ["Sa,Su 09:00-17:00"] }, wed10), false, "Weekend only");
  is(
    WhimsyPageActions.openNow(
      { specs: [{ days: ["Tuesday"], opens: "20:00", closes: "02:00" }], strings: [] },
      new Date(2026, 9, 28, 1, 0)
    ),
    true,
    "Past midnight counts for the day before"
  );
  is(WhimsyPageActions.openNow({ specs: [], strings: [] }, wed10), null, "No hours, no claim");
});

// wave7/security L4: a lone CR in the page's event data can't start an
// iCalendar property of its own.
add_task(function test_ics_lone_cr() {
  const ics = WhimsyPageActions.buildIcs(
    { kind: "event", name: "Party\rATTACH:https://evil.example/x", startDate: "2026-11-05", location: "Hall\rBEGIN:VALARM", description: "a\u0000b" },
    "https://example.com/"
  );
  const lines = ics.split("\r\n");
  ok(!lines.some(l => /^(ATTACH|BEGIN:VALARM)/.test(l)), "No injected properties");
  ok(!/\r(?!\n)/.test(ics) && !ics.includes("\u0000"), "No lone CR or NUL survives");
});

// W10-55: Allrecipes showed no pill. Its JSON-LD is an array whose Recipe has
// "@type": ["Recipe"] and steps full of &#34;. The pill comes at
// DOMContentLoaded (the ad frame keeps "load" back), and it shows without
// hovering the sidebar (Zen's single toolbar fades .urlbar-page-action out).
const DIR = getRootDirectory(gTestPath).replace("chrome://mochitests/content", "https://example.com");

add_task(async function test_allrecipes_recipe() {
  const hovered = gNavToolbox.getAttribute("zen-has-implicit-hover");
  gNavToolbox.removeAttribute("zen-has-implicit-hover");
  const tab = await BrowserTestUtils.openNewForegroundTab({
    gBrowser,
    url: DIR + "whimsy_page_actions_allrecipes.html",
    waitForLoad: false,
  });
  const el = await waitForPill("recipe");
  const state = await SpecialPowers.spawn(tab.linkedBrowser, [], () => content.document.readyState);
  isnot(state, "complete", "The pill doesn't wait for the slow ad frame");

  ok(!el.classList.contains("urlbar-page-action"), "Not one of the hover-only page actions");
  await TestUtils.waitForCondition(() => getComputedStyle(el).opacity == "1", "Fully shown");
  is(getComputedStyle(el).visibility, "visible", "Visible without hovering the sidebar");
  Assert.greater(el.getBoundingClientRect().width, 0, "and takes up room in the address bar");

  const action = WhimsyPageActions.actionFor(tab.linkedBrowser);
  is(action.name, "Severed-Finger Cheese Sticks", "The recipe from the array");
  is(action.ingredients.length, 3, "Its ingredients");
  is(action.steps.length, 4, "Its steps, the one with an image too");
  ok(action.steps[0].endsWith('torn-off "fingers".'), "Character references are decoded");
  ok(!action.steps.some(s => s.includes("&#")), "None left over");
  is(action.yield, "6", "The first yield");

  el.click();
  await TestUtils.waitForCondition(() => document.getElementById("whimsy-cook-panel")?.state == "open", "Cook mode opens");
  const panel = document.getElementById("whimsy-cook-panel");
  is(panel.querySelectorAll(".whimsy-cook-steps > li").length, 4, "Four numbered steps");
  ok(panel.querySelector(".whimsy-cook-steps").textContent.includes('"nail bed"'), "Quotes read as quotes");
  const hidden = BrowserTestUtils.waitForEvent(panel, "popuphidden");
  panel.hidePopup();
  await hidden;
  BrowserTestUtils.removeTab(tab);
  if (hovered) {
    gNavToolbox.setAttribute("zen-has-implicit-hover", hovered);
  }
});

// W10-55: a Best Buy product page: the Product's script type carries a
// charset, its price is inside an AggregateOffer, and a "customers also
// viewed" ItemList names other Products. (The pill itself waits for Watch a
// page, which needs AI set up; the action is understood either way.)
add_task(async function test_bestbuy_product() {
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, DIR + "whimsy_page_actions_bestbuy.html");
  await TestUtils.waitForCondition(() => WhimsyPageActions.actionFor(tab.linkedBrowser), "Product found");
  const action = WhimsyPageActions.actionFor(tab.linkedBrowser);
  is(action.kind, "product", "A product");
  is(action.name, "Apple - AirPods Pro 2, Wireless Active Noise Cancelling Earbuds - White", "The page's product, not the related ones");
  is(action.price, "189.99", "Price from the AggregateOffer");
  is(action.currency, "USD", "and its currency");
  BrowserTestUtils.removeTab(tab);
});

// W10-55: JSON-LD shapes seen in the wild, parsed straight from markup.
add_task(function test_jsonld_shapes() {
  const { findAction } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyPageActionsChild.sys.mjs");
  const find = (...scripts) =>
    findAction(
      new DOMParser().parseFromString(
        "<!DOCTYPE html>" + scripts.map(s => `<script type="application/ld+json">${s}</script>`).join(""),
        "text/html"
      )
    );
  const soup = (name, extra = "") =>
    `{"@type": "Recipe", "name": "${name}", "recipeIngredient": ["1 egg"]${extra}}`;

  // Wrapped in an HTML comment, a raw line break in a string, trailing commas.
  let action = find(`<!--\n{"@context": "https://schema.org", "@type": "Recipe", "name": "Pea\nSoup", "recipeIngredient": ["peas", "water",],}\n-->`);
  is(action?.name, "Pea Soup", "Loose JSON still reads");
  is(action?.ingredients.length, 2, "with its trailing comma dropped");

  action = find(`//<![CDATA[\n${soup("Cdata Soup")}\n//]]>`);
  is(action?.name, "Cdata Soup", "CDATA-wrapped");

  is(find(`{"@type": "recipe", "name": "Lower", "recipeIngredient": ["x"]}`)?.kind, "recipe", "Lower-case type");
  is(find(`{"@type": "schema:Recipe", "name": "Prefixed", "recipeIngredient": ["x"]}`)?.kind, "recipe", "schema: prefix");
  is(find(`{"@type": ["Recipe", "NewsArticle"], "name": "Both", "recipeIngredient": ["x"]}`)?.kind, "recipe", "Type array");

  // The recipe plus a carousel of related recipes.
  action = find(
    soup("Main Soup"),
    `{"@type": "ItemList", "itemListElement": [{"@type": "ListItem", "item": ${soup("Other Soup")}}, {"@type": "ListItem", "item": ${soup("Third Soup")}}]}`
  );
  is(action?.name, "Main Soup", "Related recipes in a list don't hide the page's own");

  // A ProductGroup and its variants (the price is on the variants).
  action = find(
    `{"@type": "ProductGroup", "name": "Tee", "hasVariant": [{"@type": "Product", "name": "Tee - S", "offers": {"@type": "Offer", "price": "20", "priceCurrency": "EUR"}}, {"@type": "Product", "name": "Tee - M"}]}`,
    `{"@type": "Product", "name": "Tee - S", "offers": {"price": "20", "priceCurrency": "EUR"}}`
  );
  is(action?.name, "Tee", "The product family");
  is(action?.offer?.price, "20", "priced from a variant");

  // Still nothing for a listing or several unrelated items.
  is(find(`[{"@type": "Event", "name": "One", "startDate": "2026-11-05"}, {"@type": "Event", "name": "Two", "startDate": "2026-11-06"}]`), null, "An events listing");
  is(find(`{"@type": "ItemList", "itemListElement": [{"@type": "ListItem", "item": ${soup("A")}}, {"@type": "ListItem", "item": ${soup("B")}}]}`), null, "A recipe listing");
  is(find("{not json at all"), null, "Broken JSON is ignored");
});
