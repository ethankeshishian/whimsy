/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Icon pack picker data for Settings → Look and Feel → Look (wave29/icon-
// sets): Lucide (outline) and Phosphor-fill (filled) as alternatives to
// Zen's own Nucleo icons. This is only the picker's metadata (the three
// packs, the six icons every card and the preview strip show, and the URL
// for one icon in one pack); applying the pick to open windows is
// WhimsyLook.sys.mjs's initIconPack, which loads the generated override
// stylesheet (whimsy/tools/iconpacks.py) as a USER_SHEET.

const PREF = "whimsy.look.icon-pack";
const DEFAULT_PACK = "nucleo";
const NUCLEO_URL = name => `chrome://browser/skin/zen-icons/${name}.svg`;
const PACK_URL = (pack, name) => `chrome://browser/content/whimsy/icon-packs/${pack}/${name}.svg`;
const MAP_URL = "chrome://browser/content/whimsy/icon-packs/map.json";

// Picker order. Each (but nucleo) has a whimsy-look-icon-pack-<id> name and
// a whimsy-look-icon-pack-<id>-detail string (Settings → Look and Feel).
const PACKS = ["nucleo", "lucide", "phosphor-fill"];

// The six icons every card, and the toolbar preview strip below them, show
// (icon-sets.md: back, reload, bookmark, search, folder, home). These use
// Whimsy's own Nucleo names, which also name the vendored pack files.
const PREVIEW_ICONS = ["back", "reload", "bookmark-hollow", "search-glass", "folder", "home"];

export const WhimsyIconPack = {
  PREF,
  DEFAULT_PACK,
  PACKS,
  PREVIEW_ICONS,

  get selectedPack() {
    const id = Services.prefs.getStringPref(PREF, DEFAULT_PACK);
    return PACKS.includes(id) ? id : DEFAULT_PACK;
  },

  // map.json: Nucleo name -> {lucide: <file-or-null>, "phosphor-fill": ...},
  // from the same vendoring that wrote the pack directories (the reviewed
  // fallbacks the design calls for: a name a pack lacks stays Nucleo).
  async _map() {
    if (!this._mapPromise) {
      this._mapPromise = fetch(MAP_URL)
        .then(r => r.json())
        .catch(e => {
          console.error("Whimsy: icon pack map.json", e);
          return {};
        });
    }
    return this._mapPromise;
  },

  // The URL to show name in pack: Nucleo's own file for "nucleo" or any
  // name the pack doesn't carry (the documented fallback), else the
  // vendored file.
  async previewURL(pack, name) {
    if (pack == DEFAULT_PACK) {
      return NUCLEO_URL(name);
    }
    const map = await this._map();
    return map[name]?.[pack] ? PACK_URL(pack, name) : NUCLEO_URL(name);
  },
};
