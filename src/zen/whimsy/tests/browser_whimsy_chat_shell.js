/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// W23 chat-shell: the chat panel column. ⌘E opens and closes it (and only
// ⌘E or the hide button do); Esc closes what's open inside it and never the
// panel; AI off turns the first ⌘E into a toast and later ones into setup;
// either side, Zen-style resize, and the narrow-window rules.

const { WhimsyChatPanel } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyChatPanel.sys.mjs");
const { WhimsyAIProviders } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyAIProviders.sys.mjs");
const { WhimsyAIStore } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyAIStore.sys.mjs");

const PAGE = "https://example.com/";
const PREFS = ["whimsy.chat.side", "whimsy.chat.width", "whimsy.chat.ai-off-toast-seen", "whimsy.ai.order"];

const chat = () => WhimsyChatPanel.forWindow(window);
const el = () => document.getElementById("whimsy-chat");
const part = sel => el().querySelector(sel);

function stubProvider() {
  const calls = [];
  WhimsyAIProviders.setTestProvider(async function* (provider, request) {
    calls.push({ provider, request });
    yield { type: "text", delta: "Hello." };
  });
  WhimsyAIProviders.setOrder(["claude"]);
  return calls;
}

async function settle() {
  await TestUtils.waitForCondition(
    () => !el() || el().getAnimations({ subtree: true }).every(a => a.playState != "running"),
    "The panel's motion has finished"
  );
}

// A key pressed while the page has focus reaches the window after the
// content process has seen it, so wait for chat to answer.
async function pressCmdE({ expect = "toggle" } = {}) {
  const was = chat().isOpen;
  EventUtils.synthesizeKey("e", { accelKey: true });
  if (expect == "toggle") {
    await TestUtils.waitForCondition(() => chat().isOpen != was, "⌘E reached chat");
  } else {
    await TestUtils.waitForTick();
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
  }
  await settle();
}

async function closeChat() {
  if (chat().isOpen) {
    chat().close({ reason: "key" });
    await settle();
  }
}

add_setup(async function () {
  await SpecialPowers.pushPrefEnv({ set: [["whimsy.ai.enabled", true], ["whimsy.feature.ai-hints", false]] });
  await WhimsyAIStore._resetForTesting(PathUtils.join(PathUtils.tempDir, "whimsy-chat-shell-" + Date.now()));
  const { outerWidth, outerHeight } = window;
  window.resizeTo(1400, 900);
  await TestUtils.waitForCondition(() => window.innerWidth >= 1300, "Wide window");
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE);
  registerCleanupFunction(async () => {
    await closeChat();
    BrowserTestUtils.removeTab(tab);
    WhimsyAIProviders.setTestProvider(null);
    for (const pref of PREFS) {
      Services.prefs.clearUserPref(pref);
    }
    window.resizeTo(outerWidth, outerHeight);
    await WhimsyAIStore._resetForTesting(null);
  });
});

// ---- Task 1: open and close, Esc, focus ----

add_task(async function closed_by_default_nothing_sent() {
  const calls = stubProvider();
  ok(!chat().isOpen, "Chat is closed by default");
  ok(!el() || el().hidden, "and draws nothing beside the page");
  await pressCmdE();
  ok(chat().isOpen, "⌘E opens it");
  await TestUtils.waitForTick();
  is(calls.length, 0, "Opening sends nothing until you ask");
  await closeChat();
});

add_task(async function cmd_e_toggles_and_focuses_composer() {
  stubProvider();
  gBrowser.selectedBrowser.focus();
  await pressCmdE();
  ok(chat().isOpen, "⌘E opens chat");
  ok(!el().hidden, "The panel shows");
  is(document.activeElement, chat().composer, "Focus lands in the composer");
  await pressCmdE();
  ok(!chat().isOpen, "⌘E again closes it");
  ok(el().hidden, "The panel is gone");
  is(document.activeElement, gBrowser.selectedBrowser, "Focus goes back to the page");
});

add_task(async function esc_never_closes_chat() {
  stubProvider();
  await pressCmdE();
  chat().composer.focus();
  EventUtils.sendString("hi");
  EventUtils.synthesizeKey("KEY_Escape");
  await settle();
  ok(chat().isOpen, "Esc leaves chat open");
  is(document.activeElement, chat().composer, "Focus stays in the composer");
  is(chat().composer.value, "hi", "and what was typed stays");
  part(".whimsy-chat-head-title").focus();
  EventUtils.synthesizeKey("KEY_Escape");
  ok(chat().isOpen, "Esc on the header does nothing either");
  chat().composer.value = "";
  await closeChat();
});

