/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Parent half of WhimsyNetErrorChild: navigating a privileged page away from
// about:neterror needs chrome privilege, so the child only sends a message
// and this opens whimsy://game's real page (about:whimsy?game) in the
// current tab, the same way WhimsyProtocol.go() does for the address bar.

// B12: nsINetworkLinkService (and the "network:link-status-changed" topic
// it fires) only exists in the parent process; a reconnect reported as a
// bare "changed" - no clean down/up pair, e.g. the link itself never
// looked down, only the IP lease changed on reassociation - never flips
// nsIOService's own cached connectivity, so the window "online" event the
// game listens for never fires downstream. isLinkUp is queried live here
// instead of trusting that cached flag, and the result is pushed to content.
const NETWORK_LINK_TOPIC = "network:link-status-changed";

export class WhimsyNetErrorParent extends JSWindowActorParent {
  receiveMessage(message) {
    if (message.name == "WhimsyNetError:WatchConnectivity") {
      if (!this._linkObserver) {
        this._linkObserver = () => this.onNetworkLink();
        Services.obs.addObserver(this._linkObserver, NETWORK_LINK_TOPIC);
      }
      return;
    }
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

  onNetworkLink() {
    let isUp;
    try {
      isUp = Cc["@mozilla.org/network/network-link-service;1"]
        .getService(Ci.nsINetworkLinkService).isLinkUp;
    } catch {
      return;
    }
    if (isUp) {
      try {
        this.sendAsyncMessage("WhimsyNetError:BackOnline");
      } catch {
        // The content side may already be gone.
      }
    }
  }

  didDestroy() {
    if (this._linkObserver) {
      Services.obs.removeObserver(this._linkObserver, NETWORK_LINK_TOPIC);
      this._linkObserver = null;
    }
  }
}
