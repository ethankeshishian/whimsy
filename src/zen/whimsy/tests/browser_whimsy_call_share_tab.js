/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// W29: Call Options › Share this tab, and Share This Tab in Call. Whimsy
// presses the web call's own share button; Firefox's sharing prompt opens
// on the tab you're looking at, that tab picked in its list; Allow stays
// yours to click; Stop sharing works from any tab.
// Design: whimsy-handoff/intake-w29/designs/share-a-tab.md.

const { WhimsyCallPip } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyCallPip.sys.mjs");
const { WhimsyCallOptionsPanel } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyCallOptionsPanel.sys.mjs");
const { WhimsyShareTab } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyShareTab.sys.mjs");
const { SitePermissions } = ChromeUtils.importESModule("resource:///modules/SitePermissions.sys.mjs");
const { globalActions } = ChromeUtils.importESModule("resource:///modules/ZenUBGlobalActions.sys.mjs");

const ORIGIN = "https://example.com";
const DIR = getRootDirectory(gTestPath).replace("chrome://mochitests/content", ORIGIN);
const PAGE = DIR + "whimsy_call_share.html";
const DOC_TITLE = "Quarterly plan";
const DOC = `data:text/html,<title>${DOC_TITLE}</title><p>The plan</p>`;
const SHARE_COMMAND = "whimsy-action-call-share-tab";

add_setup(async function () {
  const principal = Services.scriptSecurityManager.createContentPrincipalFromOrigin(ORIGIN);
  SitePermissions.setForPrincipal(principal, "camera", SitePermissions.ALLOW);
  registerCleanupFunction(() => SitePermissions.removeFromPrincipal(principal, "camera"));
  await SpecialPowers.pushPrefEnv({
    set: [
      ["media.navigator.streams.fake", true],
      ["media.navigator.permission.fake", true],
      ["media.audio_loopback_dev", ""],
      ["media.video_loopback_dev", ""],
      ["media.getusermedia.window.focus_source.enabled", false],
      ["media.autoplay.default", 0],
      ["media.autoplay.blocking_policy", 0],
      // Leaving the call doesn't float it: these tests open Call Options
      // from the main window.
      ["whimsy.feature.call-pip", false],
    ],
  });
});

function shareAction() {
  return globalActions.find(a => a.l10nId == SHARE_COMMAND);
}

let sharedCall = null;
async function openCall() {
  if (sharedCall) {
    return sharedCall;
  }
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE);
  await SpecialPowers.spawn(tab.linkedBrowser, [], () => content.wrappedJSObject.startCall());
  await TestUtils.waitForCondition(() => WhimsyCallPip.isInCall(tab), "The tab is in a call");
  await TestUtils.waitForCondition(() => WhimsyCallPip.shareAvailable(tab.linkedBrowser), "Whimsy found the call's share button");
  sharedCall = tab;
  registerCleanupFunction(async () => {
    await SpecialPowers.spawn(tab.linkedBrowser, [], () => content.wrappedJSObject.endCall());
    await TestUtils.waitForCondition(() => !WhimsyCallPip.isInCall(tab), "The call ended");
    BrowserTestUtils.removeTab(tab);
  });
  return tab;
}

function page(tab, fn, ...args) {
  return SpecialPowers.spawn(tab.linkedBrowser, [fn, args], (name, list) => content.wrappedJSObject[name](...list));
}

async function openPanel(browser) {
  const shown = BrowserTestUtils.waitForEvent(window, "popupshown", false, e => e.target.id == "whimsy-call-options-panel");
  const { panel } = WhimsyCallOptionsPanel.open(window, browser);
  await shown;
  await whimsySettled();
  return panel;
}

async function closePanel(panel) {
  if (panel.state == "open") {
    const hidden = BrowserTestUtils.waitForEvent(panel, "popuphidden");
    panel.hidePopup();
    await hidden;
  }
}

function shareRow(panel) {
  return panel.querySelector("#whimsy-call-options-share");
}

async function rowText(panel) {
  const row = shareRow(panel);
  const label = row.querySelector(".whimsy-surface-row-label");
  const detail = row.querySelector(".whimsy-surface-row-detail");
  await document.l10n.translateElements([label, detail]);
  // Fluent isolates each placeable (U+2068 … U+2069).
  const plain = text => text.replace(/[\u2068\u2069]/g, "");
  return { label: plain(label.textContent), detail: detail.hidden ? null : plain(detail.textContent) };
}

