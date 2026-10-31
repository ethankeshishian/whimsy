/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// batch8: tab lifecycle — undo for tab actions.
//
// Cmd+Shift+T already reopens the single most recently closed tab
// (History:UndoCloseTab → SessionStore.undoCloseTab). What doesn't exist is
// a *general* undo: moving a tab to another space, pinning/unpinning, or
// closing has no Cmd+Z at all (Cmd+Z is the plain text cmd_undo editor
// command everywhere, and stays disabled outside a text field). Arc's Cmd+Z
// undoes the last tab-level action generically, stacking a handful of steps,
// so it's a universal safety net instead of "remember Cmd+Shift+T is
// close-only."
//
// A small ring buffer of { type, undo(), redo() } entries, per window, that
// every other Whimsy tab feature (archive, snooze, tree-close, pin/unpin,
// move-to-space) pushes to and one Cmd+Z/Cmd+Shift+Z handler drains. The
// handler only engages when focus isn't in an editable field or web content
// (checked via document.activeElement before Firefox's own cmd_undo would
// run), and it only ever intercepts the key — via preventDefault() before
// the window's <key> dispatch sees it — when there's actually something on
// the stack, so an empty stack leaves Cmd+Z as plain editor undo.

import { AppConstants } from "resource://gre/modules/AppConstants.sys.mjs";

const MAX_STACK = 20;
const FEATURE_PREF = "whimsy.feature.undo-tab-actions";

const undoStacks = new WeakMap();
const redoStacks = new WeakMap();

function isEditableTarget(win) {
  const el = win.document.activeElement;
  if (!el) {
    return false;
  }
  // Focus inside a page (including a compose box, an online editor) is the
  // page's business, not ours — we can't know its editable state from
  // chrome without an async round-trip, so the safe default is to leave it
  // alone entirely.
  if (el.localName == "browser") {
    return true;
  }
  if (el.isContentEditable) {
    return true;
  }
  if (el.localName == "textarea") {
    return true;
  }
  if (el.localName == "input") {
    const type = (el.getAttribute("type") || "text").toLowerCase();
    return !["checkbox", "radio", "button", "submit", "reset", "file", "range", "color", "image"].includes(type);
  }
  return !!el.closest?.("findbar, search-textbox, moz-input-box, [contenteditable]");
}

