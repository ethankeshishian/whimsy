/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// W26 passkeys: Whimsy's own Touch ID passkeys, end to end through Gecko's
// WebAuthn (the real WebAuthnService, the real WhimsyPasskeyService and
// its patch, the real front end) with the Secure Enclave helper replaced by
// a WebCrypto stand-in, so no hardware and no Touch ID sheet. The fixture
// page (whimsy_passkeys_page.js) checks every answer as a site would.

const { WhimsyPasskeys, PasskeyError, AAGUID_STRING } = ChromeUtils.importESModule(
  "resource:///modules/whimsy/WhimsyPasskeys.sys.mjs"
);
const { WhimsyProfiles } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyProfiles.sys.mjs");
const { ContextualIdentityService } = ChromeUtils.importESModule(
  "moz-src:///toolkit/components/contextualidentity/ContextualIdentityService.sys.mjs"
);
// The store is OSKeyStore-encrypted; head.js gives this file its own throwaway
// Keychain item and deletes it after the cleanups, so nothing is set up here.

const ROOT = getRootDirectory(gTestPath).replace("chrome://mochitests/content", "https://example.com");
const PAGE = ROOT + "whimsy_passkeys.sjs";
const RP = "example.com";
const PROMPT = "whimsy-passkeys-prompt";
const AAGUID_HEX = AAGUID_STRING.replace(/-/g, "");

const tabs = new Set();
const spaces = [];
const profiles = [];
let home, defaultSpace, workSpace, workProfile;

// -- the stand-in for the helper -----------------------------------------------

function b64url(bytes) {
  return ChromeUtils.base64URLEncode(bytes, { pad: false });
}
function fromB64url(text) {
  return new Uint8Array(ChromeUtils.base64URLDecode(text, { padding: "ignore" }));
}
function rawToDer(raw) {
  const integer = bytes => {
    let start = 0;
    while (start < bytes.length - 1 && bytes[start] == 0) {
      start++;
    }
    let value = bytes.slice(start);
    if (value[0] & 0x80) {
      value = Uint8Array.from([0, ...value]);
    }
    return Uint8Array.from([0x02, value.length, ...value]);
  };
  const r = integer(raw.slice(0, 32));
  const s = integer(raw.slice(32));
  return Uint8Array.from([0x30, r.length + s.length, ...r, ...s]);
}

// mode: touch (the person verifies), cancel (dismissed or not recognised),
// bad-blob (a key from another Mac), wait (the sheet stays up until aborted).
const signer = {
  mode: "touch",
  calls: [],
  keys: new Map(),
  availability: { se: true, biometry: true, biometryType: "touchID" },
  async available() {
    return this.availability;
  },
  async _gate(signal) {
    if (this.mode == "cancel") {
      throw new PasskeyError("cancel");
    }
    if (this.mode == "wait") {
      await new Promise((_, reject) => signal.addEventListener("abort", () => reject(new PasskeyError("cancel")), { once: true }));
    }
  },
  async create({ reason, signal }) {
    this.calls.push({ op: "create", reason });
    await this._gate(signal);
    const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
    const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
    const blob = `stub-${this.keys.size}-${Math.random().toString(36).slice(2)}`;
    this.keys.set(blob, pair.privateKey);
    return { blob, x: fromB64url(jwk.x), y: fromB64url(jwk.y) };
  },
  async sign({ blob, message, reason, signal }) {
    this.calls.push({ op: "sign", reason });
    await this._gate(signal);
    const key = this.keys.get(blob);
    if (!key || this.mode == "bad-blob") {
      throw new PasskeyError("bad-blob");
    }
    const raw = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, message));
    return rawToDer(raw);
  },
};

// -- the page and the prompt ------------------------------------------------------

async function focusPage(browser) {
  const win = browser.documentGlobal;
  await SimpleTest.promiseFocus(win);
  browser.focus();
  await SpecialPowers.spawn(browser, [], () =>
    ContentTaskUtils.waitForCondition(() => content.document.hasFocus(), "The page has focus")
  );
}

async function openPage(userContextId = 0, win = window) {
  const tab = BrowserTestUtils.addTab(win.gBrowser, PAGE, { userContextId });
  tabs.add(tab);
  win.gBrowser.selectedTab = tab;
  await BrowserTestUtils.browserLoaded(tab.linkedBrowser, false, PAGE);
  await focusPage(tab.linkedBrowser);
  return tab;
}

// Starts a request in the page; the prompt is driven while it runs.
function request(browser, method, opts = {}) {
  return SpecialPowers.spawn(browser, [method, opts], (m, o) =>
    content.wrappedJSObject.passkey[m](Cu.cloneInto(o, content))
  );
}

function abortRequest(browser) {
  return SpecialPowers.spawn(browser, [], () => content.wrappedJSObject.passkey.abort());
}

function prompt(win = window) {
  return win.document.getElementById(PROMPT);
}

async function promptIn(state, win = window) {
  await TestUtils.waitForCondition(
    () => prompt(win)?.state == "open" && prompt(win).dataset.state == state,
    `The prompt shows ${state}`
  );
  // Fluent fills the new elements on the next refresh tick; a bad id or
  // argument would blank the whole batch (strict l10n), so a blank title
  // after that is re-translated by hand to surface the error.
  const panel = prompt(win);
  await TestUtils.waitForCondition(
    () => panel.querySelector(".whimsy-surface-title")?.textContent,
    `The ${state} prompt's title is translated`
  ).catch(async e => {
    await win.document.l10n.translateFragment(panel);
    throw e;
  });
  await whimsySettled(win.document);
  return prompt(win);
}

