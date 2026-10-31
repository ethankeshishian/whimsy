/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// wave9/secfix (security-full-1 L1): Zap writes the site to Zen's Boost
// store as soon as zap mode starts, so a private tab (or Scratch, or a
// private window) can't zap: its site would stay on disk.

const { gZenBoostsManager } = ChromeUtils.importESModule("resource:///modules/zen/boosts/ZenBoostsManager.sys.mjs");
const { WhimsyZap } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyZap.sys.mjs");
const { WhimsyPrivate } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyPrivate.sys.mjs");

const DOMAIN = "example.org";
const PAGE = "https://example.org/?secfix-zap";

add_task(async function a_private_tab_cant_zap() {
  await SpecialPowers.pushPrefEnv({ set: [["whimsy.feature.zap", true], ["zen.boosts.enabled", true]] });
  ok(!gZenBoostsManager.getActiveBoostId(DOMAIN), "The site starts without a Boost");

  const normal = await BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE);
  ok(WhimsyZap.canZap(window), "A normal tab can zap");
  BrowserTestUtils.removeTab(normal);

  const tab = WhimsyPrivate.openPrivateTab(window, { url: PAGE, force: true });
  await BrowserTestUtils.browserLoaded(tab.linkedBrowser, false, PAGE);
  gBrowser.selectedTab = tab;
  ok(!WhimsyZap.canZap(window), "A private tab can't");
  is(await WhimsyZap.toggle(window), false, "Zap mode doesn't start");
  ok(!gZenBoostsManager.getActiveBoostId(DOMAIN), "…and the private site never reached the Boost store");
  BrowserTestUtils.removeTab(tab);
  await SpecialPowers.popPrefEnv();
});
