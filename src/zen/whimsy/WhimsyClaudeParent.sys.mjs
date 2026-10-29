/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// The browser half of WhimsyClaudeChild. WhimsyClaude.sys.mjs sends it
// queries; it accepts nothing from the page.

export class WhimsyClaudeParent extends JSWindowActorParent {
  receiveMessage() {
    return null;
  }
}
