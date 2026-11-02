/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// W11-07: Settings → Home and startup, as in Zen, with Whimsy's home.
//
// - New windows and New tabs each offer Whimsy Home (the default) and
//   Firefox Home. New windows said "Custom URLs…" for Whimsy's own default
//   (about:whimsy) and Firefox Home (about:home) wasn't a choice any more.
// - New tabs follow the choice (AboutNewTab.newTabURL); an add-on that
//   replaces the new tab page wins; private windows keep their own page.
// - The "Firefox Home" group (Search, Widgets, Shortcuts, Stories, ...) is
//   there, also when Settings loaded before the new tab add-on listened.
// - One control: Look's "Use the Whimsy homepage" is gone, an old "off" is
//   migrated, and each choice is a command with an assignable shortcut.

const { AboutNewTab } = ChromeUtils.importESModule("resource:///modules/AboutNewTab.sys.mjs");
const { WhimsyHome } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyHome.sys.mjs");
const { WhimsySettingsCommands } = ChromeUtils.importESModule(
  "resource:///modules/whimsy/WhimsySettingsCommands.sys.mjs"
);
const { SessionStore } = ChromeUtils.importESModule("resource:///modules/sessionstore/SessionStore.sys.mjs");
const { TabStateFlusher } = ChromeUtils.importESModule("resource:///modules/sessionstore/TabStateFlusher.sys.mjs");

const HOMEPAGE_PREF = "browser.startup.homepage";
const NEWTAB_PAGE_PREF = "whimsy.newtab.page";
const NEWTAB_ENABLED_PREF = "browser.newtabpage.enabled";
const EXTENSION_PREF = "browser.newtab.extensionControlled";
const FEATURE_PREF = "whimsy.feature.home";

add_setup(async function () {
  await SpecialPowers.pushPrefEnv({
    set: [
      ["identity.fxaccounts.account.device.name", ""],
      [FEATURE_PREF, true],
    ],
  });
  registerCleanupFunction(() => {
    for (const pref of [HOMEPAGE_PREF, NEWTAB_PAGE_PREF, NEWTAB_ENABLED_PREF, EXTENSION_PREF]) {
      Services.prefs.clearUserPref(pref);
    }
  });
});

async function withHomeSettings(callback) {
  await BrowserTestUtils.withNewTab("about:preferences#home", async browser => {
    const win = browser.contentWindow;
    const doc = browser.contentDocument;
    await TestUtils.waitForCondition(
      () =>
        doc.getElementById("setting-control-homepageNewWindows")?.controlEl &&
        doc.getElementById("setting-control-homepageNewTabs")?.controlEl,
      "Home and startup's New windows and New tabs render"
    );
    await callback(win, doc);
  });
}

function select(doc, id) {
  return doc.getElementById(`setting-control-${id}`).controlEl;
}

async function optionLabels(doc, id) {
  const options = [...select(doc, id).querySelectorAll("moz-option")];
  await TestUtils.waitForCondition(() => options.every(o => o.label), `${id}'s choices are named`);
  return Object.fromEntries(options.map(o => [String(o.value), o.label]));
}

