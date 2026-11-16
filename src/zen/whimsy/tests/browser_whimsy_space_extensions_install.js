/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// W28 ext: "Run in profiles:" in Firefox's own "Add extension" prompt
// (x-spaces-profiles-extensions-per-profile). One checkbox per profile under
// "Optional settings:", the current profile checked and locked, the others
// unchecked; Add writes the same choice as Run in Profiles. Owner's case:
// installing an extension that's already installed but not allowed in this
// profile doesn't reinstall or fail, it only adds this profile.

const { AddonTestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/AddonTestUtils.sys.mjs"
);
const { WhimsySpaceExtensions } = ChromeUtils.importESModule(
  "resource:///modules/whimsy/WhimsySpaceExtensions.sys.mjs"
);
const { WhimsyProfiles } = ChromeUtils.importESModule(
  "resource:///modules/whimsy/WhimsyProfiles.sys.mjs"
);
const { ContextualIdentityService } = ChromeUtils.importESModule(
  "moz-src:///toolkit/components/contextualidentity/ContextualIdentityService.sys.mjs"
);
const { AppMenuNotifications } = ChromeUtils.importESModule(
  "resource://gre/modules/AppMenuNotifications.sys.mjs"
);

AddonTestUtils.initMochitest(this);

const FEATURE = "whimsy.feature.space-extensions";
const PROFILES_PREF = "whimsy.profiles.extensions";
const MANAGED_PREF = "whimsy.extensions.space-isolation-managed";
const ADDON_ID = "install-profiles@whimsy.test";

let firstSpace, containerSpace, container, containerKey, xpi;

function makeXPI(version = "1.0") {
  return AddonTestUtils.createTempWebExtensionFile({
    manifest: {
      name: "Whimsy Install Test",
      version,
      browser_specific_settings: { gecko: { id: ADDON_ID } },
      permissions: ["tabs"],
    },
  });
}

add_setup(async function () {
  await SpecialPowers.pushPrefEnv({ set: [["extensions.ui.disableUnsignedWarnings", true]] });
  firstSpace = gZenWorkspaces.getWorkspaces().find(w => w.uuid == gZenWorkspaces.activeWorkspace);
  container = ContextualIdentityService.create("Whimsy Install Profile", "fingerprint", "orange");
  containerKey = WhimsyProfiles.keyFor(container.userContextId);
  containerSpace = await gZenWorkspaces.createAndSaveWorkspace(
    "Install Space", undefined, true, container.userContextId);
  WhimsySpaceExtensions.initWindow(window);
  xpi = makeXPI();

  registerCleanupFunction(async () => {
    await (await AddonManager.getAddonByID(ADDON_ID))?.uninstall();
    Services.prefs.clearUserPref(FEATURE);
    for (const pref of [PROFILES_PREF, MANAGED_PREF]) {
      Services.prefs.clearUserPref(pref);
    }
    if (gZenWorkspaces.activeWorkspace != firstSpace.uuid) {
      await gZenWorkspaces.changeWorkspaceWithID(firstSpace.uuid);
    }
    await gZenWorkspaces.removeWorkspace(containerSpace.uuid);
    ContextualIdentityService.remove(container.userContextId);
  });
});

// Starts installing `file` from about:addons-style "Install Add-on From
// File", waits for Firefox's prompt and returns it with the install.
async function startInstall(file = xpi) {
  const install = await AddonManager.getInstallForFile(file);
  const events = [];
  install.addListener({
    onInstallCancelled: () => events.push("cancelled"),
    onInstallFailed: () => events.push("failed"),
    onInstallEnded: () => events.push("ended"),
  });
  AddonManager.installAddonFromAOM(gBrowser.selectedBrowser, document.documentURIObject, install);
  await TestUtils.waitForCondition(() =>
    PopupNotifications.panel.state == "open" &&
    PopupNotifications.getNotification("addon-webext-permissions"),
  "Firefox's install prompt is open");
  const panel = PopupNotifications.panel.querySelector("#addon-webext-permissions-notification");
  return { install, events, panel };
}

function profilesItem(panel) {
  return panel.querySelector("#addon-webext-perm-list-optional > li.whimsy-ext-install-profiles");
}

function checkboxFor(panel, key) {
  return profilesItem(panel)?.querySelector(`moz-checkbox[data-profile-key="${key}"]`);
}

async function accept(panel) {
  const hidden = BrowserTestUtils.waitForPopupEvent(PopupNotifications.panel, "hidden");
  panel.button.click();
  await hidden;
}

async function cancel(panel) {
  const hidden = BrowserTestUtils.waitForPopupEvent(PopupNotifications.panel, "hidden");
  panel.secondaryButton.click();
  await hidden;
}

// The "was added" notice belongs to Firefox (unchanged); it isn't under
// test here, so it's taken down once it's up.
async function dismissAddedNotice() {
  await TestUtils.waitForCondition(() =>
    AppMenuNotifications.notifications.some(n => n.id == "addon-installed"),
  "Firefox's added notice is up");
  AppMenuNotifications.removeNotification("addon-installed");
}

