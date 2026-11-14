/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// W27: Press Esc twice to leave full screen (whimsy.fullscreen.double-escape,
// whimsy-PresShell-cpp.patch, WhimsyFullscreenEscape.sys.mjs).

const PAGE =
  getRootDirectory(gTestPath).replace("chrome://mochitests/content", "https://example.com") +
  "whimsy_double_escape.html";
const PREF = "whimsy.fullscreen.double-escape";

add_setup(async function () {
  await SpecialPowers.pushPrefEnv({
    set: [
      ["full-screen-api.transition-duration.enter", "0 0"],
      ["full-screen-api.transition-duration.leave", "0 0"],
      ["full-screen-api.allow-trusted-requests-only", false],
      // The notice shows (a timeout of 0 turns it off) and doesn't hide
      // before the test reads it.
      ["full-screen-api.warning.timeout", 60000],
      ["full-screen-api.warning.delay", 0],
    ],
  });
});

async function openPage() {
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE);
  const browser = tab.linkedBrowser;
  await SimpleTest.promiseFocus(browser);
  await SpecialPowers.spawn(browser, [], () =>
    ContentTaskUtils.waitForCondition(
      () => content.browsingContext.isActive && content.document.hasFocus(),
      "The page is active"
    )
  );
  return tab;
}

function pageState(browser) {
  return SpecialPowers.spawn(browser, [], () => ({
    fullscreen: !!content.document.fullscreenElement,
    escapeDowns: content.wrappedJSObject.escapeDowns,
    fullscreenChanges: content.wrappedJSObject.fullscreenChanges,
  }));
}

async function enterFullscreen(browser) {
  const entered = BrowserTestUtils.waitForEvent(window, "MozDOMFullscreen:Entered");
  await SpecialPowers.spawn(browser, [], async () => {
    const changed = new Promise(resolve =>
      content.document.addEventListener("fullscreenchange", resolve, { once: true })
    );
    content.document.getElementById("player").requestFullscreen();
    await changed;
  });
  await entered;
  ok(document.fullscreenElement, "The window is in the page's full screen");
  await SimpleTest.promiseFocus(browser);
}

async function waitForExit(browser) {
  await TestUtils.waitForCondition(() => !document.fullscreenElement, "The window left full screen");
  await SpecialPowers.spawn(browser, [], () =>
    ContentTaskUtils.waitForCondition(() => !content.document.fullscreenElement, "The page left full screen")
  );
}

// Lets anything an Esc queued (an exit runs from a runnable) happen: two
// frames in the chrome, then a round trip to the page.
async function settle(browser) {
  await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
  await SpecialPowers.spawn(browser, [], () => new Promise(r => content.requestAnimationFrame(r)));
}

add_task(async function setting_off_one_escape_exits() {
  await SpecialPowers.pushPrefEnv({ set: [[PREF, false]] });
  is(Services.prefs.getDefaultBranch("").getBoolPref(PREF), false, "The setting is off by default");
  const tab = await openPage();
  const browser = tab.linkedBrowser;
  await enterFullscreen(browser);

  EventUtils.synthesizeKey("KEY_Escape");
  await waitForExit(browser);
  const state = await pageState(browser);
  is(state.escapeDowns, 0, "As in Firefox, the page doesn't see the Esc that leaves full screen");
  is(state.fullscreenChanges, 2, "One Esc left full screen");
  isnot(
    document.getElementById("fullscreen-exit-button").getAttribute("data-l10n-id"),
    "whimsy-fullscreen-press-esc-again",
    "No \"press Esc again\" notice"
  );

  BrowserTestUtils.removeTab(tab);
  await SpecialPowers.popPrefEnv();
});

