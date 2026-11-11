/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// W23 page-read: ⌘K Summarize sums up the whole page in the tab's chat.
// Points end with numbered passage chips, only for quotes really on the
// page; a long page is read in two passes and says what it skipped; a chip
// whose passage has left the page says so. A fake provider answers.

const { WhimsyAIProviders } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyAIProviders.sys.mjs");
const { WhimsyAIPage } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyAIPage.sys.mjs");
const { WhimsyAIStore } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyAIStore.sys.mjs");
const { WhimsyChatAnswer } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyChatAnswer.sys.mjs");
const { WhimsyAIContext } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyAIContext.sys.mjs");
const { WhimsyChat } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyChat.sys.mjs");

const ROOT = getRootDirectory(gTestPath).replace("chrome://mochitests/content", "https://example.com");
const PAGE = ROOT + "whimsy_ai_page.html";
const LONG = ROOT + "whimsy_ai_long.html";

const PDF = ROOT + "whimsy_ai_lease.pdf";
const SCANNED = ROOT + "whimsy_ai_scanned.pdf";

let prompts = [];
// A summary streams as text: a lead line, then "- point || quote" lines.
function lines({ lead = "", points = [] }) {
  return [lead, ...points.map(p => `- ${p.text} || ${p.quote ?? ""}`)].filter(Boolean).join("\n");
}
function provider(answer) {
  return request => {
    prompts.push(request.prompt);
    const a = typeof answer == "function" ? answer(request) : answer;
    return a.points ? lines(a) : JSON.stringify(a);
  };
}

const PLANNING = {
  lead: "Planning for the offsite.",
  points: [
    { text: "The offsite is in Lisbon", quote: "The offsite is on March 14 in Lisbon." },
    { text: "Someone loves espresso", quote: "Espresso is the finest drink ever brewed by anyone." },
    { text: "Priya owns the budget", quote: "Budget owner: Priya." },
  ],
};

// Content-side: the tint is a CSS custom highlight named for its level.
function passageTint(browser) {
  return SpecialPowers.spawn(browser, [], () => {
    const highlights = content.CSS.highlights;
    for (let level = 18; level <= 32; level += 2) {
      const name = `whimsy-passage-${level}`;
      if (highlights.has(name)) {
        const range = [...content.wrappedJSObject.CSS.highlights.get(name)][0];
        return { level, text: range.toString(), top: range.getBoundingClientRect().top, height: content.innerHeight };
      }
    }
    return null;
  });
}

add_setup(async () => {
  prompts = [];
  // pdf.js counts how often it has shown its new-features notice.
  const impressions = "pdfjs.featuresNotificationImpressionCount";
  await SpecialPowers.pushPrefEnv({ set: [[impressions, Services.prefs.getIntPref(impressions, 0)]] });
  registerCleanupFunction(async () => {
    WhimsyAIProviders.setTestProvider(null);
    WhimsyChat.close(window, { reason: "hide" });
    await WhimsyAIStore.clear?.({ kinds: ["chats"] });
  });
});

add_task(async function chip_only_when_quote_on_page() {
  WhimsyAIProviders.setTestProvider(provider(PLANNING));
  await BrowserTestUtils.withNewTab(PAGE, async () => {
    const summary = await WhimsyAIPage.summarizePage(window, gBrowser.selectedTab);
    is(summary.lead, "Planning for the offsite.", "The lead");
    Assert.deepEqual(
      summary.points.map(p => p.passage?.n ?? null),
      [1, null, 2],
      "A chip only for quotes really on the page, numbered in order"
    );
    is(summary.points[0].passage.quote, "The offsite is on March 14 in Lisbon.", "with the page's own words");
    ok(!summary.read.long, "A short page is read whole");
    ok(summary.read.words > 5, "and its words are counted");
  });
});

