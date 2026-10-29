/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// batch10: Notes (Arc's Notes / Vivaldi's Notes panel). A lightweight
// markdown scratchpad in the sidebar for the stuff too small for a real
// document - a pasted address, a running todo list for the session - kept
// as a list of free-floating notes (Whimsy's own JSONFile store, the same
// pattern ZenSpaceRoutingManager uses) with an "attach to this page"
// toggle that, when on, hands the text to Firefox 149's own TabNotes
// storage (engine/browser/components/tabnotes/TabNotes.sys.mjs) keyed by
// canonical URL, so it shows again next time that URL is open. Scope note:
// the queue's "pinnable like a tab" is dropped for this pass - it would
// need a new whimsy:// page and tab-pin plumbing neither of which exists
// yet; said sections list/edit notes inline instead.

import { html, repeat } from "chrome://global/content/vendor/lit.all.mjs";
import { ZenLibrarySearchSection } from "moz-src:///zen/library/sections/ZenLibrarySearchSection.mjs";

const lazy = {};
ChromeUtils.defineESModuleGetters(
  lazy,
  {
    JSONFile: "resource://gre/modules/JSONFile.sys.mjs",
    TabNotes: "moz-src:///browser/components/tabnotes/TabNotes.sys.mjs",
  },
  { global: "current" }
);

const STORE_FILENAME = "whimsy-notes.json";

class NotesStore {
  #file = null;
  #loading = null;

  async #ensureLoaded() {
    if (this.#file) {
      return this.#file;
    }
    this.#loading ??= (async () => {
      const file = new lazy.JSONFile({
        path: PathUtils.join(PathUtils.profileDir, STORE_FILENAME),
        dataPostProcessor(data) {
          if (!data || typeof data != "object" || !Array.isArray(data.notes)) {
            return { notes: [] };
          }
          return data;
        },
      });
      await file.load();
      this.#file = file;
    })();
    await this.#loading;
    return this.#file;
  }

  async list() {
    const file = await this.#ensureLoaded();
    return [...file.data.notes].sort((a, b) => b.updated - a.updated);
  }

  async create() {
    const file = await this.#ensureLoaded();
    const note = {
      id: Services.uuid.generateUUID().toString(),
      title: "",
      text: "",
      pageAttached: false,
      url: null,
      created: Date.now(),
      updated: Date.now(),
    };
    file.data.notes.push(note);
    file.saveSoon();
    return note;
  }

  async update(id, changes) {
    const file = await this.#ensureLoaded();
    const note = file.data.notes.find(n => n.id == id);
    if (!note) {
      return null;
    }
    Object.assign(note, changes, { updated: Date.now() });
    file.saveSoon();
    return note;
  }

  async remove(id) {
    const file = await this.#ensureLoaded();
    file.data.notes = file.data.notes.filter(n => n.id != id);
    file.saveSoon();
  }
}

export const gWhimsyNotesStore = new NotesStore();

function preview(text) {
  const firstLine = (text ?? "").split("\n").find(l => l.trim()) ?? "";
  return firstLine.length > 80 ? `${firstLine.slice(0, 80)}…` : firstLine;
}

export class WhimsyNotesSection extends ZenLibrarySearchSection {
  static id = "whimsy-notes";
  static label = "whimsy-library-notes-title";

  static render(library) {
    return html`
      <whimsy-library-notes-section
        class="zen-library-section"
        data-section="whimsy-notes"
        .library=${library}
      ></whimsy-library-notes-section>
    `;
  }

  static properties = {
    notes: { state: true },
    editingId: { state: true },
  };

  constructor() {
    super();
    this.notes = [];
    this.editingId = null;
  }

  connectedCallback() {
    super.connectedCallback();
    this.#refresh();
  }

