/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// wave9/mini W8-28: hover link cards.
// - Timing: the card waits long enough for the pointer to cross from the
//   link to it; links crossed on the way don't replace it (the hover
//   bridge); the page's late mouseout never closes it under the pointer;
//   the same person under another URL spelling keeps the same card.
// - Details: X and a signed-in LinkedIn give few og: tags, so each field
//   falls back to twitter: tags, schema.org JSON-LD, <title> and oEmbed;
//   on the profile's own site the hovered link's name and photo fill in.
// No real network: fetchProfile / fetchText are stubbed.

const { WhimsyPeople } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyPeople.sys.mjs");
const { WhimsyLinkHover } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyLinkHover.sys.mjs");

const wait = ms => new Promise(resolve => setTimeout(resolve, ms)); // eslint-disable-line mozilla/no-arbitrary-setTimeout
const panel = () => document.getElementById(WhimsyLinkHover.PANEL_ID);
const personName = () => panel()?.querySelector('[data-card="people"] .whimsy-person-name')?.textContent;

let originalFetch;
add_setup(async function () {
  await SimpleTest.promiseFocus(window);
  await SpecialPowers.pushPrefEnv({
    set: [
      ["whimsy.feature.people-cards", true],
      ["whimsy.feature.link-previews", false],
    ],
  });
  originalFetch = WhimsyPeople.fetchProfile;
  WhimsyPeople.fetchProfile = async (_win, url) => ({
    title: { "https://github.com/octocat": "The Octocat" }[url] ?? null,
    url,
    description: null,
    image: null,
  });
  registerCleanupFunction(() => {
    WhimsyLinkHover.forWindow(window).hide({ animate: false });
    WhimsyPeople.fetchProfile = originalFetch;
    WhimsyPeople._resetForTests();
  });
});

function at(offset = 0) {
  return { x: window.mozInnerScreenX + 200, y: window.mozInnerScreenY + 150 + offset, width: 80, height: 18 };
}

async function showOctocat(host) {
  WhimsyPeople._resetForTests();
  host.enter({ source: "people", browser: gBrowser.selectedBrowser, url: "https://github.com/octocat", how: "hover", ...at() });
  await TestUtils.waitForCondition(() => panel()?.state == "open", "The card opens");
  await TestUtils.waitForCondition(() => personName() == "The Octocat", "...for the Octocat");
  await TestUtils.waitForCondition(() => panel().hasAttribute("whimsy-open"), "...and has finished appearing");
}

// Takes the pointer off the card, so a card reopening in the same place
// doesn't start under it.
async function moveAway(host) {
  EventUtils.synthesizeMouse(document.documentElement, 2, 2, { type: "mousemove" });
  await TestUtils.waitForCondition(() => !host.overPanel, "Pointer off the card");
}

async function closeCard(host) {
  await moveAway(host);
  host.hide({ animate: false });
  await TestUtils.waitForCondition(() => !panel() || panel().state == "closed", "Card closed");
}

add_task(async function test_grace_covers_the_trip_to_the_card() {
  Assert.greaterOrEqual(WhimsyLinkHover.LEAVE_GRACE_MS, 300, "Time to cross from the link to the card");
  const host = WhimsyLinkHover.forWindow(window);
  await showOctocat(host);
  host.leave(gBrowser.selectedBrowser);
  await wait(200);
  is(panel().state, "open", "Leaving the link doesn't close the card at once (180ms used to)");
  await TestUtils.waitForCondition(() => panel().state == "closed", "...it closes after the grace period");
});

add_task(async function test_links_crossed_on_the_way_dont_replace_the_card() {
  const host = WhimsyLinkHover.forWindow(window);
  await showOctocat(host);
  // Down from the link toward the card, over another person's link.
  host.leave(gBrowser.selectedBrowser);
  host.enter({ source: "people", browser: gBrowser.selectedBrowser, url: "https://github.com/monalisa", how: "hover", ...at(20) });
  is(panel().state, "open", "Crossing another link keeps the card");
  is(personName(), "The Octocat", "...showing the same person");
  host.leave(gBrowser.selectedBrowser);
  // The pointer reaches the card.
  EventUtils.synthesizeMouseAtCenter(panel().querySelector('[data-card="people"]'), { type: "mousemove" });
  await TestUtils.waitForCondition(() => host.overPanel, "Pointer on the card");
  await wait(WhimsyLinkHover.ENTER_DELAY_MS + WhimsyLinkHover.LEAVE_GRACE_MS + 100);
  is(panel().state, "open", "The card stays while the pointer is on it");
  is(personName(), "The Octocat", "...and the crossed link never took over");
  ok(!host.pending, "Nothing is waiting to replace it");
  await closeCard(host);
});

