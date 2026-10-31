/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// wave7/menus: the order of Zen's space menu (zenWorkspaceMoreActions,
// right-click a space icon or the space's "..."). Zen's markup and
// Whimsy's injected rows (Look and Feel, Lock, Hide, Scratch) came out
// as one list with Delete in the middle and Lock/Hide right under it.
// Grouped by what each row changes, the destructive one last (macOS HIG:
// "put destructive items at the end, separated"):
//
//   Rename · Change Icon · Edit Theme · Look and Feel · Profile ▸
//   ┃ (Zen's list of spaces, when the menu isn't for one space)
//   ┃ New Space · Manage · Routing
//   ┃ Unload · Unload Others · Share
//   ┃ Lock · Hide
//   ┃ Delete
//   ┃ Scratch's own rows, and anything else, as they came.
//
// wave9/menus (design-full-4 M3): Scratch's menu shows only what applies to
// Scratch. Rows that would delete, share, lock, hide, re-profile, unload or
// restyle it are hidden (Close Scratch replaces Delete; Share would send
// private pages' addresses); Save as Space… comes first and Close Scratch
// sits in the destructive last group. W9-09's Reset All Tabs and Show
// Hidden Spaces… join the Unload and Lock/Hide groups.
//
// Zen's file isn't edited (overlay rule): the rows are moved on every
// popupshowing, after every other listener has created and shown or
// hidden its rows (this one listens on the window, in the bubbling
// phase; theirs are on the popup). Group separators hide when a group or
// everything above it is empty, so no two ever touch.

const POPUP_ID = "zenWorkspaceMoreActions";
const SEPARATOR_PREFIX = "whimsy-space-menu-separator-";
// Zen's own separators this order replaces (hidden, not removed).
const REPLACED_ATTR = "whimsy-replaced";
// The Zen separator under its list of spaces, which this order keeps.
const LIST_END_ATTR = "whimsy-list-end";

// After Zen's list-of-spaces block (its separator, the list and the
// separator under it), each group starts with a separator of its own.
const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  WhimsyPrivate: "resource:///modules/whimsy/WhimsyPrivate.sys.mjs",
});

// Hidden on Scratch's menu; marked so the next space's menu gets them back.
const SCRATCH_HIDES = [
  "#context_zenDeleteWorkspace",
  "#context_zenShareWorkspace",
  "#whimsy-lock-space-menuitem",
  "#whimsy-hide-space-menuitem",
  "#context_zenWorkspacesOpenInContainerTab",
  "#context_zenUnloadWorkspace",
  "#whimsy-space-look-menuitem",
];
const SCRATCH_HIDDEN_ATTR = "whimsy-scratch-hidden";
const SCRATCH_KEEP = "#context_whimsyKeepScratch";
const SCRATCH_SEPARATOR = "context_whimsyScratchSeparator";
const SCRATCH_HEAD_SEPARATOR = "whimsy-space-menu-separator-scratch";

const HEAD = [
  "#context_zenEditWorkspace",
  "#context_zenEditWorkspaceIcon",
  "#context_zenChangeWorkspaceTheme",
  "#whimsy-space-look-menuitem",
  "#context_zenWorkspacesOpenInContainerTab",
];
const GROUPS = [
  [
    ':scope > menuitem[command="cmd_zenOpenWorkspaceCreation"]',
    "#context_zenManageWorkspaces",
    "#context_zenSpaceRoutingSettings",
  ],
  [
    "#context_zenUnloadWorkspace",
    "#context_zenUnloadAllOtherWorkspace",
    "#whimsy-reset-space-tabs-menuitem",
    "#context_zenShareWorkspace",
  ],
  ["#whimsy-lock-space-menuitem", "#whimsy-hide-space-menuitem", "#whimsy-show-hidden-spaces-menuitem"],
  ["#context_zenDeleteWorkspace", "#context_whimsyCloseScratch"],
];

function shown(node) {
  return !node.hidden && node.getAttribute("hidden") != "true";
}

