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
  Whimsy: "resource:///modules/whimsy/Whimsy.sys.mjs",
  WhimsyAdultHistory: "resource:///modules/whimsy/WhimsyAdultHistory.sys.mjs",
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
const HTML_NS = "http://www.w3.org/1999/xhtml";
const SYSTEM_PROMPT =
  "From this one message the person wrote, pull stable facts worth remembering about them for future conversations: " +
  "their name, role, preferences, ongoing projects, people, and places they mention. Most messages hold none: a question " +
  "about a page, a tab, the browser, or the world says nothing about the person, so answer [] for it. Skip anything one-off, " +
  "sensitive (health, finances, political or religious views), or already obvious from the question itself. Never guess, " +
  "never fill in a category the message doesn't mention, and never write placeholders like \"none\". " +
  "Answer with nothing but a JSON array of short strings, one per fact, in the person's own words where " +
  "possible. Only what the person says about themselves counts. Answer [] when nothing in this message is worth saving.";

// W24 memory: words that carry no fact on their own, for matching a
// fact back to the message and a memory to a question.
const STOP_WORDS = new Set(
  ("the and for are but not you your yours with this that these those what which who whom whose when where why how " +
    "was were has have had does did done can could should would will shall may might must from into onto about " +
    "than then them they their there here its it's i'm i've i'd i'll im ive me my mine myself we we're our ours " +
    "is am be been being do just also very really any some all one tell show give get got let make please " +
    "tab tabs page pages site website web browser whimsy on in at to of a an or so if").split(" ")
);
// Words a model writes when it fills in a category instead of quoting the
// person ("Name: Sam", "Places: none mentioned"); they never ground a fact.
const LABEL_WORDS = new Set(
  "name names role roles preference preferences project projects ongoing people person place places mentioned none fact facts".split(" ")
);
// Question inversions ("am I on", "do I have") aren't the person saying
// something about themselves.
const INVERSION = /\b(?:am|are|do|does|did|can|could|should|would|will|was|were|have|has|had|shall|may|might|must)\s+(?:i|we)\b/g;
const SELF_STATEMENT = /\b(?:i|i'm|im|i've|i'd|i'll|my|mine|myself|we|we're|we've|our|ours|call me|remember)\b/;
const PLACEHOLDER = /\b(?:none|n\/a|unknown|not (?:mentioned|specified|provided|given)|no \w+(?: \w+)? (?:is |are )?mentioned)\b|\b(?:an ai|ai assistant|language model|foundation model)\b/i;

let inited = false;

function normalize(text) {
  return String(text ?? "").trim().toLowerCase().replace(/[\u2018\u2019]/g, "'").replace(/\s+/g, " ");
}

// "lives" and "live", "cats" and "cat" count as the same word.
function stem(word) {
  return word.length > 3 ? word.replace(/(?:ies|es|s)$/, "") : word;
}

