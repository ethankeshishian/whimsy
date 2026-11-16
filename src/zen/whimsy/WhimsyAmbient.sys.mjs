/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// W29 ambient-audio: six bundled ambient loops (rain, café, woods,
// fireplace, ocean, brown noise), played from the chrome window's own
// AudioContext, not from a tab. Muting a tab, or switching tabs or
// spaces, never touches it; it pauses when the window closes.
//
// One home: the Ambient sound sheet (WhimsySurface, top center of the
// page, same spot as the designed-but-not-yet-built Focus sheet), a 3x2
// grid of tiles plus a volume slider. Only one sound plays at a time;
// clicking its tile again, or closing and reopening the window, stops it;
// closing the sheet does not. ⌘K is the other way in: "Ambient Sound…"
// when nothing plays, "Stop Ambient Sound" (ranked first by the urlbar's
// own usage learner once used) while one does.
//
// Tracks: CC0 recordings from Freesound; see content/ambient/LICENSES.txt
// for each source, author and the licence-page snapshot kept beside it.
// Brown noise has no file: it's generated once per window as integrated
// white noise, the way the design asks.
//
// The Focus sheet's own "Sound" row (start/stop hooks) isn't built here:
// the Focus session core itself doesn't exist in this repo yet (W28
// focus-wellbeing.md is designed, not shipped), and the design's own
// builder plan defers that step to "when the Focus build lands."
//
// Open item for the report: the design's ⌘K "detail" text (e.g. "Change
// the sound or its volume") isn't a new control; it reuses
// ZenUBActionsProvider's existing payload.prettyName field (confirmed in
// use for WhimsySpaces' per-space rows), which WhimsyCommands.register
// didn't yet accept from a caller. Added there as spec.extraPayload.

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  Whimsy: "resource:///modules/whimsy/Whimsy.sys.mjs",
  WhimsyCommands: "resource:///modules/whimsy/WhimsyCommands.sys.mjs",
  WhimsySurface: "resource:///modules/whimsy/WhimsySurface.sys.mjs",
});
ChromeUtils.defineLazyGetter(lazy, "l10n", () => new Localization(["browser/whimsy.ftl"], true));

const FEATURE = "ambient-audio";
const SHEET_CSS = "chrome://browser/content/whimsy/whimsy-ambient.css";
const SHEET_ID = "whimsy-ambient-sheet";
const COMMAND_OPEN = "whimsy-ambient-open";
const COMMAND_STOP = "whimsy-ambient-stop";
const VOLUME_PREF = "whimsy.ambient.volume";
const LAST_PREF = "whimsy.ambient.last";
const HTML = "http://www.w3.org/1999/xhtml";

const FADE_IN_S = 1;
const FADE_OUT_S = 0.6;
const CROSSFADE_S = 1;
const BROWN_NOISE_SECONDS = 6;

// Order is the 3x2 grid's reading order: Rain, Café, Woods / Fireplace,
// Ocean, Brown noise.
const SOUNDS = [
  { id: "rain", l10nId: "whimsy-ambient-tile-rain", file: "rain.opus" },
  { id: "cafe", l10nId: "whimsy-ambient-tile-cafe", file: "cafe.opus" },
  { id: "woods", l10nId: "whimsy-ambient-tile-woods", file: "woods.opus" },
  { id: "fireplace", l10nId: "whimsy-ambient-tile-fireplace", file: "fireplace.opus" },
  { id: "ocean", l10nId: "whimsy-ambient-tile-ocean", file: "ocean.opus" },
  { id: "brown", l10nId: "whimsy-ambient-tile-brown", file: null },
];

function soundInfo(id) {
  return SOUNDS.find(s => s.id == id) ?? null;
}

function formatSync(l10nId, args) {
  try {
    return lazy.l10n.formatValueSync(l10nId, args) ?? "";
  } catch (e) {
    return "";
  }
}

// Per-window playback state. ctx/masterGain/buffers are created lazily, on
// the first play, so an ordinary window never opens an AudioContext.
const states = new WeakMap();

function state(win) {
  let s = states.get(win);
  if (!s) {
    s = { ctx: null, masterGain: null, voice: null, sound: null, buffers: new Map(), notify: null };
    states.set(win, s);
  }
  return s;
}