export const WhimsySpaceMenu = {
  initWindow(win) {
    const popup = win.document.getElementById(POPUP_ID);
    if (!popup) {
      return;
    }
    this.prepare(win, popup);
    const onShowing = event => {
      if (event.target == popup) {
        try {
          this.applyScratch(win, popup, this.targetSpace(win, event));
          this.arrange(win, popup);
        } catch (e) {
          console.error("Whimsy: space menu order", e);
        }
      }
    };
    win.addEventListener("popupshowing", onShowing);
    win.addEventListener("unload", () => win.removeEventListener("popupshowing", onShowing), { once: true });
    popup.addEventListener("popuphidden", event => {
      if (event.target == popup) {
        this.restoreScratch(popup);
      }
    });
  },

  // Once per window: the separator that closes Zen's list of spaces stays
  // (it divides the first two groups); Zen's other plain separators are
  // replaced by Whimsy's, one per group.
  prepare(win, popup) {
    const { document } = win;
    const listSeparator = document.getElementById("context_zenWorkspacesSeparator");
    let keep = listSeparator?.nextElementSibling;
    while (keep && keep.localName != "menuseparator") {
      keep = keep.nextElementSibling;
    }
    for (const separator of popup.querySelectorAll(":scope > menuseparator:not([id])")) {
      if (separator != keep) {
        separator.setAttribute(REPLACED_ATTR, "true");
        separator.hidden = true;
      }
    }
    keep?.setAttribute(LIST_END_ATTR, "true");
    GROUPS.forEach((_, i) => {
      if (!document.getElementById(SEPARATOR_PREFIX + i)) {
        const separator = document.createXULElement("menuseparator");
        separator.id = SEPARATOR_PREFIX + i;
        popup.append(separator);
      }
    });
  },

  // The space the menu opened for (as WhimsyPrivate and Zen read it).
  targetSpace(win, event) {
    let id = null;
    try {
      id = event.explicitOriginalTarget?.closest?.("toolbarbutton")?.getAttribute("zen-workspace-id");
    } catch (e) {}
    return id || win.gZenWorkspaces?.activeWorkspace || null;
  },

  isScratch(win, spaceId) {
    try {
      return lazy.WhimsyPrivate.featureOn && lazy.WhimsyPrivate.isScratchId(win, spaceId);
    } catch (e) {
      return false;
    }
  },

  // Scratch's menu: hide what doesn't apply (and give it back after), and
  // drop WhimsyPrivate's own separator (this order places its rows).
  applyScratch(win, popup, spaceId) {
    this.restoreScratch(popup);
    const scratchSeparator = win.document.getElementById(SCRATCH_SEPARATOR);
    if (scratchSeparator) {
      scratchSeparator.hidden = true;
    }
    if (!this.isScratch(win, spaceId)) {
      return;
    }
    for (const selector of SCRATCH_HIDES) {
      const node = this.find(popup, selector);
      if (node && shown(node)) {
        node.hidden = true;
        node.setAttribute(SCRATCH_HIDDEN_ATTR, "true");
      }
    }
  },

  // Gives back what Scratch's menu hid: on popuphidden, so the rows are as
  // their owners left them before the next menu's listeners run.
  restoreScratch(popup) {
    for (const node of popup.querySelectorAll(`:scope > [${SCRATCH_HIDDEN_ATTR}]`)) {
      node.removeAttribute(SCRATCH_HIDDEN_ATTR);
      node.hidden = false;
    }
  },

  find(popup, selector) {
    return popup.querySelector(selector.startsWith(":scope") ? selector : `:scope > ${selector}`);
  },

  arrange(win, popup) {
    const { document } = win;
    const head = HEAD.map(s => this.find(popup, s)).filter(Boolean);
    // Scratch's Save as Space… first, with a separator of its own.
    const keep = this.find(popup, SCRATCH_KEEP);
    let keepSeparator = document.getElementById(SCRATCH_HEAD_SEPARATOR);
    if (keep && !keepSeparator) {
      keepSeparator = document.createXULElement("menuseparator");
      keepSeparator.id = SCRATCH_HEAD_SEPARATOR;
    }
    if (keep) {
      keepSeparator.hidden = !shown(keep) || !head.some(shown);
      head.unshift(keep, keepSeparator);
    }
    // Zen's list-of-spaces block, as Zen just filled it.
    const listSeparator = document.getElementById("context_zenWorkspacesSeparator");
    const list = [...popup.querySelectorAll(":scope > .zen-workspace-context-menu-item")];
    const listEnd = popup.querySelector(`:scope > menuseparator[${LIST_END_ATTR}]`);
    const order = [...head];
    if (listSeparator) {
      order.push(listSeparator, ...list);
    }
    if (listEnd) {
      order.push(listEnd);
    }
    let above = head.some(shown) || list.some(shown);
    GROUPS.forEach((selectors, i) => {
      const items = selectors.map(s => this.find(popup, s)).filter(Boolean);
      const own = document.getElementById(SEPARATOR_PREFIX + i);
      // The first group sits under Zen's own separator when it's there.
      const divider = i == 0 && listEnd ? listEnd : own;
      const any = items.some(shown);
      if (divider != own && own) {
        own.hidden = true;
      }
      if (divider) {
        divider.hidden = !(any && above);
        if (divider == own) {
          order.push(own);
        }
      }
      order.push(...items);
      above ||= any;
    });
    // Already in order (every show after the first): leave the DOM alone.
    const children = [...popup.children];
    if (order.every((node, i) => children[i] == node)) {
      return;
    }
    popup.prepend(...order);
  },
};
