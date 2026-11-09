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
    // Asked for the tab being summarized, which a summary in the background
    // (its owning tab not the one on screen) keeps reading. Not gated on
    // the selected tab below, unlike the hover-preview messages.
    if (name == "WhimsyAIPreview:RecognizeText") {
      // Tests: a stand-in for the real (slow, platform) OCR call, asked
      // before the child does it for real. null means "no stand-in, do it".
      const fn = lazy.WhimsyAIPage._testOcrRecognizer;
      return { text: fn ? String(fn(data?.page) ?? "") : null };
    }
    const browser = this.browsingContext.top.embedderElement;
    const win = browser?.ownerDocument.defaultView;
    if (!win?.gBrowser || win.closed) {
      return undefined;
    }
    // Only the tab you're looking at.
    if (browser != win.gBrowser.selectedBrowser) {
      return undefined;
    }
    if (name == "WhimsyAIPreview:Show") {
      lazy.WhimsyAIPage.showPreview(win, browser, data).catch(error =>
        console.error("Whimsy: link preview", error)
      );
    } else if (name == "WhimsyAIPreview:Leave") {
      lazy.WhimsyAIPage.leavePreview(win, data?.url);
    }
    return undefined;
  }
}
