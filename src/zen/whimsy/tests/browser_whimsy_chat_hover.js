/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

const { WhimsyChatPanel } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyChatPanel.sys.mjs");
const { WhimsyAIProviders } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyAIProviders.sys.mjs");
const { WhimsyAIStore } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyAIStore.sys.mjs");

const HOVER_PREF = "whimsy.ai.chat.edge-hover";
const chat = () => WhimsyChatPanel.forWindow(window);
const root = document.documentElement;

async function settle() {
  await TestUtils.waitForCondition(() => !chat().el || chat().el.getAnimations({ subtree: true }).every(a => a.playState != "running"), "Chat's motion finished");
}

function edge(side = "right", options = {}) {
  const box = root.getBoundingClientRect();
  EventUtils.synthesizeMouse(root, side == "right" ? box.width - 1 : 1, box.height / 2, { type: "mousemove", ...options });
}

function away() {
  EventUtils.synthesizeMouseAtCenter(gBrowser.selectedBrowser, { type: "mousemove" });
}

async function peek(side = "right") {
  away();
  edge(side);
  await TestUtils.waitForCondition(() => chat().isOpen && chat().ready, "The edge reveals chat");
  await settle();
  ok(chat().peeking, "It is a peek");
  ok(chat().el.hasAttribute("overlay"), "The peek floats over the page");
}

async function closeChat() {
  chat().close();
  await settle();
  away();
}

async function noPeek(message, side = "right", options = {}) {
  edge(side, options);
  await TestUtils.waitForTick();
  ok(!chat().isOpen, message);
  ok(!chat().hoverEnter, "No delayed reveal is queued");
  away();
}

add_setup(async function () {
  await SpecialPowers.pushPrefEnv({ set: [
    ["whimsy.ai.enabled", true],
    ["whimsy.ai.order", "claude"],
    ["whimsy.feature.ai-chat", true],
    ["whimsy.feature.ai-hints", false],
    [HOVER_PREF, true],
    ["whimsy.chat.side", "right"],
    ["whimsy.chat.width", 380],
    ["zen.tabs.vertical.right-side", false],
    ["zen.view.use-single-toolbar", true],
  ] });
  const { outerWidth, outerHeight } = window;
  const storeDir = PathUtils.join(PathUtils.profileDir, "whimsy-chat-hover-" + Date.now());
  await WhimsyAIStore._resetForTesting(storeDir);
  WhimsyAIProviders.setTestProvider(async function* () {
    yield { type: "text", delta: "Hello." };
  });
  window.resizeTo(1400, 900);
  await TestUtils.waitForCondition(() => window.innerWidth >= 1300, "Wide window");
  await TestUtils.waitForCondition(() => root.getAttribute("zen-single-toolbar") == "true" && !gZenCompactModeManager.sidebarIsOnRight, "The single-toolbar layout is ready");
  await SimpleTest.promiseFocus(window);
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.com/");
  registerCleanupFunction(async () => {
    await closeChat();
    BrowserTestUtils.removeTab(tab);
    WhimsyAIProviders.setTestProvider(null);
    window.resizeTo(outerWidth, outerHeight);
    await WhimsyAIStore._resetForTesting(null);
    await IOUtils.remove(storeDir, { recursive: true, ignoreAbsent: true });
  });
});

add_task(async function edge_reveals_away_collapses_without_focus() {
  gBrowser.selectedBrowser.focus();
  await peek();
  is(document.activeElement, gBrowser.selectedBrowser, "Peeking preserves page focus");
  const pageWidth = gBrowser.selectedBrowser.getBoundingClientRect().width;
  away();
  await TestUtils.waitForCondition(() => !chat().isOpen && chat().el.hidden, "Away collapses chat after Zen's delay");
  is(gBrowser.selectedBrowser.getBoundingClientRect().width, pageWidth, "Peeking never resizes the page");
  ok(chat().peekMotion().enter?.duration > 0, "The animation uses Zen's loaded sidebar spring");
  ok(chat().peekMotion().exit?.duration > 0, "The exit uses Zen's sidebar transition");
});

add_task(async function focus_typing_and_starter_pin_until_cmd_e() {
  for (const action of ["focus", "type", "starter", "history", "menu", "drop"]) {
    await peek();
    if (action == "focus") {
      EventUtils.synthesizeMouseAtCenter(chat().composer, {});
    } else if (action == "type") {
      chat().composer.focus();
      EventUtils.sendString("A draft");
      is(chat().composer.value, "A draft", "Typing is kept");
    } else if (action == "starter") {
      await TestUtils.waitForCondition(() => chat().body.querySelector(".whimsy-chat-suggestion")?.textContent.trim(), "A starter is ready");
      EventUtils.synthesizeMouseAtCenter(chat().body.querySelector(".whimsy-chat-suggestion"), {});
      await TestUtils.waitForCondition(() => !chat().streams.size, "The stub answer finished");
    } else if (action == "history") {
      EventUtils.synthesizeMouseAtCenter(document.getElementById("whimsy-chat-list-button"), {});
      await TestUtils.waitForCondition(() => chat().listOpen, "History opened");
    } else if (action == "menu") {
      EventUtils.synthesizeMouseAtCenter(chat().header, { type: "contextmenu", button: 2 });
      await TestUtils.waitForCondition(() => chat().headMenu.state == "open", "Chat's menu opened");
      const hidden = BrowserTestUtils.waitForEvent(chat().headMenu, "popuphidden");
      chat().headMenu.hidePopup();
      await hidden;
    } else {
      chat().panel.dispatchEvent(new DragEvent("dragenter", { bubbles: true }));
    }
    away();
    ok(!chat().peeking && !chat().hoverLeave, `${action} promotes the peek and cancels collapse`);
    ok(chat().isOpen, `${action} leaves chat open`);
    EventUtils.synthesizeKey("e", { accelKey: true });
    await TestUtils.waitForCondition(() => !chat().isOpen && chat().el.hidden, "⌘E closes the engaged chat");
    chat().composer.value = "";
  }
});

