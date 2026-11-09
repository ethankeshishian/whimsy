/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// W23 page-read: shots for side-by-side checks against 05-page (page-1.1,
// 1.3, 1.8, 7.1–7.5, 11.1–11.3) and fu-page (1.6, 1.7, 7.1), light and dark,
// plus mid-animation frames (the find card opening, the passage tint fading,
// the preview loading). WHIMSY_SHOTS=<dir> writes w23-page-read-*.png.

const { WhimsyAIProviders } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyAIProviders.sys.mjs");
const { WhimsyAIPage } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyAIPage.sys.mjs");
const { WhimsyAIReader } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyAIReader.sys.mjs");
const { WhimsyAIStore } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyAIStore.sys.mjs");
const { WhimsyChat } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyChat.sys.mjs");

const ROOT = getRootDirectory(gTestPath).replace("chrome://mochitests/content", "https://example.com");
const PAGE = ROOT + "whimsy_ai_page.html";
const LONG = ROOT + "whimsy_ai_long.html";
const LINKS = ROOT + "whimsy_ai_links.html";
const PDF = ROOT + "whimsy_ai_lease.pdf";
const SCANNED = ROOT + "whimsy_ai_scanned.pdf";
const NAME = state => `w23-page-read-${state}`;
const AT = { x: 10, y: 10, width: 10, height: 10 };

function lines({ lead, points }) {
  return [lead, ...points.map(([text, quote]) => `- ${text} || ${quote ?? ""}`)].join("\n");
}

const ANSWERS = {
  page: lines({ lead: "Planning notes for the team offsite.", points: [
    ["The offsite is in Lisbon on March 14", "The offsite is on March 14 in Lisbon."],
    ["The espresso machine is out of stock", "The espresso machine costs $129 and is out of stock."],
    ["Priya owns the budget", "Budget owner: Priya."],
  ] }),
  long: lines({ lead: "Shared rules for cross-border rail freight.", points: [
    ["Slots are booked a year ahead", "Slots are booked a year ahead, with 20% kept for late requests."],
    ["Rule twelve covers late slots", "Article 12 sentence 30 explains slot rule 12.30 for cross-border freight."],
  ] }),
  pdf: lines({ lead: "A lease for 18 Harbour Lane.", points: [
    ["Notice is two months after the first year", "The tenant may end this lease with two months written notice after the first twelve months."],
  ] }),
  scanned: lines({ lead: "A scanned lease.", points: [["Rent is due on the first of the month", ""]] }),
};

function provider(request) {
  const prompt = request.prompt ?? request.messages?.at(-1)?.content ?? "";
  if (/too long to read at once/.test(prompt)) {
    return JSON.stringify({ sections: [0, 12] });
  }
  if (/link preview/.test(request.system ?? "")) {
    return JSON.stringify({ title: "Quarterly planning notes", points: ["The offsite is in Lisbon on March 14", "The espresso machine is out of stock", "Priya owns the budget"] });
  }
  if (/Ask on Page/.test(request.system ?? "")) {
    return JSON.stringify({ answer: "The offsite is in Lisbon on March 14.", quote: "The offsite is on March 14 in Lisbon." });
  }
  if (/Document title/.test(prompt)) {
    return /monthly rent/i.test(prompt) ? ANSWERS.scanned : ANSWERS.pdf;
  }
  return /Rail Freight/.test(prompt) ? ANSWERS.long : ANSWERS.page;
}

add_setup(async () => {
  const branch = Services.prefs;
  await SpecialPowers.pushPrefEnv({ set: [
    ["findbar.highlightAll", true],
    ["accessibility.typeaheadfind.casesensitive", branch.getIntPref("accessibility.typeaheadfind.casesensitive", 0)],
    ["findbar.entireword", branch.getBoolPref("findbar.entireword", false)],
    ["findbar.matchdiacritics", branch.getIntPref("findbar.matchdiacritics", 0)],
    ["accessibility.typeaheadfind.flashBar", branch.getIntPref("accessibility.typeaheadfind.flashBar", 0)],
  ] });
  WhimsyAIProviders.setTestProvider(provider);
  // page-11.3: the scanned PDF has no text layer, so pdfPages would
  // otherwise call the real on-device text recognition (slow, and this
  // Mac's OS service can stall well past a test's timeout). A stand-in
  // answers instead, same as a real page's: text naming the monthly rent.
  WhimsyAIPage.setTestOcrRecognizer(() => "Rent is due on the first of the month, the monthly rent.");
  registerCleanupFunction(async () => {
    WhimsyAIProviders.setTestProvider(null);
    WhimsyAIPage.setTestOcrRecognizer(null);
    WhimsyAIReader.setTestReader(null);
    WhimsyChat.close(window, { reason: "hide" });
    await WhimsyAIStore.clear?.({ kinds: ["chats"] });
    await SpecialPowers.popPrefEnv();
  });
});

