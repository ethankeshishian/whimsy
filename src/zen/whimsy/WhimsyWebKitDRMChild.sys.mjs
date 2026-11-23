/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// W30 drm-webkit: Gecko notifies "mediakeys-request" (MediaKeys.h) whenever a
// page asks for a key system, the same notice Firefox's EncryptedMediaChild
// listens to. This actor listens alongside it, and only for Widevine tells
// the parent, which switches the tab to WebKit (WhimsyWebKitDRM.sys.mjs).
// Firefox's own handling of the notice is untouched.

// com.widevine.alpha and its variants (.experiment, .experiment2, ...).
const WIDEVINE = /^com\.widevine\.alpha(\.|$)/;

export class WhimsyWebKitDRMChild extends JSWindowActorChild {
  observe(_subject, topic, data) {
    if (topic != "mediakeys-request" || this._sent) {
      return;
    }
    let parsed;
    try {
      parsed = JSON.parse(data);
    } catch {
      return;
    }
    const keySystem = String(parsed?.keySystem ?? "");
    const status = String(parsed?.status ?? "");
    // is-capture-possible is a screen-capture probe, not a request.
    if (!WIDEVINE.test(keySystem) || status == "is-capture-possible") {
      return;
    }
    // One message per document: the parent switches the whole tab.
    this._sent = true;
    this.sendAsyncMessage("WhimsyWebKitDRM:Widevine", { keySystem, status });
  }
}
