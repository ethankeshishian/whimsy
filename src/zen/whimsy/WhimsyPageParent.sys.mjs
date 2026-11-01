/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// The parent side of Whimsy's page tools. Registered once per session by
// Whimsy.registerActors; the child is created when a page first needs it.

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  WhimsyFollowerTabs: "resource:///modules/whimsy/WhimsyFollowerTabs.sys.mjs",
  WhimsyMedia: "resource:///modules/whimsy/WhimsyMedia.sys.mjs",
  WhimsyPage: "resource:///modules/whimsy/WhimsyPage.sys.mjs",
  // batch6
  WhimsySplit: "resource:///modules/whimsy/WhimsySplit.sys.mjs",
  WhimsyZap: "resource:///modules/whimsy/WhimsyZap.sys.mjs",
});

export class WhimsyPageParent extends JSWindowActorParent {
  get tab() {
    const browser = this.browsingContext.top.embedderElement;
    // ownerGlobal isn't defined on elements seen from a module.
    return browser?.ownerDocument?.defaultView?.gBrowser?.getTabForBrowser(browser) ?? null;
  }

  // wave9/secfix (security-full-1 M5): only the URL comes from content. The
  // principal is the one the parent holds for the page (content or, for a
  // sandboxed page, null; never system), and the parent itself checks the
  // page may load the link, as Link Hints does: a compromised renderer
  // can't open privileged URLs as the system.
  pagePrincipal(href) {
    const principal = this.manager?.documentPrincipal;
    if (typeof href != "string" || !principal || !(principal.isContentPrincipal || principal.isNullPrincipal)) {
      return null;
    }
    try {
      if (["javascript", "data"].includes(Services.io.extractScheme(href))) {
        return null;
      }
      Services.scriptSecurityManager.checkLoadURIStrWithPrincipal(
        principal,
        href,
        Ci.nsIScriptSecurityManager.DISALLOW_INHERIT_PRINCIPAL
      );
    } catch (e) {
      return null;
    }
    return principal;
  }

  receiveMessage(message) {
    switch (message.name) {
      case "Whimsy:VolumeLevel":
        return lazy.WhimsyMedia.volumeFor(this.tab);
      case "Whimsy:EditingEnded": {
        const browser = this.browsingContext.top.embedderElement;
        if (browser) {
          lazy.WhimsyPage.onEditingEnded(browser);
        }
        return null;
      }
      // batch6 #7
      case "Whimsy:SplitLink": {
        const tab = this.tab;
        const win = tab?.ownerDocument?.defaultView;
        const href = message.data?.href;
        const triggeringPrincipal = this.pagePrincipal(href);
        if (win && triggeringPrincipal) {
          lazy.WhimsySplit.openLinkInSplit(win, tab, href, triggeringPrincipal);
        }
        return null;
      }
      case "Whimsy:FollowLink": {
        if (this.tab) {
          lazy.WhimsyFollowerTabs.onLinkFollowed(this.tab, message.data.url);
        }
        return null;
      }
      // wave9/menus: read by the page menu's Allow Copy and Paste row.
      case "Whimsy:CopyBlocked": {
        const browser = this.browsingContext.top.embedderElement;
        if (browser) {
          browser._whimsyCopyBlocked = !!message.data?.blocked;
        }
        return null;
      }
      case "Whimsy:ZapExit": {
        const browser = this.browsingContext.top.embedderElement;
        const win = browser?.ownerDocument?.defaultView;
        if (win) {
          lazy.WhimsyZap.cancelSession(win, browser);
        }
        return null;
      }
      case "Whimsy:ZapAccept": {
        const browser = this.browsingContext.top.embedderElement;
        const win = browser?.ownerDocument?.defaultView;
        if (win) {
          lazy.WhimsyZap.acceptSession(win, browser);
        }
        return null;
      }
    }
    return null;
  }
}
