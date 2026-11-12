/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// W23 ⌘K: with AI on in a normal tab, ⌘K ranks commands for what's on
// screen (cmd-3.x, fu-media 3.5 and 4.10). AI off or private: today's verbs.

const { WhimsyVerbs, WhimsyContextCommands } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyVerbs.sys.mjs");
const { WhimsyAICommands } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyAICommands.sys.mjs");
const { WhimsyAIProviders } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyAIProviders.sys.mjs");
const { WhimsyAIViewShare } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyAIViewShare.sys.mjs");
const { WhimsyPrivate } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyPrivate.sys.mjs");
const { UrlbarTestUtils } = ChromeUtils.importESModule("resource://testing-common/UrlbarTestUtils.sys.mjs");

UrlbarTestUtils.init(this);

const ROOT = getRootDirectory(gTestPath).replace("chrome://mochitests/content", "https://example.com");
const PAGE = kind => `${ROOT}whimsy_cmdk.html?kind=${kind}`;
const TOUCHED = ["whimsy.ai.enabled", "whimsy.ai.order", "whimsy.ai.quick-text-apple"];
const saved = new Map(TOUCHED.map(name => [name, Services.prefs.prefHasUserValue(name) ? whimsyReadPref(name, Services.prefs.getPrefType(name)) : null]));

function restorePrefs() {
  for (const [name, value] of saved) {
    if (value === null) {
      Services.prefs.clearUserPref(name);
    } else {
      whimsyWritePref(name, Services.prefs.getPrefType(name), value);
    }
  }
}

add_setup(async function () {
  await SpecialPowers.pushPrefEnv({ set: [["whimsy.feature.ai-hints", false]] });
  await WhimsyAICommands._resetForTesting();
  await WhimsyAICommands.init();
  await WhimsyAICommands.save({ name: "Tweet thread", result: "copy", prompt: "Turn {selection} into a thread." });
  await WhimsyAICommands.save({ name: "Search Kagi", result: "link", url: "https://kagi.com/search?q=%s" });
  WhimsyContextCommands.detectLanguage = text => (/[؀-ۿ]/.test(text) ? "ar" : "en");
  Services.prefs.setBoolPref("whimsy.ai.enabled", true);
  registerCleanupFunction(async () => {
    WhimsyContextCommands.detectLanguage = null;
    WhimsyAIViewShare.imageText = null;
    WhimsyAIProviders.setTestProvider(null);
    await closeBar();
    await WhimsyAICommands._resetForTesting();
    restorePrefs();
    await WhimsyAICommands.init();
    closeToasts();
  });
});

async function closeBar() {
  await SimpleTest.promiseFocus(window);
  if (gURLBar.view.isOpen) {
    await UrlbarTestUtils.promisePopupClose(window, () => {
      gURLBar.blur();
      if (gURLBar.view.isOpen) {
        gURLBar.view.close();
      }
    });
  }
  gURLBar.searchMode = null;
  WhimsyVerbs.sessions.delete(window);
}

// A tab on a test page; the bar is closed afterwards even when a check fails.
async function withPage(url, fn) {
  await BrowserTestUtils.withNewTab(url, async browser => {
    try {
      await fn(browser);
    } finally {
      await closeBar();
    }
  });
}

async function select(browser, id) {
  await SpecialPowers.spawn(browser, [id], elementId => {
    const el = content.document.getElementById(elementId);
    if (el.localName == "textarea" || el.localName == "input") {
      el.focus();
      el.setSelectionRange(0, el.value.length);
      return;
    }
    const range = content.document.createRange();
    range.selectNodeContents(el);
    content.getSelection().removeAllRanges();
    content.getSelection().addRange(range);
  });
}

async function cmdK() {
  WhimsyVerbs.sessions.delete(window);
  EventUtils.synthesizeKey("k", { accelKey: true });
  const subject = await TestUtils.waitForCondition(() => WhimsyVerbs.sessions.get(window), "⌘K opened its menu");
  await UrlbarTestUtils.promiseSearchComplete(window);
  return subject;
}

