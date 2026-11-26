/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// W29: Match the page (Zen's space colour editor, off by default, per
// space). On, the window frame (sidebar and toolbar) is tinted with the
// current tab's colour, through the same CSS variables
// ZenGradientGenerator.onWorkspaceChange sets, so every themed surface
// follows. Off (or no colour, or a private window, or the Glance
// overlay), the space's own gradient is untouched.
//
// A per-space style (Blend, Gradient or Replace - theme.matchPageStyle,
// "gradient" by default) picks how the site's colour and the space's own
// colours combine (see paintValuesFor): Blend mixes them, Gradient keeps
// the space's gradient with the site's colour as its new top stop, and
// Replace drops the space's colour while it's on. Every style crossfades
// over 300ms (instant with Reduce Motion) - see crossfadeBackground,
// which reproduces ZenGradientGenerator/ZenSpaceManager's own space-
// switch dissolve (stash the old paint, then animate
// --zen-background-opacity back up) since a plain CSS transition can't
// interpolate a flat colour into a linear-gradient.
//
// The colour comes from the page's <meta name="theme-color"> (through
// WhimsyPageTintParent/Child, respecting the tag's media attribute), or
// else the favicon's dominant colour, or else the space's own colour
// (which makes Blend a no-op). No Zen file changes: the toggle and style
// rows are built from JS at the one spot theme-picker.inc leaves between
// the opacity/texture controls and Custom Color, the style row reuses
// WhimsySpaceLook's own segmented control, and the tint is applied with
// Zen's own public ZenGradientGenerator/nsZenThemePicker API
// (gZenThemePicker) - singleColorValue below reproduces its one private
// step (#getSingleRGBColor) from public pieces plus a direct pref read,
// so nothing here depends on Zen's internals changing shape.

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  PrivateBrowsingUtils: "resource://gre/modules/PrivateBrowsingUtils.sys.mjs",
  WhimsySpaceLook: "resource:///modules/whimsy/WhimsySpaceLook.sys.mjs",
});

const FEATURE_PREF = "whimsy.feature.page-tint";
const ACRYLIC_SIDEBAR_PREF = "zen.theme.acrylic-sidebar";

// Never let the tint reach pure black or pure white.
const MIN_LIGHTNESS = 0.08;
const MAX_LIGHTNESS = 0.92;

// origin (prePath) -> { theme: [r,g,b]|null, favicon: [r,g,b]|null|undefined }
// theme comes from WhimsyPageTintParent; favicon is decoded lazily, once,
// the first time a tab on that origin needs a colour and has none yet.
const colorByOrigin = new Map();

function originOf(uriOwner) {
  try {
    return uriOwner.currentURI.prePath;
  } catch (e) {
    return null;
  }
}

function entryFor(origin) {
  let entry = colorByOrigin.get(origin);
  if (!entry) {
    entry = {};
    colorByOrigin.set(origin, entry);
  }
  return entry;
}

function acrylicSidebar() {
  return Services.prefs.getBoolPref(ACRYLIC_SIDEBAR_PREF, false);
}

// Reproduces nsZenThemePicker's private #getSingleRGBColor from only its
// public pieces, plus the acrylic-sidebar pref it reads internally.
function singleColorValue(picker, rgb, forToolbar) {
  let opacity = picker.currentOpacity;
  let color;
  if ((forToolbar && !acrylicSidebar()) || (!forToolbar && !picker.canBeTransparent)) {
    color = picker.blendColors(rgb, picker.getToolbarModifiedBaseRaw().slice(0, 3), picker.canBeTransparent ? 90 : opacity * 100);
    opacity = 1;
  } else {
    color = rgb;
  }
  if (picker.isLegacyVersion && picker.isDarkMode) {
    color = picker.blendColors(color, [0, 0, 0], 30);
  }
  return picker.blendWithWhiteOverlay(color, opacity);
}

function clampExtremes(picker, rgb) {
  const [h, s, l] = picker.rgbToHsl(...rgb);
  const clamped = Math.min(MAX_LIGHTNESS, Math.max(MIN_LIGHTNESS, l));
  return clamped === l ? rgb : picker.hslToRgb(h / 360, s, clamped);
}

function dominantSpaceColor(picker, theme) {
  return picker.getMostDominantColor(theme?.gradientColors ?? []) || picker.getNativeAccentColor();
}

function ensureTheme(workspace) {
  if (!workspace.theme) {
    workspace.theme = { type: "gradient", gradientColors: [], opacity: 0.5, texture: 0 };
  }
  return workspace.theme;
}

