/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// wave3/speed: a speed control on every video, shown while the pointer is
// over it (the Video Speed Controller extension's overlay, built in). It
// says the current speed ("1×"); click the number to type any speed (Enter
// applies, clamped to 0.25–4×, Escape cancels), or the arrow beside it for
// quarter steps from 0.25× to 4×. The speed you pick is remembered per site
// (WhimsyVideoSpeedParent) and applied to the site's next videos.
//
// The control is drawn in the document's anonymous content
// (insertAnonymousContent, like Screenshots): the page can't see or style
// it, it sits above the page (fullscreen players included) and it never
// changes the player's DOM. Pointer and key events aimed at it are stopped
// at the top of the event path, so a player never sees a click or a typed
// digit (YouTube seeks on digits) meant for the control.
//
// The actor starts with the first media event of a page; the pointer and
// key listeners never create it, so pages without video pay nothing.

import { clearTimeout, setTimeout } from "resource://gre/modules/Timer.sys.mjs";

const lazy = {};
ChromeUtils.defineLazyGetter(lazy, "l10n", () => new Localization(["browser/whimsy.ftl"], true));
// wave5/captions: "CC" (translated captions) lives in this control.
ChromeUtils.defineESModuleGetters(lazy, {
  VideoCaptions: "resource:///modules/whimsy/WhimsyCaptionsChild.sys.mjs",
  cueText: "resource:///modules/whimsy/WhimsyCaptionsChild.sys.mjs",
});
const CAPTIONS_PREF = "whimsy.feature.video-captions";

const FEATURE_PREF = "whimsy.feature.video-speed";
// W23 video: typed speeds go to Gecko's whole range, 1/16× to 16×.
const MIN_RATE = 1 / 16;
const MAX_RATE = 16;
const RANGE_PREF = "whimsy.feature.video-speed-range";
const DEFAULT_PREF = "whimsy.video.default-speed";
const DEFAULT_FEATURE_PREF = "whimsy.feature.video-default-speed";
// W23 video: Summarize and picture-in-picture, two plates at the top right.
const TOP_BUTTONS_PREF = "whimsy.video.top-buttons";
const SUMMARY_PREF = "whimsy.feature.ai-video-summary";
const AI_PREF = "whimsy.ai.enabled";
// Up to this wide, Summarize is its icon alone.
const COMPACT_WIDTH = 260;
const NOTE_MS = 2000;
const PRESETS = Array.from({ length: 16 }, (_, i) => (i + 1) / 4);
// Smaller videos (thumbnails, avatars, inline previews) get no control.
const MIN_WIDTH = 120;
const MIN_HEIGHT = 68;
const INSET = 8;
// The control fades after the pointer rests this long, like a player's own
// controls, and lingers this long after the pointer leaves the video.
const IDLE_MS = 2500;
const LEAVE_MS = 300;
// A player that puts the speed back to 1× this soon after Whimsy applied the
// site's speed (YouTube does on load) gets it applied once more.
const RESET_GRACE_MS = 1500;
const STYLESHEET = "chrome://browser/content/whimsy/whimsy-video-speed.css";
const SVG_UTURN = `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M5.5 3.2 2.7 6l2.8 2.8"/><path d="M3 6h6.6a3.6 3.6 0 0 1 0 7.2H7"/></svg>`;
const SVG_SPARKLE = `<svg viewBox="0 0 16 16" aria-hidden="true"><path class="fill" d="M8 1.5c.4 3.2 2.3 5.1 5.5 5.5-3.2.4-5.1 2.3-5.5 5.5C7.6 9.3 5.7 7.4 2.5 7 5.7 6.6 7.6 4.7 8 1.5Z"/><path class="fill" d="M13 11.2c.15 1 .8 1.65 1.8 1.8-1 .15-1.65.8-1.8 1.8-.15-1-.8-1.65-1.8-1.8 1-.15 1.65-.8 1.8-1.8Z"/></svg>`;
const SVG_PIP = `<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="1.8" y="3" width="12.4" height="10" rx="2"/><rect class="fill" x="8" y="8" width="4.6" height="3.4" rx=".9"/></svg>`;
const SVG_PIP_OUT = `<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="1.8" y="3" width="12.4" height="10" rx="2"/><path d="M6 10.5 10 6.5m0 0H7.2m2.8 0v2.8"/></svg>`;
const MARKUP = `<template>
  <link rel="stylesheet" href="${STYLESHEET}"/>
  <div id="bar" hidden="">
    <button id="reset" type="button" hidden="">${SVG_UTURN}</button>
    <button id="value" type="button"></button>
    <input id="input" type="text" inputmode="decimal" autocomplete="off" spellcheck="false" hidden=""/>
    <button id="toggle" type="button" aria-haspopup="menu" aria-expanded="false" aria-controls="menu">
      <svg viewBox="0 0 10 10" aria-hidden="true"><path d="M2 3.75 5 6.75 8 3.75"/></svg>
    </button>
    <button id="cc" type="button" aria-pressed="false" hidden="">CC</button>
    <div id="menu" role="menu" hidden=""></div>
    <div id="speednote" role="status" hidden=""></div>
  </div>
  <div id="right" hidden="">
    <div id="summplate" class="plate" hidden=""><button id="summ" type="button" aria-pressed="false">${SVG_SPARKLE}<span class="spinner" aria-hidden="true"></span><span id="summlabel"></span></button></div>
    <div id="pipplate" class="plate"><button id="pip" type="button" aria-pressed="false">${SVG_PIP}${SVG_PIP_OUT}</button></div>
  </div>
  <div id="captions" role="region" hidden=""><div id="note"></div><div id="cue" dir="auto"></div></div>
</template>`;

