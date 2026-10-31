/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// wave5/look: a look per space. A space keeps only what it changes (font,
// density, title lines, a Zen Mod); the rest follows Settings. Each tab
// list carries its own space's look; the window takes the active space's
// as you switch, and gives it back when you leave. W8-36: the editor is an
// overlay like Zen's theme picker, with a live preview, Done and Cancel.

const { WhimsySpaceLook, normalizeLook } = ChromeUtils.importESModule(
  "resource:///modules/whimsy/WhimsySpaceLook.sys.mjs"
);
const { WhimsyLook } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyLook.sys.mjs");

const FEATURE = "whimsy.feature.space-look";
const MOD_ID = "whimsy-test-space-mod";

let home, other;

const root = () => document.documentElement;
const list = space => gZenWorkspaces.workspaceElement(space.uuid);
const stored = space => gZenWorkspaces.getWorkspaces().find(w => w.uuid == space.uuid)?.whimsyLook;

async function switchTo(space) {
  await gZenWorkspaces.changeWorkspaceWithID(space.uuid);
  await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
}

add_setup(async function () {
  // The look changes at once instead of at the bottom of the dip.
  await SpecialPowers.pushPrefEnv({ set: [["ui.prefersReducedMotion", 1]] });
  home = gZenWorkspaces.getActiveWorkspace();
  other = await gZenWorkspaces.createAndSaveWorkspace("Reading", undefined, true);
  registerCleanupFunction(async () => {
    Services.prefs.clearUserPref(FEATURE);
    for (const space of [home, other]) {
      WhimsySpaceLook.reset(window, space.uuid);
    }
    if (gZenWorkspaces.activeWorkspace != home.uuid) {
      await gZenWorkspaces.changeWorkspaceWithID(home.uuid);
    }
    await gZenWorkspaces.removeWorkspace(other.uuid);
  });
});

add_task(function test_normalize() {
  Assert.deepEqual(normalizeLook(null), {}, "Nothing stored: follow Settings");
  Assert.deepEqual(
    normalizeLook({ font: 'Geor"gia;', density: "huge", lines: 5, mod: "", extra: 1 }),
    { font: "Georgia" },
    "Only known keys and valid values survive; the font is a bare family"
  );
  Assert.deepEqual(normalizeLook({ font: "" }), { font: "" }, "The system font is a choice of its own");
  Assert.deepEqual(
    normalizeLook({ density: "roomy", lines: "2", mod: "x" }),
    { density: "roomy", lines: 2, mod: "x" },
    "Density, lines and mod"
  );
});

add_task(async function test_follows_settings_by_default() {
  ok(Services.prefs.getBoolPref(FEATURE), "On by default");
  is(stored(other), undefined, "A new space stores no look");
  for (const space of [home, other]) {
    for (const attr of ["whimsy-look-font", "whimsy-look-lines", "whimsy-look-density"]) {
      ok(!list(space).hasAttribute(attr), `${space.name}: no ${attr} while no space overrides it`);
    }
  }
  ok(!root().hasAttribute("uidensity"), "Firefox's normal density");
  is(WhimsyLook.windowFont(window), WhimsyLook.uiFont(), "The window uses Settings' font");
});

add_task(async function test_switching_applies_and_restores() {
  WhimsySpaceLook.setLook(window, other.uuid, { font: "Georgia", density: "compact", lines: 2 });
  Assert.deepEqual(stored(other), { font: "Georgia", density: "compact", lines: 2 }, "Stored with the space");

  // Each list carries its own space's look before anyone switches.
  is(list(other).getAttribute("whimsy-look-density"), "compact", "Reading's list is compact");
  is(list(other).getAttribute("whimsy-look-lines"), "2", "and wraps titles onto two lines");
  ok(list(other).style.getPropertyValue("--whimsy-space-font").includes("Georgia"), "in Georgia");
  is(getComputedStyle(list(other)).getPropertyValue("--tab-min-height").trim(), "29px", "Compact tab height");
  is(list(home).getAttribute("whimsy-look-density"), "normal", "Home's list keeps Settings' density");
  is(list(home).getAttribute("whimsy-look-lines"), "1", "and Settings' one line");
  ok(!root().hasAttribute("uidensity"), "The window still wears Home's look");

  await switchTo(other);
  is(root().getAttribute("uidensity"), "compact", "Switching to Reading makes the window compact");
  ok(root().hasAttribute("whimsy-ui-font"), "and sets its font");
  ok(root().style.getPropertyValue("--whimsy-ui-font").includes("Georgia"), "Georgia");
  gUIDensity.update();
  is(root().getAttribute("uidensity"), "compact", "Firefox re-reading its density keeps the space's");

  await switchTo(home);
  ok(!root().hasAttribute("uidensity"), "Back home: normal density again");
  ok(!root().hasAttribute("whimsy-ui-font"), "and the system font");
});

