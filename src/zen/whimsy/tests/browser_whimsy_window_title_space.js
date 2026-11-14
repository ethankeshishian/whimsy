/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// W27: Show space name in window title (WhimsyWindowTitle; Settings → Tab
// Management, off by default). On, the window's titlepreface is
// "<space> — ", so the title reads "<space> — <page title>". It shows with
// any number of spaces, follows space switches and renames, goes with its
// switch, and a window behind the private lock shows no space name.

const { WhimsyWindowTitle } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyWindowTitle.sys.mjs");

const SHOW = "whimsy.spaces.window-title-name";
const FEATURE = "whimsy.feature.window-title-space";
const LOCK = "whimsy-private-window-locked";
const SEP = " — ";
const PAGE = "data:text/html,<title>Ledger</title>";

let homeSpace;

function preface() {
  return document.documentElement.getAttribute("titlepreface");
}

function active() {
  return gZenWorkspaces.getWorkspaces().find(w => w.uuid == gZenWorkspaces.activeWorkspace);
}

add_setup(async function () {
  await gZenWorkspaces.promiseInitialized;
  homeSpace = active();
  ok(window._whimsyWindowTitle, "The window title module is set up in this window");
});

add_task(async function test_off_by_default() {
  ok(!Services.prefs.getBoolPref(SHOW), "The setting is off by default");
  await BrowserTestUtils.withNewTab(PAGE, async () => {
    await TestUtils.waitForCondition(() => document.title.startsWith("Ledger"), "The page's title shows");
    ok(!preface(), "No titlepreface while it's off");
    is(WhimsyWindowTitle.spaceName(window), null, "No space name while it's off");
  });
});

add_task(async function test_settings_row() {
  await BrowserTestUtils.withNewTab("about:preferences#zenTabManagement", async browser => {
    const doc = browser.contentDocument;
    const box = await TestUtils.waitForCondition(() => doc.getElementById("whimsyWindowTitleSpace"), "The row is there");
    is(box.getAttribute("preference"), SHOW, "It sets the pref");
    await TestUtils.waitForCondition(() => box.label == "Show space name in window title", "Its label");
    ok(!box.checked, "Unchecked by default");
  });
});

add_task(async function test_on_names_the_space_first_and_follows_it() {
  const other = await gZenWorkspaces.createAndSaveWorkspace("Taxes 2026", undefined, true);
  registerCleanupFunction(async () => {
    if (gZenWorkspaces.getWorkspaces().some(w => w.uuid == other.uuid)) {
      await gZenWorkspaces.changeWorkspaceWithID(homeSpace.uuid);
      await gZenWorkspaces.removeWorkspace(other.uuid);
    }
  });
  await gZenWorkspaces.changeWorkspaceWithID(homeSpace.uuid);
  const home = active().name;
  ok(home, "The first space has a name");

  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE);
  await SpecialPowers.pushPrefEnv({ set: [[SHOW, true]] });
  await TestUtils.waitForCondition(() => preface() == `${home}${SEP}`, "On: the titlepreface is <space> — ");
  await TestUtils.waitForCondition(
    () => document.title.startsWith(`${home}${SEP}Ledger`),
    "The window title starts with the space's name"
  );

  await gZenWorkspaces.changeWorkspaceWithID(other.uuid);
  await TestUtils.waitForCondition(() => preface() == `Taxes 2026${SEP}`, "Switching spaces names the new one");
  // A page in this space, so the title has a content title after the preface.
  const otherTab = await BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE);
  await TestUtils.waitForCondition(
    () => document.title.startsWith(`Taxes 2026${SEP}Ledger`),
    "and the title shows it, before the page title"
  );

  const stored = gZenWorkspaces.getWorkspaces().find(w => w.uuid == other.uuid);
  gZenWorkspaces.saveWorkspace({ ...stored, name: "Taxes 2027" });
  await TestUtils.waitForCondition(() => preface() == `Taxes 2027${SEP}`, "Renaming the space retitles it");

  await TestUtils.waitForCondition(
    () => document.title.startsWith(`Taxes 2027${SEP}`),
    "and the title follows the rename"
  );
  BrowserTestUtils.removeTab(otherTab);

  await gZenWorkspaces.changeWorkspaceWithID(homeSpace.uuid);
  await TestUtils.waitForCondition(() => preface() == `${home}${SEP}`, "Back in the first space");

  await SpecialPowers.pushPrefEnv({ set: [[FEATURE, false]] });
  await TestUtils.waitForCondition(() => !preface(), "With the switch off there's no preface");
  await TestUtils.waitForCondition(() => document.title.startsWith("Ledger"), "and the title is Firefox's");
  await SpecialPowers.popPrefEnv();
  await TestUtils.waitForCondition(() => preface() == `${home}${SEP}`, "Switch back on: named again");

  await SpecialPowers.popPrefEnv();
  await TestUtils.waitForCondition(() => !preface(), "Turning the setting off removes the preface");
  BrowserTestUtils.removeTab(tab);
});

add_task(async function test_one_space_still_named() {
  // Whatever spaces earlier tests left, the module sees exactly one: the
  // list it reads (gZenWorkspaces.getWorkspaces) is narrowed to this space.
  const getWorkspaces = gZenWorkspaces.getWorkspaces;
  gZenWorkspaces.getWorkspaces = function () {
    return getWorkspaces.apply(this, arguments).filter(w => w.uuid == homeSpace.uuid);
  };
  await SpecialPowers.pushPrefEnv({ set: [[SHOW, true]] });
  try {
    is(gZenWorkspaces.getWorkspaces().length, 1, "The module sees exactly one space");
    WhimsyWindowTitle.update(window);
    is(preface(), `${active().name}${SEP}`, "One space: it's still named (the setting was turned on knowingly)");
  } finally {
    gZenWorkspaces.getWorkspaces = getWorkspaces;
    await SpecialPowers.popPrefEnv();
  }
  await TestUtils.waitForCondition(() => !preface(), "Off again");
});

add_task(async function test_locked_private_window_shows_no_space() {
  await SpecialPowers.pushPrefEnv({ set: [[SHOW, true]] });
  const root = document.documentElement;
  try {
    await TestUtils.waitForCondition(() => preface()?.endsWith(SEP), "Unlocked: the space is named");
    root.setAttribute(LOCK, "true");
    await TestUtils.waitForCondition(() => !preface(), "Locked: the space name comes off the title");
    is(WhimsyWindowTitle.preface(window), null, "and no preface is offered while locked");
    root.removeAttribute(LOCK);
    await TestUtils.waitForCondition(() => preface()?.endsWith(SEP), "Unlocked again: named again");
  } finally {
    root.removeAttribute(LOCK);
    await SpecialPowers.popPrefEnv();
  }
  await TestUtils.waitForCondition(() => !preface(), "Off at the end");
});