add_task(async function test_late_mouseout_never_closes_the_card_under_the_pointer() {
  const host = WhimsyLinkHover.forWindow(window);
  await showOctocat(host);
  EventUtils.synthesizeMouseAtCenter(panel().querySelector('[data-card="people"]'), { type: "mousemove" });
  await TestUtils.waitForCondition(() => host.overPanel, "Pointer on the card");
  // The page's mouseout for the link arrives over IPC after that.
  host.leave(gBrowser.selectedBrowser);
  await wait(WhimsyLinkHover.LEAVE_GRACE_MS + 150);
  is(panel().state, "open", "The card stays under the pointer");
  await closeCard(host);
});

add_task(async function test_resting_on_another_link_switches_cards() {
  const host = WhimsyLinkHover.forWindow(window);
  await showOctocat(host);
  host.leave(gBrowser.selectedBrowser);
  host.enter({ source: "people", browser: gBrowser.selectedBrowser, url: "https://github.com/monalisa", how: "hover", ...at(40) });
  ok(host.pending, "The other link waits its turn");
  await TestUtils.waitForCondition(
    () => panel()?.state == "open" && panel().querySelector(".whimsy-person-handle")?.textContent.includes("monalisa"),
    "Resting on the other link for the delay shows its card"
  );
  ok(!host.pending, "...and nothing is left waiting");
  await closeCard(host);
});

add_task(async function test_same_person_other_spelling_keeps_the_card() {
  const host = WhimsyLinkHover.forWindow(window);
  await showOctocat(host);
  host.leave(gBrowser.selectedBrowser);
  host.enter({ source: "people", browser: gBrowser.selectedBrowser, url: "https://www.github.com/octocat/", how: "hover", ...at(20) });
  ok(!host.pending, "The same profile under another URL isn't a new card");
  await wait(WhimsyLinkHover.LEAVE_GRACE_MS + 150);
  is(panel().state, "open", "...and it cancelled the leave");
  await closeCard(host);
});

add_task(async function test_keys_cancel_a_waiting_card() {
  const host = WhimsyLinkHover.forWindow(window);
  await showOctocat(host);
  host.enter({ source: "people", browser: gBrowser.selectedBrowser, url: "https://github.com/monalisa", how: "hover", ...at(20) });
  ok(host.pending, "Waiting");
  EventUtils.synthesizeKey("KEY_Escape");
  await TestUtils.waitForCondition(() => panel().state == "closed", "Esc closes the card");
  ok(!host.pending, "...and drops the waiting one");
  await wait(WhimsyLinkHover.ENTER_DELAY_MS + 100);
  is(panel().state, "closed", "Nothing opens afterwards");
});

add_task(async function test_metadata_fallbacks() {
  const parse = html => WhimsyPeople.parseProfile(window, html, "https://x.com/jane");
  let found = parse(`<head>
    <meta name="twitter:title" content="Jane Doe (@jane) / X">
    <meta name="twitter:description" content="Builds things">
    <meta name="twitter:image" content="https://pbs.twimg.com/profile_images/1/a.jpg"></head>`);
  is(found?.title, "Jane Doe (@jane) / X", "Name from twitter:title when og: is missing");
  is(found.description, "Builds things", "Bio from twitter:description");
  is(found.image, "https://pbs.twimg.com/profile_images/1/a.jpg", "Photo from twitter:image");
  is(WhimsyPeople.card(found, "https://x.com/jane").name, "Jane Doe", "The card shows just the name");

  found = WhimsyPeople.parseProfile(window, `<head><title>LinkedIn</title>
    <script type="application/ld+json">{"@context":"http://schema.org","@graph":[
      {"@type":"WebPage","name":"x"},
      {"@type":"Person","name":"Jane Doe","jobTitle":["Engineer at Example"],
       "image":{"@type":"ImageObject","contentUrl":"https://media.licdn.com/dms/image/a.jpg"}}]}</script>
    <script type="application/ld+json">not json</script></head>`, "https://linkedin.com/in/jane-doe");
  is(found?.title, "Jane Doe", "Name from the page's schema.org Person (JSON-LD)");
  is(found.description, "Engineer at Example", "Headline from its jobTitle");
  is(found.image, "https://media.licdn.com/dms/image/a.jpg", "Photo from its image");

  found = WhimsyPeople.parseProfile(window, `<head><title>(3) Jane Doe | LinkedIn</title></head>`,
    "https://linkedin.com/in/jane-doe");
  is(WhimsyPeople.card(found, "https://linkedin.com/in/jane-doe").name, "Jane Doe",
    "A signed-in <title> works too, without the unread count");

  is(parse(`<head><title>X</title></head>`), null, "X's app shell names no one");
  is(parse(`<head><meta property="og:title" content="Log in to X / X"></head>`), null, "A login wall is no card");
  const meta = WhimsyPeople.parseMeta(window, `<head><title>X</title>
    <link rel="alternate" type="application/json+oembed" href="https://x.com/oembed?url=jane"></head>`);
  is(meta.oembed, "https://x.com/oembed?url=jane", "The page's oEmbed endpoint is found");
});

