/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// Fire button: one press ends the session, closing its tabs and clearing
// what they left, so you can start fresh. Pinned tabs and Essentials stay
// open (their data is still cleared). The real ForgetAboutSite /
// Services.clearData calls are stubbed or recorded so the shared test
// profile isn't wiped.

const { WhimsyFireButton } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyFireButton.sys.mjs");
const { WhimsyProfiles } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyProfiles.sys.mjs");
const { ContextualIdentityService } = ChromeUtils.importESModule(
  "moz-src:///toolkit/components/contextualidentity/ContextualIdentityService.sys.mjs"
);

const startTabs = new Set(gBrowser.tabs);
registerCleanupFunction(() => {
  for (const tab of gBrowser.tabs.filter(t => !startTabs.has(t))) {
    if (tab.isConnected && !tab.closing) {
      if (tab.pinned) {
        gBrowser.unpinTab(tab);
      }
      BrowserTestUtils.removeTab(tab);
    }
  }
});

add_task(function test_closable_tabs_excludes_pinned_and_essentials() {
  const fakeEssential = { pinned: false, closing: false, hasAttribute: name => name == "zen-essential" };
  const fakePinned = { pinned: true, closing: false, hasAttribute: () => false };
  const fakeNormal = { pinned: false, closing: false, hasAttribute: () => false };
  const result = WhimsyFireButton.closableTabs(window, [fakeEssential, fakePinned, fakeNormal]);
  is(result.length, 1, "Only the plain tab is closable");
  is(result[0], fakeNormal, "...and it's the right one");
});

add_task(async function test_burn_tabs_closes_only_closable_ones() {
  const pinned = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.com/?pinned-survivor");
  gBrowser.pinTab(pinned);
  const plain = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.com/?burn-me");
  const before = gBrowser.tabs.length;

  WhimsyFireButton.burnTabs(window, [pinned, plain], "test");

  await TestUtils.waitForCondition(() => gBrowser.tabs.length == before - 1, "Only the plain tab closed");
  ok(pinned.isConnected, "The pinned tab survived");
  ok(!plain.isConnected, "The plain tab didn't");
});

// wave7/fire: the sheet serves the Fire Button's point (end the session,
// start fresh), in the user's words: "Fire in This Profile" first, then
// "Fire Everywhere" (red). The line under the first counts the tabs and
// names the profile's spaces; the note under them names the profile and
// says exactly what's cleared and kept. Closing the sheet burns nothing.
add_task(async function test_fire_sheet() {
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.com/?fire-sheet");
  const id = WhimsyFireButton.profileId(window);
  const expected = WhimsyFireButton.profileTabs(window, id)
    .reduce((sum, [w, tabs]) => sum + WhimsyFireButton.closableTabs(w, tabs).length, 0);
  ok(WhimsyFireButton.profileTabs(window, id).some(([, tabs]) => tabs.includes(tab)),
    "The new tab is in this profile's tabs");
  const shown = BrowserTestUtils.waitForEvent(document, "popupshown", true, e => e.target.id == "whimsyFirePanel");
  WhimsyFireButton.openPanel(window);
  await shown;
  const panel = document.getElementById("whimsyFirePanel");
  ok(panel.classList.contains("whimsy-sheet"), "It is a Whimsy sheet");
  const scopes = [...panel.querySelectorAll(".whimsy-fire-scope")].map(i => i.getAttribute("whimsy-fire-scope"));
  Assert.deepEqual(scopes, ["profile", "everything"], "Two choices: this profile, then everywhere");
  const row = panel.querySelector('[whimsy-fire-scope="profile"]');
  const title = row.querySelector(".whimsy-sheet-item-title");
  is(document.l10n.getAttributes(title).id, "whimsy-fire-profile", "The first row is Fire in This Profile");
  await TestUtils.waitForCondition(() => (title.value || title.textContent) == "Fire in This Profile", "...in the user's words");
  const detail = document.l10n.getAttributes(row.querySelector(".whimsy-sheet-item-subtitle"));
  is(detail.args.count, expected, "Its line counts the tabs it will close");
  const spaceName = gZenWorkspaces.getActiveWorkspace().name;
  if (spaceName) {
    ok(detail.args.spaces.includes(spaceName), "...and names this profile's spaces");
  }
  ok(panel.querySelector('[whimsy-fire-scope="everything"]').hasAttribute("destructive"), "Fire Everywhere is red");
  const summary = panel.querySelector("#whimsy-fire-summary");
  Assert.deepEqual(document.l10n.getAttributes(summary),
    { id: "whimsy-fire-profile-summary", args: { profile: WhimsyProfiles.nameOf(id) } },
    "The note names the profile");
  await TestUtils.waitForCondition(() => summary.textContent.includes("last hour"), "...in words");
  if (id == 0) {
    ok(summary.textContent.includes("Default profile"), "No profile reads as the Default profile");
  }
  ok(/cookies, site data and cache/.test(summary.textContent), "...naming what goes");
  ok(summary.textContent.includes("Other profiles keep theirs"), "...what other profiles keep");
  ok(summary.textContent.includes("Pinned tabs"), "...and what stays open");
  for (const old of ["site", "last-15-min", "space", "session"]) {
    ok(!panel.querySelector(`[whimsy-fire-scope="${old}"]`), `No "${old}" row`);
  }

  const hidden = BrowserTestUtils.waitForEvent(panel, "popuphidden");
  panel.querySelector(".whimsy-sheet-close").doCommand();
  await hidden;
  ok(tab.isConnected, "Closing the sheet burns nothing");
  BrowserTestUtils.removeTab(tab);
});

