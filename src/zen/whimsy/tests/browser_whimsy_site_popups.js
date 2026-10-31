/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// wave9/mini W8-23, the normal-window path (the user's case): a page in an
// ordinary Whimsy window calls window.open(url, name, "width=…,height=…")
// ("Continue with Google"). Firefox makes that a popup window. It must get
// Firefox's minimal popup chrome, not Mini's or a full window's: the
// read-only address bar with its identity (the security indicator), no
// sidebar, no Mini bar, the size the page asked for. It stays attached to
// its opener (window.opener, postMessage, window.close), and Whimsy's
// window extras (season toast, teaching hints, meeting card, Claude's
// target window, Archive) leave it alone. A screenshot is taken for the
// build lane to look at.

const { WhimsyQuickWindow } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyQuickWindow.sys.mjs");
const { WhimsySeasonToast } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsySeasonToast.sys.mjs");
const { WhimsyTeach } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyTeach.sys.mjs");
const { WhimsyClaude } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyClaude.sys.mjs");
const { WhimsyArchive } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyArchive.sys.mjs");

const ROOT = getRootDirectory(gTestPath).replace("chrome://mochitests/content", "https://example.com");
const OPENER = ROOT + "whimsy_oauth_opener.html";
const POPUP = ROOT + "whimsy_oauth_popup.html";

add_setup(async function () {
  await SpecialPowers.pushPrefEnv({ set: [["browser.link.open_newwindow.restriction", 2]] });
});

add_task(async function test_sign_in_popup_from_a_normal_window() {
  await BrowserTestUtils.withNewTab(OPENER, async browser => {
    await SpecialPowers.spawn(browser, [], () =>
      ContentTaskUtils.waitForCondition(() => content.document.readyState == "complete", "Page complete"));
    const minis = WhimsyQuickWindow.windows().length;
    const opened = BrowserTestUtils.waitForNewWindow({ url: POPUP });
    await BrowserTestUtils.synthesizeMouseAtCenter("#continue", {}, browser);
    const popup = await opened;
    const doc = popup.document;
    const root = doc.documentElement;

    // A real popup, attached to its opener.
    ok(!popup.toolbar.visible, "Firefox's popup window");
    ok(root.hasAttribute("popup-window"), "...styled as one");
    ok(!popup._whimsyQuickWindow && !root.hasAttribute("whimsy-quick-window"), "Not a Mini Whimsy window");
    ok(!doc.getElementById("whimsy-quick-window-bar"), "No Mini bar");
    is(WhimsyQuickWindow.windows().length, minis, "No Mini opened");
    const popupBrowser = popup.gBrowser.selectedBrowser;
    is(popupBrowser.browsingContext.opener, browser.browsingContext, "Attached to the page that opened it");

    // Firefox's minimal popup chrome: the read-only address with identity
    // (Zen's sidebar, where it normally lives, is collapsed in popups).
    await TestUtils.waitForCondition(() => popup.gURLBar.checkVisibility(), "The address bar shows");
    if (root.hasAttribute("whimsy-site-popup")) {
      is(doc.getElementById("nav-bar").parentElement.id, "zen-appcontent-navbar-container",
        "...in the strip above the page");
    }
    ok(popup.gURLBar.readOnly, "...read-only, as Firefox keeps it in popups");
    await TestUtils.waitForCondition(() => popup.gURLBar.value.includes("example.com"),
      "...showing where the popup is (the security indicator a sign-in needs)");
    ok(doc.getElementById("identity-box")?.checkVisibility(), "The site identity is visible");
    const toolbox = doc.getElementById("navigator-toolbox");
    ok(!toolbox.checkVisibility() || toolbox.getBoundingClientRect().width == 0, "No sidebar in a popup");
    const page = popupBrowser.getBoundingClientRect();
    Assert.greater(page.height, 300, `The page has the room it asked for (${page.width}x${page.height})`);
    Assert.lessOrEqual(Math.abs(popup.innerWidth - 420), 40, `The width the page asked for (${popup.innerWidth})`);

    // Whimsy's window extras stay out of it.
    is(WhimsySeasonToast.pending(popup), null, "No season toast in the popup");
    is(WhimsyTeach._kind(popup), "popup", "No teaching hints in the popup");
    isnot(WhimsyClaude.topWindow(), popup, "Claude never targets the popup");
    is(WhimsyArchive.recordClose(popup, popup.gBrowser.selectedTab), null, "Its tab never goes to Archive");

    await shot("site-popup-sign-in", popup.browsingContext.currentWindowGlobal);

    // The sign-in completes: result to the opener, then the popup closes itself.
    const closed = BrowserTestUtils.domWindowClosed(popup);
    await BrowserTestUtils.synthesizeMouseAtCenter("#account", {}, popupBrowser);
    await closed;
    const token = await SpecialPowers.spawn(browser, [], async () => {
      await ContentTaskUtils.waitForCondition(() => content.document.body.dataset.token, "Result arrived");
      return content.document.body.dataset.token;
    });
    is(token, "signed-in", "The opener received the result through postMessage");
    ok(!WhimsyArchive.storedEntries.some(entry => entry.url == POPUP), "Nothing archived when it closed");
  });
});

add_task(async function test_switch_off_leaves_zens_popup_chrome() {
  await SpecialPowers.pushPrefEnv({ set: [["whimsy.feature.site-popup-chrome", false]] });
  await BrowserTestUtils.withNewTab(OPENER, async browser => {
    await SpecialPowers.spawn(browser, [], () =>
      ContentTaskUtils.waitForCondition(() => content.document.readyState == "complete", "Page complete"));
    const opened = BrowserTestUtils.waitForNewWindow({ url: POPUP });
    await BrowserTestUtils.synthesizeMouseAtCenter("#continue", {}, browser);
    const popup = await opened;
    await new Promise(resolve => popup.requestAnimationFrame(() => popup.requestAnimationFrame(resolve)));
    ok(!popup.document.documentElement.hasAttribute("whimsy-site-popup"), "With the switch off, nothing is moved");
    is(popup.gBrowser.selectedBrowser.browsingContext.opener, browser.browsingContext, "...and the popup is still attached");
    await BrowserTestUtils.closeWindow(popup);
  });
  await SpecialPowers.popPrefEnv();
});

// Same screenshot convention as browser_whimsy_screens.js (WHIMSY_SHOTS).
async function shot(name, windowGlobal) {
  const dir = Services.env.get("WHIMSY_SHOTS");
  if (!dir) {
    return;
  }
  const bitmap = await windowGlobal.drawSnapshot(null, 1, "white");
  const canvas = document.createElementNS("http://www.w3.org/1999/xhtml", "canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  canvas.getContext("2d").drawImage(bitmap, 0, 0);
  const blob = await new Promise(resolve => canvas.toBlob(resolve));
  const path = PathUtils.join(dir, `${name}.png`);
  await IOUtils.write(path, new Uint8Array(await blob.arrayBuffer()));
  info(`Saved ${path}`);
}