add_task(async function test_oembed_fallback() {
  const original = WhimsyPeople.fetchText;
  const requested = [];
  WhimsyPeople.fetchText = async (_win, url) => {
    requested.push(url);
    if (url.startsWith("https://x.com/jane")) {
      return { text: `<head><title>X</title><link rel="alternate" type="application/json+oembed" href="https://x.com/oembed?u=jane"></head>` };
    }
    return { text: JSON.stringify({ author_name: "Jane Doe", thumbnail_url: "https://pbs.twimg.com/a.jpg" }) };
  };
  try {
    const found = await originalFetch.call(WhimsyPeople, window, "https://x.com/jane", 0);
    is(found?.title, "Jane Doe", "oEmbed's author_name names the person");
    is(found.image, "https://pbs.twimg.com/a.jpg", "...and its thumbnail is the photo");
    requested.length = 0;
    is(await WhimsyPeople.fetchOEmbed(window, "https://evil.test/oembed", "https://x.com/jane", 0), null,
      "An endpoint on another site is never fetched");
    is(requested.length, 0, "...no request at all");
  } finally {
    WhimsyPeople.fetchText = original;
  }
});

add_task(async function test_link_context_on_the_profiles_own_site() {
  const linkedIn = "https://linkedin.com/in/jane-doe";
  let context = WhimsyPeople.pageContext(linkedIn, "www.linkedin.com", {
    name: "Jane Doe\nEngineer at Example\n• 2nd",
    image: "https://media.licdn.com/dms/image/a.jpg",
  });
  is(context?.title, "Jane Doe", "On LinkedIn, the link's first line is the name");
  is(context.image, "https://media.licdn.com/dms/image/a.jpg", "...and its photo comes from LinkedIn's CDN");
  context = WhimsyPeople.pageContext(linkedIn, "www.linkedin.com", { name: "Jane", image: "https://evil.test/a.jpg" });
  is(context.image, null, "A photo from anywhere else is dropped");
  is(WhimsyPeople.pageContext(linkedIn, "example.com", { name: "Someone Else" }), null,
    "Another site can't put a name on someone's profile");
  is(WhimsyPeople.pageContext("https://x.com/jane", "twitter.com", { name: "Jane Doe" })?.title, "Jane Doe",
    "twitter.com and x.com are one site");
  is(WhimsyPeople.pageContext(linkedIn, "www.linkedin.com", { name: "View Jane’s profile" }), null,
    "A link that only says View… isn't a name");
  const merged = WhimsyPeople.merge({ title: "Jane Doe", url: linkedIn, description: "Bio", image: null },
    { title: "Jane", url: linkedIn, description: null, image: "https://media.licdn.com/a.jpg" });
  is(merged.title, "Jane Doe", "The lookup's name wins");
  is(merged.image, "https://media.licdn.com/a.jpg", "...the link's photo fills a gap");
});

add_task(async function test_card_shows_link_context_at_once() {
  const host = WhimsyLinkHover.forWindow(window);
  WhimsyPeople._resetForTests();
  const original = WhimsyPeople.fetchProfile;
  WhimsyPeople.fetchProfile = async () => null;
  try {
    host.enter({
      source: "people",
      browser: gBrowser.selectedBrowser,
      url: "https://x.com/jane",
      how: "hover",
      ...at(),
      context: { title: "Jane Doe", url: "https://x.com/jane", description: null, image: null },
    });
    await TestUtils.waitForCondition(() => panel()?.state == "open", "The card opens");
    is(personName(), "Jane Doe", "The link's own name shows at once");
    await TestUtils.waitForCondition(() => !panel().querySelector(".whimsy-person[loading]"), "Lookup done");
    is(personName(), "Jane Doe", "...and stays when X gives nothing (no empty card)");
    is(panel().querySelector(".whimsy-person-handle").textContent, "@jane · X", "...with the handle and site");
  } finally {
    WhimsyPeople.fetchProfile = original;
    await closeCard(host);
  }
});
