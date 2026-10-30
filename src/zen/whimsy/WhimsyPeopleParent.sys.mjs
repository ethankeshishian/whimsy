/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// People cards: shows the shared hover card for a hovered profile link in
// the selected tab. See WhimsyPeople.sys.mjs.

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  WhimsyHoverCard: "resource:///modules/whimsy/WhimsyHoverCard.sys.mjs",
  WhimsyPeople: "resource:///modules/whimsy/WhimsyPeople.sys.mjs",
});

const FEATURE_PREF = "whimsy.feature.people-cards";
const CARD_WIDTH = 320;
const CARD_HEIGHT = 200;

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
    const card = lazy.WhimsyHoverCard.forWindow(win);
    if (name == "Whimsy:PersonLeave") {
      card.leave(browser);
      return;
    }
    const { originAttributes } = this.manager.documentPrincipal;
    const url = lazy.WhimsyPeople.profile(data?.url);
    if (!url || originAttributes.privateBrowsingId || !lazy.WhimsyPeople.enabled) {
      return;
    }
    // Only the container matters for which session is used; the page's
    // own first-party/partition keys belong to the page, not the profile.
    const attributes = {
      userContextId: originAttributes.userContextId || 0,
      privateBrowsingId: 0,
    };
    const screen = {
      x: Math.max(win.screenX, Math.min(Number(data.x) || 0, win.screenX + win.outerWidth - CARD_WIDTH)),
      y: Math.max(win.screenY, Math.min((Number(data.y) || 0) + 16, win.screenY + win.outerHeight - CARD_HEIGHT)),
    };
    card.schedule(
      browser,
      async () => {
        const found = await lazy.WhimsyPeople.lookup(win, url, attributes);
        return {
          ...(found ?? lazy.WhimsyPeople.fallback(url)),
          avatar: true,
          screen,
        };
      },
      FEATURE_PREF
    );
  }

  didDestroy() {
    let browser;
    try {
      browser = this.#browser;
    } catch {
      return; // The browsing context is already gone.
    }
    if (browser?.documentGlobal?.gBrowser) {
      lazy.WhimsyHoverCard.forWindow(browser.documentGlobal).leave(browser);
    }
  }
}
