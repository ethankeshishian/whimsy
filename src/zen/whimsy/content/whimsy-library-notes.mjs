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

// W13 notes (option C, design/notes-sidebar): a note's card shows its
// title (or its first line), then the next line of the note.
function lines(text) {
  return (text ?? "").split("\n").map(l => l.trim()).filter(Boolean);
}
function cardText(note) {
  const [first = "", second = ""] = lines(note.text);
  const title = (note.title ?? "").trim();
  const clip = line => (line.length > 80 ? `${line.slice(0, 80)}…` : line);
  return title ? { title: clip(title), line: clip(first) } : { title: clip(first), line: clip(second) };
}

function hostOf(url) {
  try {
    return new URL(url).host || url;
  } catch {
    return url ?? "";
  }
}

// How long ago, as compact as the mockup's "2h", "1d", "1w"; a date after
// five weeks. null under a minute (the card says "Now").
export function noteAge(time, now = Date.now(), locale = Services.locale.appLocaleAsBCP47) {
  const seconds = Math.max(0, (now - time) / 1000);
  if (seconds < 60) {
    return null;
  }
  for (const [unit, size, below] of [["minute", 60, 60], ["hour", 3600, 24], ["day", 86400, 7], ["week", 604800, 5]]) {
    const n = Math.floor(seconds / size);
    if (n < below) {
      return new Intl.NumberFormat(locale, { style: "unit", unit, unitDisplay: "narrow" }).format(n);
    }
  }
  return new Intl.DateTimeFormat(locale, { month: "short", day: "numeric" }).format(time);
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

  // F09 A: a new note opens with the cursor in its title.
  async #addNote() {
    const note = await gWhimsyNotesStore.create({ profileKey: this.profileKey });
    await this.#refresh();
    this.#openNote(note.id, "title");
  }

  // W13 notes C: open a note's card in place of its row; the cursor goes
  // to the title when it has none, else to the end of the note.
  #openNote(id, field = null) {
    const previous = this.editingId;
    if (previous && previous != id) {
      this.#closeNote(previous);
    }
    this.editingId = id;
    this.updateComplete.then(() => {
      const card = this.querySelector(".whimsy-note-editor");
      card?.scrollIntoView({ block: "nearest" });
      const title = card?.querySelector(".whimsy-note-open-title");
      const body = card?.querySelector("textarea");
      const target = field == "title" || (field == null && !title?.value) ? title : body;
      target?.focus();
      if (target == body && body) {
        body.setSelectionRange(body.value.length, body.value.length);
      }
    });
  }

  // Done (or Esc, or another note): what was typed is saved; a note left
  // empty is never kept (F09).
  async #closeNote(id = this.editingId) {
    if (!id) {
      return;
    }
    if (this.editingId == id) {
      this.editingId = null;
    }
    const note = this.notes.find(n => n.id == id);
    if (note) {
      await this.#flush(note);
    }
    const stored = (await gWhimsyNotesStore.list()).find(n => n.id == id);
    if (stored && !stored.title?.trim() && !stored.text?.trim() && !stored.blocks?.length) {
      await gWhimsyNotesStore.remove(id);
      if (stored.pageAttached) {
        try {
          const tab = this.ownerDocument.defaultView.gBrowser.selectedTab;
          if (await lazy.TabNotes.has(tab)) {
            await lazy.TabNotes.delete(tab);
          }
        } catch (e) {}
      }
    }
    await this.#refresh();
  }

  // The Library's Esc: an open note closes first (ZenLibrary asks the
  // showing section before it closes itself).
  onEscape() {
    if (!this.editingId) {
      return super.onEscape?.() ?? false;
    }
    this.#closeNote();
    return true;
  }

  // A page a note can be kept with (not a private page, not a blank one).
  #canAttach() {
    const win = this.ownerDocument.defaultView;
    const tab = win.gBrowser.selectedTab;
    const url = this.#pageURL();
    return (
      !!tab && !!url && !/^about:(blank|newtab|home)$/.test(url) &&
      !lazy.PrivateBrowsingUtils.isBrowserPrivate(tab.linkedBrowser) && !tab.hasAttribute("whimsy-private")
    );
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

  // The page a note is kept with, as a chip: its favicon and the page's
  // title when it's the page you're on, else its host.
  #renderChip(note, { removable = false } = {}) {
    const win = this.ownerDocument.defaultView;
    const here = note.url && note.url == this.#pageURL();
    const label = (here && win.gBrowser.selectedTab?.label) || hostOf(note.url);
    return html`
      <span class="whimsy-note-chip" title=${note.url}>
        <img class="whimsy-note-chip-icon" src=${`page-icon:${note.url}`} alt="" />
        <span class="whimsy-note-chip-label">${label}</span>
        ${
          removable
            ? html`<button
                type="button"
                class="whimsy-note-chip-remove"
                data-l10n-id="whimsy-library-notes-detach"
                @click=${() => this.#toggleAttach(note)}
              ></button>`
            : ""
        }
      </span>
    `;
  }

  // W13 notes C: the open note, in the F09 A card's layout: the title,
  // the note, live blocks, then the page chip and Done.
  #renderEditor(note) {
    const host = hostOf(this.#pageURL());
    return html`
      <div
        class="whimsy-note-editor whimsy-note-open"
        @dragover=${event => this.#onDragOver(event)}
        @drop=${event => this.#onDrop(note, event)}
        @keydown=${event => {
          // ⌘Return is Done (F09).
          if (event.key == "Enter" && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            this.#closeNote(note.id);
          }
        }}
      >
        <input
          type="text"
          class="whimsy-note-open-title"
          data-l10n-id="whimsy-library-notes-title-placeholder"
          .value=${note.title}
          @input=${event => this.#draft(note, "title", event.target.value)}
          @change=${() => this.#flush(note)}
          @keydown=${event => {
            // Return in the title moves to the note (F09).
            if (event.key == "Enter" && !event.metaKey && !event.ctrlKey) {
              event.preventDefault();
              const body = event.target.parentNode.querySelector("textarea");
              body?.focus();
              body?.setSelectionRange(0, 0);
            }
          }}
        />
        <textarea
          class="whimsy-note-open-body"
          rows="4"
          data-l10n-id="whimsy-library-notes-body-placeholder"
          .value=${note.text}
          @input=${event => {
            this.#draft(note, "text", event.target.value);
            // It grows with what you write, up to 12 lines, then scrolls.
            event.target.rows = Math.min(12, Math.max(4, event.target.value.split("\n").length));
          }}
          @change=${() => this.#flush(note)}
          @blur=${() => this.#flush(note)}
          @keydown=${event => this.#onEditorKeydown(note, event)}
        ></textarea>
        ${this.#renderBlocks(note)}
        <div class="whimsy-note-open-footer">
          ${
            note.pageAttached && note.url
              ? this.#renderChip(note, { removable: true })
              : this.#canAttach()
                ? html`<button
                    type="button"
                    class="whimsy-note-chip whimsy-note-chip-add"
                    data-l10n-id="whimsy-library-notes-attach-chip"
                    data-l10n-args=${JSON.stringify({ host })}
                    @click=${() => this.#toggleAttach(note)}
                  ></button>`
                : ""
          }
          <button
            type="button"
            class="whimsy-note-done"
            data-l10n-id="whimsy-library-notes-done"
            @click=${() => this.#closeNote(note.id)}
          ></button>
        </div>
      </div>
    `;
  }

  // W13 notes C: a two-line card: the title, the next line, the page chip
  // and how long ago; Edit and Delete on hover (and keyboard focus).
  #renderCard(note) {
    const { title, line } = cardText(note);
    const age = noteAge(note.updated ?? note.created ?? Date.now());
    let when = "";
    try {
      when = new Intl.DateTimeFormat(Services.locale.appLocaleAsBCP47, { dateStyle: "medium", timeStyle: "short" })
        .format(note.updated ?? note.created);
    } catch {}
    return html`
      <div
        class="whimsy-note-card"
        tabindex="0"
        @click=${() => this.#openNote(note.id)}
        @keydown=${event => {
          if ((event.key == "Enter" || event.key == " ") && event.target == event.currentTarget) {
            event.preventDefault();
            this.#openNote(note.id);
          }
        }}
      >
        ${
          title
            ? html`<span class="whimsy-note-card-title">${title}</span>`
            : html`<span class="whimsy-note-card-title" data-l10n-id="whimsy-library-notes-untitled"></span>`
        }
        ${line ? html`<span class="whimsy-note-card-line">${line}</span>` : ""}
        <span class="whimsy-note-card-footer">
          ${note.pageAttached && note.url ? this.#renderChip(note) : ""}
          ${
            age
              ? html`<span class="whimsy-note-card-age" title=${when}>${age}</span>`
              : html`<span class="whimsy-note-card-age" title=${when} data-l10n-id="whimsy-library-notes-just-now"></span>`
          }
        </span>
        <span class="whimsy-note-card-actions">
          <toolbarbutton
            class="toolbarbutton-1 whimsy-note-card-edit"
            data-l10n-id="whimsy-library-notes-edit"
            @click=${event => {
              event.stopPropagation();
              this.#openNote(note.id);
            }}
          >
            <img class="toolbarbutton-icon" src="chrome://browser/content/whimsy/whimsy-form-pencil.svg" alt="" />
          </toolbarbutton>
          <toolbarbutton
            class="toolbarbutton-1 whimsy-note-card-delete"
            data-l10n-id="whimsy-library-notes-delete"
            @click=${event => {
              event.stopPropagation();
              this.#removeNote(note.id);
            }}
          >
            <img class="toolbarbutton-icon" src="chrome://browser/skin/zen-icons/trash.svg" alt="" />
          </toolbarbutton>
        </span>
      </div>
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
    return html`
      <div class="zen-library-group whimsy-note-item" data-note-id=${note.id}>
        ${this.editingId == note.id ? this.#renderEditor(note) : this.#renderCard(note)}
      </div>
    `;
  }

  // W13 notes C: the empty state: the notes sprite, "No notes yet", New
  // Note, and where else notes come from.
  #renderEmpty() {
    return html`
      <div class="whimsy-notes-empty">
        <div class="whimsy-notes-empty-icon"><div class="empty-state-icon-image"></div></div>
        <strong class="whimsy-notes-empty-title" data-l10n-id="whimsy-library-notes-empty"></strong>
        <button
          type="button"
          class="whimsy-note-done whimsy-notes-empty-new"
          data-l10n-id="whimsy-library-notes-new"
          @click=${() => this.#addNote()}
        ></button>
        <span class="whimsy-notes-empty-hint" data-l10n-id="whimsy-library-notes-empty-hint"></span>
      </div>
    `;
  }

  renderItems() {
    if (!this.notes.length) {
      return this.#renderEmpty();
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

  // The footer's New note; the empty state has its own button instead.
  renderFooter() {
    if (!this.notes.length) {
      return "";
    }
    return html`
      <button class="zen-library-filter-button" @click=${() => this.#addNote()}>
        <img src="chrome://browser/skin/zen-icons/plus.svg" alt="" />
        <span data-l10n-id="whimsy-library-notes-add"></span>
      </button>
    `;
  }
}

customElements.define("whimsy-library-notes-section", WhimsyNotesSection);