// The classic "integrated white noise" brown-noise generator (leaky
// integrator): louder than plain white noise, so it's rescaled back down.
function brownNoiseBuffer(ctx) {
  const length = Math.round(BROWN_NOISE_SECONDS * ctx.sampleRate);
  const buffer = ctx.createBuffer(2, length, ctx.sampleRate);
  for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
    const data = buffer.getChannelData(channel);
    let last = 0;
    for (let i = 0; i < length; i++) {
      const white = Math.random() * 2 - 1;
      last = (last + 0.02 * white) / 1.02;
      data[i] = last * 3.5;
    }
  }
  return buffer;
}

export const WhimsyAmbient = {
  SOUNDS,

  get enabled() {
    return lazy.Whimsy.featureEnabled(FEATURE);
  },

  get volume() {
    return Math.min(100, Math.max(0, Services.prefs.getIntPref(VOLUME_PREF, 60)));
  },

  set volume(value) {
    Services.prefs.setIntPref(VOLUME_PREF, Math.min(100, Math.max(0, Math.round(value))));
  },

  isPlaying(win) {
    return !!state(win).sound;
  },

  // The id of the sound currently playing in this window, or null.
  playingSound(win) {
    return state(win).sound;
  },

  initWindow(win) {
    try {
      win.windowUtils.loadSheetUsingURIString(SHEET_CSS, win.windowUtils.AUTHOR_SHEET);
    } catch (e) {
      console.error("Whimsy: ambient sheet", e);
    }
    lazy.WhimsyCommands.register(win, {
      id: COMMAND_OPEN,
      l10nId: "whimsy-action-ambient-sound",
      icon: "chrome://browser/skin/zen-icons/selectable/volume-high.svg",
      isAvailable: w => this.enabled,
      run: w => this.openSheet(w),
      // Called with no argument (register() is per-window, like
      // WhimsySpaces' own manual globalActions.push): close over this
      // window's own win, not a call-time one.
      extraPayload: () => ({
        get prettyName() {
          return formatSync(WhimsyAmbient.isPlaying(win) ? "whimsy-ambient-detail-playing" : "whimsy-ambient-detail-idle");
        },
      }),
    });
    lazy.WhimsyCommands.register(win, {
      id: COMMAND_STOP,
      l10nId: "whimsy-action-ambient-stop",
      icon: "chrome://browser/skin/zen-icons/media-pause.svg",
      isAvailable: w => this.enabled && this.isPlaying(w),
      run: w => this.stop(w),
      extraPayload: () => ({
        get prettyName() {
          const sound = soundInfo(WhimsyAmbient.playingSound(win));
          return sound ? formatSync(sound.l10nId) : "";
        },
      }),
    });
    win.addEventListener("unload", () => this.teardown(win), { once: true });
  },

  teardown(win) {
    const s = states.get(win);
    if (!s) {
      return;
    }
    this.stop(win, { immediate: true });
    try {
      s.ctx?.close();
    } catch (e) {
      // Already closing.
    }
    states.delete(win);
  },

  ensureContext(win) {
    const s = state(win);
    if (!s.ctx) {
      s.ctx = new win.AudioContext();
      s.masterGain = s.ctx.createGain();
      s.masterGain.gain.value = this.volume / 100;
      s.masterGain.connect(s.ctx.destination);
    }
    return s;
  },

  async getBuffer(win, id) {
    const s = state(win);
    if (s.buffers.has(id)) {
      return s.buffers.get(id);
    }
    const info = soundInfo(id);
    if (!info) {
      return null;
    }
    const buffer = info.file
      ? await (async () => {
          const response = await win.fetch(`chrome://browser/content/whimsy/ambient/${info.file}`);
          const data = await response.arrayBuffer();
          return s.ctx.decodeAudioData(data);
        })()
      : brownNoiseBuffer(s.ctx);
    s.buffers.set(id, buffer);
    return buffer;
  },

  setVolume(win, value) {
    this.volume = value;
    const s = states.get(win);
    if (s?.masterGain) {
      s.masterGain.gain.setValueAtTime(this.volume / 100, s.ctx.currentTime);
    }
  },

  /** Click a tile: play it, or stop it if it's the one already playing. */
  async toggle(win, id) {
    if (!this.enabled || !soundInfo(id)) {
      return;
    }
    if (this.playingSound(win) == id) {
      this.stop(win);
      return;
    }
    await this.play(win, id);
  },

  async play(win, id) {
    const s = this.ensureContext(win);
    const buffer = await this.getBuffer(win, id);
    if (!buffer || state(win) !== s) {
      // The window closed (teardown cleared the entry) while decoding.
      return;
    }
    const ctx = s.ctx;
    const now = ctx.currentTime;
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.loop = true;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(1, now + FADE_IN_S);
    source.connect(gain);
    gain.connect(s.masterGain);
    source.start();

    const previous = s.voice;
    if (previous) {
      previous.gain.gain.cancelScheduledValues(now);
      previous.gain.gain.setValueAtTime(previous.gain.gain.value, now);
      previous.gain.gain.linearRampToValueAtTime(0, now + CROSSFADE_S);
      win.setTimeout(() => stopVoice(previous), CROSSFADE_S * 1000 + 80);
    }
    s.voice = { source, gain };
    s.sound = id;
    Services.prefs.setStringPref(LAST_PREF, id);
    s.notify?.();
  },

  stop(win, { immediate = false } = {}) {
    const s = states.get(win);
    if (!s?.voice) {
      return;
    }
    const voice = s.voice;
    const ctx = s.ctx;
    const now = ctx.currentTime;
    const duration = immediate ? 0 : FADE_OUT_S;
    voice.gain.gain.cancelScheduledValues(now);
    voice.gain.gain.setValueAtTime(voice.gain.gain.value, now);
    voice.gain.gain.linearRampToValueAtTime(0, now + duration);
    win.setTimeout(() => stopVoice(voice), duration * 1000 + 80);
    s.voice = null;
    s.sound = null;
    Services.prefs.setStringPref(LAST_PREF, "");
    s.notify?.();
  },

  openSheet(win) {
    const doc = win.document;
    const existing = doc.getElementById(SHEET_ID);
    if (existing) {
      lazy.WhimsySurface.close(existing);
      return;
    }
    const s = state(win);
    const parts = lazy.WhimsySurface.create(win, {
      id: SHEET_ID,
      width: 272,
      titleL10nId: "whimsy-ambient-sheet-title",
      close: true,
      onHidden: () => {
        s.notify = null;
      },
    });
    const body = html(doc, "div", "whimsy-ambient-body");
    const grid = html(doc, "div", "whimsy-ambient-grid");
    grid.setAttribute("role", "grid");
    grid.dataset.columns = "3";
    const tiles = new Map();
    SOUNDS.forEach((sound, index) => {
      const tile = html(doc, "button", "whimsy-surface-cell whimsy-ambient-tile");
      tile.type = "button";
      tile.dataset.sound = sound.id;
      tile.tabIndex = index == 0 ? 0 : -1;
      const bars = html(doc, "span", "whimsy-ambient-bars");
      bars.setAttribute("aria-hidden", "true");
      bars.append(html(doc, "i"), html(doc, "i"), html(doc, "i"));
      const iconWrap = html(doc, "span", "whimsy-ambient-icon");
      iconWrap.append(tileIcon(doc, sound.id), pauseIcon(doc));
      const label = html(doc, "span", "whimsy-ambient-label");
      doc.l10n.setAttributes(label, sound.l10nId);
      tile.append(bars, iconWrap, label);
      tile.addEventListener("click", () => this.toggle(win, sound.id));
      grid.append(tile);
      tiles.set(sound.id, tile);
    });
    body.append(grid);

    const volRow = html(doc, "div", "whimsy-ambient-volume-row");
    volRow.append(volumeIcon(doc));
    const slider = doc.createElementNS(HTML, "input");
    slider.type = "range";
    slider.min = "0";
    slider.max = "100";
    slider.step = "5";
    slider.className = "whimsy-ambient-volume-slider";
    slider.value = String(this.volume);
    doc.l10n.setAttributes(slider, "whimsy-ambient-volume");
    slider.addEventListener("input", () => this.setVolume(win, Number(slider.value)));
    volRow.append(slider);
    body.append(volRow);

    parts.view.append(body);
    lazy.WhimsySurface.finish(parts);

    const sync = () => {
      const playing = this.playingSound(win);
      for (const [id, tile] of tiles) {
        const isOn = id == playing;
        tile.classList.toggle("is-on", isOn);
        if (isOn) {
          tile.setAttribute("aria-label", formatSync("whimsy-ambient-tile-playing", { sound: formatSync(soundInfo(id).l10nId) }));
        } else {
          tile.removeAttribute("aria-label");
        }
      }
    };
    s.notify = sync;
    sync();

    lazy.WhimsySurface.open(win, parts.panel, { at: "page-top-center" });
  },
};

