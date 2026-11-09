/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// W23 page-act: page edits by description (page-6.x). Hides keep as named
// zaps, style changes as one CSS-only Boost per sentence, anything needing
// script is done once and never kept, and Esc is Just this time.

const { WhimsyAIPageEdits, WhimsyPageBar, sanitizeCSS } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyAIPageEdits.sys.mjs");
const { WhimsyAIProviders } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyAIProviders.sys.mjs");
const { WhimsyZap } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyZap.sys.mjs");
const { gZenBoostsManager } = ChromeUtils.importESModule("resource:///modules/zen/boosts/ZenBoostsManager.sys.mjs");

const PAGE = getRootDirectory(gTestPath).replace("chrome://mochitests/content", "https://example.com") + "whimsy_ai_article_edit.html";
const DOMAIN = "example.com";

const PLANS = {
  "hide the sidebar": { hide: ["#sidebar"], css: "", click: [], done: "Hid the sidebar" },
  "make the text bigger": {
    hide: [],
    css: "body { font-size: 22px; } body { background: url(https://evil.example/x.png) } @import url(https://evil.example/a.css);",
    click: [],
    done: "Made the text bigger",
  },
  "expand every comment": { hide: [], css: "", click: ["#comments summary", "a", "#nope"], done: "Expanded 2 comments" },
  "hide the comments": { hide: ["#comments"], css: "", click: [], done: "Hid the comments" },
  "hide the weather widget": { hide: ["#weather"], css: "", click: [], done: "", missing: "Couldn’t find a weather widget on this page." },
};

function cleanBoosts() {
  for (const boost of gZenBoostsManager.loadBoostsFromStore(DOMAIN) ?? []) {
    gZenBoostsManager.deleteBoost(boost);
  }
  Services.prefs.clearUserPref("whimsy.ai.page-edits");
}

add_setup(async function () {
  await SpecialPowers.pushPrefEnv({ set: [["whimsy.feature.ai-hints", false]] });
  WhimsyAIProviders.setTestProvider(async request => {
    const sentence = /Sentence: (.*)/.exec(request.prompt)?.[1];
    return JSON.stringify(PLANS[sentence] ?? { hide: [], css: "", click: [] });
  });
  registerCleanupFunction(() => {
    WhimsyAIProviders.setTestProvider(null);
    WhimsyPageBar.hide(window);
    cleanBoosts();
    closeToasts();
  });
});

const display = (browser, selector) => SpecialPowers.spawn(browser, [selector], s => content.getComputedStyle(content.document.querySelector(s)).display);

async function barShown() {
  const bar = await TestUtils.waitForCondition(() => WhimsyPageBar.current(window), "The bar shows");
  await TestUtils.waitForCondition(() => bar.el.getBoundingClientRect().width > 0 && bar.el.querySelector("button"), "Laid out");
  await document.l10n.translateFragment(bar.el);
  return bar.el;
}

add_task(async function hide_saves_named_zap() {
  await BrowserTestUtils.withNewTab(PAGE, async browser => {
    const result = await WhimsyAIPageEdits.apply(window, gBrowser.selectedTab, "hide the sidebar");
    is(result.kind, "zap", "A hide is a zap");
    is(await display(browser, "#sidebar"), "none", "Applied live, before anything is saved");
    const bar = await barShown();
    const keep = bar.querySelector("[data-button=keep]");
    ok(keep.classList.contains("primary"), "Keep on this site is the default");
    await TestUtils.waitForCondition(() => bar.ownerDocument.activeElement == keep, "The bar takes focus");
    EventUtils.synthesizeKey("KEY_Enter");
    await TestUtils.waitForCondition(() => !WhimsyPageBar.current(window), "Enter keeps it");
    ok(WhimsyZap.getZapSelectors(DOMAIN).includes("#sidebar"), "Saved as a zapped element");
    is(WhimsyAIPageEdits.zapName(DOMAIN, "#sidebar"), "hide the sidebar", "Named by the sentence");
    is(WhimsyAIPageEdits.edits(DOMAIN).boosts.length, 0, "Not a Boost");
  });
  cleanBoosts();
  closeToasts();
});