add_task(async function chip_scrolls_and_tints_until_scroll() {
  WhimsyAIProviders.setTestProvider(provider({
    lead: "Freight rules.",
    points: [{ text: "Rule twelve covers late slots", quote: "Article 12 sentence 30 explains slot rule 12.30 for cross-border freight." }],
  }));
  await BrowserTestUtils.withNewTab(LONG, async browser => {
    const tab = gBrowser.selectedTab;
    const msg = await WhimsyAIPage.summarizeInChat(window, tab);
    is(msg.role, "ai", "The summary is an answer in the tab's chat");
    is(msg.citations.length, 1, "with one passage chip");
    const panel = document.getElementById("whimsy-chat");
    const chip = await TestUtils.waitForCondition(() => panel?.querySelector('.whimsy-chat-cite[data-n="1"]'), "The chip shows");
    is(await SpecialPowers.spawn(browser, [], () => content.scrollY), 0, "Starts at the top");
    // Exercise the chip's click handler independently of the animated chat's
    // screen position and the OS-active Firefox instance.
    chip.click();
    let tint = await TestUtils.waitForCondition(() => passageTint(browser), "Pressing the chip tints the passage");
    ok(tint.text.includes("12.30"), "the quoted passage");
    ok(await SpecialPowers.spawn(browser, [], () => content.scrollY > 0), "and scrolls to it");
    const atEnd = await SpecialPowers.spawn(browser, [], () => content.scrollY >= content.scrollMaxY - 1);
    ok(Math.abs(tint.top - tint.height / 3) < 40 || atEnd, `a third of the way down, or as far as the page goes (${Math.round(tint.top)} of ${tint.height})`);
    ok(chip.hasAttribute("active"), "The chip shows it's the one pressed");
    await TestUtils.waitForCondition(async () => (tint = await passageTint(browser))?.level == 18, "The tint eases to 18%");
    await SpecialPowers.spawn(browser, [], () => {
      // A queued event from the arrival can be delivered after the tint.
      content.document.dispatchEvent(new content.Event("scroll", { bubbles: true }));
    });
    ok(await passageTint(browser), "and stays while the scroll position is unchanged");
    await SpecialPowers.spawn(browser, [], () => content.scrollBy(0, -120));
    await TestUtils.waitForCondition(async () => !(await passageTint(browser)), "The next scroll clears it");
  });
});

// Simulate a background document that receives no animation frames. This
// exercises the real painter, highlight registry, timer, and scroll listener.
add_task(async function passage_tint_without_animation_frames() {
  await BrowserTestUtils.withNewTab(LONG, async browser => {
    await SpecialPowers.spawn(browser, [], () => {
      const actor = content.windowGlobalChild.getActor("WhimsyAIPreview");
      actor.clearPassage();
      const range = actor.findPassage(content,
        "Article 12 sentence 30 explains slot rule 12.30 for cross-border freight.");
      ok(range, "The passage exists");
      const unframed = {
        document: content.document,
        windowUtils: content.windowUtils,
        CSS: content.CSS,
        Highlight: content.Highlight,
        performance: content.performance,
        get scrollX() { return content.scrollX; },
        get scrollY() { return content.scrollY; },
        requestAnimationFrame: () => 0,
        cancelAnimationFrame: () => {},
        addEventListener: content.addEventListener.bind(content),
        removeEventListener: content.removeEventListener.bind(content),
      };
      actor.paintPassage(unframed, range, "#0062cc", false);
      ok(content.CSS.highlights.has("whimsy-passage-32"), "Tint is published without a frame");
      content.document.dispatchEvent(new content.Event("scroll", { bubbles: true }));
      ok(content.CSS.highlights.has("whimsy-passage-32"), "A queued arrival event preserves the tint");
    });
    await TestUtils.waitForCondition(async () => (await passageTint(browser))?.level == 18,
      "Tint reaches its final level without a frame");
    await SpecialPowers.spawn(browser, [], () => {
      // No frame is needed to arm dismissal, even immediately after painting.
      content.scrollTo({ top: content.scrollY > 0 ? 0 : 120, behavior: "instant" });
      content.document.dispatchEvent(new content.Event("scroll", { bubbles: true }));
      ok(!content.CSS.highlights.has("whimsy-passage-18"), "The next changed scroll position clears the tint without a frame");
      content.windowGlobalChild.getActor("WhimsyAIPreview").clearPassage();
    });
  });
});

