/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// wave5/captions: live translated captions. "CC" in the speed control
// (WhimsyVideoSpeedChild) turns them on for that video: its captions show
// in your language, translated on this Mac by Firefox Translations
// (WhimsyCaptions, in the parent). Like YouTube's auto-translate, but for
// any video with captions, and nothing leaves the Mac.
//
// Where the captions come from:
// - the video's own text tracks (<track> WebVTT, or tracks a player adds):
//   the showing one, else the first subtitles/captions track. It's set to
//   "hidden" so its cues still load and fire cuechange but the browser
//   doesn't draw them under ours; turning CC off puts its mode back.
// - YouTube's own captions (they're drawn in the page, not text tracks):
//   CC turns on YouTube's subtitles if needed, reads its caption lines and
//   hides YouTube's box while ours shows.
// Otherwise CC says there are no captions to translate.
//
// The captions are drawn in the speed control's anonymous content, in
// Reader View's typeface (reader.font_type), on a dark plate near the
// bottom of the video. Drag them anywhere over the video (the place is
// kept, relative to the video, through resizes and fullscreen);
// double-click puts them back.
//
// Deferred: captions for videos that have none (speech to text with Apple's
// on-device SFSpeechRecognizer, requiresOnDeviceRecognition). The audio
// can't be tapped from here: captureStream()/mozCaptureStream() and
// AudioContext.createMediaElementSource() run under the page's principal,
// so cross-origin media without CORS (most CDN video) and EME media
// (Netflix, Disney+) give silence, and createMediaElementSource reroutes the
// page's own audio. It needs an engine patch (whimsy-*.patch under
// src/dom/media/): a chrome-only HTMLMediaElement method that registers an
// audio tap on the element's AudioSink/DecodedStream (after decode, before
// output, principal-checked against the system principal only, never for
// EME), posting downmixed 16 kHz mono PCM to a chrome callback; then a
// native component like src/zen/whimsy/calendar (nsIWhimsySpeech,
// Objective-C++, Speech.framework, NSSpeechRecognitionUsageDescription in
// Info.plist) running SFSpeechAudioBufferRecognitionRequest in the parent,
// with the PCM sent over the actor; its partial results feed the same
// translate-and-draw path as cues.

import { clearTimeout, setTimeout } from "resource://gre/modules/Timer.sys.mjs";

const lazy = {};
ChromeUtils.defineLazyGetter(lazy, "l10n", () => new Localization(["browser/whimsy.ftl"], true));

export const CAPTIONS_PREF = "whimsy.feature.video-captions";
const NOTICE_MS = 3000;
const CACHE_LIMIT = 300;
// Cues sampled to detect a track's language when it doesn't say.
const SAMPLE_CUES = 30;
const KINDS = ["subtitles", "captions"];
// Where the captions sit by default: centred, this far up from the bottom
// of the video (a fraction of its height).
const BOTTOM = 0.07;

const ENTITIES = { amp: "&", lt: "<", gt: ">", nbsp: " ", lrm: "‎", rlm: "‏" };

// A cue's plain text: WebVTT tags (<v Bob>, <i>, <c.x>, timestamps) dropped
// and its escapes decoded. "<v Bob>Hi &amp; bye</v>" reads "Hi & bye".
export function cueText(raw) {
  return String(raw ?? "")
    .replace(/<[^>]*>/g, "")
    .replace(/&(amp|lt|gt|nbsp|lrm|rlm);/g, (_, name) => ENTITIES[name])
    .split("\n")
    .map(line => line.trim())
    .filter(Boolean)
    .join("\n");
}

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

export class VideoCaptions {
  // The video whose captions show, and where they come from.
  video = null;
  source = null;
  // The original text on screen, and its translations so far.
  text = "";
  cache = new Map();
  // The language the captions are in, once known.
  from = null;
  // Per video: the dragged place, as fractions of the video's size.
  offsets = new WeakMap();
  dragging = null;

  constructor(actor) {
    this.actor = actor;
  }

  static get enabled() {
    return Services.prefs.getBoolPref(CAPTIONS_PREF, true);
  }

