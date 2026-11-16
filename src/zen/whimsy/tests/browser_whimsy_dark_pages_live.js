/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// browser-chrome loads only head.js automatically; load this suite explicitly.
Services.scriptloader.loadSubScript(
  getRootDirectory(gTestPath) + "head_whimsy_dark_pages.js",
  this
);

requestLongerTimeout(2);

const FEATURE = "whimsy.feature.dark-pages";

// A same-origin frame, to check that the frame follows the page live too.
async function addFrame(browser) {
  await SpecialPowers.spawn(browser, [PAGE], async src => {
    const frame = content.document.createElement("iframe");
    frame.src = src + "?theme=native";
    const loaded = new Promise(resolve => frame.addEventListener("load", resolve, { once: true }));
    content.document.body.append(frame);
    await loaded;
  });
}

async function frameScheme(browser, dark) {
  await SpecialPowers.spawn(browser.browsingContext.children[0], [dark], async value => {
    await ContentTaskUtils.waitForCondition(
      () => content.matchMedia("(prefers-color-scheme: dark)").matches == value,
      `The frame sees ${value ? "dark" : "light"}`
    );
  });
}

async function paintedDark(browser) {
  const painted = await colors(browser);
  return Math.max(...painted.paintedBackground.slice(0, 3)) < 100;
}

// Owner bug (W29): turning automatic dark mode on did nothing on google.com
// until a reload. Whimsy's startup hook runs after session restore, so a
// page that was already open never got the dark-pages child. Every control
// must take effect live on such a page, and turning off must restore it.
add_task(async function page_open_before_startup_hook_follows_every_control() {
  await SpecialPowers.pushPrefEnv({ set: [[MODE, "off"]] });
  await whimsySetScheme(false);
  // The order at startup: the restored page loads first, Whimsy registers
  // its page actors after.
  ChromeUtils.unregisterWindowActor("WhimsyDarkPages");
  WhimsyDarkPages._actorRegistered = false;
  let registered = false;
  try {
    await BrowserTestUtils.withNewTab(PAGE, async browser => {
      await addFrame(browser);
      WhimsyDarkPages.registerActor();
      registered = true;
      const windowId = browser.innerWindowID;
      ok(!(await paintedDark(browser)), "The page starts light");

      // Settings: Dark pages → Always.
      await SpecialPowers.pushPrefEnv({ set: [[MODE, "always"]] });
      await darkState(browser, "generated");
      ok(await paintedDark(browser), "Always turns the already-open page dark live");
      await frameScheme(browser, true);
      await SpecialPowers.pushPrefEnv({ set: [[MODE, "off"]] });
      await darkState(browser, "original");
      const restored = await colors(browser);
      ok(!restored.inverted && !restored.scheme, "Off restores the page live");
      ok(!(await paintedDark(browser)), "Off paints the page light again");
      await frameScheme(browser, false);

      // The site panel's Automatic dark mode switch (and the moon).
      WhimsyDarkPages.setDark(browser, true);
      await darkState(browser, "generated");
      ok(await paintedDark(browser), "The site switch turns the page dark live");
      WhimsyDarkPages.setDark(browser, false);
      await darkState(browser, "original");
      ok(!(await paintedDark(browser)), "The site switch restores the page live");

      // The feature switch.
      await SpecialPowers.pushPrefEnv({ set: [[MODE, "always"], [FEATURE, false]] });
      await darkState(browser, "original");
      await SpecialPowers.pushPrefEnv({ set: [[FEATURE, true]] });
      await darkState(browser, "generated");
      ok(await paintedDark(browser), "Turning the feature on applies live");
      await SpecialPowers.pushPrefEnv({ set: [[FEATURE, false]] });
      await darkState(browser, "original");
      ok(!(await paintedDark(browser)), "Turning the feature off restores live");
      is(browser.innerWindowID, windowId, "Every change applied to the same document, without a reload");
      for (let i = 0; i < 5; i++) {
        await SpecialPowers.popPrefEnv();
      }
    });
  } finally {
    if (!registered) {
      WhimsyDarkPages.registerActor();
    }
    await SpecialPowers.popPrefEnv();
    await SpecialPowers.popPrefEnv();
  }
});

// A page loaded while the feature was off still has a listening child.
add_task(async function page_loaded_with_feature_off_turns_on_live() {
  await SpecialPowers.pushPrefEnv({ set: [[MODE, "always"], [FEATURE, false]] });
  await whimsySetScheme(false);
  await BrowserTestUtils.withNewTab(PAGE, async browser => {
    await addFrame(browser);
    ok(!(await paintedDark(browser)), "The page loads light while the feature is off");
    const windowId = browser.innerWindowID;
    await SpecialPowers.pushPrefEnv({ set: [[FEATURE, true]] });
    await darkState(browser, "generated");
    ok(await paintedDark(browser), "Turning the feature on applies live");
    await frameScheme(browser, true);
    await SpecialPowers.popPrefEnv();
    await darkState(browser, "original");
    ok(!(await paintedDark(browser)), "Turning it off restores live");
    await frameScheme(browser, false);
    is(browser.innerWindowID, windowId, "No reload");
  });
  await SpecialPowers.popPrefEnv();
  await SpecialPowers.popPrefEnv();
});

