/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// wave8/isolation: a tab never lives in a space whose profile (container)
// differs from its own userContextId, whatever path moves it, and a moved
// page never carries its old profile's cookies across. dev.580 report:
// "When I move a tab to another container, the accounts remain signed in."

const { WhimsyIsolation } = ChromeUtils.importESModule(
  "resource:///modules/whimsy/WhimsyIsolation.sys.mjs"
);
const { WhimsyProfiles } = ChromeUtils.importESModule(
  "resource:///modules/whimsy/WhimsyProfiles.sys.mjs"
);
const { WhimsyProfileMoves } = ChromeUtils.importESModule(
  "resource:///modules/whimsy/WhimsyProfileMoves.sys.mjs"
);
const { WhimsySpaces } = ChromeUtils.importESModule(
  "resource:///modules/whimsy/WhimsySpaces.sys.mjs"
);
const { WhimsyPrivate } = ChromeUtils.importESModule(
  "resource:///modules/whimsy/WhimsyPrivate.sys.mjs"
);
const { WhimsySnooze } = ChromeUtils.importESModule(
  "resource:///modules/whimsy/WhimsySnooze.sys.mjs"
);
const { PlacesUtils } = ChromeUtils.importESModule("resource://gre/modules/PlacesUtils.sys.mjs");
const { ContextualIdentityService } = ChromeUtils.importESModule(
  "moz-src:///toolkit/components/contextualidentity/ContextualIdentityService.sys.mjs"
);

const PAGE = "https://example.com/";
const ATTR = "zen-workspace-id";
let home, work, workSpace, answers, asked;
const realConfirm = WhimsyProfileMoves.confirm;

add_setup(async function () {
  await SpecialPowers.pushPrefEnv({ set: [["whimsy.feature.space-profiles", true]] });
  home = gZenWorkspaces.getActiveWorkspace();
  work = WhimsyProfiles.create("Whimsy Isolation Work");
  workSpace = await gZenWorkspaces.createAndSaveWorkspace("Isolation Work", undefined, true, work);
  WhimsyIsolation.initWindow(window);
  asked = [];
  answers = [];
  WhimsyProfileMoves.confirm = async (win, request) => {
    asked.push(request);
    return answers.shift() ?? false;
  };
  registerCleanupFunction(async () => {
    WhimsyProfileMoves.confirm = realConfirm;
    if (gZenWorkspaces.activeWorkspace != home.uuid) {
      await gZenWorkspaces.changeWorkspace(home);
    }
    for (const tab of tabsOf(workSpace)) {
      BrowserTestUtils.removeTab(tab);
    }
    await gZenWorkspaces.removeWorkspace(workSpace.uuid);
    ContextualIdentityService.remove(work);
    Services.cookies.removeAll();
  });
});

function tabsOf(space) {
  return gZenWorkspaces.allStoredTabs.filter(tab => tab.getAttribute(ATTR) == space.uuid &&
    !tab.hasAttribute("zen-essential") && !tab.closing);
}

// The invariant, checked over every tab of the window.
function assertNoTabCrosses(when) {
  const crossing = gZenWorkspaces.allStoredTabs.filter(tab => WhimsyIsolation.violates(window, tab));
  is(crossing.length, 0, `${when}: no tab sits in a space of another profile`);
}

async function openHomeTab(url = PAGE) {
  if (gZenWorkspaces.activeWorkspace != home.uuid) {
    await gZenWorkspaces.changeWorkspace(home);
  }
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, url);
  is(tab.getAttribute(ATTR), home.uuid, "Starts in the home space");
  is(tab.userContextId, 0, "…in Default");
  return tab;
}

async function reopenedInWork(old) {
  const moved = await TestUtils.waitForCondition(() =>
    tabsOf(workSpace).find(t => t != old && t.userContextId == work), "Reopened in the Work profile");
  ok(old.closing || !old.isConnected, "The Default copy is gone");
  is(moved.userContextId, work, "Its container is the Work space's");
  return moved;
}

