/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// W23 routines-ui: the parts of Routines' UI that outlive a window's
// Library: the form opener (Library in place, or chat's sheet), chat's
// "make a routine" (a drafted routine or watch, opened filled and outlined
// to confirm, never turned on by itself), the agent's "Make it a routine…",
// suggestions from history, and the Routines tab's count badge.

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  PlacesUtils: "resource://gre/modules/PlacesUtils.sys.mjs",
  WhimsyAIContext: "resource:///modules/whimsy/WhimsyAIContext.sys.mjs",
  WhimsyAIReader: "resource:///modules/whimsy/WhimsyAIReader.sys.mjs",
  WhimsyAIRouter: "resource:///modules/whimsy/WhimsyAIRouter.sys.mjs",
  WhimsyAIStore: "resource:///modules/whimsy/WhimsyAIStore.sys.mjs",
  WhimsyAIUpdates: "resource:///modules/whimsy/WhimsyAIUpdates.sys.mjs",
  WhimsyChat: "resource:///modules/whimsy/WhimsyChat.sys.mjs",
  WhimsyChatAgent: "resource:///modules/whimsy/WhimsyChatAgent.sys.mjs",
  WhimsyChatThreads: "resource:///modules/whimsy/WhimsyChatThreads.sys.mjs",
  WhimsyCommands: "resource:///modules/whimsy/WhimsyCommands.sys.mjs",
  WhimsyPageWatch: "resource:///modules/whimsy/WhimsyPageWatch.sys.mjs",
  WhimsyRoutines: "resource:///modules/whimsy/WhimsyRoutines.sys.mjs",
});

const SECTION = "whimsy-routines";
const COUNT_ATTR = "whimsy-routines-count";
const ICON = "chrome://browser/content/whimsy/icons/routines.svg";
const FORM = "chrome://browser/content/whimsy/whimsy-routine-form.mjs";
const HTML_NS = "http://www.w3.org/1999/xhtml";
const SHEET = "chrome://browser/content/whimsy/whimsy-routines.css";

// What chat hands to a routine: a schedule ("every Friday at 4, …") or a
// page to watch ("tell me when … here").
const SCHEDULE_ASK = /^(?:please\s+)?(?:(?:every|each)\s+(?:day|morning|evening|night|weekday|week|hour|month|(?:mon|tues|wednes|thurs|fri|satur|sun)day)s?\b|on weekdays\b|weekday mornings\b|remind me every\b|make (?:this|it) a routine\b|set up a routine\b)/i;
const WATCH_ASK = /^(?:please\s+)?(?:tell|let|notify|alert|ping) me (?:when|if)\s+(.+)$/i;
const TRIGGER_KINDS = ["schedule", "page", "return", "meeting", "email", "open-site", "download"];

const DRAFT_SYSTEM =
  "You turn a request into a Whimsy browser routine. Reply with JSON only, no prose: " +
  '{"title": a short name (2 to 4 words), "prompt": what to do on each run, in plain words, ' +
  '"trigger": one of {"kind":"schedule","days":[0-6, 0 is Sunday],"hour":0-23,"minute":0-59} | {"kind":"schedule","every":"hour"} | ' +
  '{"kind":"meeting","leadMinutes":5-30} | {"kind":"meeting","after":true} | {"kind":"return","awayMinutes":30-480} | ' +
  '{"kind":"email","match":"anyone"} | {"kind":"open-site","host":"example.com"} | {"kind":"download","match":"any"}}';

const WATCH_SYSTEM =
  "You set up a Whimsy page watch. Reply with JSON only: " +
  '{"condition": what to look for on the page, in a few plain words, like "tickets go on sale", ' +
  '"interval": how often to check in minutes, one of 15, 60, 360, 1440 (15 for tickets and drops that sell out, 60 for prices, 1440 for slow pages)}';

let started = false;
let formModule = null;
let seenAt = Date.now();
const pending = new WeakMap();

function form() {
  formModule ??= ChromeUtils.importESModule(FORM);
  return formModule;
}

function library(win) {
  return win.document.querySelector("zen-library");
}

function sectionOf(win) {
  return win.document.querySelector("whimsy-library-routines-section");
}

