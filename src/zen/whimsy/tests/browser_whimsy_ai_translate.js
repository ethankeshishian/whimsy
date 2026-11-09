/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// W23 page-act: "Translate better with <provider>" in Firefox's panel (off
// by default, remembered per language pair) and AI page translation: top
// down in sections, handoff when a provider is out, Firefox's engine when
// nobody can go on (page-5.1–5.6).

const { WhimsyAITranslate } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyAITranslate.sys.mjs");
const { WhimsyAIProviders, WhimsyAIError } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyAIProviders.sys.mjs");
const { WhimsyPageBar } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyAIPageEdits.sys.mjs");

const PAGE = getRootDirectory(gTestPath).replace("chrome://mochitests/content", "https://example.com") + "whimsy_ai_article_edit.html";

let outOf = new Set();
const seen = [];

add_setup(async function () {
  await SpecialPowers.pushPrefEnv({
    set: [
      ["whimsy.feature.ai-hints", false],
      ["whimsy.ai.order", "claude,openai"],
      ["whimsy.ai.translate.pairs", ""],
    ],
  });
  WhimsyAIProviders.setTestProvider(async function* (provider, request) {
    seen.push(provider);
    if (outOf.has(provider)) {
      throw new WhimsyAIError("plan-limit");
    }
    const text = request.messages.at(-1).content;
    yield { type: "text", delta: text.split("\n").map(line => line.replace(/^(\d+)\. /, `$1. [${provider}] `)).join("\n") };
  });
  registerCleanupFunction(() => {
    WhimsyAIProviders.setTestProvider(null);
    WhimsyAIProviders.clearResting("claude");
    WhimsyAIProviders.clearResting("openai");
    WhimsyPageBar.hide(window);
  });
});

add_task(async function translate_better_choice_off_by_default_remembered_per_pair() {
  ok(!WhimsyAITranslate.isChosen("fr", "en"), "Off by default");
  is(WhimsyAITranslate.provider(), "claude", "Named for the first provider that can translate");
  // Firefox's panel, built from its template as it is when it opens.
  ok(window.FullPageTranslationsPanel.elements, "The translations panel is built");
  const languages = WhimsyAITranslate.languages;
  let pair = { from: "fr", to: "en" };
  WhimsyAITranslate.languages = () => pair;
  try {
    const choice = WhimsyAITranslate.decorate(window);
    ok(choice, "The choice sits under the languages");
    is(choice.previousElementSibling?.id, "full-page-translations-panel-lang-selection", "Right under them");
    is(choice.getAttribute("aria-checked"), "false", "Unticked");
    await document.l10n.translateFragment(choice);
    ok(choice.querySelector(".whimsy-translate-name").textContent.includes("Claude"), "Named for Claude");
    const button = document.getElementById("full-page-translations-panel-translate");
    isnot(button.getAttribute("data-l10n-id"), "whimsy-translate-with", "Translate keeps Firefox's words");

    WhimsyAITranslate.setChosen("fr", "en", true);
    WhimsyAITranslate.decorate(window);
    is(choice.getAttribute("aria-checked"), "true", "Ticked");
    is(button.getAttribute("data-l10n-id"), "whimsy-translate-with", "Translate is renamed for the provider");
    ok(WhimsyAITranslate.isChosen("fr", "en"), "Remembered for French to English");

    pair = { from: "de", to: "en" };
    WhimsyAITranslate.decorate(window);
    is(choice.getAttribute("aria-checked"), "false", "Per language pair, not per site");
    isnot(button.getAttribute("data-l10n-id"), "whimsy-translate-with", "Firefox's Translate again");
  } finally {
    WhimsyAITranslate.languages = languages;
    WhimsyAITranslate.setChosen("fr", "en", false);
  }
  is(Services.prefs.getStringPref("whimsy.ai.translate.pairs"), "", "Unticking forgets the pair");
});

add_task(async function quota_falls_to_firefox_engine() {
  const firefox = WhimsyAITranslate._firefoxTranslate;
  let firefoxCalls = 0;
  WhimsyAITranslate._firefoxTranslate = async () => firefoxCalls++;
  try {
    await BrowserTestUtils.withNewTab(PAGE, async browser => {
      // Claude is out before the first section: ChatGPT takes over.
      outOf = new Set(["claude"]);
      let result = await WhimsyAITranslate.translate(window, gBrowser.selectedTab, { from: "fr", to: "en" });
      is(result.by, "openai", "The next enabled provider translated");
      ok(result.done >= 1 && result.done == result.total, "Every section, top down");
      const text = await SpecialPowers.spawn(browser, [], () => content.document.querySelector("article p").textContent);
      ok(text.startsWith("[openai]"), "The page text was swapped in");
      is(firefoxCalls, 0, "Firefox's engine wasn't needed");
      const bar = WhimsyPageBar.current(window);
      ok(bar, "The done bar shows");
      ok(bar.el.querySelector("[data-button=original]"), "With Show original");
      EventUtils.synthesizeMouseAtCenter(bar.el.querySelector("[data-button=original]"), {});
      await SpecialPowers.spawn(browser, [], async () => {
        await ContentTaskUtils.waitForCondition(() => !content.document.querySelector("article p").textContent.startsWith("["), "Original back");
      });

      // Nobody left: Firefox's engine finishes.
      outOf = new Set(["claude", "openai"]);
      WhimsyAIProviders.clearResting("claude");
      WhimsyAIProviders.clearResting("openai");
      result = await WhimsyAITranslate.translate(window, gBrowser.selectedTab, { from: "fr", to: "en" });
      is(result.by, "firefox", "Handed to Firefox's engine");
      is(firefoxCalls, 1, "Firefox translated the rest");
      WhimsyPageBar.hide(window);
    });
  } finally {
    WhimsyAITranslate._firefoxTranslate = firefox;
    outOf = new Set();
    WhimsyAIProviders.clearResting("claude");
    WhimsyAIProviders.clearResting("openai");
  }
});
