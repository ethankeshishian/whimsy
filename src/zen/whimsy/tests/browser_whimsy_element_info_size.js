/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// W13 F10 (r1 item 11): Element Info is a fixed 392px wide and as
// tall as what it shows: no scrollbar when it fits; in a short window only
// its body scrolls and the header stays. Picking another element keeps the
// card and its width, and its height eases to the new content (160ms). Its
// header drags it (F07). Element Info is a command with an assignable key.

const { WhimsyInspector } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyInspector.sys.mjs");
const { WhimsyCommands } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyCommands.sys.mjs");
const { WhimsySurface } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsySurface.sys.mjs");

const PAGE = "https://example.com/document-builder.sjs?html=" + encodeURIComponent(`
  <html><body style="margin:0">
    <div id="card" class="card" style="margin:16px;border:1px solid #000;padding:12px;width:320px;height:88px;color:#1d1b26;background:#fff;font:500 15px/24px sans-serif">Card text</div>
    <img id="pic" style="display:block;width:40px;height:40px;background:#eee">
  </body></html>
`);

registerCleanupFunction(() => WhimsySurface.forgetDragPositions());

const panelOf = win => win.document.getElementById("whimsy-element-inspector-panel");

async function inspect(win, selector) {
  await WhimsyInspector.inspectElementBySelector(win, selector);
  const panel = await TestUtils.waitForCondition(() => {
    const p = panelOf(win);
    return p?.state == "open" && p.querySelector(".whimsy-element-tag")?.title.includes(selector.slice(1)) ? p : null;
  }, `Element Info for ${selector}`);
  await TestUtils.waitForTick();
  return panel;
}

async function close(panel) {
  const hidden = BrowserTestUtils.waitForPopupEvent(panel, "hidden");
  panel.hidePopup();
  await hidden;
}

add_task(async function test_hugs_content_at_fixed_width() {
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE);
  const panel = await inspect(window, "#card");
  const card = panel.querySelector(".whimsy-surface-view");
  const body = panel.querySelector(".whimsy-element-body");
  // 392px minus the panel's 10px padding and 1px border on each side
  // (popup.css's ::part(content), box-sizing: border-box).
  Assert.less(Math.abs(card.getBoundingClientRect().width - (392 - 2 * 10 - 2 * 1)), 1.5, "392px wide");
  ok(body.scrollHeight <= body.clientHeight + 1, "Everything fits: no scrollbar");
  is(getComputedStyle(body).overflowY, "auto", "The body would scroll, if it had to");
  const header = panel.querySelector(".whimsy-surface-header");
  is(header.querySelector(".whimsy-element-tag").textContent, "div#card", "div#card, in the header");
  is(getComputedStyle(header.querySelector(".whimsy-element-tag")).fontWeight, "600", "Semibold");
  ok(header.querySelector(".whimsy-surface-grip") && header.classList.contains("whimsy-surface-drag-handle"), "The header drags it");
  await TestUtils.waitForCondition(() => panel.querySelector('[data-fact="font"] .v')?.textContent.includes("15/24 · 500"),
    "Font as size/line height · weight");

  // A real click on a colour row copies its value.
  const text = panel.querySelector('[data-color="text"]');
  await SimpleTest.promiseClipboardChange("#1D1B26", () => EventUtils.synthesizeMouseAtCenter(text, {}));

  // Another element: same card, same width, the height eases to it.
  const width = card.getBoundingClientRect().width;
  const before = card.getBoundingClientRect().height;
  const same = await inspect(window, "#pic");
  is(same, panel, "The same card");
  const animation = card.getAnimations().find(a => a.id == "whimsy-element-info-height");
  ok(animation, "The height eases to the new content");
  is(animation.effect.getTiming().duration, 160, "…over 160ms");
  await animation.finished;
  is(card.getBoundingClientRect().width, width, "The width never changes");
  isnot(card.getBoundingClientRect().height, before, "The height follows its content");
  ok(body.scrollHeight <= body.clientHeight + 1, "Still no scrollbar");
  await close(panel);
  BrowserTestUtils.removeTab(tab);
});

add_task(async function test_short_window_scrolls_only_the_body() {
  // Zen's browser windows have a 495px minimum height (zen-theme.css), so a
  // short window only exists as a popup a page opened (window.open with
  // "popup"), which that minimum doesn't apply to (W13 F03's cheat sheet
  // test uses the same trick).
  const startTabs = new Set(gBrowser.tabs);
  const opener = await BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE);
  const opened = BrowserTestUtils.waitForNewWindow({ url: PAGE });
  await SpecialPowers.spawn(opener.linkedBrowser, [PAGE], url => {
    content.window.open(url, "_blank", "popup,width=900,height=360");
  });
  const win = await opened;
  try {
    ok(win.document.documentElement.hasAttribute("popup-window"), "A popup window");
    win.resizeTo(900, 360);
    await TestUtils.waitForCondition(() => Math.abs(win.outerHeight - 360) < 40, "A short window");
    const panel = await inspect(win, "#card");
    const header = panel.querySelector(".whimsy-surface-header");
    const body = panel.querySelector(".whimsy-element-body");
    Assert.greater(body.scrollHeight, body.clientHeight, "Too tall for the window: the body scrolls");
    const top = header.getBoundingClientRect().top;
    body.scrollTop = body.scrollHeight;
    await TestUtils.waitForTick();
    is(header.getBoundingClientRect().top, top, "The header stays put");
    ok(header.checkVisibility(), "…and in view");
    await close(panel);
  } finally {
    await BrowserTestUtils.closeWindow(win);
    for (const tab of gBrowser.tabs.filter(t => !startTabs.has(t))) {
      BrowserTestUtils.removeTab(tab);
    }
  }
});

add_task(function test_command() {
  const entry = WhimsyCommands.get("cmd_whimsyInspectElement");
  ok(entry?.keyId && document.getElementById(entry.keyId), "Element Info has a key Settings can bind");
});
