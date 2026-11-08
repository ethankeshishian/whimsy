/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// W23 cmdbar-ai: Recent answer and Updates at the top of the command bar,
// ⌘1–⌘9 rows, and the VPN status strip.

Services.scriptloader.loadSubScript(getRootDirectory(gTestPath) + "head_cmdbar_ai.js", this);

const { WhimsyUndo } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyUndo.sys.mjs");
const { WhimsyVPN } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyVPN.sys.mjs");

requestLongerTimeout(2);

let clock = Date.now();


add_setup(async function () {
  await setupAI();
});

async function fresh() {
  await freshStore();
  clock = Date.now();
  WhimsyAIUpdates._setClockForTesting(() => clock);
}

const groupOf = row => gURLBar.view.getResultFromElement(row)?.payload.group;

add_task(async function recent_answer_row_for_10_minutes_then_gone() {
  await fresh();
  WhimsyAIUpdates.setRecentAnswer({ question: Q, tabTitle: "The best laptops", text: "Light.", citations: [], opened: [], sources: 0, at: clock });
  await openEmptyBar();
  is(updateRows().length, 1, "A Recent answer row on top");
  is(groupOf(updateRows()[0]), "recent", "in its own section");
  is(await labelOf(updateRows()[0], "Recent answer"), "Recent answer", "headed Recent answer");
  await closeBar();
  clock += 11 * 60 * 1000;
  await openEmptyBar();
  is(updateRows().length, 0, "Gone after 10 minutes");
  await closeBar();
});

add_task(async function backspace_removes_recent() {
  await fresh();
  WhimsyAIUpdates.setRecentAnswer({ question: Q, tabTitle: "x", text: "Light.", citations: [], opened: [], sources: 0, at: clock });
  await openEmptyBar();
  is(gURLBar.view.selectedRowIndex, -1, "Nothing is pre-selected");
  EventUtils.synthesizeKey("KEY_ArrowDown");
  EventUtils.synthesizeKey("KEY_Backspace");
  await TestUtils.waitForCondition(() => !WhimsyAIUpdates.recentAnswer(), "⌫ removed it");
  await TestUtils.waitForCondition(() => !updateRows().length, "and the row");
  await closeBar();
});

add_task(async function recent_answer_reopens_card_as_left() {
  await fresh();
  WhimsyAIUpdates.setRecentAnswer({ question: Q, tabTitle: "x", text: "The 13-inch is lightest.", citations: [{ n: 1, at: 5, source: { url: "https://example.org/", title: "Specs" } }], opened: [1], sources: 1, provider: "claude", at: clock });
  await openEmptyBar();
  EventUtils.synthesizeKey("KEY_ArrowDown");
  EventUtils.synthesizeKey("KEY_Enter");
  await TestUtils.waitForCondition(() => cardEl()?.querySelector(".whimsy-ask-body"), "The card came back");
  ok(cardEl().querySelector(".whimsy-ask-source[visited]"), "with the opened source marked");
  is(calls.length, 0, "without asking again");
  await closeBar();
});

add_task(async function updates_order_and_show_more() {
  await fresh();
  for (let i = 1; i <= 6; i++) {
    clock += 1000;
    await post(i);
  }
  clock += 1000;
  await post("needs", { needsYou: true, title: "Sam asked you to review" });
  await openEmptyBar();
  let list = updateRows();
  is(list[0].querySelector(".whimsy-update-title").textContent, "Sam asked you to review", "Needs you first");
  is(list[1].querySelector(".whimsy-update-title").textContent, "Update 6", "then newest");
  is(list.length, 6, "Five, then Show more");
  is(await labelOf(list[0], "Updates"), "Updates", "headed Updates");
  const more = list[5];
  is(document.l10n.getAttributes(more.querySelector(".urlbarView-title")).args.count, 2, "Show 2 more");
  EventUtils.synthesizeMouseAtCenter(more.querySelector(".whimsy-update-more"), {});
  await TestUtils.waitForCondition(() => updateRows().length == 7, "Expanded in place");
  ok(gURLBar.hasAttribute("whimsy-updates-expanded"), "and scrolls inside the bar");
  await closeBar();
});

