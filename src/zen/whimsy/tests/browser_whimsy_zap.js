/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// wave6/zap: Zap as a command. Cmd+Shift+X / the command bar / the site
// panel turn on Zen's zap mode (making a Boost when the site has none),
// zaps are undoable (Cmd+Z while zapping, Whimsy's undo after), counted for
// Year in tabs, and the dust is tinted with the space's colors.

const { gZenBoostsManager } = ChromeUtils.importESModule("resource:///modules/zen/boosts/ZenBoostsManager.sys.mjs");
const { WhimsyZap } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyZap.sys.mjs");
const { WhimsyUndo } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyUndo.sys.mjs");
const { WhimsyStats } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyStats.sys.mjs");
const { AppConstants } = ChromeUtils.importESModule("resource://gre/modules/AppConstants.sys.mjs");

const DOMAIN = "example.com";
// A page with a real <h1>, so "hidden" can never pass on a missing heading.
const PAGE = "https://example.com/browser/zen/whimsy/tests/whimsy_article.html";

function zapBar(browser) {
  return browser.closest(".browserContainer")?.querySelector("zen-zap-bar");
}

function zapSelectors() {
  if (!gZenBoostsManager.getActiveBoostId(DOMAIN)) {
    return [];
  }
  return gZenBoostsManager.loadActiveBoostFromStore(DOMAIN)?.boostEntry.boostData.zapSelectors ?? [];
}

function headingHidden(browser) {
  return SpecialPowers.spawn(browser, [], () => {
    const h1 = content.document.querySelector("h1");
    if (!h1) {
      throw new Error("The test page has no <h1>");
    }
    return content.getComputedStyle(h1).display == "none";
  });
}

async function zapModeOn(browser) {
  document.getElementById(WhimsyZap.COMMAND_ID).doCommand();
  const bar = await TestUtils.waitForCondition(() => zapBar(browser), "The zap bar shows");
  await bar.updateComplete;
  ok(WhimsyZap.isZapping(window), "Zap mode is on in this tab");
  return bar;
}

async function zapModeOff(browser) {
  document.getElementById(WhimsyZap.COMMAND_ID).doCommand();
  await TestUtils.waitForCondition(() => !zapBar(browser), "The zap bar goes away");
}

function deleteBoosts() {
  for (const boost of gZenBoostsManager.loadBoostsFromStore(DOMAIN) ?? []) {
    gZenBoostsManager.deleteBoost(boost);
  }
}

add_setup(async function () {
  await SpecialPowers.pushPrefEnv({
    set: [
      ["whimsy.feature.zap", true],
      ["whimsy.feature.undo-tab-actions", true],
      ["zen.boosts.enabled", true],
      // The dust needs WebGL and takes a moment; tests zap instantly.
      ["zen.boosts.dissolve-on-zap", false],
    ],
  });
  deleteBoosts();
  registerCleanupFunction(() => {
    deleteBoosts();
    Services.prefs.clearUserPref("whimsy.stats.zapped");
  });
});

add_task(async function shortcut_and_actions_exist() {
  const key = document.getElementById("key_whimsyZap");
  ok(key, "Zap has a <key>");
  is(key.getAttribute("key"), "X", "on X");
  is(key.getAttribute("modifiers"), "accel,shift", "with Cmd+Shift");
  const bidi = document.getElementById("key_switchTextDirection");
  ok(!bidi || !bidi.getAttribute("key"), "Switch Text Direction gave up Cmd+Shift+X");

  const { globalActions } = ChromeUtils.importESModule("resource:///modules/ZenUBGlobalActions.sys.mjs");
  const action = globalActions.find(a => a.l10nId == "whimsy-action-zap");
  ok(action, "Zap Elements is a command bar action");
  is(action.commandId, WhimsyZap.COMMAND_ID, "and it runs the zap command");

  await BrowserTestUtils.withNewTab("about:blank", async () => {
    ok(!WhimsyZap.canZap(window), "Nothing to zap on about:blank");
    ok(!action.isAvailable(window), "so the action is hidden there");
  });
  await BrowserTestUtils.withNewTab(PAGE, async () => {
    ok(WhimsyZap.canZap(window), "A web page can be zapped");
    ok(action.isAvailable(window), "and the action shows");
  });
});

add_task(async function command_makes_a_boost_and_toggles_zap_mode() {
  deleteBoosts();
  await BrowserTestUtils.withNewTab(PAGE, async browser => {
    ok(!gZenBoostsManager.getActiveBoostId(DOMAIN), "The site starts without a Boost");
    await zapModeOn(browser);
    ok(gZenBoostsManager.getActiveBoostId(DOMAIN), "Zapping made an active Boost for the site");
    ok(
      gZenBoostsManager.loadActiveBoostFromStore(DOMAIN).boostEntry.boostData.changeWasMade,
      "and it's kept (not discarded as an untouched Boost)"
    );
    await zapModeOff(browser);
    ok(!WhimsyZap.isZapping(window), "The same command turns zap mode off");
  });
});

