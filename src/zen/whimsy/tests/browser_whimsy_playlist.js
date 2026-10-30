/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// Playlist v1 (whimsy.feature.playlist): save direct media files, download
// them into the profile for offline play, never from private browsing.

const { WhimsyPlaylist } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyPlaylist.sys.mjs");
const { WhimsyPrivate } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyPrivate.sys.mjs");

const ROOT = getRootDirectory(gTestPath).replace("chrome://mochitests/content", "https://example.com");
const PAGE = ROOT + "whimsy_video.html";
const VIDEO = ROOT + "whimsy_video.mp4";

const toasts = [];
const realToast = gZenUIManager.showToast;

add_setup(async function () {
  gZenUIManager.showToast = id => toasts.push(id);
  registerCleanupFunction(async () => {
    gZenUIManager.showToast = realToast;
    for (const item of await WhimsyPlaylist.list()) {
      await WhimsyPlaylist.remove(item.id);
    }
  });
});

async function waitForState(id, state) {
  await TestUtils.waitForCondition(async () => (await WhimsyPlaylist.get(id))?.state == state, `item becomes ${state}`);
  return WhimsyPlaylist.get(id);
}

add_task(async function test_save_and_download() {
  await BrowserTestUtils.withNewTab(PAGE, async browser => {
    toasts.length = 0;
    const item = await WhimsyPlaylist.add(window, { url: VIDEO, browser });
    ok(item, "The video was saved");
    is(item.type, "video", "It's a video");
    is(item.site, "example.com", "It remembers the site");
    ok(toasts.includes("whimsy-playlist-added-toast"), "A toast confirms it");

    const offline = await waitForState(item.id, "offline");
    ok(await IOUtils.exists(offline.file), "The file is in the profile");
    ok(offline.file.startsWith(WhimsyPlaylist.mediaDir), "under whimsy-playlist/");
    ok(WhimsyPlaylist.playbackURL(offline).startsWith("file:"), "It plays from the file");

    toasts.length = 0;
    const again = await WhimsyPlaylist.add(window, { url: VIDEO, browser });
    is(again.id, item.id, "Saving twice keeps one item");
    ok(toasts.includes("whimsy-playlist-exists-toast"), "and says it's already there");

    ok(await WhimsyPlaylist.remove(item.id), "Remove works");
    ok(!(await IOUtils.exists(offline.file)), "Removing deletes the file");
    is(await WhimsyPlaylist.get(item.id), null, "and the item");
  });
});

add_task(async function test_link_only_when_offline_off() {
  await SpecialPowers.pushPrefEnv({ set: [["whimsy.playlist.offline-download", false]] });
  await BrowserTestUtils.withNewTab(PAGE, async browser => {
    const item = await WhimsyPlaylist.add(window, { url: VIDEO + "?link", browser });
    // eslint-disable-next-line mozilla/no-arbitrary-setTimeout
    await new Promise(r => setTimeout(r, 300));
    is((await WhimsyPlaylist.get(item.id)).state, "link", "Stays a saved link");
    is(WhimsyPlaylist.playbackURL(item), VIDEO + "?link", "and plays from the web");
    await WhimsyPlaylist.remove(item.id);
  });
  await SpecialPowers.popPrefEnv();
});

add_task(async function test_unsupported_and_private() {
  toasts.length = 0;
  is(await WhimsyPlaylist.add(window, { url: "blob:https://example.com/x" }), null, "Streams (blob:) aren't saved");
  ok(toasts.includes("whimsy-playlist-unsupported-toast"), "and it says why");

  const tab = WhimsyPrivate.openPrivateTab(window, { url: PAGE });
  ok(tab, "A private tab opened");
  await BrowserTestUtils.browserLoaded(tab.linkedBrowser, false, PAGE);
  toasts.length = 0;
  is(await WhimsyPlaylist.add(window, { url: VIDEO + "?private", browser: tab.linkedBrowser }), null,
    "Nothing is saved from private browsing");
  ok(toasts.includes("whimsy-playlist-private-toast"), "and it says why");
  is((await WhimsyPlaylist.list()).length, 0, "The playlist is still empty");
  BrowserTestUtils.removeTab(tab);
});

add_task(async function test_context_menu_and_page_media() {
  await SpecialPowers.pushPrefEnv({ set: [["whimsy.playlist.offline-download", false]] });
  await BrowserTestUtils.withNewTab(PAGE, async browser => {
    const menu = document.getElementById("contentAreaContextMenu");
    let shown = BrowserTestUtils.waitForPopupEvent(menu, "shown");
    await BrowserTestUtils.synthesizeMouseAtCenter("#video", { type: "contextmenu", button: 2 }, browser);
    await shown;
    const item = document.getElementById("context-whimsy-save-playlist");
    ok(item && !item.hidden, "Save to Playlist is on the video menu");
    let hidden = BrowserTestUtils.waitForPopupEvent(menu, "hidden");
    menu.activateItem(item);
    await hidden;
    await TestUtils.waitForCondition(async () => (await WhimsyPlaylist.list()).some(i => i.url == VIDEO),
      "The video was saved from the menu");
    for (const i of await WhimsyPlaylist.list()) {
      await WhimsyPlaylist.remove(i.id);
    }

    // The command bar action finds the page's video through the page actor.
    const saved = await WhimsyPlaylist.saveFromPage(window);
    is(saved?.url, VIDEO, "Save Video to Playlist finds the page's video");
    await WhimsyPlaylist.remove(saved.id);

    // Switch off: no menu item.
    await SpecialPowers.pushPrefEnv({ set: [["whimsy.feature.playlist", false]] });
    shown = BrowserTestUtils.waitForPopupEvent(menu, "shown");
    await BrowserTestUtils.synthesizeMouseAtCenter("#video", { type: "contextmenu", button: 2 }, browser);
    await shown;
    ok(item.hidden, "No Save to Playlist with the switch off");
    hidden = BrowserTestUtils.waitForPopupEvent(menu, "hidden");
    menu.hidePopup();
    await hidden;
    await SpecialPowers.popPrefEnv();
  });
  await SpecialPowers.popPrefEnv();
});
