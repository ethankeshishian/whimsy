/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// W23: AI's local storage. Chats (threads and their messages), the Updates
// feed, and the folders other lanes keep (reports, activity, index, memory)
// live in <profile>/whimsy-ai/: the folder 0700, every file 0600, never
// synced, bounded (500 threads, 2,000 messages a thread, 50 MB; the oldest
// go first), and cleared by the Fire button. Nothing here is written for a
// private tab: callers check WhimsyAIContext.isPrivate first.

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  WhimsyAIUpdates: "resource:///modules/whimsy/WhimsyAIUpdates.sys.mjs",
});

const DIR_NAME = "whimsy-ai";
const THREADS_FILE = "threads.json";
const MESSAGES_DIR = "messages";
const DOCS_DIR = "docs";
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
const MAX_THREADS = 500;
const MAX_MESSAGES = 2000;
const MAX_BYTES = 50 * 1024 * 1024;
const TOPIC = "whimsy-ai-store-changed";

export const KINDS = ["chats", "reports", "activity", "index", "memory", "routineResults"];
// Thread kinds each Fire kind clears.
const THREAD_KINDS = {
  chats: ["tab", "cmdbar", "agent", "outside"],
  routineResults: ["routine", "watch"],
};
// Folders other lanes own, cleared by kind.
// Folders Fire empties by date. The index isn't here: one file holds every
// entry, so its own clearer drops just the range (N1).
const KIND_DIRS = { reports: "reports", activity: "activity", memory: "memory" };

let state = null;
let loading = null;
let dirOverride = null;
let writes = Promise.resolve();
const clearers = new Map();

function dir() {
  return dirOverride ?? PathUtils.join(PathUtils.profileDir, DIR_NAME);
}

function uuid() {
  return Services.uuid.generateUUID().toString().slice(1, -1);
}

function notify(kind) {
  Services.obs.notifyObservers(null, TOPIC, kind);
}

async function ensureDir(path) {
  await IOUtils.makeDirectory(path, { ignoreExisting: true, createAncestors: true, permissions: DIR_MODE });
  await IOUtils.setPermissions(path, DIR_MODE);
}

// Written into a 0700 folder, then narrowed to 0600, so no other account
// can read it at any point.
async function writeFile(path, value) {
  await ensureDir(PathUtils.parent(path));
  await IOUtils.writeJSON(path, value, { tmpPath: path + ".tmp" });
  await IOUtils.setPermissions(path, FILE_MODE);
}

async function readFile(path, fallback) {
  try {
    return await IOUtils.readJSON(path);
  } catch {
    return fallback;
  }
}

function messagesPath(threadId) {
  return PathUtils.join(dir(), MESSAGES_DIR, `${threadId.replace(/[^\w-]/g, "")}.json`);
}

async function load() {
  if (state) {
    return state;
  }
  loading ??= (async () => {
    await ensureDir(dir());
    const saved = await readFile(PathUtils.join(dir(), THREADS_FILE), null);
    state = { threads: Array.isArray(saved?.threads) ? saved.threads : [], messages: new Map(), sizes: new Map(saved?.sizes ?? []) };
    loading = null;
    return state;
  })();
  return loading;
}

async function messagesOf(threadId) {
  const s = await load();
  if (!s.messages.has(threadId)) {
    s.messages.set(threadId, await readFile(messagesPath(threadId), []));
  }
  return s.messages.get(threadId);
}

function queue(fn) {
  writes = writes.then(fn).catch(e => console.error("WhimsyAIStore: write failed", e));
  return writes;
}

// Writes coalesce: a burst of appends writes each file once, with the
// latest state, when the queue gets to it.
const dirty = new Set();
let flushQueued = null;

function scheduleFlush() {
  flushQueued ??= queue(async () => {
    flushQueued = null;
    const names = [...dirty];
    dirty.clear();
    for (const name of names) {
      if (name == THREADS_FILE) {
        await writeFile(PathUtils.join(dir(), THREADS_FILE), { version: 1, threads: state.threads, sizes: [...state.sizes] });
      } else if (state.messages.has(name)) {
        await writeFile(messagesPath(name), state.messages.get(name));
      }
    }
  });
  return flushQueued;
}

function saveThreads() {
  dirty.add(THREADS_FILE);
  return scheduleFlush();
}

