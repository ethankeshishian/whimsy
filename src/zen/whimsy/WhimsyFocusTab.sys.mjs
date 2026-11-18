/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// W29 focus sessions: Stay on this tab (intake-w29/designs/focus-this-tab.md,
// option Q1a, a tick in the Focus session sheet).
//
// While a session with it ticked runs, the window it started in shows only
// the tab it started on:
//   - the other tabs, Essentials, pinned tabs, folders, the New Tab row, and
//     the space switcher hide (the `whimsy-focus-tab` window attribute and
//     whimsy-browser.css); one muted line under the tab says how many are
//     hidden and until when;
//   - a new tab (⌘T, ⌘-click, target=_blank, links from other apps) opens
//     in Glance over the kept tab, the way Zen opens a pinned app tab's
//     outside links (ZenGlanceManager.onTabOpen); with a Glance already
//     open, the link loads in it. Glance's open-as-tab and split buttons
//     are hidden and do nothing;
//   - switching away is blocked: ⌃Tab, ⌘1-9 and the other tab keys do
//     nothing, spaces don't change, ⌘K hides its switch-to-tab rows, and a
//     tab selected any other way gives way to the kept tab again.
// Ending the session (or closing the kept tab) brings everything back.
// Other windows are untouched.

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  AppConstants: "resource://gre/modules/AppConstants.sys.mjs",
  clearTimeout: "resource://gre/modules/Timer.sys.mjs",
  setTimeout: "resource://gre/modules/Timer.sys.mjs",
});

const ATTR = "whimsy-focus-tab";
const KEEP = "whimsy-focus-keep";
const LINE_CLASS = "whimsy-focus-tab-line";
const HID = "whimsy-focus-hid";
const ICON = "chrome://browser/content/whimsy/icons/clock.svg";
const XHTML = "http://www.w3.org/1999/xhtml";
// The fades (the design: out 200ms, back 300ms).
const OUT_MS = 200;
const IN_MS = 300;

const state = new WeakMap();