add_task(async function zaps_count_and_undo() {
  deleteBoosts();
  Services.prefs.setIntPref("whimsy.stats.zapped", 0);
  await BrowserTestUtils.withNewTab(PAGE, async browser => {
    WhimsyZap.ensureBoost(DOMAIN);
    // What zap mode does when an element is clicked.
    gZenBoostsManager.addZapSelectorToActive("h1", DOMAIN);
    await TestUtils.waitForCondition(() => headingHidden(browser), "The heading is zapped");
    is(WhimsyStats.getZapCount(), 1, "The zap counts toward Year in tabs");
    is(WhimsyUndo.peek(window)?.type, "zap", "and is on the undo stack");

    // Zapping the same thing again isn't a new zap.
    gZenBoostsManager.addZapSelectorToActive("h1", DOMAIN);
    is(WhimsyStats.getZapCount(), 1, "A repeat zap doesn't count twice");

    WhimsyUndo.undo(window);
    ok(!zapSelectors().includes("h1"), "Undo brings the heading back");
    await TestUtils.waitForCondition(async () => !(await headingHidden(browser)), "The heading shows again");
    is(WhimsyStats.getZapCount(), 1, "Undo doesn't change the count");

    WhimsyUndo.redo(window);
    ok(zapSelectors().includes("h1"), "Redo zaps it again");
    is(WhimsyStats.getZapCount(), 1, "Redo isn't a new zap either");
    WhimsyUndo.undo(window);
    ok(!zapSelectors().includes("h1"), "Undone again");
  });
});

add_task(async function cmd_z_while_zapping() {
  deleteBoosts();
  await BrowserTestUtils.withNewTab(PAGE, async browser => {
    await zapModeOn(browser);
    gZenBoostsManager.addZapSelectorToActive("h1", DOMAIN);
    ok(zapSelectors().includes("h1"), "Zapped while in zap mode");
    browser.focus();
    const accel = AppConstants.platform == "macosx" ? { metaKey: true } : { ctrlKey: true };
    EventUtils.synthesizeKey("z", accel, window);
    await TestUtils.waitForCondition(() => !zapSelectors().includes("h1"), "Cmd+Z in zap mode unzaps");
    EventUtils.synthesizeKey("z", { ...accel, shiftKey: true }, window);
    await TestUtils.waitForCondition(() => zapSelectors().includes("h1"), "Cmd+Shift+Z zaps it again");
    await zapModeOff(browser);
  });
});

add_task(async function site_panel_menu_item() {
  deleteBoosts();
  await BrowserTestUtils.withNewTab(PAGE, async () => {
    const popup = document.getElementById("zenSiteDataActions");
    ok(popup, "Zen's site panel menu exists");
    const shown = BrowserTestUtils.waitForPopupEvent(popup, "shown");
    popup.openPopup(gURLBar, "after_start");
    await shown;
    const item = document.getElementById("whimsy-site-zap");
    ok(item && !item.hidden, "Zap Elements is in the site panel menu");
    is(item.getAttribute("command"), WhimsyZap.COMMAND_ID, "and runs the zap command");
    is(document.l10n.getAttributes(item).id, "whimsy-site-zap", "No count before anything is zapped");
    const hidden = BrowserTestUtils.waitForPopupEvent(popup, "hidden");
    popup.hidePopup();
    await hidden;

    WhimsyZap.ensureBoost(DOMAIN);
    gZenBoostsManager.addZapSelectorToActive("h1", DOMAIN);
    gZenBoostsManager.addZapSelectorToActive("p", DOMAIN);
    const shownAgain = BrowserTestUtils.waitForPopupEvent(popup, "shown");
    popup.openPopup(gURLBar, "after_start");
    await shownAgain;
    const attrs = document.l10n.getAttributes(item);
    is(attrs.id, "whimsy-site-zap-count", "The item says how many things are zapped");
    is(attrs.args.count, 2, "two of them");
    const hiddenAgain = BrowserTestUtils.waitForPopupEvent(popup, "hidden");
    popup.hidePopup();
    await hiddenAgain;
  });
  await BrowserTestUtils.withNewTab("about:blank", async () => {
    const popup = document.getElementById("zenSiteDataActions");
    const shown = BrowserTestUtils.waitForPopupEvent(popup, "shown");
    popup.openPopup(gURLBar, "after_start");
    await shown;
    ok(document.getElementById("whimsy-site-zap").hidden, "No Zap item where nothing can be zapped");
    const hidden = BrowserTestUtils.waitForPopupEvent(popup, "hidden");
    popup.hidePopup();
    await hidden;
  });
});

