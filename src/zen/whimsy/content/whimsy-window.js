/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Loaded into each browser window by WhimsyUpdates.showUpdatedNotice.

"use strict";

var WhimsyWindow = {
  // After the updater installed a new build (or rolled back), say so once,
  // with Zen's own sidebar notification. Zen's sweep animation plays on its
  // own because the build ID changed.
  // Returns the notification element, if one was shown. `force` shows it
  // even under test automation (for the screenshot tool).
  async showUpdatedNotice(notice, { force = false } = {}) {
    const { WhimsyUpdates } = ChromeUtils.importESModule(
      "resource:///modules/whimsy/WhimsyUpdates.sys.mjs"
    );
    notice ??= await WhimsyUpdates.takeUpdatedNotice();
    if (!notice || (window.gZenUIManager?.testingEnabled && !force)) {
      return null;
    }
    await window.gZenWorkspaces?.promiseInitialized;
    // A window module: load it into this window's global, like Zen does.
    const { default: createSidebarNotification } = ChromeUtils.importESModule(
      "chrome://browser/content/zen-components/ZenSidebarNotification.mjs",
      { global: "current" }
    );
    const links = [];
    if (!notice.rolled_back && notice.version) {
      const pattern = Services.prefs.getStringPref("app.releaseNotesURL.prompt", "");
      if (pattern) {
        links.push({
          url: Services.urlFormatter.formatURL(pattern.replace("%VERSION%", notice.version)),
          l10nId: "whimsy-updated-notes",
          special: true,
          icon: "chrome://browser/skin/zen-icons/sparkles.svg",
        });
      }
    }
    links.push({
      action: () => window.openPreferences("paneZenLooks"),
      l10nId: notice.rolled_back ? "whimsy-updated-settings" : "whimsy-updated-rollback",
      icon: "chrome://browser/skin/zen-icons/security-broken.svg",
    });
    return createSidebarNotification({
      headingL10nId: notice.rolled_back ? "whimsy-rolled-back-heading" : "whimsy-updated-heading",
      autoHideMs: 15000,
      links,
    });
  },
};