async function promptGone(win = window) {
  await TestUtils.waitForCondition(() => !prompt(win), "The prompt closed");
}

function press(id, win = window) {
  const button = win.document.getElementById(id);
  ok(button && !button.disabled, `#${id} is there to press`);
  EventUtils.synthesizeMouseAtCenter(button, {}, win);
}

function footerIds(win = window) {
  return [...prompt(win).querySelectorAll(".whimsy-surface-footer button")].map(b => b.id);
}

function labelOf(id, win = window) {
  const el = win.document.getElementById(id);
  return el?.getAttribute("label") || el?.textContent || "";
}

// Firefox's own WebAuthn prompts (authenticator-rs): the sign a request was
// handed to the security-key path.
async function watchNative(callback) {
  const prompts = [];
  const observer = (_subject, _topic, data) => {
    const type = JSON.parse(data).prompt.type;
    if (type != "cancel") {
      prompts.push(type);
    }
  };
  Services.obs.addObserver(observer, "webauthn-prompt");
  try {
    const value = await callback(prompts);
    await TestUtils.waitForTick();
    return { value, prompts };
  } finally {
    Services.obs.removeObserver(observer, "webauthn-prompt");
  }
}

// A request that goes to authenticator-rs waits for a security key that
// isn't there: the page aborts it once Firefox's prompt has appeared.
async function expectDelegated(browser, method, opts, label) {
  const { value, prompts } = await watchNative(async native => {
    const result = request(browser, method, opts);
    await TestUtils.waitForCondition(() => native.length > 0 || prompt(), `${label}: something asked`);
    await TestUtils.waitForTick();
    ok(!prompt(), `${label}: no Whimsy prompt`);
    await abortRequest(browser);
    return result;
  });
  Assert.greater(prompts.length, 0, `${label}: Firefox's security-key prompt ran (${prompts.join(", ")})`);
  is(value.ok, false, `${label}: the aborted request rejected`);
  return value;
}

async function records() {
  return WhimsyPasskeys.load();
}

// -- setup ----------------------------------------------------------------------------

add_setup(async function () {
  requestLongerTimeout(6);
  await SpecialPowers.pushPrefEnv({
    set: [
      ["whimsy.feature.passkeys", true],
      ["security.webauth.webauthn_enable_softtoken", false],
      ["security.webauth.webauthn_enable_usbtoken", true],
      ["security.webauthn.enable_conditional_mediation", true],
      // Its "Chat about your tabs" callout would sit in the prompt shots.
      ["whimsy.feature.ai-hints", false],
    ],
  });
  WhimsyPasskeys._signer = signer;
  WhimsyPasskeys.resetAvailability();
  WhimsyPasskeys.init();
  await WhimsyPasskeys.probe();
  ok(WhimsyPasskeys.available, "The stand-in says this Mac has a Secure Enclave");
  await WhimsyPasskeys.save([]);
  home = gZenWorkspaces.getActiveWorkspace();
  defaultSpace = await gZenWorkspaces.createAndSaveWorkspace("Passkeys Default", undefined, true, 0);
  spaces.push(defaultSpace);
  workProfile = WhimsyProfiles.create("Passkeys Work");
  profiles.push(workProfile);
  workSpace = await gZenWorkspaces.createAndSaveWorkspace("Passkeys Work", undefined, true, workProfile);
  spaces.push(workSpace);
  await gZenWorkspaces.changeWorkspace(defaultSpace);
  registerCleanupFunction(async () => {
    WhimsyPasskeys.cancel(0);
    for (const tab of tabs) {
      if (tab.isConnected && !tab.closing && tab.linkedBrowser?.webProgress) {
        try {
          await BrowserTestUtils.removeTab(tab);
        } catch (e) {
          info(`Closing a leftover tab: ${e}`);
        }
      }
    }
    await gZenWorkspaces.changeWorkspace(home);
    for (const space of spaces) {
      await gZenWorkspaces.removeWorkspace(space.uuid);
    }
    for (const id of profiles) {
      ContextualIdentityService.remove(id);
    }
    await WhimsyPasskeys.save([]);
    WhimsyPasskeys._signer = null;
    WhimsyPasskeys.resetAvailability();
  });
});

function fresh() {
  signer.mode = "touch";
  signer.calls = [];
  WhimsyPasskeys._cancels.clear();
}

// -- the tasks -------------------------------------------------------------------------

let mona; // the first passkey: { id, x, y }

// 0. Sites ask isUserVerifyingPlatformAuthenticatorAvailable() all the time.
// The parent asks Whimsy from a background thread; that used to crash.
add_task(async function uvpaa_from_the_page() {
  const tab = await openPage();
  for (const expected of [true, false]) {
    await SpecialPowers.pushPrefEnv({ set: [["whimsy.feature.passkeys", expected]] });
    const answers = await SpecialPowers.spawn(tab.linkedBrowser, [], () =>
      Promise.all(Array.from({ length: 5 }, () =>
        content.PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable())));
    Assert.deepEqual(answers, Array(5).fill(expected), `The page hears ${expected} with passkeys ${expected ? "on" : "off"}`);
    await SpecialPowers.popPrefEnv();
  }
});