// A page whose address isn't its origin: a CSP sandbox gives it an opaque
// principal. The site switch is keyed by address, in chrome and in the page.
add_task(async function sandboxed_page_follows_the_site_switch() {
  await SpecialPowers.pushPrefEnv({ set: [[MODE, "off"]] });
  await whimsySetScheme(false);
  await BrowserTestUtils.withNewTab(ROOT + "whimsy_dark_pages_sandbox.html", async browser => {
    await darkState(browser, "original");
    ok(await SpecialPowers.spawn(browser, [], () => content.document.nodePrincipal.isNullPrincipal),
      "The page runs in a sandbox");
    WhimsyDarkPages.setDark(browser, true);
    await darkState(browser, "generated");
    ok(await paintedDark(browser), "The site switch turns the sandboxed page dark live");
    WhimsyDarkPages.setDark(browser, false);
    await darkState(browser, "original");
    ok(!(await paintedDark(browser)), "And restores it live");
  });
  await SpecialPowers.popPrefEnv();
  await SpecialPowers.popPrefEnv();
});

// A page that went into the back-forward cache before the actor registered
// starts its child when it comes back.
add_task(async function cached_page_from_before_startup_hook_follows_settings() {
  await SpecialPowers.pushPrefEnv({ set: [[MODE, "off"]] });
  await whimsySetScheme(false);
  ChromeUtils.unregisterWindowActor("WhimsyDarkPages");
  WhimsyDarkPages._actorRegistered = false;
  let registered = false;
  try {
    await BrowserTestUtils.withNewTab(PAGE + "?first", async browser => {
      await SpecialPowers.spawn(browser, [], () => {
        content.document.documentElement.dataset.cached = "yes";
      });
      BrowserTestUtils.startLoadingURIString(browser, PAGE + "?second");
      await BrowserTestUtils.browserLoaded(browser);
      WhimsyDarkPages.registerActor();
      registered = true;
      const shown = BrowserTestUtils.waitForContentEvent(browser, "pageshow");
      browser.goBack();
      await shown;
      is(await SpecialPowers.spawn(browser, [], () => content.document.documentElement.dataset.cached), "yes",
        "The first page came back from the back-forward cache");
      await SpecialPowers.pushPrefEnv({ set: [[MODE, "always"]] });
      await darkState(browser, "generated");
      ok(await paintedDark(browser), "The cached page turns dark live");
      await SpecialPowers.popPrefEnv();
      await darkState(browser, "original");
      ok(!(await paintedDark(browser)), "And restores live");
    });
  } finally {
    if (!registered) {
      WhimsyDarkPages.registerActor();
    }
    await SpecialPowers.popPrefEnv();
    await SpecialPowers.popPrefEnv();
  }
});

// Owner bug (W29): a canvas-drawn editor (Google Docs was the example) went
// near-black with dark text: the paint-time inversion changes CSS colors,
// never canvas pixels. Canvas pixels get the same lightness flip, so text
// stays readable, on highlights and selections too.
add_task(async function canvas_drawn_editor_stays_readable() {
  await SpecialPowers.pushPrefEnv({ set: [[MODE, "always"]] });
  await BrowserTestUtils.withNewTab(ROOT + "whimsy_dark_pages_canvas.html", async browser => {
    await darkState(browser, "generated");
    const px = await SpecialPowers.spawn(browser, [], () => {
      const canvas = content.document.createElementNS("http://www.w3.org/1999/xhtml", "canvas");
      canvas.width = content.innerWidth;
      canvas.height = content.innerHeight;
      const ctx = canvas.getContext("2d");
      ctx.drawWindow(content, 0, 0, canvas.width, canvas.height, "white");
      const at = (x, y) => [...ctx.getImageData(x, y, 1, 1).data].slice(0, 3);
      return {
        page: at(380, 150), outside: at(500, 300), text: at(40, 25),
        highlight: at(200, 45), highlightText: at(130, 30),
        selection: at(350, 45), selectionText: at(280, 30),
      };
    });
    const lum = rgb => {
      const [r, g, b] = rgb.map(c => {
        c /= 255;
        return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const contrast = (a, b) => {
      const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
      return (hi + 0.05) / (lo + 0.05);
    };
    info(JSON.stringify(px));
    ok(Math.max(...px.outside) < 100 && Math.max(...px.page) < 100, "The page is dark, under the canvas too");
    Assert.greaterOrEqual(contrast(px.text, px.page), 4.5, "Canvas text is readable on the dark page");
    ok(lum(px.text) > lum(px.page), "Canvas text is light on the dark page");
    Assert.greaterOrEqual(contrast(px.highlightText, px.highlight), 4.5, "Text on a highlight is readable");
    ok(px.highlight[0] > px.highlight[2], "The highlight keeps a warm color");
    Assert.greaterOrEqual(contrast(px.selectionText, px.selection), 4.5, "Text on the selection is readable");
    ok(px.selection[2] > px.selection[0], "The selection stays blue");
    await SpecialPowers.pushPrefEnv({ set: [[MODE, "off"]] });
    await darkState(browser, "original");
    is(await SpecialPowers.spawn(browser, [], () =>
      content.getComputedStyle(content.document.getElementById("editor")).filter), "none",
    "Original leaves the canvas untouched");
    await SpecialPowers.popPrefEnv();
  });
  await SpecialPowers.popPrefEnv();
});