async function fresh() {
  WhimsyChat.close(window, { reason: "hide" });
  await WhimsyAIStore.clear?.({ kinds: ["chats"] });
}

async function waitForPdf(browser) {
  await TestUtils.waitForCondition(
    () => SpecialPowers.spawn(browser, [], () => !!content.wrappedJSObject.PDFViewerApplication?.pdfDocument),
    "The viewer has the document"
  );
  // W23 polish (MUST 4): the toolbar's icons are mask images. Wait until
  // they've loaded (an unloaded mask paints nothing), and check they can:
  // a blank toolbar must be the snapshot's timing, never a blocked load.
  const icons = await SpecialPowers.spawn(browser, [], async () => {
    const doc = content.document;
    const buttons = [...doc.querySelectorAll("#toolbarContainer button")].filter(b => b.getClientRects().length);
    const urls = new Set();
    for (const button of buttons) {
      const mask = content.getComputedStyle(button, "::before").maskImage;
      const url = /url\("?([^")]+)"?\)/.exec(mask)?.[1];
      if (url) {
        urls.add(url);
      }
    }
    const loads = [...urls].map(
      url =>
        new Promise(resolve => {
          const img = new content.Image();
          img.onload = () => resolve({ url, ok: true });
          img.onerror = () => resolve({ url, ok: false });
          img.src = url;
          content.setTimeout(() => resolve({ url, ok: false, late: true }), 5000);
        })
    );
    return { count: buttons.length, results: await Promise.all(loads) };
  });
  Assert.greater(icons.results.length, 0, `The toolbar's ${icons.count} buttons have mask icons`);
  for (const { url, ok: loaded } of icons.results) {
    ok(loaded, `Toolbar icon ${url} loads`);
    info(`DIAG icon ${url} ${loaded}`);
  }
  ok(
    await SpecialPowers.spawn(browser, [], () => content.document.getElementById("pdfFeaturesNotification")?.hidden ?? true),
    "Firefox's split/merge promo stays hidden"
  );
}

async function summaryIn(url, prepare = null) {
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, url);
  await prepare?.(tab.linkedBrowser);
  await fresh();
  await WhimsyAIPage.summarizeInChat(window, tab);
  const panel = document.getElementById("whimsy-chat");
  await TestUtils.waitForCondition(() => panel.querySelector('.whimsy-chat-msg[data-role="ai"]:not([busy])'), "The summary shows");
  return { tab, panel };
}

// Waits until `el` stops moving (a panel sliding in), so a click lands on it.
async function steady(el) {
  let last = "";
  await TestUtils.waitForCondition(async () => {
    await new Promise(r => requestAnimationFrame(r));
    const now = JSON.stringify(el.getBoundingClientRect());
    const still = now == last;
    last = now;
    return still;
  }, "It has stopped moving");
}

function closer(tab) {
  return async () => {
    WhimsyChat.close(window, { reason: "hide" });
    BrowserTestUtils.removeTab(tab);
  };
}

// page-1.1: the summary in the tab's chat, chips after the points.
add_task(async function summary_in_chat() {
  await whimsyBothSchemes(NAME("summary"), async () => closer((await summaryIn(PAGE)).tab));
});