add_task(async function summary_streams_with_chips() {
  await SpecialPowers.pushPrefEnv({ set: [["whimsy.ai.enabled", true], ["whimsy.ai.order", "claude"], ["whimsy.ai.off", ""]] });
  let release;
  const gate = new Promise(r => (release = r));
  WhimsyAIProviders.setTestProvider(async function* () {
    yield { type: "text", delta: "Planning for the offsite.\n- The offsite is in Lis" };
    await gate;
    yield { type: "text", delta: "bon || The offsite is on March 14 in Lisbon.\n- Priya owns the budget || Budget owner: Priya." };
  });
  try {
    await BrowserTestUtils.withNewTab(PAGE, async () => {
      const done = WhimsyAIPage.summarizeInChat(window, gBrowser.selectedTab);
      const panel = document.getElementById("whimsy-chat") ?? (await TestUtils.waitForCondition(() => document.getElementById("whimsy-chat")));
      const live = await TestUtils.waitForCondition(() => panel.querySelector(".whimsy-chat-msg[busy] .whimsy-chat-text li"), "Points stream in");
      ok(live.textContent.includes("The offsite is in Lis"), "as they come");
      ok(!panel.querySelector(".whimsy-chat-msg[busy]").textContent.includes("||"), "without the quote markers");
      ok(!panel.querySelector(".whimsy-chat-msg[busy] .whimsy-chat-cite"), "a chip waits for its passage");
      release();
      const msg = await done;
      is(msg.citations.length, 2, "Both passages are on the page");
      ok(!msg.text.includes("||"), "The saved answer has no markers");
      ok(panel.querySelector('.whimsy-chat-msg[data-role="ai"] .whimsy-chat-cite[data-n="2"]'), "and both chips show");
    });
  } finally {
    WhimsyAIProviders.setTestProvider(null);
    await SpecialPowers.popPrefEnv();
  }
});

add_task(async function pdf_chip_turns_page() {
  WhimsyAIProviders.setTestProvider(provider({
    lead: "A lease for 18 Harbour Lane.",
    points: [{ text: "Notice is two months after the first year", quote: "The tenant may end this lease with two months written notice after the first twelve months." }],
  }));
  prompts = [];
  await BrowserTestUtils.withNewTab(PDF, async browser => {
    await TestUtils.waitForCondition(
      () => SpecialPowers.spawn(browser, [], () => !!content.wrappedJSObject.PDFViewerApplication?.pdfDocument),
      "The viewer has the document"
    );
    is(browser.contentPrincipal.spec, "resource://pdf.js/web/viewer.html", `Firefox's viewer shows it (document type ${browser.documentContentType})`);
    const msg = await WhimsyAIPage.summarizeInChat(window, gBrowser.selectedTab);
    ok(/Page 3/.test(prompts.at(-1)), "Read page by page");
    is(msg.citations[0].source.page, 3, "The chip knows its page");
    const panel = document.getElementById("whimsy-chat");
    const chip = await TestUtils.waitForCondition(() => panel.querySelector('.whimsy-chat-cite[data-n="1"]'), "The chip shows");
    await TestUtils.waitForCondition(() => chip.textContent.trim() == "p. 3", "and names the page");
    // Exercise the chip's click handler independently of the animated chat's
    // screen position and the OS-active Firefox instance.
    chip.click();
    await TestUtils.waitForCondition(
      () => SpecialPowers.spawn(browser, [], () => content.wrappedJSObject.PDFViewerApplication.page == 3),
      "Pressing it turns to that page"
    );
  });
});

