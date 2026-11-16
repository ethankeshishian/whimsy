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

// WhimsyPageTint's singleColorValue() reproduces nsZenThemePicker's own
// #getSingleRGBColor, which always paints the toolbar at full opacity
// while the background may carry the space's configured, lower opacity -
// so the two can differ in alpha for the same flat colour. Compare only
// the RGB components.
function rgbOf(value) {
  const match = value.match(/rgba?\(([^,]+),([^,]+),([^,)]+)/);
  ok(match, `"${value}" is an rgb()/rgba() colour`);
  return match.slice(1, 4).map(n => Number(n.trim()));
}

// nsZenThemePicker's blendWithWhiteOverlay (ZenGradientGenerator.mjs) is
// not a pure opacity-setter: on macOS it also blends the colour toward a
// window-vibrancy overlay, by an amount that depends on the opacity it's
// given. The toolbar is always painted at opacity 1 (forced in
// singleColorValue) while the background keeps the space's own, lower
// opacity, so the two call it with different arguments and land close
// but not pixel-identical for what is still, visibly, the same flat
// colour. A few points of channel drift is that formula, not a bug, so
// compare with a small tolerance rather than exact equality.
function assertSameFlatColour(toolbar, other, message) {
  const [t, o] = [rgbOf(toolbar), rgbOf(other)];
  const deltas = t.map((v, i) => Math.abs(v - o[i]));
  const worst = Math.max(...deltas);
  ok(worst <= 6, `${message} (toolbar ${t}, background ${o}, off by up to ${worst})`);
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

// A space switch's own side effects (ZenSpaceManager's #performWorkspaceChange)
// aren't all settled the instant changeWorkspaceWithID's promise resolves;
// browser_whimsy_space_look.js's own switchTo() waits two animation frames
// for the same reason.
async function switchToSpace(uuid) {
  await gZenWorkspaces.changeWorkspaceWithID(uuid);
  await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
}

function swatchesOpacity() {
  return getComputedStyle($("PanelUI-zen-gradient-generator-color-pages")).opacity;
}

// The dim is a plain CSS rule keyed off the panel's own attribute, applied
// on the same tick as the attribute (see WhimsyPageTint.sys.mjs's style
// picker and toggle handlers), but a style recalc can still land a frame
// later than the attribute itself, same as a Zen space switch's own
// attributes (see browser_whimsy_space_look.js's switchTo()).
async function waitForSwatchesOpacity(expected, message) {
  await TestUtils.waitForCondition(() => swatchesOpacity() == expected, message);
  is(swatchesOpacity(), expected, message);
}

async function endMatchPage(workspace = gZenWorkspaces.getActiveWorkspace()) {
  // Also drop a lingering non-default style, so a test never inherits an
  // earlier one's Blend/Replace choice along with Match the page itself.
  if (workspace.theme?.matchPage || workspace.theme?.matchPageStyle) {
    workspace.theme.matchPage = false;
    delete workspace.theme.matchPageStyle;
    gZenWorkspaces.saveWorkspace(workspace);
    gZenThemePicker.onWorkspaceChange(workspace);
  }
  WhimsyPageTint._resetCache();
  // Every test starts here, so this is also the one place that can
  // guarantee a previous test's crossfade (toggling the switch, or just
  // switching style, each starts one - see crossfadeBackground) has
  // actually finished, rather than leaving "animating-background" set on
  // the shared background element for whichever test runs next to trip
  // over.
  const bg = gZenThemePicker.browserBackgroundElement;
  await TestUtils.waitForCondition(() => !bg.hasAttribute("animating-background"));
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

registerCleanupFunction(async () => {
  Services.prefs.clearUserPref(FEATURE);
  await endMatchPage();
});

add_task(async function test_row_and_names() {
  ok(row(), "The theme picker has the new row");
  is(row().nextElementSibling?.id, "whimsy-match-page-style-row", "...then the style row");
  is(styleRow().nextElementSibling?.id, "PanelUI-zen-gradient-generator-custom-colors", "...right before Custom Color");
  ok(toggle(), "...with a switch");
  // moz-toggle "maps" aria-label onto its shadow button and strips the
  // host's own attribute (lit-utils.mjs's mapped-property handling), so
  // the real value lives on the ariaLabel property, not the attribute.
  await TestUtils.waitForCondition(() => toggle().ariaLabel, "The switch has a name");
  is(toggle().ariaLabel, "Match the page", "...matching the design's exact copy");
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
  await endMatchPage();
  toggle().click();
  await TestUtils.waitForCondition(() => !styleRow().hidden, "Turning it on shows the style row");
  is(styleButton("gradient").getAttribute("aria-checked"), "true", "Gradient is the per-space default");

  toggle().click();
  await TestUtils.waitForCondition(() => styleRow().hidden, "Turning it off hides it again");
});

add_task(async function test_switching_restores_exactly_and_dims_under_replace_only() {
  await endMatchPage();
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
    await waitForSwatchesOpacity("1", "...still at full strength");

    pickStyle("blend");
    await TestUtils.waitForCondition(() => workspace.theme?.matchPageStyle == "blend");
    ok(!panel().hasAttribute("whimsy-match-page-dim"), "Blend: still not dimmed");

    pickStyle("replace");
    await TestUtils.waitForCondition(() => workspace.theme?.matchPageStyle == "replace");
    ok(panel().hasAttribute("whimsy-match-page-dim"), "Replace: the panel is marked to dim the pad and swatches");
    await waitForSwatchesOpacity("0.4", "The swatches dim to 40%");

    pickStyle("gradient");
    await TestUtils.waitForCondition(() => workspace.theme?.matchPageStyle == "gradient");
    ok(!panel().hasAttribute("whimsy-match-page-dim"), "Back to Gradient: the dim clears");

    toggle().click();
    await TestUtils.waitForCondition(() => !workspace.theme?.matchPage, "Turning it off clears theme.matchPage");
    is(background(), before, "...and restores the gradient exactly");
    ok(!panel().hasAttribute("whimsy-match-page-dim"), "The dim stays clear");
    await waitForSwatchesOpacity("1", "The swatches stay at full strength");
  });
});