add_task(async function esc_closes_list_then_nothing() {
  stubProvider();
  await pressCmdE();
  EventUtils.synthesizeMouseAtCenter(part("#whimsy-chat-list-button"), {});
  await settle();
  const list = part(".whimsy-chat-list");
  ok(!list.hidden, "The conversation list slides over the thread");
  EventUtils.synthesizeKey("KEY_Escape");
  await settle();
  ok(list.hidden, "Esc closes the list");
  ok(chat().isOpen, "and only the list");
  EventUtils.synthesizeKey("KEY_Escape");
  await settle();
  ok(chat().isOpen, "A second Esc does nothing");
  ok(el().contains(document.activeElement), "Focus stays in chat");
  await closeChat();
});

add_task(async function hide_button_tooltip_and_icon() {
  stubProvider();
  await pressCmdE();
  const hide = part("#whimsy-chat-hide-button");
  await document.l10n.translateFragment(hide);
  is(hide.getAttribute("title"), "Hide chat ⌘E", "The tooltip names the key");
  ok(getComputedStyle(hide.querySelector(".whimsy-chat-icon")).backgroundImage.includes("chat-hide.svg"), "Its icon is Zen's sidebar icon, flipped");
  is(hide.getAttribute("aria-keyshortcuts"), "Meta+E", "VoiceOver hears the key");
  EventUtils.synthesizeMouseAtCenter(hide, {});
  await settle();
  ok(!chat().isOpen, "The hide button closes chat");
});

add_task(async function ai_off_first_cmd_e_toasts_then_opens_setup() {
  Services.prefs.setBoolPref("whimsy.ai.enabled", false);
  Services.prefs.clearUserPref("whimsy.chat.ai-off-toast-seen");
  await pressCmdE({ expect: "nothing" });
  ok(!chat().isOpen, "With AI off, ⌘E doesn't open chat");
  await TestUtils.waitForCondition(
    () => gZenUIManager.toasts.getToasts().some(t => t.element.getAttribute("whimsy-chat-ai-off")),
    "The first ⌘E shows the Set up AI toast"
  );
  const opened = BrowserTestUtils.waitForNewTab(gBrowser, url => url.startsWith("about:preferences"), true);
  await pressCmdE({ expect: "nothing" });
  const tab = await opened;
  is(tab.linkedBrowser.currentURI.spec, "about:preferences?sheet=add-provider#whimsyAI", "The next ⌘E opens Settings › AI on Add a provider");
  ok(!chat().isOpen, "Chat still doesn't open");
  BrowserTestUtils.removeTab(tab);
  for (const toast of gZenUIManager.toasts.getToasts()) {
    toast.close?.();
  }
  Services.prefs.setBoolPref("whimsy.ai.enabled", true);
  ok(!Services.prefs.prefHasUserValue("whimsy.chat.ai-off-toast-seen"), "Turning AI on forgets the toast, so it shows again next time AI is off");
});

add_task(async function find_selection_no_longer_on_cmd_e() {
  const find = document.getElementById("key_findSelection");
  ok(!find || find.getAttribute("key")?.toLowerCase() != "e", "Use Selection for Find no longer has ⌘E");
  const key = document.getElementById("key_cmd_whimsyChatToggle");
  is(key?.getAttribute("key")?.toLowerCase(), "e", "Chat holds ⌘E");
  is(key.getAttribute("modifiers"), "accel", "with Command alone");
  ok(document.getElementById("cmd_whimsyChatToggle"), "It's a named command");
});

// ---- Task 2: side, resize, narrow windows ----

add_task(async function move_left_sits_inside_tabs() {
  stubProvider();
  await pressCmdE();
  const tabbox = document.getElementById("tabbrowser-tabbox");
  const tabs = document.getElementById("navigator-toolbox");
  ok(el().getBoundingClientRect().left > tabbox.getBoundingClientRect().right - 1, "On the right by default");
  document.getElementById("cmd_whimsyChatMoveLeft").doCommand();
  await settle();
  is(Services.prefs.getStringPref("whimsy.chat.side"), "left", "One setting for every window");
  const chatRect = el().getBoundingClientRect();
  ok(chatRect.right <= tabbox.getBoundingClientRect().left + 1, "Chat sits left of the page");
  ok(tabs.getBoundingClientRect().right <= chatRect.left + 1, "and inside the tabs, which stay at the window edge");
  document.getElementById("cmd_whimsyChatMoveRight").doCommand();
  await settle();
  ok(el().getBoundingClientRect().left > tabbox.getBoundingClientRect().right - 1, "Back on the right");
  await closeChat();
});

function splitter() {
  return part(".whimsy-chat-splitter");
}

