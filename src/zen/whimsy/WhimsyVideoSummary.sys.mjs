/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// W23 video: Summarize on a video. A press opens a chat tied to the tab with
// a "This video" chip and streams a summary with chapters whose times seek
// the video. It's a toggle (owner, 2026-11-08): pressed while this video's
// summary shows, it closes chat; pressed again, the same summary comes back;
// with chat on another conversation, it switches to this summary.
//
// What it reads, in order: the player's text tracks (hidden mode loads every
// cue), subtitle files the tab loaded (WhimsySubtitleSniffer, matched by
// timing), subtitles drawn over the video, then the page's title and
// description. Protected (DRM) video: subtitles and page only, no frames, no
// audio. No captions at all: on-device speech captions start without drawing
// anything, and "What's said so far" grows as the video plays.

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  WhimsyAI: "resource:///modules/whimsy/WhimsyAI.sys.mjs",
  WhimsyAIContext: "resource:///modules/whimsy/WhimsyAIContext.sys.mjs",
  WhimsyAIHints: "resource:///modules/whimsy/WhimsyAIHints.sys.mjs",
  WhimsyAIRouter: "resource:///modules/whimsy/WhimsyAIRouter.sys.mjs",
  WhimsyAIStore: "resource:///modules/whimsy/WhimsyAIStore.sys.mjs",
  WhimsyChat: "resource:///modules/whimsy/WhimsyChat.sys.mjs",
  WhimsyChatPanel: "resource:///modules/whimsy/WhimsyChatPanel.sys.mjs",
  WhimsyChatThreads: "resource:///modules/whimsy/WhimsyChatThreads.sys.mjs",
  WhimsyCommands: "resource:///modules/whimsy/WhimsyCommands.sys.mjs",
  WhimsySubtitleSniffer: "resource:///modules/whimsy/WhimsySubtitleSniffer.sys.mjs",
  WhimsyVerbs: "resource:///modules/whimsy/WhimsyVerbs.sys.mjs",
});
ChromeUtils.defineLazyGetter(lazy, "l10n", () => new Localization(["browser/whimsy.ftl"], true));

const FEATURE = "ai-video-summary";
const ICON = "chrome://browser/content/whimsy/icons/summarize.svg";
const CHIP_ICON = "chrome://browser/content/whimsy/icons/video-chip.svg";
const TRANSCRIPT_CHARS = 60000;
const HEARD_CHARS = 20000;
// "What's said so far" is retold after this much more is heard.
const HEARD_STEP_CHARS = 600;
const FRAME_WIDTH = 640;

const PROMPT = [
  "Summarize the video described below for someone deciding whether to watch it.",
  "Start with two or three plain sentences.",
  "Then a line that says exactly \"Chapters\", then one line per chapter as \"- m:ss Title\" (h:mm:ss past an hour), in order, from the times in the transcript.",
  "Leave out chapters when there's no transcript with times.",
].join(" ");
const LIVE_PROMPT =
  "This is a live stream. Summarize what was captioned while the person watched, then a line \"Chapters\" with one line per moment as \"- m:ss Title\" using the times given.";
const QUOTES_PROMPT =
  "List the three to five most telling quotes from the transcript, word for word, each as \"- m:ss “quote”\" with the time it's said. No preamble.";
const UPDATE_PROMPT =
  "This is a live stream. Here's what was captioned since your last summary. Say what's happened since, then a line \"Chapters\" with one line per new moment as \"- m:ss Title\" using the times given. Don't repeat the earlier summary.";
const HEARD_PROMPT = "In one or two sentences, say what has been said so far in this video, from the speech below. No preamble.";

const formatTime = seconds => {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
};

function h(doc, tag, attrs = {}, ...children) {
  const el = doc.createElementNS("http://www.w3.org/1999/xhtml", tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) {
      continue;
    }
    if (k == "l10n") {
      const [id, args] = Array.isArray(v) ? v : [v];
      doc.l10n.setAttributes(el, id, args);
    } else if (k.startsWith("on")) {
      el.addEventListener(k.slice(2), v);
    } else {
      el.setAttribute(k, v === true ? "" : v);
    }
  }
  el.append(...children.flat().filter(c => c != null));
  return el;
}

