/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// wave5/profiles, phase 1: the profile model (containers as Arc profiles),
// "Create a New Profile…" in Zen's Set Profile menu, and Settings →
// Profiles (create, rename, delete rules, Delete Unused Profiles).

const { WhimsyProfiles } = ChromeUtils.importESModule(
  "resource:///modules/whimsy/WhimsyProfiles.sys.mjs"
);
const { ContextualIdentityService } = ChromeUtils.importESModule(
  "moz-src:///toolkit/components/contextualidentity/ContextualIdentityService.sys.mjs"
);

const FEATURE = "whimsy.feature.space-profiles";
const created = new Set();

function makeProfile(name) {
  const id = WhimsyProfiles.create(name);
  created.add(id);
  return id;
}

registerCleanupFunction(() => {
  Services.prefs.clearUserPref(FEATURE);
  for (const id of created) {
    if (ContextualIdentityService.getPublicIdentityFromId(id)) {
      ContextualIdentityService.remove(id);
    }
  }
});

add_task(async function model_and_names() {
  const list = WhimsyProfiles.list();
  is(list[0].id, 0, "Default comes first");
  is(list[0].name, "Default", "Container 0 is called Default");
  is(list[0].key, "default", "Default's synced key");
  is(WhimsyProfiles.validateName(""), "whimsy-profile-name-empty", "Empty names are refused");
  is(WhimsyProfiles.validateName("  default "), "whimsy-profile-name-taken",
    "Default's name is taken, ignoring case and spaces");

  const id = makeProfile("Whimsy Work");
  ok(WhimsyProfiles.list().some(p => p.id == id && p.name == "Whimsy Work"), "New profile is listed");
  is(WhimsyProfiles.validateName("whimsy work"), "whimsy-profile-name-taken", "Duplicate refused");
  is(WhimsyProfiles.validateName("whimsy work", id), null, "A profile may keep its own name");
  Assert.throws(() => WhimsyProfiles.create("WHIMSY WORK"), /whimsy-profile-name-taken/,
    "create() refuses a duplicate");

  const key = WhimsyProfiles.keyFor(id);
  isnot(key, "default", "A container has its own key");
  is(WhimsyProfiles.idForKey(key), id, "The key maps back to the container");
  is(WhimsyProfiles.idForKey("default"), 0, "default → 0");

  WhimsyProfiles.rename(id, "Whimsy Office");
  is(WhimsyProfiles.nameOf(id), "Whimsy Office", "Renamed");
  Assert.throws(() => WhimsyProfiles.rename(0, "Mine"), /whimsy-profile-default-fixed/,
    "Default can't be renamed");
  ok(!WhimsyProfiles.canDelete(0, window), "Default can't be deleted");
});

add_task(async function delete_rules() {
  const used = makeProfile("Whimsy Used");
  const unused = makeProfile("Whimsy Unused");
  const space = await gZenWorkspaces.createAndSaveWorkspace("Profile Space", undefined, true, used);
  try {
    ok(!WhimsyProfiles.canDelete(used, window), "A profile with a space can't be deleted");
    ok(WhimsyProfiles.canDelete(unused, window), "An unused profile can");
    ok(WhimsyProfiles.unusedIds(window).includes(unused), "Listed as unused");
    ok(!WhimsyProfiles.unusedIds(window).includes(used), "The used one isn't");
    ok(!(await WhimsyProfiles.delete(used, window)), "delete() refuses the used one");
    ok(ContextualIdentityService.getPublicIdentityFromId(used), "…and it still exists");

    let hookKey = null;
    WhimsyProfiles.onDelete((id, key) => {
      if (id == unused) {
        hookKey = key;
      }
    });
    const key = WhimsyProfiles.keyFor(unused);
    ok(await WhimsyProfiles.delete(unused, window), "Unused profile deleted");
    ok(!ContextualIdentityService.getPublicIdentityFromId(unused), "Its container is gone");
    is(hookKey, key, "Per-profile data hooks run with the profile's key");
  } finally {
    await gZenWorkspaces.removeWorkspace(space.uuid);
  }
});

