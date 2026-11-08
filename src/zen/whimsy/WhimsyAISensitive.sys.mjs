/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// W23: the one redactor every AI surface shares. Password, card, and
// one-time-code fields never reach a model: they're left out of page text
// and masked (a solid box, never a blur) before anything is captured.
// Card-shaped digit runs and key-looking strings in ordinary text become
// "[card number]" and "[secret]". Pure functions, safe in content processes.

import { findSensitive, kindOf, luhn } from "resource:///modules/whimsy/WhimsyRedactChild.sys.mjs";
import { isSecret } from "resource:///modules/whimsy/WhimsyFormProtectionChild.sys.mjs";

export const MASK_COLOR = "rgb(118, 118, 128)";
export const CARD_LABEL = "[card number]";
export const SECRET_LABEL = "[secret]";
export const HIDDEN_LABEL = "[hidden]";

const PASSWORD_WORDS = /\b(pass(word|code|phrase)?|pwd|pin)\b/i;
const CARD_WORDS = /\b(card ?(number|no)|cc[ -]?(num|number|csc|exp)|cardnumber|cvv|cvc|csc|security code|expir\w*)\b/i;
const OTP_WORDS = /\b(otp|one[- ]time|verification code|confirmation code|2fa|mfa|totp|(auth|authentication|sms|login|sign[- ]?in|access) code)\b/i;
const NOT_OTP_WORDS = /\b(postal|zip|post|promo|coupon|discount|gift|referral|area|country|invite)\b/i;
const CARD_SHAPED = /^\s*\d(?:[ -]?\d){12,18}\s*$/;
const FIELD_SELECTOR = "input, textarea, select, [contenteditable]:not([contenteditable=false])";

function digitsOf(text) {
  return String(text ?? "").replace(/\D/g, "");
}

function isCardValue(value) {
  if (!CARD_SHAPED.test(value ?? "")) {
    return false;
  }
  const digits = digitsOf(value);
  return digits.length >= 13 && digits.length <= 19 && luhn(digits);
}

// "1234 1234 1234 1234", "0000 0000 0000 0000": card-shaped, Luhn or not.
function isCardPlaceholder(text) {
  return CARD_SHAPED.test(text ?? "") && digitsOf(text).length >= 13;
}

function words(el) {
  const parts = [];
  for (const attr of ["name", "id", "aria-label", "placeholder", "data-testid", "title"]) {
    parts.push(el.getAttribute?.(attr) ?? "");
  }
  for (const label of el.labels ?? []) {
    parts.push(label.textContent ?? "");
  }
  const labelledBy = el.getAttribute?.("aria-labelledby");
  if (labelledBy) {
    for (const id of labelledBy.split(/\s+/)) {
      parts.push(el.ownerDocument?.getElementById(id)?.textContent ?? "");
    }
  }
  return parts.join(" ").replace(/[_-]+/g, " ");
}

export function fieldValue(el) {
  if (el.localName == "input" || el.localName == "textarea" || el.localName == "select") {
    return el.value ?? "";
  }
  return el.textContent ?? "";
}

/**
 * Whether a frame is a payment frame: on another origin than the tab's
 * page, with a card field (a cc-* hint, a card-number name, or a
 * card-shaped placeholder) in it. Everything in such a frame is masked.
 *
 * @param {WindowGlobalChild|Window} windowContext
 * @returns {boolean}
 */
export function isSensitiveFrame(windowContext) {
  const wgc = windowContext?.windowGlobalChild ?? windowContext;
  if (!wgc || wgc.browsingContext?.parent == null || wgc.sameOriginWithTop) {
    return false;
  }
  const doc = wgc.browsingContext?.window?.document;
  if (!doc) {
    return false;
  }
  for (const el of doc.querySelectorAll("input, select")) {
    const autocomplete = (el.getAttribute("autocomplete") ?? "").toLowerCase();
    if (/\bcc-/.test(autocomplete) || isCardPlaceholder(el.getAttribute("placeholder")) || CARD_WORDS.test(words(el))) {
      return true;
    }
  }
  return false;
}

