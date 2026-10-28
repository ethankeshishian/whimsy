/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Lets people pick the app icon. The bundle ships with the default
// ("daydream"); any other choice replaces the Dock icon while the app runs.
// "day-and-night" follows the system's light or dark appearance.

import { AppConstants } from "resource://gre/modules/AppConstants.sys.mjs";

const PREF = "whimsy.app-icon";
const DEFAULT_ICON = "daydream";
const AUTO_ICON = "day-and-night";
const ICON_URL = id => `chrome://browser/content/whimsy/app-icons/${id}.png`;

// Picker order. Each id has a zen-app-icon-<id> string and a PNG.
const ICONS = [
  "daydream",
  "day-and-night",
  "cotton-candy",
  "golden-hour",
  "lagoon",
  "berry-jam",
  "lemonade",
  "stargazer",
  "spearmint",
  "sugar-rush",
  "party-popper",
];

export const WhimsyAppIcon = {
  PREF,
  DEFAULT_ICON,
  ICONS,

  // The image for a picker tile. Day & Night shows its light face.
  previewURL(id) {
    return ICON_URL(id == AUTO_ICON ? `${AUTO_ICON}-light` : id);
  },

  init() {
    if (this._initialized || AppConstants.platform != "macosx") {
      return;
    }
    this._initialized = true;
    Services.prefs.addObserver(PREF, () => this.apply());
    Services.obs.addObserver(() => this.apply(), "look-and-feel-changed");
    this.apply();
  },

  get selectedIcon() {
    const id = Services.prefs.getStringPref(PREF, DEFAULT_ICON);
    return ICONS.includes(id) ? id : DEFAULT_ICON;
  },

  // The image to show right now, or null for the bundle's own icon.
  get resolvedImage() {
    const id = this.selectedIcon;
    if (id == DEFAULT_ICON) {
      return null;
    }
    if (id == AUTO_ICON) {
      return `${AUTO_ICON}-${this._systemIsDark() ? "dark" : "light"}`;
    }
    return id;
  },

  _systemIsDark() {
    const win = Services.wm.getMostRecentWindow(null);
    return !!win?.matchMedia("(-moz-system-dark-theme)").matches;
  },

  async apply() {
    const image = this.resolvedImage;
    if (image === this._applied) {
      return;
    }
    this._applied = image;
    const dock = Cc["@mozilla.org/widget/macdocksupport;1"].getService(Ci.nsIMacDockSupport);
    if (!image) {
      dock.setApplicationIcon(null);
      return;
    }
    try {
      const response = await fetch(ICON_URL(image));
      const buffer = await response.arrayBuffer();
      const container = Cc["@mozilla.org/image/tools;1"]
        .getService(Ci.imgITools)
        .decodeImageFromArrayBuffer(buffer, "image/png");
      // A newer choice may have landed while this one loaded.
      if (this._applied === image) {
        dock.setApplicationIcon(container);
      }
    } catch (e) {
      console.error("Whimsy: couldn't apply app icon", image, e);
      this._applied = undefined;
    }
  },
};
