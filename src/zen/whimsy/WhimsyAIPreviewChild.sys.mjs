/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// AI v1: 5-second previews (Arc Max), the page side. Shift while pointing at
// a link asks for a preview; on the sites Arc named (search results, X,
// Threads, Hacker News), resting on a link to another site is enough. The
// parent (WhimsyAIPage) checks the switches again, fetches and draws.

const PREF = "whimsy.feature.link-previews";
const BLOCKED_PREF = "whimsy.ai.blocked";
// wave7/ux: the link card (where a link goes) shows on the same triggers,
// with or without AI. The parent's hover host waits its one delay, so this
// side reports a hover right away.
const LINK_CARDS_PREF = "whimsy.feature.link-cards";
// Arc: "Google, DuckDuckGo, Bing, X, Threads and Hacker News".
const HOVER_SITES =
  /(^|\.)(google\.[a-z.]+|duckduckgo\.com|bing\.com|x\.com|twitter\.com|threads\.net|threads\.com|news\.ycombinator\.com)$/i;

export class WhimsyAIPreviewChild extends JSWindowActorChild {
  link = null;

  get enabled() {
    return (
      Services.prefs.getBoolPref(LINK_CARDS_PREF, true) ||
      (Services.prefs.getBoolPref(PREF, true) && !Services.prefs.getBoolPref(BLOCKED_PREF, false))
    );
  }

  handleEvent(event) {
    switch (event.type) {
      case "mouseover":
        this.onOver(event);
        break;
      case "mouseout":
        if (this.link && !this.link.contains(event.relatedTarget)) {
          this.leave();
        }
        break;
      case "keydown":
        if (event.key == "Shift" && !event.repeat && this.link) {
          this.show("shift");
        }
        break;
      case "pagehide":
        this.leave();
        break;
    }
  }

  onOver(event) {
    const link = event.target?.closest?.("a[href]");
    if (link == this.link) {
      return;
    }
    if (this.link) {
      this.leave();
    }
    if (!link || !/^https?:/i.test(link.href) || !this.enabled) {
      return;
    }
    this.link = link;
    if (event.shiftKey) {
      this.show("shift");
    } else if (this.isHoverSite() && this.isOutbound(link)) {
      this.show("hover");
    }
  }

  isHoverSite() {
    try {
      return HOVER_SITES.test(this.document.location.hostname);
    } catch {
      return false;
    }
  }

  // Result links, not the site's own navigation.
  isOutbound(link) {
    try {
      const here = this.document.location.hostname.replace(/^www\./, "");
      const there = new URL(link.href).hostname.replace(/^www\./, "");
      return there != here && !there.endsWith(`.${here}`) && !here.endsWith(`.${there}`);
    } catch {
      return false;
    }
  }

  show(how) {
    const link = this.link;
    const win = this.contentWindow;
    if (!link?.isConnected || !win) {
      return;
    }
    const rect = link.getBoundingClientRect();
    this.shown = true;
    this.sendAsyncMessage("WhimsyAIPreview:Show", {
      url: link.href,
      how,
      title: (link.title || link.textContent || "").replace(/\s+/g, " ").trim().slice(0, 200),
      x: win.mozInnerScreenX + rect.left,
      y: win.mozInnerScreenY + rect.top,
      width: rect.width,
      height: rect.height,
    });
  }

  leave() {
    const link = this.link;
    this.link = null;
    if (link && this.shown) {
      this.shown = false;
      this.sendAsyncMessage("WhimsyAIPreview:Leave", { url: link.href });
    }
  }
}
