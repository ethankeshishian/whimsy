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
