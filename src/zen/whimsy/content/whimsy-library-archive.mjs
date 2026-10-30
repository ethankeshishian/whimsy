/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// fixB: the Archive, as a Library section beside History.
//
// Why it exists (Arc's Archive): Arc tidies the sidebar for you, archiving
// tabs you haven't touched in 12 hours, and anything you close goes there
// too, so a space always looks the way you left it and nothing is lost.
// That is different from History: History is every page you ever visited
// (each navigation, forever, by site); the Archive is the tabs that left
// your sidebar (one row per tab, newest first, for a while), each with why
// it left and the space it goes back to. Putting it in the Library next to
// History, in the same rows and search, makes that difference something
// you can see: same place, different question.
//
// The rows come from SessionStore's closed tabs (WhimsyArchive.listEntries),
// tagged with why each left: archived after going unused, closed, closed
// with its branch, snoozed, or burned by the Fire button. Click (or Enter)
// restores the tab into its space; Cmd-click restores it in the
// background; the trash (or Delete) forgets it.

import { html, repeat } from "chrome://global/content/vendor/lit.all.mjs";
import {
  ZenLibrarySearchSection,
  whenFilterGroup,
  MS_PER_DAY,
} from "moz-src:///zen/library/sections/ZenLibrarySearchSection.mjs";

const { WhimsyArchive } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyArchive.sys.mjs");
const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  SessionStore: "moz-src:///browser/components/sessionstore/SessionStore.sys.mjs",
});

const CLOSED_OBJECTS_TOPIC = "sessionstore-closed-objects-changed";
const IDLE_PREF = "whimsy.tabs.archive.idle-after";
const SWEEP_PREF = "whimsy.feature.auto-archive-tabs";
// Fluent variant keys can't start with a digit.
const IDLE_KEYS = { "12h": "h12", "24h": "h24", "7d": "d7", "30d": "d30" };
const REASONS = ["idle", "closed", "tree", "snooze", "fire"];

function reasonOf(entry) {
  return entry.reason == "manual" ? "closed" : REASONS.includes(entry.reason) ? entry.reason : "closed";
}

function startOfDay(time) {
  const day = new Date(time);
  day.setHours(0, 0, 0, 0);
  return day.getTime();
}

const timeFormat = new Intl.DateTimeFormat(undefined, { timeStyle: "short" });
const dayFormat = new Intl.DateTimeFormat(undefined, { weekday: "long", month: "long", day: "numeric" });

export class WhimsyArchiveSection extends ZenLibrarySearchSection {
  static id = "whimsy-archive";
  static label = "whimsy-library-archive-title";

  static render(library) {
    return html`
      <whimsy-library-archive-section
        class="zen-library-section"
        data-section="whimsy-archive"
        .library=${library}
      ></whimsy-library-archive-section>
    `;
  }

  static properties = {
    entries: { state: true },
  };

  constructor() {
    super();
    this.entries = [];
    this._observer = () => this.refresh();
  }

  connectedCallback() {
    super.connectedCallback();
    Services.obs.addObserver(this._observer, CLOSED_OBJECTS_TOPIC);
    Services.prefs.addObserver(IDLE_PREF, this._observer);
    Services.prefs.addObserver(SWEEP_PREF, this._observer);
    this.refresh();
  }

  disconnectedCallback() {
    Services.obs.removeObserver(this._observer, CLOSED_OBJECTS_TOPIC);
    Services.prefs.removeObserver(IDLE_PREF, this._observer);
    Services.prefs.removeObserver(SWEEP_PREF, this._observer);
    super.disconnectedCallback();
  }

  get win() {
    return this.ownerDocument.defaultView;
  }

  refresh() {
    try {
      this.entries = WhimsyArchive.listEntries(this.win, { query: this.searchQuery });
    } catch (e) {
      console.error("Whimsy: archive list", e);
      this.entries = [];
    }
  }

  get searchPlaceholderL10nId() {
    return "whimsy-library-archive-search";
  }

  get filterGroups() {
    return [
      whenFilterGroup("library-history-filter-when"),
      {
        id: "reason",
        titleL10nId: "whimsy-library-archive-filter-reason",
        exclusive: true,
        options: REASONS.map(id => ({ id, l10nId: `whimsy-library-archive-reason-${id}` })),
      },
    ];
  }

  onSearchChanged() {
    this.refresh();
  }

  onFiltersChanged() {
    this.requestUpdate();
  }

