/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// W27: Edit Field in Text Editor. The current tab's focused field (a
// textarea or a contenteditable, read and written as plain text by
// WhimsyFieldEditorChild.sys.mjs) is written to a temp file under the
// profile, opened in the Mac's default text editor (`open -t`, which picks
// the text editor regardless of what app .txt happens to be associated
// with), and watched by polling its content until it changes, writing each
// change back into the field; the watch stops when the tab navigates, the
// tab closes, the window closes, or ten minutes pass.
//
// W29: a button in the field's own bottom-end corner (WhimsyFieldEditorChild
// qualifies()) shows in exactly the fields the command is available for.
// Each child reports "Qualified { on }" whenever its own field starts or
// stops qualifying; isAvailable just reads the latest report for the
// selected tab, kept here in a WeakMap keyed by <browser>. Pressing the
// button sends "Press", which runs the very same editFocusedField() the
// command runs, so the two can never disagree about what counts.
//
// Finding the focused field is Create Email Alias's own problem
// (WhimsyEmailAliases.sys.mjs:206-236): ask every frame of the tab's own
// actor, in source order, for whatever's focused there.

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  PrivateBrowsingUtils: "resource://gre/modules/PrivateBrowsingUtils.sys.mjs",
  WhimsyLinkHints: "resource:///modules/whimsy/WhimsyLinkHints.sys.mjs",
  WhimsyCommands: "resource:///modules/whimsy/WhimsyCommands.sys.mjs",
});

// W29 r4: icon B, "open elsewhere" (owner-approved; a designer's earlier
// pass used the command's menu icon, code.svg). The field button draws the
// same shape inline (WhimsyFieldEditorChild.sys.mjs's ICON_PATH_D); this
// file is the one place to edit on a future swap, with that inline copy
// kept identical to it (a content-process button can't load a chrome://
// resource directly, so it can't just reference this file).
const ICON = "chrome://browser/content/whimsy/icons/edit-field.svg";
const DIR_NAME = "whimsy-field-editor";
const POLL_MS = 500;
const MAX_MS = 10 * 60 * 1000; // ten minutes
let keycapCSS;

export const WhimsyFieldEditor = {
  // At most one watch per window; a second run on a different field
  // replaces the first. Pressing again on the SAME field (same actor and
  // the same #read() token) reopens the same file instead.
  _sessions: new WeakMap(),
  // The latest "Qualified" report per <browser>, from whichever frame
  // reported it (kept as the reporting actor, so a stale report from an
  // actor that's since been replaced can't clobber a newer one).
  _qualified: new WeakMap(),

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
          (uri.schemeIs("https") || uri.schemeIs("http")) &&
          this.qualifiedFor(w.gBrowser?.selectedBrowser)
        );
      },
    });
    const refreshColors = () => {
      const actor = this._qualified.get(win.gBrowser.selectedBrowser);
      actor?.sendAsyncMessage("WhimsyFieldEditor:Colors", lazy.WhimsyLinkHints.colors(win));
    };
    win.addEventListener("ZenWorkspacesUIUpdate", refreshColors);
    const colorsObserver = new win.MutationObserver(refreshColors);
    colorsObserver.observe(win.document.documentElement, { attributes: true, attributeFilter: ["style"] });
    win.addEventListener("unload", () => colorsObserver.disconnect(), { once: true });
    win.addEventListener("TabClose", event => {
      if (this._sessions.get(win)?.tab == event.target) {
        this.stop(win);
      }
    });
    win.addEventListener("unload", () => this.stop(win), { once: true });
  },

  // True exactly while some frame of this browser's current page has a
  // qualifying field focused (Q2: this follows the field regardless of
  // whether the button itself is showing, so hiding it in Settings doesn't
  // take the command away).
  qualifiedFor(browser) {
    return !!browser && this._qualified.has(browser);
  },

  _setQualified(browser, on, actor) {
    if (!browser) {
      return;
    }
    if (on) {
      this._qualified.set(browser, actor);
    } else if (this._qualified.get(browser) == actor) {
      this._qualified.delete(browser);
    }
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
    if (lazy.PrivateBrowsingUtils.isWindowPrivate(win)) {
      return "private";
    }
    const browser = win.gBrowser.selectedBrowser;
    const found = await this._findFocused(browser);
    if (!found) {
      return "no-field";
    }
    const existing = this._sessions.get(win);
    if (existing && existing.actor == found.actor && existing.token == found.field.token) {
      // A second press while editing: bring the same file forward rather
      // than starting a second watch.
      this.openInEditor(existing.path);
      return "editing";
    }
    this.stop(win);
    const dir = PathUtils.join(PathUtils.profileDir, DIR_NAME);
    await IOUtils.makeDirectory(dir, { permissions: 0o700, ignoreExisting: true });
    const path = PathUtils.join(dir, `field-${Date.now()}.txt`);
    await IOUtils.writeUTF8(path, found.field.value);
    this.openInEditor(path);

    const tab = win.gBrowser.selectedTab;
    const session = {
      path,
      tab,
      url: browser.currentURI.spec,
      actor: found.actor,
      token: found.field.token,
      lastWritten: found.field.value,
    };
    session.timer = win.setInterval(() => this._tick(win), POLL_MS);
    session.deadline = win.setTimeout(() => this.stop(win), MAX_MS);
    this._sessions.set(win, session);
    this._setEditing(session.actor, true, session.token);
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

  _setEditing(actor, on, token) {
    try {
      actor?.sendAsyncMessage("WhimsyFieldEditor:Editing", { on, token });
    } catch (e) {
      // The actor may already be gone.
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
    this._setEditing(session.actor, false, session.token);
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

export class WhimsyFieldEditorParent extends JSWindowActorParent {
  receiveMessage(message) {
    if (message.name == "WhimsyFieldEditor:Style") {
      const win = this.browsingContext.topChromeWindow;
      keycapCSS ??= win.fetch("chrome://browser/content/whimsy/whimsy-link-hints.css").then(response => response.text());
      return keycapCSS.then(css => ({ css, ...lazy.WhimsyLinkHints.colors(win) }));
    }
    if (message.name == "WhimsyFieldEditor:Qualified") {
      WhimsyFieldEditor._setQualified(this.browsingContext.top.embedderElement, message.data.on, this);
    } else if (message.name == "WhimsyFieldEditor:Press") {
      const win = this.browsingContext.topChromeWindow;
      if (win) {
        WhimsyFieldEditor.editFocusedField(win).catch(e => console.error("Whimsy: field editor press", e));
      }
    }
    return null;
  }

  didDestroy() {
    WhimsyFieldEditor._setQualified(this.browsingContext.top.embedderElement, false, this);
  }
}
