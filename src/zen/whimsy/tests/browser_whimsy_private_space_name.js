/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// W10-10: "Scratch" is now "Private Space" everywhere a person reads it:
// the space's name, commands, menus, the cheat sheet, Settings and toasts.
// Pref names, ids and code names stay ("whimsy.feature.scratch",
// cmd_whimsyNewScratch, whimsyScratch), so nothing needs migrating; the old
// word only survives as a search keyword.

const { WhimsyPrivate } = ChromeUtils.importESModule(
  "resource:///modules/whimsy/WhimsyPrivate.sys.mjs"
);
const { WhimsyCommands } = ChromeUtils.importESModule(
  "resource:///modules/whimsy/WhimsyCommands.sys.mjs"
);

const OLD = /\bScratch\b/;

add_task(async function no_whimsy_string_says_scratch() {
  const response = await fetch("resource://app/localization/en-US/browser/whimsy.ftl");
  ok(response.ok, "whimsy.ftl is readable");
  const text = await response.text();
  let id = null;
  const offenders = [];
  for (const line of text.split("\n")) {
    if (/^#/.test(line) || !line.trim()) {
      continue;
    }
    const start = /^([a-z][a-z0-9-]*)\s*=/.exec(line);
    if (start) {
      id = start[1];
    }
    // Search keywords keep the old name on purpose, so it still finds it.
    if (id?.startsWith("whimsy-keywords-")) {
      continue;
    }
    if (OLD.test(line)) {
      offenders.push(`${id}: ${line.trim()}`);
    }
  }
  Assert.deepEqual(offenders, [], "No visible string says Scratch");
});

add_task(async function the_space_commands_and_menus_say_private_space() {
  const [name] = await document.l10n.formatValues([{ id: "whimsy-scratch-name" }]);
  is(name, "Private Space", "The space's name");
  for (const id of ["cmd_whimsyNewScratch", "cmd_whimsyKeepScratch", "cmd_whimsyCloseScratch"]) {
    const title = WhimsyCommands.title(WhimsyCommands.get(id));
    ok(title.includes("Private Space"), `${id} reads "${title}"`);
    ok(!OLD.test(title), `${id} doesn't say Scratch`);
  }
  const item = document.getElementById("menu_whimsyNewScratch");
  if (item) {
    await document.l10n.translateElements([item]);
    is(item.getAttribute("label"), "New Private Space", "File ▸ New Private Space");
  }
  const keywords = WhimsyCommands.keywords("whimsy-keywords-new-private-space");
  ok(keywords.includes("Scratch"), "Typing its old name still finds it");

  const startSpace = gZenWorkspaces.activeWorkspace;
  const space = await WhimsyPrivate.openScratch(window);
  ok(space, "The Private Space opened");
  is(space.name, "Private Space", "…named Private Space");
  ok(Services.prefs.getBoolPref("whimsy.feature.scratch"), "Its switch keeps its pref name");
  await WhimsyPrivate.closeScratch(window);
  if (gZenWorkspaces.activeWorkspace != startSpace) {
    await gZenWorkspaces.changeWorkspaceWithID(startSpace);
  }
});