function contentWords(text, extra = null) {
  return normalize(text)
    .split(/[^\p{L}\p{N}']+/u)
    .map(w => w.replace(/^'+|'+$/g, ""))
    .filter(w => w.length > 2 && !STOP_WORDS.has(w) && !extra?.has(w))
    .map(stem);
}

/**
 * W24 memory: whether a message says anything about the person at all.
 * Questions about a page, a tab, or the world ("what's on this tab",
 * "what website am I on") don't, so they never cost a model call.
 */
export function mentionsSelf(text) {
  return SELF_STATEMENT.test(normalize(text).replace(INVERSION, " "));
}

/**
 * W24 memory: a fact the model returned is kept only when it's grounded in
 * the person's words (shares a real word with them) and isn't a filled-in
 * category or placeholder. Small models answer every category in the
 * prompt with invented facts ("Name: Sam", "Places: none mentioned").
 */
function grounded(fact, userText) {
  if (PLACEHOLDER.test(fact)) {
    return false;
  }
  const said = new Set(contentWords(userText));
  return contentWords(fact, LABEL_WORDS).some(w => said.has(w));
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

// ---- W24 memexpand: the disclosure shared by "Used N memories" (read-only)
// and "Saved N facts" (each row removable). Built fresh from the live
// store every time it opens, so a memory deleted elsewhere (Settings, or
// this list's own remove) never shows stale text or an id that's gone.

function memoryBox(doc, id, items, { onRemove, manage } = {}) {
  const box = doc.createElementNS(HTML_NS, "div");
  box.className = "whimsy-chat-memory-list";
  box.id = id;
  const list = doc.createElementNS(HTML_NS, "ul");
  for (const memory of items) {
    const li = doc.createElementNS(HTML_NS, "li");
    const text = doc.createElementNS(HTML_NS, "span");
    text.className = "whimsy-chat-memory-text";
    text.textContent = memory.text;
    li.append(text);
    if (onRemove) {
      const remove = doc.createElementNS(HTML_NS, "button");
      remove.type = "button";
      remove.className = "whimsy-chat-chip-x";
      doc.l10n.setAttributes(remove, "whimsy-chat-memory-remove", { fact: memory.text });
      const mark = doc.createElementNS(HTML_NS, "span");
      mark.className = "whimsy-chat-icon";
      mark.style.setProperty("--whimsy-chat-icon", 'url("chrome://browser/skin/zen-icons/close.svg")');
      mark.setAttribute("aria-hidden", "true");
      remove.append(mark);
      remove.addEventListener("click", () => onRemove(memory, li));
      li.append(remove);
    }
    list.append(li);
  }
  box.append(list);
  if (manage) {
    const manageBtn = doc.createElementNS(HTML_NS, "button");
    manageBtn.type = "button";
    manageBtn.className = "whimsy-chat-link";
    doc.l10n.setAttributes(manageBtn, "whimsy-chat-used-memories-manage");
    manageBtn.addEventListener("click", manage);
    box.append(manageBtn);
  }
  doc.l10n.translateFragment(box);
  return box;
}

/**
 * Toggles `trigger`'s box, inserted right after `after` (closing it if
 * it's already open). `build()` may be async: it should read the live
 * store, never trust a cached snapshot, since a memory may have been
 * deleted since the message was saved or last opened.
 */
async function toggleDisclosure(trigger, after, build) {
  const isOpen = after.nextElementSibling?.matches(".whimsy-chat-memory-list") ? after.nextElementSibling : null;
  if (isOpen) {
    isOpen.remove();
    trigger.setAttribute("aria-expanded", "false");
    trigger.removeAttribute("aria-controls");
    return null;
  }
  const box = await build();
  // A second press while build() was awaiting may have opened it already.
  if (after.nextElementSibling?.matches(".whimsy-chat-memory-list")) {
    return null;
  }
  after.after(box);
  trigger.setAttribute("aria-controls", box.id);
  trigger.setAttribute("aria-expanded", "true");
  return box;
}

function renderMemorySaved(doc, msg, ctx) {
  const node = doc.createElementNS(HTML_NS, "div");
  node.className = "whimsy-chat-note";
  node.dataset.kind = "memory-saved";
  const mark = doc.createElementNS(HTML_NS, "span");
  mark.className = "whimsy-chat-icon";
  mark.style.setProperty("--whimsy-chat-icon", `url("${ICONS}memory.svg")`);
  mark.setAttribute("aria-hidden", "true");
  const textEl = doc.createElementNS(HTML_NS, "span");
  textEl.className = "whimsy-chat-note-text";
  const toggle = doc.createElementNS(HTML_NS, "button");
  toggle.type = "button";
  // The chat's one disclosure (.whimsy-agent-disclose, W25 designfix).
  toggle.className = "whimsy-agent-disclose whimsy-chat-disclosure";
  toggle.setAttribute("aria-expanded", "false");
  doc.l10n.setAttributes(toggle, "whimsy-chat-note-memory-saved", { count: (msg.memoryIds ?? []).length });
  toggle.addEventListener("click", () => WhimsyAIMemory._toggleSavedList(toggle, node, msg, ctx));
  textEl.append(toggle);
  if (!msg.undone) {
    const undo = doc.createElementNS(HTML_NS, "button");
    undo.type = "button";
    undo.className = "whimsy-chat-link";
    undo.dataset.action = "undo";
    doc.l10n.setAttributes(undo, "whimsy-chat-note-memory-undo");
    undo.addEventListener("click", () => WhimsyAIMemory._undoFromNote(ctx.thread, msg, node));
    textEl.append(" ", undo);
  }
  node.append(mark, textEl);
  node.dataset.memoryIds = JSON.stringify(msg.memoryIds ?? []);
  doc.l10n.translateFragment(node);
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
      disclosure: true,
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

  /**
   * Facts worth offering a prompt about `text`; most relevant first,
   * capped. A question about memory itself gets the newest ones, since
   * every memory is relevant to it.
   */
  async forPrompt(text, { limit = 8 } = {}) {
    if (!this.on) {
      return [];
    }
    const all = await this.list();
    if (!all.length) {
      return [];
    }
    if (this.isAboutMemory(text)) {
      return all.slice(0, limit);
    }
    const words = new Set(contentWords(text));
    const scored = all.map(m => ({ m, score: contentWords(m.text).filter(w => words.has(w)).length }));
    const matched = scored.filter(s => s.score > 0).sort((a, b) => b.score - a.score).map(s => s.m);
    return (matched.length ? matched : all).slice(0, limit);
  },

  /** Whether a message asks about memory itself ("what have you saved"). */
  isAboutMemory(text) {
    return /\b(?:memor(?:y|ies)|remember(?:ed|s)?|saved?|forget|forgot)\b/.test(normalize(text));
  },

  /**
   * What memory saved from this thread and still keeps (not undone or
   * deleted), oldest first: [{id, text}].
   */
  async savedIn(threadId) {
    if (!threadId) {
      return [];
    }
    const notes = (await lazy.WhimsyAIStore.messages(threadId).catch(() => []))
      .filter(m => m.role == "note" && m.kind == "memory-saved" && !m.undone);
    if (!notes.length) {
      return [];
    }
    const kept = new Map((await this.list()).map(m => [m.id, m]));
    return notes.flatMap(n => n.memoryIds ?? []).filter(id => kept.has(id)).map(id => ({ id, text: kept.get(id).text }));
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
    if (!userText || !mentionsSelf(userText)) {
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
    // Only facts the person said, each once: one already kept isn't saved
    // (or announced) again.
    const known = new Set((await entries()).map(m => normalize(m.text)));
    const saved = [];
    for (const fact of facts) {
      const key = normalize(fact);
      if (known.has(key) || !grounded(fact, userText)) {
        continue;
      }
      known.add(key);
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
    // W24: nothing is remembered from a chat on an adult site's page.
    if (!lazy.WhimsyAdultHistory.keepsTab(panel.currentTab)) {
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
    node?.querySelector('[data-action="undo"]')?.remove();
  },

  // W24 memexpand (was chat-4.4): "Used N memories" opens the list in
  // place, under the answer's actions, with Manage memory… at its end;
  // pressing it again folds it. Read live each time, by id, so a memory
  // deleted meanwhile (in Settings, or removed from a Saved list) is
  // simply left out, never shown with stale text.
  async _openUsedList(win, msg) {
    const doc = win.document;
    const node = doc.querySelector(`[data-msg-id="${CSS.escape(msg.id)}"] [data-action="used-memories"]`);
    const row = node?.closest(".whimsy-chat-actions");
    if (!node || !row || !msg.usedMemories?.length) {
      return;
    }
    await toggleDisclosure(node, row, async () => {
      const live = new Map((await this.list()).map(m => [m.id, m]));
      const items = (msg.usedMemories ?? [])
        .filter(m => live.has(m.id))
        .map(m => ({ id: m.id, text: live.get(m.id).text }));
      return memoryBox(doc, `whimsy-used-${msg.id}`, items, {
        manage: () => lazy.WhimsyAIProviders.openSettings(win, "memory"),
      });
    });
  },

  // W24 memexpand: "Saved N facts" opens the same kind of list, each row
  // removable. Read live, by id, for the same reason as _openUsedList.
  async _toggleSavedList(toggle, node, msg, ctx) {
    const doc = node.ownerDocument;
    await toggleDisclosure(toggle, node, async () => {
      const live = new Map((await this.list()).map(m => [m.id, m]));
      const items = (msg.memoryIds ?? [])
        .filter(id => live.has(id))
        .map(id => ({ id, text: live.get(id).text }));
      return memoryBox(doc, `whimsy-saved-${msg.id}`, items, {
        onRemove: (memory, li) => this._removeSavedFact(node, toggle, msg, ctx, memory, li),
      });
    });
  },

  /** Removing a saved fact's row: the same delete Settings ▸ Memory uses. */
  async _removeSavedFact(node, toggle, msg, ctx, memory, li) {
    await this.remove(memory.id, { block: false });
    msg.memoryIds = (msg.memoryIds ?? []).filter(id => id != memory.id);
    msg.facts = (msg.facts ?? []).filter(text => text != memory.text);
    if (ctx.thread?.id) {
      await lazy.WhimsyAIStore.updateMessage(ctx.thread.id, msg.id, { memoryIds: msg.memoryIds, facts: msg.facts }).catch(() => {});
    }
    li.remove();
    const count = msg.memoryIds.length;
    node.dataset.memoryIds = JSON.stringify(msg.memoryIds);
    if (!count) {
      // The box (this li's own list) is still open, right after node.
      if (node.nextElementSibling?.matches(".whimsy-chat-memory-list")) {
        node.nextElementSibling.remove();
      }
      node.remove();
      return;
    }
    node.ownerDocument.l10n.setAttributes(toggle, "whimsy-chat-note-memory-saved", { count });
    await node.ownerDocument.l10n.translateElements([toggle]);
  },

  // Tests: a scratch folder (through WhimsyAIStore._resetForTesting).
  _resetForTesting() {
    inited = false;
  },
};
