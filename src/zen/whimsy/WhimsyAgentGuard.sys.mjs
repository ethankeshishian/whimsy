/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// W23: the agent's guardrails. The agent acts freely, but pauses with an
// exact preview before anything that moves money, sends or posts to
// people, deletes, changes account or privacy settings, submits a form,
// types your data on a site you haven't used, downloads, or signs in.
// When it can't tell what a control does, it pauses too.
//
// - Security settings (passwords, 2FA, recovery) are never changed: the
//   pause hands the step to the person ("security", no "do").
// - Card, password, and one-time-code fields are never typed by the agent:
//   the person fills them (Firefox or the password manager fills saved
//   ones); codes are never read from mail or texts.
// - Captchas are never solved: the agent waits for the page to move on.
// - Downloads are saved, never opened or installed.
// - "Don't ask again on this site for this task" only for submit,
//   new-site data, and downloads; never beyond the task, never saved.
// - An outside app's held call returns before its client's 120s limit with
//   "Waiting for the person to approve; call again to keep waiting".
//
// classify() is pure (the target comes from WhimsyClaudeChild's
// Claude:Describe), so it's tested directly and from fixtures.

import { redactText } from "resource:///modules/whimsy/WhimsyAISensitive.sys.mjs";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  PlacesUtils: "resource://gre/modules/PlacesUtils.sys.mjs",
  WhimsyAgentTasks: "resource:///modules/whimsy/WhimsyAgentTasks.sys.mjs",
});

export const WAITING_TEXT = "Waiting for the person to approve; call again to keep waiting";
// The stdio bridge gives up at 120s; answer well before.
const HOLD_MS = 100 * 1000;

const KINDS = ["pay", "send", "delete", "account", "security", "submit", "new-site-data", "download", "sign-in", "unsure", "captcha"];

