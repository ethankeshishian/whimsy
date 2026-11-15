/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// W29 Match the page (space colour editor toggle, off by default; see
// intake-w29/designs/accent-from-page.md). WhimsyPageTint tints the window
// frame with the active tab's colour - its theme-color meta
// (WhimsyPageTintChild/Parent), else its favicon's dominant colour, else
// nothing - blended into the space's own gradient colour at the opacity
// slider's strength, through the same CSS variables
// ZenGradientGenerator.onWorkspaceChange sets.

const { WhimsyPageTint } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyPageTint.sys.mjs");

const FEATURE = "whimsy.feature.page-tint";
const PAGE =
  getRootDirectory(gTestPath).replace("chrome://mochitests/content", "https://example.com") +
  "whimsy_page_tint.html";

const $ = id => document.getElementById(id);
const row = () => $("whimsy-match-page-row");
const toggle = () => $("whimsy-match-page-switch");
const panel = () => gZenThemePicker.panel;

function background() {
  return gZenThemePicker.browserBackgroundElement.style.getPropertyValue("--zen-main-browser-background");
}

function setThemeColor(browser, content) {
  return SpecialPowers.spawn(browser, [content], c => {
    let meta = content.document.querySelector('meta[name="theme-color"]');
    if (c == null) {
      meta?.remove();
      return;
    }
    if (!meta) {
      meta = content.document.createElement("meta");
      meta.setAttribute("name", "theme-color");
      content.document.head.appendChild(meta);
    }
    meta.setAttribute("content", c);
  });
}

async function openPanel() {
  if (panel().state == "open") {
    return;
  }
  const shown = BrowserTestUtils.waitForPopupEvent(panel(), "shown");
  gZenThemePicker.openThemePicker(new MouseEvent("click"));
  await shown;
}

async function closePanel() {
  if (panel().state != "open") {
    return;
  }
  const hidden = BrowserTestUtils.waitForPopupEvent(panel(), "hidden");
  panel().hidePopup();
  await hidden;
}

function endMatchPage() {
  const workspace = gZenWorkspaces.getActiveWorkspace();
  if (workspace.theme?.matchPage) {
    workspace.theme.matchPage = false;
    gZenWorkspaces.saveWorkspace(workspace);
    gZenThemePicker.onWorkspaceChange(workspace);
  }
  WhimsyPageTint._resetCache();
}

add_setup(async () => {
  await gZenThemePicker.promiseInitialized;
  await openPanel();
  registerCleanupFunction(closePanel);
});

registerCleanupFunction(() => {
  Services.prefs.clearUserPref(FEATURE);
  endMatchPage();
});

add_task(async function test_row_and_names() {
  ok(row(), "The theme picker has the new row");
  is(row().nextElementSibling?.id, "PanelUI-zen-gradient-generator-custom-colors", "...right before Custom Color");
  ok(toggle(), "...with a switch");
  await TestUtils.waitForCondition(() => toggle().getAttribute("aria-label"), "The switch has a name");
  is(toggle().getAttribute("aria-label"), "Match the page", "...matching the design's exact copy");
  await TestUtils.waitForCondition(
    () => row().querySelector(".whimsy-match-page-row-label")?.textContent,
    "The row has a label"
  );
  is(row().querySelector(".whimsy-match-page-row-label").textContent, "Match the page");
  is(row().querySelector(".whimsy-match-page-row-detail").textContent, "Tints this space with each site’s colour");
  ok(!toggle().pressed, "Off by default");
});

add_task(async function test_switching_restores_exactly_and_dims() {
  endMatchPage();
  const workspace = gZenWorkspaces.getActiveWorkspace();
  const before = background();

  await BrowserTestUtils.withNewTab(PAGE, async browser => {
    await setThemeColor(browser, "#3366ff");

    toggle().click();
    await TestUtils.waitForCondition(() => workspace.theme?.matchPage, "Turning it on sets theme.matchPage");
    await TestUtils.waitForCondition(() => background() != before, "The frame repaints with the site colour");
    ok(document.documentElement.hasAttribute("whimsy-match-page"), "The root is marked for the crossfade CSS");
    ok(panel().hasAttribute("whimsy-match-page-dim"), "The panel is marked to dim the pad and swatches");
    is(getComputedStyle($("PanelUI-zen-gradient-generator-color-pages")).opacity, "0.4", "The swatches dim to 40%");

    toggle().click();
    await TestUtils.waitForCondition(() => !workspace.theme?.matchPage, "Turning it off clears theme.matchPage");
    is(background(), before, "...and restores the gradient exactly");
    ok(!panel().hasAttribute("whimsy-match-page-dim"), "The dim clears");
    is(getComputedStyle($("PanelUI-zen-gradient-generator-color-pages")).opacity, "1", "The swatches come back");
  });
});