add_task(async function test_both_homes_are_choices() {
  Services.prefs.clearUserPref(HOMEPAGE_PREF);
  Services.prefs.clearUserPref(NEWTAB_PAGE_PREF);
  Services.prefs.clearUserPref(NEWTAB_ENABLED_PREF);
  await withHomeSettings(async (win, doc) => {
    const windows = await optionLabels(doc, "homepageNewWindows");
    is(windows.whimsy, "Whimsy Home (Default)", "New windows: Whimsy Home, the default");
    is(windows.home, "Firefox Home", "New windows: Firefox Home is a choice too");
    ok("blank" in windows && "custom" in windows, "Firefox's Blank Page and Custom URLs stay");
    const tabs = await optionLabels(doc, "homepageNewTabs");
    is(tabs.whimsy, "Whimsy Home (Default)", "New tabs: Whimsy Home, the default");
    is(tabs.home, "Firefox Home", "New tabs: Firefox Home");
    ok("blank" in tabs, "New tabs: Blank Page stays");

    // The default homepage is Whimsy Home, not "Custom URLs…" with a
    // "Choose a specific site" button (the bug).
    await TestUtils.waitForCondition(() => select(doc, "homepageNewWindows").value == "whimsy", "New windows shows Whimsy Home");
    const custom = doc.getElementById("setting-control-homepageGoToCustomHomepageUrlPanel");
    ok(!custom || !BrowserTestUtils.isVisible(custom), "No Choose a specific site for Whimsy Home");
    await TestUtils.waitForCondition(() => select(doc, "homepageNewTabs").value == "whimsy", "New tabs shows Whimsy Home");

    // about:home (Firefox's default, or synced from Firefox) is Firefox Home.
    Services.prefs.setStringPref(HOMEPAGE_PREF, "about:home");
    await TestUtils.waitForCondition(() => select(doc, "homepageNewWindows").value == "home", "about:home is Firefox Home");
    Services.prefs.setStringPref(HOMEPAGE_PREF, "https://example.com/");
    await TestUtils.waitForCondition(() => select(doc, "homepageNewWindows").value == "custom", "A site is Custom URLs");

    // Picking in Settings sets the prefs.
    win.Preferences.getSetting("homepageNewWindows").value = "whimsy";
    is(Services.prefs.getStringPref(HOMEPAGE_PREF), "about:whimsy", "Whimsy Home is about:whimsy");
    win.Preferences.getSetting("homepageNewTabs").value = "home";
    is(Services.prefs.getStringPref(NEWTAB_PAGE_PREF), "home", "New tabs: Firefox Home");
    ok(Services.prefs.getBoolPref(NEWTAB_ENABLED_PREF), "...and new tabs aren't blank");
    win.Preferences.getSetting("homepageNewTabs").value = "blank";
    ok(!Services.prefs.getBoolPref(NEWTAB_ENABLED_PREF), "Blank is Firefox's own pref");
    await TestUtils.waitForCondition(() => select(doc, "homepageNewTabs").value == "blank", "New tabs shows Blank Page");
    win.Preferences.getSetting("homepageNewTabs").value = "whimsy";
    ok(Services.prefs.getBoolPref(NEWTAB_ENABLED_PREF), "Whimsy Home turns new tab pages back on");
    is(Services.prefs.getStringPref(NEWTAB_PAGE_PREF), "whimsy", "New tabs: Whimsy Home");

    // Restore Defaults means Whimsy Home for both.
    Services.prefs.setStringPref(HOMEPAGE_PREF, "about:home");
    Services.prefs.setStringPref(NEWTAB_PAGE_PREF, "home");
    const restore = doc.getElementById("setting-control-homepageRestoreDefaults").controlEl;
    await TestUtils.waitForCondition(() => !restore.disabled, "Restore Defaults is offered");
    restore.click();
    await TestUtils.waitForCondition(
      () => Services.prefs.getStringPref(HOMEPAGE_PREF) == "about:whimsy" &&
        Services.prefs.getStringPref(NEWTAB_PAGE_PREF) == "whimsy",
      "Restore Defaults picks Whimsy Home for both"
    );
  });
  for (const pref of [HOMEPAGE_PREF, NEWTAB_PAGE_PREF, NEWTAB_ENABLED_PREF]) {
    Services.prefs.clearUserPref(pref);
  }
});

add_task(async function test_firefox_home_group() {
  await withHomeSettings(async (win, doc) => {
    const group = await TestUtils.waitForCondition(
      () => doc.querySelector('setting-pane[data-category="paneHome"] setting-group[groupid="home"]'),
      "The Firefox Home group is in Home and startup"
    );
    await TestUtils.waitForCondition(
      () => group.config && group.querySelector("moz-fieldset"),
      "The Firefox Home group renders its settings"
    );
    for (const id of ["webSearch", "shortcuts", "recentActivity"]) {
      ok(doc.getElementById(`setting-control-${id}`), `Firefox Home has ${id}`);
    }
    // With Whimsy Home for both, Firefox's own notice says how to use them.
    ok(doc.getElementById("setting-control-firefoxHomeDisabledNotice"), "Firefox's notice: set new tabs or windows to Firefox Home");
  });
});