add_task(async function test_unset_parts_follow_settings() {
  WhimsySpaceLook.setLook(window, other.uuid, { font: undefined, lines: undefined });
  Assert.deepEqual(stored(other), { density: "compact" }, "Only the density is left");

  await SpecialPowers.pushPrefEnv({ set: [["browser.uidensity", 2]] });
  is(list(home).getAttribute("whimsy-look-density"), "roomy", "Home follows Settings' new density");
  is(list(other).getAttribute("whimsy-look-density"), "compact", "Reading keeps its own");
  is(root().getAttribute("uidensity"), "touch", "The window (on Home) is roomy");

  await SpecialPowers.pushPrefEnv({ set: [["whimsy.look.ui-font", "Menlo"]] });
  await switchTo(other);
  is(root().getAttribute("uidensity"), "compact", "Reading: compact");
  ok(root().style.getPropertyValue("--whimsy-ui-font").includes("Menlo"), "with Settings' font, which it doesn't override");

  WhimsySpaceLook.setLook(window, other.uuid, { font: "" });
  ok(!root().hasAttribute("whimsy-ui-font"), "A space can ask for the system font over Settings' choice");
  is(list(other).style.getPropertyValue("--whimsy-space-font"), "system-ui", "in its list too");
  ok(list(home).style.getPropertyValue("--whimsy-space-font").includes("Menlo"), "Home's list keeps Settings' font");

  await switchTo(home);
  await SpecialPowers.popPrefEnv();
  await SpecialPowers.popPrefEnv();
  ok(!root().hasAttribute("uidensity"), "Settings back to normal");
});

add_task(async function test_reset() {
  WhimsySpaceLook.setLook(window, other.uuid, { font: "Georgia", density: "roomy", lines: 3 });
  WhimsySpaceLook.reset(window, other.uuid);
  is(stored(other), undefined, "Reset forgets the look");
  for (const attr of ["whimsy-look-font", "whimsy-look-lines", "whimsy-look-density"]) {
    ok(!list(other).hasAttribute(attr), `No ${attr} left`);
  }
  await switchTo(other);
  ok(!root().hasAttribute("uidensity"), "Reading looks like Settings again");
  await switchTo(home);
});

