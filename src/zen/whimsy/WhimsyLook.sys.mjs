/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Look and feel options that need a little script (the CSS lives in
// whimsy-browser.css). Each part checks its whimsy.feature.<id> switch.
//
// Hex colors (whimsy.feature.hex-colors): Zen's theme picker can add a
// custom color, but only through the system color well, so a brand color
// you already know ("#5B8CFF") had to be eyeballed. Arc's and Figma's
// pickers take a typed or pasted hex. A field next to the well now does:
// type or paste #RGB, #RRGGBB or #RRGGBBAA (the # is optional), the well
// follows as you type, and Enter (or Zen's + button) adds it. The well
// writes its pick back into the field. Whimsy also shows Zen's custom
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

const HEX_FEATURE_PREF = "whimsy.feature.hex-colors";
const FONT_FEATURE_PREF = "whimsy.feature.ui-font";
const FONT_PREF = "whimsy.look.ui-font";
const TRANSPARENCY_FEATURE_PREF = "whimsy.feature.transparency";
const TRANSPARENCY_PREF = "whimsy.look.transparency";
export const MAX_TRANSPARENCY = 80;
const GLASS_FEATURE_PREF = "whimsy.feature.liquid-glass";
const GLASS_PREF = "whimsy.look.liquid-glass";
export const GLASS_TRANSPARENCY = 35;
const HEX_INPUT_ID = "whimsy-hex-input";

// wave5/look: a space's own font per window (WhimsySpaceLook): a family,
// "" for the system font; no entry follows Settings.
const spaceFonts = new WeakMap();
const fontUpdaters = new WeakMap();

function featureOn(pref) {
  return Services.prefs.getBoolPref(pref, true);
}

// "#abc", "abc", "#aabbcc", "#aabbccdd" → { rgb: "#aabbcc", alpha: 0..1 },
// else null.
export function parseHex(text) {
  const match = /^#?([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(String(text ?? "").trim());
  if (!match) {
    return null;
  }
  let hex = match[1].toLowerCase();
  if (hex.length <= 4) {
    hex = [...hex].map(c => c + c).join("");
  }
  const alpha = hex.length == 8 ? Math.round((parseInt(hex.slice(6), 16) / 255) * 100) / 100 : 1;
  return { rgb: `#${hex.slice(0, 6)}`, alpha };
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
    run("hex-colors", () => this.initHexInput(win));
    run("transparency", () => this.initTransparency(win));
    run("ui-font", () => this.initFont(win));
  },

  // --- Hex colors ---

  initHexInput(win) {
    const { document } = win;
    const well = document.getElementById("PanelUI-zen-gradient-generator-custom-input");
    const opacity = document.getElementById("PanelUI-zen-gradient-generator-custom-opacity");
    if (!well || document.getElementById(HEX_INPUT_ID)) {
      return;
    }
    const field = document.createElementNS("http://www.w3.org/1999/xhtml", "input");
    field.id = HEX_INPUT_ID;
    field.type = "text";
    field.setAttribute("spellcheck", "false");
    field.setAttribute("autocomplete", "off");
    field.setAttribute("maxlength", "9");
    document.l10n.setAttributes(field, "whimsy-hex-input");
    well.after(field);

    const sync = () => {
      const text = field.value.trim();
      const parsed = parseHex(text);
      field.toggleAttribute("invalid", !!text && !parsed);
      field.setAttribute("aria-invalid", String(!!text && !parsed));
      if (parsed) {
        well.value = parsed.rgb;
        // #RRGGBBAA carries its own opacity; plain hex means opaque.
        if (opacity) {
          opacity.value = parsed.alpha;
        }
      }
      return parsed;
    };
    field.addEventListener("input", sync);
    field.addEventListener("keydown", event => {
      if (event.key != "Enter") {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      if (sync()) {
        win.gZenThemePicker?.addCustomColor();
        field.value = "";
        field.removeAttribute("invalid");
      }
    });
    // The well's own pick shows up in the field.
    const fromWell = () => {
      field.value = well.value.toUpperCase();
      field.removeAttribute("invalid");
    };
    well.addEventListener("input", fromWell);
    well.addEventListener("change", fromWell);
    // Zen's + button adds the well's color and clears the well; the field
    // clears with it so it never shows a color that's no longer pending.
    const add = document.getElementById("PanelUI-zen-gradient-generator-color-custom-add");
    if (add) {
      document.l10n.setAttributes(add, "whimsy-hex-add");
      add.addEventListener("command", () => {
        field.value = "";
        field.removeAttribute("invalid");
      });
    }

    const panel = document.getElementById("PanelUI-zen-gradient-generator");
    panel?.addEventListener("popupshowing", event => {
      if (event.target == panel) {
        field.value = "";
        field.removeAttribute("invalid");
      }
    });
    const update = () => (field.hidden = !featureOn(HEX_FEATURE_PREF));
    Services.prefs.addObserver(HEX_FEATURE_PREF, update);
    win.addEventListener("unload", () => Services.prefs.removeObserver(HEX_FEATURE_PREF, update), { once: true });
    update();
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
