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
  // batch-ai: 5-second hover preview
  WhimsyAIPage: "resource:///modules/whimsy/WhimsyAIPage.sys.mjs",
});

export class WhimsyPageParent extends JSWindowActorParent {
  get tab() {
    const browser = this.browsingContext.top.embedderElement;
    // ownerGlobal isn't defined on elements seen from a module.
    return browser?.ownerDocument?.defaultView?.gBrowser?.getTabForBrowser(browser) ?? null;
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
        if (win) {
          lazy.WhimsySplit.openLinkInSplit(win, tab, message.data.href, message.data.triggeringPrincipal);
        }
        return null;
      }
      case "Whimsy:FollowLink": {
        if (this.tab) {
          lazy.WhimsyFollowerTabs.onLinkFollowed(this.tab, message.data.url);
        }
        return null;
      }
      // batch-ai: 5-second hover preview
      case "Whimsy:AIHoverLink": {
        const browser = this.browsingContext.top.embedderElement;
        const win = browser?.ownerGlobal;
        if (win) {
          lazy.WhimsyAIPage.onLinkHover(win, browser, message.data);
        }
        return null;
      }
      case "Whimsy:AILeaveLink": {
        const browser = this.browsingContext.top.embedderElement;
        const win = browser?.ownerGlobal;
        if (win) {
          lazy.WhimsyAIPage.onLinkLeave(win, browser);
        }
        return null;
      }
    }
    return null;
  }
}
