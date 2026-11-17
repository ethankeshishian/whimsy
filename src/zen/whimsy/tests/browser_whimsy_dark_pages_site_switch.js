/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

Services.scriptloader.loadSubScript(getRootDirectory(gTestPath) + "head_whimsy_dark_pages.js", this);

add_setup(async function () {
  // Exercise the fade in both normal and private windows on every host.
  await SpecialPowers.pushPrefEnv({ set: [["ui.prefersReducedMotion", 0]] });
  const { WhimsySettingsCommands } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsySettingsCommands.sys.mjs");
  const entry = WhimsySettingsCommands.forSetting("whimsyDarkPagesMode");
  is(WhimsySettingsCommands.nameOf(entry), "Adaptive Dark Mode", "The command-bar feature name is unified");
  for (const spec of WhimsySettingsCommands.specsFor(entry)) {
    is(spec.l10nArgs().name, "Adaptive Dark Mode", "Every command choice uses the same feature name");
  }
});

const WORK = 2;
const panel = () => document.getElementById("zen-unified-site-data-panel");
const profileSection = () => document.getElementById("whimsy-site-settings-profile-section");
const siteSection = () => document.getElementById("whimsy-site-settings-section");

async function openPanel() {
  await WhimsySiteSettings.hidePanel(window);
  gNavToolbox.setAttribute("zen-has-implicit-hover", "true");
  const shown = BrowserTestUtils.waitForPopupEvent(panel(), "shown");
  WhimsySiteSettings.open(window);
  await shown;
  await document.l10n.translateFragment(panel());
  await Promise.all(panel().getAnimations({ subtree: true }).map(animation => animation.finished.catch(() => {})));
}

async function closePanel() {
  await WhimsySiteSettings.hidePanel(window);
  gNavToolbox.removeAttribute("zen-has-implicit-hover");
}

function clearSite() {
  Services.prefs.clearUserPref("whimsy.dark-pages.profiles");
  Services.prefs.setStringPref(SITES, "{}");
}

async function assertSiteDetail(win, browser, row, profileDark) {
  const doc = win.document;
  const { WhimsyProfiles } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyProfiles.sys.mjs");
  const profile = WhimsyProfiles.nameOf(WhimsyDarkPages.userContextIdOf(browser));
  const stored = WhimsyDarkPages.storedChoice(browser);
  const dark = WhimsyDarkPages.isDark(browser);
  await doc.l10n.translateFragment(row);
  const status = row.querySelector("#whimsy-dark-page-site-status");
  const reset = row.querySelector("#whimsy-dark-page-site-reset");
  const text = status.textContent.replace(/[\u2066-\u2069]/g, "").replace(/\s+/g, " ").trim();
  is(text, stored ? `${dark ? "On" : "Off"} here, ${profileDark ? "on" : "off"} in ${profile} ·` : `Same as ${profile}`,
    "The sub-line explains the site's relationship to its named profile");
  is(reset.hidden, !stored, "Reset appears only for a remembered exception");
  is(row.querySelector("input").getAttribute("aria-describedby"), status.id,
    "The switch exposes the relationship to assistive technology");
  is(doc.getElementById("whimsy-dark-page-site-label").textContent, "Adaptive Dark Mode", "Unified site label");
  return reset;
}

async function clickSettled(win, node) {
  await Promise.all(node.closest("[whimsy-site-setting]").getAnimations({ subtree: true })
    .map(animation => animation.finished.catch(() => {})));
  ok(node.checkVisibility(), "The control is visible before the click");
  EventUtils.synthesizeMouseAtCenter(node, {}, win);
}

const HOME_SPACE = gZenWorkspaces.activeWorkspace;
let workSpace;
async function openTab(url, userContextId) {
  workSpace ??= (await gZenWorkspaces.createAndSaveWorkspace("Dark switch", undefined, true, WORK)).uuid;
  if (gZenWorkspaces.activeWorkspace != workSpace) {
    await gZenWorkspaces.changeWorkspaceWithID(workSpace);
  }
  const tab = BrowserTestUtils.addTab(gBrowser, url, { userContextId });
  gBrowser.selectedTab = tab;
  await TestUtils.waitForCondition(() => tab.linkedBrowser.currentURI.spec == url &&
    !tab.linkedBrowser.webProgress.isLoadingDocument, `Loaded ${url}`);
  is(tab.linkedBrowser.browsingContext.originAttributes.userContextId, userContextId,
    "The test page opens in Work");
  return tab;
}

