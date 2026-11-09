/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// W23 page-act: shots for side-by-side checks against 05-page (3.2, 4.2,
// 4.5, 5.4, 6.2, 6.4, 6.6, 6.10, 6.11, 8.3, 9.1, 9.5, 10.2, 12.2) and
// fu-page (2.4, 4.3, 9.4, 10.4, dec-13), light and dark, plus the page
// bar's rise (mid 120ms). WHIMSY_SHOTS=<dir> writes w23-page-act-*.png.
// Firefox's translations panel (5.2) is a XUL panel drawSnapshot can't
// draw; its choice is checked in browser_whimsy_ai_translate.js.

const { WhimsyAIFill } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyAIFill.sys.mjs");
const { WhimsyAIPageEdits, WhimsyPageBar } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyAIPageEdits.sys.mjs");
const { WhimsyAITranslate } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyAITranslate.sys.mjs");
const { WhimsyAICompare } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyAICompare.sys.mjs");
const { WhimsyAIProviders } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyAIProviders.sys.mjs");
const { WhimsyAIReader } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyAIReader.sys.mjs");
const { WhimsyScamCheck } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyScamCheck.sys.mjs");
const { WhimsyPageActions } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyPageActions.sys.mjs");
const { WhimsyVerbs } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyVerbs.sys.mjs");
const { WhimsyChat } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyChat.sys.mjs");
const { gZenBoostsManager } = ChromeUtils.importESModule("resource:///modules/zen/boosts/ZenBoostsManager.sys.mjs");
const { UrlbarTestUtils } = ChromeUtils.importESModule("resource://testing-common/UrlbarTestUtils.sys.mjs");
UrlbarTestUtils.init(this);

const DIR = getRootDirectory(gTestPath).replace("chrome://mochitests/content", "");
const url = (name, host = "example.com") => `https://${host}${DIR}${name}`;
const NAME = state => `w23-page-act-${state}`;
const DRAFT = "Thanks both for the details. We found the cause: the video decoder isn’t restarted after sleep when PiP is open. The fix is in 1.4.3, out next week.";

let gate = null;

function provider(request) {
  const system = request.system ?? "";
  const prompt = request.prompt ?? "";
  if (/fill a web form/.test(system)) {
    const id = /- (\S+): "Delivery note"/.exec(prompt)?.[1];
    return JSON.stringify({ fields: id ? [{ id, value: "Leave with the concierge", from: "memory" }] : [] });
  }
  if (/change how a web page looks/.test(system)) {
    const sentence = /Sentence: (.*)/.exec(prompt)?.[1] ?? "";
    if (/expand/.test(sentence)) {
      return JSON.stringify({ hide: [], css: "", click: ["#comments summary"], done: "Expanded 2 comments" });
    }
    if (/weather/.test(sentence)) {
      return JSON.stringify({ hide: [], css: "", click: [], missing: "Couldn’t find a weather widget on this page." });
    }
    return JSON.stringify({ hide: ["#sidebar"], css: ".layout { grid-template-columns: 1fr !important; } article { font-size: 19px; }", click: [], done: "Hid the sidebar and made the text bigger" });
  }
  if (/find the same product/.test(system)) {
    return JSON.stringify([
      { store: "Amazon", url: "https://www.amazon.example/aria-5" },
      { store: "B&H Photo", url: "https://www.bhphoto.example/aria-5" },
      { store: "Costco", url: "https://www.costco.example/aria-5" },
    ]);
  }
  if (/read one store's product page/.test(system)) {
    if (/amazon/.test(prompt)) {
      return JSON.stringify({ found: true, price: 329.99, currency: "USD", shipping: 0, discounts: [{ label: "$25 coupon", amount: 25 }], delivery: "Tomorrow", returns: { cost: "free", days: 30 } });
    }
    if (/bhphoto/.test(prompt)) {
      return JSON.stringify({ found: true, price: 319, currency: "USD", shipping: 0, discounts: [], delivery: "Fri", returns: { cost: "label", fee: 9.95, days: 30 } });
    }
    if (/costco/.test(prompt)) {
      return JSON.stringify({ found: false, signIn: true });
    }
    return JSON.stringify({ found: true, price: 349, currency: "USD", shipping: 9.99, discounts: [{ label: "10% first order", amount: 34.9 }], delivery: "Thu", returns: { cost: "free", days: 30 } });
  }
  if (/act on the person's browser tabs/.test(system)) {
    const ids = re => prompt.split("\n").filter(l => re.test(l)).map(l => /^(t\d+):/.exec(l)?.[1]).filter(Boolean);
    return JSON.stringify({ action: "group", name: "Trip", ask: [{ label: "Store", tabs: ids(/Other store/) }, { label: "Night train", tabs: ids(/night train/i) }] });
  }
  return DRAFT;
}

