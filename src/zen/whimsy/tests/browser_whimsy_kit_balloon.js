/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// Firefox's mascot Kit and the Firefox logo glyphs are swapped for Whimsy's
// balloon with chrome overrides (src/zen/whimsy/jar.inc.mn), so Firefox's
// files stay untouched. Covers every overridden URL resolving to Whimsy's art,
// Settings' default-browser promo showing the balloon at Kit's size, and
// Settings' About Whimsy icon being Whimsy's logo.

const KIT = ["happy", "concerned", "confetti", "holding-lock", "in-circle", "sympathetic"];
const NEWTAB = "chrome://newtab/content/data/content/assets/";
const NEWTAB_KIT = {
  "kit-in-circle.svg": "in-circle",
  "kit-circle-animated.svg": "in-circle",
  "widget-privacy-kit.svg": "in-circle",
  "kit.png": "in-circle",
  "kit-stocks-watchlist.svg": "happy",
};
const LOGOS = {
  "chrome://browser/skin/sidebar/firefox.svg": "whimsy-mono",
  "chrome://browser/content/logos/share-firefox.svg": "share-whimsy",
  "chrome://browser/skin/window-firefox.svg": "window-whimsy",
};

async function text(url) {
  const response = await fetch(url);
  ok(response.ok, `${url} loads`);
  return response.text();
}

async function assertBalloon(url, art) {
  const svg = await text(url);
  ok(svg.includes('id="whimsy-kit-balloon"'), `${url} is the Whimsy balloon`);
  ok(svg.includes(`data-whimsy-art="balloon-${art}"`), `${url} is the ${art} balloon`);
}

add_task(async function test_kit_urls_are_the_balloon() {
  for (const name of KIT) {
    await assertBalloon(`chrome://global/skin/illustrations/kit-${name}.svg`, name);
  }
  for (const [file, art] of Object.entries(NEWTAB_KIT)) {
    await assertBalloon(NEWTAB + file, art);
  }
});

add_task(async function test_balloons_keep_kits_size() {
  // Kit's intrinsic sizes, so promos and pages don't shift.
  const sizes = {
    happy: [50, 40],
    concerned: [50, 40],
    confetti: [80, 60],
    "holding-lock": [80, 100],
    "in-circle": [120, 120],
    sympathetic: [250, 250],
  };
  for (const [name, [w, h]] of Object.entries(sizes)) {
    const img = new Image();
    img.src = `chrome://global/skin/illustrations/kit-${name}.svg`;
    await img.decode();
    is(img.naturalWidth, w, `kit-${name} keeps Kit's width`);
    is(img.naturalHeight, h, `kit-${name} keeps Kit's height`);
  }
});

add_task(async function test_logo_glyphs_are_whimsy() {
  for (const [url, art] of Object.entries(LOGOS)) {
    const svg = await text(url);
    ok(svg.includes('id="whimsy-logo"'), `${url} is Whimsy's logo (${art})`);
    ok(svg.includes("context-fill"), `${url} still follows the icon colour`);
  }
});

add_task(async function test_settings_default_browser_promo() {
  await BrowserTestUtils.withNewTab("about:preferences#general", async browser => {
    const doc = browser.contentDocument;
    const isDefault = await TestUtils.waitForCondition(
      () => doc.getElementById("isDefaultPane"),
      "The default-browser promo is built"
    );
    is(isDefault.localName, "moz-promo", "The promo is a moz-promo");
    const src = isDefault.getAttribute("imagesrc");
    ok(src.endsWith("kit-happy.svg"), "The 'Whimsy is your default browser' promo uses the happy image");
    await assertBalloon(src, "happy");

    const notDefault = doc.getElementById("isNotDefaultPane");
    await assertBalloon(notDefault.getAttribute("imagesrc"), "concerned");

    // Whichever promo shows, its image renders as the balloon at Kit's size.
    const shown = [isDefault, notDefault].find(p => p.checkVisibility());
    if (shown) {
      await shown.updateComplete;
      const img = shown.shadowRoot.querySelector("img");
      await TestUtils.waitForCondition(() => img.complete && img.naturalWidth, "The promo image loads");
      is(img.naturalWidth, 50, "The promo image keeps Kit's width");
      is(img.naturalHeight, 40, "The promo image keeps Kit's height");
    }
  });
});

add_task(async function test_settings_about_icon() {
  await BrowserTestUtils.withNewTab("about:preferences", async browser => {
    const doc = browser.contentDocument;
    const nav = await TestUtils.waitForCondition(
      () => doc.getElementById("category-about-firefox"),
      "The About Whimsy category exists"
    );
    const src = nav.getAttribute("iconsrc");
    is(src, "chrome://browser/skin/sidebar/firefox.svg", "About uses the app logo glyph");
    ok((await text(src)).includes('id="whimsy-logo"'), "Settings' About icon is Whimsy's logo");
  });
});
