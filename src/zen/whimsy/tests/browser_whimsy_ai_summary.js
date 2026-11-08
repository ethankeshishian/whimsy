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

let prompts = [];
function provider(answer) {
  return request => {
    prompts.push(request.prompt);
    return JSON.stringify(typeof answer == "function" ? answer(request) : answer);
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

add_setup(async () => {
  prompts = [];
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

add_task(async function chip_scrolls_and_tints() {
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
    EventUtils.synthesizeMouseAtCenter(chip, {}, window);
    await TestUtils.waitForCondition(
      () => SpecialPowers.spawn(browser, [], () => content.scrollY > 0 && content.getSelection().toString().includes("12.30")),
      "Pressing the chip scrolls to the passage and marks it"
    );
    ok(chip.hasAttribute("active"), "The chip shows it's the one pressed");
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