async function shown() {
  await UrlbarTestUtils.promiseSearchComplete(window);
  const out = [];
  for (let i = 0; i < UrlbarTestUtils.getResultCount(window); i++) {
    const { result, element } = await UrlbarTestUtils.getDetailsOfResultAt(window, i);
    out.push({
      id: result.payload.whimsyVerb,
      group: result.rowLabel?.id ?? null,
      args: result.rowLabel?.args ?? null,
      title: result.payload.title,
      tag: result.payload.tag,
      detail: result.payload.detail,
      off: result.payload.dynamicType == "whimsy-verb-off",
      element,
    });
  }
  return out;
}

async function type(text) {
  EventUtils.sendString(text);
  await UrlbarTestUtils.promiseSearchComplete(window);
}

function groupsOf(rows) {
  const out = [];
  for (const row of rows) {
    if (out.at(-1)?.group != row.group) {
      out.push({ group: row.group, args: row.args, ids: [] });
    }
    out.at(-1).ids.push(row.id);
  }
  return out;
}

add_task(async function selection_order() {
  await withPage(PAGE("article"), async browser => {
    await select(browser, "sel");
    await cmdK();
    const groups = groupsOf(await shown());
    Assert.deepEqual(groups.map(g => g.group), ["whimsy-cmdk-group-selection", "whimsy-cmdk-group-verbs", "whimsy-cmdk-group-yours"], "AI text commands, today's verbs, then yours");
    Assert.deepEqual(groups[0].ids, ["ai:explain", "ai:translate", "ai:ask-selection"], "Explain, Translate, Ask about this…");
    is(groups[1].ids[0], "search", "Search stays first among today's verbs");
    ok(!groups[1].ids.includes("translate"), "Translate shows once, as the AI command");
    Assert.deepEqual(groups[2].ids.slice(-1), ["edit-commands"], "Edit commands… is last");
    const rows = await shown();
    is(rows.find(r => r.title == "Tweet thread")?.tag, "Copy", "Your commands are tagged with their output");
    await closeBar();
  });
});

add_task(async function text_field_writing_first_replaces_in_place() {
  const calls = [];
  WhimsyAIProviders.setOrder(["claude"]);
  WhimsyAIProviders.setTestProvider(async function* (provider, request) {
    calls.push(request);
    yield { type: "text", delta: "I think the 14th works better for us." };
  });
  await withPage(PAGE("field"), async browser => {
    await select(browser, "field");
    await cmdK();
    const rows = await shown();
    is(rows[0].group, "whimsy-cmdk-group-field", "The first group is the text field's");
    Assert.deepEqual(rows.slice(0, 3).map(r => r.id), ["ai:improve", "ai:fix", "ai:translate"], "Writing commands come first");
    is(rows[0].tag, "Replace", "They're tagged Replace");
    EventUtils.synthesizeKey("KEY_Enter");
    await TestUtils.waitForCondition(
      async () => (await SpecialPowers.spawn(browser, [], () => content.document.getElementById("field").value)) == "I think the 14th works better for us.",
      "Improve writing replaced the text in the field"
    );
    ok(calls[0].messages.at(-1).content.includes("becuase"), "The field's text went into the prompt");
    const toast = await TestUtils.waitForCondition(() => toastFor("whimsy-cmdk-replaced-toast"), "The Undo toast shows");
    ok(toast, "Replaced, with Undo");
    await SpecialPowers.spawn(browser, [], () => content.document.getElementById("field").focus());
    await WhimsyContextCommands.undoReplace({ context: browser.browsingContext });
    is(await SpecialPowers.spawn(browser, [], () => content.document.getElementById("field").value.startsWith("i think the 14th")), true, "Undo puts the original back");
  });
  WhimsyAIProviders.setTestProvider(null);
  closeToasts();
  restorePrefs();
  Services.prefs.setBoolPref("whimsy.ai.enabled", true);
});

add_task(async function no_ai_rows_in_sensitive_field() {
  await withPage(PAGE("otp"), async browser => {
    await select(browser, "otp");
    await cmdK();
    const rows = await shown();
    ok(!rows.some(r => r.id.startsWith("ai:")), "No AI rows on a one-time code");
    is(rows[0].id, "search", "Today's verbs, Search first");
    await closeBar();
  });
});