// Per tab: videoId -> threadId.
const byTab = new WeakMap();
// threadId -> {tab, videoId, source, heard, heardTold, summaryId}
const threads = new Map();

// Cue lists from subtitle files. Each parser returns [{start, end, text}].
const toSeconds = t => {
  const m = String(t).trim().match(/^(?:(\d+):)?(\d+):(\d+)(?:[.,](\d+))?$/);
  if (m) {
    return Number(m[1] ?? 0) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(`0.${m[4] ?? 0}`);
  }
  const unit = String(t).trim().match(/^([\d.]+)(h|m|s|ms|t)?$/);
  if (!unit) {
    return NaN;
  }
  const n = Number(unit[1]);
  return { h: n * 3600, m: n * 60, s: n, ms: n / 1000, t: n / 1e7 }[unit[2] ?? "s"];
};

const stripTags = text =>
  String(text)
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .trim();

export function parseSubtitles(text) {
  const body = String(text ?? "");
  if (/<tt[\s>]/i.test(body)) {
    const cues = [];
    for (const m of body.matchAll(/<p\b([^>]*)>([\s\S]*?)<\/p>/gi)) {
      const begin = m[1].match(/begin="([^"]+)"/)?.[1];
      const end = m[1].match(/end="([^"]+)"/)?.[1];
      const text = stripTags(m[2]);
      if (begin != null && text) {
        cues.push({ start: toSeconds(begin), end: end != null ? toSeconds(end) : toSeconds(begin), text });
      }
    }
    return cues.filter(c => Number.isFinite(c.start));
  }
  // WebVTT and SRT: blocks with "start --> end".
  const cues = [];
  for (const block of body.replace(/\r/g, "").split(/\n{2,}/)) {
    const lines = block.split("\n");
    const at = lines.findIndex(l => l.includes("-->"));
    if (at < 0) {
      continue;
    }
    const [start, end] = lines[at].split("-->").map(s => toSeconds(s.trim().split(/\s+/)[0]));
    const text = stripTags(lines.slice(at + 1).join("\n"));
    if (Number.isFinite(start) && text) {
      cues.push({ start, end, text });
    }
  }
  return cues;
}

// The file whose cues fit the video's length best, or null.
export function matchByTiming(files, duration) {
  let best = null;
  for (const file of files) {
    const cues = file.cues;
    if (!cues?.length) {
      continue;
    }
    const last = Math.max(...cues.map(c => c.end || c.start));
    let score = cues.length;
    if (Number.isFinite(duration) && duration > 0) {
      // Cues past the end belong to another video; a file that stops early is a poorer fit.
      if (last > duration + 30) {
        continue;
      }
      score = last / duration;
    }
    if (!best || score > best.score) {
      best = { file, score };
    }
  }
  return best?.file ?? null;
}

