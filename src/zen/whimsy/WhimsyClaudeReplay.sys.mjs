/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Agent replay for the Claude space (whimsy.feature.claude-replay): each
// Claude run is kept as a timeline of steps (the tool, its target, the
// page's URL and title, a small thumbnail) so the person can look back at
// what Claude did. whimsy://replay (whimsy-replay.js) lists the runs.
//
// - Local only: a private file in the profile (whimsy-claude/runs.json,
//   mode 0600), bounded (runs, steps, bytes, age) and pruned on every save.
// - Private tabs, private windows and Scratch are never captured, not even
//   their URL; WhimsyClaude never lets Claude use them anyway.
// - Clear history (and the Fire button's "Everything") clears it, along
//   with the shield's audit log; clearing a time range clears that range.
// - whimsy.claude.replay (Settings → Claude) turns recording off.
//
// A run starts when Claude Code connects (MCP initialize), after Stop, or
// after a quiet spell.

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  PrivateBrowsingUtils: "resource://gre/modules/PrivateBrowsingUtils.sys.mjs",
  WhimsyClaude: "resource:///modules/whimsy/WhimsyClaude.sys.mjs",
  WhimsyPrivate: "resource:///modules/whimsy/WhimsyPrivate.sys.mjs",
  clearTimeout: "resource://gre/modules/Timer.sys.mjs",
  setTimeout: "resource://gre/modules/Timer.sys.mjs",
});

const FEATURE_PREF = "whimsy.feature.claude-replay";
const KEEP_PREF = "whimsy.claude.replay";

const LIMITS = {
  runs: 30,
  steps: 150,
  bytes: 6 * 1024 * 1024,
  ageMs: 30 * 24 * 60 * 60 * 1000,
  gapMs: 15 * 60 * 1000,
};
const THUMB_WIDTH = 320;
const SAVE_DELAY_MS = 1000;
const CLIP = 120;

