/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// W9-04: site settings ("This Site" in Zen's site panel). Covers the
// section and its fixed rows, Zen's Autoplay row stepping aside, the zoom
// stepper, the autoplay dropdown, Always Open in Reader View opening an
// article by itself (and not again after leaving Reader), Open in Full
// Screen (once per tab and site; off leaves the full screen it entered),
// Pretend to Be picked in place, Forget All with Undo, private tabs and
// profiles never sharing or persisting, the "Site Settings…" command and
// the feature switch. W10-16: WhimsySurface parts, no per-row ✕.

const { WhimsySiteSettings, PERM_TYPES, COMMAND_ID } = ChromeUtils.importESModule(
  "resource:///modules/whimsy/WhimsySiteSettings.sys.mjs"
);
const { WhimsyUserAgent } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyUserAgent.sys.mjs");
const { WhimsyUndo } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyUndo.sys.mjs");
const { WhimsyCommands } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyCommands.sys.mjs");
const { SitePermissions } = ChromeUtils.importESModule("resource:///modules/SitePermissions.sys.mjs");

const HOST = "example.com";
const PAGE = `https://${HOST}/`;
const ARTICLE_URL =
  getRootDirectory(gTestPath).replace("chrome://mochitests/content", `https://${HOST}`) + "whimsy_article.html";
const FEATURE_PREF = "whimsy.feature.site-settings";
const NORMAL = { userContextId: 0, privateBrowsingId: 0 };

function panel() {
  return document.getElementById("zen-unified-site-data-panel");
}

function section() {
  return document.getElementById("whimsy-site-settings-section");
}

function rowOf(kind) {
  return section()?.querySelector(`[whimsy-site-setting="${kind}"]`);
}

async function openPanel() {
  await closePanel();
  gNavToolbox.setAttribute("zen-has-implicit-hover", "true");
  ok(await WhimsySiteSettings.open(window), "Site Settings… opened the site panel");
  is(panel().state, "open", "Zen's site panel is open");
  // Fluent fills the rows after popupshowing.
  await document.l10n.translateFragment(section());
}

async function closePanel() {
  if (panel().state == "closed") {
    return;
  }
  const hidden = BrowserTestUtils.waitForPopupEvent(panel(), "hidden");
  panel().hidePopup(true);
  await hidden;
}

// The zoom Firefox has saved for the browser's page (FullZoom's content
// pref, read from the store). A + step saves asynchronously; a reload
// before the save lands restores the previous value, so tests that
// reload after a step wait on this first.
function savedZoom(browser) {
  const cps = Cc["@mozilla.org/content-pref/service;1"].getService(Ci.nsIContentPrefService2);
  return new Promise(resolve => {
    let value;
    cps.getByDomainAndName(browser.currentURI.spec, FullZoom.name, browser.loadContext, {
      handleResult(pref) {
        value = pref.value;
      },
      handleCompletion: () => resolve(value),
      handleError: () => resolve(undefined),
    });
  });
}

async function waitForSavedZoom(browser, zoom, msg) {
  await TestUtils.waitForCondition(async () => Math.abs(((await savedZoom(browser)) ?? 1) - zoom) < 0.01, msg);
}

function clearAll() {
  for (const oa of [NORMAL, { userContextId: 0, privateBrowsingId: 1 }, { userContextId: 2, privateBrowsingId: 0 }]) {
    const principal = WhimsySiteSettings.sitePrincipal(HOST, oa);
    for (const kind of Object.keys(PERM_TYPES)) {
      Services.perms.removeFromPrincipal(principal, WhimsySiteSettings.permType(kind, oa));
    }
    Services.perms.removeFromPrincipal(principal, "autoplay-media");
  }
  WhimsyUserAgent.clear(HOST);
  gNavToolbox.removeAttribute("zen-has-implicit-hover");
}

registerCleanupFunction(async () => {
  await closePanel();
  clearAll();
  Services.prefs.clearUserPref(FEATURE_PREF);
});

