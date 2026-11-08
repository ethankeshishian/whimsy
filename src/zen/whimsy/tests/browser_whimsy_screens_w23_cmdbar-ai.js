/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// W23 cmdbar-ai screenshots, light and dark: w23-cmdbar-ai-<state>-<scheme>.
// Compare with docs/superpowers/mockups/ai/02-command-bar.html#<state>.

Services.scriptloader.loadSubScript(getRootDirectory(gTestPath) + "head_cmdbar_ai.js", this);

const { WhimsyVPN } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyVPN.sys.mjs");
const { WhimsyAIHints } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyAIHints.sys.mjs");

const NAME = id => `w23-cmdbar-ai-${id}`;
const SPECS = "https://example.org/browser/zen/whimsy/tests/whimsy_chat_article.html";

function answerScript({ hold = null, partial = false, handoff = false } = {}) {
  return async function* () {
    if (handoff) {
      yield { type: "handoff", from: "claude", to: "openai", reason: "quota" };
    }
    yield { type: "text", delta: "The **13-inch MacBook Air** is the lightest at **2.7 lb (1.24 kg)**." };
    yield { type: "citation", n: 1, source: { url: SPECS, title: "MacBook Air 13 and 15 · Tech Specs" } };
    if (hold) {
      await hold;
    }
    yield { type: "text", delta: " The 15-inch is 3.3 lb. Both have the M5 chip, so the 13-inch is the pick if weight matters most." };
    yield { type: "citation", n: 2, source: { url: ARTICLE, title: "The best laptops of 2026" } };
    if (partial) {
      yield { type: "quota-mid", provider: "claude", next: "openai" };
      const e = new Error("quota");
      e.code = "plan-limit";
      throw e;
    }
  };
}

function failing(code, tried = []) {
  return async function* () {
    const e = new Error(code);
    e.code = code;
    e.tried = tried;
    throw e;
    // eslint-disable-next-line no-unreachable
    yield null;
  };
}

let tab;

add_setup(async function () {
  await setupAI();
  tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, ARTICLE);
  registerCleanupFunction(() => BrowserTestUtils.removeTab(tab));
});

async function shootAsk(id, scriptFn, { typed = null, after = null } = {}) {
  await whimsyBothSchemes(NAME(id), async () => {
    await freshStore();
    gBrowser.selectedTab = tab;
    script = scriptFn;
    await askWithKeys();
    await TestUtils.waitForCondition(() => cardEl() && !cardEl().hasAttribute("busy"), "Settled");
    if (typed) {
      EventUtils.sendString(typed);
      await TestUtils.waitForCondition(() => cardEl().querySelector("[data-action='continue']"), "Typed");
    }
    await after?.();
    return () => closeBar();
  });
}

add_task(async function shots_ask_row() {
  await whimsyBothSchemes(NAME("cmd-1.2"), async () => {
    await typeInBar(Q);
    return () => closeBar();
  });
  await whimsyBothSchemes(NAME("cmd-1.4"), async () => {
    await typeInBar(Q);
    EventUtils.synthesizeKey("KEY_ArrowDown");
    return () => closeBar();
  });
  await whimsyBothSchemes(NAME("cmd-1.3"), async () => {
    await typeInBar("sum up the battery section here");
    return () => closeBar();
  });
});

add_task(async function shots_card() {
  const g = gate();
  await whimsyBothSchemes(NAME("cmd-1.5"), async () => {
    await freshStore();
    script = answerScript({ hold: g.promise });
    await askWithKeys();
    await TestUtils.waitForCondition(() => cardEl().querySelector(".whimsy-ask-caret"), "Streaming");
    return () => closeBar();
  });
  g.open();
  const wait = gate();
  await whimsyBothSchemes(NAME("cmd-1.6"), async () => {
    await freshStore();
    script = async function* () {
      await wait.promise;
      yield { type: "text", delta: "x" };
    };
    await askWithKeys();
    await TestUtils.waitForCondition(() => cardEl().querySelector(".whimsy-ask-loading"), "Loading lines after 300ms");
    return () => closeBar();
  });
  wait.open();
  await shootAsk("cmd-1.7", answerScript());
  await shootAsk("cmd-1.8", answerScript(), { typed: "and which one has the better battery" });
  await shootAsk("cmd-1.14", answerScript({ handoff: true }));
  await shootAsk("cmd-1.15", answerScript({ partial: true }));
  await shootAsk("cmd-1.12", failing("offline"));
  await shootAsk("cmd-1.13", failing("provider-down"));
  await shootAsk("cmd-1.16", failing("all-failed", ["claude", "openai"]));
});

add_task(async function shots_rtl_and_ai_off() {
  await whimsyBothSchemes(NAME("cmd-1.20"), async () => {
    await freshStore();
    script = async function* () {
      yield { type: "text", delta: "מקבוק אייר 13 אינץ׳ שוקל **1.24 ק״ג**. דגם ה־15 אינץ׳ שוקל 1.51 ק״ג." };
    };
    await askWithKeys("כמה שוקל מקבוק אייר 13?");
    await answered();
    return () => closeBar();
  });
  await whimsyBothSchemes(NAME("cmd-1.18"), async () => {
    await SpecialPowers.pushPrefEnv({ set: [["whimsy.ai.enabled", false]] });
    await typeInBar("ai");
    return async () => {
      await closeBar();
      await SpecialPowers.popPrefEnv();
    };
  });
});