add_task(async function view_share_groups_and_ties() {
  await withPage(PAGE("video"), async () => {
    await cmdK();
    const groups = groupsOf(await shown());
    is(groups[0].group, "whimsy-cmdk-group-video-top", "A page the video fills leads with video");
    is(groups[0].args.title, "Weeknight miso salmon", "The heading names the page");
    await closeBar();
  });
  await withPage(PAGE("article"), async () => {
    await cmdK();
    const groups = groupsOf(await shown());
    is(groups[0].group, "whimsy-cmdk-group-article-top", "Text fills the view: article first");
    ok(groups[0].ids.length <= 3, "Each kind shows its top three");
    ok(!groups.some(g => g.group == "whimsy-cmdk-group-image"), "The photo below the fold gets no group");
    await closeBar();
  });
  const subject = { kind: "page", text: "", title: "Mixed", url: "https://a.test/" };
  const order = shares => WhimsyContextCommands.rank(window, subject, { shares, images: [{ area: 100 }], underPointer: null, product: false, textChars: 1000 }).map(g => g.kind);
  Assert.deepEqual(order({ article: 0.3, video: 0.3, image: 0.3 }).slice(0, 3), ["article", "video", "image"], "Ties go article, video, then image");
  Assert.deepEqual(order({ article: 0.2, video: 0.5, image: 0.3 }).slice(0, 3), ["video", "image", "article"], "Otherwise by share of the view");
});

add_task(async function product_page_compare_and_watch_first() {
  const fake = id => ({ id, group: "product", label: id, icon: "chrome://browser/skin/zen-icons/search-glass.svg", run() {} });
  WhimsyVerbs.registerVerb(fake("watch-price"));
  WhimsyVerbs.registerVerb(fake("compare"));
  await withPage(PAGE("product"), async () => {
    await cmdK();
    const groups = groupsOf(await shown());
    is(groups[0].group, "whimsy-cmdk-group-product-top", "A product page leads with its commands");
    Assert.deepEqual(groups[0].ids.slice(0, 2).sort(), ["compare", "watch-price"], "Compare and Watch price on top");
    await closeBar();
  });
  WhimsyVerbs.unregisterVerb("watch-price");
  WhimsyVerbs.unregisterVerb("compare");
});

add_task(async function foreign_selection_translate_first() {
  await withPage(PAGE("foreign"), async browser => {
    await select(browser, "sel");
    await cmdK();
    const rows = await shown();
    is(rows[0].id, "ai:translate", "Text not in your language: Translate jumps to the top");
    ok(/→/.test(rows[0].tag), `It says which way (${rows[0].tag})`);
    ok(/→ English$/.test(rows[0].tag), "naming the language, not the variant (\"English\", not \"American English\")");
    const title = document.getElementById("urlbar-search-mode-indicator-title");
    await TestUtils.waitForCondition(() => title.textContent == "Actions", "Commands mode has its Actions chip (S4)");
    ok(BrowserTestUtils.isVisible(document.getElementById("urlbar-search-mode-indicator")), "and it shows");
    await closeBar();
  });
});

add_task(async function order_frozen_while_open() {
  await withPage(PAGE("article"), async browser => {
    await cmdK();
    const before = groupsOf(await shown()).map(g => g.group);
    await SpecialPowers.spawn(browser, [], () => content.document.getElementById("late").scrollIntoView());
    gURLBar.startQuery({ allowAutofill: false });
    Assert.deepEqual(groupsOf(await shown()).map(g => g.group), before, "The page scrolled under the open menu: the order stays");
    await closeBar();
    await cmdK();
    is(groupsOf(await shown())[0].group, "whimsy-cmdk-group-image", "Opened again, it measures afresh: the photo leads");
    await closeBar();
  });
});

add_task(async function typing_flattens_then_ask_scoped() {
  await withPage(PAGE("video"), async () => {
    await cmdK();
    await type("ask");
    const rows = await shown();
    ok(rows.length && rows.every(r => r.group == "whimsy-cmdk-group-commands"), "Typing drops the groups into one list");
    is(rows[0].id, "ai:ask-video", "Word starts rank first");
    gURLBar.select();
    await type("what does he say about battery");
    const none = await shown();
    is(none[0].id, "ask", "No match: the Ask row");
    is(none[0].tag, "Ask about this video", "Scoped to what's on screen");
    is(none[1].id, "web-search", "Then web search");
    await closeBar();
  });
});

