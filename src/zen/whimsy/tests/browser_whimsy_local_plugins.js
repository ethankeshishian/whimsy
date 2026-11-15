/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// W28 plugins (research x-extensions-building-plugins, option A, owner
// approved): a folder for the owner's own unsigned extensions. Each real
// folder in <profile>/whimsy-plugins is an unpacked WebExtension that loads
// without a signature, turned off until approved through Firefox's own
// permission prompt, and again for each new version. Signing stays required
// everywhere else, and nothing reaches outside the folder (links, pointer
// files, .xpi files). The engine scans the folder at startup; tests use the
// same rescan Firefox runs for sideloads (getNewSideloads).

const { AddonManager, AddonManagerPrivate } = ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs");
const { ExtensionsUI } = ChromeUtils.importESModule("resource:///modules/ExtensionsUI.sys.mjs");
const { XPIInternal } = ChromeUtils.importESModule("resource://gre/modules/addons/XPIProvider.sys.mjs");
const { XPIDatabase } = ChromeUtils.importESModule("resource://gre/modules/addons/XPIDatabase.sys.mjs");
const { Subprocess } = ChromeUtils.importESModule("resource://gre/modules/Subprocess.sys.mjs");

const LOCATION = "whimsy-local-plugins";
const PLUGINS = PathUtils.join(PathUtils.profileDir, "whimsy-plugins");
const OUTSIDE = PathUtils.join(PathUtils.profileDir, "whimsy-plugins-outside-test");

let gMtime = Date.now();

function manifestFor(id, extra = {}) {
  return {
    manifest_version: 3,
    name: `Plugin ${id}`,
    version: "1.0",
    browser_specific_settings: { gecko: { id } },
    background: { scripts: ["background.js"] },
    ...extra,
  };
}

// Writes an unpacked extension into dir; each write gets a later mtime, so
// a rescan always sees the change.
async function writeExtension(dir, manifest) {
  await IOUtils.makeDirectory(dir, { createAncestors: true });
  const manifestPath = PathUtils.join(dir, "manifest.json");
  await IOUtils.writeUTF8(manifestPath, JSON.stringify(manifest));
  await IOUtils.writeUTF8(PathUtils.join(dir, "background.js"), "/* plugin */\n");
  gMtime += 10000;
  await IOUtils.setModificationTime(manifestPath, gMtime);
  await IOUtils.setModificationTime(dir, gMtime);
}

async function ln(target, link) {
  const proc = await Subprocess.call({ command: "/bin/ln", arguments: ["-s", target, link] });
  is(await proc.wait().then(r => r.exitCode), 0, `ln -s ${link}`);
}

async function rescan() {
  return (await AddonManagerPrivate.getNewSideloads()).map(addon => addon.id);
}

async function removeEverything() {
  await IOUtils.remove(PLUGINS, { recursive: true, ignoreAbsent: true });
  await IOUtils.remove(OUTSIDE, { recursive: true, ignoreAbsent: true });
  await rescan();
}

add_setup(async function () {
  // Whimsy's builds require signing (xpinstall.signatures.required), the
  // test profile doesn't. Turning the pref on here would disable the test
  // harness's own unsigned extensions, so signing is required the way a
  // real build decides it, for extensions only, while this file runs.
  const realMustSign = XPIDatabase.mustSign;
  XPIDatabase.mustSign = type => type == "extension";
  registerCleanupFunction(async () => {
    await removeEverything();
    XPIDatabase.mustSign = realMustSign;
  });
  await removeEverything();
});

