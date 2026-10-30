/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// fixC: Whimsy's two look choices in Zen's first-run onboarding
// (whimsy.feature.welcome-look).
//
// Zen's onboarding (src/zen/welcome/ZenWelcome.mjs) walks through a few
// one-question pages: import, space colors, search engine, ad blocking,
// Essentials, default browser. Each page is a title, a line of copy and a
// column of big radio cards, with Next at the bottom of the sidebar, and
// the cards slide in with the page. Whimsy adds two pages of exactly that
// shape right after "Your space, your colors.", because they are the same
// kind of choice (how the browser looks) and Zen's colors page is where
// the window starts showing the space's gradient:
//
// - Transparency (whimsy.look.transparency, macOS only): solid, a little,
//   a lot. Picking one applies it at once; around the onboarding card the
//   window's own background fades and the blurred desktop shows through,
//   so the choice previews itself. Settings → Look and Feel has the full
//   slider.
// - Interface font (whimsy.look.ui-font): the system font plus a few
//   families every Mac has, each card set in its own font. Picking one
//   switches the whole window's text, onboarding included.
//
// ZenWelcome.mjs keeps its pages in a closure, so one overlay hook
// (whimsy/overlay.py, "welcome-pages") hands the list to extendPages() as
// the pages object is built, along with Zen's own createOption() and Next
// button so the cards and buttons are Zen's, not look-alikes.

const FEATURE_PREF = "whimsy.feature.welcome-look";
const TRANSPARENCY_FEATURE_PREF = "whimsy.feature.transparency";
const TRANSPARENCY_PREF = "whimsy.look.transparency";
const FONT_FEATURE_PREF = "whimsy.feature.ui-font";
const FONT_PREF = "whimsy.look.ui-font";

// Within Settings' 0–80 % slider.
export const TRANSPARENCY_LEVELS = [
  { id: "solid", value: 0, l10n: "whimsy-welcome-transparency-solid" },
  { id: "subtle", value: 20, l10n: "whimsy-welcome-transparency-subtle" },
  { id: "glassy", value: 45, l10n: "whimsy-welcome-transparency-glassy" },
];

// Shipped with macOS; shown only when installed. "" is the system font.
export const FONT_CHOICES = ["", "Avenir Next", "Georgia", "Menlo"];

function featureOn(pref) {
  return Services.prefs.getBoolPref(pref, true);
}

function setIntOrClear(pref, value) {
  if (value == Services.prefs.getDefaultBranch("").getIntPref(pref, 0)) {
    Services.prefs.clearUserPref(pref);
  } else {
    Services.prefs.setIntPref(pref, value);
  }
}

export const WhimsyWelcome = {
  get featureOn() {
    return featureOn(FEATURE_PREF);
  },

  // Only macOS draws the blurred material behind the window (as in Settings).
  get transparencySupported() {
    return this.featureOn && featureOn(TRANSPARENCY_FEATURE_PREF) && Services.appinfo.OS == "Darwin";
  },

  get fontSupported() {
    return this.featureOn && featureOn(FONT_FEATURE_PREF);
  },

  // Called by the overlay hook with Zen's page list; returns the list to use.
  extendPages(win, pages, helpers) {
    try {
      if (!this.featureOn || !Array.isArray(pages) || pages.some(page => page?.id?.startsWith("whimsy-"))) {
        return pages;
      }
      const added = [this.transparencyPage(helpers), this.fontPage(win, helpers)];
      const result = [...pages];
      let at = result.findIndex(page => page?.id == "colors");
      if (at < 0) {
        at = result.findIndex(page => page?.id == "finish") - 1;
      }
      result.splice(at < 0 ? result.length : at + 1, 0, ...added);
      return result;
    } catch (e) {
      console.error("Whimsy: onboarding", e);
      return pages;
    }
  },

  // The level closest to the current setting.
  currentLevel() {
    const value = Services.prefs.getIntPref(TRANSPARENCY_PREF, 0);
    return TRANSPARENCY_LEVELS.reduce((best, level) =>
      Math.abs(level.value - value) < Math.abs(best.value - value) ? level : best
    );
  },

  transparencyPage({ createOption, kNextButton }) {
    const self = this;
    const group = "whimsy-welcome-transparency";
    return {
      id: "whimsy-transparency",
      title: "whimsy-welcome-transparency-title",
      descriptions: ["whimsy-welcome-transparency-description"],
      buttons: [kNextButton],
      skip() {
        return !self.transparencySupported;
      },
      render(content) {
        const current = self.currentLevel();
        for (const level of TRANSPARENCY_LEVELS) {
          const option = createOption({
            id: `${group}-${level.id}`,
            group,
            l10n: level.l10n,
            checked: level == current,
          });
          const input = option.querySelector("input");
          input.value = String(level.value);
          // Live: the window around the card fades as you pick.
          input.addEventListener("change", () => setIntOrClear(TRANSPARENCY_PREF, level.value));
          content.appendChild(option);
        }
      },
      commit(content) {
        const checked = content.querySelector(`input[name="${group}"]:checked`);
        if (checked) {
          setIntOrClear(TRANSPARENCY_PREF, parseInt(checked.value, 10) || 0);
        }
      },
    };
  },

  async installedFonts() {
    const families = new Set();
    try {
      const enumerator = Cc["@mozilla.org/gfx/fontenumerator;1"].getService(Ci.nsIFontEnumerator);
      for (const family of await enumerator.EnumerateAllFontsAsync()) {
        families.add(family);
      }
    } catch (e) {
      console.error("Whimsy: onboarding fonts", e);
    }
    return FONT_CHOICES.filter(family => !family || families.has(family));
  },

  fontPage(win, { createOption, kNextButton }) {
    const self = this;
    const group = "whimsy-welcome-font";
    return {
      id: "whimsy-font",
      title: "whimsy-welcome-font-title",
      // wave5/look: mention, never ask, that each space can differ.
      descriptions: [
        "whimsy-welcome-font-description",
        ...(Services.prefs.getBoolPref("whimsy.feature.space-look", true) ? ["whimsy-welcome-font-per-space"] : []),
      ],
      buttons: [kNextButton],
      skip() {
        return !self.fontSupported;
      },
      async render(content) {
        const fonts = await self.installedFonts();
        if (!content.isConnected) {
          // Already left this page.
          return;
        }
        const current = Services.prefs.getStringPref(FONT_PREF, "");
        const choices = fonts.includes(current) ? fonts : [...fonts, current];
        choices.forEach((family, index) => {
          const option = createOption({
            id: `${group}-${index}`,
            group,
            l10n: family ? null : "whimsy-welcome-font-system",
            text: family,
            checked: family == current,
          });
          const input = option.querySelector("input");
          input.value = family;
          // Each card in its own font (whimsy-browser.css leaves
          // .whimsy-font-preview out of the interface-font rule).
          const label = option.querySelector(".zen-welcome-option-label");
          label?.classList.add("whimsy-font-preview");
          label?.style.setProperty("font-family", family ? `"${family}", system-ui` : "system-ui");
          // Live: the whole window, onboarding included, switches font.
          input.addEventListener("change", () => self.setFont(family));
          content.appendChild(option);
        });
      },
      commit(content) {
        const checked = content.querySelector(`input[name="${group}"]:checked`);
        if (checked) {
          self.setFont(checked.value);
        }
      },
    };
  },

  setFont(family) {
    if (family) {
      Services.prefs.setStringPref(FONT_PREF, family);
    } else {
      Services.prefs.clearUserPref(FONT_PREF);
    }
  },
};