async function drag(dx) {
  const s = splitter();
  EventUtils.synthesizeMouse(s, 4, 100, { type: "mousedown" });
  EventUtils.synthesizeMouse(s, 4 + dx / 2, 100, { type: "mousemove" });
  EventUtils.synthesizeMouse(s, 4 + dx, 100, { type: "mousemove" });
  EventUtils.synthesizeMouse(s, 4 + dx, 100, { type: "mouseup" });
  await settle();
}

add_task(async function resize_bounds_and_double_click_reset() {
  stubProvider();
  await pressCmdE();
  const panel = part(".whimsy-chat-panel");
  is(Math.round(panel.getBoundingClientRect().width), 380, "380px by default");
  await drag(-100);
  is(Math.round(panel.getBoundingClientRect().width), 480, "Dragging the gap follows the pointer");
  is(Services.prefs.getIntPref("whimsy.chat.width"), 480, "and keeps the width for every window");
  await drag(-2000);
  is(Math.round(panel.getBoundingClientRect().width), Math.floor(window.innerWidth / 2), "No wider than half the window");
  await drag(400);
  ok(chat().isOpen, "A drag that isn't nearly shut keeps chat open");
  is(Math.round(panel.getBoundingClientRect().width) >= 320, true, "No narrower than 320px");
  const diag = [];
  const t0 = performance.now();
  const snap = label =>
    diag.push(
      `${label} t=${(performance.now() - t0).toFixed(2)} w=${Math.round(panel.getBoundingClientRect().width)} ` +
        `resizing=${splitter().hasAttribute("resizing")} anim=${el()
          .getAnimations({ subtree: true })
          .map(a => `${a.playState}`)
          .join(",")}`
    );
  const log = e => diag.push(`${e.type} detail=${e.detail} t=${(performance.now() - t0).toFixed(2)}`);
  for (const t of ["mousedown", "mouseup", "click", "dblclick", "mousemove"]) {
    window.addEventListener(t, log, true);
  }
  snap("before-click1");
  EventUtils.synthesizeMouse(splitter(), 4, 100, { clickCount: 1 });
  snap("after-click1");
  EventUtils.synthesizeMouse(splitter(), 4, 100, { clickCount: 2 });
  snap("after-click2-sync");
  await settle();
  snap("after-settle");
  for (const t of ["mousedown", "mouseup", "click", "dblclick", "mousemove"]) {
    window.removeEventListener(t, log, true);
  }
  const widthNow = Math.round(panel.getBoundingClientRect().width);
  if (widthNow != 380) {
    info(`DBLCLICK DIAG FAIL: ${diag.join(" | ")}`);
  }
  is(widthNow, 380, "Double-click resets the width");
  ok(!Services.prefs.prefHasUserValue("whimsy.chat.width"), "and forgets it");
  await closeChat();
});

add_task(async function drag_shut_hides_and_cmd_e_restores_width() {
  stubProvider();
  Services.prefs.setIntPref("whimsy.chat.width", 450);
  await pressCmdE();
  await drag(360);
  ok(!chat().isOpen, "Dragging nearly shut hides chat");
  is(Services.prefs.getIntPref("whimsy.chat.width"), 450, "The last width is kept");
  await pressCmdE();
  is(Math.round(part(".whimsy-chat-panel").getBoundingClientRect().width), 450, "⌘E brings it back at that width");
  await closeChat();
  Services.prefs.clearUserPref("whimsy.chat.width");
});

add_task(async function narrow_window_320_then_overlay_under_480_page() {
  stubProvider();
  const { outerWidth, outerHeight } = window;
  window.resizeTo(900, 700);
  await TestUtils.waitForCondition(() => window.innerWidth <= 900, "Narrow window");
  await pressCmdE();
  const wrapper = document.getElementById("zen-tabbox-wrapper");
  is(Math.round(part(".whimsy-chat-panel").getBoundingClientRect().width), 320, "Under 1000px, chat is 320px");
  const pageWouldBe = wrapper.getBoundingClientRect().width - 320 - 8;
  is(el().hasAttribute("overlay"), pageWouldBe < 480, "It floats only if the page would be under 480px");
  window.resizeTo(700, 560);
  await TestUtils.waitForCondition(() => el().hasAttribute("overlay"), "A tiny window floats chat over the page");
  ok(gBrowser.selectedBrowser.getBoundingClientRect().width > 320, "The page keeps its width under the floating chat");
  await closeChat();
  window.resizeTo(outerWidth, outerHeight);
  await TestUtils.waitForCondition(() => window.innerWidth >= 1300, "Wide again");
});
