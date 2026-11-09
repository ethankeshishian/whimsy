/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// W23 agent-tabs: the Drive look. A tab an agent is using gets a soft
// terracotta edge glow over its page, a pointer that glides to what the agent
// is about to press, an outline on that target, and a working line under the
// tab's title that names the client ("Claude · Checking the total").
//
// Everything is drawn in the chrome, in a layer over the page's browser
// stack: the page can't see, move, or fake any of it, and nothing is added to
// the page's own document.

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  WhimsyAgentTasks: "resource:///modules/whimsy/WhimsyAgentTasks.sys.mjs",
  WhimsyChatAgent: "resource:///modules/whimsy/WhimsyChatAgent.sys.mjs",
});

const SHEET = "chrome://browser/content/whimsy/whimsy-agent.css";
const HTML_NS = "http://www.w3.org/1999/xhtml";
const TRAVEL_MS = 240;
const EASE = "cubic-bezier(0.075, 0.82, 0.165, 1)";

const sheets = new WeakSet();
// browser -> {x, y} where the pointer sits (page CSS pixels).
const spots = new WeakMap();

function reducedMotion(win) {
  return win.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function stackOf(browser) {
  return browser?.closest?.(".browserStack") ?? browser?.parentNode ?? null;
}

export const WhimsyAgentPointer = {
  SHEET,
  TRAVEL_MS,

  loadSheet(win) {
    if (win && !sheets.has(win)) {
      sheets.add(win);
      win.windowUtils.loadSheetUsingURIString(SHEET, win.windowUtils.AUTHOR_SHEET);
    }
  },

  /** The layer over a browser's page, made on first use. */
  layer(browser, create = true) {
    const stack = stackOf(browser);
    if (!stack) {
      return null;
    }
    let layer = stack.querySelector(":scope > .whimsy-agent-layer");
    if (!layer && create) {
      const doc = browser.ownerDocument;
      this.loadSheet(doc.documentGlobal);
      layer = doc.createElementNS(HTML_NS, "div");
      layer.className = "whimsy-agent-layer";
      layer.setAttribute("aria-hidden", "true");
      const glow = doc.createElementNS(HTML_NS, "div");
      glow.className = "whimsy-agent-glow";
      const target = doc.createElementNS(HTML_NS, "div");
      target.className = "whimsy-agent-target";
      target.hidden = true;
      const label = doc.createElementNS(HTML_NS, "span");
      label.className = "whimsy-agent-target-label";
      target.append(label);
      const pointer = doc.createElementNS(HTML_NS, "div");
      pointer.className = "whimsy-agent-pointer";
      pointer.hidden = true;
      layer.append(glow, target, pointer);
      stack.append(layer);
    }
    return layer;
  },

  // Page CSS pixels -> the layer's pixels (zoom, and the browser's offset in its stack).
  toLayer(browser, x, y) {
    const zoom = browser.fullZoom || 1;
    const b = browser.getBoundingClientRect();
    const s = stackOf(browser).getBoundingClientRect();
    return { x: b.left - s.left + x * zoom, y: b.top - s.top + y * zoom, zoom };
  },

  /** The glow on (tone "work" or "wait") or off. */
  glow(browser, on, { tone = "work" } = {}) {
    const layer = this.layer(browser, on);
    if (!layer) {
      return;
    }
    layer.toggleAttribute("glow", !!on);
    layer.setAttribute("tone", tone);
  },

  /**
   * Glides the pointer to (x, y) in the page's CSS pixels; resolves once it's
   * there, before the agent presses anything. Reduced motion: it jumps.
   */
  async moveTo(browser, { x, y, label = "" } = {}) {
    const layer = this.layer(browser);
    if (!layer || !Number.isFinite(x) || !Number.isFinite(y)) {
      return;
    }
    const win = browser.ownerDocument.documentGlobal;
    const pointer = layer.querySelector(".whimsy-agent-pointer");
    const to = this.toLayer(browser, x, y);
    const from = spots.get(browser);
    spots.set(browser, { x, y });
    pointer.dataset.label = label;
    pointer.style.translate = `${to.x}px ${to.y}px`;
    const wasHidden = pointer.hidden;
    pointer.hidden = false;
    if (wasHidden || !from || reducedMotion(win)) {
      return;
    }
    const start = this.toLayer(browser, from.x, from.y);
    const anim = pointer.animate(
      { translate: [`${start.x}px ${start.y}px`, `${to.x}px ${to.y}px`] },
      { duration: TRAVEL_MS, easing: EASE }
    );
    await anim.finished.catch(() => {});
  },

  /** Outlines the control about to be used (rect in page CSS pixels), or clears it. */
  target(browser, rect, label = "") {
    const layer = this.layer(browser, !!rect);
    const box = layer?.querySelector(".whimsy-agent-target");
    if (!box) {
      return;
    }
    if (!rect) {
      box.hidden = true;
      return;
    }
    const at = this.toLayer(browser, rect.x, rect.y);
    Object.assign(box.style, {
      left: `${at.x}px`,
      top: `${at.y}px`,
      width: `${rect.width * at.zoom}px`,
      height: `${rect.height * at.zoom}px`,
    });
    box.firstChild.textContent = label;
    box.hidden = false;
  },

  /** Takes the glow, pointer, and target off a page. */
  clear(browser) {
    spots.delete(browser);
    this.layer(browser, false)?.remove();
  },

  /**
   * The working line under a tab's title. `text` is what it's doing; null
   * removes the line. tone: "work" (terracotta), "wait" (amber), or "muted".
   */
  working(tab, text, { client = "", tone = "work" } = {}) {
    const container = tab?.querySelector(".tab-label-container");
    if (!container) {
      return;
    }
    let line = container.querySelector(":scope > .whimsy-agent-working");
    if (text == null) {
      line?.remove();
      tab.removeAttribute("whimsy-agent-working");
      return;
    }
    const doc = tab.ownerDocument;
    this.loadSheet(doc.documentGlobal);
    if (!line) {
      line = doc.createXULElement("label");
      line.className = "whimsy-agent-working";
      line.setAttribute("role", "presentation");
      line.setAttribute("crop", "end");
      container.append(line);
    }
    tab.setAttribute("whimsy-agent-working", tone);
    doc.l10n.setAttributes(line, "whimsy-agent-tabs-working", { client, doing: text });
  },

  /** The line for where a task is: doing, waiting on you, or yours. */
  lineFor(task) {
    const client = task.clientName || task.client || "";
    if (task.state == "paused" && task.pause && !task.pause.choice) {
      if (task.pause.yours) {
        return { client, tone: "muted", l10n: "whimsy-agent-tabs-yours" };
      }
      return { client, tone: "wait", l10n: task.pause.kind == "collision" ? "whimsy-agent-tabs-paused" : "whimsy-agent-tabs-needs-you" };
    }
    let doing = "";
    try {
      doing = lazy.WhimsyChatAgent.progressOf(task).text;
    } catch (e) {}
    return { client, tone: "work", doing };
  },

  /** Brings a tab's line and glow up to date with its task. */
  refreshTab(tab, task) {
    if (!tab.hasAttribute("whimsy-claude-active") || !task) {
      return;
    }
    const line = this.lineFor(task);
    const doc = tab.ownerDocument;
    this.working(tab, line.doing ?? "", { client: line.client, tone: line.tone });
    const label = tab.querySelector(".whimsy-agent-working");
    if (line.l10n && label) {
      doc.l10n.setAttributes(label, line.l10n, { client: line.client });
    } else if (!line.doing && label) {
      doc.l10n.setAttributes(label, "whimsy-agent-tabs-working-plain", { client: line.client });
    }
    if (task.mode == "drive" || tab.selected) {
      this.glow(tab.linkedBrowser, line.tone != "muted", { tone: line.tone });
    }
  },

  /** WhimsyClaude marks a tab in use: the Drive look comes on. */
  activate(tab, task) {
    this.refreshTab(tab, task);
    if (task && (task.mode == "drive" || tab.selected)) {
      this.glow(tab.linkedBrowser, !(task.pause?.yours), { tone: this.lineFor(task).tone });
    }
  },

  /** …and off again. */
  deactivate(tab) {
    this.working(tab, null);
    if (tab.linkedBrowser) {
      this.clear(tab.linkedBrowser);
    }
  },

  /** Every tab a task is using, after the task changed. */
  refreshTask(task) {
    for (const tab of task?.tabs ?? []) {
      if (!tab.closing && tab.isConnected) {
        this.refreshTab(tab, task);
      }
    }
  },

  observe(subject, topic, data) {
    const [, id] = String(data).split(":");
    const task = lazy.WhimsyAgentTasks.get(id);
    if (!task) {
      return;
    }
    if (!lazy.WhimsyAgentTasks.isActive(task)) {
      // Ended: the look goes with it.
      for (const tab of task.tabs) {
        this.deactivate(tab);
      }
      return;
    }
    this.refreshTask(task);
  },

  init() {
    if (!this._init) {
      this._init = true;
      Services.obs.addObserver(this, "whimsy-agent-tasks-changed");
    }
  },
};