// wave7/fire: per-site forgetting left the sheet but stays reachable as the
// "Forget About This Site…" command (only on a website), which names the
// site and asks first with Cancel as the default. Return there forgets
// nothing.
add_task(async function test_forget_site_is_a_command_that_confirms() {
  const { WhimsyCommands } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyCommands.sys.mjs");
  ok(WhimsyCommands.get("cmd_whimsyForgetSite"), "Forget About This Site… is a registered command");
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://www.example.com/?forget-site");
  const original = WhimsyFireButton.burnSite;
  let burned = 0;
  WhimsyFireButton.burnSite = async () => {
    burned++;
    return 0;
  };
  try {
    const dialogOpen = BrowserTestUtils.promiseAlertDialogOpen();
    const forgetting = WhimsyFireButton.forgetSite(window);
    const dialogWin = await dialogOpen;
    is(dialogWin.Dialog.args.defaultButtonNum, 1, "Cancel is the default button");
    ok(dialogWin.Dialog.args.title.includes("example.com"), "The question names the base domain");
    ok(dialogWin.Dialog.args.text.includes("subdomains"), "...and says subdomains and tabs go too");
    EventUtils.synthesizeKey("KEY_Enter", {}, dialogWin);
    await forgetting;
    is(burned, 0, "Return forgets nothing");
    ok(tab.isConnected, "...and closes nothing");
  } finally {
    WhimsyFireButton.burnSite = original;
    BrowserTestUtils.removeTab(tab);
  }
});

// wave5/uxfix: the flame flash stays under Zen's toasts, and reduced motion
// drops it entirely (the toast confirms instead).
add_task(async function test_fire_flash_layering_and_reduced_motion() {
  const root = document.documentElement;
  root.setAttribute("whimsy-fire-burning", "");
  try {
    const flash = getComputedStyle(root, "::after");
    Assert.less(Number(flash.zIndex), 1000, "The flash sits below Zen's toast layer");
    await SpecialPowers.pushPrefEnv({ set: [["ui.prefersReducedMotion", 1]] });
    await TestUtils.waitForCondition(() => getComputedStyle(root, "::after").display == "none",
      "Reduced motion hides the flash");
    await SpecialPowers.popPrefEnv();
  } finally {
    root.removeAttribute("whimsy-fire-burning");
  }
});

