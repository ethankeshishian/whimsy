/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// W28 verification codes: Settings → Privacy & Security → Verification
// Codes. The rows (site, account, profile, date), Copy code (Touch ID once
// per session, then the code on the clipboard), Delete with Undo, and Add
// Code…, whose setup key field rejects a bad key.

const { WhimsyTOTP, STORE_ORIGIN, totp } = ChromeUtils.importESModule(
  "resource:///modules/whimsy/WhimsyTOTP.sys.mjs"
);
const { WhimsyProfiles } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyProfiles.sys.mjs");
const { WhimsyAuth } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyAuth.sys.mjs");
const { WhimsyUndo } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyUndo.sys.mjs");

const GITHUB = { issuer: "GitHub", account: "octocat", secret: "JBSWY3DPEHPK3PXP", algorithm: "SHA1", digits: 6, period: 30 };
const ACME = { issuer: "Acme", account: "me@example.com", secret: "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ", algorithm: "SHA1", digits: 6, period: 30 };
const NOW = 1_699_999_990_000; // 20 seconds left in its step

const realNow = WhimsyTOTP._now;
let asked = 0;

add_setup(async function () {
  await SpecialPowers.pushPrefEnv({ set: [["whimsy.feature.totp", true]] });
  WhimsyTOTP._now = () => NOW;
  WhimsyTOTP._unlocked = false;
  WhimsyAuth._reauthenticator = {
    asyncReauthenticateUser: async () => {
      asked++;
      return [true];
    },
  };
  registerCleanupFunction(async () => {
    WhimsyTOTP._now = realNow;
    WhimsyTOTP._unlocked = false;
    WhimsyAuth._reauthenticator = null;
    closeToasts();
    SpecialPowers.clipboardCopyString("");
    await removeCodes();
  });
});

async function removeCodes() {
  for (const login of await Services.logins.searchLoginsAsync({ origin: STORE_ORIGIN })) {
    await Services.logins.removeLoginAsync(login);
  }
  WhimsyTOTP._store.invalidate();
}

async function seed() {
  await removeCodes();
  for (const entry of [GITHUB, ACME]) {
    await WhimsyTOTP._store.save({
      site: entry == GITHUB ? "github.com" : "acme.example",
      profileKey: WhimsyProfiles.keyFor(0),
      profileName: WhimsyProfiles.nameOf(0),
      account: entry.account,
      entry,
    });
  }
}

function rows(doc) {
  return [...doc.querySelectorAll("#whimsyTotpList .whimsy-totp-row")];
}

async function withSettings(callback) {
  await BrowserTestUtils.withNewTab("about:preferences#privacy", async browser => {
    const doc = browser.contentDocument;
    const win = browser.contentWindow;
    await TestUtils.waitForCondition(() => doc.getElementById("whimsyTotpGroup") && !doc.getElementById("whimsyTotpGroup").hidden,
      "The Verification Codes card is shown");
    await callback(win, doc);
  });
}

async function listed(doc, count) {
  await TestUtils.waitForCondition(() => rows(doc).length == count, `${count} codes are listed`);
  await TestUtils.waitForCondition(() => rows(doc).every(row => row.querySelector(".whimsy-profile-meta").textContent),
    "Each row's line is translated");
}

add_task(async function rows_and_copy() {
  await seed();
  await withSettings(async (win, doc) => {
    await listed(doc, 2);
    ok(doc.getElementById("whimsyTotpEmpty").hidden, "No empty line");
    const sites = rows(doc).map(row => row.querySelector(".whimsy-profile-name").textContent).sort();
    Assert.deepEqual(sites, ["acme.example", "github.com"], "A row per site");
    const github = rows(doc).find(row => row.querySelector(".whimsy-profile-name").textContent == "github.com");
    const meta = github.querySelector(".whimsy-profile-meta").textContent;
    ok(meta.startsWith(`octocat · ${WhimsyProfiles.nameOf(0)} · Added `), `The account, profile, and date: ${meta}`);
    ok(!doc.getElementById("whimsyTotpGroup").textContent.includes(GITHUB.secret), "No key on the page");

    await whimsyBothSchemes("w28-totp-settings", async () => {
      doc.getElementById("whimsyTotpGroup").scrollIntoView();
    });

    // Copy code: Touch ID once, the code on the clipboard, and a toast.
    SpecialPowers.clipboardCopyString("");
    const code = await totp(GITHUB, NOW);
    const copy = github.querySelector(".whimsy-totp-copy");
    is(copy.label || copy.textContent, "Copy code", "Copy code");
    EventUtils.synthesizeMouseAtCenter(copy, {}, win);
    await TestUtils.waitForCondition(() => SpecialPowers.getClipboardData("text/plain") == code, "The code was copied");
    is(asked, 1, "Touch ID was asked");
    const toast = await TestUtils.waitForCondition(() => toastFor("whimsy-totp-copied-toast"), "The copied toast");
    ok(toast, "A toast says it changes soon");
    closeToasts();
    SpecialPowers.clipboardCopyString("");
    EventUtils.synthesizeMouseAtCenter(copy, {}, win);
    await TestUtils.waitForCondition(() => SpecialPowers.getClipboardData("text/plain") == code, "Copied again");
    is(asked, 1, "and not asked again this session");
    closeToasts();
    SpecialPowers.clipboardCopyString("");
  });
});

