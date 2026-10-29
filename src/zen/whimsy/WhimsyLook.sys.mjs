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

const HEX_FEATURE_PREF = "whimsy.feature.hex-colors";
const TRANSPARENCY_FEATURE_PREF = "whimsy.feature.transparency";
const TRANSPARENCY_PREF = "whimsy.look.transparency";
export const MAX_TRANSPARENCY = 80;
const HEX_INPUT_ID = "whimsy-hex-input";

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

  // The chosen transparency in percent, 0 when off or unsupported.
  transparency() {
    if (!featureOn(TRANSPARENCY_FEATURE_PREF)) {
      return 0;
    }
    const value = Services.prefs.getIntPref(TRANSPARENCY_PREF, 0);
    return Math.min(MAX_TRANSPARENCY, Math.max(0, value));
  },

  initTransparency(win) {
    const root = win.document.documentElement;
    const update = () => {
      const value = this.transparency();
      root.toggleAttribute("whimsy-transparency", value > 0);
      root.style.setProperty("--whimsy-chrome-opacity", String(1 - value / 100));
    };
    Services.prefs.addObserver(TRANSPARENCY_PREF, update);
    Services.prefs.addObserver(TRANSPARENCY_FEATURE_PREF, update);
    win.addEventListener(
      "unload",
      () => {
        Services.prefs.removeObserver(TRANSPARENCY_PREF, update);
        Services.prefs.removeObserver(TRANSPARENCY_FEATURE_PREF, update);
      },
      { once: true }
    );
    update();
  },
};