add_task(async function test_plugin_loads_unsigned_after_approval() {
  const id = "hello@whimsy-plugins.test";
  const dir = PathUtils.join(PLUGINS, "hello");
  await writeExtension(dir, manifestFor(id, { host_permissions: ["*://example.com/*"] }));

  ok((await rescan()).includes(id), "a new plugin is offered for approval");
  const addon = await AddonManager.getAddonByID(id);
  ok(addon, "the plugin is installed from the folder");
  is(addon.installTelemetryInfo?.source, LOCATION, "from the local plugins location");
  is(addon.isCorrectlySigned, true, "unsigned, yet counted as correctly signed in this folder");
  ok(!(addon.signedState > AddonManager.SIGNEDSTATE_MISSING), "it carries no signature");
  is(addon.appDisabled, false, "signing doesn't disable it");
  is(addon.isPrivileged, false, "a plugin is never privileged");
  is(addon.userDisabled, true, "it starts turned off, though the test profile auto-enables sideloads");
  is(addon.seen, false, "and waits for the owner's approval");
  is(addon.isActive, false, "so it doesn't run yet");
  ok(!(addon.permissions & AddonManager.PERM_CAN_UNINSTALL), "nothing removes it but deleting its folder");
  ok(!WebExtensionPolicy.getByID(id), "no extension is running");

  // Approval is Firefox's own permission prompt for a sideloaded extension.
  const shown = BrowserTestUtils.waitForEvent(PopupNotifications.panel, "popupshown");
  ExtensionsUI.showSideloaded(gBrowser, addon);
  await shown;
  const notification = PopupNotifications.panel.querySelector("popupnotification:not([hidden])");
  is(notification?.id, "addon-webext-permissions-notification", "the extension permission prompt opens");
  await TestUtils.waitForCondition(() => notification.textContent.includes("example.com"), "and lists the plugin's sites");
  const enabled = new Promise(resolve => {
    const listener = {
      onEnabled(a) {
        if (a.id == id) {
          AddonManager.removeAddonListener(listener);
          resolve();
        }
      },
    };
    AddonManager.addAddonListener(listener);
  });
  notification.button.click();
  await enabled;
  await TestUtils.waitForCondition(() => WebExtensionPolicy.getByID(id)?.active, "the plugin runs");
  is(WebExtensionPolicy.getByID(id).isPrivileged, false, "unprivileged at runtime too");
  const approved = await AddonManager.getAddonByID(id);
  is(approved.userDisabled, false, "approved");
  is(approved.seen, true, "and seen");

  // What survives a restart: the startup state records it enabled, in this
  // location, at this folder.
  const state = XPIInternal.XPIStates.getLocation(LOCATION)?.get(id);
  ok(state?.enabled, "the startup state keeps it enabled");
  is(state?.path, dir, "loaded from its own folder");

  for (const tab of gBrowser.tabs.filter(t => t.linkedBrowser.currentURI.spec.startsWith("about:addons"))) {
    BrowserTestUtils.removeTab(tab);
  }
});

add_task(async function test_new_version_needs_approval_again() {
  const id = "hello@whimsy-plugins.test";
  const dir = PathUtils.join(PLUGINS, "hello");
  ok((await AddonManager.getAddonByID(id))?.isActive, "the approved plugin from the last task runs");

  // An edit with the same version and no new permissions reloads quietly.
  await writeExtension(dir, manifestFor(id, { host_permissions: ["*://example.com/*"], description: "edited" }));
  ok(!(await rescan()).includes(id), "a same-version edit asks nothing");
  let addon = await AddonManager.getAddonByID(id);
  is(addon.description, "edited", "the edit is picked up");
  is(addon.userDisabled, false, "and the plugin stays on");

  // The same version asking for a new site needs approval.
  await writeExtension(dir, manifestFor(id, { host_permissions: ["*://example.com/*", "*://example.org/*"] }));
  ok((await rescan()).includes(id), "a new site asks again");
  addon = await AddonManager.getAddonByID(id);
  is(addon.userDisabled, true, "turned off until approved");
  is(addon.seen, false, "waiting for approval");
  await TestUtils.waitForCondition(() => !WebExtensionPolicy.getByID(id), "it stops running");

  await addon.enable();
  addon.markAsSeen();
  await TestUtils.waitForCondition(() => WebExtensionPolicy.getByID(id)?.active, "approved again, it runs");

  // A new version needs approval.
  await writeExtension(dir, manifestFor(id, { host_permissions: ["*://example.com/*", "*://example.org/*"], version: "2.0" }));
  ok((await rescan()).includes(id), "a new version asks again");
  addon = await AddonManager.getAddonByID(id);
  is(addon.version, "2.0", "the new version is loaded");
  is(addon.userDisabled, true, "turned off until approved");
  is(addon.seen, false, "waiting for approval");
  await TestUtils.waitForCondition(() => !WebExtensionPolicy.getByID(id), "it stops running");

  // Deleting the folder removes the plugin.
  await IOUtils.remove(dir, { recursive: true });
  await rescan();
  is(await AddonManager.getAddonByID(id), null, "removing its folder removes the plugin");
});