function saveMessages(threadId) {
  const list = state.messages.get(threadId) ?? [];
  state.sizes.set(threadId, JSON.stringify(list).length);
  dirty.add(threadId);
  return scheduleFlush();
}

async function removeThreadFiles(ids) {
  for (const id of ids) {
    state.messages.delete(id);
    state.sizes.delete(id);
    dirty.delete(id);
  }
  await queue(async () => {
    for (const id of ids) {
      await IOUtils.remove(messagesPath(id), { ignoreAbsent: true });
    }
  });
}

// Oldest threads go first, until both bounds hold.
async function prune() {
  const s = state;
  const byAge = [...s.threads].sort((a, b) => (a.updated ?? 0) - (b.updated ?? 0));
  const drop = [];
  let total = [...s.sizes.values()].reduce((a, b) => a + b, 0);
  while (byAge.length && (s.threads.length - drop.length > MAX_THREADS || total > MAX_BYTES)) {
    const t = byAge.shift();
    drop.push(t.id);
    total -= s.sizes.get(t.id) ?? 0;
  }
  if (drop.length) {
    s.threads = s.threads.filter(t => !drop.includes(t.id));
    await removeThreadFiles(drop);
  }
}

function textOf(msg) {
  if (typeof msg?.text == "string") {
    return msg.text;
  }
  if (typeof msg?.content == "string") {
    return msg.content;
  }
  return "";
}

