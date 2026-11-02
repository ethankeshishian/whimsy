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


const lazy = {};
ChromeUtils.defineESModuleGetters(
  lazy,
  {
    JSONFile: "resource://gre/modules/JSONFile.sys.mjs",
    TabNotes: "moz-src:///browser/components/tabnotes/TabNotes.sys.mjs",
    WhimsyCommands: "resource:///modules/whimsy/WhimsyCommands.sys.mjs",
    WhimsyPanels: "resource:///modules/whimsy/WhimsyPanels.sys.mjs",
    WhimsyPrivate: "resource:///modules/whimsy/WhimsyPrivate.sys.mjs",
    WhimsyToast: "resource:///modules/whimsy/WhimsyToast.sys.mjs",
    WhimsyProfiles: "resource:///modules/whimsy/WhimsyProfiles.sys.mjs",
  },
  { global: "current" }
);

ChromeUtils.defineLazyGetter(lazy, "l10n", () => new Localization(["browser/whimsy.ftl"], true));

const STORE_FILENAME = "whimsy-notes.json";
// W13 notes (option C): the Library's Notes tab shows how many notes are
// kept with the page you're on.
export const NOTE_COUNT_ATTR = "whimsy-note-count";
// Notified after any note is created, changed or removed, so an open Notes
// section shows notes added elsewhere (verbs, other windows, tab drops).
export const NOTES_CHANGED_TOPIC = "whimsy-notes-changed";

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

  async list(profileKey = null) {
    const file = await this.#ensureLoaded();
    let notes = file.data.notes;
    if (profileKey) {
      notes = notes.filter(n => (n.profileKey || "default") === profileKey);
    }
    return [...notes].sort((a, b) => b.updated - a.updated);
  }

  async create(data = {}) {
    const file = await this.#ensureLoaded();
    const note = {
      id: Services.uuid.generateUUID().toString(),
      title: data.title || "",
      text: data.text || "",
      profileKey: data.profileKey || "default",
      pageAttached: !!data.pageAttached,
      url: data.url || null,
      created: Date.now(),
      updated: Date.now(),
      ...(data.blocks ? { blocks: data.blocks } : {}),
    };
    file.data.notes.push(note);
    file.saveSoon();
    Services.obs.notifyObservers(null, NOTES_CHANGED_TOPIC);
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
    Services.obs.notifyObservers(null, NOTES_CHANGED_TOPIC);
    return note;
  }

  /** @returns {object|null} the note that was removed (for Undo) */
  async remove(id) {
    const file = await this.#ensureLoaded();
    const removed = file.data.notes.find(n => n.id == id) ?? null;
    file.data.notes = file.data.notes.filter(n => n.id != id);
    file.saveSoon();
    Services.obs.notifyObservers(null, NOTES_CHANGED_TOPIC);
    return removed;
  }

  // wave9/designfix (M9): Undo of a deleted note puts it back as it was.
  async restore(note) {
    const file = await this.#ensureLoaded();
    if (!note?.id || file.data.notes.some(n => n.id == note.id)) {
      return;
    }
    file.data.notes.push(note);
    file.saveSoon();
    Services.obs.notifyObservers(null, NOTES_CHANGED_TOPIC);
  }

  async removeForProfile(profileKey) {
    if (!profileKey || profileKey === "default") {
      return;
    }
    const file = await this.#ensureLoaded();
    file.data.notes = file.data.notes.filter(n => (n.profileKey || "default") !== profileKey);
    file.saveSoon();
    Services.obs.notifyObservers(null, NOTES_CHANGED_TOPIC);
  }
}

export const gWhimsyNotesStore = new NotesStore();

// W8-49: clean up notes when a custom profile is deleted.
try {
  lazy.WhimsyProfiles.onDelete?.((id, key) => gWhimsyNotesStore.removeForProfile(key));
} catch (e) {}

const HTML_NS = "http://www.w3.org/1999/xhtml";
const QUICK_NOTE_ID = "whimsy-quick-note";
// Typing is saved this long after the last key.
export const QUICK_NOTE_SAVE_MS = 300;

