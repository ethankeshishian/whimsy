/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// W29 Match the page (space colour editor toggle, off by default; see
// intake-w29/designs/accent-blend-vs-replace.md, r4). WhimsyPageTint tints
// the window frame with the active tab's colour - its theme-color meta
// (WhimsyPageTintChild/Parent), else its favicon's dominant colour, else
// nothing - through one of three per-space styles (Blend, Gradient or
// Replace; Gradient by default), through the same CSS variables
// ZenGradientGenerator.onWorkspaceChange sets.

const { WhimsyPageTint } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyPageTint.sys.mjs");

const FEATURE = "whimsy.feature.page-tint";
const PAGE =
  getRootDirectory(gTestPath).replace("chrome://mochitests/content", "https://example.com") +
  "whimsy_page_tint.html";

const $ = id => document.getElementById(id);
const row = () => $("whimsy-match-page-row");
const toggle = () => $("whimsy-match-page-switch");
const styleRow = () => $("whimsy-match-page-style-row");
const styleButton = value => styleRow()?.querySelector(`.whimsy-look-segment[data-value="${value}"]`);
const panel = () => gZenThemePicker.panel;

function background() {
  return gZenThemePicker.browserBackgroundElement.style.getPropertyValue("--zen-main-browser-background");
}

function toolbarBackground() {
  return gZenThemePicker.toolbarBackgroundElement.style.getPropertyValue("--zen-main-browser-background-toolbar");
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

function pickStyle(value) {
  styleButton(value).click();
}

function endMatchPage(workspace = gZenWorkspaces.getActiveWorkspace()) {
  if (workspace.theme?.matchPage) {
    workspace.theme.matchPage = false;
    gZenWorkspaces.saveWorkspace(workspace);
    gZenThemePicker.onWorkspaceChange(workspace);
  }
  WhimsyPageTint._resetCache();
}

// A fixed, known 2-stop gradient so the Gradient style's stops are
// predictable across tests, independent of whatever the test profile's
// default space happens to carry.
function setSpaceGradient(workspace, [c1, c2]) {
  workspace.theme = {
    type: "gradient",
    gradientColors: [{ c: c1, isPrimary: true }, { c: c2 }],
    opacity: 0.5,
    texture: 0,
  };
  gZenWorkspaces.saveWorkspace(workspace);
  gZenThemePicker.onWorkspaceChange(workspace);
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
  is(row().nextElementSibling?.id, "whimsy-match-page-style-row", "...then the style row");
  is(styleRow().nextElementSibling?.id, "PanelUI-zen-gradient-generator-custom-colors", "...right before Custom Color");
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
  ok(styleRow().hidden, "The style row is hidden while it's off");

  for (const [value, text] of [["blend", "Blend"], ["gradient", "Gradient"], ["replace", "Replace"]]) {
    const label = styleButton(value)?.querySelector(".whimsy-look-segment-label");
    await TestUtils.waitForCondition(() => label?.textContent, `The ${value} segment has a label`);
    is(label.textContent, text, `The ${value} segment reads "${text}"`);
  }
});

add_task(async function test_style_row_shows_with_the_switch_and_defaults_to_gradient() {
  endMatchPage();
  toggle().click();
  await TestUtils.waitForCondition(() => !styleRow().hidden, "Turning it on shows the style row");
  is(styleButton("gradient").getAttribute("aria-checked"), "true", "Gradient is the per-space default");

  toggle().click();
  await TestUtils.waitForCondition(() => styleRow().hidden, "Turning it off hides it again");
});

