/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// W26: the site panel, profile first. Two headings: "Profile Settings" with
// the profile's name (Automatic Dark Mode) and "Site Settings" with the
// host and Zen's More (Dark Mode, Tracking Protection, Zoom, Autoplay, each
// stored permission, Always Open in Reader View, Open in Full Screen, and
// Pretend to Be). Each profile keeps its own: permissions (Reader, Full
// Screen, Autoplay, any permission, tracking exceptions), dark mode, and
// zoom. The one-time migration copies Default's permissions into every
// existing profile and folds in the old ".ucN" types, without losing or
// overwriting anything, and is idempotent. A profile made after that starts
// fresh: none of Default's permissions (W28, the owner: "New is the
// default. Don't copy."). W28: every row in both headings has a hover
// tooltip saying what it does.

Services.scriptloader.loadSubScript(getRootDirectory(gTestPath) + "head_whimsy_dark_pages.js", this);

const { PERM_TYPES, TOOLTIP_PERMISSIONS } = ChromeUtils.importESModule(
  "resource:///modules/whimsy/WhimsySiteSettings.sys.mjs"
);
const { WhimsyProfiles } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyProfiles.sys.mjs");
const { WhimsyProfileZoom, ZOOM_NAME } = ChromeUtils.importESModule(
  "resource:///modules/whimsy/WhimsyProfileZoom.sys.mjs"
);
const { SitePermissions } = ChromeUtils.importESModule("resource:///modules/SitePermissions.sys.mjs");
const { ContentBlockingAllowList } = ChromeUtils.importESModule(
  "resource://gre/modules/ContentBlockingAllowList.sys.mjs"
);

const HOST = "example.com";
const SITE = `https://${HOST}/`;
const WORK = 2;
const oa = (userContextId, privateBrowsingId = 0) => ({ userContextId, privateBrowsingId });
const principalOf = (origin, attrs) =>
  Services.scriptSecurityManager.createContentPrincipal(Services.io.newURI(origin), attrs);
const capability = (principal, type) => Services.perms.getPermissionObject(principal, type, true)?.capability;

function panel() {
  return document.getElementById("zen-unified-site-data-panel");
}
const profileSection = () => document.getElementById("whimsy-site-settings-profile-section");
const siteSection = () => document.getElementById("whimsy-site-settings-section");
const kindsOf = el => [...el.querySelectorAll("[whimsy-site-setting]")].map(r => r.getAttribute("whimsy-site-setting"));

async function openPanel() {
  await WhimsySiteSettings.hidePanel(window);
  gNavToolbox.setAttribute("zen-has-implicit-hover", "true");
  const shown = BrowserTestUtils.waitForPopupEvent(panel(), "shown");
  WhimsySiteSettings.open(window);
  await shown;
  await document.l10n.translateFragment(panel());
}

async function closePanel() {
  await WhimsySiteSettings.hidePanel(window);
  gNavToolbox.removeAttribute("zen-has-implicit-hover");
}

// A profile's tabs live in that profile's space, so open them there (as the
// other profile tests do); Default's tabs open back in the first space.
const HOME_SPACE = gZenWorkspaces.activeWorkspace;
const spaces = new Map();
async function spaceFor(userContextId) {
  if (!userContextId) {
    return HOME_SPACE;
  }
  if (!spaces.has(userContextId)) {
    const space = await gZenWorkspaces.createAndSaveWorkspace(`Profile ${userContextId}`, undefined, true, userContextId);
    spaces.set(userContextId, space.uuid);
  }
  return spaces.get(userContextId);
}

async function selectTab(tab) {
  const space = tab.getAttribute("zen-workspace-id");
  if (space && gZenWorkspaces.activeWorkspace != space) {
    await gZenWorkspaces.changeWorkspaceWithID(space);
  }
  gBrowser.selectedTab = tab;
}

async function openTab(url, userContextId = 0) {
  const space = await spaceFor(userContextId);
  if (gZenWorkspaces.activeWorkspace != space) {
    await gZenWorkspaces.changeWorkspaceWithID(space);
  }
  const tab = BrowserTestUtils.addTab(gBrowser, url, { userContextId });
  gBrowser.selectedTab = tab;
  const browser = tab.linkedBrowser;
  await TestUtils.waitForCondition(() => browser.currentURI.spec == url && !browser.webProgress.isLoadingDocument,
    `Loaded ${url}`);
  is(browser.browsingContext.originAttributes.userContextId, userContextId, `${url} opens in profile ${userContextId}`);
  return tab;
}

