/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

export const WhimsyLocalPlugins = {
  get enabled() {
    return Services.prefs.getBoolPref("whimsy.feature.local-plugins", false);
  },

  async openFolder() {
    if (!this.enabled) {
      return;
    }
    const path = PathUtils.join(PathUtils.profileDir, "whimsy-plugins");
    await IOUtils.makeDirectory(path, { createAncestors: true });
    this.launchFolder(path);
  },

  launchFolder(path) {
    const { FileUtils } = ChromeUtils.importESModule("resource://gre/modules/FileUtils.sys.mjs");
    new FileUtils.File(path).launch();
  },
};
