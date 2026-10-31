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
  ["#context_zenUnloadWorkspace", "#context_zenUnloadAllOtherWorkspace", "#context_zenShareWorkspace"],
  ["#whimsy-lock-space-menuitem", "#whimsy-hide-space-menuitem"],
  ["#context_zenDeleteWorkspace"],
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
          this.arrange(win, popup);
        } catch (e) {
          console.error("Whimsy: space menu order", e);
        }
      }
    };
    win.addEventListener("popupshowing", onShowing);
    win.addEventListener("unload", () => win.removeEventListener("popupshowing", onShowing), { once: true });
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

  find(popup, selector) {
    return popup.querySelector(selector.startsWith(":scope") ? selector : `:scope > ${selector}`);
  },

  arrange(win, popup) {
    const { document } = win;
    const head = HEAD.map(s => this.find(popup, s)).filter(Boolean);
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