// wave5/uxfix: rows only choose a scope. Focus starts on the list, Return on
// a row clears nothing, and only the red footer button runs it, followed
// by a toast saying what closed and what was cleared. burnProfile is
// stubbed (it would clear the test profile's last hour) but closes the tab
// for real.
add_task(async function test_fire_needs_the_explicit_button() {
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.com/?fire-explicit");
  const original = WhimsyFireButton.burnProfile;
  let burned = 0;
  WhimsyFireButton.burnProfile = async win => {
    burned++;
    return { count: WhimsyFireButton.burnTabs(win, [tab], "profile"), visits: 0, sites: 0, profile: "Default" };
  };
  try {
    const shown = BrowserTestUtils.waitForEvent(document, "popupshown", true, e => e.target.id == "whimsyFirePanel");
    WhimsyFireButton.openPanel(window);
    await shown;
    const panel = document.getElementById("whimsyFirePanel");
    const session = panel.querySelector('[whimsy-fire-scope="profile"]');
    await TestUtils.waitForCondition(() => document.activeElement == session, "Focus starts on the first row");
    is(session.getAttribute("role"), "radio", "Rows are radios");
    is(session.getAttribute("aria-checked"), "true", "Fire in This Profile starts chosen");
    const forget = panel.querySelector("#whimsy-fire-forget");
    ok(forget.hasAttribute("destructive"), "The action is the red footer button");
    is(document.l10n.getAttributes(forget).id, "whimsy-fire-forget-profile", "It names the choice");

    EventUtils.synthesizeKey("KEY_Enter", {}, window);
    is(panel.state, "open", "Return on a row keeps the sheet open");
    is(burned, 0, "...and clears nothing");

    const everything = panel.querySelector('[whimsy-fire-scope="everything"]');
    everything.doCommand();
    is(everything.getAttribute("aria-checked"), "true", "Choosing the other row moves the choice");
    is(session.getAttribute("aria-checked"), "false", "...off the first");
    is(document.l10n.getAttributes(forget).id, "whimsy-fire-forget-everything", "The button follows the choice");
    is(document.l10n.getAttributes(panel.querySelector("#whimsy-fire-summary")).id, "whimsy-fire-everything-summary",
      "...and so does the note");

    session.doCommand();
    const hidden = BrowserTestUtils.waitForEvent(panel, "popuphidden");
    const toastShown = TestUtils.waitForCondition(() =>
      [...document.querySelectorAll("#zen-toast-container label")].some(l =>
        document.l10n.getAttributes(l).id == "whimsy-fire-done-profile"),
    "A toast says what closed and what was cleared");
    forget.doCommand();
    await hidden;
    await TestUtils.waitForCondition(() => !tab.isConnected, "The space's tabs close");
    is(burned, 1, "It ran once");
    await toastShown;
  } finally {
    WhimsyFireButton.burnProfile = original;
    if (tab.isConnected) {
      BrowserTestUtils.removeTab(tab);
    }
  }
});

