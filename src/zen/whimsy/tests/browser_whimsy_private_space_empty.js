/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// W10-09: the Private Space has no new tab page. Cmd+Shift+N opens it empty
// and creates no tab; the content area shows Whimsy's logo, what the space
// does and New Private Tab. Closing its last tab brings that back instead of
// closing the space; leaving it with no tabs closes it.

const { WhimsyPrivate } = ChromeUtils.importESModule(
  "resource:///modules/whimsy/WhimsyPrivate.sys.mjs"
);

const PAGE = "https://example.com/browser/";

function emptyState() {
  return document.getElementById("whimsy-private-empty");
}

function shown() {
  const el = emptyState();
  return !!el && !el.hidden && el.isConnected && el.getBoundingClientRect().width > 0;
}

function tabsIn(space) {
  return gZenWorkspaces.allStoredTabs.filter(
    tab => !tab.closing && tab.getAttribute("zen-workspace-id") == space.uuid &&
      !tab.hasAttribute("zen-empty-tab") && !tab.hasAttribute("zen-essential")
  );
}

let startSpace;

add_setup(async function () {
  startSpace = gZenWorkspaces.activeWorkspace;
  registerCleanupFunction(async () => {
    await WhimsyPrivate.closeScratch(window);
    if (gZenWorkspaces.activeWorkspace != startSpace) {
      await gZenWorkspaces.changeWorkspaceWithID(startSpace);
    }
  });
});

add_task(async function cmd_shift_n_opens_it_empty_with_no_tab() {
  const before = gBrowser.tabs.length;
  EventUtils.synthesizeKey("n", { accelKey: true, shiftKey: true });
  await TestUtils.waitForCondition(() => WhimsyPrivate.activeSpaceIsScratch(window), "The Private Space shows");
  const space = WhimsyPrivate.getScratch(window);
  is(tabsIn(space).length, 0, "No tab was created in it");
  is(gBrowser.tabs.length, before, "No tab anywhere");
  ok(gBrowser.selectedTab.hasAttribute("zen-empty-tab"), "Zen's empty tab is selected");
  ok(!gBrowser.tabs.some(t => t.linkedBrowser?.currentURI?.spec == "about:privatebrowsing"), "No private new tab page");

  await TestUtils.waitForCondition(shown, "The empty state shows");
  const el = emptyState();
  ok(document.documentElement.hasAttribute("whimsy-private-space-empty"), "The window knows");
  is(el.parentNode, gBrowser.selectedBrowser.closest(".browserStack"), "It's in the page's own place");
  const stack = el.parentNode.getBoundingClientRect();
  const box = el.getBoundingClientRect();
  ok(Math.abs(box.width - stack.width) < 1 && Math.abs(box.height - stack.height) < 1, "It fills the content area");

  await document.l10n.translateFragment(el);
  is(el.querySelector("h1").textContent, "Private Space", "Its title");
  ok(el.querySelector(".whimsy-private-empty-body").textContent.length > 20, "One sentence on what it does");
  const mark = el.querySelector(".whimsy-private-empty-mark");
  ok(getComputedStyle(mark, "::before").backgroundImage.includes("whimsy-mono.svg"), "Whimsy's balloon");
  const button = el.querySelector(".whimsy-private-empty-new");
  is(button.textContent.includes("New Private Tab"), true, "New Private Tab");
  ok(el.querySelector(".whimsy-private-empty-key").textContent, "…with its shortcut");
  is(el.getAttribute("role"), "region", "A labelled region for VoiceOver");
  is(document.getElementById(el.getAttribute("aria-labelledby")), el.querySelector("h1"), "…named by its title");
  ok(gURLBar.isPrivate, "The address bar over it is private");
});

add_task(async function new_private_tab_opens_the_private_bar_and_esc_leaves_nothing() {
  const space = WhimsyPrivate.getScratch(window);
  emptyState().querySelector(".whimsy-private-empty-new").click();
  await TestUtils.waitForCondition(() => gURLBar.focused && gURLBar.hasAttribute("whimsy-private"),
    "The private command bar opened");
  EventUtils.synthesizeKey("KEY_Escape");
  if (gURLBar.focused) {
    EventUtils.synthesizeKey("KEY_Escape");
  }
  await TestUtils.waitForCondition(() => !gURLBar.hasAttribute("zen-newtab"), "The bar closed");
  is(tabsIn(space).length, 0, "Esc created nothing");
  ok(shown(), "The empty state is still there");
});

