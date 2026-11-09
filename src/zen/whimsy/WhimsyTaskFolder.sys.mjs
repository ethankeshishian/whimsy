/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// W23 agent-tabs: the task folder (an unpinned-folder row, ai-task-folder).
// A Background task's tabs sit in their own folder at the end of the chat's
// space's Today tabs. It looks and opens like a Zen folder (Zen's own folder
// icon, tinted terracotta, with the agent's mark), shows what the agent is
// doing, and dissolves with Zap's dissolve when the task ends: tabs you keep
// stay where the folder was, as ordinary tabs; the rest leave as one group.
//
// Why a Whimsy header row and not Firefox's native tab-group (spike, W23):
// Zen turns tab groups off, a native group among unpinned tabs doesn't
// collapse or get Zen's folder look, SessionStore would save it as a group,
// the person could drop their own tabs into it, and its right-click opens
// Firefox's (disabled) tab-group menu. The row is plain chrome: it's never
// saved by session restore, so after a restart the tabs come back ordinary.
//
// While the task runs, its tabs are skipped by Ctrl+Tab (WhimsyCtrlTab), and
// a click or key press in one of them pauses the task ("you win"): chat
// opens on the pause card and focus stays in the page.

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  WhimsyAgentPointer: "resource:///modules/whimsy/WhimsyAgentPointer.sys.mjs",
  WhimsyAgentTasks: "resource:///modules/whimsy/WhimsyAgentTasks.sys.mjs",
  WhimsyChat: "resource:///modules/whimsy/WhimsyChat.sys.mjs",
  WhimsyChatAgent: "resource:///modules/whimsy/WhimsyChatAgent.sys.mjs",
  WhimsyClaude: "resource:///modules/whimsy/WhimsyClaude.sys.mjs",
  WhimsyCommands: "resource:///modules/whimsy/WhimsyCommands.sys.mjs",
});

const FEATURE_PREF = "whimsy.feature.ai-task-folder";
const HTML_NS = "http://www.w3.org/1999/xhtml";
const MEMBER = "whimsy-task-tab";
const OWNER = "whimsy-task-folder-id";
const COLLAPSED = "whimsy-task-collapsed";
const OPENED = "whimsy-agent-opened";
const ICON = "chrome://browser/content/whimsy/icons/task-folder.svg";
const SLIDE_MS = 240;
const FADE_MS = 150;
const EASE = "cubic-bezier(0.075, 0.82, 0.165, 1)";
const QUIET_KEYS = new Set(["Shift", "Control", "Alt", "Meta", "CapsLock", "Fn", "OS"]);

// win -> Map(taskId -> folder row)
const folders = new WeakMap();
const windows = new WeakSet();
let initialized = false;
// Set while this module moves tabs itself (its own TabMove events).
let arranging = 0;
let dissolveClock = null;

