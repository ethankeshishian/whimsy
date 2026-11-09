/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// W23 routines-ui: Library › Routines. One list in two groups, Routines and
// Page watches, built from the Library's own parts: Routing's search box
// and New, the 12px group labels, and Boosts-sized rows with a one-line
// result. Row buttons (Run now, Pause, Edit, Delete; watches: Check now)
// take the time's place on hover or focus. A row opens its thread in chat
// beside the Library. New and Edit open the form in place, the way Routing
// opens "New route". With AI off the tab stays and shows the opt-in card.

import { html, nothing, repeat } from "chrome://global/content/vendor/lit.all.mjs";
import { ZenLibrarySearchSection } from "moz-src:///zen/library/sections/ZenLibrarySearchSection.mjs";
import { buildRoutineForm } from "./whimsy-routine-form.mjs";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  WhimsyAIProviders: "resource:///modules/whimsy/WhimsyAIProviders.sys.mjs",
  WhimsyAIStore: "resource:///modules/whimsy/WhimsyAIStore.sys.mjs",
  WhimsyChat: "resource:///modules/whimsy/WhimsyChat.sys.mjs",
  WhimsyPageWatch: "resource:///modules/whimsy/WhimsyPageWatch.sys.mjs",
  MAX_WATCHES: "resource:///modules/whimsy/WhimsyPageWatch.sys.mjs",
  WhimsyRoutines: "resource:///modules/whimsy/WhimsyRoutines.sys.mjs",
  WhimsyRoutinesUI: "resource:///modules/whimsy/WhimsyRoutinesUI.sys.mjs",
  WhimsyUndo: "resource:///modules/whimsy/WhimsyUndo.sys.mjs",
  triggerLabel: "resource:///modules/whimsy/WhimsyRoutineCards.sys.mjs",
});

const ZEN = "chrome://browser/skin/zen-icons/";
const OWN = "chrome://browser/content/whimsy/icons/";
const SHEET = "chrome://browser/content/whimsy/whimsy-routines.css";
const PANEL_FADE_MS = 300;

// Built-ins: their tile (glyph and colour) in the Library.
export const BUILT_IN_TILES = {
  "daily-brief": [`${ZEN}selectable/sun.svg`, "#e8a000"],
  "weekly-recap": [`${ZEN}selectable/stats-chart.svg`, "#2f9e5b"],
  "meeting-prep": [`${ZEN}selectable/people.svg`, "#7a5af8"],
  "price-watch": [`${ZEN}selectable/logo-usd.svg`, "#e0466b"],
  "catch-up": [`${OWN}uturn-backward.svg`, "#2f80ed"],
  "doc-changes": [`${ZEN}page-portrait.svg`, "#2f80ed"],
  standup: [`${ZEN}selectable/checkbox.svg`, "#5e6ad2"],
  "meeting-follow-up": [`${ZEN}selectable/time.svg`, "#e8590c"],
};
const TRIGGER_TILES = {
  schedule: `${OWN}clock.svg`,
  page: `${ZEN}page-portrait.svg`,
  return: `${OWN}uturn-backward.svg`,
  meeting: `${ZEN}selectable/people.svg`,
  email: `${ZEN}mail.svg`,
  "open-site": "chrome://browser/content/whimsy/icons/globe-line.svg",
  download: `${ZEN}downloads.svg`,
};

const LIBRARY_WIDTH = 600;

const STEP_L10N = {
  reconnect: "whimsy-routine-step-reconnect",
  "sign-in": "whimsy-routine-step-sign-in",
  edit: "whimsy-routine-step-edit",
  "try-again": "whimsy-routine-step-try-again",
  "skip-today": "whimsy-routine-step-skip-today",
  "prep-anyway": "whimsy-routine-skip-prep",
};

function loadSheet() {
  if (!window._whimsyRoutinesSheet) {
    window._whimsyRoutinesSheet = true;
    window.windowUtils.loadSheetUsingURIString(SHEET, window.windowUtils.AUTHOR_SHEET);
  }
}

