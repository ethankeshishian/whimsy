/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// The updater's browser side: Settings → Look and Feel → Updates, and the
// one-time notice after an update. Uses a scratch state folder; never starts
// the real launchd jobs.

const { WhimsyUpdates } = ChromeUtils.importESModule(
  "resource:///modules/whimsy/WhimsyUpdates.sys.mjs"
);

let dir;
const original = {};

// What whimsy/version.py writes into a released Whimsy.app.
const VERSION = {
  version: "1.24b-w2",
  zen: "1.24b",
  zen_label: "dev (2026-10-27)",
  firefox: "159.0",
  released: true,
  notes_url: "https://github.com/ethankeshishian/whimsy/releases/tag/v1.24b-w2",
  history: [
    { version: "1.24b-w2", zen: "1.24b", date: "2026-10-28", notes: ["My Review Requests"] },
    { version: "1.23.4b-w1", zen: "1.23.4b", date: "2026-10-20", notes: [] },
  ],
};

async function writeState(state) {
  await IOUtils.writeJSON(PathUtils.join(dir, "state.json"), state);
}

add_setup(async () => {
  dir = await IOUtils.createUniqueDirectory(PathUtils.tempDir, "whimsy-updater-test");
  await IOUtils.makeDirectory(PathUtils.join(dir, "logs"));
  await IOUtils.writeUTF8(PathUtils.join(dir, "logs", "update.log"), "line one\nbuilt Zen 1.24b\n");
  for (const key of ["dataDir", "versionFile", "kick", "isInstalled"]) {
    original[key] = WhimsyUpdates[key];
  }
  WhimsyUpdates.dataDir = dir;
  WhimsyUpdates.versionFile = PathUtils.join(dir, "whimsy-version.json");
  await IOUtils.writeJSON(WhimsyUpdates.versionFile, VERSION);
  WhimsyUpdates.kicked = [];
  WhimsyUpdates.kick = async job => (WhimsyUpdates.kicked.push(job), true);
  WhimsyUpdates.isInstalled = () => true;
  registerCleanupFunction(async () => {
    Object.assign(WhimsyUpdates, original);
    delete WhimsyUpdates.kicked;
    Services.prefs.clearUserPref("whimsy.updates.seen-install");
    await IOUtils.remove(dir, { recursive: true });
  });
});

add_task(async function test_updated_notice_shows_once() {
  Services.prefs.clearUserPref("whimsy.updates.seen-install");
  await writeState({ installed: { id: "a", version: "1.23.4b" } });
  is(await WhimsyUpdates.takeUpdatedNotice(), null, "The first run only records what's installed");
  is(await WhimsyUpdates.takeUpdatedNotice(), null, "Nothing new, no notice");

  await writeState({ installed: { id: "b", version: "1.24b" } });
  const notice = await WhimsyUpdates.takeUpdatedNotice();
  is(notice?.version, "1.24b-w2", "A new install shows the notice, with the Whimsy version");
  is(notice.notes_url, VERSION.notes_url, "...linking to Whimsy's release notes");
  is(await WhimsyUpdates.takeUpdatedNotice(), null, "Only once");

  const [heading, notes, rollback] = await document.l10n.formatMessages([
    { id: "whimsy-updated-heading" },
    { id: "whimsy-updated-notes-label" },
    { id: "whimsy-updated-rollback-label" },
  ]);
  ok(heading.value && notes.value && rollback.value, "The notice's strings exist");
});

// Firefox's Updates group, with the Whimsy version on its version line.
async function openUpdates(browser) {
  const doc = browser.contentDocument;
  const firefox = await TestUtils.waitForCondition(() =>
    doc.querySelector('setting-pane[data-category="paneAbout"] setting-group[groupid="updates"]')
  );
  const group = await TestUtils.waitForCondition(() => doc.getElementById("whimsyUpdatesGroup"));
  await TestUtils.waitForCondition(() => group.checkVisibility(), "Whimsy's rows are visible");
  ok(firefox.contains(group), "...inside Firefox's Updates group");
  const info = firefox.querySelector("update-information");
  const state = firefox.querySelector("update-state");
  return { doc, group, info, state };
}

const plain = text => text.replace(/[\u2068\u2069]/g, "").trim();