// wave7/fire: Fire in This Profile is per profile. It closes the tabs of
// every space in the profile (not another profile's), removes only this
// profile's visits from the last hour (another profile's visit to the same
// URL stays), and clears the sites they touched only in this profile's
// container (the same site in another profile keeps its cookies; a site
// only another profile visited is untouched). Real Places and cookie data
// on test hosts; burnTabs is recorded so the test's tabs stay open.
add_task(async function test_burn_profile_is_per_profile() {
  const { WhimsySpaceHistory } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsySpaceHistory.sys.mjs");
  const { SiteDataTestUtils } = ChromeUtils.importESModule("resource://testing-common/SiteDataTestUtils.sys.mjs");
  const mine = WhimsyFireButton.profileId(window);
  const other = WhimsyProfiles.create("Fire Other");
  const sibling = await gZenWorkspaces.createAndSaveWorkspace("Fire Sibling", undefined, true, mine);
  const elsewhere = await gZenWorkspaces.createAndSaveWorkspace("Fire Elsewhere", undefined, true, other);
  const siblingTab = BrowserTestUtils.addTab(gBrowser, "about:blank");
  siblingTab.setAttribute("zen-workspace-id", sibling.uuid);
  const elsewhereTab = BrowserTestUtils.addTab(gBrowser, "about:blank");
  elsewhereTab.setAttribute("zen-workspace-id", elsewhere.uuid);

  const MINE_URL = "https://example.com/?fire-mine";
  const NET_URL = "https://example.net/?fire-other-profile";
  const now = Date.now();
  await PlacesUtils.history.insertMany([
    { url: MINE_URL, visits: [{ date: new Date(now - 60000) }, { date: new Date(now - 600000) }] },
    { url: NET_URL, visits: [{ date: new Date(now - 120000) }] },
  ]);
  const db = await PlacesUtils.promiseDBConnection();
  const rows = await db.execute(`SELECT v.id, v.visit_date, p.guid, p.url FROM moz_historyvisits v
    JOIN moz_places p ON p.id = v.place_id WHERE p.url IN (:a, :b)`, { a: MINE_URL, b: NET_URL });
  const file = await WhimsySpaceHistory.file();
  const ids = [];
  for (const row of rows) {
    const id = row.getResultByName("id");
    const time = Math.floor(row.getResultByName("visit_date") / 1000);
    const here = row.getResultByName("url") == MINE_URL && time == now - 60000;
    file.data.visits[id] = { id, time, guid: row.getResultByName("guid"),
      spaceId: here ? gZenWorkspaces.activeWorkspace : elsewhere.uuid, spaceName: here ? "Here" : "Fire Elsewhere",
      profile: WhimsyProfiles.keyFor(here ? mine : other) };
    ids.push(id);
  }
  is(ids.length, 3, "Three visits recorded with their profiles");
  SiteDataTestUtils.addToCookies({ origin: "https://example.com", originAttributes: { userContextId: mine } });
  SiteDataTestUtils.addToCookies({ origin: "https://example.com", originAttributes: { userContextId: other } });
  SiteDataTestUtils.addToCookies({ origin: "https://example.net", originAttributes: { userContextId: mine } });

  const originalBurnTabs = WhimsyFireButton.burnTabs;
  const closing = [];
  WhimsyFireButton.burnTabs = (w, tabs) => {
    closing.push(...tabs);
    return tabs.length;
  };
  try {
    const result = await WhimsyFireButton.burnProfile(window);
    ok(closing.includes(siblingTab), "Another space in this profile has its tabs closed too");
    ok(!closing.includes(elsewhereTab), "...but not a space in another profile");
    Assert.greaterOrEqual(result.visits, 1, "This profile's visit went");
    is(result.profile, WhimsyProfiles.nameOf(mine), "The toast names the profile");

    ok(!SiteDataTestUtils.hasCookies("https://example.com", null, { userContextId: mine }),
      "The site this profile visited lost its cookies in this profile");
    ok(SiteDataTestUtils.hasCookies("https://example.com", null, { userContextId: other }),
      "...but keeps them in another profile");
    ok(SiteDataTestUtils.hasCookies("https://example.net", null, { userContextId: mine }),
      "A site only another profile visited keeps its cookies");

    const left = await db.execute(`SELECT v.visit_date, p.url FROM moz_historyvisits v
      JOIN moz_places p ON p.id = v.place_id WHERE p.url IN (:a, :b)`, { a: MINE_URL, b: NET_URL });
    const kept = left.map(row => `${row.getResultByName("url")}@${Math.floor(row.getResultByName("visit_date") / 1000)}`).sort();
    Assert.deepEqual(kept, [`${MINE_URL}@${now - 600000}`, `${NET_URL}@${now - 120000}`].sort(),
      "Only this profile's visit left history; another profile's visits (same URL included) stay");
  } finally {
    WhimsyFireButton.burnTabs = originalBurnTabs;
    for (const id of ids) {
      delete file.data.visits[id];
    }
    file.saveSoon();
    await PlacesUtils.history.remove([MINE_URL, NET_URL]).catch(() => {});
    for (const site of ["example.com", "example.net"]) {
      await new Promise(resolve => Services.clearData.deleteDataFromSite(site, {}, true,
        Ci.nsIClearDataService.CLEAR_COOKIES, { onDataDeleted: resolve }));
    }
    BrowserTestUtils.removeTab(siblingTab);
    BrowserTestUtils.removeTab(elsewhereTab);
    await gZenWorkspaces.removeWorkspace(sibling.uuid);
    await gZenWorkspaces.removeWorkspace(elsewhere.uuid);
    ContextualIdentityService.remove(other);
  }
});

