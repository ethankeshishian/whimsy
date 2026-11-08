/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// W23: the parent side of WhimsyAIContext. The child never asks for
// anything; WhimsyAIContext.extract() and withMask() send to it.
export class WhimsyAIContextParent extends JSWindowActorParent {}
