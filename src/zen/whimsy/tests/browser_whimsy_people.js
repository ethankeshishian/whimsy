/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

// batch hover: People cards. No real network: fetchProfile is stubbed.

const { WhimsyPeople } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyPeople.sys.mjs");
const { WhimsyLinkHover } = ChromeUtils.importESModule(
  "resource:///modules/whimsy/WhimsyLinkHover.sys.mjs"
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
  // wave7/ux: People cards are card 1 of the link hover host.
  const host = WhimsyLinkHover.forWindow(window);
  const panel = () => document.getElementById(WhimsyLinkHover.PANEL_ID);
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
        await new Promise(resolve => setTimeout(resolve, WhimsyLinkHover.ENTER_DELAY_MS + 200)); // eslint-disable-line mozilla/no-arbitrary-setTimeout
        ok(!panel() || panel().state == "closed", "Non-profile links: no card");
        is(fetches, 0, "Non-profile links: no request");

        await BrowserTestUtils.synthesizeMouseAtCenter("#p", { type: "mousemove" }, browser);
        await TestUtils.waitForCondition(() => panel()?.state == "open", "Profile link: card opens");
        await TestUtils.waitForCondition(
          () => panel().querySelector('[data-card="people"] .whimsy-hover-title')?.textContent == "The Octocat",
          "Card shows the name"
        );
        is(fetches, 1, "One request for one deliberate hover");
      }
    );
  } finally {
    host.hide({ animate: false });
    WhimsyPeople.fetchProfile = original;
    WhimsyPeople._resetForTests();
    await SpecialPowers.popPrefEnv();
  }
});
