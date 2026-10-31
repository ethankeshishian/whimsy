/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Link lasso, the browser side: tracks selected links from the page
// and delegates to WhimsyLinkLasso to open tabs or create a folder.

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  WhimsyLinkLasso: "resource:///modules/whimsy/WhimsyLinkLasso.sys.mjs",
});

export class WhimsyLassoParent extends JSWindowActorParent {
  receiveMessage(message) {
    const browser = this.browsingContext?.top?.embedderElement;
    const win = browser?.documentGlobal;
    if (!win?.gBrowser) {
      return undefined;
    }

    if (message.name == "WhimsyLasso:Dismissed") {
      lazy.WhimsyLinkLasso.clearSelected(win, browser);
      return undefined;
    }

    // Only plain web links, and only as many as a folder/window should hold.
    const links = (message.data?.links ?? [])
      .filter(link => typeof link?.url == "string" && /^https?:\/\//i.test(link.url))
      .map(link => ({ url: link.url, title: String(link.title ?? "").slice(0, 200) }));
    const pageTitle = String(message.data?.pageTitle ?? "").slice(0, 200);
    const pageURL = String(message.data?.pageURL ?? "");

    switch (message.name) {
      case "WhimsyLasso:Selected":
        lazy.WhimsyLinkLasso.setSelected(win, browser, {
          links,
          pageTitle,
          pageURL,
        });
        return { canMakeFolder: !lazy.WhimsyLinkLasso.isPrivate(win, browser) };
      case "WhimsyLasso:OpenTabs":
        lazy.WhimsyLinkLasso.openTabs(win, browser, {
          links,
          pageTitle,
          pageURL,
        });
        break;
      case "WhimsyLasso:MakeFolder":
      case "WhimsyLasso:Create":
        lazy.WhimsyLinkLasso.createFolder(win, browser, {
          links,
          pageTitle,
          pageURL,
        });
        break;
    }
    return undefined;
  }
}