// theme.matchPage stays the on/off boolean; theme.matchPageStyle is the
// per-space choice of how it paints, "gradient" (the design's
// recommendation) by default.
function styleOf(workspace) {
  const style = workspace?.theme?.matchPageStyle;
  return style === "blend" || style === "replace" ? style : "gradient";
}

// Resolves the one colour a style needs for dark-mode/accent-colour
// purposes, plus the background/toolbar CSS values to paint. Blend and
// Replace are a flat colour (nothing new: Replace is Blend with no
// space colour in the mix). Gradient keeps a CSS linear-gradient, built
// the same way Zen's own getGradient processes a custom-colour
// gradient's stops (#getSingleRGBColor on each one): the site's colour
// solid through the top 13% (behind the toolbar and address), fading to
// the space's first stop by 60% and its second at the bottom - nothing
// mixed, so unlike Blend it never averages two colours into a third.
function paintValuesFor(picker, style, siteColor, theme) {
  if (style === "replace") {
    const tinted = clampExtremes(picker, siteColor);
    return { background: singleColorValue(picker, tinted, false), toolbar: singleColorValue(picker, tinted, true), representative: tinted };
  }
  if (style === "blend") {
    const dominant = dominantSpaceColor(picker, theme);
    const tinted = clampExtremes(picker, picker.blendColors(siteColor, dominant, picker.currentOpacity * 100));
    return { background: singleColorValue(picker, tinted, false), toolbar: singleColorValue(picker, tinted, true), representative: tinted };
  }
  const stops = theme?.gradientColors ?? [];
  const site = clampExtremes(picker, siteColor);
  const first = clampExtremes(picker, stops[0]?.c ?? dominantSpaceColor(picker, theme));
  const second = clampExtremes(picker, stops[1]?.c ?? first);
  const siteValue = singleColorValue(picker, site, false);
  const background =
    `linear-gradient(to bottom, ${siteValue} 0%, ${siteValue} 13%, ` +
    `${singleColorValue(picker, first, false)} 60%, ${singleColorValue(picker, second, false)} 100%)`;
  return { background, toolbar: singleColorValue(picker, site, true), representative: site };
}

// A 300ms crossfade between arbitrary background values (a flat colour
// or a linear-gradient string), instant with Reduce Motion. A plain CSS
// transition can't interpolate a colour into a gradient, so this
// reproduces ZenGradientGenerator.onWorkspaceChange and
// ZenSpaceManager's own space-switch dissolve: stash the current paint
// into zen-browser-ui.css's "-old" layer (its ::before, under ::after
// at 1 - --zen-background-opacity), then animate --zen-background-opacity
// from its complement back up to 1 with gZenUIManager.motion, the same
// spring Zen uses for a space switch.
function crossfadeBackground(win, backgroundElement, toolbarElement, background, toolbarBackground) {
  const elements = [backgroundElement, toolbarElement];
  if (win.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    backgroundElement.style.setProperty("--zen-main-browser-background", background);
    toolbarElement.style.setProperty("--zen-main-browser-background-toolbar", toolbarBackground);
    for (const element of elements) {
      element.style.setProperty("--zen-background-opacity", 1);
    }
    return;
  }

  let previousOpacity = parseFloat(backgroundElement.style.getPropertyValue("--zen-background-opacity"));
  previousOpacity = !previousOpacity || previousOpacity === 1 ? 0 : 1 - previousOpacity;

  backgroundElement.style.setProperty(
    "--zen-main-browser-background-old",
    backgroundElement.style.getPropertyValue("--zen-main-browser-background")
  );
  toolbarElement.style.setProperty(
    "--zen-main-browser-background-toolbar-old",
    toolbarElement.style.getPropertyValue("--zen-main-browser-background-toolbar")
  );
  for (const element of elements) {
    element.toggleAttribute("animating-background", true);
    element.style.setProperty("--zen-background-opacity", previousOpacity);
  }

  backgroundElement.style.setProperty("--zen-main-browser-background", background);
  toolbarElement.style.setProperty("--zen-main-browser-background-toolbar", toolbarBackground);

  const animation = win.gZenUIManager.motion.animate(
    elements,
    { "--zen-background-opacity": [previousOpacity, 1] },
    { type: "spring", bounce: 0, duration: 0.3 }
  );
  Promise.resolve(animation).then(
    () => {
      for (const element of elements) {
        element.removeAttribute("animating-background");
      }
    },
    () => {}
  );
}

