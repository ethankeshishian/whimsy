/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// home: Whimsy's homepage (about:whimsy) and its Changelog tab
// (about:whimsy?tab=changelog), replacing Zen's about:home. Covers the
// WhimsyProtocol routes, both tabs' content, the changelog rendering a
// real entry, and whimsy.feature.home off falling back to about:home.

const { WhimsyProtocol } = ChromeUtils.importESModule(
  "resource:///modules/whimsy/WhimsyProtocol.sys.mjs"
);

add_setup(async function () {
  await SpecialPowers.pushPrefEnv({ set: [["whimsy.feature.home", true]] });
});

add_task(function test_routes() {
  is(WhimsyProtocol.route("whimsy://home").url, "about:whimsy", "whimsy://home routes to about:whimsy");
  is(
    WhimsyProtocol.route("whimsy://changelog").url,
    "about:whimsy?tab=changelog",
    "whimsy://changelog routes to the Changelog tab"
  );
});

add_task(async function test_home_tab_content() {
  await BrowserTestUtils.withNewTab("about:whimsy", async browser => {
    await SpecialPowers.spawn(browser, [], async () => {
      const doc = content.document;
      await ContentTaskUtils.waitForCondition(
        () => doc.getElementById("whimsy-home-link-settings"),
        "Home page finished rendering"
      );

      is(
        doc.getElementById("whimsy-tab-home").getAttribute("aria-selected"),
        "true",
        "The Home tab is selected by default"
      );
      is(
        doc.getElementById("whimsy-panel-changelog").hidden,
        true,
        "The Changelog panel starts hidden"
      );

      const links = {
        settings: doc.getElementById("whimsy-home-link-settings"),
        shortcuts: doc.getElementById("whimsy-home-link-shortcuts"),
        imports: doc.getElementById("whimsy-home-link-import"),
        feedback: doc.getElementById("whimsy-home-link-feedback"),
      };
      is(links.settings.getAttribute("href"), "about:preferences", "Settings quick link");
      is(links.shortcuts.getAttribute("href"), "about:keyboard", "Keyboard shortcuts quick link");
      ok(links.imports, "An Import from Arc quick link exists");
      is(
        links.feedback.getAttribute("href"),
        "https://github.com/ethankeshishian/whimsy/issues",
        "Feedback quick link goes to Whimsy's GitHub issues"
      );
    });
  });
});

add_task(async function test_changelog_tab_renders_entries() {
  await BrowserTestUtils.withNewTab("about:whimsy?tab=changelog", async browser => {
    await SpecialPowers.spawn(browser, [], async () => {
      const doc = content.document;
      await ContentTaskUtils.waitForCondition(
        () => doc.getElementById("whimsy-changelog-list").children.length,
        "The changelog finished loading"
      );

      is(
        doc.getElementById("whimsy-tab-changelog").getAttribute("aria-selected"),
        "true",
        "?tab=changelog selects the Changelog tab"
      );
      is(doc.getElementById("whimsy-panel-home").hidden, true, "The Home panel is hidden");

      const entries = doc.querySelectorAll("#whimsy-changelog-list .whimsy-changelog-entries li");
      Assert.greater(entries.length, 0, "At least one changelog entry rendered");

      const builds = doc.querySelectorAll("#whimsy-changelog-list > .whimsy-changelog-group");
      ok(builds[0].classList.contains("is-latest"), "The newest build is highlighted");
      ok(builds[0].querySelector(".wh-latest"), "...and labeled Latest");
      is(doc.querySelectorAll(".is-latest").length, 1, "Only one build is highlighted");
      for (const build of builds) {
        ok(/^(v[\w-]+|unreleased)$/.test(build.id), `Build has an anchor id: ${build.id}`);
        is(build.querySelector(".wh-anchor").getAttribute("href"), "#" + build.id, "Anchor link points at its build");
        ok(build.querySelector(".wh-kind"), `${build.id} groups its notes by kind`);
      }
      ok(doc.querySelector("#whimsy-changelog-list time[datetime]"), "Released builds show their date");
      for (const entry of entries) {
        ok(
          !/\b[0-9a-f]{7,40}\b/.test(entry.textContent),
          `Entry has no commit hash: "${entry.textContent}"`
        );
      }
    });
  });
});

