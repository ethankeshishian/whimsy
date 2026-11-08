/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// W23 chat-shell: shots of the chat panel for side-by-side checks against
// 03-chat (chat-1.x, 8.x, 9.3, 11.1), fu-chat (1.1, 9.2, 9.4, 11.2), and
// fu-agent chat-dec-13. WHIMSY_SHOTS=<dir> writes w23-chat-shell-*.png.

const { WhimsyChatPanel } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyChatPanel.sys.mjs");
const { WhimsyChat } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyChat.sys.mjs");
const { WhimsyAIProviders } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyAIProviders.sys.mjs");
const { WhimsyAIStore } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyAIStore.sys.mjs");
const { WhimsyAIContext } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyAIContext.sys.mjs");
const { WhimsyPrivate } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyPrivate.sys.mjs");

const ROOT = getRootDirectory(gTestPath).replace("chrome://mochitests/content", "https://example.com");
const ARTICLE = ROOT + "whimsy_chat_article.html";
const ANSWER =
  "Cities are dropping the rule that new buildings must include parking, and it mostly lowers housing costs.\n\n" +
  "• More than 60 cities have done it, starting with Buffalo in 2017.\n" +
  "• Builders there added 21% fewer spaces and used the land for homes and shops.\n" +
  "• A garage space can add $50,000 to a new apartment.\n\n" +
  "Street parking in Minneapolis stayed under 85% full afterwards, so the feared crowding didn’t show up.";

const chat = () => WhimsyChatPanel.forWindow(window);
const el = () => document.getElementById("whimsy-chat");
const part = sel => el().querySelector(sel);
const NAME = state => `w23-chat-shell-${state}`;

let article;

async function settle() {
  await TestUtils.waitForCondition(
    () => !el() || el().getAnimations({ subtree: true }).every(a => a.playState != "running" || a.effect?.getComputedTiming().iterations == Infinity),
    "The panel's motion has finished"
  );
}

async function openChat(opts) {
  await WhimsyChat.open(window, opts);
  await TestUtils.waitForCondition(() => chat().ready, "Chat is ready");
  await settle();
}

async function closeChat() {
  if (chat().isOpen) {
    chat().close({ reason: "key" });
    await settle();
  }
}

// Every running animation of the panel, held as one.
function allOf(root) {
  const list = () => root.getAnimations({ subtree: true }).filter(a => a.effect?.getComputedTiming().iterations != Infinity);
  return () => {
    const anims = list();
    if (!anims.length) {
      return null;
    }
    return {
      pause: () => anims.forEach(a => a.pause()),
      play: () => anims.forEach(a => a.play()),
      set currentTime(ms) {
        anims.forEach(a => (a.currentTime = ms));
      },
      get currentTime() {
        return anims[0].currentTime;
      },
    };
  };
}

async function answeredThread() {
  const tabKey = WhimsyAIContext.tabKey(article);
  const thread = await WhimsyAIStore.createThread({ kind: "tab", tabKey, title: article.label, url: ARTICLE, firstAsk: "Sum up this article" });
  await WhimsyAIStore.append(thread.id, { role: "user", text: "Sum up this article" });
  await WhimsyAIStore.append(thread.id, { role: "ai", text: ANSWER, provider: "claude" });
  return thread;
}

add_setup(async function () {
  await SpecialPowers.pushPrefEnv({ set: [["whimsy.ai.enabled", true], ["whimsy.feature.ai-hints", false]] });
  await WhimsyAIStore._resetForTesting(PathUtils.join(PathUtils.tempDir, "whimsy-chat-shots-" + Date.now()));
  WhimsyAIProviders.setTestProvider(async function* () {
    yield { type: "text", delta: ANSWER };
  });
  WhimsyAIProviders.setOrder(["claude"]);
  const { outerWidth, outerHeight } = window;
  window.resizeTo(1280, 800);
  await TestUtils.waitForCondition(() => window.innerWidth >= 1200, "Mockup-sized window");
  article = await BrowserTestUtils.openNewForegroundTab(gBrowser, ARTICLE);
  registerCleanupFunction(async () => {
    await closeChat();
    BrowserTestUtils.removeTab(article);
    WhimsyAIProviders.setTestProvider(null);
    for (const pref of ["whimsy.ai.order", "whimsy.chat.side", "whimsy.chat.width", "whimsy.chat.ai-off-toast-seen"]) {
      Services.prefs.clearUserPref(pref);
    }
    window.resizeTo(outerWidth, outerHeight);
    await WhimsyAIStore._resetForTesting(null);
  });
});

