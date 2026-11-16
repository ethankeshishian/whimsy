/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// W29 vpncalls: parent half of WhimsyVPNCallChild. The message carries no
// data; WhimsyVPN checks the tab itself (is the VPN carrying its page?).
const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  WhimsyVPN: "resource:///modules/whimsy/WhimsyVPN.sys.mjs",
});

export class WhimsyVPNCallParent extends JSWindowActorParent {
  receiveMessage(message) {
    if (message.name != "WhimsyVPNCall:IceFailed") {
      return;
    }
    const browser = this.browsingContext.top.embedderElement;
    try {
      lazy.WhimsyVPN.onCallFailed(browser);
    } catch (e) {
      console.error("Whimsy: VPN call failed", e);
    }
  }
}