function clearSite() {
  for (const attrs of [oa(0), oa(WORK), oa(3)]) {
    const principal = principalOf(SITE.slice(0, -1), attrs);
    for (const type of [...Object.values(PERM_TYPES), "autoplay-media", "camera", "trackingprotection"]) {
      Services.perms.removeFromPrincipal(principal, type);
    }
  }
  Services.prefs.clearUserPref("whimsy.dark-pages.profiles");
  Services.prefs.setStringPref(SITES, "{}");
}

// Full Screen is checked as a stored flag: opening the site must not put the
// test window itself in full screen, which outlives this file.
const enterFullscreen = WhimsySiteSettings.enterFullscreen;
WhimsySiteSettings.enterFullscreen = () => {};

registerCleanupFunction(async () => {
  WhimsySiteSettings.enterFullscreen = enterFullscreen;
  await closePanel();
  clearSite();
  if (gZenWorkspaces.activeWorkspace != HOME_SPACE) {
    await gZenWorkspaces.changeWorkspaceWithID(HOME_SPACE);
  }
  for (const uuid of spaces.values()) {
    for (const tab of gZenWorkspaces.allStoredTabs.filter(t => t.getAttribute("zen-workspace-id") == uuid &&
      !t.hasAttribute("zen-essential") && !t.hasAttribute("zen-empty-tab"))) {
      BrowserTestUtils.removeTab(tab);
    }
    await gZenWorkspaces.removeWorkspace(uuid);
  }
});

add_task(async function test_headings_and_rows() {
  clearSite();
  ok(Services.prefs.getBoolPref("permissions.isolateBy.userContext"), "Permissions are kept per profile");
  const tab = await openTab(SITE, WORK);
  SitePermissions.setForPrincipal(tab.linkedBrowser.contentPrincipal, "camera", SitePermissions.BLOCK);
  try {
    await openPanel();
    const zenSettings = document.getElementById("zen-site-data-settings-list").closest(".zen-site-data-section");
    ok(zenSettings.hidden, "Zen's Settings heading steps aside");
    const headings = [...panel().querySelectorAll(".whimsy-site-settings-caption > .whimsy-surface-caption-label")]
      .filter(el => el.checkVisibility());
    Assert.deepEqual(headings.map(el => el.textContent), ["Profile Settings", "Site Settings"],
      "Two headings, profile first");
    is(profileSection().nextElementSibling, siteSection(), "Site Settings right under Profile Settings");
    is(profileSection().previousElementSibling, zenSettings, "where Zen's Settings was");
    is(profileSection().querySelector(".whimsy-site-settings-caption-who").textContent, WhimsyProfiles.nameOf(WORK),
      "Profile Settings names the profile");
    is(siteSection().querySelector(".whimsy-site-settings-caption-who").textContent, HOST,
      "Site Settings names the site");
    const more = document.getElementById("zen-site-data-settings-more");
    is(more.parentNode, siteSection().querySelector(".whimsy-site-settings-caption"), "More sits beside Site Settings");
    ok(more.checkVisibility(), "and shows");
    ok(siteSection().querySelector(".whimsy-site-settings-caption #whimsy-site-settings-forget-all"),
      "Forget All stays in the site heading");

    Assert.deepEqual(kindsOf(profileSection()), ["profile-dark-pages"], "Profile Settings: Automatic Dark Mode only");
    is(document.getElementById("whimsy-site-settings-profile-dark-label").textContent, "Automatic Dark Mode",
      "named Automatic Dark Mode");
    Assert.deepEqual(kindsOf(siteSection()),
      ["dark-pages", "tracking", "zoom", "autoplay", "permission-camera", "reader", "fullscreen", "useragent"],
      "Site Settings: Dark Mode, Tracking Protection, Zoom, Autoplay, each permission, Reader, Full Screen, Pretend to Be");
    is(document.getElementById("whimsy-dark-page-site-label").textContent, "Dark Mode", "Dark Mode");
    is(document.getElementById("whimsy-site-settings-tracking-label").textContent, "Tracking Protection",
      "Tracking Protection");
    ok(document.getElementById("whimsy-site-settings-tracking-switch").checked, "which is on");
    ok(!panel().textContent.includes("Proxy"), "No Proxy row");

    // A permission row picks Allow or Block for this profile.
    const row = siteSection().querySelector('[whimsy-site-setting="permission-camera"]');
    is(row.getAttribute("state"), "allow", "The stored permission reads as remembered");
    const button = row.querySelector(".whimsy-surface-dropdown");
    const listId = `${button.id}-list`;
    const opened = BrowserTestUtils.waitForEvent(document, "popupshown", true, e => e.target.id == listId);
    button.click();
    await opened;
    const list = document.getElementById(listId);
    Assert.deepEqual([...list.querySelectorAll("[role=option]")].map(o => Number(o.dataset.value)),
      [SitePermissions.ALLOW, SitePermissions.BLOCK], "Allow or Block");
    list.querySelector(`[role=option][data-value="${SitePermissions.ALLOW}"]`).click();
    await TestUtils.waitForCondition(() => !list.isConnected, "The list closes on a pick");
    is(capability(principalOf("https://example.com", oa(WORK)), "camera"), Services.perms.ALLOW_ACTION,
      "Allow is stored for the profile");
    ok(!capability(principalOf("https://example.com", oa(0)), "camera"), "and not for Default");
    await closePanel();

    // A page that isn't a site: Zen's own heading, with More, comes back.
    const other = await openTab("about:robots");
    await openPanel();
    ok(siteSection().hidden && profileSection().hidden, "No Whimsy headings off a site");
    ok(more.parentNode.classList.contains("zen-site-data-section-header"), "More is back in Zen's heading");
    await closePanel();
    BrowserTestUtils.removeTab(other);
  } finally {
    BrowserTestUtils.removeTab(tab);
    clearSite();
  }
});