add_task(async function test_switching_restores_exactly_and_dims_under_replace_only() {
  endMatchPage();
  const workspace = gZenWorkspaces.getActiveWorkspace();
  const before = background();

  await BrowserTestUtils.withNewTab(PAGE, async browser => {
    await setThemeColor(browser, "#3366ff");

    toggle().click();
    await TestUtils.waitForCondition(() => workspace.theme?.matchPage, "Turning it on sets theme.matchPage");
    await TestUtils.waitForCondition(() => background() != before, "The frame repaints with the site colour");
    ok(document.documentElement.hasAttribute("whimsy-match-page"), "The root is marked for the tint");

    // M.2 correction: Gradient (the default) still uses the space's own
    // colour, so the pad and swatches stay live.
    ok(!panel().hasAttribute("whimsy-match-page-dim"), "Gradient: the pad and swatches aren't dimmed");
    is(getComputedStyle($("PanelUI-zen-gradient-generator-color-pages")).opacity, "1", "...still at full strength");

    pickStyle("blend");
    await TestUtils.waitForCondition(() => workspace.theme?.matchPageStyle == "blend");
    ok(!panel().hasAttribute("whimsy-match-page-dim"), "Blend: still not dimmed");

    pickStyle("replace");
    await TestUtils.waitForCondition(() => workspace.theme?.matchPageStyle == "replace");
    ok(panel().hasAttribute("whimsy-match-page-dim"), "Replace: the panel is marked to dim the pad and swatches");
    is(getComputedStyle($("PanelUI-zen-gradient-generator-color-pages")).opacity, "0.4", "The swatches dim to 40%");

    pickStyle("gradient");
    await TestUtils.waitForCondition(() => workspace.theme?.matchPageStyle == "gradient");
    ok(!panel().hasAttribute("whimsy-match-page-dim"), "Back to Gradient: the dim clears");

    toggle().click();
    await TestUtils.waitForCondition(() => !workspace.theme?.matchPage, "Turning it off clears theme.matchPage");
    is(background(), before, "...and restores the gradient exactly");
    ok(!panel().hasAttribute("whimsy-match-page-dim"), "The dim stays clear");
    is(getComputedStyle($("PanelUI-zen-gradient-generator-color-pages")).opacity, "1", "The swatches stay at full strength");
  });
});

add_task(async function test_blend_paint_output() {
  endMatchPage();
  const workspace = gZenWorkspaces.getActiveWorkspace();
  setSpaceGradient(workspace, [[235, 133, 112], [196, 154, 227]]); // coral to lilac

  await BrowserTestUtils.withNewTab(PAGE, async browser => {
    await setThemeColor(browser, "#1ed760"); // a green site, far from the space
    ensureTheme: workspace.theme.matchPageStyle = "blend";
    gZenWorkspaces.saveWorkspace(workspace);

    toggle().click();
    await TestUtils.waitForCondition(() => workspace.theme?.matchPage);
    await TestUtils.waitForCondition(() => background());
    ok(!background().includes("gradient"), "Blend paints a flat colour, not a gradient");
    is(toolbarBackground(), background(), "...the same flat colour behind the toolbar");

    toggle().click();
    await TestUtils.waitForCondition(() => !workspace.theme?.matchPage);
  });
});

add_task(async function test_gradient_paint_output() {
  endMatchPage();
  const workspace = gZenWorkspaces.getActiveWorkspace();
  setSpaceGradient(workspace, [[235, 133, 112], [196, 154, 227]]); // coral to lilac
  workspace.theme.matchPageStyle = "gradient";
  gZenWorkspaces.saveWorkspace(workspace);

  await BrowserTestUtils.withNewTab(PAGE, async browser => {
    await setThemeColor(browser, "#1ed760");

    toggle().click();
    await TestUtils.waitForCondition(() => workspace.theme?.matchPage);
    await TestUtils.waitForCondition(() => background().includes("linear-gradient"));
    const bg = background();
    ok(bg.startsWith("linear-gradient(to bottom,"), "Gradient paints a top-to-bottom linear-gradient");
    ok(bg.includes(" 0%,") && bg.includes(" 13%,") && bg.includes(" 60%,") && bg.includes(" 100%)"), "...with the design's four stops");
    ok(!toolbarBackground().includes("gradient"), "The toolbar stays a flat, solid colour");

    toggle().click();
    await TestUtils.waitForCondition(() => !workspace.theme?.matchPage);
  });
});

