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

// W10-30: Fire is a WhimsySurface that explains each choice in full: "The
// last hour in <profile>" (counts the tabs and names the profile's spaces),
// "Everything from <site>" (only on a web page) and "Everything,
// everywhere" (red tile), what's always kept, and one red button that
// names the choice. No arrow tail, no native rows. Closing it burns nothing.
async function openFire(options) {
  const shown = BrowserTestUtils.waitForEvent(document, "popupshown", true, e => e.target.id == "whimsyFirePanel");
  WhimsyFireButton.openPanel(window, options);
  await shown;
  const panel = document.getElementById("whimsyFirePanel");
  await document.l10n.translateFragment(panel);
  return panel;
}
async function closeFire(panel) {
  if (panel.state == "open") {
    const hidden = BrowserTestUtils.waitForEvent(panel, "popuphidden");
    panel.hidePopup();
    await hidden;
  }
}

add_task(async function test_fire_surface() {
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://www.example.com/?fire-sheet");
  const id = WhimsyFireButton.profileId(window);
  const expected = WhimsyFireButton.profileTabs(window, id)
    .reduce((sum, [w, tabs]) => sum + WhimsyFireButton.closableTabs(w, tabs).length, 0);
  const panel = await openFire();
  ok(panel.classList.contains("whimsy-surface"), "It is a Whimsy surface");
  is(panel.getAttribute("hidepopovertail"), "true", "with no arrow tail");
  ok(!panel.querySelector("menupopup, menuitem, toolbarseparator"), "and no native rows");
  is(panel.querySelector(".whimsy-surface-title").textContent, "What should Fire erase?", "The heading asks the question");
  const scopes = [...panel.querySelectorAll(".whimsy-fire-scope")].map(i => i.getAttribute("whimsy-fire-scope"));
  Assert.deepEqual(scopes, ["profile", "site", "everything"], "Three choices: this profile, this site, everywhere");
  const group = panel.querySelector(".whimsy-fire-choices");
  is(group.getAttribute("role"), "radiogroup", "The choices are a radio group");
  const row = panel.querySelector('[whimsy-fire-scope="profile"]');
  is(row.getAttribute("aria-checked"), "true", "The profile starts chosen");
  const name = row.querySelector(".whimsy-surface-choice-name");
  Assert.deepEqual(document.l10n.getAttributes(name),
    { id: "whimsy-fire-choice-profile", args: { profile: WhimsyProfiles.nameOf(id) } }, "It names the profile");
  const detail = row.querySelector(".whimsy-surface-choice-detail");
  is(document.l10n.getAttributes(detail).args.count, expected, "Its detail counts the tabs it will close");
  const spaceName = gZenWorkspaces.getActiveWorkspace().name;
  if (spaceName) {
    ok(document.l10n.getAttributes(detail).args.spaces.includes(spaceName), "...and names this profile's spaces");
  }
  ok(detail.textContent.includes("signed out") && detail.textContent.includes("Other profiles"), "...and says what it means");
  for (const card of panel.querySelectorAll(".whimsy-surface-choice-detail")) {
    Assert.lessOrEqual(card.scrollWidth, card.clientWidth + 1, "A detail is never cropped sideways");
    isnot(getComputedStyle(card).textOverflow, "ellipsis", "...nor ellipsed");
  }
  const site = panel.querySelector('[whimsy-fire-scope="site"] .whimsy-surface-choice-name');
  is(document.l10n.getAttributes(site).args.site, "example.com", "The site choice names the base domain");
  const everything = panel.querySelector('[whimsy-fire-scope="everything"]');
  is(everything.querySelector(".whimsy-surface-tile").getAttribute("tone"), "destructive", "Everywhere has the red tile");
  ok(everything.querySelector(".whimsy-surface-choice-detail").textContent.includes("the Archive"), "Everywhere says the Archive goes");
  const kept = panel.querySelector("#whimsy-fire-kept");
  ok(kept.textContent.includes("saved passwords") && kept.textContent.includes("Essentials"), "What's always kept is spelled out");

  panel.querySelector(".whimsy-surface-close").doCommand();
  await TestUtils.waitForCondition(() => !panel.isConnected, "The ✕ closes it");
  ok(tab.isConnected, "Closing it burns nothing");
  BrowserTestUtils.removeTab(tab);
});

