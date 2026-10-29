/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// The content side of Whimsy's page tools (one actor per frame, created on
// first use). WhimsyPageParent sends the requests.

// Per-tab volume: each media element keeps the volume the page set
// ("own"); the element plays at own × the tab's level. Web Audio graphs
// and media elements never attached to the page aren't reached.
const MEDIA = new WeakMap();

export class WhimsyPageChild extends JSWindowActorChild {
  // The tab's volume level (1 = as the page sets it), or null when it
  // hasn't been asked for yet.
  volumeLevel = null;

  async handleEvent(event) {
    switch (event.type) {
      case "play":
      case "volumechange":
      case "loadedmetadata":
        await this.onMediaEvent(event);
        break;
    }
  }

  receiveMessage(message) {
    switch (message.name) {
      case "Whimsy:SetVolume":
        this.volumeLevel = message.data.level;
        for (const el of this.document?.querySelectorAll("audio, video") ?? []) {
          this.scaleVolume(el);
        }
        for (const el of this.trackedMedia ?? []) {
          const media = el.deref();
          if (media && !media.isConnected) {
            this.scaleVolume(media);
          }
        }
        return null;
      case "Whimsy:GetVolume":
        return this.mediaVolumes();
      case "Whimsy:MediaInfo": {
        const el = this.mainMedia();
        return el ? { playing: !el.paused, area: this.area(el), rate: el.playbackRate } : null;
      }
      case "Whimsy:SetRate":
        return this.setRate(message.data);
      case "Whimsy:PageBounds":
        return this.pageBounds();
    }
    return null;
  }

  async onMediaEvent(event) {
    const el = event.target;
    if (!HTMLMediaElement.isInstance(el)) {
      return;
    }
    if (this.volumeLevel === null) {
      try {
        this.volumeLevel = await this.sendQuery("Whimsy:VolumeLevel");
      } catch (e) {
        return;
      }
    }
    this.scaleVolume(el);
  }

  // Applies the level to one element. A volume the page set since the last
  // time (anything other than what Whimsy applied) becomes its own volume.
  scaleVolume(el) {
    const level = this.volumeLevel ?? 1;
    let state = MEDIA.get(el);
    if (!state) {
      if (level == 1) {
        return;
      }
      state = { own: el.volume, applied: null };
      MEDIA.set(el, state);
      (this.trackedMedia ??= []).push(new WeakRef(el));
    } else if (state.applied === null || Math.abs(el.volume - state.applied) > 1e-6) {
      state.own = el.volume;
    }
    const target = Math.min(1, Math.max(0, state.own * level));
    state.applied = target;
    if (Math.abs(el.volume - target) > 1e-6) {
      el.volume = target;
    }
  }

  // For tests and the panel: what each element is playing at.
  mediaVolumes() {
    return [...(this.document?.querySelectorAll("audio, video") ?? [])].map(el => ({
      volume: el.volume,
      own: MEDIA.get(el)?.own ?? el.volume,
    }));
  }

  // Playback speed: the media the page is about — the one playing, else
  // the largest video, else the first audio.
  mainMedia() {
    const media = [...(this.document?.querySelectorAll("video, audio") ?? [])].filter(el => el.readyState > 0 || el.src || el.currentSrc);
    media.sort((a, b) => Number(a.paused) - Number(b.paused) || this.area(b) - this.area(a));
    return media[0] ?? null;
  }

  area(el) {
    const rect = el.getBoundingClientRect();
    return rect.width * rect.height;
  }

  setRate({ delta = 0, reset = false }) {
    const el = this.mainMedia();
    if (!el) {
      return null;
    }
    const rate = reset ? 1 : Math.round(Math.min(4, Math.max(0.25, el.playbackRate + delta)) * 100) / 100;
    el.playbackRate = rate;
    return rate;
  }

  // Capture: the whole scrollable page, in CSS pixels (what Screenshots'
  // full-page bounds are, without its overlay).
  pageBounds() {
    const win = this.contentWindow;
    const left = win.scrollMinX;
    const top = win.scrollMinY;
    const width = win.innerWidth + win.scrollMaxX - left;
    const height = win.innerHeight + win.scrollMaxY - top;
    return { left, top, right: left + width, bottom: top + height, width, height, devicePixelRatio: win.devicePixelRatio };
  }
}