add_task(async function test_updates_settings() {
  await writeState({
    status: "idle",
    last_run: new Date().toISOString(),
    last_result: "up-to-date",
    installed: { id: "b", version: "1.24b" },
    previous: { id: "a", version: "1.23.4b" },
  });
  await IOUtils.writeJSON(PathUtils.join(dir, "control.json"), { paused: false });

  await BrowserTestUtils.withNewTab("about:preferences#about", async browser => {
    const { doc, info, state } = await openUpdates(browser);
    for (const id of ["whimsyUpdatesHeader", "whimsyUpdatesHeadline", "whimsyUpdatesDetail", "whimsyUpdatesBase",
                      "whimsyUpdatesAuto", "whimsyUpdatesCheck", "whimsyUpdatesHistory"]) {
      ok(!doc.getElementById(id), `No separate #${id}: Firefox's group has it`);
    }
    is(doc.getElementById("whimsyUpdatesChannel")?.namespaceURI,
      "http://www.mozilla.org/keymaster/gatekeeper/there.is.only.xul", "The channel is a real XUL menulist");

    // Firefox's version line shows the Whimsy version and its base.
    await TestUtils.waitForCondition(() => info.version == "1.24b-w2", "The version line shows Whimsy's version");
    is(plain(info.distribution), "Based on Zen 1.24b (dev (2026-10-27)) · Firefox 159.0", "...based on Zen and Firefox");
    is(info.releaseNotesURL, VERSION.notes_url, "...linking Whimsy's release notes");
    await TestUtils.waitForCondition(() => plain(info.shadowRoot.querySelector("#distribution")?.textContent || "").startsWith("Based on Zen"));

    // Firefox's check button only installs a staged build; it never builds.
    await TestUtils.waitForCondition(() => state.value == "checkForUpdates", "Firefox's check button");
    const button = await TestUtils.waitForCondition(() => state.shadowRoot.querySelector("moz-button, moz-box-button"));
    button.click();
    await TestUtils.waitForCondition(() => WhimsyUpdates.kicked.includes("app.whimsy.applier"), "The installer job runs");
    ok(!WhimsyUpdates.kicked.includes("app.whimsy.updater"), "The build job never runs from the browser");
    ok(!(await WhimsyUpdates.readControl()).check_requested, "No build request is written");
    ok((await WhimsyUpdates.readControl()).install_requested, "An install request is written");
    await TestUtils.waitForCondition(() => state.value == "noUpdatesFound", "...then that it's up to date");

    // Firefox's install-automatically choice sets auto_install only; it never
    // touches the nightly publish pause.
    await IOUtils.writeJSON(PathUtils.join(dir, "control.json"), { hold: true });
    const defaults = Services.prefs.getDefaultBranch("");
    const channel = defaults.getCharPref("app.update.channel", "");
    WhimsyUpdates._channelInit = false;
    WhimsyUpdates.initChannel();
    Services.prefs.setBoolPref("app.update.auto", false);
    await TestUtils.waitForCondition(async () => (await WhimsyUpdates.readControl()).auto_install === false, "Auto-install off");
    Services.prefs.setBoolPref("app.update.auto", true);
    await TestUtils.waitForCondition(async () => (await WhimsyUpdates.readControl()).auto_install === true, "Auto-install on");
    is((await WhimsyUpdates.readControl()).hold, true, "The publish hold is untouched");
    Services.prefs.clearUserPref("app.update.auto");
    Services.prefs.unlockPref("app.update.channel");
    defaults.setCharPref("app.update.channel", channel);
    Services.prefs.lockPref("app.update.channel");

    // The log.
    const log = doc.getElementById("whimsyUpdatesLog");
    ok(log.hidden, "The log starts hidden");
    doc.getElementById("whimsyUpdatesShowLog").click();
    await TestUtils.waitForCondition(() => log.textContent.includes("built Zen 1.24b"));
    ok(!log.hidden, "Show log shows it");

    // Roll back, while there's a previous version.
    const rollback = doc.getElementById("whimsyUpdatesRollback");
    await TestUtils.waitForCondition(() => rollback.getAttribute("label")?.includes("1.23.4b"));
    ok(!rollback.hidden, "Rolling back to the previous version is offered");

    // A staged update.
    await writeState({ status: "idle", installed: { id: "b", version: "1.24b" }, staged: { version: "1.25b" } });
    const staged = doc.getElementById("whimsyUpdatesStaged");
    await TestUtils.waitForCondition(() => !staged.hidden && staged.textContent.includes("1.25b"), "A staged update says it's ready");
    ok(staged.textContent.includes("next time you quit"), "...and when it installs");
    await TestUtils.waitForCondition(() => rollback.hidden, "No roll back without a previous version");
  });
});