add_task(async function scanned_pdf_ocr_first() {
  WhimsyAIProviders.setTestProvider(provider({
    lead: "A scanned lease.",
    points: [{ text: "Rent is due on the first", quote: "" }],
  }));
  prompts = [];
  // The page has no text layer, so it goes to on-device text recognition.
  // A stand-in answers as the real one does (the OS service is slow and can
  // stall past the product's 10-second limit late in a long run).
  const asked = [];
  WhimsyAIPage.setTestOcrRecognizer(page => {
    asked.push(page);
    return "Rent is due on the first of the month, the monthly rent.";
  });
  registerCleanupFunction(() => WhimsyAIPage.setTestOcrRecognizer(null));
  await BrowserTestUtils.withNewTab(SCANNED, async browser => {
    await TestUtils.waitForCondition(
      () => SpecialPowers.spawn(browser, [], () => !!content.wrappedJSObject.PDFViewerApplication?.pdfDocument),
      "The viewer has the document"
    );
    const msg = await WhimsyAIPage.summarizeInChat(window, gBrowser.selectedTab);
    WhimsyAIPage.setTestOcrRecognizer(null);
    Assert.deepEqual(asked, [1], "The text-free page is recognized");
    is(msg.role, "ai", "A scanned PDF still gets a summary");
    ok(/monthly rent/i.test(prompts.at(-1)), "from text recognized on this Mac first");
    const panel = document.getElementById("whimsy-chat");
    const note = await TestUtils.waitForCondition(() => panel.querySelector('.whimsy-chat-note[data-kind="ocr"]'), "The answer says so");
    await TestUtils.waitForCondition(() => /text recognition on this Mac/.test(note.textContent), "in words");
    ok(note.compareDocumentPosition(panel.querySelector('.whimsy-chat-msg[data-role="ai"]')) & Node.DOCUMENT_POSITION_FOLLOWING, "above the answer");
  });
});

add_task(async function long_page_note_and_read_rest() {
  const realMax = Object.getOwnPropertyDescriptor(WhimsyAIProviders, "maxInputChars");
  Object.defineProperty(WhimsyAIProviders, "maxInputChars", { configurable: true, get: () => 8000 });
  prompts = [];
  WhimsyAIProviders.setTestProvider(provider(request =>
    /too long to read at once/.test(request.prompt)
      ? { sections: [3, 7] }
      : { lead: "Shared rules.", points: [{ text: "Slots are booked a year ahead", quote: "Slots are booked a year ahead, with 20% kept for late requests." }] }
  ));
  try {
    await BrowserTestUtils.withNewTab(LONG, async () => {
      const tab = gBrowser.selectedTab;
      await WhimsyAIPage.summarizeInChat(window, tab);
      ok(/too long to read at once/.test(prompts[0]), "First pass: headings and openings");
      ok(/\[12\] Article 12/.test(prompts[0]), "every section is in the outline");
      ok(/Article 3: Rule set 3/.test(prompts[1]) && /Article 7: Rule set 7/.test(prompts[1]), "Then the picked sections in full");
      ok(!/Article 5: Rule set 5/.test(prompts[1]), "and not the others");
      const panel = document.getElementById("whimsy-chat");
      const note = await TestUtils.waitForCondition(() => panel.querySelector('.whimsy-chat-note[data-kind="long-page"]'), "The note says what was read");
      await TestUtils.waitForCondition(() => /skimmed all 13 sections/.test(note.textContent), "in plain words");
      const rest = note.querySelector(".whimsy-chat-link");
      ok(rest, "Read the rest is offered");
      prompts = [];
      rest.click();
      await TestUtils.waitForCondition(() => prompts.length >= 2, "Read the rest continues");
      ok(!/\[3\] Article 3/.test(prompts[0]), "with the sections not read yet");
    });
  } finally {
    if (realMax) {
      Object.defineProperty(WhimsyAIProviders, "maxInputChars", realMax);
    } else {
      delete WhimsyAIProviders.maxInputChars;
    }
  }
});

add_task(async function changed_page_note() {
  WhimsyAIProviders.setTestProvider(provider(PLANNING));
  await BrowserTestUtils.withNewTab(PAGE, async browser => {
    const tab = gBrowser.selectedTab;
    const msg = await WhimsyAIPage.summarizeInChat(window, tab);
    await SpecialPowers.spawn(browser, [], () => {
      content.document.body.textContent = "This live blog has moved on.";
    });
    const [thread] = await WhimsyAIStore.threads({ kind: "tab", tabKey: WhimsyAIContext.tabKey(tab) });
    const shown = await WhimsyChatAnswer.showCitation(window, thread, msg.citations[0].source);
    ok(!shown, "Nothing to scroll to");
    const panel = document.getElementById("whimsy-chat");
    const note = await TestUtils.waitForCondition(() => panel.querySelector('.whimsy-chat-note[data-kind="passage-gone"]'), "The thread says so");
    await TestUtils.waitForCondition(() => /isn’t on the page anymore/.test(note.textContent), "in words");
    ok(note.querySelector(".whimsy-chat-link"), "and offers to sum up again");
  });
});
