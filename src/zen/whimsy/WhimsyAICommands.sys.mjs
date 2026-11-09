/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// W23 commands: saved prompts and links. A command has a name, a result
// (Replace, Insert after, Copy, or Link), and either a prompt with tokens
// and a model ("Auto" follows the provider order) or, for Link, an address
// with %s that nothing sends to AI. Built-ins can be hidden; yours are
// edited in Settings › AI › Commands. Every command shows in ⌘K and chat,
// and routines can use any of them. The old whimsy.verbs.skills lines
// become Link commands once, silently.

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  WhimsyAI: "resource:///modules/whimsy/WhimsyAI.sys.mjs",
  WhimsyAIContext: "resource:///modules/whimsy/WhimsyAIContext.sys.mjs",
  WhimsyAIProviders: "resource:///modules/whimsy/WhimsyAIProviders.sys.mjs",
  WhimsyAIRouter: "resource:///modules/whimsy/WhimsyAIRouter.sys.mjs",
  WhimsyAISensitive: "resource:///modules/whimsy/WhimsyAISensitive.sys.mjs",
  WhimsyAIStore: "resource:///modules/whimsy/WhimsyAIStore.sys.mjs",
  WhimsyChat: "resource:///modules/whimsy/WhimsyChat.sys.mjs",
  WhimsyCommands: "resource:///modules/whimsy/WhimsyCommands.sys.mjs",
  WhimsyPrivate: "resource:///modules/whimsy/WhimsyPrivate.sys.mjs",
  WhimsyUndo: "resource:///modules/whimsy/WhimsyUndo.sys.mjs",
  clearTimeout: "resource://gre/modules/Timer.sys.mjs",
  setTimeout: "resource://gre/modules/Timer.sys.mjs",
});
ChromeUtils.defineLazyGetter(lazy, "l10n", () => new Localization(["browser/whimsy.ftl"], true));

const FEATURE_PREF = "whimsy.feature.ai-commands";
const SKILLS_PREF = "whimsy.verbs.skills";
const DOC = "commands";
const CHANGED_TOPIC = "whimsy-ai-commands-changed";
const ZEN = "chrome://browser/skin/zen-icons/";
const ICONS = "chrome://browser/content/whimsy/icons/";
const MAX_COMMANDS = 200;
const MAX_PROMPT = 8000;
const MAX_NAME = 80;
const PAGE_CHARS = 60000;

export const RESULTS = ["replace", "insert-after", "copy", "link"];

// Text commands answer on the selection; Summarize works on what's showing.
export const BUILT_INS = [
  {
    id: "improve",
    l10nId: "whimsy-command-improve",
    detailL10nId: "whimsy-commands-detail-selection",
    result: "replace",
    task: "quick-text",
    scope: "selection",
    icon: `${ZEN}wand-sparkle.svg`,
    prompt: "Improve the writing of the text below: clearer, tighter, and natural, in the same language, voice, and format. Reply with the improved text only.\n\n{selection}",
  },
  {
    id: "fix",
    l10nId: "whimsy-command-fix",
    detailL10nId: "whimsy-commands-detail-selection",
    result: "replace",
    task: "quick-text",
    scope: "selection",
    marks: true,
    icon: `${ZEN}spell-check.svg`,
    prompt: "Fix the spelling, grammar, and punctuation of the text below. Change nothing else: keep its words, voice, language, and format. Reply with the corrected text only.\n\n{selection}",
  },
  {
    id: "translate",
    l10nId: "whimsy-command-translate",
    detailL10nId: "whimsy-commands-detail-selection",
    result: "insert-after",
    task: "translate",
    scope: "selection",
    icon: `${ZEN}translations.svg`,
    prompt: "Translate the text below into {language}. Keep its meaning, tone, and format. Reply with the translation only.\n\n{selection}",
  },
  {
    id: "summarize",
    l10nId: "whimsy-command-summarize",
    detailL10nId: "whimsy-commands-detail-page",
    result: "insert-after",
    task: "summary",
    scope: "page",
    icon: `${ICONS}summarize.svg`,
    prompt: "Summarize {page} in a few short bullet points: what it is and what matters most.",
  },
];

const enc = encodeURIComponent;

