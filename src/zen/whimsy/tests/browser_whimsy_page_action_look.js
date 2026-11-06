/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// W13 F05 (wave12 F05, option B): the address bar's page-action button
// ("Cook mode") is a plain address bar button with a label: the address
// bar's 8px radius, no tint at rest, the neighbours' own hover and pressed
// fills, and the selected fill while Cook mode is open. Driven with real
// pointer moves and clicks; the colours are read from computed styles.
// It is also a command (command bar, a shortcut of your own).

ChromeUtils.defineESModuleGetters(this, {
  WhimsyPageActions: "resource:///modules/whimsy/WhimsyPageActions.sys.mjs",
  WhimsyCommands: "resource:///modules/whimsy/WhimsyCommands.sys.mjs",
});

const PAGE =
  getRootDirectory(gTestPath).replace("chrome://mochitests/content", "https://example.com") +
  "whimsy_page_actions.html";

const pill = () => document.getElementById("whimsy-page-action");

add_setup(async function () {
  await SpecialPowers.pushPrefEnv({ set: [["whimsy.feature.page-actions", true]] });
  WhimsyPageActions._testing = true;
  registerCleanupFunction(() => (WhimsyPageActions._testing = false));
});

// What a colour expression resolves to inside the address bar.
function resolved(expression) {
  const probe = document.createXULElement("box");
  probe.style.backgroundColor = expression;
  pill().after(probe);
  const value = getComputedStyle(probe).backgroundColor;
  probe.remove();
  return value;
}

async function openRecipe() {
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, `${PAGE}?recipe`);
  await SpecialPowers.spawn(tab.linkedBrowser, [], () => {});
  await TestUtils.waitForCondition(() => pill() && !pill().hidden && pill().getAttribute("kind") == "recipe", "Cook mode button");
  await TestUtils.waitForCondition(() => getComputedStyle(pill()).opacity == "1", "Fully shown");
  return tab;
}

add_task(async function test_plain_address_bar_button() {
  const tab = await openRecipe();
  const el = pill();
  const style = getComputedStyle(el);
  const radius = getComputedStyle(document.getElementById("urlbar")).getPropertyValue("--urlbar-icon-border-radius").trim() || "8px";
  is(style.borderTopLeftRadius, radius, `The address bar's radius (${radius}), not a 99px pill`);
  Assert.greaterOrEqual(el.getBoundingClientRect().height, 25.5, "26px tall, like its neighbours");
  is(style.backgroundColor, "rgba(0, 0, 0, 0)", "No tint at rest");

  // Hover: the neighbours' hover fill (Firefox's urlbar box hover).
  const hoverFill = resolved("var(--urlbar-box-hover-bgcolor, color-mix(in srgb, currentColor 9%, transparent))");
  isnot(hoverFill, "rgba(0, 0, 0, 0)", "The address bar has a hover fill");
  // Zen reveals the address bar's hidden buttons once the toolbar is hovered, which slides the pill left; settle that first, as a real pointer does.
  EventUtils.synthesizeMouseAtCenter(document.getElementById("urlbar"), { type: "mousemove" });
  let settledX;
  await TestUtils.waitForCondition(() => {
    const x = el.getBoundingClientRect().x;
    const done = x === settledX;
    settledX = x;
    return done;
  }, "The address bar is done revealing its buttons");
  EventUtils.synthesizeMouseAtCenter(el, { type: "mousemove" });
  await TestUtils.waitForCondition(() => getComputedStyle(el).backgroundColor == hoverFill, "Hover takes the shared fill");
  isnot(hoverFill, resolved("color-mix(in srgb, var(--zen-primary-color, AccentColor) 30%, transparent)"),
    "...not the old deeper tint");

  // A real click opens Cook mode; the button shows it's on.
  EventUtils.synthesizeMouseAtCenter(el, {});
  await TestUtils.waitForCondition(() => document.getElementById("whimsy-cook-panel")?.state == "open", "Cook mode opens");
  ok(el.hasAttribute("open"), "The button is the open panel's anchor");
  // Move away so only [open] decides the fill.
  EventUtils.synthesizeMouseAtCenter(document.getElementById("urlbar-input"), { type: "mousemove" });
  const onFill = resolved("color-mix(in srgb, var(--zen-primary-color, AccentColor) 22%, transparent)");
  await TestUtils.waitForCondition(() => getComputedStyle(el).backgroundColor == onFill, "On: the selected fill");
  const panel = document.getElementById("whimsy-cook-panel");
  const hidden = BrowserTestUtils.waitForEvent(panel, "popuphidden");
  EventUtils.synthesizeKey("KEY_Escape");
  await hidden;
  await TestUtils.waitForCondition(() => getComputedStyle(el).backgroundColor == "rgba(0, 0, 0, 0)", "Off again");
  BrowserTestUtils.removeTab(tab);
});

add_task(async function test_command() {
  const entry = WhimsyCommands.get("cmd_whimsyPageAction");
  ok(entry?.keyId, "A command with a <key> Settings can bind");
  ok(document.getElementById(entry.keyId), "...in this window");
  const { globalActions } = ChromeUtils.importESModule("resource:///modules/ZenUBGlobalActions.sys.mjs");
  const cook = globalActions.find(a => a.l10nId == "whimsy-action-page-action-recipe");
  ok(cook, "The command bar names it for a recipe");
  ok(!cook.isAvailable(window), "...not on a page without one");
  const tab = await openRecipe();
  ok(cook.isAvailable(window), "...offered on a recipe");
  ok(!globalActions.find(a => a.l10nId == "whimsy-action-page-action-event").isAvailable(window), "Only the page's own action");
  document.getElementById("cmd_whimsyPageAction").doCommand();
  await TestUtils.waitForCondition(() => document.getElementById("whimsy-cook-panel")?.state == "open", "The command opens Cook mode");
  const panel = document.getElementById("whimsy-cook-panel");
  const hidden = BrowserTestUtils.waitForEvent(panel, "popuphidden");
  panel.hidePopup();
  await hidden;
  BrowserTestUtils.removeTab(tab);
});
