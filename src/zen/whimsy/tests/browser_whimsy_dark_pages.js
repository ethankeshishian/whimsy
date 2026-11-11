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
      sheetCount: doc.styleSheets.length,
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

add_task(async function authored_theme_then_generated_fallback() {
  await BrowserTestUtils.withNewTab(PAGE + "?theme=native", async browser => {
    await darkState(browser, "native");
    const native = await colors(browser);
    ok(native.scheme, "Gecko advertises dark to authored media queries and matchMedia");
    is(native.background, "rgb(24, 26, 32)", "Uses the site's exact dark background");
    is(native.color, "rgb(233, 230, 225)", "Uses the site's exact dark text");
    is(native.photo, "none", "Native-theme photos are untouched");
    ok(!native.inverted, "Native dark theme never enables inversion");
  });
  await BrowserTestUtils.withNewTab(PAGE, async browser => {
    await darkState(browser, "generated");
    const generated = await colors(browser);
    ok(generated.scheme, "Native dark was requested before generating colors");
    ok(generated.startScheme, "The first parser script already sees the dark preference");
    is(generated.startCanvas, "rgb(28, 27, 34)", "A dark document-start canvas prevents the initial white flash");
    ok(generated.inverted, "Reuses the existing Zen Boosts paint-time engine");
    const kept = await SpecialPowers.spawn(browser, [], () => {
      const { darkPagesInversion } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyDarkPagesConfig.sys.mjs");
      const bc = content.browsingContext;
      bc.isZenBoostsInverted = darkPagesInversion(bc, false);
      return bc.isZenBoostsInverted;
    });
    ok(kept, "A late no-boost result cannot erase adaptation");
    is(generated.background, "rgb(255, 255, 255)", "The site's computed colors remain authored");
    ok(Math.max(...generated.paintedBackground.slice(0, 3)) < 100, "Painted background is dark");
    ok(generated.brightText, "Painted text is readable on the generated dark canvas");
    is(generated.photo, "none", "Photos are never inverted, and default dimming is off");
    is(generated.sheetCount, 1, "Authored CSSOM was preserved");
    WhimsyDarkPages.setChoice(browser, "off");
    await darkState(browser, "original");
    const original = await colors(browser);
    Assert.deepEqual(generated.photoPixel, original.photoPixel, "The bitmap keeps its exact painted colors");
    WhimsyDarkPages.setChoice(browser, "automatic");
    await darkState(browser, "generated");
    await SpecialPowers.pushPrefEnv({ set: [["whimsy.dark-pages.dim-images", true]] });
    await SpecialPowers.spawn(browser, [], async () => {
      await ContentTaskUtils.waitForCondition(
        () => content.getComputedStyle(content.document.querySelector("img")).filter == "brightness(0.8)",
        "Opt-in dims the photo"
      );
    });
    await SpecialPowers.popPrefEnv();
  });
});

add_task(async function already_dark_is_untouched_and_switch_off_restores() {
  await BrowserTestUtils.withNewTab(PAGE + "?theme=already", async browser => {
    await darkState(browser, "native");
    const original = await colors(browser);
    is(original.background, "rgb(24, 26, 32)", "Already-dark page stays its exact authored color");
    is(original.photo, "none", "No image correction is applied");
    ok(!original.inverted, "Already-dark page never enables inversion");
  });
  await BrowserTestUtils.withNewTab(PAGE, async browser => {
    await darkState(browser, "generated");
    await SpecialPowers.pushPrefEnv({ set: [["whimsy.feature.dark-pages", false]] });
    await darkState(browser, "original");
    is((await colors(browser)).background, "rgb(255, 255, 255)", "Feature switch removes generated colors live");
    await SpecialPowers.popPrefEnv();
  });
});

add_task(async function first_conversion_toast_once_and_turn_off() {
  await SpecialPowers.pushPrefEnv({ set: [["whimsy.dark-pages.offered", false]] });
  try {
    await BrowserTestUtils.withNewTab(PAGE + "?theme=native", async browser => {
      await darkState(browser, "native");
      ok(!Services.prefs.getBoolPref("whimsy.dark-pages.offered"), "Native theme does not consume the offer");
    });
    await BrowserTestUtils.withNewTab(PAGE, async browser => {
      await darkState(browser, "generated");
      await TestUtils.waitForCondition(() => document.getElementById("whimsyDarkPagesTurnOff"), "Conversion shows the shared toast");
      const button = document.getElementById("whimsyDarkPagesTurnOff");
      ok(button.closest(".zen-toast"), "Uses the same styled component as other Whimsy toasts");
      EventUtils.synthesizeMouseAtCenter(button, {}, window);
      is(Services.prefs.getStringPref(MODE), "off", "Turn off disables Dark pages globally");
      await darkState(browser, "original");
      Services.prefs.setStringPref(MODE, "always");
      await darkState(browser, "generated");
      await TestUtils.waitForCondition(() => !document.getElementById("whimsyDarkPagesTurnOff"), "Offer does not reappear");
      ok(Services.prefs.getBoolPref("whimsy.dark-pages.offered"), "Offer is remembered across pages");
    });
    await BrowserTestUtils.withNewTab(PAGE, async browser => {
      await darkState(browser, "generated");
      ok(!document.getElementById("whimsyDarkPagesTurnOff"), "A new light page does not repeat the offer");
    });
  } finally {
    await SpecialPowers.popPrefEnv();
  }
});

