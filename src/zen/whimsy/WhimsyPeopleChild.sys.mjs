/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// People cards: tells the parent when the pointer enters or leaves a link
// to one of the profile sites. Every other link stays silent, so ordinary
// browsing sends no messages. The parent decides whether it's a profile.

const HOSTS = /^(?:www\.|mobile\.)?(?:github\.com|linkedin\.com|x\.com|twitter\.com)$/i;

export class WhimsyPeopleChild extends JSWindowActorChild {
  handleEvent(event) {
    const link = event.target.closest?.("a[href]");
    if (!link || link.contains(event.relatedTarget)) {
      return;
    }
    let url;
    try {
      url = new URL(link.href);
    } catch {
      return;
    }
    if (url.protocol != "https:" || !HOSTS.test(url.hostname)) {
      return;
    }
    if (event.type == "mouseover") {
      // wave7/ux: the link's own box too, so the hover host can place its
      // cards beside the link without covering it.
      const win = this.contentWindow;
      const rect = link.getBoundingClientRect();
      this.sendAsyncMessage("Whimsy:PersonHover", {
        url: url.href,
        x: event.screenX,
        y: event.screenY,
        rect: win && {
          x: win.mozInnerScreenX + rect.left,
          y: win.mozInnerScreenY + rect.top,
          width: rect.width,
          height: rect.height,
        },
      });
    } else {
      this.sendAsyncMessage("Whimsy:PersonLeave");
    }
  }
}
