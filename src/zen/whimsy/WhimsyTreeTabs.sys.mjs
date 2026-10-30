/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// batch8: tab lifecycle — tree-style tabs with Islands mode. Off by
// default (whimsy.feature.tree-tabs); a settings radio picks "Tree"
// (Waterfox 6.7/Sidebery: nest a tab under whichever tab opened it,
// indented, collapsible per branch, any depth) or "Islands" (Opera Tab
// Islands: the same tree flattened to one visible level with a colored
// pill per root). Build-plan answer: max depth 4, and closing a tab with
// children archives the whole branch as one group (restorable together
// from the Archive view) rather than silently reparenting the orphaned
// children to the grandparent.
//
// Arc-vs-Zen call: Zen's folders (ZenFolder/ZenFolders.createFolder) are
// Firefox's native tab groups, but creating one *pins every member tab*
// (gBrowser.pinTab) — folders are a pinned-tab primitive, not a home for
// ordinary tabs spawned from a link. Reusing that would force-pin every
// child tab a tree ever picks up, which isn't the Tree/Islands model. This
// builds its own lightweight nesting instead, over the parent chain
// Firefox already tracks as `tab.openerTab`, and leaves ZenFolder alone.
//
// Scope for tonight: the data model (depth, has-children, Islands color,
// orphan handling, branch-archive-on-close) and the attributes
// whimsy-browser.css needs to draw it. Interactive collapse/expand (a
// click target that folds a branch) and clearing a dragged-out child's
// parent are deferred — both need a hands-on look at Zen's tab custom
// element and drag code under a real build to get right, which a
// no-build writer pass can't verify.

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  WhimsyArchive: "resource:///modules/whimsy/WhimsyArchive.sys.mjs",
  FOLDER_COLORS: "resource:///modules/whimsy/WhimsyFolderColors.sys.mjs",
  WhimsyUndo: "resource:///modules/whimsy/WhimsyUndo.sys.mjs",
});

const FEATURE_PREF = "whimsy.feature.tree-tabs";
const STYLE_PREF = "whimsy.tabs.tree-style";
const MAX_DEPTH = 4;
const EVENTS = ["TabOpen", "TabClose", "TabMove", "TabSelect"];

export const WhimsyTreeTabs = {
  get enabled() {
    return Services.prefs.getBoolPref(FEATURE_PREF, false);
  },

  get style() {
    return Services.prefs.getStringPref(STYLE_PREF, "tree");
  },

  initWindow(win) {
    this.wrapClose(win);
    const rerender = () => {
      try {
        this.render(win);
      } catch (e) {
        console.error("Whimsy: tree-tabs render", e);
      }
    };
    const container = win.gBrowser.tabContainer;
    for (const type of EVENTS) {
      container.addEventListener(type, rerender);
    }
    for (const pref of [FEATURE_PREF, STYLE_PREF]) {
      Services.prefs.addObserver(pref, rerender);
    }
    win.addEventListener(
      "unload",
      () => {
        for (const type of EVENTS) {
          container.removeEventListener(type, rerender);
        }
        for (const pref of [FEATURE_PREF, STYLE_PREF]) {
          Services.prefs.removeObserver(pref, rerender);
        }
      },
      { once: true }
    );
    rerender();
  },

  // A tab's opener, only while that opener is still around and connected —
  // Firefox clears nothing for us when the opener closes, so a stale
  // reference would otherwise render as a phantom parent.
  openerOf(tab) {
    const opener = tab.openerTab;
    return opener && opener.isConnected && !opener.closing && opener != tab ? opener : null;
  },

  depthOf(tab) {
    let depth = 0;
    let current = tab;
    while (depth < MAX_DEPTH) {
      const opener = this.openerOf(current);
      if (!opener) {
        break;
      }
      depth++;
      current = opener;
    }
    return depth;
  },

  rootOf(tab) {
    let current = tab;
    for (let i = 0; i < MAX_DEPTH + 1; i++) {
      const opener = this.openerOf(current);
      if (!opener) {
        return current;
      }
      current = opener;
    }
    return current;
  },

  hasChildren(win, tab) {
    return win.gBrowser.tabs.some(t => this.openerOf(t) == tab);
  },

  // Direct and indirect children, deepest-last — the whole branch under
  // `tab`, regardless of the depth-4 visual cap (the real chain is kept so
  // restoring from the Archive reconstructs it).
  descendantsOf(win, tab) {
    const result = [];
    const stack = [tab];
    while (stack.length) {
      const current = stack.pop();
      for (const t of win.gBrowser.tabs) {
        if (t != tab && !result.includes(t) && this.openerOf(t) == current) {
          result.push(t);
          stack.push(t);
        }
      }
    }
    return result;
  },

  colorFor(tab) {
    const colors = Object.values(lazy.FOLDER_COLORS);
    const id = tab.getAttribute("id") || tab.linkedPanel || "";
    let hash = 0;
    for (let i = 0; i < id.length; i++) {
      hash = (hash * 31 + id.charCodeAt(i)) | 0;
    }
    return colors[Math.abs(hash) % colors.length];
  },

  render(win) {
    const { gBrowser } = win;
    if (!this.enabled) {
      for (const tab of gBrowser.tabs) {
        tab.removeAttribute("whimsy-tree-depth");
        tab.removeAttribute("whimsy-tree-has-children");
        tab.style.removeProperty("--whimsy-tree-color");
      }
      win.document.documentElement.removeAttribute("whimsy-tree-tabs");
      return;
    }
    const islands = this.style == "islands";
    win.document.documentElement.setAttribute("whimsy-tree-tabs", islands ? "islands" : "tree");
    for (const tab of gBrowser.tabs) {
      if (tab.pinned || tab.hasAttribute("zen-essential") || tab.hasAttribute("zen-empty-tab")) {
        tab.removeAttribute("whimsy-tree-depth");
        tab.removeAttribute("whimsy-tree-has-children");
        tab.style.removeProperty("--whimsy-tree-color");
        continue;
      }
      const depth = this.depthOf(tab);
      tab.setAttribute("whimsy-tree-depth", islands ? Math.min(depth, 1) : depth);
      tab.toggleAttribute("whimsy-tree-has-children", this.hasChildren(win, tab));
      if (depth > 0) {
        tab.style.setProperty("--whimsy-tree-color", this.colorFor(this.rootOf(tab)));
      } else {
        tab.style.removeProperty("--whimsy-tree-color");
      }
    }
  },

  // Closing a tab with children archives the whole branch as one group
  // instead of letting the single tab close normally; a leafless tab (or
  // the feature off) falls straight through to the real removeTab, so
  // WhimsyUndo's own close-tracking still applies to it.
  wrapClose(win) {
    const { gBrowser } = win;
    const original = gBrowser.removeTab;
    if (typeof original != "function" || original._whimsyTree) {
      return;
    }
    const self = this;
    const wrapped = function (tab, options) {
      // Skip the redirect while some other Whimsy module (idle sweep, fire
      // button, snooze) is already closing this tab under its own reason —
      // otherwise this would hijack that close into a "tree" one instead.
      if (self.enabled && !lazy.WhimsyUndo.isSuppressed && tab && tab.isConnected && !tab.closing) {
        const branch = self.descendantsOf(win, tab);
        if (branch.length) {
          lazy.WhimsyArchive.archiveTabs(win, [tab, ...branch], {
            reason: "tree",
            groupId: `tree-${Date.now()}`,
          });
          return undefined;
        }
      }
      return original.apply(this, arguments);
    };
    wrapped._whimsyTree = true;
    gBrowser.removeTab = wrapped;
  },
};