add_task(async function suppressed_by_popup_press_drag_fullscreen_and_pref() {
  const menu = document.createXULElement("menupopup");
  const item = document.createXULElement("menuitem");
  item.setAttribute("label", "Test menu");
  menu.append(item);
  document.getElementById("mainPopupSet").append(menu);
  try {
    const shown = BrowserTestUtils.waitForEvent(menu, "popupshown");
    menu.openPopupAtScreen(window.screenX + 100, window.screenY + 100, true);
    await shown;
    await noPeek("An unrelated menu blocks peeking");
    const hidden = BrowserTestUtils.waitForEvent(menu, "popuphidden");
    menu.hidePopup();
    await hidden;
  } finally {
    menu.remove();
  }
  EventUtils.synthesizeMouseAtCenter(gBrowser.selectedBrowser, { type: "mousedown" });
  try {
    await noPeek("A pressed pointer blocks peeking", "right", { buttons: 1 });
  } finally {
    EventUtils.synthesizeMouseAtCenter(gBrowser.selectedBrowser, { type: "mouseup" });
  }
  gBrowser.selectedBrowser.dispatchEvent(new DragEvent("dragstart", { bubbles: true }));
  await noPeek("A drag outside chat blocks peeking");
  gBrowser.selectedBrowser.dispatchEvent(new DragEvent("dragend", { bubbles: true }));
  root.setAttribute("inDOMFullscreen", "true");
  try {
    await noPeek("Fullscreen video blocks peeking");
  } finally {
    root.removeAttribute("inDOMFullscreen");
  }
  await SpecialPowers.pushPrefEnv({ set: [[HOVER_PREF, false]] });
  await noPeek("The switch disables peeking");
  await chat().open();
  ok(chat().isOpen, "Manual opening still works with the switch off");
  await closeChat();
  await SpecialPowers.popPrefEnv();
  await peek();
  await SpecialPowers.pushPrefEnv({ set: [[HOVER_PREF, false]] });
  await TestUtils.waitForCondition(() => chat().el.hidden, "Turning the switch off collapses an existing peek");
  await SpecialPowers.popPrefEnv();
  away();
});

add_task(async function follows_dock_side_and_tabs_win_shared_edge() {
  await SpecialPowers.pushPrefEnv({ set: [["whimsy.chat.side", "left"]] });
  await noPeek("Tabs win the left edge", "left");
  await SpecialPowers.pushPrefEnv({ set: [["zen.tabs.vertical.right-side", true]] });
  await TestUtils.waitForCondition(() => gZenCompactModeManager.sidebarIsOnRight, "Tabs moved right");
  await peek("left");
  away();
  await TestUtils.waitForCondition(() => chat().el.hidden, "Left peek collapses");
  await SpecialPowers.popPrefEnv();
  await SpecialPowers.popPrefEnv();
  await TestUtils.waitForCondition(() => !gZenCompactModeManager.sidebarIsOnRight, "Tabs moved back");
});

add_task(async function equal_outer_gaps_default_and_minimum_width_light_dark() {
  for (const dark of [false, true]) {
    await whimsySetScheme(dark);
    for (const width of [380, 320]) {
      window.resizeTo(width == 320 ? 900 : 1400, 900);
      await TestUtils.waitForCondition(() => width == 320 ? window.innerWidth <= 900 : window.innerWidth >= 1300, "The window reached its requested width");
      await SpecialPowers.pushPrefEnv({ set: [["whimsy.chat.width", width]] });
      for (const peeking of [false, true]) {
        if (peeking) {
          await peek();
        } else {
          await chat().open();
          await settle();
        }
        const panel = chat().panel.getBoundingClientRect();
        const content = gBrowser.selectedBrowser.closest(".browserSidebarContainer").getBoundingClientRect();
        const frame = root.getBoundingClientRect();
        const gap = parseFloat(getComputedStyle(root).getPropertyValue("--zen-element-separation"));
        Assert.lessOrEqual(Math.abs(frame.right - panel.right - gap), 1, "The right gap matches the standard content gap");
        Assert.lessOrEqual(Math.abs(panel.top - frame.top - gap), 1, "The top gap matches the standard content gap");
        Assert.lessOrEqual(Math.abs(content.top - panel.top), 1, "Chat and the web content card share their top gap");
        Assert.lessOrEqual(Math.abs(frame.bottom - panel.bottom - gap), 1, "The bottom gap matches too");
        is(Math.round(panel.width), width, "The card retains its requested width");
        await whimsyShot(`w24-chat-hover-${peeking ? "peek" : "docked"}-${width}-${dark ? "dark" : "light"}`);
        await closeChat();
      }
      await SpecialPowers.popPrefEnv();
    }
    await SpecialPowers.popPrefEnv();
  }
});
