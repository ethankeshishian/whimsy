/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Look and feel options that need a little script (the CSS lives in
// whimsy-browser.css). Each part checks its whimsy.feature.<id> switch.
//
// Hex colors (whimsy.feature.hex-colors): the live hex field in Zen's theme
// picker lives in WhimsyHexPicker.sys.mjs. Whimsy also shows Zen's custom
// color row by default (zen.theme.gradient.show-custom-colors).
//
// Transparency (whimsy.look.transparency, Settings → Look and Feel): how
// see-through the sidebar and toolbars are, 0 to 80 %. On macOS Whimsy's
// window sits on a blurred system material (zen.widget.macos.window-
// vibrancy); Zen paints its space gradient over it fully opaque, with a
// per-space opacity in the theme picker that only fades the gradient into
// gray. This slider fades the whole painted background, everywhere at
// once, so the desktop shows through the blur like Arc's and Safari's
// translucent sidebars. 0 is Zen's look.
//
// Liquid Glass (whimsy.look.liquid-glass, Settings → Look and Feel, off by
// default, macOS 26+): Safari 26 and macOS Tahoe's own apps put their
// sidebars and toolbars on Apple's adaptive glass material; Gecko only gives
// it to menus. With the setting on, whimsy-nsCocoaWindow-mm.patch swaps the
// window's backdrop for NSGlassEffectView and the chrome goes see-through
// over it: at the Transparency level, or GLASS_TRANSPARENCY when the slider
// is at 0 (glass behind an opaque sidebar would be invisible). It needs the
// transparency switch, and with Reduce Transparency the chrome keeps the
// slider's level (AppKit frosts the glass itself). Older macOS: no change.
//
// Interface font (whimsy.look.ui-font, Settings → Look and Feel): Vivaldi
// and Zen mods let people set the browser's own font (tab titles, URL bar,
// menus, Settings) apart from web fonts, to match their editor or system
// taste. Empty is the system font (San Francisco on macOS). Pages keep
// their own fonts.

const FONT_FEATURE_PREF = "whimsy.feature.ui-font";
const FONT_PREF = "whimsy.look.ui-font";
const TRANSPARENCY_FEATURE_PREF = "whimsy.feature.transparency";
const TRANSPARENCY_PREF = "whimsy.look.transparency";
export const MAX_TRANSPARENCY = 80;
const GLASS_FEATURE_PREF = "whimsy.feature.liquid-glass";
const GLASS_PREF = "whimsy.look.liquid-glass";
export const GLASS_TRANSPARENCY = 35;

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  WhimsyHexPicker: "resource:///modules/whimsy/WhimsyHexPicker.sys.mjs",
});

// wave5/look: a space's own font per window (WhimsySpaceLook): a family,
// "" for the system font; no entry follows Settings.
const spaceFonts = new WeakMap();
const fontUpdaters = new WeakMap();

function featureOn(pref) {
  return Services.prefs.getBoolPref(pref, true);
}

export const WhimsyLook = {
  initWindow(win) {
    const run = (name, fn) => {
      try {
        fn();
      } catch (e) {
        console.error(`Whimsy: ${name} failed`, e);
      }
    };
    run("hex-colors", () => lazy.WhimsyHexPicker.initWindow(win));
    run("transparency", () => this.initTransparency(win));
    run("ui-font", () => this.initFont(win));
  },

  // --- Transparency ---

  // Whether win's chrome sits on Liquid Glass: the setting is on, macOS 26
  // or later draws it, and the system doesn't ask for less transparency.
  liquidGlass(win) {
    return (
      featureOn(GLASS_FEATURE_PREF) &&
      featureOn(TRANSPARENCY_FEATURE_PREF) &&
      Services.prefs.getBoolPref(GLASS_PREF, false) &&
      win.matchMedia("(-moz-mac-tahoe-theme)").matches &&
      !win.matchMedia("(prefers-reduced-transparency: reduce)").matches
    );
  },

  // The chosen transparency in percent, 0 when off or unsupported. With
  // Liquid Glass on (pass the window), never 0.
  transparency(win = null) {
    if (!featureOn(TRANSPARENCY_FEATURE_PREF)) {
      return 0;
    }
    const value = Math.min(MAX_TRANSPARENCY, Math.max(0, Services.prefs.getIntPref(TRANSPARENCY_PREF, 0)));
    if (!value && win && this.liquidGlass(win)) {
      return GLASS_TRANSPARENCY;
    }
    return value;
  },

  initTransparency(win) {
    const root = win.document.documentElement;
    const update = () => {
      const value = this.transparency(win);
      root.toggleAttribute("whimsy-transparency", value > 0);
      root.toggleAttribute("whimsy-liquid-glass", this.liquidGlass(win));
      root.style.setProperty("--whimsy-chrome-opacity", String(1 - value / 100));
    };
    const prefs = [TRANSPARENCY_PREF, TRANSPARENCY_FEATURE_PREF, GLASS_PREF, GLASS_FEATURE_PREF];
    for (const pref of prefs) {
      Services.prefs.addObserver(pref, update);
    }
    // Reduce Transparency can change while the window is open.
    const reduced = win.matchMedia("(prefers-reduced-transparency: reduce)");
    reduced.addEventListener("change", update);
    win.addEventListener(
      "unload",
      () => {
        for (const pref of prefs) {
          Services.prefs.removeObserver(pref, update);
        }
        reduced.removeEventListener("change", update);
      },
      { once: true }
    );
    update();
  },

  // --- Interface font ---

  // The chosen font family, or "" for the system font.
  uiFont() {
    if (!featureOn(FONT_FEATURE_PREF)) {
      return "";
    }
    // A family name only: no quotes, semicolons or braces reach the CSS.
    return Services.prefs.getStringPref(FONT_PREF, "").replace(/["\\;{}<>]/g, "").trim();
  },

  // wave5/look: the active space's font for this window (undefined or
  // null: follow Settings).
  setSpaceFont(win, font) {
    if (font === undefined || font === null) {
      spaceFonts.delete(win);
    } else {
      spaceFonts.set(win, String(font).replace(/["\\;{}<>]/g, "").trim());
    }
    fontUpdaters.get(win)?.();
  },

  // The font win's interface uses: its space's, else Settings'.
  windowFont(win) {
    return win && spaceFonts.has(win) ? spaceFonts.get(win) : this.uiFont();
  },

  initFont(win) {
    const root = win.document.documentElement;
    const update = () => {
      const font = this.windowFont(win);
      root.toggleAttribute("whimsy-ui-font", !!font);
      if (font) {
        root.style.setProperty("--whimsy-ui-font", `"${font}"`);
      } else {
        root.style.removeProperty("--whimsy-ui-font");
      }
    };
    fontUpdaters.set(win, update);
    Services.prefs.addObserver(FONT_PREF, update);
    Services.prefs.addObserver(FONT_FEATURE_PREF, update);
    win.addEventListener(
      "unload",
      () => {
        Services.prefs.removeObserver(FONT_PREF, update);
        Services.prefs.removeObserver(FONT_FEATURE_PREF, update);
      },
      { once: true }
    );
    update();
  },
};