add_task(async function closing_the_last_tab_brings_the_empty_state_back() {
  const space = WhimsyPrivate.getScratch(window);
  const tab = WhimsyPrivate.openPrivateTab(window, { url: PAGE });
  await BrowserTestUtils.browserLoaded(tab.linkedBrowser, false, PAGE);
  is(tab.getAttribute("zen-workspace-id"), space.uuid, "A private tab in the Private Space");
  await TestUtils.waitForCondition(() => !shown(), "The empty state goes while a page shows");
  ok(!document.documentElement.hasAttribute("whimsy-private-space-empty"), "…and the window knows");

  BrowserTestUtils.removeTab(tab);
  await TestUtils.waitForCondition(shown, "Closing the last tab shows the empty state again");
  await new Promise(resolve => setTimeout(resolve, 300));
  is(WhimsyPrivate.getScratch(window)?.uuid, space.uuid, "The space is never closed from under you");
});

add_task(async function leaving_it_empty_closes_it() {
  const space = WhimsyPrivate.getScratch(window);
  await gZenWorkspaces.changeWorkspaceWithID(startSpace);
  await TestUtils.waitForCondition(() => !WhimsyPrivate.getScratch(window), "Leaving it empty closes it");
  ok(!gZenWorkspaces.getWorkspaces().some(s => s.uuid == space.uuid), "The space is gone");
  ok(!shown(), "No empty state elsewhere");
  ok(!document.documentElement.hasAttribute("whimsy-private-space-empty"), "The window attribute went");
});

add_task(async function leaving_it_with_tabs_keeps_it() {
  const space = await WhimsyPrivate.openScratch(window, { withTab: true });
  const tab = gBrowser.selectedTab;
  ok(WhimsyPrivate.isPrivateTab(tab), "A private tab");
  await gZenWorkspaces.changeWorkspaceWithID(startSpace);
  await new Promise(resolve => setTimeout(resolve, 300));
  is(WhimsyPrivate.getScratch(window)?.uuid, space.uuid, "A Private Space with tabs stays when you leave");
  // Its last tab closed from elsewhere (it's in the background): it goes.
  BrowserTestUtils.removeTab(tab);
  await TestUtils.waitForCondition(() => !WhimsyPrivate.getScratch(window), "Emptied in the background, it closes");
});

add_task(async function reduced_motion_just_appears() {
  await SpecialPowers.pushPrefEnv({ set: [["ui.prefersReducedMotion", 1]] });
  await WhimsyPrivate.openScratch(window);
  await TestUtils.waitForCondition(shown, "The empty state shows");
  is(getComputedStyle(emptyState().querySelector(".whimsy-private-empty-card")).animationName, "none",
    "No fade with reduced motion");
  await SpecialPowers.popPrefEnv();
  await gZenWorkspaces.changeWorkspaceWithID(startSpace);
  await TestUtils.waitForCondition(() => !WhimsyPrivate.getScratch(window), "Closed on leaving");
});

add_task(async function switch_off_shows_nothing() {
  await SpecialPowers.pushPrefEnv({ set: [["whimsy.feature.scratch", false]] });
  is(await WhimsyPrivate.openScratch(window), null, "No Private Space with the switch off");
  ok(!shown(), "No empty state");
  await SpecialPowers.popPrefEnv();
});

add_task(async function cmd_shift_n_again_is_new_private_tab() {
  await WhimsyPrivate.openScratch(window);
  await TestUtils.waitForCondition(shown, "On its empty state");
  EventUtils.synthesizeKey("n", { accelKey: true, shiftKey: true });
  await TestUtils.waitForCondition(() => gURLBar.focused && gURLBar.hasAttribute("whimsy-private"),
    "Pressed again in the Private Space, it opens the private command bar");
  EventUtils.synthesizeKey("KEY_Escape");
  if (gURLBar.focused) {
    EventUtils.synthesizeKey("KEY_Escape");
  }
  await TestUtils.waitForCondition(() => !gURLBar.hasAttribute("zen-newtab"), "The bar closed");
  await gZenWorkspaces.changeWorkspaceWithID(startSpace);
  await TestUtils.waitForCondition(() => !WhimsyPrivate.getScratch(window), "Closed on leaving");
});
