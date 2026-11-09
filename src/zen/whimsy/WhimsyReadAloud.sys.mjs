/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// W23 voice-image: read aloud (media-4.1–4.11, fu-media 4.5, 4.10, dec-12).
// A media feature, not AI: macOS voices through the window's
// speechSynthesis, so it works with AI off and in private windows. The page
// side (WhimsyReadAloudChild) finds the sentences and tints the current one;
// this side speaks them one at a time and shows a mini player made from
// Zen's media card, in its own box beside Zen's media toolbar (Zen's
// controller owns that toolbar). The tab gets its speaker while reading,
// and muting the tab pauses. Speed and voice are prefs, for every site.

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  Whimsy: "resource:///modules/whimsy/Whimsy.sys.mjs",
  WhimsyCommands: "resource:///modules/whimsy/WhimsyCommands.sys.mjs",
  WhimsySurface: "resource:///modules/whimsy/WhimsySurface.sys.mjs",
  WhimsyVerbs: "resource:///modules/whimsy/WhimsyVerbs.sys.mjs",
});
ChromeUtils.defineLazyGetter(lazy, "l10n", () => new Localization(["browser/whimsy.ftl"], true));

const FEATURE = "read-aloud";
const VOICE_PREF = "whimsy.read-aloud.voice";
const RATE_PREF = "whimsy.read-aloud.rate";
const ICON = "chrome://browser/content/whimsy/icons/listen.svg";
const SHEET = "chrome://browser/content/whimsy/whimsy-read-aloud.css";
const SPEEDS = [0.75, 1, 1.25, 1.5, 2];
// Words a minute at 1×, for progress and time left (macOS voices are near it).
const WPM = 175;
const XUL_NS = "http://www.mozilla.org/keymaster/gatekeeper/there.is.only.xul";
const HTML_NS = "http://www.w3.org/1999/xhtml";

