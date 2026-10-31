/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// W9-04: site settings ("This Site" in Zen's site panel). Covers the
// section and its fixed rows, Zen's Autoplay row stepping aside, zoom with
// reset, autoplay cycling and forgetting, Always Open in Reader View
// opening an article by itself (and not again after leaving Reader), Open
// in Full Screen (once per tab and site), Pretend to Be, Forget All with
// Undo, private tabs and profiles never sharing or persisting, the
// "Site Settings…" command and the feature switch.

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

function clearAll() {
  for (const oa of [NORMAL, { userContextId: 0, privateBrowsingId: 1 }, { userContextId: 2, privateBrowsingId: 0 }]) {
    const principal = WhimsySiteSettings.sitePrincipal(HOST, oa);
    for (const type of Object.values(PERM_TYPES)) {
      Services.perms.removeFromPrincipal(principal, type);
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
      ["zoom", "autoplay", "reader", "fullscreen", "useragent"],
      "Rows in a fixed order, the optional one last"
    );
    ok(section().contains(document.activeElement), "The command puts focus in the section");
    ok(document.getElementById("whimsy-site-settings-forget-all").hidden, "Nothing remembered: no Forget All");
    is(rowOf("reader").getAttribute("state"), "block", "Reader is off");
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

add_task(async function test_zoom_row_and_reset() {
  clearAll();
  await BrowserTestUtils.withNewTab(PAGE, async browser => {
    await FullZoom.enlarge(browser);
    const zoomed = ZoomManager.getZoomForBrowser(browser);
    Assert.greater(zoomed, 1, "The page is zoomed in");
    await openPanel();
    const row = rowOf("zoom");
    await TestUtils.waitForCondition(() => row.getAttribute("state") == "allow", "The zoom row lights up");
    is(document.l10n.getAttributes(row.querySelector(".whimsy-site-settings-state")).args.percent,
      Math.round(zoomed * 100), "and shows the zoom level");
    const reset = row.querySelector(".whimsy-site-settings-forget");
    ok(!reset.hidden, "with a reset button");
    ok(!document.getElementById("whimsy-site-settings-forget-all").hidden, "Forget All shows");
    reset.doCommand();
    await TestUtils.waitForCondition(() => ZoomManager.getZoomForBrowser(browser) == 1, "Reset puts zoom back");
    await closePanel();
  });
  // Site-specific: a new tab on the site opens at the default zoom.
  await BrowserTestUtils.withNewTab(PAGE, async browser => {
    is(ZoomManager.getZoomForBrowser(browser), 1, "The site's zoom was forgotten");
  });
});

add_task(async function test_autoplay_reuses_firefox_permission() {
  clearAll();
  await BrowserTestUtils.withNewTab(PAGE, async browser => {
    const principal = browser.contentPrincipal;
    SitePermissions.setForPrincipal(principal, "autoplay-media", SitePermissions.ALLOW);
    await openPanel();
    const zenRow = document.querySelector(
      "#zen-site-data-settings-list .permission-popup-permission-item-autoplay-media"
    );
    ok(zenRow, "Zen lists the stored autoplay decision");
    ok(zenRow.hidden, "but steps aside while This Site shows it");
    let row = rowOf("autoplay");
    is(row.getAttribute("state"), "allow", "Autoplay is remembered here");
    ok(row.querySelector(".whimsy-site-settings-forget"), "with a Forget button");

    row.click();
    is(Services.perms.getPermissionObject(principal, "autoplay-media", true)?.capability, SitePermissions.BLOCK,
      "A click cycles Allow to Block audio");
    row = rowOf("autoplay");
    row.querySelector(".whimsy-site-settings-forget").doCommand();
    ok(!Services.perms.getPermissionObject(principal, "autoplay-media", true), "Forget removes Firefox's permission");
    row = rowOf("autoplay");
    is(row.getAttribute("state"), "block", "and the row shows the default again");
    ok(!row.querySelector(".whimsy-site-settings-forget"), "without a Forget button");
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
});

add_task(async function test_always_open_in_reader() {
  clearAll();
  await BrowserTestUtils.withNewTab(PAGE, async () => {
    await openPanel();
    rowOf("reader").click();
    ok(WhimsySiteSettings.getFlag("reader", HOST, NORMAL), "Clicking the row remembers Reader for the site");
    is(rowOf("reader").getAttribute("state"), "allow", "and the row shows On");
    await closePanel();
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

add_task(async function test_open_in_full_screen() {
  clearAll();
  const calls = [];
  const original = WhimsySiteSettings.enterFullscreen;
  WhimsySiteSettings.enterFullscreen = win => calls.push(win);
  registerCleanupFunction(() => (WhimsySiteSettings.enterFullscreen = original));

  WhimsySiteSettings.setFlag("fullscreen", HOST, NORMAL, true);
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE);
  is(calls.length, 1, "Opening the site goes full screen");
  is(calls[0], window, "in its window");

  const other = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.org/");
  await BrowserTestUtils.switchTab(gBrowser, tab);
  is(calls.length, 1, "Coming back to the same tab doesn't force it again");
  BrowserTestUtils.removeTab(other);
  BrowserTestUtils.removeTab(tab);

  WhimsySiteSettings.setFlag("fullscreen", HOST, NORMAL, false);
  const tab3 = await BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE);
  is(calls.length, 1, "Forgotten: the site opens normally");
  BrowserTestUtils.removeTab(tab3);
  WhimsySiteSettings.enterFullscreen = original;
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
    is(document.l10n.getAttributes(rowOf("useragent").querySelector(".whimsy-site-settings-state")).id,
      "whimsy-site-settings-useragent-safari-iphone", "iPhone (mobile site)");
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
