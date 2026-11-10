/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// W24 emoji: emoji from the command bar (":" in the bar, or the Emoji
// command). Mockup: docs/superpowers/mockups/w24/05-emoji.html.

ChromeUtils.defineESModuleGetters(this, {
  UrlbarTestUtils: "resource://testing-common/UrlbarTestUtils.sys.mjs",
  WhimsyEmojiFrequent: "resource:///modules/whimsy/WhimsyEmojiFrequent.sys.mjs",
});

const FEATURE = "whimsy.feature.command-bar-emoji";
const TONE_PREF = "whimsy.spaces.emoji-skin-tone";
const PARTY = "\u{1F389}"; // 🎉

function card() {
  return window.gURLBar.view.panel.querySelector(".whimsy-emoji-card");
}

async function openEmoji(query, win = window) {
  await UrlbarTestUtils.promiseAutocompleteResultPopup({ window: win, waitForFocus, value: ":" + query });
  const el = win.gURLBar.view.panel.querySelector(".whimsy-emoji-card");
  await TestUtils.waitForCondition(
    () => el.querySelector(".whimsy-emoji-cell, .whimsy-emoji-empty"),
    "The grid drew"
  );
  return el;
}

function closeBar(win = window) {
  if (win.gURLBar.view.isOpen) {
    win.gURLBar.view.close();
  }
  win.gURLBar.handleRevert();
}

// On https (matching the WhimsyEmoji actor's registration; a data: URL
// doesn't), with one focused element already in it.
async function openFieldTab(tagHtml, id) {
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.com/");
  await SpecialPowers.spawn(tab.linkedBrowser, [tagHtml, id], (html, elId) => {
    content.document.body.insertAdjacentHTML("beforeend", html);
    content.document.getElementById(elId).focus();
  });
  return tab;
}

async function fieldValue(tab, id) {
  return SpecialPowers.spawn(tab.linkedBrowser, [id], elId => content.document.getElementById(elId).value);
}

add_setup(async function () {
  await SpecialPowers.pushPrefEnv({ set: [[FEATURE, true]] });
  WhimsyEmojiFrequent.clear();
  registerCleanupFunction(() => {
    WhimsyEmojiFrequent.clear();
    Services.prefs.clearUserPref(TONE_PREF);
  });
});

add_task(async function test_party_shows_tada_first() {
  const el = await openEmoji("party");
  const cells = [...el.querySelectorAll(".whimsy-emoji-cell")];
  ok(cells.length > 0, "Results are shown");
  is(cells[0].textContent, PARTY, "The party popper is first");
  closeBar();
});

add_task(async function test_grid_geometry_and_footer() {
  const el = await openEmoji("party");
  const grid = el.querySelector(".whimsy-emoji-grid");
  const columns = window.getComputedStyle(grid).gridTemplateColumns.trim().split(/\s+/);
  is(columns.length, 8, "Eight columns");
  is(new Set(columns).size, 1, "The columns are equal");
  const footer = el.querySelector(".whimsy-emoji-footer");
  ok(footer, "A footer is shown, naming the selected emoji");
  ok(window.gURLBar.contains(footer), "The footer is inside the command bar, not a separate popup");
  closeBar();
});

add_task(async function test_insert_into_focused_textarea_and_undo() {
  WhimsyEmojiFrequent.clear();
  const tab = await openFieldTab("<textarea id=t></textarea>", "t");
  try {
    await openEmoji("party");
    EventUtils.synthesizeKey("KEY_ArrowRight", {}, window);
    EventUtils.synthesizeKey("KEY_ArrowLeft", {}, window);
    EventUtils.synthesizeKey("KEY_Enter", {}, window);
    await TestUtils.waitForCondition(async () => (await fieldValue(tab, "t")) == PARTY, "Enter typed the emoji into the focused textarea");
    await SpecialPowers.spawn(tab.linkedBrowser, [], () => {
      content.document.getElementById("t").focus();
      content.document.execCommand("undo");
    });
    await TestUtils.waitForCondition(async () => (await fieldValue(tab, "t")) == "", "Undo removed it");
  } finally {
    BrowserTestUtils.removeTab(tab);
  }
});

