/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Keep Gecko's recovery actions, diagnostics and certificate warnings intact.
// AboutNetErrorLoad also covers the asynchronous felt-privacy card render.
const BASE = "chrome://browser/content/whimsy/";
const STYLE_ID = "whimsy-neterror-style";
const LINK_ID = "whimsy-neterror-game-link";

export class WhimsyNetErrorChild extends JSWindowActorChild {
  handleEvent(event) {
    if (!["DOMContentLoaded", "AboutNetErrorLoad"].includes(event.type)) {
      return;
    }
    const doc = this.document;
    if (!doc?.body) {
      return;
    }
    if (Services.prefs.getBoolPref("whimsy.feature.net-error-branding", true)) {
      this.addStyle(doc.head);
      const card = doc.querySelector("net-error-card");
      // The stylesheet must live inside Lit's shadow tree as well.
      if (card?.shadowRoot) {
        this.addStyle(card.shadowRoot);
      }
      const container = card?.shadowRoot?.querySelector(".container") ||
        doc.querySelector("#text-container");
      if (container && !container.querySelector("#whimsy-neterror-brand")) {
        const brand = doc.createElement("p");
        brand.id = "whimsy-neterror-brand";
        doc.l10n.setAttributes(brand, "whimsy-neterror-brand");
        container.prepend(brand);
      }
    }
    // Never distract from a certificate warning with a game invitation.
    if (doc.documentURI.startsWith("about:neterror?") &&
        Services.prefs.getBoolPref("whimsy.feature.game", true) &&
        !doc.getElementById(LINK_ID)) {
      this.addStyle(doc.head);
      const button = doc.createElement("button");
      button.id = LINK_ID;
      button.type = "button";
      doc.l10n.setAttributes(button, "whimsy-neterror-play");
      button.addEventListener("click", () => this.sendAsyncMessage("WhimsyNetError:PlayGame"));
      doc.body.append(button);
    }
  }

  addStyle(root) {
    if (root.querySelector(`#${STYLE_ID}`)) {
      return;
    }
    const link = this.document.createElement("link");
    link.id = STYLE_ID;
    link.rel = "stylesheet";
    link.href = `${BASE}whimsy-neterror.css`;
    root.append(link);
  }
}