async function cleanup() {
  for (const tab of tabsOf(workSpace)) {
    BrowserTestUtils.removeTab(tab);
  }
  if (gZenWorkspaces.activeWorkspace != home.uuid) {
    await gZenWorkspaces.changeWorkspace(home);
  }
  assertNoTabCrosses("After the case");
}

// Move to Space / Move to New Space / Claude / Mini / split row / undo /
// archive: everything through Zen's moveTabsToWorkspace.
add_task(async function move_api_never_lets_the_tab_cross() {
  const tab = await openHomeTab();
  answers = [false];
  asked = [];
  gZenWorkspaces.moveTabToWorkspace(tab, workSpace.uuid);
  is(tab.getAttribute(ATTR), home.uuid, "Held back synchronously: never in Work, not even while asking");
  assertNoTabCrosses("While Arc's warning is up");
  await TestUtils.waitForCondition(() => asked.length == 1, "Arc's warning");
  await TestUtils.waitForTick();
  is(tab.getAttribute(ATTR), home.uuid, "No: it stays home");
  is(tab.userContextId, 0, "…in Default");

  answers = [true];
  gZenWorkspaces.moveTabToWorkspace(tab, workSpace.uuid);
  is(tab.getAttribute(ATTR), home.uuid, "Held back again");
  await reopenedInWork(tab);
  await cleanup();
});

// The Move to menu's own command (Zen's changeTabWorkspace) and the space
// icon drop (WhimsySpaces.moveToSpace) end in the same API.
add_task(async function space_icon_drop_reopens_in_the_destination() {
  const tab = await openHomeTab();
  answers = [true];
  asked = [];
  await WhimsySpaces.moveToSpace(window, tab, workSpace.uuid);
  await reopenedInWork(tab);
  is(asked.length, 1, "Asked once");
  await cleanup();
});

// Sidebar drag across spaces (ZenDragAndDrop #handle_dropSwitchSpace), Zen's
// share and anything else that only writes the attribute.
add_task(async function a_direct_attribute_move_is_put_back_and_asked() {
  const tab = await openHomeTab();
  answers = [false];
  asked = [];
  workSpaceElement().tabsContainer.appendChild(tab);
  tab.setAttribute(ATTR, workSpace.uuid);
  await TestUtils.waitForCondition(() => tab.getAttribute(ATTR) == home.uuid, "Put back at once");
  ok(gZenWorkspaces.workspaceElement(home.uuid).tabsContainer.contains(tab), "…in the home space's strip");
  await TestUtils.waitForCondition(() => asked.length == 1, "Then Arc's warning");
  is(tab.userContextId, 0, "No: still Default, still home");

  answers = [true];
  workSpaceElement().tabsContainer.appendChild(tab);
  tab.setAttribute(ATTR, workSpace.uuid);
  await reopenedInWork(tab);
  await cleanup();
});

function workSpaceElement() {
  return gZenWorkspaces.workspaceElement(workSpace.uuid);
}

// Folders moved to a space (Zen's changeFolderToSpace, a folder dropped on a
// space icon) carry their tabs with them.
add_task(async function a_folder_moved_across_profiles_reopens_its_tabs() {
  const tab = await openHomeTab();
  gBrowser.pinTab(tab);
  const folder = gZenFolders.createFolder([tab], { label: "Isolation", renameFolder: false, workspaceId: home.uuid });
  ok(folder, "A folder");
  answers = [true];
  asked = [];
  gZenFolders.changeFolderToSpace(folder, workSpace.uuid);
  await TestUtils.waitForCondition(() => asked.length == 1, "Arc's warning");
  const moved = await reopenedInWork(tab);
  is(moved.group, folder, "The reopened tab is in its folder");
  is(folder.getAttribute(ATTR), workSpace.uuid, "…and the folder is in Work");
  await folder.delete();
  await cleanup();
});

