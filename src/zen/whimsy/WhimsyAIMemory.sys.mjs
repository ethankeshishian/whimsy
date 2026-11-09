/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// W23 memory-fire: stable facts about the person (name, role, preferences,
// ongoing projects) saved automatically after a chat answer, or when asked,
// and used in later prompts (forPrompt). One switch, "Use and save
// memories" (whimsy.ai.memory), pauses both halves at once. Facts live one
// JSON file per memory in <profile>/whimsy-ai/memory (WhimsyAIStore, 0600),
// cleared by the Fire button; a blocked list (facts Undo rejected) is a
// small doc in the same store so an undone fact doesn't come back. Never
// reads or writes for a private tab: every caller checks first.

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  noteLine: "resource:///modules/whimsy/WhimsyChatAnswer.sys.mjs",
  Whimsy: "resource:///modules/whimsy/Whimsy.sys.mjs",
  WhimsyAI: "resource:///modules/whimsy/WhimsyAI.sys.mjs",
  WhimsyAIRouter: "resource:///modules/whimsy/WhimsyAIRouter.sys.mjs",
  WhimsyAIStore: "resource:///modules/whimsy/WhimsyAIStore.sys.mjs",
  WhimsyChat: "resource:///modules/whimsy/WhimsyChat.sys.mjs",
  WhimsyAIProviders: "resource:///modules/whimsy/WhimsyAIProviders.sys.mjs",
});

const FOLDER_KIND = "memory";
const BLOCKED_DOC = "memory-blocked";
const USE_PREF = "whimsy.ai.memory";
const FEATURE = "ai-memory";
const MAX_MEMORIES = 500;
const ICONS = "chrome://browser/content/whimsy/icons/";
const SYSTEM_PROMPT =
  "From this one message the person wrote, pull stable facts worth remembering about them for future conversations: " +
  "their name, role, preferences, ongoing projects, people, and places they mention. Skip anything one-off, " +
  "sensitive (health, finances, political or religious views), or already obvious from the question itself. " +
  "Answer with nothing but a JSON array of short strings, one per fact, in the person's own words where " +
  "possible. Only what the person says about themselves counts. Answer [] when nothing in this message is worth saving.";

let inited = false;

