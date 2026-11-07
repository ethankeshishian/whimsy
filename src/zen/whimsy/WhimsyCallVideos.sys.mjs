/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Shared by the page and PiP actors in each content process. Call tiles
// can temporarily have no source while the microphone keeps the call going.
export const callVideos = new WeakSet();
