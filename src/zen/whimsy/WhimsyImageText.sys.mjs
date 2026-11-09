/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// W23 voice-image: text inside images (media-3.x), recognized on this Mac
// by WhimsyImageTextChild. This side keeps which images have text, shows
// the "Copied text from image" toast, finds words in images for ⌘F,
// offers "Copy text from image" and "Translate text in image" (the command
// bar, and ⌘K's image group when an image has text), and translates in
// place: Firefox Translations when it has the pair, else an AI provider
// when AI is on and the tab isn't private. Works with AI off.

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  LanguageDetector: "resource://gre/modules/translations/LanguageDetector.sys.mjs",
  TranslationsParent: "resource://gre/actors/TranslationsParent.sys.mjs",
  Translator: "chrome://global/content/translations/Translator.mjs",
  WhimsyAI: "resource:///modules/whimsy/WhimsyAI.sys.mjs",
  WhimsyAIContext: "resource:///modules/whimsy/WhimsyAIContext.sys.mjs",
  WhimsyAIHints: "resource:///modules/whimsy/WhimsyAIHints.sys.mjs",
  WhimsyAIRouter: "resource:///modules/whimsy/WhimsyAIRouter.sys.mjs",
  WhimsyAIViewShare: "resource:///modules/whimsy/WhimsyAIViewShare.sys.mjs",
  WhimsyCommands: "resource:///modules/whimsy/WhimsyCommands.sys.mjs",
  WhimsyFindCard: "resource:///modules/whimsy/WhimsyFindCard.sys.mjs",
  WhimsyVerbs: "resource:///modules/whimsy/WhimsyVerbs.sys.mjs",
});
ChromeUtils.defineLazyGetter(lazy, "l10n", () => new Localization(["browser/whimsy.ftl"], true));
ChromeUtils.defineLazyGetter(lazy, "clipboard", () => Cc["@mozilla.org/widget/clipboardhelper;1"].getService(Ci.nsIClipboardHelper));

const FEATURE = "image-text";
const ICON = "chrome://browser/content/whimsy/icons/image-text.svg";
const TRANSLATE_ICON = "chrome://browser/skin/zen-icons/translations.svg";
const CHECK_ICON = "chrome://browser/skin/zen-icons/check.svg";
const MAX_KNOWN = 300;
const TRANSLATE_SYSTEM =
  "Translate each line of text found in an image into the target language. Reply with only a JSON array of strings, one per line, in the same order. Keep numbers, times, and names as they are.";

// src -> {count, text, lang}; newest last, bounded.
const known = new Map();
// W23 secfix L5: recognized image text goes with Fire (any AI data
// cleared), Clear History, and the last private window closing.
const forget = () => known.clear();
Services.obs.addObserver(forget, "browser:purge-session-history");
Services.obs.addObserver(forget, "whimsy-ai-store-cleared");
Services.obs.addObserver(forget, "last-pb-context-exited");
// browser -> Set of srcs with text on its page.
const pages = new WeakMap();

function browserOf(actor) {
  return actor.browsingContext?.top?.embedderElement ?? null;
}

function windowOf(browser) {
  return browser?.ownerDocument?.defaultView ?? null;
}

function languageName(tag) {
  try {
    return new Intl.DisplayNames([Services.locale.appLocaleAsBCP47], { type: "language" }).of(tag) ?? tag;
  } catch {
    return tag;
  }
}

const primary = tag => String(tag ?? "").split("-")[0].toLowerCase();

export class WhimsyImageTextParent extends JSWindowActorParent {
  receiveMessage(message) {
    return WhimsyImageText.receive(this, message);
  }
}

