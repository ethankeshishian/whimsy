/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// W23 page-read (fu-page 1.7, page-1.8): Cmd+F opens Firefox's find bar as a
// floating card at the top right of the page. Its options live in a ⋯ menu of
// checkable rows; Quick Find still works; when nothing matches, the count
// turns red, Enter asks about the page, and the answer can move to the chat.

const { WhimsyAIProviders } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyAIProviders.sys.mjs");
const { WhimsyAIStore } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyAIStore.sys.mjs");
const { WhimsyAIContext } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyAIContext.sys.mjs");
const { WhimsyChat } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyChat.sys.mjs");

const ROOT = getRootDirectory(gTestPath).replace("chrome://mochitests/content", "https://example.com");
const PAGE = ROOT + "whimsy_ai_page.html";

const { WhimsyFindCard } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyFindCard.sys.mjs");

const FIND_PREFS = [
  "findbar.highlightAll",
  "accessibility.typeaheadfind.casesensitive",
  "findbar.matchdiacritics",
  "findbar.entireword",
  // Firefox's bar counts down its first-open flashes in this one.
  "accessibility.typeaheadfind.flashBar",
];

function fakeProvider() {
  return JSON.stringify({
    answer: "The offsite is in Lisbon on March 14.",
    quote: "The offsite is on March 14 in Lisbon.",
  });
}

add_setup(async () => {
  // Pin each find option at its current value so the toggles below are undone.
  const branch = Services.prefs;
  await SpecialPowers.pushPrefEnv({
    set: FIND_PREFS.map(name => [name, branch.getPrefType(name) == branch.PREF_INT ? branch.getIntPref(name) : branch.getBoolPref(name, false)]),
  });
  WhimsyAIProviders.setTestProvider(fakeProvider);
  registerCleanupFunction(async () => {
    WhimsyAIProviders.setTestProvider(null);
    WhimsyChat.close(window, { reason: "hide" });
    await WhimsyAIStore.clear?.({ kinds: ["chats"] });
    await SpecialPowers.popPrefEnv();
  });
});

async function openFind() {
  EventUtils.synthesizeKey("f", { accelKey: true });
  const findbar = await TestUtils.waitForCondition(() => gBrowser.isFindBarInitialized() && gBrowser.getCachedFindBar(), "The find bar exists");
  await TestUtils.waitForCondition(() => !findbar.hidden && document.activeElement == findbar._findField, "Cmd+F opens it, focused");
  return findbar;
}

async function typeIn(findbar, text) {
  findbar._findField.select();
  EventUtils.sendString(text);
  await TestUtils.waitForCondition(() => findbar._findField.getAttribute("status") != "pending", "Find ran");
}

function count(findbar) {
  return findbar.querySelector(".whimsy-find-count").getAttribute("value");
}

async function closeFind(findbar) {
  findbar.close(true);
  await TestUtils.waitForCondition(() => findbar.hidden, "The find bar closes");
}

add_task(async function floating_card_top_right() {
  await BrowserTestUtils.withNewTab(PAGE, async browser => {
    const findbar = await openFind();
    ok(findbar.hasAttribute("whimsy-find-card"), "The find bar is the floating card");
    await TestUtils.waitForCondition(() => findbar.getAnimations().every(a => a.playState != "running"), "It has opened");
    const card = findbar.getBoundingClientRect();
    const page = browser.getBoundingClientRect();
    const style = getComputedStyle(findbar);
    info(`card ${JSON.stringify(card)} page ${JSON.stringify(page)} position ${style.position} top ${style.top} parent ${findbar.parentNode.className} ${getComputedStyle(findbar.parentNode).position}`);
    Assert.lessOrEqual(Math.abs(page.right - card.right - 14), 2, `It sits 14px from the page's right edge (${page.right - card.right})`);
    Assert.lessOrEqual(Math.abs(card.top - page.top - 10), 2, `and 10px below its top (${card.top - page.top})`);
    is(Math.round(card.width), 400, "400px wide");
    is(Math.round(page.height), Math.round(browser.closest(".browserContainer").getBoundingClientRect().height), "The page keeps its full height under it");
    for (const [selector, name] of [
      [".whimsy-find-field .findbar-textbox", "the field"],
      [".findbar-find-previous", "previous"],
      [".findbar-find-next", "next"],
      [".whimsy-find-more", "⋯"],
      [".findbar-closebutton", "close"],
    ]) {
      const el = findbar.querySelector(selector);
      ok(el && el.getBoundingClientRect().width > 0, `It shows ${name}`);
    }
    ok(!findbar.getElement("highlight").getBoundingClientRect().width, "Firefox's checkboxes moved into the menu");
    await typeIn(findbar, "Lisbon");
    await TestUtils.waitForCondition(() => /^\d+\/\d+$/.test(count(findbar) ?? ""), "The count shows current of total");
    ok(findbar.querySelector(".whimsy-find-field .whimsy-find-count").getBoundingClientRect().width > 0, "inside the field");
    const toasts = document.getElementById("zen-toast-container");
    if (toasts) {
      Assert.greaterOrEqual(parseFloat(getComputedStyle(toasts).top), page.top + 54, "Zen's toasts line up under the card");
    }
    await closeFind(findbar);
    ok(!document.documentElement.hasAttribute("whimsy-find-card-open"), "and go back up when it closes");
  });
});