add_task(async function test_fire_site_choice_only_on_web_pages() {
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, "about:robots");
  const panel = await openFire();
  ok(!panel.querySelector('[whimsy-fire-scope="site"]'), "No site choice on an about: page");
  await closeFire(panel);
  BrowserTestUtils.removeTab(tab);
});

// W10-30: "Forget About This Site…" (command bar) opens the surface with
// the site chosen, in place of its system dialog. Nothing runs until the
// red button.
add_task(async function test_forget_site_opens_the_surface() {
  const { WhimsyCommands } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyCommands.sys.mjs");
  ok(WhimsyCommands.get("cmd_whimsyForgetSite"), "Forget About This Site… is a registered command");
  ok(WhimsyCommands.get("cmd_whimsyFireProfile"), "Fire in This Profile is a registered command");
  ok(WhimsyCommands.get("cmd_whimsyFireEverywhere"), "Fire Everywhere is a registered command");
  is(WhimsyCommands.title(WhimsyCommands.get("cmd_whimsyFireProfile")), "Fire in This Profile", "Profile command title");
  is(WhimsyCommands.title(WhimsyCommands.get("cmd_whimsyFireEverywhere")), "Fire Everywhere", "Everywhere command title");
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://www.example.com/?forget-site");
  const original = WhimsyFireButton.burnSite;
  let burned = 0;
  WhimsyFireButton.burnSite = async () => {
    burned++;
    return 0;
  };
  let dialogs = 0;
  const onDialog = () => dialogs++;
  Services.obs.addObserver(onDialog, "common-dialog-loaded");
  try {
    const shown = BrowserTestUtils.waitForEvent(document, "popupshown", true, e => e.target.id == "whimsyFirePanel");
    WhimsyFireButton.forgetSite(window);
    await shown;
    const panel = document.getElementById("whimsyFirePanel");
    is(panel.dataset.scope, "site", "The site is chosen");
    const forget = panel.querySelector("#whimsy-fire-forget");
    Assert.deepEqual(document.l10n.getAttributes(forget), { id: "whimsy-fire-run-site", args: { site: "example.com" } },
      "The red button says Forget example.com");
    EventUtils.synthesizeKey("KEY_Enter", {}, window);
    is(burned, 0, "Return on the card forgets nothing");
    is(panel.state, "open", "...and keeps it open");
    const toastShown = TestUtils.waitForCondition(() => toastFor("whimsy-fire-done-site-title"),
      "The result toast says it forgot the site");
    forget.doCommand();
    await toastShown;
    is(burned, 1, "The red button forgets it");
    is(dialogs, 0, "No system dialog");
  } finally {
    Services.obs.removeObserver(onDialog, "common-dialog-loaded");
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
    await TestUtils.waitForCondition(() => getComputedStyle(root, "::after").animationName == "none",
      "Reduced motion drops the flash");
    is(getComputedStyle(root, "::after").opacity, "0", "...so nothing shows");
    await SpecialPowers.popPrefEnv();
  } finally {
    root.removeAttribute("whimsy-fire-burning");
  }
});

// A flash that starts or ends while a surface is opening doesn't close it
// (the flash layer used to be created and removed on the window's root,
// which rebuilt every frame, popups included).
add_task(async function test_fire_flash_never_closes_a_surface() {
  const root = document.documentElement;
  const shown = BrowserTestUtils.waitForEvent(document, "popupshown", true, e => e.target.id == "whimsyFirePanel");
  const panel = WhimsyFireButton.openPanel(window);
  root.setAttribute("whimsy-fire-burning", "");
  root.getBoundingClientRect();
  root.removeAttribute("whimsy-fire-burning");
  await shown;
  is(panel.state, "open", "The surface opened through the flash");
  await closeFire(panel);
});

