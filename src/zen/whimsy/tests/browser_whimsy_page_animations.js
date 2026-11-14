/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// W27: Turn Off / Turn On Page Animations (WhimsyPageActions). The command
// stops CSS animations and transitions on the current tab only, until it
// reloads, with a user sheet loaded through the page-actions actor; running
// it again removes the sheet. The command bar names the next step, and a
// toast confirms each change.

const { WhimsyPageActions } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyPageActions.sys.mjs");
const { WhimsyCommands } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyCommands.sys.mjs");
const { globalActions } = ChromeUtils.importESModule("resource:///modules/ZenUBGlobalActions.sys.mjs");

const ID = "cmd_whimsyTogglePageAnimations";
const PAGE =
  getRootDirectory(gTestPath).replace("chrome://mochitests/content", "https://example.com") +
  "whimsy_page_animations.html";

function action(l10nId) {
  return globalActions.find(a => a.whimsyCommand == ID && a.l10nId == l10nId);
}

function available(l10nId) {
  return !!action(l10nId)?.isAvailable(window);
}

// The spinner's computed animation and transition, and its ::after's.
function motion(browser) {
  return SpecialPowers.spawn(browser, [], () => {
    const el = content.document.getElementById("spinner");
    const style = content.getComputedStyle(el);
    return {
      animation: style.animationName,
      transition: style.transitionProperty,
      after: content.getComputedStyle(el, "::after").animationName,
    };
  });
}

function stilled(browser) {
  return motion(browser).then(m => m.animation == "none" && m.transition == "none" && m.after == "none");
}

registerCleanupFunction(() => closeToasts());

add_setup(() => closeToasts());

add_task(function test_registered_unbound_and_named() {
  const entry = WhimsyCommands.get(ID);
  ok(entry, "The command is registered");
  is(entry?.l10nId, "whimsy-action-page-animations-toggle", "Its neutral name is for about:keyboard");
  ok(document.getElementById(ID), "It has a <command>");
  const keyEl = entry?.keyId && document.getElementById(entry.keyId);
  ok(keyEl, "It has a <key>, so a shortcut can be assigned");
  ok(!keyEl?.hasAttribute("key") && !keyEl?.hasAttribute("keycode"), "No default shortcut");
  is(action("whimsy-action-page-animations-off")?.label, "Turn Off Page Animations", "The command bar's off row");
  is(action("whimsy-action-page-animations-on")?.label, "Turn On Page Animations", "The command bar's on row");
  ok(
    action("whimsy-action-page-animations-off")?.whimsyKeywords?.includes("Reduce Motion"),
    "Found by Reduce Motion too"
  );
  ok(!Services.prefs.prefHasUserValue("ui.prefersReducedMotion"), "It never touches ui.prefersReducedMotion");
});

add_task(async function test_this_tab_only_until_reload() {
  const other = await BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE);
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE);
  const browser = tab.linkedBrowser;
  try {
    Assert.deepEqual(
      await motion(browser),
      { animation: "whimsy-spin", transition: "opacity", after: "whimsy-spin" },
      "The test page animates to begin with"
    );
    ok(available("whimsy-action-page-animations-off"), "Turn Off Page Animations is offered");
    ok(!available("whimsy-action-page-animations-on"), "and Turn On Page Animations isn't");

    document.getElementById(ID).doCommand();
    ok(available("whimsy-action-page-animations-on"), "Turn On Page Animations is offered next");
    ok(!available("whimsy-action-page-animations-off"), "and Turn Off Page Animations isn't");
    await TestUtils.waitForCondition(() => stilled(browser), "Animations and transitions stop on this tab");
    await TestUtils.waitForCondition(() => toastFor("whimsy-page-animations-off-toast"), "The off toast shows");
    ok(!Services.prefs.prefHasUserValue("ui.prefersReducedMotion"), "No app-wide pref was set");

    is((await motion(other.linkedBrowser)).animation, "whimsy-spin", "Another tab on the same page still animates");
    await BrowserTestUtils.switchTab(gBrowser, other);
    ok(available("whimsy-action-page-animations-off"), "On the other tab the command offers Turn Off again");
    await BrowserTestUtils.switchTab(gBrowser, tab);

    document.getElementById(ID).doCommand();
    ok(available("whimsy-action-page-animations-off"), "Turn Off Page Animations is offered again");
    await TestUtils.waitForCondition(
      async () => (await motion(browser)).animation == "whimsy-spin",
      "Turning them on removes the sheet"
    );
    await TestUtils.waitForCondition(() => toastFor("whimsy-page-animations-on-toast"), "The on toast shows");
    ok(!toastFor("whimsy-page-animations-off-toast"), "It replaced the off toast (one at a time)");

    document.getElementById(ID).doCommand();
    await TestUtils.waitForCondition(() => stilled(browser), "Off again");
    const loaded = BrowserTestUtils.browserLoaded(browser);
    browser.reload();
    await loaded;
    is((await motion(browser)).animation, "whimsy-spin", "A reload brings the animations back");
    ok(available("whimsy-action-page-animations-off"), "and the command offers Turn Off again");
  } finally {
    BrowserTestUtils.removeTab(tab);
    BrowserTestUtils.removeTab(other);
    closeToasts();
  }
});

add_task(async function test_not_offered_off_the_web() {
  await BrowserTestUtils.withNewTab("about:blank", () => {
    ok(!available("whimsy-action-page-animations-off"), "Not offered on about:blank");
    ok(!available("whimsy-action-page-animations-on"), "Neither row");
  });
});

add_task(async function test_switch_off_hides_and_disarms_it() {
  await BrowserTestUtils.withNewTab(PAGE, async browser => {
    await SpecialPowers.pushPrefEnv({ set: [["whimsy.feature.page-animations-command", false]] });
    ok(!available("whimsy-action-page-animations-off"), "Hidden with its switch off");
    ok(!available("whimsy-action-page-animations-on"), "Both rows hidden");
    document.getElementById(ID).doCommand();
    ok(!WhimsyPageActions.animationsOff(browser), "Running it does nothing with its switch off");
    is((await motion(browser)).animation, "whimsy-spin", "The page still animates");
    await SpecialPowers.popPrefEnv();
  });
});