export const WhimsyNotes = {
  get enabled() {
    return Services.prefs.getBoolPref("whimsy.feature.notes", true);
  },

  initWindow(win) {
    lazy.WhimsyCommands.register(win, {
      id: "cmd_whimsyCreateNote",
      l10nId: "whimsy-action-create-note",
      // wave9/menus: localized (M11); no "Scratchpad", which ranked New Note
      // right under New Scratch Space for "scratch" (N4).
      whimsyKeywords: lazy.WhimsyCommands.keywords("whimsy-keywords-create-note"),
      // W10-26: the Quick Note card, where you write it right away.
      run: w => this.openQuickNote(w, { attach: false }),
      icon: "chrome://browser/skin/zen-icons/reader-mode.svg",
      isAvailable: () => this.enabled,
    });
    // W10-26: Notes in the Library, on its own command.
    lazy.WhimsyCommands.register(win, {
      id: "cmd_whimsyOpenNotes",
      l10nId: "whimsy-action-open-notes",
      run: w => this.openInLibrary(w),
      icon: "chrome://browser/skin/zen-icons/reader-mode.svg",
      isAvailable: () => this.enabled,
    });
    this.initContextMenu(win);
    this.initRailBadge(win);
  },

  /** How many of this profile's notes are kept with the page in front. */
  async pageNoteCount(win) {
    if (!this.enabled || this.isPrivate(win)) {
      return 0;
    }
    const tab = win.gBrowser?.selectedTab;
    const url = tab?.canonicalUrl ?? win.gBrowser?.currentURI?.spec ?? null;
    if (!url) {
      return 0;
    }
    const profileKey = lazy.WhimsyProfiles.keyFor(lazy.WhimsyProfiles.activeProfileId(win));
    const notes = await gWhimsyNotesStore.list(profileKey);
    return notes.filter(note => note.pageAttached && note.url == url).length;
  },

  // W13 notes C: a count badge on the Library's Notes tab when the page in
  // front has notes, so you can tell before opening it. Zen renders the
  // rail (Lit), so the badge is an attribute drawn by CSS (::after), put
  // back whenever the rail is drawn again; it follows the page, the notes
  // and the profile.
  initRailBadge(win) {
    if (win._whimsyNoteBadge) {
      return;
    }
    let pending = false;
    const update = () => {
      if (pending || win.closed) {
        return;
      }
      pending = true;
      win.setTimeout(() => {
        pending = false;
        this.updateRailBadge(win).catch(e => console.error("Whimsy: notes badge", e));
      }, 0);
    };
    win._whimsyNoteBadge = update;
    const observer = { observe: update };
    Services.obs.addObserver(observer, NOTES_CHANGED_TOPIC);
    Services.prefs.addObserver("whimsy.feature.notes", update);
    win.gBrowser?.tabContainer?.addEventListener("TabSelect", update);
    win.addEventListener("ZenWorkspacesUIUpdate", update);
    const progress = { onLocationChange: update };
    win.gBrowser?.addProgressListener(progress);
    // The rail is drawn by Zen's <zen-library> when it first opens and again
    // after it changes: put the badge back on the new tab.
    let rail = null;
    const library = win.document.querySelector("zen-library");
    if (library) {
      rail = new win.MutationObserver(records => {
        // Only the rail matters; the sections' own rows change all the time.
        const railChanged = records.some(r => !r.target.closest?.("#zen-library-content") &&
          (r.type == "attributes" ||
            [...r.addedNodes].some(n => n.classList?.contains("zen-library-tab") || n.querySelector?.(".zen-library-tab"))));
        if (railChanged) {
          update();
        }
      });
      rail.observe(library, { childList: true, subtree: true, attributes: true, attributeFilter: ["data-section"] });
    }
    win.addEventListener("unload", () => {
      Services.obs.removeObserver(observer, NOTES_CHANGED_TOPIC);
      Services.prefs.removeObserver("whimsy.feature.notes", update);
      win.gBrowser?.removeProgressListener(progress);
      rail?.disconnect();
    }, { once: true });
    update();
  },

  async updateRailBadge(win) {
    const tabs = win.document.querySelectorAll("zen-library .zen-library-tab");
    if (!tabs.length) {
      return;
    }
    const count = await this.pageNoteCount(win);
    const label = count ? await lazy.l10n.formatValue("whimsy-library-notes-badge", { count }) : null;
    for (const tab of win.document.querySelectorAll("zen-library .zen-library-tab")) {
      if (tab.dataset.section == "whimsy-notes" && count) {
        if (tab.getAttribute(NOTE_COUNT_ATTR) != String(count)) {
          tab.setAttribute(NOTE_COUNT_ATTR, String(count));
        }
        tab.setAttribute("aria-description", label);
      } else if (tab.hasAttribute(NOTE_COUNT_ATTR)) {
        tab.removeAttribute(NOTE_COUNT_ATTR);
        tab.removeAttribute("aria-description");
      }
    }
  },

  // Opens the Library on Notes (never closes it, unlike a toggle), with
  // `noteId` open for editing.
  openInLibrary(win, noteId = null) {
    const ZenLibrary = win.customElements.get("zen-library");
    if (!ZenLibrary?.toggle) {
      return false;
    }
    const lib = win.document.querySelector("zen-library");
    if (lib?.zenLibrarySections && !("whimsy-notes" in lib.zenLibrarySections)) {
      return false;
    }
    this._focusNote.set(win, noteId);
    if (lib?.activeTab != "whimsy-notes" || !ZenLibrary.isLibraryOpen) {
      ZenLibrary.toggle("whimsy-notes");
    }
    win.document.querySelector("whimsy-library-notes-section")?.focusPendingNote?.();
    return true;
  },

  _focusNote: new WeakMap(),

  // The note the Library should open on, once (see openInLibrary).
  takeFocusNote(win) {
    const id = this._focusNote.get(win) ?? null;
    this._focusNote.delete(win);
    return id;
  },

  // "Note saved" · its title (or first line) and the page's host · Open.
  showSavedToast(win, note) {
    let host = "";
    try {
      host = note.url ? new URL(note.url).host : "";
    } catch {}
    const name = note.title || (note.text ?? "").split("\n").find(line => line.trim())?.trim() || "";
    const detail = [name.slice(0, 80), host].filter(Boolean).join(" · ");
    lazy.WhimsyToast.show(win, {
      l10nId: "whimsy-note-saved-toast",
      detail: detail || undefined,
      action: {
        l10nId: "whimsy-note-saved-open",
        onCommand: () => this.openInLibrary(win, note.id),
      },
    });
  },

  // W10-26: New Note opens a small card (the Edit Space Look family: 380px,
  // beside the sidebar) with Title and a note body, the keyboard already in
  // the body. Nothing is stored until you type; then it saves as you type.
  // "This page" keeps it with the page (Firefox's TabNotes, by the page's
  // address), so it shows again when you open it; never for a private
  // page. Closing (Esc, Done, ⌘Return, a click outside, another tab) keeps
  // what you wrote and says so with an Open button; an empty card leaves
  // nothing behind.
  async openQuickNote(win, { attach = false } = {}) {
    const doc = win.document;
    const existing = doc.getElementById(QUICK_NOTE_ID);
    if (existing?.state == "open" || existing?.state == "showing") {
      existing.querySelector(".whimsy-quick-note-body")?.focus();
      if (attach) {
        await existing._whimsySetAttached?.(true);
      }
      return existing;
    }
    existing?.remove();

    const tab = win.gBrowser?.selectedTab ?? null;
    const isPrivate = this.isPrivate(win);
    const profileKey = lazy.WhimsyProfiles.keyFor(lazy.WhimsyProfiles.activeProfileId(win));
    const pageURL = !isPrivate ? (tab?.canonicalUrl ?? win.gBrowser?.currentURI?.spec ?? null) : null;
    let host = "";
    try {
      host = pageURL ? new URL(pageURL).host : "";
    } catch {}
    // Any page with an address, canonical or not (a data: page has none).
    const canAttach = !isPrivate && !!pageURL && !/^about:(blank|newtab|home)$/.test(pageURL);

    const panel = doc.createXULElement("panel");
    panel.id = QUICK_NOTE_ID;
    panel.className = "whimsy-look-picker whimsy-quick-note";
    panel.setAttribute("type", "arrow");
    panel.setAttribute("orient", "vertical");
    panel.setAttribute("role", "dialog");
    panel.setAttribute("noautofocus", "true");
    panel.setAttribute("hidepopovertail", "true");
    panel.setAttribute("aria-labelledby", `${QUICK_NOTE_ID}-title`);

    const view = doc.createXULElement("vbox");
    view.className = "whimsy-look-picker-view";
    panel.append(view);

    const header = doc.createXULElement("hbox");
    header.className = "whimsy-look-picker-header";
    header.setAttribute("align", "center");
    const title = doc.createElementNS(HTML_NS, "h2");
    title.id = `${QUICK_NOTE_ID}-title`;
    title.className = "whimsy-look-picker-title";
    doc.l10n.setAttributes(title, "whimsy-quick-note-title");
    const status = doc.createElementNS(HTML_NS, "span");
    status.className = "whimsy-look-hint whimsy-quick-note-status";
    status.setAttribute("role", "status");
    header.append(title, status);

    const name = doc.createElementNS(HTML_NS, "input");
    name.id = `${QUICK_NOTE_ID}-name`;
    name.type = "text";
    name.className = "whimsy-look-search whimsy-quick-note-name";
    name.maxLength = 200;
    doc.l10n.setAttributes(name, "whimsy-quick-note-name");

    const body = doc.createElementNS(HTML_NS, "textarea");
    body.id = `${QUICK_NOTE_ID}-body`;
    body.className = "whimsy-quick-note-body";
    body.rows = 6;
    doc.l10n.setAttributes(body, "whimsy-quick-note-body");

    // "This page · host": a checkbox chip.
    const chipRow = doc.createXULElement("hbox");
    chipRow.className = "whimsy-quick-note-chips";
    const chip = doc.createElementNS(HTML_NS, "button");
    chip.type = "button";
    chip.className = "whimsy-quick-note-attach";
    chip.setAttribute("role", "checkbox");
    chip.setAttribute("aria-checked", "false");
    const check = doc.createElementNS(HTML_NS, "span");
    check.className = "whimsy-quick-note-check";
    check.setAttribute("aria-hidden", "true");
    const favicon = doc.createElementNS(HTML_NS, "img");
    favicon.className = "whimsy-quick-note-favicon";
    favicon.alt = "";
    const icon = tab?.getAttribute("image");
    if (icon && canAttach) {
      favicon.src = icon;
    } else {
      favicon.hidden = true;
    }
    const chipLabel = doc.createElementNS(HTML_NS, "span");
    chip.append(check, favicon, chipLabel);
    if (canAttach) {
      doc.l10n.setAttributes(chipLabel, "whimsy-quick-note-attach", { host });
      doc.l10n.setAttributes(chip, "whimsy-quick-note-attach-button", { host });
    } else {
      chip.disabled = true;
      doc.l10n.setAttributes(chipLabel, isPrivate ? "whimsy-quick-note-private" : "whimsy-quick-note-no-page");
    }
    chipRow.append(chip);

    const footer = doc.createXULElement("hbox");
    footer.className = "panel-footer whimsy-look-footer whimsy-quick-note-footer";
    footer.setAttribute("align", "center");
    const hint = doc.createElementNS(HTML_NS, "span");
    hint.className = "whimsy-look-hint whimsy-quick-note-hint";
    let profileName = "";
    try {
      profileName = lazy.WhimsyProfiles.nameOf(lazy.WhimsyProfiles.activeProfileId(win)) || "";
    } catch {}
    const button = (l10nId, onCommand, primary = false) => {
      const el = doc.createXULElement("button");
      el.className = "footer-button";
      if (primary) {
        el.classList.add("primary");
        el.setAttribute("default", "true");
      }
      doc.l10n.setAttributes(el, l10nId);
      el.addEventListener("command", onCommand);
      return el;
    };
    let openAfter = false;
    const openInNotes = button("whimsy-quick-note-open", () => {
      openAfter = true;
      lazy.WhimsyPanels.close(panel);
    });
    openInNotes.classList.add("whimsy-quick-note-open");
    const done = button("whimsy-quick-note-done", () => lazy.WhimsyPanels.close(panel), true);
    done.classList.add("whimsy-quick-note-done");
    footer.append(hint, openInNotes, done);

    view.append(header, name, body, chipRow, footer);

    // --- State: one note, made on the first keystroke, saved as you type.
    let note = null;
    let creating = null;
    let timer = null;
    let attached = false;
    const showHint = () => {
      if (attached) {
        doc.l10n.setAttributes(hint, "whimsy-quick-note-hint-attached");
      } else if (profileName) {
        doc.l10n.setAttributes(hint, "whimsy-quick-note-hint", { profile: profileName });
      } else {
        doc.l10n.setAttributes(hint, "whimsy-quick-note-hint-plain");
      }
    };
    showHint();
    const ensureNote = () => {
      creating ??= gWhimsyNotesStore
        .create({ profileKey, title: name.value, text: body.value })
        .then(created => (note = created));
      return creating;
    };
    const save = async () => {
      win.clearTimeout(timer);
      timer = null;
      if (!note) {
        if (!name.value && !body.value && !attached) {
          return;
        }
        await ensureNote();
      }
      const text = body.value;
      await gWhimsyNotesStore.update(note.id, { title: name.value, text });
      if (attached && tab && !tab.closing) {
        try {
          await lazy.TabNotes.set(tab, text || " ");
        } catch (e) {
          // An address TabNotes can't keep (about:, data:); the note keeps it.
        }
      }
      doc.l10n.setAttributes(status, "whimsy-quick-note-saved");
    };
    panel._whimsyFlush = save;
    const onInput = () => {
      win.clearTimeout(timer);
      timer = win.setTimeout(() => save().catch(console.error), QUICK_NOTE_SAVE_MS);
    };
    name.addEventListener("input", onInput);
    body.addEventListener("input", onInput);
    // The body grows with what you write, up to 12 lines, then scrolls.
    body.addEventListener("input", () => {
      body.rows = Math.min(12, Math.max(6, body.value.split("\n").length));
    });

    const setAttached = async on => {
      if (!canAttach) {
        return;
      }
      await ensureNote();
      win.clearTimeout(timer);
      let updated;
      if (on) {
        try {
          await lazy.TabNotes.set(tab, body.value || " ");
        } catch (e) {
          // Kept by the note's own address even where TabNotes can't.
        }
        updated = await gWhimsyNotesStore.update(note.id, {
          title: name.value,
          text: body.value,
          pageAttached: true,
          url: pageURL,
        });
      } else {
        updated = await gWhimsyNotesStore.update(note.id, { pageAttached: false, url: null });
        try {
          if (await lazy.TabNotes.has(tab)) {
            await lazy.TabNotes.delete(tab);
          }
        } catch (e) {}
      }
      // What the store says, never what we hoped.
      attached = !!updated?.pageAttached;
      chip.setAttribute("aria-checked", attached);
      showHint();
      doc.l10n.setAttributes(status, "whimsy-quick-note-saved");
    };
    panel._whimsySetAttached = setAttached;
    chip.addEventListener("click", () => setAttached(chip.getAttribute("aria-checked") != "true").catch(console.error));

    // ⌘Return (Ctrl+Return) is Done.
    panel.addEventListener("keydown", event => {
      if (event.key == "Enter" && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        lazy.WhimsyPanels.close(panel);
      }
    });
    // Another tab: the card was about this one.
    const onTabSelect = () => lazy.WhimsyPanels.close(panel);
    win.gBrowser?.tabContainer?.addEventListener("TabSelect", onTabSelect);

    let closed = false;
    panel.addEventListener("popupshown", event => {
      if (event.target == panel) {
        body.focus();
      }
    });
    panel.addEventListener("popuphidden", async event => {
      if (event.target != panel || closed) {
        return;
      }
      closed = true;
      win.gBrowser?.tabContainer?.removeEventListener("TabSelect", onTabSelect);
      try {
        await save();
        await creating;
        if (note && !name.value.trim() && !body.value.trim()) {
          // Empty: nothing was written, so nothing stays.
          await gWhimsyNotesStore.remove(note.id);
          if (attached) {
            try {
              await lazy.TabNotes.delete(tab);
            } catch (e) {}
          }
        } else if (note) {
          const saved = { ...note, title: name.value, text: body.value };
          if (openAfter) {
            this.openInLibrary(win, note.id);
          } else {
            this.showSavedToast(win, saved);
          }
        } else if (openAfter) {
          this.openInLibrary(win);
        }
      } catch (e) {
        console.error("Whimsy: quick note", e);
      } finally {
        panel.remove();
      }
    });

    (doc.getElementById("mainPopupSet") ?? doc.documentElement).append(panel);
    // Where Edit Space Look opens: beside the sidebar, level with its top.
    const rightSide = !!win.gZenVerticalTabsManager?._prefsRightSide;
    const sidebar = lazy.WhimsyPanels.visibleAnchor(win, ["TabsToolbar", "navigator-toolbox"]);
    if (sidebar) {
      panel.openPopup(sidebar, {
        position: rightSide ? "topleft topright" : "topright topleft",
        x: rightSide ? 10 : -10,
        y: 0,
      });
    } else {
      lazy.WhimsyPanels.open(win, panel);
    }
    if (attach && canAttach) {
      await setAttached(true);
    }
    return panel;
  },

  // wave8/isolation + W8-49: a note belongs to the showing space's profile,
  // and a private page's address and title never go to disk.
  isPrivate(win) {
    const tab = win.gBrowser?.selectedTab;
    return !!tab && (lazy.WhimsyPrivate.isPrivateTab(tab) || lazy.WhimsyPrivate.isPrivateBrowser(tab.linkedBrowser));
  },

  async createNote(win, { url = null, title = "" } = {}) {
    if (this.isPrivate(win)) {
      url = null;
      title = "";
    }
    const profileKey = lazy.WhimsyProfiles.keyFor(lazy.WhimsyProfiles.activeProfileId(win));
    const note = await gWhimsyNotesStore.create({ url, title, profileKey });
    this.openInLibrary(win, note.id);
    return note;
  },

  initContextMenu(win) {
    const menu = win.document.getElementById("contentAreaContextMenu");
    if (!menu) {
      return;
    }
    menu.addEventListener("popupshowing", event => {
      if (event.target == menu) {
        this.updateContextMenu(win);
      }
    });
  },

  updateContextMenu(win) {
    const { document } = win;
    const context = win.gContextMenu;
    const item = document.getElementById("context-whimsy-new-note");
    // wave9/menus (design-full-4 L1): the page menu only. On a link, image,
    // canvas or media player it would save the page, not what was clicked.
    const show = this.enabled && !!context && !context.onTextInput && !context.onEditable && !context.isContentSelected &&
      !context.onLink && !context.onImage && !context.onCanvas && !context.onVideo && !context.onAudio &&
      !this.isPrivate(win);
    if (!show) {
      if (item) {
        item.hidden = true;
      }
      return;
    }
    let el = item;
    if (!el) {
      el = document.createXULElement("menuitem");
      el.id = "context-whimsy-new-note";
      el.setAttribute("data-l10n-id", "whimsy-context-new-note");
      // W10-26: the Quick Note card, already kept with this page.
      el.addEventListener("command", () => {
        this.openQuickNote(win, { attach: true }).catch(console.error);
      });
    }
    el.hidden = false;
    const anchor = document.getElementById("context-whimsy-copy-markdown") || document.getElementById("context-savepage");
    if (anchor && anchor.nextElementSibling != el) {
      anchor.after(el);
    } else if (!el.parentNode) {
      document.getElementById("contentAreaContextMenu").appendChild(el);
    }
  },
};