// 1. create for a platform authenticator: P1, the sheet, a valid credential.
add_task(async function create_platform() {
  fresh();
  const tab = await openPage();
  const browser = tab.linkedBrowser;
  const result = request(browser, "create", { attachment: "platform" });
  const panel = await promptIn("create");
  is(panel.querySelector(".whimsy-surface-title").textContent, `Save a passkey for ${RP}?`, "P1 title names the site");
  ok(panel.querySelector(".whimsy-passkeys-text").textContent.includes("on this Mac only"), "P1 says the passkey lives on this Mac only");
  ok(panel.querySelector(".whimsy-passkeys-text").textContent.includes("Default profile"), "P1 names the profile");
  is(panel.querySelector(".whimsy-passkeys-account .whimsy-surface-row-label").textContent, "Mona Lisa Octocat", "P1 shows the account");
  Assert.deepEqual(footerIds(), ["whimsy-passkeys-cancel", "whimsy-passkeys-primary"], "A platform-only request offers no security key");
  is(labelOf("whimsy-passkeys-primary"), "Save with Touch ID", "The primary says what it does");
  is(document.activeElement?.id, "whimsy-passkeys-primary", "The primary button has focus");
  press("whimsy-passkeys-primary");
  const created = await result;
  await promptGone();
  ok(created.ok, `The site got a credential (${created.error ?? ""} ${created.message ?? ""})`);
  is(created.fmt, "none", "Attestation none");
  is(created.attStmtSize, 0, "An empty attestation statement");
  is(created.authData.flags, 0x45, "UP, UV and AT set; BE and BS clear");
  is(created.authData.counter, 0, "The counter is 0");
  is(created.authData.aaguid, AAGUID_HEX, "Whimsy's AAGUID survived");
  ok(created.rpIdHashMatches, "rpIdHash is SHA-256 of the RP ID");
  is(created.authData.credentialId, created.rawId, "The credential ID in authData is the one returned");
  is(created.authData.cose.alg, -7, "ES256");
  is(created.authData.cose.crv, 1, "P-256");
  is(created.extensions.credProps?.rk, true, "credProps says discoverable");
  is(created.attachment, "platform", "Attachment platform");
  Assert.deepEqual(created.transports, ["internal"], "Transport internal");
  is(created.clientData.type, "webauthn.create", "clientDataJSON is the parent's");
  is(signer.calls.length, 1, "One Touch ID sheet");
  is(signer.calls[0].reason, `save a passkey for ${RP}`, "The sheet's reason names only the validated site");
  const stored = await records();
  is(stored.length, 1, "One record stored");
  is(stored[0].rpId, RP, "Stored for the site");
  is(stored[0].profile, "default", "Stored in the Default profile");
  is(stored[0].displayName, "Mona Lisa Octocat", "Stored with the account's display name");
  mona = { id: created.rawId, x: created.authData.cose.x, y: created.authData.cose.y };
  BrowserTestUtils.removeTab(tab);
});

// 2. attachment left open: P1 offers a security key; choosing it hands the
//    request to authenticator-rs with no second Whimsy prompt.
add_task(async function create_unspecified_offers_security_key() {
  fresh();
  const tab = await openPage();
  const browser = tab.linkedBrowser;
  const { value, prompts } = await watchNative(async native => {
    const result = request(browser, "create", { userId: "BAUG", name: "hubot", displayName: "Hubot" });
    await promptIn("create");
    Assert.deepEqual(footerIds(), ["whimsy-passkeys-security-key", "whimsy-passkeys-cancel", "whimsy-passkeys-primary"], "Use a security key, Cancel, Save");
    press("whimsy-passkeys-security-key");
    await promptGone();
    await TestUtils.waitForCondition(() => native.length > 0, "Firefox's security-key prompt appeared");
    await abortRequest(browser);
    return result;
  });
  Assert.greater(prompts.length, 0, `Handed to authenticator-rs (${prompts.join(", ")})`);
  is(value.ok, false, "The aborted security-key request rejected");
  is(signer.calls.length, 0, "No Touch ID sheet");
  is((await records()).length, 1, "Nothing stored");
  BrowserTestUtils.removeTab(tab);
});

// 3. cross-platform: straight to authenticator-rs, no Whimsy prompt.
add_task(async function create_cross_platform_goes_to_authrs() {
  fresh();
  const tab = await openPage();
  await expectDelegated(tab.linkedBrowser, "create", { attachment: "cross-platform", userId: "BAUG" }, "cross-platform");
  is(signer.calls.length, 0, "No Touch ID sheet");
  BrowserTestUtils.removeTab(tab);
});

// 4. get with our ID in the allow list: P3, then a verified assertion.
add_task(async function get_with_allow_list() {
  fresh();
  const tab = await openPage();
  const browser = tab.linkedBrowser;
  const before = (await records())[0];
  is(before.lastUsed, 0, "Never used yet");
  const result = request(browser, "get", { allow: [mona.id], publicKey: mona });
  const panel = await promptIn("sign");
  is(panel.querySelector(".whimsy-surface-title").textContent, `Sign in to ${RP}`, "P3 title");
  is(panel.querySelector(".whimsy-passkeys-text").textContent, "Use Touch ID to sign in as Mona Lisa Octocat.", "P3 names the account");
  Assert.deepEqual(footerIds(), ["whimsy-passkeys-security-key", "whimsy-passkeys-cancel", "whimsy-passkeys-primary"], "P3 footer");
  is(labelOf("whimsy-passkeys-primary"), "Continue with Touch ID", "P3 primary");
  // Enter runs the primary, as in a sheet.
  EventUtils.synthesizeKey("KEY_Enter", {}, window);
  const got = await result;
  await promptGone();
  ok(got.ok, `The site got an assertion (${got.error ?? ""} ${got.message ?? ""})`);
  is(got.rawId, mona.id, "For the passkey it asked for");
  is(got.verified, true, "The ES256 signature verifies over authData ‖ SHA-256(clientDataJSON)");
  is(got.authData.flags, 0x05, "UP and UV; BE and BS clear");
  is(got.authData.counter, 0, "Counter 0");
  is(got.authData.length, 37, "No attested credential data on get");
  is(got.userHandle, "AQID", "The stored user handle comes back");
  is(got.attachment, "platform", "Attachment platform");
  is(signer.calls.at(-1).reason, `sign in to ${RP}`, "The sheet's reason");
  Assert.greater((await records())[0].lastUsed, 0, "lastUsed written");
  BrowserTestUtils.removeTab(tab);
});

