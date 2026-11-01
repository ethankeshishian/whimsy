/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Content side of Form Protection (W9-03).
// Monitors form inputs in content pages. When a user has typed or edited text
// in a form, tells the parent so the tab can be marked as protected from
// auto-archive and show its in-progress form marker.
//
// W10-25: keeps what was typed across a reload. When a page with typed
// answers goes away (pagehide), it sends a snapshot of its form data to the
// parent (SessionStoreUtils.collectFormData, which never collects passwords
// or card numbers). When the same address loads again in the tab, it asks
// for the snapshot, counts the empty fields it could fill and tells the
// parent, which asks the person first ("Fill in 3 answers you typed
// before?"). Only Fill In fills them, and only fields that are still empty.

const HIGHLIGHT_MS = 2000;
const FADE_MS = 400;

function addressOf(location) {
  try {
    const url = new URL(location.href);
    url.hash = "";
    return url.href;
  } catch (e) {
    return "";
  }
}

// Never refilled, whatever a snapshot says.
function isSecret(el) {
  if (el.localName == "input" && el.type == "password") {
    return true;
  }
  const autocomplete = (el.getAttribute("autocomplete") ?? "").toLowerCase();
  return /\bcc-|one-time-code|current-password|new-password/.test(autocomplete);
}

export class WhimsyFormProtectionChild extends JSWindowActorChild {
  // The snapshot offered for this document, and what Fill In filled.
  _offer = null;

  handleEvent(event) {
    switch (event.type) {
      case "input":
      case "change":
        this.checkFormState();
        break;
      case "pageshow":
        this.checkFormState();
        if (!event.persisted) {
          this.offerRefill();
        }
        break;
      case "pagehide":
        this.snapshot();
        break;
    }
  }

  receiveMessage(message) {
    if (message.name == "Whimsy:FormRefill") {
      return this.refill();
    }
    return null;
  }

  checkFormState() {
    try {
      const doc = this.document;
      if (!doc || doc.nodeType !== doc.DOCUMENT_NODE) {
        return;
      }
      const hasForm = this.hasFilledForm(doc);
      this.sendAsyncMessage("Whimsy:FormProtectionState", { hasForm });
    } catch (e) {
      // Content may be in transition or detached.
    }
  }

  hasFilledForm(doc) {
    if (!doc) {
      return false;
    }
    const inputs = doc.querySelectorAll(
      "input:not([type=hidden]):not([type=submit]):not([type=reset]):not([type=button]):not([type=image]), textarea"
    );
    for (const input of inputs) {
      if (input.type === "checkbox" || input.type === "radio") {
        if (input.checked !== input.defaultChecked) {
          return true;
        }
      } else {
        if (input.value && input.value !== input.defaultValue && input.value.trim().length > 0) {
          return true;
        }
      }
    }
    const selects = doc.querySelectorAll("select");
    for (const select of selects) {
      for (const option of select.options) {
        if (option.selected !== option.defaultSelected) {
          return true;
        }
      }
    }
    return false;
  }

  // The top document's typed answers, as it goes away.
  snapshot() {
    try {
      const win = this.contentWindow;
      if (!win || win.top != win || !this.hasFilledForm(this.document)) {
        return;
      }
      const data = SessionStoreUtils.collectFormData(win);
      if (!data || (!data.id && !data.xpath)) {
        return;
      }
      this.sendAsyncMessage("Whimsy:FormSnapshot", {
        url: addressOf(win.location),
        data: { id: data.id ?? {}, xpath: data.xpath ?? {} },
      });
    } catch (e) {
      // A page going away can't always be read.
    }
  }

  // The elements a snapshot names, with the values for them.
  _targets(data) {
    const doc = this.document;
    const targets = [];
    for (const [key, value] of Object.entries(data?.id ?? {})) {
      const el = doc.getElementById(key);
      if (el) {
        targets.push([el, value]);
      }
    }
    for (const [xpath, value] of Object.entries(data?.xpath ?? {})) {
      try {
        const el = doc.evaluate(xpath, doc, null, 9 /* FIRST_ORDERED_NODE_TYPE */, null).singleNodeValue;
        if (el) {
          targets.push([el, value]);
        }
      } catch (e) {
        // Not a valid path in this document.
      }
    }
    return targets;
  }

  // Whether `el` is empty enough to take `value` (never overwriting what's
  // there now).
  _fillable(el, value) {
    if (isSecret(el) || el.disabled || el.readOnly) {
      return false;
    }
    if (el.localName == "input" && (el.type == "checkbox" || el.type == "radio")) {
      return typeof value == "boolean" && value && el.checked == el.defaultChecked && !el.checked;
    }
    if (el.localName == "select") {
      return typeof value == "object" && value != null && el.selectedIndex == [...el.options].findIndex(o => o.defaultSelected);
    }
    if (el.localName == "textarea" || el.localName == "input") {
      return typeof value == "string" && value.length > 0 && !el.value;
    }
    return false;
  }

  async offerRefill() {
    try {
      const win = this.contentWindow;
      if (!win || win.top != win) {
        return;
      }
      const url = addressOf(win.location);
      const snapshot = await this.sendQuery("Whimsy:FormSnapshotFor", { url });
      if (!snapshot?.data) {
        return;
      }
      const count = this._targets(snapshot.data).filter(([el, value]) => this._fillable(el, value)).length;
      if (!count) {
        return;
      }
      this._offer = { url, data: snapshot.data };
      this.sendAsyncMessage("Whimsy:FormRefillReady", { url, count });
    } catch (e) {
      // The page went away first.
    }
  }

  // Fill In: only the fields that are still empty; each lights up briefly.
  refill() {
    const offer = this._offer;
    this._offer = null;
    if (!offer || addressOf(this.contentWindow.location) != offer.url) {
      return { filled: 0 };
    }
    const filled = [];
    for (const [el, value] of this._targets(offer.data)) {
      if (!this._fillable(el, value)) {
        continue;
      }
      if (el.localName == "select") {
        const index = typeof value.selectedIndex == "number" ? value.selectedIndex : -1;
        const byValue = [...el.options].findIndex(o => o.value == value.value);
        el.selectedIndex = byValue >= 0 ? byValue : index;
      } else if (el.type == "checkbox" || el.type == "radio") {
        el.checked = true;
      } else {
        el.value = value;
      }
      el.dispatchEvent(new this.contentWindow.Event("input", { bubbles: true }));
      el.dispatchEvent(new this.contentWindow.Event("change", { bubbles: true }));
      filled.push(el);
    }
    this.highlight(filled);
    this.checkFormState();
    return { filled: filled.length };
  }

  // A 2s outline on each filled field, fading out (none with reduced
  // motion). Inline styles: a page can't load chrome:// sheets.
  highlight(elements) {
    const win = this.contentWindow;
    const reduce = win.matchMedia("(prefers-reduced-motion: reduce)").matches;
    for (const el of elements) {
      const old = { outline: el.style.outline, background: el.style.backgroundColor, transition: el.style.transition };
      el.style.outline = "2px solid color-mix(in srgb, AccentColor 70%, transparent)";
      el.style.backgroundColor = "color-mix(in srgb, AccentColor 8%, transparent)";
      win.setTimeout(() => {
        if (!reduce) {
          el.style.transition = `outline-color ${FADE_MS}ms ease-out, background-color ${FADE_MS}ms ease-out`;
        }
        el.style.outline = old.outline;
        el.style.backgroundColor = old.background;
        win.setTimeout(() => (el.style.transition = old.transition), reduce ? 0 : FADE_MS);
      }, HIGHLIGHT_MS);
    }
  }
}