const wordsIn = text => (String(text).match(/\S+/g) ?? []).length;
const formatRate = rate => `${new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(rate)}×`;
const formatTime = seconds => {
  const s = Math.max(0, Math.round(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};
const shortVoice = voice => String(voice?.name ?? "").replace(/\s*\(.*\)\s*$/, "");
const base = tag => String(tag ?? "").split(/[-_]/)[0].toLowerCase();

export class WhimsyReadAloudParent extends JSWindowActorParent {
  receiveMessage(message) {
    if (message.name == "WhimsyReadAloud:Jump") {
      WhimsyReadAloud.jumpFrom(this, message.data?.index);
    }
  }

  didDestroy() {
    WhimsyReadAloud.actorGone(this);
  }
}

export const WhimsyReadAloud = {
  // Tests stand in for speechSynthesis: { speak(u), cancel(), getVoices() }.
  testSynth: null,
  // How long the finished card stays (media-4.9).
  leaveDelay: 5000,
  session: null,
  initialized: false,

  get enabled() {
    return lazy.Whimsy.featureEnabled(FEATURE);
  },

  get rate() {
    const value = Number(Services.prefs.getStringPref(RATE_PREF, "1"));
    return Number.isFinite(value) && value > 0 ? Math.min(4, Math.max(0.5, value)) : 1;
  },

  setRate(rate) {
    Services.prefs.setStringPref(RATE_PREF, String(rate));
  },

  setVoice(uri) {
    Services.prefs.setStringPref(VOICE_PREF, uri ?? "");
  },

  init() {
    if (this.initialized) {
      return;
    }
    this.initialized = true;
    ChromeUtils.registerWindowActor("WhimsyReadAloud", {
      parent: { esModuleURI: "resource:///modules/whimsy/WhimsyReadAloud.sys.mjs" },
      child: { esModuleURI: "resource:///modules/whimsy/WhimsyReadAloudChild.sys.mjs" },
      matches: ["https://*/*", "http://*/*", "file:///*"],
      messageManagerGroups: ["browsers"],
      safeForUntrustedWebProcess: true,
    });
    this.prefObserver = () => this.settingsChanged();
    Services.prefs.addObserver(RATE_PREF, this.prefObserver);
    Services.prefs.addObserver(VOICE_PREF, this.prefObserver);
    const verb = { icon: ICON, run: win => this.listen(win, { mode: "page" }) };
    // ⌘K: Listen to selection with the selection's verbs, and the page's two
    // rows under This page; greyed with the reason where there's nothing to read.
    lazy.WhimsyVerbs.registerVerb({ ...verb, id: "listen-selection", scope: "selection", l10nId: "whimsy-read-aloud-listen-selection", isAvailable: () => this.enabled });
    lazy.WhimsyVerbs.registerVerb({
      ...verb,
      id: "listen-page",
      scope: "page",
      group: "page",
      l10nId: "whimsy-read-aloud-listen-page",
      isAvailable: (win, s, view) => this.enabled && (!!view || this.readable(win)),
      tag: (win, s, view) => (this.readable(win) ? lazy.l10n.formatValueSync("whimsy-read-aloud-minutes", { minutes: this.minutesFor(view?.textChars) }) : null),
      unavailable: win => (this.readable(win) ? null : "whimsy-read-aloud-nothing"),
    });
    lazy.WhimsyVerbs.registerVerb({
      icon: ICON,
      id: "listen-here",
      scope: "page",
      group: "page",
      l10nId: "whimsy-read-aloud-listen-here",
      detail: "whimsy-read-aloud-listen-here-detail",
      isAvailable: win => this.enabled && this.readable(win),
      run: win => this.listen(win, { mode: "here" }),
    });
  },

  initWindow(win) {
    if (!this.enabled) {
      return;
    }
    this.init();
    win.windowUtils.loadSheetUsingURIString(SHEET, win.windowUtils.AUTHOR_SHEET);
    const available = w => this.enabled && this.readable(w);
    lazy.WhimsyCommands.register(win, {
      id: "cmd_whimsyListenPage",
      l10nId: "whimsy-read-aloud-listen-page",
      icon: ICON,
      key: null,
      isAvailable: available,
      run: w => this.listen(w, { mode: "page" }),
    });
    lazy.WhimsyCommands.register(win, {
      id: "cmd_whimsyListenFromHere",
      l10nId: "whimsy-read-aloud-listen-here",
      icon: ICON,
      key: null,
      isAvailable: available,
      run: w => this.listen(w, { mode: "here" }),
    });
    const tabs = win.gBrowser.tabContainer;
    tabs.addEventListener("TabAttrModified", event => {
      if (this.session?.tab == event.target && event.detail?.changed?.includes("muted")) {
        this.muteChanged();
      }
    });
    tabs.addEventListener("TabClose", event => {
      if (this.session?.tab == event.target) {
        this.stop();
      }
    });
  },

  // Reader View found an article here (Firefox checks every page it loads).
  readable(win) {
    return !!win?.gBrowser?.selectedBrowser?.isArticle;
  },

  minutesFor(chars) {
    return Math.max(1, Math.round((chars ?? 0) / 6 / WPM / this.rate));
  },

  synth(win) {
    return this.testSynth ?? win.speechSynthesis;
  },

  voices(win) {
    try {
      return [...(this.synth(win)?.getVoices() ?? [])];
    } catch (e) {
      return [];
    }
  },

  // The saved voice, else the system's, else one in the app's language.
  voice(win) {
    const all = this.voices(win);
    const uri = Services.prefs.getStringPref(VOICE_PREF, "");
    const lang = base(Services.locale.appLocaleAsBCP47);
    return all.find(v => uri && v.voiceURI == uri) ?? all.find(v => v.default) ?? all.find(v => base(v.lang) == lang) ?? all[0] ?? null;
  },

  // ---- Reading.

  async listen(win, { mode = "page" } = {}) {
    if (!this.enabled) {
      return false;
    }
    const tab = win.gBrowser.selectedTab;
    const browser = tab.linkedBrowser;
    let actor = null;
    let found = null;
    try {
      actor = browser.browsingContext?.currentWindowGlobal?.getActor("WhimsyReadAloud");
      found = await actor?.sendQuery("WhimsyReadAloud:Prepare", { mode, tint: this.tint(win) });
    } catch (e) {
      found = null;
    }
    if (!found?.sentences?.length) {
      win.gZenUIManager?.showToast?.("whimsy-read-aloud-nothing");
      return false;
    }
    this.stop({ animate: false });
    const sentences = found.sentences.map(text => ({ text, words: wordsIn(text) }));
    const before = [];
    let sum = 0;
    for (const s of sentences) {
      before.push(sum);
      sum += s.words;
    }
    let site = "";
    try {
      site = browser.currentURI.host.replace(/^www\./, "");
    } catch (e) {
      site = "";
    }
    this.session = {
      win,
      tab,
      actor,
      kind: found.kind,
      sentences,
      before,
      total: sum,
      index: found.start ?? 0,
      offset: 0,
      spoken: 0,
      state: "loading",
      mutePaused: false,
      ownSound: false,
      title: found.title || tab.label,
      site,
    };
    this.showCard(win);
    this.speak();
    return true;
  },

  tint(win) {
    try {
      return win.getComputedStyle(win.document.documentElement).getPropertyValue("--zen-primary-color").trim();
    } catch (e) {
      return "";
    }
  },

  // Speaks the current sentence from `offset` (a word start).
  speak() {
    const s = this.session;
    if (!s) {
      return;
    }
    const sentence = s.sentences[s.index];
    if (!sentence) {
      this.finish();
      return;
    }
    const synth = this.synth(s.win);
    s.utterance = null;
    synth.cancel();
    const text = sentence.text.slice(s.offset);
    const u = this.testSynth ? { text } : new s.win.SpeechSynthesisUtterance(text);
    u.rate = this.rate;
    const voice = this.voice(s.win);
    if (voice) {
      u.voice = voice;
      if (!this.testSynth) {
        u.lang = voice.lang;
      }
    }
    const from = s.offset;
    u.onstart = () => {
      if (s.utterance == u && s.state == "loading") {
        s.state = "playing";
        this.render();
      }
    };
    u.onboundary = event => {
      if (s.utterance == u && event.name != "sentence") {
        s.charIndex = from + (event.charIndex ?? 0);
        s.spoken = wordsIn(sentence.text.slice(0, s.charIndex));
        this.render();
      }
    };
    u.onend = () => {
      if (s.utterance == u && this.session == s) {
        s.utterance = null;
        s.index++;
        s.offset = 0;
        s.charIndex = 0;
        s.spoken = 0;
        this.speak();
      }
    };
    u.onerror = event => {
      if (s.utterance == u && event?.error != "interrupted" && event?.error != "canceled") {
        u.onend();
      }
    };
    s.utterance = u;
    s.charIndex = from;
    if (s.state != "loading") {
      s.state = "playing";
    }
    this.mark();
    this.sound(true);
    synth.speak(u);
    this.render();
  },

  mark(paused = false) {
    const s = this.session;
    s?.actor?.sendQuery("WhimsyReadAloud:Mark", { index: s.index, paused }).catch(() => {});
  },

  // While reading, the tab shows its speaker (Whimsy's tab speaker); only
  // what this set is taken away, so real page audio keeps its own.
  sound(on) {
    const s = this.session;
    if (!s) {
      return;
    }
    if (on && !s.tab.hasAttribute("soundplaying")) {
      s.tab.toggleAttribute("soundplaying", true);
      s.ownSound = true;
    } else if (!on && s.ownSound) {
      s.tab.removeAttribute("soundplaying");
      s.ownSound = false;
    }
  },

  pause({ byMute = false } = {}) {
    const s = this.session;
    if (!s || (s.state != "playing" && s.state != "loading")) {
      return;
    }
    s.utterance = null;
    this.synth(s.win).cancel();
    // Carries on from the word it stopped at.
    s.offset = s.charIndex ?? 0;
    s.state = "paused";
    s.mutePaused = byMute;
    this.mark(true);
    // The speaker goes like any paused media's (media-4.7); a muted tab
    // still shows its muted one (media-4.8).
    this.sound(false);
    this.render();
  },

  resume() {
    const s = this.session;
    if (!s) {
      return;
    }
    if (s.state == "finished") {
      s.index = 0;
      s.offset = 0;
      s.spoken = 0;
      this.cancelLeave();
    } else if (s.state != "paused") {
      return;
    }
    s.mutePaused = false;
    s.state = "playing";
    if (s.tab.hasAttribute("muted")) {
      s.tab.toggleMuteAudio();
    }
    this.speak();
  },

  toggle() {
    const state = this.session?.state;
    if (state == "playing" || state == "loading") {
      this.pause();
    } else {
      this.resume();
    }
  },

  // Previous and next skip sentences (media-4.3).
  step(delta) {
    const s = this.session;
    if (!s || s.state == "finished") {
      return;
    }
    this.goTo(Math.max(0, Math.min(s.sentences.length - 1, s.index + delta)));
  },

  goTo(index) {
    const s = this.session;
    if (!s || !(index >= 0 && index < s.sentences.length)) {
      return;
    }
    this.cancelLeave();
    s.index = index;
    s.offset = 0;
    s.charIndex = 0;
    s.spoken = 0;
    if (s.state == "paused") {
      s.mutePaused = false;
      if (s.tab.hasAttribute("muted")) {
        this.mark(true);
        this.render();
        return;
      }
    }
    s.state = s.state == "loading" ? "loading" : "playing";
    this.speak();
  },

  jumpFrom(actor, index) {
    if (this.session?.actor == actor) {
      this.goTo(index);
    }
  },

  actorGone(actor) {
    if (this.session?.actor == actor) {
      this.stop();
    }
  },

  muteChanged() {
    const s = this.session;
    if (!s) {
      return;
    }
    if (s.tab.hasAttribute("muted")) {
      this.pause({ byMute: true });
    } else if (s.state == "paused" && s.mutePaused) {
      s.mutePaused = false;
      s.state = "playing";
      this.speak();
    }
    this.render();
  },

  // A new speed or voice applies from the word being read.
  settingsChanged() {
    const s = this.session;
    if (s?.state == "playing" || s?.state == "loading") {
      s.offset = s.charIndex ?? 0;
      this.speak();
    } else {
      this.render();
    }
  },

  finish() {
    const s = this.session;
    if (!s) {
      return;
    }
    s.state = "finished";
    s.index = s.sentences.length - 1;
    s.spoken = s.sentences[s.index]?.words ?? 0;
    s.utterance = null;
    // The highlight clears; the sentences stay for Replay.
    s.actor?.sendQuery("WhimsyReadAloud:Mark", { index: -1 }).catch(() => {});
    this.sound(false);
    this.render();
    this.scheduleLeave();
  },

  stop({ animate = true } = {}) {
    const s = this.session;
    if (!s) {
      return;
    }
    this.session = null;
    this.cancelLeave();
    s.utterance = null;
    try {
      this.synth(s.win).cancel();
    } catch (e) {
      // The window is closing.
    }
    s.actor?.sendQuery("WhimsyReadAloud:Clear").catch(() => {});
    if (s.ownSound) {
      s.tab.removeAttribute("soundplaying");
    }
    this.hideCard(s.win, s.card, animate);
  },

  // The finished card leaves after 5s, unless the pointer is on it.
  scheduleLeave() {
    const s = this.session;
    this.cancelLeave();
    s.leaveTimer = s.win.setTimeout(() => {
      if (this.session != s) {
        return;
      }
      if (s.holder?.matches(":hover")) {
        s.holder.addEventListener("mouseleave", () => this.session == s && s.state == "finished" && this.scheduleLeave(), { once: true });
        return;
      }
      this.stop();
    }, this.leaveDelay);
  },

  cancelLeave() {
    const s = this.session;
    if (s?.leaveTimer) {
      s.win.clearTimeout(s.leaveTimer);
      s.leaveTimer = null;
    }
  },

  // ---- The mini player (Zen's media card).

  holder(win) {
    const doc = win.document;
    let holder = doc.getElementById("whimsy-read-aloud-player");
    if (holder) {
      return holder;
    }
    const zen = doc.getElementById("zen-media-controls-toolbar");
    if (!zen) {
      return null;
    }
    holder = doc.createXULElement("vbox");
    holder.id = "whimsy-read-aloud-player";
    holder.hidden = true;
    zen.after(holder);
    return holder;
  },

  showCard(win) {
    const s = this.session;
    const doc = win.document;
    const holder = this.holder(win);
    const template = doc.getElementById("zen-media-card-template");
    if (!holder || !template) {
      return;
    }
    for (const old of holder.querySelectorAll(".zen-media-card")) {
      old.remove();
    }
    const fragment = doc.importNode(template.content, true);
    const card = fragment.querySelector(".zen-media-card");
    card.classList.add("whimsy-read-aloud-card");
    card.querySelector(".zen-media-pip-button")?.remove();
    card.querySelector(".media-device-buttons")?.remove();
    card.querySelector(".zen-media-notes")?.remove();
    const q = sel => card.querySelector(sel);
    const els = {
      title: q(".zen-media-title"),
      artist: q(".zen-media-artist"),
      close: q(".zen-media-close-button"),
      progress: q(".zen-media-progress-bar"),
      current: q(".zen-media-current-time"),
      duration: q(".zen-media-duration"),
      focus: q(".zen-media-focus-button"),
      prev: q(".zen-media-previoustrack-button"),
      play: q(".zen-media-playpause-button"),
      next: q(".zen-media-nexttrack-button"),
      mute: q(".zen-media-mute-button"),
    };
    const speed = doc.createElementNS(HTML_NS, "button");
    speed.className = "whimsy-read-aloud-speed";
    speed.type = "button";
    speed.setAttribute("aria-haspopup", "menu");
    const speedText = doc.createElementNS(HTML_NS, "span");
    speed.append(speedText);
    els.mute.after(speed);
    els.speed = speed;
    els.speedText = speedText;
    const l10n = {
      close: "whimsy-read-aloud-close",
      focus: "whimsy-read-aloud-focus",
      prev: "whimsy-read-aloud-previous",
      next: "whimsy-read-aloud-next",
      mute: "whimsy-read-aloud-mute",
    };
    for (const [name, id] of Object.entries(l10n)) {
      doc.l10n.setAttributes(els[name], id);
    }
    for (const name of ["prev", "play", "next", "mute"]) {
      els[name].setAttribute("tabindex", "0");
    }
    for (const name of ["close", "focus"]) {
      els[name].setAttribute("tabindex", "-1");
    }
    els.progress.setAttribute("tabindex", "-1");
    els.prev.addEventListener("command", () => this.step(-1));
    els.next.addEventListener("command", () => this.step(1));
    els.play.addEventListener("command", () => this.toggle());
    els.mute.addEventListener("command", () => this.session?.tab.toggleMuteAudio());
    els.close.addEventListener("command", () => this.stop());
    els.focus.addEventListener("command", () => {
      if (this.session) {
        win.gBrowser.selectedTab = this.session.tab;
      }
    });
    speed.addEventListener("click", () => this.openSpeedMenu(win, speed));
    els.progress.addEventListener("change", () => {
      const cur = this.session;
      if (!cur) {
        return;
      }
      const words = Number(els.progress.value);
      const index = cur.before.findLastIndex(n => n <= words);
      this.goTo(Math.max(0, index));
    });
    card.addEventListener("keydown", event => this.cardKey(event));
    card.addEventListener("keyup", event => {
      if (event.key == " ") {
        event.preventDefault();
        event.stopPropagation();
      }
    });
    s.card = card;
    s.els = els;
    s.holder = holder;
    els.focus.style.listStyleImage = `url(${s.tab.linkedBrowser.mIconURL || `page-icon:${s.tab.linkedBrowser.currentURI.spec}`})`;
    els.title.textContent = s.title;
    holder.append(card);
    holder.hidden = false;
    this.render();
    win.requestAnimationFrame(() => {
      if (card.isConnected) {
        holder.style.setProperty("--whimsy-read-aloud-collapsed", `${card.getBoundingClientRect().height}px`);
      }
    });
  },

  // Space plays and pauses; ← and → step sentences while the card has focus.
  cardKey(event) {
    if (event.altKey || event.metaKey || event.ctrlKey) {
      return;
    }
    const handled = { " ": () => this.toggle(), ArrowLeft: () => this.step(-1), ArrowRight: () => this.step(1) }[event.key];
    if (handled && !event.target.closest?.(".zen-media-progress-bar")) {
      event.preventDefault();
      event.stopPropagation();
      handled();
    }
  },

  render() {
    const s = this.session;
    const els = s?.els;
    if (!els) {
      return;
    }
    const doc = s.win.document;
    const { card } = s;
    card.classList.toggle("playing", s.state == "playing");
    card.toggleAttribute("busy", s.state == "loading");
    card.toggleAttribute("finished", s.state == "finished");
    card.toggleAttribute("muted", s.tab.hasAttribute("muted"));
    const finished = s.state == "finished";
    for (const button of [els.prev, els.next]) {
      if (finished || s.state == "loading") {
        button.setAttribute("disabled", "true");
      } else {
        button.removeAttribute("disabled");
      }
    }
    const playId = finished ? "whimsy-read-aloud-replay" : s.state == "playing" ? "whimsy-read-aloud-pause" : "whimsy-read-aloud-play";
    if (els.play.getAttribute("data-l10n-id") != playId) {
      doc.l10n.setAttributes(els.play, playId);
    }
    const rate = this.rate;
    const totalSeconds = (s.total / WPM / rate) * 60;
    const done = finished ? s.total : (s.before[s.index] ?? 0) + (s.spoken ?? 0);
    if (finished) {
      doc.l10n.setAttributes(els.artist, "whimsy-read-aloud-finished", { minutes: Math.max(1, Math.round(totalSeconds / 60)) });
    } else {
      doc.l10n.setAttributes(els.artist, "whimsy-read-aloud-artist", { site: s.site, voice: shortVoice(this.voice(s.win)) || "" });
    }
    els.progress.max = String(Math.max(1, s.total));
    els.progress.value = String(done);
    els.current.textContent = formatTime((done / WPM / rate) * 60);
    els.duration.textContent = formatTime(totalSeconds);
    els.speedText.textContent = formatRate(rate);
    doc.l10n.setAttributes(els.speed, "whimsy-read-aloud-speed", { rate: formatRate(rate) });
  },

  hideCard(win, card, animate) {
    const holder = card?.parentElement;
    if (!card || !holder) {
      return;
    }
    const done = () => {
      card.remove();
      if (!holder.querySelector(".zen-media-card")) {
        holder.hidden = true;
      }
    };
    const reduce = win.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (!animate || reduce || holder.hidden) {
      done();
      return;
    }
    // Zen's exit (zen-removing): the card sinks and fades where it is.
    card.style.bottom = `${holder.getBoundingClientRect().bottom - card.getBoundingClientRect().bottom}px`;
    card.setAttribute("zen-removing", "true");
    win.requestAnimationFrame(() =>
      Promise.allSettled(card.getAnimations().map(a => a.finished)).then(done)
    );
  },

  // The speed menu (media-4.5): five speeds, then Voice ›.
  openSpeedMenu(win, anchor) {
    const voice = this.voice(win);
    const options = SPEEDS.map(rate => ({
      value: String(rate),
      text: formatRate(rate),
      detailL10nId: rate == 1 ? "whimsy-read-aloud-speed-normal" : undefined,
    }));
    options.push({
      rule: true,
      value: "voice",
      l10nId: "whimsy-read-aloud-voice",
      detailL10nId: "whimsy-read-aloud-voice-detail",
      detailL10nArgs: { name: shortVoice(voice) },
      expand: ({ done }) => this.voiceList(win, done),
    });
    anchor.setAttribute("open", "true");
    return lazy.WhimsySurface.openListbox(win, {
      id: "whimsy-read-aloud-speed-menu",
      anchor,
      options,
      value: String(this.rate),
      width: 180,
      position: "before_end",
      onPick: value => {
        if (String(value).startsWith("voice:")) {
          this.setVoice(value.slice(6));
        } else if (Number(value) > 0) {
          this.setRate(Number(value));
        }
      },
      onHidden: () => anchor.removeAttribute("open"),
    });
  },

  // Voices for the app's language (and the one in use), as menu options.
  voiceOptions(win) {
    const lang = base(Services.locale.appLocaleAsBCP47);
    const current = this.voice(win);
    return this.voices(win)
      .filter(v => base(v.lang) == lang || v.voiceURI == current?.voiceURI)
      .sort((a, b) => a.name.localeCompare(b.name));
  },

  voiceList(win, done) {
    const doc = win.document;
    const current = this.voice(win);
    const list = doc.createElementNS(HTML_NS, "div");
    list.className = "whimsy-surface-listbox";
    list.setAttribute("role", "listbox");
    for (const v of this.voiceOptions(win)) {
      const row = doc.createElementNS(HTML_NS, "div");
      row.className = "whimsy-surface-option";
      row.setAttribute("role", "option");
      const on = v.voiceURI == current?.voiceURI;
      row.setAttribute("aria-selected", on ? "true" : "false");
      row.tabIndex = on ? 0 : -1;
      if (on) {
        row.setAttribute("autofocus", "true");
      }
      const check = doc.createElementNS(XUL_NS, "image");
      check.className = "whimsy-surface-option-check";
      check.setAttribute("src", "chrome://global/skin/icons/check.svg");
      const label = doc.createElementNS(HTML_NS, "span");
      label.className = "whimsy-surface-option-label";
      label.textContent = v.name;
      row.append(check, label);
      const pick = () => done(`voice:${v.voiceURI}`);
      row.addEventListener("click", pick);
      row.addEventListener("keydown", event => {
        if (event.key == "Enter" || event.key == " ") {
          event.preventDefault();
          pick();
        } else if (event.key == "ArrowDown" || event.key == "ArrowUp") {
          event.preventDefault();
          const sibling = event.key == "ArrowDown" ? row.nextElementSibling : row.previousElementSibling;
          sibling?.focus();
        }
      });
      list.append(row);
    }
    return list;
  },
};