function stopVoice(voice) {
  try {
    voice.source.stop();
  } catch (e) {
    // Already stopped.
  }
  try {
    voice.source.disconnect();
    voice.gain.disconnect();
  } catch (e) {
    // Already disconnected.
  }
}

function html(doc, tag, className) {
  const el = doc.createElementNS(HTML, tag);
  if (className) {
    el.className = className;
  }
  return el;
}

function svg(doc, paths, { viewBox = "0 0 18 18" } = {}) {
  const el = doc.createElementNS("http://www.w3.org/2000/svg", "svg");
  el.setAttribute("viewBox", viewBox);
  el.setAttribute("aria-hidden", "true");
  for (const { d, fill } of paths) {
    const path = doc.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", d);
    if (fill) {
      path.classList.add("fill");
    }
    el.append(path);
  }
  return el;
}

// Plain stroke glyphs, one per tile, in the hover-controls' own visual
// language (WhimsyVideoSpeedChild's inline currentColor strokes) rather
// than a new icon-sprite asset.
function tileIcon(doc, id) {
  const el = svg(doc, TILE_PATHS[id] ?? []);
  el.classList.add("whimsy-ambient-icon-own");
  return el;
}

function pauseIcon(doc) {
  const el = svg(doc, [
    { d: "M6 4h2v10H6z", fill: true },
    { d: "M10 4h2v10h-2z", fill: true },
  ]);
  el.classList.add("whimsy-ambient-icon-pause");
  return el;
}

