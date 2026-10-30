/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// batch8: tab lifecycle — find heavy tabs (Opera GX's Hot Tabs Killer).
//
// A one-click list of the tabs using the most RAM, with a close button
// next to each — used reactively, the moment the browser feels sluggish,
// as a faster alternative to hunting through Activity Monitor for the
// browser's own tab-to-process mapping. ChromeUtils.requestProcInfo()
// already gives per-process memory/CPU and each process's windows array,
// which maps back to tabs via outerWindowID; there's no per-tab UI for it
// anywhere in Zen. Fission means a tab's content process can be shared
// with same-site tabs (process-per-site-group), so this groups tied tabs
// together under one memory figure instead of claiming false precision.
//
// Polls only while the popover is open, every POLL_INTERVAL_MS, and only
// samples CPU time as a delta between two polls (requestProcInfo reports
// cumulative time).

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  WhimsyPanels: "resource:///modules/whimsy/WhimsyPanels.sys.mjs",
});

const FEATURE_PREF = "whimsy.feature.heavy-tabs";
const PANEL_ID = "whimsyHeavyTabsPanel";
const POLL_INTERVAL_MS = 3000;
const TOP_N = 8;

export const WhimsyHeavyTabs = {
  get enabled() {
    return Services.prefs.getBoolPref(FEATURE_PREF, true);
  },

  initWindow(win) {
    const { WhimsyShortcuts } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyShortcuts.sys.mjs");
    WhimsyShortcuts.addActions([
      {
        l10nId: "whimsy-action-heavy-tabs",
        icon: "chrome://global/skin/icons/performance.svg",
        command: w => this.openPanel(w),
        isAvailable: () => this.enabled,
      },
    ]);
  },

  async sample(win) {
    const info = await ChromeUtils.requestProcInfo();
    const byOuterWindowId = new Map();
    for (const tab of win.gBrowser.tabs) {
      const id = tab.linkedBrowser?.outerWindowID;
      if (id) {
        byOuterWindowId.set(id, tab);
      }
    }
    const groups = [];
    for (const proc of [info, ...(info.children || [])]) {
      const tabs = [...new Set((proc.windows || []).map(w => byOuterWindowId.get(w.outerWindowId)).filter(Boolean))];
      if (tabs.length) {
        groups.push({ pid: proc.pid, memory: proc.memory || 0, cpuTime: proc.cpuTime || 0, tabs });
      }
    }
    groups.sort((a, b) => b.memory - a.memory);
    return groups.slice(0, TOP_N);
  },

  formatBytes(bytes) {
    const mb = bytes / (1024 * 1024);
    return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${mb.toFixed(0)} MB`;
  },

  // fixB: a WhimsyPanels sheet, centred like the command bar it opens
  // from. One caption per process (its memory and CPU), then its tabs;
  // click a tab to go to it, or close it from the row.
  panel(win) {
    return win.document.getElementById(PANEL_ID);
  },

  async refresh(win) {
    const panel = this.panel(win);
    if (!panel) {
      return;
    }
    const now = Date.now();
    const groups = await this.sample(win);
    if (!panel.isConnected) {
      return;
    }
    const prev = panel._prevSample;
    panel._prevSample = { groups, time: now };
    this.render(win, groups, prev);
  },

  render(win, groups, prev) {
    const panel = this.panel(win);
    if (!panel) {
      return;
    }
    const { document } = win;
    const list = panel.querySelector(".whimsy-sheet-body");
    // Keep keyboard focus on the same tab's row across refreshes.
    const focusedTab = document.activeElement?.closest?.(".whimsy-sheet-line")?._whimsyTab;
    const focusedClose = !!document.activeElement?.closest?.(".whimsy-sheet-line-actions");
    list.replaceChildren();
    if (!groups.length) {
      list.append(
        lazy.WhimsyPanels.empty(document, {
          l10nId: "whimsy-heavy-tabs-empty",
          icon: "chrome://global/skin/icons/performance.svg",
        })
      );
      return;
    }
    let refocus = null;
    for (const group of groups) {
      const prevGroup = prev?.groups.find(g => g.pid == group.pid);
      let cpu = "";
      if (prevGroup && prev.time) {
        const seconds = (Date.now() - prev.time) / 1000;
        // cpuTime is cumulative, in nanoseconds.
        const pct = seconds > 0 ? ((group.cpuTime - prevGroup.cpuTime) / 1e9 / seconds) * 100 : 0;
        cpu = `${Math.max(0, Math.round(pct))}% CPU`;
      }
      const caption = lazy.WhimsyPanels.caption(document, { text: this.formatBytes(group.memory), detail: cpu });
      caption.classList.add("whimsy-heavy-tabs-group");
      list.append(caption);
      for (const tab of group.tabs) {
        const item = lazy.WhimsyPanels.item(document, {
          label: tab.label,
          subtitle: tab.linkedBrowser?.currentURI?.displayHost || "",
          icon: tab.getAttribute("image") || "chrome://global/skin/icons/defaultFavicon.svg",
          favicon: true,
          onCommand: () => {
            lazy.WhimsyPanels.close(panel);
            if (tab.isConnected && !tab.closing) {
              win.gBrowser.selectedTab = tab;
            }
          },
        });
        item.classList.add("whimsy-heavy-tabs-row");
        const close = lazy.WhimsyPanels.iconButton(document, {
          icon: "chrome://browser/skin/zen-icons/close.svg",
          l10nId: "whimsy-heavy-tabs-close-tab",
          onCommand: () => {
            if (tab.isConnected && !tab.closing) {
              win.gBrowser.removeTab(tab, { animate: false });
            }
            this.refresh(win);
          },
        });
        close.classList.add("whimsy-heavy-tabs-close");
        const line = lazy.WhimsyPanels.line(document, item, close);
        line._whimsyTab = tab;
        list.append(line);
        if (tab == focusedTab) {
          refocus = focusedClose ? close : item;
        }
      }
    }
    refocus?.focus();
  },

  openPanel(win) {
    const { panel, body } = lazy.WhimsyPanels.create(win, {
      id: PANEL_ID,
      titleL10nId: "whimsy-heavy-tabs-title",
      subtitleL10nId: "whimsy-heavy-tabs-subtitle",
      size: "medium",
      onHidden: () => {
        if (panel._timer != null) {
          win.clearInterval(panel._timer);
          panel._timer = null;
        }
        panel._prevSample = null;
      },
    });
    body.append(
      lazy.WhimsyPanels.empty(win.document, {
        l10nId: "whimsy-heavy-tabs-measuring",
        icon: "chrome://global/skin/icons/performance.svg",
      })
    );
    panel.addEventListener("popupshown", () => {
      this.refresh(win);
      panel._timer = win.setInterval(() => this.refresh(win), POLL_INTERVAL_MS);
    });
    lazy.WhimsyPanels.open(win, panel);
  },
};