add_task(async function test_profiles_keep_their_own_permissions() {
  clearSite();
  const origin = "https://example.com";
  const home = principalOf(origin, oa(0));
  const work = principalOf(origin, oa(WORK));

  for (const kind of ["reader", "fullscreen"]) {
    WhimsySiteSettings.setFlag(kind, HOST, oa(WORK), true);
    ok(WhimsySiteSettings.getFlag(kind, HOST, oa(WORK)), `${kind}: on in Work`);
    ok(!WhimsySiteSettings.getFlag(kind, HOST, oa(0)), `${kind}: Default doesn't share it`);
    is(capability(work, PERM_TYPES[kind]), Services.perms.ALLOW_ACTION, `${kind}: on Work's own principal`);
    ok(!Services.perms.all.some(p => p.type.startsWith(`${PERM_TYPES[kind]}.uc`)), `${kind}: no ".ucN" type`);
    WhimsySiteSettings.setFlag(kind, HOST, oa(WORK), false);
  }
  for (const type of ["autoplay-media", "camera"]) {
    SitePermissions.setForPrincipal(work, type, SitePermissions.BLOCK);
    is(capability(work, type), SitePermissions.BLOCK, `${type}: blocked in Work`);
    ok(!capability(home, type), `${type}: Default doesn't share it`);
    SitePermissions.setForPrincipal(home, type, SitePermissions.ALLOW);
    is(capability(work, type), SitePermissions.BLOCK, `${type}: and Default's own leaves Work's alone`);
  }

  // Tracking Protection: the switch is per profile, like the shield's.
  const workTab = await openTab(SITE, WORK);
  const homeTab = await openTab(SITE, 0);
  try {
    ContentBlockingAllowList.add(workTab.linkedBrowser);
    ok(ContentBlockingAllowList.includes(workTab.linkedBrowser), "Tracking Protection off in Work");
    ok(!ContentBlockingAllowList.includes(homeTab.linkedBrowser), "but still on in Default");
    await selectTab(workTab);
    await openPanel();
    ok(!document.getElementById("whimsy-site-settings-tracking-switch").checked, "Work's panel shows it off");
    await closePanel();
    await selectTab(homeTab);
    await openPanel();
    ok(document.getElementById("whimsy-site-settings-tracking-switch").checked, "Default's shows it on");
    await closePanel();
    ContentBlockingAllowList.remove(workTab.linkedBrowser);
  } finally {
    BrowserTestUtils.removeTab(workTab);
    BrowserTestUtils.removeTab(homeTab);
    clearSite();
  }
});

