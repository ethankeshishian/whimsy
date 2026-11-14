/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Verification codes, page side (W28, WhimsyTOTP.sys.mjs has the rest).
//
// - Code fields: on focus of a field that asks for a sign-in code, ask the
//   parent whether this site has codes (a yes or no, nothing else) and show
//   the shared field button (WhimsyFieldButton, as email aliases). A trusted
//   click on it arms this field; the parent then sends the one code to fill,
//   and it goes only into that field, only while it's still in the page.
// - Setup QR codes: on a right-click, the square-ish image, canvas, or SVG
//   under the pointer is drawn into a small canvas here and read with jsQR.
//   Only an otpauth://totp/ URI of sane length goes to the parent, which
//   checks it again. Nothing else from the page is sent.
//
// No key ever reaches this process: the parent keeps them.

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  WhimsyFieldButton: "resource:///modules/whimsy/WhimsyFieldButton.sys.mjs",
});
ChromeUtils.defineLazyGetter(lazy, "l10n", () => new Localization(["browser/whimsy.ftl"], true));
ChromeUtils.defineLazyGetter(lazy, "jsQR", () => {
  return ChromeUtils.importESModule("resource:///modules/whimsy/third_party/jsQR.mjs").default;
});

const FEATURE_PREF = "whimsy.feature.totp";
const HOST_ID = "whimsy-totp-host";
const HTML_NS = "http://www.w3.org/1999/xhtml";
const SVG_NS = "http://www.w3.org/2000/svg";
const MAX_URI = 2048;
// Setup codes are square: 64px or more on screen, at most 2000px, and
// within a third of square either way.
const MIN_SIZE = 64;
const MAX_SIZE = 2000;
// Read at no more than this many pixels a side (jsQR's time grows with
// area), with a white quiet zone around it.
const DECODE_SIZE = 400;
const MARGIN = 16;
// An armed click is good for this long (the chooser stays open meanwhile).
const ARMED_MS = 120_000;

const CODE_AUTOCOMPLETE = "one-time-code";
const CODE_HINT = /otp|2fa|mfa|one.?time|verif|auth.?code|authenticat|security.?code|passcode|two.?factor|totp/i;
const NOT_CODE_HINT = /promo|coupon|gift|discount|zip|postal|voucher|referral|card|cvc|cvv/i;
const CODE_TYPES = new Set(["text", "tel", "number"]);

function labelText(input) {
  const parts = [];
  try {
    for (const label of input.labels ?? []) {
      parts.push(label.textContent);
    }
  } catch {}
  const labelledBy = input.getAttribute("aria-labelledby");
  if (labelledBy) {
    for (const id of labelledBy.split(/\s+/).slice(0, 4)) {
      parts.push(input.ownerDocument.getElementById(id)?.textContent ?? "");
    }
  }
  return parts.join(" ").slice(0, 200);
}

/** Whether `input` is a field asking for a sign-in code. */
export function isCodeField(input) {
  if (!HTMLInputElement.isInstance(input) || input.readOnly || input.disabled) {
    return false;
  }
  const type = (input.type || "text").toLowerCase();
  if (!CODE_TYPES.has(type)) {
    return false;
  }
  const autocomplete = (input.getAttribute("autocomplete") || "").toLowerCase().split(/\s+/);
  if (autocomplete.includes(CODE_AUTOCOMPLETE)) {
    return true;
  }
  if (autocomplete.some(token => ["email", "username", "cc-number", "cc-csc", "postal-code", "tel"].includes(token))) {
    return false;
  }
  const short =
    type == "number" ||
    (input.maxLength >= 1 && input.maxLength <= 10) ||
    ["numeric", "decimal"].includes((input.inputMode || "").toLowerCase());
  if (!short) {
    return false;
  }
  const hints = [
    input.name,
    input.id,
    input.placeholder,
    input.getAttribute("aria-label"),
    labelText(input),
  ].filter(Boolean).join(" ");
  return CODE_HINT.test(hints) && !NOT_CODE_HINT.test(hints);
}

/** Whether `text` is something worth sending up as a setup code. */
export function looksLikeSetupUri(text) {
  return typeof text == "string" && text.length <= MAX_URI && /^otpauth:\/\/totp\//i.test(text);
}