// Gecko's slowest speed is 1/16× (shown as 0.06×); the rest round to hundredths.
export const clampRate = rate => (rate <= MIN_RATE ? MIN_RATE : Math.round(Math.min(MAX_RATE, rate) * 100) / 100);

// The legacy range, while the W23 range's switch is off.
const clampLegacy = rate => Math.round(Math.min(4, Math.max(0.25, rate)) * 100) / 100;

export function clampTyped(rate) {
  return Services.prefs.getBoolPref(RANGE_PREF, true) ? clampRate(rate) : clampLegacy(rate);
}

// The speed videos start at (Settings › Media), 1× while its switch is off.
export function defaultRate() {
  if (!Services.prefs.getBoolPref(DEFAULT_FEATURE_PREF, true)) {
    return 1;
  }
  const value = Number(Services.prefs.getStringPref(DEFAULT_PREF, "1"));
  return Number.isFinite(value) && value > 0 ? clampRate(value) : 1;
}

// "1.5", "1,5", "1.5x", "1.5×" and " 2 " all read as speeds; anything else
// is NaN.
export function parseRate(text) {
  const cleaned = String(text).trim().replace(",", ".").replace(/\s*[x×]$/i, "");
  return /^\d*\.?\d+$/.test(cleaned) ? Number(cleaned) : NaN;
}

const W23_FALLBACK = {
  reset: "Back to {rate}",
  fastest: "Set to {rate}, as fast as videos go",
  summarize: "Summarize",
  summarizing: "Summarizing…",
  summarizeTip: "Summarize this video",
  hideSummary: "Hide summary",
  showSummary: "Show summary",
  pip: "Picture-in-Picture",
  pipBack: "Back to the page",
};

export class WhimsyVideoSpeedChild extends JSWindowActorChild {
  // Videos seen in this document (pruned when they leave it).
  videos = new Set();
  // Per video: the source the site's speed was applied to, and when.
  applied = new WeakMap();
  // The site's remembered speed, once asked for.
  siteRate = null;
  // The video the control is showing for.
  current = null;
  // W23 video: ids the parent knows each video by (for Summarize).
  videoIds = new WeakMap();
  nextVideoId = 1;
  // What a Summarize press does for the current video: "none", "shown", or "hidden".
  summaryState = "none";
  summarizing = false;
  // Drawn subtitles kept per video while it plays: how often, and how many.
  drawnLimits = { every: 1000, cues: 2000, chars: 60000 };

  idOf(video) {
    if (!this.videoIds.has(video)) {
      this.videoIds.set(video, `${this.browsingContext.id}:${this.nextVideoId++}`);
    }
    return this.videoIds.get(video);
  }

  videoById(id) {
    for (const video of this.videos) {
      if (this.videoIds.get(video) == id) {
        return video;
      }
    }
    return null;
  }

  // wave5/captions: translated captions, made the first time CC is used.
  get captions() {
    this._captions ??= new lazy.VideoCaptions(this);
    return this._captions;
  }

  get enabled() {
    return Services.prefs.getBoolPref(FEATURE_PREF, true);
  }

  handleEvent(event) {
    switch (event.type) {
      case "loadstart":
      case "loadedmetadata":
      case "play":
        this.onMedia(event);
        break;
      case "ratechange":
        this.onRateChange(event);
        break;
      case "mousemove":
        this.onPointer(event);
        break;
      case "mouseout":
        if (!event.relatedTarget && !this.busy) {
          this.scheduleHide(LEAVE_MS);
        }
        break;
      case "fullscreenchange":
        this.hide();
        this._captions?.schedulePlace();
        break;
      case "pointerdown":
      case "mousedown":
      case "pointerup":
      case "mouseup":
      case "click":
      case "dblclick":
      case "contextmenu":
        this.onPointerButton(event);
        break;
      case "keydown":
      case "keypress":
      case "keyup":
        this.onKey(event);
        break;
    }
  }

  // w7native: live captions from speech, recognized in the parent.
  receiveMessage(message) {
    switch (message.name) {
      case "WhimsyCaptions:SpeechText":
        this._captions?.onSpeechText(message.data);
        this._listener?.onSpeechText(message.data);
        break;
      case "WhimsyCaptions:SpeechError":
        this._captions?.onSpeechError(message.data);
        this._listener?.onSpeechError(message.data);
        break;
      case "WhimsyVideoSpeed:CallCaptions":
        return this.toggleCallCaptions();
      case "WhimsyVideoSpeed:SummaryState":
        if (message.data?.videoId && this.current && this.idOf(this.current) == message.data.videoId) {
          this.summaryState = message.data.state;
          this.render();
        }
        break;
      case "WhimsyVideoSpeed:Default":
        return this.applyDefault(message.data?.rate);
      case "WhimsyVideoSpeed:MainVideo": {
        const video = this.current ?? this.mainVideo();
        return video ? this.idOf(video) : null;
      }
      case "WhimsyVideoSpeed:SummarySource":
        return this.summarySource(this.videoById(message.data?.videoId));
      case "WhimsyVideoSpeed:FetchText":
        return this.fetchText(message.data?.url);
      case "WhimsyVideoSpeed:Listen":
        return this.listen(this.videoById(message.data?.videoId));
      case "WhimsyVideoSpeed:Seek": {
        const video = this.videoById(message.data?.videoId);
        const time = Number(message.data?.time);
        if (!video || !Number.isFinite(time)) {
          return false;
        }
        video.currentTime = time;
        video.play()?.catch?.(() => {});
        return true;
      }
    }
    return null;
  }

  // --- W23 video: what Summarize reads ---

