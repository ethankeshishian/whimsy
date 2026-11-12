/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// W24: a top-level page that labels itself as adult (<meta name="rating"
// content="adult"> or the RTA label) tells the parent, which takes its
// visit back out of history (WhimsyAdultHistory.sys.mjs). Only the fact
// crosses over; the parent uses its own record of the address.

const LABELS = new Set(["adult", "rta-5042-1996-1400-1577-rta"]);

export class WhimsyAdultHistoryChild extends JSWindowActorChild {
  handleEvent(event) {
    const doc = this.document;
    if (this._sent || event.target != doc || this.browsingContext.parent) {
      return;
    }
    if (!Services.prefs.getBoolPref("whimsy.feature.adult-history", true) ||
        !Services.prefs.getBoolPref("whimsy.adult-history.enabled", true)) {
      return;
    }
    const labelled = [...doc.querySelectorAll('meta[name="rating" i], meta[http-equiv="rating" i]')]
      .some(meta => LABELS.has(String(meta.content ?? "").trim().toLowerCase()));
    if (labelled) {
      this._sent = true;
      this.sendAsyncMessage("Labelled");
    }
  }
}
