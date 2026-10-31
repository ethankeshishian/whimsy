/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// w7native: live captions for videos without any. When CC (the speed
// control) finds no captions, WhimsyCaptionsChild taps the video's audio
// (nsIWhimsyAudioTap, in the content process) and sends it here a few times
// a second; Apple's speech recognizer turns it into text on this Mac
// (nsIWhimsySpeech, src/zen/whimsy/speech, requiresOnDeviceRecognition) and
// the text goes back to the caption box, which translates it like any
// other caption (WhimsyCaptions). Like Chrome's Live Caption, but in your
// language.
//
// Nothing runs until someone turns CC on for a video without captions; the
// first time, macOS asks for Speech Recognition access. Only locales with
// an on-device model (Dictation's languages) are used: no audio leaves the
// Mac. A content process can feed and stop only the sessions it started.

const FEATURE_PREF = "whimsy.feature.video-speech-captions";
const CAPTIONS_PREF = "whimsy.feature.video-captions";
// From a content process: at most 2 s of 48 kHz audio per message.
const MAX_SAMPLES = 96000;
const MAX_TEXT = 2000;
const LANG_RE = /^[a-zA-Z]{2,3}([-_][a-zA-Z0-9]{1,8})*$/;

const normal = tag => String(tag || "").replace(/_/g, "-");
const primary = tag => normal(tag).split("-")[0].toLowerCase();

/**
 * The recognizer locale for the first wanted language that has one: an
 * exact match ("en-GB"), else the same language in the region of the first
 * wanted tag that names one, else the first locale of that language.
 */
export function pickLocale(available, wanted) {
  const locales = (Array.isArray(available) ? available : []).map(normal).filter(Boolean);
  const tags = (Array.isArray(wanted) ? wanted : []).map(normal).filter(tag => LANG_RE.test(tag));
  for (const tag of tags) {
    const exact = locales.find(locale => locale.toLowerCase() == tag.toLowerCase());
    if (exact) {
      return exact;
    }
  }
  const region = tags.map(tag => tag.split("-")[1]).find(part => part && /^[a-zA-Z]{2}$/.test(part));
  for (const tag of tags) {
    const same = locales.filter(locale => primary(locale) == primary(tag));
    if (same.length) {
      return same.find(locale => region && locale.split("-")[1]?.toLowerCase() == region.toLowerCase()) ?? same[0];
    }
  }
  return null;
}

export const WhimsyLiveSpeech = {
  // For tests: a stand-in for nsIWhimsySpeech (authorizationStatus,
  // requestAccess, onDeviceLocales, start).
  testSpeech: null,

  // id -> { actor, session }
  sessions: new Map(),
  nextId: 1,

  get enabled() {
    return Services.prefs.getBoolPref(FEATURE_PREF, true) && Services.prefs.getBoolPref(CAPTIONS_PREF, true);
  },

  speech() {
    if (this.testSpeech) {
      return this.testSpeech;
    }
    try {
      const cls = Cc["@whimsy/speech;1"];
      return cls ? cls.getService(Ci.nsIWhimsySpeech) : null;
    } catch {
      return null;
    }
  },

  // The authorization status, asking macOS the first time.
  async access(speech) {
    let status = speech.authorizationStatus;
    if (status == "notDetermined") {
      status = await new Promise(resolve => {
        try {
          speech.requestAccess((granted, result) => resolve(String(result)));
        } catch {
          resolve("failed");
        }
      });
    }
    return status;
  },

  wantedLanguages(hint) {
    const tags = [];
    if (typeof hint == "string" && LANG_RE.test(hint)) {
      tags.push(hint);
    }
    try {
      tags.push(Services.locale.appLocaleAsBCP47, ...Services.locale.regionalPrefsLocales, ...Services.locale.requestedLocales);
    } catch {}
    return tags;
  },

  // { lang } -> { id, lang } or { error: "off" | "unavailable" | "denied" }.
  async start(actor, { lang } = {}) {
    if (!this.enabled) {
      return { error: "off" };
    }
    const speech = this.speech();
    if (!speech) {
      return { error: "unavailable" };
    }
    let status;
    try {
      status = await this.access(speech);
    } catch {
      status = "failed";
    }
    if (status != "authorized") {
      return { error: status == "denied" || status == "restricted" ? "denied" : "unavailable" };
    }
    let locales = [];
    try {
      locales = speech.onDeviceLocales;
    } catch {}
    const locale = pickLocale(locales, this.wantedLanguages(lang));
    if (!locale) {
      return { error: "unavailable" };
    }

    const id = this.nextId++;
    const listener = {
      QueryInterface: ChromeUtils.generateQI(["nsIWhimsySpeechListener"]),
      onText: (text, isFinal) => {
        this.send(id, "WhimsyCaptions:SpeechText", { id, text: String(text ?? "").slice(-MAX_TEXT), final: !!isFinal });
      },
      onError: reason => {
        this.send(id, "WhimsyCaptions:SpeechError", { id, reason: String(reason) });
        this.sessions.delete(id);
      },
    };
    let session;
    try {
      session = speech.start(locale, listener);
    } catch (e) {
      return { error: "unavailable" };
    }
    this.sessions.set(id, { actor, session });
    return { id, lang: locale };
  },

  send(id, name, data) {
    const entry = this.sessions.get(id);
    if (!entry) {
      return;
    }
    try {
      entry.actor.sendAsyncMessage(name, data);
    } catch {
      // The tab went away; didDestroy stops the session.
    }
  },

  audio(actor, { id, rate, samples } = {}) {
    const entry = this.sessions.get(id);
    if (!entry || entry.actor !== actor || !this.enabled) {
      return;
    }
    rate = Number(rate);
    if (!Number.isInteger(rate) || rate < 8000 || rate > 192000) {
      return;
    }
    if (!(samples instanceof Float32Array) && !Array.isArray(samples)) {
      return;
    }
    const list = Array.from(samples.length > MAX_SAMPLES ? samples.slice(-MAX_SAMPLES) : samples, x =>
      Number.isFinite(x) ? Math.max(-1, Math.min(1, x)) : 0
    );
    if (!list.length) {
      return;
    }
    try {
      entry.session.appendAudio(list, rate);
    } catch (e) {
      console.error("Whimsy live captions: audio refused", e);
    }
  },

  stop(actor, { id } = {}) {
    const entry = this.sessions.get(id);
    if (!entry || entry.actor !== actor) {
      return;
    }
    this.sessions.delete(id);
    try {
      entry.session.stop();
    } catch {}
  },

  // The tab or frame went away.
  stopAll(actor) {
    for (const [id, entry] of [...this.sessions]) {
      if (entry.actor === actor) {
        this.stop(actor, { id });
      }
    }
  },
};