  // Text tracks (hidden mode loads every cue), subtitles drawn over the
  // video, and the page's title and description.
  async summarySource(video) {
    if (!video) {
      return null;
    }
    const doc = this.document;
    const meta = name => doc.querySelector(`meta[property="${name}"], meta[name="${name}"]`)?.content?.trim() || "";
    const rect = video.getBoundingClientRect();
    const live = this.isLive(video);
    this.followTime(video);
    return {
      title: meta("og:title") || doc.title || "",
      description: meta("og:description") || meta("description") || this.ldDescription(),
      channel: meta("og:site_name") || "",
      duration: Number.isFinite(video.duration) ? video.duration : null,
      currentTime: video.currentTime,
      live,
      seekable: video.seekable?.length > 0 && video.seekable.end(video.seekable.length - 1) - video.seekable.start(0) > 1,
      drm: !!video.mediaKeys,
      rect: { x: rect.left, y: rect.top, width: rect.width, height: rect.height },
      cues: await this.trackCues(video),
      drawn: this.drawnSoFar(video),
    };
  }

  ldDescription() {
    for (const script of this.document.querySelectorAll('script[type="application/ld+json"]')) {
      try {
        const data = JSON.parse(script.textContent);
        for (const item of [data].flat()) {
          if (item?.description) {
            return String(item.description);
          }
        }
      } catch (e) {}
    }
    return "";
  }

  async trackCues(video) {
    const list = video.textTracks;
    let track = null;
    for (let i = 0; i < (list?.length ?? 0); i++) {
      if (["subtitles", "captions"].includes(list[i].kind) && (!track || list[i].mode == "showing")) {
        track = list[i];
      }
    }
    if (!track) {
      return [];
    }
    const mode = track.mode;
    if (mode == "disabled") {
      track.mode = "hidden";
    }
    const deadline = ChromeUtils.now() + 3000;
    while (!track.cues?.length && ChromeUtils.now() < deadline) {
      await new Promise(r => setTimeout(r, 100));
    }
    const cues = [];
    for (let i = 0; i < (track.cues?.length ?? 0); i++) {
      const cue = track.cues[i];
      const text = lazy.cueText(cue.text);
      if (text) {
        cues.push({ start: cue.startTime, end: cue.endTime, text });
      }
    }
    if (track.mode != mode) {
      track.mode = mode;
    }
    return cues;
  }

  // Text the page draws over the lower part of the video (its own subtitles).
  drawnText(video) {
    const r = video.getBoundingClientRect();
    let box = video.parentElement;
    while (box?.parentElement && box.getBoundingClientRect().width <= r.width * 1.2) {
      box = box.parentElement;
    }
    const out = [];
    const walker = this.document.createTreeWalker(box ?? this.document.body, this.contentWindow.NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node && out.length < 6; node = walker.nextNode()) {
      const text = node.textContent.trim();
      if (!text || !node.parentElement?.checkVisibility()) {
        continue;
      }
      const t = node.parentElement.getBoundingClientRect();
      const cy = t.top + t.height / 2;
      if (t.left >= r.left && t.right <= r.right && cy > r.top + r.height * 0.55 && cy < r.bottom) {
        out.push(text);
      }
    }
    return out.length ? [out.join("\n")] : [];
  }

  // Subtitles drawn over the video, collected while it plays (a second at a
  // time, when it has no text track), so Summarize reads more than the line
  // on screen. Bounded, and never in a private window or with Summarize off.
  collectDrawn(video) {
    this.drawnCues ??= new WeakMap();
    if (this.drawnCues.has(video) || !this.summaryAllowed || !this.hasOverlay(video)) {
      return;
    }
    const cues = [];
    this.drawnCues.set(video, cues);
    let chars = 0;
    let last = 0;
    const sample = () => {
      const now = ChromeUtils.now();
      if (video.paused || now - last < this.drawnLimits.every) {
        return;
      }
      last = now;
      if (!this.summaryAllowed) {
        video.removeEventListener("timeupdate", sample);
        this.drawnCues.delete(video);
        return;
      }
      if (this.hasTextTrack(video)) {
        return;
      }
      const text = this.drawnText(video)[0];
      const prev = cues.at(-1);
      if (!text) {
        return;
      }
      if (prev?.text == text) {
        prev.end = video.currentTime;
        return;
      }
      cues.push({ start: video.currentTime, end: video.currentTime, text });
      chars += text.length;
      while (cues.length > this.drawnLimits.cues || chars > this.drawnLimits.chars) {
        chars -= cues.shift().text.length;
      }
    };
    video.addEventListener("timeupdate", sample);
  }

  hasTextTrack(video) {
    const list = video.textTracks;
    for (let i = 0; i < (list?.length ?? 0); i++) {
      if (["subtitles", "captions"].includes(list[i].kind)) {
        return true;
      }
    }
    return false;
  }

  // What was collected, plus the line on screen now.
  drawnSoFar(video) {
    const cues = [...(this.drawnCues?.get(video) ?? [])].sort((a, b) => a.start - b.start);
    const text = this.drawnText(video)[0];
    if (text && !cues.some(c => c.text == text)) {
      cues.push({ start: video.currentTime, end: video.currentTime, text });
    }
    return cues;
  }

  // A subtitle file the tab loaded, with the page's own credentials.
  async fetchText(url) {
    try {
      const response = await this.contentWindow.fetch(url, { credentials: "include" });
      return response.ok ? (await response.text()).slice(0, 2000000) : null;
    } catch (e) {
      return null;
    }
  }

  // No captions: on-device speech captions, drawn nowhere.
  listen(video) {
    if (!video || !lazy.VideoCaptions.speechEnabled || video.mediaKeys) {
      return false;
    }
    this._listener ??= new lazy.VideoCaptions(this, {
      silent: true,
      onHeard: text => this.sendAsyncMessage("WhimsyVideoSpeed:Heard", { videoId: this.idOf(video), text, seconds: video.currentTime }),
    });
    return this._listener.listen(video);
  }

