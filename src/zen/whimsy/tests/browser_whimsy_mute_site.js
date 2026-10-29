/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// Remember muted sites: the tab menu's "Mute Site" mutes the site's tabs
// and every tab that later goes there (subdomains too), "Unmute Site"
// clears it. Other sites aren't touched, and the switch hides the item.

const startTabs = new Set(gBrowser.tabs);
const site = Services.scriptSecurityManager.createContentPrincipal(Services.io.newURI("https://example.com"), {});

registerCleanupFunction(() => {
  Services.perms.removeFromPrincipal(site, "whimsy-muted");
  for (const tab of gBrowser.tabs.filter(t => !startTabs.has(t))) {
    BrowserTestUtils.removeTab(tab);
  }
});

async function openMenu(tab) {
  const menu = document.getElementById("tabContextMenu");
  const shown = BrowserTestUtils.waitForPopupEvent(menu, "shown");
  EventUtils.synthesizeMouseAtCenter(tab, { type: "contextmenu", button: 2 });
  await shown;
  return menu;
}

async function activate(menu, item) {
  const hidden = BrowserTestUtils.waitForPopupEvent(menu, "hidden");
  menu.activateItem(item);
  await hidden;
}

const item = () => document.getElementById("context_whimsyMuteSite");
const open = url => BrowserTestUtils.openNewForegroundTab(gBrowser, url);

add_task(async function test_mute_site() {
  const a = await open("https://example.com/one");
  let menu = await openMenu(a);
  ok(item() && !item().hidden, "The tab menu offers Mute Site");
  await TestUtils.waitForCondition(() => item().getAttribute("label") == "Mute Site", "labelled");
  await activate(menu, item());
  ok(a.hasAttribute("muted"), "The site's open tab is muted");
  is(
    Services.perms.testExactPermissionFromPrincipal(site, "whimsy-muted"),
    Services.perms.ALLOW_ACTION,
    "The choice is saved for the site"
  );

  const b = await open("https://www.example.com/two");
  await TestUtils.waitForCondition(() => b.hasAttribute("muted"), "A new tab on the site opens muted");
  ok(b.linkedBrowser.audioMuted, "its browser is muted");
  const other = await open("https://example.org/");
  ok(!other.hasAttribute("muted"), "Another site isn't muted");

  // Leaving the site gives the tab its sound back.
  BrowserTestUtils.startLoadingURIString(b.linkedBrowser, "https://example.org/?elsewhere");
  await BrowserTestUtils.browserLoaded(b.linkedBrowser);
  ok(!b.hasAttribute("muted"), "Navigating away from the site unmutes");

  menu = await openMenu(a);
  await TestUtils.waitForCondition(() => item().getAttribute("label") == "Unmute Site", "now offers Unmute Site");
  await activate(menu, item());
  ok(!a.hasAttribute("muted"), "Unmute Site unmutes the tab");
  is(
    Services.perms.testExactPermissionFromPrincipal(site, "whimsy-muted"),
    Services.perms.UNKNOWN_ACTION,
    "and clears the saved choice"
  );
  const c = await open("https://example.com/three");
  ok(!c.hasAttribute("muted"), "New tabs on the site play again");
  for (const tab of [a, b, other, c]) {
    BrowserTestUtils.removeTab(tab);
  }
});

add_task(async function test_hand_mute_survives_and_about_pages() {
  const a = await open("https://example.com/");
  a.toggleMuteAudio();
  BrowserTestUtils.startLoadingURIString(a.linkedBrowser, "https://example.org/");
  await BrowserTestUtils.browserLoaded(a.linkedBrowser);
  ok(a.hasAttribute("muted"), "A tab muted by hand stays muted across sites");
  const blank = await open("about:blank");
  const menu = await openMenu(blank);
  ok(!item() || item().hidden, "No Mute Site on a page without a site");
  menu.hidePopup();
  BrowserTestUtils.removeTab(a);
  BrowserTestUtils.removeTab(blank);
});

add_task(async function test_switch_off() {
  await SpecialPowers.pushPrefEnv({ set: [["whimsy.feature.mute-site", false]] });
  const a = await open("https://example.com/");
  const menu = await openMenu(a);
  ok(!item() || item().hidden, "The switch hides Mute Site");
  const hidden = BrowserTestUtils.waitForPopupEvent(menu, "hidden");
  menu.hidePopup();
  await hidden;
  BrowserTestUtils.removeTab(a);
  await SpecialPowers.popPrefEnv();
});