function shareNotification(browser) {
  return PopupNotifications.getNotification("webRTC-shareDevices", browser);
}

// Colours composited the way they show: every background from the root
// down, then the text on top.
function shownRGB(win, el, color) {
  const chain = [];
  for (let node = el; node && node.nodeType == 1; node = node.parentElement) {
    chain.unshift(win.getComputedStyle(node).backgroundColor);
  }
  const canvas = win.document.createElementNS("http://www.w3.org/1999/xhtml", "canvas");
  canvas.width = canvas.height = 1;
  const ctx = canvas.getContext("2d");
  const paint = value => {
    ctx.fillStyle = value;
    ctx.fillRect(0, 0, 1, 1);
    return [...ctx.getImageData(0, 0, 1, 1).data.slice(0, 3)];
  };
  paint(win.getComputedStyle(win.document.documentElement).backgroundColor || "white");
  let bg = null;
  for (const value of chain) {
    bg = paint(value);
  }
  return { bg, fg: paint(color) };
}
function contrast(a, b) {
  const lum = ([r, g, b2]) => {
    const lin = c => ((c /= 255) <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
    return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b2);
  };
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

// findShare, one general rule, on call bars shaped like Meet's, Zoom's,
// and Teams' web clients; never a link share, a stop control, or someone
// else's button.
add_task(async function test_find_share_general() {
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, DIR + "whimsy_call_share.html");
  try {
    const found = await SpecialPowers.spawn(tab.linkedBrowser, [], () => {
      const { WhimsyCallControls } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyCallControls.sys.mjs");
      const doc = content.document;
      const bars = {
        meet: `<a><button aria-label="Share link">x</button></a>
          <div class="bar"><button data-is-muted="false" aria-label="Turn off microphone (⌘ + d)">m</button>
          <button data-is-muted="false" aria-label="Turn off camera (⌘ + e)">c</button>
          <button id="want" aria-label="Share screen"><i>present_to_all</i></button></div>`,
        zoom: `<div class="bar"><button aria-pressed="false" aria-label="mute my microphone">m</button>
          <button aria-pressed="false" aria-label="stop my video">c</button>
          <div><button id="want" aria-label="Share Screen">Share</button></div></div>`,
        teams: `<button>Share</button>
          <div class="bar"><button aria-pressed="false" aria-label="Mute">m</button>
          <button aria-pressed="false" aria-label="Turn camera off">c</button>
          <button id="want" title="Share content">Share</button></div>`,
        bare: `<button>Share</button>
          <div class="bar"><button data-is-muted="false" aria-label="Turn off microphone">m</button>
          <button data-is-muted="false" aria-label="Turn off camera">c</button>
          <button id="want">Present</button></div>`,
        stop: `<div class="bar"><button data-is-muted="false" aria-label="Turn off microphone">m</button>
          <button data-is-muted="false" aria-label="Turn off camera">c</button>
          <button aria-label="Stop presenting">x</button>
          <button aria-label="Share screen" disabled>y</button></div>
          <div role="listitem"><button aria-label="Share screen">z</button></div>`,
        french: `<div class="bar"><button data-is-muted="false" aria-label="Désactiver le micro">m</button>
          <button data-is-muted="false" aria-label="Désactiver la caméra">c</button>
          <button id="want" aria-label="Partager l'écran">p</button></div>`,
      };
      const result = {};
      for (const [name, html] of Object.entries(bars)) {
        doc.body.innerHTML = html;
        const el = WhimsyCallControls.findShare(doc);
        result[name] = el ? el.id || "other" : null;
      }
      return result;
    });
    Assert.deepEqual(
      found,
      { meet: "want", zoom: "want", teams: "want", bare: "want", stop: null, french: "want" },
      "The call bar's own share button in each, and none where there is only a stop, a disabled, or someone else's"
    );
  } finally {
    BrowserTestUtils.removeTab(tab);
  }
});

