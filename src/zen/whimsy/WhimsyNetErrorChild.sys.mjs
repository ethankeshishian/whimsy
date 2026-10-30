/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Adds a small "Play while you wait" button to Firefox's own net-error page
// (about:neterror, e.g. when you're offline), linking to Whimsy's own
// Balloon-Fight-style canvas game at whimsy://game. Registered as its own
// JS window actor (WhimsyNetErrorChild/Parent, matches "about:neterror?*")
// instead of patching aboutNetError.* - an overlay, not an engine change.
// The page is a different document with its own Fluent bundle
// (toolkit/neterror/netError.ftl), so the button's text is plain English
// rather than pulled from whimsy.ftl, to avoid reaching across bundles.
// whimsy.feature.game (checked on every load, so turning it off just stops
// adding the button; an already-open error page is left alone).

const FEATURE_PREF = "whimsy.feature.game";
const LINK_ID = "whimsy-neterror-game-link";

export class WhimsyNetErrorChild extends JSWindowActorChild {
  handleEvent(event) {
    if (event.type != "DOMContentLoaded" || !Services.prefs.getBoolPref(FEATURE_PREF, true)) {
      return;
    }
    const doc = this.document;
    if (!doc || doc.getElementById(LINK_ID)) {
      return;
    }
    const button = doc.createElement("button");
    button.id = LINK_ID;
    button.type = "button";
    button.textContent = "🎈 Play while you wait";
    button.addEventListener("click", () => this.sendAsyncMessage("WhimsyNetError:PlayGame"));
    const style = doc.createElement("style");
    style.textContent = `
      #${LINK_ID} {
        position: fixed;
        left: 50%;
        bottom: 32px;
        transform: translateX(-50%);
        z-index: 2147483647;
        padding: 10px 18px;
        border: none;
        border-radius: 999px;
        font: inherit;
        font-weight: 600;
        font-size: 14px;
        color: #fff;
        background: linear-gradient(135deg, #7c5cff, #ff7cd4);
        box-shadow: 0 4px 16px rgba(0, 0, 0, 0.2);
        cursor: pointer;
      }
      #${LINK_ID}:hover { filter: brightness(1.08); }
      @media (prefers-reduced-motion: no-preference) {
        #${LINK_ID} { transition: transform 0.15s ease, filter 0.15s ease; }
        #${LINK_ID}:hover { transform: translateX(-50%) translateY(-1px); }
      }
    `;
    doc.head.append(style);
    doc.body.append(button);
  }
}