add_task(async function test_section_rows_and_command() {
  clearAll();
  const entry = WhimsyCommands.get(COMMAND_ID);
  ok(entry, "Site Settings… is a registered command");
  is(entry.l10nId, "whimsy-action-site-settings", "under its own name");
  ok(entry.keyId && document.getElementById(entry.keyId), "with a <key> the person can bind");
  is(entry.defaultKey, null, "and no default shortcut");

  await BrowserTestUtils.withNewTab(PAGE, async () => {
    await openPanel();
    ok(section() && !section().hidden, "The This Site section shows for a web page");
    const zenSettings = document.getElementById("zen-site-data-settings-list").closest(".zen-site-data-section");
    is(zenSettings.nextElementSibling, section(), "right after Zen's Settings section");
    Assert.deepEqual(
      [...section().querySelectorAll("[whimsy-site-setting]")].map(r => r.getAttribute("whimsy-site-setting")),
      ["zoom", "autoplay", "dark-pages", "reader", "fullscreen", "useragent"],
      "Rows in a fixed order, the optional one last"
    );
    ok(section().contains(document.activeElement), "The command puts focus in the section");
    ok(document.getElementById("whimsy-site-settings-forget-all").hidden, "Nothing remembered: no Forget All");
    is(rowOf("reader").getAttribute("state"), "block", "Reader is off");
    ok(section().querySelector("#whimsy-site-settings-list").classList.contains("whimsy-surface-group"),
      "The rows sit on one surface track");
    ok(!section().querySelector(".whimsy-site-settings-forget, toolbarseparator"), "No per-row ✕ and no separators");
    is(rowOf("reader").querySelector("input").getAttribute("role"), "switch", "Reader is a switch");
    is(rowOf("fullscreen").querySelector("input").getAttribute("role"), "switch", "Full Screen is a switch");
    ok(section().querySelector(".whimsy-site-settings-private-note").hidden, "No private note in a normal tab");
    ok(
      zenSettings.querySelector(".permission-popup-permission-item-site-protection"),
      "Content blocking stays Zen's own Tracking protection row"
    );
    ok(!section().querySelector(".permission-popup-permission-item-site-protection"), "and isn't listed twice");
    await closePanel();
  });

  await BrowserTestUtils.withNewTab("data:text/html,<p>Not a site</p>", async () => {
    gNavToolbox.setAttribute("zen-has-implicit-hover", "true");
    const shown = BrowserTestUtils.waitForPopupEvent(panel(), "shown");
    WhimsySiteSettings.open(window);
    await shown;
    ok(section().hidden, "No section for a page that isn't a site");
    await closePanel();
  });
});

// W10-16: "the zoom button doesn't work": − / + step Firefox's zoom and
// the % resets to 100%.
add_task(async function test_zoom_stepper() {
  clearAll();
  await BrowserTestUtils.withNewTab(PAGE, async browser => {
    await openPanel();
    const row = rowOf("zoom");
    const [out, value, into] = row.querySelector(".whimsy-site-settings-stepper").children;
    is(value.textContent, "100%", "The % shows the zoom");
    ok(value.hasAttribute("at-default"), "muted at the default");
    // F16: real clicks, as a person makes them (.click() hid the bug).
    EventUtils.synthesizeMouseAtCenter(into, {});
    await TestUtils.waitForCondition(() => ZoomManager.getZoomForBrowser(browser) > 1, "+ zooms in");
    await TestUtils.waitForCondition(() => value.textContent == `${Math.round(ZoomManager.getZoomForBrowser(browser) * 100)}%`,
      "and the % follows");
    ok(!value.hasAttribute("at-default"), "no longer muted");
    ok(!document.getElementById("whimsy-site-settings-forget-all").hidden, "Forget All shows");
    EventUtils.synthesizeMouseAtCenter(out, {});
    await TestUtils.waitForCondition(() => ZoomManager.getZoomForBrowser(browser) == 1, "− steps back");
    EventUtils.synthesizeMouseAtCenter(out, {});
    await TestUtils.waitForCondition(() => ZoomManager.getZoomForBrowser(browser) < 1, "− zooms out");
    is(panel().state, "open", "The panel stays open while zooming");
    EventUtils.synthesizeMouseAtCenter(value, {});
    await TestUtils.waitForCondition(() => ZoomManager.getZoomForBrowser(browser) == 1, "The % resets to 100%");
    await TestUtils.waitForCondition(() => value.textContent == "100%", "and says so");
    // A zoom change from elsewhere (⌘+, a saved zoom applied) shows too.
    await FullZoom.enlarge(browser);
    await TestUtils.waitForCondition(() => value.textContent == `${Math.round(ZoomManager.getZoomForBrowser(browser) * 100)}%`
      && value.textContent != "100%", "The % follows a zoom made elsewhere");
    await closePanel();
  });
  // Site-specific: a new tab on the site opens at that zoom; reset it.
  await BrowserTestUtils.withNewTab(PAGE, async browser => {
    Assert.greater(ZoomManager.getZoomForBrowser(browser), 1, "The site remembers its zoom");
    await FullZoom.reset(browser);
  });
});

