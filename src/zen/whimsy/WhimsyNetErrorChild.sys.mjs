/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Keep Gecko's recovery actions, diagnostics and certificate warnings intact.
// AboutNetErrorLoad also covers the asynchronous felt-privacy card render.
const BASE = "chrome://browser/content/whimsy/";
const STYLE_ID = "whimsy-neterror-style";
const LINK_ID = "whimsy-neterror-game-link";
// Like Chrome's offline dino: only "you're offline" errors turn into the
// game. netOffline always; the usual no-connection errors only while the
// browser really has no network.
const OFFLINE_ERRORS = ["dnsNotFound", "connectionFailure", "netTimeout", "netReset", "netInterrupt"];
const SEASONS_URL = "resource:///modules/whimsy/WhimsySeasons.sys.mjs";
const GAME_PREFS = ["whimsy.game.style", "whimsy.game.chiptune", "whimsy.game.high-score"];

export class WhimsyNetErrorChild extends JSWindowActorChild {
  handleEvent(event) {
    if (event.type == "keydown") {
      this.handleKey(event);
      return;
    }
    if (event.type == "click") {
      this.handleClick(event);
      return;
    }
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
      // The deflated balloon dresses for the season (whimsy-neterror.css
      // layers the accent over it); custom properties reach the shadow tree.
      const season = this.season();
      if (season) {
        doc.documentElement.setAttribute("data-whimsy-season", season);
      } else {
        doc.documentElement.removeAttribute("data-whimsy-season");
      }
      if (container && !container.querySelector("#whimsy-neterror-brand")) {
        const brand = doc.createElement("p");
        brand.id = "whimsy-neterror-brand";
        doc.l10n.setAttributes(brand, "whimsy-neterror-brand");
        container.prepend(brand);
      }
    }
    // The game is only for a tab's network errors: never on a certificate
    // warning or another error, and never in a note or Easel block.
    if (this.errorCode() && Services.prefs.getBoolPref("whimsy.feature.game", true) && !this.checkingTab) {
      this.checkingTab = true;
      this.sendQuery("WhimsyNetError:InTab").then(inTab => {
        if (inTab && this.document == doc) {
          this.offerGame(doc);
        }
      }, () => {});
    }
  }

  offerGame(doc) {
    if (!doc.getElementById(LINK_ID)) {
      this.addStyle(doc.head);
      const button = doc.createElement("button");
      button.id = LINK_ID;
      button.type = "button";
      doc.l10n.setAttributes(button, "whimsy-neterror-play");
      button.addEventListener("click", () => this.sendAsyncMessage("WhimsyNetError:PlayGame"));
      doc.body.append(button);
    }
    if (this.isOffline() && !this.listening) {
      this.listening = true;
      doc.addEventListener("keydown", this, true);
      // Tapping the deflated balloon (the container's ::before) works too.
      doc.addEventListener("click", this, true);
    }
  }

  // The error code when this is a network error page (offline, DNS,
  // connection), else null.
  errorCode() {
    const doc = this.document;
    if (!doc?.documentURI.startsWith("about:neterror?")) {
      return null;
    }
    const error = new URLSearchParams(doc.documentURI.slice("about:neterror?".length)).get("e");
    return error == "netOffline" || OFFLINE_ERRORS.includes(error) ? error : null;
  }

  isOffline() {
    const error = this.errorCode();
    return error == "netOffline" || (!!error && !this.contentWindow.navigator.onLine);
  }

  // Space or an arrow key turns the page into the game in place - unless
  // the key belongs to something focused (a text field, or Space on a
  // button such as Try Again).
  handleKey(event) {
    if (this.gamePlaying() || event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) {
      return;
    }
    const isSpace = event.key == " ";
    if (!isSpace && !event.key.startsWith("Arrow")) {
      return;
    }
    const target = event.composedTarget ?? event.target;
    if (target?.closest?.("input, textarea, select, [contenteditable]") || target?.isContentEditable) {
      return;
    }
    if (isSpace && target?.closest?.("button, a")) {
      return;
    }
    event.preventDefault();
    if (this.gameStarted) {
      // Back from the error page (Esc): the key only brings the game back.
      event.stopPropagation();
    }
    this.startGame();
  }

  // The game is on screen (it hides itself again on Esc).
  gamePlaying() {
    return this.gameStarted && this.document.body.classList.contains("whimsy-game-embedded");
  }

  handleClick(event) {
    if (this.gamePlaying() || event.button != 0) {
      return;
    }
    const container = (event.composedPath?.() || [event.composedTarget ?? event.target]).find(
      node => node?.id == "text-container" || node?.classList?.contains("felt-privacy-container")
    );
    if (container?.id != "text-container" && !container?.classList?.contains("felt-privacy-container")) {
      return;
    }
    // The balloon is the container's ::before, at the top of its box.
    const rect = container.getBoundingClientRect();
    if (event.clientY - rect.top < 160) {
      this.startGame();
    }
  }

  // The parent checks that a page really loads (the OS's link state can
  // stay "up" with no internet, or miss the reconnect) and says so here.
  receiveMessage(message) {
    if (message.name == "WhimsyNetError:BackOnline" || message.name == "WhimsyNetError:Offline") {
      this.connection = message.name == "WhimsyNetError:BackOnline";
      this.tellGame();
    }
  }

  tellGame() {
    if (this.connection !== undefined) {
      this.document?.dispatchEvent(new this.contentWindow.Event(this.connection ? "WhimsyGame:BackOnline" : "WhimsyGame:Offline"));
    }
  }

  startGame() {
    const doc = this.document;
    if (this.gameStarted) {
      doc.dispatchEvent(new this.contentWindow.Event("WhimsyGame:Show"));
      return;
    }
    this.gameStarted = true;
    this.sendAsyncMessage("WhimsyNetError:WatchConnectivity");
    const win = this.contentWindow;
    const host = {
      autostart: true,
      season: this.season(),
      // wave7/season: an occasion (halloween, holidays) dresses the game further.
      look: this.look(),
      get(name, fallback) {
        const P = Services.prefs;
        return typeof fallback == "boolean" ? P.getBoolPref(name, fallback)
          : typeof fallback == "number" ? P.getIntPref(name, fallback)
            : P.getStringPref(name, fallback);
      },
      // Content processes can't write prefs; the parent does it.
      set: (name, value) => {
        if (GAME_PREFS.includes(name)) {
          this.sendAsyncMessage("WhimsyNetError:SetPref", { name, value });
        }
      },
    };
    win.wrappedJSObject.WhimsyGameHost = Cu.cloneInto(host, win, { cloneFunctions: true });
    doc.l10n.addResourceIds(["browser/whimsy.ftl"]);
    doc.body.classList.add("whimsy-game-embedded");
    // The game takes the deflated balloon's place (also inside the
    // felt-privacy card's shadow tree, where body classes don't reach).
    doc.querySelector("net-error-card")?.shadowRoot
      ?.querySelector(".felt-privacy-container")?.classList.add("whimsy-game-embedded");
    const link = doc.createElement("link");
    link.rel = "stylesheet";
    link.href = `${BASE}whimsy-game.css`;
    doc.head.append(link);
    const script = doc.createElement("script");
    // What the connection check found before the game was listening.
    script.addEventListener("load", () => this.tellGame(), { once: true });
    script.src = `${BASE}whimsy-game.js`;
    doc.head.append(script);
  }

  season() {
    try {
      return ChromeUtils.importESModule(SEASONS_URL).WhimsySeasons.current()?.id ?? null;
    } catch {
      return null;
    }
  }

  look() {
    try {
      return ChromeUtils.importESModule(SEASONS_URL).WhimsySeasons.look()?.id ?? null;
    } catch {
      return null;
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
