/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { html, repeat } from "chrome://global/content/vendor/lit.all.mjs";
import { ZenLibrarySearchSection } from "moz-src:///zen/library/sections/ZenLibrarySearchSection.mjs";
import {
  TAB_DROP_TYPE,
  blockFromTab,
  blockFromURL,
  blocksEnabled,
  parseEmbedCommand,
} from "./whimsy-note-blocks.mjs";
const { gWhimsyNotesStore, NOTES_CHANGED_TOPIC } = ChromeUtils.importESModule(
  "resource:///modules/whimsy/WhimsyNotesSection.sys.mjs"
);
const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  TabNotes: "moz-src:///browser/components/tabnotes/TabNotes.sys.mjs",
  PrivateBrowsingUtils: "resource://gre/modules/PrivateBrowsingUtils.sys.mjs",
  WhimsyProfiles: "resource:///modules/whimsy/WhimsyProfiles.sys.mjs",
});

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

  // W8-49: Notes are per-profile (matching active space's container).
  get profileKey() {
    const win = this.ownerDocument?.defaultView;
    if (!win) {
      return "default";
    }
    const profileId = lazy.WhimsyProfiles.activeProfileId(win);
    return lazy.WhimsyProfiles.keyFor(profileId);
  }

  // Notes can change while this section stays mounted (the library keeps it
  // for a while after closing): "Add to Note", another window, a tab drop,
  // or switching to a space of another profile.
  #observer = () => this.#refresh();

  connectedCallback() {
    super.connectedCallback();
    Services.obs.addObserver(this.#observer, NOTES_CHANGED_TOPIC);
    const win = this.ownerDocument?.defaultView;
    if (win) {
      win.addEventListener("ZenWorkspacesUIUpdate", this.#observer);
      win.addEventListener("TabSelect", this.#observer);
    }
    this.#refresh();
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    Services.obs.removeObserver(this.#observer, NOTES_CHANGED_TOPIC);
    const win = this.ownerDocument?.defaultView;
    if (win) {
      win.removeEventListener("ZenWorkspacesUIUpdate", this.#observer);
      win.removeEventListener("TabSelect", this.#observer);
    }
  }

  async #refresh() {
    this.notes = await gWhimsyNotesStore.list(this.profileKey);
  }

  get searchPlaceholderL10nId() {
    return "whimsy-library-notes-search-placeholder";
  }

  onSearchChanged() {
    this.requestUpdate();
  }

  async #addNote() {
    const note = await gWhimsyNotesStore.create({ profileKey: this.profileKey });
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
        await lazy.TabNotes.set(this.ownerDocument.defaultView.gBrowser.selectedTab, text || " ");
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
      const tab = this.ownerDocument.defaultView.gBrowser.selectedTab;
      if (!tab?.canonicalUrl) {
        return;
      }
      // wave8/isolation: attaching saves the page's address (Firefox's
      // TabNotes and this note), so never for a private page.
      if (
        lazy.PrivateBrowsingUtils.isBrowserPrivate(tab.linkedBrowser) ||
        tab.hasAttribute("whimsy-private")
      ) {
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

  // wave5: live blocks (whimsy-note-blocks.mjs).
  #toast(id) {
    this.ownerDocument.defaultView.gZenUIManager?.showToast(id);
  }

  async #insertBlock(note, result, text = null) {
    if (text != null && text != note.text) {
      await this.#setText(note, text);
    }
    if (result.error) {
      this.#toast(result.error);
      return;
    }
    const current = (await gWhimsyNotesStore.list()).find(n => n.id == note.id) ?? note;
    await gWhimsyNotesStore.update(note.id, { blocks: [...(current.blocks ?? []), result.block] });
    await this.#refresh();
  }

  async #updateBlock(note, block) {
    const current = (await gWhimsyNotesStore.list()).find(n => n.id == note.id);
    if (!current) {
      return;
    }
    const blocks = (current.blocks ?? []).map(b => (b.id == block.id ? block : b));
    await gWhimsyNotesStore.update(note.id, { blocks });
    await this.#refresh();
  }

  async #removeBlock(note, block) {
    const current = (await gWhimsyNotesStore.list()).find(n => n.id == note.id);
    if (!current) {
      return;
    }
    await gWhimsyNotesStore.update(note.id, { blocks: (current.blocks ?? []).filter(b => b.id != block.id) });
    await this.#refresh();
  }

  // "/embed" (current tab) or "/embed <url>" on its own line, then Enter.
  #onEditorKeydown(note, event) {
    if (event.key != "Enter" || event.shiftKey || !blocksEnabled()) {
      return;
    }
    const textarea = event.target;
    const { value, selectionStart } = textarea;
    const lineStart = value.lastIndexOf("\n", selectionStart - 1) + 1;
    let lineEnd = value.indexOf("\n", selectionStart);
    if (lineEnd == -1) {
      lineEnd = value.length;
    }
    const command = parseEmbedCommand(value.slice(lineStart, lineEnd));
    if (!command) {
      return;
    }
    event.preventDefault();
    const text = (value.slice(0, lineStart) + value.slice(lineEnd + 1)).replace(/\n$/, "");
    textarea.value = text;
    this.embed(note, command.url, text);
  }

  // Public for tests: embeds the selected tab, or `url` in its container.
  embed(note, url = null, text = null) {
    const win = this.ownerDocument.defaultView;
    const tab = win.gBrowser.selectedTab;
    const result = url
      ? blockFromURL(url, {
          userContextId: tab?.userContextId,
          isPrivate: blockFromTab(tab).error == "whimsy-note-block-private",
        })
      : blockFromTab(tab);
    return this.#insertBlock(note, result, text);
  }

  #onDragOver(event) {
    const types = event.dataTransfer?.types ?? [];
    if (!blocksEnabled() || !(types.includes(TAB_DROP_TYPE) || types.includes("text/x-moz-url"))) {
      return;
    }
    event.preventDefault();
    event.dataTransfer.dropEffect = "link";
  }

  #onDrop(note, event) {
    if (!blocksEnabled()) {
      return;
    }
    const dt = event.dataTransfer;
    const tab = dt.mozGetDataAt(TAB_DROP_TYPE, 0);
    if (tab) {
      event.preventDefault();
      event.stopPropagation();
      this.#insertBlock(note, blockFromTab(tab));
      return;
    }
    const link = dt.getData("text/x-moz-url").split("\n")[0];
    if (link) {
      event.preventDefault();
      event.stopPropagation();
      this.embed(note, link);
    }
  }

  #renderBlocks(note) {
    if (!blocksEnabled()) {
      return "";
    }
    return html`
      ${repeat(
        note.blocks ?? [],
        b => b.id,
        b => html`<whimsy-note-block
          .block=${b}
          .onBlockChange=${block => this.#updateBlock(note, block)}
          .onBlockRemove=${block => this.#removeBlock(note, block)}
        ></whimsy-note-block>`
      )}
      <span class="whimsy-note-block-hint" data-l10n-id="whimsy-note-block-hint"></span>
    `;
  }

  #renderNote(note) {
    const query = this.searchQuery.toLowerCase();
    if (
      query &&
      !note.title?.toLowerCase().includes(query) &&
      !note.text?.toLowerCase().includes(query) &&
      !note.blocks?.some(b => `${b.title} ${b.url}`.toLowerCase().includes(query))
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
                <div
                  class="zen-library-row whimsy-note-editor"
                  style="flex-direction: column; align-items: stretch; gap: 6px;"
                  @dragover=${event => this.#onDragOver(event)}
                  @drop=${event => this.#onDrop(note, event)}
                >
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
                    @keydown=${event => this.#onEditorKeydown(note, event)}
                  ></textarea>
                  ${this.#renderBlocks(note)}
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