function whenText(ms) {
  if (!ms) {
    return "";
  }
  const d = new Date(ms);
  const now = new Date();
  const diff = now - d;
  if (diff >= 0 && diff < 60 * 60 * 1000) {
    // The run thread's "1 min ago", not Intl's abbreviated "1 min. ago".
    return { l10nId: "whimsy-cmdbar-minutes-ago", minutes: Math.max(1, Math.round(diff / 60000)) };
  }
  if (d.toDateString() == now.toDateString()) {
    return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  }
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (d.toDateString() == yesterday.toDateString()) {
    return new Intl.RelativeTimeFormat(undefined, { numeric: "auto" }).format(-1, "day").replace(/^./, c => c.toUpperCase());
  }
  if (diff < 6 * 24 * 60 * 60 * 1000) {
    return d.toLocaleDateString([], { weekday: "short" });
  }
  return d.toLocaleDateString([], { month: "short", day: "numeric" });
}

function hostOf(url) {
  try {
    return new URL(url).host.replace(/^www\./, "");
  } catch {
    return url ?? "";
  }
}

export class WhimsyRoutinesSection extends ZenLibrarySearchSection {
  static id = "whimsy-routines";
  static label = "whimsy-library-routines-title";

  static render(library) {
    return html`
      <whimsy-library-routines-section
        class="zen-library-section"
        data-section="whimsy-routines"
        .library=${library}
      ></whimsy-library-routines-section>
    `;
  }

  static properties = {
    items: { state: true },
    aiOn: { state: true },
    draft: { state: true },
    confirming: { state: true },
    moreOpen: { state: true },
    suggestions: { state: true },
    details: { state: true },
    loaded: { state: true },
  };

  #observer = { observe: () => this.#refresh() };
  #form = null;
  #formKey = null;
  #resize = null;
  #draftTimer = null;
  #refreshing = null;

  constructor() {
    super();
    this.items = [];
    this.aiOn = lazy.WhimsyRoutines.enabled;
    this.draft = null;
    this.confirming = null;
    this.moreOpen = false;
    this.suggestions = [];
    this.details = new Map();
    this.loaded = false;
  }

