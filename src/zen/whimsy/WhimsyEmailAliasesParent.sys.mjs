/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Email aliases, chrome side: the menu that the mask button in an email
// field opens. It lives in the browser window, so only a real click in it
// can create an alias. The site label comes from the frame's principal,
// never from the page.

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  WhimsyEmailAliases: "resource:///modules/whimsy/WhimsyEmailAliases.sys.mjs",
});

const POPUP_ID = "whimsy-email-aliases-popup";

// AliasError reason -> toast string id.
const ERROR_TOASTS = {
  "signed-out": "whimsy-email-aliases-toast-signed-out",
  unavailable: "whimsy-email-aliases-toast-unavailable",
  network: "whimsy-email-aliases-toast-network",
  service: "whimsy-email-aliases-toast-icloud-failed",
  "relay-off": "whimsy-email-aliases-toast-relay-off",
  relay: "whimsy-email-aliases-toast-relay-failed",
};

export class WhimsyEmailAliasesParent extends JSWindowActorParent {
  receiveMessage(message) {
    if (message.name == "WhimsyEmailAliases:OpenMenu") {
      this.openMenu(message.data).catch(e => console.error("Whimsy: email aliases", e));
    }
  }

  get #win() {
    return this.browsingContext.topChromeWindow;
  }

  get #userContextId() {
    return this.browsingContext.originAttributes.userContextId || 0;
  }

  async openMenu({ screenX, screenY } = {}) {
    const win = this.#win;
    const E = lazy.WhimsyEmailAliases;
    if (!win || !E.enabled || this.browsingContext.usePrivateBrowsing) {
      return;
    }
    const popup = this.#popup(win);
    const [icloud, relay] = popup.children;
    win.document.l10n.setAttributes(icloud, "whimsy-email-aliases-icloud-checking");
    icloud.disabled = true;
    icloud.dataset.action = "";
    relay.hidden = !E.relayAvailable;
    popup._whimsyActor = this;
    popup.openPopupAtScreen(Math.round(screenX ?? 0), Math.round(screenY ?? 0), false);

    // Ask iCloud while the menu is already showing.
    const status = await E.iCloudStatus(this.#userContextId);
    if (popup._whimsyActor != this) {
      return;
    }
    const states = {
      "signed-in": ["whimsy-email-aliases-icloud", "create"],
      "signed-out": ["whimsy-email-aliases-icloud-sign-in", "sign-in"],
      unavailable: ["whimsy-email-aliases-icloud-unavailable", ""],
      error: ["whimsy-email-aliases-icloud-error", "sign-in"],
    };
    const [l10nId, action] = states[status.state] ?? states.error;
    win.document.l10n.setAttributes(icloud, l10nId);
    icloud.dataset.action = action;
    icloud.disabled = !action;
  }

  #popup(win) {
    const doc = win.document;
    let popup = doc.getElementById(POPUP_ID);
    if (popup) {
      return popup;
    }
    popup = doc.createXULElement("menupopup");
    popup.id = POPUP_ID;
    const icloud = doc.createXULElement("menuitem");
    icloud.className = "menuitem-iconic";
    icloud.id = "whimsy-email-aliases-icloud";
    const relay = doc.createXULElement("menuitem");
    relay.className = "menuitem-iconic";
    relay.id = "whimsy-email-aliases-relay";
    doc.l10n.setAttributes(relay, "whimsy-email-aliases-relay");
    popup.append(icloud, relay);
    icloud.addEventListener("command", () => popup._whimsyActor?.onICloud(icloud.dataset.action));
    relay.addEventListener("command", () => popup._whimsyActor?.onRelay());
    popup.addEventListener("popuphidden", e => {
      if (e.target == popup) {
        // Let a command that closed the menu run first.
        win.setTimeout(() => (popup._whimsyActor = null), 0);
      }
    });
    doc.getElementById("mainPopupSet").append(popup);
    return popup;
  }

  #toast(id, args) {
    try {
      this.#win?.gZenUIManager?.showToast(id, args ? { l10nArgs: args } : {});
    } catch (e) {
      console.error("Whimsy: email aliases toast", e);
    }
  }

  #fail(e) {
    console.error("Whimsy: email aliases", e);
    this.#toast(ERROR_TOASTS[e?.reason] ?? "whimsy-email-aliases-toast-network");
    if (e?.reason == "signed-out") {
      lazy.WhimsyEmailAliases.openICloudSignIn(this.#win);
    }
  }

  async #fill(address) {
    try {
      const filled = await this.sendQuery("WhimsyEmailAliases:Fill", { address });
      if (filled) {
        this.#toast("whimsy-email-aliases-toast-filled", { address });
        return;
      }
    } catch {}
    // The field went away: the address must not be lost.
    Cc["@mozilla.org/widget/clipboardhelper;1"].getService(Ci.nsIClipboardHelper).copyString(address);
    this.#toast("whimsy-email-aliases-toast-copied", { address });
  }

  async onICloud(action) {
    const E = lazy.WhimsyEmailAliases;
    if (action == "sign-in") {
      E.openICloudSignIn(this.#win);
      return;
    }
    if (action != "create") {
      return;
    }
    this.#toast("whimsy-email-aliases-toast-creating");
    try {
      const label = this.manager.documentPrincipal?.host || "";
      const address = await E.createICloudAlias({ userContextId: this.#userContextId, label });
      await this.#fill(address);
    } catch (e) {
      this.#fail(e);
    }
  }

  async onRelay() {
    const browser = this.browsingContext.top.embedderElement;
    const origin = this.manager.documentPrincipal?.originNoSuffix;
    try {
      const address = await lazy.WhimsyEmailAliases.createRelayAlias(browser, origin);
      if (address) {
        await this.#fill(address);
      }
    } catch (e) {
      this.#fail(e);
    }
  }
}
