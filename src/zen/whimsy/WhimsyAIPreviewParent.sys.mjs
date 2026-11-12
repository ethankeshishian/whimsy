/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// W25 hover cards: the window side of a link's hover (WhimsyAIPreviewChild
// reports it; WhimsyLinkHover shows the card). Also answers the AI summary's
// PDF text-recognition stand-in for tests.

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  WhimsyAIPage: "resource:///modules/whimsy/WhimsyAIPage.sys.mjs",
  WhimsyLinkHover: "resource:///modules/whimsy/WhimsyLinkHover.sys.mjs",
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
      lazy.WhimsyLinkHover.forWindow(win).enter({ ...data, source: "link", how: "hover", browser });
    } else if (name == "WhimsyAIPreview:Leave") {
      lazy.WhimsyLinkHover.forWindow(win).leave(null, data?.url);
    }
    return undefined;
  }
}
