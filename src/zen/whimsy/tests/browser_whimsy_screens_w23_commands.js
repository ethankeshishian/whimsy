/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

requestLongerTimeout(4);

// W23 commands: shots of Settings › AI › Commands and the command sheet for
// side-by-side checks against 07-settings set-6.x and fu-settings 6.1, 6.2,
// and 6.7. WHIMSY_SHOTS=<dir> writes w23-commands-*.png.

const { WhimsyAICommands } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyAICommands.sys.mjs");
const { WhimsyAIProviders } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyAIProviders.sys.mjs");

const TOUCHED = ["whimsy.ai.enabled", "whimsy.ai.order", "whimsy.ai.off", "whimsy.ai.quick-text-apple", "whimsy.verbs.skills"];
const saved = new Map(
  TOUCHED.map(name => {
    const type = Services.prefs.getPrefType(name);
    return [name, Services.prefs.prefHasUserValue(name) ? { type, value: whimsyReadPref(name, type) } : null];
  })
);
const realConnection = WhimsyAIProviders.connection;

function restorePrefs() {
  for (const [name, was] of saved) {
    if (was) {
      whimsyWritePref(name, was.type, was.value);
    } else {
      Services.prefs.clearUserPref(name);
    }
  }
}

const YOURS = [
  { name: "Make it a post", result: "copy", model: "claude", prompt: "Rewrite {selection} as one post for X, under 280 characters. Keep my voice; no hashtags." },
  { name: "Explain for a PM", result: "insert-after", model: "auto", prompt: "Plain-English version of anything technical: {selection}" },
  { name: "Wikipedia", result: "link", url: "https://en.wikipedia.org/w/index.php?search=%s" },
  { name: "Search Linear", result: "link", url: "https://linear.app/unicorner/search?q=%s" },
];

add_setup(async function () {
  await SpecialPowers.pushPrefEnv({ set: [["whimsy.feature.ai-hints", false]] });
  ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyAIHints.sys.mjs").WhimsyAIHints._settleForTesting();
  closeToasts();
  const connections = { apple: { method: "local" }, claude: { method: "plan", label: "Max" }, openai: { method: "plan", label: "Plus" } };
  WhimsyAIProviders.connection = async id => connections[id] ?? null;
  const outer = { width: window.outerWidth, height: window.outerHeight };
  await resizeTo(1280, 800);
  registerCleanupFunction(async () => {
    WhimsyAIProviders.connection = realConnection;
    await WhimsyAICommands._resetForTesting();
    restorePrefs();
    await WhimsyAICommands.init();
    await resizeTo(outer.width, outer.height);
    closeToasts();
  });
});

async function resizeTo(width, height) {
  window.resizeTo(width, height);
  await TestUtils.waitForCondition(() => window.outerWidth == width && window.outerHeight == height, `The window is ${width}×${height}`).catch(() =>
    info(`The window stayed ${window.outerWidth}×${window.outerHeight}`)
  );
  await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
}

async function seed(yours = YOURS) {
  restorePrefs();
  Services.prefs.setStringPref("whimsy.ai.order", "apple,claude,openai");
  Services.prefs.setBoolPref("whimsy.ai.quick-text-apple", true);
  Services.prefs.setBoolPref("whimsy.ai.enabled", true);
  await WhimsyAICommands._resetForTesting();
  await WhimsyAICommands.init();
  for (const cmd of yours) {
    await WhimsyAICommands.save(cmd);
  }
}

const visible = node => !!node?.checkVisibility();
const click = (page, node) => EventUtils.synthesizeMouseAtCenter(node, {}, page.win);

async function frames(win) {
  await new Promise(r => win.requestAnimationFrame(() => win.requestAnimationFrame(r)));
}

async function settled(page) {
  for (let i = 0; i < 3; i++) {
    const running = page.doc.getAnimations().filter(a => a.playState == "running" && a.effect?.getComputedTiming().iterations != Infinity);
    await Promise.all(running.map(a => a.finished.catch(() => {})));
    await page.doc.l10n.translateFragment(page.doc.documentElement);
    await frames(page.win);
  }
}

