/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// W23 commands: AI rows at the top of the selection's menu and the result
// card (page-2.x, fu-page 2.4, 2.6, 2.8).

const { WhimsyAISelectionCard, wordDiff } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyAISelectionCard.sys.mjs");
const { WhimsyAICommands } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyAICommands.sys.mjs");
const { WhimsyAIProviders } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyAIProviders.sys.mjs");

const PAGE = getRootDirectory(gTestPath).replace("chrome://mochitests/content", "https://example.com") + "whimsy_ai_selection.html";
// whimsy.ai.enabled isn't tracked here: head.js's whimsyRestoreLeakedPrefs
// clears it unconditionally at the end of every file, so a snapshot taken
// here (which could already see it on, from the manifest's own default or
// a leak) never gets a chance to write it back on.
const TOUCHED = ["whimsy.ai.order", "whimsy.ai.translate.recent"];
const saved = new Map(TOUCHED.map(name => [name, Services.prefs.prefHasUserValue(name) ? whimsyReadPref(name, Services.prefs.getPrefType(name)) : null]));
const IMPROVED = "Hi Priya, sorry for the slow reply. We should have moved the launch sooner, but there’s still time if we decide this week.";

function restorePrefs() {
  for (const [name, value] of saved) {
    if (value === null) {
      Services.prefs.clearUserPref(name);
    } else {
      whimsyWritePref(name, Services.prefs.getPrefType(name), value);
    }
  }
}

let answer = IMPROVED;
let calls = [];
let gate = null;

add_setup(async function () {
  await SpecialPowers.pushPrefEnv({ set: [["whimsy.feature.ai-hints", false]] });
  await WhimsyAICommands._resetForTesting();
  await WhimsyAICommands.init();
  Services.prefs.setBoolPref("whimsy.ai.enabled", true);
  WhimsyAIProviders.setOrder(["claude"]);
  WhimsyAIProviders.setTestProvider(async function* (provider, request) {
    calls.push(request);
    await gate;
    yield { type: "text", delta: answer };
  });
  registerCleanupFunction(async () => {
    WhimsyAISelectionCard.close();
    WhimsyAIProviders.setTestProvider(null);
    await WhimsyAICommands._resetForTesting();
    restorePrefs();
    await WhimsyAICommands.init();
    closeToasts();
  });
});

const menu = () => document.getElementById("contentAreaContextMenu");
const row = id => document.getElementById(`context-whimsy-ai-${id}`);
const shown = el => !!el && !el.hidden;
const panel = () => document.getElementById("whimsy-ai-selection-card");

async function select(browser, id) {
  await SpecialPowers.spawn(browser, [id], elementId => {
    const el = content.document.getElementById(elementId);
    if (el.localName == "textarea" || el.localName == "input") {
      el.focus();
      el.setSelectionRange(0, el.value.length);
      return;
    }
    el.focus?.();
    const range = content.document.createRange();
    range.selectNodeContents(el);
    content.getSelection().removeAllRanges();
    content.getSelection().addRange(range);
  });
}

async function openMenu(browser, id) {
  await select(browser, id);
  const opened = BrowserTestUtils.waitForEvent(menu(), "popupshown");
  await BrowserTestUtils.synthesizeMouseAtCenter(`#${id}`, { type: "contextmenu", button: 2 }, browser);
  await opened;
}

async function closeMenu() {
  const hidden = BrowserTestUtils.waitForEvent(menu(), "popuphidden");
  menu().hidePopup();
  await hidden;
}

async function pick(id) {
  const shownCard = BrowserTestUtils.waitForEvent(document, "popupshown", true, e => e.target.id == "whimsy-ai-selection-card");
  menu().activateItem(row(id));
  await shownCard;
  await TestUtils.waitForCondition(() => WhimsyAISelectionCard.card?.status == "done", "The answer is complete");
}

const value = (browser, id) => SpecialPowers.spawn(browser, [id], i => content.document.getElementById(i).value);