add_task(async function while_closed_group_has_own_dismiss_all() {
  await fresh();
  await post(1, { whileClosed: true, title: "Ran once for 2 misses" });
  await post(2);
  await openEmptyBar();
  const list = updateRows();
  is(await labelOf(list[0], "While Whimsy was closed"), "While Whimsy was closed", "Catch-ups first");
  is(await labelOf(list[1], "Updates"), "Updates", "then Updates");
  const all = headingRows()[0].querySelector(".whimsy-update-dismiss-all");
  ok(!all.hidden, "The group has its own Dismiss all");
  EventUtils.synthesizeMouseAtCenter(all, {});
  await TestUtils.waitForCondition(async () => (await WhimsyAIUpdates.list()).whileClosed.length == 0, "Dismissed the catch-ups");
  is((await WhimsyAIUpdates.list()).updates.length, 1, "Updates stay");
  await closeBar();
});

add_task(async function remind_menu_times_and_returns_at_top() {
  const base = new Date(2026, 10, 4, 10, 52).getTime(); // a Wednesday
  const t = remindTimes(base);
  is(t[0].at, base + 3600000, "In 1 hour");
  is(new Date(t[1].at).getHours(), 18, "This evening at 6 PM");
  is(new Date(t[2].at).getHours(), 8, "Tomorrow morning at 8 AM");
  is(new Date(t[3].at).getDay(), 1, "Next week is a Monday");
  is(new Date(t[3].at).getHours(), 8, "at 8 AM");
  await fresh();
  await post(1, { title: "Prep for Design review" });
  clock += 1000;
  await post(2);
  await openEmptyBar();
  EventUtils.synthesizeKey("KEY_ArrowDown");
  EventUtils.synthesizeKey("KEY_ArrowDown");
  EventUtils.synthesizeKey("KEY_Tab");
  EventUtils.synthesizeKey("KEY_Tab");
  ok(gURLBar.view.selectedElement?.classList.contains("whimsy-update-remind"), "Tab walks Open, then Remind me");
  const shown = BrowserTestUtils.waitForEvent(document, "popupshown", false, e => e.target.id == "whimsy-cmdbar-remind-menu");
  EventUtils.synthesizeKey("KEY_Enter");
  await shown;
  const menu = document.getElementById("whimsy-cmdbar-remind-menu");
  is(menu.querySelectorAll("[role=option]").length, 5, "Five choices");
  menu.querySelector("[role=option]").click();
  await TestUtils.waitForCondition(async () => (await WhimsyAIUpdates.list()).updates.length == 1, "It left Updates");
  clock += 3600000 + 1000;
  const back = (await WhimsyAIUpdates.list()).updates;
  is(back[0].title, "Prep for Design review", "and came back on top");
  await closeBar();
});

add_task(async function dismiss_toast_undo_cmd_z() {
  await fresh();
  await post(1);
  await openEmptyBar();
  EventUtils.synthesizeKey("KEY_ArrowDown");
  EventUtils.synthesizeKey("KEY_Backspace");
  await TestUtils.waitForCondition(async () => (await WhimsyAIUpdates.list()).updates.length == 0, "⌫ dismissed it");
  await TestUtils.waitForCondition(() => document.querySelector("#zen-toast-container [data-l10n-id='whimsy-cmdbar-dismissed-toast'], .zen-toast") , "A toast says so");
  info(`undo: canUndo=${WhimsyUndo.canUndo(window)} value="${gURLBar.value}" focused=${gURLBar.focused}`);
  EventUtils.synthesizeKey("z", { accelKey: true });
  await TestUtils.waitForCondition(async () => (await WhimsyAIUpdates.list()).updates.length == 1, "⌘Z brought it back");
  await closeBar();
});

add_task(async function watch_hit_return_opens_page_cmd_return_thread() {
  await fresh();
  const thread = await WhimsyAIStore.createThread({ kind: "watch", title: "Price watch" });
  await WhimsyAIStore.append(thread.id, { role: "ai", text: "Dropped to $899." });
  await WhimsyAIUpdates.post({ source: "watch", title: "MacBook Air dropped to $899", url: ARTICLE, threadId: thread.id });
  await openEmptyBar();
  EventUtils.synthesizeKey("KEY_ArrowDown");
  const opened = BrowserTestUtils.waitForNewTab(gBrowser, ARTICLE);
  EventUtils.synthesizeKey("KEY_Enter");
  BrowserTestUtils.removeTab(await opened);
  await fresh();
  await WhimsyAIUpdates.post({ source: "watch", title: "MacBook Air dropped to $899", url: ARTICLE, threadId: thread.id });
  await openEmptyBar();
  EventUtils.synthesizeKey("KEY_ArrowDown");
  EventUtils.synthesizeKey("KEY_Enter", { accelKey: true });
  await TestUtils.waitForCondition(() => WhimsyChat.isOpen(window), "⌘↩ opened the watch's thread");
  WhimsyChat.close(window, { reason: "key" });
});

