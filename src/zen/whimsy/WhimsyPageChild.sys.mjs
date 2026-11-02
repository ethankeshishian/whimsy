/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// The content side of Whimsy's page tools (one actor per frame, created on
// first use). WhimsyPageParent sends the requests.

import { AppConstants } from "resource://gre/modules/AppConstants.sys.mjs";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  PictureInPictureChild: "moz-src:///toolkit/actors/PictureInPictureChild.sys.mjs",
  BrowserUtils: "resource://gre/modules/BrowserUtils.sys.mjs",
  setTimeout: "resource://gre/modules/Timer.sys.mjs",
  // W10-61: press again.
  eventSignatures: "resource:///modules/whimsy/WhimsyShortcuts.sys.mjs",
  PRESS_AGAIN_SHARED_KEY: "resource:///modules/whimsy/WhimsyShortcuts.sys.mjs",
});

// Per-tab volume: each media element keeps the volume the page set
// ("own"); the element plays at own × the tab's level. Web Audio graphs
// and media elements never attached to the page aren't reached.
const MEDIA = new WeakMap();

// Allow copy and paste: the page events Whimsy keeps from the page, and the
// sheet that undoes user-select: none.
const COPY_EVENTS = ["copy", "cut", "paste", "contextmenu", "selectstart", "dragstart"];
// W10-41: copy-protection plugins (WP Content Copy Protection on
// ratzillacosme.com) also cancel the copy keys themselves: a keydown
// handler on the document returns false for Cmd+C/X/V/A, which kept
// Cmd+C from copying even with Allow Copy on, and Cmd+Shift+C (Copy URL)
// too. Only these keys are kept from the page; its other shortcuts work.
const COPY_KEY_EVENTS = ["keydown", "keypress", "keyup"];
const COPY_KEY_CODES = new Set(["KeyA", "KeyC", "KeyV", "KeyX"]);
export function isCopyKey(event) {
  const accel = AppConstants.platform == "macosx" ? event.metaKey : event.ctrlKey;
  if (accel && COPY_KEY_CODES.has(event.code)) {
    return true;
  }
  // Ctrl+Insert / Shift+Insert (copy / paste outside macOS).
  return event.code == "Insert" && (event.ctrlKey || event.shiftKey);
}
const COPY_SHEET =
  "data:text/css," +
  encodeURIComponent(
    "*, *::before, *::after { user-select: text !important; -webkit-user-select: text !important; }" +
    // F25: sites that block copying also hide the selection (a transparent
    // ::selection), so text was selected and copied but never shown as such.
    "*::selection { background-color: Highlight !important; color: HighlightText !important; }"
  );

export class WhimsyPageChild extends JSWindowActorChild {
  // The tab's volume level (1 = as the page sets it), or null when it
  // hasn't been asked for yet.
  volumeLevel = null;