function uuid() {
  return Services.uuid.generateUUID().toString().slice(1, -1);
}

function clean(cmd) {
  const result = RESULTS.includes(cmd.result) ? cmd.result : "copy";
  const out = {
    id: String(cmd.id || uuid()),
    builtIn: false,
    hidden: false,
    name: String(cmd.name ?? "").trim().slice(0, MAX_NAME),
    result,
    model: "auto",
  };
  if (result == "link") {
    out.url = String(cmd.url ?? "").trim();
  } else {
    out.prompt = String(cmd.prompt ?? "").slice(0, MAX_PROMPT);
    out.model = typeof cmd.model == "string" && cmd.model ? cmd.model : "auto";
  }
  return out;
}

/** What's wrong with a command, as a Fluent id per field, or null. */
export function problems(cmd) {
  const out = {};
  if (!String(cmd.name ?? "").trim()) {
    out.name = "whimsy-commands-error-name";
  }
  if (cmd.result == "link") {
    const url = String(cmd.url ?? "").trim();
    if (!/^https?:\/\/[^/\s]+/i.test(url)) {
      out.url = "whimsy-commands-error-address";
    } else if (!url.includes("%s")) {
      out.url = "whimsy-commands-error-missing-s";
    }
  } else if (!String(cmd.prompt ?? "").trim()) {
    out.prompt = "whimsy-commands-error-prompt";
  }
  return Object.keys(out).length ? out : null;
}

// "Label | https://…" per line; "#" starts a comment (WhimsyVerbs' old format).
export function parseSkills(text) {
  const out = [];
  for (const line of String(text ?? "").split(/\r?\n/)) {
    const [label, url] = line.split("|").map(p => p?.trim());
    if (!label || label.startsWith("#") || !/^https?:\/\//i.test(url ?? "")) {
      continue;
    }
    out.push({ name: label, result: "link", url });
  }
  return out;
}

/** A Link command's address for a subject: %s the selection (else the page's address), %t its title, %u its address. */
export function linkFor(url, subject = {}) {
  const s = subject.kind == "selection" ? subject.text : subject.url;
  return String(url)
    .replace(/%s/g, enc(s ?? ""))
    .replace(/%t/g, enc(subject.title ?? ""))
    .replace(/%u/g, enc(subject.url ?? ""));
}

let data = null;
let loading = null;
let prefill = null;

