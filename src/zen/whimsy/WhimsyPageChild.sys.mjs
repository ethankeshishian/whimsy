/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// The content side of Whimsy's page tools (one actor per frame, created on
// first use). WhimsyPageParent sends the requests.

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  PictureInPictureChild: "moz-src:///toolkit/actors/PictureInPictureChild.sys.mjs",
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

  // Shift+click a link (W8-16): Arc's Peek, so Zen's Glance, as Option+click
  // already does. Firefox's own Shift+click (a new window) is what the user
  // got instead. batch6 #7's opt-in (whimsy.splitlink.shift-click, Settings
  // -> Tab Management -> Tabs) still wins: with it on, Shift+click opens the
  // link in a split beside the current tab. Top frame only, like Zen's own
  // Glance trigger.
  onClick(event) {
    if (
      event.button !== 0 ||
      !event.shiftKey ||
      event.ctrlKey ||
      event.altKey ||
      event.metaKey ||
      event.defaultPrevented
    ) {
      return;
    }
    const split = Services.prefs.getBoolPref("whimsy.splitlink.shift-click", false);
    const glance =
      !split &&
      !this.browsingContext.parent &&
      Services.prefs.getBoolPref("zen.glance.enabled", true) &&
      Services.prefs.getStringPref("zen.glance.activation-method", "alt") != "shift";
    if (!split && !glance) {
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
    if (split) {
      event.preventDefault();
      event.stopPropagation();
      this.sendAsyncMessage("Whimsy:SplitLink", { href, triggeringPrincipal: principal });
      return;
    }
    let actor = null;
    try {
      actor = this.manager.getActor("ZenGlance");
    } catch (e) {
      return; // No Glance on this page (a non-web process, or Glance off).
    }
    event.preventDefault();
    event.stopPropagation();
    actor.sendAsyncMessage("ZenGlance:OpenGlance", { url: href, triggeringPrincipal: principal });
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
      // wave7/small: Cast to AirPlay (WhimsyCast).
      case "Whimsy:CastSource":
        return this.castSource();
      case "Whimsy:CastControl":
        return this.castControl(message.data);
      // wave7/small: Capture in Portrait Mode (WhimsyPage).
      case "Whimsy:PortraitBounds":
        return this.portraitBounds(message.data.width);
      case "Whimsy:SetEditable":
        return this.setEditable(message.data.on);
      case "Whimsy:ZapActive": {
        const { WhimsyZapChild } = ChromeUtils.importESModule(
          "resource:///modules/whimsy/WhimsyZapChild.sys.mjs"
        );
        if (message.data?.active) {
          WhimsyZapChild.onStart(this.contentWindow, () => {
            this.sendAsyncMessage("Whimsy:ZapExit");
          });
        } else {
          WhimsyZapChild.onStop(this.contentWindow);
        }
        return null;
      }
      case "Whimsy:AllowCopy":
        return this.allowCopy(message.data.on);
      case "Whimsy:Selection":
        return this.selection();
      case "Whimsy:ReadingLength":
        return this.readingLength();
      case "Whimsy:SetFollowerSource":
        this.setFollowerSource(message.data.on);
        return null;
      // wave3: floating calls (WhimsyCallPip).
      case "Whimsy:CallPip":
        return this.callPip();
      // fix7: automatic picture-in-picture fallback (WhimsyMedia).
      case "Whimsy:AutoPip":
        return this.autoPip();
      // media: playlist media discovery.
      case "Whimsy:GetPageMedia":
        return this.pageMedia();
      // wave5/quick: Copy page as Markdown (WhimsyMarkdownCopy).
      case "Whimsy:PageMarkdown":
        return ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyPageMarkdown.sys.mjs").pageToMarkdown(
          this.document,
          message.data
        );
      // wave5/verbs: the selection as Markdown (Copy as Markdown verb).
      case "Whimsy:SelectionMarkdown": {
        const { selectionToMarkdown } = ChromeUtils.importESModule(
          "resource:///modules/whimsy/WhimsySelectionMarkdown.sys.mjs"
        );
        return this.contentWindow ? selectionToMarkdown(this.contentWindow) : "";
      }
    }
    return null;
  }

  // wave3: floating calls. Puts the call's main video (the active speaker's
  // tile, the biggest playing one, preferring others over your own mirrored
  // self-view) in picture-in-picture, the way Firefox's own tab-switch PiP
  // does for a playing video. Call videos don't qualify for that one: their
  // sound plays from separate audio elements, so the videos are muted or
  // have no audio track. Returns whether it opened.
  async callPip() {
    const doc = this.document;
    if (!doc) {
      return false;
    }
    const videos = [...doc.querySelectorAll("video")];
    // A player that was just closed (you came back, then left again right
    // away) lets go of its video a moment later; wait for that briefly.
    for (let i = 0; i < 20 && videos.some(v => v.isCloningElementVisually); i++) {
      await new Promise(resolve => this.contentWindow?.setTimeout(resolve, 50));
      if (!this.contentWindow) {
        return false;
      }
    }
    if (videos.some(v => v.isCloningElementVisually)) {
      return false; // Already in picture-in-picture.
    }
    const win = this.contentWindow;
    const mirrored = v => {
      try {
        return new win.DOMMatrixReadOnly(win.getComputedStyle(v).transform).a < 0;
      } catch (e) {
        return false;
      }
    };
    const live = videos.filter(v => !v.paused && v.readyState >= 2 && v.videoWidth > 0 && this.area(v) > 0);
    if (!live.length) {
      return false;
    }
    live.sort((a, b) => Number(mirrored(a)) - Number(mirrored(b)) || this.area(b) - this.area(a));
    const launcher = this.manager.getActor("PictureInPictureLauncher");
    launcher.togglePictureInPicture({ video: live[0], reason: "AutoPip" }, false).catch(console.error);
    return true;
  }

  // fix7: the tab was switched away from while its video played. Firefox
  // pops the video out itself when the page goes hidden, but listens for
  // that only while a video is on screen (PictureInPictureToggleChild's
  // tracking). If it's listening, wait for the page to hide and leave it to
  // Firefox (which also honours a muted tab and a window closed by hand);
  // otherwise (scrolled away, tracking not started yet, or Zen kept the tab
  // rendered) pop it out here.
  // W8-31: Firefox's own fallback (autoToggle) took the first playing video
  // and needed it to be 45s+ (min-video-secs, now 0 in prefs), so a short or
  // second video stayed in the sidebar. Take the biggest playing video with
  // sound, under Firefox's own eligibility rules.
  async autoPip() {
    const doc = this.document;
    if (!doc) {
      return false;
    }
    const firefoxListens = () => {
      try {
        return !!this.manager.getActor("PictureInPictureToggle")?.docState?.isTrackingVideos;
      } catch (e) {
        return false;
      }
    };
    if (firefoxListens() && doc.visibilityState != "hidden") {
      await new Promise(resolve => {
        const timer = this.contentWindow.setTimeout(resolve, 600);
        doc.addEventListener(
          "visibilitychange",
          () => {
            this.contentWindow?.clearTimeout(timer);
            resolve();
          },
          { once: true }
        );
      });
      if (!this.contentWindow) {
        return false;
      }
    }
    if (doc.visibilityState == "hidden" && firefoxListens()) {
      return false; // Firefox's own auto-PiP has it.
    }
    const videos = [...doc.querySelectorAll("video")];
    if (videos.some(v => v.isCloningElementVisually)) {
      return false; // Already in picture-in-picture.
    }
    const launcher = this.manager.getActor("PictureInPictureLauncher");
    const live = videos.filter(
      v => !v.paused && !v.muted && v.readyState >= 2 && (this.area(v) > 0 || v.videoWidth > 0) &&
        lazy.PictureInPictureChild.videoIsPiPEligible(v)
    );
    if (live.length) {
      live.sort((a, b) => this.area(b) - this.area(a) || (b.duration || 0) - (a.duration || 0));
      launcher.togglePictureInPicture({ video: live[0], reason: "AutoPip" }, false).catch(console.error);
      return true;
    }
    launcher.autoToggle();
    return true;
  }

  // Finds direct media elements (<video>, <audio>) and links on the page.
  pageMedia() {
    const doc = this.document;
    if (!doc) {
      return [];
    }
    const results = [];
    const elements = [...doc.querySelectorAll("video, audio")];
    for (const el of elements) {
      const src = el.currentSrc || el.src;
      // fix7: streamed media (YouTube and most video sites feed the player
      // through MediaSource, a blob: URL; calls use a live MediaStream) has
      // no file to save. Reported so the Playlist can say so.
      if (el.srcObject || src.startsWith("blob:") || src.startsWith("mediasource:")) {
        results.push({ url: null, streamed: true, type: el.tagName.toLowerCase() == "audio" ? "audio" : "video" });
        continue;
      }
      if (src) {
        results.push({
          url: src,
          title: doc.title || src.split("/").pop(),
          type: el.tagName.toLowerCase() == "audio" ? "audio" : "video",
          duration: el.duration && !isNaN(el.duration) ? el.duration : null,
        });
      }
    }
    const links = [...doc.querySelectorAll('a[href$=".mp4"], a[href$=".webm"], a[href$=".mp3"], a[href$=".ogg"], a[href$=".m4a"], a[href$=".wav"]')];
    for (const a of links) {
      if (a.href && !results.some(r => r.url === a.href)) {
        results.push({
          url: a.href,
          title: a.textContent.trim() || a.href.split("/").pop(),
          type: a.href.match(/\.(mp3|ogg|m4a|wav)($|\?)/i) ? "audio" : "video",
          duration: null,
        });
      }
    }
    return results;
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

  // wave7/small: Cast to AirPlay. The main video's address, where it is,
  // and whether a receiver could load it on its own (an http(s) file or
  // HLS, not Media Source or a stream).
  castVideo() {
    const videos = [...(this.document?.querySelectorAll("video") ?? [])].filter(
      el => el.readyState > 0 || el.src || el.currentSrc || el.srcObject
    );
    videos.sort((a, b) => Number(a.paused) - Number(b.paused) || this.area(b) - this.area(a));
    return videos[0] ?? null;
  }

  castSource() {
    const el = this.castVideo();
    if (!el) {
      return null;
    }
    const src = el.currentSrc || el.src || "";
    const direct = !el.srcObject && /^https?:/i.test(src);
    return { src: direct ? src : "", direct, time: el.currentTime || 0, paused: el.paused };
  }

  castControl({ action, time }) {
    const el = this.castVideo();
    if (!el) {
      return false;
    }
    if (action == "pause") {
      el.pause();
    } else if (action == "seek" && Number.isFinite(time)) {
      el.currentTime = Math.max(0, Number.isFinite(el.duration) ? Math.min(time, el.duration) : time);
    }
    return true;
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
    // wave3/speed: the user's speed; the speed control never puts it back.
    this.manager.getExistingActor("WhimsyVideoSpeed")?.userChanged(el, rate);
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

  // wave7/small: waits for the page to reflow at the narrowed width (or a
  // second), then returns the visible area, the layout width included.
  async portraitBounds(width) {
    const win = this.contentWindow;
    if (win.innerWidth > width + 1) {
      await new Promise(resolve => {
        const done = () => {
          win.removeEventListener("resize", onResize);
          win.clearTimeout(timer);
          resolve();
        };
        const onResize = () => win.innerWidth <= width + 1 && done();
        const timer = win.setTimeout(done, 1000);
        win.addEventListener("resize", onResize);
      });
    }
    await new Promise(resolve => win.requestAnimationFrame(() => win.requestAnimationFrame(resolve)));
    const root = this.document.documentElement;
    const clientWidth = root?.clientWidth || win.innerWidth;
    const clientHeight = root?.clientHeight && root.clientHeight <= win.innerHeight ? root.clientHeight : win.innerHeight;
    const left = win.scrollX;
    const top = win.scrollY;
    return {
      left,
      top,
      right: left + clientWidth,
      bottom: top + clientHeight,
      width: clientWidth,
      height: clientHeight,
      layoutWidth: win.innerWidth,
      devicePixelRatio: win.devicePixelRatio,
    };
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
