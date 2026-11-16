/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// W28: Search With ▸, right after "Search <engine> for "…"" in the
// selection menu. Owner sign-off: "Does it open in another tab? It should
// match the google/default one" — so every row reuses #context-searchselect's
// own expandos (searchTerms, principal, policyContainer, usePrivate) and
// calls the same gContextMenu.loadSearch(event), which goes to
// SearchUIUtils.loadSearchFromContext: identical tab rule, foreground or
// background per browser.search.context.loadInBackground, and private
// handling. Only `engine` differs per row.

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  SearchService: "moz-src:///toolkit/components/search/SearchService.sys.mjs",
});

const FEATURE_PREF = "whimsy.feature.search-with";
const MENU_ID = "context-whimsy-searchwith";
const POPUP_ID = "context-whimsy-searchwith-popup";
const ROW_CLASS = "whimsy-search-with-row menuitem-iconic";

const installed = new WeakSet();

export const WhimsySearchWith = {
  get enabled() {
    return Services.prefs.getBoolPref(FEATURE_PREF, true);
  },

  initWindow(win) {
    if (installed.has(win)) {
      return;
    }
    installed.add(win);
    const menu = win.document.getElementById("contentAreaContextMenu");
    if (!menu) {
      return;
    }
    const onShowing = event => {
      if (event.target != menu) {
        return;
      }
      try {
        this.updateMenu(win);
      } catch (e) {
        console.error("Whimsy: search with", e);
      }
    };
    menu.addEventListener("popupshowing", onShowing);
    win.addEventListener("unload", () => menu.removeEventListener("popupshowing", onShowing), { once: true });
  },

  // The <menu id="context-whimsy-searchwith"> row, created once per window
  // and reused. Kept out of the markup (browser-context.inc.xhtml stays
  // untouched); inserted after #context-searchselect at run time.
  row(win) {
    const doc = win.document;
    let menu = doc.getElementById(MENU_ID);
    if (menu) {
      return menu;
    }
    menu = doc.createXULElement("menu");
    menu.id = MENU_ID;
    doc.l10n.setAttributes(menu, "whimsy-context-search-with");
    const popup = doc.createXULElement("menupopup");
    popup.id = POPUP_ID;
    menu.append(popup);
    return menu;
  },

  updateMenu(win) {
    const doc = win.document;
    const anchor = doc.getElementById("context-searchselect");
    const menu = this.row(win);
    if (anchor && anchor.nextElementSibling != menu) {
      anchor.after(menu);
    }
    // Follows #context-searchselect's own visibility (text field, link,
    // devtools toolbox, an engine that doesn't support this response
    // type…), on top of needing 2+ visible engines (the one above already
    // covers the default).
    if (!this.enabled || !anchor || anchor.hidden) {
      menu.hidden = true;
      return;
    }
    const engines = this.otherEngines(anchor.engine);
    menu.hidden = !engines.length;
    if (!menu.hidden) {
      this.fill(win, menu.menupopup, engines, anchor);
    }
  },

  // Settings order, minus the default the row above already searches.
  otherEngines(defaultEngine) {
    try {
      return lazy.SearchService.visibleEngines.filter(engine => engine != defaultEngine);
    } catch (e) {
      console.error("Whimsy: search with engines", e);
      return [];
    }
  },

  fill(win, popup, engines, anchor) {
    const doc = win.document;
    popup.replaceChildren(
      ...engines.map(engine => {
        const row = doc.createXULElement("menuitem");
        row.className = ROW_CLASS;
        row.setAttribute("label", engine.name);
        // Same expandos #updateSearchMenuitem puts on the row above
        // (nsContextMenu.sys.mjs), engine swapped for this one.
        row.engine = engine;
        row.searchTerms = anchor.searchTerms;
        row.principal = anchor.principal;
        row.policyContainer = anchor.policyContainer;
        row.usePrivate = anchor.usePrivate;
        row.addEventListener("command", event => {
          win.gContextMenu?.loadSearch({ event });
        });
        engine
          .getIconURL(16)
          .then(url => {
            if (url && row.isConnected) {
              row.setAttribute("image", url);
            }
          })
          .catch(() => {});
        return row;
      })
    );
  },
};