export const WhimsyImageText = {
  // Tests: a stand-in recognizer, src -> [{text, quad: [[x, y] × 4]}]
  // (normalized, top left, top right, bottom right, bottom left) or null;
  // a stand-in translation engine, (lines, {from, to}) -> lines; and the
  // language to translate into.
  testRecognizer: null,
  testTranslate: null,
  testTargetLanguage: null,

  get enabled() {
    return Services.prefs.getBoolPref(`whimsy.feature.${FEATURE}`, true);
  },

  get supported() {
    return !!this.testRecognizer || (Services.appinfo.isTextRecognitionSupported && Services.prefs.getBoolPref("dom.text-recognition.enabled", false));
  },

  initWindow(win) {
    this.installHooks();
    lazy.WhimsyCommands.register(win, {
      id: "cmd_whimsyCopyImageText",
      l10nId: "whimsy-image-text-copy-command",
      icon: ICON,
      run: w => this.copyFromView(w),
      isAvailable: w => this.enabled && this.pageHasText(w.gBrowser.selectedBrowser),
    });
    lazy.WhimsyCommands.register(win, {
      id: "cmd_whimsyTranslateImageText",
      l10nId: "whimsy-image-text-translate-command",
      icon: TRANSLATE_ICON,
      run: w => this.translate(w),
      isAvailable: w => this.enabled && this.pageHasText(w.gBrowser.selectedBrowser),
    });
  },

  installHooks() {
    // ⌘K's view share asks which images have text (L07 doesn't import us).
    lazy.WhimsyAIViewShare.imageText = { hasText: src => this.hasText(src) };
    if (this._hooked) {
      return;
    }
    this._hooked = true;
    lazy.WhimsyFindCard.registerImageMatcher(({ browser, text }) => this.countInView(browser, text));
    lazy.WhimsyAIHints.register({ id: "image-text", isVisible: w => this.pageHasText(w.gBrowser?.selectedBrowser) });
    const withText = view => lazy.WhimsyAIViewShare.pickImages(view).find(image => this.hasText(image.src)) ?? null;
    lazy.WhimsyVerbs.registerVerb({
      id: "image-text:translate",
      group: "image",
      l10nId: "whimsy-image-text-translate-command",
      icon: TRANSLATE_ICON,
      isAvailable: (win, subject, view) => this.enabled && !!withText(view),
      tag: (win, subject, view) => this.pairLabel(withText(view)?.src),
      run: (w, subject) => {
        w.gURLBar.view.close();
        return this.translate(w, withText(subject?.view)?.src);
      },
    });
    lazy.WhimsyVerbs.registerVerb({
      id: "image-text:copy",
      group: "image",
      l10nId: "whimsy-image-text-copy-command",
      icon: ICON,
      isAvailable: (win, subject, view) => this.enabled && !!withText(view),
      run: (w, subject) => {
        w.gURLBar.view.close();
        return this.copyFromView(w, withText(subject?.view)?.src);
      },
    });
  },

  hasText(src) {
    return (known.get(src)?.count ?? 0) > 0;
  },

  pageHasText(browser) {
    return !!browser && (pages.get(browser)?.size ?? 0) > 0;
  },

  remember(src, lines) {
    known.delete(src);
    known.set(src, { count: lines.length, text: lines.join("\n"), lang: known.get(src)?.lang ?? null });
    while (known.size > MAX_KNOWN) {
      known.delete(known.keys().next().value);
    }
    if (lines.length) {
      this.detect(src);
    }
  },

  async detect(src) {
    const entry = known.get(src);
    if (!entry?.text) {
      return null;
    }
    try {
      const { language } = await lazy.LanguageDetector.detectLanguage(entry.text);
      entry.lang = language && language != "un" ? language : null;
    } catch {
      entry.lang = null;
    }
    return entry.lang;
  },

  async targetLanguage() {
    return this.testTargetLanguage ?? (await lazy.TranslationsParent.getTopPreferredSupportedToLang()) ?? Services.locale.appLocaleAsBCP47;
  },

  // "Japanese to English" for ⌘K's Translate row, once the language is known.
  pairLabel(src) {
    const from = known.get(src)?.lang;
    if (!from) {
      return undefined;
    }
    const to = this.testTargetLanguage ?? Services.locale.appLocaleAsBCP47;
    return lazy.l10n.formatValueSync("whimsy-image-text-pair", { from: languageName(from), to: languageName(primary(to)) });
  },

  receive(actor, { name, data }) {
    const browser = browserOf(actor);
    switch (name) {
      case "Whimsy:ImageText:Begin": {
        if (!this.enabled || !this.supported) {
          return { enabled: false };
        }
        const lines = this.testRecognizer ? (this.testRecognizer(String(data?.src ?? "")) ?? []) : null;
        return { enabled: true, lines };
      }
      case "Whimsy:ImageText:Found": {
        // Web content is untrusted: keep to what the child itself would send.
        const src = String(data?.src ?? "").slice(0, 4096);
        const lines = Array.isArray(data?.lines) ? data.lines.slice(0, 200).map(line => String(line).slice(0, 500)) : [];
        this.remember(src, lines);
        if (browser && lines.length && actor.browsingContext == actor.browsingContext.top) {
          if (!pages.has(browser)) {
            pages.set(browser, new Set());
          }
          pages.get(browser).add(src);
          const win = windowOf(browser);
          if (data.inView && win?.gBrowser?.selectedBrowser == browser) {
            lazy.WhimsyAIHints.request(win, "image-text");
          }
        }
        return null;
      }
      case "Whimsy:ImageText:Reset":
        if (browser && actor.browsingContext == actor.browsingContext.top) {
          pages.delete(browser);
        }
        return null;
      case "Whimsy:ImageText:Copied":
        this.toastCopied(windowOf(browser), Math.min(Math.max(Math.trunc(Number(data?.lines)) || 1, 1), 200));
        return null;
      case "Whimsy:ImageText:Used":
        lazy.WhimsyAIHints.used("image-text");
        return null;
    }
    return null;
  },

  actorFor(browser) {
    try {
      return browser?.browsingContext?.currentWindowGlobal?.getActor("WhimsyImageText") ?? null;
    } catch {
      return null;
    }
  },

  /** The images in view with text: [{imageId, src, lines: [{text, rect}]}], biggest first. */
  async recognizeInView(browser) {
    if (!this.enabled) {
      return [];
    }
    try {
      return (await this.actorFor(browser)?.sendQuery("Whimsy:ImageText:InView")) ?? [];
    } catch {
      return [];
    }
  },

  /** ⌘F: how many times `text` shows in images on screen. */
  async countInView(browser, text) {
    if (!this.enabled || !text) {
      return 0;
    }
    try {
      return Number(await this.actorFor(browser)?.sendQuery("Whimsy:ImageText:Count", { text })) || 0;
    } catch {
      return 0;
    }
  },

  async textOf(browser, src = null) {
    try {
      return (await this.actorFor(browser)?.sendQuery("Whimsy:ImageText:Text", { src })) ?? null;
    } catch {
      return null;
    }
  },

  toastCopied(win, count) {
    win?.gZenUIManager?.toasts?.open("whimsy-image-text-copied", {
      key: "whimsy-image-text-copied",
      icon: CHECK_ICON,
      descriptionId: "whimsy-image-text-copied-lines",
      descriptionArgs: { count },
    });
    lazy.WhimsyAIHints.used("image-text");
  },

  /** Copies all the text of the image in view (or `src`) and says so. */
  async copyFromView(win, src = null) {
    const found = await this.textOf(win.gBrowser.selectedBrowser, src);
    if (!found?.lines?.length) {
      win.gZenUIManager?.showToast?.("whimsy-image-text-none");
      return false;
    }
    lazy.clipboard.copyString(found.lines.join("\n"));
    this.toastCopied(win, found.lines.length);
    return true;
  },

  /** Covers each line of the image in view (or `src`) with its translation. */
  async translate(win, src = null) {
    const browser = win.gBrowser.selectedBrowser;
    const found = await this.textOf(browser, src);
    if (!found?.lines?.length) {
      win.gZenUIManager?.showToast?.("whimsy-image-text-none");
      return false;
    }
    if (!known.get(found.src)?.lang) {
      this.remember(found.src, found.lines);
      await this.detect(found.src);
    }
    const from = known.get(found.src)?.lang;
    const to = primary(await this.targetLanguage());
    let lines = null;
    if (from && primary(from) != to) {
      lines = await this.translateOnDevice(found.lines, from, to);
      if (!lines && lazy.WhimsyAI.enabled && !lazy.WhimsyAIContext.isPrivate(win.gBrowser.selectedTab)) {
        lines = await this.translateWithAI(found.lines, to);
      }
    }
    if (!lines) {
      win.gZenUIManager?.showToast?.("whimsy-image-text-translate-failed");
      return false;
    }
    const [label, showOriginal, showTranslation] = await lazy.l10n.formatValues([
      { id: "whimsy-image-text-translated-from", args: { language: languageName(from) } },
      { id: "whimsy-image-text-show-original" },
      { id: "whimsy-image-text-show-translation" },
    ]);
    try {
      return !!(await this.actorFor(browser)?.sendQuery("Whimsy:ImageText:Translate", { imageId: found.imageId, lines, label, showOriginal, showTranslation }));
    } catch {
      return false;
    }
  },

  async translateOnDevice(lines, from, to) {
    if (this.testTranslate) {
      return (await this.testTranslate(lines, { from, to }))?.map(String) ?? null;
    }
    let translator = null;
    try {
      if (!Services.prefs.getBoolPref("browser.translations.enable", true) || !lazy.TranslationsParent.getIsTranslationsEngineSupported()) {
        return null;
      }
      const source = await lazy.TranslationsParent.findCompatibleSourceLangTag(from);
      if (!source) {
        return null;
      }
      translator = await lazy.Translator.create({
        languagePair: { sourceLanguage: source, targetLanguage: to },
        requestTranslationsPort: pair => lazy.TranslationsParent.requestTranslationsPort(pair),
        allowSameLanguage: true,
      });
      const out = [];
      for (const line of lines) {
        out.push(String((await translator.translate(line)) ?? line));
      }
      return out;
    } catch (e) {
      console.error("Whimsy: image text translation", e);
      return null;
    } finally {
      translator?.destroy?.();
    }
  },

  async translateWithAI(lines, to) {
    try {
      const result = await lazy.WhimsyAIRouter.run({
        task: "translate",
        system: TRANSLATE_SYSTEM,
        messages: [{ role: "user", content: `Target language: ${languageName(to)}\n\n${JSON.stringify(lines)}` }],
      });
      const match = String(result?.text ?? "").match(/\[[\s\S]*\]/);
      const parsed = match ? JSON.parse(match[0]) : null;
      return Array.isArray(parsed) && parsed.length == lines.length ? parsed.map(String) : null;
    } catch (e) {
      console.error("Whimsy: image text translation by AI", e);
      return null;
    }
  },
};
