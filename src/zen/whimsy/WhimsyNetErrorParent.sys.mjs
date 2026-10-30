/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Parent half of WhimsyNetErrorChild: navigating a privileged page away from
// about:neterror needs chrome privilege, so the child only sends a message
// and this opens whimsy://game's real page (about:whimsy?game) in the
// current tab, the same way WhimsyProtocol.go() does for the address bar.

export class WhimsyNetErrorParent extends JSWindowActorParent {
  receiveMessage(message) {
    if (message.name != "WhimsyNetError:PlayGame") {
      return;
    }
    const browser = this.browsingContext.top.embedderElement;
    const win = browser?.ownerGlobal;
    win?.openTrustedLinkIn("about:whimsy?game", "current");
  }
}