add_task(async function setting_on_two_escapes_exit() {
  await SpecialPowers.pushPrefEnv({ set: [[PREF, true]] });
  const tab = await openPage();
  const browser = tab.linkedBrowser;
  await enterFullscreen(browser);

  const warning = document.getElementById("fullscreen-warning");
  const button = document.getElementById("fullscreen-exit-button");

  info("First Esc: the page gets it and full screen stays");
  EventUtils.synthesizeKey("KEY_Escape");
  await SpecialPowers.spawn(browser, [], () =>
    ContentTaskUtils.waitForCondition(() => content.wrappedJSObject.escapeDowns == 1, "The page saw the first Esc")
  );
  await TestUtils.waitForCondition(
    () => button.getAttribute("data-l10n-id") == "whimsy-fullscreen-press-esc-again",
    "The full-screen notice asks for a second Esc"
  );
  await TestUtils.waitForCondition(
    () => button.textContent.trim() == "Press Esc again to exit full screen",
    "The notice's button is translated"
  );
  ok(warning.hasAttribute("onscreen") && !warning.hidden, "Firefox's full-screen notice is showing");
  await settle(browser);
  ok(document.fullscreenElement, "The window is still full screen after one Esc");
  let state = await pageState(browser);
  ok(state.fullscreen, "The page is still full screen after one Esc");
  is(state.fullscreenChanges, 1, "No full-screen change after one Esc");
  await whimsyShot("w27-dblesc-hint");

  info("Second Esc: full screen ends");
  EventUtils.synthesizeKey("KEY_Escape");
  await waitForExit(browser);
  state = await pageState(browser);
  is(state.escapeDowns, 1, "The page saw only the first Esc, as Firefox keeps the one that exits");
  is(state.fullscreenChanges, 2, "Two Escs left full screen");

  info("The pair is used up: the next full screen starts over");
  await enterFullscreen(browser);
  EventUtils.synthesizeKey("KEY_Escape");
  await SpecialPowers.spawn(browser, [], () =>
    ContentTaskUtils.waitForCondition(() => content.wrappedJSObject.escapeDowns == 2, "The page saw the new first Esc")
  );
  await settle(browser);
  ok(document.fullscreenElement, "A new full screen needs two Escs again");
  EventUtils.synthesizeKey("KEY_Escape");
  await waitForExit(browser);

  BrowserTestUtils.removeTab(tab);
  await SpecialPowers.popPrefEnv();
});

add_task(async function settings_row() {
  is(Services.prefs.getBoolPref(PREF), false, "The setting starts off");
  await whimsyBothSchemes("w27-dblesc-setting", async () => {
    const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, "about:preferences#zenLooks");
    const doc = tab.linkedBrowser.contentDocument;
    const box = await TestUtils.waitForCondition(() => doc.getElementById("whimsyDoubleEscape"), "The row is in Settings");
    const group = doc.getElementById("whimsyLookGroup");
    ok(group.contains(box), "It sits in Look and Feel's Look group");
    is(box.localName, "checkbox", "It is a checkbox like the rows around it");
    is(box.previousElementSibling.id, "whimsyFindCard", "It follows the Find card row");
    await TestUtils.waitForCondition(() => box.label == "Press Esc twice to leave full screen", "The label is translated");
    ok(!box.checked, "Unchecked while the setting is off");
    box.scrollIntoView({ block: "center" });
    return () => BrowserTestUtils.removeTab(tab);
  });

  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, "about:preferences#zenLooks");
  const doc = tab.linkedBrowser.contentDocument;
  const box = await TestUtils.waitForCondition(() => doc.getElementById("whimsyDoubleEscape"), "The row is in Settings");
  box.scrollIntoView({ block: "center" });
  await TestUtils.waitForCondition(() => box.getBoundingClientRect().height > 0, "The row is laid out");
  EventUtils.synthesizeMouseAtCenter(box, {}, tab.linkedBrowser.contentWindow);
  await TestUtils.waitForCondition(() => Services.prefs.getBoolPref(PREF), "Checking it turns the setting on");
  EventUtils.synthesizeMouseAtCenter(box, {}, tab.linkedBrowser.contentWindow);
  await TestUtils.waitForCondition(() => !Services.prefs.getBoolPref(PREF), "Unchecking it turns the setting off");
  BrowserTestUtils.removeTab(tab);
  Services.prefs.clearUserPref(PREF);
});