// A cookie of Default is never readable from the tab once it's in Work.
add_task(async function a_moved_tab_does_not_keep_its_old_cookies() {
  const tab = await openHomeTab();
  await SpecialPowers.spawn(tab.linkedBrowser, [], () => {
    content.document.cookie = "whimsy_isolation=signed-in; path=/";
  });
  ok(Services.cookies.getCookiesFromHost("example.com", { userContextId: 0 })
    .some(c => c.name == "whimsy_isolation"), "Default has the sign-in cookie");

  answers = [true];
  gZenWorkspaces.moveTabToWorkspace(tab, workSpace.uuid);
  const moved = await reopenedInWork(tab);
  if (!moved.linkedPanel) {
    await gZenWorkspaces.changeWorkspace(workSpace);
    gBrowser.selectedTab = moved;
  }
  await TestUtils.waitForCondition(() => moved.linkedBrowser.currentURI?.spec == PAGE, "Loaded in Work");
  await BrowserTestUtils.browserLoaded(moved.linkedBrowser, false, PAGE).catch(() => {});
  const seen = await SpecialPowers.spawn(moved.linkedBrowser, [], () => content.document.cookie);
  ok(!seen.includes("whimsy_isolation"), "The Work tab can't read Default's cookie");
  is(moved.linkedBrowser.contentPrincipal.originAttributes.userContextId, work, "Its page runs as Work");
  ok(!Services.cookies.getCookiesFromHost("example.com", { userContextId: work })
    .some(c => c.name == "whimsy_isolation"), "Work's jar never got it");
  // And the other way: a cookie Work sets stays in Work.
  await SpecialPowers.spawn(moved.linkedBrowser, [], () => {
    content.document.cookie = "whimsy_work=only-work; path=/";
  });
  ok(!Services.cookies.getCookiesFromHost("example.com", { userContextId: 0 })
    .some(c => c.name == "whimsy_work"), "Default never sees Work's cookie");
  await cleanup();
});

// A new tab in a container that isn't its space's (an explicit container
// tab, a route, a tab adopted from another window) goes to a space of its
// own profile.
add_task(async function a_new_tab_lands_in_its_own_profile_space() {
  if (gZenWorkspaces.activeWorkspace != home.uuid) {
    await gZenWorkspaces.changeWorkspace(home);
  }
  const tab = gBrowser.addTrustedTab(PAGE + "?fresh", { userContextId: work, inBackground: true });
  await TestUtils.waitForCondition(() => tab.getAttribute(ATTR) == workSpace.uuid, "Sorted into Work");
  is(tab.userContextId, work, "Same tab, same container: nothing crossed");
  assertNoTabCrosses("After a new container tab");
  await cleanup();
});

// A space whose profile changed (Set Profile from another device, Zen's own
// Set Container) or a session saved crossed by an older build: the tabs
// reopen in place.
add_task(async function the_sweep_reopens_crossed_tabs_in_place() {
  const tab = await openHomeTab();
  gBrowser.selectedTab = gBrowser.visibleTabs.find(t => t != tab) ?? gBrowser.selectedTab;
  WhimsyIsolation.quietly(window, () => {
    workSpaceElement().tabsContainer.appendChild(tab);
    tab.setAttribute(ATTR, workSpace.uuid);
  });
  ok(WhimsyIsolation.violates(window, tab), "Crossed, as dev.580 left it");
  WhimsyIsolation.sweep(window);
  await reopenedInWork(tab);
  await cleanup();
});

// Set Profile with the Profiles switch off still reopens (Zen's own Set
// Container left every tab in the old cookie jar).
add_task(async function set_profile_reopens_with_the_switch_off() {
  await SpecialPowers.pushPrefEnv({ set: [["whimsy.feature.space-profiles", false]] });
  const other = await gZenWorkspaces.createAndSaveWorkspace("Isolation Other", undefined, true, 0);
  const tab = gBrowser.addTrustedTab(PAGE + "?other", { inBackground: true, userContextId: 0 });
  gZenWorkspaces.moveTabToWorkspace(tab, other.uuid);
  is(tab.getAttribute(ATTR), other.uuid, "In the other space");
  answers = [true];
  await WhimsyProfileMoves.moveSpace(window, other, work);
  const moved = await TestUtils.waitForCondition(() =>
    tabsOf(other).find(t => t.userContextId == work), "Reopened in the space's new profile");
  ok(moved, "Reopened");
  assertNoTabCrosses("After Set Profile");
  await gZenWorkspaces.removeWorkspace(other.uuid);
  await SpecialPowers.popPrefEnv();
});

