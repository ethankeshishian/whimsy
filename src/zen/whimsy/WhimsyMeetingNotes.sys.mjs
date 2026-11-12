/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// W25: Granola meeting notes (whimsy.feature.meeting-notes). Design:
// whimsy-handoff/intake-w25/mockups/granola.html (approved, round 7).
//
// Whimsy follows a calendar meeting that has a call tab (a tab on the
// event's join link, or a tab in a WebRTC call) by itself: it starts when
// the meeting starts and stops when it ends. While Granola is connected
// (Settings › AI › Connectors, the existing MCP connector) it reads
// Granola's notes for that meeting through Granola's own MCP tools
// (list_meetings, then get_meeting_transcript, else get_meetings) once a
// minute, and when they've grown, the meeting's chat (the call tab's
// thread) shows a short list of key points. Download transcript gets the
// transcript from Granola as a Markdown file.
//
// When Granola can't give notes (none for this meeting, unreachable for 2
// minutes, or signed out), one toast offers Take notes, once per meeting.
// Whimsy's own notes take the call tab's sound (the call captions' tap,
// WhimsyCaptionsChild) and the microphone (nsIWhimsySpeech.listen), both
// recognized on this Mac; Stop on the card ends them. The transcript is
// kept in memory only, until the download or 24 hours after the meeting.

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  clearInterval: "resource://gre/modules/Timer.sys.mjs",
  DownloadPaths: "resource://gre/modules/DownloadPaths.sys.mjs",
  Downloads: "resource://gre/modules/Downloads.sys.mjs",
  FileUtils: "resource://gre/modules/FileUtils.sys.mjs",
  pickLocale: "resource:///modules/whimsy/WhimsyLiveSpeech.sys.mjs",
  PrivateBrowsingUtils: "resource://gre/modules/PrivateBrowsingUtils.sys.mjs",
  setInterval: "resource://gre/modules/Timer.sys.mjs",
  WhimsyAIRouter: "resource:///modules/whimsy/WhimsyAIRouter.sys.mjs",
  WhimsyAIStore: "resource:///modules/whimsy/WhimsyAIStore.sys.mjs",
  WhimsyCallPip: "resource:///modules/whimsy/WhimsyCallPip.sys.mjs",
  WhimsyChat: "resource:///modules/whimsy/WhimsyChat.sys.mjs",
  WhimsyChatContextUI: "resource:///modules/whimsy/WhimsyChatContextUI.sys.mjs",
  WhimsyChatPanel: "resource:///modules/whimsy/WhimsyChatPanel.sys.mjs",
  WhimsyConnectors: "resource:///modules/whimsy/WhimsyConnectors.sys.mjs",
  WhimsyLiveSpeech: "resource:///modules/whimsy/WhimsyLiveSpeech.sys.mjs",
  WhimsyMCPClient: "resource:///modules/whimsy/WhimsyMCPClient.sys.mjs",
  WhimsyNextMeeting: "resource:///modules/whimsy/WhimsyNextMeeting.sys.mjs",
});

const FEATURE_PREF = "whimsy.feature.meeting-notes";
const HTML_NS = "http://www.w3.org/1999/xhtml";
const ICONS = "chrome://browser/content/whimsy/icons/";
const MINUTE = 60 * 1000;
// How long Granola may have nothing (or be unreachable) before Whimsy
// offers its own notes (G.8).
const GRACE_MS = 2 * MINUTE;
// Points refresh only when the notes have grown by this much.
const GROWTH_CHARS = 80;
const NOTES_CHARS = 12000;
const CHIP_CHARS = 12000;
const KEEP_MS = 24 * 60 * MINUTE;
const MAX_POINTS = 6;
// A microphone session that ends this many times within a minute without
// any words is given up on.
const MIC_RESTARTS = 5;

// Granola's MCP tools (docs.granola.ai/help-center/sharing/integrations/mcp).
export const GRANOLA_TOOLS = {
  list: "list_meetings",
  notes: "get_meetings",
  transcript: "get_meeting_transcript",
};

const POINTS_SYSTEM =
  "You keep running notes for a meeting that is still going on. From the notes or transcript you're given, " +
  `write at most ${MAX_POINTS} short key points: decisions, owners, dates, and open questions. ` +
  "One point per line, each starting with \"- \". Plain text, no headings, no preamble. " +
  "Keep earlier points that still hold, in the same words, and add new ones at the end.";

const norm = s => String(s ?? "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

function h(doc, tag, attrs = {}, ...kids) {
  const el = doc.createElementNS(HTML_NS, tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) {
      continue;
    }
    if (k == "class") {
      el.className = v;
    } else if (k == "l10n") {
      doc.l10n.setAttributes(el, ...[].concat(v));
    } else if (k.startsWith("on")) {
      el.addEventListener(k.slice(2), v);
    } else {
      el.setAttribute(k, v === true ? "" : v);
    }
  }
  el.append(...kids.filter(c => c != null && c !== false));
  return el;
}

const icon = (doc, name) => h(doc, "span", { class: "whimsy-chat-icon", "data-icon": name, "aria-hidden": "true" });

