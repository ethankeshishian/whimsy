/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// W26 extpin: extensions aren't pinned to the URL bar by default (owner).
//
// Firefox places a new extension's button where its manifest asks:
// browser_action.default_area "navbar" (uBlock Origin, 1Password, Bitwarden,
// and many more ask for it) puts it on the nav bar
// (ExtensionActions.sys.mjs BrowserActionBase constructor →
// ext-browserAction.js build() defaultArea → CustomizableUI.createWidget,
// which auto-adds an unseen widget to its default area), and Zen's single
// toolbar then moves nav-bar extension buttons into the URL bar
// (ZenVerticalTabsManager.mjs appendCustomizableItem). In Whimsy every
// extension starts in the site panel's Extensions section instead
// (CustomizableUI.AREA_ADDONS); Pin to Toolbar still pins it, and that pin
// is kept. An enterprise policy's default_area still wins: it's an admin's
// choice, not the extension's.
//
// Migration, once per extension that was already placed before this change:
// a button on a toolbar whose manifest asks for a toolbar is taken to be
// auto-pinned and goes back to the panel; one whose manifest asks for the
// panel (Firefox's default) can only be on a toolbar because the user pinned
// it, so it stays. CustomizableUI keeps no record of who pinned, so a
// toolbar-default extension the user unpinned and pinned again looks the
// same as an auto-pinned one and moves once; pinning it again sticks.

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  CustomizableUI:
    "moz-src:///browser/components/customizableui/CustomizableUI.sys.mjs",
});

export const FEATURE_PREF = "whimsy.feature.extensions-in-panel";
// The widget ids that sat outside the panel when Whimsy first ran with this
// change, as JSON; each one is checked once, when its extension next starts.
// Unset: the snapshot hasn't been taken yet.
export const MIGRATION_PREF = "whimsy.extensions.pin-migration";
const STATE_PREF = "browser.uiCustomization.state";
const WIDGET_SUFFIX = "-browser-action";
// CustomizableUI.AREA_ADDONS, without loading CustomizableUI at startup.
const ADDONS_AREA = "unified-extensions-area";

function featureOn() {
  return Services.prefs.getBoolPref(FEATURE_PREF, true);
}

function policyArea(extension) {
  return Services.policies?.getExtensionSettings(extension.id)?.default_area;
}

function manifestArea(extension) {
  const action = extension.manifest?.browser_action || extension.manifest?.action;
  return action?.default_area || "menupanel";
}

// Every extension widget placed outside the panel: from the saved state
// and, once CustomizableUI is running, its live placements too.
function pinnedWidgetIds(live) {
  const ids = new Set();
  if (live) {
    const CUI = lazy.CustomizableUI;
    for (const area of CUI.areas) {
      if (area == ADDONS_AREA) {
        continue;
      }
      for (const id of CUI.getWidgetIdsInArea(area)) {
        if (id.endsWith(WIDGET_SUFFIX)) {
          ids.add(id);
        }
      }
    }
  }
  try {
    const saved = JSON.parse(Services.prefs.getStringPref(STATE_PREF, "") || "{}");
    for (const [area, placed] of Object.entries(saved.placements || {})) {
      if (area == ADDONS_AREA) {
        continue;
      }
      for (const id of placed) {
        if (id.endsWith(WIDGET_SUFFIX)) {
          ids.add(id);
        }
      }
    }
  } catch (e) {
    console.error(e);
  }
  return [...ids];
}

function takeSnapshot(live) {
  const pending = pinnedWidgetIds(live);
  Services.prefs.setStringPref(MIGRATION_PREF, JSON.stringify(pending));
  return pending;
}

function readPending() {
  if (!Services.prefs.prefHasUserValue(MIGRATION_PREF)) {
    return takeSnapshot(true);
  }
  try {
    return JSON.parse(Services.prefs.getStringPref(MIGRATION_PREF, "[]"));
  } catch (e) {
    return [];
  }
}

export const WhimsyExtensionPins = {
  // At profile-after-change (WhimsyStartup), before any extension starts:
  // the snapshot only ever holds placements made before this change.
  snapshotAtStartup() {
    if (featureOn() && !Services.prefs.prefHasUserValue(MIGRATION_PREF)) {
      takeSnapshot(false);
    }
  },

  // The area a new extension button starts in: Firefox's choice is `area`.
  defaultArea(extension, area) {
    if (!featureOn() || policyArea(extension)) {
      return area;
    }
    return lazy.CustomizableUI.AREA_ADDONS;
  },

  // Called once the widget exists. Moves a button that was auto-pinned
  // before this change back to the panel, once per extension.
  migrate(extension, widgetId) {
    if (!featureOn()) {
      return;
    }
    try {
      const pending = readPending();
      const index = pending.indexOf(widgetId);
      if (index == -1) {
        return;
      }
      pending.splice(index, 1);
      Services.prefs.setStringPref(MIGRATION_PREF, JSON.stringify(pending));
      if (policyArea(extension) || manifestArea(extension) == "menupanel") {
        return;
      }
      const CUI = lazy.CustomizableUI;
      const placement = CUI.getPlacementOfWidget(widgetId, false);
      if (placement && placement.area != ADDONS_AREA) {
        CUI.addWidgetToArea(widgetId, CUI.AREA_ADDONS, 0);
      }
    } catch (e) {
      console.error(e);
    }
  },
};