// F16 (second look): the user's likely conditions: a site with a zoom
// already saved, Reader View on,
// and − / + clicked again and again. The % follows each click and the
// zoom is still there after a reload.
add_task(async function test_zoom_stepper_reader_saved_zoom() {
  clearAll();
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, ARTICLE_URL);
  const browser = tab.linkedBrowser;
  try {
    await FullZoom.enlarge(browser);
    const saved = ZoomManager.getZoomForBrowser(browser);
    Assert.greater(saved, 1, "The site has a saved zoom");
    await TestUtils.waitForCondition(() => browser.isArticle, "readerable");
    browser.browsingContext.currentWindowGlobal.getActor("AboutReader").sendAsyncMessage("Reader:ToggleReaderMode", {});
    await TestUtils.waitForCondition(() => browser.currentURI.spec.startsWith("about:reader"), "In Reader View");
    await openPanel();
    // Reader messages can rebuild the section after popupshown. Always
    // inspect/click the controls currently on screen, not a detached row.
    const control = name => rowOf("zoom").querySelector(`.whimsy-site-settings-zoom-${name}`);
    const value = () => control("value");
    const shown = () => `${Math.round(ZoomManager.getZoomForBrowser(browser) * 100)}%`;
    await TestUtils.waitForCondition(() => value().textContent == shown(), `The % shows the zoom (${value().textContent})`);
    for (const [button, more] of [["in", true], ["in", true], ["out", false], ["out", false], ["out", false]]) {
      const before = ZoomManager.getZoomForBrowser(browser);
      EventUtils.synthesizeMouseAtCenter(control(button), {});
      await TestUtils.waitForCondition(() => {
        const now = ZoomManager.getZoomForBrowser(browser);
        return more ? now > before : now < before;
      }, `${more ? "+" : "−"} steps the zoom`);
      await TestUtils.waitForCondition(() => value().textContent == shown(), `...and the % follows (${value().textContent})`);
      is(panel().state, "open", "The panel stays open");
    }
    EventUtils.synthesizeMouseAtCenter(value(), {});
    await TestUtils.waitForCondition(() => ZoomManager.getZoomForBrowser(browser) == 1 && value().textContent == "100%",
      "The % resets Reader View's zoom");
    await closePanel();
    browser.browsingContext.currentWindowGlobal.getActor("AboutReader").sendAsyncMessage("Reader:ToggleReaderMode", {});
    await TestUtils.waitForCondition(() => browser.currentURI.spec == ARTICLE_URL, "Out of Reader View");
    await TestUtils.waitForCondition(() => Math.abs(ZoomManager.getZoomForBrowser(browser) - saved) < 0.01,
      "The page keeps the site's saved zoom");
    // Outside Reader, a + step is saved for the site and survives a reload.
    await openPanel();
    EventUtils.synthesizeMouseAtCenter(rowOf("zoom").querySelector(".whimsy-site-settings-zoom-in"), {});
    await TestUtils.waitForCondition(() => ZoomManager.getZoomForBrowser(browser) > saved, "+ steps the page zoom");
    const last = ZoomManager.getZoomForBrowser(browser);
    await closePanel();
    await waitForSavedZoom(browser, last, "The step is saved for the site");
    BrowserTestUtils.reloadTab(tab);
    await BrowserTestUtils.browserLoaded(browser);
    await TestUtils.waitForCondition(() => Math.abs(ZoomManager.getZoomForBrowser(browser) - last) < 0.01,
      "The zoom stays after a reload");
    await FullZoom.reset(browser);
  } finally {
    BrowserTestUtils.removeTab(tab);
    clearAll();
  }
});

// W14 18b: ⌘+ / ⌘- / ⌘0 in Reader View zoom the page as the stepper does,
// so the stepper's % and the address bar's zoom button follow (Firefox's
// own handling changed Reader's font size, which neither shows).
add_task(async function test_reader_zoom_shortcuts_follow() {
  clearAll();
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, ARTICLE_URL);
  const browser = tab.linkedBrowser;
  try {
    await TestUtils.waitForCondition(() => browser.isArticle, "readerable");
    browser.browsingContext.currentWindowGlobal.getActor("AboutReader").sendAsyncMessage("Reader:ToggleReaderMode", {});
    await TestUtils.waitForCondition(() => browser.currentURI.spec.startsWith("about:reader"), "In Reader View");
    await TestUtils.waitForCondition(() => document.getElementById("reader-mode-button").hasAttribute("readeractive"), "Reader View is on");
    const fontSize = Services.prefs.getIntPref("reader.font_size", 0);
    await openPanel();
    const value = () => rowOf("zoom").querySelector(".whimsy-site-settings-zoom-value");
    const zoomButton = document.getElementById("urlbar-zoom-button");
    EventUtils.synthesizeKey("+", { accelKey: true });
    await TestUtils.waitForCondition(() => ZoomManager.getZoomForBrowser(browser) > 1, "⌘+ zooms the Reader View page");
    const shown = `${Math.round(ZoomManager.getZoomForBrowser(browser) * 100)}%`;
    await TestUtils.waitForCondition(() => value().textContent == shown, `The stepper follows (${value().textContent})`);
    await TestUtils.waitForCondition(() => !zoomButton.hidden && zoomButton.getAttribute("label") == shown,
      `...and so does the address bar's zoom button (${zoomButton.getAttribute("label")})`);
    is(Services.prefs.getIntPref("reader.font_size", 0), fontSize, "Reader's own text size is left alone");
    EventUtils.synthesizeKey("-", { accelKey: true });
    await TestUtils.waitForCondition(() => Math.abs(ZoomManager.getZoomForBrowser(browser) - 1) < 0.001, "⌘- steps back");
    EventUtils.synthesizeKey("+", { accelKey: true });
    await TestUtils.waitForCondition(() => ZoomManager.getZoomForBrowser(browser) > 1, "⌘+ again");
    EventUtils.synthesizeKey("0", { accelKey: true });
    await TestUtils.waitForCondition(() => Math.abs(ZoomManager.getZoomForBrowser(browser) - 1) < 0.001 && value().textContent == "100%",
      "⌘0 resets it, and the stepper follows");
    await closePanel();
  } finally {
    BrowserTestUtils.removeTab(tab);
    clearAll();
  }
});

