/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Activity (W23; was agent replay): every agent run, Whimsy's own and
// outside apps', is kept as a timeline of steps (the tool, its target, the
// page's address and title, a small thumbnail) so the person can look back
// at what an agent did. Settings › AI › Activity and whimsy://replay
// ("Agent runs") list the runs; one run is one task (WhimsyAgentTasks).
//
// - Local only: <profile>/whimsy-ai/agent-runs.json, mode 0600, bounded
//   (runs, steps, bytes) and kept 7, 30 (default), or 90 days, or forever
//   (whimsy.ai.activity.days: 7|30|90|0).
// - Private tabs, private windows, and Scratch are never captured, not even
//   their address. Thumbnails are taken with card, password, and code
//   fields masked first (WhimsyAIContext.withMask), never blurred later.
// - The Fire button (WhimsyAIStore "activity"), Clear history, and Delete
//   Run clear it; clearing a time range clears that range.
// - whimsy.claude.replay turns recording off.

import { redactText } from "resource:///modules/whimsy/WhimsyAISensitive.sys.mjs";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  PrivateBrowsingUtils: "resource://gre/modules/PrivateBrowsingUtils.sys.mjs",
  WhimsyAIContext: "resource:///modules/whimsy/WhimsyAIContext.sys.mjs",
  WhimsyAIStore: "resource:///modules/whimsy/WhimsyAIStore.sys.mjs",
  WhimsyClaude: "resource:///modules/whimsy/WhimsyClaude.sys.mjs",
  WhimsyPrivate: "resource:///modules/whimsy/WhimsyPrivate.sys.mjs",
  clearTimeout: "resource://gre/modules/Timer.sys.mjs",
  setTimeout: "resource://gre/modules/Timer.sys.mjs",
});

const FEATURE_PREF = "whimsy.feature.ai-activity";
const KEEP_PREF = "whimsy.claude.replay";
const DAYS_PREF = "whimsy.ai.activity.days";
const DAY_MS = 24 * 60 * 60 * 1000;
const RETENTION_CHOICES = [7, 30, 90, 0];

const LIMITS = {
  runs: 500,
  steps: 300,
  bytes: 20 * 1024 * 1024,
  // Only the newest runs keep thumbnails.
  thumbRuns: 60,
};

function retentionMs() {
  const days = Services.prefs.getIntPref(DAYS_PREF, 30);
  return RETENTION_CHOICES.includes(days) && days > 0 ? days * DAY_MS : days == 0 ? Infinity : 30 * DAY_MS;
}
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
  return PathUtils.join(lazy.WhimsyAIStore.dir, "agent-runs.json");
}

// Before W23.
function oldFilePath() {
  return PathUtils.join(PathUtils.profileDir, "whimsy-claude", "runs.json");
}

const state = {
  runs: null,
  loading: null,
  saveTimer: null,
  saving: Promise.resolve(),
  pending: new Set(),
  observing: false,
};

