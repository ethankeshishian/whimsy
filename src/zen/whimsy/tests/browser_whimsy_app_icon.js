/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// Whimsy: the app icon picker in Settings and the runtime Dock icon swap.

const { WhimsyAppIcon } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyAppIcon.sys.mjs");

add_setup(async () => {
  registerCleanupFunction(() => Services.prefs.clearUserPref(WhimsyAppIcon.PREF));
});

add_task(async function test_default_icon() {
  is(WhimsyAppIcon.selectedIcon, "daydream", "Daydream is the default icon");
  is(WhimsyAppIcon.resolvedImage, null, "The default uses the bundle's own icon");
});

add_task(async function test_every_icon_has_an_image() {
  for (const id of WhimsyAppIcon.ICONS) {
    const response = await fetch(WhimsyAppIcon.previewURL(id));
    ok(response.ok, `${id} has a preview image`);
  }
});

add_task(async function test_switching_applies_to_the_dock() {
  Services.prefs.setStringPref(WhimsyAppIcon.PREF, "sugar-rush");
  await TestUtils.waitForCondition(() => WhimsyAppIcon._applied === "sugar-rush", "Sugar Rush applied");

  Services.prefs.setStringPref(WhimsyAppIcon.PREF, "day-and-night");
  await TestUtils.waitForCondition(
    () => WhimsyAppIcon._applied?.startsWith("day-and-night-"),
    "Day & Night applied"
  );
  const dark = window.matchMedia("(-moz-system-dark-theme)").matches;
  is(
    WhimsyAppIcon._applied,
    `day-and-night-${dark ? "dark" : "light"}`,
    "Day & Night matches the system appearance"
  );

  Services.prefs.setStringPref(WhimsyAppIcon.PREF, "not-a-real-icon");
  await TestUtils.waitForCondition(() => WhimsyAppIcon._applied === null, "Unknown ids fall back");

  Services.prefs.clearUserPref(WhimsyAppIcon.PREF);
  is(WhimsyAppIcon._applied, null, "Back to the bundle icon");
});

add_task(async function test_settings_picker() {
  await BrowserTestUtils.withNewTab("about:preferences#zenLooks", async browser => {
    const doc = browser.contentDocument;
    const list = await TestUtils.waitForCondition(() => doc.getElementById("whimsyAppIconList"));
    await TestUtils.waitForCondition(() => list.children.length, "Tiles are built");
    is(list.children.length, WhimsyAppIcon.ICONS.length, "One tile per icon");
    ok(doc.getElementById("whimsyAppIconGroup").checkVisibility(), "The App icon group is visible");

    const selected = () => [...list.children].find(t => t.getAttribute("aria-checked") == "true");
    is(selected().dataset.icon, "daydream", "Daydream starts selected");

    const lagoon = list.querySelector('[data-icon="lagoon"]');
    lagoon.click();
    is(Services.prefs.getStringPref(WhimsyAppIcon.PREF), "lagoon", "Clicking a tile picks it");
    is(selected(), lagoon, "The picked tile is marked");

    const label = lagoon.querySelector("span");
    await TestUtils.waitForCondition(() => label.textContent, "Tile labels are translated");
    is(label.textContent, "Lagoon", "The tile shows its name");
  });
  Services.prefs.clearUserPref(WhimsyAppIcon.PREF);
});

// The choice also goes into an installed bundle, so Finder, Spotlight and
// launchers show it, and is saved for the local updater to re-apply.
add_task(async function test_bundle_icon() {
  const { WhimsyUpdates } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyUpdates.sys.mjs");
  is(WhimsyAppIcon.bundlePath(), null, "A build-folder app (links into the source) is never modified");

  const dir = await IOUtils.createUniqueDirectory(PathUtils.tempDir, "whimsy-icon-test");
  const app = PathUtils.join(dir, "Fake.app");
  const res = PathUtils.join(app, "Contents", "Resources");
  await IOUtils.makeDirectory(res, { createAncestors: true });
  await IOUtils.writeUTF8(PathUtils.join(res, "firefox.icns"), "original");
  const saved = { bundlePath: WhimsyAppIcon.bundlePath, dataDir: WhimsyUpdates.dataDir, isInstalled: WhimsyUpdates.isInstalled };
  registerCleanupFunction(async () => {
    WhimsyAppIcon.bundlePath = saved.bundlePath;
    Object.assign(WhimsyUpdates, { dataDir: saved.dataDir, isInstalled: saved.isInstalled });
    await IOUtils.remove(dir, { recursive: true });
  });
  WhimsyAppIcon.bundlePath = () => app;
  WhimsyUpdates.dataDir = PathUtils.join(dir, "updater");
  WhimsyUpdates.isInstalled = () => true;
  const savedIcon = PathUtils.join(WhimsyUpdates.dataDir, "app-icon.icns");

  Services.prefs.setStringPref(WhimsyAppIcon.PREF, "lagoon");
  await TestUtils.waitForCondition(async () => (await WhimsyAppIcon.readMarker(app)) == "lagoon", "Lagoon written");
  await WhimsyAppIcon._bundleJob;
  is(await IOUtils.readUTF8(PathUtils.join(res, "firefox-default.icns")), "original", "The original icon is kept");
  const icns = await IOUtils.read(PathUtils.join(res, "firefox.icns"), { maxBytes: 4 });
  is(String.fromCharCode(...icns), "icns", "The bundle's icon is Lagoon's icns");
  ok(await IOUtils.exists(savedIcon), "...saved for the local updater");
  is((await WhimsyUpdates.readControl()).app_icon, "lagoon", "...which knows the choice");

  Services.prefs.clearUserPref(WhimsyAppIcon.PREF);
  await TestUtils.waitForCondition(async () => (await WhimsyAppIcon.readMarker(app)) == "daydream", "Default written");
  await WhimsyAppIcon._bundleJob;
  is(await IOUtils.readUTF8(PathUtils.join(res, "firefox.icns")), "original", "The default puts the original back");
  ok(!(await IOUtils.exists(savedIcon)), "...and nothing is left to re-apply");
  is((await WhimsyUpdates.readControl()).app_icon, null, "...after updates");
});