// page-1.3: a chip pressed; the passage a third of the way down, tinted.
add_task(async function passage_tint() {
  const tint = browser => SpecialPowers.spawn(browser, [], () => {
    for (let level = 18; level <= 32; level += 2) {
      if (content.CSS.highlights.has(`whimsy-passage-${level}`)) {
        return level;
      }
    }
    return 0;
  });
  await whimsyBothSchemes(NAME("passage"), async dark => {
    const { tab, panel } = await summaryIn(LONG);
    const chip = await TestUtils.waitForCondition(() => panel.querySelector('.whimsy-chat-cite[data-n="2"]'), "The chip shows");
    await steady(chip);
    EventUtils.synthesizeMouseAtCenter(chip, {});
    // The tint fades from 32% to 18% over 600ms: shoot its first frames once.
    // The page reports the tint's first frame itself (no round trip per
    // poll), so the shot follows it within a frame or two.
    if (!dark) {
      const seen = await SpecialPowers.spawn(tab.linkedBrowser, [], () => new Promise(resolve => {
        const start = content.performance.now();
        const look = () => {
          for (let l = 32; l >= 18; l -= 2) {
            if (content.CSS.highlights.has(`whimsy-passage-${l}`)) {
              resolve({ level: l, scrollY: content.scrollY });
              return;
            }
          }
          if (content.performance.now() - start > 5000) {
            resolve({ level: 0, scrollY: content.scrollY, size: content.CSS.highlights.size });
            return;
          }
          content.requestAnimationFrame(look);
        };
        look();
      }));
      info(`Tint first seen: ${JSON.stringify(seen)}; chip active ${chip.hasAttribute("active")}`);
      Assert.greaterOrEqual(seen.level, 28, "The tint starts strong");
      await whimsyShot(NAME("passage-mid-start"));
    }
    await TestUtils.waitForCondition(async () => (await tint(tab.linkedBrowser)) == 18, "The tint settles");
    return closer(tab);
  });
});

// fu-page 1.6: a long page says what it read and skipped; Read the rest.
add_task(async function long_page_note() {
  const realMax = Object.getOwnPropertyDescriptor(WhimsyAIProviders, "maxInputChars");
  Object.defineProperty(WhimsyAIProviders, "maxInputChars", { configurable: true, get: () => 8000 });
  try {
    await whimsyBothSchemes(NAME("long-page"), async () => {
      const { tab, panel } = await summaryIn(LONG);
      await TestUtils.waitForCondition(() => panel.querySelector('.whimsy-chat-note[data-kind="long-page"] .whimsy-chat-link'), "The note shows");
      return closer(tab);
    });
  } finally {
    if (realMax) {
      Object.defineProperty(WhimsyAIProviders, "maxInputChars", realMax);
    } else {
      delete WhimsyAIProviders.maxInputChars;
    }
  }
});

// page-11.1: a PDF's chips name pages; page-11.3: a scanned PDF says it was recognized.
add_task(async function pdf_summary() {
  await whimsyBothSchemes(NAME("pdf"), async () => {
    const { tab, panel } = await summaryIn(PDF, waitForPdf);
    await TestUtils.waitForCondition(() => panel.querySelector(".whimsy-chat-cite")?.textContent.trim() == "p. 3", "The chip names its page");
    return closer(tab);
  });
  await whimsyBothSchemes(NAME("pdf-scanned"), async () => {
    const { tab, panel } = await summaryIn(SCANNED, waitForPdf);
    await TestUtils.waitForCondition(() => panel.querySelector('.whimsy-chat-note[data-kind="ocr"]')?.textContent, "The note shows");
    return closer(tab);
  });
});

// fu-page 7.1 / page-7.4: a link preview, loading then filled.
add_task(async function link_preview() {
  let release = null;
  WhimsyAIReader.setTestReader(async () => {
    await new Promise(r => (release = r));
    return "The offsite is on March 14 in Lisbon. The espresso machine is out of stock. Budget owner: Priya.";
  });
  try {
    await whimsyBothSchemes(NAME("preview"), async dark => {
      const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, LINKS);
      release = null;
      await WhimsyAIPage.showPreview(window, tab.linkedBrowser, { url: PAGE + `?shot-${dark}`, how: "hover", ...AT });
      const panel = await TestUtils.waitForCondition(() => {
        const p = document.getElementById("whimsy-link-hover");
        return p?.state == "open" && p;
      }, "The cards open");
      await TestUtils.waitForCondition(() => release && panel.querySelector('[data-card="ai"] .whimsy-ai-shimmer'), "The summary is loading");
      await whimsySettled();
      // MUST 6: the cards are a panel of their own; copy them in for the shot.
      let undo = whimsyStandInPopups();
      await whimsyShot(NAME(`preview-loading-${dark ? "dark" : "light"}`));
      undo();
      release();
      await TestUtils.waitForCondition(() => panel.querySelector('[data-card="ai"] .whimsy-preview-points'), "then fills in place");
      await whimsySettled();
      undo = whimsyStandInPopups();
      ok(document.querySelector('div#whimsy-link-hover [data-card="ai"] .whimsy-preview-points'), "The filled cards are in the shot");
      return async () => {
        undo();
        WhimsyAIPage.hidePreview(window);
        BrowserTestUtils.removeTab(tab);
      };
    });
  } finally {
    WhimsyAIReader.setTestReader(null);
  }
});

