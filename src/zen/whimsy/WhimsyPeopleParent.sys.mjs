/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// People cards: shows the shared hover card for a hovered profile link in
// the selected tab. See WhimsyPeople.sys.mjs.

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  WhimsyLinkHover: "resource:///modules/whimsy/WhimsyLinkHover.sys.mjs",
  WhimsyPeople: "resource:///modules/whimsy/WhimsyPeople.sys.mjs",
});


export class WhimsyPeopleParent extends JSWindowActorParent {
  get #browser() {
    return this.browsingContext.top.embedderElement;
  }

  receiveMessage({ name, data }) {
    const browser = this.#browser;
    const win = browser?.documentGlobal;
    if (!win?.gBrowser || win.gBrowser.selectedBrowser != browser) {
      return;
    }
    // wave7/ux: People cards are the first card of the link hover host
    // (WhimsyLinkHover), which owns the delay, the lookup and placement, and
    // stacks the AI summary beneath when that's on.
    const host = lazy.WhimsyLinkHover.forWindow(win);
    if (name == "Whimsy:PersonLeave") {
      host.leave(browser);
      return;
    }
    const { originAttributes } = this.manager.documentPrincipal;
    const url = lazy.WhimsyPeople.profile(data?.url);
    if (!url || originAttributes.privateBrowsingId || !lazy.WhimsyPeople.enabled) {
      return;
    }
    const point = { x: Number(data.x) || 0, y: Number(data.y) || 0 };
    const rect = data.rect ?? { x: point.x - 1, y: point.y - 8, width: 2, height: 16 };
    host.enter({
      source: "people",
      browser,
      url: data.url,
      how: "hover",
      ...rect,
      userContextId: originAttributes.userContextId || 0,
    });
  }

  didDestroy() {
    let browser;
    try {
      browser = this.#browser;
    } catch {
      return; // The browsing context is already gone.
    }
    if (browser?.documentGlobal?.gBrowser) {
      lazy.WhimsyLinkHover.forWindow(browser.documentGlobal).leave(browser);
    }
  }
}