  // Chapters in chat follow playback.
  followTime(video) {
    if (this.followed?.has(video)) {
      return;
    }
    this.followed ??= new WeakSet();
    this.followed.add(video);
    let last = 0;
    video.addEventListener("timeupdate", () => {
      const now = ChromeUtils.now();
      if (now - last > 500) {
        last = now;
        this.sendAsyncMessage("WhimsyVideoSpeed:Time", { videoId: this.idOf(video), time: video.currentTime });
      }
    });
  }

  // F31: Live Captions for This Call. A call's videos never get the speed
  // control (F30), so the captions show over the call's largest tile on
  // their own, from the call's sound. Returns "on", "off" or why not.
  toggleCallCaptions() {
    if (!lazy.VideoCaptions.enabled || !lazy.VideoCaptions.speechEnabled) {
      return "unavailable";
    }
    const video = this.callVideo();
    if (!video) {
      return "no-video";
    }
    if (this._captions?.source?.call) {
      this._captions.stop();
      return "off";
    }
    if (!this.ensureControl()) {
      return "unavailable";
    }
    this.captions.label();
    return this.captions.start(video, { call: true }) ? "on" : "unavailable";
  }

  // The call's largest visible video (its speaker or main tile).
  callVideo() {
    let best = null;
    let bestArea = 0;
    for (const video of this.document?.querySelectorAll("video") ?? []) {
      const rect = video.getBoundingClientRect();
      const area = rect.width * rect.height;
      if (area > bestArea && video.checkVisibility()) {
        best = video;
        bestArea = area;
      }
    }
    return best;
  }

  didDestroy() {
    this.clearTimers();
    this._captions?.stop();
    this._listener?.stop();
    if (this.anon) {
      try {
        this.document?.removeAnonymousContent(this.anon);
      } catch (e) {
        // The document is already gone.
      }
    }
    this.anon = null;
  }

  // --- Videos and the site's speed ---

  async onMedia(event) {
    const el = event.composedTarget ?? event.originalTarget;
    if (!this.enabled || !HTMLVideoElement.isInstance(el)) {
      return;
    }
    this.videos.add(el);
    if (this.siteRate === null) {
      try {
        this.siteRate = clampRate((await this.sendQuery("WhimsyVideoSpeed:Get")) || defaultRate());
      } catch (e) {
        this.siteRate = defaultRate();
      }
    }
    this.applySiteRate(el);
    if (event.type == "play") {
      this.collectDrawn(el);
    }
  }

  // Calls (Google Meet, WebRTC) and live streams (unbounded duration) cannot
  // be sped up: keep the overlay off them.
  isEligible(el) {
    if (!el || !HTMLVideoElement.isInstance(el)) {
      return false;
    }
    // WebRTC / MediaStream sources (calls like Google Meet, Zoom, etc.)
    if (el.srcObject || el.currentSrc?.startsWith("mediastream:")) {
      return false;
    }
    // Live streams (unbounded duration / live stream sources)
    if (this.isLive(el)) {
      return false;
    }
    return true;
  }

  isLive(el) {
    return el.duration === Infinity || (el.readyState >= 1 && !Number.isFinite(el.duration));
  }

  // W23 video: a live stream (never a call) gets the top-right plates only,
  // Summarize and picture-in-picture; its speed can't run ahead.
  hasOverlay(el) {
    return this.isEligible(el) || (!!el && HTMLVideoElement.isInstance(el) && !el.srcObject && !el.currentSrc?.startsWith("mediastream:") && this.isLive(el) && Services.prefs.getBoolPref(TOP_BUTTONS_PREF, true));
  }

  // The site's speed goes to each new source once, never over a speed the
  // page chose itself, and never to live streams (they can't run ahead).
  applySiteRate(el) {
    if (!this.isEligible(el) || this.siteRate == 1 || !el.currentSrc) {
      return;
    }
    const state = this.applied.get(el);
    if (state?.src == el.currentSrc) {
      return;
    }
    if (el.playbackRate != 1) {
      this.applied.set(el, { src: el.currentSrc, at: 0 });
      return;
    }
    this.applied.set(el, { src: el.currentSrc, at: ChromeUtils.now() });
    el.playbackRate = this.siteRate;
  }

  onRateChange(event) {
    const el = event.composedTarget ?? event.originalTarget;
    if (!HTMLVideoElement.isInstance(el) || !this.enabled) {
      return;
    }
    const state = this.applied.get(el);
    if (state?.at && el.playbackRate == 1 && this.siteRate != 1 && ChromeUtils.now() - state.at < RESET_GRACE_MS) {
      state.at = 0;
      el.playbackRate = this.siteRate;
      return;
    }
    if (el == this.current) {
      this.render();
    }
  }

  // The user picked a speed: play at it and remember it for the site.
  setRate(rate) {
    const el = this.current;
    if (!el || !this.isEligible(el) || !Number.isFinite(rate)) {
      return;
    }
    const typed = rate;
    rate = clampTyped(rate);
    el.playbackRate = rate;
    this.siteRate = rate;
    this.applied.set(el, { src: el.currentSrc, at: 0 });
    this.sendAsyncMessage("WhimsyVideoSpeed:Set", { rate });
    this.render();
    // Faster than videos go: one line says why it's 16×. Slower just applies.
    if (typed > rate && rate == MAX_RATE) {
      this.showNote(this.strings.fastest.replace("{rate}", this.format(rate)));
    }
  }

  // Back to your default: plays at it and forgets this site's speed.
  applyDefault(rate = defaultRate()) {
    const el = this.current ?? this.mainVideo();
    this.siteRate = rate;
    this.sendAsyncMessage("WhimsyVideoSpeed:Forget");
    if (!el) {
      return null;
    }
    this.applied.set(el, { src: el.currentSrc, at: 0 });
    el.playbackRate = rate;
    this.render();
    return rate;
  }

