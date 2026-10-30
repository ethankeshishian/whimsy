/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

// batch hover: People cards. No real network: fetchProfile is stubbed.

const { WhimsyPeople } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyPeople.sys.mjs");
const { WhimsyHoverCard } = ChromeUtils.importESModule(
  "resource:///modules/whimsy/WhimsyHoverCard.sys.mjs"
);

add_task(async function profile_links_only() {
  for (const url of [
    "https://github.com/octocat",
    "https://www.linkedin.com/in/some-person",
    "https://x.com/someone",
    "https://twitter.com/someone/",
  ]) {
    ok(WhimsyPeople.profile(url), `Profile: ${url}`);
  }
  for (const url of [
    "https://github.com/octocat/hello-world",
    "https://github.com/settings",
    "https://x.com/home",
    "https://x.com/someone/status/1",
    "https://www.linkedin.com/company/example",
    "https://github.com.evil.test/octocat",
    "https://me@github.com/octocat",
    "http://github.com/octocat",
    "not a url",
  ]) {
    is(WhimsyPeople.profile(url), null, `Not a profile: ${url}`);
  }
  const fallback = WhimsyPeople.fallback("https://x.com/someone");
  is(fallback.title, "@someone", "Fallback card shows the handle");
  is(fallback.description, "X", "Fallback card names the site");
});

add_task(async function cache_rate_limit_container_and_private() {
  WhimsyPeople._resetForTests();
  await SpecialPowers.pushPrefEnv({ set: [["whimsy.feature.people-cards", true]] });
  const original = WhimsyPeople.fetchProfile;
  const seen = [];
  WhimsyPeople.fetchProfile = async (_win, url, userContextId) => {
    seen.push({ url, userContextId });
    return { title: "The Octocat", url, description: "GitHub mascot", image: null };
  };
  try {
    const url = "https://github.com/octocat";
    const first = await WhimsyPeople.lookup(window, url, { userContextId: 7 });
    is(first.title, "The Octocat", "Profile fetched");
    is(seen[0].userContextId, 7, "Fetched as the hovered tab's container");
    await WhimsyPeople.lookup(window, url, { userContextId: 7 });
    is(seen.length, 1, "A second hover uses the cache");
    is(
      await WhimsyPeople.lookup(window, url, { userContextId: 8 }),
      null,
      "Another container doesn't share the cache, and the 10 s spacing holds"
    );
    is(seen.length, 1, "Rate limit: no second request");
    is(
      await WhimsyPeople.lookup(window, url, { userContextId: 7, privateBrowsingId: 1 }),
      null,
      "Never in private browsing"
    );
    Services.prefs.setBoolPref("whimsy.feature.people-cards", false);
    is(await WhimsyPeople.lookup(window, url, { userContextId: 7 }), null, "Feature off: nothing, not even cache");
  } finally {
    WhimsyPeople.fetchProfile = original;
    WhimsyPeople._resetForTests();
    await SpecialPowers.popPrefEnv();
  }
});

add_task(async function parse_meta_only() {
  const html = `<html><head>
    <meta property="og:title" content="Jane Doe">
    <meta property="og:description" content="Engineer">
    <meta property="og:image" content="https://example.com/a.png">
    <script>window.top.location = "https://evil.test/"</script></head></html>`;
  const parsed = WhimsyPeople.parseProfile(window, html, "https://github.com/jane");
  is(parsed.title, "Jane Doe", "Name from og:title");
  is(parsed.description, "Engineer", "Headline from og:description");
  is(parsed.image, "https://example.com/a.png", "https avatar kept");
  is(
    WhimsyPeople.parseProfile(window, `<meta property="og:title" content="Sign in to LinkedIn">`, "https://linkedin.com/in/x"),
    null,
    "A login wall is no card"
  );
});

add_task(async function hover_in_page_shows_card() {
  WhimsyPeople._resetForTests();
  await SpecialPowers.pushPrefEnv({ set: [["whimsy.feature.people-cards", true]] });
  const original = WhimsyPeople.fetchProfile;
  let fetches = 0;
  WhimsyPeople.fetchProfile = async (_win, url) => {
    ++fetches;
    return { title: "The Octocat", url, description: "GitHub mascot", image: null };
  };
  const card = WhimsyHoverCard.forWindow(window);
  try {
    // The actor matches web pages only (not data:), so use the test server.
    await BrowserTestUtils.withNewTab(
      "https://example.com/browser/",
      async browser => {
        await SpecialPowers.spawn(browser, [], () => {
          content.document.body.innerHTML = `
            <p><a id="o" href="https://example.com/">other</a></p>
            <p><a id="r" href="https://github.com/octocat/repo">repo</a></p>
            <p><a id="p" href="https://github.com/octocat">octocat</a></p>`;
        });
        // A plain link and a repo link: never a card or a fetch.
        for (const id of ["o", "r"]) {
          await BrowserTestUtils.synthesizeMouseAtCenter(`#${id}`, { type: "mousemove" }, browser);
        }
        await new Promise(resolve => setTimeout(resolve, WhimsyHoverCard.ENTER_DELAY_MS + 200)); // eslint-disable-line mozilla/no-arbitrary-setTimeout
        ok(!card.panel || card.panel.state == "closed", "Non-profile links: no card");
        is(fetches, 0, "Non-profile links: no request");

        await BrowserTestUtils.synthesizeMouseAtCenter("#p", { type: "mousemove" }, browser);
        await TestUtils.waitForCondition(() => card.panel?.state == "open", "Profile link: card opens");
        await TestUtils.waitForCondition(
          () => card.panel.querySelector(".whimsy-person-name")?.textContent == "The Octocat",
          "Card shows the name once loaded");
        is(card.panel.querySelector(".whimsy-person-handle").textContent, "@octocat · GitHub", "...the handle and site");
        is(card.panel.querySelector(".whimsy-person-bio").textContent, "GitHub mascot", "...and the bio");
        is(card.panel.getAttribute("role"), "dialog", "A card with actions is a dialog");
        is(card.panel.getAttribute("aria-label"), "The Octocat", "...named after the person");
        is(card.panel.querySelectorAll(".whimsy-person-action").length, 2, "Open Profile and Copy Link");
        is(fetches, 1, "One request for one deliberate hover");
      }
    );
  } finally {
    card.hide();
    WhimsyPeople.fetchProfile = original;
    WhimsyPeople._resetForTests();
    await SpecialPowers.popPrefEnv();
  }
});

