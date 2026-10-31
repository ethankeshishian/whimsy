/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// batch hist: keep Zen's History rows, actions, search, and filter panel.
//
// System pass: History is the one place for tabs and pages you left. Its
// "Show" filter picks:
// - All: every page you visited (Zen's History, plus "Where was the tab?").
// - Closed: the Archive (Arc): tabs that left your sidebar, one row per tab,
//   newest first, each with why it left (unused, closed, closed with its
//   branch, snoozed, burned) and the space it goes back to. Click (or Enter)
//   restores it into its space; Cmd-click restores it in the background;
//   the trash (or Delete) forgets it. Rows come from SessionStore's closed
//   tabs (WhimsyArchive.listEntries).
// - Snoozed: tabs waiting to come back (WhimsySnooze), soonest first, each
//   with its wake time. Click (or Enter) wakes it now; the cancel button
//   (or Delete) cancels the snooze and leaves it in Closed.
// "View Archive…" and "View Snoozed Tabs…" open History on those filters
// (WhimsyLibrarySection.openHistory).

import { html, repeat } from "chrome://global/content/vendor/lit.all.mjs";
import { ZenLibraryHistorySection } from "moz-src:///zen/library/sections/ZenLibraryHistorySection.mjs";
import { whenFilterGroup, MS_PER_DAY } from "moz-src:///zen/library/sections/ZenLibrarySearchSection.mjs";
const { WhimsySpaceHistory } = ChromeUtils.importESModule(
  "resource:///modules/whimsy/WhimsySpaceHistory.sys.mjs"
);
const { WhimsyProfiles } = ChromeUtils.importESModule(
  "resource:///modules/whimsy/WhimsyProfiles.sys.mjs"
);
const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  WhimsyArchive: "resource:///modules/whimsy/WhimsyArchive.sys.mjs",
  WhimsySnooze: "resource:///modules/whimsy/WhimsySnooze.sys.mjs",
});

const VIEW_PREF = "whimsy.library.history.view";
const VIEWS = ["all", "closed", "snoozed"];
const CLOSED_OBJECTS_TOPIC = "sessionstore-closed-objects-changed";
const SNOOZE_TOPIC = "whimsy-snooze-changed";
const IDLE_PREF = "whimsy.tabs.archive.idle-after";
const SWEEP_PREF = "whimsy.feature.auto-archive-tabs";
const ARCHIVE_FEATURE = "whimsy.feature.archive-view";
const SNOOZE_FEATURE = "whimsy.feature.snooze-tab";
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

export class WhimsySpaceHistorySection extends ZenLibraryHistorySection {
  // WhimsyLibrarySection.openHistory checks for this.
  static whimsyHistory = true;

  static render(library) {
    return html`<whimsy-space-history-section class="zen-library-section"
      data-section="history" .library=${library}></whimsy-space-history-section>`;
  }

  // fixB: with Whimsy's Closed filter, Zen's "Closed tabs" source (which
  // relabels this tab "Archive") would be a second Archive. History stays
  // History; closed tabs live under Show → Closed.
  static get archiveSection() {
    return Services.prefs.getBoolPref(ARCHIVE_FEATURE, true);
  }
  static get snoozeSection() {
    return Services.prefs.getBoolPref(SNOOZE_FEATURE, true);
  }
  static get tabLabel() {
    return this.archiveSection ? this.label : super.tabLabel;
  }

  constructor() {
    super();
    if (WhimsySpaceHistorySection.archiveSection && this.activeFilters.has("source:closed")) {
      this.activeFilters.delete("source:closed");
      this.activeFilters.add("source:history");
    }
    const saved = Services.prefs.getStringPref(VIEW_PREF, "all");
    this.activeFilters.add(`show:${this.#viewAvailable(saved) ? saved : "all"}`);
    this._whimsyItems = [];
    this._shownView = this.whimsyView || "all";
  }

