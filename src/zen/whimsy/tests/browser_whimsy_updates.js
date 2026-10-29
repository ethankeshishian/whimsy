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
  WhimsyUpdates.isInstalled = async () => true;
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
    const doc = browser.contentDocument;
    const group = await TestUtils.waitForCondition(() => doc.getElementById("whimsyUpdatesGroup"));
    await TestUtils.waitForCondition(() => group.checkVisibility(), "About Whimsy is visible");
    is(group.dataset.category, "paneAbout", "in the About pane");
    await TestUtils.waitForCondition(() => doc.getElementById("whimsyUpdatesHeader").textContent == "Whimsy version and updates", "headed Whimsy version and updates");
    is(group.previousElementSibling?.dataset.category, "paneAbout", "right after Firefox's About section");
    const XUL = "http://www.mozilla.org/keymaster/gatekeeper/there.is.only.xul";
    for (const id of ["whimsyUpdatesAuto", "whimsyUpdatesCheck", "whimsyUpdatesChannel"]) {
      is(doc.getElementById(id)?.namespaceURI, XUL, `#${id} is a real XUL control`);
    }
    const text = id => doc.getElementById(id).textContent;
    const label = id => doc.getElementById(id).getAttribute("label");

    await TestUtils.waitForCondition(() => text("whimsyUpdatesHeadline").includes("1.24b"));
    const plain = id => text(id).replace(/[\u2068\u2069]/g, "");
    await TestUtils.waitForCondition(() => text("whimsyUpdatesHeadline").includes("1.24b-w2"));
    is(plain("whimsyUpdatesHeadline"), "Up to date · Whimsy 1.24b-w2", "Shows the Whimsy version");
    await TestUtils.waitForCondition(() => text("whimsyUpdatesBase"));
    is(plain("whimsyUpdatesBase"), "Based on Zen 1.24b (dev (2026-10-27)) · Firefox 159.0", "...and its Zen base");

    // The version history, newest first.
    const items = await TestUtils.waitForCondition(() => {
      const list = doc.querySelectorAll("#whimsyUpdatesHistoryList > li");
      return list.length == 2 && [...list].every(li => li.textContent) && list;
    });
    ok(items[0].textContent.includes("1.24b-w2") && items[0].textContent.includes("This version"),
      "The current release is marked");
    ok(items[0].textContent.includes("My Review Requests"), "...with its changes");
    ok(items[0].textContent.includes("Zen 1.24b"), "A new Zen base is called out");
    ok(items[1].textContent.includes("Rebuilt with no Whimsy changes"), "A release with no changes says so");
    ok(text("whimsyUpdatesDetail").startsWith("Last checked"), "Shows when it last checked");
    const rollback = doc.getElementById("whimsyUpdatesRollback");
    await TestUtils.waitForCondition(() => label("whimsyUpdatesRollback")?.includes("1.23.4b"));
    ok(!rollback.disabled, "Rolling back to the previous version is offered");

    // Pause and resume.
    const auto = doc.getElementById("whimsyUpdatesAuto");
    ok(auto.checked, "Automatic updates are on");
    auto.click();
    await TestUtils.waitForCondition(async () => (await WhimsyUpdates.readControl()).paused === true);
    await TestUtils.waitForCondition(() => text("whimsyUpdatesHeadline").startsWith("Paused"));
    ok(doc.getElementById("whimsyUpdatesCheck").disabled, "Check now is off while paused");
    auto.click();
    await TestUtils.waitForCondition(async () => (await WhimsyUpdates.readControl()).paused === false);

    // Check now asks the updater job to run.
    await TestUtils.waitForCondition(() => !doc.getElementById("whimsyUpdatesCheck").disabled);
    doc.getElementById("whimsyUpdatesCheck").click();
    await TestUtils.waitForCondition(() => WhimsyUpdates.kicked.includes("app.whimsy.updater"));
    ok((await WhimsyUpdates.readControl()).check_requested, "The check request is recorded");

    // The log.
    const log = doc.getElementById("whimsyUpdatesLog");
    ok(log.hidden, "The log starts hidden");
    doc.getElementById("whimsyUpdatesShowLog").click();
    await TestUtils.waitForCondition(() => log.textContent.includes("built Zen 1.24b"));
    ok(!log.hidden, "Show log shows it");

    // A staged update.
    await writeState({ status: "idle", installed: { id: "b", version: "1.24b" }, staged: { version: "1.25b" } });
    await TestUtils.waitForCondition(
      () => text("whimsyUpdatesHeadline").includes("1.25b"),
      "A staged update says it's ready"
    );
    ok(text("whimsyUpdatesDetail").includes("next time you quit"), "...and when it installs");

    // No previous version: nothing to roll back to.
    await TestUtils.waitForCondition(() => rollback.disabled, "Roll back is off without a previous version");
  });
});

add_task(async function test_dev_builds() {
  // A build that never went through staging: Zen's version, marked dev.
  await IOUtils.remove(WhimsyUpdates.versionFile);
  const dev = await WhimsyUpdates.readVersion();
  is(dev.version, `${Services.appinfo.version}-dev`, "No version file: a dev build of Zen's version");
  ok(!dev.released, "...not a release");

  // A staged local build: the next version plus -dev, listed above the releases.
  await IOUtils.writeJSON(WhimsyUpdates.versionFile, {
    ...VERSION,
    version: "1.24b-w3-dev",
    commit: "e169bef",
    released: false,
  });
  await BrowserTestUtils.withNewTab("about:preferences#about", async browser => {
    const doc = browser.contentDocument;
    const first = await TestUtils.waitForCondition(() => {
      const item = doc.querySelector("#whimsyUpdatesHistoryList > li");
      return item?.textContent.includes("e169bef") && item;
    });
    ok(first.textContent.includes("1.24b-w3-dev"), "The dev build is listed first");
    ok(first.textContent.includes("not released yet"), "...as unreleased");
  });
  await IOUtils.writeJSON(WhimsyUpdates.versionFile, VERSION);
});

add_task(async function test_updates_settings_for_published_installs() {
  // Installed from a published build: no local updater, Firefox's updater.
  WhimsyUpdates.isInstalled = async () => false;
  await IOUtils.remove(PathUtils.join(dir, "state.json"));
  await BrowserTestUtils.withNewTab("about:preferences#about", async browser => {
    const doc = browser.contentDocument;
    const headline = await TestUtils.waitForCondition(() => doc.getElementById("whimsyUpdatesHeadline"));
    await TestUtils.waitForCondition(() => headline.textContent.includes(Services.appinfo.version));
    ok(headline.textContent.startsWith("Up to date"), "Shows the version Firefox's updater keeps current");
    ok(doc.getElementById("whimsyUpdatesDetail").textContent.includes("restart"), "Explains updates install on restart");
    ok(doc.getElementById("whimsyUpdatesRollback").hidden, "No local rollback");
    ok(doc.getElementById("whimsyUpdatesShowLog").hidden, "No local log");
    ok(!doc.getElementById("whimsyUpdatesCheck").disabled, "Check now is available");
  });
  WhimsyUpdates.isInstalled = async () => true;
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
  WhimsyUpdates.isInstalled = async () => false;
  WhimsyUpdates._channelInit = false;
  await WhimsyUpdates.initChannel();
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
  WhimsyUpdates.isInstalled = async () => true;
  Services.prefs.setStringPref("whimsy.update-channel", "release");
  await TestUtils.waitForCondition(async () => (await WhimsyUpdates.readControl()).channel == "release");
  is(UpdateUtils.UpdateChannel, "local", "Firefox's updater stays out of the way there");
});
