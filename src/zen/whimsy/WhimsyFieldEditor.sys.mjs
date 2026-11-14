/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// W27: Edit Field in Text Editor. The current tab's focused field (an
// input, a textarea, or a contenteditable, read and written as plain text
// by WhimsyFieldEditorChild.sys.mjs) is written to a temp file under the
// profile, opened in the Mac's default text editor (`open -t`, which picks
// the text editor regardless of what app .txt happens to be associated
// with), and watched by polling its content until it changes, writing each
// change back into the field; the watch stops when the tab navigates, the
// tab closes, the window closes, or ten minutes pass.
//
// Finding the focused field is Create Email Alias's own problem
// (WhimsyEmailAliases.sys.mjs:206-236): ask every frame of the tab's own
// actor, in source order, for whatever's focused there. With nothing
// focused anywhere, a toast says so, the same way.

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  PrivateBrowsingUtils: "resource://gre/modules/PrivateBrowsingUtils.sys.mjs",
  WhimsyCommands: "resource:///modules/whimsy/WhimsyCommands.sys.mjs",
});

const ICON = "chrome://browser/skin/zen-icons/selectable/code.svg";
const DIR_NAME = "whimsy-field-editor";
const POLL_MS = 500;
const MAX_MS = 10 * 60 * 1000; // ten minutes

export class WhimsyFieldEditorParent extends JSWindowActorParent {}

export const WhimsyFieldEditor = {
  // At most one watch per window; a second run replaces the first.
  _sessions: new WeakMap(),

  initWindow(win) {
    lazy.WhimsyCommands.register(win, {
      id: "cmd_whimsyEditFieldInEditor",
      l10nId: "whimsy-action-edit-field-in-editor",
      icon: ICON,
      run: w => this.editFocusedField(w),
      isAvailable: w => {
        const uri = w.gBrowser?.selectedBrowser?.currentURI;
        return (
          !lazy.PrivateBrowsingUtils.isWindowPrivate(w) &&
          !!uri &&
          (uri.schemeIs("https") || uri.schemeIs("http"))
        );
      },
    });
    win.addEventListener("TabClose", event => {
      if (this._sessions.get(win)?.tab == event.target) {
        this.stop(win);
      }
    });
    win.addEventListener("unload", () => this.stop(win), { once: true });
  },

  // The WhimsyFieldEditor actor and the field it found, from whichever
  // frame of the tab has focus, or null with nothing focused anywhere.
  async _findFocused(browser) {
    const contexts = browser.browsingContext?.getAllBrowsingContextsInSubtree() ?? [];
    for (const context of contexts) {
      let actor = null;
      try {
        actor = context.currentWindowGlobal?.getActor("WhimsyFieldEditor");
      } catch (e) {
        continue; // not a web page the actor matches
      }
      let field = null;
      try {
        field = await actor?.sendQuery("WhimsyFieldEditor:Read");
      } catch (e) {
        continue;
      }
      if (field) {
        return { actor, field };
      }
    }
    return null;
  },

  // Resolves to "editing", "no-field" or "private", like
  // WhimsyEmailAliases.createForFocusedField.
  async editFocusedField(win) {
    this.stop(win);
    if (lazy.PrivateBrowsingUtils.isWindowPrivate(win)) {
      return "private";
    }
    const browser = win.gBrowser.selectedBrowser;
    const found = await this._findFocused(browser);
    if (!found) {
      win.gZenUIManager?.showToast?.("whimsy-field-editor-toast-no-field");
      return "no-field";
    }
    const dir = PathUtils.join(PathUtils.profileDir, DIR_NAME);
    await IOUtils.makeDirectory(dir, { permissions: 0o700, ignoreExisting: true });
    const path = PathUtils.join(dir, `field-${Date.now()}.txt`);
    await IOUtils.writeUTF8(path, found.field.value);
    this.openInEditor(path);

    const tab = win.gBrowser.selectedTab;
    const session = { path, tab, url: browser.currentURI.spec, actor: found.actor, lastWritten: found.field.value };
    session.timer = win.setInterval(() => this._tick(win), POLL_MS);
    session.deadline = win.setTimeout(() => this.stop(win), MAX_MS);
    this._sessions.set(win, session);
    return "editing";
  },

  async _tick(win) {
    const session = this._sessions.get(win);
    if (!session) {
      return;
    }
    const browser = session.tab.linkedBrowser;
    if (!browser || session.tab.closing || browser.currentURI?.spec != session.url) {
      this.stop(win);
      return;
    }
    let text;
    try {
      text = await IOUtils.readUTF8(session.path);
    } catch (e) {
      return; // removed, or not written yet; try again next tick
    }
    if (text == session.lastWritten || !this._sessions.get(win)) {
      return;
    }
    session.lastWritten = text;
    try {
      await session.actor.sendQuery("WhimsyFieldEditor:Write", { text });
    } catch (e) {
      this.stop(win);
    }
  },

  stop(win) {
    const session = this._sessions.get(win);
    if (!session) {
      return;
    }
    win.clearInterval(session.timer);
    win.clearTimeout(session.deadline);
    this._sessions.delete(win);
  },

  // `open -t` always picks the Mac's default text editor, unlike
  // nsIFile.launch() (WhimsyVerbs.launchFile), which goes by .txt's own
  // file association and could land on something else. Stubbed in tests.
  openInEditor(path) {
    try {
      const file = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
      file.initWithPath("/usr/bin/open");
      const process = Cc["@mozilla.org/process/util;1"].createInstance(Ci.nsIProcess);
      process.init(file);
      process.runAsync(["-t", path], 2);
    } catch (e) {
      console.error("Whimsy: field editor", e);
    }
  },
};
