/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// wave7/focus: paste guard.
//
// Pasting an API key into a chat box, an issue or a support form is how
// most keys leak (GitHub's and AWS's secret scanning exist because of it).
// Before a paste reaches a web page, Whimsy looks at the text once; if it
// looks like a secret (an API key with a known prefix, a private key, a
// card number, a sign-in token) and the field isn't that service's own
// password field, a small sheet by the field asks "This looks like an
// OpenAI API key. Paste into example.com?" with Cancel as the default.
//
// Privacy: the text is read only inside the page's process, only for the
// paste in progress, only up to 10 KB, and is never logged, stored or sent
// anywhere; the parent learns the kind of secret and nothing else.
//
// Ordinary text stays quiet: every pattern needs its exact prefix and
// length, keys must mix letters and digits, and a card number counts only
// when the whole paste is one Luhn-valid number (and never into a field
// that asks for a card).
//
// This module is shared by both processes: the detector runs in the page's
// process (WhimsyPasteGuardChild); the command runs in the parent.

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  WhimsyCommands: "resource:///modules/whimsy/WhimsyCommands.sys.mjs",
});

const FEATURE_PREF = "whimsy.feature.paste-guard";
// The person's own on/off (the command); the feature switch is the master.
const ENABLED_PREF = "whimsy.paste-guard.enabled";
const ICON = "chrome://browser/skin/zen-icons/selectable/key.svg";

export const MAX_LENGTH = 10 * 1024;

// Letters and digits both: real keys are random, words with a prefix aren't.
function mixed(token) {
  return /[0-9]/.test(token) && /[A-Za-z]/.test(token);
}

// First match wins, so a more specific prefix comes before a looser one
// (Anthropic's "sk-ant-" before OpenAI's "sk-").
const PATTERNS = [
  { kind: "private-key", rx: /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/ },
  { kind: "anthropic", rx: /(?<![\w-])sk-ant-[a-z0-9]{2,12}-[A-Za-z0-9_-]{32,}/, check: mixed },
  { kind: "openai", rx: /(?<![\w-])sk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{32,}(?![\w-])/, check: mixed },
  { kind: "github", rx: /(?<!\w)(?:gh[pousr]_[A-Za-z0-9]{36,255}|github_pat_[A-Za-z0-9_]{60,255})(?!\w)/ },
  { kind: "aws", rx: /(?<![A-Za-z0-9])(?:AKIA|ASIA)[A-Z0-9]{16}(?![A-Za-z0-9])/, check: mixed },
  { kind: "slack", rx: /(?<![\w-])xox[abposr]-\d{6,}-[A-Za-z0-9-]{10,}/ },
  { kind: "stripe", rx: /(?<!\w)(?:sk|rk)_live_[A-Za-z0-9]{20,}(?!\w)/, check: mixed },
  { kind: "google", rx: /(?<![\w-])AIza[0-9A-Za-z_-]{35}(?![\w-])/ },
  { kind: "jwt", rx: /(?<![\w-])eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{16,}(?![\w-])/ },
];

// Where each kind belongs: the issuer's own sign-in and console hosts,
// matched exactly. Never a whole domain: some (amazonaws.com via S3,
// googleapis.com via Cloud Storage) serve anyone's pages, so a phishing
// login there must still ask.
const HOMES = {
  openai: ["platform.openai.com", "auth.openai.com"],
  anthropic: ["console.anthropic.com", "platform.claude.com", "claude.ai"],
  github: ["github.com"],
  aws: ["signin.aws.amazon.com", "console.aws.amazon.com"],
  slack: ["slack.com", "app.slack.com"],
  stripe: ["dashboard.stripe.com"],
  google: ["accounts.google.com", "console.cloud.google.com"],
};

function luhn(digits) {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = digits.charCodeAt(digits.length - 1 - i) - 48;
    if (i % 2 == 1) {
      d *= 2;
      if (d > 9) {
        d -= 9;
      }
    }
    sum += d;
  }
  return sum % 10 == 0;
}

// Card networks by prefix and length, so an order or tracking number that
// happens to pass Luhn rarely counts.
const NETWORKS = [
  { rx: /^4/, lengths: [13, 16, 19] }, // Visa
  { rx: /^(?:5[1-5]|2(?:2[2-9]|[3-6]\d|7[01]|720))/, lengths: [16] }, // Mastercard
  { rx: /^3[47]/, lengths: [15] }, // American Express
  { rx: /^(?:6011|65|64[4-9])/, lengths: [16, 19] }, // Discover
  { rx: /^35(?:2[89]|[3-8]\d)/, lengths: [16, 19] }, // JCB
  { rx: /^3(?:0[0-5]|[68])/, lengths: [14] }, // Diners Club
];

// The whole paste is one card number: 13-19 digits, optionally grouped
// with single spaces or dashes, a card network's prefix and length, not
// one repeated digit, and Luhn-valid.
export function isCardNumber(text) {
  const trimmed = text.trim();
  if (trimmed.length > 23 || !/^\d(?:[ -]?\d){12,18}$/.test(trimmed)) {
    return false;
  }
  const digits = trimmed.replace(/[ -]/g, "");
  return (
    NETWORKS.some(n => n.rx.test(digits) && n.lengths.includes(digits.length)) &&
    !/^(\d)\1+$/.test(digits) &&
    luhn(digits)
  );
}

/**
 * What kind of secret the text looks like, or null. Reads at most
 * MAX_LENGTH characters; longer text is left alone (a secret pasted on
 * its own is short).
 *
 * @param {string} text
 * @returns {string|null}
 */
export function detectSecret(text) {
  if (typeof text != "string" || !text || text.length > MAX_LENGTH) {
    return null;
  }
  for (const { kind, rx, check } of PATTERNS) {
    const match = rx.exec(text);
    if (match && (!check || check(match[0]))) {
      return kind;
    }
  }
  return isCardNumber(text) ? "card" : null;
}

/** Whether `host` is exactly one of the hosts this kind of secret belongs to. */
export function isHome(kind, host) {
  host = (host ?? "").toLowerCase().replace(/\.$/, "");
  return !!host && (HOMES[kind] ?? []).includes(host);
}

export const WhimsyPasteGuard = {
  FEATURE_PREF,
  ENABLED_PREF,

  get enabled() {
    return Services.prefs.getBoolPref(FEATURE_PREF, true);
  },

  // The feature is on and the person hasn't turned it off.
  get active() {
    return this.enabled && Services.prefs.getBoolPref(ENABLED_PREF, true);
  },

  toggle(win) {
    if (!this.enabled) {
      return;
    }
    const on = !Services.prefs.getBoolPref(ENABLED_PREF, true);
    Services.prefs.setBoolPref(ENABLED_PREF, on);
    win?.gZenUIManager?.showToast?.(
      on ? "whimsy-paste-guard-on-toast" : "whimsy-paste-guard-off-toast",
      on ? { descriptionId: "whimsy-paste-guard-on-toast-description" } : {}
    );
  },

  initWindow(win) {
    lazy.WhimsyCommands.register(win, {
      id: "cmd_whimsyPasteGuard",
      l10nId: "whimsy-action-paste-guard-toggle",
      run: w => this.toggle(w),
      icon: ICON,
      variants: [
        {
          l10nId: "whimsy-action-paste-guard-on",
          isAvailable: () => this.enabled && !this.active,
        },
        { l10nId: "whimsy-action-paste-guard-off", isAvailable: () => this.active },
      ],
    });
  },
};
