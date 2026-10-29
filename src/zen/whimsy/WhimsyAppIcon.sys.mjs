/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Lets people pick the app icon. The bundle ships with the default
// ("daydream"); any other choice replaces the Dock icon while the app runs.
// "day-and-night" follows the system's light or dark appearance.
//
// The choice is also written into an installed bundle (Contents/Resources/
// firefox.icns, then an ad-hoc re-sign and a LaunchServices refresh), so
// Finder, Spotlight and launchers show it too. Day & Night writes its light
// face there. The original icon is kept as firefox-default.icns, and a
// whimsy-app-icon file records what the bundle shows, so a bundle replaced
// by an update gets the choice again at startup. With the local updater, its
// installs re-apply the saved icon (whimsy/updater/updater.py).

import { AppConstants } from "resource://gre/modules/AppConstants.sys.mjs";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  Subprocess: "resource://gre/modules/Subprocess.sys.mjs",
  WhimsyUpdates: "resource:///modules/whimsy/WhimsyUpdates.sys.mjs",
});

const PREF = "whimsy.app-icon";
const DEFAULT_ICON = "daydream";
const AUTO_ICON = "day-and-night";
const ICON_URL = id => `chrome://browser/content/whimsy/app-icons/${id}.png`;
const MARKER = "whimsy-app-icon";

// Writes an icon into a bundle: $1 app, $2 PNG (empty: the default icon),
// $3 icon id, $4 where to keep a copy for the local updater (optional).
// Never NSWorkspace setIcon: its Icon\r file breaks the code seal.
const BUNDLE_SCRIPT = `set -e
app="$1"; res="$app/Contents/Resources"
[ -f "$res/firefox-default.icns" ] || cp "$res/firefox.icns" "$res/firefox-default.icns"
if [ -n "$2" ]; then
  tmp=$(mktemp -d); set="$tmp/icon.iconset"; mkdir "$set"
  for s in 16 32 128 256 512; do
    /usr/bin/sips -z $s $s "$2" --out "$set/icon_\${s}x\${s}.png" >/dev/null
    /usr/bin/sips -z $((s*2)) $((s*2)) "$2" --out "$set/icon_\${s}x\${s}@2x.png" >/dev/null
  done
  /usr/bin/iconutil -c icns "$set" -o "$tmp/icon.icns"
  cp "$tmp/icon.icns" "$res/firefox.icns"
  [ -z "$4" ] || cp "$tmp/icon.icns" "$4"
  rm -rf "$tmp"
else
  cp "$res/firefox-default.icns" "$res/firefox.icns"
  [ -z "$4" ] || rm -f "$4"
fi
printf %s "$3" > "$res/${MARKER}"
# Re-seal a signed bundle, as publish.py signs it (a local build only has
# the linker's signature on its executables: nothing to re-seal).
if [ -f "$app/Contents/_CodeSignature/CodeResources" ]; then
  /usr/bin/codesign --force --sign - --preserve-metadata=entitlements,requirements,flags "$app"
fi
/usr/bin/touch "$app"
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f "$app"
`;

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
    Services.prefs.addObserver(PREF, () => {
      this.apply();
      this.writeBundleIcon();
    });
    Services.obs.addObserver(() => this.apply(), "look-and-feel-changed");
    this.apply();
    // After an update replaced the bundle, or a choice made elsewhere.
    this.writeBundleIcon();
  },

  // Overridable for tests: the running .app, or null for a build that isn't
  // installed (a dev build runs from the build folder, whose files are links
  // into the source tree). Installed bundles carry whimsy-version.json.
  bundlePath() {
    const resources = Services.dirsvc.get("GreD", Ci.nsIFile);
    const version = resources.clone();
    version.append("whimsy-version.json");
    const icns = resources.clone();
    icns.append("firefox.icns");
    if (!version.exists() || !icns.exists() || icns.isSymlink()) {
      return null;
    }
    return resources.parent.parent.path;
  },

  // The icon the bundle should show: Day & Night's light face.
  get bundleIcon() {
    const id = this.selectedIcon;
    return id == AUTO_ICON ? `${AUTO_ICON}-light` : id;
  },

  async readMarker(app) {
    try {
      return (await IOUtils.readUTF8(PathUtils.join(app, "Contents", "Resources", MARKER))).trim();
    } catch {
      return DEFAULT_ICON;
    }
  },

  async run(args) {
    const proc = await lazy.Subprocess.call({
      command: "/bin/sh",
      arguments: ["-c", BUNDLE_SCRIPT, "whimsy-app-icon", ...args],
      stderr: "stdout",
    });
    const output = await proc.stdout.readString();
    const { exitCode } = await proc.wait();
    if (exitCode != 0) {
      throw new Error(`exit ${exitCode}: ${output.trim()}`);
    }
  },

  // Writes the chosen icon into the installed bundle, once per change.
  async writeBundleIcon() {
    const app = this.bundlePath();
    if (!app) {
      return;
    }
    const icon = this.bundleIcon;
    const job = (this._bundleJob ?? Promise.resolve()).then(async () => {
      if ((await this.readMarker(app)) == icon) {
        return;
      }
      let png = "";
      if (icon != DEFAULT_ICON) {
        const bytes = new Uint8Array(await (await fetch(ICON_URL(icon))).arrayBuffer());
        png = PathUtils.join(PathUtils.tempDir, `whimsy-app-icon-${icon}.png`);
        await IOUtils.write(png, bytes);
      }
      const updates = lazy.WhimsyUpdates;
      const local = updates.isInstalled();
      const saved = local ? PathUtils.join(updates.dir, "app-icon.icns") : "";
      if (local) {
        await IOUtils.makeDirectory(updates.dir, { ignoreExisting: true });
      }
      try {
        await this.run([app, png, icon, saved]);
      } finally {
        if (png) {
          await IOUtils.remove(png, { ignoreAbsent: true });
        }
      }
      if (local) {
        await updates.writeControl({ app_icon: icon == DEFAULT_ICON ? null : icon });
      }
    });
    this._bundleJob = job.catch(e => console.error("Whimsy: couldn't write the app icon into the bundle", e));
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