add_task(async function test_blend_paint_output() {
  await endMatchPage();
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
    assertSameFlatColour(toolbarBackground(), background(), "...the same flat colour behind the toolbar");

    toggle().click();
    await TestUtils.waitForCondition(() => !workspace.theme?.matchPage);
  });
});

add_task(async function test_gradient_paint_output() {
  await endMatchPage();
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
  await endMatchPage();
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
    assertSameFlatColour(toolbarBackground(), replaced, "...the same flat colour behind the toolbar");

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
  await endMatchPage();
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
    await switchToSpace(other.uuid);
    await openPanel();
    is(styleButton("gradient").getAttribute("aria-checked"), "true", "A fresh space still defaults to Gradient");
    ok(!toggle().pressed, "...and starts with Match the page off, unaffected by home's switch");

    toggle().click();
    await TestUtils.waitForCondition(() => other.theme?.matchPage);
    pickStyle("blend");
    await TestUtils.waitForCondition(() => other.theme?.matchPageStyle == "blend");

    await closePanel();
    await switchToSpace(home.uuid);
    await openPanel();
    is(styleButton("replace").getAttribute("aria-checked"), "true", "Home kept its own Replace choice");
    ok(toggle().pressed, "...and its switch stayed on");

    await endMatchPage(home);
    await endMatchPage(other);
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
  await endMatchPage();
  const workspace = gZenWorkspaces.getActiveWorkspace();
  const bg = gZenThemePicker.browserBackgroundElement;

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
    // Let the off-crossfade finish before leaving: it's a real, un-reduced
    // 300ms animation here, and leaving its "animating-background" attribute
    // in flight would otherwise leak into whichever test runs next.
    await TestUtils.waitForCondition(() => !bg.hasAttribute("animating-background"));
  });
});

add_task(async function test_reduced_motion_is_instant() {
  await endMatchPage();
  const workspace = gZenWorkspaces.getActiveWorkspace();
  const bg = gZenThemePicker.browserBackgroundElement;

  await SpecialPowers.pushPrefEnv({ set: [["ui.prefersReducedMotion", 1]] });
  // The pref push can land a tick before matchMedia reflects it; crossfadeBackground
  // reads the media query at click time, so make sure it has already settled.
  await TestUtils.waitForCondition(
    () => window.matchMedia("(prefers-reduced-motion: reduce)").matches,
    "Reduced motion has propagated to matchMedia"
  );
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
  await endMatchPage();
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
