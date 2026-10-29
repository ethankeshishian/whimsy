/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// Translate selection: select text and press Cmd+Opt+Shift+T (or use the
// command bar) to open Firefox's selection translation panel. Without a
// selection it says so; the AI kill switch doesn't block it.

const PAGE = "https://example.com/document-builder.sjs?html=" + encodeURIComponent("<p id=p lang=fr>Bonjour tout le monde, comment allez-vous ?</p>");
const { WhimsyPage } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyPage.sys.mjs");

async function select(browser) {
  await SpecialPowers.spawn(browser, [], () => {
    const range = content.document.createRange();
    range.selectNodeContents(content.document.getElementById("p"));
    content.getSelection().removeAllRanges();
    content.getSelection().addRange(range);
  });
}

add_task(async function test_key_and_panel() {
  const key = document.getElementById("key_whimsyTranslateSelection");
  is(key?.getAttribute("command"), "cmd_whimsyTranslateSelection", "Cmd+Opt+Shift+T translates the selection");
  const mods = k => (k.getAttribute("modifiers") || "").replace("accel", "meta").split(/[ ,]+/).filter(Boolean).sort().join();
  const clash = [...document.querySelectorAll("key")].filter(
    k => k != key && k.getAttribute("disabled") != "true" && (k.getAttribute("key") || "").toLowerCase() == "t" && mods(k) == mods(key)
  );
  Assert.deepEqual(clash.map(k => k.id), [], "no clash");

  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE);
  await select(tab.linkedBrowser);
  const found = await WhimsyPage.findSelection(tab.linkedBrowser);
  is(found?.text, "Bonjour tout le monde, comment allez-vous ?", "It finds the selected text");
  ok(found.x > 0 && found.y > 0, "and where it is on screen");

  tab.linkedBrowser.focus();
  EventUtils.synthesizeKey("T", { accelKey: true, altKey: true, shiftKey: true });
  await TestUtils.waitForCondition(
    () => document.getElementById("select-translations-panel")?.state == "open",
    "The selection translation panel opens"
  );
  const p = document.getElementById("select-translations-panel");
  const hidden = BrowserTestUtils.waitForPopupEvent(p, "hidden");
  p.hidePopup();
  await hidden;
  BrowserTestUtils.removeTab(tab);
});

add_task(async function test_empty_ai_and_switch() {
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE);
  is(await WhimsyPage.translateSelection(window), null, "Nothing selected: nothing to translate");
  await SpecialPowers.pushPrefEnv({ set: [["whimsy.ai.blocked", true]] });
  ok(WhimsyPage.translateSelectionEnabled, "The AI kill switch leaves translation on");
  await SpecialPowers.popPrefEnv();
  await SpecialPowers.pushPrefEnv({ set: [["whimsy.feature.translate-selection", false]] });
  await select(tab.linkedBrowser);
  is(await WhimsyPage.translateSelection(window), null, "The switch turns it off");
  await SpecialPowers.popPrefEnv();
  const { globalActions } = ChromeUtils.importESModule("resource:///modules/ZenUBGlobalActions.sys.mjs");
  is(globalActions.find(a => a.l10nId == "whimsy-action-translate-selection")?.label, "Translate Selection", "In the command bar");
  BrowserTestUtils.removeTab(tab);
});
