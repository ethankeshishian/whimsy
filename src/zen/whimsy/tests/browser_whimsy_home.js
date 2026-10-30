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
    changelog.focus();
    EventUtils.synthesizeKey("KEY_ArrowRight", {}, browser.contentWindow);
    is(doc.activeElement, home, "Arrow navigation wraps and focuses Home");
    EventUtils.synthesizeKey("KEY_End", {}, browser.contentWindow);
    is(doc.activeElement, changelog, "End selects the last tab");
    EventUtils.synthesizeKey("KEY_Home", {}, browser.contentWindow);
    is(doc.activeElement, home, "Home selects the first tab");
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