function reducedMotion(win) {
  return win.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function foldersOf(win, create = false) {
  let map = folders.get(win);
  if (!map && create) {
    map = new Map();
    folders.set(win, map);
  }
  return map ?? new Map();
}

function isTab(el) {
  return el?.localName == "tab" && el.classList.contains("tabbrowser-tab");
}

function membersOf(folder) {
  return [...folder._tabs].filter(t => t.isConnected && !t.closing).sort((a, b) => a._tPos - b._tPos);
}

export const WhimsyTaskFolder = {
  FEATURE_PREF,

  get enabled() {
    return Services.prefs.getBoolPref(FEATURE_PREF, true);
  },

  init() {
    if (!initialized) {
      initialized = true;
      Services.obs.addObserver(this, lazy.WhimsyAgentTasks.TOPIC);
    }
  },

  initWindow(win) {
    if (!this.enabled || !win.gBrowser || windows.has(win)) {
      return;
    }
    windows.add(win);
    this.init();
    const tabs = win.gBrowser.tabContainer;
    const onTab = event => this.onTabEvent(win, event);
    for (const type of ["TabOpen", "TabMove", "TabClose", "TabSelect", "TabPinned"]) {
      tabs.addEventListener(type, onTab);
    }
    // You win: a click or key press in an agent's tab pauses its task.
    const onInput = event => this.onInput(win, event);
    win.addEventListener("mousedown", onInput, true);
    win.addEventListener("keydown", onInput, true);
    lazy.WhimsyCommands.register(win, {
      id: "cmd_whimsyTaskFolderToggle",
      l10nId: "whimsy-agent-tabs-cmd-folder",
      icon: ICON,
      isAvailable: () => !!this.folderInSpace(win),
      run: () => {
        const folder = this.folderInSpace(win);
        if (folder) {
          this.setCollapsed(folder, !folder.hasAttribute("collapsed"));
        }
      },
    });
  },

  /** The folder in the space you're in, if a task has one there. */
  folderInSpace(win) {
    const strip = win.gZenWorkspaces?.activeWorkspaceStrip ?? null;
    return [...foldersOf(win).values()].find(f => f.isConnected && !f.hidden && (!strip || strip.contains(f))) ?? null;
  },

  folderOf(tab) {
    const id = tab?.getAttribute(OWNER);
    return id ? foldersOf(tab.documentGlobal).get(id) ?? null : null;
  },

  foldersFor(task) {
    const out = [];
    for (const win of Services.wm.getEnumerator("navigator:browser")) {
      const folder = foldersOf(win).get(task.id);
      if (folder) {
        out.push(folder);
      }
    }
    return out;
  },

  // Where the space's Today (unpinned) tabs live.
  containerFor(win, task) {
    const spaces = win.gZenWorkspaces;
    const id = task.spaceId ?? spaces?.activeWorkspace;
    return (id && spaces?.workspaceElement?.(id)?.tabsContainer) || win.gBrowser.tabContainer.arrowScrollbox;
  },

  /** The folder row for a task in a window, made at the end of the space's Today tabs. */
  create(win, task) {
    const map = foldersOf(win, true);
    let folder = map.get(task.id);
    if (folder?.isConnected) {
      return folder;
    }
    const doc = win.document;
    lazy.WhimsyAgentPointer.loadSheet(win);
    folder = doc.createXULElement("hbox");
    folder.className = "whimsy-task-folder";
    folder.setAttribute("role", "button");
    folder.setAttribute("tabindex", "0");
    folder.setAttribute("collapsed", "");
    folder.setAttribute("aria-expanded", "false");
    folder.dataset.taskId = task.id;
    folder._tabs = new Set();
    folder._task = task;

    const icon = doc.createElementNS(HTML_NS, "span");
    icon.className = "whimsy-task-folder-icon";
    const raw = win.customElements.get("zen-folder")?.rawIcon;
    if (raw) {
      icon.append(raw.cloneNode(true));
    }
    const mark = doc.createElementNS(HTML_NS, "span");
    mark.className = "whimsy-task-folder-mark";
    icon.append(mark);

    const text = doc.createElementNS(HTML_NS, "span");
    text.className = "whimsy-task-folder-text";
    const title = doc.createElementNS(HTML_NS, "span");
    title.className = "whimsy-task-folder-title";
    const line = doc.createElementNS(HTML_NS, "span");
    line.className = "whimsy-agent-working";
    const lineText = doc.createElementNS(HTML_NS, "span");
    line.append(lineText);
    text.append(title, line);

    const count = doc.createElementNS(HTML_NS, "span");
    count.className = "whimsy-task-folder-count";
    count.setAttribute("aria-hidden", "true");
    const twisty = doc.createElementNS(HTML_NS, "span");
    twisty.className = "whimsy-task-folder-twisty";
    folder.append(icon, text, count, twisty);

    folder.addEventListener("click", event => {
      if (event.button == 0) {
        this.setCollapsed(folder, !folder.hasAttribute("collapsed"));
      }
    });
    folder.addEventListener("keydown", event => {
      if (event.key == "Enter" || event.key == " ") {
        event.preventDefault();
        this.setCollapsed(folder, !folder.hasAttribute("collapsed"));
      }
    });

    // At the end of the Today tabs: after the last ordinary tab.
    const container = this.containerFor(win, task);
    const last = [...container.children].filter(isTab).at(-1);
    if (last) {
      last.after(folder);
    } else {
      container.prepend(folder);
    }
    map.set(task.id, folder);
    this.refreshFolder(folder);
    if (!reducedMotion(win)) {
      folder.animate({ height: ["0px", "44px"], opacity: [0, 1] }, { duration: SLIDE_MS, easing: EASE });
    }
    return folder;
  },

  /** A tab a Background task opened joins its folder. */
  adopt(task, tab) {
    if (!this.enabled || !tab?.isConnected) {
      return null;
    }
    const folder = this.create(tab.documentGlobal, task);
    this.add(folder, tab);
    return folder;
  },

  add(folder, tab) {
    if (!folder || !tab || tab.pinned) {
      return;
    }
    folder._tabs.add(tab);
    tab.setAttribute(MEMBER, "");
    tab.setAttribute(OWNER, folder.dataset.taskId);
    tab.toggleAttribute(COLLAPSED, folder.hasAttribute("collapsed"));
    this.arrange(folder);
    this.refreshFolder(folder);
  },

  /**
   * Keeps the folder whole and last: the row sits right before its tabs,
   * which stay together, and a tab of yours that lands below it moves above.
   */
  arrange(folder) {
    const win = folder.ownerDocument.documentGlobal;
    const gBrowser = win.gBrowser;
    arranging++;
    try {
      const members = membersOf(folder);
      for (let i = 1; i < members.length; i++) {
        if (members[i].previousElementSibling != members[i - 1]) {
          gBrowser.moveTabAfter(members[i], members[i - 1]);
        }
      }
      const first = members[0];
      if (!first) {
        return;
      }
      const last = members.at(-1);
      // Yours, after the folder: above it.
      let next = last.nextElementSibling;
      while (next) {
        const after = next.nextElementSibling;
        if (isTab(next) && !next.hasAttribute(MEMBER) && !next.pinned) {
          gBrowser.moveTabBefore(next, first);
        }
        next = after;
      }
      if (first.previousElementSibling != folder) {
        first.before(folder);
      }
    } finally {
      arranging--;
    }
  },

  /** A tab leaves its folder and is an ordinary tab, just above the folder. */
  release(tab) {
    const folder = this.folderOf(tab);
    tab.removeAttribute(MEMBER);
    tab.removeAttribute(OWNER);
    tab.removeAttribute(COLLAPSED);
    if (!folder) {
      return;
    }
    folder._tabs.delete(tab);
    const members = membersOf(folder);
    if (members.length && tab.isConnected && !tab.closing && tab._tPos > members[0]._tPos) {
      arranging++;
      try {
        tab.documentGlobal.gBrowser.moveTabBefore(tab, members[0]);
      } finally {
        arranging--;
      }
    }
    this.arrange(folder);
    this.refreshFolder(folder);
  },

  setCollapsed(folder, collapsed) {
    folder.toggleAttribute("collapsed", collapsed);
    folder.setAttribute("aria-expanded", String(!collapsed));
    folder.querySelector(".whimsy-task-folder-icon > svg")?.setAttribute("state", collapsed ? "close" : "open");
    for (const tab of folder._tabs) {
      tab.toggleAttribute(COLLAPSED, collapsed);
    }
  },

  /** Title, the working line (amber when it needs you), and the count. */
  refreshFolder(folder) {
    const task = lazy.WhimsyAgentTasks.get(folder.dataset.taskId) ?? folder._task;
    const doc = folder.ownerDocument;
    const count = membersOf(folder).length;
    folder.hidden = !count;
    folder.querySelector(".whimsy-task-folder-title").textContent = task?.title || task?.clientName || "";
    folder.querySelector(".whimsy-task-folder-count").textContent = String(count);
    doc.l10n.setAttributes(folder, "whimsy-agent-tabs-folder", { title: task?.title || task?.clientName || "", count });
    if (!task) {
      return;
    }
    const line = lazy.WhimsyAgentPointer.lineFor(task);
    folder.setAttribute("whimsy-agent-working", line.tone);
    const text = folder.querySelector(".whimsy-agent-working > span");
    if (line.l10n) {
      doc.l10n.setAttributes(text, line.l10n, { client: line.client });
    } else if (line.doing) {
      doc.l10n.setAttributes(text, "whimsy-agent-tabs-working", { client: line.client, doing: line.doing });
    } else {
      doc.l10n.setAttributes(text, "whimsy-agent-tabs-working-plain", { client: line.client });
    }
  },

  refresh(task) {
    for (const folder of this.foldersFor(task)) {
      this.refreshFolder(folder);
    }
  },

  /**
   * The task ended. Tabs not in `archive` stay, ordinary, where the folder
   * was; the archived ones leave as one group; the row dissolves. Returns the
   * archived tabs that weren't in a folder (the caller archives those).
   */
  end(task, { archive = [] } = {}) {
    const rest = new Set(archive);
    for (const folder of this.foldersFor(task)) {
      const keep = membersOf(folder).filter(t => !rest.has(t));
      for (const tab of folder._tabs) {
        rest.delete(tab);
      }
      this.dissolve(folder, { keep, archive: membersOf(folder).filter(t => archive.includes(t)) });
    }
    return [...rest];
  },

  /**
   * Dissolves the folder: `keep` become ordinary tabs in place (with the
   * agent's mark until you use them), the rest of its tabs are archived, and
   * the row goes with Zap's dissolve. Resolves when it's gone.
   */
  async dissolve(folder, { keep = [], archive = null } = {}) {
    if (!folder?.isConnected || folder._dissolving) {
      return;
    }
    folder._dissolving = true;
    const win = folder.ownerDocument.documentGlobal;
    const kept = new Set(keep);
    const members = membersOf(folder);
    const leaving = archive ?? members.filter(t => !kept.has(t));
    foldersOf(win).delete(folder.dataset.taskId);
    for (const tab of members) {
      tab.removeAttribute(MEMBER);
      tab.removeAttribute(OWNER);
      tab.removeAttribute(COLLAPSED);
    }
    folder._tabs.clear();
    const staying = members.filter(t => !leaving.includes(t));
    for (const tab of staying) {
      if (!tab.selected) {
        tab.setAttribute(OPENED, "");
      }
    }
    const gone = this.dissolveRow(folder);
    if (leaving.length) {
      win.gBrowser.removeTabs(leaving, { animate: true, skipPermitUnload: true });
    }
    if (staying.length) {
      this.movedToast(win, folder._task, staying);
    }
    await gone;
  },

  // Zap's dissolve on the row (particles from its own pixels). Reduced
  // motion, Zap's dust turned off, or no WebGL (blocklisted GPU, lost
  // context): a plain 150ms fade, so the folder still leaves cleanly.
  // The row's `dissolving` attribute says which ("zap" or "fade").
  async dissolveRow(folder) {
    const win = folder.ownerDocument.documentGlobal;
    try {
      if (folder.hidden) {
        return;
      }
      const rect = folder.getBoundingClientRect();
      if (!rect.width || !rect.height) {
        return;
      }
      const dust = !reducedMotion(win) && Services.prefs.getBoolPref("zen.boosts.dissolve-on-zap", true);
      if (!dust || !(await this.zap(win, folder))) {
        await this.fade(folder);
      }
    } finally {
      folder.remove();
    }
  },

  async fade(folder) {
    if (!folder.isConnected || folder.style.getPropertyValue("opacity") == "0") {
      return;
    }
    folder.setAttribute("dissolving", "fade");
    await folder.animate({ opacity: [1, 0] }, { duration: FADE_MS, fill: "forwards" }).finished.catch(() => {});
  },

  // Runs Zap's dissolve; false (nothing shown yet) when WebGL can't.
  async zap(win, folder) {
    let fx = null;
    let started = false;
    try {
      const { ZapDissolve } = ChromeUtils.importESModule("resource:///modules/zen/boosts/ZenZapDissolve.sys.mjs");
      fx = new ZapDissolve(win.document);
      await fx.initialize();
      // Asking the canvas again returns the context Zap made, or null if
      // it couldn't make one.
      const gl = fx.getElementById("zen-zap-dissolve-canvas")?.getContext("webgl");
      const rect = folder.getBoundingClientRect();
      if (!gl || gl.isContextLost() || !folder.isConnected || !rect.width || !rect.height) {
        return false;
      }
      await new Promise((resolve, reject) => {
        // Never wait past the shader's 1.4s by much, whatever happens.
        const safety = win.setTimeout(resolve, dissolveClock ? 60000 : 2500);
        const lost = () => {
          win.clearTimeout(safety);
          reject(new Error("WebGL context lost"));
        };
        gl.canvas.addEventListener("webglcontextlost", lost, { once: true });
        fx.dissolve(folder, () => {
          win.clearTimeout(safety);
          gl.canvas.removeEventListener("webglcontextlost", lost);
          resolve();
        });
        if (dissolveClock) {
          // Tests hold the particles at an exact frame (whimsyShotMid can't:
          // it's a rAF-driven shader, not a Web Animation). The first frame
          // ran on the real clock at this tick's time; later ones get
          // that time plus the elapsed time the test asks for.
          let base = null;
          fx.window = {
            innerWidth: win.innerWidth,
            innerHeight: win.innerHeight,
            requestAnimationFrame: f => {
              base ??= win.document.timeline.currentTime;
              return win.requestAnimationFrame(() => f(base + dissolveClock()));
            },
            cancelAnimationFrame: id => win.cancelAnimationFrame(id),
          };
        }
        folder.setAttribute("dissolving", "zap");
        folder.style.setProperty("opacity", "0", "important");
        started = true;
      });
      return true;
    } catch (e) {
      console.error("Whimsy: task folder dissolve", e);
      return started;
    } finally {
      // Zap's own tearDown loses the context on purpose ("WebGL context
      // was lost" in the console is it letting go, not a failure).
      fx?.tearDown();
    }
  },

  // "Moved 2 tabs to Travel" with Undo, which archives them again.
  movedToast(win, task, tabs) {
    const toasts = win.gZenUIManager?.toasts;
    if (!toasts) {
      return;
    }
    const spaces = win.gZenWorkspaces;
    const space = spaces?.getWorkspaces?.().find(ws => ws.uuid == (task?.spaceId ?? spaces.activeWorkspace));
    try {
      toasts.open("whimsy-agent-tabs-moved", {
        key: `whimsy-agent-moved-${task?.id ?? ""}`,
        l10nArgs: { count: tabs.length, space: space?.name ?? "" },
        ...(task?.title && { description: task.title }),
        buttons: [{
          id: "whimsy-agent-tabs-undo",
          l10nId: "whimsy-agent-tabs-undo",
          command: () => {
            const live = tabs.filter(t => t.isConnected && !t.closing);
            if (live.length) {
              win.gBrowser.removeTabs(live, { animate: true, skipPermitUnload: true });
            }
          },
        }],
      });
    } catch (e) {
      console.error("Whimsy: moved toast", e);
    }
  },

  onTabEvent(win, event) {
    const tab = event.target;
    switch (event.type) {
      case "TabSelect":
        // Used: the agent's mark goes.
        tab.removeAttribute(OPENED);
        return;
      case "TabClose": {
        const folder = this.folderOf(tab);
        if (folder) {
          folder._tabs.delete(tab);
          this.refreshFolder(folder);
        }
        return;
      }
      case "TabPinned":
        if (this.folderOf(tab)) {
          this.releaseByPerson(tab);
        }
        return;
    }
    if (arranging) {
      return;
    }
    const map = foldersOf(win);
    if (!map.size) {
      return;
    }
    const folder = this.folderOf(tab);
    if (event.type == "TabMove" && folder) {
      // Dragged out of the folder (or to another space): it's yours.
      const prev = tab.previousElementSibling;
      const inside = prev == folder || (prev?.getAttribute?.(OWNER) == folder.dataset.taskId);
      if (!inside || !folder.parentNode?.contains(tab)) {
        this.releaseByPerson(tab);
      }
      return;
    }
    // Yours landed in or after a folder: it goes above it. A new tab waits
    // a moment, in case it's the task's own (it joins the folder first).
    const settle = () => {
      if (tab.hasAttribute(MEMBER) || !tab.isConnected) {
        return;
      }
      for (const f of map.values()) {
        if (f.isConnected && f.parentNode == tab.parentNode && f.compareDocumentPosition(tab) & f.DOCUMENT_POSITION_FOLLOWING) {
          this.arrange(f);
        }
      }
    };
    if (event.type == "TabOpen") {
      Promise.resolve().then(settle);
    } else {
      settle();
    }
  },

  // The person took a tab out of the folder (dragged, pinned): the task
  // leaves it alone from here on.
  releaseByPerson(tab) {
    const task = lazy.WhimsyAgentTasks.get(tab.getAttribute(OWNER) ?? "");
    if (task) {
      lazy.WhimsyAgentTasks.release(task, tab);
    } else {
      this.release(tab);
    }
  },

  /**
   * A click or key press in a tab a running task is using pauses the whole
   * task. The event still lands; chat opens on the pause card; focus stays
   * in the page.
   */
  onInput(win, event) {
    const browser = event.target;
    if (browser?.localName != "browser" || !event.isTrusted) {
      return;
    }
    if (event.type == "keydown" && (QUIET_KEYS.has(event.key) || event.metaKey || event.ctrlKey || event.altKey)) {
      return;
    }
    const tab = win.gBrowser.getTabForBrowser(browser);
    const task = lazy.WhimsyAgentTasks.get(tab?.getAttribute("whimsy-agent-task") ?? "");
    if (!task || task.state != "running" || !task.tabs.has(tab)) {
      return;
    }
    this.collide(win, task, tab);
  },

  collide(win, task, tab) {
    let host = "";
    try {
      host = tab.linkedBrowser.currentURI.host;
    } catch {}
    const pause = lazy.WhimsyAgentTasks.pause(task.id, {
      kind: "collision",
      host,
      tabId: lazy.WhimsyClaude.tabId(tab),
      tabRef: new WeakRef(tab),
      preview: { title: tab.label, host },
    });
    if (!pause || !task.threadId) {
      return pause;
    }
    // Chat slides open on the pause (switching chats if needed); the page
    // keeps focus, so what you were doing carries on.
    Promise.resolve(lazy.WhimsyChat.open(win, { threadId: task.threadId, focus: "none" }))
      .then(() => lazy.WhimsyChatAgent.clearNeedsYou(task))
      .catch(e => console.error("Whimsy: collision chat", e));
    return pause;
  },

  observe(subject, topic, data) {
    const [what, id] = String(data).split(":");
    const task = lazy.WhimsyAgentTasks.get(id);
    if (!task) {
      return;
    }
    if (what == "stopped" || what == "done") {
      // Ended some other way (Stop, an outside app): nothing's thrown away.
      for (const folder of this.foldersFor(task)) {
        this.dissolve(folder, { keep: membersOf(folder) });
      }
      return;
    }
    this.refresh(task);
  },

  /**
   * Tests: dissolve frames on a held clock. `elapsed()` returns the ms into
   * the 1.4s dissolve to draw; null puts the real clock back.
   */
  _setDissolveClockForTesting(clock) {
    dissolveClock = clock;
  },
};
