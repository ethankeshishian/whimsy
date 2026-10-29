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
      case "Whimsy:FollowLink": {
        if (this.tab) {
          lazy.WhimsyFollowerTabs.onLinkFollowed(this.tab, message.data.url);
        }
        return null;
      }
    }
    return null;
  }
}