add_task(async function test_mod_for_one_space() {
  const modsFile = gZenMods.modsDataFile;
  const before = (await IOUtils.exists(modsFile)) ? await IOUtils.readUTF8(modsFile) : null;
  const folder = gZenMods.getModFolder(MOD_ID);
  await IOUtils.makeDirectory(folder, { createAncestors: true });
  await IOUtils.writeUTF8(PathUtils.join(folder, "chrome.css"), ":root { --whimsy-test-space-mod: 7px; }");
  const mods = await gZenMods.getMods();
  mods[MOD_ID] = { id: MOD_ID, name: "Whimsy Test Mod", enabled: false, preferences: false };
  await IOUtils.writeJSON(modsFile, mods);
  const modValue = () => getComputedStyle(root()).getPropertyValue("--whimsy-test-space-mod").trim();
  try {
    const available = await WhimsySpaceLook.availableMods(window);
    ok(available.some(mod => mod.id == MOD_ID), "A mod that's off in Zen Mods can go on one space");
    is(modValue(), "", "The mod is off");

    WhimsySpaceLook.setLook(window, other.uuid, { mod: MOD_ID });
    await switchTo(other);
    await TestUtils.waitForCondition(() => modValue() == "7px", "The mod turns on in Reading");
    is(root().getAttribute("whimsy-space-mod"), MOD_ID, "Marked on the window");

    await switchTo(home);
    await TestUtils.waitForCondition(() => modValue() == "", "and off again at home, without a reload");

    // On everywhere already: nothing extra.
    mods[MOD_ID].enabled = true;
    await IOUtils.writeJSON(modsFile, mods);
    ok(!(await WhimsySpaceLook.availableMods(window)).some(mod => mod.id == MOD_ID), "A mod that's on isn't offered");
  } finally {
    WhimsySpaceLook.reset(window, other.uuid);
    await IOUtils.remove(folder, { recursive: true, ignoreAbsent: true });
    if (before === null) {
      await IOUtils.remove(modsFile, { ignoreAbsent: true });
    } else {
      await IOUtils.writeUTF8(modsFile, before);
    }
  }
});

add_task(async function test_switch_off() {
  WhimsySpaceLook.setLook(window, other.uuid, { density: "compact", lines: 2 });
  await switchTo(other);
  is(root().getAttribute("uidensity"), "compact", "Compact while on");

  await SpecialPowers.pushPrefEnv({ set: [[FEATURE, false]] });
  ok(!root().hasAttribute("uidensity"), "Switch off: Settings' density at once");
  ok(!list(other).hasAttribute("whimsy-look-lines"), "and Settings' title lines");
  Assert.deepEqual(stored(other), { density: "compact", lines: 2 }, "The look is kept for later");

  await SpecialPowers.popPrefEnv();
  is(root().getAttribute("uidensity"), "compact", "Switch on: the look comes back");
  WhimsySpaceLook.reset(window, other.uuid);
  await switchTo(home);
});

// W8-36: the editor is an overlay like Zen's theme picker. Changes
// preview on the real sidebar without saving; Done keeps, Cancel and Esc
// put the space back.
async function openEditor(space = other) {
  const panel = WhimsySpaceLook.openEditor(window, space.uuid);
  ok(panel, "The editor opens");
  await BrowserTestUtils.waitForPopupEvent(panel, "shown");
  await document.l10n.translateFragment(panel);
  return panel;
}

async function closeWith(panel, selector) {
  const hidden = BrowserTestUtils.waitForPopupEvent(panel, "hidden");
  panel.querySelector(selector).doCommand();
  await hidden;
}

const segment = (panel, group, value) => panel.querySelector(`[data-group="${group}"] [data-value="${value}"]`);
const section = (panel, name) => panel.querySelector(`[data-section="${name}"]`);

add_task(async function test_editor_opens_on_the_space_like_the_theme_picker() {
  is(gZenWorkspaces.activeWorkspace, home.uuid, "Home is showing");
  const panel = await openEditor(other);
  is(gZenWorkspaces.activeWorkspace, other.uuid, "Editing another space shows it, so the preview is on the real sidebar");
  ok(panel.classList.contains("whimsy-look-picker"), "Built like Zen's theme picker");
  is(panel.getAttribute("hidepopovertail"), "true", "with no arrow, as Zen's picker");
  ok(panel.querySelector(".whimsy-look-pad .whimsy-look-specimen"), "Its pad shows a type specimen");
  is(document.activeElement, panel.querySelector(".whimsy-look-search"), "The font search has the keyboard");
  for (const name of ["font", "density", "lines"]) {
    ok(!section(panel, name).querySelector(".whimsy-look-default-tag").hidden, `${name}: Browser default`);
    ok(section(panel, name).querySelector(".whimsy-look-use-default").hidden, `${name}: nothing to put back`);
  }
  is(segment(panel, "density", "normal").getAttribute("aria-checked"), "true", "Density shows Settings' Normal");
  is(segment(panel, "lines", "1").getAttribute("aria-checked"), "true", "Titles show Settings' one line");
  ok(panel.querySelector(".whimsy-look-reset").disabled, "Nothing to reset");
  ok(!document.querySelector(".whimsy-space-look-chip, panel.whimsy-sheet.whimsy-space-look"), "The old editor is gone");
  await closeWith(panel, ".whimsy-look-cancel");
  await switchTo(home);
});

