/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// wave5/profiles, phase 4: a search engine and a download folder per
// profile, applied while that profile's tab is in front and put back when
// it isn't; Default always uses the person's own settings.

const { WhimsyProfiles } = ChromeUtils.importESModule(
  "resource:///modules/whimsy/WhimsyProfiles.sys.mjs"
);
const { WhimsyProfileSettings } = ChromeUtils.importESModule(
  "resource:///modules/whimsy/WhimsyProfileSettings.sys.mjs"
);
const { SearchService } = ChromeUtils.importESModule(
  "moz-src:///toolkit/components/search/SearchService.sys.mjs"
);
const { ContextualIdentityService } = ChromeUtils.importESModule(
  "moz-src:///toolkit/components/contextualidentity/ContextualIdentityService.sys.mjs"
);

let work, workKey, ownEngine, otherEngine;

add_setup(async function () {
  await SearchService.init();
  ownEngine = SearchService.defaultEngine;
  otherEngine = (await SearchService.getVisibleEngines()).find(e => e.id != ownEngine.id);
  ok(otherEngine, "Two engines to choose between");
  work = WhimsyProfiles.create("Whimsy Settings Work");
  workKey = WhimsyProfiles.keyFor(work);
  WhimsyProfileSettings.initWindow(window);
  registerCleanupFunction(async () => {
    for (const pref of [WhimsyProfileSettings.ENGINES_PREF, WhimsyProfileSettings.DIRS_PREF,
      "whimsy.profiles.saved-search-engine", "whimsy.profiles.saved-download",
      "browser.download.dir", "browser.download.folderList"]) {
      Services.prefs.clearUserPref(pref);
    }
    await SearchService.setDefault(ownEngine, SearchService.CHANGE_REASON.UNKNOWN);
    ContextualIdentityService.remove(work);
  });
});

async function inFront(userContextId) {
  const tab = await BrowserTestUtils.openNewForegroundTab({ gBrowser, opening: "about:blank", userContextId });
  await WhimsyProfileSettings.applyFront();
  return tab;
}

add_task(async function search_engine_follows_the_front_profile() {
  await WhimsyProfileSettings.setEngine(workKey, otherEngine.id);
  const workTab = await inFront(work);
  is(SearchService.defaultEngine.id, otherEngine.id, "Work's engine while Work is in front");
  const homeTab = await inFront(0);
  is(SearchService.defaultEngine.id, ownEngine.id, "The person's own engine is back for Default");

  gBrowser.selectedTab = workTab;
  await WhimsyProfileSettings.applyFront();
  is(SearchService.defaultEngine.id, otherEngine.id, "Work's again");
  // Changing Firefox's own default while Work's applies makes it everyday.
  await SearchService.setDefault(ownEngine, SearchService.CHANGE_REASON.USER);
  is(Services.prefs.getStringPref("whimsy.profiles.saved-search-engine", ""), "",
    "Nothing left to put back");

  await WhimsyProfileSettings.setEngine(workKey, null);
  BrowserTestUtils.removeTab(workTab);
  BrowserTestUtils.removeTab(homeTab);
});

add_task(async function download_folder_follows_the_front_profile() {
  const dir = await IOUtils.createUniqueDirectory(PathUtils.tempDir, "whimsy-profile-downloads");
  ok(!Services.prefs.prefHasUserValue("browser.download.dir"), "No folder set by the person");
  await WhimsyProfileSettings.setDownloadDir(workKey, dir);
  const workTab = await inFront(work);
  is(Services.prefs.getStringPref("browser.download.dir", ""), dir, "Work's folder");
  is(Services.prefs.getIntPref("browser.download.folderList"), 2, "…used as a custom folder");
  const homeTab = await inFront(0);
  ok(!Services.prefs.prefHasUserValue("browser.download.dir"), "Default: the person's own (none) again");
  ok(!Services.prefs.prefHasUserValue("browser.download.folderList"), "…folder list too");
  BrowserTestUtils.removeTab(workTab);
  BrowserTestUtils.removeTab(homeTab);
  await IOUtils.remove(dir);
});

// wave7/security L6: the download folder never syncs, and a folder in
// ~/Library (LaunchAgents runs what lands there) is never applied.
add_task(async function download_folder_stays_local_and_safe() {
  ok(!Services.prefs.getDefaultBranch("").getBoolPref("services.sync.prefs.sync.whimsy.profiles.download-dirs", false),
    "Download folders don't sync");
  const agents = PathUtils.join(PathUtils.homeDir, "Library", "LaunchAgents");
  await IOUtils.makeDirectory(agents, { ignoreExisting: true });
  await WhimsyProfileSettings.setDownloadDir(workKey, agents);
  const workTab = await inFront(work);
  isnot(Services.prefs.getStringPref("browser.download.dir", ""), agents, "~/Library/LaunchAgents is never applied");
  ok(!Services.prefs.prefHasUserValue("browser.download.dir"), "…the person's own folder stays");
  await WhimsyProfileSettings.setDownloadDir(workKey, null);
  BrowserTestUtils.removeTab(workTab);
});

add_task(async function feature_off_and_delete() {
  await WhimsyProfileSettings.setEngine(workKey, otherEngine.id);
  const workTab = await inFront(work);
  is(SearchService.defaultEngine.id, otherEngine.id, "Applied");
  Services.prefs.setBoolPref(WhimsyProfiles.FEATURE_PREF, false);
  await WhimsyProfileSettings.applyFront();
  is(SearchService.defaultEngine.id, ownEngine.id, "Feature off: the person's own engine");
  Services.prefs.clearUserPref(WhimsyProfiles.FEATURE_PREF);
  BrowserTestUtils.removeTab(workTab);
  await WhimsyProfileSettings.applyFront();

  WhimsyProfileSettings.forget(workKey);
  is(WhimsyProfileSettings.engineFor(workKey), null, "A deleted profile's choices are forgotten");
});
