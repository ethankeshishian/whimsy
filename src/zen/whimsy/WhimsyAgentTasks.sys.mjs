/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// W23: agent tasks. Every agent run is a task: Whimsy's own (Drive or
// Background, started from chat) and an outside app's (one per MCP
// connection session). Every tool call names its task.
//
// - Stop (⌘.) ends that task only; the agent stays on for everything else.
// - A pause holds its task only. Nothing resumes by itself: a pause ends
//   with the person's choice (decide) or Continue (resume).
// - Sleep pauses every running task; a quit leaves a note that the next
//   launch shows in the task's thread and once in Updates.
//
// Thread cards (rendered by the chat lane), all {role: "card", card, taskId}:
// - "agent-pause" {pauseId, kind, preview, choices, allowForTask, state}
// - "agent-injection" {host, snippets[], count, where: {url, text}}
// - "agent-unlock" {spaceId, spaceName}: Whimsy's card; only the person acts
// - "agent-interrupted" {reason: "quit", step}

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  WhimsyOutsideAgents: "resource:///modules/whimsy/WhimsyOutsideAgents.sys.mjs",
  WhimsyAIStore: "resource:///modules/whimsy/WhimsyAIStore.sys.mjs",
  WhimsyAIUpdates: "resource:///modules/whimsy/WhimsyAIUpdates.sys.mjs",
  WhimsyChat: "resource:///modules/whimsy/WhimsyChat.sys.mjs",
  WhimsyTaskFolder: "resource:///modules/whimsy/WhimsyTaskFolder.sys.mjs",
  clearTimeout: "resource://gre/modules/Timer.sys.mjs",
  setTimeout: "resource://gre/modules/Timer.sys.mjs",
});

const TOPIC = "whimsy-agent-tasks-changed";
const RUNNING_DOC = "agent-running";
const ACTIVE = new Set(["planning", "running", "paused"]);
// The choices each pause offers, in the card's order.
const CHOICES = {
  security: ["self", "skip"],
  captcha: ["self", "skip"],
  unlock: ["do", "skip"],
  timeout: ["do", "skip", "stop"],
  sleep: ["do", "stop"],
  quit: ["do", "stop"],
  navigate: ["do", "skip"],
  collision: ["do", "self"],
  "tab-closed": ["do", "stop"],
};
const DEFAULT_CHOICES = ["do", "self", "skip"];
// "Don't ask again on this site for this task": only these (agent dec-4).
const ALLOW_KINDS = new Set(["submit", "new-site-data", "download"]);

const tasks = new Map();
const sessions = new Map();
let approvalWindow = null;
let nextPause = 1;
let initialized = false;
let timer = (ms, fn) => {
  const id = lazy.setTimeout(fn, ms);
  return () => lazy.clearTimeout(id);
};

function uuid() {
  return Services.uuid.generateUUID().toString().slice(1, -1);
}

function notify(task, what = "changed") {
  Services.obs.notifyObservers(null, TOPIC, `${what}:${task?.id ?? ""}`);
  WhimsyAgentTasks.refreshApprovalSurface();
  try {
    lazy.WhimsyChat.tasksChanged();
  } catch {}
}

function hostOf(url) {
  try {
    return Services.io.newURI(String(url)).host;
  } catch {
    return "";
  }
}

// What the Tasks strip and other lanes see: no live objects.
function view(task) {
  return {
    id: task.id,
    client: task.client,
    clientName: task.clientName,
    mode: task.mode,
    state: task.state,
    spaceId: task.spaceId,
    threadId: task.threadId,
    title: task.title,
    tabs: new Set(task.tabs),
    steps: task.steps.slice(),
    pause: task.pause ? { ...task.pause, waiters: undefined, cancelExpiry: undefined } : null,
    skipped: task.skipped.slice(),
    created: task.created,
  };
}