add_task(async function per_site_persistence_and_private_isolation() {
  await BrowserTestUtils.withNewTab(PAGE, async browser => {
    await darkState(browser, "generated");
    WhimsyDarkPages.setChoice(browser, "off");
    await darkState(browser, "original");
    const saved = Services.prefs.getStringPref(SITES);
    is(WhimsyDarkPages.choice(browser), "off", "Original is remembered for the site");
    const loaded = BrowserTestUtils.browserLoaded(browser);
    browser.reload();
    await loaded;
    await darkState(browser, "original");
    is((await colors(browser)).background, "rgb(255, 255, 255)", "Persisted Original survives reload");
    const privateWindow = await BrowserTestUtils.openNewBrowserWindow({ private: true });
    try {
      await BrowserTestUtils.withNewTab({ gBrowser: privateWindow.gBrowser, url: PAGE }, async privateBrowser => {
        await darkState(privateBrowser, "generated");
        is(WhimsyDarkPages.choice(privateBrowser), "automatic", "Public exceptions do not leak into private visits");
        WhimsyDarkPages.setChoice(privateBrowser, "off");
        await darkState(privateBrowser, "original");
        is(Services.prefs.getStringPref(SITES), saved, "Private site choice never writes the profile");
      });
    } finally {
      await BrowserTestUtils.closeWindow(privateWindow);
    }
    const nextPrivate = await BrowserTestUtils.openNewBrowserWindow({ private: true });
    try {
      await BrowserTestUtils.withNewTab({ gBrowser: nextPrivate.gBrowser, url: PAGE }, async privateBrowser => {
        await darkState(privateBrowser, "generated");
        is(WhimsyDarkPages.choice(privateBrowser), "automatic", "Private choice is forgotten with the last private window");
      });
    } finally {
      await BrowserTestUtils.closeWindow(nextPrivate);
    }
    WhimsyDarkPages.setChoice(browser, "automatic");
    await darkState(browser, "generated");
    await SpecialPowers.pushPrefEnv({ set: [[MODE, "off"]] });
    await darkState(browser, "original");
    WhimsyDarkPages.setChoice(browser, "on");
    await darkState(browser, "generated");
    is(WhimsyDarkPages.choice(browser), "on", "Dark explicitly overrides the global default");
    WhimsyDarkPages.setChoice(browser, "automatic");
    await darkState(browser, "original");
    await SpecialPowers.popPrefEnv();
  });
});

add_task(async function preserves_existing_smart_invert() {
  await BrowserTestUtils.withNewTab(PAGE, async browser => {
    await darkState(browser, "generated");
    await SpecialPowers.spawn(browser, [], () => {
      const { darkPagesInversion } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyDarkPagesConfig.sys.mjs");
      const bc = content.browsingContext;
      bc.isZenBoostsInverted = darkPagesInversion(bc, true);
    });
    try {
      WhimsyDarkPages.setChoice(browser, "off");
      await darkState(browser, "original");
      ok((await colors(browser)).inverted, "Original restores the user's existing Smart Invert");
    } finally {
      await SpecialPowers.spawn(browser, [], () => {
        const { darkPagesInversion } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyDarkPagesConfig.sys.mjs");
        const bc = content.browsingContext;
        bc.isZenBoostsInverted = darkPagesInversion(bc, false);
      });
      WhimsyDarkPages.setChoice(browser, "automatic");
    }
  });
});

add_task(async function delayed_theme_and_long_page() {
  await BrowserTestUtils.withNewTab(PAGE, async browser => {
    await darkState(browser, "generated");
    await SpecialPowers.spawn(browser, [], () => {
      const fragment = content.document.createDocumentFragment();
      for (let i = 0; i < 5000; i++) {
        const p = content.document.createElement("p");
        p.textContent = "A contour joins points of equal height.";
        fragment.append(p);
      }
      content.document.querySelector("main").append(fragment);
      content.document.documentElement.className = "already";
    });
    await darkState(browser, "native");
    is((await colors(browser)).background, "rgb(24, 26, 32)", "Late native theme removes generated colors on a long page");
  });
});

