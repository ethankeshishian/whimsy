/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// W15 screenshots: the page side reports a press on Capture in Firefox
// Screenshots' region toolbar; the parent draws the region itself and
// opens the viewer.

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  WhimsyCaptureCard: "resource:///modules/whimsy/WhimsyCaptureCard.sys.mjs",
});

export class WhimsyCaptureParent extends JSWindowActorParent {
  receiveMessage(message) {
    if (message.name != "WhimsyCapture:Confirm") {
      return null;
    }
    const browser = this.browsingContext.top.embedderElement;
    if (!browser || this.browsingContext != this.browsingContext.top) {
      return null;
    }
    lazy.WhimsyCaptureCard.confirmRegion(browser, message.data?.region)
      .catch(e => console.error("Whimsy: capture", e));
    return null;
  }
}