const SECURITY = /\b(passwords?|pass ?codes?|2fa|two[- ]factor|2[- ]step|two[- ]step|multi[- ]factor|mfa|authenticator( app)?|recovery (e-?mail|phone|codes?|keys?|options?)|security (keys?|questions?|codes?)|passkeys?|backup codes?|app passwords?)\b/i;
const PAY = /\b(pay( now)?|place (my |your )?order|buy( it)?( now)?|purchase|complete (my |your )?(purchase|order|payment|checkout)|confirm (and|&) pay|subscribe|donate|start (my |your )?(free )?trial|upgrade( now)?|book (now|and pay)|reserve (and|&) pay|add (funds|money)|send money|transfer( money)?|tip)\b/i;
const NOT_PAY = /\b(go to|proceed to|continue to|view|add to) (the )?(checkout|cart|basket|bag)\b/i;
const SEND = /\b(send( now)?|post|publish|tweet|reply( all)?|share|comment|invite|forward|retweet|repost|message)\b/i;
const DELETE = /\b(delete|remove|trash|discard|erase|destroy|empty (the )?trash|clear (all|history|data)|unsubscribe|cancel (my |your |the )?(subscription|account|order|membership|plan|booking|reservation)|close (my |your )?account|deactivate)\b/i;
const SIGN_IN = /\b(sign ?in|log ?in|login|continue with (google|apple|facebook|microsoft|github))\b/i;
const DOWNLOAD = /\b(download|install|get the app)\b/i;
const DOWNLOAD_FILE = /\.(dmg|pkg|exe|msi|zip|tar|gz|tgz|bz2|xz|7z|rar|iso|img|deb|rpm|apk|appimage|jar|crx|xpi)(\?|#|$)/i;
const ACCOUNT_ACTION = /\b(save( changes)?|apply|update|turn (on|off)|enable|disable|make (it )?(private|public)|change (my |your )?(email|username|name|privacy)|confirm)\b/i;
const SETTINGS_PATH = /\/(settings|account|preferences|privacy|profile\/edit|security|manage)(\/|$|\?|#)/i;
const GENERIC = /^\s*(confirm|ok|okay|yes|continue|proceed|done|accept|agree|next|go|apply|i agree|got it)\s*[.!]?\s*$/i;
const SUBMITS = /\b(submit|send request|request|book|reserve|register|sign ?up|create (an )?account|apply|join|enroll|rsvp)\b/i;
const PERSONAL = /\b(e-?mail|phone|mobile|tel|name|first name|last name|surname|address|street|city|postal|zip|birthday|date of birth|dob)\b/i;
const PERSONAL_AUTOCOMPLETE = /\b(name|given-name|family-name|email|tel|tel-national|street-address|address-line\d|address-level\d|postal-code|country|bday|organization)\b/;
const EMAIL = /[^\s@]+@[^\s@]+\.[^\s@]+/;
const PHONE = /\+?\d[\d\s().-]{6,}\d/;
const AMOUNT = /(?:[$€£¥₹]|\b(?:USD|EUR|GBP|CAD|AUD)\s?)\d[\d,]*(?:\.\d{2})?|\b\d[\d,]*(?:[.,]\d{2})?\s?(?:€|\b(?:USD|EUR|GBP|kr)\b)/;
const AMOUNT_ALL = new RegExp(AMOUNT.source, "g");

let siteKnown = null;

function clip(text, max = 160) {
  const value = String(text ?? "").replace(/\s+/g, " ").trim();
  return value.length > max ? value.slice(0, max - 1) + "…" : value;
}

function safe(value, max) {
  return clip(redactText(String(value ?? "")).text, max);
}

function l10n() {
  return new Localization(["browser/whimsy.ftl"], true);
}

function hostOf(url) {
  try {
    return Services.io.newURI(String(url)).host;
  } catch {
    return "";
  }
}

function fileName(href, download) {
  if (typeof download == "string" && download.trim()) {
    return clip(download, 80);
  }
  try {
    const path = Services.io.newURI(String(href)).filePath;
    return clip(decodeURIComponent(path.split("/").pop() || ""), 80);
  } catch {
    return "";
  }
}

// The amount a control would pay: in its own label first, then a "total"
// line near it, then the last amount near it.
function amountOf(target) {
  const own = String(target.text ?? "").match(AMOUNT)?.[0];
  if (own) {
    return own.trim();
  }
  const lines = String(target.context ?? "").split(/\n/);
  const total = lines.find(line => /\btotal\b/i.test(line) && AMOUNT.test(line));
  if (total) {
    return total.match(AMOUNT)[0].trim();
  }
  const all = String(target.context ?? "").match(AMOUNT_ALL);
  return all?.at(-1)?.trim() ?? null;
}

function isSearchForm(form) {
  if (!form) {
    return false;
  }
  if (form.role == "search") {
    return true;
  }
  const fields = form.fields?.filter(f => !["hidden", "submit", "button"].includes(f.type)) ?? [];
  return fields.length == 1 && (fields[0].type == "search" || /\b(q|query|search|s|keywords?)\b/i.test(fields[0].name ?? ""));
}

function isSignInForm(form) {
  return !!form?.fields?.some(f => f.kind == "password") && form.fields.length <= 4;
}

function personal(target) {
  const autocomplete = String(target.autocomplete ?? "").toLowerCase();
  const value = String(target.value ?? "");
  return PERSONAL_AUTOCOMPLETE.test(autocomplete) || PERSONAL.test(String(target.label ?? target.text ?? "")) ||
    EMAIL.test(value) || (PHONE.test(value) && !/\bsearch\b/i.test(String(target.label ?? "")));
}

function controlText(target) {
  return String(target.text ?? target.label ?? "").trim();
}

// A press: a click on the control, or Enter (or ⌘Return) that submits it.
function pressKind(target) {
  const text = controlText(target);
  const context = `${target.heading ?? ""}\n${target.context ?? ""}`;
  const form = target.form ?? null;
  const settings = !!target.settingsPage || SETTINGS_PATH.test(String(target.url ?? ""));
  if (target.captcha) {
    return "captcha";
  }
  const signIn = isSignInForm(form) && SIGN_IN.test(`${text} ${form?.submitText ?? ""}`);
  if (!signIn && (SECURITY.test(text) || (settings && SECURITY.test(`${target.heading ?? ""}`)))) {
    return "security";
  }
  if (/\b(forgot|reset|change) (your |my )?password\b/i.test(text)) {
    return "security";
  }
  if (DOWNLOAD_FILE.test(String(target.href ?? "")) || target.download != null && target.role == "link") {
    return "download";
  }
  if (target.role == "link" && !target.submits) {
    return null;
  }
  if (PAY.test(text) && !NOT_PAY.test(text)) {
    return "pay";
  }
  if (DELETE.test(text)) {
    return "delete";
  }
  if (SEND.test(text) && !/\bshare (this|link)\b/i.test(text)) {
    return "send";
  }
  if (signIn || SIGN_IN.test(text)) {
    return "sign-in";
  }
  if (settings && (ACCOUNT_ACTION.test(text) || ["switch", "checkbox", "radio"].includes(target.role))) {
    return "account";
  }
  if (DOWNLOAD.test(text) && target.role != "link") {
    return "download";
  }
  const money = !!amountOf({ text, context }) || !!form?.fields?.some(f => f.kind == "card");
  if ((GENERIC.test(text) || (!text && target.role == "button")) && (money || settings)) {
    return "unsure";
  }
  if (target.submits && form && !isSearchForm(form)) {
    return "submit";
  }
  if (!target.submits && form && !isSearchForm(form) && SUBMITS.test(text)) {
    return "submit";
  }
  return null;
}

function field(l10nId, value, extra = {}) {
  return { l10nId, label: l10n().formatValueSync(l10nId), value: safe(value, 200), ...extra };
}

function formFields(form, max = 8) {
  const out = [];
  for (const f of form?.fields ?? []) {
    if (["hidden", "submit", "button", "reset", "image"].includes(f.type)) {
      continue;
    }
    if (f.kind) {
      out.push({ label: safe(f.label || f.name, 60), value: "", hidden: true, sensitive: f.kind });
    } else if (String(f.value ?? "").trim()) {
      out.push({ label: safe(f.label || f.name, 60), value: safe(f.value, 200), guessed: !!f.guessed });
    }
    if (out.length >= max) {
      break;
    }
  }
  return out;
}

function preview(kind, target, host, { amount, file } = {}) {
  const bundle = l10n();
  const button = clip(controlText(target) || target.form?.submitText || "", 60);
  const args = { host, amount: amount ?? "", button, file: file ?? "" };
  const titleId = `whimsy-agent-pause-${kind == "pay" && !amount ? "pay-plain" : kind}`;
  const out = {
    title: bundle.formatValueSync(titleId, args),
    titleL10n: { id: titleId, args },
    fields: [],
    press: button,
  };
  const fields = out.fields;
  switch (kind) {
    case "pay":
      fields.push(field("whimsy-agent-field-pay", host));
      if (amount) {
        fields.push(field("whimsy-agent-field-total", amount, { strong: true }));
        out.amount = amount;
      }
      fields.push(...formFields(target.form));
      if (target.form?.fields?.some(f => f.kind == "card") || target.cardOnPage) {
        fields.push(field("whimsy-agent-field-card", "", { hidden: true, sensitive: "card",
          note: bundle.formatValueSync("whimsy-agent-hidden-card") }));
      }
      break;
    case "send":
      fields.push(...formFields(target.form));
      if (!fields.length && target.context) {
        fields.push(field("whimsy-agent-field-message", target.context));
      }
      break;
    case "delete":
      fields.push(field("whimsy-agent-field-site", host));
      fields.push(field("whimsy-agent-field-button", button));
      if (target.heading) {
        fields.push(field("whimsy-agent-field-from", target.heading));
      }
      break;
    case "account":
    case "security":
      fields.push(field("whimsy-agent-field-site", host));
      fields.push(field("whimsy-agent-field-setting", [target.heading, target.label || button].filter(Boolean).join(" › ")));
      if (target.checked != null) {
        fields.push(field("whimsy-agent-field-change", bundle.formatValueSync(target.checked ? "whimsy-agent-change-on-off" : "whimsy-agent-change-off-on")));
      }
      break;
    case "sign-in": {
      fields.push(field("whimsy-agent-field-site", host));
      const account = target.form?.fields?.find(f => !f.kind && /\b(e-?mail|user|login|account|number)\b/i.test(`${f.label} ${f.name}`) && f.value);
      if (account) {
        fields.push(field("whimsy-agent-field-account", account.value));
      }
      fields.push(field("whimsy-agent-field-password", "", { hidden: true, sensitive: "password",
        note: bundle.formatValueSync("whimsy-agent-hidden-password") }));
      fields.push(field("whimsy-agent-field-then", bundle.formatValueSync("whimsy-agent-then-code")));
      break;
    }
    case "download":
      fields.push(field("whimsy-agent-field-file", file || button));
      fields.push(field("whimsy-agent-field-from", hostOf(target.href) || host));
      fields.push(field("whimsy-agent-field-then", bundle.formatValueSync("whimsy-agent-then-download")));
      break;
    case "submit":
      fields.push(field("whimsy-agent-field-to", host));
      fields.push(...formFields(target.form));
      break;
    case "new-site-data":
      fields.push(field("whimsy-agent-field-site", host, { note: bundle.formatValueSync("whimsy-agent-new-site") }));
      fields.push(field("whimsy-agent-field-will-type",
        bundle.formatValueSync("whimsy-agent-will-type", { value: safe(target.value, 80), field: clip(target.label || target.name, 40) })));
      break;
    case "unsure":
      fields.push(field("whimsy-agent-field-site", host));
      fields.push(field("whimsy-agent-field-button", target.heading ? `“${button}”, ${clip(target.heading, 60)}` : `“${button}”`));
      if (amount) {
        fields.push(field("whimsy-agent-field-could-be", amount));
        out.amount = amount;
      }
      break;
    case "captcha":
      fields.push(field("whimsy-agent-field-site", host));
      break;
  }
  return out;
}

export const WhimsyAgentGuard = {
  KINDS,
  WAITING_TEXT,
  holdMs: HOLD_MS,

  /**
   * What an action would do, or null when it's free to go ahead.
   *
   * @param {"click"|"key"|"type"|"form_input"} action
   * @param {object} target from Claude:Describe: {role, text, label, form?,
   *   href?, download?, inputTypes[], sensitive?, captcha?, submits?,
   *   context?, heading?, url, value?, newSite?, keys?}
   * @returns {null|{kind: string, preview: object, handOver?: boolean, host: string}}
   */
  classify(action, target = {}) {
    const host = target.host || hostOf(target.url) || "";
    let kind = null;
    let handOver = false;
    if (action == "click" || (action == "key" && target.submits)) {
      kind = pressKind(target);
    } else if (action == "type" || action == "form_input") {
      if (target.captcha) {
        kind = "captcha";
      } else if (target.sensitive) {
        // Card, password, and code fields are always the person's to fill.
        kind = target.sensitive == "card" ? "pay" : "sign-in";
        handOver = true;
      } else if (target.newSite && personal(target)) {
        kind = "new-site-data";
      } else if (action == "form_input" && ["switch", "checkbox", "radio"].includes(target.role) &&
        (target.settingsPage || SETTINGS_PATH.test(String(target.url ?? "")))) {
        kind = SECURITY.test(`${target.label} ${target.heading}`) ? "security" : "account";
      }
    }
    if (!kind) {
      return null;
    }
    if (kind == "security") {
      handOver = true;
    }
    const amount = kind == "pay" || kind == "unsure" ? amountOf(target) : null;
    const file = kind == "download" ? fileName(target.href, target.download) : null;
    const result = { kind, host, preview: preview(kind, target, host, { amount, file }) };
    if (handOver) {
      result.handOver = true;
      result.preview.reason = target.sensitive ?? "security";
    }
    return result;
  },

  /** Whether the person has used `host` before today (Places history). */
  async isKnownSite(host) {
    if (!host) {
      return true;
    }
    if (siteKnown) {
      return siteKnown(host);
    }
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    const db = await lazy.PlacesUtils.promiseDBConnection();
    const rows = await db.executeCached(
      `SELECT 1 FROM moz_historyvisits v
       JOIN moz_places h ON h.id = v.place_id
       JOIN moz_origins o ON o.id = h.origin_id
       WHERE o.host IN (:host, :www) AND v.visit_date < :before LIMIT 1`,
      { host, www: host.startsWith("www.") ? host.slice(4) : `www.${host}`, before: startOfDay.getTime() * 1000 }
    );
    return rows.length > 0;
  },

  /**
   * Waits for the person's choice on `pause`: "do", "self", "skip", "stop",
   * or "waiting" once `holdMs` passes (outside apps only).
   */
  awaitDecision(task, pause, { holdMs = 0 } = {}) {
    return lazy.WhimsyAgentTasks.wait(task, pause, { holdMs });
  },

  // Tests: whether a site counts as known.
  _setSiteKnownForTesting(fn) {
    siteKnown = fn;
  },
};