// B10: zoom set in Reader View itself (the stepper, which zooms the
// about:reader page rather than Reader's font size, F16) is still there
// after reloading *while still in Reader View* -- not just after leaving
// Reader View back to the original page (covered above).
add_task(async function test_zoom_stepper_reader_reload_in_reader() {
  clearAll();
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, ARTICLE_URL);
  const browser = tab.linkedBrowser;
  try {
    await TestUtils.waitForCondition(() => browser.isArticle, "readerable");
    browser.browsingContext.currentWindowGlobal.getActor("AboutReader").sendAsyncMessage("Reader:ToggleReaderMode", {});
    await TestUtils.waitForCondition(() => browser.currentURI.spec.startsWith("about:reader"), "In Reader View");
    const readerURL = browser.currentURI.spec;
    await openPanel();
    const into = rowOf("zoom").querySelector(".whimsy-site-settings-zoom-in");
    EventUtils.synthesizeMouseAtCenter(into, {});
    EventUtils.synthesizeMouseAtCenter(into, {});
    await TestUtils.waitForCondition(() => ZoomManager.getZoomForBrowser(browser) > 1, "+ steps Reader View's zoom");
    const set = ZoomManager.getZoomForBrowser(browser);
    await closePanel();
    // Each + saves on its own; the reload must come after the last save.
    await waitForSavedZoom(browser, set, "Both steps are saved for Reader View");
    BrowserTestUtils.reloadTab(tab);
    await BrowserTestUtils.browserLoaded(browser);
    is(browser.currentURI.spec, readerURL, "Reloading stayed in Reader View");
    await TestUtils.waitForCondition(() => Math.abs(ZoomManager.getZoomForBrowser(browser) - set) < 0.01,
      `Reader View's zoom stays after a reload (${ZoomManager.getZoomForBrowser(browser)} vs ${set})`);
  } finally {
    BrowserTestUtils.removeTab(tab);
    clearAll();
  }
});

add_task(async function test_autoplay_reuses_firefox_permission() {
  clearAll();
  // Firefox's real default, Block audio (the harness allows autoplay, which
  // would make Allow the default and nothing to remember).
  await SpecialPowers.pushPrefEnv({ set: [["media.autoplay.default", 1]] });
  await BrowserTestUtils.withNewTab(PAGE, async browser => {
    const principal = browser.contentPrincipal;
    SitePermissions.setForPrincipal(principal, "autoplay-media", SitePermissions.ALLOW);
    await openPanel();
    const zenRow = document.querySelector(
      "#zen-site-data-settings-list .permission-popup-permission-item-autoplay-media"
    );
    ok(zenRow, "Zen lists the stored autoplay decision");
    ok(zenRow.hidden, "but steps aside while This Site shows it");
    is(rowOf("autoplay").getAttribute("state"), "allow", "Autoplay is remembered here");

    // The dropdown opens a surface listbox, not a native menu.
    const pick = async value => {
      const shown = BrowserTestUtils.waitForEvent(document, "popupshown", true,
        e => e.target.id == "whimsy-site-settings-autoplay-button-list");
      rowOf("autoplay").querySelector(".whimsy-surface-dropdown").click();
      await shown;
      const list = document.getElementById("whimsy-site-settings-autoplay-button-list");
      ok(list.classList.contains("whimsy-surface"), "The choices are a Whimsy surface");
      list.querySelector(`[role=option][data-value="${value}"]`).click();
      await TestUtils.waitForCondition(() => !list.isConnected, "It closes on a pick");
    };
    await pick(String(SitePermissions.AUTOPLAY_BLOCKED_ALL));
    is(Services.perms.getPermissionObject(principal, "autoplay-media", true)?.capability,
      SitePermissions.AUTOPLAY_BLOCKED_ALL, "Picking Block audio and video stores it");
    is(panel().state, "open", "The site panel stays open");
    await pick("default");
    ok(!Services.perms.getPermissionObject(principal, "autoplay-media", true), "Use Default forgets Firefox's permission");
    is(rowOf("autoplay").getAttribute("state"), "block", "and the row shows the default again");
    await closePanel();
  });

  Services.prefs.setBoolPref(FEATURE_PREF, false);
  await BrowserTestUtils.withNewTab(PAGE, async browser => {
    SitePermissions.setForPrincipal(browser.contentPrincipal, "autoplay-media", SitePermissions.ALLOW);
    gNavToolbox.setAttribute("zen-has-implicit-hover", "true");
    const shown = BrowserTestUtils.waitForPopupEvent(panel(), "shown");
    EventUtils.synthesizeMouseAtCenter(document.getElementById("zen-site-data-icon-button"), {});
    await shown;
    ok(!section() || section().hidden, "Switch off: no This Site section");
    const zenRow = document.querySelector(
      "#zen-site-data-settings-list .permission-popup-permission-item-autoplay-media"
    );
    ok(zenRow && !zenRow.hidden, "and Zen's Autoplay row is back");
    await closePanel();
  });
  Services.prefs.clearUserPref(FEATURE_PREF);
  clearAll();
  await SpecialPowers.popPrefEnv();
});