add_task(async function test_feature_off_falls_back() {
  await SpecialPowers.pushPrefEnv({ set: [["whimsy.feature.home", false]] });

  await BrowserTestUtils.withNewTab("about:whimsy", async browser => {
    // The about: module serves about:home's channel under the about:whimsy
    // URL, so check the document itself rather than its URI.
    is(browser.remoteType, "privilegedabout", "Disabled route loads where about:home loads");
    await SpecialPowers.spawn(browser, [], async () => {
      ok(content.document.body.classList.contains("activity-stream"), "Disabled route loads the real home document");
      ok(!content.document.getElementById("whimsy-home"), "No Whimsy homepage when disabled");
    });
  });

  await SpecialPowers.popPrefEnv();
});

add_task(async function test_tabs_and_keyboard() {
  await BrowserTestUtils.withNewTab("about:whimsy?tab=unknown", async browser => {
    const doc = browser.contentDocument;
    const home = doc.getElementById("whimsy-tab-home");
    const changelog = doc.getElementById("whimsy-tab-changelog");
    is(home.tabIndex, 0, "Unknown tab falls back to Home");
    changelog.click();
    is(changelog.getAttribute("aria-selected"), "true", "Click selects Changelog");
    is(home.tabIndex, -1, "Only selected tab is in the tab order");
    // about: URLs can only change their fragment with replaceState.
    is(doc.location.hash, "#changelog", "URL follows selection");
    // legacy: a third tab, Privacy, comes after Changelog.
    const privacy = doc.getElementById("whimsy-tab-privacy");
    changelog.focus();
    EventUtils.synthesizeKey("KEY_ArrowRight", {}, browser.contentWindow);
    is(doc.activeElement, privacy, "Arrow navigation moves on to Privacy");
    ok(!doc.getElementById("whimsy-panel-privacy").hidden, "...and shows its panel");
    EventUtils.synthesizeKey("KEY_ArrowRight", {}, browser.contentWindow);
    is(doc.activeElement, home, "Arrow navigation wraps and focuses Home");
    EventUtils.synthesizeKey("KEY_ArrowLeft", {}, browser.contentWindow);
    is(doc.activeElement, privacy, "ArrowLeft wraps back to the last tab");
    EventUtils.synthesizeKey("KEY_Home", {}, browser.contentWindow);
    is(doc.activeElement, home, "Home selects the first tab");
    EventUtils.synthesizeKey("KEY_End", {}, browser.contentWindow);
    is(doc.activeElement, privacy, "End selects the last tab");
  });
});

add_task(async function test_changelog_empty_invalid_and_text() {
  await BrowserTestUtils.withNewTab("about:whimsy?tab=changelog", async browser => {
    const doc = browser.contentDocument;
    await TestUtils.waitForCondition(() => doc.getElementById("whimsy-changelog-list").children.length);
    const render = browser.contentWindow.renderChangelog;
    const list = doc.getElementById("whimsy-changelog-list");
    const empty = doc.getElementById("whimsy-changelog-empty");
    for (const groups of [[], null, {}, [null, { version: "empty", entries: [] }]]) {
      render(groups);
      ok(!empty.hidden, "Missing or invalid notes show the empty state");
      is(list.children.length, 0, "Rendering clears previous entries");
    }
    const entries = Array.from({ length: 100 }, (_, i) => `Change ${i}`);
    entries[0] = "<img src=x onerror=alert(1)>";
    render([{ version: "test", entries }]);
    is(list.querySelectorAll("li").length, 100, "Long changelog renders every entry");
    is(list.querySelector("li").textContent, entries[0], "Notes are plain text");
    ok(!list.querySelector("img"), "Markup in release notes is never interpreted");
    ok(empty.hidden, "Rendering notes hides the empty state");

    render([{
      version: "1.2b-w3",
      date: "2026-10-30",
      title: "A title",
      new: ["One"],
      improved: [],
      fixed: ["Two", " ", 3],
    }]);
    const build = list.querySelector(".whimsy-changelog-group");
    is(build.id, "v1-2b-w3", "Version becomes a URL-safe anchor");
    is(build.querySelector(".wh-build-title span").textContent, "A title", "Title heads the build");
    Assert.deepEqual(
      [...build.querySelectorAll(".wh-kind")].map(k => k.className),
      ["wh-kind wh-kind-new", "wh-kind wh-kind-fixed"],
      "Only kinds with notes render, in New / Improved / Fixed order"
    );
    is(build.querySelectorAll(".wh-kind-fixed li").length, 1, "Blank and non-string notes are dropped");
    is(build.querySelector("time").getAttribute("datetime"), "2026-10-30", "Date is machine-readable");
  });
});

