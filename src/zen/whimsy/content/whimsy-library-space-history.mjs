/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// batch hist: keep Zen's History rows, actions, search, and filter panel.
import { html } from "chrome://global/content/vendor/lit.all.mjs";
import { ZenLibraryHistorySection } from "moz-src:///zen/library/sections/ZenLibraryHistorySection.mjs";
const { WhimsySpaceHistory } = ChromeUtils.importESModule(
  "resource:///modules/whimsy/WhimsySpaceHistory.sys.mjs"
);

export class WhimsySpaceHistorySection extends ZenLibraryHistorySection {
  static render(library) {
    return html`<whimsy-space-history-section class="zen-library-section"
      data-section="history" .library=${library}></whimsy-space-history-section>`;
  }

  // fixB: with Whimsy's Archive section beside History, Zen's "Closed
  // tabs" source (which relabels this tab "Archive") would be a second
  // Archive. History stays history; closed tabs live in the Archive.
  static get archiveSection() {
    return Services.prefs.getBoolPref("whimsy.feature.archive-view", true);
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
  }
  get filterGroups() {
    const groups = super.filterGroups;
    const visible = WhimsySpaceHistorySection.archiveSection ?
      groups.filter(group => group.id !== "source") : groups;
    if (this.spaceMode) {
      visible.push({
        id: "space",
        titleL10nId: "whimsy-history-space-filter",
        exclusive: true,
        options: [
          { id: "all", l10nId: "whimsy-history-all-spaces" },
          ...(this._spaceOptions || []).map(([id, label]) => ({ id, label })),
        ],
      });
    }
    return visible;
  }

  get spaceMode() {
    return WhimsySpaceHistory.enabled && !this.isFilterActive("source", "closed");
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
    this._spaceLimit = 100;
    this._generation = 0;
    this._spaceOptions = [];
    this._observer = () => this.refresh().catch(console.error);
    Services.obs.addObserver(this._observer, "whimsy-space-history-changed");
    Services.prefs.addObserver("whimsy.feature.space-history", this._observer);
    super.connectedCallback();
    this.refresh().catch(console.error);
  }

  disconnectedCallback() {
    ++this._generation;
    Services.obs.removeObserver(this._observer, "whimsy-space-history-changed");
    Services.prefs.removeObserver("whimsy.feature.space-history", this._observer);
    super.disconnectedCallback();
  }

  onSearchChanged() {
    // The sidecar owns the visible results. Do not start a second Places
    // search whose completion can trigger another refresh of this query.
    if (!this.spaceMode) {
      super.onSearchChanged();
      return;
    }
    this._spaceLimit = 100;
    this.refresh().catch(console.error);
  }
  onFiltersChanged() {
    super.onFiltersChanged();
    this._spaceLimit = 100;
    this.refresh().catch(console.error);
  }
  onListScrolledToEnd() {
    if (!this.spaceMode) {
      super.onListScrolledToEnd();
      return;
    }
    if (!this._spaceExhausted && !this._spaceLoading) {
      this._spaceLimit += 100;
      this.refresh().catch(console.error);
    }
  }

  async refresh() {
    const generation = ++this._generation;
    if (!this.spaceMode) {
      this.requestUpdate();
      return;
    }
    this._spaceLoading = true;
    try {
      const sort = ["date", "site", "mostvisited", "lastvisited"].find(
        id => this.isFilterActive("sort", id)) || "date";
      const spaceId = this._spaceOptions.find(([id]) => this.isFilterActive("space", id))?.[0] || "";
      const visits = await WhimsySpaceHistory.query({ spaceId,
        search: this.searchQuery, days: this.activeWhenDays ?? 120,
        sort, limit: this._spaceLimit });
      const file = await WhimsySpaceHistory.file();
      if (!this.isConnected || generation !== this._generation) {
        return;
      }
      const options = new Map();
      for (const visit of Object.values(file.data.visits)) {
        options.set(visit.spaceId, visit.spaceName);
      }
      for (const space of this.documentGlobal.gZenWorkspaces?.getWorkspaces() || []) {
        if (!space.whimsyScratch) {
          // The dropdown uses today's name; each row keeps its visit-time name.
          options.set(space.uuid, space.name);
        }
      }
      this._spaceOptions = [...options].sort((a, b) => a[1].localeCompare(b[1]));
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
      await this.updateComplete;
      if (this.filtersOpen && this.isConnected && generation === this._generation) {
        const inner = this.querySelector(".zen-library-filter-panel-inner");
        this.style.setProperty("--zen-library-filter-height", `${inner.scrollHeight + 8}px`);
      }
    } finally {
      if (generation === this._generation) {
        this._spaceLoading = false;
      }
    }
  }

  updated(changed) {
    super.updated(changed);
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
