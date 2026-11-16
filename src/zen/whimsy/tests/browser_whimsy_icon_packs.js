/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// W29 icon-sets: Lucide and Phosphor-fill alternatives to Zen's own Nucleo
// icons. WhimsyIconPack is the Settings picker's metadata (packs, preview
// icons, image URLs); WhimsyLook.initIconPack applies the pick live by
// loading a generated override stylesheet as a USER_SHEET, the same
// mechanism WhimsySpaceLook uses for a space's mod.

const { WhimsyIconPack } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyIconPack.sys.mjs");
const { WhimsyLook } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyLook.sys.mjs");

const FEATURE = "whimsy.feature.icon-pack";
const PREF = WhimsyIconPack.PREF;

registerCleanupFunction(() => {
  Services.prefs.clearUserPref(FEATURE);
  Services.prefs.clearUserPref(PREF);
});

function backButtonImage() {
  return window.getComputedStyle(document.getElementById("back-button")).listStyleImage;
}

add_task(async function test_default_pack() {
  is(WhimsyIconPack.selectedPack, "nucleo", "Nucleo (Whimsy's own icons) is the default");
  is(WhimsyLook.iconPackURL(), null, "Nucleo needs no override sheet");
  ok(backButtonImage().includes("zen-icons/back.svg"), "The back button starts with Zen's own icon");
});

add_task(async function test_every_pack_has_every_preview_icon() {
  for (const pack of WhimsyIconPack.PACKS) {
    for (const name of WhimsyIconPack.PREVIEW_ICONS) {
      const url = await WhimsyIconPack.previewURL(pack, name);
      const response = await fetch(url);
      ok(response.ok, `${pack}/${name} has a preview image (${url})`);
    }
  }
});

add_task(async function test_switching_applies_live() {
  is(WhimsyLook.iconPackURL(), null, "Starts on Nucleo");

  Services.prefs.setStringPref(PREF, "lucide");
  await TestUtils.waitForCondition(
    () => backButtonImage().includes("icon-packs/lucide/back.svg"),
    "Lucide's back icon applies to the open window"
  );

  Services.prefs.setStringPref(PREF, "phosphor-fill");
  await TestUtils.waitForCondition(
    () => backButtonImage().includes("icon-packs/phosphor-fill/back.svg"),
    "Phosphor's back icon applies"
  );

  // An id the picker doesn't know falls back to Nucleo rather than a
  // missing sheet.
  Services.prefs.setStringPref(PREF, "not-a-real-pack");
  await TestUtils.waitForCondition(() => backButtonImage().includes("zen-icons/back.svg"), "Unknown ids fall back to Nucleo");
  is(WhimsyLook.iconPackURL(), null, "...with no sheet loaded");

  Services.prefs.setStringPref(PREF, "lucide");
  await TestUtils.waitForCondition(() => backButtonImage().includes("icon-packs/lucide/back.svg"), "Lucide again");

  Services.prefs.setBoolPref(FEATURE, false);
  await TestUtils.waitForCondition(() => backButtonImage().includes("zen-icons/back.svg"), "The feature switch restores Nucleo");
  is(WhimsyLook.iconPackURL(), null, "...even with a pack still chosen");

  Services.prefs.clearUserPref(FEATURE);
  await TestUtils.waitForCondition(() => backButtonImage().includes("icon-packs/lucide/back.svg"), "Turning it back on reapplies the pick");

  Services.prefs.clearUserPref(PREF);
  await TestUtils.waitForCondition(() => backButtonImage().includes("zen-icons/back.svg"), "Clearing the pref restores Nucleo");
});

add_task(async function test_settings_picker() {
  Services.prefs.clearUserPref(FEATURE);
  Services.prefs.clearUserPref(PREF);
  await BrowserTestUtils.withNewTab("about:preferences#zenLooks", async browser => {
    const doc = browser.contentDocument;
    const list = await TestUtils.waitForCondition(() => doc.getElementById("whimsyIconPackList"));
    await TestUtils.waitForCondition(() => list.children.length, "Cards are built");
    is(list.children.length, WhimsyIconPack.PACKS.length, "One card per pack");
    ok(doc.getElementById("whimsyIconPackRow").checkVisibility(), "The row is visible");

    const selected = () => [...list.children].find(c => c.getAttribute("aria-checked") == "true");
    is(selected().dataset.pack, "nucleo", "Whimsy's own icons start selected");

    const lucideCard = list.querySelector('[data-pack="lucide"]');
    const label = lucideCard.querySelector(".whimsy-icon-pack-name span:last-child");
    const detail = lucideCard.querySelector(".whimsy-icon-pack-detail");
    await TestUtils.waitForCondition(() => label.textContent, "Card names are translated");
    is(label.textContent, "Outline", "Lucide's card is named Outline");
    is(detail.textContent, "Lucide · thin strokes", "...with its detail line");

    const glyphs = lucideCard.querySelectorAll(".whimsy-icon-pack-glyphs img");
    is(glyphs.length, WhimsyIconPack.PREVIEW_ICONS.length, "Each card previews the same six icons");
    await TestUtils.waitForCondition(() => [...glyphs].every(img => img.src), "Every glyph gets a source");

    lucideCard.click();
    is(Services.prefs.getStringPref(PREF), "lucide", "Clicking a card picks it");
    is(selected(), lucideCard, "The picked card is marked");

    const preview = doc.getElementById("whimsyIconPackPreview");
    await TestUtils.waitForCondition(
      () => preview.children.length == WhimsyIconPack.PREVIEW_ICONS.length,
      "The toolbar preview strip shows the same six icons"
    );
    await TestUtils.waitForCondition(
      () => [...preview.children].every(img => img.src.includes("icon-packs/lucide/")),
      "...rendered in the picked pack"
    );

    const nucleoCard = list.querySelector('[data-pack="nucleo"]');
    nucleoCard.click();
    is(Services.prefs.getStringPref(PREF), "nucleo", "Picking Whimsy's own icons again");
    await TestUtils.waitForCondition(
      () => [...preview.children].every(img => img.src.includes("zen-icons/")),
      "...and the preview strip goes back to Nucleo"
    );
  });
  Services.prefs.clearUserPref(PREF);
});
