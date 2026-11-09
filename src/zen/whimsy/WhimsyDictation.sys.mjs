/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// W23 voice-image: dictation, on this Mac only (media-5.x, fu-media 5.2,
// dec-15). Hold Fn (300ms, Whimsy frontmost) to dictate into the focused
// field: the words go in as a composition, greyed until final, and nothing
// is ever sent. With no field, the command bar opens listening. The
// command bar's mic listens on a click; holding ⌘K speaks into the open
// menu (WhimsyVerbs). Speech is recognized by nsIWhimsySpeech
// (requiresOnDeviceRecognition): without an on-device model for the
// language there is nothing to fall back to, so setup steps show and no
// audio is taken. Works with AI off and in private windows.

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  BrowserWindowTracker: "resource:///modules/BrowserWindowTracker.sys.mjs",
  pickLocale: "resource:///modules/whimsy/WhimsyLiveSpeech.sys.mjs",
  Whimsy: "resource:///modules/whimsy/Whimsy.sys.mjs",
  WhimsyAIHints: "resource:///modules/whimsy/WhimsyAIHints.sys.mjs",
  WhimsyCommandBarAI: "resource:///modules/whimsy/WhimsyCommandBarAI.sys.mjs",
  WhimsyCommands: "resource:///modules/whimsy/WhimsyCommands.sys.mjs",
  WhimsySurface: "resource:///modules/whimsy/WhimsySurface.sys.mjs",
});

const FEATURE = "dictation";
const HOLD_FN_PREF = "whimsy.dictation.hold-fn";
// The composition's colour while words aren't final (LookAndFeel reads
// ui.* prefs live); cleared when dictation ends, and at startup in case a
// crash left it.
const GREY_PREF = "ui.IMERawInputForeground";
const UNDERLINE_PREF = "ui.IMERawInputUnderlineStyle";
const GREY = "#8e8e93";
const SHEET = "chrome://browser/content/whimsy/whimsy-dictation.css";
const MIC_ICON = "chrome://browser/content/whimsy/icons/mic.svg";
const HTML_NS = "http://www.w3.org/1999/xhtml";
// How long a press of Fn must last to be ours (a tap is macOS's).
const HOLD_MS = 300;
// After letting go, how long the recognizer gets to punctuate the end.
const FINISH_MS = 2000;
const DONE_MS = 1200;
const LANG_TAG = /^[a-zA-Z]{2,3}([-_][a-zA-Z0-9]{1,8})*$/;

// Words not yet final are drawn grey and not underlined (media-5.5); the
// prefs are ours only while they hold our values.
function greyComposition(on) {
  if (on) {
    Services.prefs.setStringPref(GREY_PREF, GREY);
    Services.prefs.setIntPref(UNDERLINE_PREF, 0);
  } else if (Services.prefs.getStringPref(GREY_PREF, "") == GREY) {
    Services.prefs.clearUserPref(GREY_PREF);
    Services.prefs.clearUserPref(UNDERLINE_PREF);
  }
}

function h(doc, tag, attrs = {}, ...kids) {
  const el = doc.createElementNS(HTML_NS, tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k == "class") {
      el.className = v;
    } else if (k == "l10n") {
      doc.l10n.setAttributes(el, ...[].concat(v));
    } else {
      el.setAttribute(k, v);
    }
  }
  el.append(...kids);
  return el;
}

function wave(doc) {
  const box = h(doc, "span", { class: "whimsy-dictation-wave", "aria-hidden": "true" });
  for (let i = 0; i < 7; i++) {
    box.append(h(doc, "i"));
  }
  return box;
}

function alive(win) {
  return win && !win.closed && win.gBrowser;
}

// Words that stayed the same across two partial answers are settled; the
// rest is the unsure tail, drawn greyed in the command bar.
function settledLength(previous, next) {
  const a = previous.split(/(\s+)/);
  const b = next.split(/(\s+)/);
  let length = 0;
  for (let i = 0; i < Math.min(a.length, b.length) - 1; i++) {
    if (a[i] != b[i]) {
      break;
    }
    length += b[i].length;
  }
  return length;
}

