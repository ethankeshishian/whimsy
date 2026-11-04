/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// tierC-vpn: VPN. Firefox already ships a free, built-in VPN — "IP
// Protection" (toolkit/browser/components/ipprotection): sign in with a
// Mozilla account, a 50 GB/month cap (browser.ipProtection.bandwidth.maxInGb),
// a toolbar button + panel with a location picker and bandwidth usage, and
// per-site rules (exclude a site, or — with
// browser.ipProtection.features.siteInclusions — always use the VPN on a
// site, layered on the exclusions). It ships off (browser.ipProtection.enabled
// = false) and with site inclusions off; Whimsy turns both on by default
// (prefs/whimsy/whimsy.yaml) and adds a command bar "Turn VPN On/Off" and a
// Settings → Privacy card with live status and a "manage" shortcut to
// Firefox's own panel. This is NOT a VPN Whimsy built: the service, sign-in,
// proxy, quota and per-site rules are entirely Firefox's
// (engine/toolkit/components/ipprotection, engine/browser/components/ipprotection).
//
// Original flow: sign in (Mozilla account) -> click the toolbar button to
// connect -> check the quota/location in the panel -> exclude (or, with
// inclusions on, "always use") specific sites. See
// https://support.mozilla.org/en-US/kb/built-in-vpn.
//
// vpnspace: Container scoping extends the native control in WhimsyVPNScope;
// the channel boundary is implemented by the Whimsy IPPChannelFilter patch.

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  WhimsyVPNScope: "resource:///modules/whimsy/WhimsyVPNScope.sys.mjs",
  CustomizableUI: "moz-src:///browser/components/customizableui/CustomizableUI.sys.mjs",
  WhimsyCommands: "resource:///modules/whimsy/WhimsyCommands.sys.mjs",
  WhimsySurface: "resource:///modules/whimsy/WhimsySurface.sys.mjs",
  IPProtection:
    "moz-src:///browser/components/ipprotection/IPProtection.sys.mjs",
  IPProtectionService:
    "moz-src:///toolkit/components/ipprotection/IPProtectionService.sys.mjs",
  IPProtectionStates:
    "moz-src:///toolkit/components/ipprotection/IPProtectionService.sys.mjs",
  IPPProxyManager:
    "moz-src:///toolkit/components/ipprotection/IPPProxyManager.sys.mjs",
  IPPProxyStates:
    "moz-src:///toolkit/components/ipprotection/IPPProxyManager.sys.mjs",
});

const FEATURE_PREF = "whimsy.feature.vpn";
// Firefox's own master switch (also gates the toolbar button/panel and the
// backend service). Whimsy defaults it to true; this is the real on/off.
const MASTER_PREF = "browser.ipProtection.enabled";
const ICON = "chrome://browser/skin/zen-icons/selectable/lock-closed.svg";
const WIDGET_ID = "ipprotection-button";
// W13 F02: Whimsy's two VPN controls (the user asked for both, A and B).
const URLBAR_ID = "whimsy-vpn-urlbar";
const SECTION_ID = "whimsy-vpn-site-section";
const SITE_PANEL_ID = "zen-unified-site-data-panel";
const HTML_NS = "http://www.w3.org/1999/xhtml";