add_task(async function shots_open_close() {
  await whimsyBothSchemes(NAME("chat-1.1"), async () => closeChat());
  await whimsyBothSchemes(NAME("chat-1.3"), async () => {
    await openChat();
    const box = part(".whimsy-chat-composer");
    info(`Composer ${box.getBoundingClientRect().height}px; ` + [...box.querySelectorAll("*")].map(e => `${e.className}:${Math.round(e.getBoundingClientRect().height)}`).join(", "));
    return closeChat;
  });
  for (const dark of [false, true]) {
    await whimsySetScheme(dark);
    EventUtils.synthesizeKey("e", { accelKey: true });
    await whimsyShotMid(`${NAME("chat-1.2")}-${dark ? "dark" : "light"}`, allOf(el()), 120);
    await settle();
    await closeChat();
    await SpecialPowers.popPrefEnv();
  }
});

add_task(async function shots_answer_and_hide_button() {
  const thread = await answeredThread();
  await whimsyBothSchemes(NAME("fu-chat-1.1"), async () => {
    await openChat({ threadId: thread.id });
    const hide = part("#whimsy-chat-hide-button");
    InspectorUtils.addPseudoClassLock(hide, ":hover");
    return async () => {
      InspectorUtils.removePseudoClassLock(hide, ":hover");
      await closeChat();
    };
  });
  await whimsyBothSchemes(NAME("fu-chat-9.2"), async () => {
    Services.prefs.setStringPref("whimsy.chat.side", "left");
    await openChat({ threadId: thread.id });
    return async () => {
      await closeChat();
      Services.prefs.clearUserPref("whimsy.chat.side");
    };
  });
  await whimsyBothSchemes(NAME("fu-chat-9.4"), async () => {
    await openChat({ threadId: thread.id });
    const splitter = part(".whimsy-chat-splitter");
    splitter.setAttribute("resizing", "true");
    return async () => {
      splitter.removeAttribute("resizing");
      await closeChat();
    };
  });
  for (const dark of [false, true]) {
    await whimsySetScheme(dark);
    await openChat({ threadId: thread.id });
    const splitter = part(".whimsy-chat-splitter");
    InspectorUtils.addPseudoClassLock(splitter, ":hover");
    await whimsyShotMid(`${NAME("fu-chat-9.4")}-${dark ? "dark" : "light"}`, () => splitter.getAnimations({ subtree: true })[0], 300);
    InspectorUtils.removePseudoClassLock(splitter, ":hover");
    await closeChat();
    await SpecialPowers.popPrefEnv();
  }
  await WhimsyAIStore.deleteThread(thread.id);
});

add_task(async function shots_ai_off_toast() {
  await whimsyBothSchemes(NAME("fu-chat-11.2"), async () => {
    Services.prefs.setBoolPref("whimsy.ai.enabled", false);
    Services.prefs.clearUserPref("whimsy.chat.ai-off-toast-seen");
    EventUtils.synthesizeKey("e", { accelKey: true });
    await TestUtils.waitForCondition(
      () => gZenUIManager.toasts.getToasts().find(t => t.element.getAttribute("whimsy-chat-ai-off")),
      "The AI-off toast shows"
    );
    const toast = gZenUIManager.toasts.getToasts().find(t => t.element.getAttribute("whimsy-chat-ai-off"));
    await toast.shown;
    await document.l10n.translateFragment(toast.element);
    return async () => {
      toast.close();
      Services.prefs.setBoolPref("whimsy.ai.enabled", true);
    };
  });
});

add_task(async function shots_narrow_overlay() {
  const thread = await answeredThread();
  const { outerWidth, outerHeight } = window;
  window.resizeTo(720, 560);
  await TestUtils.waitForCondition(() => window.innerWidth <= 720, "Tiny window");
  await whimsyBothSchemes(NAME("chat-9.3"), async () => {
    await openChat({ threadId: thread.id });
    ok(el().hasAttribute("overlay"), "Chat floats over the page");
    return closeChat;
  });
  window.resizeTo(outerWidth, outerHeight);
  await TestUtils.waitForCondition(() => window.innerWidth >= 1200, "Back to size");
  await WhimsyAIStore.deleteThread(thread.id);
});

