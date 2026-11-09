/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// W23 page-act: Compare (page-9.1–9.5, fu-page 9.4). The pill sits right
// after Watch price; stores are read in the hidden reader with no history;
// the table ranks by true price with the sum spelled out.

const { WhimsyAICompare, cleanUrl } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyAICompare.sys.mjs");
const { WhimsyAIProviders } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyAIProviders.sys.mjs");
const { WhimsyPageActions } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyPageActions.sys.mjs");
const { WhimsyVerbs } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyVerbs.sys.mjs");
const { WhimsyChat } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyChat.sys.mjs");
const { PlacesUtils } = ChromeUtils.importESModule("resource://gre/modules/PlacesUtils.sys.mjs");

const DIR = getRootDirectory(gTestPath).replace("chrome://mochitests/content", "");
const PRODUCT = `https://example.com${DIR}whimsy_ai_product.html`;
const STORE = `https://example.org${DIR}whimsy_ai_store.html`;
const read = [];

function provider(request) {
  const system = request.system ?? "";
  if (/find the same product/.test(system)) {
    return JSON.stringify([
      { store: "B&H Photo", url: `${STORE}?tag=aff-123&utm_source=whimsy&color=black` },
      { store: "Coupon Hub", url: "https://coupons.example/aria-5" },
      { store: "Intranet", url: "http://192.168.1.20/aria" },
    ]);
  }
  if (/read one store's product page/.test(system)) {
    read.push(request.prompt);
    if (/\$319\.00/.test(request.prompt)) {
      return JSON.stringify({ found: true, price: 319, currency: "USD", shipping: 0, discounts: [], delivery: "Fri", returns: { cost: "label", fee: 9.95, days: 30 } });
    }
    return JSON.stringify({
      found: true,
      price: 349,
      currency: "USD",
      shipping: 9.99,
      discounts: [{ label: "10% first order", amount: 34.9 }, { label: "bogus", amount: 9999 }],
      delivery: "Thu",
      returns: { cost: "free", days: 30 },
    });
  }
  return "";
}

add_setup(async function () {
  await SpecialPowers.pushPrefEnv({ set: [["whimsy.feature.ai-hints", false], ["whimsy.feature.page-actions", true]] });
  WhimsyAIProviders.setTestProvider(async request => provider(request));
  registerCleanupFunction(async () => {
    WhimsyAIProviders.setTestProvider(null);
    if (WhimsyChat.isOpen(window)) {
      await WhimsyChat.close(window, { reason: "hide" });
    }
    await PlacesUtils.history.clear();
  });
});

async function productTab(browser) {
  await TestUtils.waitForCondition(() => WhimsyPageActions.actionFor(browser)?.kind == "product", "The page is a product");
}

add_task(async function compare_after_watch_price() {
  await BrowserTestUtils.withNewTab(PRODUCT, async browser => {
    await productTab(browser);
    const watch = WhimsyPageActions.pill(window);
    const pill = WhimsyAICompare.updatePill(window);
    ok(pill && !pill.hidden, "Compare shows on a product page");
    is(pill.previousElementSibling, watch, "Right after Watch price, which never moves");
    ok(WhimsyVerbs.registered.some(v => v.id == "compare" && v.group == "product"), "⌘K leads with it on product pages");
  });
  const pill = document.getElementById("whimsy-compare-action");
  WhimsyAICompare.updatePill(window);
  ok(!pill || pill.hidden, "Gone off the product page");
});

add_task(async function true_price_sum_spelled_out() {
  const tp = WhimsyAICompare.truePrice({ price: 349, shipping: 9.99, discounts: [{ label: "10% first order", amount: 34.9 }, { label: "too big", amount: 5000 }] });
  is(tp.total, 324.09, "Price + shipping − what applies");
  is(tp.discounts.length, 1, "A discount bigger than the price is dropped");
  is(WhimsyAICompare.sumText(tp, "USD"), "$349.00 + $9.99 shipping − 10% first order", "The sum, spelled out");
  const free = WhimsyAICompare.truePrice({ price: 319, shipping: 0 });
  is(WhimsyAICompare.sumText(free, "USD"), "$319.00 + free shipping", "Free shipping");
  const unknown = WhimsyAICompare.truePrice({ price: 300, shipping: null });
  ok(!unknown.shippingShown, "No shipping shown on the page");
  is(WhimsyAICompare.sumText(unknown, "USD"), "$300.00 + shipping not shown", "The cell says so instead of guessing");
  const { table } = WhimsyAICompare.table([
    { store: "Here", host: "here", here: true, tp: WhimsyAICompare.truePrice({ price: 349, shipping: 9.99 }), currency: "USD" },
    { store: "Unknown", host: "u", tp: unknown, currency: "USD" },
    { store: "Cheap", host: "c", tp: free, currency: "USD" },
  ]);
  Assert.deepEqual(table.rows.map(r => r.key), ["c", "here", "u"], "Ranked by true price, unknown shipping last");
  is(cleanUrl("https://shop.example/p?tag=aff-1&utm_medium=x&size=m"), "https://shop.example/p?size=m", "Affiliate and tracking parameters go");
  is(cleanUrl("http://shop.example/p"), null, "Only https stores");
});

add_task(async function compare_leaves_no_history() {
  await PlacesUtils.history.clear();
  await BrowserTestUtils.withNewTab(PRODUCT, async browser => {
    await productTab(browser);
    await WhimsyChat.open(window, { prompt: "Compare prices", send: true });
    const table = await TestUtils.waitForCondition(() => document.querySelector(".whimsy-pa-card[data-kind=compare] .whimsy-pa-table"), "The table shows", 200, 100);
    const rows = [...table.querySelectorAll("tr")].slice(1);
    is(rows.length, 2, "This store and the one other real store");
    is(rows[0].dataset.store, "example.org", "The cheapest true price leads");
    ok(rows[0].classList.contains("is-best"), "Marked best");
    const sums = rows.map(r => r.querySelector("td:nth-child(2) small").textContent);
    is(sums[1], "$349.00 + $9.99 shipping − 10% first order", "Here: the sum spelled out");
    ok(rows[1].querySelector("td:nth-child(2) b").textContent.includes("324.09"), "And its true price");
    const link = rows[0].querySelector("a.whimsy-pa-store");
    ok(!/tag=|utm_/.test(link.getAttribute("href")), "No affiliate links");
    is(read.length, 2, "Only this page and the real store were read: no coupon site, no local network");
    ok(!(await PlacesUtils.history.hasVisits(STORE)), "The store visit left no history");
    ok(!(await PlacesUtils.history.hasVisits(`${STORE}?color=black`)), "Not under its cleaned address either");
    const state = await SpecialPowers.spawn(browser, [], () => content.location.href);
    is(state, PRODUCT, "Nothing was added to a cart or clicked here");
    await WhimsyChat.close(window, { reason: "hide" });
  });
});