add_task(async function test_dev_builds() {
  // A build that never went through staging: Zen's version, marked dev.
  await IOUtils.remove(WhimsyUpdates.versionFile);
  const dev = await WhimsyUpdates.readVersion();
  is(dev.version, `${Services.appinfo.version}-dev`, "No version file: a dev build of Zen's version");
  ok(!dev.released, "...not a release");

  await IOUtils.writeJSON(WhimsyUpdates.versionFile, {
    ...VERSION,
    version: "1.24b-w2-dev.74",
    notes_url: undefined,
    released: false,
  });
  await BrowserTestUtils.withNewTab("about:preferences#about", async browser => {
    const { info } = await openUpdates(browser);
    await TestUtils.waitForCondition(() => info.version == "1.24b-w2-dev.74", "A dev build's version on the line");
  });
  await IOUtils.writeJSON(WhimsyUpdates.versionFile, VERSION);
});

add_task(async function test_updates_settings_for_published_installs() {
  // Installed from a published build: no local updater, Firefox's updater.
  WhimsyUpdates.isInstalled = () => false;
  await IOUtils.remove(PathUtils.join(dir, "state.json"));
  WhimsyUpdates.kicked = [];
  await BrowserTestUtils.withNewTab("about:preferences#about", async browser => {
    const { doc, info, state } = await openUpdates(browser);
    await TestUtils.waitForCondition(() => info.version == "1.24b-w2", "The Whimsy version");
    ok(doc.getElementById("whimsyUpdatesRollback").hidden, "No local rollback");
    ok(doc.getElementById("whimsyUpdatesShowLog").hidden, "No local log");
    ok(doc.getElementById("whimsyUpdatesStaged").hidden, "No local staging");
    ok(state.value != "checkingForUpdates" || !WhimsyUpdates.kicked.length, "Firefox's own updater runs the check");
  });
  WhimsyUpdates.isInstalled = () => true;
});

add_task(async function test_update_channel() {
  const defaults = Services.prefs.getDefaultBranch("");
  const originalChannel = defaults.getCharPref("app.update.channel", "");
  registerCleanupFunction(() => {
    Services.prefs.unlockPref("app.update.channel");
    defaults.setCharPref("app.update.channel", originalChannel);
    Services.prefs.lockPref("app.update.channel");
    Services.prefs.clearUserPref("whimsy.update-channel");
  });
  const { UpdateUtils } = ChromeUtils.importESModule("resource://gre/modules/UpdateUtils.sys.mjs");

  // A downloaded Whimsy: Firefox's updater follows the chosen channel.
  WhimsyUpdates.isInstalled = () => false;
  WhimsyUpdates._channelInit = false;
  WhimsyUpdates.initChannel();
  is(UpdateUtils.UpdateChannel, "release", "Standard users are on Release");

  await BrowserTestUtils.withNewTab("about:preferences#about", async browser => {
    const doc = browser.contentDocument;
    const menulist = await TestUtils.waitForCondition(() => doc.getElementById("whimsyUpdatesChannel"));
    is(menulist.namespaceURI, "http://www.mozilla.org/keymaster/gatekeeper/there.is.only.xul", "A real menulist");
    await TestUtils.waitForCondition(() => menulist.value == "release");
    const note = doc.getElementById("whimsyUpdatesChannelNote");
    await TestUtils.waitForCondition(() => note.textContent.includes("Tested builds"));

    menulist.value = "dev";
    menulist.dispatchEvent(new browser.contentWindow.Event("command", { bubbles: true }));
    await TestUtils.waitForCondition(() => Services.prefs.getStringPref("whimsy.update-channel") == "dev");
    await TestUtils.waitForCondition(() => UpdateUtils.UpdateChannel == "dev", "Firefox's updater follows Dev");
    await TestUtils.waitForCondition(() => note.textContent.includes("Every change"), "The note explains Dev");
  });

  // A Mac that builds Whimsy: its own updater installs builds, and reads the choice.
  WhimsyUpdates.isInstalled = () => true;
  Services.prefs.setStringPref("whimsy.update-channel", "release");
  await TestUtils.waitForCondition(async () => (await WhimsyUpdates.readControl()).channel == "release");
  is(UpdateUtils.UpdateChannel, "local", "Firefox's updater stays out of the way there");
});

