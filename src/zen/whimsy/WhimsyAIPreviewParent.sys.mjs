/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// AI v1: 5-second previews, the window side's entry point.

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  WhimsyAIPage: "resource:///modules/whimsy/WhimsyAIPage.sys.mjs",
});

export class WhimsyAIPreviewParent extends JSWindowActorParent {
  receiveMessage({ name, data }) {
    const browser = this.browsingContext.top.embedderElement;
    const win = browser?.ownerGlobal;
    if (!win?.gBrowser || win.closed) {
      return;
    }
    // Only the tab you're looking at.
    if (browser != win.gBrowser.selectedBrowser) {
      return;
    }
    if (name == "WhimsyAIPreview:Show") {
      lazy.WhimsyAIPage.showPreview(win, browser, data).catch(error =>
        console.error("Whimsy: link preview", error)
      );
    } else if (name == "WhimsyAIPreview:Leave") {
      lazy.WhimsyAIPage.leavePreview(win, data?.url);
    }
  }
}
