/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// wave6/zap: Link hints, the parent side: opens a hinted link in a new tab
// (with the page's own principal) and announces hint mode to screen readers.

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  WhimsyLinkHints: "resource:///modules/whimsy/WhimsyLinkHints.sys.mjs",
});

export class WhimsyLinkHintsParent extends JSWindowActorParent {
  get browser() {
    return this.browsingContext.top.embedderElement;
  }

  get window() {
    return this.browser?.ownerDocument?.defaultView ?? null;
  }

  receiveMessage(message) {
    const win = this.window;
    if (!win) {
      return null;
    }
    switch (message.name) {
      case "Whimsy:Hints:OpenTab": {
        const { href, triggeringPrincipal } = message.data ?? {};
        if (typeof href != "string" || !triggeringPrincipal) {
          return null;
        }
        win.openLinkIn(href, "tab", {
          triggeringPrincipal,
          relatedToCurrent: true,
          inBackground: false,
        });
        return null;
      }
      case "Whimsy:Hints:State":
        lazy.WhimsyLinkHints.onState(win, this.browser, message.data ?? {});
        return null;
    }
    return null;
  }
}
