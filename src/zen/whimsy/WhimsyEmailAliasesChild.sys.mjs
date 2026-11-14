/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Email aliases, page side: finds email fields and shows a small filled
// mail button at the right edge of the focused one (fix7/tabs: filled, not
// an outline, so it reads on any field; and it steps left of a password
// manager's own inline button, 1Password's, Bitwarden's, LastPass's...,
// instead of hiding under it). The button lives in a closed
// shadow root, styled through CSSOM only (so page CSPs can't block it) and
// accepts trusted clicks only. Clicking it asks the parent to open the
// alias menu, which lives in the browser chrome; the parent sends back the
// address to fill. Nothing here talks to iCloud or Relay. W28: the button
// itself (and how it finds its place) is WhimsyFieldButton, shared with
// verification codes.

import { WhimsyFieldButton } from "resource:///modules/whimsy/WhimsyFieldButton.sys.mjs";

const lazy = {};
ChromeUtils.defineLazyGetter(lazy, "l10n", () => new Localization(["browser/whimsy.ftl"], true));
const FEATURE_PREF = "whimsy.feature.email-aliases";
const BUTTON_PREF = "whimsy.email-aliases.button";
const HOST_ID = "whimsy-email-aliases-host";
const EXCLUDED_TYPES = new Set([
  "hidden", "password", "submit", "button", "checkbox", "radio", "file",
  "range", "color", "date", "datetime-local", "month", "week", "time",
  "image", "reset", "number", "tel", "url", "search",
]);
const EMAIL_HINT = /e-?mail|邮箱|correo|courriel/i;

export function isEmailField(element) {
  if (!HTMLInputElement.isInstance(element)) {
    return false;
  }
  const type = (element.type || "text").toLowerCase();
  if (EXCLUDED_TYPES.has(type) || element.readOnly || element.disabled) {
    return false;
  }
  if (type == "email") {
    return true;
  }
  const autocomplete = (element.getAttribute("autocomplete") || "").toLowerCase();
  if (autocomplete.split(/\s+/).includes("email")) {
    return true;
  }
  return [element.name, element.id, element.placeholder, element.getAttribute("aria-label")].some(
    value => value && EMAIL_HINT.test(value)
  );
}

export class WhimsyEmailAliasesChild extends JSWindowActorChild {
  #button = new WhimsyFieldButton({
    hostId: HOST_ID,
    label: () => lazy.l10n.formatValueSync("whimsy-email-aliases-field-button"), // wave9/designfix (L6)
    // A mask glyph.
    glyph: [{ tag: "path", attrs: { d: "M2 4.5h12v7H2zM2.5 5l5.5 4 5.5-4" } }],
    onClick: () => this.#openMenu(),
  });

  handleEvent(event) {
    switch (event.type) {
      case "focusin":
        this.#onFocusIn(event);
        break;
      case "pagehide":
        this.#button.remove();
        break;
    }
  }

  receiveMessage(message) {
    if (message.name == "WhimsyEmailAliases:Fill") {
      return this.#fill(message.data.address);
    }
    // wave7/small: the command bar's Create Email Alias.
    if (message.name == "WhimsyEmailAliases:FocusedField") {
      return this.#focusedField();
    }
    return undefined;
  }

  didDestroy() {
    this.#button.remove();
  }

  #onFocusIn(event) {
    const input = event.composedTarget ?? event.target;
    if (
      !Services.prefs.getBoolPref(FEATURE_PREF, true) ||
      !Services.prefs.getBoolPref(BUTTON_PREF, true) ||
      this.browsingContext.usePrivateBrowsing
    ) {
      return;
    }
    if (!isEmailField(input)) {
      return;
    }
    if (this.#button.isShownFor(input)) {
      this.#button.position();
      return;
    }
    this.#button.attach(input);
  }

  #openMenu() {
    const input = this.#button.input;
    if (!input) {
      return;
    }
    const rect = input.getBoundingClientRect();
    const win = input.ownerDocument.defaultView;
    this.sendAsyncMessage("WhimsyEmailAliases:OpenMenu", {
      screenX: win.mozInnerScreenX + rect.left,
      screenY: win.mozInnerScreenY + rect.bottom,
    });
  }

  // wave7/small: the email field focused in this frame (through open shadow
  // roots), remembered as the one to fill; where the menu opens, or null.
  #focusedField() {
    if (!Services.prefs.getBoolPref(FEATURE_PREF, true) || this.browsingContext.usePrivateBrowsing) {
      return null;
    }
    let active = this.document?.activeElement ?? null;
    while (active?.shadowRoot?.activeElement) {
      active = active.shadowRoot.activeElement;
    }
    if (!active || !isEmailField(active)) {
      return null;
    }
    this.#button.remember(active);
    const rect = active.getBoundingClientRect();
    const win = active.ownerDocument.defaultView;
    return {
      screenX: win.mozInnerScreenX + rect.left,
      screenY: win.mozInnerScreenY + rect.bottom,
    };
  }

  // Fills the field the menu was opened for, like typing would.
  #fill(address) {
    const input = this.#button.input;
    if (!input?.isConnected || typeof address != "string") {
      return false;
    }
    input.focus();
    input.setUserInput(address);
    this.#button.remove();
    return true;
  }
}