add_setup(async function () {
  await SpecialPowers.pushPrefEnv({ set: [["whimsy.feature.ai-hints", false], ["whimsy.ai.order", "claude"]] });
  WhimsyAIProviders.setTestProvider(async function* (id, request) {
    await gate;
    if (request.task == "translate") {
      yield { type: "text", delta: request.messages.at(-1).content };
      return;
    }
    yield { type: "text", delta: provider(request) };
  });
  WhimsyAIFill._testSources = {
    addresses: [
      { name: "Priya Nair", email: "priya@example.com", "street-address": "18 Harbour Lane, Flat 3", "address-level2": "Bristol", "postal-code": "BS1 4RN", tel: "07700 900123" },
      { name: "Priya Nair", email: "priya@example.com", "street-address": "18 Harbour Lane, Flat 3", "address-level2": "Bristol", "postal-code": "BS1 4RN", tel: "07700 900456" },
    ],
    memories: [{ text: "Deliveries go to the concierge" }],
  };
  WhimsyAIReader.setTestReader(u => `Product page at ${u}`);
  WhimsyScamCheck._visitCount = () => 0;
  registerCleanupFunction(async () => {
    WhimsyAIProviders.setTestProvider(null);
    WhimsyAIFill._testSources = null;
    WhimsyAIReader.setTestReader(null);
    WhimsyScamCheck._visitCount = null;
    WhimsyPageBar.hide(window);
    for (const boost of gZenBoostsManager.loadBoostsFromStore("example.com") ?? []) {
      gZenBoostsManager.deleteBoost(boost);
    }
    Services.prefs.clearUserPref("whimsy.ai.page-edits");
    Services.prefs.clearUserPref("whimsy.ai.scam.trusted");
    if (WhimsyChat.isOpen(window)) {
      await WhimsyChat.close(window, { reason: "hide" });
    }
    closeToasts();
  });
});

async function lastCard(kind, done = true) {
  return TestUtils.waitForCondition(() => {
    const card = [...document.querySelectorAll(`.whimsy-pa-card[data-kind=${kind}]`)].at(-1);
    return card && (!done || !card.querySelector(".whimsy-pa-status")) && card;
  }, `The ${kind} card shows`);
}

async function inChat(prompt) {
  await WhimsyChat.open(window, { prompt, send: true });
}

async function closeChat() {
  if (WhimsyChat.isOpen(window)) {
    await WhimsyChat.close(window, { reason: "hide" });
  }
}

async function bar() {
  const shown = await TestUtils.waitForCondition(() => WhimsyPageBar.current(window), "The bar shows");
  await document.l10n.translateFragment(shown.el);
  return shown.el;
}

add_task(async function draft_and_fill_shots() {
  await BrowserTestUtils.withNewTab(url("whimsy_ai_reply.html"), async () => {
    await inChat("Draft a reply: we found it, fix ships in 1.4.3 next week");
    const card = await lastCard("draft");
    ok(card.querySelector("[data-l10n-id=whimsy-draft-written]"), "page-3.2: written, selected, not sent");
    await whimsyBothSchemes(NAME("page-3.2"), async () => {});
    await closeChat();
    closeToasts();
  });
  await BrowserTestUtils.withNewTab(url("whimsy_ai_reply.html"), async browser => {
    await BrowserTestUtils.synthesizeMouseAtCenter("#box", {}, browser);
    EventUtils.sendString("Thanks, looking into this. I think it’s the", window);
    await inChat("Draft a reply: we found it, fix ships in 1.4.3 next week");
    const card = await lastCard("draft");
    ok(card.querySelector(".whimsy-pa-btn.primary[data-button=insert-after]"), "fu-page 2.4: Insert after leads");
    await whimsyBothSchemes(NAME("fu-page-2.4"), async () => {});
    await closeChat();
  });
  await BrowserTestUtils.withNewTab(url("whimsy_ai_form.html"), async browser => {
    await inChat("Fill this in for me");
    const card = await lastCard("fill");
    ok(card.querySelector("[data-l10n-id=whimsy-fill-done-never]"), "page-4.2: filled, never sent");
    await whimsyBothSchemes(NAME("page-4.2"), async () => {});
    await SpecialPowers.spawn(browser, [], () => content.document.getElementById("card").focus());
    await whimsyBothSchemes(NAME("fu-page-4.3"), async () => {});
    await SpecialPowers.spawn(browser, [], () => content.document.getElementById("phone").focus());
    await whimsyBothSchemes(NAME("page-4.5"), async () => {});
    await closeChat();
  });
});