// Settings loaded before the new tab add-on listened for "home-pane-loaded"
// (a Settings tab restored at startup): Whimsy sends it again once Activity
// Stream is up, so the group still comes.
add_task(async function test_firefox_home_group_after_a_missed_notice() {
  await AboutNewTab.activityStreamPromise;
  const feed = AboutNewTab.activityStream.store.feeds.get("feeds.aboutpreferences");
  ok(feed, "Firefox's new tab add-on has its Settings feed");
  const topics = ["home-pane-loaded", "customHomepage-pane-loaded"];
  let removed = true;
  for (const topic of topics) {
    Services.obs.removeObserver(feed, topic);
  }
  const restore = () => {
    if (removed) {
      removed = false;
      for (const topic of topics) {
        Services.obs.addObserver(feed, topic);
      }
    }
  };
  registerCleanupFunction(restore);

  await BrowserTestUtils.withNewTab("about:preferences#home", async browser => {
    const win = browser.contentWindow;
    const doc = browser.contentDocument;
    await TestUtils.waitForCondition(
      () => doc.querySelector('setting-pane[data-category="paneHome"]')?.initialized,
      "The Home pane is set up"
    );
    // Let Whimsy's first try (after Settings sets up every pane; nobody
    // listening yet) run and settle.
    await win.gSearchResultsPane.initializeCategories();
    await TestUtils.waitForCondition(() => !win.gWhimsySettings._firefoxHomeWait, "Whimsy's first check is done");
    ok(!win.SettingGroupManager.has("home"), "The notice was missed: no Firefox Home group yet");

    // The add-on starts listening; the person comes back to Home.
    restore();
    await win.gotoPref("paneSearch");
    await win.gotoPref("paneHome");
    const pane = doc.querySelector('setting-pane[data-category="paneHome"]');
    await TestUtils.waitForCondition(() => win.SettingGroupManager.has("home"), "Whimsy sent the notice again");
    const group = pane.querySelector('setting-group[groupid="home"]');
    await TestUtils.waitForCondition(
      () => group?.config && group.querySelector("moz-fieldset"),
      "The Firefox Home group renders"
    );
  });
});

add_task(async function test_new_tabs_follow_the_choice() {
  Services.prefs.clearUserPref(NEWTAB_PAGE_PREF);
  Services.prefs.clearUserPref(NEWTAB_ENABLED_PREF);
  await TestUtils.waitForCondition(() => AboutNewTab.newTabURL == "about:whimsy", "New tabs open Whimsy Home");
  is(window.BROWSER_NEW_TAB_URL, "about:whimsy", "BROWSER_NEW_TAB_URL is Whimsy Home");

  Services.prefs.setStringPref(NEWTAB_PAGE_PREF, "home");
  is(AboutNewTab.newTabURL, "about:newtab", "Firefox Home: Firefox's new tab page");
  ok(!AboutNewTab.newTabURLOverridden, "...not overridden");

  Services.prefs.clearUserPref(NEWTAB_PAGE_PREF);
  is(AboutNewTab.newTabURL, "about:whimsy", "Back to Whimsy Home");
  Services.prefs.setBoolPref(NEWTAB_ENABLED_PREF, false);
  is(AboutNewTab.newTabURL, "about:newtab", "Blank Page is Firefox's (about:newtab shows a blank page)");
  Services.prefs.clearUserPref(NEWTAB_ENABLED_PREF);
  is(AboutNewTab.newTabURL, "about:whimsy", "Whimsy Home again");

  // An add-on that replaces the new tab page wins, and Whimsy Home comes
  // back when it lets go (ext-url-overrides does these two steps).
  const addonPage = "moz-extension://" + "whimsy-test/newtab.html";
  Services.prefs.setBoolPref(EXTENSION_PREF, true);
  AboutNewTab.newTabURL = addonPage;
  is(AboutNewTab.newTabURL, addonPage, "The add-on's page");
  Services.prefs.setStringPref(NEWTAB_PAGE_PREF, "whimsy");
  is(AboutNewTab.newTabURL, addonPage, "Whimsy doesn't take it back while the add-on has it");
  AboutNewTab.resetNewTabURL();
  Services.prefs.clearUserPref(EXTENSION_PREF);
  is(AboutNewTab.newTabURL, "about:whimsy", "Whimsy Home once the add-on lets go");
  Services.prefs.clearUserPref(NEWTAB_PAGE_PREF);

  // Private windows keep the private browsing page.
  const privateWin = await BrowserTestUtils.openNewBrowserWindow({ private: true });
  is(privateWin.BROWSER_NEW_TAB_URL, "about:privatebrowsing", "A private window's new tab is still private browsing");
  await BrowserTestUtils.closeWindow(privateWin);
});

add_task(async function test_a_closed_whimsy_home_tab_is_like_a_closed_new_tab() {
  const before = SessionStore.getClosedTabCountForWindow(window);
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, "about:whimsy");
  await TabStateFlusher.flush(tab.linkedBrowser);
  BrowserTestUtils.removeTab(tab);
  is(
    SessionStore.getClosedTabCountForWindow(window),
    before,
    "An untouched Whimsy Home tab isn't kept in Recently Closed (as about:newtab and about:home aren't)"
  );
});