function volumeIcon(doc) {
  const el = svg(doc, [
    { d: "M3 7h2.4L9 4v10L5.4 11H3z", fill: true },
    { d: "M11.5 6.3a3 3 0 0 1 0 5.4" },
  ]);
  el.classList.add("whimsy-ambient-volume-icon");
  return el;
}

const TILE_PATHS = {
  rain: [
    { d: "M4 7a3.2 3.2 0 0 1 6-1.6 2.6 2.6 0 0 1 3.4 2.5" },
    { d: "M5.5 11v2.6M9 11v2.6M12.5 11v2.6" },
  ],
  cafe: [
    { d: "M3.5 6.5h8v4a3.5 3.5 0 0 1-3.5 3.5h-1A3.5 3.5 0 0 1 3.5 10.5z" },
    { d: "M11.5 7.5h1a1.8 1.8 0 0 1 0 3.6h-1" },
    { d: "M6 3c.6.8-.6 1.2-.6 2M9 3c.6.8-.6 1.2-.6 2" },
  ],
  woods: [
    { d: "M9 2.5 5.3 9h2L4.5 13.6h9L10.7 9h2z" },
    { d: "M9 13.6v2" },
  ],
  fireplace: [
    { d: "M9 2.6c1.6 2.3-.8 3.3-.8 5.2a2.6 2.6 0 1 0 4.4 1.9c0-3.6-3.6-2.6-3.6-7.1z" },
  ],
  ocean: [
    { d: "M2.5 7.6c1.7-1.7 3.4-1.7 5.1 0s3.4 1.7 5.1 0 3.4-1.7 5.1 0" },
    { d: "M2.5 11.4c1.7-1.7 3.4-1.7 5.1 0s3.4 1.7 5.1 0 3.4-1.7 5.1 0" },
  ],
  brown: [
    { d: "M3.5 10h1.6v2H3.5z", fill: true },
    { d: "M7.2 6.5h1.6v5.5H7.2z", fill: true },
    { d: "M10.9 8.2h1.6v3.8h-1.6z", fill: true },
    { d: "M14.6 9.6h1.6v2.4h-1.6z", fill: true },
  ],
};