add_task(async function test_preview_then_cancel_reverts() {
  await switchTo(other);
  const panel = await openEditor(other);
  segment(panel, "density", "roomy").click();
  is(stored(other), undefined, "A change isn't saved while you look");
  is(list(other).getAttribute("whimsy-look-density"), "roomy", "but the sidebar shows it at once");
  is(root().getAttribute("uidensity"), "touch", "and so does the window");
  ok(!list(home).hasAttribute("whimsy-look-density") || list(home).getAttribute("whimsy-look-density") == "normal",
    "Home's list keeps its own look");
  is(segment(panel, "density", "roomy").getAttribute("aria-checked"), "true", "Roomy is ticked");
  ok(section(panel, "density").querySelector(".whimsy-look-default-tag").hidden, "no longer the browser default");
  ok(!section(panel, "density").querySelector(".whimsy-look-use-default").hidden, "and it can go back to it");
  ok(!panel.querySelector(".whimsy-look-reset").disabled, "Reset is offered");

  await closeWith(panel, ".whimsy-look-cancel");
  is(stored(other), undefined, "Cancel saves nothing");
  ok(!list(other).hasAttribute("whimsy-look-density"), "and the sidebar is back as it was");
  ok(!root().hasAttribute("uidensity"), "so is the window");
  ok(!document.getElementById("whimsy-space-look-panel"), "The editor is gone");
});

add_task(async function test_escape_cancels() {
  const panel = await openEditor(other);
  segment(panel, "lines", "3").click();
  is(list(other).getAttribute("whimsy-look-lines"), "3", "Three lines, previewed");
  const search = panel.querySelector(".whimsy-look-search");
  search.focus();
  search.value = "zzzz-no-such-font";
  search.dispatchEvent(new Event("input"));
  ok(!panel.querySelector(".whimsy-look-empty").hidden, "No match says so");
  EventUtils.synthesizeKey("KEY_Escape");
  is(search.value, "", "The first Esc clears the search");
  is(panel.state, "open", "and leaves the editor open");
  const hidden = BrowserTestUtils.waitForPopupEvent(panel, "hidden");
  EventUtils.synthesizeKey("KEY_Escape");
  await hidden;
  is(stored(other), undefined, "Esc cancels");
  ok(!list(other).hasAttribute("whimsy-look-lines"), "and the preview goes");
});

add_task(async function test_done_keeps_and_keyboard() {
  const panel = await openEditor(other);
  // Density: one tab stop, arrows move and pick.
  segment(panel, "density", "normal").focus();
  EventUtils.synthesizeKey("KEY_ArrowLeft");
  is(segment(panel, "density", "compact").getAttribute("aria-checked"), "true", "Left picks Compact");
  is(document.activeElement, segment(panel, "density", "compact"), "and takes the focus");
  is(panel.querySelectorAll('[data-group="density"] [tabindex="0"]').length, 1, "One tab stop in the group");
  is(list(other).getAttribute("whimsy-look-density"), "compact", "previewed");

  // Font: the search narrows the list; Return picks the first match.
  const fonts = panel.querySelector('[data-list="font"]');
  const search = panel.querySelector(".whimsy-look-search");
  search.focus();
  search.value = "system";
  search.dispatchEvent(new Event("input"));
  ok([...fonts.children].filter(r => !r.hidden).length >= 1, "System font matches");
  EventUtils.synthesizeKey("KEY_Enter");
  is(panel.state, "open", "Return in the search picks, it doesn't close");
  is(list(other).style.getPropertyValue("--whimsy-space-font"), "system-ui", "The system font, previewed");
  ok(!section(panel, "font").querySelector(".whimsy-look-use-default").hidden, "The font is the space's own now");

  await closeWith(panel, ".whimsy-look-done");
  Assert.deepEqual(stored(other), { font: "", density: "compact" }, "Done keeps the look");
  is(root().getAttribute("uidensity"), "compact", "and the window keeps showing it");
});