function reducedMotion(win) {
  return win.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

// Keys that move to another tab.
function isSwitchKey(event) {
  const mac = lazy.AppConstants.platform == "macosx";
  const accel = mac ? event.metaKey : event.ctrlKey;
  if (event.ctrlKey && (event.key == "Tab" || event.key == "PageUp" || event.key == "PageDown")) {
    return true;
  }
  if (accel && !event.altKey && /^Digit[1-9]$/.test(event.code)) {
    return true;
  }
  if (accel && event.shiftKey && (event.code == "BracketLeft" || event.code == "BracketRight")) {
    return true;
  }
  if (accel && event.altKey && (event.key == "ArrowLeft" || event.key == "ArrowRight")) {
    return true;
  }
  return false;
}

export const WhimsyFocusTab = {
  ATTR,
  KEEP,

  openTabInGlance(win, tab) {
    const keep = this.keptTab(win);
    if (keep && !this.glanceOf(win) && win.gZenGlanceManager) {
      try {
        win.gZenGlanceManager.openGlance({ url: undefined }, tab, keep);
      } catch (e) {
        console.error("Focus: couldn't open the new tab in Glance", e);
      }
    }
  },

  isOn(win) {
    return state.has(win);
  },

  keptTab(win) {
    return state.get(win)?.keep ?? null;
  },

  // The Glance open over the kept tab, if any.
  glanceOf(win) {
    const keep = this.keptTab(win);
    const id = keep?.getAttribute("glance-id");
    if (!id) {
      return null;
    }
    return win.gBrowser.tabs.find(t => t != keep && t.hasAttribute("zen-glance-tab") && t.getAttribute("glance-id") == id) ?? null;
  },

  // The tabs the session hides in this window.
  hiddenCount(win) {
    const keep = this.keptTab(win);
    return win.gBrowser.tabs.filter(
      t => t != keep && !t.hasAttribute("zen-glance-tab") && !t.hasAttribute("zen-empty-tab") && !t.closing
    ).length;
  },

  /**
   * Hides everything but the selected tab in `win`.
   *
   * @param {Window} win
   * @param {object} session - WhimsyFocusSession (endsAt)
   */
  start(win, session) {
    if (!win?.gBrowser || state.has(win)) {
      return;
    }
    const doc = win.document;
    const gBrowser = win.gBrowser;
    let keep = gBrowser.selectedTab;
    // Started from inside a Glance: keep the page under it.
    if (keep.hasAttribute("zen-glance-tab")) {
      keep = keep.parentElement?.closest(".tabbrowser-tab") ?? keep;
    }
    keep.setAttribute(KEEP, "true");

    const entry = { keep, session, restore: [], line: null, timer: null };
    state.set(win, entry);
    // Other features already wrap these methods on the instance (private
    // tabs, space locks, and the switch queue). Deleting our override would
    // expose the prototype and permanently discard all of those wrappers.
    const override = (object, name, value) => {
      const own = Object.getOwnPropertyDescriptor(object, name);
      object[name] = value;
      entry.restore.push(() => {
        if (own) {
          Object.defineProperty(object, name, own);
        } else {
          delete object[name];
        }
      });
    };

    // New tabs open in Glance over the kept tab. Content opens must return
    // their own unloaded browser to Gecko; the Whimsy tabbrowser patch adopts
    // those tabs after construction, before returning to BrowserDOMWindow.
    const addTab = gBrowser.addTab;
    let passthrough = false;
    override(gBrowser, "addTab", function (uri, options = {}) {
      if (passthrough || options.openWindowInfo || options.adoptedTab || !state.has(win)) {
        return addTab.call(this, uri, options);
      }
      const glance = WhimsyFocusTab.glanceOf(win);
      if (glance && typeof uri == "string" && uri) {
        try {
          glance.linkedBrowser.fixupAndLoadURIString(uri, {
            triggeringPrincipal: options.triggeringPrincipal ?? Services.scriptSecurityManager.getSystemPrincipal(),
            csp: options.csp,
            referrerInfo: options.referrerInfo,
          });
          gBrowser.selectedTab = glance;
          return glance;
        } catch (e) {
          console.error("Focus: couldn't load in the open Glance", e);
        }
      }
      const tab = addTab.call(this, uri, options);
      if (!glance && tab && win.gZenGlanceManager) {
        passthrough = true;
        try {
          WhimsyFocusTab.openTabInGlance(win, tab);
        } finally {
          passthrough = false;
        }
      }
      return tab;
    });

    // Glance can't become a tab, or a split.
    const glance = win.gZenGlanceManager;
    if (glance) {
      override(glance, "fullyOpenGlance", async () => {});
      override(glance, "splitGlance", async () => {});
    }

    // Spaces don't change.
    const spaces = win.gZenWorkspaces;
    if (spaces?.changeWorkspace) {
      override(spaces, "changeWorkspace", async () => {});
    }

    // Tab keys do nothing.
    const onKey = event => {
      if (isSwitchKey(event)) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    };
    win.addEventListener("keydown", onKey, true);
    entry.restore.push(() => win.removeEventListener("keydown", onKey, true));

    // Any other way onto another tab gives way to the kept tab.
    const onSelect = () => {
      const tab = gBrowser.selectedTab;
      if (tab == keep || (tab.hasAttribute("zen-glance-tab") && tab.getAttribute("glance-id") == keep.getAttribute("glance-id"))) {
        return;
      }
      lazy.setTimeout(() => {
        if (state.get(win) == entry && !keep.closing && gBrowser.selectedTab == tab) {
          gBrowser.selectedTab = keep;
        }
      }, 0);
    };
    gBrowser.tabContainer.addEventListener("TabSelect", onSelect);
    entry.restore.push(() => gBrowser.tabContainer.removeEventListener("TabSelect", onSelect));

    // The kept tab closing ends the hiding (the session goes on).
    const onClose = event => {
      if (event.target == keep) {
        this.stop(win, { instant: true });
      } else {
        this.showLine(win);
      }
    };
    const onOpen = () => this.showLine(win);
    gBrowser.tabContainer.addEventListener("TabClose", onClose);
    gBrowser.tabContainer.addEventListener("TabOpen", onOpen);
    entry.restore.push(() => {
      gBrowser.tabContainer.removeEventListener("TabClose", onClose);
      gBrowser.tabContainer.removeEventListener("TabOpen", onOpen);
    });

    // ⌘K: no switch-to-tab rows.
    const results = doc.getElementById("urlbar-results");
    if (results) {
      const hideRows = () => {
        for (const row of results.querySelectorAll(".urlbarView-row")) {
          if (row.getAttribute("type") == "switchtab") {
            if (!row.hidden) {
              row.hidden = true;
              row.setAttribute(HID, "true");
            }
          } else if (row.hasAttribute(HID)) {
            row.hidden = false;
            row.removeAttribute(HID);
          }
        }
      };
      const observer = new win.MutationObserver(hideRows);
      observer.observe(results, { subtree: true, childList: true, attributes: true, attributeFilter: ["type"] });
      hideRows();
      entry.restore.push(() => {
        observer.disconnect();
        for (const row of results.querySelectorAll(`[${HID}]`)) {
          row.hidden = false;
          row.removeAttribute(HID);
        }
      });
    }

    const onUnload = () => state.delete(win);
    win.addEventListener("unload", onUnload, { once: true });
    entry.restore.push(() => win.removeEventListener("unload", onUnload));

    // Hide, with a fade.
    const root = doc.documentElement;
    if (reducedMotion(win)) {
      root.setAttribute(ATTR, "on");
    } else {
      root.setAttribute(ATTR, "leaving");
      entry.timer = lazy.setTimeout(() => {
        if (state.get(win) == entry) {
          root.setAttribute(ATTR, "on");
        }
      }, OUT_MS);
    }
    this.showLine(win);
  },

  // "13 tabs hidden until 3:40 PM", under the kept tab's space.
  showLine(win) {
    const entry = state.get(win);
    if (!entry) {
      return;
    }
    const doc = win.document;
    if (!entry.line) {
      const line = doc.createElementNS(XHTML, "div");
      line.className = LINE_CLASS;
      line.setAttribute("role", "status");
      const icon = doc.createElementNS(XHTML, "img");
      icon.setAttribute("src", ICON);
      icon.setAttribute("alt", "");
      const text = doc.createElementNS(XHTML, "span");
      line.append(icon, text);
      entry.line = line;
    }
    const space = entry.keep.closest("zen-workspace") ?? win.gZenWorkspaces?.activeWorkspaceElement ?? null;
    const anchor = space?.querySelector(".zen-workspace-empty-space") ?? null;
    if (anchor && entry.line.parentNode != anchor) {
      anchor.prepend(entry.line);
    } else if (!anchor && !entry.line.isConnected) {
      doc.getElementById("tabbrowser-tabs")?.after(entry.line);
    }
    const time = new Intl.DateTimeFormat(undefined, { timeStyle: "short" }).format(
      new Date(entry.session.endsAt || Date.now())
    );
    doc.l10n.setAttributes(entry.line.lastElementChild, "whimsy-focus-tabs-hidden", {
      count: this.hiddenCount(win),
      time,
    });
  },

  /** Brings the window's tabs back. */
  stop(win, { instant = false } = {}) {
    const entry = state.get(win);
    if (!entry) {
      return;
    }
    state.delete(win);
    if (entry.timer) {
      lazy.clearTimeout(entry.timer);
    }
    for (const undo of entry.restore.reverse()) {
      try {
        undo();
      } catch (e) {
        console.error(e);
      }
    }
    entry.line?.remove();
    const root = win.document?.documentElement;
    if (!root) {
      return;
    }
    const done = () => {
      if (!state.has(win)) {
        root.removeAttribute(ATTR);
        entry.keep.removeAttribute(KEEP);
      }
    };
    if (instant || win.closed || reducedMotion(win)) {
      done();
      return;
    }
    root.setAttribute(ATTR, "returning");
    lazy.setTimeout(done, IN_MS);
  },

  stopAll(windows) {
    for (const win of windows) {
      this.stop(win);
    }
  },
};
