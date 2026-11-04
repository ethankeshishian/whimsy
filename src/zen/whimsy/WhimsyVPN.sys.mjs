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
  setTimeout: "resource://gre/modules/Timer.sys.mjs",
  clearTimeout: "resource://gre/modules/Timer.sys.mjs",
});

const FEATURE_PREF = "whimsy.feature.vpn";
// Firefox's own master switch (also gates the toolbar button/panel and the
// backend service). Whimsy defaults it to true; this is the real on/off.
const MASTER_PREF = "browser.ipProtection.enabled";
const ICON = "chrome://browser/skin/zen-icons/selectable/lock-closed.svg";
const WIDGET_ID = "ipprotection-button";
// W13 F02: Whimsy's two VPN controls (the user asked for both, A and B).
const URLBAR_ID = "whimsy-vpn-urlbar";
const TOGGLE_ID = "whimsy-vpn-urlbar-toggle";
const CHEVRON_ID = "whimsy-vpn-urlbar-chevron";
const PANEL_ICON = "chrome://browser/skin/zen-icons/selectable/location.svg";
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
    this.holdConnecting();
    try {
      await lazy.IPPProxyManager.start();
      await this.connectingShown();
      win.gZenUIManager?.showToast?.("whimsy-vpn-on-toast");
    } catch (e) {
      this.endHold();
      console.error("Whimsy: VPN turnOn failed", e);
    }
  },

  // W14 21.1: a reconnect goes from off to on within one task (Firefox
  // keeps its proxy pass), so "connecting" was never painted. It now shows
  // from the click and stays at least this long.
  CONNECTING_HOLD_MS: 800,
  _holdUntil: 0,
  _holdTimer: null,

  holdConnecting() {
    this._holdUntil = Date.now() + this.CONNECTING_HOLD_MS;
    lazy.clearTimeout(this._holdTimer);
    this._holdTimer = lazy.setTimeout(() => this.endHold(), this.CONNECTING_HOLD_MS);
    this.updateAllUi();
  },

  endHold() {
    lazy.clearTimeout(this._holdTimer);
    this._holdTimer = null;
    if (this._holdUntil) {
      this._holdUntil = 0;
      this.updateAllUi();
    }
  },

  get holding() {
    return Date.now() < this._holdUntil;
  },

  connectingShown() {
    const left = this._holdUntil - Date.now();
    return left > 0 ? new Promise(resolve => lazy.setTimeout(resolve, left)) : Promise.resolve();
  },

  updateAllUi() {
    for (const win of Services.wm.getEnumerator("navigator:browser")) {
      if (this._uiWindows.has(win) && !win.closed) {
        try {
          this.updateUi(win);
        } catch (e) {
          console.error("Whimsy: VPN controls", e);
        }
      }
    }
  },

  async turnOff(win) {
    if (!this.canTurnOff()) {
      return;
    }
    this.endHold();
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
  // so CustomizableUI's anchor lookup is pointed at the control's chevron
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
      node.setAttribute("cui-anchorid", CHEVRON_ID);
    }
    await panel.open(win);
    this.watchPanel(win);
    return true;
  },

  // W14 3c: the chevron opens Firefox's panel, or closes it when it's open
  // (panel.open() does nothing while the panel is showing).
  async togglePanel(win) {
    const panel = this.getPanel(win);
    if (panel?.active) {
      panel.close();
      return;
    }
    if (!(await this.openPanel(win))) {
      this.explain(win);
    }
  },

  watchPanel(win) {
    const chevron = win.document.getElementById(CHEVRON_ID);
    const popup = this.getPanel(win)?.panel;
    if (!chevron || !popup) {
      return;
    }
    const sync = () => chevron.setAttribute("aria-expanded", String(!!this.getPanel(win)?.active));
    sync();
    if (popup._whimsyVpnWatched) {
      return;
    }
    popup._whimsyVpnWatched = true;
    popup.addEventListener("popupshown", sync);
    popup.addEventListener("popuphidden", sync);
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
    if (this.uiState(win).state == "elsewhere" && lazy.WhimsyVPNScope.profileForWindow(win) !== null) {
      this.holdConnecting();
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
    if (scoped == "connecting" || (this.holding && scoped != "elsewhere")) {
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

  // A: "VPN" with a status dot, last in the address bar's buttons, and a
  // chevron after a hairline (W14 3c, design vpn-chevron option A). The
  // main part toggles; the chevron opens Firefox's panel, anchored to it.
  // Each end has the address bar's hover; only the dot moves (off ring,
  // amber pulse while connecting, green with one ring on).
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
    const main = doc.createXULElement("hbox");
    main.id = TOGGLE_ID;
    main.className = "whimsy-vpn-urlbar-toggle";
    main.setAttribute("align", "center");
    main.setAttribute("role", "button");
    main.setAttribute("tabindex", "0");
    const dot = doc.createElementNS(HTML_NS, "span");
    dot.className = "whimsy-vpn-dot";
    dot.setAttribute("aria-hidden", "true");
    const label = doc.createXULElement("label");
    label.className = "whimsy-vpn-urlbar-label";
    doc.l10n.setAttributes(label, "whimsy-vpn-urlbar-label");
    main.append(dot, label);
    const divider = doc.createElementNS(HTML_NS, "span");
    divider.className = "whimsy-vpn-urlbar-divider";
    divider.setAttribute("aria-hidden", "true");
    const chevron = doc.createXULElement("hbox");
    chevron.id = CHEVRON_ID;
    chevron.className = "whimsy-vpn-urlbar-chevron";
    chevron.setAttribute("align", "center");
    chevron.setAttribute("pack", "center");
    chevron.setAttribute("role", "button");
    chevron.setAttribute("tabindex", "0");
    chevron.setAttribute("aria-haspopup", "true");
    chevron.setAttribute("aria-expanded", "false");
    doc.l10n.setAttributes(chevron, "whimsy-vpn-urlbar-panel");
    const arrow = doc.createXULElement("image");
    arrow.className = "whimsy-vpn-urlbar-chevron-icon";
    chevron.append(arrow);
    control.append(main, divider, chevron);
    const activate = (target, run) => {
      target.addEventListener("click", event => {
        if (event.button == 0) {
          run(event);
        }
      });
      target.addEventListener("keydown", event => {
        if (event.key == "Enter" || event.key == " ") {
          event.preventDefault();
          run(event);
        }
      });
    };
    activate(main, () => this.toggleHere(win));
    // A press on the chevron while the panel is open closes it: the press
    // may already have closed it, so it must not open it again.
    let wasOpen = false;
    chevron.addEventListener("mousedown", () => {
      wasOpen = !!this.getPanel(win)?.active;
    }, true);
    activate(chevron, event => {
      if (event.type == "click" && wasOpen) {
        wasOpen = false;
        this.getPanel(win)?.close();
        return;
      }
      this.togglePanel(win);
    });
    buttons.append(control);
    return control;
  },

  // B: Firefox IP Protection's row in This Site (Zen's site panel), first,
  // under the panel's quick buttons: the name and its state, a switch;
  // while it's on or connecting, All spaces | All spaces in <profile> under
  // it. W14 3d: built once and updated in place, so the knob and the thumb
  // slide, the words never blank, and the scope row opens and closes.
  buildSiteSection(win, header) {
    const doc = win.document;
    const S = lazy.WhimsySurface;
    const section = doc.createXULElement("vbox");
    section.id = SECTION_ID;
    section.className = "zen-site-data-section whimsy-vpn-site-section whimsy-surface-tokens";
    const group = S.group(doc);
    group.classList.add("whimsy-vpn-site-group");
    const toggle = S.switch(doc, {
      labelledBy: "whimsy-vpn-site-name",
      id: "whimsy-vpn-site-switch",
      onChange: () => this.toggleHere(win),
    });
    toggle.setAttribute("aria-describedby", "whimsy-vpn-site-detail");
    const { row, label } = S.row(doc, { l10nId: "whimsy-vpn-site-name", detailL10nId: "whimsy-vpn-site-off", trailing: [toggle] });
    label.id = "whimsy-vpn-site-name";
    const detail = row.querySelector(".whimsy-surface-row-detail");
    detail.id = "whimsy-vpn-site-detail";
    row.classList.add("whimsy-vpn-site-row");
    const seg = S.seg(doc, {
      name: "whimsy-vpn-scope",
      small: true,
      label: null,
      options: [
        { value: "browser", l10nId: "whimsy-vpn-scope-browser" },
        { value: "space", l10nId: "whimsy-vpn-scope-space", l10nArgs: { profile: "" } },
      ],
      onPick: value => {
        if (value == "browser" || lazy.WhimsyVPNScope.scopeChoice(win) != "space") {
          lazy.WhimsyVPNScope.setScope(win, value);
        }
      },
    });
    doc.l10n.setAttributes(seg.group, "whimsy-vpn-site-scope");
    const scopeRow = doc.createElementNS(HTML_NS, "div");
    scopeRow.className = "whimsy-vpn-scope-row";
    const inner = doc.createElementNS(HTML_NS, "div");
    inner.className = "whimsy-vpn-scope-inner";
    inner.append(seg.group);
    scopeRow.append(inner);
    group.append(row, scopeRow);
    section.append(group);
    header.after(section);
    this._siteParts.set(section, { row, toggle, detail, seg, scopeRow });
    return section;
  },

  _siteParts: new WeakMap(),

  renderSiteSection(win) {
    const doc = win.document;
    const header = doc.getElementById("zen-site-data-header");
    let section = doc.getElementById(SECTION_ID);
    const { state, scope } = this.uiState(win);
    if (state == "hidden" || !header) {
      section?.remove();
      return null;
    }
    if (!section || !this._siteParts.has(section)) {
      section?.remove();
      section = this.buildSiteSection(win, header);
    }
    const { row, toggle, detail, seg, scopeRow } = this._siteParts.get(section);
    const Scope = lazy.WhimsyVPNScope;
    const profile = Scope.profileName(Scope.profileForWindow(win) ?? 0);
    const on = state == "on" || state == "connecting";
    row.setAttribute("state", state);
    toggle.checked = on;
    const id = state == "on" ? `whimsy-vpn-site-on-${scope}` : `whimsy-vpn-site-${state}`;
    const args = state == "on" && scope == "space" ? { profile } : null;
    const now = doc.l10n.getAttributes(detail);
    if (now.id != id || JSON.stringify(now.args ?? null) != JSON.stringify(args)) {
      doc.l10n.setAttributes(detail, id, args);
    }
    const spaceButton = seg.buttons[1];
    if (doc.l10n.getAttributes(spaceButton).args?.profile != profile) {
      doc.l10n.setAttributes(spaceButton, "whimsy-vpn-scope-space", { profile });
    }
    seg.select(Scope.scopeChoice(win));
    scopeRow.toggleAttribute("open", on);
    scopeRow.inert = !on;
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
        const Scope = lazy.WhimsyVPNScope;
        const profile = Scope.profileName(Scope.profileForWindow(win) ?? 0);
        doc.l10n.setAttributes(control.querySelector(`#${TOGGLE_ID}`), id, { profile });
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
    lazy.WhimsyCommands.register(win, {
      id: "cmd_whimsyVPNPanel",
      l10nId: "whimsy-action-vpn-panel",
      run: w => this.togglePanel(w),
      icon: PANEL_ICON,
      isAvailable: () => this.wrapperEnabled && this.masterEnabled,
    });
  },
};