// Private → normal: a private tab's pages never reach normal history, not
// when it moves to another profile, and it can't be snoozed (a snooze is
// saved to disk and comes back as a normal tab).
add_task(async function private_pages_never_reach_normal_history() {
  if (gZenWorkspaces.activeWorkspace != home.uuid) {
    await gZenWorkspaces.changeWorkspace(home);
  }
  const url = `${PAGE}?whimsy-private-${Date.now()}`;
  const tab = WhimsyPrivate.openPrivateTab(window, { url, force: true });
  ok(tab && WhimsyPrivate.isPrivateTab(tab), "A private tab");
  await BrowserTestUtils.browserLoaded(tab.linkedBrowser, false, url);
  ok(!(await PlacesUtils.history.hasVisits(url)), "Its page isn't in history");

  await WhimsySnooze.snooze(window, tab, Date.now() + 3600e3);
  ok(tab.isConnected && !tab.closing, "Snooze refuses a private tab");
  ok(!(await WhimsySnooze.list()).some(record => record.url == url), "…and saves nothing");

  answers = [true];
  gZenWorkspaces.moveTabToWorkspace(tab, workSpace.uuid);
  const moved = await reopenedInWork(tab);
  ok(WhimsyPrivate.isPrivateTab(moved), "Still private in Work");
  if (!moved.linkedPanel) {
    await gZenWorkspaces.changeWorkspace(workSpace);
    gBrowser.selectedTab = moved;
  }
  await TestUtils.waitForCondition(() => moved.linkedBrowser.browsingContext?.usePrivateBrowsing,
    "Browses privately");
  await TestUtils.waitForCondition(() => moved.linkedBrowser.currentURI?.spec == url, "Same page");
  await TestUtils.waitForTick();
  ok(!(await PlacesUtils.history.hasVisits(url)), "Still not in history after the move");
  await cleanup();
});

// Normal → private: a normal tab moved into Scratch goes back (it would
// keep writing history and normal cookies there).
add_task(async function a_normal_tab_never_moves_into_scratch() {
  const tab = await openHomeTab(PAGE + "?scratch");
  const scratch = await WhimsyPrivate.openScratch(window);
  ok(scratch, "Scratch is open");
  await gZenWorkspaces.changeWorkspace(home);
  gZenWorkspaces.workspaceElement(scratch.uuid).tabsContainer.appendChild(tab);
  tab.setAttribute(ATTR, scratch.uuid);
  await TestUtils.waitForCondition(() => tab.getAttribute(ATTR) == home.uuid, "Back home");
  ok(!WhimsyPrivate.isPrivateTab(tab), "Still the same normal tab");
  await WhimsyPrivate.closeScratch(window);
  BrowserTestUtils.removeTab(tab);
  await cleanup();
});

// Per-site user agent: a choice made in a private tab is never saved (the
// pref and permission would record the site) and never reaches normal tabs.
add_task(async function a_private_user_agent_choice_stays_private() {
  const { WhimsyUserAgent, PRESETS } = ChromeUtils.importESModule(
    "resource:///modules/whimsy/WhimsyUserAgent.sys.mjs"
  );
  const host = "whimsy-isolation-ua.example";
  WhimsyUserAgent.set(host, "safari-iphone", null, { isPrivate: true });
  is(WhimsyUserAgent.uaFor(host, true), PRESETS["safari-iphone"], "Private tabs get it");
  is(WhimsyUserAgent.uaFor(host), null, "Normal tabs don't");
  ok(!Services.prefs.getStringPref("whimsy.useragent.sites", "{}").includes(host), "Not saved to prefs");
  const principal = Services.scriptSecurityManager.createContentPrincipal(
    Services.io.newURI(`https://${host}/`), {});
  is(Services.perms.testPermissionFromPrincipal(principal, "whimsy-useragent"),
    Services.perms.UNKNOWN_ACTION, "No permission saved");
  Services.obs.notifyObservers(null, "last-pb-context-exited");
  is(WhimsyUserAgent.uaFor(host, true), null, "Forgotten when private browsing ends");
});

