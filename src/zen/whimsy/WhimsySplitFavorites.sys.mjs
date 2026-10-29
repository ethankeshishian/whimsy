/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Pin or favorite a split: a split you use every day (email + calendar side
// by side) reopens with one click instead of manually re-splitting two tabs
// each time. Zen's `splitData` is purely a per-session object tied to the
// tabs currently in it (ZenViewSplitter.mjs's `_data`), so a favorite is its
// own small store of { name, urls, gridType } that outlives the tabs, same
// as a pinned tab's URL outlives the tab. Opening a favorite reconstructs
// the split (fresh tabs, then the existing splitTabs(tabs, gridType)) rather
// than restoring scroll position or form state — the same honest limitation
// a pinned tab already has.
//
// Whimsy only reads window.gZenViewSplitter's public surface (currentView,
// splitViewActive, splitTabs) — never ZenViewSplitter.mjs's internal node
// classes — so this stays a pure overlay on Zen's split view.

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  WhimsyShortcuts: "resource:///modules/whimsy/WhimsyShortcuts.sys.mjs",
  JSONFile: "resource://gre/modules/JSONFile.sys.mjs",
});
ChromeUtils.defineLazyGetter(lazy, "l10n", () => new Localization(["browser/whimsy.ftl"], true));

const FEATURE_PREF = "whimsy.feature.split-favorites";
const STORE_NAME = "whimsy-split-favorites.json";

export const WhimsySplitFavorites = {
  get enabled() {
    return Services.prefs.getBoolPref(FEATURE_PREF, true);
  },

  get store() {
    if (!this._store) {
      this._store = new lazy.JSONFile({
        path: PathUtils.join(PathUtils.profileDir, STORE_NAME),
        dataPostProcessor: data => (Array.isArray(data.favorites) ? data : { favorites: [] }),
      });
    }
    return this._store;
  },

  async _load() {
    const store = this.store;
    if (!store.dataReady) {
      await store.load();
    }
    return store.data.favorites;
  },

  initWindow(win) {
    if (!this.enabled) {
      return;
    }
    lazy.WhimsyShortcuts.addCommand(win, {
      id: "whimsy-cmd-favorite-split",
      run: w => this.favoriteCurrentSplit(w),
    });
    lazy.WhimsyShortcuts.addCommand(win, {
      id: "whimsy-cmd-open-split-favorites",
      run: w => this.openFavoritesPanel(w),
    });
    lazy.WhimsyShortcuts.addActions([
      {
        l10nId: "whimsy-action-favorite-split",
        command: "whimsy-cmd-favorite-split",
        icon: "chrome://browser/skin/zen-icons/star.svg",
        isAvailable: w => this.enabled && !!w.gZenViewSplitter?.splitViewActive,
      },
      {
        l10nId: "whimsy-action-open-split-favorites",
        command: "whimsy-cmd-open-split-favorites",
        icon: "chrome://browser/skin/zen-icons/split.svg",
        isAvailable: () => this.enabled,
      },
    ]);
  },

  async favoriteCurrentSplit(win) {
    const splitter = win.gZenViewSplitter;
    const splitData = splitter?.splitViewActive ? splitter._data?.[splitter.currentView] : null;
    if (!splitData?.tabs?.length) {
      return;
    }
    const urls = splitData.tabs.map(tab => tab.linkedBrowser.currentURI.spec);
    const defaultName = splitData.tabs.map(tab => tab.label || tab.linkedBrowser.currentURI.spec).join(" + ");
    const prompts = Services.prompt;
    const input = { value: defaultName };
    const title = await lazy.l10n.formatValue("whimsy-split-favorite-name-title");
    const message = await lazy.l10n.formatValue("whimsy-split-favorite-name-prompt");
    if (!prompts.prompt(win, title, message, input, null, { value: false })) {
      return;
    }
    const favorites = await this._load();
    favorites.push({
      id: Services.uuid.generateUUID().toString(),
      name: input.value || defaultName,
      urls,
      gridType: splitData.gridType,
      created: Date.now(),
    });
    this.store.saveSoon();
    win.gZenUIManager?.showToast?.("whimsy-split-favorite-saved-toast");
  },

  async removeFavorite(id) {
    const favorites = await this._load();
    const index = favorites.findIndex(f => f.id == id);
    if (index >= 0) {
      favorites.splice(index, 1);
      this.store.saveSoon();
    }
  },

  // Reconstructs the split: a fresh tab per URL, then Zen's own splitTabs.
  // A now-dead URL still opens; it just errors normally on load, same as
  // any bad bookmark.
  async openFavorite(win, favorite) {
    const principal = Services.scriptSecurityManager.getSystemPrincipal();
    const tabs = favorite.urls.map(url =>
      win.gBrowser.addTab(url, { triggeringPrincipal: principal, inBackground: true })
    );
    win.gZenViewSplitter?.splitTabs(tabs, favorite.gridType);
  },

  async openFavoritesPanel(win) {
    const { document } = win;
    const favorites = await this._load();
    let panel = document.getElementById("whimsySplitFavoritesPanel");
    if (panel) {
      panel.remove();
    }
    panel = document.createXULElement("panel");
    panel.id = "whimsySplitFavoritesPanel";
    panel.setAttribute("type", "arrow");
    panel.setAttribute("noautofocus", "true");
    const box = document.createXULElement("vbox");
    box.className = "whimsy-split-favorites-list";
    if (!favorites.length) {
      const empty = document.createXULElement("label");
      empty.setAttribute("data-l10n-id", "whimsy-split-favorites-empty");
      box.append(empty);
    }
    for (const favorite of favorites) {
      const row = document.createXULElement("hbox");
      row.className = "whimsy-split-favorite-row";
      const open = document.createXULElement("toolbarbutton");
      open.className = "whimsy-split-favorite-open";
      open.setAttribute("label", favorite.name);
      open.setAttribute("flex", "1");
      open.addEventListener("command", () => {
        panel.hidePopup();
        this.openFavorite(win, favorite);
      });
      const remove = document.createXULElement("toolbarbutton");
      remove.className = "whimsy-split-favorite-remove";
      remove.setAttribute("data-l10n-id", "whimsy-split-favorite-remove");
      remove.addEventListener("command", async () => {
        await this.removeFavorite(favorite.id);
        row.remove();
      });
      row.append(open, remove);
      box.append(row);
    }
    panel.append(box);
    (document.getElementById("mainPopupSet") ?? document.documentElement).append(panel);
    document.l10n?.translateFragment(panel).catch(() => {});
    const anchor = document.getElementById("urlbar-container") ?? document.documentElement;
    panel.openPopup(anchor, "bottomcenter topleft");
  },
};
