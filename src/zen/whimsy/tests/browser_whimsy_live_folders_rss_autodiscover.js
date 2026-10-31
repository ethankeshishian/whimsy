/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// RSS feed autodiscovery: adding an RSS live folder currently only works
// with a feed URL already in hand. Most sites advertise their feed on an
// ordinary page instead, via <link rel="alternate" type="application/
// rss+xml"> in <head> -- the same thing a browser's own "subscribe"
// button used to look for. A non-feed page given that link is upgraded to
// its advertised feed; a genuine feed, or a page advertising none, is
// returned unchanged (the caller falls back to using what was typed).

const { WhimsyLiveFolders } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyLiveFolders.sys.mjs");

const ROOT = getRootDirectory(gTestPath).replace("chrome://mochitests/content", "https://example.com");

add_task(async function test_discovers_the_advertised_feed() {
  const found = await WhimsyLiveFolders.discoverFeed(`${ROOT}whimsy_feed_page.html`);
  ok(found?.endsWith("whimsy_discovered_feed.xml"), "Finds the page's advertised feed URL");
});

add_task(async function test_no_feed_link_returns_null() {
  const found = await WhimsyLiveFolders.discoverFeed(`${ROOT}whimsy_no_feed_page.html`);
  is(found, null, "A page with no advertised feed returns null: the caller keeps the given URL");
});

add_task(async function test_already_a_feed_passes_through() {
  const found = await WhimsyLiveFolders.discoverFeed(`${ROOT}whimsy_discovered_feed.xml`);
  is(found, null, "Already a feed: nothing to discover, the caller keeps using it as-is");
});

add_task(async function test_switch_off_skips_discovery() {
  await SpecialPowers.pushPrefEnv({ set: [["whimsy.feature.live-folders-rss-autodiscover", false]] });
  ok(!WhimsyLiveFolders.rssAutodiscoverEnabled, "The switch is off");
  // wrapRssAutodiscovery's wrapper checks this same flag before ever
  // calling discoverFeed; promptForFeedUrl itself needs a real prompt
  // dialog to exercise end to end, so this is the flag it gates on.
  await SpecialPowers.popPrefEnv();
  ok(WhimsyLiveFolders.rssAutodiscoverEnabled, "and back on by default");
});

// wave9/secfix (security-full-1 L4): a page can't point a live folder's
// polling at a local file or the local network; the typed URL is used.
add_task(async function test_discovered_feed_must_be_public_http() {
  const page = href => "https://example.com/document-builder.sjs?html=" +
    encodeURIComponent(`<head><link rel="alternate" type="application/rss+xml" href="${href}"></head><body>Hi</body>`);
  is(await WhimsyLiveFolders.discoverFeed(page("file:///etc/hosts")), null, "Never a file: feed");
  is(await WhimsyLiveFolders.discoverFeed(page("http://192.168.1.1/feed.xml")), null, "Never the local network");
  is(await WhimsyLiveFolders.discoverFeed(page("http://localhost:631/feed")), null, "Never this machine");
  is(await WhimsyLiveFolders.discoverFeed(page("http://intranet/feed")), null, "Never a one-word intranet name");
  is(await WhimsyLiveFolders.discoverFeed(page("/feed.xml")), "https://example.com/feed.xml", "The page's own host is fine");
});
