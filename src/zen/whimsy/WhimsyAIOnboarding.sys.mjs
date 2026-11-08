/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// W23: onboarding's AI steps (01-onboarding). After "Block ads and
// trackers?": "Want a little AI help?" (Apple Intelligence when this Mac
// has it, Claude, ChatGPT), then "Connect your stuff?" (only when a
// provider connected), then "You're all set" once, when the AI steps end
// with a service connected. Each card has its own Connect; one sign-in at a
// time (the others dim, Cancel stops the busy one, and Continue cancels it
// and keeps the rest). Failures are one line on their card.

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  CATALOG: "resource:///modules/whimsy/WhimsyConnectors.sys.mjs",
  STEPS: "resource:///modules/whimsy/WhimsyClaudeCodeInstall.sys.mjs",
  WhimsyAIClaudeCode: "resource:///modules/whimsy/WhimsyAIClaudeCode.sys.mjs",
  WhimsyAIProviders: "resource:///modules/whimsy/WhimsyAIProviders.sys.mjs",
  WhimsyClaudeCodeInstall: "resource:///modules/whimsy/WhimsyClaudeCodeInstall.sys.mjs",
  WhimsyConnectorOAuth: "resource:///modules/whimsy/WhimsyConnectorOAuth.sys.mjs",
  WhimsyConnectors: "resource:///modules/whimsy/WhimsyConnectors.sys.mjs",
  WhimsyNextMeeting: "resource:///modules/whimsy/WhimsyNextMeeting.sys.mjs",
});

const styled = new WeakSet();
const SHEET = "chrome://browser/content/whimsy/whimsy-ai-onboarding.css";
const ICONS = "chrome://browser/content/whimsy/icons/";
const CHECK = "chrome://global/skin/icons/check-filled.svg";
const ALERT = "chrome://global/skin/icons/warning.svg";
const HTML = "http://www.w3.org/1999/xhtml";
const CELEBRATED_PREF = "whimsy.ai.onboarding.celebrated";
const CLAUDE_CODE_URL = "https://code.claude.com/docs/en/setup";
const EXIT = "cubic-bezier(0.4, 0, 1, 1)";
const SPRING = "cubic-bezier(0.34, 1.56, 0.64, 1)";
const TEXT_SPRING = "cubic-bezier(0.34, 1.3, 0.64, 1)";

const PROVIDERS = {
  apple: { logo: "chrome://browser/content/whimsy/ai/apple-intelligence.svg", action: "whimsy-onb-turn-on", done: "whimsy-onb-on" },
  claude: { logo: `${ICONS}claude.svg`, action: "whimsy-onb-connect", done: "whimsy-onb-connected" },
  openai: { logo: `${ICONS}openai.svg`, action: "whimsy-onb-connect", done: "whimsy-onb-connected" },
};
const CONNECTORS = {
  google: { marks: ["gmail", "google-calendar", "google-drive"] },
  microsoft: { marks: ["outlook", "onedrive"] },
  "apple-calendar": { action: "whimsy-onb-allow" },
  granola: {},
  linear: {},
  jira: {},
};
// x, y from the centre of the marks, size, delay, accent (onb-5.1).
const SPARKS = [
  [-300, -60, 26, 0, 0], [-225, -150, 18, 60, 1], [-390, 30, 14, 140, 1], [-340, 120, 20, 90, 0],
  [300, -80, 24, 30, 1], [235, -160, 16, 120, 0], [390, 10, 18, 80, 0], [350, 130, 14, 160, 1],
  [-80, -175, 14, 40, 0], [95, -185, 20, 100, 1], [-150, -120, 10, 180, 1], [160, -125, 12, 20, 0],
];

