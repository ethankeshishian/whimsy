/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

const { WhimsyDarkPages } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyDarkPages.sys.mjs");
const { WhimsySiteSettings } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsySiteSettings.sys.mjs");
const ROOT = getRootDirectory(gTestPath).replace("chrome://mochitests/content", "https://example.com");
const PAGE = ROOT + "whimsy_dark_pages.html";
const MODE = "whimsy.dark-pages.mode";
const SITES = "whimsy.dark-pages.sites";

async function darkState(browser, expected) {
  await SpecialPowers.spawn(browser, [expected], async value => {
    await ContentTaskUtils.waitForCondition(
      () => content.document.documentElement.getAttribute("data-whimsy-dark-page") == value,
      `Page reached ${value}`
    );
  });
  await TestUtils.waitForCondition(() => WhimsyDarkPages.state(browser) == expected, "Chrome received the page's state");
  await SpecialPowers.spawn(browser, [], async () => {
    await new Promise(resolve => content.requestAnimationFrame(() => content.requestAnimationFrame(resolve)));
    await Promise.all(content.document.getAnimations().map(animation => animation.finished.catch(() => {})));
  });
}

async function colors(browser) {
  return SpecialPowers.spawn(browser, [], () => {
    const doc = content.document;
    const body = content.getComputedStyle(doc.body);
    const canvas = doc.createElementNS("http://www.w3.org/1999/xhtml", "canvas");
    canvas.width = content.innerWidth;
    canvas.height = content.innerHeight;
    const ctx = canvas.getContext("2d");
    ctx.drawWindow(content, 0, 0, canvas.width, canvas.height, "white");
    const pixel = (x, y) => [...ctx.getImageData(Math.round(x), Math.round(y), 1, 1).data];
    const title = doc.querySelector("h1").getBoundingClientRect();
    const textPixels = ctx.getImageData(title.x, title.y, title.width, title.height).data;
    let brightText = false;
    for (let i = 0; i < textPixels.length; i += 4) {
      brightText ||= Math.min(textPixels[i], textPixels[i + 1], textPixels[i + 2]) > 170;
    }
    const img = doc.querySelector("img");
    const rect = img.getBoundingClientRect();
    return {
      startScheme: content.wrappedJSObject.whimsySchemeAtStart,
      startCanvas: content.wrappedJSObject.whimsyCanvasAtStart,
      background: body.backgroundColor,
      color: body.color,
      paintedBackground: pixel(4, Math.min(content.innerHeight - 4, 150)),
      brightText,
      photo: content.getComputedStyle(img).filter,
      photoPixel: pixel(rect.x + rect.width / 2, rect.y + Math.min(rect.height / 2, 10)),
      scheme: content.matchMedia("(prefers-color-scheme: dark)").matches,
      inverted: content.browsingContext.isZenBoostsInverted,
      authoredRules: Array.from(doc.getElementById("authored-theme").sheet.cssRules, rule => rule.cssText),
      expectedRules: (() => {
        const sheet = new content.CSSStyleSheet();
        sheet.replaceSync(doc.getElementById("authored-theme").textContent);
        return Array.from(sheet.cssRules, rule => rule.cssText);
      })(),
    };
  });
}

add_setup(async function () {
  const defaults = Services.prefs.getDefaultBranch("");
  ok(defaults.getBoolPref("whimsy.feature.dark-pages"), "Dark pages ships enabled");
  is(defaults.getStringPref(MODE), "match", "The default follows Whimsy");
  ok(!defaults.getBoolPref("whimsy.dark-pages.dim-images"), "Dim images ships off");
  await SpecialPowers.pushPrefEnv({ set: [
    ["whimsy.feature.dark-pages", true], [MODE, "always"], [SITES, "{}"],
    ["whimsy.dark-pages.offered", true], ["whimsy.dark-pages.dim-images", false],
  ] });
});