  get els() {
    return this.actor.els;
  }

  get win() {
    return this.actor.contentWindow;
  }

  isOn(video) {
    return !!video && this.video == video;
  }

  toggle(video) {
    if (this.isOn(video)) {
      this.stop();
    } else {
      this.start(video);
    }
  }

  start(video) {
    this.stop();
    if (!video || !this.els) {
      return false;
    }
    this.video = video;
    this.from = null;
    this.failed = false;
    this.cache.clear();
    this.source = this.trackSource(video) ?? this.siteSource(video);
    if (!this.source) {
      this.video = null;
      this.notice(this.strings.none, video);
      return false;
    }
    this.applyTypography();
    this.win.addEventListener("scroll", this, { capture: true, passive: true });
    this.win.addEventListener("resize", this);
    this.listening = true;
    this.update();
    return true;
  }

  stop() {
    const source = this.source;
    this.source = null;
    this.video = null;
    this.text = "";
    this.dragging = null;
    try {
      if (source?.kind == "track") {
        source.track.removeEventListener("cuechange", this);
        source.track.mode = source.mode;
      } else if (source?.kind == "site") {
        source.observer.disconnect();
        for (const el of source.hidden) {
          el.style.visibility = "";
        }
        // Turned on by us: turned off again, so YouTube remembers what you had.
        if (source.pressed && source.button.getAttribute("aria-pressed") == "true") {
          source.button.click();
        }
      }
      if (this.listening) {
        this.win?.removeEventListener("scroll", this, { capture: true });
        this.win?.removeEventListener("resize", this);
      }
    } catch (e) {
      // The page is going away.
    }
    this.listening = false;
    this.show("");
  }

  handleEvent(event) {
    switch (event.type) {
      case "cuechange":
        this.update();
        break;
      case "scroll":
      case "resize":
        this.schedulePlace();
        break;
    }
  }

  // --- Sources ---

  trackSource(video) {
    const list = video.textTracks;
    const tracks = [];
    for (let i = 0; i < (list?.length ?? 0); i++) {
      if (KINDS.includes(list[i].kind)) {
        tracks.push(list[i]);
      }
    }
    if (!tracks.length) {
      return null;
    }
    const track = tracks.find(t => t.mode == "showing") ?? tracks[0];
    const source = { kind: "track", track, mode: track.mode, lang: track.language || null };
    track.mode = "hidden";
    track.addEventListener("cuechange", this);
    return source;
  }

  // YouTube draws its captions in the page (.ytp-caption-segment), not as
  // text tracks.
  siteSource(video) {
    const player = video.closest?.(".html5-video-player");
    const button = player?.querySelector(".ytp-subtitles-button");
    if (!button || button.getAttribute("aria-disabled") == "true" || button.style.display == "none") {
      return null;
    }
    const source = { kind: "site", player, button, pressed: false, hidden: new Set(), lang: null };
    if (button.getAttribute("aria-pressed") != "true") {
      button.click();
      source.pressed = true;
    }
    source.observer = new this.win.MutationObserver(() => this.scheduleUpdate());
    source.observer.observe(player, { childList: true, subtree: true, characterData: true });
    return source;
  }

  currentText() {
    const source = this.source;
    if (source?.kind == "track") {
      const cues = source.track.activeCues;
      const lines = [];
      for (let i = 0; i < (cues?.length ?? 0); i++) {
        lines.push(cueText(cues[i].text));
      }
      return lines.filter(Boolean).join("\n");
    }
    if (source?.kind == "site") {
      for (const box of source.player.querySelectorAll(".ytp-caption-window-container")) {
        if (!source.hidden.has(box)) {
          source.hidden.add(box);
          box.style.visibility = "hidden";
        }
      }
      let lines = [...source.player.querySelectorAll(".caption-visual-line")];
      if (!lines.length) {
        lines = [...source.player.querySelectorAll(".ytp-caption-segment")];
      }
      return lines
        .map(line => line.textContent.trim())
        .filter(Boolean)
        .join("\n");
    }
    return "";
  }