add_task(async function switch_off() {
  deleteBoosts();
  await SpecialPowers.pushPrefEnv({ set: [["whimsy.feature.zap", false]] });
  Services.prefs.setIntPref("whimsy.stats.zapped", 0);
  await BrowserTestUtils.withNewTab(PAGE, async browser => {
    ok(!WhimsyZap.canZap(window), "With the switch off, nothing offers Zap");
    document.getElementById(WhimsyZap.COMMAND_ID).doCommand();
    await new Promise(resolve => setTimeout(resolve, 300));
    ok(!zapBar(browser), "The command does nothing");
    ok(!gZenBoostsManager.getActiveBoostId(DOMAIN), "and makes no Boost");
    // Zen's own zap (from the Boost editor) still works, uncounted.
    const boost = gZenBoostsManager.createNewBoost(DOMAIN);
    gZenBoostsManager.makeBoostActiveForDomain(DOMAIN, boost.id);
    gZenBoostsManager.updateBoost(boost);
    gZenBoostsManager.addZapSelectorToActive("h1", DOMAIN);
    is(WhimsyStats.getZapCount(), 0, "Zaps aren't counted with the switch off");
  });
  await SpecialPowers.popPrefEnv();
});

add_task(async function dust_takes_space_colors() {
  await BrowserTestUtils.withNewTab(PAGE, async browser => {
    Services.ppmm.sharedData.set(WhimsyZap.TINT_KEY, [
      [255, 0, 0],
      [0, 0, 255],
    ]);
    Services.ppmm.sharedData.flush();
    const result = await SpecialPowers.spawn(browser, [WhimsyZap.TINT_KEY], async key => {
      await ContentTaskUtils.waitForCondition(() => Services.cpmm.sharedData.get(key), "Colors reach the page");
      const { WhimsyZapTint } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyZapTint.sys.mjs");
      const canvas = content.document.createElement("canvas");
      canvas.width = 20;
      canvas.height = 10;
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = "white";
      ctx.fillRect(0, 0, 10, 10); // The right half stays transparent.
      const tinted = WhimsyZapTint.tint(ctx, 20, 10);
      return {
        tinted,
        left: [...ctx.getImageData(1, 5, 1, 1).data],
        right: [...ctx.getImageData(15, 5, 1, 1).data],
      };
    });
    ok(result.tinted, "The capture was tinted");
    Assert.less(result.left[1], 200, "White took on the space's colors");
    Assert.greater(result.left[0], 150, "red at the start of the gradient");
    is(result.right[3], 0, "Transparent pixels stay transparent (no dust outside the element)");
    Services.ppmm.sharedData.delete(WhimsyZap.TINT_KEY);
    Services.ppmm.sharedData.flush();
  });
  // The window's own space colors are what gets shared.
  const colors = await WhimsyZap.updateTint(window);
  ok(Array.isArray(colors), "The current space's colors are read");
  is(
    JSON.stringify(Services.ppmm.sharedData.get(WhimsyZap.TINT_KEY) ?? []),
    JSON.stringify(colors),
    "and shared with the pages"
  );
});

add_task(async function zap_cursor_and_escape() {
  deleteBoosts();
  await BrowserTestUtils.withNewTab(PAGE, async browser => {
    await zapModeOn(browser);
    ok(WhimsyZap.isZapping(window), "Zap mode active");

    await TestUtils.waitForCondition(async () => {
      return SpecialPowers.spawn(browser, [], () => {
        const h1 = content.document.querySelector("h1");
        return content.getComputedStyle(h1).cursor === "crosshair";
      });
    }, "Crosshair cursor applied in zap mode");

    const styles = await SpecialPowers.spawn(browser, [], () => {
      const h1 = content.document.querySelector("h1");
      const a = content.document.createElement("a");
      a.href = "#";
      content.document.body.appendChild(a);
      const h1Style = content.getComputedStyle(h1);
      const aStyle = content.getComputedStyle(a);
      const res = {
        h1Cursor: h1Style.cursor,
        h1UserSelect: h1Style.userSelect,
        aCursor: aStyle.cursor,
      };
      a.remove();
      return res;
    });
    is(styles.h1Cursor, "crosshair", "Heading has crosshair cursor in zap mode");
    is(styles.h1UserSelect, "none", "Heading has user-select: none in zap mode");
    is(styles.aCursor, "crosshair", "Link has crosshair cursor in zap mode");

    // Escape exits Zap mode
    EventUtils.synthesizeKey("KEY_Escape", {}, window);
    await TestUtils.waitForCondition(() => !zapBar(browser), "Escape exited zap mode");
    ok(!WhimsyZap.isZapping(window), "Zap mode is off after Escape");
  });
});

add_task(async function zap_escape_from_content() {
  deleteBoosts();
  await BrowserTestUtils.withNewTab(PAGE, async browser => {
    await zapModeOn(browser);
    ok(WhimsyZap.isZapping(window), "Zap mode active");

    browser.focus();
    await SpecialPowers.spawn(browser, [], () => {
      content.document.body.focus();
      const event = new content.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
      content.window.dispatchEvent(event);
    });
    await TestUtils.waitForCondition(() => !zapBar(browser), "Escape from content exited zap mode");
    ok(!WhimsyZap.isZapping(window), "Zap mode is off after content Escape");
  });
});