async function closeCard() {
  if (panel()?.state == "open") {
    const hidden = BrowserTestUtils.waitForEvent(panel(), "popuphidden");
    WhimsyAISelectionCard.close();
    await hidden;
  }
}

add_task(async function four_rows_above_cut() {
  await BrowserTestUtils.withNewTab(PAGE, async browser => {
    await openMenu(browser, "draft");
    const ids = ["improve", "fix", "translate", "more"];
    ok(ids.every(id => shown(row(id))), "Improve Writing, Fix Spelling and Grammar, Translate, and More Commands… show");
    const items = [...menu().children].filter(el => !el.hidden);
    Assert.deepEqual(items.slice(0, 4).map(el => el.id), ids.map(id => `context-whimsy-ai-${id}`), "They're the first four rows");
    const cut = document.getElementById("context-cut");
    ok(items.indexOf(cut) > 4, "Above Cut");
    is(row("more").getAttribute("acceltext"), "⌘K", "More Commands… shows ⌘K");
    const sub = row("translate").menupopup;
    const opened = BrowserTestUtils.waitForEvent(sub, "popupshown");
    row("translate").openMenu(true);
    await opened;
    const labels = [...sub.children].filter(el => el.localName == "menuitem").map(el => el.id);
    is(labels.at(-1), "context-whimsy-ai-translate-other", "Translate ends with Other…");
    ok(labels[0] == "context-whimsy-ai-translate-0", "Your language comes first");
    await closeMenu();
  });
});

add_task(async function no_ai_rows_in_password_card_otp() {
  await BrowserTestUtils.withNewTab(PAGE, async browser => {
    for (const id of ["password", "card", "otp"]) {
      await openMenu(browser, id);
      ok(!shown(row("improve")) && !shown(row("more")), `No AI rows in the ${id} field`);
      await closeMenu();
    }
  });
});

add_task(async function no_ai_rows_in_otp_contenteditable() {
  await BrowserTestUtils.withNewTab(PAGE, async browser => {
    await openMenu(browser, "otp-ce");
    ok(!shown(row("improve")) && !shown(row("translate")), "No AI rows in a one-time-code editable");
    await closeMenu();
  });
});

add_task(async function replace_default_in_editable() {
  calls = [];
  answer = IMPROVED;
  await BrowserTestUtils.withNewTab(PAGE, async browser => {
    await openMenu(browser, "draft");
    await pick("improve");
    ok(calls[0].messages.at(-1).content.includes("should of moved"), "The selection went into the prompt");
    const replace = document.getElementById("whimsy-ai-card-replace");
    is(replace.getAttribute("default"), "true", "Replace is the default");
    await TestUtils.waitForCondition(() => document.activeElement == replace, "Focus is on Replace");
    const hidden = BrowserTestUtils.waitForEvent(panel(), "popuphidden");
    EventUtils.synthesizeKey("KEY_Enter");
    await hidden;
    await TestUtils.waitForCondition(async () => (await value(browser, "draft")) == IMPROVED, "Enter replaced the text");
    ok(toastFor("whimsy-ai-card-replaced-toast"), "With an Undo toast");
    closeToasts();
  });
});

add_task(async function readonly_copy_and_insert_after_block() {
  answer = "Les trains de nuit sont revenus.";
  await BrowserTestUtils.withNewTab(PAGE, async browser => {
    await openMenu(browser, "article");
    await pick("improve");
    ok(!document.getElementById("whimsy-ai-card-replace"), "No Replace on read-only text");
    ok(document.getElementById("whimsy-ai-card-copy") && document.getElementById("whimsy-ai-card-insert"), "Copy and Insert after");
    const hidden = BrowserTestUtils.waitForEvent(panel(), "popuphidden");
    EventUtils.synthesizeMouseAtCenter(document.getElementById("whimsy-ai-card-insert"), {});
    await hidden;
    const block = await TestUtils.waitForCondition(
      () => SpecialPowers.spawn(browser, [], () => {
        const box = content.document.querySelector("[data-whimsy-ai-inserted]");
        return box && box.previousElementSibling?.id == "article" ? box.textContent : null;
      }),
      "A marked block sits under the paragraph"
    );
    is(block, answer, "It holds the answer");
  });
});

