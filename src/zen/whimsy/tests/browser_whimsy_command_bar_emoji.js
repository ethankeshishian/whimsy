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
const DANCERS = "\u{1F46F}"; // 👯 (base of the 👯/👯‍♂️/👯‍♀️ gender-variant family)
const TONGUE = "\u{1F61B}"; // 😛
const WINK_TONGUE = "\u{1F61C}"; // 😜

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

// Seeds the frequent list so it sorts to this exact order (most to least
// recent breaks the tie at count 1; see WhimsyEmojiFrequent.record/top).
function seedFrequent(order) {
  WhimsyEmojiFrequent.clear();
  for (const emoji of [...order].reverse()) {
    WhimsyEmojiFrequent.record(window, emoji);
  }
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
  // The 8 columns span the results' full width (1fr each) — not fixed-size
  // columns that left a big empty area to the right of the grid — while a
  // fixed row height keeps cells from stretching tall the way 1fr columns
  // used to (aspect-ratio: 1, now removed, was what made them tall).
  const cellRect = el.querySelector(".whimsy-emoji-cell").getBoundingClientRect();
  const gridRect = grid.getBoundingClientRect();
  const cardRect = el.getBoundingClientRect();
  ok(Math.abs(cellRect.height - 48) < 2, "Cells have a fixed ~48px row height");
  ok(cellRect.width > cellRect.height, "Cells aren't square: the column is wider than the fixed row height");
  // Not `cardRect.width` itself: the card has its own horizontal padding
  // (whimsy-emoji.css, .whimsy-emoji-card), so the grid is inset a bit —
  // just nowhere near the ~55%-wide bug this regresses.
  ok(gridRect.width > cardRect.width * 0.85, "The grid spans the full results width, not just the left ~55%");
  const emojiSize = parseFloat(window.getComputedStyle(el.querySelector(".whimsy-emoji-cell")).fontSize);
  ok(Math.abs(emojiSize - 30) < 2, "The emoji glyph itself is about 30px, not lost in an oversized cell");

  const footer = el.querySelector(".whimsy-emoji-footer");
  ok(footer, "A footer is shown, naming the selected emoji");
  ok(window.gURLBar.contains(footer), "The footer is inside the command bar, not a separate popup");

  // Visible, not just present: a real size, and not clipped by any
  // ancestor's overflow (the bug this regresses: a huge, stretched grid
  // pushed the footer below the panel's clipped bounds).
  const rect = footer.getBoundingClientRect();
  ok(rect.width > 0 && rect.height > 0, "The footer has a non-zero size");
  let clippedBy = null;
  for (let anc = footer.parentElement; anc && anc != window.gURLBar.parentElement; anc = anc.parentElement) {
    const ancRect = anc.getBoundingClientRect();
    const overflow = window.getComputedStyle(anc).overflow;
    if (/hidden|clip/.test(overflow) && (rect.bottom > ancRect.bottom + 0.5 || rect.top < ancRect.top - 0.5)) {
      clippedBy = anc;
      break;
    }
  }
  ok(!clippedBy, `The footer isn't clipped by an ancestor's overflow${clippedBy ? ` (${clippedBy.className})` : ""}`);
  await document.l10n.translateFragment(footer);
  ok(footer.textContent.trim().length > 0, "The footer has visible text");
  ok(footer.textContent.includes("↵"), "Shows the Enter shortcut");
  // Whether ⌘↵ also shows (and isn't a duplicate of ↵) depends on whether a
  // field is focused — covered by test_footer_label_reflects_insert_target.
  closeBar();
});