add_task(async function these_n_images_heading() {
  WhimsyAIViewShare.imageText = { hasText: () => false };
  await withPage(PAGE("images"), async () => {
    await cmdK();
    const groups = groupsOf(await shown());
    const images = groups.find(g => g.group == "whimsy-cmdk-group-image");
    is(images?.args.count, 3, "Three images of a size: These 3 images");
    is((await shown()).find(r => r.id == "ai:ask-image")?.title, "Ask about these images", "Ask covers all of them");
    await closeBar();
  });
  await withPage(PAGE("one-image"), async () => {
    await cmdK();
    is(groupsOf(await shown()).find(g => g.group == "whimsy-cmdk-group-image")?.args.count, 1, "One image twice the next one's area: This image");
    await closeBar();
  });
  await withPage(PAGE("images"), async browser => {
    await BrowserTestUtils.synthesizeMouseAtCenter("#b", { type: "mousemove" }, browser);
    await cmdK();
    is(groupsOf(await shown()).find(g => g.group == "whimsy-cmdk-group-image")?.args.count, 1, "The image under the pointer: This image");
    await closeBar();
  });
  WhimsyAIViewShare.imageText = null;
});

add_task(async function unavailable_greyed_with_reason() {
  await withPage(PAGE("empty"), async () => {
    await cmdK();
    await type("summ");
    const rows = await shown();
    const row = rows.find(r => r.id == "ai:summarize-page");
    ok(row?.off, "Summarize page shows greyed");
    is(row.detail, "There’s no text here to summarize.", "with the reason");
    // W25 designfix: a row's description is the bar's one secondary line:
    // no larger than the title, in the muted token, with no joiner.
    const detail = row.element.row.querySelector(".whimsy-cmdk-detail");
    const title = row.element.row.querySelector(".urlbarView-title");
    Assert.lessOrEqual(parseFloat(getComputedStyle(detail).fontSize), parseFloat(getComputedStyle(title).fontSize), "The description is no larger than the title");
    const probe = document.createElementNS("http://www.w3.org/1999/xhtml", "span");
    probe.style.color = "var(--whimsy-ask-muted)";
    detail.parentElement.append(probe);
    is(getComputedStyle(detail).color, getComputedStyle(probe).color, "...in the secondary (muted) colour");
    probe.remove();
    is(getComputedStyle(detail, "::before").content, "none", "No em-dash joiner");
    ok(!row.element.row.querySelector("[selectable]") && !row.element.row.hasAttribute("row-selectable"), "and can't be selected");
    ok(rows.some(r => r.id == "web-search"), "Search is still there");
    await closeBar();
  });
});

add_task(async function ai_off_and_private_unchanged() {
  Services.prefs.setBoolPref("whimsy.ai.enabled", false);
  await withPage(PAGE("article"), async browser => {
    await select(browser, "sel");
    const subject = await cmdK();
    ok(!subject.groups, "AI off: today's verbs");
    const rows = await shown();
    is(rows[0].id, "search", "Search first");
    ok(!rows.some(r => r.id.startsWith("ai:")), "No AI rows");
    await closeBar();
  });
  Services.prefs.setBoolPref("whimsy.ai.enabled", true);
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE("article"));
  const real = WhimsyPrivate.isPrivateTab;
  WhimsyPrivate.isPrivateTab = t => t == tab || real.call(WhimsyPrivate, t);
  try {
    await select(tab.linkedBrowser, "sel");
    const subject = await cmdK();
    ok(!subject.groups, "Private tab: today's verbs, whatever the AI setting");
    await closeBar();
  } finally {
    WhimsyPrivate.isPrivateTab = real;
    BrowserTestUtils.removeTab(tab);
  }
});

