/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// Whimsy: the app icon picker in Settings and the runtime Dock icon swap.

const { ZenAppIcon } = ChromeUtils.importESModule("resource:///modules/ZenAppIcon.sys.mjs");

add_setup(async () => {
  registerCleanupFunction(() => Services.prefs.clearUserPref(ZenAppIcon.PREF));
});

add_task(async function test_default_icon() {
  is(ZenAppIcon.selectedIcon, "daydream", "Daydream is the default icon");
  is(ZenAppIcon.resolvedImage, null, "The default uses the bundle's own icon");
});

add_task(async function test_every_icon_has_an_image() {
  for (const id of ZenAppIcon.ICONS) {
    const response = await fetch(ZenAppIcon.previewURL(id));
    ok(response.ok, `${id} has a preview image`);
  }
});

add_task(async function test_switching_applies_to_the_dock() {
  Services.prefs.setStringPref(ZenAppIcon.PREF, "sugar-rush");
  await TestUtils.waitForCondition(() => ZenAppIcon._applied === "sugar-rush", "Sugar Rush applied");

  Services.prefs.setStringPref(ZenAppIcon.PREF, "day-and-night");
  await TestUtils.waitForCondition(
    () => ZenAppIcon._applied?.startsWith("day-and-night-"),
    "Day & Night applied"
  );
  const dark = window.matchMedia("(-moz-system-dark-theme)").matches;
  is(
    ZenAppIcon._applied,
    `day-and-night-${dark ? "dark" : "light"}`,
    "Day & Night matches the system appearance"
  );

  Services.prefs.setStringPref(ZenAppIcon.PREF, "not-a-real-icon");
  await TestUtils.waitForCondition(() => ZenAppIcon._applied === null, "Unknown ids fall back");

  Services.prefs.clearUserPref(ZenAppIcon.PREF);
  is(ZenAppIcon._applied, null, "Back to the bundle icon");
});

add_task(async function test_settings_picker() {
  await BrowserTestUtils.withNewTab("about:preferences#zenLooks", async browser => {
    const doc = browser.contentDocument;
    const list = await TestUtils.waitForCondition(() => doc.getElementById("zenAppIconList"));
    await TestUtils.waitForCondition(() => list.children.length, "Tiles are built");
    is(list.children.length, ZenAppIcon.ICONS.length, "One tile per icon");
    ok(doc.getElementById("zenAppIconGroup").checkVisibility(), "The App icon group is visible");

    const selected = () => [...list.children].find(t => t.getAttribute("aria-checked") == "true");
    is(selected().dataset.icon, "daydream", "Daydream starts selected");

    const lagoon = list.querySelector('[data-icon="lagoon"]');
    lagoon.click();
    is(Services.prefs.getStringPref(ZenAppIcon.PREF), "lagoon", "Clicking a tile picks it");
    is(selected(), lagoon, "The picked tile is marked");

    const label = lagoon.querySelector("span");
    await TestUtils.waitForCondition(() => label.textContent, "Tile labels are translated");
    is(label.textContent, "Lagoon", "The tile shows its name");
  });
  Services.prefs.clearUserPref(ZenAppIcon.PREF);
});