add_task(async function test_use_default_and_reset() {
  let panel = await openEditor(other);
  ok(!panel.querySelector(".whimsy-look-reset").disabled, "Something to reset");
  section(panel, "density").querySelector(".whimsy-look-use-default").click();
  ok(!section(panel, "density").querySelector(".whimsy-look-default-tag").hidden, "Density follows the browser again");
  is(segment(panel, "density", "normal").getAttribute("aria-checked"), "true", "showing Settings' value");
  ok(section(panel, "font").querySelector(".whimsy-look-default-tag").hidden, "The font is still the space's");
  await closeWith(panel, ".whimsy-look-done");
  Assert.deepEqual(stored(other), { font: "" }, "Only the font is left");

  panel = await openEditor(other);
  panel.querySelector(".whimsy-look-reset").doCommand();
  ok(panel.querySelector(".whimsy-look-reset").disabled, "Reset: everything follows the browser");
  is(stored(other)?.font, "", "Reset previews; nothing is saved yet");
  ok(!list(other).hasAttribute("whimsy-look-font"), "The sidebar shows it");
  await closeWith(panel, ".whimsy-look-done");
  is(stored(other), undefined, "Done after Reset forgets the look");
});

add_task(async function test_click_outside_keeps() {
  const panel = await openEditor(other);
  segment(panel, "lines", "2").click();
  // A click outside closes without Done or Cancel; like Zen's theme
  // picker, what you see is kept.
  const hidden = BrowserTestUtils.waitForPopupEvent(panel, "hidden");
  panel.hidePopup();
  await hidden;
  Assert.deepEqual(stored(other), { lines: 2 }, "Kept");
  WhimsySpaceLook.reset(window, other.uuid);
  await switchTo(home);
});

add_task(async function test_command() {
  const command = document.getElementById("cmd_whimsyEditSpaceLook");
  ok(command, "Edit Space Look is a command");
  const shown = BrowserTestUtils.waitForEvent(document, "popupshown", false, e => e.target.id == "whimsy-space-look-panel");
  command.doCommand();
  const { target: panel } = await shown;
  is(panel.dataset.uuid, home.uuid, "for the space that's showing");
  await closeWith(panel, ".whimsy-look-cancel");

  await SpecialPowers.pushPrefEnv({ set: [[FEATURE, false]] });
  is(WhimsySpaceLook.openEditor(window, home.uuid), null, "Nothing opens with the switch off");
  await SpecialPowers.popPrefEnv();
});

add_task(async function test_context_menu() {
  const menu = document.getElementById("zenWorkspaceMoreActions");
  const shown = BrowserTestUtils.waitForPopupEvent(menu, "shown");
  menu.openPopup(gZenWorkspaces.activeWorkspaceElement, "after_start");
  await shown;
  const item = document.getElementById("whimsy-space-look-menuitem");
  ok(item && !item.hidden, "Edit Look… sits in the space menu");
  const theme = document.getElementById("context_zenChangeWorkspaceTheme");
  ok(
    theme.compareDocumentPosition(item) & Node.DOCUMENT_POSITION_FOLLOWING,
    "after Zen's Theme…"
  );
  let hidden = BrowserTestUtils.waitForPopupEvent(menu, "hidden");
  menu.hidePopup();
  await hidden;

  await SpecialPowers.pushPrefEnv({ set: [[FEATURE, false]] });
  const shownAgain = BrowserTestUtils.waitForPopupEvent(menu, "shown");
  menu.openPopup(gZenWorkspaces.activeWorkspaceElement, "after_start");
  await shownAgain;
  ok(item.hidden, "Hidden with the switch off");
  hidden = BrowserTestUtils.waitForPopupEvent(menu, "hidden");
  menu.hidePopup();
  await hidden;
  await SpecialPowers.popPrefEnv();
});