// The real page's identity icon (here, the "no site" state's search-glass
// placeholder) must not show through the grid, and the mockup's own search
// icon takes its place — not just a blank gap (the bug this regresses: a
// `#urlbar:has(.urlbarView-row[...])` selector that never matched, because
// the urlbarView's panel isn't a DOM descendant of #urlbar).
add_task(async function test_identity_icon_hidden_behind_grid() {
  await openEmoji("party");
  ok(window.gURLBar.view.isOpen, "The grid is open");
  const urlbar = window.document.getElementById("urlbar");
  ok(urlbar.hasAttribute("whimsy-emoji-open"), "The urlbar is marked as having the grid open");
  const identityBox = window.document.getElementById("identity-box");
  ok(identityBox, "#identity-box exists");
  const icon = identityBox?.querySelector("#identity-icon, image, .identity-icon");
  if (icon) {
    const rect = icon.getBoundingClientRect();
    is(rect.width, 0, "The real identity icon has no width while the grid is open");
    is(rect.height, 0, "The real identity icon has no height while the grid is open");
  }
  const beforeContent = identityBox && window.getComputedStyle(identityBox, "::before").content;
  ok(beforeContent && beforeContent != "none", "A replacement search icon is drawn in its place");
  closeBar();
  await TestUtils.waitForCondition(() => !urlbar.hasAttribute("whimsy-emoji-open"), "The marker comes off once the bar closes");
});

// TEMPORARY DIAGNOSTIC — W24 emoji4, reverted before this lane finishes.
add_task(async function test_zzz_temp_diag_trust_icon() {
  await openEmoji("party");
  const win = window;
  const identityBox = win.document.getElementById("identity-box");
  const boxRect = identityBox.getBoundingClientRect();
  const probeX = boxRect.left - 10;
  const probeY = boxRect.top + boxRect.height / 2;
  const topEl = win.document.elementFromPoint(probeX, probeY);
  info("WDIAG2 probe=" + probeX + "," + probeY + " topEl=" + (topEl ? `${topEl.tagName}#${topEl.id}.${topEl.className}` : "null"));
  let chain = "";
  for (let el = topEl; el; el = el.parentElement) {
    chain += `${el.tagName}#${el.id || ""} `;
  }
  info("WDIAG2 chain=" + chain);
  for (const id of ["trust-icon-container", "tracking-protection-icon-container", "remote-control-box"]) {
    const el = win.document.getElementById(id);
    if (!el) {
      info(`WDIAG2 ${id}=missing`);
      continue;
    }
    const rect = el.getBoundingClientRect();
    const disp = win.getComputedStyle(el).display;
    info(`WDIAG2 ${id} display=${disp} rect=${JSON.stringify(rect)}`);
  }
  closeBar();
});

add_task(async function test_footer_label_reflects_insert_target() {
  const typeLabel = () => card().querySelector(".whimsy-emoji-footer-keys > span:first-child > span")?.getAttribute("data-l10n-id");
  const shortcutSpans = () => card().querySelectorAll(".whimsy-emoji-footer-keys > span").length;

  const tab = await openFieldTab("<textarea id=t></textarea>", "t");
  try {
    await openEmoji("party");
    await TestUtils.waitForCondition(() => typeLabel() == "whimsy-emoji-footer-type", "↵ says Type into the page when a field is focused");
    is(shortcutSpans(), 2, "With a field, both ↵ Type into the page and ⌘↵ Copy show");
    closeBar();
  } finally {
    BrowserTestUtils.removeTab(tab);
  }

  const tab2 = await BrowserTestUtils.openNewForegroundTab(gBrowser, "data:text/html,<body></body>");
  try {
    await openEmoji("party");
    await TestUtils.waitForCondition(() => typeLabel() == "whimsy-emoji-footer-copy", "↵ says Copy when nothing is focused");
    // Not also ⌘↵ Copy: that would be the same action shown twice.
    is(shortcutSpans(), 1, "With no field, only ↵ Copy shows — no duplicate ⌘↵ Copy");
    closeBar();
  } finally {
    BrowserTestUtils.removeTab(tab2);
  }
});

