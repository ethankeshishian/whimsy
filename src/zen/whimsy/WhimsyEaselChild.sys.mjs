/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// wave7: "Add Page to Easel" asks the page for its size; the parent draws
// the page. (Add to Easel for a screenshot is in the screenshot viewer,
// W15; the region toolbar is WhimsyCaptureChild's.)

export class WhimsyEaselChild extends JSWindowActorChild {
  receiveMessage(message) {
    if (message.name != "WhimsyEasel:PageBounds") {
      return null;
    }
    const win = this.contentWindow;
    const doc = this.document;
    if (!win || !doc?.documentElement) {
      return null;
    }
    return {
      width: Math.max(doc.documentElement.scrollWidth, doc.documentElement.clientWidth),
      height: Math.max(doc.documentElement.scrollHeight, doc.documentElement.clientHeight),
      viewportWidth: doc.documentElement.clientWidth,
      viewportHeight: doc.documentElement.clientHeight,
      devicePixelRatio: win.devicePixelRatio,
    };
  }
}