// 5. a foreign allow list (the Apple Account, GitHub-with-YubiKey case):
//    not ours, so authenticator-rs untouched.
add_task(async function get_foreign_allow_list_goes_to_authrs() {
  fresh();
  const tab = await openPage();
  const foreign = b64url(crypto.getRandomValues(new Uint8Array(32)));
  await expectDelegated(tab.linkedBrowser, "get", { allow: [foreign] }, "foreign allow list");
  is(signer.calls.length, 0, "No Touch ID sheet");
  BrowserTestUtils.removeTab(tab);
});

// 6. discoverable get with several accounts: P4, most recently used first,
//    arrow keys move, Enter continues.
add_task(async function get_discoverable_chooses() {
  fresh();
  const tab = await openPage();
  const browser = tab.linkedBrowser;
  const others = [];
  for (const [userId, name, displayName] of [["BAUG", "hubot", "Hubot"], ["BwgJ", "mona-work", "Mona (work)"]]) {
    const result = request(browser, "create", { attachment: "platform", userId, name, displayName });
    await promptIn("create");
    press("whimsy-passkeys-primary");
    const created = await result;
    await promptGone();
    ok(created.ok, `Saved ${displayName}`);
    others.push({ id: created.rawId, x: created.authData.cose.x, y: created.authData.cose.y, displayName });
    await focusPage(browser);
  }
  is((await records()).length, 3, "Three passkeys for the site");
  const result = request(browser, "get", { allow: [], publicKey: others[0] });
  const panel = await promptIn("sign");
  const cards = [...panel.querySelectorAll(".whimsy-surface-choice")];
  is(cards.length, 3, "P4 lists every account");
  is(panel.querySelector(".whimsy-passkeys-text").textContent, "Choose an account", "P4 asks to choose");
  Assert.deepEqual(
    cards.map(c => c.querySelector(".whimsy-surface-choice-name").textContent),
    ["Mona (work)", "Hubot", "Mona Lisa Octocat"],
    "Most recently used first (the newest saves count as used)"
  );
  is(cards[0].getAttribute("aria-checked"), "true", "The first is picked");
  cards[0].focus();
  EventUtils.synthesizeKey("KEY_ArrowDown", {}, window);
  is(cards[1].getAttribute("aria-checked"), "true", "Arrow down picks the next");
  is(document.activeElement, cards[1], "and moves focus with it");
  EventUtils.synthesizeKey("KEY_Enter", {}, window);
  const got = await result;
  await promptGone();
  ok(got.ok, `Signed in (${got.error ?? ""})`);
  is(got.rawId, others[0].id, "With the chosen account's passkey");
  is(got.verified, true, "and its signature verifies");
  is(got.userHandle, "BAUG", "Its user handle");
  BrowserTestUtils.removeTab(tab);
});

// 7. excludeCredentials names ours: P8, OK, then InvalidStateError.
add_task(async function exclude_credentials_already_saved() {
  fresh();
  const tab = await openPage();
  const browser = tab.linkedBrowser;
  const result = request(browser, "create", { attachment: "platform", exclude: [mona.id] });
  const panel = await promptIn("exists");
  is(panel.querySelector(".whimsy-surface-title").textContent, `A passkey for ${RP} is already saved`, "P8 title");
  ok(panel.querySelector(".whimsy-passkeys-text").textContent.includes("Mona Lisa Octocat"), "P8 names the account");
  Assert.deepEqual(footerIds(), ["whimsy-passkeys-ok"], "OK only");
  press("whimsy-passkeys-ok");
  const created = await result;
  await promptGone();
  is(created.error, "InvalidStateError", "The site learns it only after OK");
  is(signer.calls.length, 0, "No Touch ID sheet");
  BrowserTestUtils.removeTab(tab);
});

// 8. the same account on the same site replaces its passkey.
add_task(async function same_user_replaces() {
  fresh();
  const tab = await openPage();
  const browser = tab.linkedBrowser;
  const result = request(browser, "create", { attachment: "platform", userId: "AQID", displayName: "Mona Again" });
  await promptIn("create");
  press("whimsy-passkeys-primary");
  const created = await result;
  await promptGone();
  ok(created.ok, "Saved again");
  const stored = await records();
  is(stored.length, 3, "Still three records");
  const monas = stored.filter(r => r.userHandle == "AQID");
  is(monas.length, 1, "One record for the user handle");
  is(monas[0].id, created.rawId, "The new credential replaced the old");
  is(monas[0].displayName, "Mona Again", "with the new display name");
  mona = { id: created.rawId, x: created.authData.cose.x, y: created.authData.cose.y };
  BrowserTestUtils.removeTab(tab);
});

