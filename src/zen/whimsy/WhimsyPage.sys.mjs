/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Page tools: things you do to the page you're on.
//
// Capture (Arc's Capture, Edge's Web Capture): Firefox Screenshots is the
// capture tool (drag a region, click an element, or Visible / Full Page,
// then Copy or Download). Whimsy adds Arc's Cmd+Shift+2 for it, and a
// one-step "Copy Full-Page Screenshot" (Cmd+Opt+Shift+F and the command
// bar) that drops the whole page on the clipboard with no editor between.

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  BrowserUtils: "resource://gre/modules/BrowserUtils.sys.mjs",
  ScreenshotsUtils: "moz-src:///browser/components/screenshots/ScreenshotsUtils.sys.mjs",
  WhimsyShortcuts: "resource:///modules/whimsy/WhimsyShortcuts.sys.mjs",
});

const CAPTURE_FEATURE_PREF = "whimsy.feature.capture";

function isWebPage(win) {
  const tab = win.gBrowser.selectedTab;
  const uri = tab.linkedBrowser?.currentURI;
  return !!tab.linkedPanel && !tab.hasAttribute("zen-empty-tab") && !!uri && !uri.spec.startsWith("about:blank");
}

export const WhimsyPage = {
  get captureEnabled() {
    return Services.prefs.getBoolPref(CAPTURE_FEATURE_PREF, true);
  },

  initWindow(win) {
    this.initCapture(win);
  },

  // --- Capture ---

  initCapture(win) {
    if (!this.captureEnabled) {
      return;
    }
    const { WhimsyShortcuts } = lazy;
    // Arc's capture shortcut, beside Firefox's Cmd+Shift+S.
    WhimsyShortcuts.addKey(win, {
      id: "key_whimsyScreenshotArc",
      command: "Browser:Screenshot",
      key: "2",
      modifiers: "accel,shift",
    });
    WhimsyShortcuts.addCommand(win, {
      id: "cmd_whimsyCopyFullPage",
      run: w => this.copyFullPageScreenshot(w),
      key: { id: "key_whimsyCopyFullPage", key: "F", modifiers: "accel,alt,shift" },
    });
    WhimsyShortcuts.addActions([
      {
        l10nId: "whimsy-action-copy-full-page",
        command: "cmd_whimsyCopyFullPage",
        icon: "chrome://browser/skin/zen-icons/screenshot.svg",
        isAvailable: w => this.captureEnabled && isWebPage(w),
      },
    ]);
  },

  // Copies the whole page as a PNG (Screenshots draws it). Returns the image's size in CSS pixels,
  // or null when the page can't be captured.
  async copyFullPageScreenshot(win, browser = win.gBrowser.selectedBrowser) {
    if (!this.captureEnabled || !isWebPage(win)) {
      return null;
    }
    const { ScreenshotsUtils, BrowserUtils } = lazy;
    let rect;
    try {
      rect = await browser.browsingContext.currentWindowGlobal.getActor("WhimsyPage").sendQuery("Whimsy:PageBounds");
    } catch (e) {
      console.error("Whimsy: full-page capture", e);
      win.gZenUIManager?.showToast?.("whimsy-capture-failed-toast");
      return null;
    }
    const canvas = await ScreenshotsUtils.createCanvas(rect, browser);
    const blob = await canvas.convertToBlob();
    BrowserUtils.copyImageToClipboard(await blob.arrayBuffer());
    win.gZenUIManager?.showToast?.("whimsy-capture-copied-toast");
    const ratio = rect.devicePixelRatio || 1;
    return { width: canvas.width / ratio, height: canvas.height / ratio };
  },
};
