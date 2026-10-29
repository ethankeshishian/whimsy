/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// Audio, mic and camera indicators: Firefox and Zen already show them on
// vertical tabs, with the sidebar collapsed, and on Essentials. This checks
// each place, and that clicking the audio indicator mutes the tab without
// switching to it.

const startTabs = new Set(gBrowser.tabs);
registerCleanupFunction(async () => {
  if (Services.prefs.prefHasUserValue("zen.view.sidebar-expanded")) {
    Services.prefs.clearUserPref("zen.view.sidebar-expanded");
  }
  for (const tab of gBrowser.tabs.filter(t => !startTabs.has(t))) {
    if (tab.hasAttribute("zen-essential")) {
      gZenPinnedTabManager.removeEssentials(tab);
    }
    BrowserTestUtils.removeTab(tab);
  }
});

function shown(el) {
  if (!el) {
    return false;
  }
  const rect = el.getBoundingClientRect();
  return window.getComputedStyle(el).display != "none" && rect.width > 0 && rect.height > 0;
}

const settle = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));

async function setExpanded(expanded) {
  Services.prefs.setBoolPref("zen.view.sidebar-expanded", expanded);
  await TestUtils.waitForCondition(
    () => document.getElementById("navigator-toolbox").hasAttribute("zen-sidebar-expanded") == expanded,
    `Sidebar ${expanded ? "expanded" : "collapsed"}`
  );
  await settle();
}

add_task(async function test_indicators() {
  const open = url => BrowserTestUtils.openNewForegroundTab(gBrowser, url);
  const camera = await open("https://example.com/?camera");
  const mic = await open("https://example.com/?mic");
  const audio = await open("https://example.com/?audio");
  const pinned = await open("https://example.com/?pinned");
  const essential = await open("https://example.com/?essential");
  gBrowser.pinTab(pinned);
  gZenPinnedTabManager.addToEssentials(essential);
  await TestUtils.waitForCondition(() => essential.hasAttribute("zen-essential"), "An Essential");
  const home = await open("https://example.org/");
  gBrowser.updateBrowserSharing(camera.linkedBrowser, { webRTC: { sharing: "camera" } });
  gBrowser.updateBrowserSharing(mic.linkedBrowser, { webRTC: { sharing: "microphone" } });
  for (const tab of [audio, pinned, essential]) {
    tab.setAttribute("soundplaying", "true");
  }
  await settle();

  // Expanded sidebar: a speaker button beside the title; sharing icons
  // replace the favicon; on an Essential tile, the overlay on its icon.
  ok(shown(audio.audioButton), "Expanded: a playing tab shows its speaker");
  ok(shown(pinned.audioButton), "and so does a playing pinned tab");
  ok(shown(essential.overlayIcon), "A playing Essential shows the speaker on its tile");
  is(camera.getAttribute("sharing"), "camera", "The camera tab is marked as sharing");
  ok(shown(camera.sharingIcon), "and shows the camera icon");
  ok(shown(mic.sharingIcon), "The microphone tab shows the mic icon");

  // Collapsed sidebar: every indicator still shows on the icon.
  await setExpanded(false);
  for (const [name, tab] of Object.entries({ audio, pinned, essential })) {
    ok(shown(tab.overlayIcon), `Collapsed: ${name} shows the speaker on its icon`);
  }
  ok(shown(camera.sharingIcon), "Collapsed: the camera icon shows");
  ok(shown(mic.sharingIcon), "Collapsed: the mic icon shows");

  // Clicking the speaker mutes the tab, without switching to it.
  EventUtils.synthesizeMouseAtCenter(audio.overlayIcon, {});
  await TestUtils.waitForCondition(() => audio.hasAttribute("muted"), "Clicking the speaker mutes the tab");
  is(gBrowser.selectedTab, home, "without switching to it");
  EventUtils.synthesizeMouseAtCenter(essential.overlayIcon, {});
  await TestUtils.waitForCondition(() => essential.hasAttribute("muted"), "Clicking an Essential's speaker mutes it");
  is(gBrowser.selectedTab, home, "also without switching");
  await setExpanded(true);

  // Expanded again: the muted speaker stays, and a click unmutes.
  ok(shown(audio.audioButton), "A muted tab keeps its (muted) speaker");
  EventUtils.synthesizeMouseAtCenter(audio.audioButton, {});
  await TestUtils.waitForCondition(() => !audio.hasAttribute("muted"), "Clicking it again unmutes");

  // Sharing stops: the icon goes.
  gBrowser.updateBrowserSharing(camera.linkedBrowser, { webRTC: { sharing: null } });
  await settle();
  ok(!camera.hasAttribute("sharing"), "Sharing stopped");
  ok(!shown(camera.sharingIcon), "and the camera icon is gone");
});