export const WhimsyAIStore = {
  TOPIC,
  KINDS,
  MAX_THREADS,
  MAX_MESSAGES,
  MAX_BYTES,

  get dir() {
    return dir();
  },

  /** Threads, newest first. */
  async threads({ kind, tabKey } = {}) {
    const s = await load();
    return s.threads
      .filter(t => (!kind || t.kind == kind) && (!tabKey || t.tabKey == tabKey))
      .sort((a, b) => (b.updated ?? 0) - (a.updated ?? 0))
      .map(t => ({ ...t }));
  },

  async thread(id) {
    const s = await load();
    const t = s.threads.find(x => x.id == id);
    return t ? { ...t } : null;
  },

  async createThread(t = {}) {
    const s = await load();
    const now = Date.now();
    const thread = { title: "", ...t, id: t.id ?? uuid(), kind: t.kind ?? "tab", created: t.created ?? now, updated: t.updated ?? now };
    s.threads = s.threads.filter(x => x.id != thread.id);
    s.threads.push(thread);
    s.messages.set(thread.id, s.messages.get(thread.id) ?? []);
    await prune();
    saveThreads();
    notify("chats");
    return { ...thread };
  },

  async updateThread(id, patch) {
    const s = await load();
    const t = s.threads.find(x => x.id == id);
    if (!t) {
      return null;
    }
    Object.assign(t, patch, { id, updated: patch.updated ?? Date.now() });
    saveThreads();
    notify("chats");
    return { ...t };
  },

  async append(threadId, msg) {
    const s = await load();
    const t = s.threads.find(x => x.id == threadId);
    if (!t) {
      throw new Error(`No thread ${threadId}`);
    }
    const list = await messagesOf(threadId);
    const message = { ...msg, id: msg.id ?? uuid(), time: msg.time ?? Date.now() };
    list.push(message);
    if (list.length > MAX_MESSAGES) {
      list.splice(0, list.length - MAX_MESSAGES);
    }
    t.updated = message.time;
    saveMessages(threadId);
    await prune();
    saveThreads();
    notify("chats");
    return { ...message };
  },

  async messages(threadId) {
    return (await messagesOf(threadId)).map(m => ({ ...m }));
  },

  async updateMessage(threadId, msgId, patch) {
    const list = await messagesOf(threadId);
    const m = list.find(x => x.id == msgId);
    if (!m) {
      return null;
    }
    Object.assign(m, patch, { id: msgId });
    saveMessages(threadId);
    notify("chats");
    return { ...m };
  },

  async deleteThread(id) {
    const s = await load();
    s.threads = s.threads.filter(t => t.id != id);
    await removeThreadFiles([id]);
    saveThreads();
    notify("chats");
  },

  /** Threads whose title or messages contain `text`, newest first. */
  async search(text) {
    const needle = String(text ?? "").trim().toLowerCase();
    const all = await this.threads();
    if (!needle) {
      return all;
    }
    const out = [];
    for (const t of all) {
      if ((t.title ?? "").toLowerCase().includes(needle)) {
        out.push(t);
        continue;
      }
      const hit = (await messagesOf(t.id)).find(m => textOf(m).toLowerCase().includes(needle));
      if (hit) {
        out.push({ ...t, match: { messageId: hit.id, text: textOf(hit) } });
      }
    }
    return out;
  },

  // --- Named documents (the Updates feed, small lists other lanes keep) ---

  async readDoc(name, fallback = null) {
    await load();
    return readFile(PathUtils.join(dir(), DOCS_DIR, `${name.replace(/[^\w-]/g, "")}.json`), fallback);
  },

  async writeDoc(name, value) {
    await load();
    await queue(() => writeFile(PathUtils.join(dir(), DOCS_DIR, `${name.replace(/[^\w-]/g, "")}.json`), value));
  },

  /** A folder of the store for a lane's own files (made 0700). */
  async folder(kind) {
    const path = PathUtils.join(dir(), KIND_DIRS[kind] ?? kind.replace(/[^\w-]/g, ""));
    await ensureDir(dir());
    await ensureDir(path);
    return path;
  },

  /** Writes a lane's file into the store with the store's modes. */
  async writeFile(path, value) {
    if (!path.startsWith(dir() + "/")) {
      throw new Error("Outside the AI store");
    }
    await queue(() => writeFile(path, value));
  },

  /**
   * A lane that keeps its own data adds how to clear it:
   * `fn({since}) -> Promise`, for one of KINDS.
   */
  registerClearer(kind, fn) {
    if (!clearers.has(kind)) {
      clearers.set(kind, new Set());
    }
    clearers.get(kind).add(fn);
    return () => clearers.get(kind)?.delete(fn);
  },

  /**
   * Clears by kind, everything or only what's newer than `since` (ms since
   * the epoch). The Fire button calls this.
   */
  async clear({ since = null, kinds = KINDS } = {}) {
    const s = await load();
    const after = x => since == null || (x ?? 0) >= since;
    for (const kind of kinds) {
      const threadKinds = THREAD_KINDS[kind];
      if (threadKinds) {
        // A thread started in the range goes; an older one loses only the
        // messages from the range.
        const doomed = s.threads.filter(t => threadKinds.includes(t.kind) && after(t.created)).map(t => t.id);
        s.threads = s.threads.filter(t => !doomed.includes(t.id));
        await removeThreadFiles(doomed);
        if (since != null) {
          for (const t of s.threads.filter(x => threadKinds.includes(x.kind) && after(x.updated))) {
            const list = await messagesOf(t.id);
            const kept = list.filter(m => !after(m.time));
            s.messages.set(t.id, kept);
            t.updated = kept.at(-1)?.time ?? t.created;
            await saveMessages(t.id);
          }
        }
      }
      const sub = KIND_DIRS[kind];
      if (sub) {
        const path = PathUtils.join(dir(), sub);
        await queue(async () => {
          if (!(await IOUtils.exists(path))) {
            return;
          }
          for (const child of await IOUtils.getChildren(path)) {
            const stat = await IOUtils.stat(child).catch(() => null);
            if (stat && after(stat.lastModified)) {
              await IOUtils.remove(child, { recursive: true, ignoreAbsent: true });
            }
          }
        });
      }
      for (const fn of clearers.get(kind) ?? []) {
        try {
          await fn({ since });
        } catch (e) {
          console.error(`WhimsyAIStore: clearing ${kind} failed`, e);
        }
      }
      notify(kind);
    }
    await lazy.WhimsyAIUpdates._clearKinds(kinds, since);
    await saveThreads();
    await writes;
    // In-memory AI text (link preview summaries) goes too (L5).
    Services.obs.notifyObservers(null, "whimsy-ai-store-cleared", JSON.stringify({ kinds, since }));
  },

  /** Resolves once every write so far is on disk. */
  flush() {
    return writes;
  },

  // Tests: a scratch folder in place of the profile's, and a cold start.
  async _resetForTesting(path = null) {
    await writes;
    dirOverride = path;
    state = null;
    loading = null;
  },
};