add_task(async function shots_narrow() {
  const { outerWidth, outerHeight } = window;
  window.resizeTo(760, outerHeight);
  await TestUtils.waitForCondition(() => window.outerWidth <= 800, "Narrow");
  try {
    await shootAsk("cmd-1.22", answerScript());
  } finally {
    window.resizeTo(outerWidth, outerHeight);
    await TestUtils.waitForCondition(() => window.outerWidth == outerWidth, "Restored");
  }
});

async function seed() {
  await freshStore();
  let t = Date.now() - 3 * 3600000;
  WhimsyAIUpdates._setClockForTesting(() => t);
  await WhimsyAIUpdates.post({ source: "routine", title: "Q4 planning notes: 6 edits by Priya", detail: "Doc changes · Drive" });
  t += 600000;
  await WhimsyAIUpdates.post({ source: "routine", title: "Daily brief: 4 meetings, 12 new emails, rain after 3", detail: "Daily brief · weekdays at 8:00" });
  t += 600000;
  await WhimsyAIUpdates.post({ source: "watch", title: "MacBook Air 13 dropped to $899", detail: "Price watch · amazon.com · was $999", url: ARTICLE });
  t += 600000;
  await WhimsyAIUpdates.post({ source: "routine", kind: "prep", title: "Prep for Design review at 11:00", detail: "Meeting prep · 3 docs and last week’s Granola notes", dueAt: Date.now() + 8 * 60000 });
  t += 600000;
  await WhimsyAIUpdates.post({ source: "routine", needsYou: true, title: "Sam asked you to review WHM-212", detail: "Standup digest · Linear" });
  WhimsyAIUpdates._setClockForTesting(() => Date.now());
}

add_task(async function shots_updates() {
  await whimsyBothSchemes(NAME("cmd-2.1"), async () => {
    await freshStore();
    await WhimsyAIUpdates.post({ source: "watch", title: "MacBook Air 13 dropped to $899", detail: "Price watch · amazon.com · was $999", url: ARTICLE });
    await openEmptyBar();
    return () => closeBar();
  });
  await whimsyBothSchemes(NAME("cmd-2.2"), async () => {
    await seed();
    await openEmptyBar();
    return () => closeBar();
  });
  await whimsyBothSchemes(NAME("cmd-2.3"), async () => {
    await seed();
    await openEmptyBar();
    EventUtils.synthesizeKey("KEY_ArrowDown");
    EventUtils.synthesizeKey("KEY_ArrowDown");
    EventUtils.synthesizeKey("KEY_Tab");
    EventUtils.synthesizeKey("KEY_Tab");
    return () => closeBar();
  });
  await whimsyBothSchemes(NAME("cmd-2.4"), async () => {
    await seed();
    await openEmptyBar();
    EventUtils.synthesizeKey("KEY_ArrowDown");
    EventUtils.synthesizeKey("KEY_ArrowDown");
    EventUtils.synthesizeKey("KEY_Tab");
    EventUtils.synthesizeKey("KEY_Tab");
    EventUtils.synthesizeKey("KEY_Enter");
    await TestUtils.waitForCondition(() => gURLBar.view.selectedElement?.classList.contains("whimsy-remind-option"), "The menu is open");
    await new Promise(r => setTimeout(r, 250));
    return async () => {
      EventUtils.synthesizeKey("KEY_Escape");
      await TestUtils.waitForCondition(() => !gURLBar.view.panel.querySelector(".whimsy-remind-option"), "Esc closed the menu");
      await closeBar();
    };
  });
  await whimsyBothSchemes(NAME("cmd-2.7"), async () => {
    await seed();
    for (let i = 0; i < 18; i++) {
      await WhimsyAIUpdates.post({ source: "routine", title: `Weekly recap ${i + 1} is ready`, detail: "Weekly recap · Fridays" });
    }
    await openEmptyBar();
    return () => closeBar();
  });
  await whimsyBothSchemes(NAME("cmd-2.15"), async () => {
    await seed();
    await openEmptyBar();
    EventUtils.synthesizeKey("KEY_Meta", { type: "keydown", metaKey: true });
    await TestUtils.waitForCondition(() => gURLBar.hasAttribute("whimsy-numbers"), "Numbers");
    return async () => {
      EventUtils.synthesizeKey("KEY_Meta", { type: "keyup" });
      await closeBar();
    };
  });
  await whimsyBothSchemes(NAME("fu-routines-4.5"), async () => {
    await seed();
    await WhimsyAIUpdates.post({ source: "routine", whileClosed: true, title: "Daily brief ran once for 2 misses", detail: "Daily brief · weekdays at 8:00" });
    await openEmptyBar();
    return () => closeBar();
  });
  await whimsyBothSchemes(NAME("cmd-1.25"), async () => {
    await seed();
    WhimsyAIUpdates.setRecentAnswer({ question: Q, tabTitle: "The best laptops of 2026", text: "Light.", citations: [], opened: [1], sources: 2, at: Date.now() - 3 * 60000 });
    await openEmptyBar();
    return () => closeBar();
  });
});