add_task(async function test_theme_color_change_updates_the_tint() {
  endMatchPage();
  const workspace = gZenWorkspaces.getActiveWorkspace();

  await BrowserTestUtils.withNewTab(PAGE, async browser => {
    toggle().click();
    await TestUtils.waitForCondition(() => workspace.theme?.matchPage);
    const base = background();

    await setThemeColor(browser, "#ff2222");
    await TestUtils.waitForCondition(() => background() != base, "A theme-color repaints the frame");
    const red = background();

    await setThemeColor(browser, "#2222ff");
    await TestUtils.waitForCondition(() => background() != red, "...and a later change repaints it again");

    toggle().click();
    await TestUtils.waitForCondition(() => !workspace.theme?.matchPage);
  });
});

add_task(async function test_reduced_motion_is_instant() {
  endMatchPage();
  const workspace = gZenWorkspaces.getActiveWorkspace();
  const bg = gZenThemePicker.browserBackgroundElement;

  await SpecialPowers.pushPrefEnv({ set: [["ui.prefersReducedMotion", 1]] });
  try {
    await BrowserTestUtils.withNewTab(PAGE, async browser => {
      await setThemeColor(browser, "#44bb88");
      toggle().click();
      await TestUtils.waitForCondition(() => workspace.theme?.matchPage);
      await TestUtils.waitForCondition(() => background());
      is(
        getComputedStyle(bg, "::after").transitionDuration,
        "0s",
        "Reduce Motion: the frame's colour change isn't animated"
      );
      toggle().click();
      await TestUtils.waitForCondition(() => !workspace.theme?.matchPage);
    });
  } finally {
    await SpecialPowers.popPrefEnv();
  }
});

add_task(async function test_motion_crossfades_by_default() {
  endMatchPage();
  const workspace = gZenWorkspaces.getActiveWorkspace();
  const bg = gZenThemePicker.browserBackgroundElement;

  await BrowserTestUtils.withNewTab(PAGE, async browser => {
    await setThemeColor(browser, "#bb4488");
    toggle().click();
    await TestUtils.waitForCondition(() => workspace.theme?.matchPage);
    await TestUtils.waitForCondition(() => background());
    is(
      getComputedStyle(bg, "::after").transitionDuration,
      "0.3s",
      "Otherwise the frame crossfades over 300ms"
    );
    toggle().click();
    await TestUtils.waitForCondition(() => !workspace.theme?.matchPage);
  });
});

add_task(async function test_private_windows_not_tinted() {
  const privateWin = await BrowserTestUtils.openNewBrowserWindow({ private: true });
  try {
    ok(!privateWin.document.getElementById("whimsy-match-page-row"), "No row is built in a private window");
    ok(
      !privateWin.document.documentElement.hasAttribute("whimsy-match-page"),
      "...and the frame is never marked for a tint"
    );
  } finally {
    await BrowserTestUtils.closeWindow(privateWin);
  }
});

add_task(async function test_favicon_fallback_colour() {
  // No theme-color: the favicon's own dominant colour, decoded from a
  // flat-filled 16x16 icon (data: URIs never taint the canvas).
  const svg =
    "data:image/svg+xml," +
    encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16">' +
      '<rect width="16" height="16" fill="#2244ee"/></svg>');
  const color = await WhimsyPageTint.faviconColor(window, { image: svg });
  Assert.deepEqual(color, [34, 68, 238], "The favicon's own colour, decoded");

  is(await WhimsyPageTint.faviconColor(window, { image: null }), null, "No icon: no colour");
  is(await WhimsyPageTint.faviconColor(window, {}), null, "No icon at all: no colour");
});
