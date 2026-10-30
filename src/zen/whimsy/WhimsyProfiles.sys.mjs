/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// wave5/profiles: Arc's profiles on top of Firefox containers, inside one
// Firefox profile and one Firefox Account (docs/whimsy/space-profiles-spec.md).
//
// Arc: every space belongs to a profile; a profile is its own browser data
// (logins, cookies, history, favorites, extensions), and a new one starts
// empty. People use it to keep work and personal accounts apart without
// juggling windows. Here a profile IS a container (Gecko's contextual
// identity): container 0 is "Default", every public container is a named
// profile, and a space's profile is Zen's workspace.containerTabId. Cookies,
// cache and site storage are partitioned by Gecko itself; the rest of the
// per-profile behaviour lives in the WhimsyProfile* modules.
//
// Anything synced is keyed by the profile *key* rather than the container
// id, because container ids differ between devices: "default" for 0, else
// the guid Zen's Spaces sync gives the container (builtin-1..4 for Firefox's
// four). Zen's sync carries the containers and the space assignments.

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  ContextualIdentityService: "moz-src:///toolkit/components/contextualidentity/ContextualIdentityService.sys.mjs",
  PrivateBrowsingUtils: "resource://gre/modules/PrivateBrowsingUtils.sys.mjs",
  WhimsyPanels: "resource:///modules/whimsy/WhimsyPanels.sys.mjs",
  WhimsyProfileHistory: "resource:///modules/whimsy/WhimsyProfileHistory.sys.mjs",
  WhimsyProfileMoves: "resource:///modules/whimsy/WhimsyProfileMoves.sys.mjs",
  WhimsyProfilePasswords: "resource:///modules/whimsy/WhimsyProfilePasswords.sys.mjs",
  WhimsyProfileSettings: "resource:///modules/whimsy/WhimsyProfileSettings.sys.mjs",
  ZenSpacesSyncModel: "resource:///modules/zen/ZenSpacesSyncModel.sys.mjs",
});
ChromeUtils.defineLazyGetter(lazy, "l10n", () => new Localization(["browser/whimsy.ftl"], true));

const HTML_NS = "http://www.w3.org/1999/xhtml";
const FEATURE_PREF = "whimsy.feature.space-profiles";
const MIGRATED_PREF = "whimsy.profiles.migrated";
export const DEFAULT_KEY = "default";
// Firefox's container colours, in its own order; a new profile takes the
// next one so neighbours in a list differ.
const COLORS = ["blue", "turquoise", "green", "yellow", "orange", "red", "pink", "purple"];
const NAME_MAX = 40;
const NAME_PANEL_ID = "whimsy-profile-name-panel";
const CREATE_ITEM_ATTR = "data-whimsy-create-profile";