async function openCommands() {
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, "about:preferences#whimsyAI");
  const win = tab.linkedBrowser.contentWindow;
  const doc = win.document;
  await TestUtils.waitForCondition(() => win.WhimsyAISettings?.root && doc.getElementById("whimsyAIPage")?.checkVisibility(), "Settings › AI shows");
  const $ = id => doc.getElementById(id);
  await TestUtils.waitForCondition(() => $("whimsyCommandsList")?.dataset.ready == "true", "Commands are listed");
  const page = { tab, win, doc, $, S: win.WhimsyAISettings };
  await settled(page);
  $("whimsyAISection-commands").scrollIntoView({ block: "start", behavior: "instant" });
  await frames(win);
  return page;
}

async function done(page) {
  page.S.closeSheet({ restore: false });
  BrowserTestUtils.removeTab(page.tab);
  closeToasts();
}

async function editSheet(page, name) {
  const row = [...page.doc.querySelectorAll("#whimsyCommandsYours .whimsy-commands-row")].find(r => r.querySelector(".whimsy-ai-item-name").textContent == name);
  click(page, row.querySelector(".whimsy-commands-iconbtn"));
  await TestUtils.waitForCondition(() => page.$("whimsyAISheet")?.dataset.sheet == "command" && visible(page.$("whimsyAISheet")), "The command sheet opens");
}

function shoot(state, prepare, { yours = YOURS } = {}) {
  return whimsyBothSchemes(`w23-commands-${state}`, async dark => {
    await seed(yours);
    const page = await openCommands();
    try {
      await prepare(page, dark);
      await settled(page);
      ok(visible(page.$("whimsyAISection-commands")), `${state} (${dark ? "dark" : "light"}) is ready`);
    } catch (e) {
      await done(page);
      throw e;
    }
    return () => done(page);
  });
}

add_task(async function shots_list() {
  // set-6.1 and fu-settings 6.1: built in (switches) and yours (edit buttons).
  await shoot("set-6.1", async () => {});
});

add_task(async function shots_sheet() {
  // set-6.2 and fu-settings 6.2: a prompt command, the prompt focused, no Show in.
  await shoot("set-6.2", async page => {
    await editSheet(page, "Make it a post");
    const prompt = page.$("whimsyCommandPrompt");
    prompt.focus();
    page.win.getSelection().collapse(prompt, prompt.childNodes.length);
  });
  // set-6.3: a Link command.
  await shoot("set-6.3", async page => {
    await editSheet(page, "Wikipedia");
  });
  // set-6.4: Save with the prompt left empty.
  await shoot("set-6.4", async page => {
    await editSheet(page, "Make it a post");
    page.$("whimsyCommandPrompt").replaceChildren();
    click(page, page.$("whimsyCommandSave"));
    await TestUtils.waitForCondition(() => visible(page.$("whimsyCommandPromptError")), "The prompt's error shows");
  });
  // set-6.5: a Link command missing %s.
  await shoot("set-6.5", async page => {
    await editSheet(page, "Wikipedia");
    const address = page.$("whimsyCommandAddress");
    address.value = "https://en.wikipedia.org/wiki/Special:Search";
    click(page, page.$("whimsyCommandSave"));
    await TestUtils.waitForCondition(() => visible(page.$("whimsyCommandAddressError")), "The address's error shows");
  });
  // set-6.6: the result segment focused from the keyboard.
  await shoot("set-6.6", async page => {
    await editSheet(page, "Make it a post");
    page.$("whimsyCommandName").focus();
    EventUtils.synthesizeKey("KEY_Tab", {}, page.win);
  });
  // The token picker after typing "{".
  await shoot("tokens", async page => {
    await editSheet(page, "Explain for a PM");
    const prompt = page.$("whimsyCommandPrompt");
    prompt.focus();
    page.win.getSelection().collapse(prompt, prompt.childNodes.length);
    EventUtils.sendString(" from {", page.win);
    await TestUtils.waitForCondition(() => page.$("whimsyCommandsTokens"), "The token picker opens");
  });
});

