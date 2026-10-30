/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// ext → wave5/profiles: extensions per profile (Arc: each profile has its
// own extensions). Replaces "Show in Spaces…": an extension runs in All
// Profiles (the default) or only in the profiles picked from "Run in
// Profiles" on its menu (unified-extensions panel, toolbar, about:addons).
//
// What that means, all of it real Firefox behaviour:
// 1. Outside its profiles, the extension's tabs, webNavigation, webRequest
//    and proxy APIs can't see or act on tabs:
//    extensions.userContextIsolation.<id>.restricted lists every other
//    profile's container (Extension.sys.mjs#canAccessContainer). Whimsy
//    turns extensions.userContextIsolation.enabled on by default (it's read
//    when an extension starts) and also flips it on running extensions.
// 2. Its content scripts don't run in those profiles' pages: a Whimsy
//    process script (content/whimsy-profiles-process.js) declines them
//    before ExtensionContent injects anything.
// 3. Its toolbar button and panel row hide in those profiles' spaces.
// Honest limit: it's still one install with one background page and one
// storage.local shared by every profile; Settings says so.
//
// The choice is stored by profile key in a synced map (WhimsyProfileSync,
// merged per extension, newest wins): extension id → [key, ...].

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  AddonManager: "resource://gre/modules/AddonManager.sys.mjs",
  ExtensionCommon: "resource://gre/modules/ExtensionCommon.sys.mjs",
  WhimsyProfiles: "resource:///modules/whimsy/WhimsyProfiles.sys.mjs",
  WhimsySyncedMap: "resource:///modules/whimsy/WhimsyProfileSync.sys.mjs",
});

const FEATURE_PREF = "whimsy.feature.space-extensions";
// {extensionId: [profile key, ...]}; no entry means all profiles.
const PROFILES_PREF = "whimsy.profiles.extensions";
// The old per-space choice, migrated once to profiles.
const VISIBILITY_PREF = "whimsy.extensions.space-visibility";
// Extension ids whose restricted pref Whimsy currently manages, so turning
// the feature off (or clearing a choice) resets exactly those.
const MANAGED_ISOLATION_PREF = "whimsy.extensions.space-isolation-managed";
const MENU_ID = "whimsy-space-extensions-menu";
const MENUPOPUP_ID = "whimsy-space-extensions-menupopup";
export const PROCESS_SCRIPT = "chrome://browser/content/whimsy/whimsy-profiles-process.js";

function featureOn() {
  return Services.prefs.getBoolPref(FEATURE_PREF, true);
}

function readJSON(pref, fallback) {
  try {
    return JSON.parse(Services.prefs.getStringPref(pref, "") || fallback);
  } catch (e) {
    return JSON.parse(fallback);
  }
}

function restrictedPref(extensionId) {
  return `extensions.userContextIsolation.${extensionId}.restricted`;
}