// Upload from the clipboard offers recent downloads: only the asking page's
// own side (private/normal) and profile.
add_task(async function upload_offers_only_this_profiles_downloads() {
  const { Downloads } = ChromeUtils.importESModule("resource://gre/modules/Downloads.sys.mjs");
  const { WhimsyUploadParent } = ChromeUtils.importESModule(
    "resource:///modules/whimsy/WhimsyUploadParent.sys.mjs"
  );
  const made = [];
  async function download(name, source, kind) {
    const list = await Downloads.getList(kind);
    const target = PathUtils.join(PathUtils.tempDir, name);
    const d = await Downloads.createDownload({ source: { url: "data:text/plain,iso", ...source }, target });
    await list.add(d);
    await d.start();
    made.push([list, d, target]);
  }
  await download("iso-default.txt", {}, Downloads.PUBLIC);
  await download("iso-work.txt", { userContextId: work }, Downloads.PUBLIC);
  await download("iso-private.txt", { isPrivate: true }, Downloads.PRIVATE);
  try {
    const names = async opts => (await WhimsyUploadParent.recentDownloads(opts)).map(d => d.name);
    const inDefault = await names({});
    ok(inDefault.includes("iso-default.txt"), "Default sees its own download");
    ok(!inDefault.includes("iso-work.txt"), "…not Work's");
    ok(!inDefault.includes("iso-private.txt"), "…nor a private one");
    const inWork = await names({ userContextId: work });
    ok(inWork.includes("iso-work.txt") && !inWork.includes("iso-default.txt"), "Work sees only Work's");
    const inPrivate = await names({ isPrivate: true });
    ok(inPrivate.includes("iso-private.txt") && !inPrivate.includes("iso-default.txt"),
      "A private tab sees only private downloads");
  } finally {
    for (const [list, d, target] of made) {
      await list.remove(d);
      await IOUtils.remove(target, { ignoreAbsent: true });
    }
  }
});

// Notes are saved to disk and shared by every profile: "Add to Note" isn't
// offered on a private page.
add_task(async function add_to_note_is_not_offered_on_a_private_page() {
  const { WhimsyVerbs } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyVerbs.sys.mjs");
  const subject = { kind: "page", url: PAGE, title: "Page", text: "", markdown: "" };
  const normal = await openHomeTab(PAGE + "?note");
  ok(WhimsyVerbs.verbsFor(window, subject).some(v => v.id == "note"), "Offered on a normal page");
  const priv = WhimsyPrivate.openPrivateTab(window, { url: PAGE + "?private-note", force: true });
  gBrowser.selectedTab = priv;
  ok(!WhimsyVerbs.verbsFor(window, subject).some(v => v.id == "note"), "Not on a private page");
  BrowserTestUtils.removeTab(priv);
  BrowserTestUtils.removeTab(normal);
  await cleanup();
});

// wave8 lane: paths wave 8 added or changed. Each one must go through the
// guard: the tab ends up in Work's container, can't read Default's cookie,
// and nothing is left crossing.
async function setDefaultCookie(tab, name) {
  await SpecialPowers.spawn(tab.linkedBrowser, [name], n => {
    content.document.cookie = `${n}=signed-in; path=/`;
  });
  ok(Services.cookies.getCookiesFromHost("example.com", { userContextId: 0 }).some(c => c.name == name),
    `Default has ${name}`);
}

async function assertMovedClean(old, name) {
  const moved = await reopenedInWork(old);
  await BrowserTestUtils.browserLoaded(moved.linkedBrowser, { wantLoad: url => url.startsWith(PAGE) }).catch(() => {});
  await TestUtils.waitForCondition(() => moved.linkedBrowser.currentURI?.spec.startsWith(PAGE), "The page loads in Work");
  const seen = await SpecialPowers.spawn(moved.linkedBrowser, [], () => content.document.cookie);
  ok(!seen.includes(name), `The Work tab can't read Default's ${name}`);
  assertNoTabCrosses("After the move");
  return moved;
}