// wave7/fire: Everything clears exactly what its note and confirm name.
add_task(function test_everything_flags() {
  const C = Ci.nsIClearDataService;
  is(WhimsyFireButton.forgetFlags, C.CLEAR_HISTORY | C.CLEAR_COOKIES_AND_SITE_DATA | C.CLEAR_ALL_CACHES,
    "History, cookies, site data and cache");
  is(WhimsyFireButton.siteFlags, C.CLEAR_COOKIES_AND_SITE_DATA | C.CLEAR_ALL_CACHES,
    "Fire in This Profile clears a site's cookies, site data and cache");
});

// wave7/ux: "Everything" can't be undone, so the Forget button asks once
// more in the window's own dialog (as Delete Space does), with Cancel as
// the default. Return there forgets nothing; only "Forget Everything" runs
// it, and then the toast says what went. burnEverything is stubbed so the
// shared test profile isn't wiped.
add_task(async function test_fire_everything_confirms_with_cancel_default() {
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.com/?fire-everything");
  const original = WhimsyFireButton.burnEverything;
  let burned = 0;
  WhimsyFireButton.burnEverything = async () => {
    burned++;
    return 0;
  };
  try {
    async function openEverything() {
      const shown = BrowserTestUtils.waitForEvent(document, "popupshown", true, e => e.target.id == "whimsyFirePanel");
      WhimsyFireButton.openPanel(window);
      await shown;
      const panel = document.getElementById("whimsyFirePanel");
      panel.querySelector('[whimsy-fire-scope="everything"]').doCommand();
      is(panel.dataset.scope, "everything", "Everything is chosen");
      return panel;
    }

    // Return in the dialog picks Cancel.
    let panel = await openEverything();
    let dialogOpen = BrowserTestUtils.promiseAlertDialogOpen();
    let forgetting = WhimsyFireButton.forget(window, panel);
    let dialogWin = await dialogOpen;
    is(dialogWin.Dialog.args.defaultButtonNum, 1, "Cancel is the default button");
    const dialogEl = dialogWin.document.querySelector("dialog");
    is(dialogEl.defaultButton, "cancel", "...so Return cancels");
    is(dialogEl.getButton("accept").label, "Fire Everywhere", "The accept button names the action");
    EventUtils.synthesizeKey("KEY_Enter", {}, dialogWin);
    await forgetting;
    is(burned, 0, "Return in the confirm forgets nothing");
    ok(tab.isConnected, "...and closes no tabs");

    // The explicit button runs it, and the toast reports it.
    panel = await openEverything();
    dialogOpen = BrowserTestUtils.promiseAlertDialogOpen();
    const toastShown = TestUtils.waitForCondition(() =>
      [...document.querySelectorAll("#zen-toast-container label")].some(l =>
        document.l10n.getAttributes(l).id == "whimsy-fire-done-everything"),
    "A toast says everything was forgotten");
    forgetting = WhimsyFireButton.forget(window, panel);
    dialogWin = await dialogOpen;
    dialogWin.document.querySelector("dialog").getButton("accept").click();
    await forgetting;
    is(burned, 1, "Forget Everything runs once accepted");
    await toastShown;
  } finally {
    WhimsyFireButton.burnEverything = original;
    BrowserTestUtils.removeTab(tab);
  }
});

// wave7/ux: Fire in This Profile doesn't ask again; the sheet's explicit
// button (which names it) is enough.
add_task(async function test_fire_profile_does_not_confirm() {
  const original = WhimsyFireButton.confirmEverything;
  let asked = 0;
  WhimsyFireButton.confirmEverything = async () => {
    asked++;
    return false;
  };
  const originalProfile = WhimsyFireButton.burnProfile;
  WhimsyFireButton.burnProfile = async () => 0;
  try {
    const shown = BrowserTestUtils.waitForEvent(document, "popupshown", true, e => e.target.id == "whimsyFirePanel");
    WhimsyFireButton.openPanel(window);
    await shown;
    const panel = document.getElementById("whimsyFirePanel");
    await WhimsyFireButton.forget(window, panel);
    is(asked, 0, "Fire in This Profile doesn't ask a second time");
  } finally {
    WhimsyFireButton.confirmEverything = original;
    WhimsyFireButton.burnProfile = originalProfile;
  }
});

