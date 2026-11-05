/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// wave5: Easel. The parent only asks its page for sizes (Add Page to
// Easel); the page never sends anything of its own.

export class WhimsyEaselParent extends JSWindowActorParent {
  receiveMessage() {
    return null;
  }
}