export const WhimsyUndo = {
  _suppressed: 0,

  get enabled() {
    return Services.prefs.getBoolPref(FEATURE_PREF, true);
  },

  // True while some other Whimsy module's own runSuppressed() is on the
  // stack — e.g. WhimsyTreeTabs checks this so it doesn't also hijack a
  // close that WhimsyArchive (idle sweep, fire button, snooze) is already
  // handling under its own reason.
  get isSuppressed() {
    return this._suppressed > 0;
  },

  // Other Whimsy modules call their own gBrowser.removeTab/removeTabs,
  // pinTab/unpinTab or moveTabToWorkspace inside this when they're about to
  // push their own, more specific undo entry (e.g. WhimsyArchive tagging a
  // reason) so the generic wraps below don't also push a plain one for the
  // same action. Also wraps undo()/redo() themselves, so an entry's own
  // undo calling, say, gBrowser.removeTab doesn't push a new entry.
  runSuppressed(fn) {
    this._suppressed++;
    try {
      return fn();
    } finally {
      this._suppressed--;
    }
  },

  push(win, entry) {
    if (!this.enabled || this._suppressed) {
      return;
    }
    const stack = undoStacks.get(win) || [];
    stack.push(entry);
    if (stack.length > MAX_STACK) {
      stack.shift();
    }
    undoStacks.set(win, stack);
    redoStacks.set(win, []); // A fresh action invalidates old redos.
  },

  /**
   * wave5/uxfix: a result toast with an Undo button bound to this exact
   * entry (Arc shows Undo on its toasts; Cmd+Z alone was invisible). The
   * entry is pushed too, so Cmd+Z still works. Without the feature switch
   * it's a plain toast.
   *
   * wave8/snooze (W8-37): drawn by WhimsyToast, the one toast every Whimsy
   * undoable action uses: the message, an "Undo" button that says so in
   * words, and the shortcut (⌘Z) beside it. Zen's toast hid the button's
   * text and left after 2s.
   *
   * @param {Window} win
   * @param {string} messageId - the toast's Fluent id
   * @param {object} entry - an undo entry, as for push()
   * @param {object} [l10nArgs]
   * @param {object} [options] - { detail } a plain-text second line
   */
  showToast(win, messageId, entry, l10nArgs = undefined, options = {}) {
    this.push(win, entry);
    const toast = { l10nId: messageId, l10nArgs, detail: options.detail };
    if (this.enabled) {
      const keys = lazy().WhimsyToast.undoKeys();
      toast.action = {
        id: "whimsy-undo-toast-button",
        l10nId: "whimsy-undo-toast-action",
        keys,
        ariaKeys: AppConstants.platform == "macosx" ? "Meta+Z" : "Control+Z",
        onCommand: () => this.undoEntry(win, entry),
      };
    }
    const shown = lazy().WhimsyToast.show(win, toast);
    if (shown) {
      shown._undoEntry = entry; // Cmd+Z on this entry also hides its toast.
    }
    return shown;
  },

  // Undoes one specific entry, wherever it sits in the stack.
  undoEntry(win, entry) {
    const stack = undoStacks.get(win) || [];
    const index = stack.lastIndexOf(entry);
    if (index < 0) {
      return false;
    }
    stack.splice(index, 1);
    stack.push(entry);
    return this.undo(win);
  },

  canUndo(win) {
    return !!undoStacks.get(win)?.length;
  },
  canRedo(win) {
    return !!redoStacks.get(win)?.length;
  },

  // wave6/zap: the entry Cmd+Z (peek) or Cmd+Shift+Z (peekRedo) would run.
  peek(win) {
    return undoStacks.get(win)?.at(-1) ?? null;
  },
  peekRedo(win) {
    return redoStacks.get(win)?.at(-1) ?? null;
  },

  // wave6/parity: what Cmd+Z would undo right now (the Edit menu names it,
  // as Arc's "Undo Archive Tab" does), or null when it's the editor's.
  pendingUndo(win) {
    if (!this.enabled || isEditableTarget(win)) {
      return null;
    }
    return undoStacks.get(win)?.at(-1)?.type ?? null;
  },

  undo(win) {
    const stack = undoStacks.get(win);
    const entry = stack?.pop();
    if (!entry) {
      return false;
    }
    // wave8/snooze: the toast offering this undo has done its job.
    const toast = lazy().WhimsyToast.current(win);
    if (toast && toast._undoEntry == entry) {
      lazy().WhimsyToast.dismiss(toast);
    }
    this.runSuppressed(() => {
      try {
        entry.undo();
      } catch (e) {
        console.error("Whimsy: undo failed", e);
      }
    });
    if (entry.redo) {
      const redos = redoStacks.get(win) || [];
      redos.push(entry);
      redoStacks.set(win, redos);
    }
    return true;
  },

  redo(win) {
    const stack = redoStacks.get(win);
    const entry = stack?.pop();
    if (!entry?.redo) {
      return false;
    }
    this.runSuppressed(() => {
      try {
        entry.redo();
      } catch (e) {
        console.error("Whimsy: redo failed", e);
      }
    });
    const undos = undoStacks.get(win) || [];
    undos.push(entry);
    undoStacks.set(win, undos);
    return true;
  },

  initWindow(win) {
    this.wrapTabActions(win);
    this.registerCommands(win);
    const onKeyDown = event => {
      if (!this.enabled || event.key?.toLowerCase() != "z" || event.altKey) {
        return;
      }
      const accel = AppConstants.platform == "macosx" ? event.metaKey && !event.ctrlKey : event.ctrlKey;
      if (!accel) {
        return;
      }
      if (isEditableTarget(win)) {
        return; // Let cmd_undo/cmd_redo run.
      }
      const wantsRedo = event.shiftKey;
      if (wantsRedo ? !this.canRedo(win) : !this.canUndo(win)) {
        return; // Nothing of ours to do; fall through to the editor command.
      }
      event.preventDefault();
      event.stopPropagation();
      wantsRedo ? this.redo(win) : this.undo(win);
    };
    // Capturing, default group: runs before the window's <key> elements are
    // matched, so preventDefault() here keeps Firefox's own Cmd+Z/Cmd+Shift+Z
    // <key> (cmd_undo/cmd_redo) from firing too.
    win.addEventListener("keydown", onKeyDown, true);
    win.addEventListener("unload", () => win.removeEventListener("keydown", onKeyDown, true), { once: true });
  },

  // wave8/snooze: Undo and Redo as commands, so the command bar offers
  // them and about:keyboard can bind them. No default key: Cmd+Z and
  // Cmd+Shift+Z stay the editor's, and the keydown handler above takes
  // them only when there's a tab action to undo.
  registerCommands(win) {
    const { WhimsyCommands } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyCommands.sys.mjs");
    WhimsyCommands.register(win, {
      id: "cmd_whimsyUndoTabAction",
      l10nId: "whimsy-action-undo-tab-action",
      run: w => this.undo(w),
      icon: "chrome://browser/skin/zen-icons/arrow-rotate-anticlockwise.svg",
      isAvailable: w => this.enabled && this.canUndo(w),
    });
    WhimsyCommands.register(win, {
      id: "cmd_whimsyRedoTabAction",
      l10nId: "whimsy-action-redo-tab-action",
      run: w => this.redo(w),
      icon: "chrome://browser/skin/zen-icons/forward.svg",
      isAvailable: w => this.enabled && this.canRedo(w),
    });
  },

  // Wraps gBrowser.removeTab/removeTabs (close), pinTab/unpinTab, and
  // ZenWorkspaces' moveTab(s)ToWorkspace (move-to-space) so every Whimsy
  // and Zen call through them pushes a plain undo entry, unless the caller
  // wrapped its own call in runSuppressed() to push something more specific.
  wrapTabActions(win) {
    const { gBrowser } = win;
    const self = this;

    const wrap = (obj, name, makeEntry) => {
      const original = obj[name];
      if (typeof original != "function" || original._whimsyUndo) {
        return;
      }
      const wrapped = function (...args) {
        const entry = self._suppressed ? null : makeEntry.apply(this, args);
        if (entry) {
          self.push(win, entry);
        }
        return original.apply(this, args);
      };
      wrapped._whimsyUndo = true;
      obj[name] = wrapped;
    };

    wrap(gBrowser, "removeTab", function (tab) {
      if (!tab || tab.pinned || tab.hasAttribute("zen-empty-tab") || tab.hasAttribute("zen-essential")) {
        return null;
      }
      const entry = {
        type: "close",
        undo: () => {
          const restored = lazy().SessionStore.undoCloseTab(win, 0, win);
          entry._restored = restored;
        },
        redo: () => {
          if (entry._restored?.isConnected && !entry._restored.closing) {
            self.runSuppressed(() => win.gBrowser.removeTab(entry._restored, { animate: false }));
          }
        },
      };
      return entry;
    });

    wrap(gBrowser, "pinTab", tab => ({
      type: "pin",
      undo: () => self.runSuppressed(() => win.gBrowser.unpinTab(tab)),
      redo: () => self.runSuppressed(() => win.gBrowser.pinTab(tab)),
    }));

    wrap(gBrowser, "unpinTab", tab => ({
      type: "unpin",
      undo: () => self.runSuppressed(() => win.gBrowser.pinTab(tab)),
      redo: () => self.runSuppressed(() => win.gBrowser.unpinTab(tab)),
    }));

    win.gZenWorkspaces?.promiseInitialized?.then(() => {
      const workspaces = win.gZenWorkspaces;
      wrap(workspaces, "moveTabsToWorkspace", function (tabs, workspaceID) {
        const prior = tabs
          .map(tab => [tab, tab.getAttribute("zen-workspace-id")])
          .filter(([tab, id]) => tab && id && id != workspaceID);
        if (!prior.length) {
          return null;
        }
        return {
          type: "move",
          undo: () =>
            self.runSuppressed(() => {
              for (const [tab, id] of prior) {
                if (tab.isConnected && !tab.closing) {
                  workspaces.moveTabToWorkspace(tab, id);
                }
              }
            }),
          redo: () =>
            self.runSuppressed(() => {
              for (const [tab] of prior) {
                if (tab.isConnected && !tab.closing) {
                  workspaces.moveTabToWorkspace(tab, workspaceID);
                }
              }
            }),
        };
      });
    });
  },
};

// A tiny lazy-import helper so the close-undo entry above doesn't need a
// module-level `lazy` object of its own just for SessionStore (and, since
// wave8/snooze, WhimsyToast).
function lazy() {
  if (!lazy._mod) {
    lazy._mod = {
      ...ChromeUtils.importESModule("moz-src:///browser/components/sessionstore/SessionStore.sys.mjs"),
      ...ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyToast.sys.mjs"),
    };
  }
  return lazy._mod;
}