  async #refresh() {
    this.notes = await gWhimsyNotesStore.list();
  }

  get searchPlaceholderL10nId() {
    return "whimsy-library-notes-search-placeholder";
  }

  onSearchChanged() {
    this.requestUpdate();
  }

  async #addNote() {
    const note = await gWhimsyNotesStore.create();
    await this.#refresh();
    this.editingId = note.id;
  }

  async #removeNote(id) {
    if (this.editingId == id) {
      this.editingId = null;
    }
    await gWhimsyNotesStore.remove(id);
    await this.#refresh();
  }

  async #setText(note, text) {
    if (note.pageAttached) {
      try {
        await lazy.TabNotes.set(this.ownerGlobal.gBrowser.selectedTab, text || " ");
      } catch (e) {
        console.error("Whimsy: set page note", e);
      }
    }
    await gWhimsyNotesStore.update(note.id, { text });
    await this.#refresh();
  }

  async #setTitle(note, title) {
    await gWhimsyNotesStore.update(note.id, { title });
    await this.#refresh();
  }

  async #toggleAttach(note) {
    if (!note.pageAttached) {
      const tab = this.ownerGlobal.gBrowser.selectedTab;
      if (!tab?.canonicalUrl) {
        return;
      }
      try {
        await lazy.TabNotes.set(tab, note.text || " ");
      } catch (e) {
        console.error("Whimsy: attach note to page", e);
        return;
      }
      await gWhimsyNotesStore.update(note.id, { pageAttached: true, url: tab.canonicalUrl });
    } else {
      await gWhimsyNotesStore.update(note.id, { pageAttached: false, url: null });
    }
    await this.#refresh();
  }

  #renderNote(note) {
    const query = this.searchQuery.toLowerCase();
    if (
      query &&
      !note.title?.toLowerCase().includes(query) &&
      !note.text?.toLowerCase().includes(query)
    ) {
      return "";
    }
    const editing = this.editingId == note.id;
    return html`
      <div class="zen-library-group">
        <div
          class="zen-library-row"
          @click=${() => {
            this.editingId = editing ? null : note.id;
          }}
        >
          <img class="zen-library-row-icon" src="chrome://browser/skin/zen-icons/edit-copy.svg" alt="" />
          <div class="zen-library-row-text">
            <span class="zen-library-row-title">${note.title || preview(note.text) || "—"}</span>
            <span class="zen-library-row-subtitle">${
              note.pageAttached ? note.url : preview(note.text)
            }</span>
          </div>
          <div class="zen-library-row-actions">
            <toolbarbutton
              class="toolbarbutton-1"
              data-l10n-id="whimsy-library-notes-delete"
              @click=${event => {
                event.stopPropagation();
                this.#removeNote(note.id);
              }}
            >
              <img class="toolbarbutton-icon" src="chrome://browser/skin/zen-icons/trash.svg" alt="" />
            </toolbarbutton>
          </div>
        </div>
        ${
          editing
            ? html`
                <div class="zen-library-row" style="flex-direction: column; align-items: stretch; gap: 6px;">
                  <input
                    type="text"
                    data-l10n-id="whimsy-library-notes-title-placeholder"
                    .value=${note.title}
                    @change=${event => this.#setTitle(note, event.target.value)}
                  />
                  <textarea
                    rows="6"
                    .value=${note.text}
                    @change=${event => this.#setText(note, event.target.value)}
                  ></textarea>
                  <label>
                    <input
                      type="checkbox"
                      .checked=${note.pageAttached}
                      @change=${() => this.#toggleAttach(note)}
                    />
                    <span data-l10n-id="whimsy-library-notes-attach"></span>
                  </label>
                </div>
              `
            : ""
        }
      </div>
    `;
  }

  renderItems() {
    if (!this.notes.length) {
      return html`<div class="zen-library-empty" data-l10n-id="whimsy-library-notes-empty"></div>`;
    }
    return repeat(this.notes, n => n.id, n => this.#renderNote(n));
  }

  renderFooter() {
    return html`
      <button class="zen-library-filter-button" @click=${() => this.#addNote()}>
        <img src="chrome://browser/skin/zen-icons/plus.svg" alt="" />
        <span data-l10n-id="whimsy-library-notes-add"></span>
      </button>
    `;
  }
}

customElements.define("whimsy-library-notes-section", WhimsyNotesSection);
