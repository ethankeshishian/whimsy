/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

const { WhimsyAutofill } = ChromeUtils.importESModule(
  "resource:///modules/whimsy/WhimsyStartup.sys.mjs"
);
const CARD_PREF = "extensions.formautofill.creditCards.enabled";
const ADDRESS_PREF = "extensions.formautofill.addresses.enabled";
const SIGNON_PREF = "signon.rememberSignons";
const AUTOFILL_PREFS = [CARD_PREF, ADDRESS_PREF];

add_setup(async function () {
  const defaults = Services.prefs.getDefaultBranch("");
  const saved = [SIGNON_PREF, ...AUTOFILL_PREFS].map(name => ({
    name,
    user: Services.prefs.prefHasUserValue(name)
      ? Services.prefs.getBoolPref(name) : null,
    defaultValue: defaults.getBoolPref(name),
  }));
  registerCleanupFunction(async () => {
    for (const { name, user } of saved) {
      if (user === null) {
        Services.prefs.clearUserPref(name);
      } else {
        Services.prefs.setBoolPref(name, user);
      }
    }
    // Drain pending lookups before restoring the test profile's defaults.
    await WhimsyAutofill.refresh();
    for (const { name, defaultValue } of saved) {
      defaults.setBoolPref(name, defaultValue);
    }
  });
  for (const { name } of saved) {
    Services.prefs.clearUserPref(name);
  }
  ok(WhimsyAutofill._initialized, "The profile startup hook installed the autofill observer");
  await WhimsyAutofill.refresh();
});

async function waitForAutofillDefaults(enabled) {
  await TestUtils.waitForCondition(() => AUTOFILL_PREFS.every(name =>
    Services.prefs.getDefaultBranch("").getBoolPref(name) === enabled
  ), `Autofill defaults become ${enabled}`);
}

add_task(async function test_manual_password_choice_is_not_a_manager() {
  Services.prefs.setBoolPref(SIGNON_PREF, false);
  await WhimsyAutofill.refresh();
  for (const name of AUTOFILL_PREFS) {
    ok(Services.prefs.getBoolPref(name), `${name} stays on without an extension`);
    ok(!Services.prefs.prefHasUserValue(name), "No autofill user preference is created");
  }
  Services.prefs.clearUserPref(SIGNON_PREF);
});

add_task(async function test_password_manager_owns_autofill_defaults() {
  const extension = ExtensionTestUtils.loadExtension({
    useAddonManager: "temporary",
    manifest: { permissions: ["privacy"] },
    async background() {
      await browser.privacy.services.passwordSavingEnabled.set({ value: false });
      browser.test.sendMessage("password-saving-disabled");
    },
  });
  await extension.startup();
  try {
    await extension.awaitMessage("password-saving-disabled");
    // No explicit refresh: startup's pref observer must handle this change.
    await waitForAutofillDefaults(false);
    for (const name of AUTOFILL_PREFS) {
      ok(!Services.prefs.getBoolPref(name), `${name} is off with a password manager`);
      ok(!Services.prefs.prefHasUserValue(name), "Only the default branch changes");
    }

    Services.prefs.setBoolPref(CARD_PREF, true);
    Services.prefs.setBoolPref(ADDRESS_PREF, true);
    await WhimsyAutofill.refresh();
    for (const name of AUTOFILL_PREFS) {
      ok(Services.prefs.getBoolPref(name), `${name}: explicit opt-in wins`);
      Services.prefs.clearUserPref(name);
      ok(!Services.prefs.getBoolPref(name), `${name}: clearing the choice uses the manager default`);
    }
  } finally {
    await extension.unload();
  }
  await waitForAutofillDefaults(true);
  for (const name of AUTOFILL_PREFS) {
    ok(Services.prefs.getBoolPref(name), `${name} returns after unload`);
    ok(!Services.prefs.prefHasUserValue(name), "Unload leaves no stale autofill user preference");
  }
});

add_task(async function test_explicit_opt_out_survives_refresh() {
  for (const name of AUTOFILL_PREFS) {
    Services.prefs.setBoolPref(name, false);
  }
  try {
    await WhimsyAutofill.refresh();
    for (const name of AUTOFILL_PREFS) {
      ok(!Services.prefs.getBoolPref(name), `${name}: explicit opt-out wins without a manager`);
    }
  } finally {
    for (const name of AUTOFILL_PREFS) {
      Services.prefs.clearUserPref(name);
    }
  }
});

add_task(async function test_settings_explains_autofill_defaults() {
  await BrowserTestUtils.withNewTab("about:preferences#privacy", async browser => {
    const doc = browser.contentDocument;
    const note = await TestUtils.waitForCondition(() =>
      doc.getElementById("whimsyAutofillManagerNote")
    );
    await doc.l10n.translateElements([note]);
    ok(!note.hidden, "The autofill explanation is visible in Privacy & Security");
    ok(note.textContent.includes("Saved payment methods and addresses are kept"),
      "Settings explains that saved data is preserved");
    const group = doc.getElementById("whimsyAutofillGroup");
    for (const [id, pref] of [
      ["whimsyAutofillPayments", CARD_PREF],
      ["whimsyAutofillAddresses", ADDRESS_PREF],
    ]) {
      const control = group.querySelector(`#${id}`);
      ok(control, `${id} is inside the Autofill group`);
      await control.updateComplete;
      is(control.checked, Services.prefs.getBoolPref(pref), "The switch reflects the effective autofill preference");
      control.click();
      is(Services.prefs.getBoolPref(pref), control.checked, "The switch writes the user's autofill choice");
      Services.prefs.setBoolPref(pref, !control.checked);
      await TestUtils.waitForCondition(() => control.checked === Services.prefs.getBoolPref(pref),
        "The switch follows changes from native settings");
      Services.prefs.clearUserPref(pref);
    }
  });
});
