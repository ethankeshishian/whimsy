/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// wave5: Easels in the Library (Arc kept them under Library > Easels):
// the easels of the profile in front, newest first (wave9: per profile, like
// Notes). A click opens it (or its open tab). Private windows, private tabs
// and Scratch list none and can't make one.

import { html, repeat } from "chrome://global/content/vendor/lit.all.mjs";
import { ZenLibrarySearchSection } from "moz-src:///zen/library/sections/ZenLibrarySearchSection.mjs";
const { gWhimsyEaselStore, WhimsyEasel, CHANGED_TOPIC, easelIdFromURL, profileKeyOf } = ChromeUtils.importESModule(
  "resource:///modules/whimsy/WhimsyEasel.sys.mjs"
);

export class WhimsyEaselsSection extends ZenLibrarySearchSection {
  static id = "whimsy-easels";
  static label = "whimsy-library-easels-title";

  static render(library) {
    return html`
      <whimsy-library-easels-section
        class="zen-library-section"
        data-section="whimsy-easels"
        .library=${library}
      ></whimsy-library-easels-section>
    `;
  }

  static properties = { easels: { state: true }, canPersist: { state: true } };

  #observer = { observe: () => this.#refresh() };
  // Switching to a space of another profile (or into Scratch, or to a
  // private tab) changes which easels show.
  #onContextChange = () => this.#refresh();

  constructor() {
    super();
    this.easels = [];
    this.canPersist = true;
  }

  connectedCallback() {
    super.connectedCallback();
    Services.obs.addObserver(this.#observer, CHANGED_TOPIC);
    window.addEventListener("ZenWorkspacesUIUpdate", this.#onContextChange);
    window.addEventListener("TabSelect", this.#onContextChange);
    this.#refresh();
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    Services.obs.removeObserver(this.#observer, CHANGED_TOPIC);
    window.removeEventListener("ZenWorkspacesUIUpdate", this.#onContextChange);
    window.removeEventListener("TabSelect", this.#onContextChange);
  }

  async #refresh() {
    this.canPersist = WhimsyEasel.canPersistIn(window);
    this.easels = this.canPersist ? await gWhimsyEaselStore.list(WhimsyEasel.profileKeyForWindow(window)) : [];
  }

  get searchPlaceholderL10nId() {
    return "whimsy-library-easels-search-placeholder";
  }

  onSearchChanged() {
    this.requestUpdate();
  }

  #open(easel) {
    WhimsyEasel.openEasel(window, easel.id, { profileKey: profileKeyOf(easel) });
  }

  // Deleting can be undone from the toast for a few seconds.
  async #remove(easel) {
    await gWhimsyEaselStore.remove(easel.id);
    for (const tab of [...window.gBrowser.tabs]) {
      if (easelIdFromURL(tab.linkedBrowser?.currentURI?.spec) == easel.id) {
        window.gBrowser.removeTab(tab);
      }
    }
    this.#refresh();
    const id = "whimsy-library-easels-undo-button";
    window.gZenUIManager?.showToast?.("whimsy-library-easels-deleted", {
      timeout: 8000,
      l10nArgs: { title: easel.title || (await WhimsyEasel.untitled(window)) },
      button: {
        id,
        command: event => {
          event.target.closest(".zen-toast")?.remove();
          gWhimsyEaselStore.restore(easel.id);
        },
      },
    });
    const button = document.getElementById(id);
    if (button) {
      document.l10n.setAttributes(button, id);
    }
  }

  #renderEasel(easel) {
    const query = this.searchQuery.toLowerCase();
    const items = easel.items ?? [];
    const words = items.map(i => i.text ?? i.title ?? "").join(" ").toLowerCase();
    if (query && !(easel.title ?? "").toLowerCase().includes(query) && !words.includes(query)) {
      return "";
    }
    return html`
      <div
        class="zen-library-row"
        tabindex="0"
        role="button"
        @click=${() => this.#open(easel)}
        @keydown=${event => {
          if (event.key == "Enter" || event.key == " ") {
            event.preventDefault();
            this.#open(easel);
          }
        }}
      >
        <img class="zen-library-row-icon" src="chrome://browser/skin/zen-icons/paintbrush.svg" alt="" />
        <div class="zen-library-row-text">
          ${easel.title
            ? html`<span class="zen-library-row-title">${easel.title}</span>`
            : html`<span class="zen-library-row-title" data-l10n-id="whimsy-easel-untitled"></span>`}
          <span class="zen-library-row-subtitle" data-l10n-id="whimsy-library-easels-items" data-l10n-args=${JSON.stringify({ count: items.length })}></span>
        </div>
        <div class="zen-library-row-actions">
          <toolbarbutton
            class="toolbarbutton-1"
            data-l10n-id="whimsy-library-easels-delete"
            @click=${event => {
              event.stopPropagation();
              this.#remove(easel);
            }}
          >
            <img class="toolbarbutton-icon" src="chrome://browser/skin/zen-icons/trash.svg" alt="" />
          </toolbarbutton>
        </div>
      </div>
    `;
  }

  renderItems() {
    if (!this.canPersist) {
      return html`
        <div class="zen-library-empty">
          <span data-l10n-id="whimsy-library-easels-private"></span>
        </div>
      `;
    }
    if (!this.easels.length) {
      return html`
        <div class="zen-library-empty">
          <span data-l10n-id="whimsy-library-easels-empty"></span>
          <button class="whimsy-library-easels-new" data-l10n-id="whimsy-library-easels-new"
            @click=${() => WhimsyEasel.newEasel(window)}></button>
        </div>
      `;
    }
    return repeat(this.easels, e => e.id, e => this.#renderEasel(e));
  }
}

customElements.define("whimsy-library-easels-section", WhimsyEaselsSection);