// 9. profiles are kept apart: the Work profile never sees Default's passkeys.
add_task(async function profiles_are_isolated() {
  fresh();
  await gZenWorkspaces.changeWorkspace(workSpace);
  const tab = await openPage(workProfile);
  const browser = tab.linkedBrowser;
  is(tab.userContextId, workProfile, "The tab is in the Work profile");
  await expectDelegated(browser, "get", { allow: [mona.id] }, "Work: Default's passkey");
  await focusPage(browser);
  await expectDelegated(browser, "get", { allow: [] }, "Work: nothing discoverable");
  await focusPage(browser);
  const result = request(browser, "create", { attachment: "platform", userId: "AQID" });
  const panel = await promptIn("create");
  ok(panel.querySelector(".whimsy-passkeys-text").textContent.includes("Passkeys Work profile"), "P1 names the Work profile");
  press("whimsy-passkeys-primary");
  const created = await result;
  await promptGone();
  ok(created.ok, "Saved in Work");
  const stored = await records();
  is(stored.length, 4, "Four records: three Default, one Work");
  is(stored.filter(r => r.profile != "default").length, 1, "One belongs to Work");
  ok(stored.some(r => r.userHandle == "AQID" && r.profile == "default"), "Default's passkey for the same user stayed");
  BrowserTestUtils.removeTab(tab);
  await gZenWorkspaces.changeWorkspace(defaultSpace);
});

// 10. private windows: create is refused (P9), get works and writes nothing.
add_task(async function private_window() {
  fresh();
  const win = await BrowserTestUtils.openNewBrowserWindow({ private: true });
  try {
    const tab = await openPage(0, win);
    const browser = tab.linkedBrowser;
    let result = request(browser, "create", { attachment: "platform", userId: "DAwN" });
    let panel = await promptIn("private", win);
    is(panel.querySelector(".whimsy-surface-title").textContent, "Passkeys aren’t saved in private windows", "P9 title");
    Assert.deepEqual(footerIds(win), ["whimsy-passkeys-security-key", "whimsy-passkeys-cancel"], "P9: a security key, or Cancel");
    press("whimsy-passkeys-cancel", win);
    let created = await result;
    await promptGone(win);
    is(created.error, "NotAllowedError", "Refused");
    is(signer.calls.length, 0, "No Touch ID sheet");
    await focusPage(browser);
    const before = (await records()).find(r => r.id == mona.id).lastUsed;
    result = request(browser, "get", { allow: [mona.id], publicKey: mona });
    panel = await promptIn("sign", win);
    press("whimsy-passkeys-primary", win);
    const got = await result;
    await promptGone(win);
    ok(got.ok && got.verified, "Signing in with an existing passkey works in a private window");
    is((await records()).find(r => r.id == mona.id).lastUsed, before, "and writes no lastUsed");
  } finally {
    await BrowserTestUtils.closeWindow(win);
  }
});

// 11. no biometrics (P5), cancelled (P6), a key from another Mac (P7).
add_task(async function touch_id_unavailable_cancelled_and_bad_blob() {
  fresh();
  const tab = await openPage();
  const browser = tab.linkedBrowser;

  signer.availability = { se: true, biometry: false, biometryType: "touchID" };
  WhimsyPasskeys.resetAvailability();
  await WhimsyPasskeys.probe();
  let result = request(browser, "get", { allow: [mona.id], publicKey: mona });
  let panel = await promptIn("sign-password");
  is(panel.querySelector(".whimsy-passkeys-fallback span").textContent, "Touch ID isn’t available while the lid is closed. Your Mac password works instead.", "P5 amber line (lid closed)");
  is(labelOf("whimsy-passkeys-primary"), "Use Mac password", "P5 primary");
  press("whimsy-passkeys-primary");
  let got = await result;
  await promptGone();
  ok(got.ok && got.verified, "The password path signs the same way");

  signer.availability = { se: true, biometry: false, biometryType: "none" };
  WhimsyPasskeys.resetAvailability();
  await WhimsyPasskeys.probe();
  await focusPage(browser);
  result = request(browser, "get", { allow: [mona.id], publicKey: mona });
  panel = await promptIn("sign-password");
  is(panel.querySelector(".whimsy-passkeys-fallback span").textContent, "This Mac has no Touch ID. Your Mac password works instead.", "P5 amber line (no sensor)");
  press("whimsy-passkeys-cancel");
  got = await result;
  await promptGone();
  is(got.error, "NotAllowedError", "Cancel rejects");

  signer.availability = { se: true, biometry: true, biometryType: "touchID" };
  WhimsyPasskeys.resetAvailability();
  await WhimsyPasskeys.probe();
  await focusPage(browser);
  signer.mode = "cancel";
  result = request(browser, "get", { allow: [mona.id], publicKey: mona });
  panel = await promptIn("sign");
  press("whimsy-passkeys-primary");
  panel = await promptIn("cancelled");
  is(panel.querySelector(".whimsy-passkeys-status").textContent, "Didn’t sign in. Try again, or use another way.", "P6 line");
  is(labelOf("whimsy-passkeys-primary"), "Try again", "P6 primary");
  is(panel.querySelector(".whimsy-surface-title").textContent, `Sign in to ${RP}`, "P6 keeps the title");
  signer.mode = "touch";
  press("whimsy-passkeys-primary");
  got = await result;
  await promptGone();
  ok(got.ok && got.verified, "Try again signs in");
  is(signer.calls.filter(c => c.op == "sign").length, 3, "Each try was a fresh sheet (password, cancelled, try again)");

  await focusPage(browser);
  signer.mode = "bad-blob";
  result = request(browser, "get", { allow: [mona.id], publicKey: mona });
  panel = await promptIn("sign");
  press("whimsy-passkeys-primary");
  panel = await promptIn("error");
  is(panel.querySelector(".whimsy-surface-title").textContent, "This passkey can’t be used here", "P7 title");
  is(panel.querySelector(".whimsy-passkeys-status").textContent, "Saved on another Mac, or its key was removed.", "P7 line");
  ok(panel.querySelector(".whimsy-passkeys-text").textContent.includes("Settings → Privacy & Security → Passkeys"), "P7 points at Settings");
  is(panel.querySelector(".whimsy-surface-tile").getAttribute("tone"), "destructive", "P7 tile is destructive");
  Assert.deepEqual(footerIds(), ["whimsy-passkeys-security-key", "whimsy-passkeys-cancel"], "P7 has no primary");
  press("whimsy-passkeys-cancel");
  got = await result;
  await promptGone();
  is(got.error, "NotAllowedError", "Cancel rejects");
  signer.mode = "touch";
  BrowserTestUtils.removeTab(tab);
});