add_task(async function set_profile_menu_creates_profile() {
  const space = gZenWorkspaces.getActiveWorkspace();
  const original = space.containerTabId ?? 0;
  const popup = document.querySelector("#context_zenWorkspacesOpenInContainerTab > menupopup");
  ok(popup, "Zen's Set Profile list exists");

  const prompt = WhimsyProfiles.promptName;
  WhimsyProfiles.promptName = async () => makeProfile("Whimsy From Menu");
  // The move itself (Arc's warning, tabs reopening) is
  // browser_whimsy_profile_moves.js; say yes here.
  const { WhimsyProfileMoves } = ChromeUtils.importESModule(
    "resource:///modules/whimsy/WhimsyProfileMoves.sys.mjs"
  );
  const confirm = WhimsyProfileMoves.confirm;
  WhimsyProfileMoves.confirm = async () => true;
  try {
    window._whimsyProfileMenuSpace = space.uuid;
    popup.dispatchEvent(new Event("popupshowing", { bubbles: true }));
    const item = popup.querySelector("[data-whimsy-create-profile]");
    ok(item, "Set Profile ends with Create a New Profile…");
    is(popup.lastElementChild, item, "…as the last item");
    await document.l10n.translateElements([item]);
    is(item.getAttribute("label"), "Create a New Profile…", "Arc's wording");
    item.doCommand();
    await TestUtils.waitForCondition(() =>
      WhimsyProfiles.nameOf(gZenWorkspaces.getActiveWorkspace().containerTabId) == "Whimsy From Menu",
    "The space moved to the new profile");
  } finally {
    WhimsyProfiles.promptName = prompt;
    WhimsyProfileMoves.confirm = confirm;
    window._whimsyProfileMenuSpace = null;
    space.containerTabId = original;
    await gZenWorkspaces.saveWorkspace(space);
  }

  Services.prefs.setBoolPref(FEATURE, false);
  popup.dispatchEvent(new Event("popupshowing", { bubbles: true }));
  ok(!popup.querySelector("[data-whimsy-create-profile]"), "Feature off: no Create item");
  Services.prefs.clearUserPref(FEATURE);
});

add_task(async function name_sheet_validates_inline() {
  const existing = makeProfile("Whimsy Sheet");
  const pending = WhimsyProfiles.promptName(window, {});
  const panel = await TestUtils.waitForCondition(() => {
    const p = document.getElementById("whimsy-profile-name-panel");
    return p?.state == "open" && p;
  }, "The Profile Name sheet opens");
  const input = panel.querySelector(".whimsy-profile-name-input");
  await TestUtils.waitForCondition(() => document.activeElement == input, "The field has focus");
  input.value = "whimsy sheet";
  EventUtils.synthesizeKey("KEY_Enter", {}, window);
  const error = panel.querySelector(".whimsy-profile-name-error");
  await TestUtils.waitForCondition(() => !error.hidden && error.textContent, "Reason shown");
  is(error.textContent, "A Profile with that name already exists. Choose another name.", "Arc's message");
  ok(input.hasAttribute("aria-invalid"), "Field marked invalid");
  is(panel.state, "open", "The sheet stays open to fix it");
  input.value = "Whimsy Sheet 2";
  input.dispatchEvent(new Event("input"));
  ok(error.hidden, "Typing clears the error");
  EventUtils.synthesizeKey("KEY_Enter", {}, window);
  const id = await pending;
  created.add(id);
  is(WhimsyProfiles.nameOf(id), "Whimsy Sheet 2", "Created from the sheet");
  isnot(id, existing, "A new profile");

  const cancelled = WhimsyProfiles.promptName(window, {});
  await TestUtils.waitForCondition(() =>
    document.getElementById("whimsy-profile-name-panel")?.state == "open");
  EventUtils.synthesizeKey("KEY_Escape", {}, window);
  is(await cancelled, null, "Esc cancels");
});