add_task(async function shots_vpn_strip() {
  await whimsyBothSchemes(NAME("fu-media-5.1"), async () => {
    await typeInBar("night trains");
    WhimsyVPN.updateStrip(window, "on", "browser");
    return async () => {
      WhimsyVPN.updateStrip(window, "off", null);
      await closeBar();
    };
  });
});

add_task(async function shots_first_use_and_way_back() {
  await whimsyBothSchemes(NAME("cmd-5.1"), async () => {
    await freshStore();
    await SpecialPowers.pushPrefEnv({ set: [["whimsy.feature.ai-hints", true], ["whimsy.ai.hints.seen", ""], ["whimsy.ai.hints.today", ""]] });
    WhimsyAIHints._setTimingForTesting({ gapMs: 0, seenMs: 600000, timeoutMs: 600000, pollMs: 50 });
    await typeInBar(Q);
    await TestUtils.waitForCondition(() => WhimsyAIHints.current?.id == "ask", "The Ask row's hint");
    return async () => {
      WhimsyAIHints.current?.toast.close({ instant: true });
      WhimsyAIHints._setTimingForTesting(null);
      await closeBar();
      await SpecialPowers.popPrefEnv();
    };
  });
  await whimsyBothSchemes(NAME("cmd-1.24"), async () => {
    await freshStore();
    await SpecialPowers.pushPrefEnv({ set: [["whimsy.ai.cmdbar.answer-saved-shown", false]] });
    gBrowser.selectedTab = tab;
    script = answerScript();
    await askWithKeys();
    await answered();
    const loaded = BrowserTestUtils.waitForNewTab(gBrowser, SPECS);
    EventUtils.synthesizeMouseAtCenter(cardEl().querySelector(".whimsy-ask-source"), {});
    const opened = await loaded;
    await TestUtils.waitForCondition(() => document.getElementById("whimsy-cmdbar-show-answer"), "Answer saved");
    return async () => {
      for (const t of gZenUIManager.toasts.getToasts()) {
        t.close({ instant: true });
      }
      BrowserTestUtils.removeTab(opened);
      gBrowser.selectedTab = tab;
      await SpecialPowers.popPrefEnv();
    };
  });
});

add_task(async function shots_motion_mid() {
  await freshStore();
  gBrowser.selectedTab = tab;
  const g = gate();
  script = async function* () {
    yield { type: "text", delta: "The **13-inch MacBook Air** is the lightest at **2.7 lb (1.24 kg)**." };
    await g.promise;
    yield { type: "text", delta: " The 15-inch is 3.3 lb. Both have the M5 chip." };
  };
  await askWithKeys();
  await TestUtils.waitForCondition(() => cardEl().querySelector(".whimsy-ask-caret"), "Streaming");
  g.open();
  await whimsyShotMid(NAME("cmd-1.5-words"), () => [...cardEl().querySelectorAll(".whimsy-ask-fresh")].at(-1)?.getAnimations()[0], 40);
  await answered();
  WhimsyCommandBarAI._flight = null;
  const flight = new Promise(resolve => {
    const real = WhimsyCommandBarAI.land;
    WhimsyCommandBarAI.land = function (...args) {
      WhimsyCommandBarAI.land = real;
      const done = real.apply(this, args);
      resolve();
      return done;
    };
  });
  EventUtils.synthesizeKey("KEY_Enter", { accelKey: true });
  await flight;
  await whimsyShotMid(NAME("cmd-1.9-handoff"), () => WhimsyCommandBarAI._flight, 80);
  await TestUtils.waitForCondition(() => !document.querySelector(".whimsy-ask-ghost"), "Landed");
  WhimsyChat.close(window, { reason: "key" });
  await seed();
  await openEmptyBar();
  EventUtils.synthesizeKey("KEY_ArrowDown");
  EventUtils.synthesizeKey("KEY_ArrowDown");
  EventUtils.synthesizeKey("KEY_Tab");
  EventUtils.synthesizeKey("KEY_Tab");
  EventUtils.synthesizeKey("KEY_Enter");
  await whimsyShotMid(NAME("cmd-2.4-menu"), () => gURLBar.view.panel.querySelector(".whimsy-remind-option")?.getAnimations()[0], 90);
  EventUtils.synthesizeKey("KEY_Escape");
  await TestUtils.waitForCondition(() => !gURLBar.view.panel.querySelector(".whimsy-remind-option"), "Menu closed");
  await closeBar();
});

add_task(async function shots_written() {
  const dir = Services.env.get("WHIMSY_SHOTS");
  if (!dir) {
    ok(true, "WHIMSY_SHOTS is unset, so no shots are written");
    return;
  }
  const names = (await IOUtils.getChildren(dir)).map(p => PathUtils.filename(p)).filter(n => n.startsWith("w23-cmdbar-ai-"));
  Assert.greaterOrEqual(names.length, 55, `Every state, light and dark, and the mid-motion frames (${names.length})`);
});