// Paints one style's resolved values through the same
// variables/attributes ZenGradientGenerator.onWorkspaceChange sets for a
// window's active space.
function paintTint(win, picker, values) {
  const backgroundElement = picker.browserBackgroundElement;
  const toolbarElement = picker.toolbarBackgroundElement;
  if (!backgroundElement || !toolbarElement) {
    return;
  }
  const docElement = win.document.documentElement;

  crossfadeBackground(win, backgroundElement, toolbarElement, values.background, values.toolbar);
  docElement.removeAttribute("zen-default-theme");

  const isDarkMode = picker.shouldBeDarkMode(values.representative);
  if (isDarkMode) {
    docElement.setAttribute("zen-should-be-dark-mode", "true");
  } else {
    docElement.removeAttribute("zen-should-be-dark-mode");
  }
  const primaryColor = picker.getAccentColorForUI(values.representative, isDarkMode);
  docElement.style.setProperty("--zen-primary-color", primaryColor);
  const textColor = picker.getToolbarColor(isDarkMode, primaryColor);
  docElement.style.setProperty("--toolbox-textcolor", `rgba(${textColor[0]}, ${textColor[1]}, ${textColor[2]}, ${textColor[3]})`);
  docElement.style.setProperty("--toolbar-color-scheme", isDarkMode ? "dark" : "light");
}

// The colour to tint with for this tab: its own theme-color if one was
// reported, else its favicon's dominant colour (decoded once per origin,
// asynchronously - a miss here re-applies once it resolves), else null
// (no colour: leave the space's own gradient alone).
function colorForTab(win, tab) {
  const origin = originOf(tab?.linkedBrowser);
  if (!origin) {
    return null;
  }
  const entry = entryFor(origin);
  if (entry.theme) {
    return entry.theme;
  }
  if (entry.favicon !== undefined) {
    return entry.favicon;
  }
  entry.favicon = null; // placeholder: avoid decoding twice while it's in flight
  WhimsyPageTint.faviconColor(win, tab)
    .then(color => {
      entry.favicon = color;
      if (originOf(win.gBrowser?.selectedTab?.linkedBrowser) == origin) {
        applyTint(win);
      }
    })
    .catch(() => {
      entry.favicon = null;
    });
  return null;
}

function applyTint(win) {
  if (win.closed || !win.gBrowser) {
    return;
  }
  const picker = win.gZenThemePicker;
  if (!picker?.promiseInitialized) {
    return;
  }
  const docElement = win.document.documentElement;
  const workspace = win.gZenWorkspaces?.getActiveWorkspace?.();
  const matchPage = WhimsyPageTint.enabled && !!workspace?.theme?.matchPage;
  docElement.toggleAttribute("whimsy-match-page", matchPage);
  if (!matchPage) {
    return;
  }
  // The Glance overlay keeps the colour of the tab underneath.
  if (win.gBrowser.selectedTab?.hasAttribute("glance-id")) {
    return;
  }

  const siteColor = colorForTab(win, win.gBrowser.selectedTab);
  if (!siteColor) {
    return;
  }

  const values = paintValuesFor(picker, styleOf(workspace), siteColor, workspace.theme);
  paintTint(win, picker, values);
}

// Blend, Gradient, Replace: the design's exact order and copy.
const STYLE_OPTIONS = [
  { value: "blend", l10nId: "whimsy-theme-picker-match-page-style-blend" },
  { value: "gradient", l10nId: "whimsy-theme-picker-match-page-style-gradient" },
  { value: "replace", l10nId: "whimsy-theme-picker-match-page-style-replace" },
];

