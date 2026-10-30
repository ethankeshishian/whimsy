/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// batch8: tab lifecycle — tree-style tabs with Islands mode
// (whimsy.feature.tree-tabs, on per the wave-3 request). A settings radio
// picks "Tree" (Waterfox 6.7/Sidebery: nest a tab under whichever tab opened
// it, indented, any depth) or "Islands" (Opera Tab Islands: the same tree
// flattened to one visible level with a colored pill per root). Build-plan
// answer: max depth 4, and closing a tab with children archives the whole
// branch as one group (restorable together from the Archive view).
//
// Arc-vs-Zen call: Zen's folders pin every member tab, so they can't hold
// ordinary link-spawned tabs. This builds its own nesting over the parent
// chain Firefox already tracks as `tab.openerTab`, and leaves folders alone.
//
// wave3: collapse/expand and drag-to-reparent (Sidebery's model).
// - A disclosure button on each parent folds its subtree; nested folds are
//   kept, and selecting a folded tab (Ctrl+Tab, search) unfolds its
//   ancestors. Folding is presentation only: it overrides `tab.visible` (what
//   keyboard navigation, Ctrl+Tab and drag lists read) but never touches the
//   `hidden` attribute Zen's spaces and extensions own.
// - After a native same-window drop, the horizontal offset of the drop
//   (14px, one indent level, per step) sets the new depth: drag left past
//   the parent's indent to detach a tab, right to nest it under the tab
//   above. The dropped tab's own subtree follows it.
// Relationships never cross spaces, containers, private contexts, or
// pinned/Essential/split tabs.

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  WhimsyArchive: "resource:///modules/whimsy/WhimsyArchive.sys.mjs",
  FOLDER_COLORS: "resource:///modules/whimsy/WhimsyFolderColors.sys.mjs",
  WhimsyUndo: "resource:///modules/whimsy/WhimsyUndo.sys.mjs",
});

const FEATURE_PREF = "whimsy.feature.tree-tabs";
const STYLE_PREF = "whimsy.tabs.tree-style";
const MAX_DEPTH = 4;
const EVENTS = ["TabOpen", "TabClose", "TabMove", "TabSelect", "TabPinned", "TabUnpinned"];
const visibility = new WeakMap();