add_task(async function test_dark_mode_per_profile() {
  clearSite();
  await SpecialPowers.pushPrefEnv({ set: [[MODE, "always"]] });
  const workTab = await openTab(PAGE, WORK);
  const homeTab = await openTab(PAGE, 0);
  try {
    await darkState(homeTab.linkedBrowser, "generated");
    await darkState(workTab.linkedBrowser, "generated");
    ok(WhimsyDarkPages.profileOn(WORK), "A profile nobody switched follows Settings (on)");

    // The profile's switch: Work's pages turn original, Default's stay dark.
    await selectTab(workTab);
    await openPanel();
    const profileSwitch = document.getElementById("whimsy-site-settings-profile-dark-switch");
    ok(profileSwitch.checked, "Automatic Dark Mode is on");
    ok(document.getElementById("whimsy-site-settings-dark-pages-switch").checked, "and the site's Dark Mode with it");
    EventUtils.synthesizeMouseAtCenter(profileSwitch, {});
    await darkState(workTab.linkedBrowser, "original");
    ok(!WhimsyDarkPages.profileOn(WORK), "Work's Automatic Dark Mode is off");
    ok(WhimsyDarkPages.profileOn(0), "Default's isn't");
    await TestUtils.waitForCondition(
      () => document.getElementById("whimsy-site-settings-dark-pages-switch")?.checked === false,
      "The site's Dark Mode starts at the profile's (off)");
    is(WhimsyDarkPages.storedChoice(workTab.linkedBrowser), null, "without remembering the site");
    is(WhimsyDarkPages.state(homeTab.linkedBrowser), "generated", "Default's page stays dark");

    // The site's switch overrides the profile.
    EventUtils.synthesizeMouseAtCenter(document.getElementById("whimsy-site-settings-dark-pages-switch"), {});
    await darkState(workTab.linkedBrowser, "generated");
    is(WhimsyDarkPages.storedChoice(workTab.linkedBrowser), "on", "The site's own Dark Mode is remembered");
    is(WhimsyDarkPages.storedChoice(homeTab.linkedBrowser), null, "for Work only");
    await closePanel();

    // Two states: switching the site back to the profile's forgets it.
    WhimsyDarkPages.setDark(workTab.linkedBrowser, false);
    await darkState(workTab.linkedBrowser, "original");
    is(WhimsyDarkPages.storedChoice(workTab.linkedBrowser), null, "Back at the profile's: nothing remembered");
  } finally {
    BrowserTestUtils.removeTab(workTab);
    BrowserTestUtils.removeTab(homeTab);
    clearSite();
    await SpecialPowers.popPrefEnv();
  }
});