// The row and the command are there only for a call; the row is
// disabled, saying why, when the call page has no share button.
add_task(async function test_only_on_a_call() {
  const plain = await BrowserTestUtils.openNewForegroundTab(gBrowser, DOC);
  try {
    ok(shareAction(), "Share This Tab in Call is a command");
    ok(!shareAction().isAvailable(window), "With no call, the command isn't offered");
    ok(!WhimsyCallPip._calls.has(plain.linkedBrowser), "A plain tab has no Call Options");

    const call = await openCall();
    await BrowserTestUtils.switchTab(gBrowser, plain);
    ok(shareAction().isAvailable(window), "With a call, the command is offered from any tab");

    let panel = await openPanel(call.linkedBrowser);
    const row = shareRow(panel);
    ok(row, "Call Options has the Share row");
    const caption = row.closest(".whimsy-surface-group").previousElementSibling;
    await document.l10n.translateElements([caption.querySelector(".whimsy-surface-caption-label")]);
    is(caption.textContent.trim(), "Share", "Under the caption Share");
    Assert.deepEqual(await rowText(panel), { label: "Share this tab", detail: DOC_TITLE }, "Share this tab, with the tab's title");
    is(row.getAttribute("role"), "button", "The row is a button");
    ok(!row.hasAttribute("aria-disabled"), "It's enabled");
    const label = row.querySelector(".whimsy-surface-row-label");
    const detail = row.querySelector(".whimsy-surface-row-detail");
    for (const el of [label, detail]) {
      ok(el.scrollWidth <= el.clientWidth + 1, `${el.className} isn't clipped`);
    }

    // Contrast and screenshots, light and dark.
    for (const dark of [false, true]) {
      await whimsySetScheme(dark);
      try {
        await whimsySettled();
        for (const el of [label, detail]) {
          const { bg, fg } = shownRGB(window, el, getComputedStyle(el).color);
          const ratio = contrast(fg, bg);
          Assert.greaterOrEqual(ratio, 4.5, `${el.className} meets WCAG AA in ${dark ? "dark" : "light"} (${ratio.toFixed(2)}:1)`);
        }
        await whimsyShot(`w29-share-tab-row-${dark ? "dark" : "light"}`);
      } finally {
        await SpecialPowers.popPrefEnv();
      }
    }

    // No share button on the page: the row dims and says why.
    await page(call, "setShare", false);
    await TestUtils.waitForCondition(() => !WhimsyCallPip.shareAvailable(call.linkedBrowser), "The share button went away");
    is(row.getAttribute("aria-disabled"), "true", "The row is disabled");
    ok(row.classList.contains("whimsy-call-options-dim"), "and dim");
    Assert.deepEqual(
      await rowText(panel),
      { label: "Share this tab", detail: "Whimsy Call's share button wasn't found" },
      "It says the call's share button wasn't found"
    );
    ok(!shareAction().isAvailable(window), "The command isn't offered either");
    await whimsyBothSchemes("w29-share-tab-missing", () => null);
    EventUtils.synthesizeMouseAtCenter(row, {}, window);
    is(panel.state, "open", "Clicking it does nothing");
    is((await page(call, "shareState")).shares, 0, "The page wasn't pressed");
    await closePanel(panel);
    await page(call, "setShare", true);
    await TestUtils.waitForCondition(() => WhimsyCallPip.shareAvailable(call.linkedBrowser), "The share button is back");
  } finally {
    BrowserTestUtils.removeTab(plain);
  }
});