// Security review H2: burned tabs never come back. Both choices close their
// tabs first without a closed-tab entry, forget closed tabs already in
// scope, write the session file, and only then clear. Afterwards
// Cmd+Shift+T restores nothing burned and the session file has none of the
// burned URLs. Data clearing is stubbed (the shared profile keeps its data).
add_task(async function test_fire_leaves_nothing_restorable() {
  const { SessionStore } = ChromeUtils.importESModule("moz-src:///browser/components/sessionstore/SessionStore.sys.mjs");
  const { SessionSaver } = ChromeUtils.importESModule("moz-src:///browser/components/sessionstore/SessionSaver.sys.mjs");
  const { TabStateFlusher } = ChromeUtils.importESModule("moz-src:///browser/components/sessionstore/TabStateFlusher.sys.mjs");
  const recovery = PathUtils.join(PathUtils.profileDir, "sessionstore-backups", "recovery.jsonlz4");
  const closedURLs = () => SessionStore.getClosedTabDataForWindow(window)
    .flatMap(item => (item.state?.entries ?? []).map(entry => entry.url));
  async function sessionText() {
    await SessionSaver.run();
    return JSON.stringify(await IOUtils.readJSON(recovery, { decompress: true }));
  }
  async function openFlushed(url) {
    const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, url);
    await TabStateFlusher.flush(tab.linkedBrowser);
    return tab;
  }
  const stubs = { profileVisits: async () => [], clearSiteData: async () => {}, removeVisit: async () => {},
    clearData: async () => {} };
  const originals = {};
  for (const [name, fn] of Object.entries(stubs)) {
    originals[name] = WhimsyFireButton[name];
    WhimsyFireButton[name] = fn;
  }
  const originalProfileTabs = WhimsyFireButton.profileTabs;
  const originalAllTabs = WhimsyFireButton.allTabs;
  try {
    // Fire in This Profile: a tab of this profile closed earlier in the hour,
    // and one burned now.
    const EARLIER = "https://example.com/?fire-h2-closed-earlier";
    const BURNED = "https://example.com/?fire-h2-burned";
    const earlier = await openFlushed(EARLIER);
    BrowserTestUtils.removeTab(earlier);
    await TestUtils.waitForCondition(() => closedURLs().includes(EARLIER), "A normal close is restorable");
    const burned = await openFlushed(BURNED);
    WhimsyFireButton.profileTabs = () => [[window, [burned]]];
    await WhimsyFireButton.burnProfile(window);
    ok(!burned.isConnected, "The burned tab closed");
    ok(!closedURLs().includes(BURNED), "It never entered the closed-tab list");
    ok(!closedURLs().includes(EARLIER), "The profile's earlier closed tab is forgotten too");
    let text = await sessionText();
    ok(!text.includes("fire-h2-burned") && !text.includes("fire-h2-closed-earlier"),
      "The session file has neither URL");
    const restored = SessionStore.undoCloseTab(window, 0);
    if (restored) {
      ok(!/fire-h2/.test(SessionStore.getTabState(restored)), "Cmd+Shift+T brings back nothing burned");
      BrowserTestUtils.removeTab(restored);
    } else {
      ok(true, "Cmd+Shift+T has nothing to restore");
    }

    // Fire Everywhere: same order, everything closed is forgotten.
    const ALL = "https://example.com/?fire-h2-everywhere";
    const everywhere = await openFlushed(ALL);
    WhimsyFireButton.allTabs = () => [[window, [everywhere]]];
    await WhimsyFireButton.burnEverything(window);
    ok(!everywhere.isConnected, "Fire Everywhere closed the tab");
    is(SessionStore.getClosedTabCountForWindow(window), 0, "Nothing is left to reopen");
    is(SessionStore.getClosedWindowCount(), 0, "...and no closed windows");
    text = await sessionText();
    ok(!text.includes("fire-h2-everywhere"), "The session file doesn't have it");
  } finally {
    for (const [name, fn] of Object.entries(originals)) {
      WhimsyFireButton[name] = fn;
    }
    WhimsyFireButton.profileTabs = originalProfileTabs;
    WhimsyFireButton.allTabs = originalAllTabs;
  }
});