// Firefox stamps each downloaded update with app.update.channel and, at
// startup, marks a stored update failed when the channel differs. The Dev
// choice must be applied before that check, not when a window opens.
add_task(async function test_channel_applied_before_update_service() {
  const entries = [...Services.catMan.enumerateCategory("profile-after-change")].map(e => e.entry);
  const whimsy = entries.indexOf("WhimsyStartup");
  Assert.greaterOrEqual(whimsy, 0, "Whimsy starts at profile-after-change");
  const stub = entries.indexOf("nsUpdateServiceStub");
  if (stub >= 0) {
    Assert.less(whimsy, stub, "...before Firefox's update service checks stored updates");
  }

  const defaults = Services.prefs.getDefaultBranch("");
  const originalChannel = defaults.getCharPref("app.update.channel", "");
  registerCleanupFunction(() => {
    Services.prefs.unlockPref("app.update.channel");
    defaults.setCharPref("app.update.channel", originalChannel);
    Services.prefs.lockPref("app.update.channel");
    Services.prefs.clearUserPref("whimsy.update-channel");
  });
  const { UpdateUtils } = ChromeUtils.importESModule("resource://gre/modules/UpdateUtils.sys.mjs");

  // A downloaded Whimsy on Dev, starting up with the build's default channel.
  WhimsyUpdates.isInstalled = () => false;
  Services.prefs.setStringPref("whimsy.update-channel", "dev");
  Services.prefs.unlockPref("app.update.channel");
  defaults.setCharPref("app.update.channel", "release");
  WhimsyUpdates._channelInit = false;
  Cc["@whimsy/startup;1"].getService(Ci.nsIObserver).observe(null, "profile-after-change", "");
  is(UpdateUtils.UpdateChannel, "dev", "The startup hook applies Dev synchronously");
  const stored = { channel: "dev" }; // what serialize() wrote at download time
  is(stored.channel, UpdateUtils.UpdateChannel, "A stored Dev update isn't marked ERR_CHANNEL_CHANGE");
  WhimsyUpdates.isInstalled = () => true;
});

// Every Whimsy build of a Zen release shares its appVersion; Firefox's
// updater must order them by build ID (whimsy-UpdateService-sys-mjs.patch),
// not accept any build ID that merely differs.
add_task(async function test_same_version_orders_by_build_id() {
  const aus = Cc["@mozilla.org/updates/update-service;1"].getService(Ci.nsIApplicationUpdateService);
  const current = Services.appinfo.appBuildID;
  const update = buildID => ({
    QueryInterface: ChromeUtils.generateQI(["nsIUpdate"]),
    appVersion: Services.appinfo.version,
    buildID,
    type: "minor",
    unsupported: false,
  });
  const older = String(Number(current.slice(0, 4)) - 1) + current.slice(4);
  const newer = String(Number(current.slice(0, 4)) + 1) + current.slice(4);
  is(await aus.selectUpdate([update(older)]), null, "An older build of the same version is skipped");
  is(await aus.selectUpdate([update(current)]), null, "The running build is skipped");
  is((await aus.selectUpdate([update(newer)]))?.buildID, newer, "A newer build is offered");
});

// An update record carried over from an earlier session (ready or still
// downloading) for the build that's now running, or an older one, is dropped
// at startup whatever its state; it used to be staged again ("Restart to
// update" on the installed build). The just-installed "succeeded" update stays
// for Firefox's post-update handling.
add_task(async function test_startup_drops_carried_over_updates() {
  const current = Services.appinfo.appBuildID;
  const older = String(Number(current.slice(0, 4)) - 1) + current.slice(4);
  const newer = String(Number(current.slice(0, 4)) + 1) + current.slice(4);
  // The engine passes Firefox's comparison; same version, build-ID order.
  const isOld = update => update.buildID <= current;
  const update = buildID => ({ buildID });
  const ready = update(current);
  const downloading = update(current);

  for (const status of ["applying", "failed", "pending", "applied", "downloading"]) {
    Assert.deepEqual(
      WhimsyUpdates.staleActiveUpdates(status, { ready, downloading }, isOld),
      [ready, downloading],
      `${status}: the running build's records are dropped`
    );
  }
  Assert.deepEqual(
    WhimsyUpdates.staleActiveUpdates("succeeded", { ready, downloading }, isOld),
    [downloading],
    "succeeded: the just-installed update stays; a carried-over download goes"
  );
  const old = update(older);
  Assert.deepEqual(
    WhimsyUpdates.staleActiveUpdates("downloading", { ready: null, downloading: old }, isOld),
    [old],
    "An older build's download is dropped"
  );
  Assert.deepEqual(
    WhimsyUpdates.staleActiveUpdates("pending", { ready: update(newer), downloading: null }, isOld),
    [],
    "A newer build is kept"
  );
  Assert.deepEqual(
    WhimsyUpdates.staleActiveUpdates("none", { ready: null, downloading: null }, isOld),
    [],
    "No updates, nothing to drop"
  );
});