add_task(async function test_migration() {
  const origin = "https://migrate.example.com";
  const home = principalOf(origin, oa(0));
  const work = principalOf(origin, oa(WORK));
  const other = principalOf(origin, oa(3));
  const keep = principalOf("https://keep.example.com", oa(0));
  const keepWork = principalOf("https://keep.example.com", oa(WORK));
  const privateHome = principalOf("https://private.example.com", oa(0, 1));
  const cleanup = () => {
    for (const p of [home, work, other, keep, keepWork, privateHome,
      principalOf("https://private.example.com", oa(WORK)), principalOf("https://private.example.com", oa(WORK, 1))]) {
      for (const type of ["camera", "geo", "whimsy-site-reader", "whimsy-site-reader.uc2", "whimsy-site-fullscreen.uc3",
        "whimsy-site-fullscreen"]) {
        Services.perms.removeFromPrincipal(p, type);
      }
    }
  };
  cleanup();

  // What profiles saw before: Default's (the container was dropped).
  Services.perms.addFromPrincipal(home, "camera", Services.perms.ALLOW_ACTION);
  Services.perms.addFromPrincipal(keep, "geo", Services.perms.ALLOW_ACTION);
  // A profile's own, written since: never overwritten.
  Services.perms.addFromPrincipal(keepWork, "geo", Services.perms.DENY_ACTION);
  // The old per-profile Reader and Full Screen types.
  Services.perms.addFromPrincipal(home, "whimsy-site-reader.uc2", Services.perms.ALLOW_ACTION);
  Services.perms.addFromPrincipal(home, "whimsy-site-fullscreen.uc3", Services.perms.ALLOW_ACTION);
  // Private: memory only, never copied.
  Services.perms.addFromPrincipal(privateHome, "camera", Services.perms.ALLOW_ACTION);
  const key = p => `${p.principal.origin}|${p.type}`;
  const existing = new Set(Services.perms.all.map(key));
  const before = Services.perms.all.filter(p => !p.principal.originAttributes.userContextId && !p.type.includes(".uc"))
    .map(p => `${p.principal.origin}|${p.type}|${p.capability}`).sort();

  try {
    const first = WhimsySiteSettings.migratePermissions({ force: true, userContextIds: [WORK, 3] });
    ok(first.copied >= 3, `Default's permissions copied into each profile (${first.copied})`);
    is(first.folded, 2, "and both old per-profile types folded in");
    ok(Services.prefs.getBoolPref("whimsy.site-settings.profile-permissions-migrated"), "recorded as done");

    is(capability(work, "camera"), Services.perms.ALLOW_ACTION, "Work keeps the camera it was allowed");
    is(capability(other, "camera"), Services.perms.ALLOW_ACTION, "and so does every other profile");
    is(capability(home, "camera"), Services.perms.ALLOW_ACTION, "Default keeps its own");
    is(capability(keepWork, "geo"), Services.perms.DENY_ACTION, "A profile's own decision isn't overwritten");

    is(capability(work, "whimsy-site-reader"), Services.perms.ALLOW_ACTION, "Work's old Reader type is Work's Reader");
    ok(!capability(other, "whimsy-site-reader"), "only Work's");
    ok(!capability(home, "whimsy-site-reader"), "and not Default's");
    is(capability(other, "whimsy-site-fullscreen"), Services.perms.ALLOW_ACTION, "Profile 3's Full Screen likewise");
    ok(!Services.perms.all.some(p => /^whimsy-site-(reader|fullscreen)\.uc\d+$/.test(p.type)), "No old types left");

    ok(!capability(principalOf("https://private.example.com", oa(WORK)), "camera"), "Private permissions aren't copied");
    ok(!capability(principalOf("https://private.example.com", oa(WORK, 1)), "camera"), "not even to private");
    ok(!Services.perms.all.some(p => p.principal.originAttributes.userContextId &&
      ["cookie", "https-only-load-insecure", "ipp-vpn"].includes(p.type)), "Shared types aren't copied");

    const after = Services.perms.all.filter(p => !p.principal.originAttributes.userContextId && !p.type.includes(".uc"))
      .map(p => `${p.principal.origin}|${p.type}|${p.capability}`).sort();
    Assert.deepEqual(after, before, "Nothing of Default's is lost or changed");

    const snapshot = () => Services.perms.all.map(p => `${p.principal.origin}|${p.type}|${p.capability}`).sort();
    const settled = snapshot();
    Assert.deepEqual(WhimsySiteSettings.migratePermissions({ force: true, userContextIds: [WORK, 3] }),
      { copied: 0, folded: 0 }, "Run again, it changes nothing");
    Assert.deepEqual(snapshot(), settled, "Idempotent: the same permissions");
    Assert.deepEqual(WhimsySiteSettings.migratePermissions(), { copied: 0, folded: 0 }, "and once done, it doesn't run");
  } finally {
    cleanup();
    // The copies this run made of the harness's own permissions.
    for (const permission of Services.perms.all) {
      if (permission.principal.originAttributes.userContextId && !existing.has(key(permission))) {
        Services.perms.removePermission(permission);
      }
    }
  }
});