function normalize(text) {
  return String(text ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

function uid() {
  return Services.uuid.generateUUID().toString().slice(1, 9);
}

async function folder() {
  return lazy.WhimsyAIStore.folder(FOLDER_KIND);
}

async function entries() {
  const dir = await folder();
  const out = [];
  for (const path of await IOUtils.getChildren(dir).catch(() => [])) {
    if (!path.endsWith(".json")) {
      continue;
    }
    const data = await IOUtils.readJSON(path).catch(() => null);
    if (data?.id) {
      out.push({ ...data, path });
    }
  }
  return out.sort((a, b) => (b.date ?? 0) - (a.date ?? 0));
}

async function blockedList() {
  return (await lazy.WhimsyAIStore.readDoc(BLOCKED_DOC, [])) ?? [];
}

function parseFacts(text) {
  const source = String(text ?? "");
  const match = /\[[\s\S]*\]/.exec(source);
  try {
    const parsed = JSON.parse(match ? match[0] : source);
    return Array.isArray(parsed) ? parsed.map(f => String(f ?? "").trim()).filter(Boolean) : [];
  } catch {
    return [];
  }
}

function renderMemorySaved(doc, msg, ctx) {
  const facts = msg.facts ?? [];
  const label = facts.length == 1 ? facts[0] : `${facts.length} facts`;
  const node = lazy.noteLine(doc, {
    kind: "memory-saved",
    iconUrl: `${ICONS}memory.svg`,
    l10n: facts.length == 1
      ? ["whimsy-chat-note-memory-saved-one", { fact: facts[0] }]
      : ["whimsy-chat-note-memory-saved-many", { count: facts.length }],
    buttons: msg.undone
      ? []
      : [{ l10n: "whimsy-chat-note-memory-undo", run: () => WhimsyAIMemory._undoFromNote(ctx.thread, msg, node) }],
  });
  node.dataset.memoryIds = JSON.stringify(msg.memoryIds ?? []);
  return node;
}

export const WhimsyAIMemory = {
  USE_PREF,

  /** Whether memory saves and reads anything at all right now. */
  get on() {
    return lazy.Whimsy.featureEnabled(FEATURE) && lazy.WhimsyAI.enabled && Services.prefs.getBoolPref(USE_PREF, true);
  },

  init() {
    if (inited) {
      return;
    }
    inited = true;
    lazy.WhimsyAIStore.registerClearer("memory", ({ since } = {}) => this._clearBlocked(since));
    lazy.WhimsyChat.registerCard("note:memory-saved", renderMemorySaved);
    lazy.WhimsyChat.registerAnswerAction({
      id: "used-memories",
      labelled: true,
      l10nId: "whimsy-chat-action-used-memories",
      icon: `${ICONS}memory.svg`,
      isAvailable: msg => msg.role == "ai" && Array.isArray(msg.usedMemories) && !!msg.usedMemories.length,
      l10nArgs: msg => ({ count: msg.usedMemories.length }),
      run: (win, msg) => this._openUsedList(win, msg),
    });
  },

  async _clearBlocked(since) {
    if (since == null) {
      await lazy.WhimsyAIStore.writeDoc(BLOCKED_DOC, []);
      return;
    }
    const list = await blockedList();
    await lazy.WhimsyAIStore.writeDoc(BLOCKED_DOC, list.filter(b => (b.blockedAt ?? 0) < since));
  },

  /** Every saved memory, newest first: {id, text, source, date}. */
  async list() {
    this.init();
    return (await entries()).map(({ path, ...m }) => m);
  },

  async get(id) {
    const all = await entries();
    const found = all.find(m => m.id == id);
    return found ? (({ path, ...m }) => m)(found) : null;
  },

  /** Saves one fact (used by extract() and by "save when told"). */
  async save(text, { source = "" } = {}) {
    this.init();
    const fact = String(text ?? "").trim();
    if (!fact) {
      return null;
    }
    const blocked = new Set((await blockedList()).map(b => b.fact));
    if (blocked.has(normalize(fact))) {
      return null;
    }
    const dir = await folder();
    const id = uid();
    const entry = { id, text: fact, source, date: Date.now() };
    await lazy.WhimsyAIStore.writeFile(PathUtils.join(dir, `${id}.json`), entry);
    const all = await entries();
    if (all.length > MAX_MEMORIES) {
      for (const old of all.slice(MAX_MEMORIES)) {
        await IOUtils.remove(old.path, { ignoreAbsent: true });
      }
    }
    return entry;
  },

  async update(id, text) {
    this.init();
    const dir = await folder();
    const path = PathUtils.join(dir, `${id.replace(/[^\w-]/g, "")}.json`);
    const entry = await IOUtils.readJSON(path).catch(() => null);
    if (!entry) {
      return null;
    }
    entry.text = String(text ?? "").trim();
    await lazy.WhimsyAIStore.writeFile(path, entry);
    return entry;
  },

  /**
   * Deletes a memory. `block` (Undo on an auto-save, and Settings' delete)
   * also stops that fact text being saved again.
   */
  async remove(id, { block = false } = {}) {
    this.init();
    const dir = await folder();
    const path = PathUtils.join(dir, `${id.replace(/[^\w-]/g, "")}.json`);
    const entry = await IOUtils.readJSON(path).catch(() => null);
    // Block first, then delete: once the fact is gone it's already blocked,
    // so an extraction that lands in between can't save it back.
    if (block && entry) {
      const list = await blockedList();
      list.push({ fact: normalize(entry.text), blockedAt: Date.now() });
      await lazy.WhimsyAIStore.writeDoc(BLOCKED_DOC, list.slice(-MAX_MEMORIES));
    }
    await IOUtils.remove(path, { ignoreAbsent: true });
    return entry;
  },

  /** Restores a removed memory (Undo on a Settings delete, not blocked). */
  async restore(entry) {
    if (!entry?.id) {
      return null;
    }
    const dir = await folder();
    await lazy.WhimsyAIStore.writeFile(PathUtils.join(dir, `${entry.id}.json`), entry);
    return entry;
  },

  /** Facts worth offering a prompt about `text`; most relevant first, capped. */
  async forPrompt(text, { limit = 8 } = {}) {
    if (!this.on) {
      return [];
    }
    const all = await this.list();
    if (!all.length) {
      return [];
    }
    const words = normalize(text).split(/\W+/).filter(w => w.length > 2);
    const scored = all.map(m => ({ m, score: words.filter(w => normalize(m.text).includes(w)).length }));
    const matched = scored.filter(s => s.score > 0).sort((a, b) => b.score - a.score).map(s => s.m);
    return (matched.length ? matched : all).slice(0, limit);
  },

  /**
   * After an answer: exchange = {userText, aiText}. Extracts stable facts
   * with task "memory" (the router sends quick tasks to Apple's on-device
   * model first), saves each (skipping blocked ones), and returns what was
   * saved: [{id, text, source, date}].
   */
  async extract(threadId, exchange, { isPrivate = false, signal = null } = {}) {
    if (isPrivate || !this.on || signal?.aborted) {
      return [];
    }
    this.init();
    // L1: only the person's own words. The answer can echo a page's text
    // (or an injection in it), so it's never a source of facts.
    const userText = String(exchange?.userText ?? "").trim();
    if (!userText) {
      return [];
    }
    let facts;
    try {
      const result = await lazy.WhimsyAIRouter.run({
        task: "memory",
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: `The person wrote: ${userText}` }],
        signal: signal ?? undefined,
      });
      facts = parseFacts(result.text);
    } catch (e) {
      if (!signal?.aborted) {
        console.error("WhimsyAIMemory: extract failed", e);
      }
      return [];
    }
    if (signal?.aborted) {
      return [];
    }
    const saved = [];
    for (const fact of facts) {
      const entry = await this.save(fact, { source: threadId });
      if (entry) {
        saved.push(entry);
      }
    }
    return saved;
  },

  /** A chat panel calls this after a fresh answer to append the note. */
  async noteAfterAnswer(panel, thread, answerMsg, userText, { signal = null } = {}) {
    if (!answerMsg || answerMsg.role != "ai") {
      return;
    }
    const saved = await this.extract(thread.id, { userText, aiText: String(answerMsg.text ?? "") }, { signal });
    // Once anything is saved, the note goes in the thread even if the panel
    // has moved on, so the fact always has its Undo.
    if (!saved.length) {
      return;
    }
    const note = await lazy.WhimsyAIStore.append(thread.id, {
      role: "note",
      kind: "memory-saved",
      memoryIds: saved.map(m => m.id),
      facts: saved.map(m => m.text),
    });
    if (panel.thread?.id == thread.id && panel.body?.isConnected) {
      panel.body.append(panel.renderNote(note));
      await panel.doc.l10n.translateFragment(panel.body);
      panel.body.scrollTop = panel.body.scrollHeight;
    }
  },

  async _undoFromNote(thread, msg, node) {
    for (const id of msg.memoryIds ?? []) {
      await this.remove(id, { block: true });
    }
    if (thread?.id) {
      await lazy.WhimsyAIStore.updateMessage(thread.id, msg.id, { undone: true }).catch(() => {});
    }
    node?.querySelector(".whimsy-chat-link")?.remove();
  },

  // chat-4.4: "Used 1 memory" opens the list in place, under the answer's
  // actions, with Manage memory… at its end; pressing it again folds it.
  _openUsedList(win, msg) {
    const doc = win.document;
    const node = doc.querySelector(`[data-msg-id="${CSS.escape(msg.id)}"] [data-action="used-memories"]`);
    const row = node?.closest(".whimsy-chat-actions");
    if (!node || !row || !msg.usedMemories?.length) {
      return;
    }
    const open = row.nextElementSibling?.matches(".whimsy-chat-used-memories") ? row.nextElementSibling : null;
    if (open) {
      open.remove();
      node.setAttribute("aria-expanded", "false");
      return;
    }
    const ns = "http://www.w3.org/1999/xhtml";
    const box = doc.createElementNS(ns, "div");
    box.className = "whimsy-chat-used-memories";
    box.id = `whimsy-used-${msg.id}`;
    const list = doc.createElementNS(ns, "ul");
    for (const memory of msg.usedMemories) {
      const li = doc.createElementNS(ns, "li");
      li.textContent = memory.text;
      list.append(li);
    }
    const manage = doc.createElementNS(ns, "button");
    manage.className = "whimsy-chat-link";
    manage.type = "button";
    doc.l10n.setAttributes(manage, "whimsy-chat-used-memories-manage");
    manage.addEventListener("click", () => lazy.WhimsyAIProviders.openSettings(win, "memory"));
    box.append(list, manage);
    row.after(box);
    node.setAttribute("aria-controls", box.id);
    node.setAttribute("aria-expanded", "true");
  },

  // Tests: a scratch folder (through WhimsyAIStore._resetForTesting).
  _resetForTesting() {
    inited = false;
  },
};
