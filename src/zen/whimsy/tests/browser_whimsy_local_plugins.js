/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// W28 plugins (research x-extensions-building-plugins, option A, owner
// approved): a folder for the owner's own unsigned extensions. Each real
// folder in <profile>/whimsy-plugins is an unpacked WebExtension that loads
// without a signature, turned off until approved through Firefox's own
// permission prompt, and again for each manifest change. Signing stays required
// everywhere else, and nothing reaches outside the folder (links, pointer
// files, .xpi files). The engine scans the folder at startup; tests use the
// same rescan Firefox runs for sideloads (getNewSideloads).

const { AddonManager, AddonManagerPrivate } = ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs");
const { ExtensionsUI } = ChromeUtils.importESModule("resource:///modules/ExtensionsUI.sys.mjs");
const { XPIInternal } = ChromeUtils.importESModule("resource://gre/modules/addons/XPIProvider.sys.mjs");
const { XPIDatabase, AddonInternal } = ChromeUtils.importESModule("resource://gre/modules/addons/XPIDatabase.sys.mjs");
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

async function closeAddonsTabs() {
  for (const tab of [...gBrowser.tabs].filter(t => t.linkedBrowser?.currentURI?.spec?.startsWith("about:addons"))) {
    if (gBrowser.tabs.length == 1) {
      BrowserTestUtils.addTab(gBrowser, "about:blank");
    }
    await BrowserTestUtils.removeTab(tab);
  }
}

// Exercise the real sideload prompt for both decisions. Wait until its
// safety delay and all opening animations finish before synthesizing a click.
async function answerPrompt(addon, run, fromAddons = false) {
  let toggle;
  let manager;
  if (fromAddons) {
    manager = await BrowserAddonUI.openAddonsMgr("addons://list/extension");
    await TestUtils.waitForCondition(() => manager.document.querySelector(`addon-card[addon-id="${addon.id}"]`)?.addon === addon, "current plugin card appears");
    toggle = manager.document.querySelector(`addon-card[addon-id="${addon.id}"] moz-toggle[action="toggle-disabled"]`);
    toggle.scrollIntoView();
    await Promise.all(manager.document.getAnimations({ subtree: true }).map(a => a.finished.catch(() => {})));
  }
  const shown = BrowserTestUtils.waitForEvent(PopupNotifications.panel, "popupshown");
  if (fromAddons) {
    EventUtils.synthesizeMouseAtCenter(toggle, {}, manager);
  } else {
    ExtensionsUI.showSideloaded(gBrowser, addon);
  }
  await shown;
  const notification = PopupNotifications.panel.querySelector("popupnotification:not([hidden])");
  is(notification?.id, "addon-webext-permissions-notification", "Firefox permission notification is reused");
  const strings = notification.notification.options.customElementOptions.strings;
  is(strings.header, "Run the plugin “<>”?", "Whimsy asks before running the named plugin");
  is(strings.addonName, addon.name, "Firefox safely substitutes the plugin name");
  is(strings.listIntro, "It can:", "permissions introduction");
  is(notification.button.label, "Run", "affirmative label");
  is(notification.secondaryButton.label, "Don't Run", "refusal label");
  const button = run ? notification.button : notification.secondaryButton;
  await TestUtils.waitForCondition(() => !button.disabled, "permission prompt safety delay has ended");
  await Promise.all(PopupNotifications.panel.getAnimations({ subtree: true }).map(a => a.finished.catch(() => {})));
  const response = fromAddons ? Promise.resolve() : new Promise(resolve => ExtensionsUI.once("sideload-response", resolve));
  const hidden = BrowserTestUtils.waitForEvent(PopupNotifications.panel, "popuphidden");
  EventUtils.synthesizeMouseAtCenter(button, {}, window);
  await Promise.all([response, hidden]);
  await TestUtils.waitForCondition(() => addon.seen && addon.userDisabled == !run, "the prompt decision is applied");
  return strings;
}