add_task(async function test_password_field_copies_instead() {
  WhimsyEmojiFrequent.clear();
  const tab = await openFieldTab("<input id=p type=password>", "p");
  try {
    await openEmoji("party");
    EventUtils.synthesizeKey("KEY_Enter", {}, window);
    await TestUtils.waitForCondition(() => SpecialPowers.getClipboardData("text/plain") == PARTY, "Copied instead of typed");
    is(await fieldValue(tab, "p"), "", "Never typed into the password field");
  } finally {
    BrowserTestUtils.removeTab(tab);
  }
});

add_task(async function test_no_focus_copies_and_toasts() {
  WhimsyEmojiFrequent.clear();
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, "data:text/html,<body></body>");
  try {
    await openEmoji("party");
    EventUtils.synthesizeKey("KEY_Enter", {}, window);
    await TestUtils.waitForCondition(() => SpecialPowers.getClipboardData("text/plain") == PARTY, "Copied");
    await TestUtils.waitForCondition(() => window.gZenUIManager.toasts.getToasts().length > 0, "A toast showed");
    closeToasts();
  } finally {
    BrowserTestUtils.removeTab(tab);
  }
});

add_task(async function test_nonsense_offers_web_search() {
  const el = await openEmoji("zzqqxxnonsense");
  ok(el.querySelector(".whimsy-emoji-search-web"), "A nonsense query offers a web search");
  ok(!el.querySelector(".whimsy-emoji-cell"), "and shows no grid");
  closeBar();
});

add_task(async function test_frequent_first_and_not_from_private() {
  WhimsyEmojiFrequent.clear();
  const privWin = await BrowserTestUtils.openNewBrowserWindow({ private: true });
  try {
    await openEmoji("rocket", privWin);
    EventUtils.synthesizeKey("KEY_Enter", {}, privWin);
    is(WhimsyEmojiFrequent.top(5).length, 0, "A pick in a private window isn't remembered");
  } finally {
    await BrowserTestUtils.closeWindow(privWin);
  }

  const picked = (await openEmoji("rocket")).querySelector(".whimsy-emoji-cell").textContent;
  EventUtils.synthesizeKey("KEY_Enter", {}, window); // nothing focused here: copies, and records it
  closeToasts();

  const el = await openEmoji("");
  const first = el.querySelector(".whimsy-emoji-sec");
  await document.l10n.translateFragment(el);
  is(first.textContent, "Frequently used", "The frequent section leads");
  is(el.querySelector(".whimsy-emoji-cell").textContent, picked, "The just-picked emoji is first in it");
  closeBar();
});

add_task(async function test_skin_tone_applied() {
  WhimsyEmojiFrequent.clear();
  await SpecialPowers.pushPrefEnv({ set: [[TONE_PREF, 3]] });
  const tab = await openFieldTab("<textarea id=t></textarea>", "t");
  try {
    await openEmoji("thumb up");
    ok(window.gURLBar.view.panel.querySelector(".whimsy-emoji-cell"), "Thumbs up is found");
    EventUtils.synthesizeKey("KEY_Tab", {}, window);
    await TestUtils.waitForCondition(() => card().querySelector(".whimsy-emoji-tone.on"), "The tone row opened on the saved tone");
    EventUtils.synthesizeKey("KEY_Enter", {}, window);
    await TestUtils.waitForCondition(
      async () => (await fieldValue(tab, "t")).includes("\u{1F3FD}"), // medium skin tone modifier
      "The chosen skin tone was typed"
    );
  } finally {
    await SpecialPowers.popPrefEnv();
    BrowserTestUtils.removeTab(tab);
  }
});

add_task(async function test_screenshots() {
  await openEmoji("party");
  await whimsySetScheme(false);
  await whimsyShot("w24-emoji-light");
  await whimsySetScheme(true);
  await whimsyShot("w24-emoji-dark");
  await SpecialPowers.popPrefEnv();
  await SpecialPowers.popPrefEnv();
  closeBar();
});