add_task(async function settings_profiles_group() {
  const used = makeProfile("Whimsy Settings Used");
  const space = await gZenWorkspaces.createAndSaveWorkspace("Settings Space", undefined, true, used);
  try {
    await BrowserTestUtils.withNewTab("about:preferences#zenTabManagement", async browser => {
      const doc = browser.contentDocument;
      const group = await TestUtils.waitForCondition(() => doc.getElementById("whimsyProfilesGroup"));
      await TestUtils.waitForCondition(() => group.checkVisibility(), "Profiles group shows");
      const row = id => doc.querySelector(`.whimsy-profile-row[data-profile-id="${id}"]`);
      ok(row(0), "Default row");
      ok(!row(0).querySelector(".whimsy-profile-delete"), "Default has no delete");
      const usedDelete = row(used).querySelector(".whimsy-profile-delete");
      ok(usedDelete.disabled, "A used profile's delete is disabled");
      is(usedDelete.getAttribute("aria-describedby"), "whimsyProfilesDeleteRule",
        "…and points at the rule in text");

      doc.getElementById("whimsyProfilesCreate").doCommand();
      const form = doc.querySelector("#whimsyProfilesCreateSlot .whimsy-profile-name-form");
      const input = form.querySelector("input");
      is(doc.activeElement, input, "Create puts focus in the name field");
      input.value = "Whimsy Settings Used";
      form.requestSubmit();
      const error = form.querySelector(".whimsy-profile-name-error");
      await TestUtils.waitForCondition(() => !error.hidden && error.textContent);
      is(input.getAttribute("aria-invalid"), "true", "Duplicate flagged inline");
      input.value = "Whimsy Settings New";
      form.requestSubmit();
      await TestUtils.waitForCondition(() =>
        WhimsyProfiles.list().some(p => p.name == "Whimsy Settings New"), "Created");
      const fresh = WhimsyProfiles.list().find(p => p.name == "Whimsy Settings New");
      created.add(fresh.id);
      await TestUtils.waitForCondition(() => row(fresh.id), "Row appears");
      ok(!row(fresh.id).querySelector(".whimsy-profile-delete").disabled, "Unused can be deleted");
      ok(!doc.getElementById("whimsyProfilesDeleteUnused").disabled, "Delete Unused available");
    });
  } finally {
    await gZenWorkspaces.removeWorkspace(space.uuid);
  }
});

add_task(async function settings_feature_off() {
  Services.prefs.setBoolPref(FEATURE, false);
  await BrowserTestUtils.withNewTab("about:preferences#zenTabManagement", async browser => {
    const doc = browser.contentDocument;
    await TestUtils.waitForCondition(() => doc.getElementById("whimsySpacesGroup") ||
      doc.getElementById("zenWorkspacesGroup"));
    ok(!doc.getElementById("whimsyProfilesGroup"), "No Profiles group when off");
  });
  Services.prefs.clearUserPref(FEATURE);
});

// Essentials per profile are Zen's own container-specific essentials
// (zen.workspaces.separate-essentials, on by default): a space shows its
// profile's strip only.
add_task(async function essentials_follow_the_space_profile() {
  ok(Services.prefs.getBoolPref("zen.workspaces.separate-essentials"), "Zen's per-container essentials are on");
  const home = gZenWorkspaces.getActiveWorkspace();
  const work = makeProfile("Whimsy Essentials Work");
  const space = await gZenWorkspaces.createAndSaveWorkspace("Essentials Work", undefined, true, work);
  const tab = BrowserTestUtils.addTab(gBrowser, "about:blank", { skipAnimation: true, userContextId: work });
  try {
    gZenPinnedTabManager.addToEssentials(tab);
    is(tab.parentNode.getAttribute("container"), String(work), "The essential lives in Work's strip");
    await gZenWorkspaces.changeWorkspace(space);
    ok(!gZenWorkspaces.getEssentialsSection(work).hasAttribute("hidden"), "Work's strip shows in a Work space");
    await gZenWorkspaces.changeWorkspace(home);
    ok(gZenWorkspaces.getEssentialsSection(work).hasAttribute("hidden"), "…and not in a Default space");
  } finally {
    BrowserTestUtils.removeTab(tab);
    if (gZenWorkspaces.activeWorkspace != home.uuid) {
      await gZenWorkspaces.changeWorkspace(home);
    }
    await gZenWorkspaces.removeWorkspace(space.uuid);
  }
});