add_task(async function test_zoom_per_profile() {
  const cps = Cc["@mozilla.org/content-pref/service;1"].getService(Ci.nsIContentPrefService2);
  const stored = name => new Promise(resolve => {
    let value;
    cps.getByDomainAndName(SITE, name, null, {
      handleResult: pref => (value = pref.value),
      handleCompletion: () => resolve(value),
      handleError: () => resolve(undefined),
    });
  });
  await new Promise(resolve => cps.removeByName(ZOOM_NAME, null, { handleCompletion: resolve }));
  const workTab = await openTab(SITE, WORK);
  try {
    await FullZoom.enlarge(workTab.linkedBrowser);
    const zoomed = ZoomManager.getZoomForBrowser(workTab.linkedBrowser);
    ok(zoomed > 1, `Zoomed in in Work (${zoomed})`);
    const name = WhimsyProfileZoom.nameFor(ZOOM_NAME, WORK);
    is(name, `${ZOOM_NAME}.uc${WORK}`, "Work's zoom has its own name");
    is(WhimsyProfileZoom.userContextIdOf(workTab.linkedBrowser.loadContext), WORK, "FullZoom's context is Work's");
    await TestUtils.waitForCondition(async () => Math.abs(((await stored(name)) ?? 1) - zoomed) < 0.01,
      "saved under Work's name");
    is(await stored(ZOOM_NAME), undefined, "and not Default's");

    const homeTab = await openTab(SITE, 0);
    is(ZoomManager.getZoomForBrowser(homeTab.linkedBrowser), 1, "A Default tab of the site loads at 100%");
    const workAgain = await openTab(SITE, WORK);
    await TestUtils.waitForCondition(
      () => Math.abs(ZoomManager.getZoomForBrowser(workAgain.linkedBrowser) - zoomed) < 0.01,
      "A new Work tab of the site loads at Work's zoom");
    is(ZoomManager.getZoomForBrowser(homeTab.linkedBrowser), 1, "and Default's tab stayed at 100%");

    await FullZoom.enlarge(homeTab.linkedBrowser);
    await TestUtils.waitForCondition(async () => ((await stored(ZOOM_NAME)) ?? 1) > 1,
      "Default's zoom keeps the name it always had");
    await FullZoom.reset(homeTab.linkedBrowser);
    BrowserTestUtils.removeTab(homeTab);
    BrowserTestUtils.removeTab(workAgain);

    await WhimsyProfileZoom.forgetProfile(WORK);
    is(await stored(name), undefined, "A deleted profile's zoom goes with it");
  } finally {
    await FullZoom.reset(workTab.linkedBrowser);
    BrowserTestUtils.removeTab(workTab);
    await new Promise(resolve => cps.removeByName(ZOOM_NAME, null, { handleCompletion: resolve }));
  }
});

// W28, the owner: "New is the default. Don't copy." A profile made after the
// one-time migration starts with no site permissions of its own, whatever
// Default has; opening a window (which runs the migration check) copies
// nothing into it.
add_task(async function test_new_profile_starts_fresh() {
  clearSite();
  const origin = "https://example.com";
  const home = principalOf(origin, oa(0));
  const types = ["camera", "geo", "autoplay-media", PERM_TYPES.reader, PERM_TYPES.fullscreen];
  Services.perms.addFromPrincipal(home, "camera", Services.perms.ALLOW_ACTION);
  Services.perms.addFromPrincipal(home, "geo", Services.perms.DENY_ACTION);
  SitePermissions.setForPrincipal(home, "autoplay-media", SitePermissions.ALLOW);
  WhimsySiteSettings.setFlag("reader", HOST, oa(0), true);
  WhimsySiteSettings.setFlag("fullscreen", HOST, oa(0), true);
  const id = WhimsyProfiles.create("Fresh Start");
  let tab = null;
  try {
    Assert.deepEqual(WhimsySiteSettings.migratePermissions(), { copied: 0, folded: 0 },
      "A window opening copies nothing into a new profile");
    const fresh = principalOf(origin, oa(id));
    for (const type of types) {
      ok(capability(home, type), `Default has ${type}`);
      ok(!capability(fresh, type), `the new profile doesn't: ${type}`);
    }
    Assert.deepEqual(SitePermissions.getAllByPrincipal(fresh).filter(p => !["cookie", "https-only-load-insecure",
      "ipp-vpn"].includes(p.id)).map(p => p.id), [], "No permissions of its own at all");
    ok(!WhimsySiteSettings.getFlag("reader", HOST, oa(id)) && !WhimsySiteSettings.getFlag("fullscreen", HOST, oa(id)),
      "Reader and Full Screen are off");

    tab = await openTab(SITE, id);
    await openPanel();
    ok(!kindsOf(siteSection()).some(kind => kind.startsWith("permission-")), "Its panel lists no permissions");
    for (const kind of ["autoplay", "reader", "fullscreen"]) {
      is(siteSection().querySelector(`[whimsy-site-setting="${kind}"]`).getAttribute("state"), "block",
        `${kind}: at the default`);
    }
    ok(document.getElementById("whimsy-site-settings-forget-all").hidden, "Nothing to forget");
    await closePanel();
  } finally {
    if (tab) {
      BrowserTestUtils.removeTab(tab);
    }
    if (gZenWorkspaces.activeWorkspace != HOME_SPACE) {
      await gZenWorkspaces.changeWorkspaceWithID(HOME_SPACE);
    }
    if (spaces.has(id)) {
      await gZenWorkspaces.removeWorkspace(spaces.get(id));
      spaces.delete(id);
    }
    ok(await WhimsyProfiles.delete(id, window), "The new profile is deleted");
    Services.perms.removeFromPrincipal(home, "geo");
    clearSite();
  }
});