add_task(async function test_build_anchor_opens_changelog() {
  await BrowserTestUtils.withNewTab("about:whimsy#v1-24b-w1", async browser => {
    const doc = browser.contentDocument;
    await TestUtils.waitForCondition(() => doc.getElementById("v1-24b-w1"), "The anchored build rendered");
    is(doc.getElementById("whimsy-tab-changelog").getAttribute("aria-selected"), "true", "A build anchor opens the Changelog");
    ok(!doc.getElementById("whimsy-panel-changelog").hidden, "...with its panel showing");
    is(doc.location.hash, "#v1-24b-w1", "The build anchor stays in the URL");

    // Following another build's link from the Home tab switches tabs too.
    doc.getElementById("whimsy-tab-home").click();
    ok(doc.getElementById("whimsy-panel-changelog").hidden, "Back on Home");
    const changed = BrowserTestUtils.waitForEvent(browser.contentWindow, "hashchange");
    doc.querySelector("#unreleased .wh-anchor, .whimsy-changelog-group .wh-anchor").click();
    await changed;
    ok(!doc.getElementById("whimsy-panel-changelog").hidden, "A build link shows the Changelog");
  });
});

add_task(async function test_home_sections_and_balloon() {
  await BrowserTestUtils.withNewTab("about:whimsy", async browser => {
    const doc = browser.contentDocument;
    await doc.l10n.ready;
    await doc.l10n.translateRoots();
    is(doc.querySelectorAll(".wh-feature").length, 4, "The what-makes-Whimsy section has four features");
    for (const link of doc.querySelectorAll(".whimsy-home-link")) {
      ok(link.querySelector(".wh-link-title").textContent.trim(), `${link.id} has a title`);
      ok(link.querySelector(".wh-link-desc").textContent.trim(), `${link.id} has a description`);
    }
    const balloon = doc.getElementById("whimsy-home-balloon");
    ok(balloon.getAttribute("aria-label"), "The balloon has an accessible name");
    ok(balloon.querySelector("svg"), "Localizing the balloon keeps its artwork");
    balloon.click();
    ok(balloon.classList.contains("is-poked"), "Poking the balloon bounces it");
    ok(doc.getElementById("whimsy-panel-home").hidden === false, "...and changes nothing else");
    for (const sheet of doc.styleSheets) {
      ok(sheet.href?.startsWith("chrome://"), `Only local stylesheets: ${sheet.href}`);
    }
  });
});

add_task(async function test_import_uses_existing_arc_migrator() {
  const { MigrationUtils } = ChromeUtils.importESModule("moz-src:///browser/components/migration/MigrationUtils.sys.mjs");
  const original = MigrationUtils.showMigrationWizard;
  let request;
  MigrationUtils.showMigrationWizard = (opener, options) => { request = { opener, options }; };
  try {
    await BrowserTestUtils.withNewTab("about:whimsy", async browser => {
      browser.contentDocument.getElementById("whimsy-home-link-import").click();
      await TestUtils.waitForCondition(() => request, "Import invokes Firefox's wizard");
      is(request.opener, window, "Wizard belongs to the browser window");
      is(request.options.migratorKey, "arc", "Arc is selected");
      ok(!request.options.skipSourceSelection, "Other browsers remain available if Arc is missing");
    });
  } finally {
    MigrationUtils.showMigrationWizard = original;
  }
});

add_task(async function test_load_failure_shows_empty_state() {
  await BrowserTestUtils.withNewTab("about:whimsy?tab=changelog", async browser => {
    const win = browser.contentWindow;
    const doc = browser.contentDocument;
    await TestUtils.waitForCondition(() => doc.getElementById("whimsy-changelog-list").children.length);
    const originalFetch = win.fetch;
    win.fetch = async () => { throw new Error("Missing changelog fixture"); };
    try {
      await win.loadChangelog();
      ok(!doc.getElementById("whimsy-changelog-empty").hidden, "Load failure shows the empty state");
      is(doc.getElementById("whimsy-changelog-list").children.length, 0, "Failure clears stale notes");
    } finally {
      win.fetch = originalFetch;
    }
  });
});

