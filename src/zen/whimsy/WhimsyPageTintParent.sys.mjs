/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { WhimsyPageTint } from "resource:///modules/whimsy/WhimsyPageTint.sys.mjs";

export class WhimsyPageTintParent extends JSWindowActorParent {
  receiveMessage({ name, data }) {
    // Frames cannot report a colour for the tab.
    if (name != "WhimsyPageTint:ThemeColor" || this.browsingContext != this.browsingContext.top) {
      return;
    }
    const browser = this.browsingContext.top.embedderElement;
    if (browser && this.manager == this.browsingContext.currentWindowGlobal) {
      WhimsyPageTint.onThemeColor(browser, data.color);
    }
  }
}