add_task(async function menu_checkable_rows_drive_findbar() {
  await BrowserTestUtils.withNewTab(PAGE, async () => {
    const findbar = await openFind();
    const more = findbar.querySelector(".whimsy-find-more");
    EventUtils.synthesizeMouseAtCenter(more, {});
    const menu = await TestUtils.waitForCondition(() => {
      const p = document.getElementById("whimsy-find-menu");
      return p?.state == "open" && p;
    }, "⋯ opens the options menu");
    ok(menu.classList.contains("whimsy-surface"), "a styled surface");
    const rows = [...menu.querySelectorAll("[role=option]")];
    Assert.deepEqual(rows.map(r => r.dataset.option), ["highlight", "case", "diacritics", "words", "links"], "Firefox's options, in its order");
    const row = id => menu.querySelector(`[data-option="${id}"]`);
    is(row("highlight").getAttribute("aria-selected"), String(findbar.getElement("highlight").checked), "Highlight All shows its state");

    const caseBox = findbar.getElement("find-case-sensitive");
    const before = caseBox.checked;
    EventUtils.synthesizeMouseAtCenter(row("case"), {});
    is(caseBox.checked, !before, "Match Case flips the find bar's option");
    is(row("case").getAttribute("aria-selected"), String(!before), "and its check");
    EventUtils.synthesizeMouseAtCenter(row("case"), {});
    is(caseBox.checked, before, "and back");

    row("words").focus();
    EventUtils.synthesizeKey("KEY_Enter");
    ok(findbar.getElement("find-entire-word").checked, "Enter checks Whole Words");
    EventUtils.synthesizeKey(" ");
    ok(!findbar.getElement("find-entire-word").checked, "Space unchecks it");

    EventUtils.synthesizeMouseAtCenter(row("links"), {});
    is(findbar.findMode, findbar.FIND_LINKS, "Find in Links Only searches links");
    ok(findbar.hasAttribute("whimsy-links-only"), "and the bar knows");
    EventUtils.synthesizeMouseAtCenter(row("links"), {});
    is(findbar.findMode, findbar.FIND_NORMAL, "and back to the whole page");

    EventUtils.synthesizeKey("KEY_Escape");
    await TestUtils.waitForCondition(() => menu.state == "closed", "Esc closes the menu");
    await TestUtils.waitForCondition(() => document.activeElement == findbar._findField, "back in the field");
    ok(!findbar.hidden, "The find bar stays open");
    // An option toggled just before closing searches again; its late miss
    // ("Lisbon" is no link) must not bring the card back.
    const finder = findbar.browser.finder;
    const missed = new Promise(resolve => {
      const listener = {
        onFindResult(data) {
          if (data.result == Ci.nsITypeAheadFind.FIND_NOTFOUND) {
            finder.removeResultListener(listener);
            resolve(data.result);
          }
        },
      };
      finder.addResultListener(listener);
    });
    WhimsyFindCard.setLinksOnly(findbar, true);
    await closeFind(findbar);
    is(await missed, Ci.nsITypeAheadFind.FIND_NOTFOUND, "Links Only misses after the card closed");
    await TestUtils.waitForTick();
    ok(findbar.hidden, "and the late miss doesn't reopen the card");
  });
});

add_task(async function quick_find_still_works() {
  await BrowserTestUtils.withNewTab(PAGE, async browser => {
    await SpecialPowers.spawn(browser, [], () => content.document.body.focus());
    browser.focus();
    EventUtils.synthesizeKey("/");
    const findbar = await TestUtils.waitForCondition(() => {
      const bar = gBrowser.isFindBarInitialized() && gBrowser.getCachedFindBar();
      return bar && !bar.hidden && bar;
    }, "/ opens Quick Find");
    is(findbar.findMode, findbar.FIND_TYPEAHEAD, "in Quick Find mode");
    ok(findbar.hasAttribute("whimsy-find-card"), "in the floating card");
    EventUtils.sendString("Lisbon");
    await TestUtils.waitForCondition(() => findbar._findField.getAttribute("status") != "pending", "Find ran");
    isnot(findbar._findField.getAttribute("status"), "notfound", "It finds the word");
    ok(findbar.querySelector(".whimsy-find-more").hidden, "Quick Find has no ⋯ menu");
    ok(findbar.querySelector(".whimsy-ask-button").hidden, "and no Ask");
    EventUtils.synthesizeKey("KEY_Escape");
    await TestUtils.waitForCondition(() => findbar.hidden, "Esc closes it");
  });
});