add_task(async function undo_restores_and_reopens_card() {
  answer = IMPROVED;
  await BrowserTestUtils.withNewTab(PAGE, async browser => {
    const original = await value(browser, "draft");
    await openMenu(browser, "draft");
    await pick("improve");
    const hidden = BrowserTestUtils.waitForEvent(panel(), "popuphidden");
    EventUtils.synthesizeMouseAtCenter(document.getElementById("whimsy-ai-card-replace"), {});
    await hidden;
    await TestUtils.waitForCondition(async () => (await value(browser, "draft")) == IMPROVED, "Replaced");
    const reopened = BrowserTestUtils.waitForEvent(document, "popupshown", true, e => e.target.id == "whimsy-ai-selection-card");
    EventUtils.synthesizeKey("z", { accelKey: true });
    await reopened;
    await TestUtils.waitForCondition(async () => (await value(browser, "draft")) == original, "⌘Z put the original back");
    const selected = await SpecialPowers.spawn(browser, [], () => {
      const el = content.document.getElementById("draft");
      return el.value.slice(el.selectionStart, el.selectionEnd);
    });
    is(selected, original, "selected");
    await TestUtils.waitForCondition(() => document.activeElement?.id == "whimsy-ai-card-replace", "The card is back, focus on Replace");
    ok(panel().textContent.includes("slow reply"), "with the same result");
    await closeCard();
    closeToasts();
  });
});

add_task(async function esc_changes_nothing() {
  answer = IMPROVED;
  await BrowserTestUtils.withNewTab(PAGE, async browser => {
    const original = await value(browser, "draft");
    await openMenu(browser, "draft");
    await pick("improve");
    const hidden = BrowserTestUtils.waitForEvent(panel(), "popuphidden");
    EventUtils.synthesizeKey("KEY_Escape");
    await hidden;
    is(await value(browser, "draft"), original, "Esc closed the card and changed nothing");
  });
});

add_task(async function buttons_dim_until_complete() {
  answer = IMPROVED;
  let open;
  gate = new Promise(r => (open = r));
  await BrowserTestUtils.withNewTab(PAGE, async browser => {
    await openMenu(browser, "draft");
    const shownCard = BrowserTestUtils.waitForEvent(document, "popupshown", true, e => e.target.id == "whimsy-ai-selection-card");
    menu().activateItem(row("improve"));
    await shownCard;
    ok(document.getElementById("whimsy-ai-card-replace").hasAttribute("disabled"), "Replace is dim while the answer comes");
    open();
    await TestUtils.waitForCondition(() => WhimsyAISelectionCard.card?.status == "done", "Done");
    ok(!document.getElementById("whimsy-ai-card-replace").hasAttribute("disabled"), "and ready once it's complete");
    await closeCard();
  });
  gate = null;
});

add_task(async function fix_marks_changes() {
  Assert.deepEqual(
    wordDiff("we should of moved", "we should have moved").filter(p => p.op != "same").map(p => [p.op, p.text]),
    [["del", "of"], ["ins", "have"]],
    "Word changes"
  );
  answer = "Hi Priya, sorry for the late reply. I think we should have moved the launch sooner, but there is still time if we decide this week.";
  await BrowserTestUtils.withNewTab(PAGE, async browser => {
    await openMenu(browser, "draft");
    await pick("fix");
    const ins = [...panel().querySelectorAll("ins")].map(n => n.textContent);
    const del = [...panel().querySelectorAll("del")].map(n => n.textContent);
    ok(ins.includes("have") && del.includes("of"), "Fix Spelling and Grammar marks what changed");
    await closeCard();
  });
});
