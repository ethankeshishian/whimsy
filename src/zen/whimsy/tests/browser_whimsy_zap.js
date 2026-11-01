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

    const subMenu = document.getElementById("whimsy-site-zapped-menu");
    ok(subMenu && !subMenu.hidden, "Submenu shows when elements are zapped");
    const subAttrs = document.l10n.getAttributes(subMenu);
    is(subAttrs.args.count, 2, "Submenu says 2 zapped elements");
    const elItems = subMenu.querySelectorAll(".whimsy-site-zapped-item");
    is(elItems.length, 2, "Submenu lists both zapped elements");

    // Review design-full-5 M10: Restore All appears once, at the end of the
    // submenu, not also in the site panel menu itself.
    const restoreAlls = [...popup.querySelectorAll("menuitem")].filter(
      el => el.getAttribute("command") == WhimsyZap.COMMAND_RESTORE_ALL
    );
    is(restoreAlls.length, 1, "Restore All Zapped Elements appears once");
    is(restoreAlls[0].parentNode.parentNode, subMenu, "inside the Zapped Elements submenu");
    is(restoreAlls[0].parentNode.lastElementChild, restoreAlls[0], "as its last row");
    is(restoreAlls[0].previousElementSibling?.localName, "menuseparator", "after a separator");
    const { globalActions } = ChromeUtils.importESModule("resource:///modules/ZenUBGlobalActions.sys.mjs");
    const restoreAction = globalActions.find(a => a.l10nId == "whimsy-action-zap-restore-all");
    ok(!restoreAction?.icon?.includes("trash"), "Restore All has no trash icon");

    // Review design-full-4 L9: rows say what was zapped, not the selector.
    await TestUtils.waitForCondition(
      () => document.l10n.getAttributes(elItems[0]).id == "whimsy-site-zap-restore-item",
      "The page describes the zapped elements"
    );
    is(document.l10n.getAttributes(elItems[0]).args.name, "Article title", "The heading is named by its text");
    const pName = document.l10n.getAttributes(elItems[1]).args.name;
    ok(pName.startsWith("Lorem ipsum") && pName.length <= 40, "Long text is cut short");
    for (const el of elItems) {
      await document.l10n.translateElements([el]);
      ok(el.label?.startsWith("Restore “"), `"${el.label}" names the element, not its selector`);
    }

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