// Share this tab from another tab: the call's own button is pressed, the
// prompt opens on this tab with this tab picked, and nothing is shared
// until Allow is clicked. Then Stop sharing, from a third tab, ends it.
add_task(async function test_share_prompt_and_stop() {
  is(WhimsyShareTab.promptBrowser(gBrowser.selectedBrowser, { sharingScreen: true, callID: "none" }), null,
    "With no share pending, Firefox's prompt stays where it asked");
  const call = await openCall();
  const doc = await BrowserTestUtils.openNewForegroundTab(gBrowser, DOC);
  const third = BrowserTestUtils.addTab(gBrowser, "about:blank");
  try {
    let panel = await openPanel(call.linkedBrowser);
    const shown = BrowserTestUtils.waitForEvent(PopupNotifications.panel, "popupshown");
    EventUtils.synthesizeMouseAtCenter(shareRow(panel), {}, window);
    await shown;
    is(panel.state, "closed", "Call Options closed");
    is((await page(call, "shareState")).shares, 1, "The call page's share button was pressed once");

    const notification = shareNotification(doc.linkedBrowser);
    ok(notification, "Firefox's prompt is on the tab to share");
    ok(!shareNotification(call.linkedBrowser), "not on the call's tab");
    is(gBrowser.selectedTab, doc, "You never left the tab");
    const list = document.getElementById("webRTC-selectWindow-menulist");
    const types = [...list.menupopup.children].map(item => item.getAttribute("devicetype")).filter(Boolean);
    info(`The prompt lists: ${types.join(", ")}`);
    const item = list.selectedItem;
    is(item?.mediaSource, "browser", "A tab is picked");
    is(String(item?.deviceId), String(doc.linkedBrowser.browserId), "This tab");
    is(item?.label, DOC_TITLE, "listed by its title");
    const element = PopupNotifications.panel.firstElementChild;
    ok(!element.hasAttribute("invalidselection"), "Allow can be clicked");
    ok(!element.button.disabled, "Allow is enabled");
    const state = await page(call, "shareState");
    is(state.result, null, "Nothing is shared before Allow");
    ok(!WhimsyShareTab.isSharing(call.linkedBrowser), "The call isn't sharing");
    await whimsyShot("w29-share-tab-prompt");

    const hidden = BrowserTestUtils.waitForEvent(PopupNotifications.panel, "popuphidden");
    EventUtils.synthesizeMouseAtCenter(element.button, {}, window);
    await hidden;
    await TestUtils.waitForCondition(async () => (await page(call, "shareState")).result == "shared", "The page has the tab's stream");
    await TestUtils.waitForCondition(() => WhimsyShareTab.isSharing(call.linkedBrowser), "The call is sharing");
    is(WhimsyShareTab.sharedTitle(call.linkedBrowser), DOC_TITLE, "It shares the doc");

    // Stop from a third tab.
    await BrowserTestUtils.switchTab(gBrowser, third);
    panel = await openPanel(call.linkedBrowser);
    Assert.deepEqual(await rowText(panel), { label: "Stop sharing", detail: `Sharing ${DOC_TITLE}` }, "The row reads Stop sharing");
    await whimsyBothSchemes("w29-share-tab-stop", () => null);
    EventUtils.synthesizeMouseAtCenter(shareRow(panel), {}, window);
    await TestUtils.waitForCondition(() => !WhimsyShareTab.isSharing(call.linkedBrowser), "Sharing stopped");
    await TestUtils.waitForCondition(async () => !(await page(call, "shareState")).live, "The page's shared track ended");
    ok(WhimsyCallPip.isInCall(call), "The call itself goes on");
    is(panel.state, "closed", "Call Options closed");
  } finally {
    BrowserTestUtils.removeTab(third);
    BrowserTestUtils.removeTab(doc);
  }
});

// The command does what the row does, for the selected tab; the prompt
// after a Not now goes back to Firefox's own placement.
add_task(async function test_command_and_not_now() {
  const call = await openCall();
  const doc = await BrowserTestUtils.openNewForegroundTab(gBrowser, DOC);
  try {
    const before = (await page(call, "shareState")).shares;
    const shown = BrowserTestUtils.waitForEvent(PopupNotifications.panel, "popupshown");
    document.getElementById("cmd_whimsyCallShareTab").doCommand();
    await shown;
    is((await page(call, "shareState")).shares, before + 1, "The command pressed the call's share button");
    ok(shareNotification(doc.linkedBrowser), "The prompt is on the selected tab");
    is(String(document.getElementById("webRTC-selectWindow-menulist").selectedItem?.deviceId),
      String(doc.linkedBrowser.browserId), "with it picked");

    // Not now: the page is told no, and nothing is left pending.
    const hidden = BrowserTestUtils.waitForEvent(PopupNotifications.panel, "popuphidden");
    EventUtils.synthesizeMouseAtCenter(PopupNotifications.panel.firstElementChild.secondaryButton, {}, window);
    await hidden;
    await TestUtils.waitForCondition(async () => (await page(call, "shareState")).result == "NotAllowedError", "The page was told no");
    ok(!WhimsyShareTab.isSharing(call.linkedBrowser), "Nothing is shared");
    ok(!WhimsyShareTab._pending.has(call.linkedBrowser), "No share is left pending");
  } finally {
    BrowserTestUtils.removeTab(doc);
  }
});