add_task(async function no_match_ask_enter() {
  await BrowserTestUtils.withNewTab(PAGE, async () => {
    const findbar = await openFind();
    const ask = findbar.querySelector(".whimsy-ask-button");
    const wrapper = findbar.querySelector(".whimsy-find-field");
    await typeIn(findbar, "Lisbon");
    ok(!ask.hidden && !ask.hasAttribute("askable"), "Found: Ask keeps its space but isn't offered");
    const fieldWidth = wrapper.getBoundingClientRect().width;

    await typeIn(findbar, "where is the offsite");
    await TestUtils.waitForCondition(() => wrapper.hasAttribute("notfound"), "Nothing found");
    is(count(findbar), "0/0", "The count says so");
    const [r, g, b] = getComputedStyle(findbar.querySelector(".whimsy-find-count")).color.match(/\d+/g).map(Number);
    ok(r > g + 80 && r > b + 60, `in red (rgb ${r}, ${g}, ${b})`);
    await TestUtils.waitForCondition(() => ask.hasAttribute("askable"), "Ask is offered");
    is(wrapper.getBoundingClientRect().width, fieldWidth, "in the space kept for it, so the field doesn't move");

    EventUtils.synthesizeKey("KEY_Enter");
    const panel = await TestUtils.waitForCondition(() => {
      const p = document.getElementById("whimsy-ask-panel");
      return p?.state == "open" && p.querySelector(".whimsy-ask-answer") && p;
    }, "Enter asks, and the answer shows");
    ok(panel.hasAttribute("whimsy-find-card"), "as the card under the bar");
    const bar = findbar.getBoundingClientRect();
    const card = panel.getBoundingClientRect();
    Assert.greaterOrEqual(Math.round(card.top), Math.round(bar.bottom), "below it");
    Assert.lessOrEqual(Math.abs(card.right - bar.right), 12, "right-aligned with it");
    is(panel.querySelector(".whimsy-ask-head .whimsy-ask-question").textContent, "where is the offsite", "The question heads it");
    ok(panel.querySelector(".whimsy-ask-head .whimsy-ask-close"), "with a close button");
    is(panel.querySelector(".whimsy-ask-quote").textContent, "The offsite is on March 14 in Lisbon.", "The passage is quoted");
    const foot = panel.querySelector(".whimsy-ask-foot");
    ok(foot.querySelector(".whimsy-ask-find") && foot.querySelector(".whimsy-ask-continue"), "Find on Page and Continue in chat sit in the foot");
    EventUtils.synthesizeMouseAtCenter(panel.querySelector(".whimsy-ask-close"), {});
    await TestUtils.waitForCondition(() => panel.state == "closed", "× closes the answer");
    await closeFind(findbar);
  });
});

add_task(async function continue_in_chat_moves_qa() {
  await BrowserTestUtils.withNewTab(PAGE, async () => {
    const tab = gBrowser.selectedTab;
    const findbar = await openFind();
    await typeIn(findbar, "where is the offsite");
    const ask = findbar.querySelector(".whimsy-ask-button");
    await TestUtils.waitForCondition(() => ask.hasAttribute("askable"), "Ask is offered");
    EventUtils.synthesizeMouseAtCenter(ask, {});
    const panel = await TestUtils.waitForCondition(() => {
      const p = document.getElementById("whimsy-ask-panel");
      return p?.state == "open" && p.querySelector(".whimsy-ask-continue") && p;
    }, "The answer shows");
    EventUtils.synthesizeMouseAtCenter(panel.querySelector(".whimsy-ask-continue"), {});
    await TestUtils.waitForCondition(() => panel.state == "closed", "The card closes");
    const chat = await TestUtils.waitForCondition(() => document.getElementById("whimsy-chat"), "The chat opens");
    const [thread] = await WhimsyAIStore.threads({ kind: "tab", tabKey: WhimsyAIContext.tabKey(tab) });
    ok(thread, "in the tab's own chat");
    const messages = await WhimsyAIStore.messages(thread.id);
    Assert.deepEqual(messages.slice(-2).map(m => [m.role, m.text]), [
      ["user", "where is the offsite"],
      ["ai", "The offsite is in Lisbon on March 14."],
    ], "The question and its answer moved in");
    is(messages.at(-1).citations[0].source.quote, "The offsite is on March 14 in Lisbon.", "with the passage as its source");
    await TestUtils.waitForCondition(() => chat.querySelector('.whimsy-chat-msg[data-role="ai"] .whimsy-chat-cite'), "The chat shows it with its chip");
    WhimsyChat.close(window, { reason: "hide" });
    await closeFind(findbar);
  });
});