add_task(async function test_zap_undo_granularity() {
  deleteBoosts();
  await BrowserTestUtils.withNewTab(PAGE, async () => {
    WhimsyZap.ensureBoost(DOMAIN);
    gZenBoostsManager.addZapSelectorToActive("h1", DOMAIN);
    gZenBoostsManager.addZapSelectorToActive("p", DOMAIN);
    is(zapSelectors().length, 2, "Initially 2 zapped elements");

    // Test restoring one element via unzapSelector
    WhimsyZap.unzapSelector(window, "h1", DOMAIN);
    ok(!zapSelectors().includes("h1"), "h1 removed by individual unzap");
    ok(zapSelectors().includes("p"), "p is still zapped");

    // Test undoing that single restore
    WhimsyUndo.undo(window);
    ok(zapSelectors().includes("h1"), "Undo brings h1 back to zapped state");

    // Test restoring all elements on the site via command
    const cmd = document.getElementById(WhimsyZap.COMMAND_RESTORE_ALL);
    ok(cmd, "Restore all command registered");
    cmd.doCommand();
    is(zapSelectors().length, 0, "All selectors removed by restore-all");

    // Test undoing restore-all
    WhimsyUndo.undo(window);
    is(zapSelectors().length, 2, "Undo brings back all zapped selectors");

    // Names come from the page; missing or invalid selectors fall back.
    const names = await WhimsyZap.describeSelectors(gBrowser.selectedBrowser, ["h1", ".not-on-page", "div >>> bad"]);
    is(names[0]?.name, "Article title", "A zapped heading is described by its text");
    is(names[0]?.kind, "other", "and is a plain element");
    is(names[1], null, "An element not on the page has no name");
    is(names[2], null, "An invalid selector doesn't throw");
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

// W10-35: Esc cancels zaps made in this session, Enter accepts.
add_task(async function zap_session_escape_cancels_session_zaps() {
  deleteBoosts();
  await BrowserTestUtils.withNewTab(PAGE, async browser => {
    await zapModeOn(browser);
    ok(WhimsyZap.isZapping(window), "Zap mode active");

    gZenBoostsManager.addZapSelectorToActive("h1", DOMAIN);
    ok(zapSelectors().includes("h1"), "h1 was zapped in this session");

    // Escape cancels this session's zaps and exits zap mode
    EventUtils.synthesizeKey("KEY_Escape", {}, window);
    await TestUtils.waitForCondition(() => !zapBar(browser), "Escape exited zap mode");
    ok(!WhimsyZap.isZapping(window), "Zap mode is off after Escape");
    ok(!zapSelectors().includes("h1"), "h1 was cancelled on Escape");
  });
});

add_task(async function zap_session_enter_accepts_session_zaps() {
  deleteBoosts();
  await BrowserTestUtils.withNewTab(PAGE, async browser => {
    await zapModeOn(browser);
    ok(WhimsyZap.isZapping(window), "Zap mode active");

    gZenBoostsManager.addZapSelectorToActive("h1", DOMAIN);
    ok(zapSelectors().includes("h1"), "h1 was zapped in this session");

    // Enter accepts this session's zaps and exits zap mode
    EventUtils.synthesizeKey("KEY_Enter", {}, window);
    await TestUtils.waitForCondition(() => !zapBar(browser), "Enter exited zap mode");
    ok(!WhimsyZap.isZapping(window), "Zap mode is off after Enter");
    ok(zapSelectors().includes("h1"), "h1 was accepted on Enter");
  });
});

add_task(async function zap_session_escape_preserves_prior_zaps() {
  deleteBoosts();
  WhimsyZap.ensureBoost(DOMAIN);
  gZenBoostsManager.addZapSelectorToActive("p", DOMAIN);
  ok(zapSelectors().includes("p"), "p was zapped in a prior session");

  await BrowserTestUtils.withNewTab(PAGE, async browser => {
    await zapModeOn(browser);
    ok(WhimsyZap.isZapping(window), "Zap mode active");

    gZenBoostsManager.addZapSelectorToActive("h1", DOMAIN);
    ok(zapSelectors().includes("h1"), "h1 was zapped in current session");
    ok(zapSelectors().includes("p"), "p is still present");

    EventUtils.synthesizeKey("KEY_Escape", {}, window);
    await TestUtils.waitForCondition(() => !zapBar(browser), "Escape exited zap mode");
    ok(!WhimsyZap.isZapping(window), "Zap mode is off");
    ok(!zapSelectors().includes("h1"), "Session zap h1 cancelled");
    ok(zapSelectors().includes("p"), "Prior zap p preserved");
  });
});

add_task(async function zap_session_content_enter_accepts() {
  deleteBoosts();
  await BrowserTestUtils.withNewTab(PAGE, async browser => {
    await zapModeOn(browser);
    ok(WhimsyZap.isZapping(window), "Zap mode active");

    gZenBoostsManager.addZapSelectorToActive("h1", DOMAIN);
    ok(zapSelectors().includes("h1"), "h1 was zapped in current session");

    browser.focus();
    await SpecialPowers.spawn(browser, [], () => {
      content.document.body.focus();
      const event = new content.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
      content.window.dispatchEvent(event);
    });
    await TestUtils.waitForCondition(() => !zapBar(browser), "Content Enter exited zap mode");
    ok(!WhimsyZap.isZapping(window), "Zap mode is off");
    ok(zapSelectors().includes("h1"), "h1 accepted on content Enter");
  });
});

// W10-35 (lane): Esc pressed in the page (where focus is while zapping)
// cancels the session too, takes the zaps off the undo stack and the
// Year-in-tabs count, and leaves no Cmd+Z that brings them back.
add_task(async function zap_session_content_escape_cancels_and_cleans_up() {
  deleteBoosts();
  Services.prefs.setIntPref("whimsy.stats.zapped", 0);
  await BrowserTestUtils.withNewTab(PAGE, async browser => {
    await zapModeOn(browser);
    gZenBoostsManager.addZapSelectorToActive("h1", DOMAIN);
    ok(zapSelectors().includes("h1"), "h1 zapped in this session");
    is(WhimsyUndo.peek(window)?.selector, "h1", "the zap is on the undo stack");
    if (WhimsyStats.enabled) {
      is(WhimsyStats.getZapCount(), 1, "the zap was counted");
    }

    browser.focus();
    await SpecialPowers.spawn(browser, [], () => {
      content.document.body.focus();
      const event = new content.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
      content.window.dispatchEvent(event);
    });
    await TestUtils.waitForCondition(() => !zapBar(browser), "content Escape exited zap mode");
    ok(!zapSelectors().includes("h1"), "the session's zap was cancelled");
    await TestUtils.waitForCondition(async () => !(await headingHidden(browser)), "the heading shows again");
    ok(WhimsyUndo.peek(window)?.selector != "h1", "the cancelled zap is no longer undoable");
    if (WhimsyStats.enabled) {
      is(WhimsyStats.getZapCount(), 0, "the cancelled zap no longer counts");
    }
  });
});

// W10-35 (lane): Esc and Enter typed in the address bar while zapping
// belong to the address bar, not to the zap session.
add_task(async function zap_session_keys_in_address_bar_are_left_alone() {
  deleteBoosts();
  await BrowserTestUtils.withNewTab(PAGE, async browser => {
    await zapModeOn(browser);
    gZenBoostsManager.addZapSelectorToActive("h1", DOMAIN);
    gURLBar.focus();
    await TestUtils.waitForCondition(() => gURLBar.focused, "the address bar has focus");
    EventUtils.synthesizeKey("KEY_Escape", {}, window);
    await TestUtils.waitForTick();
    ok(
      WhimsyZap.isChromeFieldKey({ key: "Enter", target: gURLBar.inputField }),
      "Enter in the address bar is the address bar's"
    );
    ok(!WhimsyZap.isChromeFieldKey({ key: "Enter", target: browser }), "Enter aimed at the page is zap mode's");
    ok(WhimsyZap.isZapping(window), "zap mode stays on");
    ok(zapSelectors().includes("h1"), "the session's zap stays");
    await zapModeOff(browser);
  });
});