add_task(async function style_saves_css_only_boost() {
  await BrowserTestUtils.withNewTab(PAGE, async browser => {
    const result = await WhimsyAIPageEdits.apply(window, gBrowser.selectedTab, "make the text bigger");
    is(result.kind, "boost", "A style change is a Boost");
    ok(!/url\(|@import|evil/.test(result.css), "Its CSS can't load anything");
    is(await SpecialPowers.spawn(browser, [], () => content.getComputedStyle(content.document.body).fontSize), "22px", "Applied live");
    const bar = await barShown();
    EventUtils.synthesizeMouseAtCenter(bar.querySelector("[data-button=keep]"), {});
    await TestUtils.waitForCondition(() => !WhimsyPageBar.current(window), "Kept");
    const boosts = WhimsyAIPageEdits.edits(DOMAIN).boosts;
    is(boosts.length, 1, "One Boost for the sentence");
    is(boosts[0].sentence, "make the text bigger", "Named by it");
    const css = gZenBoostsManager.loadActiveBoostFromStore(DOMAIN).boostEntry.boostData.customCSS;
    ok(css.includes("font-size: 22px"), "The site's Boost has the CSS");
    ok(!/url\(|@import|evil|<script/i.test(css), "Only CSS, nothing that loads or runs");
    WhimsyAIPageEdits.setBoostOn(DOMAIN, boosts[0].id, false);
    ok(!gZenBoostsManager.loadActiveBoostFromStore(DOMAIN).boostEntry.boostData.customCSS.includes("22px"), "Turn Off takes it out");
  });
  is(sanitizeCSS("a { behavior: url(x.htc); -moz-binding: url(x) } b { color: red }").includes("color: red"), true, "Plain CSS stays");
  cleanBoosts();
  closeToasts();
});

add_task(async function script_never_saved() {
  await BrowserTestUtils.withNewTab(PAGE, async browser => {
    const result = await WhimsyAIPageEdits.apply(window, gBrowser.selectedTab, "expand every comment");
    is(result.kind, "script", "Needs the page's code");
    is(result.clicked, 2, "Only the disclosure controls were pressed, never links");
    const open = await SpecialPowers.spawn(browser, [], () => [...content.document.querySelectorAll("details")].every(d => d.open));
    ok(open, "Done for now");
    const bar = await barShown();
    ok(bar.querySelector("[data-button=keep]").disabled, "Keep isn't available");
    is(bar.querySelector("small").getAttribute("data-l10n-id"), "whimsy-edit-script-why", "And says why");
    ok(!WhimsyAIPageEdits.keep(window), "Keep refuses it");
    EventUtils.synthesizeMouseAtCenter(bar.querySelector("[data-button=done]"), {});
    await TestUtils.waitForCondition(() => !WhimsyPageBar.current(window), "Done closes the bar");
    is(WhimsyAIPageEdits.edits(DOMAIN).boosts.length, 0, "No Boost");
    is(WhimsyZap.getZapSelectors(DOMAIN).length, 0, "No zap");
  });
});

add_task(async function just_this_time_esc() {
  await BrowserTestUtils.withNewTab(PAGE, async browser => {
    await WhimsyAIPageEdits.apply(window, gBrowser.selectedTab, "hide the comments");
    await barShown();
    await TestUtils.waitForCondition(() => document.activeElement?.closest(".whimsy-page-bar"), "The bar has focus");
    EventUtils.synthesizeKey("KEY_Escape");
    await TestUtils.waitForCondition(() => !WhimsyPageBar.current(window), "Esc is Just this time");
    is(await display(browser, "#comments"), "none", "The change stays on the page for now");
    is(WhimsyZap.getZapSelectors(DOMAIN).length, 0, "Nothing saved");
    is(WhimsyAIPageEdits.zapName(DOMAIN, "#comments"), null, "No name stored");

    // Undo puts the page back.
    await WhimsyAIPageEdits.apply(window, gBrowser.selectedTab, "hide the sidebar");
    const bar = await barShown();
    EventUtils.synthesizeMouseAtCenter(bar.querySelector("[data-button=undo]"), {});
    await TestUtils.waitForCondition(async () => (await display(browser, "#sidebar")) != "none", "Undo shows the sidebar again");

    // Not found: one line, nothing changed.
    const missing = await WhimsyAIPageEdits.apply(window, gBrowser.selectedTab, "hide the weather widget");
    is(missing.kind, "missing", "Couldn't find it");
    const miss = await barShown();
    ok(miss.querySelector("[data-button=retry]"), "Try other words");
    await TestUtils.waitForCondition(() => document.activeElement == miss.querySelector("[data-button=retry]"), "The bar has focus");
    EventUtils.synthesizeKey("KEY_Escape");
    await TestUtils.waitForCondition(() => !WhimsyPageBar.current(window), "Esc dismisses");
  });
  cleanBoosts();
});