// wave8/cmds: the command bar's "Move to <space>" rows.
add_task(async function command_bar_move_to_space_goes_through_the_guard() {
  const tab = await openHomeTab(PAGE + "?cmdbar");
  await setDefaultCookie(tab, "whimsy_cmdbar");
  WhimsySpaces.syncSpaceActions(window);
  const { globalActions } = ChromeUtils.importESModule("resource:///modules/ZenUBGlobalActions.sys.mjs");
  const row = globalActions.find(a => a.commandId == `whimsy:move-to-space-${workSpace.uuid}`);
  ok(row?.isAvailable(window), "Move to Isolation Work is offered");
  answers = [true];
  asked = [];
  row.command(window);
  is(tab.getAttribute(ATTR), home.uuid, "Held back while asking");
  await assertMovedClean(tab, "whimsy_cmdbar");
  is(asked.length, 1, "Arc's warning was shown once");
  await cleanup();
});

// wave8/cmds: Move Tab to Next / Previous Space.
add_task(async function next_and_previous_space_moves_go_through_the_guard() {
  const spaces = gZenWorkspaces.getWorkspaces();
  const i = spaces.findIndex(s => s.uuid == home.uuid);
  const next = spaces[(i + 1) % spaces.length]?.uuid == workSpace.uuid;
  const prev = spaces[(i - 1 + spaces.length) % spaces.length]?.uuid == workSpace.uuid;
  ok(next || prev, "Work is next to the home space");
  const tab = await openHomeTab(PAGE + "?relative");
  await setDefaultCookie(tab, "whimsy_relative");
  answers = [true];
  asked = [];
  document.getElementById(next ? "cmd_whimsyMoveTabToNextSpace" : "cmd_whimsyMoveTabToPrevSpace").doCommand();
  await assertMovedClean(tab, "whimsy_relative");
  await cleanup();
});

// wave8/snooze: a snoozed tab whose closed entry is gone comes back fresh in
// the container of the space it returns to.
add_task(async function snooze_wake_opens_in_the_space_container() {
  if (gZenWorkspaces.activeWorkspace != home.uuid) {
    await gZenWorkspaces.changeWorkspace(home);
  }
  const before = new Set(gZenWorkspaces.allStoredTabs);
  WhimsySnooze.wake(window, {
    url: PAGE + "?snoozed", title: "Snoozed", zenWorkspace: workSpace.uuid,
    userContextId: 0, closedId: null, wakeAt: Date.now(),
  });
  const woke = await TestUtils.waitForCondition(
    () => gZenWorkspaces.allStoredTabs.find(t => !before.has(t) && !t.closing),
    "The snoozed tab came back");
  await TestUtils.waitForCondition(() => woke.getAttribute(ATTR) == workSpace.uuid, "In Work");
  is(woke.userContextId, work, "In Work's container, not Default's");
  assertNoTabCrosses("After waking");
  await cleanup();
});

// Archive: a tab archived from Work comes back in Work's container, even
// restored while another space shows.
add_task(async function archive_restore_keeps_the_container() {
  const { WhimsyArchive } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyArchive.sys.mjs");
  await gZenWorkspaces.changeWorkspace(workSpace);
  const tab = BrowserTestUtils.addTab(gBrowser, PAGE + "?archived", { userContextId: work });
  await BrowserTestUtils.browserLoaded(tab.linkedBrowser);
  gZenWorkspaces.moveTabToWorkspace(tab, workSpace.uuid);
  await TestUtils.waitForCondition(() => tab.getAttribute(ATTR) == workSpace.uuid, "The tab is in Work");
  is(tab.userContextId, work, "…in Work's container");
  BrowserTestUtils.removeTab(tab);
  const entry = await TestUtils.waitForCondition(
    () => WhimsyArchive.listEntries(window).find(e => e.url == PAGE + "?archived"), "Archived");
  await gZenWorkspaces.changeWorkspace(home);
  const back = WhimsyArchive.restore(window, entry.closedId);
  ok(back, "Restored");
  await TestUtils.waitForCondition(() => back.getAttribute(ATTR) == workSpace.uuid, "Back in Work");
  is(back.userContextId, work, "In Work's container");
  assertNoTabCrosses("After restoring");
  await cleanup();
});