  mainVideo() {
    let best = null;
    for (const el of this.videos) {
      if (el.isConnected && this.hasOverlay(el) && (!best || (best.paused && !el.paused))) {
        best = el;
      }
    }
    return best;
  }

  showNote(text) {
    const { speednote } = this.els;
    clearTimeout(this.noteTimer);
    speednote.textContent = text;
    speednote.hidden = false;
    speednote.removeAttribute("data-leaving");
    this.noteTimer = setTimeout(() => {
      speednote.toggleAttribute("data-leaving", true);
      this.noteTimer = setTimeout(() => (speednote.hidden = true), 180);
    }, NOTE_MS);
  }

  // The Cmd+Opt shortcuts (WhimsyPageChild) changed the speed: it's the
  // user's, so it's never put back, and the site's next videos follow it.
  userChanged(el, rate) {
    this.applied.set(el, { src: el.currentSrc, at: 0 });
    if (this.siteRate !== null) {
      this.siteRate = rate;
    }
  }

  // --- Showing the control ---

  // Whether the user is in the middle of using the control.
  get busy() {
    if (!this.anon) {
      return false;
    }
    let focused = false;
    try {
      focused = !!this.anon.root.activeElement;
    } catch (e) {}
    return focused || !this.els.menu.hidden || !this.els.input.hidden;
  }

  inControl(node) {
    try {
      return !!node && !!this.anon && this.anon.root.contains(node);
    } catch (e) {
      return false;
    }
  }

  onPointer(event) {
    if (this._captions?.dragging) {
      this._captions.drag(event);
      return;
    }
    if (!this.enabled) {
      this.hide();
      return;
    }
    this.pointer = { x: event.clientX, y: event.clientY, inControl: this.inControl(event.originalTarget) };
    if (!this.frameQueued) {
      this.frameQueued = true;
      this.contentWindow?.requestAnimationFrame(() => {
        this.frameQueued = false;
        this.updateHover();
      });
    }
  }

  updateHover() {
    const point = this.pointer;
    if (!point || !this.contentWindow) {
      return;
    }
    if (point.inControl) {
      if (this.current && this.hasOverlay(this.current)) {
        this.show(this.current);
      } else {
        this.hide();
      }
      return;
    }
    const video = this.videoAt(point.x, point.y);
    if (video) {
      this.show(video);
    } else if (!this.busy) {
      this.scheduleHide(LEAVE_MS);
    }
  }

  // The smallest visible video under the point: an inline preview inside a
  // bigger player is the one meant.
  videoAt(x, y) {
    let best = null;
    let bestArea = Infinity;
    const fullscreen = this.document.fullscreenElement;
    for (const el of this.videos) {
      if (!el.isConnected) {
        this.videos.delete(el);
        continue;
      }
      if (!this.hasOverlay(el)) {
        continue;
      }
      if (fullscreen && fullscreen != el && !fullscreen.contains(el)) {
        continue;
      }
      const r = el.getBoundingClientRect();
      if (r.width < MIN_WIDTH || r.height < MIN_HEIGHT || x < r.left || x > r.right || y < r.top || y > r.bottom) {
        continue;
      }
      if (r.width * r.height < bestArea) {
        best = el;
        bestArea = r.width * r.height;
      }
    }
    return best;
  }

  show(video) {
    if (!video || !this.hasOverlay(video) || !this.ensureControl()) {
      return;
    }
    clearTimeout(this.hideTimer);
    if (video != this.current) {
      this.closeMenu();
      this.cancelEdit();
      this.current = video;
    }
    this.place();
    this.render();
    if (this.sheetReady) {
      // Both sides share one timer: they fade in and out together.
      this.els.bar.toggleAttribute("data-shown", true);
      this.els.right.toggleAttribute("data-shown", true);
    }
    this.keepAlive();
    this.querySummary(video);
  }

  async querySummary(video) {
    if (!this.summaryAllowed) {
      return;
    }
    try {
      const state = await this.sendQuery("WhimsyVideoSpeed:SummaryState", { videoId: this.idOf(video) });
      if (this.current == video && state) {
        this.summaryState = state;
        this.render();
      }
    } catch (e) {
      // The page is going away.
    }
  }

  // Summarize shows with AI on, its switch on, and never in a private tab.
  get summaryAllowed() {
    return (
      Services.prefs.getBoolPref(AI_PREF, false) &&
      Services.prefs.getBoolPref(SUMMARY_PREF, true) &&
      !this.browsingContext?.usePrivateBrowsing
    );
  }