export const WhimsyProfiles = {
  FEATURE_PREF,
  DEFAULT_KEY,

  get enabled() {
    return Services.prefs.getBoolPref(FEATURE_PREF, true) &&
      Services.prefs.getBoolPref("privacy.userContext.enabled", true);
  },

  // -- model -------------------------------------------------------------

  /** Every profile, Default first, then containers in their own order. */
  list() {
    const profiles = [{ id: 0, key: DEFAULT_KEY, name: this.defaultName(), isDefault: true }];
    for (const identity of lazy.ContextualIdentityService.getPublicIdentities()) {
      profiles.push({
        id: identity.userContextId,
        key: this.keyFor(identity.userContextId),
        name: lazy.ContextualIdentityService.getUserContextLabel(identity.userContextId),
        color: identity.color,
        icon: identity.icon,
        isDefault: false,
      });
    }
    return profiles;
  },

  defaultName() {
    return lazy.l10n.formatValueSync("whimsy-profile-default-name");
  },

  exists(id) {
    id = Number(id) || 0;
    return id === 0 || !!lazy.ContextualIdentityService.getPublicIdentityFromId(id);
  },

  nameOf(id) {
    id = Number(id) || 0;
    if (id === 0 || !this.exists(id)) {
      return this.defaultName();
    }
    return lazy.ContextualIdentityService.getUserContextLabel(id);
  },

  /** The synced, device-independent key of a profile (see the banner). */
  keyFor(id) {
    id = Number(id) || 0;
    if (id === 0 || !this.exists(id)) {
      return DEFAULT_KEY;
    }
    try {
      return lazy.ZenSpacesSyncModel.guidForContextId(id, { create: true }) ?? `local-${id}`;
    } catch (e) {
      console.error("Whimsy: profile key", e);
      return `local-${id}`;
    }
  },

  /** The container id for a key, or null when this device has no such profile. */
  idForKey(key) {
    if (!key || key === DEFAULT_KEY) {
      return 0;
    }
    if (key.startsWith("local-")) {
      const id = Number(key.slice(6));
      return this.exists(id) ? id : null;
    }
    try {
      return lazy.ZenSpacesSyncModel.contextIdForGuid(key);
    } catch (e) {
      console.error("Whimsy: profile key", e);
      return null;
    }
  },

  /** A space's profile id (Zen: no container means Default). */
  profileIdOfSpace(space) {
    const id = Number(space?.containerTabId) || 0;
    return this.exists(id) ? id : 0;
  },

  /** An ordinary (non-private) browser window with spaces, if any. */
  mainWindow(preferred = null) {
    const usable = win => win && !win.closed && win.gZenWorkspaces?.workspaceEnabled &&
      !win._whimsyQuickWindow && !lazy.PrivateBrowsingUtils.isWindowPrivate(win);
    if (usable(preferred)) {
      return preferred;
    }
    for (const win of Services.wm.getEnumerator("navigator:browser")) {
      if (usable(win)) {
        return win;
      }
    }
    return null;
  },

  spaces(win = null) {
    return this.mainWindow(win)?.gZenWorkspaces.getWorkspaces() ?? [];
  },

  spacesFor(id, win = null) {
    id = Number(id) || 0;
    return this.spaces(win).filter(space => this.profileIdOfSpace(space) === id);
  },

  /** The profile of the space in front of `win`. */
  activeProfileId(win) {
    const space = win?.gZenWorkspaces?.getActiveWorkspace?.();
    return space ? this.profileIdOfSpace(space) : 0;
  },

  /**
   * Checks a proposed name. Returns null when it's fine, else the l10n id
   * of the reason (shown under the field).
   */
  validateName(name, exceptId = null) {
    const trimmed = String(name ?? "").trim();
    if (!trimmed) {
      return "whimsy-profile-name-empty";
    }
    const folded = trimmed.toLocaleLowerCase();
    const taken = this.list().some(profile => profile.id !== exceptId &&
      profile.name.trim().toLocaleLowerCase() === folded);
    return taken ? "whimsy-profile-name-taken" : null;
  },

  create(name) {
    const error = this.validateName(name);
    if (error) {
      throw new Error(error);
    }
    const count = lazy.ContextualIdentityService.getPublicIdentities().length;
    const identity = lazy.ContextualIdentityService.create(
      String(name).trim().slice(0, NAME_MAX), "fingerprint", COLORS[count % COLORS.length]);
    // Register its synced key now, so settings saved for it right away
    // already use the key other devices will see.
    this.keyFor(identity.userContextId);
    return identity.userContextId;
  },

  rename(id, name) {
    id = Number(id) || 0;
    if (id === 0) {
      throw new Error("whimsy-profile-default-fixed");
    }
    const error = this.validateName(name, id);
    if (error) {
      throw new Error(error);
    }
    const identity = lazy.ContextualIdentityService.getPublicIdentityFromId(id);
    lazy.ContextualIdentityService.update(id, String(name).trim().slice(0, NAME_MAX),
      identity.icon, identity.color);
  },

  /** Arc: Default stays, and a profile still assigned to a space stays. */
  canDelete(id, win = null) {
    id = Number(id) || 0;
    return id !== 0 && this.exists(id) && !this.spacesFor(id, win).length;
  },

  // Other modules forget their per-profile data here (passwords, settings).
  _deleteHooks: [],
  onDelete(hook) {
    this._deleteHooks.push(hook);
  },

  /**
   * Deletes a profile and its data: Firefox's container removal clears its
   * cookies, cache and site storage; hooks remove the rest.
   */
  async delete(id, win = null) {
    id = Number(id) || 0;
    if (!this.canDelete(id, win)) {
      return false;
    }
    const key = this.keyFor(id);
    for (const hook of this._deleteHooks) {
      try {
        await hook(id, key);
      } catch (e) {
        console.error("Whimsy: profile delete hook", e);
      }
    }
    lazy.ContextualIdentityService.remove(id);
    return true;
  },

  unusedIds(win = null) {
    return this.list().filter(profile => this.canDelete(profile.id, win)).map(profile => profile.id);
  },

  async deleteUnused(win = null) {
    let count = 0;
    for (const id of this.unusedIds(win)) {
      if (await this.delete(id, win)) {
        count++;
      }
    }
    return count;
  },

  /** Assigns a space to a profile (Zen's own field and save path). */
  async assignSpace(win, space, id) {
    id = Number(id) || 0;
    if (!space || !this.exists(id)) {
      return false;
    }
    space.containerTabId = id;
    await win.gZenWorkspaces.saveWorkspace(space);
    win.gZenWorkspaces.updateTabsContainers?.();
    return true;
  },

  // -- migration ---------------------------------------------------------

  // Versioned steps, each run once. Default needs nothing: it IS container
  // 0, so cookies, untagged logins, history, essentials and extensions stay
  // where they are. Later steps register themselves here.
  _migrations: [],
  addMigration(version, step) {
    this._migrations.push({ version, step });
    this._migrations.sort((a, b) => a.version - b.version);
  },

  async migrate(win) {
    const done = Services.prefs.getIntPref(MIGRATED_PREF, 0);
    for (const { version, step } of this._migrations) {
      if (version <= done) {
        continue;
      }
      try {
        await step(win);
      } catch (e) {
        console.error(`Whimsy: profiles migration ${version}`, e);
        return;
      }
      Services.prefs.setIntPref(MIGRATED_PREF, version);
    }
  },

  // -- name sheet (create / rename) --------------------------------------

  /**
   * Asks for a profile name in a small sheet anchored to `anchor`.
   * Validates on submit, says why inline, and keeps the sheet open until
   * the name works. Resolves the new/renamed profile id, or null.
   */
  promptName(win, { anchor = null, renameId = null } = {}) {
    const { WhimsyPanels } = lazy;
    const doc = win.document;
    return new Promise(resolve => {
      let result = null;
      const { panel, body, footer } = WhimsyPanels.create(win, {
        id: NAME_PANEL_ID,
        titleL10nId: renameId === null ? "whimsy-profile-create-title" : "whimsy-profile-rename-title",
        footer: true,
        onHidden: () => resolve(result),
      });
      const form = doc.createElementNS(HTML_NS, "form");
      form.className = "whimsy-profile-name-form";
      const label = doc.createElementNS(HTML_NS, "label");
      label.htmlFor = `${NAME_PANEL_ID}-input`;
      label.className = "whimsy-profile-name-label";
      doc.l10n.setAttributes(label, "whimsy-profile-name-label");
      const input = doc.createElementNS(HTML_NS, "input");
      input.id = `${NAME_PANEL_ID}-input`;
      input.className = "whimsy-profile-name-input";
      input.type = "text";
      input.maxLength = NAME_MAX;
      input.setAttribute("autocomplete", "off");
      input.setAttribute("aria-describedby", `${NAME_PANEL_ID}-error`);
      if (renameId !== null) {
        input.value = this.nameOf(renameId);
      }
      const error = doc.createElementNS(HTML_NS, "p");
      error.id = `${NAME_PANEL_ID}-error`;
      error.className = "whimsy-profile-name-error";
      error.hidden = true;
      form.append(label, input, error);
      body.append(form);

      const showError = l10nId => {
        error.hidden = !l10nId;
        input.toggleAttribute("aria-invalid", !!l10nId);
        if (l10nId) {
          doc.l10n.setAttributes(error, l10nId);
          input.focus();
          input.select();
        } else {
          error.removeAttribute("data-l10n-id");
          error.textContent = "";
        }
      };
      input.addEventListener("input", () => {
        if (!error.hidden) {
          showError(null);
        }
      });
      const submit = event => {
        event?.preventDefault();
        try {
          if (renameId === null) {
            result = this.create(input.value);
          } else {
            this.rename(renameId, input.value);
            result = renameId;
          }
        } catch (e) {
          showError(e.message.startsWith("whimsy-") ? e.message : "whimsy-profile-name-failed");
          return;
        }
        WhimsyPanels.close(panel);
      };
      form.addEventListener("submit", submit);
      input.addEventListener("keydown", event => {
        if (event.key == "Enter") {
          submit(event);
        }
      });
      footer.append(
        WhimsyPanels.footerButton(doc, {
          l10nId: "whimsy-profile-cancel",
          onCommand: () => WhimsyPanels.close(panel),
        }),
        WhimsyPanels.footerButton(doc, {
          l10nId: renameId === null ? "whimsy-profile-create-button" : "whimsy-profile-rename-button",
          primary: true,
          onCommand: submit,
        })
      );
      panel.addEventListener("popupshown", () => {
        input.focus();
        input.select();
      });
      WhimsyPanels.open(win, panel, { anchor: anchor ? WhimsyPanels.visibleAnchor(win, [anchor]) : null });
    });
  },

  // -- Zen's space editor: "Set Profile" and the new-space Profile list --

  createMenuItem(doc, onCreate) {
    const item = doc.createXULElement("menuitem");
    item.setAttribute(CREATE_ITEM_ATTR, "true");
    doc.l10n.setAttributes(item, "whimsy-profile-create-menuitem");
    item.addEventListener("command", event => {
      // Zen's own command listener on the list would read this item as a
      // container (NaN); it's ours alone.
      event.stopPropagation();
      onCreate();
    });
    return item;
  },

  initSpaceMenus(win) {
    const doc = win.document;
    // Bubbling: Zen fills both lists in its own popupshowing listeners on
    // the lists themselves, which run before this one; then "Create a New
    // Profile…" goes last, as in Arc.
    win.addEventListener("popupshowing", event => {
      if (event.target.id == "zenWorkspaceMoreActions") {
        // Same target Zen reads for its own context menu data.
        let target = null;
        try {
          target = event.explicitOriginalTarget?.closest?.("toolbarbutton");
        } catch {}
        win._whimsyProfileMenuSpace = target?.getAttribute("zen-workspace-id") || null;
        return;
      }
      if (!this.enabled) {
        return;
      }
      const popup = event.target;
      const setProfile = popup.parentNode?.id == "context_zenWorkspacesOpenInContainerTab";
      const creation = popup.classList?.contains("zen-workspace-creation-profiles-popup");
      if ((!setProfile && !creation) || popup.querySelector(`[${CREATE_ITEM_ATTR}]`)) {
        return;
      }
      if (setProfile) {
        // The space the menu was opened for, read now: Zen clears its
        // context menu data once the menu closes.
        const space = this.contextMenuSpace(win);
        const anchor = popup.closest("menupopup#zenWorkspaceMoreActions")?.anchorNode ??
          doc.getElementById("zen-workspaces-button");
        popup.append(doc.createXULElement("menuseparator"), this.createMenuItem(doc, async () => {
          const id = await this.promptName(win, { anchor });
          if (id !== null && space) {
            await this.moveSpaceToProfile(win, space, id, { fresh: true });
          }
        }));
      } else {
        const form = popup.closest("zen-workspace-creation");
        const button = form?.querySelector(".zen-workspace-creation-profile");
        popup.append(doc.createXULElement("menuseparator"), this.createMenuItem(doc, async () => {
          const id = await this.promptName(win, { anchor: button });
          if (id !== null && form?.isConnected) {
            form.currentProfile = { id, name: this.nameOf(id) };
          }
        }));
      }
    });
  },

  /** The space Zen's space menu is acting on. */
  contextMenuSpace(win) {
    const workspaces = win.gZenWorkspaces;
    const uuid = win._whimsyProfileMenuSpace;
    return (uuid && workspaces.getWorkspaceFromId?.(uuid)) || workspaces.getActiveWorkspace();
  },

  /**
   * Moves a space to another profile: Arc's warning, then its tabs reopen
   * in the new container (WhimsyProfileMoves). `fresh` means the profile
   * was just created for this space; its tabs still change profile, so the
   * warning still applies.
   */
  async moveSpaceToProfile(win, space, id, { fresh = false } = {}) {
    void fresh;
    return lazy.WhimsyProfileMoves.moveSpace(win, space, id);
  },

  // -- wiring ------------------------------------------------------------

  initWindow(win) {
    if (win._whimsyProfiles || !win.gZenWorkspaces?.workspaceEnabled ||
        lazy.PrivateBrowsingUtils.isWindowPrivate(win)) {
      return;
    }
    win._whimsyProfiles = true;
    this.initSpaceMenus(win);
    // Once per session; each part checks the switch on use.
    lazy.WhimsyProfilePasswords.init();
    lazy.WhimsyProfileHistory.init();
    lazy.WhimsyProfileSettings.initWindow(win);
    lazy.WhimsyProfileMoves.initWindow(win);
    for (const hook of this._windowHooks) {
      try {
        hook(win);
      } catch (e) {
        console.error("Whimsy: profiles window hook", e);
      }
    }
    if (!this._migrating) {
      this._migrating = this.migrate(win);
    }
  },

  // Later phases add per-window setup here.
  _windowHooks: [],
  onWindow(hook) {
    this._windowHooks.push(hook);
  },
};