// Include the fade and a painted pixel in the deadline: the state attribute
// alone changes inside the update callback even when rendering is suppressed.
async function switchReachesPage(browser, dark, change) {
  const start = ChromeUtils.now();
  change();
  await darkState(browser, dark ? "generated" : "original");
  const painted = await colors(browser);
  is(Math.max(...painted.paintedBackground.slice(0, 3)) < 100, dark,
    "The new state is painted behind the open popup");
  const elapsed = ChromeUtils.now() - start;
  info(`Dark switch ${dark ? "on" : "off"}: ${elapsed.toFixed(0)}ms through paint`);
  Assert.less(elapsed, 2000, "The page reaches the new state within 2s of the click/change");
}

registerCleanupFunction(async () => {
  await closePanel();
  clearSite();
  if (gZenWorkspaces.activeWorkspace != HOME_SPACE) {
    await gZenWorkspaces.changeWorkspaceWithID(HOME_SPACE);
  }
  if (workSpace) {
    for (const tab of gZenWorkspaces.allStoredTabs.filter(t => t.getAttribute("zen-workspace-id") == workSpace &&
      !t.hasAttribute("zen-essential") && !t.hasAttribute("zen-empty-tab"))) {
      BrowserTestUtils.removeTab(tab);
    }
    await gZenWorkspaces.removeWorkspace(workSpace);
  }
});

// Owner regression: use the actual panel control, keep the same document and
// row across both flips, and exercise both directions of profile/global drift.
add_task(async function test_site_dark_switch_updates_live_without_replacing_rows() {
  await whimsySetScheme(true);
  try {
    for (const [mode, profileOn] of [["off", false], ["always", true], ["always", false], ["off", true]]) {
      clearSite();
      await SpecialPowers.pushPrefEnv({ set: [[MODE, mode]] });
      WhimsyDarkPages.setProfileOn(WORK, profileOn);
      const tab = await openTab(PAGE, WORK);
      const browser = tab.linkedBrowser;
      try {
        await darkState(browser, profileOn ? "generated" : "original");
        const windowId = browser.innerWindowID;
        const originalScheme = await SpecialPowers.spawn(browser, [], () =>
          content.windowGlobalChild.getActor("WhimsyDarkPages")._originalScheme);
        await openPanel();
        const row = siteSection().querySelector('[whimsy-site-setting="dark-pages"]');
        const toggle = row.querySelector("input");
        const profileRow = profileSection().querySelector('[whimsy-site-setting="profile-dark-pages"]');
        await assertSiteDetail(window, browser, row, profileOn);
        is(document.getElementById("whimsy-site-settings-profile-dark-label").textContent,
          "Adaptive Dark Mode", "Unified profile label");
        // Always exercise on then off, even when the profile starts dark.
        if (toggle.checked) {
          await switchReachesPage(browser, false, () => EventUtils.synthesizeMouseAtCenter(toggle, {}));
        }
        for (const dark of [true, false, true, false]) {
          ok(toggle.checkVisibility(), "The original switch remains clickable");
          await switchReachesPage(browser, dark, () => EventUtils.synthesizeMouseAtCenter(toggle, {}));
          is(await SpecialPowers.spawn(browser, [], () => content.browsingContext.prefersColorSchemeOverride),
            dark ? "dark" : originalScheme, "The open page's color scheme follows the switch");
          is(browser.innerWindowID, windowId, "The document was not reloaded");
          is(panel().state, "open", "The panel stays open");
          is(siteSection().querySelector('[whimsy-site-setting="dark-pages"]'), row,
            "The same site row survives the flip and the child's report");
          is(document.getElementById("whimsy-site-settings-dark-pages-switch"), toggle,
            "The switch is not replaced under the pointer");
          is(profileSection().querySelector('[whimsy-site-setting="profile-dark-pages"]'), profileRow,
            "Profile controls are not rebuilt");
          is(toggle.checked, dark, "The switch agrees with the page");
          is(WhimsyDarkPages.storedChoice(browser), dark == profileOn ? null : dark ? "on" : "off",
            "Matching the profile clears the exception; differing remembers it");
          await assertSiteDetail(window, browser, row, profileOn);
          is(row.getAttribute("state"), WhimsyDarkPages.storedChoice(browser) ? "allow" : "block",
            "The row's remembered marker follows the stored choice");
        }
        // Reset clears the exception without rebuilding the row, by mouse
        // and keyboard. Await the real fade before interacting again.
        for (const keyboard of [false, true]) {
          WhimsyDarkPages.setDark(browser, !profileOn);
          await darkState(browser, profileOn ? "original" : "generated");
          const reset = await assertSiteDetail(window, browser, row, profileOn);
          if (keyboard) {
            reset.focus();
            EventUtils.synthesizeKey("KEY_Enter", {}, window);
          } else {
            await clickSettled(window, reset);
          }
          await darkState(browser, profileOn ? "generated" : "original");
          is(WhimsyDarkPages.storedChoice(browser), null, "Reset removes the stored choice");
          await assertSiteDetail(window, browser, row, profileOn);
          is(document.getElementById(toggle.id), toggle, "Reset keeps the original switch");
        }
        // Unoverridden sites follow profile flips immediately in this popup.
        for (const on of [!profileOn, profileOn]) {
          WhimsyDarkPages.setProfileOn(WORK, on);
          await darkState(browser, on ? "generated" : "original");
          is(toggle.checked, on, "The site switch follows the profile change");
          is(WhimsyDarkPages.storedChoice(browser), null, "Following the profile stores no exception");
          await assertSiteDetail(window, browser, row, on);
          is(document.getElementById(toggle.id), toggle, "Profile changes preserve the site control");
          is(profileSection().querySelector('[whimsy-site-setting="profile-dark-pages"]'), profileRow,
            "Profile changes preserve the profile row");
          is(browser.innerWindowID, windowId, "Profile changes do not reload the page");
          is(panel().state, "open", "The popup remains open during profile changes");
        }
        // A change from another control/window must also preserve this row.
        for (const dark of [true, false]) {
          await switchReachesPage(browser, dark, () => WhimsyDarkPages.setDark(browser, dark));
          is(document.getElementById(toggle.id), toggle, "External changes update the existing switch");
          is(toggle.checked, dark, "The existing switch follows external changes");
          is(panel().state, "open", "External changes leave the panel open");
        }
      } finally {
        await closePanel();
        await BrowserTestUtils.removeTab(tab);
        clearSite();
        await SpecialPowers.popPrefEnv();
      }
    }
  } finally {
    await SpecialPowers.popPrefEnv();
  }
});

