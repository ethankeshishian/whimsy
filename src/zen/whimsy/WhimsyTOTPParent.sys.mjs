/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Verification codes, chrome side of the page actor (W28). The site and the
// profile always come from the frame's top-level browsing context, never
// from the page. The page learns only whether a field button belongs here,
// and, after a trusted click on it, the one code it fills.

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  WhimsyTOTP: "resource:///modules/whimsy/WhimsyTOTP.sys.mjs",
});

export class WhimsyTOTPParent extends JSWindowActorParent {
  get #where() {
    const top = this.browsingContext.top;
    if (!top || this.browsingContext.usePrivateBrowsing) {
      return null;
    }
    const site = lazy.WhimsyTOTP.siteOf(top.currentWindowGlobal?.documentURI ?? null);
    if (!site) {
      return null;
    }
    return { site, profileKey: lazy.WhimsyTOTP.profileKeyFor(top.originAttributes?.userContextId ?? 0) };
  }

  receiveMessage(message) {
    const T = lazy.WhimsyTOTP;
    if (!T.enabled) {
      return message.name == "WhimsyTOTP:HasCodes" ? false : undefined;
    }
    switch (message.name) {
      case "WhimsyTOTP:HasCodes": {
        const where = this.#where;
        return where ? T.hasCodes(where.site, where.profileKey) : false;
      }
      case "WhimsyTOTP:Pick": {
        const where = this.#where;
        const win = this.browsingContext.topChromeWindow;
        if (!where || !win) {
          return undefined;
        }
        const rect = message.data?.screenRect;
        const screenRect = ["left", "top", "width", "height"].every(k => Number.isFinite(rect?.[k]))
          ? { left: rect.left, top: rect.top, width: rect.width, height: rect.height }
          : null;
        T.pick(win, { ...where, screenRect }, code => this.sendQuery("WhimsyTOTP:Fill", { code })).catch(e =>
          console.error("Whimsy: verification codes", e?.name ?? "error")
        );
        return undefined;
      }
      case "WhimsyTOTP:QR": {
        const uri = message.data?.uri;
        if (typeof uri == "string") {
          T.onSetupCode(this.browsingContext, uri);
        }
        return undefined;
      }
    }
    return undefined;
  }
}