add_task(async function test_always_open_in_reader() {
  clearAll();
  await BrowserTestUtils.withNewTab(ARTICLE_URL, async browser => {
    // B9: the switch only works once the page is known to be readerable.
    await TestUtils.waitForCondition(() => browser.isArticle, "readerable");
    await openPanel();
    ok(!rowOf("reader").querySelector("input").disabled, "readerable: the switch is enabled");
    // Turning it on puts the page in front into Reader View now, so the
    // panel goes out of the way first.
    let hidden = BrowserTestUtils.waitForPopupEvent(panel(), "hidden");
    rowOf("reader").querySelector("input").click();
    ok(WhimsySiteSettings.getFlag("reader", HOST, NORMAL), "The switch remembers Reader for the site");
    is(rowOf("reader").getAttribute("state"), "allow", "and the row shows it");
    ok(rowOf("reader").querySelector("input").checked, "switched on");
    await hidden;
    await TestUtils.waitForCondition(() => browser.currentURI.spec.startsWith("about:reader"), "The page opens in Reader View now");
    await openPanel();
    ok(rowOf("reader").querySelector("input").checked, "Still on in Reader View");
    rowOf("reader").querySelector("input").click();
    ok(!WhimsySiteSettings.getFlag("reader", HOST, NORMAL), "Switching it off forgets it");
    await TestUtils.waitForCondition(() => browser.currentURI.spec == ARTICLE_URL, "Switching it off leaves Reader View");
    await TestUtils.waitForCondition(() => browser.isArticle, "readerable again");
    await openPanel();
    hidden = BrowserTestUtils.waitForPopupEvent(panel(), "hidden");
    rowOf("reader").querySelector("input").click();
    await hidden;
    ok(WhimsySiteSettings.getFlag("reader", HOST, NORMAL), "On again for the next page");
  });

  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, ARTICLE_URL, false);
  const browser = tab.linkedBrowser;
  await TestUtils.waitForCondition(
    () => browser.currentURI.spec.startsWith("about:reader"),
    "An article on the site opens in Reader View by itself"
  );

  // Leaving Reader View sticks: the page isn't sent back into Reader.
  browser.browsingContext.currentWindowGlobal.getActor("AboutReader").sendAsyncMessage("Reader:ToggleReaderMode", {});
  await TestUtils.waitForCondition(() => browser.currentURI.spec == ARTICLE_URL, "Back on the original page");
  await TestUtils.waitForCondition(() => browser.isArticle, "The original page is readerable again");
  await new Promise(r => setTimeout(r, 500)); // eslint-disable-line mozilla/no-arbitrary-setTimeout
  ok(!browser.currentURI.spec.startsWith("about:reader"), "Leaving Reader View isn't undone");
  BrowserTestUtils.removeTab(tab);

  // Switch off: no automatic Reader View.
  Services.prefs.setBoolPref(FEATURE_PREF, false);
  const tab2 = await BrowserTestUtils.openNewForegroundTab(gBrowser, ARTICLE_URL);
  await TestUtils.waitForCondition(() => tab2.linkedBrowser.isArticle, "readerable");
  await new Promise(r => setTimeout(r, 500)); // eslint-disable-line mozilla/no-arbitrary-setTimeout
  ok(!tab2.linkedBrowser.currentURI.spec.startsWith("about:reader"), "Switch off: the article stays as is");
  BrowserTestUtils.removeTab(tab2);
  Services.prefs.clearUserPref(FEATURE_PREF);
  clearAll();
});

// F16: turning Always Open in Reader View off ends Reader View now, as
// turning full screen off ends full screen.
add_task(async function test_reader_switch_off_leaves_reader() {
  clearAll();
  WhimsySiteSettings.setFlag("reader", HOST, NORMAL, true);
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, ARTICLE_URL, false);
  const browser = tab.linkedBrowser;
  try {
    await TestUtils.waitForCondition(() => browser.currentURI.spec.startsWith("about:reader"), "In Reader View");
    await openPanel();
    const toggle = rowOf("reader")?.querySelector("input");
    ok(toggle?.checked, "The switch is on in Reader View");
    toggle.click();
    await TestUtils.waitForCondition(() => browser.currentURI.spec == ARTICLE_URL, "Switching it off left Reader View");
    ok(!WhimsySiteSettings.getFlag("reader", HOST, NORMAL), "and forgot it");
    await closePanel();
  } finally {
    BrowserTestUtils.removeTab(tab);
    clearAll();
  }
});

add_task(async function test_open_in_full_screen() {
  clearAll();
  const calls = [];
  const original = WhimsySiteSettings.enterFullscreen;
  const tabs = [];
  // Keep a neutral tab selected during teardown. Removing the last fixture
  // otherwise selects an existing example.com tab while its rule is on.
  const keep = await BrowserTestUtils.openNewForegroundTab(gBrowser, "about:blank");
  tabs.push(keep);
  WhimsySiteSettings.enterFullscreen = win => calls.push(win);
  try {
    WhimsySiteSettings.setFlag("fullscreen", HOST, NORMAL, true);
    const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE);
    tabs.push(tab);
    is(calls.length, 1, "Opening the site goes full screen");
    is(calls[0], window, "in its window");

    const other = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.org/");
    tabs.push(other);
    await BrowserTestUtils.switchTab(gBrowser, tab);
    is(calls.length, 1, "Coming back to the same tab doesn't force it again");
    await BrowserTestUtils.switchTab(gBrowser, keep);
    await BrowserTestUtils.removeTab(other);
    await BrowserTestUtils.removeTab(tab);

    WhimsySiteSettings.setFlag("fullscreen", HOST, NORMAL, false);
    const tab3 = await BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE);
    tabs.push(tab3);
    is(calls.length, 1, "Forgotten: the site opens normally");
  } finally {
    clearAll();
    WhimsySiteSettings.enterFullscreen = original;
    for (const tab of tabs.reverse()) {
      if (tab.isConnected && !tab.closing) {
        await BrowserTestUtils.removeTab(tab);
      }
    }
  }
});