async function installAccepting(prepare = async () => {}) {
  const started = AddonTestUtils.promiseWebExtensionStartup(ADDON_ID);
  const { panel } = await startInstall();
  await prepare(panel);
  await accept(panel);
  await started;
  await dismissAddedNotice();
}

async function uninstall() {
  await (await AddonManager.getAddonByID(ADDON_ID))?.uninstall();
  is(WhimsySpaceExtensions.getAllowedProfiles(ADDON_ID), null, "Uninstalling forgets the choice");
}

add_task(async function test_prompt_lists_profiles_current_locked() {
  ok(WhimsyProfiles.list().length >= 2, "There are at least two profiles");
  const started = AddonTestUtils.promiseWebExtensionStartup(ADDON_ID);
  const { panel } = await startInstall();
  const item = profilesItem(panel);
  ok(item, "Optional settings has the profiles item");
  ok(BrowserTestUtils.isVisible(item), "and it shows");
  ok(!panel.querySelector("#addon-webext-perm-title-optional").hidden, "Optional settings: shows");
  const label = item.querySelector("#whimsy-ext-install-profiles-label");
  await TestUtils.waitForCondition(() => label.textContent == "Run in profiles:", "The group label is translated");
  is(item.querySelector("[role=group]").getAttribute("aria-labelledby"), label.id, "The group is named by its label");

  const boxes = [...item.querySelectorAll("moz-checkbox")];
  Assert.deepEqual(boxes.map(box => box.dataset.profileKey), WhimsyProfiles.list().map(p => p.key),
    "One checkbox per profile, in the profiles' own order");
  const current = checkboxFor(panel, "default");
  ok(current.checked && current.disabled, "The profile you're in is checked and locked");
  is(current.description, "this profile", "with the detail this profile");
  is(current.label, WhimsyProfiles.defaultName(), "named as the profile is");
  ok(current.iconSrc.startsWith("data:image/svg+xml"), "with its colour dot");
  const other = checkboxFor(panel, containerKey);
  ok(!other.checked && !other.disabled, "Other profiles start unchecked");
  is(other.label, "Whimsy Install Profile", "named as the user named it");
  ok(decodeURIComponent(other.iconSrc).includes("#ff9f00"), "Its dot is the profile's colour");

  // The private-windows item is still Firefox's and still comes first.
  const optional = [...panel.querySelector("#addon-webext-perm-list-optional").children];
  ok(optional.indexOf(item) == optional.length - 1, "Whimsy's item comes after Firefox's own");

  await whimsyBothSchemes("space-extensions-install-prompt", async () => whimsyStandInPopups());

  await accept(panel);
  await started;
  await dismissAddedNotice();
  Assert.deepEqual(WhimsySpaceExtensions.getAllowedProfiles(ADDON_ID), ["default"],
    "Add with nothing else checked limits it to this profile");
  const restricted = JSON.parse(Services.prefs.getStringPref(
    `extensions.userContextIsolation.${ADDON_ID}.restricted`, "[]"));
  ok(restricted.includes(container.userContextId), "It's kept out of the other profile");
  ok(!restricted.includes(0), "but not out of this one");
  await uninstall();
});

add_task(async function test_checking_every_profile_means_all_profiles() {
  await installAccepting(async panel => {
    for (const profile of WhimsyProfiles.list()) {
      const box = checkboxFor(panel, profile.key);
      if (!box.checked) {
        const changed = BrowserTestUtils.waitForEvent(box, "change");
        box.click();
        await changed;
      }
    }
  });
  is(WhimsySpaceExtensions.getAllowedProfiles(ADDON_ID), null, "Every profile checked writes no entry");
  ok(!(ADDON_ID in JSON.parse(Services.prefs.getStringPref(PROFILES_PREF, "{}"))) ||
    JSON.parse(Services.prefs.getStringPref(PROFILES_PREF))[ADDON_ID][0] === null,
  "Nothing limits it in the synced map");
  await uninstall();
});

add_task(async function test_checking_another_profile() {
  await installAccepting(async panel => {
    const box = checkboxFor(panel, containerKey);
    const changed = BrowserTestUtils.waitForEvent(box, "change");
    box.click();
    await changed;
  });
  const allowed = WhimsySpaceExtensions.getAllowedProfiles(ADDON_ID);
  if (WhimsyProfiles.list().length == 2) {
    is(allowed, null, "Both of two profiles = All Profiles");
  } else {
    Assert.deepEqual(allowed, ["default", containerKey].sort(), "This profile and the one checked");
  }
  await uninstall();
});

add_task(async function test_cancel_writes_nothing() {
  const { install, events, panel } = await startInstall();
  ok(profilesItem(panel), "The list shows");
  checkboxFor(panel, containerKey).click();
  await cancel(panel);
  await TestUtils.waitForCondition(() => events.includes("cancelled"), "The install is cancelled");
  is(install.state, AddonManager.STATE_CANCELLED, "Firefox cancelled it");
  is(await AddonManager.getAddonByID(ADDON_ID), null, "Nothing installed");
  is(WhimsySpaceExtensions.getAllowedProfiles(ADDON_ID), null, "Nothing written");
  ok(!WhimsySpaceExtensions._pendingInstalls.has(ADDON_ID), "No choice left waiting");
});

