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
      is(links.shortcuts.getAttribute("href"), "about:keyboard", "Shortcuts quick link");
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
  Services.prefs.setBoolPref("whimsy.feature.home", false);
  registerCleanupFunction(() => Services.prefs.clearUserPref("whimsy.feature.home"));

  await BrowserTestUtils.withNewTab("about:whimsy", async browser => {
    await SpecialPowers.spawn(browser, [], async () => {
      ok(
        !content.document.getElementById("whimsy-home"),
        "With the feature off, about:whimsy no longer shows Whimsy's homepage"
      );
    });
  });

  Services.prefs.clearUserPref("whimsy.feature.home");
});