// W25 designfix: the Actions chip, the selected row, and the key tag on it
// all take one accent token pair (--whimsy-accent-fill under
// --whimsy-on-accent), which must clear WCAG AA in both themes.
function srgb(color) {
  const canvas = document.createElementNS("http://www.w3.org/1999/xhtml", "canvas");
  canvas.width = canvas.height = 1;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, 1, 1);
  return [...ctx.getImageData(0, 0, 1, 1).data];
}
function luminance([r, g, b]) {
  const lin = c => ((c /= 255) <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}
function contrast(fg, bg) {
  const [a, b] = [luminance(srgb(fg)), luminance(srgb(bg))].sort((x, y) => y - x);
  return (a + 0.05) / (b + 0.05);
}
// The nearest painted (opaque) background behind `el`.
function backgroundOf(el) {
  for (let node = el; node; node = node.parentElement) {
    const bg = getComputedStyle(node).backgroundColor;
    if (srgb(bg)[3] == 255) {
      return bg;
    }
  }
  return "white";
}

add_task(async function accent_pills_and_selected_rows_meet_aa() {
  await withPage(PAGE("field"), async browser => {
    await select(browser, "field");
    for (const dark of [false, true]) {
      await whimsySetScheme(dark);
      try {
        await cmdK();
        const rows = await shown();
        const title = document.getElementById("urlbar-search-mode-indicator-title");
        await TestUtils.waitForCondition(() => title.textContent == "Actions", "The Actions chip");
        const chip = document.getElementById("urlbar-search-mode-indicator");
        const selected = rows[0].element.row ?? rows[0].element;
        const row = selected.closest(".urlbarView-row");
        await TestUtils.waitForCondition(() => row.hasAttribute("selected"), "The first row is selected");
        const tag = row.querySelector(".whimsy-cmdk-tag");
        const scheme = dark ? "dark" : "light";
        for (const [name, el] of [["Actions chip", title], ["selected row title", row.querySelector(".urlbarView-title")], ["its key tag", tag]]) {
          ok(el, `${name} is there`);
          const ratio = contrast(getComputedStyle(el).color, backgroundOf(el));
          Assert.greaterOrEqual(ratio, 4.5, `${scheme}: ${name} contrast is ${ratio.toFixed(2)}:1`);
        }
        is(srgb(getComputedStyle(chip).backgroundColor).join(), srgb(getComputedStyle(row).backgroundColor).join(), `${scheme}: the chip and the selected row share one accent fill`);
        await whimsyShot(`w25-cmdbar-contrast-${scheme}`);
        await closeBar();
      } finally {
        await SpecialPowers.popPrefEnv();
      }
    }
  });
});

// W25 designfix, part of the truncation guard: with a very long query, a
// row's key hint keeps its full text inside the row's padding box and
// never overlaps the title, which ellipses instead.
add_task(async function long_query_keeps_key_hints_whole() {
  await withPage(PAGE("empty"), async () => {
    await UrlbarTestUtils.promiseAutocompleteResultPopup({ window, waitForFocus, value: "lorem ipsum ".repeat(17).slice(0, 200) });
    let checked = 0;
    for (let i = 0; i < UrlbarTestUtils.getResultCount(window); i++) {
      const { element } = await UrlbarTestUtils.getDetailsOfResultAt(window, i);
      const inner = element.row.querySelector(".urlbarView-row-inner");
      const action = inner?.querySelector(".urlbarView-action");
      const title = inner?.querySelector(".urlbarView-title");
      if (!action?.textContent.trim() || !action.checkVisibility() || !title) {
        continue;
      }
      checked++;
      const name = action.textContent.trim();
      ok(action.scrollWidth <= action.clientWidth, `"${name}" isn't truncated`);
      const box = inner.getBoundingClientRect();
      const end = box.right - parseFloat(getComputedStyle(inner).paddingRight);
      const a = action.getBoundingClientRect();
      Assert.lessOrEqual(a.right, end + 0.5, `"${name}" sits inside the row's padding box`);
      Assert.greaterOrEqual(a.left, title.getBoundingClientRect().right - 0.5, `"${name}" doesn't overlap the title`);
    }
    Assert.greater(checked, 0, "At least one row shows a key hint");
    gURLBar.view.close();
    gURLBar.handleRevert();
  });
});