export const WhimsyAICommands = {
  TOPIC: CHANGED_TOPIC,
  BUILT_INS,

  get enabled() {
    return Services.prefs.getBoolPref(FEATURE_PREF, true);
  },

  get ready() {
    return !!data;
  },

  /** Loads the store and moves the old skills over, once. */
  init() {
    loading ??= this._load().catch(e => {
      console.error("Whimsy: commands", e);
      data ??= { hidden: [], commands: [], migrated: false };
    });
    return loading;
  },

  async _load() {
    const saved = await lazy.WhimsyAIStore.readDoc(DOC, null);
    data = {
      hidden: Array.isArray(saved?.hidden) ? saved.hidden.filter(id => BUILT_INS.some(b => b.id == id)) : [],
      commands: Array.isArray(saved?.commands) ? saved.commands.map(clean).filter(c => c.name) : [],
      migrated: !!saved?.migrated,
    };
    if (this.enabled) {
      await this.migrate();
    }
    this._changed();
  },

  // fu-settings dec-12: no banner; an empty list changes nothing.
  async migrate() {
    const lines = Services.prefs.getStringPref(SKILLS_PREF, "");
    if (data.migrated && !lines.trim()) {
      return;
    }
    const found = parseSkills(lines);
    for (const skill of found) {
      if (!data.commands.some(c => c.result == "link" && c.name == skill.name && c.url == skill.url)) {
        data.commands.push(clean(skill));
      }
    }
    data.migrated = true;
    await this._write();
    if (Services.prefs.prefHasUserValue(SKILLS_PREF)) {
      Services.prefs.clearUserPref(SKILLS_PREF);
    }
  },

  async _write() {
    data.commands = data.commands.slice(-MAX_COMMANDS);
    await lazy.WhimsyAIStore.writeDoc(DOC, { version: 1, migrated: data.migrated, hidden: data.hidden, commands: data.commands });
  },

  _changed() {
    Services.obs.notifyObservers(null, CHANGED_TOPIC);
  },

  _builtIn(b) {
    let name = "";
    try {
      name = lazy.l10n.formatValueSync(b.l10nId) ?? "";
    } catch (e) {}
    return {
      id: b.id,
      builtIn: true,
      hidden: !!data?.hidden.includes(b.id),
      name,
      result: b.result,
      prompt: b.prompt,
      model: "auto",
      l10nId: b.l10nId,
      detailL10nId: b.detailL10nId,
      task: b.task,
      scope: b.scope,
      marks: !!b.marks,
      icon: b.icon,
    };
  },

  /** Built-ins first, then yours, in the order they were made. */
  list() {
    const yours = (data?.commands ?? []).map(c => ({
      ...c,
      icon: c.result == "link" ? `${ZEN}link.svg` : `${ZEN}sparkles.svg`,
      scope: "both",
      task: "quick-text",
    }));
    return [...BUILT_INS.map(b => this._builtIn(b)), ...yours];
  },

  get(id) {
    return this.list().find(c => c.id == id) ?? null;
  },

  /** Your Link commands, for ⌘K's verbs (they work with AI off). */
  links() {
    if (!this.enabled) {
      return parseSkills(Services.prefs.getStringPref(SKILLS_PREF, "")).map(s => ({ ...s, id: s.name }));
    }
    return (data?.commands ?? []).filter(c => c.result == "link");
  },

  async save(cmd) {
    await this.init();
    const next = clean(cmd);
    const issues = problems(next);
    if (issues) {
      throw Object.assign(new Error("invalid command"), { problems: issues });
    }
    const at = data.commands.findIndex(c => c.id == next.id);
    if (at >= 0) {
      data.commands[at] = next;
    } else {
      data.commands.push(next);
    }
    await this._write();
    this._changed();
    return next;
  },

  /**
   * Deletes one of yours. With a window, the Undo toast (⌘Z while it's up)
   * puts it back where it was.
   */
  async remove(id, win = null) {
    await this.init();
    const at = data.commands.findIndex(c => c.id == id);
    if (at < 0) {
      return null;
    }
    const [gone] = data.commands.splice(at, 1);
    await this._write();
    this._changed();
    if (win) {
      lazy.WhimsyUndo.showToast(win, "whimsy-commands-deleted-toast", { undo: () => this.restore(gone, at).catch(console.error) }, { name: gone.name });
    }
    return gone;
  },

  async restore(cmd, at = data.commands.length) {
    await this.init();
    if (!data.commands.some(c => c.id == cmd.id)) {
      data.commands.splice(Math.min(at, data.commands.length), 0, clean(cmd));
      await this._write();
      this._changed();
    }
  },

  async setHidden(id, hidden) {
    await this.init();
    if (!BUILT_INS.some(b => b.id == id)) {
      return;
    }
    data.hidden = data.hidden.filter(x => x != id);
    if (hidden) {
      data.hidden.push(id);
    }
    await this._write();
    this._changed();
  },

  /** Opens the command sheet in Settings › AI › Commands, filled in when `prefill` is given. */
  openEditor(win, { prefill: fill = null, id = null } = {}) {
    prefill = fill || id ? { ...(fill ?? {}), id } : {};
    lazy.WhimsyAIProviders.openSettings(win, "command");
  },

  /** Settings' sheet reads what to show once. */
  takePrefill() {
    const out = prefill;
    prefill = null;
    return out;
  },

  /** ⌘K's "Edit commands…". */
  openSettings(win) {
    lazy.WhimsyAIProviders.openSettings(win, "commands");
  },

  /** The prompt with its tokens filled in, redacted. */
  promptFor(cmd, subject = {}, { language } = {}) {
    const redact = text => lazy.WhimsyAISensitive.redactText(String(text ?? "")).text;
    const selection = redact(subject.text ?? "");
    const page = subject.pageText ? `${subject.title ?? ""}\n${subject.url ?? ""}\n\n${redact(subject.pageText).slice(0, PAGE_CHARS)}` : `${subject.title ?? ""} (${subject.url ?? ""})`;
    return String(cmd.prompt ?? "")
      .replace(/\{selection\}/g, selection || page)
      .replace(/\{page\}/g, page)
      .replace(/\{link\}/g, subject.url ?? "")
      .replace(/\{language\}/g, language || Services.locale.appLocaleAsBCP47);
  },

  /**
   * Runs a command on a subject ({kind, text, url, title, pageText?}).
   * Link opens its address and sends nothing to AI. Prompt commands go
   * through the router (built-in text commands Apple first when quick text
   * is on) and resolve to {kind: result, text, result}; the caller shows
   * or places the text.
   */
  async run(win, id, subject = {}, { signal, onEvent, language } = {}) {
    await this.init();
    const cmd = this.get(id);
    if (!cmd) {
      throw new Error(`No command ${id}`);
    }
    const tab = win?.gBrowser?.selectedTab;
    if (cmd.result == "link") {
      const url = linkFor(cmd.url, subject);
      lazy.WhimsyPrivate.openTabFor(win, url);
      return { kind: "link", url };
    }
    if (!lazy.WhimsyAI.enabled || (tab && lazy.WhimsyAIContext.isPrivate(tab))) {
      throw Object.assign(new Error("blocked"), { code: "blocked" });
    }
    const result = await lazy.WhimsyAIRouter.run({
      task: cmd.task ?? "quick-text",
      messages: [{ role: "user", content: this.promptFor(cmd, subject, { language }) }],
      system: "You are a writing command in Whimsy, a web browser. Do exactly what the instruction says and reply with the result only: no preamble, no quotes around it, and no notes.",
      provider: cmd.model,
      userStarted: true,
      tools: [],
      signal,
      onEvent,
    });
    return { kind: cmd.result, text: String(result?.text ?? "").trim(), result };
  },

  // ---- Wiring ----

  initWindow(win) {
    this.init();
    lazy.WhimsyCommands.register(win, {
      id: "cmd_whimsyEditCommands",
      l10nId: "whimsy-action-edit-commands",
      run: w => this.openSettings(w),
      icon: `${ZEN}edit-theme.svg`,
      isAvailable: () => this.enabled && lazy.WhimsyAI.enabled,
    });
    if (!this._answerAction) {
      this._answerAction = true;
      lazy.WhimsyChat.registerAnswerAction({
        id: "save-command",
        l10nId: "whimsy-chat-action-save-command",
        icon: `${ZEN}plus.svg`,
        isAvailable: msg => this.enabled && msg?.role == "ai" && !!msg.text && this.reused(msg),
        run: (w, msg) => this.openEditor(w, { prefill: { prompt: this._promptOf.get(msg.id) ?? "", result: "copy" } }),
      });
      this._watchPrompts();
    }
  },

  // "Save as a command" shows on answers to a prompt you've sent before.
  _promptOf: new Map(),
  reused(msg) {
    return this._promptOf.has(msg?.id);
  },

  _watchPrompts() {
    let timer = null;
    const refresh = () => {
      lazy.clearTimeout(timer);
      timer = lazy.setTimeout(() => this._scanPrompts().catch(e => console.error("Whimsy: commands' prompts", e)), 500);
    };
    Services.obs.addObserver(refresh, "whimsy-ai-store-changed");
    refresh();
  },

  async _scanPrompts() {
    const counts = new Map();
    const answers = [];
    const threads = (await lazy.WhimsyAIStore.threads()).slice(-50);
    for (const thread of threads) {
      const messages = await lazy.WhimsyAIStore.messages(thread.id);
      let asked = null;
      for (const m of messages) {
        if (m.role == "user") {
          asked = String(m.text ?? "").trim();
          if (asked) {
            const key = asked.toLowerCase().replace(/\s+/g, " ");
            counts.set(key, (counts.get(key) ?? 0) + 1);
          }
        } else if (m.role == "ai" && asked) {
          answers.push([m.id, asked]);
        }
      }
    }
    this._promptOf = new Map(answers.filter(([, p]) => counts.get(p.toLowerCase().replace(/\s+/g, " ")) > 1));
  },

  async _resetForTesting() {
    await loading?.catch(() => {});
    data = null;
    loading = null;
    prefill = null;
    await lazy.WhimsyAIStore.writeDoc(DOC, null);
  },
};