export const WhimsyVPN = {
  FEATURE_PREF,
  MASTER_PREF,

  // Whimsy's own command bar/Settings layer is on. Firefox's VPN itself can
  // still be on or off independently via MASTER_PREF (the Settings checkbox).
  get wrapperEnabled() {
    return Services.prefs.getBoolPref(FEATURE_PREF, true);
  },

  get masterEnabled() {
    return Services.prefs.getBoolPref(MASTER_PREF, false);
  },

  // Signed in, entitled, and ready to connect/disconnect.
  get ready() {
    return (
      this.wrapperEnabled &&
      this.masterEnabled &&
      lazy.IPProtectionService.state == lazy.IPProtectionStates.READY
    );
  },

  canTurnOn() {
    if (!this.ready) {
      return false;
    }
    const state = lazy.IPPProxyManager.state;
    return state != lazy.IPPProxyStates.ACTIVE && state != lazy.IPPProxyStates.ACTIVATING;
  },

  canTurnOff() {
    if (!this.ready) {
      return false;
    }
    const state = lazy.IPPProxyManager.state;
    return state == lazy.IPPProxyStates.ACTIVE || state == lazy.IPPProxyStates.ACTIVATING;
  },

  async turnOn(win) {
    if (!this.canTurnOn()) {
      return;
    }
    try {
      await lazy.IPPProxyManager.start();
      win.gZenUIManager?.showToast?.("whimsy-vpn-on-toast");
    } catch (e) {
      console.error("Whimsy: VPN turnOn failed", e);
    }
  },

  async turnOff(win) {
    if (!this.canTurnOff()) {
      return;
    }
    try {
      await lazy.IPPProxyManager.stop();
      win.gZenUIManager?.showToast?.("whimsy-vpn-off-toast");
    } catch (e) {
      console.error("Whimsy: VPN turnOff failed", e);
    }
  },

  // W13 F02: the address bar control and This Site's row are Whimsy's only
  // VPN controls now; Firefox's own toolbar button would be a duplicate, so
  // it's taken out of the default toolbar (Zen's CustomizableUI patch still
  // places it there) the first time a window initializes. Customize mode
  // can still add it back from the palette if someone wants it.
  hideButton() {
    const { CustomizableUI } = lazy;
    if (CustomizableUI.getPlacementOfWidget(WIDGET_ID)) {
      CustomizableUI.removeWidgetFromArea(WIDGET_ID);
    }
  },

  // W10-50: Firefox's VPN panel for this window, or null while Firefox's
  // service hasn't made it (switched off, starting, or not offered to this
  // profile). Nothing here may be a dead control, so callers explain a null.
  getPanel(win) {
    try {
      return lazy.IPProtection.getPanel(win) ?? null;
    } catch (e) {
      console.warn("Whimsy: failed to get the IPProtection panel", e);
      return null;
    }
  },

  // W10-50/F02: opens Firefox's own VPN panel (sign-in, connect, location,
  // usage). panel.open() anchors to Firefox's own toolbar widget's node,
  // which Whimsy keeps out of the toolbar (W13 F02 removed it in favor of
  // the address bar control): without a placement that node has no layout,
  // so CustomizableUI's anchor lookup is pointed at the address bar control
  // instead via cui-anchorid, the same override a toolbar overflow uses.
  // Returns false when there is no panel; see explain().
  async openPanel(win) {
    const panel = this.getPanel(win);
    if (!panel) {
      return false;
    }
    const widget = lazy.CustomizableUI.getWidget(WIDGET_ID);
    const node = widget?.forWindow(win)?.node;
    if (node && !node.isConnected) {
      this.urlbarControl(win);
      node.setAttribute("cui-anchorid", URLBAR_ID);
    }
    await panel.open(win);
    return true;
  },

  // W10-50: why the panel can't open yet, as a Fluent id.
  unavailableReason() {
    if (!this.masterEnabled) {
      return "whimsy-vpn-off-hint";
    }
    return lazy.IPProtectionService.state == lazy.IPProtectionStates.UNAVAILABLE
      ? "whimsy-vpn-unavailable-toast"
      : "whimsy-vpn-starting-toast";
  },

  explain(win) {
    win.gZenUIManager?.showToast?.(this.unavailableReason(), { timeout: 6000 });
  },

  // W10-50: the last failed enrollment (a Guardian AUTH_ERRORS value), so
  // Settings can say why "Get started" didn't stick. Cleared once signed in.
  lastEnrollError: "",

  enrollErrorL10nId(error) {
    switch (error) {
      case "region_unavailable":
        return "whimsy-vpn-enroll-region";
      case "not_entitled":
      case "unauthorized":
        return "whimsy-vpn-enroll-account";
      case "network_error":
      case "server_error":
        return "whimsy-vpn-enroll-network";
      default:
        return "whimsy-vpn-enroll-failed";
    }
  },

  // Fired by whimsy-IPProtectionPanel-sys-mjs.patch: Firefox only records a
  // failed enrollment, and its panel falls back to "Get started" silently.
  observe(subject, topic, data) {
    if (topic != "whimsy-ipprotection-enroll-failed") {
      return;
    }
    this.lastEnrollError = data || "enrollment_failed";
    const win = subject?.gZenUIManager ? subject : Services.wm.getMostRecentWindow("navigator:browser");
    win?.gZenUIManager?.showToast?.(this.enrollErrorL10nId(this.lastEnrollError), { timeout: 8000 });
    Services.obs.notifyObservers(null, "whimsy-vpn-enroll-error-changed");
  },

  _observing: false,
  _observeEnrollment() {
    if (this._observing) {
      return;
    }
    this._observing = true;
    Services.obs.addObserver(this, "whimsy-ipprotection-enroll-failed");
    lazy.IPProtectionService.addEventListener("IPProtectionService:StateChanged", () => {
      if (lazy.IPProtectionService.state == lazy.IPProtectionStates.READY && this.lastEnrollError) {
        this.lastEnrollError = "";
        Services.obs.notifyObservers(null, "whimsy-vpn-enroll-error-changed");
      }
    });
  },

  // Set Up VPN: switch Firefox's VPN on, then connect when signed in, or
  // open Firefox's panel to sign in. W10-50: it used to fall back to
  // opening Settings, because Firefox's service never started (see
  // prefs/whimsy/whimsy.yaml, app.update.checkInstallTime.days); now it
  // says why instead of sending people to a page that couldn't help either.
  async setUp(win) {
    if (!this.masterEnabled) {
      Services.prefs.setBoolPref(MASTER_PREF, true);
    }
    if (this.canTurnOn()) {
      return this.turnOn(win);
    }
    if (await this.openPanel(win)) {
      return undefined;
    }
    return this.explain(win);
  },

  canSetUp() {
    return this.wrapperEnabled && !this.ready;
  },

  // The one toggle: the command, the address bar's VPN control and This
  // Site's switch all run it.
  toggle(win) {
    if (!this.wrapperEnabled) {
      return null;
    }
    if (this.canTurnOff()) {
      return this.turnOff(win);
    }
    if (this.canSetUp()) {
      // fix7 settings: before sign-in neither On nor Off applies.
      return this.setUp(win);
    }
    return this.canTurnOn() ? this.turnOn(win) : null;
  },

  // The address bar control and This Site's switch: like toggle(), except
  // that where the VPN is on for other spaces but not this one ("off
  // here"), turning it on adds this space instead of stopping it for all.
  async toggleHere(win) {
    if (this.uiState(win).state == "elsewhere" && lazy.WhimsyVPNScope.containerForWindow(win)) {
      lazy.WhimsyVPNScope.setScope(win, "space");
    } else {
      await this.toggle(win);
    }
    this.updateUi(win);
  },

  // ---- W13 F02: the address bar control (A) and This Site's row (B) ----
  //
  // One state for both, from Firefox's service and proxy and Whimsy's
  // space scope (WhimsyVPNScope.buttonState):
  //   hidden      Firefox's VPN is switched off in Settings, or Firefox
  //               doesn't offer it to this browser: no control at all
  //   setup       not signed in yet: the control sets it up
  //   off         ready, not connected
  //   connecting  connecting
  //   on          connected, and this space is covered ("browser" or
  //               "space" scope)
  //   elsewhere   connected for other spaces, not this one (off here)
  uiState(win) {
    if (!this.wrapperEnabled || !this.masterEnabled ||
      lazy.IPProtectionService.state == lazy.IPProtectionStates.UNAVAILABLE) {
      return { state: "hidden", scope: null };
    }
    if (!this.ready) {
      return { state: "setup", scope: null };
    }
    const scoped = lazy.WhimsyVPNScope.buttonState(win);
    if (scoped == "connecting") {
      return { state: "connecting", scope: null };
    }
    if (scoped == "browser" || scoped == "space") {
      return { state: "on", scope: scoped };
    }
    if (scoped == "elsewhere" && this.canTurnOff()) {
      return { state: "elsewhere", scope: null };
    }
    return { state: "off", scope: null };
  },

  // A: "VPN" with a status dot, last in the address bar's buttons. One
  // click toggles; the address bar's own 8px hover; only the dot moves
  // (off ring, amber pulse while connecting, green with one ring on).
  urlbarControl(win) {
    const doc = win.document;
    let control = doc.getElementById(URLBAR_ID);
    if (control) {
      return control;
    }
    const buttons = doc.getElementById("page-action-buttons");
    if (!buttons) {
      return null;
    }
    control = doc.createXULElement("hbox");
    control.id = URLBAR_ID;
    control.className = "whimsy-vpn-urlbar";
    control.setAttribute("align", "center");
    control.setAttribute("role", "button");
    control.setAttribute("tabindex", "0");
    const dot = doc.createElementNS(HTML_NS, "span");
    dot.className = "whimsy-vpn-dot";
    dot.setAttribute("aria-hidden", "true");
    const label = doc.createXULElement("label");
    label.className = "whimsy-vpn-urlbar-label";
    doc.l10n.setAttributes(label, "whimsy-vpn-urlbar-label");
    control.append(dot, label);
    control.addEventListener("click", event => {
      if (event.button == 0) {
        this.toggleHere(win);
      }
    });
    control.addEventListener("keydown", event => {
      if (event.key == "Enter" || event.key == " ") {
        event.preventDefault();
        this.toggleHere(win);
      }
    });
    buttons.append(control);
    return control;
  },

  // B: Firefox IP Protection's row in This Site (Zen's site panel), first,
  // under the panel's quick buttons: the name and its state, a switch; while it's on or connecting, All spaces | This space under it.
  // Rebuilt each time the panel opens and while it's open.
  renderSiteSection(win) {
    const doc = win.document;
    const header = doc.getElementById("zen-site-data-header");
    let section = doc.getElementById(SECTION_ID);
    const { state, scope } = this.uiState(win);
    if (state == "hidden" || !header) {
      section?.remove();
      return null;
    }
    const S = lazy.WhimsySurface;
    if (!section) {
      section = doc.createXULElement("vbox");
      section.id = SECTION_ID;
      section.className = "zen-site-data-section whimsy-vpn-site-section whimsy-surface-tokens";
      header.after(section);
    }
    const hadFocus = section.contains(doc.activeElement) ? doc.activeElement.dataset.vpnControl : null;
    const group = S.group(doc);
    group.classList.add("whimsy-vpn-site-group");
    const detail = state == "on" ? `whimsy-vpn-site-on-${scope}` : `whimsy-vpn-site-${state}`;
    const toggle = S.switch(doc, {
      checked: state == "on" || state == "connecting",
      labelledBy: "whimsy-vpn-site-name",
      id: "whimsy-vpn-site-switch",
      onChange: () => this.toggleHere(win),
    });
    toggle.dataset.vpnControl = "switch";
    toggle.setAttribute("aria-describedby", "whimsy-vpn-site-detail");
    const { row, label } = S.row(doc, { l10nId: "whimsy-vpn-site-name", detailL10nId: detail, trailing: [toggle] });
    label.id = "whimsy-vpn-site-name";
    row.querySelector(".whimsy-surface-row-detail").id = "whimsy-vpn-site-detail";
    row.classList.add("whimsy-vpn-site-row");
    row.setAttribute("state", state);
    group.append(row);
    if (state == "on" || state == "connecting") {
      const container = lazy.WhimsyVPNScope.containerForWindow(win);
      const seg = S.seg(doc, {
        name: "whimsy-vpn-scope",
        small: true,
        label: null,
        options: [
          { value: "browser", l10nId: "whimsy-vpn-scope-browser" },
          { value: "space", l10nId: "whimsy-vpn-scope-space" },
        ],
        onPick: value => {
          if (value == "browser" || !lazy.WhimsyVPNScope.selectedIds().includes(container)) {
            lazy.WhimsyVPNScope.setScope(win, value);
          }
          this.updateUi(win);
        },
      });
      doc.l10n.setAttributes(seg.group, "whimsy-vpn-site-scope");
      seg.select(scope == "space" ? "space" : scope == "browser" ? "browser" : null);
      const spaceButton = seg.buttons[1];
      if (!container) {
        spaceButton.disabled = true;
        doc.l10n.setAttributes(spaceButton, "whimsy-vpn-site-scope-no-container");
      }
      for (const b of seg.buttons) {
        b.dataset.vpnControl = b.dataset.value;
      }
      const scopeRow = doc.createXULElement("hbox");
      scopeRow.className = "whimsy-vpn-scope-row";
      scopeRow.append(seg.group);
      group.append(scopeRow);
    }
    section.replaceChildren(group);
    if (hadFocus) {
      section.querySelector(`[data-vpn-control="${hadFocus}"]`)?.focus();
    }
    return section;
  },

  // Both controls, for this window.
  updateUi(win) {
    const doc = win.document;
    const { state, scope } = this.uiState(win);
    const control = state == "hidden" ? doc.getElementById(URLBAR_ID) : this.urlbarControl(win);
    if (control) {
      control.hidden = state == "hidden";
      control.setAttribute("state", state);
      const id = state == "on" ? `whimsy-vpn-urlbar-on-${scope}` : `whimsy-vpn-urlbar-${state}`;
      if (state != "hidden") {
        doc.l10n.setAttributes(control, id);
      }
    }
    const panel = doc.getElementById(SITE_PANEL_ID);
    if (panel && (panel.state == "open" || panel.state == "showing")) {
      this.renderSiteSection(win);
    }
  },

  _uiWindows: new WeakSet(),
  initUi(win) {
    if (this._uiWindows.has(win) || !win.gBrowser) {
      return;
    }
    this._uiWindows.add(win);
    const update = () => {
      try {
        this.updateUi(win);
      } catch (e) {
        console.error("Whimsy: VPN controls", e);
      }
    };
    const prefs = [FEATURE_PREF, MASTER_PREF, lazy.WhimsyVPNScope.PREF, lazy.WhimsyVPNScope.FEATURE];
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
    const onShowing = event => {
      if (event.target.id == SITE_PANEL_ID) {
        try {
          this.renderSiteSection(win);
        } catch (e) {
          console.error("Whimsy: VPN in This Site", e);
        }
      }
    };
    win.document.addEventListener("popupshowing", onShowing);
    win.addEventListener("unload", () => {
      for (const pref of prefs) {
        Services.prefs.removeObserver(pref, update);
      }
      for (const [target, name] of events) {
        target.removeEventListener(name, update);
      }
      win.document.removeEventListener("popupshowing", onShowing);
    }, { once: true });
    update();
  },

  initWindow(win) {
    // vpnspace: Firefox's panel stays Firefox's (sign-in, location, usage);
    // W13 F02 adds the address bar control and This Site's row on top, both
    // running toggle(), and takes Firefox's own toolbar button out of the
    // default toolbar so there's exactly one visible control.
    this.hideButton();
    lazy.WhimsyVPNScope.initWindow(win);
    // Watches the switch itself, so it starts and stops with it.
    this.initUi(win);
    if (!this.wrapperEnabled) {
      return;
    }
    this._observeEnrollment();
    // wave5: one command for a shortcut; the command bar names the state
    // it moves to.
    lazy.WhimsyCommands.register(win, {
      id: "cmd_whimsyVPNToggle",
      l10nId: "whimsy-action-vpn-toggle",
      run: w => this.toggle(w),
      icon: ICON,
      variants: [
        { l10nId: "whimsy-action-vpn-on", isAvailable: () => this.wrapperEnabled && this.canTurnOn() },
        { l10nId: "whimsy-action-vpn-off", isAvailable: () => this.wrapperEnabled && this.canTurnOff() },
        { l10nId: "whimsy-action-vpn-setup", isAvailable: () => this.canSetUp() },
      ],
    });
  },
};
