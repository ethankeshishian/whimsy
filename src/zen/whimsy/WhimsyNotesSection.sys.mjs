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
    WhimsyProfiles: "resource:///modules/whimsy/WhimsyProfiles.sys.mjs",
  },
  { global: "current" }
);

const STORE_FILENAME = "whimsy-notes.json";
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

  async remove(id) {
    const file = await this.#ensureLoaded();
    file.data.notes = file.data.notes.filter(n => n.id != id);
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