export const WhimsyClaudeReplay = {
  LIMITS,
  RETENTION_CHOICES,

  get enabled() {
    return Services.prefs.getBoolPref(FEATURE_PREF, true) && Services.prefs.getBoolPref(KEEP_PREF, true);
  },

  /** Days runs are kept: 7, 30, 90, or 0 (forever). */
  get retentionDays() {
    const days = Services.prefs.getIntPref(DAYS_PREF, 30);
    return RETENTION_CHOICES.includes(days) ? days : 30;
  },

  set retentionDays(days) {
    if (!RETENTION_CHOICES.includes(days)) {
      throw new Error(`Activity is kept 7, 30, or 90 days, or forever (0), not ${days}`);
    }
    Services.prefs.setIntPref(DAYS_PREF, days);
  },

  // Once per session: Clear history and the Fire button clear it.
  init() {
    if (state.observing) {
      return;
    }
    state.observing = true;
    Services.obs.addObserver(this, "browser:purge-session-history");
    Services.obs.addObserver(this, "quit-application-granted");
    Services.prefs.addObserver(DAYS_PREF, this);
    lazy.WhimsyAIStore.registerClearer("activity", ({ since }) => this.clear(since ?? 0));
  },

  observe(subject, topic, data) {
    if (topic == "nsPref:changed") {
      // A shorter time takes older runs away now.
      this.load().then(() => this.save()).catch(e => console.error("Whimsy: Activity", e));
      return;
    }
    if (topic == "quit-application-granted") {
      this.flush().catch(e => console.error("Whimsy: Claude replay", e));
      return;
    }
    // data is the start of the cleared range (microseconds), if any.
    const since = data ? Number(data) / 1000 : 0;
    this.clear(Number.isFinite(since) ? since : 0).catch(e => console.error("Whimsy: Claude replay", e));
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
      lazy.WhimsyAIContext.isPrivate(tab) ||
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
        return `“${clip(redactText(args.text).text, 60)}”${args.ref ? ` → ${clip(args.ref, 20)}` : ""}`;
      case "key":
        return clip(args.keys, 60);
      case "form_input":
        return `${clip(args.ref, 20)} = ${clip(redactText(String(args.value ?? "")).text, 40)}`;
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

  // One step of a task's run. `tab` is the tab the agent used (null for
  // tabs_list or a closed tab); its page and a masked thumbnail are kept
  // unless it's private.
  record(step, tab = null) {
    if (!this.enabled || !this.capturable(tab)) {
      return Promise.resolve();
    }
    const promise = this._record(step, tab)
      .catch(e => console.error("Whimsy: Activity", e))
      .finally(() => state.pending.delete(promise));
    state.pending.add(promise);
    return promise;
  },

  async _record({ tool, args, ok = true, error = "", url = "", title = "", task = null }, tab) {
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
    const taskId = task?.id ?? "";
    let run = runs.find(r => r.taskId == taskId);
    if (!run) {
      run = {
        id: `${entry.t.toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
        taskId,
        client: task?.client == "whimsy" ? "whimsy" : "outside",
        clientName: clip(task?.clientName ?? "", 60),
        mode: task?.mode ?? "drive",
        threadId: task?.threadId ?? null,
        title: clip(task?.title ?? "", 120),
        start: entry.t,
        end: entry.t,
        steps: [],
      };
      runs.unshift(run);
    }
    run.threadId ??= task?.threadId ?? null;
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
    const shot = await lazy.WhimsyClaude.capture(tab, Math.min(1, THUMB_WIDTH / width));
    if (!shot) {
      return null;
    }
    const canvas = tab.ownerDocument.createElementNS("http://www.w3.org/1999/xhtml", "canvas");
    canvas.width = Math.min(THUMB_WIDTH, shot.width);
    canvas.height = Math.max(1, Math.round((shot.height * canvas.width) / shot.width));
    canvas.getContext("2d").drawImage(shot, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/jpeg", 0.6);
  },

  // --- Storage ---

  load() {
    if (state.runs) {
      return Promise.resolve(state.runs);
    }
    state.loading ??= (async () => {
      let runs = [];
      try {
        const path = (await IOUtils.exists(filePath())) ? filePath() : oldFilePath();
        if (await IOUtils.exists(path)) {
          const data = await IOUtils.readJSON(path);
          runs = Array.isArray(data?.runs) ? data.runs : [];
        }
        await IOUtils.remove(oldFilePath(), { ignoreAbsent: true });
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
    const keep = retentionMs();
    runs = runs
      .filter(run => run && Array.isArray(run.steps) && run.steps.length && now - run.end <= keep)
      .sort((a, b) => b.end - a.end)
      .slice(0, LIMITS.runs);
    for (const run of runs.slice(LIMITS.thumbRuns)) {
      for (const step of run.steps) {
        delete step.thumb;
      }
    }
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
        await IOUtils.makeDirectory(dir, { permissions: 0o700, createAncestors: true });
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

  /** Runs, newest first; `client` "whimsy" or "outside" filters them. */
  async runs({ client = null } = {}) {
    await Promise.all([...state.pending]);
    const runs = structuredClone(await this.load());
    return client ? runs.filter(run => (run.client ?? "outside") == client) : runs;
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
    const who = run.client == "whimsy" ? "Whimsy" : run.clientName || "Outside agent";
    const lines = [`${who} run ${time(run.start)} – ${time(run.end)}`];
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