// W10-16: "Turn off fullscreen doesn't end full screen". The switch's off
// leaves the full screen Whimsy entered for the site, never one the person
// entered themselves.
add_task(async function test_full_screen_off_leaves_it() {
  clearAll();
  const exits = [];
  const originals = { enter: WhimsySiteSettings.enterFullscreen, exit: WhimsySiteSettings.exitFullscreen };
  const fakeWin = { fullScreen: true };
  WhimsySiteSettings.enterFullscreen = () => {};
  WhimsySiteSettings.exitFullscreen = win => exits.push(win);
  try {
    await BrowserTestUtils.withNewTab(PAGE, async browser => {
      WhimsySiteSettings.setFlag("fullscreen", HOST, NORMAL, true);
      ok(WhimsySiteSettings.maybeFullscreen({ fullScreen: false }, browser), "Whimsy entered full screen for the site");
      ok(WhimsySiteSettings.leaveFullscreen(fakeWin, browser, HOST), "Off leaves it");
      is(exits.length, 1, "once");
      ok(!WhimsySiteSettings.leaveFullscreen(fakeWin, browser, HOST), "but not a full screen it didn't enter");
      is(exits.length, 1, "nothing more");

      // Through the panel's switch.
      WhimsySiteSettings.setFlag("fullscreen", HOST, NORMAL, true);
      WhimsySiteSettings.maybeFullscreen({ fullScreen: false }, browser);
      const realFull = window.fullScreen;
      await openPanel();
      ok(rowOf("fullscreen").querySelector("input").checked, "The switch is on");
      const originalLeave = WhimsySiteSettings.leaveFullscreen;
      let left = 0;
      WhimsySiteSettings.leaveFullscreen = (...args) => (left++, originalLeave.apply(WhimsySiteSettings, args));
      rowOf("fullscreen").querySelector("input").click();
      WhimsySiteSettings.leaveFullscreen = originalLeave;
      is(left, 1, "Switching it off leaves full screen");
      ok(!WhimsySiteSettings.getFlag("fullscreen", HOST, NORMAL), "and forgets it");
      is(window.fullScreen, realFull, "The test window's own state is untouched");
      await closePanel();
    });
  } finally {
    WhimsySiteSettings.enterFullscreen = originals.enter;
    WhimsySiteSettings.exitFullscreen = originals.exit;
    clearAll();
  }
});

// W10-16 (pick B): Pretend to Be is one row with a dropdown, picked in the
// panel, which stays open while the page reloads; Whimsy forgets it;
// Custom… reveals a field and Apply sets it.
add_task(async function test_pretend_to_be_in_place() {
  clearAll();
  await BrowserTestUtils.withNewTab(PAGE, async browser => {
    await openPanel();
    const row = rowOf("useragent");
    is(document.l10n.getAttributes(row.querySelector(".whimsy-surface-row-detail")).id,
      "whimsy-site-settings-useragent-reloads", "It says it reloads the page");
    const pick = async value => {
      const shown = BrowserTestUtils.waitForEvent(document, "popupshown", true,
        e => e.target.id == "whimsy-site-settings-useragent-button-list");
      // The row is rebuilt as the page reloads; click the one on screen.
      const button = await TestUtils.waitForCondition(() => {
        const b = rowOf("useragent")?.querySelector(".whimsy-surface-dropdown");
        return b && BrowserTestUtils.isVisible(b) && b;
      }, "Pretend to Be's dropdown is showing");
      button.click();
      await shown;
      const list = document.getElementById("whimsy-site-settings-useragent-button-list");
      Assert.deepEqual([...list.querySelectorAll("[role=option]")].map(o => o.dataset.value),
        ["chrome-mac", "default", "safari-mac", "safari-iphone", "custom"], "Chrome, Whimsy, Safari, iPhone, Custom…");
      ok(!list.querySelector("menuitem, menuseparator"), "not a native menu");
      list.querySelector(`[data-value="${value}"]`).click();
    };
    const reloaded = BrowserTestUtils.browserLoaded(browser);
    await pick("safari-iphone");
    await reloaded;
    is(WhimsyUserAgent.entry(HOST)?.preset, "safari-iphone", "Picking iPhone sets it");
    is(panel().state, "open", "and the panel stays open");
    await TestUtils.waitForCondition(() =>
      document.l10n.getAttributes(rowOf("useragent").querySelector(".whimsy-surface-row-detail")).id ==
        "whimsy-site-settings-useragent-reloads", "Back to Reloads the page once loaded");

    await pick("custom");
    const field = section().querySelector(".whimsy-site-settings-custom-field");
    ok(field && !section().querySelector(".whimsy-site-settings-custom").hidden, "Custom… reveals the field");
    is(document.activeElement, field, "with the keyboard");
    field.value = "WhimsyTestAgent/1.0";
    const reloaded2 = BrowserTestUtils.browserLoaded(browser);
    section().querySelector("#whimsy-site-settings-custom-apply").doCommand();
    await reloaded2;
    Assert.deepEqual(WhimsyUserAgent.entry(HOST), { preset: "custom", custom: "WhimsyTestAgent/1.0" }, "Apply sets it");
    await TestUtils.waitForCondition(() =>
      document.l10n.getAttributes(rowOf("useragent").querySelector(".whimsy-surface-row-detail")).id ==
        "whimsy-site-settings-useragent-reloads", "The row settles once the page has loaded again");

    const reloaded3 = BrowserTestUtils.browserLoaded(browser);
    await pick("default");
    await reloaded3;
    is(WhimsyUserAgent.entry(HOST), null, "Whimsy forgets it");
    await closePanel();
  });
  clearAll();
});

