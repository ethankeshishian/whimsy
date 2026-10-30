/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// ext: per-space extensions (whimsy.feature.space-extensions)
//
// Arc associates extensions with a space only because each Arc space can be
// a different Chromium *profile*; profiles separate browsing state and
// settings entirely. Gecko doesn't load extensions per container/profile
// inside one window, so true per-space extensions would need distinct
// Firefox profiles mapped into Whimsy's spaces — a separate architectural
// project, not an overlay change. This module does the two parts that *are*
// reachable from an overlay, without any engine patch:
//
// 1. Per-extension "Show in Spaces…" (a submenu added to the extension's
//    existing gear menu in the unified-extensions panel, same injection
//    pattern as WhimsySpaceLock's workspace-context-menu item): pick "All
//    Spaces" (the default) or specific spaces, stored by stable space uuid.
//    On every space switch, matching extensions' toolbar buttons (pinned or
//    overflowed into the panel) and their panel-list rows are hidden or
//    shown. This never touches the browser's separate enable/disable state
//    (AddonManager) — a hidden extension is still installed and enabled.
//
// 2. Where a space has its own container (workspace.containerTabId), go one
//    step further using Firefox's real (if rarely enabled) per-container
//    extension restriction: `extensions.userContextIsolation.<id>.restricted`
//    (see toolkit/components/extensions/Extension.sys.mjs#canAccessContainer).
//    Setting it stops the extension's `tabs`, `webNavigation`, `webRequest`
//    and `proxy` APIs from seeing or acting on tabs in restricted containers
//    — real isolation for background-script automation, no patch needed.
//    It does NOT stop the extension's content scripts from running inside
//    pages loaded in those tabs (content-script injection is driven by host
//    permissions/match patterns, which this pref doesn't touch), and a space
//    without its own container can't be isolated this way at all (container
//    0, "no container", is never restricted: too many spaces can share it).
//    Full profile isolation is a separate design decision.

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  AddonManager: "resource://gre/modules/AddonManager.sys.mjs",
  ExtensionCommon: "resource://gre/modules/ExtensionCommon.sys.mjs",
});

const FEATURE_PREF = "whimsy.feature.space-extensions";
// {extensionId: {spaces: [uuid, ...]}}; no entry (or entry.spaces == null)
// means "all spaces", Arc's default.
const VISIBILITY_PREF = "whimsy.extensions.space-visibility";
// Extension ids whose extensions.userContextIsolation.<id>.restricted pref
// Whimsy currently manages, so turning the feature off (or clearing a
// restriction) resets exactly those and nothing a user set by hand.
const MANAGED_ISOLATION_PREF = "whimsy.extensions.space-isolation-managed";
const ISOLATION_ENABLED_PREF = "extensions.userContextIsolation.enabled";
const MENU_ID = "whimsy-space-extensions-menu";
const MENUPOPUP_ID = "whimsy-space-extensions-menupopup";

function featureOn() {
  return Services.prefs.getBoolPref(FEATURE_PREF, true);
}

function readJSON(pref, fallback) {
  try {
    return JSON.parse(Services.prefs.getStringPref(pref, fallback));
  } catch (e) {
    return JSON.parse(fallback);
  }
}