  get #visibleEntries() {
    const days = this.activeWhenDays;
    const since = days ? startOfDay(Date.now()) - (days - 1) * MS_PER_DAY : 0;
    const reason = REASONS.find(id => this.isFilterActive("reason", id));
    return this.entries.filter(
      entry => entry.closedAt >= since && (!reason || reasonOf(entry) == reason)
    );
  }

  #spaceName(entry) {
    if (!entry.zenWorkspace) {
      return "";
    }
    try {
      return this.win.gZenWorkspaces?.getWorkspaceFromId?.(entry.zenWorkspace)?.name || "";
    } catch (e) {
      return "";
    }
  }

  #restore(entry, event) {
    const background = !!event && (event.getModifierState?.("Accel") || event.button === 1);
    const restore = () => WhimsyArchive.restore(this.win, entry.closedId, { select: !background });
    if (background) {
      if (this.library.keepOpenWhile) {
        this.library.keepOpenWhile(restore);
      } else {
        restore();
      }
      return;
    }
    restore();
    this.library.constructor.toggle();
  }

  #forget(entry) {
    WhimsyArchive.forget(this.win, entry.closedId);
    this.refresh();
  }

  #renderIntro() {
    const sweeping = Services.prefs.getBoolPref(SWEEP_PREF, true);
    const after = Services.prefs.getStringPref(IDLE_PREF, "12h");
    const idleKey = IDLE_KEYS[after];
    return html`
      <div class="whimsy-archive-intro">
        <p data-l10n-id="whimsy-library-archive-intro"></p>
        ${
          sweeping && idleKey
            ? html`<p
                data-l10n-id="whimsy-library-archive-intro-idle"
                data-l10n-args=${JSON.stringify({ after: idleKey })}
              ></p>`
            : html`<p data-l10n-id="whimsy-library-archive-intro-manual"></p>`
        }
      </div>
    `;
  }

  #renderRow(entry) {
    const reason = reasonOf(entry);
    const space = this.#spaceName(entry);
    return html`
      <div
        class="zen-library-row whimsy-archive-row"
        tabindex="0"
        role="button"
        data-closed-id=${entry.closedId}
        @click=${event => this.#restore(entry, event)}
        @auxclick=${event => {
          if (event.button === 1) {
            event.preventDefault();
            this.#restore(entry, event);
          }
        }}
        @keydown=${event => {
          if (event.key == "Enter" || event.key == " ") {
            event.preventDefault();
            this.#restore(entry, event);
          } else if (event.key == "Delete" || event.key == "Backspace") {
            event.preventDefault();
            this.#forget(entry);
          }
        }}
      >
        <img
          class="zen-library-row-icon"
          src=${entry.image || `page-icon:${entry.url}`}
          decoding="async"
          alt=""
        />
        <div class="zen-library-row-text">
          <span class="zen-library-row-title">${entry.title || entry.url}</span>
          <span class="zen-library-row-subtitle"
            ><span
              class="whimsy-archive-reason"
              data-reason=${reason}
              data-l10n-id=${`whimsy-library-archive-reason-${reason}`}
            ></span
            >${
              space
                ? html`<span
                    class="whimsy-archive-space"
                    data-l10n-id="whimsy-library-archive-in-space"
                    data-l10n-args=${JSON.stringify({ space })}
                  ></span>`
                : ""
            }<span class="whimsy-archive-time">${timeFormat.format(new Date(entry.closedAt))}</span></span
          >
        </div>
        <div class="zen-library-row-actions">
          <toolbarbutton
            class="toolbarbutton-1"
            data-l10n-id="whimsy-library-archive-forget"
            @click=${event => {
              event.stopPropagation();
              this.#forget(entry);
            }}
          >
            <img class="toolbarbutton-icon" src="chrome://browser/skin/zen-icons/trash.svg" alt="" />
          </toolbarbutton>
          <toolbarbutton
            class="toolbarbutton-1"
            data-l10n-id="whimsy-library-archive-restore"
            @click=${event => {
              event.stopPropagation();
              this.#restore(entry, event);
            }}
          >
            <img class="toolbarbutton-icon" src="chrome://browser/skin/zen-icons/u-turn-to-left.svg" alt="" />
          </toolbarbutton>
        </div>
      </div>
    `;
  }

  #dayHeading(dayStart) {
    const today = startOfDay(Date.now());
    if (dayStart == today) {
      return html`<h3 data-l10n-id="whimsy-library-archive-today"></h3>`;
    }
    if (dayStart == today - MS_PER_DAY) {
      return html`<h3 data-l10n-id="whimsy-library-archive-yesterday"></h3>`;
    }
    return html`<h3>${dayFormat.format(new Date(dayStart))}</h3>`;
  }

  renderItems() {
    const entries = this.#visibleEntries;
    if (!entries.length) {
      return html`
        ${this.searchQuery || this.activeFilters.size ? "" : this.#renderIntro()}
        <div
          class="zen-library-empty"
          data-l10n-id=${
            this.searchQuery || this.activeFilters.size
              ? "whimsy-library-archive-no-match"
              : "whimsy-library-archive-empty"
          }
        ></div>
      `;
    }
    const days = new Map();
    for (const entry of entries) {
      const key = startOfDay(entry.closedAt);
      if (!days.has(key)) {
        days.set(key, []);
      }
      days.get(key).push(entry);
    }
    return html`
      ${this.searchQuery ? "" : this.#renderIntro()}
      ${repeat(
        days.entries(),
        ([key]) => key,
        ([key, dayEntries]) => html`
          <div class="zen-library-group">
            ${this.#dayHeading(key)}
            ${repeat(dayEntries, entry => entry.closedId, entry => this.#renderRow(entry))}
          </div>
        `
      )}
    `;
  }
}

customElements.define("whimsy-library-archive-section", WhimsyArchiveSection);
