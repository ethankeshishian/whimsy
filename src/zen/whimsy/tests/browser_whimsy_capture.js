/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// Capture: Arc's Cmd+Shift+2 opens Firefox Screenshots, and Copy Full-Page
// Screenshot (Cmd+Shift+1, command bar) puts the whole page on the
// clipboard in one step.

const TALL = "https://example.com/document-builder.sjs?html=" + encodeURIComponent("<body style='margin:0'><div style='height:4000px;background:linear-gradient(red,blue)'>Tall</div></body>");
const { WhimsyPage } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyPage.sys.mjs");

function clipboardHasImage() {
  return Services.clipboard.hasDataMatchingFlavors(["image/png", "image/jpeg", "application/x-moz-nativeimage"], Services.clipboard.kGlobalClipboard);
}

add_task(async function test_keys() {
  const arc = document.getElementById("key_whimsyScreenshotArc");
  ok(arc, "Cmd+Shift+2 exists");
  is(arc.getAttribute("command"), "Browser:Screenshot", "and opens Screenshots");
  const full = document.getElementById("key_whimsyCopyFullPage");
  is(full.getAttribute("command"), "cmd_whimsyCopyFullPage", "Cmd+Shift+1 copies the full page");
  is(full.getAttribute("keycode"), "VK_1", "Cmd+Shift+1 is bound by keycode, like Cmd+Shift+2");
  is(full.getAttribute("modifiers"), "accel,shift", "...with Cmd+Shift");
  is(arc.getAttribute("keycode"), "VK_2", "Cmd+Shift+2 is bound by keycode (key=\"2\" never matches with Shift)");
  const mods = k => (k.getAttribute("modifiers") || "").replace("accel", "meta").split(/[ ,]+/).filter(Boolean).sort().join();
  const vkClash = [...document.querySelectorAll("key")].filter(
    k => k != arc && k.getAttribute("disabled") != "true" && k.getAttribute("keycode") == "VK_2" && mods(k) == mods(arc)
  );
  Assert.deepEqual(vkClash.map(k => k.id), [], "Cmd+Shift+2 doesn't clash");
  // Nothing in Zen or Firefox uses Cmd+Shift+1 (by keycode, or as key="1"/"!").
  const oneClash = [...document.querySelectorAll("key")].filter(
    k =>
      k != full &&
      k.getAttribute("disabled") != "true" &&
      mods(k) == mods(full) &&
      (k.getAttribute("keycode") == "VK_1" || ["1", "!"].includes(k.getAttribute("key")))
  );
  Assert.deepEqual(oneClash.map(k => k.id), [], "Cmd+Shift+1 doesn't clash");
});

add_task(async function test_copy_full_page() {
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, TALL);
  const viewport = await SpecialPowers.spawn(tab.linkedBrowser, [], () => content.innerHeight);
  SpecialPowers.clipboardCopyString("not an image");
  ok(!clipboardHasImage(), "The clipboard starts with text");
  const size = await WhimsyPage.copyFullPageScreenshot(window);
  ok(size && size.height >= 4000 && size.height > viewport, `The whole page was captured (${size?.height}px, viewport ${viewport}px)`);
  ok(clipboardHasImage(), "The clipboard holds the image");

  // The shortcut does the same.
  SpecialPowers.clipboardCopyString("text again");
  tab.linkedBrowser.focus();
  EventUtils.synthesizeKey("!", { accelKey: true, shiftKey: true, code: "Digit1", keyCode: KeyEvent.DOM_VK_1 });
  await TestUtils.waitForCondition(clipboardHasImage, "Cmd+Shift+1 copies it too");
  BrowserTestUtils.removeTab(tab);
});

add_task(async function test_command_bar_and_empty() {
  const { globalActions } = ChromeUtils.importESModule("resource:///modules/ZenUBGlobalActions.sys.mjs");
  const action = globalActions.find(a => a.l10nId == "whimsy-action-copy-full-page");
  ok(action, "The command bar has Copy Full-Page Screenshot");
  is(action.label, "Copy Full-Page Screenshot", "labelled");
  const blank = await BrowserTestUtils.openNewForegroundTab(gBrowser, "about:blank");
  ok(!action.isAvailable(window), "Not offered on a blank tab");
  is(await WhimsyPage.copyFullPageScreenshot(window), null, "and does nothing there");
  BrowserTestUtils.removeTab(blank);
  await SpecialPowers.pushPrefEnv({ set: [["whimsy.feature.capture", false]] });
  ok(!action.isAvailable(window), "The switch hides it");
  await SpecialPowers.popPrefEnv();
});

// Pressing Cmd+Shift+2 really runs Screenshots (the command is stopped here
// so the Screenshots UI doesn't open in the test).
add_task(async function test_cmd_shift_2_opens_screenshots() {
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.com/");
  const command = document.getElementById("Browser:Screenshot");
  let fired = 0;
  const stop = event => {
    fired++;
    event.stopImmediatePropagation();
  };
  command.addEventListener("command", stop, true);
  tab.linkedBrowser.focus();
  // What a US layout sends: the shifted character "@", keyCode 2.
  EventUtils.synthesizeKey("@", { accelKey: true, shiftKey: true, code: "Digit2", keyCode: KeyEvent.DOM_VK_2 });
  await TestUtils.waitForCondition(() => fired > 0, "Cmd+Shift+2 runs Browser:Screenshot");
  command.removeEventListener("command", stop, true);
  BrowserTestUtils.removeTab(tab);
});