  #viewAvailable(view) {
    return (
      view == "all" ||
      (view == "closed" && WhimsySpaceHistorySection.archiveSection) ||
      (view == "snoozed" && WhimsySpaceHistorySection.snoozeSection)
    );
  }

  // "closed", "snoozed", or null for All (Zen's History).
  get whimsyView() {
    const view = VIEWS.find(id => this.isFilterActive("show", id));
    return view && view != "all" && this.#viewAvailable(view) ? view : null;
  }

  // Called by WhimsyLibrarySection.openHistory on an already-built History.
  setWhimsyView(view) {
    if (!this.#viewAvailable(view)) {
      view = "all";
    }
    for (const id of VIEWS) {
      this.activeFilters.delete(`show:${id}`);
    }
    this.activeFilters.add(`show:${view}`);
    this.requestUpdate();
    this.onFiltersChanged();
  }

  get #showGroup() {
    const options = [{ id: "all", l10nId: "whimsy-history-show-all" }];
    if (WhimsySpaceHistorySection.archiveSection) {
      options.push({ id: "closed", l10nId: "whimsy-history-show-closed" });
    }
    if (WhimsySpaceHistorySection.snoozeSection) {
      options.push({ id: "snoozed", l10nId: "whimsy-history-show-snoozed" });
    }
    return options.length > 1
      ? { id: "show", titleL10nId: "whimsy-history-show-filter", exclusive: true, options }
      : null;
  }

  get filterGroups() {
    const view = this.whimsyView;
    let groups;
    if (view == "snoozed") {
      groups = [];
    } else if (view == "closed") {
      groups = [
        whenFilterGroup("whimsy-history-closed-when"),
        {
          id: "reason",
          titleL10nId: "whimsy-library-archive-filter-reason",
          exclusive: true,
          options: REASONS.map(id => ({ id, l10nId: `whimsy-library-archive-reason-${id}` })),
        },
      ];
    } else {
      const base = super.filterGroups;
      groups = WhimsySpaceHistorySection.archiveSection ? base.filter(group => group.id !== "source") : base;
    }
    const show = this.#showGroup;
    if (show) {
      groups.unshift(show);
    }
    if (this.spaceMode || (view && this._spaceOptions?.length)) {
      groups.push({
        id: "space",
        titleL10nId: "whimsy-history-space-filter",
        exclusive: true,
        options: [
          // wave7/folders: no "Unknown space" choice. A visit whose space
          // couldn't be resolved shows under All spaces, unlabeled.
          { id: "all", l10nId: "whimsy-history-all-spaces" },
          ...(this._spaceOptions || []).map(([id, label, l10nId]) =>
            l10nId ? { id, label, l10nId } : { id, label }
          ),
        ],
      });
    }
    // wave5/profiles: the current profile's history by default (Arc).
    if (this.spaceMode && WhimsyProfiles.enabled) {
      groups.push({
        id: "profile",
        titleL10nId: "whimsy-history-profile-filter",
        exclusive: true,
        options: [
          { id: "current", l10nId: "whimsy-history-this-profile" },
          { id: "all", l10nId: "whimsy-history-all-profiles" },
        ],
      });
    }
    return groups;
  }

  get searchPlaceholderL10nId() {
    const view = this.whimsyView;
    return view ? `whimsy-history-search-${view}` : super.searchPlaceholderL10nId;
  }

  get spaceMode() {
    return WhimsySpaceHistory.enabled && !this.whimsyView && !this.isFilterActive("source", "closed");
  }

  // Zen's private fetch still runs for its Closed Tabs view. Keep that data
  // separately so a late native fetch cannot overwrite space-filtered visits.
  get visits() {
    return this.spaceMode ? this._spaceVisits ?? null : this._nativeVisits;
  }
  set visits(value) {
    this._nativeVisits = value;
    this.requestUpdate();
    // Zen's Places observer also reports title changes. Refresh the sidecar
    // query when that native result changes, so row titles stay current.
    if (this._observer && this.isConnected && this.spaceMode) {
      this.refresh().catch(console.error);
    }
  }

  connectedCallback() {
    this.activeFilters.add("space:all");
    this.activeFilters.add("profile:current");
    this._spaceLimit = 100;
    this._generation = 0;
    this._spaceOptions = [];
    this._observer = () => this.refresh().catch(console.error);
    // Closed and Snoozed change with every tab close; only refetch them
    // while one of them is showing.
    this._whimsyObserver = () => {
      if (this.whimsyView) {
        this.refresh().catch(console.error);
      }
    };
    Services.obs.addObserver(this._observer, "whimsy-space-history-changed");
    Services.obs.addObserver(this._whimsyObserver, CLOSED_OBJECTS_TOPIC);
    Services.obs.addObserver(this._whimsyObserver, SNOOZE_TOPIC);
    for (const pref of ["whimsy.feature.space-history", ARCHIVE_FEATURE, SNOOZE_FEATURE]) {
      Services.prefs.addObserver(pref, this._observer);
    }
    for (const pref of [IDLE_PREF, SWEEP_PREF]) {
      Services.prefs.addObserver(pref, this._whimsyObserver);
    }
    super.connectedCallback();
    this.refresh().catch(console.error);
  }

  disconnectedCallback() {
    ++this._generation;
    Services.obs.removeObserver(this._observer, "whimsy-space-history-changed");
    Services.obs.removeObserver(this._whimsyObserver, CLOSED_OBJECTS_TOPIC);
    Services.obs.removeObserver(this._whimsyObserver, SNOOZE_TOPIC);
    for (const pref of ["whimsy.feature.space-history", ARCHIVE_FEATURE, SNOOZE_FEATURE]) {
      Services.prefs.removeObserver(pref, this._observer);
    }
    for (const pref of [IDLE_PREF, SWEEP_PREF]) {
      Services.prefs.removeObserver(pref, this._whimsyObserver);
    }
    super.disconnectedCallback();
  }

  onSearchChanged() {
    // The sidecar owns the visible results. Do not start a second Places
    // search whose completion can trigger another refresh of this query.
    if (!this.spaceMode && !this.whimsyView) {
      super.onSearchChanged();
      return;
    }
    this._spaceLimit = 100;
    this.refresh().catch(console.error);
  }
  onFiltersChanged() {
    // Show always has exactly one choice; turning the current one off goes
    // back to All.
    if (this.#showGroup && !VIEWS.some(id => this.isFilterActive("show", id))) {
      this.activeFilters.add("show:all");
      this.requestUpdate();
    }
    const view = this.whimsyView || "all";
    if (view != this._shownView) {
      if (this._shownView) {
        // A different list: a space picked for the last one may not exist here.
        for (const [id] of this._spaceOptions || []) {
          this.activeFilters.delete(`space:${id}`);
        }
        this.activeFilters.add("space:all");
      }
      this._shownView = view;
      Services.prefs.setStringPref(VIEW_PREF, view);
    }
    super.onFiltersChanged();
    this._spaceLimit = 100;
    this.refresh().catch(console.error);
  }
  onListScrolledToEnd() {
    if (this.whimsyView) {
      return;
    }
    if (!this.spaceMode) {
      super.onListScrolledToEnd();
      return;
    }
    if (!this._spaceExhausted && !this._spaceLoading) {
      this._spaceLimit += 100;
      this.refresh().catch(console.error);
    }
  }

  // Resolves once the view shows the newest query: a refresh superseded by a
  // later one (a filter change or a Places notification) waits for that one.
  async refresh() {
    let run = this._refreshNow();
    this._latestRefresh = run;
    await run;
    while (this._latestRefresh !== run) {
      run = this._latestRefresh;
      await run;
    }
  }

  get win() {
    return this.ownerDocument.defaultView;
  }

  // The filter panel's height follows its groups (Show changes them).
  async _fitFilterPanel(generation) {
    await this.updateComplete;
    if (this.filtersOpen && this.isConnected && generation === this._generation) {
      const inner = this.querySelector(".zen-library-filter-panel-inner");
      if (inner) {
        this.style.setProperty("--zen-library-filter-height", `${inner.scrollHeight + 8}px`);
      }
    }
  }

  // The filter lists spaces in the user's own order (Zen's space strip);
  // spaces that only live on in older visits follow, by name.
  #orderSpaces(options) {
    const order = (this.win.gZenWorkspaces?.getWorkspaces() || []).map(space => space.uuid);
    const rank = id => {
      const index = order.indexOf(id);
      return index === -1 ? Infinity : index;
    };
    return [...options].sort((a, b) =>
      rank(a[0]) - rank(b[0]) || (rank(a[0]) === Infinity ? a[1].localeCompare(b[1]) : 0));
  }

  #spaceName(id) {
    if (!id) {
      return "";
    }
    try {
      return this.win.gZenWorkspaces?.getWorkspaceFromId?.(id)?.name || "";
    } catch (e) {
      return "";
    }
  }

  async _refreshWhimsyView(view, generation) {
    let items = [];
    try {
      if (view == "closed") {
        items = lazy.WhimsyArchive.listEntries(this.win, { query: this.searchQuery });
      } else {
        const query = (this.searchQuery || "").toLowerCase();
        items = (await lazy.WhimsySnooze.list()).filter(
          record =>
            !query ||
            (record.title || "").toLowerCase().includes(query) ||
            (record.url || "").toLowerCase().includes(query)
        );
      }
    } catch (e) {
      console.error(`Whimsy: History ${view}`, e);
    }
    if (!this.isConnected || generation !== this._generation) {
      return;
    }
    const options = new Map();
    const activeSpaces = (this.documentGlobal.gZenWorkspaces?.getWorkspaces() || [])
      .filter(s => !s.whimsyScratch);
    const activeIds = new Set(activeSpaces.map(s => s.uuid));
    let hasDeleted = false;
    for (const item of items) {
      if (item.zenWorkspace) {
        if (activeIds.has(item.zenWorkspace)) {
          const name = this.#spaceName(item.zenWorkspace);
          if (name) {
            options.set(item.zenWorkspace, name);
          }
        } else {
          hasDeleted = true;
        }
      }
    }
    const ordered = this.#orderSpaces(options);
    if (hasDeleted) {
      ordered.push(["deleted", "Deleted spaces", "whimsy-history-deleted-spaces"]);
    }
    this._spaceOptions = ordered;
    this._whimsyItems = items;
    this._whimsyItemsView = view;
    this.requestUpdate();
    await this._fitFilterPanel(generation);
  }

  async _refreshNow() {
    const generation = ++this._generation;
    const view = this.whimsyView;
    if (view) {
      await this._refreshWhimsyView(view, generation);
      return;
    }
    if (!this.spaceMode) {
      this.requestUpdate();
      await this._fitFilterPanel(generation);
      return;
    }
    this._spaceLoading = true;
    try {
      const sort = ["date", "site", "mostvisited", "lastvisited"].find(
        id => this.isFilterActive("sort", id)) || "date";
      // wave7/folders: no "Unknown space" choice; an unresolved visit's
      // spaceId is left out of the filter, so it shows under All spaces.
      const spaceId = this._spaceOptions?.find(([id]) => this.isFilterActive("space", id))?.[0] || "";
      const profile = WhimsyProfiles.enabled && !this.isFilterActive("profile", "all") ?
        WhimsyProfiles.keyFor(WhimsyProfiles.activeProfileId(this.documentGlobal)) : "";
      const activeSpaces = (this.documentGlobal.gZenWorkspaces?.getWorkspaces() || [])
        .filter(s => !s.whimsyScratch)
        .map(s => s.uuid);
      const visits = await WhimsySpaceHistory.query({ spaceId, profile,
        activeSpaces,
        search: this.searchQuery, days: this.activeWhenDays ?? 120,
        sort, limit: this._spaceLimit });
      const file = await WhimsySpaceHistory.file();
      if (!this.isConnected || generation !== this._generation) {
        return;
      }
      const activeIds = new Set(activeSpaces);
      const options = new Map();
      let hasDeleted = false;
      for (const visit of Object.values(file.data.visits)) {
        if (visit.spaceId) {
          if (!activeIds.has(visit.spaceId)) {
            hasDeleted = true;
          }
        }
      }
      for (const space of this.documentGlobal.gZenWorkspaces?.getWorkspaces() || []) {
        if (!space.whimsyScratch) {
          // The dropdown uses today's name; each row keeps its visit-time name.
          options.set(space.uuid, space.name);
        }
      }
      const ordered = this.#orderSpaces(options);
      if (hasDeleted) {
        ordered.push(["deleted", "Deleted spaces", "whimsy-history-deleted-spaces"]);
      }
      this._spaceOptions = ordered;
      this._flatVisits = visits;
      this._spaceExhausted = visits.length < this._spaceLimit;
      if (this.searchQuery || ["mostvisited", "lastvisited"].includes(sort)) {
        this._spaceVisits = visits;
      } else {
        const groups = new Map();
        for (const visit of visits) {
          const key = sort === "site" ? (URL.parse(visit.url)?.hostname || "") :
            new Date(visit.date).setHours(0, 0, 0, 0);
          if (!groups.has(key)) {
            groups.set(key, []);
          }
          groups.get(key).push(visit);
        }
        this._spaceVisits = sort === "site" ?
          new Map([...groups].sort(([a], [b]) => a.localeCompare(b))) : groups;
        this._flatVisits = [...this._spaceVisits.values()].flat();
      }
      this.requestUpdate();
      await this._fitFilterPanel(generation);
    } finally {
      if (generation === this._generation) {
        this._spaceLoading = false;
      }
    }
  }

  // The space picked in "Where was the tab?" for Closed or Snoozed, or "".
  get #pickedSpace() {
    return (this._spaceOptions || []).find(([id]) => this.isFilterActive("space", id))?.[0] || "";
  }

  get #filtering() {
    return (
      !!this.searchQuery ||
      !!this.#pickedSpace ||
      (this.whimsyView == "closed" &&
        (this.activeWhenDays != null || REASONS.some(id => this.isFilterActive("reason", id))))
    );
  }

  get #visibleItems() {
    const space = this.#pickedSpace;
    // Switching between Closed and Snoozed renders before the new list has
    // loaded: never draw one view's items (closed tabs have no wake time)
    // as the other's.
    let items = this._whimsyItemsView == this.whimsyView ? this._whimsyItems || [] : [];
    if (space) {
      if (space === "deleted") {
        const activeIds = new Set((this.win.gZenWorkspaces?.getWorkspaces() || []).map(s => s.uuid));
        items = items.filter(item => item.zenWorkspace && !activeIds.has(item.zenWorkspace));
      } else {
        items = items.filter(item => item.zenWorkspace == space);
      }
    }
    if (this.whimsyView != "closed") {
      return items;
    }
    const days = this.activeWhenDays;
    const since = days ? startOfDay(Date.now()) - (days - 1) * MS_PER_DAY : 0;
    const reason = REASONS.find(id => this.isFilterActive("reason", id));
    return items.filter(entry => entry.closedAt >= since && (!reason || reasonOf(entry) == reason));
  }

  // --- Closed (the Archive) ---

  #restore(entry, event) {
    const background = !!event && (event.getModifierState?.("Accel") || event.button === 1);
    const restore = () => lazy.WhimsyArchive.restore(this.win, entry.closedId, { select: !background });
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
    lazy.WhimsyArchive.forget(this.win, entry.closedId);
    this.refresh().catch(console.error);
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

  #renderClosedRow(entry) {
    const reason = reasonOf(entry);
    const space = this.#spaceName(entry.zenWorkspace);
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

  #renderClosed() {
    const entries = this.#visibleItems;
    const filtering = this.#filtering;
    if (!entries.length) {
      return html`
        ${filtering ? "" : this.#renderIntro()}
        <div
          class="zen-library-empty"
          data-l10n-id=${filtering ? "whimsy-library-archive-no-match" : "whimsy-library-archive-empty"}
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
            ${repeat(dayEntries, entry => entry.closedId, entry => this.#renderClosedRow(entry))}
          </div>
        `
      )}
    `;
  }

  // --- Snoozed ---

  #wakeArgs(wakeAt) {
    const today = startOfDay(Date.now());
    const day = startOfDay(wakeAt);
    const tomorrow = startOfDay(today + MS_PER_DAY * 1.5);
    return {
      when: day <= today ? "today" : day == tomorrow ? "tomorrow" : "later",
      time: timeFormat.format(new Date(wakeAt)),
      day: dayFormat.format(new Date(wakeAt)),
    };
  }

  #wakeNow(record) {
    lazy.WhimsySnooze.wakeNow(this.win, record);
    this.library.constructor.toggle();
  }

  #cancelSnooze(record) {
    lazy.WhimsySnooze.cancelSnooze(this.win, record);
  }

  #renderSnoozedRow(record) {
    const space = this.#spaceName(record.zenWorkspace);
    return html`
      <div
        class="zen-library-row whimsy-snoozed-row"
        tabindex="0"
        role="button"
        data-wake-at=${record.wakeAt}
        @click=${() => this.#wakeNow(record)}
        @keydown=${event => {
          if (event.key == "Enter" || event.key == " ") {
            event.preventDefault();
            this.#wakeNow(record);
          } else if (event.key == "Delete" || event.key == "Backspace") {
            event.preventDefault();
            this.#cancelSnooze(record);
          }
        }}
      >
        <img class="zen-library-row-icon" src=${`page-icon:${record.url}`} decoding="async" alt="" />
        <div class="zen-library-row-text">
          <span class="zen-library-row-title">${record.title || record.url}</span>
          <span class="zen-library-row-subtitle"
            ><span
              class="whimsy-snoozed-wake"
              data-l10n-id="whimsy-history-snoozed-wakes"
              data-l10n-args=${JSON.stringify(this.#wakeArgs(record.wakeAt))}
            ></span
            >${
              space
                ? html`<span
                    class="whimsy-archive-space"
                    data-l10n-id="whimsy-library-archive-in-space"
                    data-l10n-args=${JSON.stringify({ space })}
                  ></span>`
                : ""
            }</span
          >
        </div>
        <div class="zen-library-row-actions">
          <toolbarbutton
            class="toolbarbutton-1 whimsy-snoozed-cancel"
            data-l10n-id="whimsy-history-snoozed-cancel"
            @click=${event => {
              event.stopPropagation();
              this.#cancelSnooze(record);
            }}
          >
            <img class="toolbarbutton-icon" src="chrome://browser/skin/zen-icons/close.svg" alt="" />
          </toolbarbutton>
          <toolbarbutton
            class="toolbarbutton-1 whimsy-snoozed-wake-now"
            data-l10n-id="whimsy-history-snoozed-wake"
            @click=${event => {
              event.stopPropagation();
              this.#wakeNow(record);
            }}
          >
            <img class="toolbarbutton-icon" src="chrome://browser/skin/zen-icons/face-sun.svg" alt="" />
          </toolbarbutton>
        </div>
      </div>
    `;
  }

  #renderSnoozed() {
    const records = this.#visibleItems;
    if (!records.length) {
      return html`<div
        class="zen-library-empty"
        data-l10n-id=${this.#filtering ? "whimsy-history-snoozed-no-match" : "whimsy-history-snoozed-empty"}
      ></div>`;
    }
    return html`
      <div class="zen-library-group">
        ${repeat(
          records,
          record => `${record.closedId}:${record.wakeAt}:${record.url}`,
          record => this.#renderSnoozedRow(record)
        )}
      </div>
    `;
  }

  renderItems() {
    const view = this.whimsyView;
    if (view == "closed") {
      return this.#renderClosed();
    }
    if (view == "snoozed") {
      return this.#renderSnoozed();
    }
    return super.renderItems();
  }

  updated(changed) {
    super.updated(changed);
    if (this.whimsyView) {
      return;
    }
    const rows = this.querySelectorAll(".zen-library-row");
    for (const [index, row] of [...rows].entries()) {
      let label = row.querySelector(".whimsy-history-space-name");
      if (!this.spaceMode) {
        label?.remove();
        continue;
      }
      const visit = row.whimsyVisit || this._flatVisits?.[index];
      if (!visit?.spaceId || !visit.spaceName) {
        label?.remove();
        continue;
      }
      if (!label) {
        label = this.ownerDocument.createElement("span");
        label.className = "whimsy-history-space-name zen-library-row-subtitle";
        row.querySelector(".zen-library-row-text").appendChild(label);
      }
      this.ownerDocument.l10n.setAttributes(label, "whimsy-history-where", {
        space: visit.spaceName,
      });
    }
  }
}

customElements.define("whimsy-space-history-section", WhimsySpaceHistorySection);
