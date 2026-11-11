/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { WhimsyDarkPages } from "resource:///modules/whimsy/WhimsyDarkPages.sys.mjs";

export class WhimsyDarkPagesParent extends JSWindowActorParent {
  receiveMessage({ name, data }) {
    // Frames cannot claim that the top page was converted or trigger UI.
    if (name != "Whimsy:DarkPagesState" || this.browsingContext != this.browsingContext.top) {
      return;
    }
    const browser = this.browsingContext.top.embedderElement;
    if (browser && this.manager == this.browsingContext.currentWindowGlobal) {
      WhimsyDarkPages.report(browser, data);
    }
  }
}