// W10-16: in a private tab the section says its settings go with the
// private tabs, and nothing persists.
add_task(async function test_private_note() {
  clearAll();
  const { WhimsyPrivate } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyPrivate.sys.mjs");
  const tab = WhimsyPrivate.openPrivateTab(window, { url: ARTICLE_URL, force: true });
  // The load can be over before a load listener would be in place.
  await TestUtils.waitForCondition(() =>
    tab.linkedBrowser.currentURI?.spec == ARTICLE_URL && !tab.hasAttribute("busy") && !tab.hasAttribute("pending"),
  "The private tab loaded");
  // It opens selected; switchTab would wait for a switch that never comes.
  if (!tab.selected) {
    await BrowserTestUtils.switchTab(gBrowser, tab);
  }
  await TestUtils.waitForCondition(() => tab.linkedBrowser.isArticle, "readerable");
  try {
    await openPanel();
    ok(!section().querySelector(".whimsy-site-settings-private-note").hidden, "The private note shows");
    rowOf("reader").querySelector("input").click();
    const privateOA = { userContextId: 0, privateBrowsingId: 1 };
    ok(WhimsySiteSettings.getFlag("reader", HOST, privateOA), "remembered for the private session");
    ok(!WhimsySiteSettings.getFlag("reader", HOST, NORMAL), "never for normal tabs");
    await closePanel();
  } finally {
    BrowserTestUtils.removeTab(tab);
    clearAll();
  }
});

add_task(async function test_private_and_profiles_stay_apart() {
  clearAll();
  const privateOA = { userContextId: 0, privateBrowsingId: 1 };
  WhimsySiteSettings.setFlag("reader", HOST, privateOA, true);
  ok(WhimsySiteSettings.getFlag("reader", HOST, privateOA), "A private tab can remember it for the session");
  ok(!WhimsySiteSettings.getFlag("reader", HOST, NORMAL), "but normal tabs don't see it");
  const permission = Services.perms.getPermissionObject(
    WhimsySiteSettings.sitePrincipal(HOST, privateOA),
    PERM_TYPES.reader,
    true
  );
  is(permission.expireType, Services.perms.EXPIRE_SESSION, "and it is never written to disk");
  Services.obs.notifyObservers(null, "last-pb-context-exited");
  await TestUtils.waitForCondition(
    () => !WhimsySiteSettings.getFlag("reader", HOST, privateOA),
    "and it is gone when the last private tab closes"
  );

  const work = { userContextId: 2, privateBrowsingId: 0 };
  WhimsySiteSettings.setFlag("fullscreen", HOST, work, true);
  ok(WhimsySiteSettings.getFlag("fullscreen", HOST, work), "A profile (container) has its own settings");
  ok(!WhimsySiteSettings.getFlag("fullscreen", HOST, NORMAL), "that the default profile doesn't share");
  clearAll();
});

add_task(async function test_forget_all_and_undo() {
  clearAll();
  await BrowserTestUtils.withNewTab(PAGE, async browser => {
    WhimsySiteSettings.setFlag("reader", HOST, NORMAL, true);
    WhimsySiteSettings.setFlag("fullscreen", HOST, NORMAL, false);
    SitePermissions.setForPrincipal(browser.contentPrincipal, "autoplay-media", SitePermissions.BLOCK);
    WhimsyUserAgent.set(HOST, "safari-iphone");
    await FullZoom.enlarge(browser);

    await openPanel();
    is(rowOf("useragent").getAttribute("state"), "allow", "Pretend to Be shows the stored choice");
    is(document.l10n.getAttributes(rowOf("useragent").querySelector(".whimsy-surface-dropdown-value")).id,
      "whimsy-site-settings-useragent-safari-iphone", "iPhone");
    const forgetAll = document.getElementById("whimsy-site-settings-forget-all");
    ok(!forgetAll.hidden, "Forget All shows");
    const hidden = BrowserTestUtils.waitForPopupEvent(panel(), "hidden");
    const reloaded = BrowserTestUtils.browserLoaded(browser);
    forgetAll.click();
    await hidden;
    await reloaded;

    ok(!WhimsySiteSettings.getFlag("reader", HOST, NORMAL), "Reader forgotten");
    ok(!Services.perms.getPermissionObject(browser.contentPrincipal, "autoplay-media", true), "Autoplay forgotten");
    is(WhimsyUserAgent.entry(HOST), null, "User agent forgotten");
    await TestUtils.waitForCondition(() => ZoomManager.getZoomForBrowser(browser) == 1, "Zoom forgotten");

    ok(WhimsyUndo.peek(window)?.type == "site-settings-forget", "Undo is offered");
    const reloadedAgain = BrowserTestUtils.browserLoaded(browser);
    WhimsyUndo.undo(window);
    await reloadedAgain;
    ok(WhimsySiteSettings.getFlag("reader", HOST, NORMAL), "Undo brings Reader back");
    is(Services.perms.getPermissionObject(browser.contentPrincipal, "autoplay-media", true)?.capability,
      SitePermissions.BLOCK, "and autoplay");
    is(WhimsyUserAgent.entry(HOST)?.preset, "safari-iphone", "and the user agent");
    await TestUtils.waitForCondition(() => ZoomManager.getZoomForBrowser(browser) > 1, "and the zoom");
    await FullZoom.reset(browser);
  });
  clearAll();
});

