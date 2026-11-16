/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// W29 vpncalls: a call on this page couldn't connect (its ICE failed;
// whimsy-PeerConnection-sys-mjs.patch notifies). The parent decides whether
// the VPN is why and offers to pause it; the child sends nothing else.
export class WhimsyVPNCallChild extends JSWindowActorChild {
  observe(subject, topic) {
    if (topic == "whimsy-peerconnection-ice-failed") {
      this.sendAsyncMessage("WhimsyVPNCall:IceFailed");
    }
  }
}