// W28, the owner: "User needs to be able to know what something like
// 'tracking protection' is. Maybe hover tooltip". Every row in Profile
// Settings and Site Settings has the platform tooltip, one sentence.
add_task(async function test_every_row_has_a_tooltip() {
  clearSite();
  const tab = await openTab(SITE, WORK);
  const principal = tab.linkedBrowser.contentPrincipal;
  const permissions = { camera: SitePermissions.BLOCK, geo: SitePermissions.ALLOW, popup: SitePermissions.ALLOW,
    "desktop-notification": SitePermissions.BLOCK, cookie: SitePermissions.ALLOW };
  for (const [type, state] of Object.entries(permissions)) {
    SitePermissions.setForPrincipal(principal, type, state);
  }
  try {
    await openPanel();
    ok(profileSection().checkVisibility(), "Profile Settings shows");
    const rows = [...profileSection().querySelectorAll("[whimsy-site-setting]"),
      ...siteSection().querySelectorAll("[whimsy-site-setting]")];
    const kinds = rows.map(row => row.getAttribute("whimsy-site-setting"));
    for (const kind of ["profile-dark-pages", "dark-pages", "tracking", "zoom", "autoplay", "reader", "fullscreen",
      "useragent", ...Object.keys(permissions).map(type => `permission-${type}`)]) {
      ok(kinds.includes(kind), `The ${kind} row shows`);
    }
    const seen = new Set();
    for (const row of rows) {
      const kind = row.getAttribute("whimsy-site-setting");
      const tip = row.getAttribute("tooltiptext") ?? "";
      ok(tip.trim().length > 10, `${kind} has a tooltip: "${tip}"`);
      ok(tip.endsWith("."), `${kind}: one sentence`);
      ok(!/\bnow\b/i.test(tip), `${kind}: never "Now"`);
      ok(!seen.has(tip), `${kind}: its own words`);
      seen.add(tip);
    }
    is(siteSection().querySelector('[whimsy-site-setting="tracking"]').getAttribute("tooltiptext"),
      "Blocks trackers that follow you across sites.", "Tracking Protection says what it is");

    // Every permission with its own tooltip has one, and the rest a general one.
    const ids = ["whimsy-site-settings-permission-tooltip",
      ...[...TOOLTIP_PERMISSIONS].map(type => `whimsy-site-settings-permission-${type}-tooltip`)];
    const messages = await document.l10n.formatMessages(ids.map(id => ({ id })));
    messages.forEach((message, i) => {
      const tip = message?.attributes?.find(a => a.name == "tooltiptext")?.value ?? "";
      ok(tip.length > 10 && !/\bnow\b/i.test(tip), `${ids[i]}: "${tip}"`);
    });
    await closePanel();
  } finally {
    for (const type of Object.keys(permissions)) {
      SitePermissions.removeFromPrincipal(principal, type);
    }
    BrowserTestUtils.removeTab(tab);
    clearSite();
  }
});

add_task(async function screenshots_profile_panel() {
  clearSite();
  await whimsyBothSchemes("w26-sitepanel-profile", async () => {
    const tab = await openTab(SITE, WORK);
    SitePermissions.setForPrincipal(tab.linkedBrowser.contentPrincipal, "camera", SitePermissions.BLOCK);
    await openPanel();
    ok(profileSection()?.checkVisibility(), "Profile Settings shows");
    const undo = whimsyStandInPopups();
    return async () => {
      undo();
      await closePanel();
      BrowserTestUtils.removeTab(tab);
      clearSite();
    };
  });
});