add_task(async function needs_you_leads_with_next_step() {
  await fresh();
  await post(1, { needsYou: true, nextStep: { l10nId: "whimsy-cmdbar-try-again", command: "cmd_whimsyAskAI" } });
  await openEmptyBar();
  const row = updateRows()[0];
  ok(!row.querySelector(".whimsy-update-needs").hidden, "Needs you badge");
  is(document.l10n.getAttributes(row.querySelector(".whimsy-update-open")).id, "whimsy-cmdbar-try-again", "Its next step takes Open's place");
  await closeBar();
});

add_task(async function word_now_never_appears() {
  const ftl = await (await fetch("chrome://browser/locale/browser/whimsy.ftl").catch(() => null))?.text?.();
  if (ftl) {
    const block = ftl.slice(ftl.indexOf("## W23 cmdbar-ai"));
    const end = block.indexOf("\n## ", 5);
    ok(!/\bNow\b/.test(end > 0 ? block.slice(0, end) : block), "No 'Now' in this lane's copy");
  }
  await fresh();
  await post(1);
  await openEmptyBar();
  ok(!/\bNow\b/.test(gURLBar.view.panel.textContent), "None on screen");
  await closeBar();
});

add_task(async function cmd_digit_picks_row_while_open() {
  await fresh();
  await post(1);
  clock += 1000;
  await post(2, { url: ARTICLE });
  await openEmptyBar();
  const opened = BrowserTestUtils.waitForNewTab(gBrowser, ARTICLE);
  EventUtils.synthesizeKey("1", { accelKey: true });
  BrowserTestUtils.removeTab(await opened);
  ok(!gURLBar.view.isOpen, "⌘1 picked the first row and closed the bar");
});

add_task(async function hold_cmd_shows_numbers() {
  await fresh();
  await post(1);
  await openEmptyBar();
  EventUtils.synthesizeKey("KEY_Meta", { type: "keydown", metaKey: true });
  await TestUtils.waitForCondition(() => gURLBar.hasAttribute("whimsy-numbers"), "Holding ⌘ shows numbers");
  is(updateRows()[0].getAttribute("whimsy-num"), "⌘1", "counting rows");
  EventUtils.synthesizeKey("KEY_Meta", { type: "keyup" });
  ok(!gURLBar.hasAttribute("whimsy-numbers"), "Letting go hides them");
  await closeBar();
});

add_task(async function closed_cmd_digit_switches_tabs() {
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, "about:blank");
  ok(!gURLBar.view.isOpen, "The bar is closed");
  gBrowser.selectedBrowser.focus();
  let prevented = null;
  const seen = e => {
    if (e.key == "1") {
      prevented = e.defaultPrevented;
    }
  };
  window.addEventListener("keydown", seen);
  EventUtils.synthesizeKey("1", { accelKey: true });
  window.removeEventListener("keydown", seen);
  is(prevented, false, "⌘1 with the bar closed is left to tab switching");
  BrowserTestUtils.removeTab(tab);
});

add_task(async function vpn_strip_only_when_not_off() {
  await typeInBar("vpn");
  WhimsyVPN.updateStrip(window, "on", "browser");
  const strip = document.getElementById("whimsy-cmdbar-vpn");
  ok(strip && !strip.hidden, "VPN on: the strip shows");
  is(document.l10n.getAttributes(strip.querySelector(".whimsy-cmdbar-vpn-label")).id, "whimsy-cmdbar-vpn-on", "VPN on");
  ok(strip.getAttribute("role") == "status" && !strip.querySelector("button"), "An indicator, not a button");
  WhimsyVPN.updateStrip(window, "paused", null);
  is(strip.getAttribute("state"), "paused", "Paused for a call");
  WhimsyVPN.updateStrip(window, "off", null);
  ok(strip.hidden, "Off: no strip");
  WhimsyVPN.updateUi(window);
  await closeBar();
});

add_task(async function no_engine_chip() {
  await typeInBar("hello");
  const chip = document.getElementById("urlbar-searchmode-switcher");
  ok(!chip || chip.getBoundingClientRect().width == 0, "No search-engine chip in the bar");
  const vpn = document.getElementById("whimsy-vpn-urlbar");
  ok(!vpn || !gURLBar.hasAttribute("zen-floating-urlbar") || vpn.getBoundingClientRect().width == 0, "No VPN control in the floating bar");
  ok(document.getElementById("whimsy-cmdbar-mic-slot"), "The mic slot is there for the mic");
  await closeBar();
});