export const WhimsySpaceExtensions = {
  PROFILES_PREF,

  // -- storage --------------------------------------------------------

  get choices() {
    if (!this._choices) {
      this._choices = new lazy.WhimsySyncedMap({ pref: PROFILES_PREF, file: "whimsy-profile-extensions.json" });
      // Another device changed a choice: apply it here too.
      this._choices.onChange(() => {
        if (this._initializedChoices) {
          this.applyContainerIsolation();
          this.refreshAllWindows();
        }
      });
    }
    return this._choices;
  },

  /** {extensionId: [key, ...]} for every limited extension. */
  getProfileMap() {
    return Object.fromEntries(this.choices.entries().filter(([, keys]) => Array.isArray(keys)));
  },

  // null = all profiles (Arc's default for an extension nobody limited);
  // an array = exactly those profile keys.
  getAllowedProfiles(extensionId) {
    const entry = this.choices.get(extensionId);
    return Array.isArray(entry) ? entry : null;
  },

  isAllowedIn(extensionId, key) {
    const allowed = this.getAllowedProfiles(extensionId);
    return !allowed || allowed.includes(key);
  },

  setAllowedProfiles(extensionId, keysOrNull) {
    this.choices.set(extensionId, keysOrNull ? [...new Set(keysOrNull)].sort() : null);
    this.applyContainerIsolation();
    this.refreshAllWindows();
  },

  toggleProfile(extensionId, key) {
    const current = this.getAllowedProfiles(extensionId) ??
      lazy.WhimsyProfiles.list().map(profile => profile.key);
    this.setAllowedProfiles(extensionId, current.includes(key) ?
      current.filter(item => item != key) : [...current, key]);
  },

  forgetExtension(extensionId) {
    if (this.getAllowedProfiles(extensionId)) {
      this.choices.set(extensionId, null);
    }
    this.applyContainerIsolation();
    this.refreshAllWindows();
  },

  forgetProfile(key) {
    for (const [id, keys] of Object.entries(this.getProfileMap())) {
      if (keys.includes(key)) {
        this.choices.set(id, keys.filter(item => item != key));
      }
    }
  },

  // "Show in Spaces" lists become the profiles of those spaces, once.
  migrateSpaceChoices(win) {
    if (!Services.prefs.prefHasUserValue(VISIBILITY_PREF)) {
      return;
    }
    const old = readJSON(VISIBILITY_PREF, "{}");
    const spaces = win?.gZenWorkspaces?.getWorkspaces?.() ?? [];
    for (const [extensionId, entry] of Object.entries(old)) {
      if (!Array.isArray(entry?.spaces) || this.getAllowedProfiles(extensionId)) {
        continue;
      }
      this.setAllowedProfiles(extensionId, entry.spaces
        .map(uuid => spaces.find(space => space.uuid == uuid))
        .filter(Boolean)
        .map(space => lazy.WhimsyProfiles.keyFor(lazy.WhimsyProfiles.profileIdOfSpace(space))));
    }
    Services.prefs.clearUserPref(VISIBILITY_PREF);
  },

  // -- toolbar / panel visibility --------------------------------------

  widgetIdFor(extensionId) {
    return `${lazy.ExtensionCommon.makeWidgetId(extensionId)}-browser-action`;
  },

  activeKey(win) {
    return lazy.WhimsyProfiles.keyFor(lazy.WhimsyProfiles.activeProfileId(win));
  },

  // Hides/shows the CUI node for every extension with a browser action
  // (toolbar-pinned or overflowed into the unified-extensions panel) to
  // match the active space's profile. Extensions without a browser action
  // are handled by wrapGetActivePolicies. Never touches enable/disable.
  applyVisibility(win) {
    if (!win || win.closed || !win.gZenWorkspaces) {
      return;
    }
    const key = this.activeKey(win);
    for (const policy of WebExtensionPolicy.getActiveExtensions()) {
      if (policy.extension?.type !== "extension") {
        continue;
      }
      const visible = !featureOn() || this.isAllowedIn(policy.id, key);
      const widget = win.CustomizableUI?.getWidget(this.widgetIdFor(policy.id));
      const node = widget?.forWindow(win)?.node;
      if (node) {
        node.hidden = !visible;
        node.toggleAttribute("whimsy-hidden-space-extension", !visible);
      }
    }
    win.gUnifiedExtensions?.updateAttention?.();
  },

  refreshAllWindows() {
    for (const win of Services.wm.getEnumerator("navigator:browser")) {
      if (!win.closed) {
        this.applyVisibility(win);
      }
    }
  },

  // Panel-list rows (extensions without a browser action) are built from
  // gUnifiedExtensions.getActivePolicies() each time the panel opens.
  wrapGetActivePolicies(win) {
    const gUE = win.gUnifiedExtensions;
    const original = gUE?.getActivePolicies;
    if (typeof original !== "function" || original._whimsySpaceExt) {
      return;
    }
    const self = this;
    const wrapped = function (...args) {
      const policies = original.apply(this, args);
      if (!featureOn()) {
        return policies;
      }
      const key = self.activeKey(win);
      return policies.filter(policy => self.isAllowedIn(policy.id, key));
    };
    wrapped._whimsySpaceExt = true;
    gUE.getActivePolicies = wrapped;
  },

  // -- isolation (tabs/webNavigation/webRequest/proxy + content scripts) --

  // Every profile this device has that the extension isn't allowed in,
  // Default (container 0) included.
  restrictedIdsFor(extensionId) {
    const allowed = this.getAllowedProfiles(extensionId);
    if (!allowed) {
      return [];
    }
    return lazy.WhimsyProfiles.list()
      .filter(profile => !allowed.includes(profile.key))
      .map(profile => profile.id);
  },

  applyContainerIsolation() {
    const previouslyManaged = new Set(readJSON(MANAGED_ISOLATION_PREF, "[]"));
    const nowManaged = new Set();
    if (featureOn()) {
      for (const extensionId of Object.keys(this.getProfileMap())) {
        Services.prefs.setStringPref(restrictedPref(extensionId),
          JSON.stringify(this.restrictedIdsFor(extensionId)));
        nowManaged.add(extensionId);
      }
    }
    for (const extensionId of previouslyManaged) {
      if (!nowManaged.has(extensionId)) {
        Services.prefs.clearUserPref(restrictedPref(extensionId));
        // An older build kept it on the default branch.
        Services.prefs.getDefaultBranch("").setStringPref(restrictedPref(extensionId), "[]");
      }
    }
    if (nowManaged.size) {
      Services.prefs.setStringPref(MANAGED_ISOLATION_PREF, JSON.stringify([...nowManaged]));
    } else {
      Services.prefs.clearUserPref(MANAGED_ISOLATION_PREF);
    }
    // Firefox reads extensions.userContextIsolation.enabled when an
    // extension starts; extensions already running get it here.
    if (nowManaged.size) {
      for (const policy of WebExtensionPolicy.getActiveExtensions()) {
        if (policy.extension && nowManaged.has(policy.id)) {
          policy.extension.userContextIsolation = true;
        }
      }
    }
  },

  loadProcessScript() {
    if (this._processScript) {
      return;
    }
    this._processScript = true;
    try {
      // WhimsyStartup usually loaded it already, before any page.
      if (!Services.ppmm.getDelayedProcessScripts().some(([url]) => url == PROCESS_SCRIPT)) {
        Services.ppmm.loadProcessScript(PROCESS_SCRIPT, true);
      }
    } catch (e) {
      console.error("Whimsy: profile content-script guard", e);
    }
  },

  // -- "Run in Profiles" submenu on the extension's menus -------------

  getExtensionIdFromMenu(menu) {
    const trigger = menu.triggerNode;
    return trigger?.closest?.("[data-extensionid]")?.dataset.extensionid ??
      trigger?.closest?.(".unified-extensions-item")
        ?.querySelector("[data-extensionid]")?.dataset.extensionid ?? null;
  },

  ensureMenuItems(win, menu = win.document.getElementById("unified-extensions-context-menu")) {
    if (!menu || menu.querySelector("[data-whimsy-profile-menu]")) {
      return menu;
    }
    const { document } = win;
    const menuEl = document.createXULElement("menu");
    menuEl.setAttribute("data-whimsy-profile-menu", "true");
    if (menu.id === "unified-extensions-context-menu") {
      menuEl.id = MENU_ID;
    }
    document.l10n.setAttributes(menuEl, "whimsy-space-extensions-menu");
    const popup = document.createXULElement("menupopup");
    if (menuEl.id === MENU_ID) {
      popup.id = MENUPOPUP_ID;
    }
    popup.addEventListener("popupshowing", event => {
      if (event.target === popup) {
        this.updateProfilePicker(win, popup, menuEl.extensionId);
      }
    });
    menuEl.appendChild(popup);
    menu.appendChild(menuEl);
    return menu;
  },

  initContextMenu(win) {
    // Resolve at popup time, including toolbar/overflow menus. The unified
    // gear popup alone doesn't cover pinned actions or about:addons.
    win.addEventListener("popupshowing", event => {
      const menu = event.target;
      if (!["unified-extensions-context-menu", "toolbar-context-menu",
        "customizationPanelItemContextMenu"].includes(menu.id)) {
        return;
      }
      this.ensureMenuItems(win, menu);
      this.updateContextMenu(win, menu);
    }, true);
  },

  updateContextMenu(win, menu) {
    const item = menu.querySelector("[data-whimsy-profile-menu]");
    if (!item) {
      return;
    }
    item.extensionId = this.getExtensionIdFromMenu(menu);
    item.hidden = !featureOn() || !item.extensionId;
  },

  updateProfilePicker(win, popup, extensionId) {
    const { document } = win;
    popup.replaceChildren();
    if (!extensionId) {
      return;
    }
    const allowed = this.getAllowedProfiles(extensionId);
    const allItem = document.createXULElement("menuitem");
    allItem.setAttribute("type", "checkbox");
    document.l10n.setAttributes(allItem, "whimsy-space-extensions-all");
    allItem.toggleAttribute("checked", !allowed);
    allItem.addEventListener("command", () => this.setAllowedProfiles(extensionId, null));
    popup.appendChild(allItem);
    popup.appendChild(document.createXULElement("menuseparator"));
    for (const profile of lazy.WhimsyProfiles.list()) {
      const item = document.createXULElement("menuitem");
      item.setAttribute("type", "checkbox");
      item.setAttribute("label", profile.name);
      item.dataset.profileKey = profile.key;
      item.toggleAttribute("checked", !allowed || allowed.includes(profile.key));
      item.addEventListener("command", () => this.toggleProfile(extensionId, profile.key));
      popup.appendChild(item);
    }
  },

  initAboutAddons(win) {
    const attach = doc => {
      if (doc?.documentURI !== "about:addons" || doc._whimsySpaceExtensions ||
          !doc.nodePrincipal.isSystemPrincipal) {
        return;
      }
      doc._whimsySpaceExtensions = true;
      doc.l10n.addResourceIds(["browser/whimsy.ftl"]);
      const update = () => {
        for (const card of doc.querySelectorAll("addon-card")) {
          const panel = card.querySelector("addon-options panel-list");
          if (!panel || card.addon?.type !== "extension") {
            continue;
          }
          let item = panel.querySelector("[data-whimsy-profile-picker]");
          if (!item) {
            item = doc.createElement("panel-item");
            item.setAttribute("data-whimsy-profile-picker", "true");
            doc.l10n.setAttributes(item, "whimsy-space-extensions-picker");
            item.addEventListener("click", event => {
              event.stopPropagation();
              if (!featureOn()) {
                return;
              }
              panel.hide();
              this.showAddonPicker(win, card);
            });
            panel.appendChild(item);
          }
          const hidden = !featureOn();
          if (item.hidden !== hidden) {
            item.hidden = hidden;
          }
          if (hidden) {
            card.querySelector("[data-whimsy-profile-choices]")?.remove();
          }
        }
      };
      const observer = new win.MutationObserver(records => {
        // Only newly inserted cards/options need wiring. Ignore text, icons,
        // and our own picker mutations.
        if (records.some(record => [...record.addedNodes].some(node =>
          node.nodeType === 1 && (node.matches("addon-card, addon-options, panel-list") ||
            node.querySelector("addon-card, addon-options, panel-list"))))) {
          update();
        }
      });
      observer.observe(doc, { childList: true, subtree: true });
      Services.prefs.addObserver(FEATURE_PREF, update);
      doc.defaultView.addEventListener("unload", () => {
        observer.disconnect();
        Services.prefs.removeObserver(FEATURE_PREF, update);
      }, { once: true });
      update();
    };
    win.addEventListener("DOMContentLoaded", event => attach(event.target), true);
    const onDocument = doc => {
      if (doc?.documentURI == "about:addons" &&
          doc.defaultView?.browsingContext?.top.embedderElement?.ownerDocument.defaultView == win) {
        doc.addEventListener("DOMContentLoaded", () => attach(doc), { once: true });
      }
    };
    Services.obs.addObserver(onDocument, "document-element-inserted");
    win.addEventListener("unload", () =>
      Services.obs.removeObserver(onDocument, "document-element-inserted"), { once: true });
    for (const browser of win.gBrowser.browsers) {
      attach(browser.contentDocument);
    }
  },

  showAddonPicker(win, card, focusKey = null) {
    const doc = card.ownerDocument;
    card.querySelector("[data-whimsy-profile-choices]")?.remove();
    const choices = doc.createElement("fieldset");
    choices.setAttribute("data-whimsy-profile-choices", "true");
    choices.addEventListener("click", event => event.stopPropagation());
    const legend = doc.createElement("legend");
    doc.l10n.setAttributes(legend, "whimsy-space-extensions-picker");
    choices.appendChild(legend);
    const allowed = this.getAllowedProfiles(card.addon.id);
    const addChoice = (key, name) => {
      const label = doc.createElement("label");
      const input = doc.createElement("input");
      input.type = "checkbox";
      input.dataset.profile = key ?? "";
      input.checked = key === null ? !allowed : !allowed || allowed.includes(key);
      const text = doc.createElement("span");
      if (key === null) {
        doc.l10n.setAttributes(text, "whimsy-space-extensions-all-text");
      } else {
        text.textContent = name;
      }
      input.addEventListener("change", () => {
        if (!featureOn()) {
          return;
        }
        if (key === null) {
          this.setAllowedProfiles(card.addon.id, input.checked ? null : []);
        } else {
          this.toggleProfile(card.addon.id, key);
        }
        this.showAddonPicker(win, card, key);
      });
      label.append(input, text);
      choices.append(label, doc.createElement("br"));
    };
    addChoice(null);
    for (const profile of lazy.WhimsyProfiles.list()) {
      addChoice(profile.key, profile.name);
    }
    const note = doc.createElement("p");
    note.className = "whimsy-profile-choices-note";
    doc.l10n.setAttributes(note, "whimsy-space-extensions-shared-note");
    choices.appendChild(note);
    card.appendChild(choices);
    [...choices.querySelectorAll("input")].find(input => input.dataset.profile === (focusKey ?? ""))?.focus();
  },

  // -- wiring ------------------------------------------------------------

  wrapChangeWorkspace(win) {
    const workspaces = win.gZenWorkspaces;
    const original = workspaces.changeWorkspace;
    if (typeof original !== "function" || original._whimsySpaceExt) {
      return;
    }
    const self = this;
    const wrapped = async function (workspace, ...args) {
      const result = await original.call(this, workspace, ...args);
      self.applyVisibility(win);
      return result;
    };
    wrapped._whimsySpaceExt = true;
    workspaces.changeWorkspace = wrapped;
  },

  initCustomizableUIListener(win) {
    if (this._cuiListenerAdded) {
      return;
    }
    this._cuiListenerAdded = true;
    win.CustomizableUI?.addListener({
      onWidgetAfterDOMChange: () => this.refreshAllWindows(),
      onWidgetAdded: () => this.refreshAllWindows(),
    });
  },

  initAddonListener() {
    if (this._addonListenerAdded) {
      return;
    }
    this._addonListenerAdded = true;
    const self = this;
    lazy.AddonManager.addAddonListener({
      onEnabled: () => self.refreshAllWindows(),
      onDisabled: () => self.refreshAllWindows(),
      onInstalled: () => self.refreshAllWindows(),
      onUninstalled: addon => self.forgetExtension(addon.id),
    });
  },

  initIdentityObserver() {
    if (this._identityObserver) {
      return;
    }
    // A new profile is off-limits to limited extensions from the start; a
    // deleted one drops out of every list.
    this._identityObserver = (subject, topic) => {
      if (topic == "contextual-identity-deleted") {
        this.forgetProfile(lazy.WhimsyProfiles.keyFor(subject?.wrappedJSObject?.userContextId));
      }
      this.applyContainerIsolation();
      this.refreshAllWindows();
    };
    for (const topic of ["contextual-identity-created", "contextual-identity-deleted"]) {
      Services.obs.addObserver(this._identityObserver, topic);
    }
    Services.prefs.addObserver(FEATURE_PREF, () => {
      this.applyContainerIsolation();
      this.refreshAllWindows();
    });
    lazy.WhimsyProfiles.onDelete((id, key) => this.forgetProfile(key));
  },

  initWindow(win) {
    if (!win.gZenWorkspaces?.workspaceEnabled) {
      return;
    }
    if (win._whimsySpaceExtensions) {
      return;
    }
    win._whimsySpaceExtensions = true;
    this._initializedChoices = true;
    this.migrateSpaceChoices(win);
    this.loadProcessScript();
    this.initIdentityObserver();
    this.initContextMenu(win);
    this.initAboutAddons(win);
    this.wrapChangeWorkspace(win);
    this.wrapGetActivePolicies(win);
    this.initCustomizableUIListener(win);
    this.initAddonListener();
    const refresh = () => this.applyVisibility(win);
    win.addEventListener("ZenWorkspaceDataChanged", refresh);
    win.addEventListener("ZenWorkspacesUIUpdate", refresh);
    win.addEventListener("UnifiedExtensionsTogglePanel", refresh);
    win.addEventListener(
      "unload",
      () => {
        win.removeEventListener("ZenWorkspaceDataChanged", refresh);
        win.removeEventListener("ZenWorkspacesUIUpdate", refresh);
        win.removeEventListener("UnifiedExtensionsTogglePanel", refresh);
      },
      { once: true }
    );
    this.applyVisibility(win);
    this.applyContainerIsolation();
  },
};
