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
const { gWhimsyNotesStore, NOTES_CHANGED_TOPIC, WhimsyNotes, QUICK_NOTE_SAVE_MS } = ChromeUtils.importESModule(
  "resource:///modules/whimsy/WhimsyNotesSection.sys.mjs"
);
const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  TabNotes: "moz-src:///browser/components/tabnotes/TabNotes.sys.mjs",
  PrivateBrowsingUtils: "resource://gre/modules/PrivateBrowsingUtils.sys.mjs",
  WhimsyProfiles: "resource:///modules/whimsy/WhimsyProfiles.sys.mjs",
  WhimsyUndo: "resource:///modules/whimsy/WhimsyUndo.sys.mjs",
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

  // W10-26: what you've typed but isn't saved yet, by note id: shown over
  // the stored note, so a save that lands while you type never rewinds
  // the field.
  #drafts = new Map();
  #saveTimers = new Map();

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
    const notes = await gWhimsyNotesStore.list(this.profileKey);
    this.notes = notes.map(note => (this.#drafts.has(note.id) ? { ...note, ...this.#drafts.get(note.id) } : note));
    this.focusPendingNote();
  }

  // W10-26: the Library opened on a note (Open in Notes, the toast's
  // Open): that note, open for editing.
  focusPendingNote() {
    const win = this.ownerDocument?.defaultView;
    const id = win && WhimsyNotes.takeFocusNote(win);
    if (!id) {
      return;
    }
    this.editingId = id;
    this.updateComplete.then(() => {
      this.querySelector(`[data-note-id="${CSS.escape(id)}"]`)?.scrollIntoView({ block: "nearest" });
      this.querySelector(".whimsy-note-editor textarea")?.focus();
    });
  }

  // W10-26: saved as you type (300ms after the last key), and at once
  // when the field loses focus, so a click elsewhere never loses it.
  #draft(note, field, value) {
    const draft = { ...(this.#drafts.get(note.id) ?? {}), [field]: value };
    this.#drafts.set(note.id, draft);
    clearTimeout(this.#saveTimers.get(note.id));
    this.#saveTimers.set(
      note.id,
      setTimeout(() => this.#flush(note), QUICK_NOTE_SAVE_MS)
    );
  }

  async #flush(note) {
    clearTimeout(this.#saveTimers.get(note.id));
    this.#saveTimers.delete(note.id);
    const draft = this.#drafts.get(note.id);
    if (!draft) {
      return;
    }
    if ("text" in draft) {
      await this.#setText(note, draft.text, { refresh: false });
    }
    if ("title" in draft) {
      await gWhimsyNotesStore.update(note.id, { title: draft.title });
    }
    // Typed more while saving: keep that draft for the next save.
    if (this.#drafts.get(note.id) === draft) {
      this.#drafts.delete(note.id);
    }
    await this.#refresh();
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

  // wave9/designfix (M9): "Deleted note · Undo" (and Cmd+Z), not one
  // click to lose it.
  async #removeNote(id) {
    if (this.editingId == id) {
      this.editingId = null;
    }
    const removed = await gWhimsyNotesStore.remove(id);
    await this.#refresh();
    if (!removed) {
      return;
    }
    lazy.WhimsyUndo.showToast(
      this.documentGlobal,
      "whimsy-library-notes-deleted-toast",
      { type: "library-delete", undo: () => gWhimsyNotesStore.restore(removed) },
      undefined,
      { detail: removed.title || preview(removed.text) || undefined }
    );
  }

  async #setText(note, text, { refresh = true } = {}) {
    if (note.pageAttached) {
      try {
        await lazy.TabNotes.set(this.ownerDocument.defaultView.gBrowser.selectedTab, text || " ");
      } catch (e) {
        console.error("Whimsy: set page note", e);
      }
    }
    await gWhimsyNotesStore.update(note.id, { text });
    if (refresh) {
      await this.#refresh();
    }
  }

  // The page a note can be kept with: its canonical address, else what the
  // address bar shows (W10-26: a page without a canonical URL attached
  // nothing, silently).
  #pageURL() {
    const win = this.ownerDocument.defaultView;
    return win.gBrowser.selectedTab?.canonicalUrl ?? win.gBrowser.currentURI?.spec ?? null;
  }

  async #toggleAttach(note) {
    await this.#flush(note);
    // Read it again: the checkbox may be older than the note.
    note = (await gWhimsyNotesStore.list()).find(n => n.id == note.id) ?? note;
    if (!note.pageAttached) {
      const tab = this.ownerDocument.defaultView.gBrowser.selectedTab;
      const url = this.#pageURL();
      if (!tab || !url) {
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
        // An address TabNotes can't keep: the note keeps it.
      }
      await gWhimsyNotesStore.update(note.id, { pageAttached: true, url });
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
      <div class="zen-library-group" data-note-id=${note.id}>
        <div
          class="zen-library-row"
          @click=${() => {
            this.editingId = editing ? null : note.id;
          }}
        >
          <img class="zen-library-row-icon" src="chrome://browser/skin/zen-icons/page-portrait.svg" alt="" />
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
                    @input=${event => this.#draft(note, "title", event.target.value)}
                    @change=${() => this.#flush(note)}
                  />
                  <textarea
                    rows="6"
                    .value=${note.text}
                    @input=${event => this.#draft(note, "text", event.target.value)}
                    @change=${() => this.#flush(note)}
                    @blur=${() => this.#flush(note)}
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
    // W10-26: notes kept with the page you're on, first.
    const url = this.#pageURL();
    const here = url ? this.notes.filter(n => n.pageAttached && n.url == url) : [];
    if (!here.length) {
      return repeat(this.notes, n => n.id, n => this.#renderNote(n));
    }
    const rest = this.notes.filter(n => !here.includes(n));
    return html`
      <div class="zen-library-group whimsy-notes-this-page"><h3 data-l10n-id="whimsy-library-notes-this-page"></h3></div>
      ${repeat(here, n => n.id, n => this.#renderNote(n))}
      ${rest.length ? html`<div class="zen-library-group whimsy-notes-others"><h3 data-l10n-id="whimsy-library-notes-other"></h3></div>` : ""}
      ${repeat(rest, n => n.id, n => this.#renderNote(n))}
    `;
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