// The shared about module must keep the fun pages reachable independently
// of the homepage switch, including the game linked from network errors.
add_task(async function test_fun_pages_with_home_disabled() {
  await SpecialPowers.pushPrefEnv({ set: [["whimsy.feature.home", false]] });
  try {
    for (const [page, id] of [["game", "whimsy-game-canvas"], ["year", "whimsy-year-root"]]) {
      await BrowserTestUtils.withNewTab(`about:whimsy?${page}`, async browser => {
        ok(browser.contentDocument.getElementById(id), `${page} works with Home disabled`);
        ok(browser.contentPrincipal.isSystemPrincipal, `${page} retains its trusted principal`);
      });
    }
  } finally {
    await SpecialPowers.popPrefEnv();
  }
});

add_task(async function home_decorations_finish_within_five_seconds() {
  for (const reduced of [0, 1]) {
    await SpecialPowers.pushPrefEnv({ set: [["ui.prefersReducedMotion", reduced]] });
    try {
      await BrowserTestUtils.withNewTab("about:whimsy", async browser => {
        await SpecialPowers.spawn(browser, [reduced], async motion => {
          await ContentTaskUtils.waitForCondition(() => content.document.querySelector(".wh-balloon"));
          for (const animation of content.document.getAnimations()) {
            const timing = animation.effect.getComputedTiming();
            ok(Number.isFinite(timing.endTime) && timing.endTime <= 5000, "Automatic animation ends within five seconds");
            if (motion) {
              is(timing.activeDuration, 0, "Reduced motion disables automatic decoration");
            }
          }
        });
      });
    } finally {
      await SpecialPowers.popPrefEnv();
    }
  }
});

// wave5: the hero balloon carries one costume per season (the calendar and
// its switch are covered in browser_whimsy_seasonal_themes.js).
add_task(async function test_balloon_costumes_follow_the_switch() {
  await SpecialPowers.pushPrefEnv({ set: [["whimsy.seasons.enabled", false]] });
  try {
    await BrowserTestUtils.withNewTab("about:whimsy", async browser => {
      const doc = browser.contentDocument;
      const costumes = [...doc.querySelectorAll("#whimsy-home-balloon .wh-costume")];
      Assert.deepEqual(
        [...new Set(costumes.map(g => g.dataset.season))].sort(),
        ["autumn", "spring", "summer", "winter"],
        "One costume per season"
      );
      ok(!doc.documentElement.hasAttribute("whimsy-season"), "Seasons off: no season on the page");
      ok(costumes.every(g => browser.contentWindow.getComputedStyle(g).display == "none"), "...and no costume");
    });
  } finally {
    await SpecialPowers.popPrefEnv();
  }
});

// wave8: changelog includes every build through dev.580 and wave 7.
add_task(async function test_changelog_includes_builds_through_dev580_and_wave7() {
  await BrowserTestUtils.withNewTab("about:whimsy?tab=changelog", async browser => {
    await SpecialPowers.spawn(browser, [], async () => {
      const doc = content.document;
      await ContentTaskUtils.waitForCondition(
        () => doc.getElementById("whimsy-changelog-list").children.length,
        "The changelog finished loading"
      );

      const expectedBuilds = [
        "vwave-7",
        "v1-24b-w2-dev-580",
        "v1-24b-w2-dev-413",
        "v1-24b-w2-dev-339",
        "v1-24b-w2-dev-184",
        "v1-24b-w2-dev-74",
      ];
      for (const id of expectedBuilds) {
        const build = doc.getElementById(id);
        ok(build, `Changelog contains build anchor #${id}`);
        const title = build?.querySelector(".wh-build-title span");
        ok(title && title.textContent.trim(), `Build #${id} has a non-empty title: ${title?.textContent}`);
        const entries = build?.querySelectorAll(".whimsy-changelog-entries li") || [];
        Assert.greater(entries.length, 0, `Build #${id} has at least one entry`);
      }
    });
  });
});