// B9: the switch does nothing on a page Reader View can't open, so it's
// disabled there with a reason rather than left to look broken. Disabled,
// not hidden, so the row's position in the list never moves; and the
// switch follows the page's own readerability (navigation, late isArticle)
// rather than freezing at whatever was true when the panel opened.
add_task(async function test_reader_switch_disabled_when_not_readerable() {
  clearAll();
  await BrowserTestUtils.withNewTab(PAGE, async browser => {
    await openPanel();
    let input = rowOf("reader").querySelector("input");
    ok(input.disabled, "Not readerable: the switch is disabled");
    is(
      document.l10n.getAttributes(rowOf("reader").querySelector(".whimsy-surface-row-detail")).id,
      "whimsy-site-settings-reader-unavailable",
      "and says why"
    );
    const kinds = [...section().querySelectorAll("[whimsy-site-setting]")].map(r => r.getAttribute("whimsy-site-setting"));
    Assert.deepEqual(kinds.slice(0, 4), ["zoom", "autoplay", "reader", "fullscreen"],
      "disabled, not hidden: the row stays in place");

    // Navigating to an article while the panel is open enables it, once
    // isArticle is known (it arrives after the load settles, not with it).
    const loaded = BrowserTestUtils.browserLoaded(browser, false, ARTICLE_URL);
    BrowserTestUtils.startLoadingURIString(browser, ARTICLE_URL);
    await loaded;
    await TestUtils.waitForCondition(() => !rowOf("reader").querySelector("input").disabled,
      "Readerable once isArticle arrives: the switch enables itself");
    ok(!rowOf("reader").querySelector(".whimsy-surface-row-detail"), "and the reason is gone");

    // Navigating back to a non-article page disables it again.
    const loadedBack = BrowserTestUtils.browserLoaded(browser, false, PAGE);
    BrowserTestUtils.startLoadingURIString(browser, PAGE);
    await loadedBack;
    await TestUtils.waitForCondition(() => rowOf("reader").querySelector("input").disabled,
      "Back to a non-article page: the switch disables itself again");
    input = rowOf("reader").querySelector("input");
    ok(!input.checked, "and a click can't turn it on");
    await closePanel();
  });
  clearAll();
});

// W14-2: every This Site row's name fits on one line, unclipped, with
// Always Open in Reader View and in Full Screen on (their bolder weight).
add_task(async function test_rows_fit_on_one_line() {
  clearAll();
  // The row only needs the flag on: opening the site must not put the test
  // window itself in full screen, which outlives this file (and a --repeat
  // run's next pass, where test_open_in_full_screen then sees a full-screen
  // window and never enters it).
  const enterFullscreen = WhimsySiteSettings.enterFullscreen;
  WhimsySiteSettings.enterFullscreen = () => {};
  WhimsySiteSettings.setFlag("reader", HOST, NORMAL, true);
  WhimsySiteSettings.setFlag("fullscreen", HOST, NORMAL, true);
  try {
    await BrowserTestUtils.withNewTab(PAGE, async () => {
      await openPanel();
      is(rowOf("reader").getAttribute("state"), "allow", "Reader View row is on (weight 500)");
      is(rowOf("fullscreen").getAttribute("state"), "allow", "Full Screen row is on");
      const labels = [...section().querySelectorAll(".whimsy-surface-row-label")].filter(l => l.getClientRects().length);
      ok(labels.length >= 4, `${labels.length} row names showing`);
      for (const label of labels) {
        const lineHeight = parseFloat(getComputedStyle(label).lineHeight) || 18;
        ok(label.scrollWidth <= label.clientWidth, `"${label.textContent}" isn't cut off (${label.scrollWidth} <= ${label.clientWidth})`);
        ok(label.getBoundingClientRect().height < lineHeight * 1.5, `"${label.textContent}" is one line`);
      }
      const width = panel().getBoundingClientRect().width;
      ok(width >= 270, `The panel is wider (${width}px)`);
      await closePanel();
    });
  } finally {
    WhimsySiteSettings.setFlag("fullscreen", HOST, NORMAL, false);
    WhimsySiteSettings.enterFullscreen = enterFullscreen;
    clearAll();
  }
  ok(!window.fullScreen, "The test window never went full screen");
});
