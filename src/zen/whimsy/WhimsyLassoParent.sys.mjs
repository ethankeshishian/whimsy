/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Link lasso, the browser side: the page sends the links it lassoed and
// WhimsyLinkLasso turns them into a folder.

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  WhimsyLinkLasso: "resource:///modules/whimsy/WhimsyLinkLasso.sys.mjs",
});

export class WhimsyLassoParent extends JSWindowActorParent {
  receiveMessage(message) {
    if (message.name != "WhimsyLasso:Create") {
      return;
    }
    const browser = this.browsingContext.top.embedderElement;
    const win = browser?.documentGlobal;
    if (!win?.gBrowser) {
      return;
    }
    // Only plain web links, and only as many as a folder should hold.
    const links = (message.data?.links ?? [])
      .filter(link => typeof link?.url == "string" && /^https?:\/\//i.test(link.url))
      .map(link => ({ url: link.url, title: String(link.title ?? "").slice(0, 200) }));
    lazy.WhimsyLinkLasso.createFolder(win, browser, {
      links,
      pageTitle: String(message.data?.pageTitle ?? "").slice(0, 200),
      pageURL: String(message.data?.pageURL ?? ""),
    });
  }
}