add_task(async function test_replace_paint_output() {
  endMatchPage();
  const workspace = gZenWorkspaces.getActiveWorkspace();
  setSpaceGradient(workspace, [[235, 133, 112], [196, 154, 227]]); // coral to lilac, far from the site below
  workspace.theme.matchPageStyle = "replace";
  gZenWorkspaces.saveWorkspace(workspace);

  await BrowserTestUtils.withNewTab(PAGE, async browser => {
    await setThemeColor(browser, "#1ed760"); // a green site

    toggle().click();
    await TestUtils.waitForCondition(() => workspace.theme?.matchPage);
    await TestUtils.waitForCondition(() => background());
    const replaced = background();
    ok(!replaced.includes("gradient"), "Replace paints a flat colour, not a gradient");
    is(toolbarBackground(), replaced, "...the same flat colour behind the toolbar");

    // Blend mixes the same site colour toward the space's own colours, so
    // for a site this far from the space the two styles paint differently.
    pickStyle("blend");
    await TestUtils.waitForCondition(() => workspace.theme?.matchPageStyle == "blend");
    await TestUtils.waitForCondition(() => background() != replaced);
    isnot(background(), replaced, "Blend paints a different colour than Replace, for the same site and space");

    toggle().click();
    await TestUtils.waitForCondition(() => !workspace.theme?.matchPage);
  });
});

add_task(async function test_style_persists_per_space() {
  endMatchPage();
  const home = gZenWorkspaces.getActiveWorkspace();
  const other = await gZenWorkspaces.createAndSaveWorkspace("W29 other", undefined, true);
  try {
    toggle().click();
    await TestUtils.waitForCondition(() => home.theme?.matchPage);
    pickStyle("replace");
    await TestUtils.waitForCondition(() => home.theme?.matchPageStyle == "replace");

    // The picker's own sync happens on popupshowing, so close and reopen
    // it across the space switch, the same as a person would.
    await closePanel();
    await gZenWorkspaces.changeWorkspaceWithID(other.uuid);
    await openPanel();
    is(styleButton("gradient").getAttribute("aria-checked"), "true", "A fresh space still defaults to Gradient");
    ok(!toggle().pressed, "...and starts with Match the page off, unaffected by home's switch");

    toggle().click();
    await TestUtils.waitForCondition(() => other.theme?.matchPage);
    pickStyle("blend");
    await TestUtils.waitForCondition(() => other.theme?.matchPageStyle == "blend");

    await closePanel();
    await gZenWorkspaces.changeWorkspaceWithID(home.uuid);
    await openPanel();
    is(styleButton("replace").getAttribute("aria-checked"), "true", "Home kept its own Replace choice");
    ok(toggle().pressed, "...and its switch stayed on");

    endMatchPage(home);
    endMatchPage(other);
  } finally {
    await closePanel();
    if (gZenWorkspaces.activeWorkspace != home.uuid) {
      await gZenWorkspaces.changeWorkspaceWithID(home.uuid);
    }
    await gZenWorkspaces.removeWorkspace(other.uuid);
    await openPanel();
  }
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
      ok(!bg.hasAttribute("animating-background"), "Reduce Motion: no crossfade is started");
      is(bg.style.getPropertyValue("--zen-background-opacity"), "1", "...the new paint is shown at once");
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
    ok(bg.hasAttribute("animating-background"), "Otherwise the frame starts a 300ms crossfade");
    await TestUtils.waitForCondition(
      () => !bg.hasAttribute("animating-background"),
      "...and settles once it's done"
    );
    is(bg.style.getPropertyValue("--zen-background-opacity"), "1", "...back at full opacity");

    // Switching style while it's on crossfades the same way, including
    // into a linear-gradient (Gradient), which a CSS transition can't.
    pickStyle("gradient");
    await TestUtils.waitForCondition(() => bg.hasAttribute("animating-background"), "Gradient also crossfades in");
    await TestUtils.waitForCondition(() => !bg.hasAttribute("animating-background"));

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