function buildRow(win) {
  const doc = win.document;
  if (doc.getElementById("whimsy-match-page-row")) {
    return;
  }
  const panel = doc.getElementById("PanelUI-zen-gradient-generator");
  const controls = doc.getElementById("PanelUI-zen-gradient-generator-controls");
  const customColors = doc.getElementById("PanelUI-zen-gradient-generator-custom-colors");
  if (!panel || !controls || !customColors) {
    return;
  }

  const row = doc.createXULElement("hbox");
  row.id = "whimsy-match-page-row";
  row.className = "whimsy-match-page-row";
  row.setAttribute("align", "center");

  const text = doc.createXULElement("vbox");
  text.className = "whimsy-match-page-row-text";
  const label = doc.createXULElement("label");
  label.id = "whimsy-match-page-row-label";
  label.className = "whimsy-match-page-row-label";
  doc.l10n.setAttributes(label, "whimsy-theme-picker-match-page");
  const detail = doc.createXULElement("label");
  detail.className = "whimsy-match-page-row-detail";
  doc.l10n.setAttributes(detail, "whimsy-theme-picker-match-page-detail");
  text.append(label, detail);

  const toggle = doc.createElement("moz-toggle");
  toggle.id = "whimsy-match-page-switch";
  toggle.className = "whimsy-match-page-switch";
  doc.l10n.setAttributes(toggle, "whimsy-theme-picker-match-page-switch");
  toggle.setAttribute("data-l10n-attrs", "aria-label");

  row.append(text, toggle);
  customColors.before(row);

  // The style choice (Blend, Gradient, Replace), under the switch and
  // shown only while it's on: Whimsy's own segmented control
  // (WhimsySpaceLook.segmented), not a new component.
  const styleRow = doc.createXULElement("hbox");
  styleRow.id = "whimsy-match-page-style-row";
  styleRow.className = "whimsy-match-page-style-row";
  const stylePicker = lazy.WhimsySpaceLook.segmented(doc, "match-page-style", STYLE_OPTIONS, value => {
    const workspace = win.gZenThemePicker.workspaceBeingEdited;
    if (!workspace) {
      return;
    }
    ensureTheme(workspace).matchPageStyle = value;
    win.gZenWorkspaces.saveWorkspace(workspace);
    stylePicker.select(value);
    // M.2 correction (accent-blend-vs-replace.md): the pad and swatches
    // dim only under Replace, where the space's colour drops out while
    // it's on - Blend and Gradient still use it, so they stay live.
    panel.toggleAttribute("whimsy-match-page-dim", toggle.pressed && value === "replace");
    applyTint(win);
  });
  stylePicker.group.setAttribute("aria-labelledby", label.id);
  styleRow.append(stylePicker.group);
  customColors.before(styleRow);

  const updateStyleRowVisibility = () => {
    styleRow.hidden = !toggle.pressed;
  };

  toggle.addEventListener("toggle", () => {
    const workspace = win.gZenThemePicker.workspaceBeingEdited;
    if (!workspace) {
      return;
    }
    ensureTheme(workspace).matchPage = toggle.pressed;
    win.gZenWorkspaces.saveWorkspace(workspace);
    win.gZenThemePicker.onWorkspaceChange(workspace);
    updateStyleRowVisibility();
    panel.toggleAttribute("whimsy-match-page-dim", toggle.pressed && styleOf(workspace) === "replace");
    applyTint(win);
  });

  const sync = () => {
    // Switched off after the row was built: it goes until switched back on.
    row.hidden = !WhimsyPageTint.enabled;
    if (row.hidden) {
      styleRow.hidden = true;
      panel.removeAttribute("whimsy-match-page-dim");
      return;
    }
    const workspace = win.gZenThemePicker.workspaceBeingEdited;
    const matchPage = !!workspace?.theme?.matchPage;
    toggle.pressed = matchPage;
    stylePicker.select(styleOf(workspace));
    updateStyleRowVisibility();
    panel.toggleAttribute("whimsy-match-page-dim", matchPage && styleOf(workspace) === "replace");
  };
  panel.addEventListener("popupshowing", sync);
  win.addEventListener("unload", () => panel.removeEventListener("popupshowing", sync), { once: true });
  sync();
}

// Kept from the window's start, whether or not the row is ever built: a
// space's saved Match the page settings survive Zen's own theme writes.
function installWorkspaceGuard(win) {
  // ZenGradientGenerator's updateCurrentWorkspace() unconditionally
  // replaces workspaceBeingEdited.theme with a freshly-built, gradient-
  // only object - whether or not it also saves it (skipSave only gates
  // the save, not the in-memory replacement). It runs 200ms after every
  // panel open (handlePanelOpen, to let the dots settle first) and again
  // on close if anything is still pending, so matchPage/matchPageStyle
  // get silently dropped on practically every panel interaction. Zen's
  // own file can't be hand-edited, so wrap this one instance method
  // (scoped to this window's picker, not the shared prototype) and
  // restore our fields across every call.
  const picker = win.gZenThemePicker;
  const originalUpdateCurrentWorkspace = picker.updateCurrentWorkspace.bind(picker);
  picker.updateCurrentWorkspace = (...args) => {
    const before = picker.workspaceBeingEdited;
    const matchState = before ? { matchPage: !!before.theme?.matchPage, style: styleOf(before) } : null;
    const result = originalUpdateCurrentWorkspace(...args);
    if (!matchState || (!matchState.matchPage && matchState.style === "gradient")) {
      return result;
    }
    const after = picker.workspaceBeingEdited;
    if (!after) {
      return result;
    }
    const theme = ensureTheme(after);
    if (theme.matchPage === matchState.matchPage && styleOf(after) === matchState.style) {
      return result;
    }
    theme.matchPage = matchState.matchPage;
    theme.matchPageStyle = matchState.style;
    // Only persist if the call we just wrapped did (skipSave defaults to
    // true, i.e. no save) - this mirrors, rather than overrides, what Zen
    // itself intended for that call.
    const skipSave = args.length ? !!args[0] : true;
    if (!skipSave) {
      win.gZenWorkspaces.saveWorkspace(after);
    }
    return result;
  };
}