add_task(async function translate_and_edit_shots() {
  await BrowserTestUtils.withNewTab(url("whimsy_ai_article_edit.html"), async browser => {
    let release;
    gate = new Promise(r => (release = r));
    const translating = WhimsyAITranslate.translate(window, gBrowser.selectedTab, { from: "fr", to: "en" });
    const busy = await bar();
    ok(busy.querySelector("[data-button=stop]"), "page-5.4: top down, with Stop");
    await whimsyBothSchemes(NAME("page-5.4"), async () => {});
    release();
    gate = null;
    await translating;
    WhimsyPageBar.hide(window);
    await TestUtils.waitForCondition(() => !WhimsyPageBar.current(window), "Bar gone");

    const closeBar = async () => {
      await UrlbarTestUtils.promisePopupClose(window, () => gURLBar.view.close());
      gURLBar.blur();
      WhimsyVerbs.sessions.delete(window);
    };
    const changeMode = async value => {
      WhimsyVerbs.sessions.delete(window);
      await WhimsyAIPageEdits.prompt(window, { value });
      await TestUtils.waitForCondition(() => WhimsyVerbs.sessions.get(window)?.mode == "change-page", "⌘K is in Change this page");
      await UrlbarTestUtils.promiseSearchComplete(window);
      const ids = [];
      for (let i = 0; i < UrlbarTestUtils.getResultCount(window); i++) {
        ids.push((await UrlbarTestUtils.getDetailsOfResultAt(window, i)).result.payload.whimsyVerb);
      }
      return ids;
    };
    await whimsyBothSchemes(NAME("page-6.2"), async () => {
      const suggested = await changeMode("");
      Assert.deepEqual(suggested, ["change-page:whimsy-edit-suggest-comments", "change-page:whimsy-edit-suggest-bigger", "change-page:whimsy-edit-suggest-article"], "page-6.2: ⌘K in Change this page, with three suggestions");
      is(gURLBar.inputField.getAttribute("data-l10n-id"), "whimsy-edit-cmdk-placeholder", "page-6.2: Describe a change");
      ok(!WhimsyPageBar.current(window), "page-6.2: no bottom bar");
      await TestUtils.waitForCondition(() => gURLBar.view.panel.querySelector(".urlbarView-row[label]"), "page-6.2: a heading");
      const heading = gURLBar.view.panel.querySelector(".urlbarView-row[label]");
      is(heading?.getAttribute("label"), "Change this page", "page-6.2: the suggestions sit under Change this page");
      ok(heading?.querySelector(".urlbarView-title")?.textContent, "page-6.2: the headed row keeps its title");
      return closeBar;
    });
    is((await changeMode("hide the sidebar"))[0], "typed:change-page", "page-6.2: typing makes Change this page: …");
    await closeBar();

    // The model waits at the gate while the busy bar's rise is held at 120ms.
    let go;
    gate = new Promise(r => (go = r));
    const apply = WhimsyAIPageEdits.apply(window, gBrowser.selectedTab, "hide the sidebar and make the text bigger");
    await whimsyShotMid(NAME("page-6.4"), () => WhimsyPageBar.current(window)?.el.getAnimations()[0], 120);
    ok(true, "page-6.4: the bar's rise, mid");
    go();
    gate = null;
    await apply;
    const applied = await bar();
    ok(applied.querySelector(".primary[data-button=keep]"), "page-6.4: Keep on this site leads");
    await whimsyBothSchemes(NAME("page-6.4"), async () => {});
    const width = window.outerWidth;
    window.resizeTo(560, window.outerHeight);
    await TestUtils.waitForCondition(() => window.outerWidth <= 600, "Narrow window").catch(() => {});
    await whimsyBothSchemes(NAME("page-12.2"), async () => {});
    window.resizeTo(width, window.outerHeight);
    await TestUtils.waitForCondition(() => window.outerWidth == width, "Wide again").catch(() => {});
    WhimsyAIPageEdits.keep(window);
    await TestUtils.waitForCondition(() => document.querySelector("[data-l10n-id=whimsy-edit-saved-toast]"), "page-6.6: saved toast");
    await whimsyBothSchemes(NAME("page-6.6"), async () => {});
    closeToasts();
    // W23 secfix M5: page edits never press page controls, so page-6.10
    // (done once by clicking, never kept) is gone.
    await WhimsyAIPageEdits.apply(window, gBrowser.selectedTab, "hide the weather widget");
    await bar();
    await whimsyBothSchemes(NAME("page-6.11"), async () => {});
    WhimsyPageBar.hide(window);
  });
});