add_task(async function shots_empty_and_deleted() {
  // set-6.7 and fu-settings 6.7: nothing of your own, and the Undo toast.
  await shoot(
    "set-6.7",
    async page => {
      await editSheet(page, "Make it a post");
      click(page, page.$("whimsyCommandDelete"));
      const toast = await TestUtils.waitForCondition(() => toastFor("whimsy-commands-deleted-toast"), "The Undo toast shows");
      await toast.shown;
      await document.l10n.translateFragment(toast.element);
      await TestUtils.waitForCondition(() => visible(page.$("whimsyCommandsEmpty")), "Yours is empty");
    },
    { yours: [YOURS[0]] }
  );
});

add_task(async function shots_mid_animation() {
  // The sheet fades and scales in over 160ms and its scrim over 150ms; both held at 80ms.
  await seed();
  const page = await openCommands();
  click(page, page.$("whimsyCommandsNew"));
  const both = () => {
    const { animation: a, scrimAnimation: s } = page.S.sheet ?? {};
    return a && s && {
      pause: () => (a.pause(), s.pause()),
      set currentTime(ms) {
        a.currentTime = s.currentTime = ms;
      },
      get currentTime() {
        return a.currentTime;
      },
      play: () => (a.play(), s.play()),
    };
  };
  await whimsyShotMid("w23-commands-sheet-open", both, 80);
  await settled(page);
  ok(visible(page.$("whimsyAISheet")), "The sheet finished opening");
  await done(page);
});

// ---- ⌘K (02-command-bar cmd-3.x, fu-media 3.5 and 4.10) and the
// right-click card (05-page page-2.x, fu-page 2.4, 2.6, and 2.8).

const { WhimsyVerbs, WhimsyContextCommands } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyVerbs.sys.mjs");
const { WhimsyAISelectionCard } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyAISelectionCard.sys.mjs");
const { WhimsyAIViewShare } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyAIViewShare.sys.mjs");
const { UrlbarTestUtils } = ChromeUtils.importESModule("resource://testing-common/UrlbarTestUtils.sys.mjs");

UrlbarTestUtils.init(this);

const ROOT = getRootDirectory(gTestPath).replace("chrome://mochitests/content", "https://example.com");
const IMPROVED = "Hi Priya, sorry for the slow reply. We probably should have moved the launch sooner, but there’s still time if we decide this week.";

async function closeBar() {
  if (gURLBar.view.isOpen) {
    await UrlbarTestUtils.promisePopupClose(window, () => gURLBar.view.close());
  }
  gURLBar.blur();
  gURLBar.searchMode = null;
  WhimsyVerbs.sessions.delete(window);
}

async function selectIn(browser, id) {
  await SpecialPowers.spawn(browser, [id], elementId => {
    const el = content.document.getElementById(elementId);
    el.focus?.();
    if (el.localName == "textarea" || el.localName == "input") {
      el.setSelectionRange(0, el.value.length);
      return;
    }
    const range = content.document.createRange();
    range.selectNodeContents(el);
    content.getSelection().removeAllRanges();
    content.getSelection().addRange(range);
  });
}