export const WhimsyVideoSummary = {
  get enabled() {
    return Services.prefs.getBoolPref(`whimsy.feature.${FEATURE}`, true) && lazy.WhimsyAI.enabled;
  },

  initWindow(win) {
    lazy.WhimsyCommands.register(win, {
      id: "cmd_whimsySummarizeVideo",
      l10nId: "whimsy-video-summarize-command",
      icon: ICON,
      run: w => this.summarizeSelected(w),
      isAvailable: w => this.enabled && !lazy.WhimsyAIContext.isPrivate(w.gBrowser.selectedTab),
    });
    if (this._registered) {
      return;
    }
    this._registered = true;
    lazy.WhimsySubtitleSniffer.init();
    lazy.WhimsyVerbs.registerVerb({
      id: "ai:summarize-video",
      group: "video",
      l10nId: "whimsy-video-summarize-command",
      icon: ICON,
      isAvailable: () => this.enabled,
      run: w => {
        w.gURLBar.view.close();
        return this.summarizeSelected(w);
      },
    });
    lazy.WhimsyAIHints.register({ id: "video-summary", isVisible: w => !!w.gBrowser?.selectedTab });
    lazy.WhimsyChat.registerCard("note:video-source", (doc, msg) =>
      h(doc, "div", { class: "whimsy-chat-note", "data-kind": "video-source" }, h(doc, "span", { l10n: ["whimsy-video-note", { from: msg.from ?? "page", frames: msg.frames ?? 0 }] }))
    );
    lazy.WhimsyChat.registerCard("video-heard", (doc, msg) => this.renderHeard(doc, msg));
    lazy.WhimsyChat.registerCard("video-transcript", (doc, msg, ctx) => this.renderTranscript(doc, msg, ctx));
    lazy.WhimsyChat.registerCard("video-actions", (doc, msg, ctx) => this.renderActions(doc, msg, ctx));
  },

  tabOfActor(actor) {
    const browser = actor.browsingContext?.top?.embedderElement;
    const win = browser?.ownerGlobal;
    return { win, tab: win?.gBrowser?.getTabForBrowser(browser) ?? null };
  },

  threadFor(tab, videoId) {
    return byTab.get(tab)?.get(videoId) ?? null;
  },

  /** What a press does for this video: "none" (summarize), "shown" (hide), or "hidden" (show). */
  stateFor(actor, videoId) {
    const { win, tab } = this.tabOfActor(actor);
    const threadId = tab && this.threadFor(tab, videoId);
    if (!threadId) {
      return "none";
    }
    const panel = lazy.WhimsyChatPanel.forWindow(win);
    return lazy.WhimsyChat.isOpen(win) && panel.thread?.id == threadId ? "shown" : "hidden";
  },

  pressed(actor, videoId) {
    const { win, tab } = this.tabOfActor(actor);
    if (!tab) {
      return "none";
    }
    return this.toggle(win, tab, videoId, actor);
  },

  /**
   * The Summarize toggle, the one exception that closes chat.
   *
   * @returns {Promise<string>} the new state ("shown" or "hidden")
   */
  async toggle(win, tab, videoId, actor = null) {
    if (!this.enabled || lazy.WhimsyAIContext.isPrivate(tab)) {
      return "none";
    }
    lazy.WhimsyAIHints.used("video-summary");
    const threadId = this.threadFor(tab, videoId);
    const panel = lazy.WhimsyChatPanel.forWindow(win);
    if (threadId && lazy.WhimsyChat.isOpen(win) && panel.thread?.id == threadId) {
      lazy.WhimsyChat.close(win, { reason: "video" });
      return "hidden";
    }
    if (threadId && (await lazy.WhimsyAIStore.thread(threadId))) {
      await lazy.WhimsyChat.open(win, { threadId, focus: "card" });
      return "shown";
    }
    await this.summarize(win, tab, { actor, videoId });
    return "shown";
  },

  // ⌘K and the command: the selected tab's main video.
  async summarizeSelected(win) {
    const tab = win.gBrowser.selectedTab;
    for (const context of tab.linkedBrowser.browsingContext?.getAllBrowsingContextsInSubtree() ?? []) {
      const actor = context.currentWindowGlobal?.getExistingActor("WhimsyVideoSpeed");
      const videoId = actor && (await actor.sendQuery("WhimsyVideoSpeed:MainVideo").catch(() => null));
      if (videoId) {
        return this.toggle(win, tab, videoId, actor);
      }
    }
    return "none";
  },

  /**
   * Gathers what the video offers and streams its summary into a new chat.
   *
   * @returns {Promise<string>} the thread's id
   */
  async summarize(win, tab, { actor, videoId }) {
    const source = (await actor?.sendQuery("WhimsyVideoSpeed:SummarySource", { videoId }).catch(() => null)) ?? { title: tab.label };
    source.cues ??= [];
    let from = source.cues.length ? "captions" : "";
    if (!source.cues.length) {
      const files = [];
      for (const { url } of lazy.WhimsySubtitleSniffer.forBrowser(tab.linkedBrowser)) {
        const text = await actor?.sendQuery("WhimsyVideoSpeed:FetchText", { url }).catch(() => null);
        if (text) {
          files.push({ url, cues: parseSubtitles(text) });
        }
      }
      const match = matchByTiming(files, source.duration);
      if (match) {
        source.cues = match.cues;
        from = "subtitles";
      }
    }
    if (!source.cues.length && source.drawn?.length) {
      source.cues = source.drawn;
      from = "drawn";
    }
    // Frames go only to a model that can see them, and never from protected video.
    const textOnly = !lazy.WhimsyAIRouter.capable({ images: true }).length;
    const frames = !source.drm && !textOnly ? await this.frames(actor, source.rect) : [];
    const tabKey = lazy.WhimsyAIContext.tabKey(tab);
    const thread = await lazy.WhimsyAIStore.createThread({
      kind: "tab",
      tabKey,
      title: source.title || tab.label,
      url: tab.linkedBrowser.currentURI?.spec ?? "",
      video: { id: videoId },
      context: { added: [{ id: "video", kind: "video", tabKey, videoId }], removed: [`tab:${tabKey}`, `pane:${tabKey}`] },
    });
    const record = { tab, videoId, actor, source, heard: "", heardTold: 0, summaryId: null, from: from || "page", frames: frames.length };
    threads.set(thread.id, record);
    if (!byTab.has(tab)) {
      byTab.set(tab, new Map());
    }
    byTab.get(tab).set(videoId, thread.id);
    const [ask] = lazy.l10n.formatValuesSync([{ id: "whimsy-video-summarize-prompt" }]);
    await lazy.WhimsyAIStore.append(thread.id, { role: "user", text: ask });
    // No captions: on-device speech captions start silently (never over DRM).
    if (!source.cues.length && !source.drm && !source.live) {
      record.listening = !!(await actor?.sendQuery("WhimsyVideoSpeed:Listen", { videoId }).catch(() => false));
    }
    await lazy.WhimsyChat.open(win, { threadId: thread.id, focus: "card" });
    const panel = lazy.WhimsyChatPanel.forWindow(win);
    if (panel.thread?.id != thread.id) {
      return thread.id;
    }
    const prompt = [source.live ? LIVE_PROMPT : PROMPT, "", this.describe(source, from)].join("\n");
    const saved = await panel.answer(panel.thread, {
      instruction: prompt,
      images: frames,
      needs: frames.length ? { images: true } : {},
    });
    record.summaryId = saved?.id ?? null;
    record.cueCount = source.cues.length;
    const chips = source.live ? ["update"] : source.cues.length ? ["transcript", "quotes"] : [];
    const actions = chips.length && saved ? await lazy.WhimsyAIStore.append(thread.id, { role: "card", kind: "video-actions", chips }) : null;
    if (actions && panel.thread?.id == thread.id) {
      panel.body.append(this.renderActions(panel.doc, actions, { win, thread: panel.thread }));
    }
    const note = await lazy.WhimsyAIStore.append(thread.id, {
      role: "note",
      kind: "video-source",
      from: textOnly && !source.drm ? "text-only" : source.drm ? `drm-${from || "page"}` : from || "page",
      frames: frames.length,
    });
    if (panel.thread?.id == thread.id) {
      panel.body.append(panel.renderNote(note));
      if (record.listening) {
        const heard = await lazy.WhimsyAIStore.append(thread.id, { role: "card", kind: "video-heard", text: "", heardSeconds: 0 });
        record.heardCard = heard.id;
        panel.body.append(this.renderHeard(panel.doc, heard));
      }
      await panel.doc.l10n.translateFragment(panel.body);
    }
    return thread.id;
  },

  // The prompt's description of the video.
  describe(source, from) {
    const lines = [`Title: ${source.title ?? ""}`];
    if (source.channel) {
      lines.push(`From: ${source.channel}`);
    }
    if (Number.isFinite(source.duration)) {
      lines.push(`Length: ${formatTime(source.duration)}`);
    }
    if (source.description) {
      lines.push(`Description: ${String(source.description).slice(0, 4000)}`);
    }
    if (source.drm) {
      lines.push("The video is copy-protected: there are no frames and no sound, only its subtitles and the page.");
    }
    if (source.cues.length) {
      const now = source.live ? source.currentTime ?? 0 : 0;
      const at = c => (source.live ? `${Math.max(1, Math.round((now - c.start) / 60))} min ago` : formatTime(c.start));
      let transcript = source.cues.map(c => `${at(c)} ${c.text.replace(/\s+/g, " ")}`).join("\n");
      transcript = transcript.slice(0, TRANSCRIPT_CHARS);
      lines.push(`Transcript (from the ${from}):`, transcript);
    } else {
      lines.push("There's no transcript.");
    }
    return lines.join("\n");
  },

  // The current frame, drawn by the compositor (the page's video plays on).
  async frames(actor, rect) {
    const wg = actor?.browsingContext?.currentWindowGlobal;
    if (!wg || !rect || rect.width < 2 || rect.height < 2) {
      return [];
    }
    try {
      const scale = Math.min(1, FRAME_WIDTH / rect.width);
      const bitmap = await wg.drawSnapshot(new DOMRect(rect.x, rect.y, rect.width, rect.height), scale, "black");
      const doc = Services.wm.getMostRecentBrowserWindow()?.document;
      const canvas = doc.createElementNS("http://www.w3.org/1999/xhtml", "canvas");
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      canvas.getContext("2d").drawImage(bitmap, 0, 0);
      const data = canvas.toDataURL("image/jpeg", 0.75).split(",")[1];
      return data ? [{ type: "image", mediaType: "image/jpeg", data }] : [];
    } catch (e) {
      return [];
    }
  },

  /** The "This video" chip's context, for chat (WhimsyChatContextUI). */
  contextFor(win, desc) {
    const record = [...threads.values()].find(r => r.videoId == desc.videoId);
    const [label] = lazy.l10n.formatValuesSync([{ id: "whimsy-video-chip" }]);
    const chip = { id: desc.id, kind: "video", label, icon: CHIP_ICON, counts: { videos: 1 }, sourceId: `${desc.tabKey}#video` };
    const text = record ? this.describe(record.source, record.from) + (record.heard ? `\nSaid so far: ${record.heard}` : "") : "";
    return {
      chips: [chip],
      parts: text ? [{ chipId: desc.id, kind: "text", size: text.length, text, title: record?.source.title ?? label }] : [],
      leftOut: { private: 0, hidden: 0, locked: 0 },
      widened: [],
    };
  },

  // ---- Speech while it plays ----

  /** Speech captions heard for a video (WhimsyVideoSpeedParent). */
  async heard(actor, { videoId, text, seconds }) {
    const entry = [...threads.entries()].find(([, r]) => r.videoId == videoId && r.listening);
    if (!entry) {
      return;
    }
    const [threadId, record] = entry;
    record.heard = `${record.heard} ${text}`.trim().slice(-HEARD_CHARS);
    record.heardSeconds = seconds;
    if (record.heard.length - record.heardTold < HEARD_STEP_CHARS || record.telling) {
      return;
    }
    record.telling = true;
    record.heardTold = record.heard.length;
    try {
      const result = await lazy.WhimsyAIRouter.run({
        task: "video-heard",
        messages: [{ role: "user", content: `${HEARD_PROMPT}\n\n${record.heard}` }],
        needs: { chars: record.heard.length },
      });
      const msg = await lazy.WhimsyAIStore.updateMessage(threadId, record.heardCard, { text: result?.text ?? "", heardSeconds: seconds });
      this.refreshHeard(record, msg);
    } catch (e) {
      // The next stretch tries again.
    } finally {
      record.telling = false;
    }
  },

  refreshHeard(record, msg) {
    const win = record.tab?.ownerGlobal;
    const panel = win && lazy.WhimsyChatPanel.forWindow(win);
    const old = panel?.body?.querySelector(`[data-msg-id="${CSS.escape(msg.id)}"]`);
    if (old) {
      const node = this.renderHeard(panel.doc, msg);
      old.replaceWith(node);
      node.querySelector(".whimsy-video-heard-text")?.animate({ opacity: [0, 1] }, { duration: 150, easing: "ease-out" });
      panel.doc.l10n.translateFragment(node);
    }
  },

  renderHeard(doc, msg) {
    return h(
      doc,
      "div",
      { class: "whimsy-chat-msg whimsy-video-heard", "data-role": "card", "data-msg-id": msg.id },
      h(doc, "h4", { class: "whimsy-video-heard-head", l10n: "whimsy-video-heard-heading" }),
      msg.text ? h(doc, "p", { class: "whimsy-video-heard-text" }, msg.text) : null,
      h(doc, "div", { class: "whimsy-video-heard-line" }, h(doc, "span", { class: "whimsy-video-wave", "aria-hidden": "true" }, [4, 7, 5, 8, 4].map(n => h(doc, "i", { style: `--h:${n}px` }))), h(doc, "span", { l10n: ["whimsy-video-heard-listening", { time: formatTime(msg.heardSeconds ?? 0) }] }))
    );
  },

  // ---- Chapters follow playback, transcript ----

  /** Playback moved: the chapter that's playing gets the tint. */
  playing(actor, { videoId, time }) {
    const entry = [...threads.entries()].find(([, r]) => r.videoId == videoId);
    const win = entry?.[1].tab?.ownerGlobal;
    const panel = win && lazy.WhimsyChatPanel.forWindow(win);
    if (!panel?.isOpen || panel.thread?.id != entry[0]) {
      return;
    }
    for (const list of panel.body.querySelectorAll(".whimsy-chat-times")) {
      let now = null;
      for (const li of list.children) {
        const at = Number(li.querySelector(".whimsy-chat-time")?.dataset.seconds);
        if (Number.isFinite(at) && at <= time + 0.5) {
          now = li;
        }
      }
      for (const li of list.children) {
        li.toggleAttribute("now", li == now);
      }
    }
    for (const line of panel.body.querySelectorAll(".whimsy-video-transcript > li")) {
      const next = line.nextElementSibling;
      line.toggleAttribute("now", Number(line.dataset.seconds) <= time && (!next || Number(next.dataset.seconds) > time));
    }
  },

  // ---- The chips under the summary: Transcript and Key quotes, or Update live ----

  renderActions(doc, msg, { win, thread } = {}) {
    const chips = {
      transcript: { l10n: "whimsy-video-chip-transcript", icon: "chrome://browser/content/whimsy/icons/text-chip.svg", run: () => this.showTranscript(win) },
      quotes: { l10n: "whimsy-video-chip-quotes", icon: "chrome://browser/content/whimsy/icons/listen.svg", run: () => this.keyQuotes(win) },
      update: { l10n: "whimsy-video-chip-update", icon: "chrome://browser/skin/zen-icons/reload.svg", run: () => this.update(win) },
    };
    // Chips need the video, which lives as long as its tab this session.
    const usable = !!thread?.id && threads.has(thread.id);
    return h(
      doc,
      "div",
      { class: "whimsy-chat-msg whimsy-video-actions-card", "data-role": "card", "data-msg-id": msg.id },
      h(
        doc,
        "div",
        { class: "whimsy-video-actions" },
        (msg.chips ?? [])
          .filter(id => chips[id])
          .map(id =>
            h(
              doc,
              "button",
              { class: "whimsy-video-chip", "data-chip": id, disabled: usable ? null : "true", onclick: () => chips[id].run() },
              h(doc, "span", { class: "whimsy-chat-icon", style: `--whimsy-chat-icon: url("${chips[id].icon}")`, "aria-hidden": "true" }),
              h(doc, "span", { l10n: chips[id].l10n })
            )
          )
      )
    );
  },

  // A chip's question shows as yours, then the answer streams under it.
  async ask(win, l10nId, instruction) {
    const panel = lazy.WhimsyChatPanel.forWindow(win);
    const thread = panel.thread;
    if (!thread || !threads.has(thread.id) || panel.streams?.has(thread.id)) {
      return null;
    }
    const [text] = lazy.l10n.formatValuesSync([{ id: l10nId }]);
    const user = await lazy.WhimsyAIStore.append(thread.id, { role: "user", text });
    panel.body.append(panel.renderMessage(user));
    return panel.answer(thread, { instruction });
  },

  keyQuotes(win) {
    return this.ask(win, "whimsy-video-quotes-ask", QUOTES_PROMPT);
  },

  /** Live: what was captioned since the last summary. */
  async update(win) {
    const panel = lazy.WhimsyChatPanel.forWindow(win);
    const record = panel.thread && threads.get(panel.thread.id);
    if (!record || panel.streams?.has(panel.thread.id)) {
      return null;
    }
    const fresh = record.actor && !Cu.isDeadWrapper(record.actor) ? await record.actor.sendQuery("WhimsyVideoSpeed:SummarySource", { videoId: record.videoId }).catch(() => null) : null;
    if (fresh) {
      const cues = record.from == "drawn" || !fresh.cues?.length ? fresh.drawn ?? [] : fresh.cues;
      const seen = new Set(record.source.cues.map(c => `${c.start}|${c.text}`));
      record.source.cues = [...record.source.cues, ...cues.filter(c => !seen.has(`${c.start}|${c.text}`))].slice(-2000);
      record.source.currentTime = fresh.currentTime;
      record.source.seekable = fresh.seekable;
    }
    const since = record.source.cues.slice(record.cueCount ?? 0);
    record.cueCount = record.source.cues.length;
    const described = this.describe({ ...record.source, cues: since }, record.from);
    return this.ask(win, "whimsy-video-update-ask", `${UPDATE_PROMPT}\n\n${described}`);
  },

  async showTranscript(win) {
    const panel = lazy.WhimsyChatPanel.forWindow(win);
    const thread = panel.thread;
    const record = thread && threads.get(thread.id);
    if (!record) {
      return;
    }
    // A second press goes back to the transcript that's there.
    const shown = panel.body.querySelector(".whimsy-video-transcript")?.closest(".whimsy-chat-msg");
    if (shown) {
      shown.scrollIntoView({ block: "nearest" });
      return;
    }
    const lines = record.source.cues.slice(0, 2000).map(c => ({ t: c.start, text: c.text }));
    const card = await lazy.WhimsyAIStore.append(thread.id, { role: "card", kind: "video-transcript", lines, from: record.from });
    const node = this.renderTranscript(panel.doc, card, { win, thread, panel });
    panel.body.append(node);
    await panel.doc.l10n.translateFragment(node);
    node.scrollIntoView({ block: "nearest" });
  },

  renderTranscript(doc, msg, { win, thread } = {}) {
    const seek = seconds => this.seek(win, thread, seconds);
    const list = h(
      doc,
      "ul",
      { class: "whimsy-video-transcript" },
      (msg.lines ?? []).map(line =>
        h(doc, "li", { "data-seconds": String(line.t), onclick: () => seek(line.t) }, h(doc, "span", { class: "whimsy-chat-time" }, formatTime(line.t)), " ", h(doc, "span", {}, line.text))
      )
    );
    return h(doc, "div", { class: "whimsy-chat-msg", "data-role": "card", "data-msg-id": msg.id }, h(doc, "div", { class: "whimsy-video-heard-line", l10n: ["whimsy-video-transcript-from", { from: msg.from ?? "captions" }] }), list);
  },

  /** A time seeks this chat's video, bringing its tab back first. */
  async seek(win, thread, seconds) {
    const record = thread && threads.get(thread.id);
    const tab = record?.tab ?? lazy.WhimsyChatThreads.tabOf(thread);
    if (!tab) {
      return false;
    }
    if (tab.ownerGlobal.gBrowser.selectedTab != tab) {
      tab.ownerGlobal.gBrowser.selectedTab = tab;
    }
    if (record?.actor && !Cu.isDeadWrapper(record.actor)) {
      return record.actor.sendQuery("WhimsyVideoSpeed:Seek", { videoId: record.videoId, time: seconds }).catch(() => false);
    }
    return false;
  },

  /** Whether a thread is a video summary (chat's time pills seek through it). */
  owns(thread) {
    return !!thread?.id && threads.has(thread.id);
  },

  _resetForTesting() {
    threads.clear();
  },
};
