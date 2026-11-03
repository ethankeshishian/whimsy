/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// W13 F12 (wave12 F12, option A, styled like Whimsy): the Reader View
// button looks different on and off. Off: the outline glyph, no fill. On:
// the filled glyph in the space's colour on an 18% tint of it. Driven with
// real clicks on the button (into Reader View and out again); the look is
// read from computed styles.

const ARTICLE =
  getRootDirectory(gTestPath).replace("chrome://mochitests/content", "https://example.com") + "whimsy_article.html";
const button = () => document.getElementById("reader-mode-button");
const icon = () => button().querySelector(".urlbar-icon");

// A colour expression as it resolves in the address bar.
function resolved(property, expression) {
  const probe = document.createXULElement("box");
  probe.style.setProperty(property, expression);
  button().after(probe);
  const value = getComputedStyle(probe).getPropertyValue(property);
  probe.remove();
  return value;
}

async function clickButton() {
  // Zen shows the address bar's buttons while the pointer is over it.
  EventUtils.synthesizeMouseAtCenter(document.getElementById("urlbar"), { type: "mousemove" });
  await TestUtils.waitForCondition(
    () => button().checkVisibility({ visibilityProperty: true, opacityProperty: true }),
    "The Reader View button can be clicked"
  );
  EventUtils.synthesizeMouseAtCenter(button(), {});
}

add_task(async function test_on_and_off_look_different() {
  ok(document.documentElement.hasAttribute("whimsy-smart-buttons"), "Whimsy shows the address bar's Reader button");
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, ARTICLE);
  await TestUtils.waitForCondition(() => !button().hidden, "The page is an article");

  const offImage = getComputedStyle(icon()).listStyleImage;
  ok(!offImage.includes("reader-on.svg"), `Off: the outline glyph (${offImage})`);
  isnot(getComputedStyle(button()).backgroundColor, resolved("background-color",
    "color-mix(in srgb, var(--zen-primary-color, AccentColor) 18%, transparent)"), "Off: no tint");

  // Into Reader View with a real click.
  const entered = BrowserTestUtils.waitForContentEvent(tab.linkedBrowser, "AboutReaderContentReady", false, null, true);
  await clickButton();
  await entered;
  await TestUtils.waitForCondition(() => button().hasAttribute("readeractive"), "Reader View is on");
  // Away from the button, so hover doesn't add its layer.
  EventUtils.synthesizeMouseAtCenter(document.getElementById("urlbar-input"), { type: "mousemove" });
  const tint = resolved("background-color", "color-mix(in srgb, var(--zen-primary-color, AccentColor) 18%, transparent)");
  await TestUtils.waitForCondition(() => getComputedStyle(button()).backgroundColor == tint, "On: the space colour at 18%");
  ok(getComputedStyle(icon()).listStyleImage.includes("reader-on.svg"), "On: the filled glyph");
  is(getComputedStyle(icon()).fill, resolved("color", "var(--zen-primary-color, AccentColor)"), "...in the space's colour");
  is(getComputedStyle(icon()).animationName, "whimsy-reader-on", "...popping in once");
  const before = button().getBoundingClientRect().width;

  // And out again with a real click.
  await clickButton();
  // Leaving goes back in history, which may restore from the bfcache with no load event.
  await TestUtils.waitForCondition(() => tab.linkedBrowser.currentURI.spec == ARTICLE, "Back on the article");
  await TestUtils.waitForCondition(() => !button().hasAttribute("readeractive"), "Reader View is off");
  EventUtils.synthesizeMouseAtCenter(document.getElementById("urlbar-input"), { type: "mousemove" });
  await TestUtils.waitForCondition(() => getComputedStyle(icon()).listStyleImage == offImage, "Off: the outline glyph again");
  await TestUtils.waitForCondition(() => getComputedStyle(button()).backgroundColor != tint, "...and no tint");
  is(button().getBoundingClientRect().width, before, "The button never changes width");
  BrowserTestUtils.removeTab(tab);
});