export const WhimsyPageTint = {
  get enabled() {
    return Services.prefs.getBoolPref(FEATURE_PREF, true);
  },

  initWindow(win) {
    if (!win.gBrowser || win._whimsyPageTint) {
      return;
    }
    if (lazy.PrivateBrowsingUtils.isWindowPrivate(win)) {
      return;
    }
    win._whimsyPageTint = true;

    installWorkspaceGuard(win);
    // W32 perf: the row is built the first time the space colour editor
    // opens, and only while the feature is on.
    const editor = win.document.getElementById("PanelUI-zen-gradient-generator");
    const onEditorShowing = () => {
      if (this.enabled) {
        buildRow(win);
      }
    };
    editor?.addEventListener("popupshowing", onEditorShowing);

    const onTabSelect = event => {
      if (event.target?.hasAttribute?.("glance-id")) {
        return;
      }
      applyTint(win);
    };
    win.addEventListener("TabSelect", onTabSelect);

    const opacitySlider = win.document.getElementById("PanelUI-zen-gradient-generator-opacity");
    const onOpacityInput = () => applyTint(win);
    opacitySlider?.addEventListener("input", onOpacityInput);

    const onGradientUpdate = () => applyTint(win);
    Services.obs.addObserver(onGradientUpdate, "zen-space-gradient-update");

    win.addEventListener(
      "unload",
      () => {
        win.removeEventListener("TabSelect", onTabSelect);
        editor?.removeEventListener("popupshowing", onEditorShowing);
        opacitySlider?.removeEventListener("input", onOpacityInput);
        Services.obs.removeObserver(onGradientUpdate, "zen-space-gradient-update");
      },
      { once: true }
    );

    // Best-effort: TabSelect, DOMMetaChanged/pageshow and the favicon
    // decode all catch up once their colour is ready.
    applyTint(win);
  },

  // Called by WhimsyPageTintParent with the <browser> that reported a
  // theme-color (or null, meaning the page has none right now).
  onThemeColor(browser, colorStr) {
    // ownerGlobal isn't defined on elements seen from a module.
    const win = browser.documentGlobal;
    if (!win || win.closed) {
      return;
    }
    const origin = originOf(browser);
    if (!origin) {
      return;
    }
    entryFor(origin).theme = colorStr ? WhimsyPageTint.parseColor(colorStr) : null;
    if (win.gBrowser?.selectedBrowser == browser) {
      applyTint(win);
    }
  },

  parseColor(colorStr) {
    try {
      const rgba = InspectorUtils.colorToRGBA(colorStr);
      return rgba ? [rgba.r, rgba.g, rgba.b] : null;
    } catch (e) {
      return null;
    }
  },

  // The tab's favicon, down-sampled to 16x16, as the median of its
  // saturated pixels - null for no icon, a tainted canvas (a remote icon
  // without CORS) or a decode failure.
  async faviconColor(win, tab) {
    const url = tab?.image;
    if (!url) {
      return null;
    }
    try {
      const image = await new Promise((resolve, reject) => {
        const img = new win.Image();
        img.addEventListener("load", () => resolve(img), { once: true });
        img.addEventListener("error", () => reject(new Error("favicon load failed")), { once: true });
        img.src = url;
      });
      const canvas = win.document.createElementNS("http://www.w3.org/1999/xhtml", "canvas");
      canvas.width = 16;
      canvas.height = 16;
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      ctx.drawImage(image, 0, 0, 16, 16);
      const { data } = ctx.getImageData(0, 0, 16, 16);
      const pixels = [];
      for (let i = 0; i < data.length; i += 4) {
        if (data[i + 3] < 128) {
          continue;
        }
        const [r, g, b] = [data[i], data[i + 1], data[i + 2]];
        const max = Math.max(r, g, b);
        const min = Math.min(r, g, b);
        const sat = max == 0 ? 0 : (max - min) / max;
        pixels.push({ r, g, b, sat });
      }
      if (!pixels.length) {
        return null;
      }
      pixels.sort((a, b) => a.sat - b.sat);
      const saturated = pixels.filter(p => p.sat > 0.15);
      const pool = saturated.length ? saturated : pixels;
      const median = pool[Math.floor(pool.length / 2)];
      return [median.r, median.g, median.b];
    } catch (e) {
      return null;
    }
  },

  // Test-only: drop every cached colour so a test's origins start clean.
  _resetCache() {
    colorByOrigin.clear();
  },
};