add_task(async function test_party_dedupes_variants_and_drops_tongue_faces() {
  const el = await openEmoji("party");
  const cells = [...el.querySelectorAll(".whimsy-emoji-cell")].map(c => c.textContent);
  is(cells[0], PARTY, "The party popper is first");
  is(cells.filter(e => e.startsWith(DANCERS)).length, 1, "The dancer twins' gender variants collapse into one cell");
  // 😛/😜 are curated (a name and keywords, neither mentioning "party") —
  // Zen's loose "party" keyboard-category tag no longer counts as a match
  // for a curated emoji, so they're dropped from "party" results entirely,
  // not just demoted out of the first row.
  ok(!cells.includes(TONGUE) && !cells.includes(WINK_TONGUE), "Tongue-out faces (Zen's loose 'party' tag) don't match 'party' at all");
  closeBar();

  // But they're still findable by their own curated name/keywords.
  const tongueEl = await openEmoji("tongue");
  const tongueCells = [...tongueEl.querySelectorAll(".whimsy-emoji-cell")].map(c => c.textContent);
  ok(tongueCells.includes(TONGUE), "😛 still matches its own curated name");
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

add_task(async function test_stale_state_does_not_hijack_a_later_enter() {
  // Open the grid, then change the bar to a plain URL without ever
  // closing the popup (isActive() goes false, but nothing fires
  // popuphidden) — the capture-phase keydown listener used to keep acting
  // on the now-stale grid state and swallow this Enter instead of letting
  // it load.
  const el = await openEmoji("party");
  ok(el.querySelector(".whimsy-emoji-cell"), "The grid was showing");
  const url = "https://example.com/";
  await UrlbarTestUtils.promiseAutocompleteResultPopup({ window, waitForFocus, value: url });
  const newTab = BrowserTestUtils.waitForNewTab(gBrowser, url, true);
  EventUtils.synthesizeKey("KEY_Enter", {}, window);
  const tab = await newTab;
  is(gBrowser.selectedTab, tab, "Enter loaded the URL instead of being hijacked by stale grid state");
  BrowserTestUtils.removeTab(tab);
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

add_task(async function test_skin_tone_applied_without_opening_tone_row() {
  WhimsyEmojiFrequent.clear();
  await SpecialPowers.pushPrefEnv({ set: [[TONE_PREF, 3]] });
  const tab = await openFieldTab("<textarea id=t></textarea>", "t");
  try {
    await openEmoji("thumb up");
    EventUtils.synthesizeKey("KEY_Enter", {}, window); // no Tab: the tone still comes from the pref
    await TestUtils.waitForCondition(
      async () => (await fieldValue(tab, "t")).includes("\u{1F3FD}"), // medium skin tone modifier
      "Enter alone (no tone row) still applied the skin-tone pref"
    );
  } finally {
    await SpecialPowers.popPrefEnv();
    BrowserTestUtils.removeTab(tab);
  }
});

// 5.1, 5.2, 5.4 and 5.5 of the mockup, light and dark. Every shot closes
// its own toasts first, so an earlier task's "Copied …" can never linger
// into one (the bug this regresses).
add_task(async function test_screenshots() {
  closeToasts();

  // 5.1 — a query with results ("party").
  await whimsyBothSchemes("w24-emoji-5.1", async () => {
    closeToasts();
    await openEmoji("party");
    return () => closeBar();
  });

  // 5.2 — just ":": frequent emoji, then Smileys.
  await whimsyBothSchemes("w24-emoji-5.2", async () => {
    closeToasts();
    seedFrequent(["\u{1F44D}", PARTY, "\u{1F64F}", "✅", "\u{1F440}", "\u{1F525}", "\u{1F602}", "❤️"]);
    await openEmoji("");
    return () => {
      closeBar();
      WhimsyEmojiFrequent.clear();
    };
  });

  // 5.4 — nothing focused: Enter copies and toasts (the bar itself closes).
  await whimsyBothSchemes("w24-emoji-5.4", async () => {
    closeToasts();
    await openEmoji("party");
    EventUtils.synthesizeKey("KEY_Enter", {}, window);
    await TestUtils.waitForCondition(() => window.gZenUIManager.toasts.getToasts().length > 0, "A toast showed");
    return () => closeToasts();
  });

  // 5.5 — the tone row, open on a tone-capable emoji.
  await whimsyBothSchemes("w24-emoji-5.5", async () => {
    closeToasts();
    await openEmoji("thumb up");
    EventUtils.synthesizeKey("KEY_Tab", {}, window);
    await TestUtils.waitForCondition(() => card().querySelector(".whimsy-emoji-tone.on"), "The tone row opened");
    return () => closeBar();
  });

  closeBar();
  WhimsyEmojiFrequent.clear();
});
