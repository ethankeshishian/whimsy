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

async function writeState(state) {
  await IOUtils.writeJSON(PathUtils.join(dir, "state.json"), state);
}

add_setup(async () => {
  dir = await IOUtils.createUniqueDirectory(PathUtils.tempDir, "whimsy-updater-test");
  await IOUtils.makeDirectory(PathUtils.join(dir, "logs"));
  await IOUtils.writeUTF8(PathUtils.join(dir, "logs", "update.log"), "line one\nbuilt Zen 1.24b\n");
  for (const key of ["dataDir", "kick", "isInstalled"]) {
    original[key] = WhimsyUpdates[key];
  }
  WhimsyUpdates.dataDir = dir;
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
  is(notice?.version, "1.24b", "A new install shows the notice");
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

  await BrowserTestUtils.withNewTab("about:preferences#zenLooks", async browser => {
    const doc = browser.contentDocument;
    const group = await TestUtils.waitForCondition(() => doc.getElementById("whimsyUpdatesGroup"));
    await TestUtils.waitForCondition(() => group.checkVisibility(), "The Updates group is visible");
    const XUL = "http://www.mozilla.org/keymaster/gatekeeper/there.is.only.xul";
    for (const id of ["whimsyUpdatesAuto", "whimsyUpdatesCheck", "whimsyUiZoom"]) {
      is(doc.getElementById(id)?.namespaceURI, XUL, `#${id} is a real XUL control`);
    }
    const text = id => doc.getElementById(id).textContent;
    const label = id => doc.getElementById(id).getAttribute("label");

    await TestUtils.waitForCondition(() => text("whimsyUpdatesHeadline").includes("1.24b"));
    is(text("whimsyUpdatesHeadline").replace(/[\u2068\u2069]/g, ""), "Up to date · Zen 1.24b", "Shows what's installed");
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

add_task(async function test_updates_settings_for_published_installs() {
  // Installed from a published build: no local updater, Firefox's updater.
  WhimsyUpdates.isInstalled = async () => false;
  await IOUtils.remove(PathUtils.join(dir, "state.json"));
  await BrowserTestUtils.withNewTab("about:preferences#zenLooks", async browser => {
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
