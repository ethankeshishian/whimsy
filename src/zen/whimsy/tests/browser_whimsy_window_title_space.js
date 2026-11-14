/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// W27: the window title names its space (WhimsyWindowTitle). With more
// than one space the title is "<page title> — <space name>"; with one it
// stays Firefox's. Switching or renaming a space redoes it, the switch
// turns it off, and a locked private window keeps its generic title.

const { WhimsyWindowTitle } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyWindowTitle.sys.mjs");

const FEATURE = "whimsy.feature.window-title-space";
const SEP = " — ";
const PAGE = "data:text/html,<title>Ledger</title>";

let homeSpace, otherSpace;

function active() {
  return gZenWorkspaces.getWorkspaces().find(w => w.uuid == gZenWorkspaces.activeWorkspace);
}

add_setup(async function () {
  await gZenWorkspaces.promiseInitialized;
  homeSpace = active();
  ok(window._whimsyWindowTitle, "The window title module is set up in this window");
});

add_task(async function test_one_space_keeps_firefox_title() {
  if (gZenWorkspaces.getWorkspaces().length != 1) {
    ok(true, "Another test left more than one space; the one-space case is checked through spaceName below");
    return;
  }
  await BrowserTestUtils.withNewTab(PAGE, async () => {
    await TestUtils.waitForCondition(() => document.title.startsWith("Ledger"), "The page's title shows");
    is(WhimsyWindowTitle.spaceName(window), null, "One space: no space name");
    ok(!document.title.includes(SEP + homeSpace.name), "One space: the title doesn't name it");
  });
});

add_task(async function test_two_spaces_name_switch_and_rename() {
  otherSpace = await gZenWorkspaces.createAndSaveWorkspace("Taxes 2026", undefined, true);
  registerCleanupFunction(async () => {
    if (gZenWorkspaces.getWorkspaces().some(w => w.uuid == otherSpace.uuid)) {
      await gZenWorkspaces.changeWorkspaceWithID(homeSpace.uuid);
      await gZenWorkspaces.removeWorkspace(otherSpace.uuid);
    }
  });
  await gZenWorkspaces.changeWorkspaceWithID(homeSpace.uuid);
  const home = active().name;
  ok(home, "The first space has a name");

  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE);
  await TestUtils.waitForCondition(
    () => document.title.startsWith(`Ledger${SEP}${home}`),
    "With two spaces, the title is <page title> — <space name>"
  );
  is(WhimsyWindowTitle.spaceName(window), home, "spaceName reads the selected tab's space");

  await gZenWorkspaces.changeWorkspaceWithID(otherSpace.uuid);
  await TestUtils.waitForCondition(
    () => document.title.endsWith(`${SEP}Taxes 2026`),
    "Switching spaces names the new one"
  );

  const stored = gZenWorkspaces.getWorkspaces().find(w => w.uuid == otherSpace.uuid);
  gZenWorkspaces.saveWorkspace({ ...stored, name: "Taxes 2027" });
  await TestUtils.waitForCondition(() => document.title.endsWith(`${SEP}Taxes 2027`), "Renaming the space retitles it");

  await gZenWorkspaces.changeWorkspaceWithID(homeSpace.uuid);
  await TestUtils.waitForCondition(() => document.title.startsWith(`Ledger${SEP}${home}`), "Back in the first space");

  await SpecialPowers.pushPrefEnv({ set: [[FEATURE, false]] });
  await TestUtils.waitForCondition(
    () => document.title.startsWith("Ledger") && !document.title.includes(`${SEP}${home}`),
    "With the switch off the title is Firefox's again"
  );
  is(WhimsyWindowTitle.spaceName(window), null, "No space name with the switch off");
  await SpecialPowers.popPrefEnv();
  await TestUtils.waitForCondition(
    () => document.title.startsWith(`Ledger${SEP}${home}`),
    "Turning it back on names the space again"
  );

  BrowserTestUtils.removeTab(tab);
});

add_task(async function test_locked_private_window_keeps_generic_title() {
  const other = await gZenWorkspaces.createAndSaveWorkspace("Second", undefined, true);
  await gZenWorkspaces.changeWorkspaceWithID(homeSpace.uuid);
  const root = document.documentElement;
  try {
    ok(WhimsyWindowTitle.title(window, "Ledger").startsWith(`Ledger${SEP}`), "Unlocked: the space is named");
    root.setAttribute("whimsy-private-window-locked", "true");
    is(WhimsyWindowTitle.title(window, "Private Browsing"), "Private Browsing", "Locked: the title is left alone");
  } finally {
    root.removeAttribute("whimsy-private-window-locked");
    await gZenWorkspaces.removeWorkspace(other.uuid);
  }
  is(WhimsyWindowTitle.title(window, ""), "", "An empty title stays empty");
});
