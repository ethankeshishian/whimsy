/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// W23: the Updates feed at the top of the command bar. Routines, watches,
// deep research, and agent tasks post results here; the command bar (lane
// cmdbar-ai) lists them. Ranked: what needs you, then what's due soon,
// then newest. Remind me moves an update back to the top at a time;
// Dismiss hides it (with Undo). The Recent answer (the last command-bar
// answer) lasts 10 minutes. Kept in the AI store, so Fire clears it.

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  WhimsyAIStore: "resource:///modules/whimsy/WhimsyAIStore.sys.mjs",
});

const DOC = "updates";
const TOPIC = "whimsy-ai-updates-changed";
const RECENT_MS = 10 * 60 * 1000;
// "Due soon": a due time within this window ranks above plain news.
const DUE_WINDOW_MS = 24 * 60 * 60 * 1000;
const MAX_UPDATES = 200;
const SOURCES = new Set(["routine", "watch", "research", "agent"]);

let updates = null;
let loading = null;
let recent = null;
let now = () => Date.now();
const handlers = new Map();

function notify() {
  Services.obs.notifyObservers(null, TOPIC);
}

async function load() {
  if (updates) {
    return updates;
  }
  loading ??= (async () => {
    const saved = await lazy.WhimsyAIStore.readDoc(DOC, null);
    updates = Array.isArray(saved?.updates) ? saved.updates : [];
    // A Recent answer set before the first load is newer than the saved one.
    recent ??= saved?.recent ?? null;
    loading = null;
    return updates;
  })();
  return loading;
}

function save() {
  return lazy.WhimsyAIStore.writeDoc(DOC, { version: 1, updates, recent });
}

// Where an update sits: 0 needs you, 1 due soon (or a reminder that came
// due), 2 everything else. Within a group, the soonest due or the newest.
function rank(u, t) {
  if (u.needsYou) {
    return 0;
  }
  const due = u.remindAt ?? u.dueAt;
  if (due != null && due <= t + DUE_WINDOW_MS) {
    return 1;
  }
  return 2;
}

function order(t) {
  return (a, b) => {
    const ra = rank(a, t);
    const rb = rank(b, t);
    if (ra != rb) {
      return ra - rb;
    }
    if (ra == 1) {
      // A reminder that came due is on top; then the soonest due.
      const da = a.remindAt != null && a.remindAt <= t ? -Infinity : (a.dueAt ?? a.remindAt);
      const db = b.remindAt != null && b.remindAt <= t ? -Infinity : (b.dueAt ?? b.remindAt);
      if (da != db) {
        return da - db;
      }
    }
    return (b.surfaced ?? b.posted) - (a.surfaced ?? a.posted);
  };
}

function copy(u) {
  return u ? { ...u, nextStep: u.nextStep ? { ...u.nextStep } : undefined } : u;
}