// Reconstruct a stopped add-on from the same JSON and source/location data
// used by XPIDatabase's startup loader, then exercise a filesystem rescan.
async function reloadStoppedPlugin(id) {
  const key = `${LOCATION}:${id}`;
  const old = XPIDatabase.addonDB.get(key);
  ok(old.userDisabled && !old.active, "only stopped plugins are reconstructed");
  const data = JSON.parse(JSON.stringify(old));
  data.location = XPIInternal.XPIStates.getLocation(data.location);
  data._sourceBundle = old._sourceBundle;
  XPIDatabase.addonDB.set(key, new AddonInternal(data));
  await rescan();
  return AddonManager.getAddonByID(id);
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
  // Installing, approving, and removing extensions writes add-on manager
  // prefs; every pref this file changes is put back.
  const before = new Map(
    Services.prefs.getChildList("").filter(name => Services.prefs.prefHasUserValue(name)).map(name => {
      const type = Services.prefs.getPrefType(name);
      return [name, { type, value: whimsyReadPref(name, type) }];
    })
  );
  registerCleanupFunction(async () => {
    await removeEverything();
    await closeAddonsTabs();
    XPIDatabase.mustSign = realMustSign;
    for (const name of new Set([...Services.prefs.getChildList(""), ...before.keys()])) {
      const old = before.get(name);
      const type = Services.prefs.getPrefType(name);
      if (!Services.prefs.prefHasUserValue(name)) {
        if (old) {
          info(`Restoring preference ${name}`);
          whimsyWritePref(name, old.type, old.value);
        }
      } else if (!old) {
        info(`Clearing preference ${name}`);
        Services.prefs.clearUserPref(name);
      } else if (old.type != type || whimsyReadPref(name, type) !== old.value) {
        info(`Restoring preference ${name}`);
        whimsyWritePref(name, old.type, old.value);
      }
    }
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

  const strings = await answerPrompt(addon, true);
  ok(strings.msgs.some(msg => msg.includes("example.com")), "Firefox describes the requested site");
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

  await closeAddonsTabs();
});

add_task(async function test_changed_manifest_needs_approval_again() {
  const id = "hello@whimsy-plugins.test";
  const dir = PathUtils.join(PLUGINS, "hello");
  ok((await AddonManager.getAddonByID(id))?.isActive, "the approved plugin from the last task runs");

  // Any manifest edit, even a description with unchanged permissions, asks again.
  await writeExtension(dir, manifestFor(id, { host_permissions: ["*://example.com/*"], description: "edited" }));
  ok((await rescan()).includes(id), "a same-version manifest edit asks again");
  let addon = await AddonManager.getAddonByID(id);
  is(addon.description, "edited", "the edit is picked up");
  is(addon.userDisabled, true, "the changed manifest cannot run before approval");
  await TestUtils.waitForCondition(() => !WebExtensionPolicy.getByID(id), "the old plugin has stopped");
  await answerPrompt(addon, true);
  await TestUtils.waitForCondition(() => WebExtensionPolicy.getByID(id)?.active, "approved edit runs");

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
  await closeAddonsTabs();
});

add_task(async function test_refusal_and_disabled_state_survive_reload() {
  const id = "refused@whimsy-plugins.test";
  const dir = PathUtils.join(PLUGINS, "refused");
  const manifest = manifestFor(id, { permissions: ["tabs"] });
  await writeExtension(dir, manifest);
  ok((await rescan()).includes(id), "new plugin needs approval");
  await answerPrompt(await AddonManager.getAddonByID(id), false);
  let addon = await reloadStoppedPlugin(id);
  ok(addon, "Don't Run keeps the plugin installed");
  ok(addon.userDisabled && !addon.isActive, "Don't Run keeps it off after metadata reload");
  ok(addon.seen, "the refusal is remembered");
  ok(!(await rescan()).includes(id), "unchanged refused plugin is not offered again");
  ok(!WebExtensionPolicy.getByID(id), "refused plugin never runs");

  // Touching identical contents must preserve the refusal, too.
  await writeExtension(dir, manifest);
  ok(!(await rescan()).includes(id), "an unchanged manifest does not ask again");
  ok((await AddonManager.getAddonByID(id)).userDisabled, "unchanged reload keeps the refusal");
  await writeExtension(dir, { ...manifest, description: "changed after refusal" });
  ok((await rescan()).includes(id), "a manifest change offers approval after refusal");
  addon = await AddonManager.getAddonByID(id);
  await answerPrompt(addon, true);
  await TestUtils.waitForCondition(() => WebExtensionPolicy.getByID(id)?.active, "approved plugin runs");

  // Use the actual Add-ons toggle to turn it off.
  const win = await BrowserAddonUI.openAddonsMgr("addons://list/extension");
  await TestUtils.waitForCondition(() => win.document.querySelector(`addon-card[addon-id="${id}"]`), "plugin card appears");
  const card = win.document.querySelector(`addon-card[addon-id="${id}"]`);
  const label = card.querySelector(".whimsy-local-plugins-label");
  ok(label, "local plugin has a source label in Add-ons");
  await win.document.l10n.translateElements([label]);
  is(label.textContent, "Local plugins", "source label uses the requested Fluent copy");
  const toggle = card.querySelector('moz-toggle[action="toggle-disabled"]');
  ok(toggle, "Add-ons has its normal enable toggle");
  toggle.scrollIntoView();
  await Promise.all(win.document.getAnimations({ subtree: true }).map(a => a.finished.catch(() => {})));
  EventUtils.synthesizeMouseAtCenter(toggle, {}, win);
  await TestUtils.waitForCondition(() => card.addon.userDisabled && !card.addon.isActive && !WebExtensionPolicy.getByID(id), "Add-ons stops the plugin");
  addon = await reloadStoppedPlugin(id);
  ok(addon.userDisabled && !addon.isActive, "the Add-ons off switch survives startup metadata reconstruction");
  ok(!XPIInternal.XPIStates.getLocation(LOCATION).get(id).enabled, "startup state keeps it off");
  await writeExtension(dir, { ...manifest, description: "changed after refusal" });
  ok(!(await rescan()).includes(id), "unchanged disabled plugin does not ask again");
  ok((await AddonManager.getAddonByID(id)).userDisabled, "metadata rescan preserves the user's off choice");
  await IOUtils.remove(dir, { recursive: true });
  await rescan();
  await closeAddonsTabs();
});

add_task(async function test_manifest_v2_and_v3_run_after_approval() {
  for (const version of [2, 3]) {
    const id = `mv${version}@whimsy-plugins.test`;
    const dir = PathUtils.join(PLUGINS, `mv${version}`);
    await writeExtension(dir, manifestFor(id, { manifest_version: version }));
    ok((await rescan()).includes(id), `MV${version} plugin is discovered`);
    const addon = await AddonManager.getAddonByID(id);
    is(addon.manifestVersion, version, "requested manifest version loads");
    ok(!addon.isActive, "approval is required even with no promptable permissions");
    await answerPrompt(addon, false, true);
    ok((await AddonManager.getAddonByID(id)).userDisabled, "Don't Run from Add-ons keeps the permissionless plugin off");
    ok(!(await rescan()).includes(id), "Add-ons refusal is remembered without another prompt");
    await writeExtension(dir, manifestFor(id, { manifest_version: version, description: "updated" }));
    ok((await rescan()).includes(id), "changed permissionless manifest needs consent again");
    await answerPrompt(await AddonManager.getAddonByID(id), true, true);
    await TestUtils.waitForCondition(() => WebExtensionPolicy.getByID(id)?.active, `MV${version} runs after approval`);
    await IOUtils.remove(dir, { recursive: true });
    await rescan();
    await closeAddonsTabs();
  }
});

add_task(async function test_open_addons_list_updates_on_rescan() {
  const win = await BrowserAddonUI.openAddonsMgr("addons://list/extension");
  const doc = win.document;
  await TestUtils.waitForCondition(
    () => doc.querySelector("addon-list") && !doc.querySelector("#main")?.hasAttribute("loading"),
    "Add-ons extension list is open before rescan"
  );
  const list = doc.querySelector("addon-list");
  // Make scrolling possible even when the profile has no other extensions.
  // addon-list is an inline custom element; give its block parent the height.
  doc.getElementById("main").style.minHeight = `${win.innerHeight + 2000}px`;
  win.scrollTo({ top: 120, behavior: "instant" });
  await TestUtils.waitForCondition(() => win.scrollY == 120, "Add-ons list is scrolled");

  const id = "open-list@whimsy-plugins.test";
  const dir = PathUtils.join(PLUGINS, "open-list");
  await writeExtension(dir, manifestFor(id, { description: "first version" }));
  ok((await rescan()).includes(id), "new plugin is found while Add-ons is open");
  const addon = await AddonManager.getAddonByID(id);
  await TestUtils.waitForCondition(
    () => doc.querySelector(`addon-card[addon-id="${id}"]`)?.addon === addon &&
      doc.querySelector(`addon-card[addon-id="${id}"] .addon-description`)?.textContent == "first version",
    "new plugin card appears in the already-open Add-ons list"
  );
  const card = doc.querySelector(`addon-card[addon-id="${id}"]`);
  is(win.document, doc, "Add-ons page was not reloaded");
  is(doc.querySelector("addon-list"), list, "addon-list element was kept in place");
  is(win.scrollY, 120, "scroll position is preserved when a plugin is added");
  is(card.querySelector(".addon-description")?.textContent, "first version", "card shows initial description");

  // A same-version manifest change also replaces the backend wrapper.
  await writeExtension(dir, manifestFor(id, { description: "second version" }));
  ok((await rescan()).includes(id), "changed plugin is found while Add-ons is open");
  const updated = await AddonManager.getAddonByID(id);
  await TestUtils.waitForCondition(
    () => card.addon === updated &&
      card.querySelector(".addon-description")?.textContent == "second version",
    "changed plugin updates its card in the already-open Add-ons list"
  );
  is(win.document, doc, "Add-ons page was not reloaded on manifest change");
  is(doc.querySelector("addon-list"), list, "manifest changes keep the existing list");
  is(doc.querySelector(`addon-card[addon-id="${id}"]`), card, "manifest changes keep the existing card");
  is(win.scrollY, 120, "scroll position is preserved when a plugin changes");
  is(card.querySelector(".addon-description")?.textContent, "second version", "card shows updated description");
  is(doc.querySelectorAll(`addon-card[addon-id="${id}"]`).length, 1, "rescan does not duplicate the card");

  await IOUtils.remove(dir, { recursive: true });
  await rescan();
  await TestUtils.waitForCondition(
    () => !doc.querySelector(`addon-card[addon-id="${id}"]`),
    "removed plugin card disappears from the open Add-ons list"
  );
  is(win.scrollY, 120, "scroll position is preserved when a plugin is removed");
  await closeAddonsTabs();
});

add_task(async function test_open_folder_command_and_setting() {
  const { globalActions } = ChromeUtils.importESModule("resource:///modules/ZenUBGlobalActions.sys.mjs");
  const { WhimsyLocalPlugins } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyLocalPlugins.sys.mjs");
  const actions = globalActions.filter(a => a.commandId == "cmd_whimsyOpenPluginsFolder");
  is(actions.length, 1, "one Open Plugins Folder command");
  is(actions[0].label, "Open Plugins Folder", "command name");
  ok(actions[0].isAvailable(window), "command is offered with the feature on");
  const launch = WhimsyLocalPlugins.launchFolder;
  const opened = [];
  WhimsyLocalPlugins.launchFolder = path => opened.push(path);
  try {
    await IOUtils.remove(PLUGINS, { recursive: true, ignoreAbsent: true });
    await WhimsyLocalPlugins.openFolder();
    ok(await IOUtils.exists(PLUGINS), "opening creates the plugins folder");
    is(opened.pop(), PLUGINS, "opens the profile's plugins folder");
    await BrowserTestUtils.withNewTab("about:preferences#privacy", async browser => {
      const doc = browser.contentDocument;
      await TestUtils.waitForCondition(() => doc.getElementById("whimsyOpenPluginsFolder"), "folder setting inserted");
      const buttons = doc.querySelectorAll("#whimsyLocalPluginsGroup button");
      is(buttons.length, 1, "one folder button in the Local Plugins row");
      buttons[0].scrollIntoView();
      await Promise.all(doc.getAnimations({ subtree: true }).map(a => a.finished.catch(() => {})));
      EventUtils.synthesizeMouseAtCenter(buttons[0], {}, browser.contentWindow);
      await TestUtils.waitForCondition(() => opened.length == 1, "Settings opens the plugins folder");
      is(opened.pop(), PLUGINS, "Settings uses the same folder");
    });
    await SpecialPowers.pushPrefEnv({ set: [["whimsy.feature.local-plugins", false]] });
    try {
      ok(!actions[0].isAvailable(window), "command is hidden with the feature off");
      await WhimsyLocalPlugins.openFolder();
      is(opened.length, 0, "disabled command does not open the folder");
    } finally {
      await SpecialPowers.popPrefEnv();
    }
  } finally {
    WhimsyLocalPlugins.launchFolder = launch;
  }
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