export const WhimsySpaceExtensions = {
  // -- storage --------------------------------------------------------

  getVisibilityMap() {
    return readJSON(VISIBILITY_PREF, "{}");
  },

  setVisibilityMap(map) {
    Services.prefs.setStringPref(VISIBILITY_PREF, JSON.stringify(map));
  },

  // null = all spaces (the default, Arc parity for an un-customized
  // extension); an array = exactly those space uuids.
  getAllowedSpaces(extensionId) {
    const entry = this.getVisibilityMap()[extensionId];
    return Array.isArray(entry?.spaces) ? entry.spaces : null;
  },

  isVisibleInSpace(extensionId, spaceUuid) {
    const allowed = this.getAllowedSpaces(extensionId);
    return !allowed || !spaceUuid || allowed.includes(spaceUuid);
  },

  setAllowedSpaces(win, extensionId, spacesOrNull) {
    const map = this.getVisibilityMap();
    if (!spacesOrNull) {
      delete map[extensionId];
    } else {
      map[extensionId] = { spaces: spacesOrNull };
    }
    this.setVisibilityMap(map);
    this.applyContainerIsolation(win);
    this.refreshAllWindows();
  },

  forgetExtension(extensionId) {
    const map = this.getVisibilityMap();
    if (extensionId in map) {
      delete map[extensionId];
      this.setVisibilityMap(map);
    }
    this.refreshAllWindows();
  },

  // -- toolbar / panel visibility --------------------------------------

  widgetIdFor(extensionId) {
    return `${lazy.ExtensionCommon.makeWidgetId(extensionId)}-browser-action`;
  },

  // Hides/shows the CUI node for every extension with a browser action
  // (toolbar-pinned or overflowed into the unified-extensions panel) to
  // match the active space. Extensions without a browser action are
  // handled by wrapGetActivePolicies, since they only ever exist as rows
  // the panel builds from that list.
  applyVisibility(win) {
    if (!win || win.closed || !win.gZenWorkspaces) {
      return;
    }
    const activeUuid = win.gZenWorkspaces.activeWorkspace;
    for (const policy of WebExtensionPolicy.getActiveExtensions()) {
      if (policy.extension?.type !== "extension") {
        continue;
      }
      const visible = !featureOn() || this.isVisibleInSpace(policy.id, activeUuid);
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

  // Panel-list rows (extensions without a browser action) are built fresh
  // from gUnifiedExtensions.getActivePolicies() every time the panel opens
  // (see onPanelViewShowing in browser-addons.js), and that same list feeds
  // the attention dot and empty-state checks. Filtering it here covers all
  // of that in one place without touching Zen/Firefox's file.
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
      const activeUuid = win.gZenWorkspaces?.activeWorkspace;
      return policies.filter(policy => self.isVisibleInSpace(policy.id, activeUuid));
    };
    wrapped._whimsySpaceExt = true;
    gUE.getActivePolicies = wrapped;
  },

  // -- container (tabs/webNavigation/webRequest/proxy) isolation -------

  // Only restricts a container that belongs exclusively to spaces the
  // extension isn't allowed in; a container shared with an allowed space,
  // or the default "no container" (0), is never restricted.
  applyContainerIsolation(win) {
    const workspaces = win?.gZenWorkspaces?.getWorkspaces?.() ?? [];
    const containerOf = new Map(workspaces.map(w => [w.uuid, w.containerTabId || 0]));
    const defaults = Services.prefs.getDefaultBranch("");
    const map = this.getVisibilityMap();
    const previouslyManaged = new Set(readJSON(MANAGED_ISOLATION_PREF, "[]"));
    const nowManaged = new Set();
    let anyRestricted = false;

    if (featureOn()) {
      for (const [extensionId, entry] of Object.entries(map)) {
        const allowed = entry?.spaces;
        if (!Array.isArray(allowed)) {
          continue;
        }
        const allowedContainers = new Set(
          allowed.map(uuid => containerOf.get(uuid)).filter(id => !!id)
        );
        const restricted = [
          ...new Set(
            workspaces
              .filter(w => !allowed.includes(w.uuid))
              .map(w => containerOf.get(w.uuid))
              .filter(id => !!id && !allowedContainers.has(id))
          ),
        ];
        defaults.setStringPref(
          `extensions.userContextIsolation.${extensionId}.restricted`,
          JSON.stringify(restricted)
        );
        nowManaged.add(extensionId);
        if (restricted.length) {
          anyRestricted = true;
        }
      }
    }

    for (const extensionId of previouslyManaged) {
      if (!nowManaged.has(extensionId)) {
        defaults.setStringPref(`extensions.userContextIsolation.${extensionId}.restricted`, "[]");
      }
    }

    Services.prefs.setStringPref(MANAGED_ISOLATION_PREF, JSON.stringify([...nowManaged]));
    defaults.setBoolPref(ISOLATION_ENABLED_PREF, anyRestricted);
  },

  // -- "Show in Spaces…" submenu on the extension's gear menu ----------

  getExtensionIdFromMenu(menu) {
    const trigger = menu.triggerNode;
    return trigger?.closest?.("[data-extensionid]")?.dataset.extensionid ??
      trigger?.closest?.(".unified-extensions-item")
        ?.querySelector("[data-extensionid]")?.dataset.extensionid ?? null;
  },

  ensureMenuItems(win, menu = win.document.getElementById("unified-extensions-context-menu")) {
    if (!menu || menu.querySelector("[data-whimsy-space-menu]")) {
      return menu;
    }
    const { document } = win;
    const menuEl = document.createXULElement("menu");
    menuEl.setAttribute("data-whimsy-space-menu", "true");
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
        this.updateSpacePicker(win, popup, menuEl.extensionId);
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
    const item = menu.querySelector("[data-whimsy-space-menu]");
    if (!item) {
      return;
    }
    item.extensionId = this.getExtensionIdFromMenu(menu);
    item.hidden = !featureOn() || !item.extensionId;
  },

  updateSpacePicker(win, popup, extensionId) {
    const { document } = win;
    popup.replaceChildren();
    if (!extensionId || !win.gZenWorkspaces) {
      return;
    }
    const allowed = this.getAllowedSpaces(extensionId);
    const allItem = document.createXULElement("menuitem");
    allItem.setAttribute("type", "checkbox");
    document.l10n.setAttributes(allItem, "whimsy-space-extensions-all");
    allItem.toggleAttribute("checked", !allowed);
    allItem.addEventListener("command", () => this.setAllowedSpaces(win, extensionId, null));
    popup.appendChild(allItem);
    popup.appendChild(document.createXULElement("menuseparator"));
    for (const workspace of win.gZenWorkspaces.getWorkspaces()) {
      const item = document.createXULElement("menuitem");
      item.setAttribute("type", "checkbox");
      item.setAttribute("label", workspace.name || "");
      item.toggleAttribute("checked", !!allowed?.includes(workspace.uuid));
      item.addEventListener("command", () => {
        this.toggleSpace(win, extensionId, workspace.uuid);
      });
      popup.appendChild(item);
    }
  },

  toggleSpace(win, extensionId, uuid) {
    const current = this.getAllowedSpaces(extensionId) || [];
    this.setAllowedSpaces(win, extensionId, current.includes(uuid)
      ? current.filter(id => id !== uuid) : [...current, uuid]);
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
          let item = panel.querySelector("[data-whimsy-space-picker]");
          if (!item) {
            item = doc.createElement("panel-item");
            item.setAttribute("data-whimsy-space-picker", "true");
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
            card.querySelector("[data-whimsy-space-choices]")?.remove();
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

  showAddonPicker(win, card, focusSpace = null) {
    const doc = card.ownerDocument;
    card.querySelector("[data-whimsy-space-choices]")?.remove();
    const choices = doc.createElement("fieldset");
    choices.setAttribute("data-whimsy-space-choices", "true");
    choices.addEventListener("click", event => event.stopPropagation());
    const legend = doc.createElement("legend");
    doc.l10n.setAttributes(legend, "whimsy-space-extensions-picker");
    choices.appendChild(legend);
    const allowed = this.getAllowedSpaces(card.addon.id);
    const addChoice = (uuid, name) => {
      const label = doc.createElement("label");
      const input = doc.createElement("input");
      input.type = "checkbox";
      input.dataset.space = uuid ?? "";
      input.checked = uuid === null ? !allowed : !!allowed?.includes(uuid);
      const text = doc.createElement("span");
      if (uuid === null) {
        doc.l10n.setAttributes(text, "whimsy-space-extensions-all-text");
      } else {
        text.textContent = name;
      }
      input.addEventListener("change", () => {
        if (!featureOn()) {
          return;
        }
        if (uuid === null) {
          this.setAllowedSpaces(win, card.addon.id, null);
        } else {
          this.toggleSpace(win, card.addon.id, uuid);
        }
        this.showAddonPicker(win, card, uuid);
      });
      label.append(input, text);
      choices.append(label, doc.createElement("br"));
    };
    addChoice(null);
    for (const space of win.gZenWorkspaces.getWorkspaces()) {
      addChoice(space.uuid, space.name);
    }
    card.appendChild(choices);
    [...choices.querySelectorAll("input")].find(input => input.dataset.space === (focusSpace ?? "")).focus();
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

  initWindow(win) {
    if (!win.gZenWorkspaces?.workspaceEnabled) {
      return;
    }
    if (win._whimsySpaceExtensions) {
      return;
    }
    win._whimsySpaceExtensions = true;
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
    this.applyContainerIsolation(win);
  },
};