  // A few cues' text, to detect the language from when the track doesn't
  // say (one short cue is too little to tell).
  sample() {
    const cues = this.source?.kind == "track" ? this.source.track.cues : null;
    if (!cues?.length) {
      return null;
    }
    const texts = [];
    for (let i = 0; i < Math.min(cues.length, SAMPLE_CUES); i++) {
      texts.push(cueText(cues[i].text));
    }
    return texts.join("\n");
  }

  // --- Translating ---

  scheduleUpdate() {
    if (this.updateQueued) {
      return;
    }
    this.updateQueued = true;
    this.win?.requestAnimationFrame(() => {
      this.updateQueued = false;
      this.update();
    });
  }

  update() {
    if (!this.video) {
      return;
    }
    if (!VideoCaptions.enabled || !this.actor.enabled || !this.video.isConnected) {
      this.stop();
      this.actor.render?.();
      return;
    }
    const text = this.currentText();
    if (text == this.text) {
      return;
    }
    this.text = text;
    if (!text) {
      this.show("");
      return;
    }
    const cached = this.cache.get(text);
    if (cached) {
      this.show(cached.text, { lang: cached.lang });
      return;
    }
    // The original shows, dimmed, until its translation is back.
    this.show(text, { pending: !this.failed, lang: this.from ?? this.source.lang });
    if (!this.failed) {
      this.translate(text);
    }
  }

  async translate(text) {
    const video = this.video;
    const lang = this.from ?? this.source.lang;
    let result;
    try {
      result = await this.actor.sendQuery("WhimsyCaptions:Translate", {
        text,
        lang,
        sample: lang ? null : this.sample(),
      });
    } catch (e) {
      result = { error: "failed" };
    }
    if (video != this.video) {
      return;
    }
    if (!result || result.error) {
      // Shown as they are from here on, with a note saying so once.
      this.failed = true;
      if (this.text == text) {
        this.show(text, { lang });
      }
      this.notice(this.strings.failed);
      return;
    }
    if (result.confident) {
      this.from = result.from;
    }
    if (this.cache.size >= CACHE_LIMIT) {
      this.cache.delete(this.cache.keys().next().value);
    }
    const entry = { text: result.text, lang: result.same ? result.from : result.to };
    this.cache.set(text, entry);
    if (this.text == text) {
      this.show(entry.text, { lang: entry.lang });
    }
  }

  // --- Drawing ---

  get strings() {
    if (!this._strings) {
      const fallback = {
        none: "This video has no captions to translate",
        failed: "Couldn’t translate these captions, so they’re shown as they are",
        region: "Translated captions",
        move: "Drag to move. Double-click to put back",
      };
      try {
        const [none, failed, region] = lazy.l10n.formatMessagesSync([
          { id: "whimsy-video-captions-none" },
          { id: "whimsy-video-captions-failed" },
          { id: "whimsy-video-captions-region" },
        ]);
        const attr = (message, name) => message?.attributes?.find(a => a.name == name)?.value;
        this._strings = {
          none: none?.value ?? fallback.none,
          failed: failed?.value ?? fallback.failed,
          region: attr(region, "aria-label") ?? fallback.region,
          move: attr(region, "title") ?? fallback.move,
        };
      } catch (e) {
        this._strings = fallback;
      }
    }
    return this._strings;
  }

  // Labels the caption box (once the control is built).
  label() {
    const { captions } = this.els;
    captions.setAttribute("aria-label", this.strings.region);
    captions.title = this.strings.move;
  }

  // Reader View's typeface and weight.
  applyTypography() {
    const { captions } = this.els;
    const font = Services.prefs.getCharPref("reader.font_type", "sans-serif");
    captions.dataset.font = ["serif", "monospace"].includes(font) ? font : "sans-serif";
    captions.dataset.weight = Services.prefs.getCharPref("reader.font_weight", "regular");
  }

