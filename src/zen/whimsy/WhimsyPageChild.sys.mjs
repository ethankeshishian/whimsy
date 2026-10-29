/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// The content side of Whimsy's page tools (one actor per frame, created on
// first use). WhimsyPageParent sends the requests.

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  BrowserUtils: "resource://gre/modules/BrowserUtils.sys.mjs",
});

// Per-tab volume: each media element keeps the volume the page set
// ("own"); the element plays at own × the tab's level. Web Audio graphs
// and media elements never attached to the page aren't reached.
const MEDIA = new WeakMap();

// Allow copy and paste: the page events Whimsy keeps from the page, and the
// sheet that undoes user-select: none.
const COPY_EVENTS = ["copy", "cut", "paste", "contextmenu", "selectstart", "dragstart"];
const COPY_SHEET =
  "data:text/css," +
  encodeURIComponent("*, *::before, *::after { user-select: text !important; -webkit-user-select: text !important; }");

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
      case "click":
        this.onClick(event);
        break;
    }
  }

  // batch6 #7: Shift+click a link opens it in a split beside the current
  // tab, mirroring Arc's Shift+click. Off by default (whimsy.splitlink.shift-click),
  // since Shift+click is Firefox's own "open in new window".
  onClick(event) {
    if (
      !Services.prefs.getBoolPref("whimsy.splitlink.shift-click", false) ||
      event.button !== 0 ||
      !event.shiftKey ||
      event.ctrlKey ||
      event.altKey ||
      event.metaKey ||
      event.defaultPrevented
    ) {
      return;
    }
    const [href, node, principal] = lazy.BrowserUtils.hrefAndLinkNodeForClickEvent(event);
    if (!href || !node || Services.io.extractScheme(href) == "javascript") {
      return;
    }
    try {
      Services.scriptSecurityManager.checkLoadURIStrWithPrincipal(principal, href);
    } catch (e) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    this.sendAsyncMessage("Whimsy:SplitLink", { href, triggeringPrincipal: principal });
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
      case "Whimsy:SetEditable":
        return this.setEditable(message.data.on);
      case "Whimsy:AllowCopy":
        return this.allowCopy(message.data.on);
      case "Whimsy:Selection":
        return this.selection();
      case "Whimsy:ReadingLength":
        return this.readingLength();
      case "Whimsy:SetFollowerSource":
        this.setFollowerSource(message.data.on);
        return null;
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

  // Edit text on page: designMode, with Esc to finish.
  setEditable(on) {
    const doc = this.document;
    if (!doc) {
      return false;
    }
    doc.designMode = on ? "on" : "off";
    const win = this.contentWindow;
    if (on && !this.escListener) {
      this.escListener = event => {
        if (event.key == "Escape" && !event.defaultPrevented) {
          event.preventDefault();
          this.setEditable(false);
          this.sendAsyncMessage("Whimsy:EditingEnded");
        }
      };
      win.addEventListener("keydown", this.escListener, true);
    } else if (!on && this.escListener) {
      win.removeEventListener("keydown", this.escListener, true);
      this.escListener = null;
    }
    return doc.designMode == "on";
  }

  // Window capture listeners run before any of the page's own (on the
  // document or elements), so stopping propagation there keeps the page's
  // blockers from running; the browser's default actions still happen.
  allowCopy(on) {
    const win = this.contentWindow;
    if (!win) {
      return false;
    }
    if (on && !this.copyGuard) {
      this.copyGuard = event => event.stopImmediatePropagation();
      for (const type of COPY_EVENTS) {
        win.addEventListener(type, this.copyGuard, true);
      }
      win.windowUtils.loadSheetUsingURIString(COPY_SHEET, win.windowUtils.USER_SHEET);
    } else if (!on && this.copyGuard) {
      for (const type of COPY_EVENTS) {
        win.removeEventListener(type, this.copyGuard, true);
      }
      this.copyGuard = null;
      win.windowUtils.removeSheetUsingURIString(COPY_SHEET, win.windowUtils.USER_SHEET);
    }
    return !!this.copyGuard;
  }

  // Translate selection: the selected text (also inside a text field) and
  // the screen point just below it, in CSS pixels.
  selection() {
    const win = this.contentWindow;
    if (!win) {
      return null;
    }
    const field = this.document.activeElement;
    let text = "";
    let rect = null;
    if (field && (HTMLTextAreaElement.isInstance(field) || HTMLInputElement.isInstance(field))) {
      try {
        text = field.value.substring(field.selectionStart, field.selectionEnd);
      } catch (e) {
        // An input type without a text selection.
      }
      rect = field.getBoundingClientRect();
    }
    if (!text) {
      const selection = win.getSelection();
      text = selection?.toString() ?? "";
      rect = text && selection.rangeCount ? selection.getRangeAt(0).getBoundingClientRect() : null;
    }
    text = text.trim();
    if (!text || !rect) {
      return null;
    }
    return { text, x: win.mozInnerScreenX + rect.left, y: win.mozInnerScreenY + rect.bottom };
  }

  // Reading time: how much text the article has (its <article> or <main>
  // when it marks one, else the body) and its language.
  readingLength() {
    const doc = this.document;
    const root = doc?.querySelector("article") ?? doc?.querySelector("main, [role=main]") ?? doc?.body;
    const text = root?.innerText ?? root?.textContent ?? "";
    return { length: text.replace(/\s+/g, " ").trim().length, lang: doc?.documentElement.lang || "" };
  }

  // Follower tabs: while this page is a follower split's source, a plain
  // left-click on a link is redirected to the follower pane instead of
  // navigating here. A modified click (new tab/window) or one the page
  // already handled is left alone.
  setFollowerSource(on) {
    const win = this.contentWindow;
    if (!win) {
      return;
    }
    if (on && !this.followerLinkGuard) {
      this.followerLinkGuard = event => this.onFollowerClick(event);
      win.addEventListener("click", this.followerLinkGuard, true);
    } else if (!on && this.followerLinkGuard) {
      win.removeEventListener("click", this.followerLinkGuard, true);
      this.followerLinkGuard = null;
    }
  }

  onFollowerClick(event) {
    if (event.defaultPrevented || event.button != 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) {
      return;
    }
    const link = event.target?.closest?.("a[href]");
    if (!link || link.target == "_blank" || link.protocol == "javascript:") {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    this.sendAsyncMessage("Whimsy:FollowLink", { url: link.href });
  }
}