// fix7/tabs: the card's content, from each site's meta tags.
add_task(function card_model() {
  const github = WhimsyPeople.card({
    title: "monalisa (Mona Lisa Octocat) · GitHub",
    description: "monalisa has 8 repositories available. Follow their code on GitHub.",
    image: "https://avatars.example/m.png",
  }, "https://github.com/monalisa");
  is(github.name, "Mona Lisa Octocat", "GitHub: the name, not the handle or site");
  is(github.handle, "@monalisa", "...the handle");
  is(github.site, "GitHub", "...the site");
  is(github.bio, null, "...no boilerplate bio");
  Assert.deepEqual(github.stats, [{ value: "8", label: "repositories" }], "...the count it mentions");
  is(github.initials, "ML", "...initials for a missing avatar");

  const linkedin = WhimsyPeople.card({
    title: "Jane Doe - Staff Engineer - Acme | LinkedIn",
    description: "Experience: Acme · 500+ connections on LinkedIn.",
  }, "https://linkedin.com/in/jane");
  is(linkedin.name, "Jane Doe", "LinkedIn: the name");
  ok(linkedin.bio.startsWith("Staff Engineer · Acme"), "...the headline leads the bio");
  ok(!linkedin.bio.includes("connections"), "...without the connections line");
  Assert.deepEqual(linkedin.stats, [{ value: "500+", label: "connections" }], "...which becomes a stat");

  const x = WhimsyPeople.card({ title: "Sam (@sam) / X", description: "Building things." }, "https://x.com/sam");
  is(x.name, "Sam", "X: a name that matches the handle is still the name");

  const loading = WhimsyPeople.card(null, "https://x.com/sam", { loading: true });
  is(loading.name, "@sam", "Loading: the handle stands in");
  ok(loading.loading, "...marked loading");
});

// fix7/tabs: Arc-like dwell. The card appears ~400ms after the pointer
// rests (the handle at once, the profile when it arrives), and leaving
// before then cancels it.
add_task(async function dwell_placeholder_and_cancel() {
  Assert.lessOrEqual(WhimsyHoverCard.PEOPLE_DELAY_MS, 500, "People cards open within 500ms");
  Assert.greaterOrEqual(WhimsyHoverCard.PEOPLE_DELAY_MS, 300, "...but not on a pass-over");
  await SpecialPowers.pushPrefEnv({ set: [["whimsy.feature.people-cards", true]] });
  const card = WhimsyHoverCard.forWindow(window);
  const anchor = gBrowser.selectedBrowser;
  const url = "https://github.com/octocat";
  let resolve;
  const placeholder = { person: WhimsyPeople.card(null, url, { loading: true }) };
  try {
    card.schedule(anchor, () => new Promise(r => (resolve = r)), "whimsy.feature.people-cards",
      { delay: WhimsyHoverCard.PEOPLE_DELAY_MS, placeholder });
    await TestUtils.waitForCondition(() => card.panel?.state == "open", "The placeholder opens after the dwell");
    ok(card.panel.querySelector(".whimsy-person[loading]"), "...as a loading card");
    is(card.panel.querySelector(".whimsy-person-name").textContent, "@octocat", "...with the handle");
    resolve({ person: WhimsyPeople.card({ title: "The Octocat", description: "Mascot" }, url) });
    await TestUtils.waitForCondition(
      () => card.panel.querySelector(".whimsy-person-name")?.textContent == "The Octocat",
      "...filled in where it is");
    ok(!card.panel.querySelector(".whimsy-person[loading]"), "...no longer loading");
    card.hide();

    let loads = 0;
    card.schedule(anchor, async () => {
      loads++;
      return placeholder;
    }, "whimsy.feature.people-cards", { delay: WhimsyHoverCard.PEOPLE_DELAY_MS, placeholder });
    card.leave(anchor);
    await new Promise(r => setTimeout(r, WhimsyHoverCard.PEOPLE_DELAY_MS + 200)); // eslint-disable-line mozilla/no-arbitrary-setTimeout
    is(loads, 0, "Leaving before the dwell cancels the card");
    ok(card.panel.state == "closed", "...and nothing opens");
  } finally {
    card.hide();
    await SpecialPowers.popPrefEnv();
  }
});