  connectedCallback() {
    super.connectedCallback();
    loadSheet();
    Services.obs.addObserver(this.#observer, lazy.WhimsyRoutines.TOPIC);
    Services.obs.addObserver(this.#observer, "whimsy-ai-updates-changed");
    Services.prefs.addObserver("whimsy.ai.enabled", this.#observer);
    lazy.WhimsyPageWatch.addListener(this.#onWatches);
    window.addEventListener("keydown", this.#onWindowKey, true);
    this.#refresh();
    this.toggleAttribute("needs-opt-in", !this.aiOn);
    const pending = lazy.WhimsyRoutinesUI.takePending(window);
    if (pending) {
      this.openForm(pending);
    }
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.#dropWidth(document.querySelector("zen-library"));
    Services.obs.removeObserver(this.#observer, lazy.WhimsyRoutines.TOPIC);
    Services.obs.removeObserver(this.#observer, "whimsy-ai-updates-changed");
    Services.prefs.removeObserver("whimsy.ai.enabled", this.#observer);
    lazy.WhimsyPageWatch.removeListener(this.#onWatches);
    window.removeEventListener("keydown", this.#onWindowKey, true);
    this.#resize?.disconnect();
  }

  #onWatches = () => this.#refresh();

  // ⌘Z while the Library is open brings back a routine deleted in the last 2 s.
  #onWindowKey = event => {
    if (event.key != "z" || !event.metaKey || event.shiftKey || !this.lastDeleted || !this.isConnected || !this.checkVisibility()) {
      return;
    }
    const active = document.activeElement;
    if (active?.matches?.("input, textarea")) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    this.#undoDelete(this.lastDeleted);
  };

  async #refresh() {
    if (this.#refreshing) {
      this.#refreshAgain = true;
      return;
    }
    this.#refreshing = (async () => {
      this.aiOn = lazy.WhimsyRoutines.enabled;
      this.toggleAttribute("needs-opt-in", !this.aiOn);
      const items = await lazy.WhimsyRoutines.list().catch(() => []);
      const details = new Map();
      for (const r of items) {
        if (["failed", "waiting", "skipped"].includes(r.status) && r.threadId) {
          const cards = (await lazy.WhimsyAIStore.messages(r.threadId).catch(() => [])).filter(m => m.role == "card");
          const last = cards.findLast(m => m.kind == "routine-fail" || m.kind == "routine-skip");
          if (last) {
            details.set(r.id, last);
          }
        }
      }
      if (items.some(r => r.kind == "watch")) {
        for (const w of await lazy.WhimsyPageWatch.list().catch(() => [])) {
          details.set(`watch:${w.id}`, w);
        }
      }
      this.items = items;
      this.details = details;
      this.suggestions = items.length ? [] : await lazy.WhimsyRoutinesUI.suggestions(window).catch(() => []);
      this.loaded = true;
      lazy.WhimsyRoutinesUI.updateBadge(window);
    })();
    try {
      await this.#refreshing;
    } finally {
      this.#refreshing = null;
      if (this.#refreshAgain) {
        this.#refreshAgain = false;
        this.#refresh();
      }
    }
  }

  #refreshAgain = false;

  // Rows carry a result line, so Routines uses a 600px Library (as Spaces
  // widens it); Zen's clamp falls back to 418px in a narrow window.
  async onShown() {
    this.closest("zen-library")?.style.setProperty("--zen-library-content-width", `${LIBRARY_WIDTH}px`);
    await super.onShown();
    lazy.WhimsyRoutinesUI.markSeen(window);
  }

  onHidden() {
    this.#dropWidth(this.closest("zen-library"));
  }

  // Only our own width: the section shown next (Spaces) may have set its own.
  #dropWidth(library) {
    if (library?.style.getPropertyValue("--zen-library-content-width") == `${LIBRARY_WIDTH}px`) {
      library.style.removeProperty("--zen-library-content-width");
    }
  }

  get searchPlaceholderL10nId() {
    return "whimsy-library-routines-search";
  }

  onSearchChanged() {
    this.requestUpdate();
  }

  onEscape() {
    if (this.confirming) {
      this.confirming = null;
      return true;
    }
    if (!this.filtersOpen) {
      return false;
    }
    this.closeForm({ cancelled: true });
    return true;
  }

  onLibraryClosing() {
    super.onLibraryClosing?.();
    if (this.filtersOpen) {
      this.closeForm({ cancelled: true, now: true });
    }
  }

  // ---- The form, in place ----

  /** opts: {routineId?, prefill?, builtIn?} */
  async openForm(opts = {}) {
    if (!this.aiOn) {
      return;
    }
    clearTimeout(this.#draftTimer);
    let draft;
    if (opts.routineId) {
      const r = await lazy.WhimsyRoutines.get(opts.routineId);
      if (!r) {
        return;
      }
      draft = { ...r, trigger: { ...r.trigger }, title: r.title };
    } else {
      draft = { trigger: { kind: "schedule" }, prompt: "", showIn: "bar", using: "auto", ...(opts.prefill ?? {}) };
    }
    this.draft = { ...draft, _key: Math.random(), _builtIn: opts.builtIn ?? null };
    this.filtersOpen = true;
  }

  closeForm({ cancelled = false, now = false } = {}) {
    const builtIn = this.draft?._builtIn;
    this.filtersOpen = false;
    if (cancelled && builtIn) {
      // Cancel turns the built-in's switch back off.
      this.pendingBuiltIn = null;
    }
    this.pendingBuiltIn = null;
    const done = () => {
      if (!this.filtersOpen) {
        this.draft = null;
        this.#form = null;
        this.#formKey = null;
      }
    };
    if (now) {
      done();
    } else {
      this.#draftTimer = setTimeout(done, PANEL_FADE_MS);
    }
    this.requestUpdate();
  }

  updated(changed) {
    super.updated?.(changed);
    const host = this.querySelector(".whimsy-routines-form-host");
    if (host && this.draft && this.#formKey != this.draft._key) {
      this.#formKey = this.draft._key;
      const draft = { ...this.draft };
      delete draft._key;
      delete draft._builtIn;
      this.#form = buildRoutineForm(window, {
        draft,
        layout: "library",
        onCancel: () => this.closeForm({ cancelled: true }),
        onDone: () => {
          this.closeForm();
          this.#refresh();
        },
        onResize: () => this.#sizePanel(),
      });
      host.replaceChildren(this.#form.root);
      this.#resize?.disconnect();
      this.#resize = new ResizeObserver(() => this.#sizePanel());
      this.#resize.observe(this.#form.root);
      this.#sizePanel();
      if (this.filtersOpen) {
        this.#form.focusFirst();
      }
    }
    if (changed.has("filtersOpen") && this.filtersOpen && this.#form) {
      this.#form.focusFirst();
    }
  }

  #sizePanel() {
    const inner = this.querySelector(".zen-library-filter-panel-inner");
    if (inner) {
      this.style.setProperty("--zen-library-filter-height", `${inner.scrollHeight + 8}px`);
    }
  }

  renderTopButton() {
    if (!this.aiOn) {
      return null;
    }
    return html`
      <button class="zen-library-filter-button whimsy-routines-new" @click=${() => this.openForm()}>
        <img src="chrome://browser/skin/zen-icons/plus.svg" draggable="false" alt="" />
        <span data-l10n-id="whimsy-library-routines-new"></span>
      </button>
    `;
  }

  renderPanel() {
    const draft = this.draft;
    const title = draft?.id ? "whimsy-routine-form-edit" : "whimsy-routine-form-new";
    return html`
      <div class="zen-library-filter-header" ?inert=${!this.filtersOpen}>
        ${draft?.title && (draft.id || draft.builtIn)
          ? html`<h2>${draft.title}</h2>`
          : html`<h2 data-l10n-id=${title}></h2>`}
      </div>
      <div class="zen-library-filter-panel">
        <div class="zen-library-filter-panel-inner" ?inert=${!this.filtersOpen}>
          <div class="whimsy-routines-form-host"></div>
        </div>
      </div>
    `;
  }

  // ---- Rows ----

  #tile(r) {
    if (r.kind == "watch") {
      return html`<span class="whimsy-routine-tile is-site"><img src=${`page-icon:${r.trigger.url}`} alt="" /></span>`;
    }
    const [icon, color] = BUILT_IN_TILES[r.builtIn] ?? [TRIGGER_TILES[r.trigger.kind] ?? TRIGGER_TILES.schedule, "#6e6e73"];
    return html`<span class="whimsy-routine-tile" style=${`--tile: ${color}`}><img src=${icon} alt="" /></span>`;
  }

  #subtitle(r) {
    if (r.kind == "watch") {
      return html`<span class="zen-library-row-subtitle" data-l10n-id="whimsy-routine-bar-watch-detail"
        data-l10n-args=${JSON.stringify({ condition: r.prompt, minutes: r.trigger.interval })}></span>`;
    }
    const [id, args] = lazy.triggerLabel(r.trigger);
    return html`<span class="zen-library-row-subtitle" data-l10n-id=${id} data-l10n-args=${JSON.stringify(args ?? {})}></span>`;
  }

  #failure(r) {
    if (r.kind == "watch") {
      const w = this.details.get(`watch:${r.id}`);
      if (!w?.error || (w.failures ?? 0) < 2) {
        return null;
      }
      return {
        tone: "fail",
        pill: "whimsy-library-routines-pill-needs-you",
        reason: [w.error == "unreadable" ? "whimsy-watch-reason-unreadable" : "whimsy-watch-reason-failed", { count: w.failures }],
        steps: [
          { l10nId: "whimsy-watch-step-open-page", run: () => lazy.WhimsyPageWatch.openWatch(window, w) },
          { l10nId: "whimsy-library-routines-step-edit-watch", run: () => this.openForm({ routineId: r.id }) },
        ],
      };
    }
    if (!["failed", "waiting", "skipped"].includes(r.status)) {
      return null;
    }
    const card = this.details.get(r.id);
    if (r.status == "skipped") {
      return {
        tone: "muted",
        pill: "whimsy-library-routines-pill-skipped",
        reason: card ? ["whimsy-routine-skip-title", { meeting: card.meeting?.title ?? "" }] : null,
        steps: card?.meeting
          ? [{ l10nId: "whimsy-routine-skip-prep", run: () => lazy.WhimsyRoutines.act(window, r.id, { action: "prep-anyway", meeting: card.meeting }) }]
          : [],
      };
    }
    const waiting = r.status == "waiting";
    const step = card?.step;
    const steps = [];
    if (step?.action) {
      steps.push({
        l10nId: STEP_L10N[step.action] ?? "whimsy-routine-step-try-again",
        args: step.connector ? { connector: step.connectorName ?? step.connector } : undefined,
        primary: !waiting,
        run: () => lazy.WhimsyRoutines.act(window, r.id, step),
      });
    }
    if (waiting) {
      steps.push({ l10nId: "whimsy-library-routines-step-providers", run: () => lazy.WhimsyAIProviders.openSettings(window, "providers") });
    }
    return {
      tone: waiting ? "warn" : "fail",
      pill: waiting ? "whimsy-library-routines-pill-waiting" : "whimsy-library-routines-pill-needs-you",
      reason: card?.reason ?? null,
      steps,
    };
  }

  #result(r, failure) {
    if (failure?.reason) {
      const [id, args] = failure.reason;
      return html`<span class="whimsy-routine-result" data-tone=${failure.tone} data-l10n-id=${id} data-l10n-args=${JSON.stringify(args ?? {})}></span>`;
    }
    if (r.status == "running") {
      return html`<span class="whimsy-routine-result" data-l10n-id="whimsy-library-routines-running"></span>`;
    }
    if (r.lastResult) {
      const w = r.kind == "watch" ? this.details.get(`watch:${r.id}`) : null;
      if (w?.met) {
        return html`<span class="whimsy-routine-result" data-l10n-id="whimsy-library-routines-found" data-l10n-args=${JSON.stringify({ detail: r.lastResult })}></span>`;
      }
      return html`<span class="whimsy-routine-result">${r.lastResult}</span>`;
    }
    return html`<span class="whimsy-routine-result" data-l10n-id=${r.kind == "watch" ? "whimsy-library-routines-not-checked" : "whimsy-library-routines-never"}></span>`;
  }

