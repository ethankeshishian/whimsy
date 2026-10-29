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

  panel(win) {
    const { document } = win;
    let panel = document.getElementById(PANEL_ID);
    if (panel) {
      return panel;
    }
    panel = document.createXULElement("panel");
    panel.id = PANEL_ID;
    panel.setAttribute("type", "arrow");
    panel.setAttribute("noautofocus", "true");
    panel.setAttribute("role", "dialog");
    document.l10n.setAttributes(panel, "whimsy-heavy-tabs-panel");
    const list = document.createXULElement("vbox");
    list.className = "whimsy-heavy-tabs-list";
    panel.append(list);
    panel.addEventListener("popupshown", () => {
      this.refresh(win);
      panel._timer = win.setInterval(() => this.refresh(win), POLL_INTERVAL_MS);
    });
    panel.addEventListener("popuphidden", () => {
      if (panel._timer != null) {
        win.clearInterval(panel._timer);
        panel._timer = null;
      }
      panel._prevSample = null;
    });
    document.getElementById("mainPopupSet")?.appendChild(panel);
    return panel;
  },

  async refresh(win) {
    const panel = this.panel(win);
    const now = Date.now();
    const groups = await this.sample(win);
    const prev = panel._prevSample;
    panel._prevSample = { groups, time: now };
    this.render(win, groups, prev);
  },

  render(win, groups, prev) {
    const panel = this.panel(win);
    const list = panel.querySelector(".whimsy-heavy-tabs-list");
    list.textContent = "";
    const { document } = win;
    for (const group of groups) {
      const header = document.createXULElement("hbox");
      header.className = "whimsy-heavy-tabs-group";
      header.setAttribute("align", "center");
      const memory = document.createXULElement("label");
      memory.className = "whimsy-heavy-tabs-memory";
      memory.textContent = this.formatBytes(group.memory);
      const prevGroup = prev?.groups.find(g => g.pid == group.pid);
      const cpu = document.createXULElement("label");
      cpu.className = "whimsy-heavy-tabs-cpu";
      if (prevGroup && prev.time) {
        const deltaMs = (Date.now() - prev.time) / 1000;
        const pct = deltaMs > 0 ? ((group.cpuTime - prevGroup.cpuTime) / 1000 / deltaMs) * 100 : 0;
        cpu.textContent = `${Math.max(0, Math.round(pct))}% CPU`;
      }
      header.append(memory, cpu);
      list.append(header);
      for (const tab of group.tabs) {
        const row = document.createXULElement("hbox");
        row.className = "whimsy-heavy-tabs-row";
        row.setAttribute("align", "center");
        const icon = document.createXULElement("image");
        icon.className = "whimsy-heavy-tabs-icon";
        const src = tab.linkedBrowser?.mIconURL || tab.getAttribute("image");
        if (src) {
          icon.setAttribute("src", src);
        }
        const label = document.createXULElement("label");
        label.className = "whimsy-heavy-tabs-title";
        label.setAttribute("crop", "end");
        label.textContent = tab.label;
        const close = document.createXULElement("toolbarbutton");
        close.className = "whimsy-heavy-tabs-close toolbarbutton-1";
        document.l10n.setAttributes(close, "whimsy-heavy-tabs-close-tab");
        close.addEventListener("command", () => {
          if (tab.isConnected && !tab.closing) {
            win.gBrowser.removeTab(tab, { animate: false });
          }
          this.refresh(win);
        });
        row.append(icon, label, close);
        list.append(row);
      }
    }
  },

  openPanel(win) {
    const panel = this.panel(win);
    panel.openPopup(win.document.documentElement, { position: "overlap", triggerEvent: null });
  },
};