export const WhimsyDictation = {
  // For tests: a stand-in for nsIWhimsySpeech.
  testSpeech: null,
  // The one dictation at a time: {win, target, trigger, phase, ...}.
  active: null,
  _fnWatch: null,
  _fnTimer: 0,
  _fnHeld: false,
  _barOpens: 0,
  _windows: new Set(),

  setTestSpeech(speech) {
    this.cancel();
    this.testSpeech = speech;
    this._stopFnWatch();
    if (this._windows.size) {
      this._startFnWatch();
    }
  },

  get enabled() {
    return lazy.Whimsy.featureEnabled(FEATURE);
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

  /** Whether dictation can be offered in this window at all. */
  available() {
    return this.enabled && !!this.speech();
  },

  wantedLanguages() {
    const tags = [];
    try {
      tags.push(Services.locale.appLocaleAsBCP47, ...Services.locale.regionalPrefsLocales, ...Services.locale.requestedLocales);
    } catch {}
    return tags.filter(tag => LANG_TAG.test(tag));
  },

  // ---- Windows.
  initWindow(win) {
    if (!this.enabled || !win.gURLBar) {
      return;
    }
    greyComposition(false);
    win.windowUtils.loadSheetUsingURIString(SHEET, win.windowUtils.AUTHOR_SHEET);
    this._windows.add(win);
    win.addEventListener(
      "unload",
      () => {
        this._windows.delete(win);
        if (this.active?.win == win) {
          this.cancel();
        }
        if (!this._windows.size) {
          this._stopFnWatch();
        }
      },
      { once: true }
    );
    this.mountMic(win);
    // Leaving the window turns the mic off, however it was started.
    win.addEventListener("deactivate", () => {
      this.onFn("blur");
      if (this.active?.win == win) {
        this.stop();
      }
    });
    win.gURLBar.controller?.addListener({
      onViewOpen: () => this.onBarOpen(win),
      onViewClose: () => {
        if (this.active?.win == win && this.active.target != "field") {
          this.cancel();
        }
      },
    });
    this.registerHint();
    lazy.WhimsyCommands.register(win, {
      id: "cmd_whimsyDictate",
      l10nId: "whimsy-dictation-command",
      icon: MIC_ICON,
      isAvailable: () => this.available(),
      run: w => this.start(w, { target: "commandbar", trigger: "command" }),
    });
    if (!this._fnWatch) {
      this._startFnWatch();
    }
  },

  registerHint() {
    lazy.WhimsyAIHints.register({
      id: "voice",
      l10nId: "whimsy-dictation-hint",
      isVisible: w => !!w.gURLBar?.view.isOpen && !!this.mic(w)?.getBoundingClientRect().width,
    });
  },

  _startFnWatch() {
    const speech = this.speech();
    if (!speech?.watchFnKey) {
      return;
    }
    try {
      this._fnWatch = speech.watchFnKey(what => this.onFn(String(what)));
    } catch (e) {
      console.error("Whimsy dictation: no Fn watch", e);
    }
  },

  _stopFnWatch() {
    try {
      this._fnWatch?.stop();
    } catch {}
    this._fnWatch = null;
  },

  mic(win) {
    return win.document.getElementById("whimsy-dictation-mic");
  },

  /** The mic in the command bar's slot (WhimsyCommandBarAI.micSlot). */
  mountMic(win) {
    const doc = win.document;
    const slot = lazy.WhimsyCommandBarAI.micSlot(win);
    if (!slot || this.mic(win)) {
      return;
    }
    const button = h(doc, "button", { id: "whimsy-dictation-mic", class: "whimsy-dictation-mic", type: "button", "aria-pressed": "false", l10n: "whimsy-dictation-mic" });
    const glyph = h(doc, "span", { class: "whimsy-dictation-mic-glyph", "aria-hidden": "true" });
    const tip = h(doc, "span", { class: "whimsy-dictation-tip", "aria-hidden": "true", l10n: "whimsy-dictation-mic-tip" });
    button.append(glyph, tip);
    // The urlbar takes mousedown for its own focus handling.
    button.addEventListener("mousedown", event => event.stopPropagation());
    button.addEventListener("click", event => {
      event.stopPropagation();
      if (this.active?.win == win) {
        this.stop();
      } else {
        this.start(win, { target: "commandbar", trigger: "mic" });
      }
    });
    button.addEventListener("keydown", event => {
      if (event.key == "Escape" && this.active?.win == win) {
        event.preventDefault();
        event.stopPropagation();
        this.cancel();
      }
    });
    slot.append(button);
  },

  onBarOpen(win) {
    if (!this.available()) {
      return;
    }
    // disc-1.6: the voice hint from the third command bar open on.
    if (++this._barOpens >= 3 && !lazy.WhimsyAIHints.seen("voice")) {
      lazy.WhimsyAIHints.request(win, "voice");
    }
  },

  // ---- Fn.
  onFn(what) {
    if (what == "down") {
      this._fnHeld = true;
      if (!this.available() || !Services.prefs.getBoolPref(HOLD_FN_PREF, true) || this.active) {
        return;
      }
      const win = lazy.BrowserWindowTracker.getTopWindow();
      if (!alive(win) || Services.focus.activeWindow != win) {
        return;
      }
      this._clearFnTimer();
      this._fnTimer = win.setTimeout(() => {
        this._fnTimer = 0;
        if (this._fnHeld) {
          this.startFromFn(win);
        }
      }, HOLD_MS);
      return;
    }
    // "up", "other-key" (Fn was a modifier, as in Fn+←), or "blur".
    const wasHeld = this._fnHeld;
    this._fnHeld = false;
    this._clearFnTimer();
    if (what == "other-key") {
      return;
    }
    if (wasHeld && this.active?.trigger == "fn") {
      this.stop();
    }
  },

  _clearFnTimer() {
    if (this._fnTimer) {
      lazy.BrowserWindowTracker.getTopWindow()?.clearTimeout(this._fnTimer);
      this._fnTimer = 0;
    }
  },

  /** Fn held: the focused field, else the command bar (open or opened). */
  startFromFn(win) {
    const urlbar = win.gURLBar;
    if (urlbar.view.isOpen || urlbar.focused) {
      return this.start(win, { target: "commandbar", trigger: "fn" });
    }
    let status = Ci.nsIDOMWindowUtils.IME_STATUS_DISABLED;
    try {
      status = win.windowUtils.IMEStatus;
    } catch {}
    if (status == Ci.nsIDOMWindowUtils.IME_STATUS_PASSWORD) {
      return null;
    }
    if (status == Ci.nsIDOMWindowUtils.IME_STATUS_ENABLED) {
      return this.start(win, { target: "field", trigger: "fn" });
    }
    urlbar.focus();
    urlbar.select();
    return this.start(win, { target: "commandbar", trigger: "fn" });
  },

  // ---- One dictation.

  /**
   * Starts listening.
   *
   * @param {Window} win
   * @param {object} options
   * @param {"field"|"commandbar"|"cmdk"} options.target
   * @param {"fn"|"mic"|"cmdk"|"command"} [options.trigger]
   * @returns {Promise<boolean>} whether it's listening
   */
  async start(win, { target = "field", trigger = "mic" } = {}) {
    if (!this.available() || !alive(win)) {
      return false;
    }
    this.cancel();
    const speech = this.speech();
    const state = { win, target, trigger, phase: "starting", text: "", settled: 0, base: "", session: null, tip: null, timer: 0 };
    this.active = state;
    lazy.WhimsyAIHints.used("voice");

    let locales = [];
    try {
      locales = speech.onDeviceLocales;
    } catch {}
    const wanted = this.wantedLanguages();
    const locale = lazy.pickLocale(locales, wanted);
    if (!locale) {
      this.active = null;
      this.showSetup(win, wanted[0] ?? "en-US");
      return false;
    }

    this.showListening(state);
    const needsAsk = speech.microphoneStatus == "notDetermined" || speech.authorizationStatus == "notDetermined";
    if (needsAsk) {
      this.setPhase(state, "permission");
    }
    const mic = await this.access(speech, "microphone");
    if (this.active != state) {
      return false;
    }
    const recognition = mic == "authorized" ? await this.access(speech, "speech") : null;
    if (this.active != state) {
      return false;
    }
    if (mic != "authorized" || recognition != "authorized") {
      this.end(state);
      this.showDenied(win, mic != "authorized" ? "microphone" : "speech-recognition");
      return false;
    }

    const listener = {
      QueryInterface: ChromeUtils.generateQI(["nsIWhimsySpeechListener"]),
      onText: (text, isFinal) => this.onText(state, String(text ?? ""), !!isFinal),
      onError: () => this.onText(state, state.text, true),
    };
    try {
      state.session = speech.listen(locale, listener);
    } catch (e) {
      this.end(state);
      this.showSetup(win, locale, "unavailable");
      return false;
    }
    if (target == "field" && !this.beginComposition(state)) {
      this.cancel();
      return false;
    }
    if (target != "field") {
      // Words add to what was typed. A page address the bar shows on opening,
      // or a value that's all selected, is replaced instead.
      const urlbar = win.gURLBar;
      const input = urlbar.inputField;
      const allSelected = input.selectionStart == 0 && input.selectionEnd == input.value.length;
      state.base = urlbar.valueIsTyped && !allSelected ? (urlbar.value ?? "") : "";
      if (state.base && !/\s$/.test(state.base)) {
        state.base += " ";
      }
    }
    this.setPhase(state, "listening");
    return true;
  },

  // "authorized", "denied", ... asking macOS the first time.
  async access(speech, what) {
    const read = () => (what == "microphone" ? speech.microphoneStatus : speech.authorizationStatus);
    let status = read();
    if (status == "notDetermined") {
      status = await new Promise(resolve => {
        try {
          const ask = what == "microphone" ? speech.requestMicrophoneAccess : speech.requestAccess;
          ask.call(speech, (granted, result) => resolve(String(result)));
        } catch {
          resolve("failed");
        }
      });
    }
    return status;
  },

  /** Let go: the microphone goes off, the last words land, final. */
  stop() {
    const state = this.active;
    if (!state) {
      return;
    }
    if (state.phase != "listening") {
      this.cancel();
      return;
    }
    this.setPhase(state, "finishing");
    try {
      state.session?.finish();
    } catch {}
    state.timer = state.win.setTimeout(() => this.onText(state, state.text, true), FINISH_MS);
  },

  /** Stops at once; words not yet final are taken back out. */
  cancel() {
    const state = this.active;
    if (!state) {
      return;
    }
    try {
      state.session?.stop();
    } catch {}
    if (state.tip) {
      try {
        state.tip.cancelComposition();
      } catch {}
    } else if (state.target != "field" && state.phase != "starting" && alive(state.win)) {
      this.setBarText(state, "", 0, true);
    }
    this.end(state);
  },

  end(state) {
    if (state.timer) {
      state.win.clearTimeout(state.timer);
      state.timer = 0;
    }
    if (this.active == state) {
      this.active = null;
    }
    state.phase = "done";
    state.tip = null;
    greyComposition(false);
    if (alive(state.win)) {
      this.hideListening(state);
    }
  },

  onText(state, text, isFinal) {
    if (this.active != state || !alive(state.win)) {
      return;
    }
    if (state.target == "field") {
      this.compose(state, text, isFinal);
    } else {
      const settled = isFinal ? text.length : settledLength(state.text, text);
      this.setBarText(state, text, settled, isFinal);
    }
    state.text = text;
    if (isFinal) {
      try {
        state.session?.stop();
      } catch {}
      const done = state.target == "field" && !!text;
      this.end(state);
      if (done) {
        this.showDone(state);
      }
    } else if (state.target == "field") {
      this.placePill(state);
    }
  },

  // ---- Into a field: an IME composition, so it works in pages and in chrome.
  beginComposition(state) {
    const { win } = state;
    const tip = Cc["@mozilla.org/text-input-processor;1"].createInstance(Ci.nsITextInputProcessor);
    const callback = (processor, notification) => {
      // The editor lost focus or asked to commit: what's there stays.
      if (notification.type == "request-to-commit" || notification.type == "request-to-cancel") {
        if (this.active == state) {
          try {
            state.session?.stop();
          } catch {}
          this.end(state);
        }
      }
      return true;
    };
    try {
      if (!tip.beginInputTransaction(win, callback)) {
        return false;
      }
    } catch {
      return false;
    }
    state.tip = tip;
    state.lead = this.needsSpace(win) ? " " : "";
    greyComposition(true);
    return true;
  },

  // A space first when the caret sits right after a word.
  needsSpace(win) {
    try {
      const utils = win.windowUtils;
      const result = utils.sendQueryContentEvent(utils.QUERY_TEXT_CONTENT, -1, 1, 0, 0, utils.QUERY_CONTENT_FLAG_OFFSET_RELATIVE_TO_INSERTION_POINT);
      return result.succeeded && !!result.text && !/\s/.test(result.text);
    } catch {
      return false;
    }
  },

  compose(state, text, isFinal) {
    const tip = state.tip;
    if (!tip) {
      return;
    }
    const value = text ? state.lead + text : "";
    try {
      if (isFinal) {
        if (value) {
          tip.commitCompositionWith(value);
        } else if (tip.hasComposition) {
          tip.cancelComposition();
        }
        return;
      }
      if (!value) {
        return;
      }
      tip.setPendingCompositionString(value);
      tip.appendClauseToPendingComposition(value.length, tip.ATTR_RAW_CLAUSE);
      tip.setCaretInPendingComposition(value.length);
      tip.flushPendingComposition();
    } catch (e) {
      console.error("Whimsy dictation: composition", e);
    }
  },

  // ---- Into the command bar: its value (so results update), with a mirror
  // that greys the unsure tail.
  setBarText(state, text, settled, isFinal) {
    const { win } = state;
    const urlbar = win.gURLBar;
    const value = state.base + text;
    if (urlbar.value != value) {
      urlbar.inputField.setUserInput(value);
    }
    const mirror = this.mirror(win);
    if (!mirror) {
      return;
    }
    mirror.said.textContent = state.base + text.slice(0, settled);
    mirror.tail.textContent = isFinal ? "" : text.slice(settled);
    this.syncMirror(win);
  },

  mirror(win) {
    const box = win.gURLBar.querySelector(".urlbar-input-box");
    if (!box) {
      return null;
    }
    let el = box.querySelector(".whimsy-dictation-mirror");
    if (!el) {
      const doc = win.document;
      el = h(doc, "div", { class: "whimsy-dictation-mirror", "aria-hidden": "true" });
      el.append(
        h(doc, "span", { class: "whimsy-dictation-said" }),
        h(doc, "span", { class: "whimsy-dictation-tail" }),
        h(doc, "span", { class: "whimsy-dictation-empty", l10n: "whimsy-dictation-placeholder" }),
        wave(doc)
      );
      box.append(el);
    }
    return { el, said: el.children[0], tail: el.children[1] };
  },

  syncMirror(win) {
    const input = win.gURLBar.inputField;
    const mirror = this.mirror(win);
    if (!mirror || !input) {
      return;
    }
    const box = mirror.el.parentElement.getBoundingClientRect();
    const rect = input.getBoundingClientRect();
    const style = win.getComputedStyle(input);
    Object.assign(mirror.el.style, {
      left: `${rect.left - box.left}px`,
      top: `${rect.top - box.top}px`,
      width: `${rect.width}px`,
      height: `${rect.height}px`,
      font: style.font,
      letterSpacing: style.letterSpacing,
      paddingInlineStart: style.paddingInlineStart,
    });
    mirror.el.scrollLeft = input.scrollLeft;
  },

  // ---- What it looks like.
  showListening(state) {
    const { win, target, trigger } = state;
    const urlbar = win.gURLBar;
    const mic = this.mic(win);
    if (target == "field") {
      const pill = this.pill(win);
      pill.removeAttribute("done");
      pill.hidden = false;
      this.placePill(state);
    } else {
      urlbar.setAttribute("whimsy-dictating", target);
      if (target == "cmdk") {
        lazy.WhimsyCommandBarAI.stopNumbers?.(win);
      }
      const mirror = this.mirror(win);
      if (mirror) {
        mirror.said.textContent = urlbar.value;
        mirror.tail.textContent = "";
        this.syncMirror(win);
      }
      const key = urlbar.querySelector(".whimsy-dictation-key") ?? h(win.document, "span", { class: "whimsy-dictation-key" });
      key.hidden = trigger != "cmdk" && trigger != "fn";
      if (!key.hidden) {
        win.document.l10n.setAttributes(key, trigger == "cmdk" ? "whimsy-dictation-release-cmdk" : "whimsy-dictation-release-fn");
      }
      if (!key.isConnected && mic) {
        mic.before(key);
      }
    }
    if (mic && target != "field") {
      mic.setAttribute("listening", "true");
      mic.setAttribute("aria-pressed", "true");
    }
  },

  setPhase(state, phase) {
    state.phase = phase;
    if (state.target == "field") {
      const pill = this.pill(state.win);
      pill.setAttribute("phase", phase);
      this.placePill(state);
    } else {
      state.win.gURLBar.setAttribute("whimsy-dictation-phase", phase);
    }
  },

  hideListening(state) {
    const { win } = state;
    const urlbar = win.gURLBar;
    if (state.target == "field") {
      this.pill(win).hidden = true;
    }
    urlbar.removeAttribute("whimsy-dictating");
    urlbar.removeAttribute("whimsy-dictation-phase");
    urlbar.querySelector(".whimsy-dictation-key")?.remove();
    urlbar.querySelector(".whimsy-dictation-mirror")?.remove();
    const mic = this.mic(win);
    mic?.removeAttribute("listening");
    mic?.setAttribute("aria-pressed", "false");
  },

  // The pill under the caret (media-5.5): listening, waiting, done.
  pill(win) {
    const doc = win.document;
    let pill = doc.getElementById("whimsy-dictation-pill");
    if (pill) {
      return pill;
    }
    pill = h(doc, "div", { id: "whimsy-dictation-pill", class: "whimsy-dictation-pill", role: "status", "aria-live": "polite" });
    pill.hidden = true;
    pill.append(
      wave(doc),
      h(doc, "span", { class: "whimsy-dictation-spinner", "aria-hidden": "true" }),
      h(doc, "span", { class: "whimsy-dictation-check", "aria-hidden": "true" }),
      h(doc, "span", { class: "whimsy-dictation-pill-listening", l10n: "whimsy-dictation-listening" }),
      h(doc, "span", { class: "whimsy-dictation-pill-waiting", l10n: "whimsy-dictation-waiting" }),
      h(doc, "span", { class: "whimsy-dictation-pill-done", l10n: "whimsy-dictation-done" }),
      h(doc, "span", { class: "whimsy-dictation-key", l10n: "whimsy-dictation-release-fn" })
    );
    (doc.getElementById("browser") ?? doc.documentElement).append(pill);
    return pill;
  },

  // Just under the caret of the focused field, in window CSS px, or null.
  caretPoint(win) {
    try {
      const utils = win.windowUtils;
      const caret = utils.sendQueryContentEvent(utils.QUERY_CARET_RECT, 0, 0, 0, 0, utils.QUERY_CONTENT_FLAG_OFFSET_RELATIVE_TO_INSERTION_POINT);
      if (caret.succeeded) {
        const scale = win.devicePixelRatio || 1;
        return { x: caret.left / scale, y: (caret.top + caret.height) / scale };
      }
    } catch {}
    return null;
  },

  placePill(state) {
    const { win } = state;
    const pill = this.pill(win);
    const area = (win.gBrowser.selectedBrowser.closest(".browserStack") ?? win.gBrowser.selectedBrowser).getBoundingClientRect();
    const caret = this.caretPoint(win);
    let x = caret?.x ?? area.left + area.width / 2;
    let y = caret ? caret.y + 12 : area.bottom - 80;
    const width = pill.getBoundingClientRect().width || 160;
    x = Math.max(area.left + 8, Math.min(x - width / 2, area.right - width - 8));
    y = Math.max(area.top + 8, Math.min(y, area.bottom - 40));
    // Fixed to the viewport unless an ancestor contains it: correct by
    // where it actually landed.
    pill.style.left = `${Math.round(x)}px`;
    pill.style.top = `${Math.round(y)}px`;
    const landed = pill.getBoundingClientRect();
    if (landed.width && (Math.abs(landed.left - x) > 1 || Math.abs(landed.top - y) > 1)) {
      pill.style.left = `${Math.round(2 * x - landed.left)}px`;
      pill.style.top = `${Math.round(2 * y - landed.top)}px`;
    }
  },

  // Let go in a field: "Done" under the caret, then it fades (media-5.6).
  showDone(state) {
    const { win } = state;
    const pill = this.pill(win);
    pill.hidden = false;
    pill.setAttribute("phase", "done");
    this.placePill(state);
    win.setTimeout(() => {
      if (!this.active && pill.getAttribute("phase") == "done") {
        pill.hidden = true;
      }
    }, DONE_MS);
  },

  // ---- Panels (WhimsySurface).
  panel(win, { id, titleL10nId, icon, text, buttonL10nId, page }) {
    const S = lazy.WhimsySurface;
    const doc = win.document;
    const urlbar = win.gURLBar;
    const mic = urlbar.view.isOpen || urlbar.focused ? this.mic(win) : null;
    const anchor = mic?.getBoundingClientRect().width ? mic : null;
    // Under the command bar's mic, focus stays in the bar: moving it into the
    // panel would close the bar and take the panel's anchor with it.
    const parts = S.create(win, {
      id,
      width: 320,
      titleL10nId,
      close: true,
      footer: true,
      className: "whimsy-dictation-panel",
      initialFocus: anchor ? false : undefined,
    });
    const glyph = h(doc, "span", { class: `whimsy-dictation-panel-icon is-${icon}`, "aria-hidden": "true" });
    parts.header.prepend(glyph);
    const body = h(doc, "p", { class: "whimsy-dictation-panel-text" });
    doc.l10n.setAttributes(body, ...[].concat(text));
    parts.view.append(body);
    const spacer = doc.createXULElement("spacer");
    spacer.setAttribute("flex", "1");
    const open = S.footerButton(doc, {
      id: `${id}-open`,
      l10nId: buttonL10nId,
      primary: true,
      onCommand: () => {
        try {
          this.speech()?.openSystemSettings(page);
        } catch {}
        S.close(parts.panel);
      },
    });
    open.setAttribute("default", "true");
    parts.footer.append(spacer, open);
    S.finish(parts);
    if (anchor) {
      S.open(win, parts.panel, { anchor, position: "bottomright topright", gap: 6 });
    } else {
      // Where the pill is, else under the caret of the field (media-5.9).
      const pill = this.pill(win);
      const rect = pill.hidden ? null : pill.getBoundingClientRect();
      const caret = rect ? null : win.windowUtils.IMEStatus == Ci.nsIDOMWindowUtils.IME_STATUS_ENABLED && this.caretPoint(win);
      const at = rect ? { x: rect.left, y: rect.top } : caret ? { x: caret.x, y: caret.y + 12 } : null;
      const screenRect = at && { left: win.mozInnerScreenX + at.x, top: win.mozInnerScreenY + at.y, width: 1, height: 1 };
      S.open(win, parts.panel, screenRect ? { screenRect, position: "after_start" } : {});
    }
    return parts.panel;
  },

  /** media-5.9: the microphone or speech recognition is off for Whimsy. */
  showDenied(win, page) {
    return this.panel(win, {
      id: "whimsy-dictation-denied",
      titleL10nId: "whimsy-dictation-denied-title",
      icon: "alert",
      text: page == "microphone" ? "whimsy-dictation-denied-microphone" : "whimsy-dictation-denied-speech",
      buttonL10nId: "whimsy-dictation-open-settings",
      page,
    });
  },

  /** media-5.10: no on-device dictation for the language. */
  showSetup(win, tag, reason = "no-language") {
    let language = tag;
    try {
      language = new Intl.DisplayNames([Services.locale.appLocaleAsBCP47], { type: "language" }).of(String(tag).replace(/_/g, "-")) ?? tag;
    } catch {}
    return this.panel(win, {
      id: "whimsy-dictation-setup",
      titleL10nId: "whimsy-dictation-setup-title",
      icon: "mic",
      text: reason == "unavailable" ? "whimsy-dictation-setup-unavailable" : ["whimsy-dictation-setup-body", { language }],
      buttonL10nId: "whimsy-dictation-open-keyboard",
      page: "keyboard",
    });
  },

  /** What a press of Fn does on this Mac (0 = nothing), or null when unknown. */
  fnKeyUsage() {
    try {
      return this.speech()?.fnKeyUsage ?? null;
    } catch {
      return null;
    }
  },

  openKeyboardSettings() {
    try {
      this.speech()?.openSystemSettings("keyboard");
    } catch {}
  },

  /** ⌘K held 300ms with the menu open (WhimsyVerbs). */
  startFromCmdK(win) {
    if (!this.available() || this.active) {
      return false;
    }
    this.start(win, { target: "cmdk", trigger: "cmdk" });
    return true;
  },
};
