/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// W28 verification codes: the math and the parsing (WhimsyTOTP.sys.mjs).
// RFC 6238's own test vectors for all three hashes, base32's edge cases,
// and otpauth:// parsing, including the malformed input a page's QR code
// could carry.

const {
  base32Decode,
  normalizeSecret,
  totp,
  secondsLeft,
  fillCode,
  groupCode,
  parseOtpauth,
  buildOtpauth,
  normalizeSite,
} = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyTOTP.sys.mjs");
const { isCodeField, looksLikeSetupUri } = ChromeUtils.importESModule(
  "resource:///modules/whimsy/WhimsyTOTPChild.sys.mjs"
);

function base32(text) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const bytes = new TextEncoder().encode(text);
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += alphabet[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    out += alphabet[(value << (5 - bits)) & 31];
  }
  return out;
}

add_task(async function rfc6238_vectors() {
  const seeds = {
    SHA1: "12345678901234567890",
    SHA256: "12345678901234567890123456789012",
    SHA512: "1234567890123456789012345678901234567890123456789012345678901234",
  };
  // RFC 6238 Appendix B.
  const vectors = [
    [59, "94287082", "46119246", "90693936"],
    [1111111109, "07081804", "68084774", "25091201"],
    [1111111111, "14050471", "67062674", "99943326"],
    [1234567890, "89005924", "91819424", "93441116"],
    [2000000000, "69279037", "90698825", "38618901"],
    [20000000000, "65353130", "77737706", "47863826"],
  ];
  for (const [time, sha1, sha256, sha512] of vectors) {
    for (const [algorithm, want] of [["SHA1", sha1], ["SHA256", sha256], ["SHA512", sha512]]) {
      const entry = { secret: base32(seeds[algorithm]), algorithm, digits: 8, period: 30 };
      is(await totp(entry, time * 1000), want, `${algorithm} at ${time}`);
    }
  }
  // Six digits is the last six of the same number.
  const six = { secret: base32(seeds.SHA1), algorithm: "SHA1", digits: 6, period: 30 };
  is(await totp(six, 59_000), "287082", "Six digits");
});

add_task(async function countdown_and_rollover() {
  const entry = { secret: "JBSWY3DPEHPK3PXP", algorithm: "SHA1", digits: 6, period: 30 };
  is(secondsLeft(entry, 30_000), 30, "A fresh step has the whole period");
  is(secondsLeft(entry, 59_000), 1, "One second left");
  const early = await fillCode(entry, 31_000);
  is(early.code, await totp(entry, 31_000), "With time left, the current code");
  is(early.seconds, 29, "and its seconds");
  const late = await fillCode(entry, 56_000);
  is(late.code, await totp(entry, 60_000), "Under 5 seconds left, the next code");
  is(late.seconds, 34, "good for the rest of this step and all of the next");
  is(groupCode("481920"), "481 920", "Six digits group 3 and 3");
  is(groupCode("12345678"), "1234 5678", "Eight group 4 and 4");
});

add_task(async function base32_edges() {
  is(base32Decode("JBSWY3DPEHPK3PXP").length, 10, "Ten bytes");
  is(base32Decode("jbsw y3dp-ehpk 3pxp====").length, 10, "Spaces, dashes, padding, and lower case");
  is(base32Decode("JBSW1Y3DP"), null, "1 isn't base32");
  is(base32Decode(""), null, "Empty");
  is(base32Decode("A".repeat(600)), null, "Too long");
  is(base32Decode(null), null, "Not a string");
  is(normalizeSecret("jbsw y3dp ehpk 3pxp"), "JBSWY3DPEHPK3PXP", "Normalized");
  is(normalizeSecret("JBSWY3DP"), null, "Five bytes is too short a key");
  is(normalizeSecret("A".repeat(220)), null, "Over 128 bytes is too long");
});