add_task(async function test_old_switch_off_is_migrated() {
  Services.prefs.clearUserPref(HOMEPAGE_PREF);
  Services.prefs.clearUserPref(NEWTAB_PAGE_PREF);
  Services.prefs.setBoolPref(FEATURE_PREF, false);
  WhimsyHome.migrate();
  is(Services.prefs.getStringPref(HOMEPAGE_PREF), "about:home", "Off meant Firefox Home in new windows");
  is(Services.prefs.getStringPref(NEWTAB_PAGE_PREF), "home", "...and in new tabs");
  ok(!Services.prefs.prefHasUserValue(FEATURE_PREF), "The old switch goes back to its default");
  ok(Services.prefs.getBoolPref(FEATURE_PREF), "...on");
  WhimsyHome.migrate();
  is(Services.prefs.getStringPref(HOMEPAGE_PREF), "about:home", "Migrating twice changes nothing");

  // A custom homepage stays.
  Services.prefs.setStringPref(HOMEPAGE_PREF, "https://example.com/");
  Services.prefs.setBoolPref(FEATURE_PREF, false);
  WhimsyHome.migrate();
  is(Services.prefs.getStringPref(HOMEPAGE_PREF), "https://example.com/", "A custom homepage is kept");
  Services.prefs.clearUserPref(HOMEPAGE_PREF);
  Services.prefs.clearUserPref(NEWTAB_PAGE_PREF);
  Services.prefs.setBoolPref(FEATURE_PREF, true);
});

add_task(async function test_one_control_and_its_commands() {
  ok(!WhimsySettingsCommands.SETTINGS.some(e => e.setting == "whimsyHomeEnabled"), "No second homepage switch");
  await BrowserTestUtils.withNewTab("about:preferences#zenLooks", async browser => {
    const doc = browser.contentDocument;
    await TestUtils.waitForCondition(() => doc.getElementById("whimsyLookGroup"), "Look renders");
    ok(!doc.getElementById("whimsyHomeEnabled"), "Look has no Use the Whimsy homepage");
  });

  Services.prefs.clearUserPref(HOMEPAGE_PREF);
  Services.prefs.clearUserPref(NEWTAB_PAGE_PREF);
  const ids = {
    windowsFirefox: "cmd_whimsySetting-new-windows-home",
    windowsWhimsy: "cmd_whimsySetting-new-windows-whimsy",
    tabsFirefox: "cmd_whimsySetting-new-tabs-home",
    tabsBlank: "cmd_whimsySetting-new-tabs-blank",
    tabsWhimsy: "cmd_whimsySetting-new-tabs-whimsy",
  };
  for (const id of Object.values(ids)) {
    ok(document.getElementById(id), `${id} is a command`);
  }
  const { globalActions } = ChromeUtils.importESModule("resource:///modules/ZenUBGlobalActions.sys.mjs");
  const row = globalActions.find(a => a.whimsyCommand == ids.tabsFirefox);
  is(row?.label, "New Tab Page: Firefox Home", "The command bar names it");
  ok(row.isAvailable(window), "Offered while new tabs show Whimsy Home");

  document.getElementById(ids.windowsFirefox).doCommand();
  is(Services.prefs.getStringPref(HOMEPAGE_PREF), "about:home", "New windows: Firefox Home");
  document.getElementById(ids.windowsWhimsy).doCommand();
  is(Services.prefs.getStringPref(HOMEPAGE_PREF), "about:whimsy", "New windows: Whimsy Home");
  document.getElementById(ids.tabsFirefox).doCommand();
  is(AboutNewTab.newTabURL, "about:newtab", "New tabs: Firefox Home");
  ok(!row.isAvailable(window), "...and it isn't offered again");
  document.getElementById(ids.tabsBlank).doCommand();
  ok(!Services.prefs.getBoolPref(NEWTAB_ENABLED_PREF), "New tabs: Blank Page");
  document.getElementById(ids.tabsWhimsy).doCommand();
  ok(Services.prefs.getBoolPref(NEWTAB_ENABLED_PREF), "Whimsy Home turns new tab pages back on");
  is(AboutNewTab.newTabURL, "about:whimsy", "New tabs: Whimsy Home");

  for (const pref of [HOMEPAGE_PREF, NEWTAB_PAGE_PREF, NEWTAB_ENABLED_PREF]) {
    Services.prefs.clearUserPref(pref);
  }
});