// A page's address without its query or fragment, where magic-link tokens
// and one-time codes travel (like the audit log's; security L5).
function pageURL(spec) {
  if (!spec) {
    return "";
  }
  try {
    const uri = Services.io.newURI(String(spec));
    return uri.prePath + uri.filePath;
  } catch {
    return String(spec ?? "").split(/[?#]/)[0];
  }
}

function clip(value, max = CLIP) {
  const text = String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > max ? text.slice(0, max - 1) + "…" : text;
}

function filePath() {
  return PathUtils.join(PathUtils.profileDir, "whimsy-claude", "runs.json");
}

const state = {
  runs: null,
  loading: null,
  newRun: true,
  client: "",
  // Which run new steps go in: a counter bumped for each new run, the
  // Claude generation (Stop bumps it), and the run that key last used.
  runKey: 0,
  generation: null,
  keyRun: { key: -1, id: "" },
  saveTimer: null,
  saving: Promise.resolve(),
  pending: new Set(),
  observing: false,
};

export const WhimsyClaudeReplay = {
  LIMITS,

  get enabled() {
    return Services.prefs.getBoolPref(FEATURE_PREF, true) && Services.prefs.getBoolPref(KEEP_PREF, true);
  },

  // Once per session: Clear history clears the replay.
  init() {
    if (state.observing) {
      return;
    }
    state.observing = true;
    Services.obs.addObserver(this, "browser:purge-session-history");
    Services.obs.addObserver(this, "quit-application-granted");
  },

  observe(subject, topic, data) {
    if (topic == "quit-application-granted") {
      this.flush().catch(e => console.error("Whimsy: Claude replay", e));
      return;
    }
    // data is the start of the cleared range (microseconds), if any.
    const since = data ? Number(data) / 1000 : 0;
    this.clear(Number.isFinite(since) ? since : 0).catch(e => console.error("Whimsy: Claude replay", e));
  },

  // Claude Code (re)connected, or the person pressed Stop.
  startRun(client = "") {
    state.newRun = true;
    state.client = clip(client, 60);
  },

  // --- Recording ---

  // Never a private tab, a tab in a private window, or Scratch.
  capturable(tab) {
    if (!tab) {
      return true;
    }
    const win = tab.documentGlobal;
    return !(
      !win ||
      lazy.PrivateBrowsingUtils.isWindowPrivate(win) ||
      lazy.WhimsyPrivate.isPrivateTab(tab) ||
      tab.linkedBrowser?.browsingContext?.usePrivateBrowsing ||
      lazy.WhimsyPrivate.isScratchId(win, tab.getAttribute("zen-workspace-id")) ||
      win._whimsyQuickWindow
    );
  },

  // What a step acted on, in a few words.
  target(tool, args = {}) {
    switch (tool) {
      case "tabs_create":
      case "navigate":
        return clip(pageURL(args.url));
      case "click":
        return args.ref ? clip(args.ref) : Array.isArray(args.coordinate) ? `(${args.coordinate.map(Math.round).join(", ")})` : "";
      case "type":
        return `“${clip(args.text, 60)}”${args.ref ? ` → ${clip(args.ref, 20)}` : ""}`;
      case "key":
        return clip(args.keys, 60);
      case "form_input":
        return `${clip(args.ref, 20)} = ${clip(args.value, 40)}`;
      case "scroll":
        return clip(`${args.direction || "down"}${args.amount ? ` ×${args.amount}` : ""}`);
      case "find":
        return `“${clip(args.query, 60)}”`;
      case "read_page":
        return clip([args.filter, args.ref].filter(Boolean).join(" "));
      case "shield":
        return clip(args.reasons?.join(", "));
    }
    return "";
  },

  // One step. `tab` is the tab Claude used (null for tabs_list or a closed
  // tab); its page and a thumbnail are captured unless it's private.
  record(step, tab = null) {
    if (!this.enabled || !this.capturable(tab)) {
      return Promise.resolve();
    }
    // Decided now, in call order, not after the thumbnail's await.
    if (state.newRun || (step.generation !== undefined && step.generation !== state.generation)) {
      state.runKey++;
    }
    state.newRun = false;
    state.generation = step.generation ?? state.generation;
    const promise = this._record(step, tab, state.runKey)
      .catch(e => console.error("Whimsy: Claude replay", e))
      .finally(() => state.pending.delete(promise));
    state.pending.add(promise);
    return promise;
  },

  async _record({ tool, args, ok = true, error = "", url = "", title = "" }, tab, key) {
    const uri = tab?.linkedBrowser?.currentURI;
    const web = uri && (uri.schemeIs("http") || uri.schemeIs("https"));
    const entry = {
      t: Date.now(),
      tool: String(tool),
      target: this.target(tool, args),
      url: web ? pageURL(uri.spec) : clip(pageURL(url), 2000),
      title: clip(web ? tab.label : title, 200),
      ok: !!ok,
    };
    if (error) {
      entry.error = clip(error, 200);
    }
    const thumb = web && tool != "tabs_close" ? await this.thumbnail(tab).catch(() => null) : null;
    if (thumb) {
      entry.thumb = thumb;
    }
    const runs = await this.load();
    let run = state.keyRun.key == key ? runs.find(r => r.id == state.keyRun.id) : null;
    if (!run || entry.t - run.end > LIMITS.gapMs) {
      run = {
        id: `${entry.t.toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
        start: entry.t,
        end: entry.t,
        client: state.client,
        steps: [],
      };
      runs.unshift(run);
      state.keyRun = { key, id: run.id };
    }
    run.steps.push(entry);
    run.end = entry.t;
    if (run.steps.length > LIMITS.steps) {
      run.steps.splice(0, run.steps.length - LIMITS.steps);
      run.trimmed = true;
    }
    this.scheduleSave();
  },

  async thumbnail(tab) {
    if (!this.capturable(tab)) {
      return null;
    }
    const browser = tab.linkedBrowser;
    const wg = browser?.browsingContext?.currentWindowGlobal;
    if (!wg) {
      return null;
    }
    const width = browser.clientWidth || browser.getBoundingClientRect().width || 1280;
    const bitmap = await wg.drawSnapshot(null, Math.min(1, THUMB_WIDTH / width), "rgb(255,255,255)");
    try {
      if (!bitmap.width || !bitmap.height) {
        return null;
      }
      const canvas = tab.ownerDocument.createElementNS("http://www.w3.org/1999/xhtml", "canvas");
      canvas.width = Math.min(THUMB_WIDTH, bitmap.width);
      canvas.height = Math.max(1, Math.round((bitmap.height * canvas.width) / bitmap.width));
      canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      return canvas.toDataURL("image/jpeg", 0.6);
    } finally {
      bitmap.close();
    }
  },

  // --- Storage ---

  load() {
    if (state.runs) {
      return Promise.resolve(state.runs);
    }
    state.loading ??= (async () => {
      let runs = [];
      try {
        if (await IOUtils.exists(filePath())) {
          const data = await IOUtils.readJSON(filePath());
          runs = Array.isArray(data?.runs) ? data.runs : [];
        }
      } catch (e) {
        console.error("Whimsy: Claude replay file", e);
      }
      // Something recorded (or cleared) while the file was loading wins.
      state.runs ??= this.prune(runs);
      state.loading = null;
      return state.runs;
    })();
    return state.loading;
  },

  // Bounded: recent runs only, a step cap per run, and a byte cap
  // (oldest runs go first, then the oldest thumbnails).
  prune(runs, now = Date.now()) {
    runs = runs
      .filter(run => run && Array.isArray(run.steps) && run.steps.length && now - run.end <= LIMITS.ageMs)
      .sort((a, b) => b.end - a.end)
      .slice(0, LIMITS.runs);
    for (const run of runs) {
      if (run.steps.length > LIMITS.steps) {
        run.steps.splice(0, run.steps.length - LIMITS.steps);
        run.trimmed = true;
      }
    }
    const size = () => JSON.stringify({ runs }).length;
    while (runs.length > 1 && size() > LIMITS.bytes) {
      runs.pop();
    }
    for (const step of runs[0]?.steps ?? []) {
      if (size() <= LIMITS.bytes) {
        break;
      }
      delete step.thumb;
    }
    return runs;
  },

  scheduleSave() {
    lazy.clearTimeout(state.saveTimer);
    state.saveTimer = lazy.setTimeout(() => this.save(), SAVE_DELAY_MS);
  },

  save() {
    lazy.clearTimeout(state.saveTimer);
    state.saveTimer = null;
    state.saving = state.saving
      .catch(() => {})
      .then(async () => {
        if (!state.runs) {
          return;
        }
        state.runs = this.prune(state.runs);
        const path = filePath();
        const dir = PathUtils.parent(path);
        await IOUtils.makeDirectory(dir, { permissions: 0o700 });
        if (!state.runs.length) {
          await IOUtils.remove(path, { ignoreAbsent: true });
          return;
        }
        await IOUtils.writeJSON(path, { version: 1, runs: state.runs }, { tmpPath: path + ".tmp" });
        await IOUtils.setPermissions(path, 0o600, false);
      })
      .catch(e => console.error("Whimsy: Claude replay save", e));
    return state.saving;
  },

  // Everything recorded so far is on disk.
  async flush() {
    await Promise.all([...state.pending]);
    if (state.saveTimer || state.runs) {
      await this.save();
    }
  },

  // --- Reading (whimsy://replay) ---

  async runs() {
    await Promise.all([...state.pending]);
    return structuredClone(await this.load());
  },

  // Clears every run, or only steps from `since` (ms) on.
  async clear(since = 0) {
    await Promise.all([...state.pending]);
    const runs = await this.load();
    if (since > 0) {
      for (const run of runs) {
        run.steps = run.steps.filter(step => step.t < since);
        run.end = run.steps.at(-1)?.t ?? run.end;
      }
      state.runs = runs.filter(run => run.steps.length);
    } else {
      state.runs = [];
      await lazy.WhimsyClaude.clearAudit();
    }
    state.newRun = true;
    await this.save();
    Services.obs.notifyObservers(null, "whimsy-claude-replay-changed");
  },

  async deleteRun(id) {
    const runs = await this.load();
    state.runs = runs.filter(run => run.id != id);
    await this.save();
    Services.obs.notifyObservers(null, "whimsy-claude-replay-changed");
  },

  // A run as plain text, for Copy log.
  logText(run) {
    const time = t => new Date(t).toISOString().replace("T", " ").replace(/\.\d+Z$/, "Z");
    const lines = [`Claude run ${time(run.start)} – ${time(run.end)}${run.client ? ` (${run.client})` : ""}`];
    run.steps.forEach((step, i) => {
      let line = `${i + 1}. ${time(step.t)} ${step.tool}`;
      if (step.target) {
        line += ` ${step.target}`;
      }
      if (step.url) {
        line += ` — ${step.url}`;
      }
      if (!step.ok) {
        line += ` [failed${step.error ? `: ${step.error}` : ""}]`;
      }
      lines.push(line);
    });
    return lines.join("\n");
  },
};