add_task(async function test_nothing_outside_the_folder_loads() {
  await IOUtils.makeDirectory(PLUGINS, { createAncestors: true });

  // A symlinked plugin folder that points outside.
  const linkedId = "linked@whimsy-plugins.test";
  await writeExtension(PathUtils.join(OUTSIDE, "linked"), manifestFor(linkedId));
  await ln(PathUtils.join(OUTSIDE, "linked"), PathUtils.join(PLUGINS, "linked"));

  // A pointer file (Firefox's proxy files) named by the id.
  const pointerId = "pointer@whimsy-plugins.test";
  await writeExtension(PathUtils.join(OUTSIDE, "pointer"), manifestFor(pointerId));
  await IOUtils.writeUTF8(PathUtils.join(PLUGINS, pointerId), PathUtils.join(OUTSIDE, "pointer"));

  // A plugin folder holding a symlink to a file outside.
  const leakId = "leak@whimsy-plugins.test";
  await writeExtension(PathUtils.join(PLUGINS, "leak"), manifestFor(leakId));
  await IOUtils.remove(PathUtils.join(PLUGINS, "leak", "background.js"));
  await ln(PathUtils.join(OUTSIDE, "linked", "background.js"), PathUtils.join(PLUGINS, "leak", "background.js"));

  // A packed .xpi named by the id (unpacked folders only).
  const xpiId = "packed@whimsy-plugins.test";
  await IOUtils.writeUTF8(PathUtils.join(PLUGINS, `${xpiId}.xpi`), "not a folder");

  // No id in the manifest, and two folders claiming one id.
  await writeExtension(PathUtils.join(PLUGINS, "noid"), { ...manifestFor("x@y"), browser_specific_settings: undefined });
  const twinId = "twin@whimsy-plugins.test";
  await writeExtension(PathUtils.join(PLUGINS, "twin-a"), manifestFor(twinId));
  await writeExtension(PathUtils.join(PLUGINS, "twin-b"), manifestFor(twinId));

  // A plugin claiming the id of an extension installed elsewhere.
  const taken = ExtensionTestUtils.loadExtension({
    useAddonManager: "temporary",
    manifest: { browser_specific_settings: { gecko: { id: "taken@whimsy-plugins.test" } } },
  });
  await taken.startup();
  await writeExtension(PathUtils.join(PLUGINS, "taken"), manifestFor("taken@whimsy-plugins.test"));

  const offered = await rescan();
  for (const id of [linkedId, pointerId, leakId, xpiId, twinId]) {
    ok(!offered.includes(id), `${id} isn't offered`);
    is(await AddonManager.getAddonByID(id), null, `${id} doesn't load`);
  }
  ok(!offered.includes("taken@whimsy-plugins.test"), "a taken id isn't offered");
  is((await AddonManager.getAddonByID("taken@whimsy-plugins.test")).temporarilyInstalled, true,
    "the extension that holds the id keeps it");
  ok(await IOUtils.exists(PathUtils.join(OUTSIDE, "pointer")), "nothing outside is touched");
  await taken.unload();

  await IOUtils.remove(PLUGINS, { recursive: true });
  await rescan();
});

add_task(async function test_signing_still_required_elsewhere() {
  const id = "unsigned@whimsy-plugins.test";

  // The same unsigned extension in Firefox's own profile extensions folder
  // is refused...
  const profileExtensions = PathUtils.join(PathUtils.profileDir, "extensions");
  await writeExtension(PathUtils.join(profileExtensions, id), manifestFor(id));
  ok(!(await rescan()).includes(id), "an unsigned sideload elsewhere isn't offered");
  is(await AddonManager.getAddonByID(id), null, "and doesn't load");
  await IOUtils.remove(PathUtils.join(profileExtensions, id), { recursive: true, ignoreAbsent: true });

  // ...an unsigned .xpi install still fails for a missing signature...
  const xpi = await IOUtils.getFile(PathUtils.profileDir, "whimsy-unsigned-test.xpi");
  const zip = Cc["@mozilla.org/zipwriter;1"].createInstance(Ci.nsIZipWriter);
  zip.open(xpi, 0x04 | 0x08 | 0x20);
  const stream = Cc["@mozilla.org/io/string-input-stream;1"].createInstance(Ci.nsIStringInputStream);
  stream.setByteStringData(JSON.stringify(manifestFor(id, { background: undefined })));
  zip.addEntryStream("manifest.json", Date.now() * 1000, Ci.nsIZipWriter.COMPRESSION_NONE, stream, false);
  zip.close();
  const install = await AddonManager.getInstallForFile(xpi);
  is(install.error, AddonManager.ERROR_SIGNEDSTATE_REQUIRED, "an unsigned .xpi still needs a signature");
  await IOUtils.remove(xpi.path);
  is(await AddonManager.getAddonByID(id), null, "nothing was installed");

  // ...while the very same folder in whimsy-plugins loads.
  await writeExtension(PathUtils.join(PLUGINS, "unsigned"), manifestFor(id));
  ok((await rescan()).includes(id), "the folder in whimsy-plugins loads");
  await IOUtils.remove(PLUGINS, { recursive: true });
  await rescan();
  is(await AddonManager.getAddonByID(id), null, "and is gone with its folder");
});