export class WhimsyTOTPChild extends JSWindowActorChild {
  #armed = null; // {input, until}
  #button = new lazy.WhimsyFieldButton({
    hostId: HOST_ID,
    label: () => lazy.l10n.formatValueSync("whimsy-totp-field-button"),
    // A key.
    glyph: [
      { tag: "circle", attrs: { cx: "5.5", cy: "10.5", r: "2.5" } },
      { tag: "path", attrs: { d: "M7.5 8.5 13 3M11 5l1.5 1.5" } },
    ],
    onClick: () => this.#pick(),
  });
  #asking = null;

  get #available() {
    return Services.prefs.getBoolPref(FEATURE_PREF, true) && !this.browsingContext.usePrivateBrowsing;
  }

  handleEvent(event) {
    switch (event.type) {
      case "focusin":
        this.#onFocusIn(event).catch(() => {});
        break;
      case "contextmenu":
        this.#onContextMenu(event);
        break;
      case "pagehide":
        this.#armed = null;
        this.#button.remove();
        break;
    }
  }

  receiveMessage(message) {
    if (message.name == "WhimsyTOTP:Fill") {
      return this.#fill(message.data?.code);
    }
    return undefined;
  }

  didDestroy() {
    this.#armed = null;
    this.#button.remove();
  }

  // -- the field button ------------------------------------------------------------

  async #onFocusIn(event) {
    const input = event.composedTarget ?? event.target;
    if (!this.#available || !isCodeField(input)) {
      return;
    }
    if (this.#button.isShownFor(input)) {
      this.#button.position();
      return;
    }
    this.#asking = input;
    let has = false;
    try {
      has = await this.sendQuery("WhimsyTOTP:HasCodes");
    } catch {
      return;
    }
    // Still the field in focus, still in the page.
    if (has !== true || this.#asking != input || !input.isConnected) {
      return;
    }
    this.#asking = null;
    this.#button.attach(input);
  }

  #pick() {
    const input = this.#button.input;
    if (!input?.isConnected) {
      return;
    }
    this.#armed = { input, until: Cu.now() + ARMED_MS };
    const rect = input.getBoundingClientRect();
    const win = input.ownerDocument.defaultView;
    this.sendAsyncMessage("WhimsyTOTP:Pick", {
      screenRect: {
        left: win.mozInnerScreenX + rect.left,
        top: win.mozInnerScreenY + rect.top,
        width: rect.width,
        height: rect.height,
      },
    });
  }

  // Fills the field that was clicked, like typing would; once.
  #fill(code) {
    const armed = this.#armed;
    this.#armed = null;
    if (!armed || Cu.now() > armed.until || typeof code != "string" || !/^\d{6,8}$/.test(code)) {
      return false;
    }
    const input = armed.input;
    if (!input.isConnected || input.disabled || input.readOnly) {
      return false;
    }
    input.focus();
    input.setUserInput(code);
    this.#button.remove();
    return true;
  }

  // -- setup QR codes ----------------------------------------------------------------

  #onContextMenu(event) {
    if (!this.#available) {
      return;
    }
    const target = this.#qrElement(event.composedTarget ?? event.target);
    if (!target) {
      return;
    }
    let text = null;
    try {
      text = this.#decode(target);
    } catch {
      // Malformed or unreadable pixels: no item.
      return;
    }
    if (looksLikeSetupUri(text)) {
      this.sendAsyncMessage("WhimsyTOTP:QR", { uri: text });
    }
  }

  // The image, canvas, or SVG under the pointer that could be a setup code.
  #qrElement(node) {
    let el = node?.nodeType == Node.ELEMENT_NODE ? node : node?.parentElement;
    if (!el) {
      return null;
    }
    let found = null;
    if (el.namespaceURI == SVG_NS) {
      // The outermost <svg>: a code is often many <rect>s or <path>s.
      let svg = el.closest("svg");
      while (svg?.parentElement?.closest("svg")) {
        svg = svg.parentElement.closest("svg");
      }
      found = svg;
    } else if (HTMLImageElement.isInstance(el) || HTMLCanvasElement.isInstance(el)) {
      found = el;
    } else {
      const picture = el.closest("picture");
      found = picture?.querySelector("img") ?? null;
    }
    if (!found) {
      return null;
    }
    const rect = found.getBoundingClientRect();
    const ratio = rect.width / Math.max(rect.height, 1);
    if (
      rect.width < MIN_SIZE || rect.height < MIN_SIZE ||
      rect.width > MAX_SIZE || rect.height > MAX_SIZE ||
      ratio < 0.75 || ratio > 1.33
    ) {
      return null;
    }
    return found;
  }

  #decode(el) {
    const doc = el.ownerDocument;
    const win = doc.defaultView;
    const rect = el.getBoundingClientRect();
    const scale = Math.min(1, DECODE_SIZE / Math.max(rect.width, rect.height));
    const w = Math.max(1, Math.round(rect.width * scale));
    const h = Math.max(1, Math.round(rect.height * scale));
    const canvas = doc.createElementNS(HTML_NS, "canvas");
    canvas.width = w + MARGIN * 2;
    canvas.height = h + MARGIN * 2;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    let drawn = false;
    if (HTMLImageElement.isInstance(el) && el.complete && el.naturalWidth > 0) {
      try {
        ctx.drawImage(el, MARGIN, MARGIN, w, h);
        drawn = true;
      } catch {}
    } else if (HTMLCanvasElement.isInstance(el)) {
      try {
        ctx.drawImage(el, MARGIN, MARGIN, w, h);
        drawn = true;
      } catch {}
    }
    if (!drawn) {
      // What's on screen there (an SVG, or an image that can't be drawn):
      // a chrome-side snapshot of the element's rectangle.
      ctx.save();
      ctx.translate(MARGIN, MARGIN);
      ctx.scale(scale, scale);
      ctx.drawWindow(win, rect.left + win.scrollX, rect.top + win.scrollY, rect.width, rect.height, "rgb(255,255,255)");
      ctx.restore();
    }
    const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const result = lazy.jsQR(image.data, image.width, image.height, { inversionAttempts: "attemptBoth" });
    const text = result?.data;
    return typeof text == "string" ? text : null;
  }
}