/**
 * Granola's list_meetings reply, as {id, title, date}. Granola answers in
 * XML-like text (<meeting id="…" title="…" date="…">); JSON is read too.
 */
export function parseMeetingList(text) {
  const out = [];
  const raw = String(text ?? "").trim();
  try {
    const data = JSON.parse(raw);
    const list = Array.isArray(data) ? data : data?.meetings ?? data?.notes ?? data?.documents ?? [];
    for (const m of Array.isArray(list) ? list : []) {
      const id = m?.id ?? m?.meeting_id ?? m?.document_id;
      if (id) {
        out.push({ id: String(id), title: String(m.title ?? m.name ?? ""), date: Date.parse(m.date ?? m.created_at ?? m.start ?? m.start_time ?? "") || 0 });
      }
    }
    return out;
  } catch {}
  const attr = (tag, name) => {
    const m = new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`, "i").exec(tag);
    return m ? m[1].replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#39;|&apos;/g, "'") : "";
  };
  for (const [tag] of raw.matchAll(/<meeting\b[^>]*>/gi)) {
    const id = attr(tag, "id");
    if (id) {
      out.push({ id, title: attr(tag, "title"), date: Date.parse(attr(tag, "date") || attr(tag, "created_at") || attr(tag, "start")) || 0 });
    }
  }
  return out;
}

/** The Granola meeting that is this calendar event, or null. */
export function matchMeeting(list, event) {
  const title = norm(event.title);
  const near = m => !m.date || (m.date >= event.start - 30 * MINUTE && m.date <= event.end + 5 * MINUTE);
  const named = list.filter(m => title && norm(m.title) && (norm(m.title) == title || norm(m.title).includes(title) || title.includes(norm(m.title))) && near(m));
  const pick = arr => arr.sort((a, b) => b.date - a.date)[0] ?? null;
  if (named.length) {
    return pick(named);
  }
  // Untitled in Granola: the one meeting it started inside this event.
  const timed = list.filter(m => m.date && m.date >= event.start - 5 * MINUTE && m.date <= event.end);
  return timed.length == 1 ? timed[0] : null;
}

/** A tool reply's text: plain, or {transcript|text|notes} in JSON, tags dropped. */
export function replyText(text) {
  const raw = String(text ?? "");
  try {
    const data = JSON.parse(raw);
    const value = data?.transcript ?? data?.text ?? data?.notes ?? data?.content;
    if (typeof value == "string") {
      return value.trim();
    }
    if (Array.isArray(value)) {
      return value.map(x => (typeof x == "string" ? x : x?.text ?? "")).filter(Boolean).join("\n").trim();
    }
  } catch {}
  return raw.replace(/<\/?[a-z_][^>]*>/gi, "").replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * Arguments for one of Granola's tools, from its input schema when the
 * server gave one: the meeting's id, a time range that covers today, and
 * so on. Without a schema, Granola's documented names.
 */
export function argsFor(tool, schema, { meetingId = "", start = Date.now() } = {}) {
  const props = schema?.properties && typeof schema.properties == "object" ? schema.properties : null;
  if (!props) {
    if (tool == GRANOLA_TOOLS.list) {
      return { time_range: "this_week" };
    }
    return tool == GRANOLA_TOOLS.notes ? { meeting_ids: [meetingId] } : { meeting_id: meetingId };
  }
  const args = {};
  for (const [name, spec] of Object.entries(props)) {
    const type = spec?.type;
    if (/(^|_)(meeting|note|document)?_?ids$/i.test(name) || (type == "array" && /ids?$/i.test(name))) {
      if (meetingId) {
        args[name] = [meetingId];
      }
    } else if (/^(meeting_?|note_?|document_?)?id$/i.test(name)) {
      if (meetingId) {
        args[name] = meetingId;
      }
    } else if (/range|period|when/i.test(name)) {
      const options = Array.isArray(spec?.enum) ? spec.enum.map(String) : [];
      args[name] = options.find(o => /today/i.test(o)) ?? options.find(o => /this_?week/i.test(o)) ?? options[0] ?? "this_week";
    } else if (/after|since|from|start/i.test(name) && type == "string") {
      args[name] = new Date(start - 24 * 60 * MINUTE).toISOString();
    } else if (/^(limit|max|count|page_size)$/i.test(name) && (type == "number" || type == "integer")) {
      args[name] = 25;
    }
  }
  return args;
}

/** "- point" lines from an answer, at most MAX_POINTS. */
export function parsePoints(text) {
  return String(text ?? "")
    .split("\n")
    .map(l => l.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, "").trim())
    .filter(l => l && !/:$/.test(l))
    .slice(0, MAX_POINTS);
}

export const WhimsyMeetingNotes = {
  // Tests replace these: the poll, the grace before the offer, the clock,
  // and the speech service.
  pollMs: MINUTE,
  graceMs: GRACE_MS,
  growthChars: GROWTH_CHARS,
  testSpeech: null,
  now: () => Date.now(),

  // The meeting followed (or ended) last: see _fresh().
  state: null,
  _windows: new Set(),
  _timer: null,
  _ticking: null,
  _schemas: null,

  get enabled() {
    return Services.prefs.getBoolPref(FEATURE_PREF, true);
  },

  // ---- per window ----

  initWindow(win) {
    if (!this.enabled || this._windows.has(win) || !win.gBrowser) {
      return;
    }
    this._windows.add(win);
    this._init();
    win.gBrowser.tabContainer.addEventListener("TabClose", this);
    win.addEventListener("unload", () => {
      this._windows.delete(win);
      win.gBrowser?.tabContainer.removeEventListener("TabClose", this);
      if (!this._windows.size) {
        lazy.clearInterval(this._timer);
        this._timer = null;
      }
    }, { once: true });
    this._timer ??= lazy.setInterval(() => this.tick(), this.pollMs);
    this.tick();
  },

  _init() {
    if (this._initialized) {
      return;
    }
    this._initialized = true;
    lazy.WhimsyChat.registerThreadView({ render: panel => this.decorate(panel), id: "meeting-notes" });
    Services.obs.addObserver(this, "whimsy-connectors-changed");
  },

  observe(subject, topic) {
    if (topic == "whimsy-connectors-changed") {
      this._schemas = null;
      this.tick();
    }
  },

  handleEvent(event) {
    if (event.type == "TabClose" && this.state?.tab == event.target && this.state.phase != "ended") {
      // The call tab closed after the start: the meeting is over for us.
      this.end("tab-closed");
    }
  },

  // ---- the meeting ----

  /** The calendar meeting on now, if any. */
  meetingNow(now = this.now()) {
    return lazy.WhimsyNextMeeting.upcoming(now).find(ev => ev.start <= now && ev.end > now && !ev.allDay) ?? null;
  },

  /**
   * The meeting's call tab: one on its join link (or the event's URL),
   * else one in a WebRTC call. Private windows never.
   */
  callTabFor(meeting) {
    // The call link Whimsy found in the event, else the event's own URL.
    const join = meeting?.join?.url ?? meeting?.url ?? "";
    let joinKey = "";
    try {
      const u = new URL(join);
      joinKey = `${u.host}${u.pathname}`.replace(/\/$/, "");
    } catch {}
    let inCall = null;
    for (const win of this._windows) {
      if (win.closed || lazy.PrivateBrowsingUtils.isWindowPrivate(win)) {
        continue;
      }
      for (const tab of win.gBrowser.tabs) {
        const uri = tab.linkedBrowser?.currentURI;
        if (joinKey && uri?.schemeIs?.("https")) {
          const page = URL.parse(uri.spec);
          const here = page ? `${page.host}${page.pathname}`.replace(/\/$/, "") : "";
          if (here == joinKey) {
            return tab;
          }
        }
        if (!inCall && lazy.WhimsyCallPip.isInCall(tab)) {
          inCall = tab;
        }
      }
    }
    return inCall;
  },

  _key: ev => `${norm(ev.title)}@${Math.round(ev.start / MINUTE)}`,

  async _granola() {
    const list = await lazy.WhimsyConnectors.list();
    return list.find(c => c.id == "granola") ?? null;
  },

  /** Once a minute (and when connectors change): follow, refresh, or end. */
  tick() {
    if (!this.enabled) {
      return Promise.resolve();
    }
    // One at a time; a tick that comes while one runs waits for it.
    const run = (this._ticking ?? Promise.resolve()).then(() => this._tick()).catch(e => console.error("Whimsy meeting notes", e));
    this._ticking = run;
    return run;
  },

  async _tick() {
    const now = this.now();
    this._expire(now);
    let s = this.state;
    if (s && s.phase != "ended" && (now >= s.meeting.end || !s.tab?.linkedBrowser)) {
      await this.end(now >= s.meeting.end ? "time" : "tab-closed");
      s = this.state;
    }
    const meeting = this.meetingNow(now);
    if (meeting && (!s || s.key != this._key(meeting))) {
      const tab = this.callTabFor(meeting);
      if (tab) {
        s = this._begin(meeting, tab, now);
      }
    }
    if (!s || s.phase == "ended") {
      this._render();
      return;
    }
    const granola = await this._granola();
    const was = s.connector;
    s.connector = granola?.connected ? (granola.status == "expired" ? "expired" : "on") : "off";
    if (s.connector == "on" && was != "on") {
      // Connected (again) mid-meeting: following starts at once (G.4).
      s.noNotesSince = now;
      s.problem = null;
      if (s.phase == "off") {
        s.phase = "waiting";
      }
    }
    if (s.own) {
      await this._refreshOwn(s);
    } else if (s.connector == "on") {
      await this._refreshGranola(s, now);
    } else if (s.connector == "expired") {
      this._problem(s, "signed-out", now);
    } else {
      s.phase = "off";
    }
    this._publish(s);
  },

  _begin(meeting, tab, now) {
    this._stopOwn(this.state);
    this._closeOffer(this.state);
    this.state = {
      key: this._key(meeting),
      meeting,
      tab,
      startedAt: now,
      phase: "waiting",
      connector: "off",
      source: "granola",
      points: [],
      newPoints: new Set(),
      updatedAt: 0,
      notesText: "",
      summarizedLength: 0,
      granolaId: null,
      noNotesSince: now,
      unreachableSince: 0,
      problem: null,
      problemAt: 0,
      offered: false,
      offer: null,
      own: null,
      ownStopped: false,
      transcript: [],
      endedAt: 0,
      folded: null,
    };
    return this.state;
  },

  // ---- Granola ----

  async _toolSchemas() {
    if (this._schemas) {
      return this._schemas;
    }
    const entry = (await lazy.WhimsyConnectors._read()).connectors.granola;
    if (!entry?.url) {
      return {};
    }
    const token = await lazy.WhimsyConnectors.accessToken("granola").catch(e => {
      if (e?.code == "expired") {
        throw e;
      }
      return null;
    });
    const { tools } = await lazy.WhimsyMCPClient.connect(entry.url, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
    this._schemas = Object.fromEntries(tools.map(t => [t.name, t.inputSchema ?? null]));
    return this._schemas;
  },

  async _call(tool, args) {
    return lazy.WhimsyConnectors.call("granola", tool, args);
  },

  /** Granola's notes for this meeting so far: transcript first, else its notes. */
  async granolaNotes(s, { transcriptOnly = false } = {}) {
    const schemas = await this._toolSchemas();
    const has = name => !Object.keys(schemas).length || name in schemas;
    if (!s.granolaId) {
      if (!has(GRANOLA_TOOLS.list)) {
        return { text: "", missing: true };
      }
      const listed = parseMeetingList(await this._call(GRANOLA_TOOLS.list, argsFor(GRANOLA_TOOLS.list, schemas[GRANOLA_TOOLS.list], { start: s.meeting.start })));
      s.granolaId = matchMeeting(listed, s.meeting)?.id ?? null;
      if (!s.granolaId) {
        return { text: "" };
      }
    }
    const args = tool => argsFor(tool, schemas[tool], { meetingId: s.granolaId, start: s.meeting.start });
    if (has(GRANOLA_TOOLS.transcript)) {
      try {
        const text = replyText(await this._call(GRANOLA_TOOLS.transcript, args(GRANOLA_TOOLS.transcript)));
        if (text || transcriptOnly) {
          return { text, kind: "transcript" };
        }
      } catch (e) {
        // Transcripts are for Granola's paid plans: its notes still help.
        if (e?.code != "tool-failed" || transcriptOnly) {
          throw e;
        }
      }
    }
    if (transcriptOnly || !has(GRANOLA_TOOLS.notes)) {
      return { text: "" };
    }
    return { text: replyText(await this._call(GRANOLA_TOOLS.notes, args(GRANOLA_TOOLS.notes))), kind: "notes" };
  },

  async _refreshGranola(s, now) {
    let got;
    try {
      got = await this.granolaNotes(s);
    } catch (e) {
      if (e?.code == "expired" || e?.code == "auth") {
        await lazy.WhimsyConnectors.markExpired?.("granola");
        s.connector = "expired";
        this._problem(s, "signed-out", now);
      } else {
        s.unreachableSince ||= now;
        this._problem(s, "unreachable", now);
        if (now - s.unreachableSince >= this.graceMs) {
          this.offer(s);
        }
      }
      return;
    }
    s.unreachableSince = 0;
    s.problem = null;
    if (!got.text) {
      if (s.phase != "live") {
        s.phase = "waiting";
      }
      if (now - s.noNotesSince >= this.graceMs) {
        this.offer(s);
      }
      return;
    }
    s.noNotesSince = now;
    this._closeOffer(s);
    s.notesText = got.text;
    await this._summarize(s);
  },

  _problem(s, problem, now) {
    if (s.problem != problem) {
      s.problemAt = now;
    }
    s.problem = problem;
    if (problem == "signed-out") {
      // For the rest of this meeting, Whimsy offers its own notes (G.9).
      this.offer(s);
    }
  },

  /** Key points from the notes, when they've grown enough. */
  async _summarize(s) {
    const text = s.notesText;
    if (text.length - s.summarizedLength < this.growthChars && s.points.length) {
      if (s.phase == "waiting") {
        s.phase = "live";
      }
      return;
    }
    const before = s.points;
    let points;
    try {
      const result = await lazy.WhimsyAIRouter.run({
        task: "summary",
        system: POINTS_SYSTEM,
        messages: [{ role: "user", content: `Meeting: ${s.meeting.title}\n\nPoints so far:\n${before.map(p => `- ${p}`).join("\n") || "(none)"}\n\nNotes so far:\n${text.slice(-NOTES_CHARS)}` }],
        tools: [],
      });
      points = parsePoints(result?.text);
    } catch (e) {
      console.error("Whimsy meeting notes: points", e?.code ?? e);
      return;
    }
    if (!points.length) {
      return;
    }
    s.summarizedLength = text.length;
    s.newPoints = new Set(points.filter(p => !before.includes(p)));
    s.points = points;
    s.updatedAt = this.now();
    s.phase = "live";
  },

  // ---- the offer and Whimsy's own notes ----

  /** Take notes, once per meeting, in the call tab's window (G.10). */
  offer(s = this.state) {
    if (!s || s.offered || s.own || s.phase == "ended") {
      return;
    }
    s.offered = true;
    const win = s.tab?.documentGlobal;
    if (!win?.gZenUIManager?.toasts) {
      return;
    }
    s.offer = win.gZenUIManager.toasts.open("whimsy-meeting-offer-title", {
      key: "whimsy-meeting-offer",
      l10nArgs: { meeting: s.meeting.title },
      descriptionId: "whimsy-meeting-offer-text",
      icon: `${ICONS}mic.svg`,
      timeout: 0,
      buttons: [{ id: "whimsy-meeting-take-notes", l10nId: "whimsy-meeting-take-notes", command: () => { this.takeNotes(); } }],
    });
  },

  _closeOffer(s) {
    s?.offer?.close?.();
    if (s) {
      s.offer = null;
    }
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

  async _access(speech, what) {
    let status = what == "microphone" ? speech.microphoneStatus : speech.authorizationStatus;
    if (status == "notDetermined") {
      status = await new Promise(resolve => {
        try {
          (what == "microphone" ? speech.requestMicrophoneAccess : speech.requestAccess).call(speech, (granted, result) => resolve(String(result)));
        } catch {
          resolve("failed");
        }
      });
    }
    return status;
  },

  /** Take notes: the call's sound and the microphone, on this Mac. */
  async takeNotes() {
    const s = this.state;
    if (!s || s.own || s.phase == "ended") {
      return false;
    }
    this._closeOffer(s);
    const own = (s.own = { call: "starting", mic: "starting", problem: null, restarts: [] });
    s.source = "own";
    s.phase = s.points.length ? "live" : "waiting";
    s.problem = null;
    s.notesText = "";
    s.summarizedLength = 0;
    this._publish(s);
    const speech = this.speech();
    let locale = null;
    try {
      locale = speech ? lazy.pickLocale(speech.onDeviceLocales, lazy.WhimsyLiveSpeech.wantedLanguages()) : null;
    } catch {}
    const recognition = speech && locale ? await this._access(speech, "speech") : "unavailable";
    if (s.own != own) {
      return false;
    }
    if (recognition != "authorized") {
      own.problem = recognition == "denied" || recognition == "restricted" ? "speech-denied" : "unavailable";
      own.call = own.mic = "off";
      this._publish(s);
      return false;
    }
    own.locale = locale;
    // The call's sound, from the call tab (WhimsyVideoSpeedChild).
    const actor = s.tab.linkedBrowser?.browsingContext?.currentWindowGlobal?.getActor("WhimsyVideoSpeed");
    try {
      const ok = await actor?.sendQuery("WhimsyVideoSpeed:NotesListen", { on: true });
      own.call = ok ? "on" : "off";
    } catch {
      own.call = "off";
    }
    // And the microphone.
    const mic = await this._access(speech, "microphone");
    if (s.own != own) {
      return false;
    }
    if (mic == "authorized") {
      this._listenMic(s, speech);
    } else {
      own.mic = "denied";
    }
    this._publish(s);
    return true;
  },

  _listenMic(s, speech) {
    const own = s.own;
    const listener = {
      QueryInterface: ChromeUtils.generateQI(["nsIWhimsySpeechListener"]),
      onText: (text, isFinal) => {
        if (s.own != own || !isFinal) {
          return;
        }
        this.heard(String(text ?? ""), "me");
        // One dictation ends at each pause: the next one starts at once.
        this._restartMic(s, speech, !!String(text ?? "").trim());
      },
      onError: () => {
        if (s.own == own) {
          this._restartMic(s, speech, false);
        }
      },
    };
    try {
      own.micSession = speech.listen(own.locale, listener);
      own.mic = "on";
    } catch {
      own.mic = "off";
    }
  },

  _restartMic(s, speech, heardWords) {
    const own = s.own;
    if (!own || own.mic != "on") {
      return;
    }
    const now = this.now();
    own.restarts = heardWords ? [] : own.restarts.filter(t => now - t < MINUTE).concat(now);
    if (own.restarts.length > MIC_RESTARTS) {
      own.mic = "off";
      this._publish(s);
      return;
    }
    this._listenMic(s, speech);
  },

  /** Words recognized for Whimsy's own notes: "call" or "me". */
  heard(text, who = "call") {
    const s = this.state;
    const clean = String(text ?? "").replace(/\s+/g, " ").trim();
    if (!s?.own || !clean) {
      return;
    }
    s.transcript.push({ at: this.now(), who, text: clean });
    s.notesText = s.transcript.map(l => l.text).join("\n");
  },

  /** The call tab's sound couldn't be taken (no audio, unavailable). */
  callFailed(reason) {
    const s = this.state;
    if (s?.own) {
      s.own.call = "off";
      s.own.callReason = String(reason ?? "");
      this._publish(s);
    }
  },

  async _refreshOwn(s) {
    if (s.own?.call == "off" && s.own?.mic != "on" && !s.own.problem) {
      s.own.problem = "nothing";
    }
    await this._summarize(s);
  },

  _stopOwn(s) {
    const own = s?.own;
    if (!own || own.stopped) {
      return;
    }
    own.stopped = true;
    own.mic = own.mic == "on" ? "off" : own.mic;
    try {
      own.micSession?.stop();
    } catch {}
    own.micSession = null;
    const actor = s.tab?.linkedBrowser?.browsingContext?.currentWindowGlobal?.getActor("WhimsyVideoSpeed");
    actor?.sendQuery("WhimsyVideoSpeed:NotesListen", { on: false }).catch(() => {});
    own.call = "off";
  },

  /** Stop on the card: Whimsy's own notes end for this meeting. */
  async stop() {
    const s = this.state;
    if (!s?.own) {
      return;
    }
    this._stopOwn(s);
    s.ownStopped = true;
    await this._summarize(s);
    this._publish(s);
  },

  // ---- the end ----

  async end(reason = "time") {
    const s = this.state;
    if (!s || s.phase == "ended") {
      return;
    }
    this._stopOwn(s);
    this._closeOffer(s);
    if (s.phase == "off") {
      // Never followed (Granola not connected): nothing to keep.
      this.state = null;
      this._publish(null);
      return;
    }
    if (s.own && s.notesText.length > s.summarizedLength) {
      await this._summarize(s);
    }
    s.phase = "ended";
    s.endReason = reason;
    s.endedAt = this.now();
    this._publish(s);
  },

  // The own-notes transcript is kept 24 hours after the meeting, then dropped.
  _expire(now) {
    const s = this.state;
    if (s?.phase == "ended" && now - s.endedAt >= KEEP_MS) {
      this.state = null;
      this._publish(null);
    }
  },

  /** Download transcript (G.13 to G.15): Granola's, or Whimsy's own. */
  async download(win) {
    const s = this.state;
    if (!s) {
      return null;
    }
    let body = "";
    try {
      if (s.own) {
        body = s.transcript.map(l => `[${this._clock(l.at - s.meeting.start)}] ${l.text}`).join("\n\n");
      } else {
        body = (await this.granolaNotes(s, { transcriptOnly: true })).text;
      }
    } catch (e) {
      console.error("Whimsy meeting notes: transcript", e?.code ?? e);
    }
    if (!body) {
      win.gZenUIManager?.toasts?.open("whimsy-meeting-transcript-failed", { key: "whimsy-meeting-download" });
      return null;
    }
    const range = lazy.WhimsyNextMeeting.formatRange?.(s.meeting) ?? "";
    const day = new Date(s.meeting.start);
    const date = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, "0")}-${String(day.getDate()).padStart(2, "0")}`;
    const markdown = `# ${s.meeting.title}\n\n${date}${range ? ` · ${range}` : ""}\n\n${body}\n`;
    const dir = await lazy.Downloads.getPreferredDownloadsDirectory();
    const safe = `${String(s.meeting.title || "Meeting").replace(/[\\/:*?"<>|\u0000-\u001f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 80)} ${date}.md`;
    const file = lazy.DownloadPaths.createNiceUniqueFile(new lazy.FileUtils.File(PathUtils.join(dir, safe)));
    await IOUtils.writeUTF8(file.path, markdown);
    win.gZenUIManager?.toasts?.open("whimsy-meeting-downloaded", {
      key: "whimsy-meeting-download",
      l10nArgs: { name: file.leafName },
      icon: "chrome://browser/skin/zen-icons/downloads.svg",
      buttons: [{ id: "whimsy-meeting-reveal", l10nId: "whimsy-meeting-reveal", command: () => { try { file.reveal(); } catch {} } }],
    });
    return file.path;
  },

  _clock(ms) {
    const total = Math.max(0, Math.round(ms / 1000));
    return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
  },

  // ---- what chat shows ----

  /** The chip chat reads during the meeting (the existing live chip). */
  chip(s = this.state) {
    if (!s || s.phase == "ended" || s.phase == "off" || (!s.points.length && !s.notesText)) {
      return null;
    }
    const when = new Date(s.meeting.start).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    const text = [
      `Meeting in progress: ${s.meeting.title} (started ${when})`,
      s.points.length ? `Key points so far:\n${s.points.map(p => `- ${p}`).join("\n")}` : "",
      s.notesText ? `${s.own ? "Whimsy's own notes" : "Granola's notes"} so far (latest part):\n${s.notesText.slice(-CHIP_CHARS)}` : "",
    ].filter(Boolean).join("\n\n");
    const chipId = "granola:live";
    return {
      id: chipId,
      kind: "granola",
      label: s.meeting.title,
      icon: `${ICONS}granola.svg`,
      counts: { text: text.length },
      sourceId: "granola",
      liveNotes: true,
      parts: [{ chipId, kind: "text", size: text.length, text, title: s.meeting.title }],
    };
  },

  /** What WhimsyConnectors.poll shows, when this follows a meeting. */
  chipFor(win) {
    return this.enabled && this.state && this.state.phase != "ended" ? this.chip() : null;
  },

  _publish(s) {
    // A red dot on the call tab is the only sign that following is on (G.5).
    for (const win of this._windows) {
      for (const tab of win.closed ? [] : win.gBrowser.tabs) {
        const on = !!s && tab == s.tab && !["off", "ended"].includes(s.phase);
        if (tab.hasAttribute("whimsy-meeting-following") != on) {
          tab.toggleAttribute("whimsy-meeting-following", on);
        }
      }
    }
    for (const win of this._windows) {
      if (!win.closed) {
        try {
          lazy.WhimsyChatContextUI.setLiveChip(win, s ? this.chip(s) : null);
        } catch (e) {
          console.error(e);
        }
      }
    }
    this._render();
  },

  _render() {
    for (const win of this._windows) {
      const panel = !win.closed && lazy.WhimsyChatPanel.forWindow(win);
      if (panel?.isOpen && panel.el) {
        this.decorate(panel);
      }
    }
  },

  /** The card in the call tab's chat, at the top of the thread. */
  decorate(panel) {
    const old = panel.body?.querySelector(":scope > .whimsy-meeting-card");
    const node = this.enabled ? this.renderCard(panel) : null;
    if (!node) {
      old?.remove();
      return;
    }
    if (old) {
      old.replaceWith(node);
    } else {
      panel.body.querySelector(":scope > .whimsy-chat-empty")?.remove();
      panel.body.prepend(node);
      if (!panel.win.matchMedia("(prefers-reduced-motion: reduce)").matches) {
        node.animate({ opacity: [0, 1] }, { duration: 150, easing: "ease-out" });
      }
    }
    panel.doc.l10n.translateFragment(node);
  },

  /** The card for the panel's tab, or null when it isn't the call tab. */
  renderCard(panel) {
    const s = this.state;
    const { doc } = panel;
    const tab = panel.currentTab;
    if (!s || !tab || s.tab != tab) {
      return null;
    }
    // Not connected: one line and one button (G.1).
    if (s.phase == "off") {
      return this._card(doc, "off",
        h(doc, "div", { class: "whimsy-meeting-head" }, h(doc, "img", { class: "whimsy-meeting-mark", src: `${ICONS}granola.svg`, alt: "" }), h(doc, "span", { l10n: "whimsy-connectors-name-granola" })),
        h(doc, "p", { class: "whimsy-meeting-line", l10n: "whimsy-meeting-connect-text" }),
        h(doc, "div", { class: "whimsy-meeting-btns" }, h(doc, "button", { class: "whimsy-chat-pill-btn primary", id: "whimsy-meeting-connect", l10n: "whimsy-meeting-connect", onclick: () => this.connect(panel.win) })));
    }
    const now = this.now();
    const ended = s.phase == "ended";
    const own = !!s.own;
    const minutes = Math.max(1, Math.floor((Math.min(now, s.meeting.end) - s.meeting.start) / MINUTE));
    const points = s.points.length
      ? h(doc, "ul", { class: "whimsy-meeting-points" }, ...s.points.map(p => s.newPoints.has(p) && s.points.length > 1
        ? h(doc, "li", { class: "is-new" }, p, h(doc, "span", { class: "whimsy-meeting-new", l10n: "whimsy-meeting-new" }))
        : h(doc, "li", {}, p)))
      : null;

    if (ended) {
      const range = lazy.WhimsyNextMeeting.formatRange?.(s.meeting) ?? "";
      return this._card(doc, "ended",
        h(doc, "div", { class: "whimsy-meeting-head" },
          h(doc, "img", { class: "whimsy-meeting-mark", src: `${ICONS}granola.svg`, alt: "" }),
          h(doc, "span", { class: "whimsy-meeting-title", l10n: ["whimsy-meeting-ended-title", { meeting: s.meeting.title }] }),
          h(doc, "span", { class: "whimsy-meeting-time" }, range)),
        points,
        h(doc, "p", { class: "whimsy-meeting-meta", l10n: own ? "whimsy-meeting-from-own-ended" : "whimsy-meeting-from-granola-ended" }),
        own && !s.transcript.length
          ? null
          : h(doc, "div", { class: "whimsy-meeting-btns" },
            h(doc, "button", { class: "whimsy-chat-pill-btn", id: "whimsy-meeting-download", onclick: () => this.download(panel.win) },
              icon(doc, "download"), h(doc, "span", { l10n: "whimsy-meeting-download" }))));
    }

    // Folded to one line while you read answers (G.7); a click opens it.
    const asked = !!panel.body.querySelector('.whimsy-chat-msg[data-role="user"], .whimsy-chat-msg[data-role="ai"]');
    const folded = s.folded ?? (asked && s.points.length > 0);
    const updatedAgo = s.updatedAt ? Math.floor((now - s.updatedAt) / MINUTE) : null;
    const timeLine = folded
      ? ["whimsy-meeting-time-points", { minutes, count: s.points.length }]
      : updatedAgo === null ? ["whimsy-meeting-time", { minutes }] : ["whimsy-meeting-time-updated", { minutes, updated: updatedAgo }];
    const head = h(doc, "div", { class: "whimsy-meeting-head" },
      h(doc, "span", { class: "whimsy-meeting-live", "aria-hidden": "true" }),
      h(doc, "span", { class: "whimsy-meeting-title" }, s.meeting.title),
      h(doc, "span", { class: "whimsy-meeting-time", l10n: timeLine }),
      own && !s.ownStopped
        ? h(doc, "button", { class: "whimsy-chat-btn whimsy-meeting-stop", id: "whimsy-meeting-stop", l10n: "whimsy-meeting-stop", onclick: () => this.stop() }, icon(doc, "stop"))
        : null,
      h(doc, "button", { class: "whimsy-chat-btn whimsy-meeting-fold", l10n: folded ? "whimsy-meeting-unfold" : "whimsy-meeting-fold", "aria-expanded": folded ? "false" : "true", onclick: () => {
        s.folded = !folded;
        this.decorate(panel);
      } }, icon(doc, "chevron")));
    if (folded) {
      return this._card(doc, "folded", head);
    }

    let note = null;
    if (s.problem == "unreachable" && !own) {
      note = this._note(doc, "err", ["whimsy-meeting-unreachable", { time: new Date(s.problemAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) }]);
    } else if (s.problem == "signed-out" && !own) {
      note = this._note(doc, "err", "whimsy-meeting-signed-out",
        h(doc, "button", { class: "whimsy-chat-pill-btn primary", id: "whimsy-meeting-sign-in", l10n: "whimsy-connectors-sign-in-again", onclick: () => this.connect(panel.win) }));
    } else if (own && !s.ownStopped) {
      const o = s.own;
      if (o.problem == "speech-denied") {
        note = this._note(doc, "err", "whimsy-meeting-own-speech-denied", this._settingsButton(doc, "speech-recognition"));
      } else if (o.problem == "unavailable") {
        note = this._note(doc, "err", "whimsy-meeting-own-unavailable");
      } else if (o.mic == "denied") {
        note = this._note(doc, "warn", "whimsy-meeting-own-no-mic", this._settingsButton(doc, "microphone"));
      } else if (o.call == "off" && o.mic == "on") {
        note = this._note(doc, "mic", "whimsy-meeting-own-mic-only");
      } else if (o.call == "off" && o.mic != "on" && o.call != "starting") {
        note = this._note(doc, "err", "whimsy-meeting-own-nothing");
      } else {
        note = this._note(doc, "mic", "whimsy-meeting-own-on");
      }
    }
    const body = points ?? h(doc, "div", { class: "whimsy-meeting-skel", "aria-hidden": "true" }, h(doc, "i"), h(doc, "i"), h(doc, "i"));
    const waiting = !points
      ? h(doc, "p", { class: "whimsy-meeting-meta", l10n: [own ? "whimsy-meeting-waiting-own" : "whimsy-meeting-waiting", { time: new Date(s.meeting.start).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) }] })
      : null;
    const foot = points && !s.problem
      ? [
          h(doc, "p", { class: "whimsy-meeting-meta", l10n: own ? "whimsy-meeting-from-own" : "whimsy-meeting-from-granola" }),
          h(doc, "div", { class: "whimsy-chat-suggest whimsy-meeting-suggest" },
            ...["missed", "actions"].map(id => h(doc, "button", { class: "whimsy-chat-suggestion", "data-suggest": id, onclick: e => this._ask(panel, e.currentTarget.textContent) },
              icon(doc, "sparkle"), h(doc, "span", { l10n: `whimsy-meeting-suggest-${id}` })))),
        ]
      : [];
    return this._card(doc, own ? "own" : "live", head, note, body, waiting, ...foot);
  },

  _card(doc, kind, ...kids) {
    return h(doc, "section", { class: "whimsy-meeting-card", "data-kind": kind, "data-msg-id": "meeting-notes" }, ...kids);
  },

  _note(doc, tone, l10n, button = null) {
    return h(doc, "div", { class: "whimsy-meeting-note", "data-tone": tone, role: tone == "err" || tone == "warn" ? "alert" : null },
      icon(doc, tone == "mic" ? "mic" : "alert"), h(doc, "span", { l10n: [].concat(l10n) }), button);
  },

  _settingsButton(doc, page) {
    return h(doc, "button", { class: "whimsy-chat-pill-btn", l10n: "whimsy-connectors-open-system-settings", onclick: () => {
      try {
        this.speech()?.openSystemSettings(page);
      } catch {}
    } });
  },

  // A suggestion sends at once (BUGS W24 item 12).
  _ask(panel, text) {
    panel.composer.value = text;
    panel.autosize?.();
    panel.send();
  },

  /**
   * Connect Granola (and Sign in again): Settings › AI › Connectors at
   * Granola's row, starting the same sign-in as its own button.
   */
  connect(win) {
    const { WhimsyAIProviders } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyAIProviders.sys.mjs");
    WhimsyAIProviders.openSettings(win, "connector:granola");
  },

  // Tests only.
  _resetForTest() {
    this._stopOwn(this.state);
    this._closeOffer(this.state);
    this.state?.tab?.removeAttribute("whimsy-meeting-following");
    this.state = null;
    this._schemas = null;
    this._publish(null);
  },
};
