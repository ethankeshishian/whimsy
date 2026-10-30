/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// wave5/captions: translates a video's captions into your language, on this
// Mac, with Firefox Translations (the same engine and models as page
// translation; a language's model downloads the first time it's needed).
// WhimsyCaptionsChild reads the cues and draws them; it asks for each cue's
// translation through the speed control's actor (WhimsyVideoSpeedParent).
//
// The target is your first preferred language Translations supports (the
// one full-page translation offers). The source is the track's own language
// (srclang) when it has one, otherwise detected from a sample of its cues.

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  LanguageDetector: "resource://gre/modules/translations/LanguageDetector.sys.mjs",
  TranslationsParent: "resource://gre/actors/TranslationsParent.sys.mjs",
  Translator: "chrome://global/content/translations/Translator.mjs",
});

const FEATURE_PREF = "whimsy.feature.video-captions";
const TRANSLATIONS_PREF = "browser.translations.enable";
const MAX_TEXT = 2000;
const MAX_SAMPLE = 4000;

const primary = tag => String(tag).split("-")[0].toLowerCase();

// "es" and "es-ES" match; "zh-Hans" and "zh-Hant" don't.
export function sameLanguage(a, b) {
  if (!a || !b) {
    return false;
  }
  if (a.toLowerCase() == b.toLowerCase()) {
    return true;
  }
  return primary(a) == primary(b) && !(a.includes("-") && b.includes("-"));
}

export const WhimsyCaptions = {
  // For tests: a fake engine, (text, { from, to }) => Promise<string>, and
  // the language to translate into. Neither touches Remote Settings.
  testTranslate: null,
  testTargetLanguage: null,

  // The one live translator ({ key, promise }); a new language pair replaces it.
  translator: null,

  get enabled() {
    return Services.prefs.getBoolPref(FEATURE_PREF, true) && Services.prefs.getBoolPref(TRANSLATIONS_PREF, true);
  },

  targetLanguage() {
    return this.testTargetLanguage ?? lazy.TranslationsParent.getTopPreferredSupportedToLang();
  },

  // The language to translate from, normalised to one Translations knows, or
  // null when it can't translate from it. `confident` says whether it's
  // worth remembering for the rest of the video.
  async sourceLanguage(hint, sample) {
    if (hint) {
      const tag = this.testTranslate ? hint : await lazy.TranslationsParent.findCompatibleSourceLangTag(hint);
      return { from: tag, confident: true };
    }
    if (!sample) {
      return { from: null, confident: false };
    }
    const detected = await lazy.LanguageDetector.detectLanguage(sample);
    const tag = this.testTranslate
      ? detected.language
      : await lazy.TranslationsParent.findCompatibleSourceLangTag(detected.language);
    return { from: tag, confident: !!detected.confident };
  },

  getTranslator(from, to) {
    const key = `${from}>${to}`;
    if (this.translator?.key != key) {
      const previous = this.translator;
      this.translator = {
        key,
        promise: lazy.Translator.create({
          languagePair: { sourceLanguage: from, targetLanguage: to },
          requestTranslationsPort: pair => lazy.TranslationsParent.requestTranslationsPort(pair),
          allowSameLanguage: true,
        }),
      };
      previous?.promise.then(t => t.destroy()).catch(() => {});
      // A failed engine isn't kept: the next cue tries again.
      const current = this.translator;
      current.promise.catch(() => {
        if (this.translator == current) {
          this.translator = null;
        }
      });
    }
    return this.translator.promise;
  },

  // { text, lang, sample } → { text, from, to, same, confident } or { error }.
  // `lang` is the track's language (or the one detected earlier); `sample`
  // is a few cues' text to detect it from when there's none.
  async translate({ text, lang, sample } = {}) {
    if (!this.enabled) {
      return { error: "off" };
    }
    if (typeof text != "string" || !text.trim()) {
      return { text: "" };
    }
    // From a content process: a caption's worth of text, never a book.
    text = text.slice(0, MAX_TEXT);
    sample = typeof sample == "string" ? sample.slice(0, MAX_SAMPLE) : null;
    lang = typeof lang == "string" && /^[a-zA-Z]{2,3}(-[a-zA-Z0-9]{1,8})*$/.test(lang) ? lang : null;
    try {
      if (!this.testTranslate && !lazy.TranslationsParent.getIsTranslationsEngineSupported()) {
        return { error: "unsupported" };
      }
      const to = await this.targetLanguage();
      const { from, confident } = await this.sourceLanguage(lang, sample || text);
      if (!from) {
        return { error: "unsupported-language", to };
      }
      if (sameLanguage(from, to)) {
        return { text, from, to, same: true, confident };
      }
      const translated = this.testTranslate
        ? await this.testTranslate(text, { from, to })
        : await (await this.getTranslator(from, to)).translate(text);
      return { text: String(translated ?? ""), from, to, confident };
    } catch (e) {
      console.error("Whimsy captions: translation failed", e);
      return { error: "failed" };
    }
  },
};