add_task(async function otpauth_parsing() {
  const full = parseOtpauth("otpauth://totp/GitHub:octocat?secret=JBSWY3DPEHPK3PXP&issuer=GitHub");
  Assert.deepEqual(full, {
    issuer: "GitHub",
    account: "octocat",
    secret: "JBSWY3DPEHPK3PXP",
    algorithm: "SHA1",
    digits: 6,
    period: 30,
  }, "Issuer prefix and parameter");
  is(parseOtpauth("otpauth://totp/octocat%40example.com?secret=JBSWY3DPEHPK3PXP").account, "octocat@example.com",
    "No issuer: the label is the account, percent-decoded");
  is(parseOtpauth("otpauth://totp/Acme:me?secret=JBSWY3DPEHPK3PXP").issuer, "Acme", "Issuer from the label alone");
  const odd = parseOtpauth("OTPAUTH://TOTP/x?secret=JBSWY3DPEHPK3PXP&digits=8&period=60&algorithm=sha512");
  is(odd.digits, 8, "Eight digits");
  is(odd.period, 60, "A 60-second period");
  is(odd.algorithm, "SHA512", "SHA-512");
  const round = parseOtpauth(buildOtpauth({ ...full, account: "a:b c" }));
  is(round.account, "a:b c", "Built URIs parse back (an account with a colon and a space)");
  is(round.issuer, "GitHub", "with the issuer");

  const bad = [
    ["otpauth://hotp/x?secret=JBSWY3DPEHPK3PXP&counter=1", "hotp"],
    ["otpauth://totp/x", "no key"],
    ["otpauth://totp/x?secret=JBSWY3DP", "a short key"],
    ["otpauth://totp/x?secret=NOT-BASE32!", "a key that isn't base32"],
    ["otpauth://totp/x?secret=JBSWY3DPEHPK3PXP&digits=9", "nine digits"],
    ["otpauth://totp/x?secret=JBSWY3DPEHPK3PXP&digits=six", "digits that aren't a number"],
    ["otpauth://totp/x?secret=JBSWY3DPEHPK3PXP&period=0", "a zero period"],
    ["otpauth://totp/x?secret=JBSWY3DPEHPK3PXP&period=301", "a period over 300"],
    ["otpauth://totp/x?secret=JBSWY3DPEHPK3PXP&algorithm=MD5", "MD5"],
    ["otpauth://totp/x?secret=JBSWY3DPEHPK3PXP&secret=GEZDGNBVGY3TQOJQ", "two keys"],
    ["otpauth://totp/%E0%A4%A?secret=JBSWY3DPEHPK3PXP", "a broken percent escape"],
    ["otpauth://totp/a%0Ab?secret=JBSWY3DPEHPK3PXP", "a newline in the account"],
    ["otpauth://totp/a\u0000b?secret=JBSWY3DPEHPK3PXP", "a null"],
    [`otpauth://totp/${"a".repeat(300)}?secret=JBSWY3DPEHPK3PXP`, "an account over 256 characters"],
    [`otpauth://totp/x?secret=JBSWY3DPEHPK3PXP&issuer=${"a".repeat(2100)}`, "over 2048 characters"],
    ["https://example.com/?secret=JBSWY3DPEHPK3PXP", "a web link"],
    [42, "not a string"],
  ];
  for (const [uri, why] of bad) {
    is(parseOtpauth(uri), null, `Rejects ${why}`);
  }
  ok(looksLikeSetupUri("otpauth://totp/x?secret=A"), "The page side sends otpauth://totp/ only");
  ok(!looksLikeSetupUri("WIFI:S:home;T:WPA;P:secret;;"), "not a Wi-Fi code");
  ok(!looksLikeSetupUri("otpauth://totp/" + "a".repeat(2100)), "nor anything over 2048 characters");
});

add_task(async function sites() {
  is(normalizeSite("GitHub.com"), "github.com", "Lower case");
  is(normalizeSite("https://accounts.google.com/signin"), "accounts.google.com", "From a URL");
  is(normalizeSite("not a site"), null, "Spaces");
  is(normalizeSite(""), null, "Empty");
  is(normalizeSite("a|b.com"), null, "The record's separator");
});

add_task(async function code_fields() {
  const doc = document.implementation.createHTMLDocument("t");
  const field = attrs => {
    const input = doc.createElement("input");
    for (const [k, v] of Object.entries(attrs)) {
      input.setAttribute(k, v);
    }
    doc.body.append(input);
    return input;
  };
  ok(isCodeField(field({ autocomplete: "one-time-code" })), "autocomplete=one-time-code");
  ok(isCodeField(field({ name: "otp", maxlength: "6" })), "A short field named otp");
  ok(isCodeField(field({ type: "tel", "aria-label": "Two-factor code", inputmode: "numeric" })), "A numeric 2FA field");
  ok(!isCodeField(field({ name: "verification_code" })), "Not without being short or numeric");
  ok(!isCodeField(field({ name: "promo_verification", maxlength: "8" })), "Not a promo field");
  ok(!isCodeField(field({ name: "otp", maxlength: "6", autocomplete: "email" })), "Not an email field");
  ok(!isCodeField(field({ type: "password", autocomplete: "one-time-code" })), "Not a password field");
  ok(!isCodeField(field({ name: "postal", maxlength: "5", inputmode: "numeric" })), "Not a postal code");
});