add_task(async function copy_cancelled() {
  await seed();
  WhimsyTOTP._unlocked = false;
  WhimsyAuth._reauthenticator = { asyncReauthenticateUser: async () => [false, false] };
  SpecialPowers.clipboardCopyString("");
  try {
    const [record] = await WhimsyTOTP.list();
    ok(!(await WhimsyTOTP.copyCode(window, record.guid)), "Cancelling Touch ID copies nothing");
    is(SpecialPowers.getClipboardData("text/plain"), "", "The clipboard is untouched");
    ok(!WhimsyTOTP._unlocked, "and the next Copy asks again");
  } finally {
    WhimsyAuth._reauthenticator = { asyncReauthenticateUser: async () => [true] };
  }
});

add_task(async function delete_and_undo() {
  await seed();
  await withSettings(async (win, doc) => {
    await listed(doc, 2);
    const github = rows(doc).find(row => row.querySelector(".whimsy-profile-name").textContent == "github.com");
    const remove = github.querySelector(".whimsy-totp-delete");
    await TestUtils.waitForCondition(() => remove.getAttribute("aria-label"), "The Delete button's label");
    is(remove.getAttribute("aria-label"), "Delete the verification code for github.com", "Delete names its site");
    const gone = TestUtils.waitForCondition(() => rows(doc).length == 1, "The row went");
    EventUtils.synthesizeMouseAtCenter(remove, {}, win);
    await gone;
    is((await WhimsyTOTP.list()).length, 1, "The record is gone from the store");
    const toast = await TestUtils.waitForCondition(() => toastFor("whimsy-totp-deleted-toast"), "The undo toast");
    ok(toast, "Delete offers Undo in the toast");
    ok(WhimsyUndo.undo(window), "Undo puts it back");
    await TestUtils.waitForCondition(() => rows(doc).length == 2, "The row is back");
    const back = (await WhimsyTOTP.list()).find(record => record.site == "github.com");
    ok(back, "and so is the record");
    is((await WhimsyTOTP.codeFor(back.guid)).code, await totp(GITHUB, NOW), "with the same key");
    closeToasts();

    // Both gone: the empty line.
    for (const row of rows(doc)) {
      await WhimsyTOTP.remove(row.dataset.guid);
    }
    await TestUtils.waitForCondition(() => !doc.getElementById("whimsyTotpEmpty").hidden, "The empty line");
    ok(doc.getElementById("whimsyTotpList").hidden, "and no list");
  });
});

add_task(async function add_code_with_a_key() {
  await removeCodes();
  await withSettings(async (win, doc) => {
    const shown = BrowserTestUtils.waitForEvent(document, "popupshown", false, e => e.target.id == "whimsy-totp-add");
    EventUtils.synthesizeMouseAtCenter(doc.getElementById("whimsyTotpAdd"), {}, win);
    const { target: panel } = await shown;
    is(panel.dataset.state, "key", "Add Code… asks for the setup key");
    const key = panel.querySelector("#whimsy-totp-key");
    const site = panel.querySelector("#whimsy-totp-site-input");
    const account = panel.querySelector("#whimsy-totp-account-input");
    ok(key && site && account, "Setup key, Account, and Site");

    // A bad key: the error, and nothing saved.
    key.focus();
    EventUtils.sendString("NOT A KEY 1", window);
    site.focus();
    site.select();
    EventUtils.sendString("github.com", window);
    EventUtils.synthesizeMouseAtCenter(panel.querySelector("#whimsy-totp-save"), {}, window);
    const error = panel.querySelector("#whimsy-totp-key-error");
    await TestUtils.waitForCondition(() => !error.hidden && error.textContent, "The key's error");
    is(key.getAttribute("aria-invalid"), "true", "The key is marked invalid");
    await whimsyBothSchemes("w28-totp-add-key", async () => whimsyStandInPopups());
    is((await WhimsyTOTP.list()).length, 0, "Nothing saved");

    // A good key: the live code, then Save.
    key.select();
    EventUtils.sendString("jbsw y3dp ehpk 3pxp", window);
    ok(error.hidden, "Typing clears the error");
    account.focus();
    EventUtils.sendString("octocat", window);
    const hidden = BrowserTestUtils.waitForPopupEvent(panel, "hidden");
    EventUtils.synthesizeMouseAtCenter(panel.querySelector("#whimsy-totp-save"), {}, window);
    await hidden;
    const [record] = await WhimsyTOTP.list();
    is(record?.site, "github.com", "Saved for the site");
    is(record?.account, "octocat", "and the account");
    is((await WhimsyTOTP.codeFor(record.guid)).code, await totp(GITHUB, NOW), "with the key typed");
    await TestUtils.waitForCondition(() => rows(doc).length == 1, "and listed");
    await TestUtils.waitForCondition(() => toastFor("whimsy-totp-saved-toast"), "The saved toast");
    closeToasts();
  });
  await removeCodes();
});