// 12. Esc, the page aborting, and the tab closing all tear the prompt and
//     the helper call down.
add_task(async function cancel_abort_and_teardown() {
  fresh();
  let tab = await openPage();
  let browser = tab.linkedBrowser;
  let result = request(browser, "get", { allow: [mona.id] });
  await promptIn("sign");
  EventUtils.synthesizeKey("KEY_Escape", {}, window);
  let got = await result;
  await promptGone();
  is(got.error, "NotAllowedError", "Esc cancels");

  await focusPage(browser);
  result = request(browser, "get", { allow: [mona.id] });
  await promptIn("sign");
  await abortRequest(browser);
  got = await result;
  await promptGone();
  is(got.error, "AbortError", "The page's abort closes the prompt");

  await focusPage(browser);
  signer.mode = "wait";
  result = request(browser, "get", { allow: [mona.id] });
  await promptIn("sign");
  press("whimsy-passkeys-primary");
  const waiting = await promptIn("waiting");
  ok(document.getElementById("whimsy-passkeys-primary").disabled, "The primary is disabled while the sheet is up");
  is(waiting.dataset.state, "waiting", "P2: the prompt waits behind the sheet");
  await abortRequest(browser);
  got = await result;
  await promptGone();
  is(got.error, "AbortError", "Aborting during the sheet rejects");
  signer.mode = "touch";

  await focusPage(browser);
  result = request(browser, "get", { allow: [mona.id] });
  await promptIn("sign");
  // The page goes with the tab, so its answer never arrives (the spawn
  // rejects with AbortError); that is the point, not a leak.
  const closed = result.catch(e => e);
  BrowserTestUtils.removeTab(tab);
  await promptGone();
  ok(true, "Closing the tab closes the prompt");
  await closed;
});

// 13. prompt spam: after three cancels in a minute the origin is refused
//     without a prompt.
add_task(async function back_off_after_cancels() {
  fresh();
  const tab = await openPage();
  const browser = tab.linkedBrowser;
  for (let i = 0; i < 3; i++) {
    await focusPage(browser);
    const result = request(browser, "get", { allow: [mona.id] });
    await promptIn("sign");
    press("whimsy-passkeys-cancel");
    is((await result).error, "NotAllowedError", `Cancel ${i + 1}`);
    await promptGone();
  }
  await focusPage(browser);
  const result = await request(browser, "get", { allow: [mona.id] });
  is(result.error, "NotAllowedError", "The fourth is refused");
  ok(!prompt(), "with no prompt");
  WhimsyPasskeys._cancels.clear();
  BrowserTestUtils.removeTab(tab);
});

// 14. the switch off: authenticator-rs for everything, as before.
add_task(async function feature_off_is_yesterday() {
  fresh();
  await SpecialPowers.pushPrefEnv({ set: [["whimsy.feature.passkeys", false]] });
  const tab = await openPage();
  try {
    ok(!WhimsyPasskeys.available, "Off means not available");
    await expectDelegated(tab.linkedBrowser, "get", { allow: [mona.id] }, "feature off");
    await focusPage(tab.linkedBrowser);
    // A platform-only create has nowhere to go without Whimsy: Firefox
    // refuses it at once, with no prompt of either kind (stock behaviour).
    const { value, prompts } = await watchNative(() =>
      request(tab.linkedBrowser, "create", { attachment: "platform", userId: "DAwN" }));
    is(value.ok, false, `feature off, create: refused (${value.error}: ${value.message})`);
    ok(!prompt(), "feature off, create: no Whimsy prompt");
    is(prompts.length, 0, "feature off, create: no security-key prompt either");
  } finally {
    // The switch must come back whatever happened above: the later tasks
    // (and Firefox's own prompts, left open by a delegated request) depend
    // on it.
    await SpecialPowers.popPrefEnv();
    BrowserTestUtils.removeTab(tab);
  }
  ok(WhimsyPasskeys.available, "and on again after");
});

