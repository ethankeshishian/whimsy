/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// vpnspace: Extend Firefox's widget/panel rather than creating another VPN.
// Policy is profile-wide, pinned to the container chosen at click time; space
// switching must never silently retarget it. Existing connections are not
// migrated, and site exclusions and Firefox's connection modes still apply.
const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  IPPProxyManager: "moz-src:///toolkit/components/ipprotection/IPPProxyManager.sys.mjs",
  IPPProxyStates: "moz-src:///toolkit/components/ipprotection/IPPProxyManager.sys.mjs",
  IPProtectionService: "moz-src:///toolkit/components/ipprotection/IPProtectionService.sys.mjs",
});
const HTML = "http://www.w3.org/1999/xhtml";
const PREF = "browser.ipProtection.whimsy.userContextIds";
const FEATURE = "whimsy.feature.vpnspace";

export const WhimsyVPNScope = {
  PREF,
  FEATURE,
  get enabled() {
    return Services.prefs.getBoolPref(FEATURE, true) &&
      Services.prefs.getBoolPref("whimsy.feature.vpn", true);
  },
  get ids() {
    return this.enabled ? Services.prefs.getStringPref(PREF, "").trim() : "";
  },
  containerForWindow(win) {
    const id = Number(win.gZenWorkspaces?.getActiveWorkspace()?.containerTabId);
    return Number.isSafeInteger(id) && id > 0 ? id : null;
  },
  selectedIds() {
    return this.ids.split(",").map(value => Number(value.trim()))
      .filter(id => Number.isSafeInteger(id) && id > 0);
  },
  coveredSpaces(win) {
    const ids = this.selectedIds();
    return (win.gZenWorkspaces?.getWorkspaces?.() || [])
      .filter(space => !this.ids || ids.includes(Number(space.containerTabId)))
      .map(space => space.name || space.uuid);
  },
  // Returns false without changing the previous policy when no container exists.
  setScope(win, scope) {
    if (!this.enabled || !["browser", "space"].includes(scope)) {
      return false;
    }
    const id = scope === "space" ? this.containerForWindow(win) : null;
    if (scope === "space" && !id) {
      return false;
    }
    const ids = new Set(this.selectedIds());
    if (id !== null) {
      if (ids.has(id)) {
        ids.delete(id);
      } else {
        ids.add(id);
      }
    }
    // A nonempty invalid token matches no channel; empty means all spaces.
    Services.prefs.setStringPref(PREF, id === null ? "" : [...ids].join(",") || "none");
    return true;
  },
  buttonState(win) {
    if (!Services.prefs.getBoolPref("browser.ipProtection.enabled", false)) {
      return "off";
    }
    const ids = this.ids;
    if (ids && !this.selectedIds().includes(this.containerForWindow(win))) {
      return "elsewhere";
    }
    if (lazy.IPPProxyManager.state === lazy.IPPProxyStates.ACTIVATING) {
      return "connecting";
    }
    if (lazy.IPPProxyManager.state !== lazy.IPPProxyStates.ACTIVE) {
      return "off";
    }
    return ids ? "space" : "browser";
  },
  updateWindow(win) {
    const doc = win.document;
    const button = doc.getElementById("ipprotection-button");
    let badge = doc.getElementById("whimsy-vpn-scope-badge");
    if (!this.enabled) {
      badge?.remove();
      button?.removeAttribute("whimsy-vpn-scope");
      if (button?.getAttribute("aria-describedby") === "whimsy-vpn-scope-badge") {
        button.removeAttribute("aria-describedby");
      }
      doc.getElementById("whimsy-vpn-scope")?.remove();
      return;
    }
    if (button) {
      if (!badge) {
        badge = doc.createElementNS(HTML, "span");
        badge.id = "whimsy-vpn-scope-badge";
        button.appendChild(badge);
      }
      const state = this.buttonState(win);
      button.setAttribute("whimsy-vpn-scope", state);
      button.setAttribute("aria-describedby", badge.id);
      doc.l10n.setAttributes(badge, `whimsy-vpn-scope-button-${state}`);
    }
    const group = doc.getElementById("whimsy-vpn-scope");
    if (group) {
      const ids = this.ids;
      const id = this.containerForWindow(win);
      group.querySelector('[value="browser"]').checked = !ids;
      const space = group.querySelector('[value="space"]');
      space.checked = !!id && !!ids && this.selectedIds().includes(id);
      space.disabled = !id;
      doc.l10n.setAttributes(group.querySelector("p"), !id ?
        "whimsy-vpn-scope-no-container" : "whimsy-vpn-scope-help");
      doc.l10n.setAttributes(group.querySelector(".whimsy-vpn-covered"),
        ids ? "whimsy-vpn-scope-covered" : "whimsy-vpn-scope-all", {
          spaces: this.coveredSpaces(win).join(", ") || "—",
        });
    }
  },
  extendPanel(win, view) {
    if (!this.enabled || view.id !== "PanelUI-ipprotection") {
      return;
    }
    const doc = win.document;
    if (!doc.getElementById("whimsy-vpn-scope")) {
      const group = doc.createElementNS(HTML, "fieldset");
      group.id = "whimsy-vpn-scope";
      const legend = doc.createElementNS(HTML, "legend");
      doc.l10n.setAttributes(legend, "whimsy-vpn-scope-title");
      group.appendChild(legend);
      for (const scope of ["browser", "space"]) {
        const label = doc.createElementNS(HTML, "label");
        const radio = doc.createElementNS(HTML, "input");
        radio.type = "checkbox";
        radio.name = "whimsy-vpn-scope";
        radio.value = scope;
        const text = doc.createElementNS(HTML, "span");
        doc.l10n.setAttributes(text, `whimsy-vpn-scope-${scope}`);
        label.append(radio, text);
        group.appendChild(label);
        radio.addEventListener("change", () => {
          this.setScope(win, scope);
          this.updateWindow(win);
        });
      }
      group.appendChild(doc.createElementNS(HTML, "p"));
      const covered = doc.createElementNS(HTML, "p");
      covered.className = "whimsy-vpn-covered";
      group.appendChild(covered);
      // Outside the native body: its empty-child check controls Lit setup.
      view.appendChild(group);
    }
    this.updateWindow(win);
  },
  _windows: new WeakSet(),
  initWindow(win) {
    if (this._windows.has(win)) {
      return;
    }
    this._windows.add(win);
    const update = () => this.updateWindow(win);
    const showing = event => {
      if (event.target.id === "PanelUI-ipprotection") {
        this.extendPanel(win, event.target);
      }
    };
    const prefs = [PREF, FEATURE, "whimsy.feature.vpn", "browser.ipProtection.enabled"];
    for (const pref of prefs) {
      Services.prefs.addObserver(pref, update);
    }
    const events = [
      [lazy.IPPProxyManager, "IPPProxyManager:StateChanged"],
      [lazy.IPProtectionService, "IPProtectionService:StateChanged"],
      [win.gBrowser.tabContainer, "TabSelect"],
      [win, "ZenWorkspacesUIUpdate"],
      [win, "ZenWorkspaceDataChanged"],
    ];
    for (const [target, name] of events) {
      target.addEventListener(name, update);
    }
    win.document.addEventListener("ViewShowing", showing);
    // The native widget may be created after Whimsy initializes, or recreated
    // during customization. Only watch additions of the widget itself.
    const observer = new win.MutationObserver(records => {
      if (records.some(record => [...record.addedNodes].some(node =>
        node.nodeType === 1 && (node.id === "ipprotection-button" ||
          node.querySelector?.("#ipprotection-button"))))) {
        update();
      }
    });
    observer.observe(win.document.documentElement, { childList: true, subtree: true });
    win.addEventListener("unload", () => {
      observer.disconnect();
      win.document.removeEventListener("ViewShowing", showing);
      for (const pref of prefs) {
        Services.prefs.removeObserver(pref, update);
      }
      for (const [target, name] of events) {
        target.removeEventListener(name, update);
      }
      this._windows.delete(win);
    }, { once: true });
    update();
  },
};
