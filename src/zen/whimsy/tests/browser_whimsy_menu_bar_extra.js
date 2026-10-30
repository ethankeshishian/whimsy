/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// Menu bar extra (Arc parity, macOS only): a status bar icon with "New
// Quick Window" and recent tabs, built on nsISystemStatusBar. Covers the
// main flow, the Settings toggle, and that toggling off-then-on recreates
// the element rather than reusing a stale one removeItem already forgot.

const { WhimsyMenuBarExtra } = ChromeUtils.importESModule(
  "resource:///modules/whimsy/WhimsyMenuBarExtra.sys.mjs"
);

add_task(async function test_show_pref_adds_and_removes() {
  await SpecialPowers.pushPrefEnv({
    set: [
      ["whimsy.feature.menu-bar-extra", true],
      ["whimsy.menu-bar-extra.show", true],
    ],
  });
  WhimsyMenuBarExtra.init();
  ok(WhimsyMenuBarExtra.enabled, "enabled with both prefs on");

  await TestUtils.waitForCondition(() => document.getElementById("whimsyMenuBarExtra"), "status item added");
  const first = document.getElementById("whimsyMenuBarExtra");
  ok(first, "menu element exists");
  is(first.localName, "menu", "it's a <menu>, as nsISystemStatusBar expects");

  await SpecialPowers.pushPrefEnv({ set: [["whimsy.menu-bar-extra.show", false]] });
  ok(!WhimsyMenuBarExtra.enabled, "disabled once the setting is off");
  await TestUtils.waitForCondition(() => !document.getElementById("whimsyMenuBarExtra"), "status item removed");

  await SpecialPowers.pushPrefEnv({ set: [["whimsy.menu-bar-extra.show", true]] });
  await TestUtils.waitForCondition(() => document.getElementById("whimsyMenuBarExtra"), "status item recreated");
  isnot(document.getElementById("whimsyMenuBarExtra"), first, "a fresh element, not the one removeItem already forgot");

  await SpecialPowers.pushPrefEnv({ set: [["whimsy.feature.menu-bar-extra", false]] });
  await TestUtils.waitForCondition(() => !document.getElementById("whimsyMenuBarExtra"), "cleaned up with the feature switch off");
  await SpecialPowers.popPrefEnv();
  await SpecialPowers.popPrefEnv();
  await SpecialPowers.popPrefEnv();
  await SpecialPowers.popPrefEnv();
});

add_task(async function test_popup_contents() {
  await SpecialPowers.pushPrefEnv({
    set: [
      ["whimsy.feature.menu-bar-extra", true],
      ["whimsy.menu-bar-extra.show", true],
    ],
  });
  WhimsyMenuBarExtra.init();
  await TestUtils.waitForCondition(() => document.getElementById("whimsyMenuBarExtraPopup"));
  const popup = document.getElementById("whimsyMenuBarExtraPopup");
  WhimsyMenuBarExtra._populate(popup, window);
  const items = [...popup.children];
  ok(items.length >= 1, "the popup has at least the quick window entry");
  is(items[0].getAttribute("data-l10n-id"), "whimsy-menu-bar-extra-quick-window", "first entry is New Quick Window");

  await SpecialPowers.popPrefEnv();
});

registerCleanupFunction(() => {
  WhimsyMenuBarExtra.apply();
});