add_task(async function scam_shots() {
  for (const [state, page] of [["fu-page-dec-13", "whimsy_ai_scam.html"], ["page-8.3", "whimsy_ai_bakery.html"]]) {
    await BrowserTestUtils.withNewTab(url(page), async browser => {
      // Drawn: the shield goes in after the bar is localized and its message added.
      const notification = await TestUtils.waitForCondition(() => {
        const bar = gBrowser.getNotificationBox(browser).getNotificationWithValue("whimsy-scam-warning");
        return bar?.messageImage?.getAttribute("src") ? bar : null;
      }, "The warning shows");
      await document.l10n.translateFragment(notification);
      ok(notification, `${state}: the scam warning`);
      ok(notification.messageImage?.getAttribute("src")?.endsWith("tracking-protection.svg"), `${state}: a shield, not the warning triangle`);
      await whimsyBothSchemes(NAME(state), async () => {});
    });
  }
});

add_task(async function compare_and_tabs_shots() {
  await BrowserTestUtils.withNewTab(url("whimsy_ai_product.html"), async browser => {
    await TestUtils.waitForCondition(() => WhimsyPageActions.actionFor(browser)?.kind == "product", "A product page");
    const watch = WhimsyPageActions.pill(window);
    const [id, args] = WhimsyPageActions.l10nFor(WhimsyPageActions.actionFor(browser));
    document.l10n.setAttributes(watch.querySelector(".whimsy-page-action-label"), id, args);
    watch.querySelector(".whimsy-page-action-icon").setAttribute("src", "chrome://browser/skin/zen-icons/selectable/bell.svg");
    watch.hidden = false;
    ok(WhimsyAICompare.updatePill(window), "page-9.1: Compare after Watch price");
    await whimsyBothSchemes(NAME("page-9.1"), async () => {});
    await inChat("Compare prices");
    const card = await TestUtils.waitForCondition(() => document.querySelector(".whimsy-pa-card[data-kind=compare] .whimsy-pa-table")?.closest(".whimsy-pa-card"), "The table shows", 200, 100);
    ok(card.querySelector("tr.is-best"), "fu-page 9.4: ranked by true price");
    await whimsyBothSchemes(NAME("fu-page-9.4"), async () => {});
    ok(card.querySelector("[data-l10n-id=whimsy-compare-sign-in]"), "page-9.5: a store that needs sign-in");
    card.querySelector(".whimsy-pa-notice")?.scrollIntoView({ block: "end" });
    await whimsyBothSchemes(NAME("page-9.5"), async () => {});
    await closeChat();
    watch.hidden = true;
  });

  const tabs = [];
  for (const page of ["whimsy_ai_store.html", "whimsy_ai_store.html", "whimsy_ai_article_edit.html"]) {
    tabs.push(await BrowserTestUtils.openNewForegroundTab(gBrowser, url(page)));
  }
  WhimsyVerbs.sessions.delete(window);
  EventUtils.synthesizeKey("k", { accelKey: true });
  await TestUtils.waitForCondition(() => WhimsyVerbs.sessions.get(window), "⌘K opened");
  await UrlbarTestUtils.promiseSearchComplete(window);
  EventUtils.sendString("close the other store tabs", window);
  await UrlbarTestUtils.promiseSearchComplete(window);
  const { result } = await UrlbarTestUtils.getDetailsOfResultAt(window, 0);
  is(result.payload.whimsyVerb, "typed:tabs-close", "page-10.2: the typed request leads ⌘K");
  await whimsyBothSchemes(NAME("page-10.2"), async () => {});
  await UrlbarTestUtils.promisePopupClose(window, () => gURLBar.view.close());

  await inChat("Group my trip tabs");
  const ask = await lastCard("tabs-ask", false);
  ok(ask.querySelectorAll(".whimsy-pa-btn").length >= 2, "fu-page 10.4: choices");
  EventUtils.sendString("the store ones", window);
  await whimsyBothSchemes(NAME("fu-page-10.4"), async () => {});
  await closeChat();
  for (const tab of tabs) {
    BrowserTestUtils.removeTab(tab);
  }
});
