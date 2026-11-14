/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// W26 passkeys: Settings → Privacy & Security → Passkeys. The list, Delete
// with Undo (the toast and ⌘Z's entry), and the profile delete confirmation
// that counts the passkeys that go with it.

const { WhimsyPasskeys } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyPasskeys.sys.mjs");
const { WhimsyProfiles } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyProfiles.sys.mjs");
const { WhimsyUndo } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyUndo.sys.mjs");
const { ContextualIdentityService } = ChromeUtils.importESModule(
  "moz-src:///toolkit/components/contextualidentity/ContextualIdentityService.sys.mjs"
);
// head.js gives this file its own throwaway Keychain item for OSKeyStore.

const DAY = 86_400_000;
let workProfile, workKey;

function b64url(bytes) {
  return ChromeUtils.base64URLEncode(bytes, { pad: false });
}
function record(fields) {
  return {
    id: b64url(crypto.getRandomValues(new Uint8Array(32))),
    rpId: "github.com",
    profile: "default",
    userHandle: "AQID",
    userName: "octocat@example.com",
    displayName: "Mona Lisa Octocat",
    blob: "stub",
    x: "",
    y: "",
    created: Date.now() - 2 * DAY,
    lastUsed: 0,
    ...fields,
  };
}

add_setup(async function () {
  await SpecialPowers.pushPrefEnv({ set: [["whimsy.feature.passkeys", true]] });
  WhimsyPasskeys._signer = { available: async () => ({ se: true, biometry: true, biometryType: "touchID" }) };
  WhimsyPasskeys.resetAvailability();
  WhimsyPasskeys.init();
  await WhimsyPasskeys.probe();
  workProfile = WhimsyProfiles.create("Passkeys Settings Work");
  workKey = WhimsyProfiles.keyFor(workProfile);
  await WhimsyPasskeys.save([
    record({ lastUsed: Date.now() }),
    record({ rpId: "api-1234abcd.duosecurity.com", profile: workKey, userHandle: "BAUG", userName: "ekeshish@usc.edu", displayName: "", created: Date.now() - DAY }),
  ]);
  registerCleanupFunction(async () => {
    closeToasts();
    await WhimsyPasskeys.save([]);
    WhimsyPasskeys._signer = null;
    WhimsyPasskeys.resetAvailability();
    if (WhimsyProfiles.exists(workProfile)) {
      ContextualIdentityService.remove(workProfile);
    }
  });
});

async function withSettings(callback) {
  await BrowserTestUtils.withNewTab("about:preferences#privacy", async browser => {
    const doc = browser.contentDocument;
    const win = browser.contentWindow;
    await TestUtils.waitForCondition(() => doc.getElementById("whimsyPasskeysGroup") && !doc.getElementById("whimsyPasskeysGroup").hidden, "The Passkeys card is shown");
    is((await WhimsyPasskeys.list()).length, 2, "The store lists both passkeys");
    // Rendering throws silently inside the page's init; on a miss, render by
    // hand so the exception (if any) reaches the log.
    await TestUtils.waitForCondition(() => doc.querySelectorAll("#whimsyPasskeysList .whimsy-passkey-row").length == 2, "Both passkeys are listed")
      .catch(async e => { await win.gWhimsySettings.renderPasskeys(); throw e; });
    await callback(win, doc);
  });
}

function rows(doc) {
  return [...doc.querySelectorAll("#whimsyPasskeysList .whimsy-passkey-row")];
}

add_task(async function list_delete_and_undo() {
  await withSettings(async (win, doc) => {
    const [first, second] = rows(doc);
    is(first.querySelector(".whimsy-profile-name").textContent, "github.com", "Most recently used first");
    const meta = first.querySelector(".whimsy-profile-meta").textContent;
    ok(meta.startsWith("Mona Lisa Octocat · Default · Saved "), `The row says who, where, and when (${meta})`);
    ok(meta.endsWith(" · Last used today"), `and when it was last used (${meta})`);
    is(second.querySelector(".whimsy-profile-name").textContent, "api-1234abcd.duosecurity.com", "Duo second");
    const duoMeta = second.querySelector(".whimsy-profile-meta").textContent;
    ok(duoMeta.startsWith("ekeshish@usc.edu · Passkeys Settings Work · Saved "), `A passkey with no display name shows its user name and profile (${duoMeta})`);
    ok(!duoMeta.includes("Last used"), "and no last use when it has none");
    ok(first.querySelector("img.whimsy-passkey-favicon")?.src.includes("github.com"), "The site's favicon");
    ok(doc.getElementById("whimsyPasskeysEmpty").hidden, "No empty line while there are rows");
    is(doc.querySelector("#whimsyPasskeysGroup description[data-l10n-id='whimsy-passkeys-footnote']").textContent,
      "Passkeys from 1Password and security keys aren’t listed here; those apps keep their own.", "The footnote");

    await whimsyBothSchemes("w26-passkeys-s1-settings", async () => {
      doc.getElementById("whimsyPasskeysGroup").scrollIntoView();
    });

    const remove = first.querySelector(".whimsy-passkey-delete");
    is(remove.getAttribute("aria-label"), "Delete the passkey for github.com", "Delete names its passkey");
    const gone = TestUtils.waitForCondition(() => rows(doc).length == 1, "The row went");
    EventUtils.synthesizeMouseAtCenter(remove, {}, win);
    await gone;
    is((await WhimsyPasskeys.load()).length, 1, "The record is gone from the store");
    const toast = await TestUtils.waitForCondition(() => toastFor("whimsy-passkeys-deleted-toast"), "The undo toast");
    ok(toast, "Delete offers Undo in the toast");
    await whimsyBothSchemes("w26-passkeys-s2-deleted", async () => {});
    ok(WhimsyUndo.undo(window), "⌘Z's entry undoes the delete");
    await TestUtils.waitForCondition(() => rows(doc).length == 2, "The row is back");
    is((await WhimsyPasskeys.load()).length, 2, "and so is the record");
    is(rows(doc)[0].querySelector(".whimsy-profile-name").textContent, "github.com", "in its place");
    closeToasts();
  });
});

add_task(async function profile_delete_counts_its_passkeys() {
  await withSettings(async (win, doc) => {
    const settings = win.gWhimsySettings;
    // With a callback, promiseAlertDialogOpen leaves the answering to it;
    // read the body, then press Cancel ourselves.
    const dialog = BrowserTestUtils.promiseAlertDialogOpen(null);
    const deleting = settings.deleteProfile({ id: workProfile, key: workKey, name: "Passkeys Settings Work" });
    const dialogWin = await dialog;
    const body = dialogWin.document.getElementById("infoBody").textContent;
    ok(body.includes("saved passwords, and 1 passkey are deleted"), `The confirmation counts the passkey (${body})`);
    dialogWin.document.querySelector("dialog").getButton("cancel").click();
    await deleting;
    ok(WhimsyProfiles.exists(workProfile), "Cancel kept the profile");
    is((await WhimsyPasskeys.load()).length, 2, "and its passkey");
    ok(await WhimsyProfiles.delete(workProfile, window), "Deleting the profile");
    await TestUtils.waitForCondition(async () => (await WhimsyPasskeys.load()).length == 1, "deletes its passkey");
    ok((await WhimsyPasskeys.load()).every(r => r.profile == "default"), "Default's stays");
    await TestUtils.waitForCondition(() => rows(doc).length == 1, "and the list follows");
  });
});