add_task(async function match_whimsy_screenshots() {
  await SpecialPowers.pushPrefEnv({ set: [[MODE, "match"]] });
  try {
    await whimsyBothSchemes("w24-darkpages-match", async dark => {
      const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE);
      await darkState(tab.linkedBrowser, dark ? "generated" : "original");
      return () => BrowserTestUtils.removeTab(tab);
    });
  } finally {
    await SpecialPowers.popPrefEnv();
  }
});

add_task(async function screenshots() {
  for (const [name, theme, expected] of [
    ["generated", "light", "generated"], ["native", "native", "native"], ["already-dark", "already", "native"],
  ]) {
    await whimsyBothSchemes(`w24-darkpages-${name}`, async () => {
      const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE + "?theme=" + theme);
      await darkState(tab.linkedBrowser, expected);
      return () => BrowserTestUtils.removeTab(tab);
    });
  }
  await whimsyBothSchemes("w24-darkpages-original", async () => {
    const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE);
    await darkState(tab.linkedBrowser, "generated");
    WhimsyDarkPages.setChoice(tab.linkedBrowser, "off");
    await darkState(tab.linkedBrowser, "original");
    return () => {
      WhimsyDarkPages.setChoice(tab.linkedBrowser, "automatic");
      BrowserTestUtils.removeTab(tab);
    };
  });
  await whimsyBothSchemes("w24-darkpages-dim-images", async () => {
    await SpecialPowers.pushPrefEnv({ set: [["whimsy.dark-pages.dim-images", true]] });
    const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE);
    await darkState(tab.linkedBrowser, "generated");
    return async () => {
      BrowserTestUtils.removeTab(tab);
      await SpecialPowers.popPrefEnv();
    };
  });
  await whimsyBothSchemes("w24-darkpages-first-toast", async () => {
    await SpecialPowers.pushPrefEnv({ set: [["whimsy.dark-pages.offered", false]] });
    const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE);
    await darkState(tab.linkedBrowser, "generated");
    await TestUtils.waitForCondition(() => document.getElementById("whimsyDarkPagesTurnOff"), "First conversion offers Turn off");
    return async () => {
      gZenUIManager.toasts.getToasts({ includeClosing: true }).forEach(toast => toast.close({ instant: true }));
      BrowserTestUtils.removeTab(tab);
      await SpecialPowers.popPrefEnv();
    };
  });
  await whimsyBothSchemes("w24-darkpages-site-panel", async () => {
    const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE);
    await darkState(tab.linkedBrowser, "generated");
    gNavToolbox.setAttribute("zen-has-implicit-hover", "true");
    const panel = document.getElementById("zen-unified-site-data-panel");
    const shown = BrowserTestUtils.waitForEvent(panel, "popupshown");
    const moon = document.getElementById("whimsy-dark-page-button");
    ok(moon.checkVisibility(), "The moon is reachable beside the address");
    EventUtils.synthesizeMouseAtCenter(moon, {}, window);
    await shown;
    const row = document.querySelector('[whimsy-site-setting="dark-pages"]');
    ok(row?.checkVisibility(), "Dark page control is visible above Zoom");
    const zoom = document.querySelector('[whimsy-site-setting="zoom"]');
    ok(row.getBoundingClientRect().bottom <= zoom.getBoundingClientRect().top, "Matches the mockup's position");
    const undo = whimsyStandInPopups();
    return async () => {
      undo();
      await WhimsySiteSettings.hidePanel(window);
      gNavToolbox.removeAttribute("zen-has-implicit-hover");
      BrowserTestUtils.removeTab(tab);
    };
  });
  await whimsyBothSchemes("w24-darkpages-settings", async () => {
    const page = await BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE);
    await darkState(page.linkedBrowser, "generated");
    WhimsyDarkPages.setChoice(page.linkedBrowser, "off");
    await darkState(page.linkedBrowser, "original");
    const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, "about:preferences#zenLooks");
    await TestUtils.waitForCondition(() => tab.linkedBrowser.contentDocument?.getElementById("whimsyDarkPagesMode"), "Appearance control is initialized");
    const doc = tab.linkedBrowser.contentDocument;
    ok(!doc.getElementById("whimsyDarkPdf"), "PDF appearance is folded into the one global control");
    doc.getElementById("whimsyDarkPagesGroup").scrollIntoView({ block: "center" });
    ok(!doc.getElementById("whimsyDarkPagesSites").hidden, "Appearance lists the site's remembered exception and Reset");
    return () => {
      WhimsyDarkPages.setChoice(page.linkedBrowser, "automatic");
      BrowserTestUtils.removeTab(tab);
      BrowserTestUtils.removeTab(page);
    };
  });
});
