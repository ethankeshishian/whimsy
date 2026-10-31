/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// wave6/parity: Arc's fixed tidy-title rules (52 hosts), used before the
// AI rename and without it.

const { WhimsyTidyTitles } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyTidyTitles.sys.mjs");
const { TIDY_TITLES } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyTidyTitlesData.sys.mjs");

add_task(function test_rules() {
  is(Object.keys(TIDY_TITLES).length, 52, "All 52 of Arc's hosts");
  is(WhimsyTidyTitles.tidy("https://www.linkedin.com/", "Feed | LinkedIn"), "LinkedIn", "A fixed name for the home page");
  is(
    WhimsyTidyTitles.tidy("https://www.linkedin.com/in/someone/", "(3) Jane Doe | LinkedIn"),
    "Jane Doe",
    "Patterns strip the site name and the unread count"
  );
  is(
    WhimsyTidyTitles.tidy("https://github.com/a/b/pull/12", "Fix the bug by octocat · Pull Request #12 · a/b"),
    "Fix the bug",
    "GitHub pull requests lose the author and repo"
  );
  is(WhimsyTidyTitles.tidy("https://example.com/", "Example"), null, "No rule, no change");
  is(WhimsyTidyTitles.tidy("about:blank", "x"), null, "Web pages only");
});

add_task(function test_every_pattern_compiles() {
  for (const [host, site] of Object.entries(TIDY_TITLES)) {
    for (const rule of site.rules ?? []) {
      const patterns = [
        rule.match?.pathContainsRegex,
        rule.match?.fragmentContainsRegex,
        rule.title?.removingPattern,
        ...(rule.title?.removingPatterns ?? []),
      ].filter(Boolean);
      for (const p of patterns) {
        let ok_ = true;
        try {
          new RegExp(p);
        } catch (e) {
          ok_ = false;
        }
        ok(ok_, `${host}: ${p} compiles`);
      }
    }
  }
});