async function cmdkShot(state, kind, { select = null, typed = null, hover = null } = {}) {
  await seed();
  WhimsyContextCommands.detectLanguage = text => (/[؀-ۿ]/.test(text) ? "ar" : "en");
  WhimsyAIViewShare.imageText = { hasText: () => false };
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, `${ROOT}whimsy_cmdk.html?kind=${kind}`);
  try {
    await whimsyBothSchemes(`w23-commands-${state}`, async () => {
      if (select) {
        await selectIn(tab.linkedBrowser, select);
      }
      if (hover) {
        await BrowserTestUtils.synthesizeMouseAtCenter(`#${hover}`, { type: "mousemove" }, tab.linkedBrowser);
      }
      EventUtils.synthesizeKey("k", { accelKey: true });
      await TestUtils.waitForCondition(() => WhimsyVerbs.sessions.get(window)?.groups, "⌘K opened its menu");
      await UrlbarTestUtils.promiseSearchComplete(window);
      if (typed) {
        EventUtils.sendString(typed);
        await UrlbarTestUtils.promiseSearchComplete(window);
      }
      await document.l10n.translateFragment(gURLBar.view.panel);
      ok(gURLBar.view.isOpen, `${state} shows`);
      return closeBar;
    });
  } finally {
    WhimsyContextCommands.detectLanguage = null;
    WhimsyAIViewShare.imageText = null;
    BrowserTestUtils.removeTab(tab);
  }
}

add_task(async function shots_cmdk() {
  await cmdkShot("cmd-3.1", "article", { select: "sel" });
  await cmdkShot("cmd-3.2", "field", { select: "field" });
  await cmdkShot("cmd-3.3", "video");
  await cmdkShot("cmd-3.9", "video", { typed: "tra" });
  await cmdkShot("cmd-3.10", "video", { typed: "what does he say about battery" });
  await cmdkShot("cmd-3.11", "article", { select: "sel", typed: "" });
  await cmdkShot("cmd-3.16", "foreign", { select: "sel" });
  await cmdkShot("fu-media-3.5", "images");
  await cmdkShot("fu-media-4.10", "empty", { typed: "summ" });
});

add_task(async function shots_cmdk_product() {
  const fake = (id, label) => ({ id, group: "product", label, icon: "chrome://browser/content/whimsy/icons/compare.svg", run() {} });
  WhimsyVerbs.registerVerb(fake("compare", "Compare prices"));
  WhimsyVerbs.registerVerb({ ...fake("watch-price", "Watch price"), icon: "chrome://browser/content/whimsy/icons/eye.svg", tag: "$999.00" });
  try {
    await cmdkShot("cmd-3.6", "product");
  } finally {
    WhimsyVerbs.unregisterVerb("compare");
    WhimsyVerbs.unregisterVerb("watch-price");
  }
});

// The card: the provider answers `answer`, after `gate` when one is set.
let cardAnswer = IMPROVED;
let cardGate = null;
let cardFails = false;

function stubCard() {
  WhimsyAIProviders.setTestProvider(async function* () {
    if (cardFails) {
      throw Object.assign(new Error("down"), { code: "failed" });
    }
    const words = cardAnswer.split(" ");
    yield { type: "text", delta: words.slice(0, 6).join(" ") + " " };
    await cardGate;
    yield { type: "text", delta: words.slice(6).join(" ") };
  });
}

const menu = () => document.getElementById("contentAreaContextMenu");
const card = () => document.getElementById("whimsy-ai-selection-card");

async function rightClick(browser, id) {
  await selectIn(browser, id);
  const opened = BrowserTestUtils.waitForEvent(menu(), "popupshown");
  await BrowserTestUtils.synthesizeMouseAtCenter(`#${id}`, { type: "contextmenu", button: 2 }, browser);
  await opened;
  await document.l10n.translateFragment(menu());
}

async function openCard(browser, target, row, { done = true } = {}) {
  await rightClick(browser, target);
  const shown = BrowserTestUtils.waitForEvent(document, "popupshown", true, e => e.target.id == "whimsy-ai-selection-card");
  menu().activateItem(document.getElementById(`context-whimsy-ai-${row}`));
  await shown;
  await TestUtils.waitForCondition(() => WhimsyAISelectionCard.card?.status == (done ? "done" : "streaming") || WhimsyAISelectionCard.card?.status == "error", "The card has its answer");
  await document.l10n.translateFragment(card());
}

async function closeCard() {
  if (card()?.state == "open") {
    const hidden = BrowserTestUtils.waitForEvent(card(), "popuphidden");
    WhimsyAISelectionCard.close();
    await hidden;
  }
}