  // wave9/lens (review design-full-4 L9): Zap's restore rows show what was
  // zapped, not a CSS selector. For each selector: null when the element
  // isn't on the page, else { kind, name } where name is its accessible
  // label, alt, title or opening text, cut to 40 characters.
  describeSelectors(selectors) {
    const doc = this.document;
    if (!Array.isArray(selectors) || !doc) {
      return [];
    }
    return selectors.slice(0, 200).map(selector => {
      let el = null;
      try {
        el = typeof selector == "string" ? doc.querySelector(selector) : null;
      } catch (e) {
        return null;
      }
      if (!el) {
        return null;
      }
      const tag = el.localName;
      let kind = "other";
      if (tag == "img" || tag == "picture" || tag == "svg" || tag == "canvas") {
        kind = "image";
      } else if (tag == "video" || tag == "audio") {
        kind = "video";
      } else if (tag == "iframe" || tag == "embed" || tag == "object") {
        kind = "frame";
      }
      const raw =
        el.getAttribute("aria-label") ||
        el.getAttribute("alt") ||
        el.getAttribute("title") ||
        (kind == "other" ? (el.textContent ?? "").slice(0, 400) : "");
      let name = raw.replace(/\s+/g, " ").trim();
      if (name.length > 40) {
        name = name.slice(0, 39).trimEnd() + "…";
      }
      return { kind, name };
    });
  }

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
      case "contextmenu":
        this.onContextMenu(event);
        break;
      case "keydown":
        this.onKeyDown(event);
        break;
    }
  }

  // W10-61 (Arc's "press again"): the page cancelled a key that is one of
  // the browser's (WhimsyShortcuts.RESERVED_KEYS, as bound now): tell the
  // parent, which offers the second press. Runs in the system group after
  // all of the page's listeners, so defaultPrevented is the page's answer.
  onKeyDown(event) {
    if (!event.defaultPrevented || !event.isTrusted || event.repeat) {
      return;
    }
    if (!(event.metaKey || event.ctrlKey || event.altKey)) {
      return;
    }
    let wanted = null;
    try {
      wanted = Services.cpmm.sharedData.get(lazy.PRESS_AGAIN_SHARED_KEY);
    } catch (e) {
      return;
    }
    if (!wanted?.length) {
      return;
    }
    const signatures = lazy.eventSignatures(event).filter(s => wanted.includes(s));
    if (signatures.length) {
      this.sendAsyncMessage("Whimsy:PageTookKey", { signatures });
    }
  }

  // wave9/menus (W9-09): tells the parent, before Firefox's context menu
  // opens, whether this page looks like it blocks copying: it listens for
  // copy, cut or selectstart on the window, document or body (the usual
  // blockers), sets an on* handler for them, or turns off text selection
  // on the page or under the pointer. Already allowed: nothing to offer.
  onContextMenu(event) {
    let blocked = false;
    try {
      blocked = !this.copyGuard && this.pageBlocksCopy(event.composedTarget ?? event.target);
    } catch (e) {
      // A page torn down mid-event.
    }
    this.sendAsyncMessage("Whimsy:CopyBlocked", { blocked });
    // W10-41: the same pages usually cancel this right-click too (the
    // "Right click on text is disabled" kind), so Firefox's menu, and its
    // Allow Copy and Paste row, never opens. Once the event is done, if
    // the page cancelled it, the parent offers Allow Copy and Paste in a
    // toast instead (once per page).
    if (blocked && event.isTrusted && !this.menuBlockOffered) {
      lazy.setTimeout(() => {
        try {
          if (
            event.defaultPrevented &&
            !this.copyGuard &&
            !this.menuBlockOffered &&
            Services.prefs.getBoolPref("dom.event.contextmenu.enabled", true)
          ) {
            this.menuBlockOffered = true;
            this.sendAsyncMessage("Whimsy:ContextMenuBlocked");
          }
        } catch (e) {
          // The page went away.
        }
      }, 0);
    }
  }

  pageBlocksCopy(target) {
    const win = this.contentWindow;
    const doc = this.document;
    if (!win || !doc) {
      return false;
    }
    const types = new Set(["copy", "cut", "selectstart"]);
    const nodes = [win, doc, doc.documentElement, doc.body].filter(Boolean);
    for (const node of nodes) {
      for (const type of types) {
        if (node[`on${type}`]) {
          return true;
        }
      }
      for (const info of Services.els.getListenerInfoFor(node)) {
        if (types.has(info.type) && !info.inSystemEventGroup && info.enabled) {
          return true;
        }
      }
    }
    const noSelect = el => !!el && win.getComputedStyle(el)?.userSelect == "none";
    if (noSelect(doc.body) || noSelect(doc.documentElement)) {
      return true;
    }
    // Text under the pointer that can't be selected (not a control).
    const el = target?.nodeType == 1 ? target : target?.parentElement;
    const control = el?.closest?.("button, a, input, select, textarea, label, [role=button], [contenteditable]");
    return !control && noSelect(el) && !!el?.textContent?.trim();
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
      // wave9/lens: readable names for Zap's restore rows.
      case "Whimsy:DescribeSelectors":
        return this.describeSelectors(message.data?.selectors);
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
          WhimsyZapChild.onStart(
            this.contentWindow,
            () => {
              this.sendAsyncMessage("Whimsy:ZapExit");
            },
            () => {
              this.sendAsyncMessage("Whimsy:ZapAccept");
            }
          );
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
      // wave12: call microphone control (MediaSession togglemicrophone and Google Meet)
      case "Whimsy:ToggleMicrophone":
        return this.toggleMicrophone();
      case "Whimsy:GetMicrophoneState":
        return this.getMicrophoneState();
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

  // F32: the call's own microphone button, as the person would press it.
  // Firefox has no Media Session "togglemicrophone" action or
  // setMicrophoneActive(), so Meet (and other calls) only offer the
  // button; Meet marks it with data-is-muted.
  micButton() {
    return this.document?.querySelector(
      'button[data-is-muted], [role="button"][data-is-muted], button[aria-label*="microphone" i], button[data-tooltip*="microphone" i]'
    ) ?? null;
  }

  toggleMicrophone() {
    this.micButton()?.click();
    return this.getMicrophoneState();
  }

  getMicrophoneState() {
    const button = this.micButton();
    if (button?.hasAttribute("data-is-muted")) {
      return { active: button.getAttribute("data-is-muted") != "true" };
    }
    return { active: null };
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
  // the largest video, else the first audio (excluding calls and live streams).
  mainMedia() {
    const media = [...(this.document?.querySelectorAll("video, audio") ?? [])].filter(
      el => (el.readyState > 0 || el.src || el.currentSrc) && !el.srcObject && el.duration !== Infinity
    );
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

  // W10-44: what Cast to AirPlay can send. A plain file goes as it is. A
  // Media Source video (blob:, what most streaming players use) can't, but
  // when the player is streaming HLS (hls.js, video.js, JW Player, Twitch,
  // most video sites outside YouTube) the stream's own .m3u8 playlist plays
  // natively in AVPlayer, which hands it to the Apple TV. The playlist is
  // the video's HLS <source>, else the first one this page fetched (the
  // main playlist comes before its variants). DASH (YouTube) has no such
  // address; that stays Screen Mirroring.
  castSource() {
    const el = this.castVideo();
    if (!el) {
      return null;
    }
    const src = el.currentSrc || el.src || "";
    const time = el.currentTime || 0;
    const base = { paused: el.paused, area: this.area(el) };
    if (!el.srcObject && /^https?:/i.test(src)) {
      return { ...base, src, direct: true, kind: "file", time };
    }
    const hls = el.srcObject ? null : this.hlsPlaylist(el);
    if (hls) {
      // A live stream's position means nothing to AVPlayer: start live.
      const live = !Number.isFinite(el.duration);
      return { ...base, src: hls, direct: true, kind: "hls", live, time: live ? 0 : time };
    }
    return { ...base, src: "", direct: false, kind: "stream", time };
  }

  hlsPlaylist(el) {
    const isPlaylist = url => {
      try {
        const u = new URL(url);
        return (u.protocol == "https:" || u.protocol == "http:") && /\.m3u8$/i.test(u.pathname);
      } catch (e) {
        return false;
      }
    };
    for (const source of el.querySelectorAll("source")) {
      if (source.src && (/mpegurl/i.test(source.type) || isPlaylist(source.src)) && /^https?:/i.test(source.src)) {
        return source.src;
      }
    }
    let entries = [];
    try {
      entries = this.contentWindow.performance.getEntriesByType("resource");
    } catch (e) {
      return null;
    }
    const playlists = entries.filter(entry => isPlaylist(entry.name));
    playlists.sort((a, b) => a.startTime - b.startTime);
    return playlists[0]?.name ?? null;
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
      this.copyKeyGuard = event => {
        if (isCopyKey(event)) {
          event.stopImmediatePropagation();
        }
      };
      for (const type of COPY_EVENTS) {
        win.addEventListener(type, this.copyGuard, true);
      }
      for (const type of COPY_KEY_EVENTS) {
        win.addEventListener(type, this.copyKeyGuard, true);
      }
      win.windowUtils.loadSheetUsingURIString(COPY_SHEET, win.windowUtils.USER_SHEET);
    } else if (!on && this.copyGuard) {
      for (const type of COPY_EVENTS) {
        win.removeEventListener(type, this.copyGuard, true);
      }
      for (const type of COPY_KEY_EVENTS) {
        win.removeEventListener(type, this.copyKeyGuard, true);
      }
      this.copyGuard = null;
      this.copyKeyGuard = null;
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
    // W10-63: whether it's the page's own text (a text fragment can link
    // to it) rather than a field's.
    const inField = !!text;
    if (!text) {
      const selection = win.getSelection();
      text = selection?.toString() ?? "";
      rect = text && selection.rangeCount ? selection.getRangeAt(0).getBoundingClientRect() : null;
    }
    text = text.trim();
    if (!text || !rect) {
      return null;
    }
    return { text, x: win.mozInnerScreenX + rect.left, y: win.mozInnerScreenY + rect.bottom, inField };
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
    // wave9/secfix (security-full-1 L2): only the person's own clicks; a
    // page's synthetic click must not drive the follower pane.
    if (!event.isTrusted || event.defaultPrevented || event.button != 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) {
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