export const WhimsyAgentTasks = {
  TOPIC,
  ALLOW_KINDS,
  approvalTimeoutMs: 110 * 1000,

  init() {
    if (initialized) {
      return;
    }
    initialized = true;
    Services.obs.addObserver(this, "sleep_notification");
    Services.obs.addObserver(this, "wake_notification");
    try {
      lazy.WhimsyChat.registerTaskSource({
        id: "agent",
        list: () => this.list().map(view),
        show: (win, task) => task.threadId && lazy.WhimsyChat.open(win, { threadId: task.threadId, focus: "card" }),
        stop: task => this.stop(task.id),
      });
    } catch (e) {
      console.error("Whimsy: agent task source", e);
    }
    this.reportInterrupted().catch(e => console.error("Whimsy: agent tasks after quit", e));
  },

  observe(subject, topic) {
    if (topic == "sleep_notification") {
      for (const task of this.list()) {
        if (task.state == "running") {
          this.pause(task.id, { kind: "sleep", since: Date.now() });
        }
      }
    } else if (topic == "wake_notification") {
      for (const task of this.list()) {
        if (task.pause?.kind == "sleep" && !task.pause.until) {
          task.pause.until = Date.now();
          notify(task);
        }
      }
    }
  },

  /**
   * @param {{client?: string, clientName?: string, mode?: "drive"|"background",
   *   threadId?: string, spaceId?: string, plan?: object, namedSpaceIds?: string[],
   *   title?: string, session?: string}} opts
   */
  start({ client = "whimsy", clientName = "", mode = "drive", threadId = null, spaceId = null, plan = null,
    namedSpaceIds = [], title = "", session = null, sites = [], kind = "" } = {}) {
    this.init();
    const task = {
      id: uuid(),
      client,
      clientName: clientName || client,
      mode: mode == "background" ? "background" : "drive",
      // "routine" when a routine started it (Settings › Activity labels it so).
      kind: kind == "routine" ? "routine" : "",
      // Pauses the person approved, for Activity's "paused once, you approved".
      approvals: 0,
      state: plan ? "planning" : "running",
      spaceId,
      threadId,
      plan,
      title,
      namedSpaceIds: [...namedSpaceIds],
      session,
      tabs: new Set(),
      // H2: the sites (registrable domains) this task has been on, or the
      // person named; going anywhere else pauses. And the person's own tabs
      // they attached to a Drive task.
      sites: new Set(sites),
      attached: new Set(),
      steps: [],
      pause: null,
      generation: 0,
      allowed: new Set(),
      skipped: [],
      notices: new Map(),
      created: Date.now(),
      updated: Date.now(),
    };
    tasks.set(task.id, task);
    if (session) {
      sessions.set(session, task.id);
    }
    if (client != "whimsy" && !threadId) {
      lazy.WhimsyAIStore.createThread({ kind: "outside", title: title || task.clientName, origin: client })
        .then(thread => {
          task.threadId = thread.id;
          // A first tool call may already be waiting before the thread exists.
          if (task.pause) {
            const p = task.pause;
            this.card(task, { card: "agent-pause", pauseId: p.id, kind: p.kind,
              preview: p.preview, choices: p.choices, allowForTask: p.allowForTask,
              state: p.choice || "open" });
          }
          notify(task);
        })
        .catch(e => console.error("Whimsy: outside agent thread", e));
    }
    this.remember(task);
    notify(task, "started");
    return task;
  },

  /** Plan accepted (Start): the task runs. */
  begin(id) {
    const task = tasks.get(id);
    if (task?.state == "planning") {
      task.state = "running";
      notify(task);
    }
    return task ?? null;
  },

  get(id) {
    return tasks.get(id) ?? null;
  },

  /** Tasks still going (planning, running, or paused), oldest first. */
  list({ client = null } = {}) {
    return [...tasks.values()].filter(t => ACTIVE.has(t.state) && (!client || t.client == client));
  },

  isActive(task) {
    return !!task && ACTIVE.has(task.state);
  },

  /**
   * The task for an outside app's connection session. A stopped task is
   * reported to the app once ("stopped"); the call after that starts a new
   * one.
   */
  forSession(session, clientName = "", client = "outside") {
    const key = session || `client:${clientName}`;
    const task = tasks.get(sessions.get(key));
    if (task && (this.isActive(task) || (task.state == "stopped" && !task.stopReported))) {
      return task;
    }
    return this.start({ client, clientName, session: key });
  },

  /** Ends this task only: its calls stop, its pause goes, other tasks carry on. */
  stop(id, { reason = "stopped" } = {}) {
    const task = tasks.get(id);
    if (!task || !ACTIVE.has(task.state)) {
      return false;
    }
    task.state = "stopped";
    task.stopReason = reason;
    task.generation++;
    this.settle(task, "stop");
    this.forget(task);
    notify(task, "stopped");
    return true;
  },

  /** The task finished on its own. */
  finish(id) {
    const task = tasks.get(id);
    if (!task || !ACTIVE.has(task.state)) {
      return;
    }
    task.state = "done";
    this.settle(task, "stop");
    this.forget(task);
    notify(task, "done");
  },

  /**
   * Pauses the task (one pause at a time). `reason` is the pause: {kind,
   * preview?, host?, sig?, spaceId?, handOver?, ...}.
   */
  pause(id, reason = {}) {
    const task = tasks.get(id);
    if (!task || !ACTIVE.has(task.state)) {
      return null;
    }
    if (task.pause && !task.pause.choice) {
      return task.pause;
    }
    const kind = reason.kind ?? "unsure";
    const pause = {
      ...reason,
      id: `p${nextPause++}`,
      taskId: id,
      kind,
      choices: reason.choices ?? (reason.handOver ? ["self", "skip"] : CHOICES[kind] ?? DEFAULT_CHOICES),
      allowForTask: ALLOW_KINDS.has(kind) && !!reason.host && !reason.everyTime,
      created: Date.now(),
      choice: null,
      yours: false,
      waiters: new Set(),
    };
    task.pause = pause;
    task.state = "paused";
    task.updated = Date.now();
    this.card(task, { card: kind == "unlock" ? "agent-unlock" : "agent-pause", pauseId: pause.id, kind,
      preview: pause.preview ?? null, choices: pause.choices, allowForTask: pause.allowForTask, state: "open",
      spaceId: pause.spaceId, spaceName: pause.spaceName });
    notify(task, "paused");
    return pause;
  },

  /** Outside approvals must be usable without an open chat or a ready thread. */
  pendingApprovals() {
    return this.list().filter(t => t.client != "whimsy" && t.pause && !t.pause.choice);
  },

  showApproval(task, pause) {
    try {
      return this.renderApproval(task, pause);
    } catch (error) {
      console.error("Whimsy: approval surface", error);
      this.settle(task, "unavailable");
      return false;
    }
  },

  renderApproval(task, pause) {
    if (!pause.deadline) {
      pause.deadline = Date.now() + this.approvalTimeoutMs;
      pause.cancelExpiry = timer(this.approvalTimeoutMs, () => {
        if (task.pause == pause && !pause.choice) {
          this.settle(task, "expired");
        }
      });
    }
    if (Date.now() >= pause.deadline) {
      this.settle(task, "expired");
      return false;
    }
    const win = lazy.WhimsyOutsideAgents.window();
    if (!win?.gBrowser || !win.document.getElementById("mainPopupSet")) {
      this.settle(task, "unavailable");
      return false;
    }
    if (approvalWindow != win) {
      approvalWindow?.document?.getElementById("whimsy-mcp-approvals")?.remove();
      approvalWindow = win;
    }
    this.refreshApprovalSurface();
    const surface = win.document.getElementById("whimsy-mcp-approvals");
    if (!surface?.getBoundingClientRect().width) {
      this.settle(task, "unavailable");
      return false;
    }
    pause.shown = Date.now();
    surface.querySelector("button")?.focus();
    return true;
  },

  refreshApprovalSurface() {
    const doc = approvalWindow?.closed ? null : approvalWindow?.document;
    if (!doc) {
      return;
    }
    const pending = this.pendingApprovals();
    let surface = doc.getElementById("whimsy-mcp-approvals");
    if (!pending.length) {
      surface?.remove();
      approvalWindow = null;
      return;
    }
    const bundle = new Localization(["browser/whimsy.ftl"], true);
    const el = (tag, parent, text = "") => {
      const node = doc.createElementNS("http://www.w3.org/1999/xhtml", tag);
      node.textContent = text;
      parent.append(node);
      return node;
    };
    if (!surface) {
      surface = el("section", doc.documentElement);
      surface.id = "whimsy-mcp-approvals";
      surface.setAttribute("role", "region");
      surface.setAttribute("aria-label", bundle.formatValueSync("whimsy-mcp-pending"));
    }
    // Keep the same controls on repeated calls and unrelated task updates.
    const key = pending.map(t => `${t.id}:${t.pause.id}:${t.pause.yours}`).join("|");
    if (surface.dataset.requests == key) {
      return;
    }
    surface.dataset.requests = key;
    surface.replaceChildren();
    el("h3", surface, bundle.formatValueSync("whimsy-mcp-pending"));
    for (const task of pending) {
      const pause = task.pause;
      const card = el("article", surface);
      card.dataset.pauseId = pause.id;
      el("strong", card, task.clientName);
      el("p", card, pause.preview?.title || pause.kind);
      for (const field of pause.preview?.fields ?? []) {
        el("p", card, `${field.label}: ${field.value}${field.note ? ` — ${field.note}` : ""}`);
      }
      const buttons = el("div", card);
      const choices = pause.yours ? ["continue", "skip"] : pause.choices;
      for (const choice of choices) {
        const id = { do: "approve", skip: "deny", self: "self", stop: "stop", continue: "continue" }[choice];
        const button = el("button", buttons, bundle.formatValueSync(`whimsy-mcp-${id}`));
        button.type = "button";
        button.dataset.choice = choice;
        button.addEventListener("click", () => {
          // A stale rendered control cannot approve a subsequent request.
          if (task.pause == pause && !pause.choice) {
            choice == "continue" ? this.resume(task.id) : this.decide(task.id, choice);
          }
        });
      }
    }
  },

  /**
   * The person's choice on a pause: "do", "self" (they take the step; the
   * call waits for Continue), "skip", or "stop".
   */
  decide(id, choice, { allowForTask = false } = {}) {
    const task = tasks.get(id);
    const pause = task?.pause;
    if (!pause || pause.choice) {
      return false;
    }
    if (choice == "stop") {
      return this.stop(id);
    }
    if (!pause.choices.includes(choice)) {
      return false;
    }
    if (allowForTask && pause.allowForTask && choice == "do") {
      task.allowed.add(`${pause.kind}|${pause.host}`);
    }
    // A collision's "Keep this tab": the tab leaves the task (and its
    // folder), the task skips that site, and carries on without asking.
    if (choice == "self" && pause.kind == "collision") {
      this.release(task, pause.tabRef?.deref?.() ?? null);
      this.settle(task, "do");
      return true;
    }
    if (choice == "self") {
      pause.yours = true;
      this.updateCard(task, pause, "yours");
      notify(task);
      return true;
    }
    if (choice == "do") {
      task.approvals++;
    }
    this.settle(task, choice);
    return true;
  },

  /** Continue: after "I'll do it", or after sleep, quit, or a collision. */
  resume(id) {
    const task = tasks.get(id);
    if (!task?.pause) {
      return false;
    }
    this.settle(task, task.pause.yours ? "self" : "do");
    return true;
  },

  settle(task, choice) {
    const pause = task.pause;
    if (!pause) {
      return;
    }
    pause.cancelExpiry?.();
    pause.cancelExpiry = null;
    pause.choice = choice;
    for (const resolve of pause.waiters) {
      resolve(choice);
    }
    pause.waiters.clear();
    this.updateCard(task, pause, choice);
    if (ACTIVE.has(task.state)) {
      task.state = "running";
    }
    notify(task);
  },

  /** A decided pause, once its call has acted on the choice. */
  clearPause(task, pause = task.pause) {
    if (task.pause == pause) {
      task.pause = null;
    }
  },

  /**
   * Waits for the person. Resolves the choice, "stop", or "waiting" after
   * `holdMs` (an outside app's call returns before its client gives up).
   */
  wait(task, pause, { holdMs = 0 } = {}) {
    if (pause.choice) {
      return Promise.resolve(pause.choice);
    }
    if (!ACTIVE.has(task.state)) {
      return Promise.resolve("stop");
    }
    return new Promise(resolve => {
      let cancel = null;
      const done = value => {
        cancel?.();
        pause.waiters.delete(done);
        resolve(value);
      };
      pause.waiters.add(done);
      if (holdMs > 0) {
        cancel = timer(holdMs, () => done("waiting"));
      }
    });
  },

  allowed(task, kind, host) {
    return ALLOW_KINDS.has(kind) && task.allowed.has(`${kind}|${host}`);
  },

  /** One step for the run card and step list ({step: "retry", n} and tool calls). */
  step(task, entry) {
    task.steps.push({ t: Date.now(), ...entry });
    if (task.steps.length > 300) {
      task.steps.splice(0, task.steps.length - 300);
    }
    task.updated = Date.now();
    notify(task, "step");
  },

  addTab(task, tab) {
    task.tabs.add(tab);
    tab.setAttribute("whimsy-agent-task", task.id);
    notify(task);
  },

  /** The person keeps `tab`: it's theirs again, and off limits to this task. */
  release(task, tab) {
    if (!task || !tab) {
      return;
    }
    (task.released ??= new WeakSet()).add(tab);
    task.tabs.delete(tab);
    tab.removeAttribute("whimsy-agent-task");
    let host = "";
    try {
      host = tab.linkedBrowser?.currentURI?.host ?? "";
    } catch {}
    try {
      lazy.WhimsyTaskFolder.release(tab);
    } catch (e) {
      console.error("Whimsy: task folder release", e);
    }
    this.skipSite(task, host);
    notify(task, "released");
  },

  skipSite(task, host) {
    if (host && !task.skipped.includes(host)) {
      task.skipped.push(host);
      notify(task);
    }
  },

  /**
   * A page tried to give the agent instructions. Ignored; one notice per
   * site per task, repeats fold into it.
   */
  async notice(task, { kind = "injection", snippet = "", where = null }) {
    const host = hostOf(where?.url) || "";
    const key = `${kind}|${host}`;
    let notice = task.notices.get(key);
    if (notice) {
      notice.count++;
      if (snippet && !notice.snippets.includes(snippet) && notice.snippets.length < 5) {
        notice.snippets.push(snippet);
      }
    } else {
      notice = { kind, host, snippets: snippet ? [snippet] : [], count: 1, where, msgId: null, pending: null };
      task.notices.set(key, notice);
    }
    this.step(task, { step: "notice", kind, host });
    const fields = { snippets: notice.snippets.slice(), count: notice.count, where: notice.where, host };
    if (task.threadId) {
      notice.pending = (notice.pending ?? Promise.resolve()).then(async () => {
        if (notice.msgId) {
          await lazy.WhimsyAIStore.updateMessage(task.threadId, notice.msgId, fields);
        } else {
          notice.msgId = (await lazy.WhimsyAIStore.append(task.threadId,
            { role: "card", card: "agent-injection", taskId: task.id, ...fields })).id;
        }
      }).catch(e => console.error("Whimsy: injection notice", e));
      await notice.pending;
    }
    return notice;
  },

  // --- Thread cards ---

  card(task, fields) {
    if (!task.threadId) {
      return;
    }
    const pause = task.pause;
    lazy.WhimsyAIStore.append(task.threadId, { role: "card", taskId: task.id, ...fields })
      .then(msg => {
        if (pause && fields.pauseId == pause.id) {
          pause.msgId = msg.id;
          if (pause.choice) {
            this.updateCard(task, pause, pause.choice);
          }
        }
      })
      .catch(e => console.error("Whimsy: agent card", e));
  },

  updateCard(task, pause, state) {
    if (task.threadId && pause.msgId) {
      lazy.WhimsyAIStore.updateMessage(task.threadId, pause.msgId, { state, decided: Date.now() })
        .catch(e => console.error("Whimsy: agent card", e));
    }
  },

  // --- Quit: what was running shows in its thread on the next launch ---

  remember(task) {
    this.saveRunning().catch(e => console.error("Whimsy: agent tasks", e));
  },

  forget(task) {
    this.saveRunning().catch(e => console.error("Whimsy: agent tasks", e));
  },

  async saveRunning() {
    const running = this.list().filter(t => t.client == "whimsy" || t.threadId).map(t => ({
      id: t.id, client: t.client, clientName: t.clientName, threadId: t.threadId, title: t.title,
      step: t.steps.filter(s => s.tool).length,
    }));
    await lazy.WhimsyAIStore.writeDoc(RUNNING_DOC, running);
  },

  async reportInterrupted() {
    const left = await lazy.WhimsyAIStore.readDoc(RUNNING_DOC, []);
    if (!Array.isArray(left) || !left.length) {
      return;
    }
    await lazy.WhimsyAIStore.writeDoc(RUNNING_DOC, []);
    const l10n = new Localization(["branding/brand.ftl", "browser/whimsy.ftl"], true);
    for (const t of left) {
      if (t.threadId) {
        await lazy.WhimsyAIStore.append(t.threadId,
          { role: "card", card: "agent-interrupted", taskId: t.id, reason: "quit", step: t.step })
          .catch(() => {});
      }
      await lazy.WhimsyAIUpdates.post({
        id: `agent-quit-${t.id}`,
        source: "agent",
        title: l10n.formatValueSync("whimsy-agent-quit-update", { task: t.title || t.clientName || "" }),
        threadId: t.threadId ?? undefined,
        whileClosed: true,
      }).catch(() => {});
    }
  },

  // --- Tests ---

  _setTimerForTesting(fn) {
    const real = timer;
    timer = fn ?? real;
    return () => (timer = real);
  },

  _resetForTesting() {
    for (const task of this.list()) {
      this.stop(task.id);
    }
    tasks.clear();
    sessions.clear();
  },
};