/**
 * What a field holds that no model may see.
 *
 * @param {Element} el
 * @returns {"password"|"card"|"otp"|null}
 */
export function classifyField(el) {
  if (!el || el.nodeType != 1) {
    return null;
  }
  const name = el.localName;
  const editable = el.isContentEditable && !el.parentElement?.isContentEditable;
  if (name != "input" && name != "textarea" && name != "select" && !editable) {
    return null;
  }
  if (name == "input" && el.type == "password") {
    return "password";
  }
  const autocomplete = (el.getAttribute("autocomplete") ?? "").toLowerCase();
  if (/\b(current-password|new-password|password)\b/.test(autocomplete)) {
    return "password";
  }
  if (/\bcc-/.test(autocomplete)) {
    return "card";
  }
  if (/\bone-time-code\b/.test(autocomplete)) {
    return "otp";
  }
  const win = el.documentGlobal;
  try {
    if (win?.windowGlobalChild && isSensitiveFrame(win.windowGlobalChild)) {
      return "card";
    }
  } catch {}
  const text = words(el);
  if (name == "input" && (el.type == "hidden" || el.type == "file")) {
    return null;
  }
  if (CARD_WORDS.test(text) || isCardPlaceholder(el.getAttribute("placeholder"))) {
    return "card";
  }
  if (OTP_WORDS.test(text) || el.getAttribute("inputmode") == "numeric" && /\bcode\b/i.test(text) && !NOT_OTP_WORDS.test(text)) {
    return "otp";
  }
  if (PASSWORD_WORDS.test(text)) {
    return "password";
  }
  if (isCardValue(fieldValue(el))) {
    return "card";
  }
  if (name != "select" && !editable && isSecret(el)) {
    return "password";
  }
  return null;
}

/**
 * Every field in `doc` that holds a secret, with its kind.
 *
 * @param {Document} doc
 * @returns {{el: Element, kind: string}[]}
 */
export function sensitiveFields(doc) {
  const out = [];
  for (const el of doc?.querySelectorAll(FIELD_SELECTOR) ?? []) {
    const kind = classifyField(el);
    if (kind) {
      out.push({ el, kind });
    }
  }
  return out;
}

/**
 * Card runs and key-looking strings in plain text, replaced. Emails and
 * phone numbers stay: people ask about them.
 *
 * @param {string} text
 * @returns {{text: string, spans: {start: number, end: number, kind: "card"|"secret"}[]}}
 */
export function redactText(text) {
  const source = String(text ?? "");
  const spans = [];
  for (const [start, end] of findSensitive(source)) {
    const kind = kindOf(source.slice(start, end));
    if (kind == "card" || kind == "key") {
      spans.push({ start, end, kind: kind == "card" ? "card" : "secret" });
    }
  }
  let out = "";
  let at = 0;
  for (const span of spans) {
    out += source.slice(at, span.start) + (span.kind == "card" ? CARD_LABEL : SECRET_LABEL);
    at = span.end;
  }
  return { text: out + source.slice(at), spans };
}

/**
 * Removes every value a secret field holds from `text` (a password a page
 * mirrors into its own text, an OTP shown beside its field).
 *
 * @param {string} text
 * @param {string[]} values
 * @returns {string}
 */
export function withoutValues(text, values) {
  let out = String(text ?? "");
  const sorted = [...new Set(values.map(v => String(v ?? "").trim()).filter(v => v.length >= 3))]
    .sort((a, b) => b.length - a.length);
  for (const value of sorted) {
    out = out.split(value).join(HIDDEN_LABEL);
  }
  return out;
}

export const WhimsyAISensitive = {
  MASK_COLOR,
  classifyField,
  isSensitiveFrame,
  sensitiveFields,
  redactText,
  withoutValues,
  fieldValue,
};
