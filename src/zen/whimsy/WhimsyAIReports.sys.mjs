/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// W23 chat-answers: deep research reports and generated documents are
// local Markdown files in the AI store (<profile>/whimsy-ai/reports, 0600),
// so their tab is an ordinary file tab the Markdown viewer shows: it
// survives a restart, can be pinned, and is found by search and in the
// Archive. Opening a report whose tab is gone opens the file again. The
// Fire button's chats option clears them.

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  WhimsyAIStore: "resource:///modules/whimsy/WhimsyAIStore.sys.mjs",
});

const INDEX = "reports";
const MAX_REPORTS = 200;

let clearerOff = null;

function slug(title) {
  return String(title || "report").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "report";
}

async function index() {
  return (await lazy.WhimsyAIStore.readDoc(INDEX, [])) ?? [];
}

export const WhimsyAIReports = {
  init() {
    clearerOff ??= lazy.WhimsyAIStore.registerClearer("reports", ({ since } = {}) => this.clear({ since }));
  },

  /**
   * Saves a report as a Markdown file.
   *
   * @returns {Promise<{id: string, path: string}>}
   */
  async save(threadId, { title = "", markdown = "", kind = "report" } = {}) {
    this.init();
    const folder = await lazy.WhimsyAIStore.folder("reports");
    const id = Services.uuid.generateUUID().toString().slice(1, 9);
    const path = PathUtils.join(folder, `${slug(title)}-${id}.md`);
    const body = /^#\s/.test(markdown) || !title ? markdown : `# ${title}\n\n${markdown}`;
    await lazy.WhimsyAIStore.writeFile(path, body);
    let list = await index();
    list.push({ id, path, title, kind, threadId, created: Date.now() });
    if (list.length > MAX_REPORTS) {
      for (const old of list.slice(0, list.length - MAX_REPORTS)) {
        await IOUtils.remove(old.path).catch(() => {});
      }
      list = list.slice(-MAX_REPORTS);
    }
    await lazy.WhimsyAIStore.writeDoc(INDEX, list);
    return { id, path };
  },

  async get(id) {
    return (await index()).find(r => r.id == id) ?? null;
  },

  /** The report's tab: the open one, or the file opened again; `select: false` leaves you where you are. */
  async open(win, id, { select = true } = {}) {
    const report = await this.get(id);
    if (!report || !(await IOUtils.exists(report.path))) {
      return null;
    }
    const spec = PathUtils.toFileURI(report.path);
    const existing = win.gBrowser.tabs.find(t => !t.closing && t.linkedBrowser.currentURI.spec == spec);
    const tab = existing ?? win.gBrowser.addTrustedTab(spec, { inBackground: !select, relatedToCurrent: true });
    if (select) {
      win.gBrowser.selectedTab = tab;
    }
    return tab;
  },

  /** Export as PDF (the print dialog's Save as PDF) or a Markdown copy. */
  async export(win, id, format) {
    const report = await this.get(id);
    if (!report) {
      return null;
    }
    if (format == "markdown") {
      const fp = Cc["@mozilla.org/filepicker;1"].createInstance(Ci.nsIFilePicker);
      fp.init(win.browsingContext, "", Ci.nsIFilePicker.modeSave);
      fp.defaultString = PathUtils.filename(report.path).replace(/-[0-9a-f]{8}\.md$/, ".md");
      const result = await new Promise(resolve => fp.open(resolve));
      if (result == Ci.nsIFilePicker.returnCancel || !fp.file) {
        return null;
      }
      await IOUtils.copy(report.path, fp.file.path);
      return fp.file.path;
    }
    const tab = await this.open(win, id);
    if (!tab) {
      return null;
    }
    const browser = tab.linkedBrowser;
    if (browser.webProgress?.isLoadingDocument || browser.currentURI.spec != PathUtils.toFileURI(report.path)) {
      await new Promise(resolve => {
        const listener = {
          onStateChange(progress, request, flags) {
            if (flags & Ci.nsIWebProgressListener.STATE_STOP && flags & Ci.nsIWebProgressListener.STATE_IS_WINDOW) {
              browser.removeProgressListener(listener);
              resolve();
            }
          },
          QueryInterface: ChromeUtils.generateQI(["nsIWebProgressListener", "nsISupportsWeakReference"]),
        };
        browser.addProgressListener(listener, Ci.nsIWebProgress.NOTIFY_STATE_WINDOW);
      });
    }
    win.PrintUtils?.startPrintWindow(browser.browsingContext);
    return tab;
  },

  async clear({ since = null } = {}) {
    const list = await index();
    const keep = [];
    for (const r of list) {
      if (since == null || (r.created ?? 0) >= since) {
        await IOUtils.remove(r.path).catch(() => {});
      } else {
        keep.push(r);
      }
    }
    await lazy.WhimsyAIStore.writeDoc(INDEX, keep);
  },
};
