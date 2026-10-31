/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// wave9/pagedev: parent side of the page developer actor. The parent
// only asks (sendQuery from WhimsyPageDev); the child never pushes data.

export class WhimsyPageDevParent extends JSWindowActorParent {
  receiveMessage() {
    return null;
  }
}