// 15. conditional mediation: the login autocomplete gets this profile's
//     passkeys for the site, and picking one signs with no Whimsy prompt.
add_task(async function conditional_mediation_autofill() {
  fresh();
  const tab = await openPage();
  const browser = tab.linkedBrowser;
  const service = Cc["@mozilla.org/webauthn/service;1"].getService(Ci.nsIWebAuthnService);
  ok(WhimsyPasskeys.available, "Whimsy's passkeys are available");
  // The module's half on its own first, so a miss below says which half.
  const direct = await new Promise((resolve, reject) =>
    WhimsyPasskeys.getAutoFillEntries(RP, browser.browsingContext.id, [], { resolve, reject })
  );
  is(direct.length, 3, "The module lists Default's three for this tab");
  const result = request(browser, "get", { allow: [], mediation: "conditional", publicKey: mona });
  let tid = 0;
  await TestUtils.waitForCondition(() => {
    tid = service.hasPendingConditionalGet(browser.browsingContext.id, "https://example.com");
    return tid != 0;
  }, "The conditional request is pending");
  const entries = await new Promise((resolve, reject) => service.getAutoFillEntries(tid, { resolve, reject }));
  is(entries.length, 3, "Default's three passkeys are offered (not Work's)");
  const ours = entries.find(e => b64url(new Uint8Array(e.credentialId)) == mona.id);
  ok(ours, "including Mona's");
  is(ours.rpId, RP, "for the site");
  is(ours.userName, "mona", "with the user name");
  is(ours.provider, Ci.nsIWebAuthnAutoFillEntry.PROVIDER_PLATFORM_MACOS, "as a platform passkey");
  service.selectAutoFillEntry(tid, ours.credentialId);
  const got = await result;
  ok(!prompt(), "No Whimsy prompt after picking from the list");
  ok(got.ok && got.verified, `Signed in from the autocomplete entry (${got.error ?? ""})`);
  is(got.rawId, mona.id, "with the picked passkey");

  // Work's tab sees only its own.
  await gZenWorkspaces.changeWorkspace(workSpace);
  const work = await openPage(workProfile);
  const workResult = request(work.linkedBrowser, "get", { allow: [], mediation: "conditional" });
  let workTid = 0;
  await TestUtils.waitForCondition(() => {
    workTid = service.hasPendingConditionalGet(work.linkedBrowser.browsingContext.id, "https://example.com");
    return workTid != 0;
  }, "Work's conditional request is pending");
  const workEntries = await new Promise((resolve, reject) => service.getAutoFillEntries(workTid, { resolve, reject }));
  is(workEntries.length, 1, "Work sees one passkey");
  is(workEntries[0].userName, "mona", "its own");
  service.cancel(workTid);
  is((await workResult).ok, false, "cancelled");
  BrowserTestUtils.removeTab(work);
  await gZenWorkspaces.changeWorkspace(defaultSpace);
  BrowserTestUtils.removeTab(tab);
});