// wave5/uxfix + W10-30: cards only choose. Focus starts on the chosen card,
// arrows move the choice, Return on a card clears nothing, the red button
// follows the choice, and only it runs, followed by a toast with a title
// and a second line. burnProfile is stubbed (it would clear the test
// profile's last hour) but closes the tab for real.
add_task(async function test_fire_needs_the_explicit_button() {
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.com/?fire-explicit");
  const original = WhimsyFireButton.burnProfile;
  let burned = 0;
  WhimsyFireButton.burnProfile = async win => {
    burned++;
    return { count: WhimsyFireButton.burnTabs(win, [tab], "profile"), visits: 0, sites: 0, profile: "Default" };
  };
  try {
    const panel = await openFire();
    const session = panel.querySelector('[whimsy-fire-scope="profile"]');
    await TestUtils.waitForCondition(() => document.activeElement == session, "Focus starts on the chosen card");
    is(session.getAttribute("role"), "radio", "Cards are radios");
    is(session.getAttribute("aria-checked"), "true", "The profile starts chosen");
    const forget = panel.querySelector("#whimsy-fire-forget");
    ok(forget.hasAttribute("destructive"), "The action is the red footer button");
    is(document.l10n.getAttributes(forget).id, "whimsy-fire-run-profile", "It names the choice");

    EventUtils.synthesizeKey("KEY_Enter", {}, window);
    is(panel.state, "open", "Return on a card keeps it open");
    is(burned, 0, "...and clears nothing");

    EventUtils.synthesizeKey("KEY_End", {}, window);
    const everything = panel.querySelector('[whimsy-fire-scope="everything"]');
    is(everything.getAttribute("aria-checked"), "true", "Arrow keys move the choice");
    is(session.getAttribute("aria-checked"), "false", "...off the first");
    is(document.activeElement, everything, "...and focus");
    is(document.l10n.getAttributes(forget).id, "whimsy-fire-run-everything", "The button follows the choice");

    session.click();
    const hidden = BrowserTestUtils.waitForEvent(panel, "popuphidden");
    const toastShown = TestUtils.waitForCondition(() => toastFor("whimsy-fire-done-profile-title"),
      "A toast says what closed and what was cleared");
    forget.doCommand();
    await hidden;
    await TestUtils.waitForCondition(() => !tab.isConnected, "The space's tabs close");
    is(burned, 1, "It ran once");
    await toastShown;
    const detail = toastFor("whimsy-fire-done-profile-title").element.querySelector(".description");
    is(document.l10n.getAttributes(detail).id, "whimsy-fire-done-profile-detail", "with a second line");
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
  // wave8/isolation: a tab in another profile's space is in that profile's
  // container (the guard puts any other back).
  const elsewhereTab = BrowserTestUtils.addTab(gBrowser, "about:blank", { userContextId: other });
  await TestUtils.waitForCondition(() => elsewhereTab.getAttribute("zen-workspace-id") == elsewhere.uuid,
    "The other profile's tab is in its space");

  const MINE_URL = "https://example.com/?fire-mine";
  const NET_URL = "https://example.net/?fire-other-profile";
  // Earlier tests may have visited example.net in this profile within the
  // hour, which rightly makes it a site this profile touched; start clean.
  await PlacesUtils.history.removeByFilter({ host: "example.net" });
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
  is(WhimsyFireButton.forgetFlags,
    C.CLEAR_HISTORY | C.CLEAR_COOKIES_AND_SITE_DATA | C.CLEAR_ALL_CACHES | C.CLEAR_DOWNLOADS,
    "History, cookies, site data, cache and the download list");
  is(WhimsyFireButton.siteFlags, C.CLEAR_COOKIES_AND_SITE_DATA | C.CLEAR_ALL_CACHES,
    "Fire in This Profile clears a site's cookies, site data and cache");
});

// W10-30: "Everything" can't be undone, so it asks once more inside the
// same surface (no system dialog): Back is the default and has focus; Esc
// is Back; only the red Fire Everywhere runs it, and the toast says what
// went. burnEverything is stubbed so the shared test profile isn't wiped.
add_task(async function test_fire_everything_second_step() {
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.com/?fire-everything");
  const original = WhimsyFireButton.burnEverything;
  let burned = 0;
  WhimsyFireButton.burnEverything = async () => {
    burned++;
    return 0;
  };
  try {
    const panel = await openFire({ choice: "everything" });
    is(panel.dataset.scope, "everything", "Everything is chosen");
    panel.querySelector("#whimsy-fire-forget").doCommand();
    is(panel.dataset.step, "confirm", "The red button goes to the second step");
    is(panel.state, "open", "...in the same surface");
    const back = panel.querySelector("#whimsy-fire-back");
    await TestUtils.waitForCondition(() => document.activeElement == back, "Back has focus");
    is(back.getAttribute("default"), "true", "Back is the default");
    ok(panel.querySelector("#whimsy-fire-confirm-title").textContent.includes("everything"), "It asks again");
    EventUtils.synthesizeKey("KEY_Escape", {}, window);
    is(panel.dataset.step, "choose", "Esc goes back");
    is(panel.state, "open", "...without closing");
    is(panel.dataset.scope, "everything", "...with Everywhere still chosen");
    is(burned, 0, "Nothing ran");

    panel.querySelector("#whimsy-fire-forget").doCommand();
    back.doCommand();
    is(panel.dataset.step, "choose", "Back goes back");
    panel.querySelector("#whimsy-fire-forget").doCommand();
    const toastShown = TestUtils.waitForCondition(() => toastFor("whimsy-fire-done-everything-title"),
      "A toast says everything was erased");
    panel.querySelector("#whimsy-fire-everything-accept").doCommand();
    await toastShown;
    is(burned, 1, "Fire Everywhere runs once confirmed");
  } finally {
    WhimsyFireButton.burnEverything = original;
    BrowserTestUtils.removeTab(tab);
  }
});

// The Fire Everywhere command opens straight on the second step.
add_task(async function test_fire_everywhere_command_confirms_in_the_surface() {
  const { WhimsyCommands } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyCommands.sys.mjs");
  const shown = BrowserTestUtils.waitForEvent(document, "popupshown", true, e => e.target.id == "whimsyFirePanel");
  ok(WhimsyCommands.get("cmd_whimsyFireEverywhere"), "Fire Everywhere is a command");
  // Run it the way the command bar and its shortcut do: its <command>.
  document.getElementById("cmd_whimsyFireEverywhere").doCommand();
  await shown;
  const panel = document.getElementById("whimsyFirePanel");
  is(panel.dataset.step, "confirm", "It asks first");
  await closeFire(panel);
});

// wave7/ux: Fire in This Profile doesn't ask again; the surface's explicit
// button (which names it) is enough.
add_task(async function test_fire_profile_does_not_confirm() {
  const originalProfile = WhimsyFireButton.burnProfile;
  let burned = 0;
  WhimsyFireButton.burnProfile = async () => (burned++, 0);
  try {
    const panel = await openFire();
    await WhimsyFireButton.forget(window, panel);
    is(burned, 1, "Fire in This Profile runs without a second step");
  } finally {
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
    clearData: async () => {}, clearFormHistory: async () => {} };
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
    // Gecko 159 throws on an empty closed-tab list instead of returning null.
    const restored = SessionStore.getClosedTabCountForWindow(window) ? SessionStore.undoCloseTab(window, 0) : null;
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

// Coordinator: Fire Everywhere covers what Clear All History does, form and
// search history included, after the tabs close; saved passwords stay, and
// the note says so. Real form history (a test entry); the rest is stubbed.
add_task(async function test_fire_everywhere_clears_form_history_not_passwords() {
  const { FormHistory } = ChromeUtils.importESModule("resource://gre/modules/FormHistory.sys.mjs");
  // Zen ships form fill off, and FormHistory then refuses adds; turn it on
  // just to seed an entry (Fire's removal works either way).
  await SpecialPowers.pushPrefEnv({ set: [["browser.formfill.enable", true]] });
  await FormHistory.update({ op: "add", fieldname: "whimsy-fire-test", value: "burn me" });
  await SpecialPowers.popPrefEnv();
  is(await FormHistory.count({ fieldname: "whimsy-fire-test" }), 1, "A form entry exists");
  const login = await Services.logins.addLoginAsync(new Components.Constructor(
    "@mozilla.org/login-manager/loginInfo;1", Ci.nsILoginInfo, "init")(
    "https://example.com", "https://example.com", null, "fire-user", "fire-pass", "u", "p"));
  const order = [];
  const originals = { allTabs: WhimsyFireButton.allTabs, purgeClosed: WhimsyFireButton.purgeClosed,
    clearData: WhimsyFireButton.clearData };
  WhimsyFireButton.allTabs = () => [];
  WhimsyFireButton.purgeClosed = async () => order.push("purge");
  WhimsyFireButton.clearData = async () => order.push("clear");
  try {
    await WhimsyFireButton.burnEverything(window);
    is(await FormHistory.count({ fieldname: "whimsy-fire-test" }), 0, "Form and search history went");
    Assert.deepEqual(order, ["purge", "clear"], "Closed tabs are forgotten before data clears");
    ok((await Services.logins.searchLoginsAsync({ origin: "https://example.com" }))
      .some(l => l.username == "fire-user"), "Saved passwords stay");
    const [note, kept] = await document.l10n.formatValues([
      { id: "whimsy-fire-choice-everything-detail", args: { count: 0 } }, "whimsy-fire-kept"]);
    ok(note.includes("form and search history") && kept.includes("saved passwords, bookmarks"),
      "The card says form history goes and passwords and bookmarks stay");
  } finally {
    Object.assign(WhimsyFireButton, originals);
    await Services.logins.removeLoginAsync(login);
    await FormHistory.update({ op: "remove", fieldname: "whimsy-fire-test" });
  }
});

// Coordinator: Fire Everywhere clears the download list (its flags carry
// CLEAR_DOWNLOADS), and the downloaded file stays on disk; the note says so.
// Only the downloads flag runs here, so the shared profile keeps the rest.
add_task(async function test_fire_everywhere_clears_download_list_keeps_files() {
  const { Downloads } = ChromeUtils.importESModule("resource://gre/modules/Downloads.sys.mjs");
  ok(WhimsyFireButton.forgetFlags & Ci.nsIClearDataService.CLEAR_DOWNLOADS, "Fire Everywhere includes the download list");
  const target = PathUtils.join(PathUtils.tempDir, "whimsy-fire-download.txt");
  await IOUtils.writeUTF8(target, "kept");
  const list = await Downloads.getList(Downloads.ALL);
  const download = await Downloads.createDownload({ source: "https://example.com/whimsy-fire-download.txt", target });
  download.succeeded = true;
  download.stopped = true;
  await list.add(download);
  ok((await list.getAll()).includes(download), "The download is listed");
  try {
    await new Promise(resolve => Services.clearData.deleteData(
      WhimsyFireButton.forgetFlags & Ci.nsIClearDataService.CLEAR_DOWNLOADS, { onDataDeleted: resolve }));
    await TestUtils.waitForCondition(async () => !(await list.getAll()).includes(download), "The list forgets it");
    ok(await IOUtils.exists(target), "The downloaded file stays on disk");
    const [note, kept] = await document.l10n.formatValues([
      { id: "whimsy-fire-choice-everything-detail", args: { count: 0 } }, "whimsy-fire-kept"]);
    ok(note.includes("download list") && kept.includes("downloaded files"),
      "The card says the list goes and the files stay");
  } finally {
    if ((await list.getAll()).includes(download)) {
      await list.remove(download);
    }
    await IOUtils.remove(target, { ignoreAbsent: true });
  }
});

// W10-58: "Press Fire: no confirmation toast". Clearing a busy profile
// takes seconds (10s for 60 tabs / 21 sites in a real build), and the only
// toast came after it, for Zen's 2 seconds. Now "Clearing…" shows at once
// and (W10-30) the same toast turns into the result, with a title and a
// second line, and stays. A failure offers Try Again.
add_task(async function test_w10_58_fire_confirms_at_once() {
  let finish;
  const slowBurn = () => new Promise(resolve => (finish = resolve));
  const running = WhimsyFireButton.run(window, slowBurn, "profile");
  const working = currentToast();
  ok(working, "A toast shows as soon as Fire runs, before clearing is done");
  is(working.messageId, "whimsy-fire-working-profile", "It says it's clearing");
  finish({ count: 2, visits: 3, sites: 1, profile: "Default" });
  await running;
  const done = currentToast();
  is(done, working, "The result takes its place, without a second entrance");
  const message = done.element.querySelector("label");
  is(document.l10n.getAttributes(message).id, "whimsy-fire-done-profile-title", "and says what went");
  const detail = done.element.querySelector(".description");
  Assert.deepEqual(
    document.l10n.getAttributes(detail),
    { id: "whimsy-fire-done-profile-detail", args: { count: 2, visits: 3, sites: 1, profile: "Default" } },
    "with the counts on the second line"
  );
  await TestUtils.waitForCondition(() => detail.textContent.includes("2 tabs") && detail.textContent.includes("3 visits"),
    "The text renders");
  await new Promise(resolve => setTimeout(resolve, 2500));
  ok(!done.closing && !done.closed, "and is still there after Zen's 2 seconds");
  done.close({ instant: true });

  // A failure says so too, replacing "Clearing…", with Try Again.
  let attempts = 0;
  const failing = WhimsyFireButton.run(window, async () => {
    attempts++;
    throw new Error("test");
  }, "site", { site: "example.com" });
  is(currentToast().messageId, "whimsy-fire-working-site", "Forgetting a site says so at once");
  await failing;
  const failed = currentToast();
  is(failed.messageId, "whimsy-fire-failed-title", "and a failure replaces it");
  const retry = failed.element.querySelector(".whimsy-toast-button");
  is(document.l10n.getAttributes(retry.querySelector(".whimsy-toast-button-label")).id, "whimsy-fire-retry", "with Try Again");
  retry.click();
  await TestUtils.waitForCondition(() => attempts == 2, "Try Again runs it again");
  await TestUtils.waitForCondition(() => currentToast()?.messageId == "whimsy-fire-failed-title");
  closeToasts();
});

// W10-58: the tabs close before the (slow) history lookup, so the window
// answers the button right away. Everything is stubbed: a real burn would
// close every unpinned tab of the test profile.
add_task(async function test_w10_58_tabs_close_before_history_lookup() {
  const order = [];
  const names = ["burnTabs", "profileVisits", "purgeClosed", "clearSiteData"];
  const originals = Object.fromEntries(names.map(name => [name, WhimsyFireButton[name]]));
  WhimsyFireButton.burnTabs = () => (order.push("burnTabs"), 1);
  WhimsyFireButton.profileVisits = async () => (order.push("profileVisits"), []);
  WhimsyFireButton.purgeClosed = async () => {};
  WhimsyFireButton.clearSiteData = async () => {};
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.com/");
  try {
    await WhimsyFireButton.burnProfile(window);
    Assert.deepEqual(order.slice(0, 2), ["burnTabs", "profileVisits"],
      "Tabs close first, then history is looked up");
  } finally {
    Object.assign(WhimsyFireButton, originals);
    BrowserTestUtils.removeTab(tab);
  }
});