function parseJSON(text) {
  const match = String(text ?? "").match(/\{[\s\S]*\}/);
  try {
    return match ? JSON.parse(match[0]) : null;
  } catch {
    return null;
  }
}

function hostOf(url) {
  try {
    return new URL(url).host.replace(/^www\./, "");
  } catch {
    return "";
  }
}

export const WhimsyRoutinesUI = {
  // ---- Opening the form ----

  /** Library › Routines in place, or (outlined) chat's sheet. */
  openForm(win, opts = {}) {
    if (!lazy.WhimsyRoutines.enabled || lazy.WhimsyAIContext.isPrivate(win.gBrowser?.selectedTab)) {
      return false;
    }
    if (opts.outlined) {
      return this.openSheet(win, opts);
    }
    if (!this.openLibrary(win)) {
      return this.openSheet(win, opts);
    }
    const section = sectionOf(win);
    if (section?.isConnected && library(win)?.activeTab == SECTION) {
      section.openForm(opts);
    } else {
      pending.set(win, opts);
    }
    return true;
  },

  async openSheet(win, { routineId = null, prefill = null, outlined = true } = {}) {
    let draft = prefill ? { ...prefill } : { trigger: { kind: "schedule" }, prompt: "" };
    if (routineId) {
      const r = await lazy.WhimsyRoutines.get(routineId);
      if (!r) {
        return false;
      }
      draft = { ...r, trigger: { ...r.trigger } };
    }
    form().openRoutineSheet(win, { draft, outlined });
    return true;
  },

  /** Opens (never toggles shut) the Library on Routines. */
  openLibrary(win) {
    const ZenLibrary = win.customElements.get("zen-library");
    const lib = library(win);
    if (!ZenLibrary?.animateProgress || !lib?.zenLibrarySections || !(SECTION in lib.zenLibrarySections)) {
      return false;
    }
    if (!Services.prefs.getBoolPref("zen.library.enabled", true)) {
      return false;
    }
    if (lib.activeTab != SECTION) {
      lib.activeTab = SECTION;
    }
    if (!ZenLibrary.isLibraryOpen) {
      ZenLibrary.animateProgress(1);
    }
    return true;
  },

  takePending(win) {
    const opts = pending.get(win);
    pending.delete(win);
    return opts ?? null;
  },

  /** The routine's or watch's thread, made on first use. */
  async threadFor(id) {
    const r = await lazy.WhimsyRoutines.get(id);
    if (!r) {
      return null;
    }
    return lazy.WhimsyRoutines.threadFor(id);
  },

  // ---- Suggestions from history ----

  /**
   * At most two: a product page opened again and again this week (watch its
   * price) and a Google Doc reopened most days (doc changes). Places keeps
   * no private visits.
   */
  async suggestions(_win) {
    const since = (Date.now() - 7 * 24 * 60 * 60 * 1000) * 1000;
    const db = await lazy.PlacesUtils.promiseDBConnection();
    const rows = await db.executeCached(
      `SELECT h.url, h.title, COUNT(v.id) AS visits, COUNT(DISTINCT v.visit_date / 86400000000) AS days
         FROM moz_places h JOIN moz_historyvisits v ON v.place_id = h.id
        WHERE v.visit_date > :since
        GROUP BY h.id HAVING visits >= 3
        ORDER BY visits DESC LIMIT 40`,
      { since }
    );
    const watched = new Set((await lazy.WhimsyPageWatch.list().catch(() => [])).map(w => w.url));
    const out = [];
    let product = null;
    let doc = null;
    for (const row of rows) {
      const url = row.getResultByName("url");
      const title = row.getResultByName("title") || hostOf(url);
      if (!lazy.WhimsyAIReader.isReadableUrl(url) || watched.has(url)) {
        continue;
      }
      let u;
      try {
        u = new URL(url);
      } catch {
        continue;
      }
      if (!doc && u.host == "docs.google.com" && /^\/document\//.test(u.pathname) && row.getResultByName("days") >= 3) {
        doc = { url, title };
      } else if (!product && /\/(dp|product|products|p|item|buy|shop)\//i.test(u.pathname)) {
        product = { url, title, visits: row.getResultByName("visits") };
      }
    }
    if (product) {
      out.push({
        id: "price",
        icon: `page-icon:${product.url}`,
        l10nId: "whimsy-library-routines-suggest-watch",
        args: { title: product.title },
        whyL10nId: "whimsy-library-routines-suggest-watch-why",
        whyArgs: { count: product.visits },
        draft: { builtIn: "price-watch", title: product.title, trigger: { kind: "page", url: product.url, interval: 60 }, prompt: "" },
      });
    }
    if (doc) {
      out.push({
        id: "doc",
        icon: `page-icon:${doc.url}`,
        l10nId: "whimsy-library-routines-suggest-doc",
        args: { title: doc.title },
        whyL10nId: "whimsy-library-routines-suggest-doc-why",
        draft: { builtIn: "doc-changes", title: doc.title, trigger: { kind: "schedule", days: [1, 2, 3, 4, 5], hour: 9, minute: 0 }, prompt: "" },
      });
    }
    return out;
  },

  // ---- The rail badge: new results since you last looked ----

  markSeen(win) {
    seenAt = Date.now();
    this.updateBadge(win);
  },

  async updateBadge(win) {
    let count = 0;
    if (lazy.WhimsyRoutines.enabled) {
      const { updates = [], whileClosed = [] } = await lazy.WhimsyAIUpdates.list().catch(() => ({}));
      count = [...updates, ...whileClosed].filter(u => ["routine", "watch"].includes(u.source) && (u.surfaced ?? u.posted) > seenAt).length;
    }
    const lib = library(win);
    if (lib?.activeTab == SECTION && lib.hasAttribute("open")) {
      count = 0;
    }
    for (const tab of win.document.querySelectorAll("zen-library .zen-library-tab")) {
      if (tab.dataset.section == SECTION && count) {
        tab.setAttribute(COUNT_ATTR, String(count));
      } else if (tab.hasAttribute(COUNT_ATTR)) {
        tab.removeAttribute(COUNT_ATTR);
      }
    }
  },

  // ---- Chat ----

  /** Chat's send handler: a routine or watch, drafted, opened to confirm. */
  async onSend(panel, thread, text) {
    if (!lazy.WhimsyRoutines.enabled || !thread?.id) {
      return false;
    }
    const { win } = panel;
    const watch = text.match(WATCH_ASK);
    const tab = thread.kind == "tab" ? lazy.WhimsyChatThreads.tabOf(thread) : null;
    if (watch && tab && lazy.WhimsyPageWatch.canWatch(win, tab)) {
      return this._watchFromChat(panel, thread, tab, text, watch[1]);
    }
    if (!SCHEDULE_ASK.test(text.trim())) {
      return false;
    }
    let draft = null;
    try {
      const result = await lazy.WhimsyAIRouter.run({ task: "quick-text", system: DRAFT_SYSTEM, messages: [{ role: "user", content: text }], tools: [], userStarted: true });
      draft = parseJSON(result?.text);
    } catch (e) {
      console.warn("Whimsy routines: draft", e);
    }
    if (!draft || !TRIGGER_KINDS.includes(draft.trigger?.kind) || draft.trigger.kind == "page") {
      draft = { title: "", prompt: text, trigger: { kind: "schedule", days: [1, 2, 3, 4, 5], hour: 8, minute: 0 } };
    }
    draft = {
      title: String(draft.title ?? "").slice(0, 60),
      prompt: String(draft.prompt || text).slice(0, 4000),
      trigger: draft.trigger,
      showIn: "bar",
      using: "auto",
    };
    await lazy.WhimsyAIStore.append(thread.id, { role: "card", card: "routine-draft", draft });
    await panel.showThread(thread.id);
    await this.openSheet(win, { prefill: draft, outlined: true });
    return true;
  },

  async _watchFromChat(panel, thread, tab, text, rest) {
    let condition = rest.replace(/\s+(?:here|on this page|on this site)\s*[.!?]*$/i, "").replace(/[.!?]+$/, "").trim();
    let interval = /\b(?:tickets?|on sale|sells? out|restock)/i.test(rest) ? 15 : 60;
    try {
      const result = await lazy.WhimsyAIRouter.run({ task: "quick-text", system: WATCH_SYSTEM, messages: [{ role: "user", content: text }], tools: [], userStarted: true });
      const parsed = parseJSON(result?.text);
      if (parsed?.condition) {
        condition = String(parsed.condition).slice(0, 500);
      }
      if ([15, 60, 360, 1440].includes(parsed?.interval)) {
        interval = parsed.interval;
      }
    } catch (e) {
      console.warn("Whimsy routines: watch draft", e);
    }
    await lazy.WhimsyAIStore.append(thread.id, { role: "card", card: "routine-watch-draft", condition, interval });
    await panel.showThread(thread.id);
    lazy.WhimsyPageWatch.openDialog(panel.win, tab, { condition, interval, outlined: true });
    return true;
  },

  renderDraftCard(doc, msg, ctx) {
    const node = doc.createElementNS(HTML_NS, "div");
    node.className = "whimsy-chat-msg whimsy-routine-draft-card";
    node.dataset.role = "ai";
    const text = doc.createElementNS(HTML_NS, "div");
    text.className = "whimsy-chat-text";
    const note = doc.createElementNS(HTML_NS, "button");
    note.className = "whimsy-routine-draft-note";
    note.type = "button";
    if (msg.card == "routine-watch-draft") {
      doc.l10n.setAttributes(text, "whimsy-routine-chat-watch", { minutes: msg.interval });
      doc.l10n.setAttributes(note, "whimsy-routine-chat-reopen");
      note.addEventListener("click", () => {
        const tab = lazy.WhimsyChatThreads.tabOf(ctx.thread) ?? ctx.win.gBrowser.selectedTab;
        lazy.WhimsyPageWatch.openDialog(ctx.win, tab, { condition: msg.condition, interval: msg.interval, outlined: true });
      });
    } else {
      doc.l10n.setAttributes(text, "whimsy-routine-chat-drafted");
      doc.l10n.setAttributes(note, "whimsy-routine-chat-opened", { title: msg.draft?.title || msg.draft?.prompt?.slice(0, 40) || "" });
      note.addEventListener("click", () => this.openSheet(ctx.win, { prefill: msg.draft, outlined: true }));
    }
    node.append(text, note);
    return node;
  },

  // ---- Wiring ----

  _start() {
    if (started) {
      return;
    }
    started = true;
    lazy.WhimsyRoutines.setFormOpener((win, opts) => this.openForm(win, opts));
    lazy.WhimsyChatAgent.registerRoutineMaker?.((win, { prompt }) => this.openForm(win, { prefill: { prompt, trigger: { kind: "schedule" } }, outlined: true }));
    lazy.WhimsyChat.registerSendHandler({ id: "routines", handle: (panel, thread, text) => this.onSend(panel, thread, text) });
    lazy.WhimsyChat.registerCard("routine-draft", (doc, msg, ctx) => this.renderDraftCard(doc, msg, ctx));
    lazy.WhimsyChat.registerCard("routine-watch-draft", (doc, msg, ctx) => this.renderDraftCard(doc, msg, ctx));
    const badges = () => {
      for (const win of Services.wm.getEnumerator("navigator:browser")) {
        if (!win.closed) {
          this.updateBadge(win);
        }
      }
    };
    Services.obs.addObserver(badges, lazy.WhimsyAIUpdates.TOPIC);
  },

  initWindow(win) {
    if (!Services.prefs.getBoolPref("whimsy.feature.routines", true)) {
      return;
    }
    this._start();
    if (!win._whimsyRoutinesSheet) {
      win._whimsyRoutinesSheet = true;
      win.windowUtils.loadSheetUsingURIString(SHEET, win.windowUtils.AUTHOR_SHEET);
    }
    lazy.WhimsyCommands.register(win, {
      id: "cmd_whimsyViewRoutines",
      l10nId: "whimsy-action-view-routines",
      icon: ICON,
      run: w => this.openLibrary(w),
      isAvailable: w => Services.prefs.getBoolPref("whimsy.feature.routines", true) && !lazy.WhimsyAIContext.isPrivate(w.gBrowser.selectedTab) && !!library(w)?.zenLibrarySections?.[SECTION],
    });
  },
};