export const WhimsyAIUpdates = {
  TOPIC,
  RECENT_MS,

  /**
   * Posts (or replaces, by id) an update.
   *
   * @returns {Promise<object>} the Update
   */
  async post(update) {
    if (!SOURCES.has(update?.source)) {
      throw new Error(`Unknown update source: ${update?.source}`);
    }
    if (!update.title) {
      throw new Error("An update needs a title");
    }
    const list = await load();
    const t = now();
    const id = update.id ?? Services.uuid.generateUUID().toString().slice(1, -1);
    const old = list.find(u => u.id == id);
    const u = { ...update, id, posted: old?.posted ?? t, surfaced: t, dismissed: false };
    delete u.remindAt;
    updates = [...list.filter(x => x.id != id), u];
    // Bounded: the oldest dismissed go first, then the oldest.
    if (updates.length > MAX_UPDATES) {
      updates.sort((a, b) => Number(b.dismissed) - Number(a.dismissed) || a.posted - b.posted);
      updates = updates.slice(updates.length - MAX_UPDATES);
    }
    await save();
    notify();
    return copy(u);
  },

  /**
   * What the command bar shows.
   *
   * @returns {Promise<{recent?: object, whileClosed: object[], updates: object[]}>}
   */
  async list() {
    const list = await load();
    const t = now();
    const shown = list.filter(u => !u.dismissed && (u.remindAt == null || u.remindAt <= t));
    const sorted = shown.sort(order(t)).map(copy);
    const out = {
      whileClosed: sorted.filter(u => u.whileClosed),
      updates: sorted.filter(u => !u.whileClosed),
    };
    const r = this.recentAnswer();
    if (r) {
      out.recent = r;
    }
    return out;
  },

  async get(id) {
    return copy((await load()).find(u => u.id == id) ?? null);
  },

  async dismiss(id) {
    const u = (await load()).find(x => x.id == id);
    if (!u || u.dismissed) {
      return false;
    }
    u.dismissed = true;
    u.dismissedAt = now();
    await save();
    notify();
    return true;
  },

  async undoDismiss(id) {
    const u = (await load()).find(x => x.id == id);
    if (!u?.dismissed) {
      return false;
    }
    u.dismissed = false;
    delete u.dismissedAt;
    await save();
    notify();
    return true;
  },

  /** Dismisses a whole group: "whileClosed", "updates", or "all". Returns the ids, for Undo. */
  async dismissAll(group = "all") {
    const { whileClosed, updates: rest } = await this.list();
    const ids = (group == "whileClosed" ? whileClosed : group == "updates" ? rest : [...whileClosed, ...rest]).map(u => u.id);
    for (const u of updates) {
      if (ids.includes(u.id)) {
        u.dismissed = true;
        u.dismissedAt = now();
      }
    }
    if (ids.length) {
      await save();
      notify();
    }
    return ids;
  },

  /** Hides an update until `at`, when it comes back on top. */
  async remind(id, at) {
    const u = (await load()).find(x => x.id == id);
    if (!u) {
      return false;
    }
    u.remindAt = at;
    u.surfaced = at;
    u.dismissed = false;
    u.whileClosed = false;
    await save();
    notify();
    return true;
  },

  /**
   * A source that acts on its own rows (a routine's next step):
   * fn(win, update, {accel}) -> true when it handled the open.
   */
  registerHandler(source, fn) {
    handlers.set(source, fn);
    return () => handlers.get(source) == fn && handlers.delete(source);
  },

  async handle(win, update, opts = {}) {
    const fn = handlers.get(update?.source);
    if (!fn) {
      return false;
    }
    try {
      return !!(await fn(win, update, opts));
    } catch (e) {
      console.error("WhimsyAIUpdates: a handler failed", e);
      return false;
    }
  },

  /** The Recent answer row: a card from the command bar, or null to remove it. */
  setRecentAnswer(card) {
    recent = card ? { card, at: now() } : null;
    save();
    notify();
  },

  recentAnswer() {
    if (recent && now() - recent.at < RECENT_MS) {
      return recent.card;
    }
    return null;
  },

  /** Marks everything posted while Whimsy was closed as seen in the bar. */
  async markSeen(ids) {
    let changed = false;
    for (const u of await load()) {
      if (ids.includes(u.id) && u.whileClosed) {
        u.whileClosed = false;
        changed = true;
      }
    }
    if (changed) {
      await save();
      notify();
    }
  },

  // The Fire button, through WhimsyAIStore.clear().
  async _clearKinds(kinds, since) {
    await load();
    const sources = new Set();
    if (kinds.includes("routineResults")) {
      sources.add("routine").add("watch");
    }
    if (kinds.includes("reports")) {
      sources.add("research");
    }
    if (kinds.includes("activity")) {
      sources.add("agent");
    }
    if (kinds.includes("chats") && recent && (since == null || recent.at >= since)) {
      recent = null;
      await save();
      notify();
    }
    if (sources.size) {
      await this._clear(u => sources.has(u.source), since);
    }
  },

  async _clear(match, since) {
    await load();
    const before = updates.length;
    updates = updates.filter(u => !(match(u) && (since == null || u.posted >= since)));
    if (updates.length != before) {
      await save();
      notify();
    }
  },

  // Tests: a fake clock and a cold start.
  _setClockForTesting(fn) {
    now = fn ?? (() => Date.now());
  },

  _resetForTesting() {
    updates = null;
    loading = null;
    recent = null;
  },
};
