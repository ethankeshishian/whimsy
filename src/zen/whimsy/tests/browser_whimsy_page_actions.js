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
