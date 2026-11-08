/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// W23 cmdbar-ai: shared helpers for the Ask, Updates, and screenshot tests.

const { WhimsyCommandBarAI, looksLikeQuestion } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyCommandBarAI.sys.mjs");
const { WhimsyCommandBarUpdates, remindTimes } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyCommandBarUpdates.sys.mjs");
const { WhimsyAIProviders } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyAIProviders.sys.mjs");
const { WhimsyAIStore } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyAIStore.sys.mjs");
const { WhimsyAIUpdates } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyAIUpdates.sys.mjs");
const { WhimsyChat } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyChat.sys.mjs");
const { UrlbarTestUtils } = ChromeUtils.importESModule("resource://testing-common/UrlbarTestUtils.sys.mjs");

const ARTICLE = "https://example.com/browser/zen/whimsy/tests/whimsy_chat_article.html";
const Q = "which macbook air is the lightest";

let calls = [];
let script = null;

function gate() {
  let open;
  const promise = new Promise(r => (open = r));
  return { promise, open };
}

async function freshStore() {
  WhimsyCommandBarAI.end(window, { keep: false });
  await closeBar();
  await WhimsyAIStore._resetForTesting(PathUtils.join(PathUtils.tempDir, "whimsy-cmdbar-ai-" + Math.random().toString(16).slice(2)));
  WhimsyAIUpdates._resetForTesting();
  calls = [];
  script = null;
}

async function setupAI() {
  await SpecialPowers.pushPrefEnv({
    set: [
      ["whimsy.ai.enabled", true],
      ["whimsy.feature.ai-hints", false],
      ["whimsy.ai.order", "claude,openai"],
      ["whimsy.ai.off", ""],
    ],
  });
  WhimsyAIProviders.setTestProvider(async function* (provider, request) {
    calls.push({ provider, request });
    if (script) {
      yield* script(provider, request);
      return;
    }
    yield { type: "text", delta: "The 13-inch MacBook Air is the lightest at 2.7 lb." };
  });
  registerCleanupFunction(async () => {
    await UrlbarTestUtils.promisePopupClose(window);
    if (WhimsyChat.isOpen(window)) {
      WhimsyChat.close(window, { reason: "key" });
    }
    while (gBrowser.tabs.length > 1) {
      BrowserTestUtils.removeTab(gBrowser.tabs.at(-1));
    }
    WhimsyAIProviders.setTestProvider(null);
    WhimsyAIUpdates._setClockForTesting(() => Date.now());
    Services.prefs.clearUserPref("whimsy.ai.hints.seen");
  });
}

/** Opens the bar and types `text` with real keys; waits for the results. */
async function typeInBar(text, win = window) {
  win.gURLBar.focus();
  win.gURLBar.select();
  if (win.gURLBar.value) {
    const cleared = UrlbarTestUtils.promiseSearchComplete(win);
    EventUtils.synthesizeKey("KEY_Backspace", {}, win);
    await cleared;
  }
  const done = UrlbarTestUtils.promiseSearchComplete(win);
  EventUtils.sendString(text, win);
  await done;
  await TestUtils.waitForCondition(() => win.gURLBar.value == text, `typed "${text}"`);
}

/** ⌘L, then clear what's there: the bar before typing. */
async function openEmptyBar(win = window) {
  win.gBrowser.selectedBrowser.focus();
  EventUtils.synthesizeKey("l", { accelKey: true }, win);
  await TestUtils.waitForCondition(() => win.gURLBar.focused, "⌘L focused the bar");
  if (win.gURLBar.value) {
    const done = UrlbarTestUtils.promiseSearchComplete(win);
    EventUtils.synthesizeKey("KEY_Backspace", {}, win);
    await done;
  } else {
    await TestUtils.waitForCondition(() => win.gURLBar.view.isOpen, "The bar opened");
    await win.gURLBar.lastQueryContextPromise;
  }
  info(`diag bar: ${rows(win).map(r => `${r.getAttribute("dynamicType") || r.getAttribute("type")}:${r.textContent.trim().slice(0, 30)}`).join(" | ")} selected=${win.gURLBar.view.selectedRowIndex}`);
}

const headingRows = (win = window) => rows(win).filter(r => r.getAttribute("dynamicType") == "whimsy-update-heading");

/** The heading text above `row`. */
async function labelOf(row, want) {
  const heading = () => {
    let r = row.previousElementSibling;
    while (r && r.getAttribute("dynamicType") != "whimsy-update-heading") {
      r = r.previousElementSibling;
    }
    return r?.querySelector(".whimsy-update-heading-label")?.textContent ?? null;
  };
  await TestUtils.waitForCondition(() => heading() == want, `headed ${want}`);
  return heading();
}

function rows(win = window) {
  return [...win.gURLBar.view.panel.querySelectorAll(".urlbarView-row")].filter(r => !r.hidden && r.getBoundingClientRect().height > 0);
}

function rowOf(type, win = window) {
  return rows(win).find(r => r.getAttribute("dynamicType") == type) ?? null;
}

const askRow = (win = window) => rowOf("whimsy-ask", win);
const cardEl = (win = window) => win.gURLBar.view.panel.querySelector(".whimsy-ask-card");
const updateRows = (win = window) => rows(win).filter(r => r.getAttribute("dynamicType") == "whimsy-update");

async function askWithKeys(text = Q) {
  await typeInBar(text);
  info(`diag before ask: rows=${rows().map(r => r.getAttribute("dynamicType") || r.getAttribute("type")).join(",")} card=${!!WhimsyCommandBarAI.card(window)} value=${gURLBar.value} open=${gURLBar.view.isOpen} focused=${gURLBar.focused}`);
  EventUtils.synthesizeKey("KEY_Enter", { accelKey: true });
  await TestUtils.waitForCondition(() => cardEl()?.querySelector(".whimsy-ask-q"), "The answer card is up");
}

const answered = () => TestUtils.waitForCondition(() => cardEl() && !cardEl().hasAttribute("busy") && cardEl().querySelector(".whimsy-ask-body"), "The answer is in");

async function closeBar(win = window) {
  if (win.gURLBar.view.isOpen) {
    EventUtils.synthesizeKey("KEY_Escape", {}, win);
    await TestUtils.waitForCondition(() => !win.gURLBar.view.isOpen, "The bar closed");
  }
  if (win.gURLBar.focused) {
    win.gBrowser.selectedBrowser.focus();
  }
}

async function post(n, extra = {}) {
  return WhimsyAIUpdates.post({ source: "routine", title: `Update ${n}`, detail: `Routine ${n}`, ...extra });
}