  #end(r, failure) {
    if (failure?.pill) {
      return html`<span class="whimsy-routine-pill" data-tone=${failure.tone}><span data-l10n-id=${failure.pill}></span></span>`;
    }
    if (r.status == "running") {
      return html`<span class="whimsy-routine-spinner" role="img"></span>`;
    }
    if (r.paused) {
      return html`<span class="whimsy-routine-time" data-l10n-id="whimsy-library-routines-paused"></span>`;
    }
    const when = whenText(r.lastRun);
    if (when.l10nId) {
      return html`<span class="whimsy-routine-time" data-l10n-id=${when.l10nId}
        data-l10n-args=${JSON.stringify({ minutes: when.minutes })}></span>`;
    }
    return html`<span class="whimsy-routine-time">${when}</span>`;
  }

  #act(event, fn) {
    event.stopPropagation();
    fn();
  }

  #actions(r) {
    const watch = r.kind == "watch";
    const running = r.status == "running";
    const button = (action, l10nId, icon, fn, cls = "") => html`
      <button class="whimsy-routine-act ${cls}" data-action=${action} data-l10n-id=${l10nId}
        @click=${e => this.#act(e, fn)} @keydown=${e => e.key == " " && e.stopPropagation()}>
        <img src=${icon} alt="" />
      </button>
    `;
    return html`
      <span class="whimsy-routine-acts">
        ${watch
          ? button("check", "whimsy-library-routines-check", `${ZEN}reload.svg`, () => lazy.WhimsyRoutines.runNow(r.id))
          : running
            ? button("stop", "whimsy-library-routines-stop", `${OWN}stop.svg`, () => lazy.WhimsyRoutines.stop(r.id))
            : button("run", "whimsy-library-routines-run", `${ZEN}media-play.svg`, () => lazy.WhimsyRoutines.runNow(r.id))}
        ${r.paused
          ? button("pause", "whimsy-library-routines-resume", `${ZEN}media-play.svg`, () => this.#pause(r))
          : button("pause", "whimsy-library-routines-pause", `${OWN}pause.svg`, () => this.#pause(r))}
        ${button("edit", "whimsy-library-routines-edit", `${OWN}pencil.svg`, () => this.openForm({ routineId: r.id }))}
        ${button("delete", "whimsy-library-routines-delete", `${ZEN}trash.svg`, () => this.#askDelete(r), "is-destructive")}
      </span>
    `;
  }

  #pause(r) {
    lazy.WhimsyRoutines.pause(r.id, !r.paused);
  }

  async #open(r) {
    const threadId = await lazy.WhimsyRoutinesUI.threadFor(r.id);
    if (threadId) {
      lazy.WhimsyChat.open(window, { threadId });
    }
  }

  async #askDelete(r) {
    this.confirming = r.id;
    await this.updateComplete;
    this.querySelector(`.whimsy-routine-row[data-id="${r.id}"] .whimsy-routine-confirm-cancel`)?.focus();
  }

  async #delete(r) {
    const row = this.querySelector(`.whimsy-routine-row[data-id="${r.id}"]`);
    row?.setAttribute("removing", "");
    this.confirming = null;
    await lazy.WhimsyRoutines.remove(r.id);
    this.lastDeleted = r.id;
    lazy.WhimsyUndo.showToast(window, "whimsy-library-routines-deleted", { undo: () => this.#undoDelete(r.id) }, { title: r.title });
    setTimeout(() => {
      if (this.lastDeleted == r.id) {
        this.lastDeleted = null;
      }
    }, 2000);
  }

  async #undoDelete(id) {
    this.lastDeleted = null;
    await lazy.WhimsyRoutines.undoRemove(id);
    this.#refresh();
  }

  #rows() {
    return [...this.querySelectorAll(".whimsy-routine-row:not([removing])")];
  }

  #onRowKey(event, r) {
    if (event.target != event.currentTarget) {
      return;
    }
    const rows = this.#rows();
    const i = rows.indexOf(event.currentTarget);
    switch (event.key) {
      case "ArrowDown":
      case "ArrowUp": {
        event.preventDefault();
        const next = rows[i + (event.key == "ArrowDown" ? 1 : -1)];
        next?.focus();
        break;
      }
      case "Enter":
        event.preventDefault();
        this.#open(r);
        break;
      case "Backspace":
      case "Delete":
        event.preventDefault();
        this.#askDelete(r);
        break;
      case " ":
        event.preventDefault();
        this.#pause(r);
        break;
    }
  }

  #confirm(r) {
    return html`
      <div class="whimsy-routine-confirm" role="group">
        <span class="whimsy-routine-confirm-text" data-l10n-id="whimsy-library-routines-delete-ask"
          data-l10n-args=${JSON.stringify({ title: r.title })}></span>
        <button class="whimsy-routine-confirm-cancel" data-l10n-id="whimsy-library-routines-delete-cancel"
          @click=${e => this.#act(e, () => (this.confirming = null))}></button>
        <button class="whimsy-routine-confirm-delete" data-l10n-id="whimsy-library-routines-delete-confirm"
          @click=${e => this.#act(e, () => this.#delete(r))}></button>
      </div>
    `;
  }

  #row(r) {
    const failure = this.#failure(r);
    const confirming = this.confirming == r.id;
    const w = r.kind == "watch" ? this.details.get(`watch:${r.id}`) : null;
    return html`
      <div
        class="zen-library-row whimsy-routine-row"
        data-id=${r.id}
        data-kind=${r.kind}
        tabindex="0"
        role="button"
        ?paused=${r.paused}
        ?running=${r.status == "running"}
        ?failed=${!!failure && failure.tone != "muted"}
        ?confirming=${confirming}
        aria-label=${r.title}
        @click=${() => !confirming && this.#open(r)}
        @keydown=${e => this.#onRowKey(e, r)}
      >
        ${this.#tile(r)}
        <div class="zen-library-row-text">
          <span class="zen-library-row-title">
            <span class="whimsy-routine-title">${r.title}</span>
            ${w?.met ? html`<span class="whimsy-routine-pill" data-tone="accent"><span data-l10n-id="whimsy-library-routines-pill-found"></span></span>` : nothing}
          </span>
          ${this.#subtitle(r)}
          ${confirming ? nothing : this.#result(r, failure)}
          ${!confirming && failure?.steps?.length
            ? html`<span class="whimsy-routine-steps">
                ${failure.steps.map(
                  s => html`<button class="whimsy-routine-step" ?primary=${s.primary} data-l10n-id=${s.l10nId}
                    data-l10n-args=${JSON.stringify(s.args ?? {})} @click=${e => this.#act(e, s.run)}></button>`
                )}
              </span>`
            : nothing}
          ${confirming ? this.#confirm(r) : nothing}
        </div>
        ${confirming
          ? nothing
          : html`<div class="whimsy-routine-end">${this.#end(r, failure)}${this.#actions(r)}</div>`}
      </div>
    `;
  }

  // ---- Built-ins and suggestions ----

  #builtInRow(b) {
    const [icon, color] = BUILT_IN_TILES[b.builtIn];
    const pending = this.draft?._builtIn == b.builtIn && this.filtersOpen;
    return html`
      <div class="zen-library-row whimsy-routine-row whimsy-routine-builtin" data-builtin=${b.builtIn}>
        <span class="whimsy-routine-tile is-small" style=${`--tile: ${color}`}><img src=${icon} alt="" /></span>
        <div class="zen-library-row-text">
          <span class="zen-library-row-title">${b.title}</span>
          <span class="zen-library-row-subtitle" data-l10n-id=${`whimsy-library-routines-builtin-detail-${b.builtIn}`}></span>
        </div>
        <input
          type="checkbox"
          role="switch"
          class="whimsy-routine-switch"
          aria-label=${b.title}
          .checked=${pending}
          @change=${e => {
            if (e.target.checked) {
              this.openForm({ prefill: b, builtIn: b.builtIn });
            } else if (pending) {
              this.closeForm({ cancelled: true });
            }
          }}
        />
      </div>
    `;
  }

  #suggestionRow(s) {
    return html`
      <div class="whimsy-routine-suggestion" data-suggestion=${s.id}>
        <span class="whimsy-routine-tile is-small is-site"><img src=${s.icon} alt="" /></span>
        <div class="zen-library-row-text">
          <span class="zen-library-row-title" data-l10n-id=${s.l10nId} data-l10n-args=${JSON.stringify(s.args)}></span>
          <span class="zen-library-row-subtitle" data-l10n-id=${s.whyL10nId} data-l10n-args=${JSON.stringify(s.whyArgs ?? {})}></span>
        </div>
        <button class="whimsy-routine-add" data-l10n-id="whimsy-library-routines-add"
          @click=${() => this.openForm({ prefill: s.draft, builtIn: s.draft.builtIn })}></button>
      </div>
    `;
  }

  #renderOff() {
    const routines = this.items.filter(r => r.kind == "routine").length;
    const watches = this.items.filter(r => r.kind == "watch").length;
    return html`
      <div class="whimsy-routines-skeleton" aria-hidden="true">
        ${[0, 1, 2, 3].map(() => html`<div class="whimsy-routines-skeleton-row"><span></span><span><i></i><i></i><i></i></span></div>`)}
      </div>
      <div class="zen-library-media-opt-in whimsy-routines-opt-in" role="group" aria-labelledby="whimsy-routines-off-title">
        <div class="zen-library-media-opt-in-icon whimsy-routines-opt-in-icon">
          <div class="empty-state-icon-image"></div>
        </div>
        <h3 id="whimsy-routines-off-title" data-l10n-id="whimsy-library-routines-off-title"></h3>
        <p data-l10n-id="whimsy-library-routines-off-body"></p>
        <button class="zen-big-accent-button primary zen-library-media-opt-in-button whimsy-routines-set-up"
          data-l10n-id="whimsy-library-routines-off-button"
          @click=${() => lazy.WhimsyAIProviders.openSettings(window, "add-provider")}></button>
        <div class="zen-library-media-opt-in-note">
          <img src="chrome://browser/skin/zen-icons/selectable/lock-closed.svg" alt="" />
          <span data-l10n-id="whimsy-library-routines-off-kept" data-l10n-args=${JSON.stringify({ routines, watches })}></span>
        </div>
      </div>
    `;
  }

  renderItems() {
    if (!this.aiOn) {
      return this.#renderOff();
    }
    if (!this.loaded) {
      return nothing;
    }
    const query = this.searchQuery.toLowerCase();
    const match = r => !query || `${r.title} ${r.prompt} ${r.trigger.url ?? ""}`.toLowerCase().includes(query);
    const routines = this.items.filter(r => r.kind == "routine");
    const watches = this.items.filter(r => r.kind == "watch");
    const builtIns = lazy.WhimsyRoutines.builtIns();
    if (!routines.length && !watches.length) {
      return html`
        <div class="whimsy-routines-intro">
          <h2 data-l10n-id="whimsy-library-routines-intro-title"></h2>
          <p data-l10n-id="whimsy-library-routines-intro"></p>
        </div>
        ${this.suggestions.length
          ? html`<div class="zen-library-group whimsy-routines-group" data-group="suggested">
              <h3 data-l10n-id="whimsy-library-routines-suggested"></h3>
              ${this.suggestions.map(s => this.#suggestionRow(s))}
            </div>`
          : nothing}
        <div class="zen-library-group whimsy-routines-group" data-group="builtin">
          <h3 data-l10n-id="whimsy-library-routines-builtin"></h3>
          ${builtIns.map(b => this.#builtInRow(b))}
        </div>
      `;
    }
    const used = new Set(routines.map(r => r.builtIn).filter(Boolean));
    const unused = builtIns.filter(b => !used.has(b.builtIn));
    const shownRoutines = routines.filter(match);
    const shownWatches = watches.filter(match);
    if (query && !shownRoutines.length && !shownWatches.length) {
      return html`<div class="zen-library-empty" data-l10n-id="whimsy-library-routines-no-results"></div>`;
    }
    return html`
      ${shownRoutines.length
        ? html`<div class="zen-library-group whimsy-routines-group" data-group="routines">
            <h3 data-l10n-id="whimsy-library-routines-group-routines"></h3>
            ${repeat(shownRoutines, r => r.id, r => this.#row(r))}
          </div>`
        : nothing}
      ${shownWatches.length
        ? html`<div class="zen-library-group whimsy-routines-group" data-group="watches">
            <h3>
              <span data-l10n-id="whimsy-library-routines-group-watches"></span>
              <span class="whimsy-routines-count" data-l10n-id="whimsy-library-routines-watch-count"
                data-l10n-args=${JSON.stringify({ count: watches.length, max: lazy.MAX_WATCHES })}></span>
            </h3>
            ${repeat(shownWatches, r => r.id, r => this.#row(r))}
          </div>`
        : nothing}
      ${!query && unused.length
        ? html`
            <button class="whimsy-routines-more" aria-expanded=${this.moreOpen ? "true" : "false"}
              @click=${() => (this.moreOpen = !this.moreOpen)}>
              <img src="chrome://browser/skin/zen-icons/arrow-right.svg" alt="" />
              <span data-l10n-id=${this.moreOpen ? "whimsy-library-routines-fewer" : "whimsy-library-routines-more"}
                data-l10n-args=${JSON.stringify({ count: unused.length })}></span>
            </button>
            ${this.moreOpen ? html`<div class="whimsy-routines-more-list">${unused.map(b => this.#builtInRow(b))}</div>` : nothing}
          `
        : nothing}
    `;
  }
}

customElements.define("whimsy-library-routines-section", WhimsyRoutinesSection);