  // (Re)starts the idle fade.
  keepAlive() {
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      if (this.busy) {
        this.keepAlive();
      } else if (!this.pointer?.inControl) {
        this.hide();
      }
    }, IDLE_MS);
  }

  // Gives the keyboard back to the page (Space plays and pauses again).
  release() {
    try {
      this.anon?.root.activeElement?.blur();
    } catch (e) {
      // Already gone.
    }
  }

  scheduleHide(ms) {
    clearTimeout(this.hideTimer);
    this.hideTimer = setTimeout(() => this.hide(), ms);
  }

  hide() {
    this.clearTimers();
    if (!this.anon) {
      return;
    }
    this.closeMenu();
    this.cancelEdit();
    this.els.bar.removeAttribute("data-shown");
    this.els.right.removeAttribute("data-shown");
  }

  clearTimers() {
    clearTimeout(this.hideTimer);
    clearTimeout(this.idleTimer);
  }

  place() {
    const r = this.current.getBoundingClientRect();
    const win = this.contentWindow;
    const left = Math.min(Math.max(r.left, 0) + INSET, Math.max(INSET, win.innerWidth - 160));
    const top = Math.min(Math.max(r.top, 0) + INSET, Math.max(INSET, win.innerHeight - 34));
    this.els.bar.style.left = `${Math.round(left)}px`;
    this.els.bar.style.top = `${Math.round(top)}px`;
    // The right plates hug the video's top right corner (PiP in the corner).
    // Anchored by the video's right edge, so a viewport that narrows (chat
    // opening beside it) never drags them across the video.
    const edge = Math.max(INSET, Math.min(r.right, win.innerWidth) - INSET);
    this.els.right.style.left = `${Math.round(edge)}px`;
    this.els.right.style.top = `${Math.round(top)}px`;
    this.els.right.toggleAttribute("data-compact", r.width <= COMPACT_WIDTH);
  }

  format(rate) {
    this.numberFormat ??= new Intl.NumberFormat(Services.locale.appLocaleAsBCP47, { maximumFractionDigits: 2 });
    return `${this.numberFormat.format(rate)}×`;
  }

  render() {
    if (!this.anon || !this.current) {
      return;
    }
    const rate = this.current.playbackRate;
    const { value, menu } = this.els;
    this.els.bar.hidden = !this.sheetReady || !this.isEligible(this.current);
    value.textContent = this.format(rate);
    value.setAttribute("aria-label", this.strings.value.replace("{rate}", this.format(rate)));
    for (const item of menu.children) {
      item.setAttribute("aria-checked", String(Number(item.dataset.rate) == rate));
    }
    // CC goes last, so the speed never moves when it's there or not.
    const { cc } = this.els;
    cc.hidden = !Services.prefs.getBoolPref(CAPTIONS_PREF, true);
    cc.setAttribute("aria-pressed", String(!!this._captions?.isOn(this.current)));
    // Back to default: only while this video isn't at your default.
    const { reset } = this.els;
    const fallback = defaultRate();
    const off = Services.prefs.getBoolPref(DEFAULT_FEATURE_PREF, true) && Math.abs(rate - fallback) > 0.001;
    if (reset.hidden == off) {
      reset.hidden = !off;
      this.animateReset(off);
    }
    const back = this.strings.reset.replace("{rate}", this.format(fallback));
    reset.title = back;
    reset.setAttribute("aria-label", back);
    this.renderRight();
  }

  // The button arrives and leaves with opacity and width (150ms).
  animateReset(shown) {
    const { reset } = this.els;
    if (!this.els.bar.hasAttribute("data-shown") || this.contentWindow?.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      return;
    }
    const width = `${reset.getBoundingClientRect().width || 26}px`;
    const frames = { opacity: [0, 1], minWidth: ["0px", width], width: ["0px", width], paddingInline: ["0px", "6px"] };
    reset.animate(frames, { duration: 150, easing: "cubic-bezier(0.2, 0, 0, 1)", direction: shown ? "normal" : "reverse" });
  }

  renderRight() {
    const { right, summplate, summ, summlabel, pip } = this.els;
    const video = this.current;
    const on = Services.prefs.getBoolPref(TOP_BUTTONS_PREF, true);
    right.hidden = !on || !this.sheetReady;
    summplate.hidden = !this.summaryAllowed;
    const state = this.summarizing ? "busy" : this.summaryState;
    summ.dataset.state = state;
    summ.setAttribute("aria-pressed", String(state == "shown"));
    summlabel.textContent = state == "busy" ? this.strings.summarizing : this.strings.summarize;
    const tip = { none: this.strings.summarizeTip, shown: this.strings.hideSummary, hidden: this.strings.showSummary, busy: this.strings.summarizing }[state];
    summ.title = tip;
    summ.setAttribute("aria-label", tip);
    // Sites can turn picture-in-picture off for a video.
    const pipOn = !!video?.isCloningElementVisually;
    pip.hidden = !!video?.disablePictureInPicture;
    pip.setAttribute("aria-pressed", String(pipOn));
    pip.title = pipOn ? this.strings.pipBack : this.strings.pip;
    pip.setAttribute("aria-label", pip.title);
  }

  async pressSummarize() {
    const video = this.current;
    dump(`WHIMSY-DEBUG pressSummarize: video=${!!video} summarizing=${this.summarizing} summaryState(before)=${this.summaryState}\n`);
    if (!video || this.summarizing) {
      return;
    }
    this.summarizing = this.summaryState == "none";
    this.render();
    try {
      const state = await this.sendQuery("WhimsyVideoSpeed:Summarize", { videoId: this.idOf(video) });
      dump(`WHIMSY-DEBUG pressSummarize: got state=${state}\n`);
      if (state) {
        this.summaryState = state;
      }
    } catch (e) {
      dump(`WHIMSY-DEBUG pressSummarize: threw ${e}\n`);
    }
    this.summarizing = false;
    this.render();
    dump(`WHIMSY-DEBUG pressSummarize: summaryState(after)=${this.summaryState}\n`);
  }

  // Firefox's picture-in-picture, called directly (its own toggle is hidden by pref).
  async pressPip() {
    const video = this.current;
    if (!video) {
      return;
    }
    try {
      await this.manager.getActor("PictureInPictureLauncher").togglePictureInPicture({ video, reason: "Toggle" });
    } catch (e) {
      console.error("Whimsy: picture-in-picture", e);
    }
    this.render();
  }

  // Builds the control in the document's anonymous content the first time a
  // video is hovered. Returns whether it's there.
  ensureControl() {
    if (this.anon && !Cu.isDeadWrapper(this.anon)) {
      return true;
    }
    const doc = this.document;
    let anon;
    try {
      anon = doc.insertAnonymousContent();
    } catch (e) {
      return false; // No presentation (a hidden document).
    }
    const parsed = new DOMParser().parseFromString(MARKUP, "text/html");
    const template = doc.importNode(parsed.querySelector("template"), true);
    anon.root.appendChild(template.content.cloneNode(true));
    const root = anon.root;
    this.anon = anon;
    this.els = {
      bar: root.getElementById("bar"),
      value: root.getElementById("value"),
      input: root.getElementById("input"),
      toggle: root.getElementById("toggle"),
      menu: root.getElementById("menu"),
      cc: root.getElementById("cc"),
      captions: root.getElementById("captions"),
      note: root.getElementById("note"),
      cue: root.getElementById("cue"),
      reset: root.getElementById("reset"),
      speednote: root.getElementById("speednote"),
      right: root.getElementById("right"),
      summplate: root.getElementById("summplate"),
      summ: root.getElementById("summ"),
      summlabel: root.getElementById("summlabel"),
      pip: root.getElementById("pip"),
    };
    this.strings = this.loadStrings();
    const { value, input, toggle, menu } = this.els;
    value.title = this.strings.valueTitle;
    input.setAttribute("aria-label", this.strings.input);
    input.title = this.strings.valueTitle;
    toggle.title = this.strings.presets;
    toggle.setAttribute("aria-label", this.strings.presets);
    menu.setAttribute("aria-label", this.strings.presets);
    this.els.cc.title = this.strings.captions;
    this.els.cc.setAttribute("aria-label", this.strings.captions);
    for (const rate of PRESETS) {
      const item = doc.createElement("button");
      item.type = "button";
      item.setAttribute("role", "menuitemradio");
      item.dataset.rate = String(rate);
      item.textContent = this.format(rate);
      menu.appendChild(item);
    }
    root.querySelector("link").addEventListener(
      "load",
      () => {
        // Unhidden but transparent, so the first appearance fades in too.
        this.sheetReady = true;
        this.els.bar.hidden = false;
        this.els.captions.hidden = false;
        this.renderRight();
        if (this._captions) {
          this._captions.label();
          this._captions.refresh();
        }
        if (this.pointer && this.current) {
          this.contentWindow?.requestAnimationFrame(() => this.updateHover());
        }
      },
      { once: true }
    );
    return true;
  }

  loadStrings() {
    const fallback = {
      value: "Playback speed {rate}",
      valueTitle: "Type a speed",
      input: "Playback speed",
      presets: "Speeds",
      captions: "Translated captions",
      ...W23_FALLBACK,
    };
    try {
      const [value, input, presets] = lazy.l10n.formatMessagesSync([
        { id: "whimsy-video-speed-value", args: { rate: "{rate}" } },
        { id: "whimsy-video-speed-input" },
        { id: "whimsy-video-speed-presets" },
      ]);
      const attr = (message, name) => message?.attributes?.find(a => a.name == name)?.value;
      return {
        value: attr(value, "aria-label") ?? fallback.value,
        valueTitle: attr(value, "title") ?? fallback.valueTitle,
        input: attr(input, "aria-label") ?? fallback.input,
        presets: attr(presets, "aria-label") ?? fallback.presets,
        captions: this.loadCaptionsString() ?? fallback.captions,
        ...this.loadW23Strings(),
      };
    } catch (e) {
      return fallback;
    }
  }

  // W23 video: their own batch too.
  loadW23Strings() {
    const ids = {
      reset: "whimsy-video-back-to-default",
      fastest: "whimsy-video-speed-fastest",
      summarize: "whimsy-video-summarize",
      summarizing: "whimsy-video-summarizing",
      summarizeTip: "whimsy-video-summarize-tip",
      hideSummary: "whimsy-video-hide-summary",
      showSummary: "whimsy-video-show-summary",
      pip: "whimsy-video-pip",
      pipBack: "whimsy-video-pip-back",
    };
    try {
      const keys = Object.keys(ids);
      const messages = lazy.l10n.formatMessagesSync(keys.map(k => ({ id: ids[k], args: { rate: "{rate}" } })));
      return Object.fromEntries(keys.map((k, i) => [k, messages[i]?.value ?? W23_FALLBACK[k]]));
    } catch (e) {
      return W23_FALLBACK;
    }
  }

  // Its own batch: a missing string can't blank the speed control's.
  loadCaptionsString() {
    try {
      const [message] = lazy.l10n.formatMessagesSync([{ id: "whimsy-video-captions-button" }]);
      return message?.attributes?.find(a => a.name == "aria-label")?.value ?? null;
    } catch (e) {
      return null;
    }
  }

  // --- Using the control ---

  // Pointer events on the control never reach the page (a click on a
  // player toggles play); the control acts on clicks itself.
  onPointerButton(event) {
    const target = event.originalTarget;
    if (this._captions?.dragging && (event.type == "mouseup" || event.type == "pointerup")) {
      this._captions.endDrag();
    }
    if (!this.inControl(target)) {
      if (event.type == "mousedown" && this.busy) {
        this.closeMenu();
        this.cancelEdit();
      }
      return;
    }
    event.stopPropagation();
    this.keepAlive();
    if (event.type == "contextmenu" || event.type == "dblclick") {
      event.preventDefault();
    }
    // wave5/captions: drag the captions; double-click puts them back.
    const element = target.nodeType == target.ELEMENT_NODE ? target : target.parentElement;
    if (element?.closest("#captions")) {
      if (event.type == "mousedown") {
        this._captions?.startDrag(event);
      } else if (event.type == "dblclick") {
        this._captions?.resetPlace();
      }
      return;
    }
    if (event.type != "click" || event.button != 0) {
      return;
    }
    const button = target.closest?.("button") ?? target.parentElement?.closest("button");
    const { value, toggle, menu, cc, reset, summ, pip } = this.els;
    if (button == reset) {
      this.closeMenu();
      this.cancelEdit();
      this.applyDefault();
      this.release();
    } else if (button == summ) {
      this.closeMenu();
      this.cancelEdit();
      this.pressSummarize();
    } else if (button == pip) {
      this.closeMenu();
      this.cancelEdit();
      this.pressPip();
      this.release();
    } else if (button == cc) {
      this.closeMenu();
      this.cancelEdit();
      if (!this.captions.isOn(this.current)) {
        this.captions.label();
      }
      this.captions.toggle(this.current);
      this.render();
      this.release();
    } else if (button == value) {
      this.startEdit();
    } else if (button == toggle) {
      if (menu.hidden) {
        this.openMenu();
      } else {
        this.closeMenu();
      }
    } else if (button?.parentElement == menu) {
      this.setRate(Number(button.dataset.rate));
      this.closeMenu();
      this.release();
    }
  }

  // Keys typed into the control never reach the page either (players
  // bind digits, arrows, Space and Escape); editing still works, it runs in
  // the system event group.
  onKey(event) {
    if (!this.inControl(event.originalTarget)) {
      // Escape closes the presets wherever the focus is.
      if (event.type == "keydown" && event.key == "Escape" && this.anon && !this.els.menu.hidden) {
        this.closeMenu();
      }
      return;
    }
    event.stopPropagation();
    if (event.type != "keydown") {
      return;
    }
    this.keepAlive();
    const { input, menu, toggle } = this.els;
    if (!input.hidden) {
      if (event.key == "Enter") {
        event.preventDefault();
        this.commitEdit();
      } else if (event.key == "Escape") {
        event.preventDefault();
        this.cancelEdit();
        this.release();
      }
      return;
    }
    if (!menu.hidden) {
      const items = [...menu.children];
      const index = items.indexOf(event.originalTarget.closest?.("button"));
      const step = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -4, ArrowDown: 4 }[event.key];
      if (step && index >= 0) {
        event.preventDefault();
        items[Math.min(items.length - 1, Math.max(0, index + step))].focus();
      } else if (event.key == "Escape") {
        event.preventDefault();
        this.closeMenu();
        this.release();
      }
      return;
    }
    if (event.key == "ArrowDown" && event.originalTarget == toggle) {
      event.preventDefault();
      this.openMenu();
    }
  }

  openMenu() {
    const { menu, toggle } = this.els;
    this.cancelEdit();
    this.render();
    menu.hidden = false;
    toggle.setAttribute("aria-expanded", "true");
    const checked = menu.querySelector('[aria-checked="true"]') ?? menu.children[3];
    checked.focus({ focusVisible: false });
  }

  closeMenu() {
    if (!this.anon || this.els.menu.hidden) {
      return;
    }
    this.els.menu.hidden = true;
    this.els.toggle.setAttribute("aria-expanded", "false");
  }

  startEdit() {
    const { value, input } = this.els;
    this.closeMenu();
    input.value = String(this.current.playbackRate);
    value.hidden = true;
    input.hidden = false;
    input.focus();
    input.select();
  }

  commitEdit() {
    const rate = parseRate(this.els.input.value);
    this.cancelEdit();
    if (Number.isFinite(rate) && rate > 0) {
      this.setRate(rate);
    }
    this.release();
  }

  cancelEdit() {
    if (!this.anon || this.els.input.hidden) {
      return;
    }
    this.els.input.hidden = true;
    this.els.value.hidden = false;
  }

  // For tests: what the control shows.
  testState() {
    if (!this.anon) {
      return { built: false, shown: false };
    }
    const { bar, value, input, menu } = this.els;
    const rect = el => {
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    };
    return {
      built: true,
      shown: bar.hasAttribute("data-shown") && !bar.hidden,
      text: value.textContent,
      editing: !input.hidden,
      menuOpen: !menu.hidden,
      checked: menu.querySelector('[aria-checked="true"]')?.dataset.rate ?? null,
      value: rect(value),
      toggle: rect(this.els.toggle),
      items: Object.fromEntries([...menu.children].map(item => [item.dataset.rate, rect(item)])),
      // Object keys reorder integer-like rates ("1" before "0.25"); keep the menu's order.
      itemOrder: [...menu.children].map(item => Number(item.dataset.rate)),
      cc: { shown: !this.els.cc.hidden, pressed: this.els.cc.getAttribute("aria-pressed") == "true", ...rect(this.els.cc) },
      captions: this._captions?.testState() ?? null,
      reset: { shown: !this.els.reset.hidden, title: this.els.reset.title, ...rect(this.els.reset) },
      note: this.els.speednote.hidden ? null : this.els.speednote.textContent,
      right: {
        shown: this.els.right.hasAttribute("data-shown") && !this.els.right.hidden,
        compact: this.els.right.hasAttribute("data-compact"),
      },
      summ: {
        shown: !this.els.summplate.hidden && !this.els.right.hidden,
        state: this.els.summ.dataset.state,
        pressed: this.els.summ.getAttribute("aria-pressed") == "true",
        title: this.els.summ.title,
        labelShown: this.els.summlabel.getBoundingClientRect().width > 0,
        ...rect(this.els.summ),
      },
      pip: { shown: !this.els.pip.hidden && !this.els.right.hidden, pressed: this.els.pip.getAttribute("aria-pressed") == "true", ...rect(this.els.pip) },
      plates: {
        bar: this.els.bar.getBoundingClientRect().toJSON(),
        summ: this.els.summplate.getBoundingClientRect().toJSON(),
        pip: this.anon.root.getElementById("pipplate").getBoundingClientRect().toJSON(),
      },
      opacity: {
        bar: Number(this.contentWindow.getComputedStyle(this.els.bar).opacity),
        right: Number(this.contentWindow.getComputedStyle(this.els.right).opacity),
      },
      focusOrder: [...this.anon.root.querySelectorAll("button, input")]
        .filter(el => !el.hidden && !el.closest("[hidden]") && el.parentElement.id != "menu")
        .map(el => el.id),
      videoId: this.current ? this.idOf(this.current) : null,
    };
  }
}