add_task(async function test_hidden_with_one_profile_or_feature_off() {
  const list = WhimsyProfiles.list;
  WhimsyProfiles.list = () => list.call(WhimsyProfiles).slice(0, 1);
  try {
    const { panel } = await startInstall();
    ok(!profilesItem(panel), "One profile: no list, the prompt is pure Firefox");
    await cancel(panel);
  } finally {
    WhimsyProfiles.list = list;
  }

  Services.prefs.setBoolPref(FEATURE, false);
  try {
    const { panel } = await startInstall();
    ok(!profilesItem(panel), "Feature off: no list");
    await cancel(panel);
  } finally {
    Services.prefs.clearUserPref(FEATURE);
  }
});

add_task(async function test_no_list_for_updates_or_where_it_already_runs() {
  const addon = { id: ADDON_ID, type: "extension", version: "1.0" };
  is(await WhimsySpaceExtensions.installPromptContext(gBrowser.selectedBrowser, {}, {
    addon, shouldShowIncognitoCheckbox: false,
  }), null, "An update or optional-permission prompt has no list");

  await installAccepting();
  is(await WhimsySpaceExtensions.installPromptContext(gBrowser.selectedBrowser, {}, {
    addon, shouldShowIncognitoCheckbox: true,
  }), null, "Reinstalling where it already runs: Firefox's own prompt, no list");
  await uninstall();
});

// Owner (W27 sign-off): "if user tries to download existing in a profile
// that doesn't have it enabled, need to account for that case."
add_task(async function test_existing_extension_in_a_profile_without_it() {
  await installAccepting();
  Assert.deepEqual(WhimsySpaceExtensions.getAllowedProfiles(ADDON_ID), ["default"], "Installed in Default only");
  const before = await AddonManager.getAddonByID(ADDON_ID);
  const installDate = before.installDate.getTime();

  // addons.mozilla.org in the other profile: not installed there, so it offers Add.
  const tab = BrowserTestUtils.addTab(gBrowser, "about:blank", { userContextId: container.userContextId });
  try {
    is(await AddonManager.webAPI.getAddonByID(tab.linkedBrowser, ADDON_ID), null,
      "A site in the other profile doesn't see it installed");
    const here = await AddonManager.webAPI.getAddonByID(gBrowser.selectedBrowser, ADDON_ID);
    is(here?.id, ADDON_ID, "A site in Default does");

    await gZenWorkspaces.changeWorkspaceWithID(containerSpace.uuid);
    const installing = [];
    const listener = { onInstalling: addon => installing.push(addon.id) };
    AddonManager.addAddonListener(listener);
    try {
      const { install, events, panel } = await startInstall();
      const current = checkboxFor(panel, containerKey);
      ok(current?.checked && current.disabled, "This profile is checked and locked");
      ok(checkboxFor(panel, "default").checked, "Where it already runs stays checked");
      await accept(panel);
      await TestUtils.waitForCondition(() => events.length, "The install settled");
      Assert.deepEqual(events, ["cancelled"], "No reinstall and no error: Firefox's install just stops");
      is(install.error, 0, "Without an error");
      Assert.deepEqual(installing, [], "Nothing was reinstalled");
    } finally {
      AddonManager.removeAddonListener(listener);
    }
    const after = await AddonManager.getAddonByID(ADDON_ID);
    is(after.installDate.getTime(), installDate, "The same install");
    ok(after.isActive, "Still running");
    ok(WhimsySpaceExtensions.isAllowedIn(ADDON_ID, containerKey), "Enabled for this profile");
    ok(WhimsySpaceExtensions.isAllowedIn(ADDON_ID, "default"), "and still for Default");
    is((await AddonManager.webAPI.getAddonByID(tab.linkedBrowser, ADDON_ID))?.id, ADDON_ID,
      "The site in this profile now sees it installed");
  } finally {
    BrowserTestUtils.removeTab(tab);
    await gZenWorkspaces.changeWorkspaceWithID(firstSpace.uuid);
  }
  await uninstall();
});

// A newer version of an extension limited elsewhere is an upgrade: it
// installs, and this profile is added.
add_task(async function test_existing_older_version_upgrades() {
  await installAccepting();
  await gZenWorkspaces.changeWorkspaceWithID(containerSpace.uuid);
  try {
    const started = AddonTestUtils.promiseWebExtensionStartup(ADDON_ID);
    const { panel } = await startInstall(makeXPI("2.0"));
    ok(checkboxFor(panel, containerKey)?.checked, "The list shows, this profile checked");
    await accept(panel);
    await started;
    await dismissAddedNotice();
    is((await AddonManager.getAddonByID(ADDON_ID)).version, "2.0", "Upgraded");
    ok(WhimsySpaceExtensions.isAllowedIn(ADDON_ID, containerKey), "and enabled for this profile");
  } finally {
    await gZenWorkspaces.changeWorkspaceWithID(firstSpace.uuid);
  }
  await uninstall();
});
