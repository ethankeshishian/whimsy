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
    this._spaceId = "";
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

  renderTopButton() {
    const native = super.renderTopButton();
    if (!WhimsySpaceHistory.enabled) {
      return native;
    }
    return html`${native}<select class="whimsy-history-space zen-library-filter-chip"
      data-l10n-id="whimsy-history-space-filter" data-l10n-attrs="aria-label"
      ?disabled=${!this.spaceMode} .value=${this._spaceId || ""}
      @change=${event => {
        this._spaceId = event.target.value;
        this._spaceLimit = 100;
        this.refresh().catch(console.error);
      }}>
      <option value="" data-l10n-id="whimsy-history-all-spaces"></option>
      <option value="unknown" data-l10n-id="whimsy-history-unknown-space"></option>
      ${(this._spaceOptions || []).map(([id, name]) =>
        html`<option value=${id}>${name}</option>`)}
    </select>`;
  }

  onSearchChanged() {
    super.onSearchChanged();
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
      const visits = await WhimsySpaceHistory.query({ spaceId: this._spaceId,
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
      const visit = this._flatVisits?.[index];
      if (!visit) {
        continue;
      }
      if (!label) {
        label = this.ownerDocument.createElement("span");
        label.className = "whimsy-history-space-name zen-library-row-subtitle";
        row.querySelector(".zen-library-row-text").appendChild(label);
      }
      if (visit.spaceId) {
        this.ownerDocument.l10n.setAttributes(label, "whimsy-history-where", {
          space: visit.spaceName,
        });
      } else {
        this.ownerDocument.l10n.setAttributes(label, "whimsy-history-unknown-space");
      }
    }
  }
}

customElements.define("whimsy-space-history-section", WhimsySpaceHistorySection);
