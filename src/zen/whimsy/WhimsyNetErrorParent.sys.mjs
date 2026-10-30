/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Parent half of WhimsyNetErrorChild: navigating a privileged page away from
// about:neterror needs chrome privilege, so the child only sends a message
// and this opens whimsy://game's real page (about:whimsy?game) in the
// current tab, the same way WhimsyProtocol.go() does for the address bar.

export class WhimsyNetErrorParent extends JSWindowActorParent {
  receiveMessage(message) {
    // The game, embedded in the offline error page, saves its high score,
    // look and sound choice through here (content can't write prefs).
    if (message.name == "WhimsyNetError:SetPref" && this.manager.documentURI.spec.startsWith("about:neterror?")) {
      const { name, value } = message.data ?? {};
      if (name == "whimsy.game.high-score" && Number.isInteger(value) && value >= 0) {
        Services.prefs.setIntPref(name, Math.max(value, Services.prefs.getIntPref(name, 0)));
      } else if (name == "whimsy.game.style" && ["retro", "gradient"].includes(value)) {
        Services.prefs.setStringPref(name, value);
      } else if (name == "whimsy.game.chiptune" && typeof value == "boolean") {
        Services.prefs.setBoolPref(name, value);
      }
      return;
    }
    if (message.name != "WhimsyNetError:PlayGame" ||
        !Services.prefs.getBoolPref("whimsy.feature.game", true) ||
        !this.manager.documentURI.spec.startsWith("about:neterror?")) {
      return;
    }
    const browser = this.browsingContext.top.embedderElement;
    const win = browser?.documentGlobal;
    win?.openTrustedLinkIn("about:whimsy?game", "current");
  }
}
