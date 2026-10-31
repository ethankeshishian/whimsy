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
        // Only the href comes from the content process. The principal is
        // the one the parent holds for the page, and the parent itself
        // checks the page may load the link (security M4): a compromised
        // renderer can't open privileged URLs as the system.
        const href = message.data?.href;
        const triggeringPrincipal = this.manager?.documentPrincipal;
        if (typeof href != "string" || !triggeringPrincipal?.isContentPrincipal) {
          return null;
        }
        try {
          if (["javascript", "data"].includes(Services.io.extractScheme(href))) {
            return null;
          }
          Services.scriptSecurityManager.checkLoadURIStrWithPrincipal(
            triggeringPrincipal,
            href,
            Ci.nsIScriptSecurityManager.DISALLOW_INHERIT_PRINCIPAL
          );
        } catch (e) {
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