add_task(async function shots_list_and_threads() {
  const now = Date.now();
  const mine = await answeredThread();
  await WhimsyAIStore.createThread({ kind: "routine", title: "Daily brief", detail: "Weekdays 8:00 · 3 new today", updated: now - 3600000 });
  await WhimsyAIStore.createThread({ kind: "watch", title: "Fjell desk price watch", detail: "Dropped to $649", updated: now - 86400000 });
  await WhimsyAIStore.createThread({ kind: "tab", tabKey: "t-tokyo", title: "How Tokyo trains run on time", firstAsk: "Summarize this video", url: "https://www.youtube.com/watch", updated: now - 86400000 - 1000 });
  const q4 = await WhimsyAIStore.createThread({ kind: "tab", tabKey: "t-q4", title: "Q4 plan cost check", firstAsk: "Does this back up the plan?", url: "https://docs.google.com/", updated: now - 4 * 86400000 });
  await WhimsyAIStore.append(q4.id, { role: "ai", text: "Structured parking adds about $30k per unit in this plan." });
  await WhimsyAIStore.updateThread(q4.id, { updated: now - 4 * 86400000 });
  const closed = await WhimsyAIStore.createThread({
    kind: "tab", tabKey: "t-desk", title: "Desk app v3 review", url: "https://example.org/", firstAsk: "Is the spacing on the pricing cards consistent?",
    closedTab: { url: "https://example.org/", title: "Desk app v3", at: now - 3600000 }, updated: now - 8 * 86400000,
  });
  await WhimsyAIStore.append(closed.id, { role: "user", text: "Is the spacing on the pricing cards consistent?" });
  await WhimsyAIStore.append(closed.id, { role: "ai", text: "Not quite: the middle card has 24px padding, the others 20px." });
  await WhimsyAIStore.updateThread(closed.id, { updated: now - 8 * 86400000 });

  await whimsyBothSchemes(NAME("chat-8.1"), async () => {
    await openChat({ threadId: mine.id });
    EventUtils.synthesizeMouseAtCenter(part("#whimsy-chat-list-button"), {});
    await settle();
    return closeChat;
  });
  for (const dark of [false, true]) {
    await whimsySetScheme(dark);
    await openChat({ threadId: mine.id });
    EventUtils.synthesizeMouseAtCenter(part("#whimsy-chat-list-button"), {});
    await whimsyShotMid(`${NAME("chat-8.2")}-${dark ? "dark" : "light"}`, () => part(".whimsy-chat-list").getAnimations()[0], 100);
    await settle();
    await closeChat();
    await SpecialPowers.popPrefEnv();
  }
  await whimsyBothSchemes(NAME("chat-8.2"), async () => {
    await openChat({ threadId: mine.id });
    EventUtils.synthesizeMouseAtCenter(part("#whimsy-chat-list-button"), {});
    await settle();
    EventUtils.sendString("parking");
    await TestUtils.waitForCondition(() => el().querySelectorAll(".whimsy-chat-conv mark").length, "Matches show");
    await document.l10n.translateFragment(el());
    return closeChat;
  });
  await whimsyBothSchemes(NAME("chat-8.4"), async () => {
    await openChat({ threadId: closed.id });
    return closeChat;
  });
});

add_task(async function shots_private_wall() {
  const priv = WhimsyPrivate.openPrivateTab(window, { url: ARTICLE, force: true });
  await BrowserTestUtils.browserLoaded(priv.linkedBrowser, false, ARTICLE);
  await whimsyBothSchemes(NAME("chat-11.1"), async () => {
    await openChat();
    await TestUtils.waitForCondition(() => el().hasAttribute("private"), "The wall shows");
    await document.l10n.translateFragment(el());
    return closeChat;
  });
  BrowserTestUtils.removeTab(priv);
});

add_task(async function shots_tasks_strip() {
  let tasks = [
    { id: "a", title: "Lisbon hotels", detail: "Reading reviews · step 3 of 4 · Travel" },
    { id: "b", title: "Expense report", detail: "Needs you: confirm the total", waiting: true },
  ];
  const off = WhimsyChat.registerTaskSource({ id: "shots", list: () => tasks, show() {}, stop() {} });
  await whimsyBothSchemes(NAME("fu-agent-chat-dec-13"), async () => {
    await openChat();
    chat().newChat();
    await TestUtils.waitForCondition(() => chat().ready, "A new chat");
    await TestUtils.waitForCondition(() => part(".whimsy-chat-tasks[collapsed]"), "Two tasks fold to one line");
    await document.l10n.translateFragment(el());
    return closeChat;
  });
  await whimsyBothSchemes(NAME("fu-agent-chat-dec-13-expanded"), async () => {
    await openChat();
    EventUtils.synthesizeMouseAtCenter(part("[data-action='expand']"), {});
    await TestUtils.waitForCondition(() => !part(".whimsy-chat-tasks[collapsed]"), "Expanded");
    await document.l10n.translateFragment(el());
    return closeChat;
  });
  tasks = [tasks[0]];
  WhimsyChat.tasksChanged();
  await whimsyBothSchemes(NAME("fu-agent-chat-dec-13-one"), async () => {
    await openChat();
    await document.l10n.translateFragment(el());
    return closeChat;
  });
  off();
});
