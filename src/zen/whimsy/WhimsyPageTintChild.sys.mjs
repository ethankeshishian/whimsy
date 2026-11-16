/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// W29: Match the page. Reads <meta name="theme-color"> from the top
// document, honouring each tag's media attribute for light/dark, and
// reports the winning colour (or null) to the parent, WhimsyPageTint.
// The favicon fallback needs no actor: it runs in the parent from the
// tab's own icon.

export class WhimsyPageTintChild extends JSWindowActorChild {
  handleEvent(event) {
    if (event.type == "DOMMetaChanged" || event.type == "pageshow") {
      this.#report();
    }
  }

  #report() {
    const doc = this.document;
    if (!doc || doc.contentType != "text/html") {
      return;
    }
    const win = doc.defaultView;
    let color = null;
    for (const meta of doc.querySelectorAll('meta[name="theme-color"]')) {
      const content = meta.getAttribute("content");
      if (!content) {
        continue;
      }
      const media = meta.getAttribute("media");
      if (media && win && !win.matchMedia(media).matches) {
        // Doesn't apply to the scheme we're in right now; keep looking,
        // in case an earlier unqualified tag already matched.
        continue;
      }
      color = content;
      if (media) {
        // A media-qualified tag that matches wins outright.
        break;
      }
    }
    this.sendAsyncMessage("WhimsyPageTint:ThemeColor", { color });
  }
}