function reduced(win) {
  return win.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export const WhimsyAIOnboarding = {
  session: null,
  // Tests set this to make every animation finish at once.
  instant: false,

  get enabled() {
    return Services.prefs.getBoolPref("whimsy.feature.ai-onboarding", true);
  },

  get connectorsOn() {
    return Services.prefs.getBoolPref("whimsy.feature.ai-connectors", true);
  },

  /** Zen's page objects for the AI steps, spliced after "block-ads". */
  pages(win, helpers = {}) {
    this.session = { win, providers: new Set(), services: new Set(), busy: null, helpers };
    return [this._providersPage(win), this._connectPage(win)];
  },

  _el(doc, tag, className, parent, l10nId, args) {
    const node = doc.createElementNS(HTML, tag);
    if (className) {
      node.className = className;
    }
    if (l10nId) {
      doc.l10n.setAttributes(node, l10nId, args);
    }
    parent?.append(node);
    return node;
  },

  _sheet(win) {
    if (!styled.has(win)) {
      styled.add(win);
      win.windowUtils.loadSheetUsingURIString(SHEET, win.windowUtils.AUTHOR_SHEET);
    }
  },

  // ---- one card ----

  _card(doc, parent, { id, logo, nameL10n, detailL10n, action, marks = [] }, onAction) {
    const card = this._el(doc, "div", "whimsy-onb-card", parent);
    card.dataset.id = id;
    card.dataset.state = "idle";
    const tile = this._el(doc, "span", "whimsy-onb-logo", card);
    const img = this._el(doc, "img", "", tile);
    img.src = logo;
    img.alt = "";
    const body = this._el(doc, "span", "whimsy-onb-body", card);
    const name = this._el(doc, "span", "whimsy-onb-name", body, nameL10n);
    if (marks.length) {
      const box = this._el(doc, "span", "whimsy-onb-marks", body);
      for (const m of marks) {
        const mark = this._el(doc, "img", "", box);
        mark.src = `${ICONS}${m}.svg`;
        mark.alt = "";
      }
      name.after(box);
      const wrap = this._el(doc, "span", "", null);
      body.prepend(wrap);
      wrap.append(name, box);
    }
    const detail = this._el(doc, "span", "whimsy-onb-detail", body, detailL10n);
    const trail = this._el(doc, "span", "whimsy-onb-trail", card);
    const ui = {
      card,
      detail,
      defaultDetail: detailL10n,
      set: ({ state, status = null, tone = null, detailL10n: d = null, detailArgs, note = null, noteTone = null, actions = [], progress = null, cancel = null, button = null }) => {
        const wasState = card.dataset.state;
        card.dataset.state = state;
        doc.l10n.setAttributes(detail, d ?? ui.defaultDetail, detailArgs);
        // One tick later: rebuilding the trail here, synchronously, would
        // detach a button that's still mid-click (its own click handler is
        // what called set()), which fails the a11y check on that node.
        // queueMicrotask isn't a global in this module's scope; a resolved
        // Promise's .then() is the same microtask queue.
        Promise.resolve().then(() => {
          trail.replaceChildren();
          if (status) {
            const s = this._el(doc, "span", "whimsy-onb-status", trail);
            s.dataset.tone = tone;
            s.setAttribute("role", "status");
            if (tone == "busy") {
              this._el(doc, "span", "whimsy-onb-spinner", s);
            } else if (tone == "pass" || tone == "fail") {
              const icon = this._el(doc, "img", "", s);
              icon.src = tone == "pass" ? CHECK : ALERT;
              icon.alt = "";
              if (tone == "pass" && wasState != "done" && !reduced(doc.defaultView) && !this.instant) {
                ui.pop = icon.animate({ scale: [0.6, 1], opacity: [0, 1] }, { duration: 350, easing: SPRING });
              }
            }
            this._el(doc, "span", "", s, status);
          }
          if (cancel) {
            const c = this._el(doc, "button", "whimsy-onb-action is-quiet", trail, "whimsy-onb-cancel");
            c.dataset.action = "cancel";
            c.addEventListener("click", cancel);
          }
          if (button) {
            const b = this._el(doc, "button", "whimsy-onb-action", trail, button);
            b.dataset.action = "connect";
            b.addEventListener("click", () => onAction());
          }
          card.querySelector(".whimsy-onb-note")?.remove();
          if (note) {
            const outer = this._el(doc, "div", "whimsy-onb-note", card);
            outer.dataset.tone = noteTone ?? "fail";
            const inner = this._el(doc, "div", "", outer);
            if (progress != null) {
              const bar = this._el(doc, "span", "whimsy-onb-progress", inner);
              bar.style.setProperty("--p", `${Math.round(progress * 100)}%`);
              this._el(doc, "i", "", bar);
            }
            this._el(doc, "span", "", inner, note);
            if (actions.length) {
              const box = this._el(doc, "span", "whimsy-onb-note-actions", inner);
              for (const [l10nId, run, accent] of actions) {
                const b = this._el(doc, "button", `whimsy-onb-note-btn${accent ? " is-accent" : ""}`, box, l10nId);
                b.addEventListener("click", run);
              }
            }
            if (wasState != state && !reduced(doc.defaultView) && !this.instant) {
              ui.unfold = outer.animate({ gridTemplateRows: ["0fr", "1fr"], opacity: [0, 1] }, { duration: 300, easing: "cubic-bezier(0.34, 1.2, 0.64, 1)" });
            }
          }
        });
      },
    };
    ui.set({ state: "idle", button: action });
    return ui;
  },

  // One sign-in at a time: the other cards' buttons fade while one runs.
  _dim(content, busyId) {
    for (const card of content.querySelectorAll(".whimsy-onb-card")) {
      for (const b of card.querySelectorAll('[data-action="connect"]')) {
        b.disabled = !!busyId && card.dataset.id != busyId;
      }
    }
    for (const link of content.querySelectorAll(".whimsy-onb-link")) {
      link.disabled = !!busyId;
    }
  },

  // The bottom button: Skip for now until something connects, then
  // Continue; the line above it says what's ready.
  _bottom(doc, connected, l10n) {
    const s = this.session;
    const button = doc.querySelector("#zen-welcome-page-sidebar-buttons > button");
    if (button) {
      doc.l10n.setAttributes(button, connected.length ? "whimsy-onb-continue" : "whimsy-onb-skip");
      button.classList.toggle("primary", !!connected.length);
      button.classList.toggle("whimsy-onb-quiet", !connected.length);
    }
    let line = doc.getElementById("whimsy-onb-status");
    if (!line) {
      const buttons = doc.getElementById("zen-welcome-page-sidebar-buttons");
      line = this._el(doc, "div", "", null);
      line.id = "whimsy-onb-status";
      buttons?.before(line);
    }
    line.replaceChildren();
    if (connected.length) {
      const icon = this._el(doc, "img", "", line);
      icon.src = CHECK;
      icon.alt = "";
      const [id, args] = l10n(connected);
      this._el(doc, "span", "", line, id, args);
      if (!s.lineShown && !this.instant && !reduced(doc.defaultView)) {
        line.animate({ opacity: [0, 1] }, { duration: 150 });
      }
      s.lineShown = true;
    }
  },

  _leave(doc) {
    this.cancelBusy();
    doc.getElementById("whimsy-onb-status")?.remove();
    doc.querySelector(".whimsy-onb-sheet")?.remove();
    if (this.session) {
      this.session.lineShown = false;
    }
  },

  cancelBusy() {
    const busy = this.session?.busy;
    if (busy) {
      busy.cancelled = true;
      busy.cancel?.();
    }
  },

  // ---- screen 1: providers ----

  async appleAvailable() {
    try {
      const status = await lazy.WhimsyAIProviders.appleStatus({ build: false });
      return !["unavailable", "apple-unavailable-os"].includes(status);
    } catch {
      return false;
    }
  },

  /** Connects one provider; tests replace this. */
  async connectProvider(win, id, pending, onProgress) {
    const P = lazy.WhimsyAIProviders;
    if (id == "apple") {
      const status = await P.appleStatus({ build: true });
      if (status != "available") {
        throw Object.assign(new Error(status), { code: "apple-failed" });
      }
      P.appleConnected();
      return;
    }
    if (id == "claude") {
      const auth = await lazy.WhimsyAIClaudeCode._authStatus({ fresh: true }).catch(() => ({ installed: false }));
      if (!auth.installed) {
        const controller = new AbortController();
        pending.cancel = () => controller.abort();
        onProgress("install", 0);
        const steps = lazy.STEPS.length;
        let done = 0;
        try {
          await lazy.WhimsyClaudeCodeInstall.install({ signal: controller.signal, onStep: () => onProgress("install", ++done / steps) });
        } catch (e) {
          throw Object.assign(e, { code: pending.cancelled ? "cancelled" : "install-failed" });
        }
        if (pending.cancelled) {
          throw Object.assign(new Error("cancelled"), { code: "cancelled" });
        }
      }
      onProgress("sign-in");
      pending.cancel = () => lazy.WhimsyAIClaudeCode.cancel();
    } else {
      onProgress("sign-in");
      pending.cancel = () => P.cancelPlan?.(id);
    }
    await P.connectPlan(win, id);
  },

  _providersPage(win) {
    const self = this;
    return {
      id: "whimsy-ai-providers",
      title: "whimsy-onb-ai-title",
      descriptions: ["whimsy-onb-ai-text", "whimsy-onb-ai-private"],
      buttons: [{ l10n: "whimsy-onb-skip", onclick: pages => self._continue(pages, 1) }],
      skip() {
        return !self.enabled;
      },
      leave() {
        self._leave(win.document);
      },
      async render(content) {
        self._sheet(win);
        const doc = win.document;
        const ids = (await self.appleAvailable()) ? ["apple", "claude", "openai"] : ["claude", "openai"];
        if (!content.isConnected && content.parentNode) {
          return;
        }
        const cards = new Map();
        const s = self.session ?? (self.session = { win, providers: new Set(), services: new Set() });
        const refresh = () => {
          const ready = ids.filter(id => s.providers.has(id));
          self._bottom(doc, ready, list =>
            list.length == ids.length && ids.length == 3 ? ["whimsy-onb-ready-all"] :
            list.length == 1 ? ["whimsy-onb-ready-one", { name: PROVIDER_NAMES[list[0]] }] : ["whimsy-onb-ready-count", { count: list.length }]);
        };
        const start = async id => {
          const ui = cards.get(id);
          if (s.busy) {
            return;
          }
          const pending = (s.busy = { id });
          self._dim(content, id);
          const onProgress = (step, fraction) => {
            if (step == "install") {
              ui.set({ state: "busy", status: "whimsy-onb-installing", tone: "busy", detailL10n: "whimsy-onb-detail-claude-installing", note: "whimsy-onb-install-progress", noteTone: "info", progress: fraction, cancel: () => self.cancelBusy() });
            } else {
              ui.set({ state: "busy", status: "whimsy-onb-signing-in", tone: "busy", detailL10n: id == "claude" ? "whimsy-onb-detail-claude-signing" : id == "openai" ? "whimsy-onb-detail-openai-signing" : "whimsy-onb-detail-apple-checking", cancel: id == "apple" ? null : () => self.cancelBusy() });
            }
          };
          onProgress(id == "apple" ? "check" : "sign-in");
          try {
            await self.connectProvider(win, id, pending, onProgress);
            s.providers.add(id);
            ui.set({ state: "done", status: PROVIDERS[id].done, tone: "pass", detailL10n: id == "claude" ? "whimsy-onb-detail-claude-done" : null });
          } catch (e) {
            const code = pending.cancelled ? "cancelled" : e?.code;
            if (code == "install-failed") {
              ui.set({ state: "failed", status: "whimsy-onb-not-connected", tone: "fail", note: "whimsy-onb-install-failed", actions: [["whimsy-onb-try-again", () => start(id), true], ["whimsy-onb-install-yourself", () => lazy.WhimsyConnectorOAuth.openSignIn(win, CLAUDE_CODE_URL)]] });
            } else if (code == "cancelled" && !pending.leaving) {
              ui.set({ state: "idle", button: PROVIDERS[id].action });
            } else if (!pending.leaving) {
              ui.set({ state: "failed", status: "whimsy-onb-not-connected", tone: "fail", note: id == "apple" ? "whimsy-onb-apple-failed" : "whimsy-onb-sign-in-failed", actions: [["whimsy-onb-try-again", () => start(id), true]] });
            }
          } finally {
            if (s.busy == pending) {
              s.busy = null;
            }
            self._dim(content, null);
            refresh();
          }
        };
        for (const id of ids) {
          cards.set(id, self._card(doc, content, { id, logo: PROVIDERS[id].logo, nameL10n: `whimsy-onb-name-${id}`, detailL10n: `whimsy-onb-detail-${id}`, action: PROVIDERS[id].action }, () => start(id)));
          if (s.providers.has(id)) {
            cards.get(id).set({ state: "done", status: PROVIDERS[id].done, tone: "pass", detailL10n: id == "claude" ? "whimsy-onb-detail-claude-done" : null });
          }
        }
        const link = self._el(doc, "button", "whimsy-onb-link", content, "whimsy-onb-api-key");
        link.addEventListener("click", () => lazy.WhimsyConnectorOAuth.openSignIn(win, "about:preferences?sheet=add-provider#whimsyAI"));
        refresh();
      },
    };
  },

  // ---- screen 2: connectors ----

  /** Connects one connector; tests replace this. */
  connectConnector(win, id, opts) {
    return lazy.WhimsyConnectors.connect(win, id, opts);
  },

  _connectPage(win) {
    const self = this;
    return {
      id: "whimsy-ai-connect",
      title: "whimsy-onb-cs-title",
      descriptions: ["whimsy-onb-cs-text", "whimsy-onb-cs-later"],
      buttons: [{ l10n: "whimsy-onb-skip", onclick: pages => self._continue(pages, 2) }],
      skip() {
        return !self.enabled || !self.connectorsOn || !self.session?.providers.size;
      },
      leave() {
        self._leave(win.document);
      },
      async render(content) {
        self._sheet(win);
        const doc = win.document;
        const s = self.session;
        const all = await lazy.WhimsyConnectors.list().catch(() => []);
        const byId = new Map(all.map(c => [c.id, c]));
        const cards = new Map();
        const ids = Object.keys(CONNECTORS);
        const refresh = () => {
          const ready = ids.filter(id => s.services.has(id));
          self._bottom(doc, ready, list =>
            list.length == ids.length ? ["whimsy-onb-cs-connected-all"] :
            list.length == 1 ? ["whimsy-onb-cs-connected-one", { name: CONNECTOR_NAMES[list[0]] }] : ["whimsy-onb-cs-connected-count", { count: list.length }]);
        };
        const run = async (id, opts = {}) => {
          const ui = cards.get(id);
          const pending = (s.busy = { id, cancel: () => lazy.WhimsyConnectors.cancel() });
          self._dim(content, id);
          ui.set({ state: "busy", status: id == "apple-calendar" ? "whimsy-onb-waiting" : "whimsy-onb-signing-in", tone: "busy", detailL10n: id == "apple-calendar" ? "whimsy-onb-cs-detail-apple-calendar-busy" : "whimsy-onb-detail-signing", detailArgs: { name: CONNECTOR_NAMES[id] }, cancel: id == "apple-calendar" ? null : () => self.cancelBusy() });
          try {
            await self.connectConnector(win, id, opts);
            s.services.add(id);
            ui.set({ state: "done", status: "whimsy-onb-connected", tone: "pass" });
          } catch (e) {
            if (pending.cancelled || e?.code == "cancelled") {
              ui.set({ state: "idle", button: CONNECTORS[id].action ?? "whimsy-onb-connect" });
            } else {
              ui.set({ state: "failed", status: "whimsy-onb-not-connected", tone: "fail", note: e?.code == "denied" ? "whimsy-onb-apple-denied" : "whimsy-onb-sign-in-failed", actions: [["whimsy-onb-try-again", () => start(id), true]] });
            }
          } finally {
            if (s.busy == pending) {
              s.busy = null;
            }
            self._dim(content, null);
            refresh();
          }
        };
        const start = id => {
          if (s.busy) {
            return;
          }
          if (lazy.CATALOG[id]?.scopes.length || id == "jira") {
            self._scopesSheet(win, content, id, cards.get(id), opts => run(id, opts));
          } else {
            run(id);
          }
        };
        for (const [group, groupIds] of [["whimsy-onb-cs-schedule", ids.slice(0, 3)], ["whimsy-onb-cs-work", ids.slice(3)]]) {
          self._el(doc, "div", "whimsy-onb-caption", content, group);
          for (const id of groupIds) {
            const c = byId.get(id);
            if (id == "apple-calendar" && !lazy.WhimsyNextMeeting.appleAvailable) {
              continue;
            }
            const ui = self._card(doc, content, { id, logo: `${ICONS}${lazy.CATALOG[id].logo}.svg`, nameL10n: `whimsy-connectors-name-${id}`, detailL10n: `whimsy-onb-cs-detail-${id}`, action: CONNECTORS[id].action ?? "whimsy-onb-connect", marks: CONNECTORS[id].marks }, () => start(id));
            cards.set(id, ui);
            if (c?.connected || s.services.has(id)) {
              s.services.add(id);
              ui.set({ state: "done", status: "whimsy-onb-connected", tone: "pass" });
            } else if (c?.status == "needs-client-id") {
              ui.set({ state: "idle", status: "whimsy-onb-needs-client-id", tone: "muted" });
            }
          }
        }
        const link = self._el(doc, "button", "whimsy-onb-link", content, "whimsy-onb-cs-mcp");
        link.addEventListener("click", () => lazy.WhimsyConnectorOAuth.openSignIn(win, "about:preferences?sheet=connector-mcp#whimsyAI"));
        refresh();
      },
    };
  },

  // A WhimsySurface-style panel over the cards: what it may read (all on),
  // or Jira's address. Esc and Cancel put the card back.
  _scopesSheet(win, content, id, ui, onGo) {
    const doc = win.document;
    const s = this.session;
    const pending = (s.busy = { id });
    this._dim(content, id);
    ui.set({ state: "busy", status: "whimsy-onb-choosing", tone: "busy" });
    const sheet = this._el(doc, "div", "whimsy-onb-sheet", null);
    sheet.setAttribute("role", "dialog");
    const top = ui.card.offsetTop + ui.card.offsetHeight + 6;
    sheet.style.top = `${top}px`;
    const head = this._el(doc, "div", "whimsy-onb-sheet-head", sheet);
    const logo = this._el(doc, "img", "", head);
    logo.src = `${ICONS}${lazy.CATALOG[id].logo}.svg`;
    logo.alt = "";
    const title = this._el(doc, "h1", "", head, `whimsy-connectors-sheet-title-${id}`);
    title.id = "whimsy-onb-sheet-title";
    sheet.setAttribute("aria-labelledby", title.id);
    this._el(doc, "p", "", sheet, id == "jira" ? "whimsy-connectors-sheet-jira-text" : `whimsy-connectors-sheet-text-${id}`);
    const boxes = [];
    let field = null;
    if (id == "jira") {
      field = this._el(doc, "input", "", sheet);
      field.type = "url";
      field.placeholder = "your-team.atlassian.net";
      field.setAttribute("aria-labelledby", title.id);
    } else {
      const rows = this._el(doc, "div", "whimsy-onb-sheet-rows", sheet);
      lazy.CATALOG[id].scopes.forEach((scope, i) => {
        const label = this._el(doc, "label", "", rows);
        const box = this._el(doc, "input", "", label);
        box.type = "checkbox";
        box.checked = true;
        box.dataset.scope = scope;
        boxes.push(box);
        const img = this._el(doc, "img", "", label);
        img.src = `${ICONS}${lazy.CATALOG[id].marks[scope]}.svg`;
        img.alt = "";
        const text = this._el(doc, "span", "", label);
        this._el(doc, "span", "", text).textContent = SCOPE_NAMES[scope];
        this._el(doc, "small", "", text, `whimsy-connectors-scope-${id}-${scope}`);
        if (!i) {
          box.setAttribute("autofocus", "");
        }
      });
    }
    this._el(doc, "p", "", sheet, "whimsy-connectors-sheet-keychain");
    const foot = this._el(doc, "div", "whimsy-onb-sheet-foot", sheet);
    const cancel = this._el(doc, "button", "", foot, "whimsy-onb-cancel");
    const go = this._el(doc, "button", "is-primary", foot, `whimsy-connectors-sheet-continue-${id}`);
    go.dataset.action = "continue";
    const sync = () => (go.disabled = field ? !field.value.trim() : !boxes.some(b => b.checked));
    boxes.forEach(b => b.addEventListener("change", sync));
    field?.addEventListener("input", sync);
    sync();
    const close = () => {
      sheet.remove();
      if (s.busy == pending) {
        s.busy = null;
      }
      this._dim(content, null);
    };
    pending.cancel = () => {
      close();
      ui.set({ state: "idle", button: CONNECTORS[id].action ?? "whimsy-onb-connect" });
    };
    cancel.addEventListener("click", () => pending.cancel());
    sheet.addEventListener("keydown", event => {
      if (event.key == "Escape") {
        event.preventDefault();
        pending.cancel();
      }
    });
    go.addEventListener("click", () => {
      const opts = field ? { site: field.value.trim() } : { scopes: boxes.filter(b => b.checked).map(b => b.dataset.scope) };
      close();
      onGo(opts);
    });
    content.style.position = "relative";
    content.append(sheet);
    if (!reduced(win) && !this.instant) {
      this.sheetAnimation = sheet.animate({ opacity: [0, 1], scale: [0.97, 1] }, { duration: 180, easing: "cubic-bezier(0.2, 0, 0, 1)" });
    }
    (field ?? boxes[0])?.focus();
  },

  // ---- leaving a screen, and "You're all set" ----

  _continue(pages, screen) {
    const s = this.session;
    if (s?.busy) {
      s.busy.leaving = true;
      this.cancelBusy();
    }
    const connectorsShow = this.connectorsOn && !!s?.providers.size;
    const celebrate = screen == 2 ? !!s?.services.size : !connectorsShow && !!s?.providers.size;
    if (celebrate && !Services.prefs.getBoolPref(CELEBRATED_PREF, false)) {
      Services.prefs.setBoolPref(CELEBRATED_PREF, true);
      this.celebrate(s.win, () => pages.next());
      return false;
    }
    return true;
  },

  /** Plays once, then waits for Continue or Return (onb-5.1). */
  celebrate(win, onDone) {
    const doc = win.document;
    const s = this.session;
    const marks = [
      ...["apple", "claude", "openai"].filter(id => s.providers.has(id)).map(id => PROVIDERS[id].logo),
      ...Object.keys(CONNECTORS).filter(id => s.services.has(id)).map(id => `${ICONS}${lazy.CATALOG[id].logo}.svg`),
    ];
    const names = [
      ...["apple", "claude", "openai"].filter(id => s.providers.has(id)).map(id => PROVIDER_NAMES[id]),
      ...Object.keys(CONNECTORS).filter(id => s.services.has(id)).map(id => CONNECTOR_NAMES[id]),
    ];
    // Deferred a tick: building this overlay (and fading the card behind
    // it) synchronously would mutate the page while the button that led
    // here is still mid-click, which fails the a11y check on that button.
    // queueMicrotask isn't a global in this module's scope; a resolved
    // Promise's .then() is the same microtask queue.
    Promise.resolve().then(() => {
      const overlay = this._el(doc, "div", "", null);
      overlay.id = "whimsy-onb-done";
      overlay.setAttribute("role", "dialog");
      overlay.setAttribute("aria-labelledby", "whimsy-onb-done-title");
      const glow = this._el(doc, "div", "whimsy-onb-glow", overlay);
      const sparkBox = this._el(doc, "div", "whimsy-onb-sparks", overlay);
      const sparks = SPARKS.map(([x, y, size, delay, accent]) => {
        const spark = this._el(doc, "span", `whimsy-onb-spark${accent ? " is-accent" : ""}`, sparkBox);
        spark.style.cssText = `--x:${x}px;--y:${y}px;--s:${size}px`;
        spark.dataset.delay = delay;
        return spark;
      });
      const inner = this._el(doc, "div", "whimsy-onb-done-inner", overlay);
      const row = this._el(doc, "div", "whimsy-onb-done-marks", inner);
      const n = marks.length;
      const tiles = marks.map((src, i) => {
        const tile = this._el(doc, "span", "whimsy-onb-mark", row);
        const mid = (n - 1) / 2;
        tile.style.setProperty("--lift", `${-(mid - Math.abs(i - mid)) * 6}px`);
        tile.dataset.delay = Math.abs(i - mid) * 60;
        const img = this._el(doc, "img", "", tile);
        img.src = src;
        img.alt = "";
        return tile;
      });
      const all = s.providers.size + s.services.size >= 9;
      const list = new Intl.ListFormat(undefined, { type: "conjunction" }).format(names);
      const t1 = this._el(doc, "h1", "whimsy-onb-t1", inner, "whimsy-onb-done-title");
      t1.id = "whimsy-onb-done-title";
      const t2 = this._el(doc, "p", "whimsy-onb-t2", inner, all ? "whimsy-onb-done-text-all" : names.length == 1 ? "whimsy-onb-done-text-one" : "whimsy-onb-done-text-list", { names: list });
      const t3 = this._el(doc, "div", "whimsy-onb-t3", inner);
      const go = this._el(doc, "button", "zen-big-accent-button primary", t3, "whimsy-onb-done-continue");
      go.id = "whimsy-onb-done-continue";
      go.style.width = "100%";
      const t4 = this._el(doc, "p", "whimsy-onb-t4", inner, "whimsy-onb-done-hint");
      const card = doc.getElementById("zen-welcome-pages");
      (doc.getElementById("zen-welcome") ?? doc.documentElement).append(overlay);
      const animations = [];
      const play = (node, keyframes, options) => {
        if (!this.instant) {
          animations.push(node.animate(keyframes, { fill: "backwards", ...options }));
        }
      };
      if (reduced(win)) {
        play(overlay, { opacity: [0, 1] }, { duration: 250 });
        if (card) {
          play(card, { opacity: [1, 0] }, { duration: 250, fill: "forwards" });
        }
      } else {
        if (card) {
          play(card, { opacity: [1, 0], scale: [1, 0.94] }, { duration: 220, easing: EXIT, fill: "forwards" });
        }
        play(glow, { opacity: [0, 1], scale: [0.6, 1] }, { duration: 700, delay: 120, easing: "cubic-bezier(0.2, 0, 0, 1)" });
        tiles.forEach(tile => play(tile, { opacity: [0, 1], translate: ["0 24px", "0 0"], scale: [0.6, 1] }, { duration: 520, delay: 160 + Number(tile.dataset.delay), easing: SPRING }));
        sparks.forEach(spark => play(spark, { opacity: [0, 1, 0.7], scale: [0, 1.15, 1], rotate: ["-30deg", "0deg", "0deg"] }, { duration: 900, delay: 400 + Number(spark.dataset.delay), easing: "cubic-bezier(0.2, 0, 0, 1)" }));
        [t1, t2, t3].forEach((node, i) => play(node, { opacity: [0, 1], translate: ["0 12px", "0 0"] }, { duration: 450, delay: 520 + i * 30, easing: TEXT_SPRING }));
        play(t4, { opacity: [0, 1] }, { duration: 250, delay: 900, easing: "ease-out" });
      }
      if (card && this.instant) {
        card.style.opacity = "0";
      }
      this.celebration = { overlay, animations, tiles };
      let finished = false;
      const finish = () => {
        if (finished) {
          return;
        }
        finished = true;
        win.removeEventListener("keydown", onKey, true);
        const out = this.instant ? null : overlay.animate({ opacity: [1, 0] }, { duration: 180, fill: "forwards" });
        const done = () => {
          overlay.remove();
          for (const a of animations) {
            a.cancel();
          }
          if (card) {
            card.style.opacity = "";
          }
          this.celebration = null;
          onDone?.();
        };
        out ? out.finished.then(done, done) : done();
      };
      const onKey = event => {
        if (event.key == "Enter" && !event.repeat) {
          event.preventDefault();
          event.stopPropagation();
          finish();
        }
      };
      win.addEventListener("keydown", onKey, true);
      go.addEventListener("click", finish);
      go.focus();
    });
  },
};

const PROVIDER_NAMES = { apple: "Apple Intelligence", claude: "Claude", openai: "ChatGPT" };
const CONNECTOR_NAMES = { google: "Google", microsoft: "Microsoft", "apple-calendar": "Apple Calendar", granola: "Granola", linear: "Linear", jira: "Jira" };
const SCOPE_NAMES = { gmail: "Gmail", calendar: "Calendar", drive: "Drive", outlook: "Outlook", onedrive: "OneDrive" };