export const WhimsyTreeTabs = {
  get enabled() {
    return Services.prefs.getBoolPref(FEATURE_PREF, true);
  },

  get style() {
    return Services.prefs.getStringPref(STYLE_PREF, "tree");
  },

  initWindow(win) {
    this.wrapClose(win);
    this.initInteraction(win);
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
    return this.eligible(tab) && this.eligible(opener) && opener.isConnected &&
      !opener.closing && opener != tab && opener.ownerDocument == tab.ownerDocument &&
      opener.getAttribute("zen-workspace-id") == tab.getAttribute("zen-workspace-id") &&
      opener.userContextId == tab.userContextId &&
      opener.linkedBrowser.browsingContext?.usePrivateBrowsing ==
        tab.linkedBrowser.browsingContext?.usePrivateBrowsing ? opener : null;
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
    return this.ancestorsOf(tab).at(-1) ?? tab;
  },

  ancestorsOf(tab) {
    const seen = new Set([tab]);
    const result = [];
    for (let parent = this.openerOf(tab); parent && !seen.has(parent); parent = this.openerOf(parent)) {
      result.push(parent);
      seen.add(parent);
    }
    return result;
  },

  eligible(tab) {
    return tab?.localName == "tab" && !tab.pinned && !tab.closing &&
      !tab.hasAttribute("zen-essential") && !tab.hasAttribute("zen-empty-tab") && !tab.splitview;
  },

  toggleBranch(win, tab) {
    if (!this.enabled || !this.hasChildren(win, tab)) {
      return;
    }
    const collapse = !tab.hasAttribute("whimsy-tree-collapsed");
    if (collapse) {
      const branch = this.descendantsOf(win, tab);
      win.gBrowser.clearMultiSelectedTabs();
      if (branch.includes(win.gBrowser.selectedTab)) {
        win.gBrowser.selectedTab = tab;
      }
    }
    tab.toggleAttribute("whimsy-tree-collapsed", collapse);
    this.render(win);
  },

  initInteraction(win) {
    const container = win.gBrowser.tabContainer;
    // Capture before the tab's own mouse handlers select/close/rename it.
    for (const type of ["mousedown", "mouseup", "click", "dblclick", "keydown"]) {
      container.addEventListener(type, event => {
        const button = event.target.closest?.(".whimsy-tree-toggle");
        if (!button || !this.enabled) {
          return;
        }
        event.stopPropagation();
        if (type != "keydown" || ["Enter", " "].includes(event.key)) {
          event.preventDefault();
        }
        if ((type == "click" && event.button == 0) ||
            (type == "keydown" && ["Enter", " "].includes(event.key))) {
          this.toggleBranch(win, button.closest("tab"));
        }
      }, true);
    }
    let drag = null;
    container.addEventListener("dragstart", event => {
      const tab = event.target.closest?.("tab");
      if (!this.enabled || !this.eligible(tab)) {
        drag = null;
        return;
      }
      const depth = this.depthOf(tab);
      drag = { tab, x: event.clientX, depth: this.style == "islands" ? Math.min(1, depth) : depth };
    }, true);
    container.addEventListener("drop", event => {
      if (!drag || !this.enabled || event.dataTransfer.dropEffect != "move") {
        return;
      }
      const { tab, x, depth } = drag;
      const moving = [...(tab._dragData?.movingTabs ?? [tab])];
      const rtl = win.getComputedStyle(container).direction == "rtl";
      const indent = Math.round((event.clientX - x) * (rtl ? -1 : 1) / 14);
      // This capture listener runs before the native drop handler, and a
      // microtask would still run before it (microtasks run after each event
      // listener), so wait a task for the native move, then use its final
      // order. Copies, external drops and cancels never get here.
      win.setTimeout(() => this.reparentDropped(win, moving, Math.max(0, depth + indent)), 0);
      drag = null;
    }, true);
    container.addEventListener("dragend", () => { drag = null; }, true);
  },

  reparentDropped(win, moving, depth) {
    if (!this.enabled) {
      return;
    }
    const moved = new Set(moving);
    for (const tab of moving) {
      if (!this.eligible(tab) || !tab.isConnected || moved.has(this.openerOf(tab))) {
        continue;
      }
      const branch = this.descendantsOf(win, tab).sort((a, b) => a.index - b.index);
      const tabs = win.gBrowser.tabs;
      let previous = tabs.slice(0, tabs.indexOf(tab)).reverse().find(t =>
        !moved.has(t) && !branch.includes(t) && this.eligible(t) && t.visible &&
        t.getAttribute("zen-workspace-id") == tab.getAttribute("zen-workspace-id"));
      const desired = Math.min(this.style == "islands" ? 1 : MAX_DEPTH, depth);
      previous = desired && previous ? [previous, ...this.ancestorsOf(previous)].find(t =>
        this.depthOf(t) < desired) : null;
      // A detached branch retains its internal relationships. Never introduce
      // a cycle or a parent in another container/private browsing context.
      tab.openerTab = previous && !this.ancestorsOf(previous).includes(tab) ? previous : null;
      if (!this.openerOf(tab)) {
        tab.openerTab = null;
      }
      if (branch.length) {
        win.gBrowser.moveTabsAfter(branch, tab);
      }
    }
    this.render(win);
  },

  setTreeHidden(tab, hidden) {
    // Native keyboard navigation, focus and drag lists all use tab.visible.
    // Keep Zen's hidden attribute and SessionStore's hiddenBy untouched.
    if (!visibility.has(tab)) {
      let proto = Object.getPrototypeOf(tab);
      while (proto && !Object.getOwnPropertyDescriptor(proto, "visible")) {
        proto = Object.getPrototypeOf(proto);
      }
      const getter = Object.getOwnPropertyDescriptor(proto, "visible").get;
      visibility.set(tab, getter);
      Object.defineProperty(tab, "visible", {
        configurable: true,
        get() { return !this.hasAttribute("whimsy-tree-hidden") && getter.call(this); },
      });
    }
    tab.toggleAttribute("whimsy-tree-hidden", hidden);
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
        tab.removeAttribute("whimsy-tree-hidden");
        tab.querySelector(".whimsy-tree-toggle")?.remove();
        if (visibility.has(tab)) {
          delete tab.visible;
          visibility.delete(tab);
        }
      }
      gBrowser.tabContainer._invalidateCachedVisibleTabs();
      win.document.documentElement.removeAttribute("whimsy-tree-tabs");
      return;
    }
    const islands = this.style == "islands";
    win.document.documentElement.setAttribute("whimsy-tree-tabs", islands ? "islands" : "tree");
    for (const tab of gBrowser.tabs) {
      if (!this.eligible(tab)) {
        tab.removeAttribute("whimsy-tree-hidden");
        tab.querySelector(".whimsy-tree-toggle")?.remove();
        tab.removeAttribute("whimsy-tree-depth");
        tab.removeAttribute("whimsy-tree-has-children");
        tab.style.removeProperty("--whimsy-tree-color");
        continue;
      }
      // Selection through search/history or Ctrl+Tab reveals the branch.
      if (tab.selected) {
        for (const parent of this.ancestorsOf(tab)) {
          parent.removeAttribute("whimsy-tree-collapsed");
        }
      }
    }
    for (const tab of gBrowser.tabs.filter(t => this.eligible(t))) {
      const depth = this.depthOf(tab);
      const hasChildren = this.hasChildren(win, tab);
      this.setTreeHidden(tab, this.ancestorsOf(tab).some(t => t.hasAttribute("whimsy-tree-collapsed")));
      let button = tab.querySelector(".whimsy-tree-toggle");
      if (hasChildren && !button) {
        button = win.document.createElementNS("http://www.w3.org/1999/xhtml", "button");
        button.className = "whimsy-tree-toggle";
        button.type = "button";
        tab.querySelector(".tab-content").prepend(button);
      }
      if (!hasChildren) {
        button?.remove();
        tab.removeAttribute("whimsy-tree-collapsed");
      } else {
        const collapsed = tab.hasAttribute("whimsy-tree-collapsed");
        button.setAttribute("aria-expanded", String(!collapsed));
        win.document.l10n.setAttributes(button, collapsed ? "whimsy-tree-expand" : "whimsy-tree-collapse");
      }
      tab.setAttribute("whimsy-tree-depth", islands ? Math.min(depth, 1) : depth);
      tab.toggleAttribute("whimsy-tree-has-children", hasChildren);
      if (depth > 0) {
        tab.style.setProperty("--whimsy-tree-color", this.colorFor(this.rootOf(tab)));
      } else {
        tab.style.removeProperty("--whimsy-tree-color");
      }
    }
    gBrowser.tabContainer._invalidateCachedVisibleTabs();
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