function cardShot(state, prepare) {
  return whimsyBothSchemes(`w23-commands-${state}`, async () => {
    await seed();
    stubCard();
    const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, `${ROOT}whimsy_ai_selection.html`);
    try {
      await prepare(tab.linkedBrowser);
    } catch (e) {
      BrowserTestUtils.removeTab(tab);
      throw e;
    }
    return async () => {
      if (menu().state == "open") {
        menu().hidePopup();
      }
      await closeCard();
      closeToasts();
      cardGate = null;
      cardFails = false;
      cardAnswer = IMPROVED;
      WhimsyAIProviders.setTestProvider(null);
      BrowserTestUtils.removeTab(tab);
    };
  });
}

add_task(async function shots_right_click() {
  // page-2.1: the four rows above Cut.
  await cardShot("page-2.1", browser => rightClick(browser, "draft"));
  // fu-page 2.4: the card under the selection, Replace the default.
  await cardShot("fu-page-2.4", browser => openCard(browser, "draft", "improve"));
  // page-2.3: mid-answer, the buttons dim.
  await cardShot("page-2.3", async browser => {
    cardGate = new Promise(() => {});
    await openCard(browser, "draft", "improve", { done: false });
  });
  // page-2.7: Fix marks what changed.
  await cardShot("page-2.7", async browser => {
    cardAnswer = "Hi Priya, sorry for the late reply. I think we should have moved the launch sooner, but there is still time if we decide this week.";
    await openCard(browser, "draft", "fix");
  });
  // page-2.9 and fu-page 2.8: read-only text gets Copy and Insert after.
  await cardShot("page-2.9", async browser => {
    cardAnswer = "Les trains de nuit sont revenus en Europe parce que l’avion est devenu plus difficile à aimer.";
    await openCard(browser, "article", "improve");
  });
  // fu-page 2.6: after Undo, the original is back and the card reopens on Replace.
  await cardShot("fu-page-2.6", async browser => {
    await openCard(browser, "draft", "improve");
    const hidden = BrowserTestUtils.waitForEvent(card(), "popuphidden");
    EventUtils.synthesizeMouseAtCenter(document.getElementById("whimsy-ai-card-replace"), {});
    await hidden;
    const reopened = BrowserTestUtils.waitForEvent(document, "popupshown", true, e => e.target.id == "whimsy-ai-selection-card");
    await TestUtils.waitForCondition(() => WhimsyAISelectionCard.replaced, "Replaced");
    await WhimsyAISelectionCard.replaced.undoEntry.undo();
    await reopened;
    await document.l10n.translateFragment(card());
  });
  // page-2.12: an error is one line and what to do next.
  await cardShot("page-2.12", async browser => {
    cardFails = true;
    await openCard(browser, "draft", "improve");
  });
});

add_task(async function shots_card_mid_animation() {
  // The card opens with the panel's fade; held halfway.
  await seed();
  stubCard();
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, `${ROOT}whimsy_ai_selection.html`);
  try {
    await rightClick(tab.linkedBrowser, "draft");
    const showing = BrowserTestUtils.waitForEvent(document, "popupshowing", true, e => e.target.id == "whimsy-ai-selection-card");
    menu().activateItem(document.getElementById("context-whimsy-ai-improve"));
    await showing;
    const animation = await TestUtils.waitForCondition(() => card()?.getAnimations({ subtree: true })[0] ?? (card()?.state == "open" ? "none" : null), "The card animates in");
    if (animation == "none") {
      info("The panel opened without an animation here; no mid frame");
    } else {
      await whimsyShotMid("w23-commands-card-open", () => card().getAnimations({ subtree: true })[0] ?? animation, 60);
    }
    await TestUtils.waitForCondition(() => card()?.state == "open", "The card opened");
    ok(true, "The card finished opening");
  } finally {
    await closeCard();
    WhimsyAIProviders.setTestProvider(null);
    BrowserTestUtils.removeTab(tab);
  }
});
