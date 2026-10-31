/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// wave5: Easel. The page side reports "Add to Easel" clicks in Firefox
// Screenshots' region toolbar; everything else (the capture itself, the
// easel picker, storage) happens here in the parent, which takes the
// screenshot of the region itself rather than trusting page pixels.

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  WhimsyEasel: "resource:///modules/whimsy/WhimsyEasel.sys.mjs",
});

export class WhimsyEaselParent extends JSWindowActorParent {
  receiveMessage(message) {
    if (message.name != "WhimsyEasel:AddCapture") {
      return null;
    }
    const browser = this.browsingContext.top.embedderElement;
    if (!browser || this.browsingContext != this.browsingContext.top) {
      return null;
    }
    const { anchor, ...data } = message.data ?? {};
    lazy.WhimsyEasel.onCaptureRequest(browser, data, anchor).catch(e => console.error("Whimsy: add to easel", e));
    return null;
  }
}