add_task(async function test_private_site_dark_switch_updates_live_without_rebuilding() {
  clearSite();
  await SpecialPowers.pushPrefEnv({ set: [[MODE, "off"]] });
  const win = await BrowserTestUtils.openNewBrowserWindow({ private: true });
  const saved = Services.prefs.getStringPref(SITES);
  try {
    await BrowserTestUtils.withNewTab({ gBrowser: win.gBrowser, url: PAGE }, async browser => {
      await darkState(browser, "original");
      const windowId = browser.innerWindowID;
      const originalScheme = await SpecialPowers.spawn(browser, [], () => content.browsingContext.prefersColorSchemeOverride);
      const popup = win.document.getElementById("zen-unified-site-data-panel");
      win.gNavToolbox.setAttribute("zen-has-implicit-hover", "true");
      const shown = BrowserTestUtils.waitForPopupEvent(popup, "shown");
      WhimsySiteSettings.open(win);
      await shown;
      await win.document.l10n.translateFragment(popup);
      await Promise.all(popup.getAnimations({ subtree: true }).map(animation => animation.finished.catch(() => {})));
      const toggle = win.document.getElementById("whimsy-site-settings-dark-pages-switch");
      const row = toggle.closest("[whimsy-site-setting]");
      for (const dark of [true, false, true, false]) {
        ok(toggle.checkVisibility(), "The private switch remains visible");
        await switchReachesPage(browser, dark, () => EventUtils.synthesizeMouseAtCenter(toggle, {}, win));
        is(await SpecialPowers.spawn(browser, [], () => content.browsingContext.prefersColorSchemeOverride),
          dark ? "dark" : originalScheme, "The private page's scheme changes live");
        is(win.document.getElementById(toggle.id), toggle, "The private switch is the same node");
        is(toggle.closest("[whimsy-site-setting]"), row, "The private row is the same node");
        is(row.getAttribute("state"), dark ? "allow" : "block", "The private remembered marker updates");
        is(toggle.checked, dark, "The private switch agrees with the page");
        is(popup.state, "open", "The private panel stays open");
        is(browser.innerWindowID, windowId, "The private page is not reloaded");
        is(Services.prefs.getStringPref(SITES), saved, "Private choices never write public preferences");
      }
      WhimsyDarkPages.setDark(browser, true);
      await darkState(browser, "generated");
      const reset = await assertSiteDetail(win, browser, row, false);
      await clickSettled(win, reset);
      await darkState(browser, "original");
      is(WhimsyDarkPages.storedChoice(browser), null, "Private Reset forgets the in-memory exception");
      await assertSiteDetail(win, browser, row, false);
      is(win.document.getElementById(toggle.id), toggle, "Private Reset keeps the switch");
      is(Services.prefs.getStringPref(SITES), saved, "Private Reset never writes public preferences");
      await WhimsySiteSettings.hidePanel(win);
    });
  } finally {
    await BrowserTestUtils.closeWindow(win);
    await SpecialPowers.popPrefEnv();
    clearSite();
  }
});