// 16. the prompt on screen: every state at the default width, light and
//     dark, with the contrast and truncation guards on P1.
add_task(async function screenshots_and_guards() {
  fresh();
  const tab = await openPage();
  const browser = tab.linkedBrowser;

  const srgb = color => {
    const canvas = document.createElementNS("http://www.w3.org/1999/xhtml", "canvas");
    canvas.width = canvas.height = 1;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = color;
    ctx.fillRect(0, 0, 1, 1);
    return [...ctx.getImageData(0, 0, 1, 1).data];
  };
  const luminance = ([r, g, b]) => {
    const lin = c => ((c /= 255) <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
    return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  };
  const contrast = (fg, bg) => {
    const [a, b] = [luminance(srgb(fg)), luminance(srgb(bg))].sort((x, y) => y - x);
    return (a + 0.05) / (b + 0.05);
  };
  const backgroundOf = el => {
    for (let node = el; node; node = node.parentElement ?? node.parentNode?.host ?? null) {
      const bg = node.nodeType == 1 ? node.ownerDocument.defaultView.getComputedStyle(node).backgroundColor : null;
      if (bg && srgb(bg)[3] == 255) {
        return bg;
      }
    }
    return "white";
  };

  const shoot = async (name, state, check = null) => {
    await whimsyBothSchemes(`w26-passkeys-${name}`, async dark => {
      const panel = await promptIn(state);
      await check?.(panel, dark ? "dark" : "light");
      return whimsyStandInPopups();
    });
  };

  const guards = (panel, scheme) => {
    const footer = panel.querySelector(".whimsy-surface-footer");
    const box = footer.getBoundingClientRect();
    const buttons = [...footer.querySelectorAll("button")];
    const rects = buttons.map(b => b.getBoundingClientRect());
    info(`${scheme}: footer ${Math.round(box.left)}-${Math.round(box.right)}; ` +
      buttons.map((b, i) => `${labelOf(b.id)} ${Math.round(rects[i].left)}-${Math.round(rects[i].right)}`).join(", "));
    // One line: the quiet text button is shorter than the real ones, so
    // compare their vertical centres, not their tops.
    const middles = rects.map(r => Math.round(r.top + r.height / 2));
    ok(middles.every(m => Math.abs(m - middles[0]) <= 1), `${scheme}: the footer is one line (${middles.join(", ")})`);
    // Nothing spills past the footer: all three fit on one line at 420px.
    Assert.greaterOrEqual(Math.min(...rects.map(r => r.left)), box.left - 1, `${scheme}: the first button starts in the footer`);
    Assert.lessOrEqual(Math.max(...rects.map(r => r.right)), box.right + 1, `${scheme}: the last button ends in the footer`);
    for (const [i, button] of buttons.entries()) {
      // A squeezed XUL button clips its label without growing scrollWidth,
      // so measure the text itself (a Range spans the glyphs, clipped or
      // not) against the label's box, and the label's box against the
      // button's.
      const label = button.querySelector(".button-text") ?? button;
      const range = label.ownerDocument.createRange();
      range.selectNodeContents(label);
      const text = range.getBoundingClientRect();
      const labelBox = label.getBoundingClientRect();
      Assert.lessOrEqual(text.width, labelBox.width + 1, `${scheme}: "${labelOf(button.id)}" isn't cut (text ${Math.round(text.width)} in ${Math.round(labelBox.width)})`);
      Assert.lessOrEqual(labelBox.right, rects[i].right + 1, `${scheme}: "${labelOf(button.id)}" stays inside its button`);
      Assert.greaterOrEqual(labelBox.left, rects[i].left - 1, `${scheme}: "${labelOf(button.id)}" starts inside its button`);
    }
    Assert.lessOrEqual(panel.getBoundingClientRect().width, 440, `${scheme}: the prompt keeps its 420px width`);
    for (const [name, el] of [
      ["title", panel.querySelector(".whimsy-surface-title")],
      ["text", panel.querySelector(".whimsy-passkeys-text")],
      ["status", panel.querySelector(".whimsy-passkeys-status")],
      ["account", panel.querySelector(".whimsy-surface-row-label")],
      ["security key", panel.ownerDocument.getElementById("whimsy-passkeys-security-key")],
      ["cancel", panel.ownerDocument.getElementById("whimsy-passkeys-cancel")],
      ["ok", panel.ownerDocument.getElementById("whimsy-passkeys-ok")],
      ["primary", panel.ownerDocument.getElementById("whimsy-passkeys-primary")],
    ]) {
      if (!el) {
        continue;
      }
      const ratio = contrast(el.ownerDocument.defaultView.getComputedStyle(el).color, backgroundOf(el));
      Assert.greaterOrEqual(ratio, 4.5, `${scheme}: ${name} contrast ${ratio.toFixed(2)}:1`);
    }
    // The tile's glyph reads on its tint in both themes (3:1, a graphic).
    const tile = panel.querySelector(".whimsy-surface-tile");
    if (tile) {
      const glyph = tile.ownerDocument.defaultView.getComputedStyle(tile).color;
      const ratio = contrast(glyph, backgroundOf(tile));
      Assert.greaterOrEqual(ratio, 3, `${scheme}: tile glyph contrast ${ratio.toFixed(2)}:1`);
    }
  };

  // P1 (with the security key offered), then P2 behind the sheet.
  signer.mode = "wait";
  let result = request(browser, "create", { userId: "DAwN", name: "octocat", displayName: "Mona Lisa Octocat" });
  await shoot("p1-create", "create", guards);
  press("whimsy-passkeys-primary");
  await shoot("p2-waiting", "waiting", guards);
  await abortRequest(browser);
  await result;
  await promptGone();
  signer.mode = "touch";

  // P3 one account, P6 cancelled, P7 error.
  await focusPage(browser);
  signer.mode = "cancel";
  result = request(browser, "get", { allow: [mona.id] });
  await shoot("p3-signin", "sign", guards);
  press("whimsy-passkeys-primary");
  await shoot("p6-cancelled", "cancelled", guards);
  signer.mode = "bad-blob";
  press("whimsy-passkeys-primary");
  await shoot("p7-error", "error", guards);
  press("whimsy-passkeys-cancel");
  await result;
  await promptGone();
  signer.mode = "touch";

  // P4 choose.
  await focusPage(browser);
  result = request(browser, "get", { allow: [] });
  await shoot("p4-choose", "sign", guards);
  press("whimsy-passkeys-cancel");
  await result;
  await promptGone();

  // P5 lid closed.
  signer.availability = { se: true, biometry: false, biometryType: "touchID" };
  WhimsyPasskeys.resetAvailability();
  await WhimsyPasskeys.probe();
  await focusPage(browser);
  result = request(browser, "get", { allow: [mona.id] });
  await shoot("p5-password", "sign-password", (panel, scheme) => {
    guards(panel, scheme);
    const line = panel.querySelector(".whimsy-passkeys-fallback span");
    const ratio = contrast(getComputedStyle(line).color, backgroundOf(line));
    Assert.greaterOrEqual(ratio, 4.5, `${scheme}: amber line contrast ${ratio.toFixed(2)}:1`);
  });
  press("whimsy-passkeys-cancel");
  await result;
  await promptGone();
  signer.availability = { se: true, biometry: true, biometryType: "touchID" };
  WhimsyPasskeys.resetAvailability();
  await WhimsyPasskeys.probe();

  // P8 already saved. The cancels above (P6, P7, P4, P5) tripped the
  // back-off for the site; this is a new request, not another cancel.
  fresh();
  await focusPage(browser);
  result = request(browser, "create", { attachment: "platform", exclude: [mona.id] });
  await shoot("p8-exists", "exists", guards);
  press("whimsy-passkeys-ok");
  await result;
  await promptGone();

  // P9 private window.
  const win = await BrowserTestUtils.openNewBrowserWindow({ private: true });
  try {
    const privateTab = await openPage(0, win);
    const privateResult = request(privateTab.linkedBrowser, "create", { userId: "DAwN" });
    // whimsyBothSchemes shoots the main window; this one is the private one.
    for (const dark of [false, true]) {
      await whimsySetScheme(dark);
      let cleanup = null;
      try {
        guards(await promptIn("private", win), dark ? "dark (private)" : "light (private)");
        cleanup = whimsyStandInPopups(win.document);
        await whimsySettled(win.document);
        await whimsyShot(`w26-passkeys-p9-private-${dark ? "dark" : "light"}`, win.browsingContext.currentWindowGlobal);
      } finally {
        cleanup?.();
        await SpecialPowers.popPrefEnv();
      }
    }
    press("whimsy-passkeys-cancel", win);
    await privateResult;
    await promptGone(win);
  } finally {
    await BrowserTestUtils.closeWindow(win);
  }
  BrowserTestUtils.removeTab(tab);
});

// The real helper ships where the front end looks for it (GreBinD, beside
// plugin-container.app); W27 found it built into Contents/Resources/browser,
// which broke packaging and left every build without Touch ID passkeys.
add_task(async function helper_is_bundled_beside_the_binary() {
  const file = Services.dirsvc.get("GreBinD", Ci.nsIFile);
  for (const part of ["whimsy-passkeys.app", "Contents", "MacOS", "whimsy-passkeys"]) {
    file.append(part);
  }
  ok(file.exists(), `the passkeys helper is at ${file.path}`);
  ok(file.isExecutable(), "the passkeys helper is executable");
});