  show(text, { pending = false, lang = null } = {}) {
    if (!this.els) {
      return;
    }
    const { cue } = this.els;
    cue.textContent = text;
    cue.toggleAttribute("data-pending", !!text && pending);
    if (lang) {
      cue.setAttribute("lang", lang);
    } else {
      cue.removeAttribute("lang");
    }
    this.refresh();
  }

  // Shows the box while there's a caption or a note.
  refresh() {
    const { captions, cue, note } = this.els;
    const shown = !!cue.textContent || !!note.textContent;
    if (shown) {
      this.place();
    }
    captions.toggleAttribute("data-shown", shown && this.actor.sheetReady);
  }

  // A short note in the caption box (no captions, couldn't translate).
  notice(text, video = this.video) {
    const { note } = this.els;
    note.textContent = text;
    this.noticeVideo = video;
    clearTimeout(this.noticeTimer);
    this.refresh();
    this.noticeTimer = setTimeout(() => {
      if (!this.els) {
        return;
      }
      note.textContent = "";
      this.noticeVideo = null;
      this.refresh();
    }, NOTICE_MS);
  }

  schedulePlace() {
    if (this.placeQueued) {
      return;
    }
    this.placeQueued = true;
    this.win?.requestAnimationFrame(() => {
      this.placeQueued = false;
      if (this.video || this.noticeVideo) {
        this.place();
      }
    });
  }

  // Bottom centre of the box: near the bottom of the video, plus any
  // dragged offset; sized to the video, kept in the viewport.
  place() {
    const video = this.video ?? this.noticeVideo;
    const win = this.win;
    if (!video?.isConnected || !win || !this.els) {
      return;
    }
    const { captions } = this.els;
    const r = video.getBoundingClientRect();
    const size = Math.round(clamp(r.height * 0.05, 14, 34));
    captions.style.setProperty("--size", `${size}px`);
    captions.style.maxWidth = `${Math.round(Math.max(200, r.width * 0.8))}px`;
    const offset = this.offsets.get(video) ?? { x: 0, y: 0 };
    const x = r.left + r.width * (0.5 + offset.x);
    const y = r.bottom - r.height * (BOTTOM - offset.y);
    captions.style.left = `${Math.round(clamp(x, 0, win.innerWidth))}px`;
    captions.style.top = `${Math.round(clamp(y, size * 2, win.innerHeight))}px`;
  }

  startDrag(event) {
    if (!this.video || event.button != 0) {
      return;
    }
    const r = this.video.getBoundingClientRect();
    this.dragging = {
      x: event.clientX,
      y: event.clientY,
      offset: this.offsets.get(this.video) ?? { x: 0, y: 0 },
      width: r.width || 1,
      height: r.height || 1,
    };
    this.els.captions.toggleAttribute("data-dragging", true);
    event.preventDefault();
  }

  drag(event) {
    const d = this.dragging;
    if (!d || !this.video) {
      return;
    }
    // The box's anchor stays over the video.
    this.offsets.set(this.video, {
      x: clamp(d.offset.x + (event.clientX - d.x) / d.width, -0.5, 0.5),
      y: clamp(d.offset.y + (event.clientY - d.y) / d.height, BOTTOM - 1, BOTTOM),
    });
    this.place();
  }

  endDrag() {
    this.dragging = null;
    this.els?.captions.removeAttribute("data-dragging");
  }

  resetPlace() {
    if (this.video) {
      this.offsets.delete(this.video);
      this.place();
    }
  }

  // For tests: what the caption box shows.
  testState() {
    if (!this.els) {
      return null;
    }
    const { captions, cue, note } = this.els;
    const r = captions.getBoundingClientRect();
    return {
      on: !!this.video,
      shown: captions.hasAttribute("data-shown") && !captions.hidden,
      text: cue.textContent,
      lang: cue.getAttribute("lang"),
      pending: cue.hasAttribute("data-pending"),
      note: note.textContent,
      font: captions.dataset.font ?? null,
      from: this.from,
      mode: this.source?.kind == "track" ? this.source.track.mode : null,
      center: { x: r.left + r.width / 2, y: r.top + r.height / 2 },
      bottom: r.bottom,
    };
  }
}