async function openFind(text) {
  EventUtils.synthesizeKey("f", { accelKey: true });
  const findbar = await TestUtils.waitForCondition(() => gBrowser.isFindBarInitialized() && gBrowser.getCachedFindBar(), "The find bar exists");
  await TestUtils.waitForCondition(() => !findbar.hidden && document.activeElement == findbar._findField, "It opens, focused");
  if (text) {
    findbar._findField.select();
    EventUtils.sendString(text);
    await TestUtils.waitForCondition(() => findbar._findField.getAttribute("status") != "pending", "Find ran");
    await TestUtils.waitForCondition(() => findbar.querySelector(".whimsy-find-count").getAttribute("value"), "The count shows");
  }
  return findbar;
}

async function closeFind() {
  const findbar = gBrowser.getCachedFindBar();
  for (const id of ["whimsy-ask-panel", "whimsy-find-menu"]) {
    const popup = document.getElementById(id);
    if (popup?.state == "open") {
      const hidden = BrowserTestUtils.waitForPopupEvent(popup, "hidden");
      popup.hidePopup();
      await hidden;
    }
  }
  findbar?.close(true);
  // The pointer leaves ⋯ so the next shot doesn't show it hovered.
  EventUtils.synthesizeMouseAtPoint(600, 400, { type: "mousemove" }, window);
}

// fu-page 1.7: the floating card, found; its opening frame.
add_task(async function find_card() {
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE);
  try {
    EventUtils.synthesizeKey("f", { accelKey: true });
    const findbar = await TestUtils.waitForCondition(() => gBrowser.isFindBarInitialized() && gBrowser.getCachedFindBar(), "The find bar exists");
    await whimsyShotMid(NAME("find-open"), () => findbar.getAnimations().find(a => a.transitionProperty == "opacity"), 60).catch(() => info("No opening transition"));
    await closeFind();
    await whimsyBothSchemes(NAME("find"), async () => {
      await openFind("Lisbon");
      return closeFind;
    });
    await whimsyBothSchemes(NAME("find-menu"), async () => {
      const findbar = await openFind("Lisbon");
      await steady(findbar.querySelector(".whimsy-find-more"));
      EventUtils.synthesizeMouseAtCenter(findbar.querySelector(".whimsy-find-more"), {});
      await TestUtils.waitForCondition(() => document.getElementById("whimsy-find-menu")?.state == "open", "The ⋯ menu opens");
      return closeFind;
    });
    await whimsyBothSchemes(NAME("find-nothing"), async () => {
      const findbar = await openFind("when is the offsite");
      info(`DIAG status=${findbar._findField.getAttribute("status")} askEnabled=${WhimsyAIPage.askEnabled} providersEnabled=${WhimsyAIProviders.enabled} mode=${findbar.findMode} imgMatches=${findbar.hasAttribute("whimsy-image-matches")} hidden=${findbar.querySelector(".whimsy-ask-button").hidden}`);
      await TestUtils.waitForCondition(() => findbar.querySelector(".whimsy-ask-button").hasAttribute("askable"), "Ask is offered");
      return closeFind;
    });
    // page-1.8: the answer card under the bar.
    await whimsyBothSchemes(NAME("find-answer"), async () => {
      const findbar = await openFind("when is the offsite");
      await TestUtils.waitForCondition(() => findbar.querySelector(".whimsy-ask-button").hasAttribute("askable"), "Ask is offered");
      EventUtils.synthesizeKey("KEY_Enter");
      await TestUtils.waitForCondition(() => {
        const p = document.getElementById("whimsy-ask-panel");
        return p?.state == "open" && p.querySelector(".whimsy-ask-continue");
      }, "The answer shows");
      return closeFind;
    });
  } finally {
    await closeFind();
    BrowserTestUtils.removeTab(tab);
  }
});
