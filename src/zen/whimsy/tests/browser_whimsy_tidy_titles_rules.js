/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// wave6/parity: Arc's fixed tidy-title rules (52 hosts), used before the
// AI rename and without it.

const { WhimsyTidyTitles } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyTidyTitles.sys.mjs");
const { TIDY_TITLES } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyTidyTitlesData.sys.mjs");

add_task(function test_rules() {
  Assert.greaterOrEqual(Object.keys(TIDY_TITLES).length, 52, "Arc's hosts supported");
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
  is(
    WhimsyTidyTitles.tidy("https://github.com/a/b/pull/12", "Fix the bug · Pull Request #12 · a/b"),
    "Fix the bug",
    "GitHub PR without author also tidies"
  );
  is(
    WhimsyTidyTitles.tidy("https://mail.google.com/mail/u/0/#inbox/FMfcgzG", "Project Discussion - user@gmail.com - Gmail"),
    "Project Discussion",
    "Gmail thread tidies to the subject"
  );
  is(
    WhimsyTidyTitles.tidy("https://mycompany.atlassian.net/browse/PROJ-123", "[PROJ-123] Fix layout issue - Jira"),
    "[PROJ-123] Fix layout issue",
    "Jira issue tidies to the ticket ID and summary"
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

add_task(function test_general_heuristic_without_site_rules() {
  for (const host of ["example.com", "docs.example.com", "www.example.com"]) {
    is(WhimsyTidyTitles.heuristic(`https://${host}/notes`, "(12) Launch Plan | Example"),
      "Launch Plan", `${host}: strips a counter and host-derived suffix`);
    is(WhimsyTidyTitles.heuristic(`https://${host}/notes`, "Example — Launch Plan"),
      "Launch Plan", `${host}: strips a host-derived prefix`);
  }
  is(WhimsyTidyTitles.heuristic("https://unknown.invalid/", "[4] A useful document with many extra words"),
    "A useful document with", "Unknown sites get a short name without a site list");
  is(WhimsyTidyTitles.heuristic("https://unknown.invalid/", "A - B"), null,
    "An unknown separator is kept when it could distinguish the page");
  is(WhimsyTidyTitles.heuristic("https://unknown.invalid/", "Brief"), null,
    "An already clean short title stays unchanged");
  is(WhimsyTidyTitles.heuristic("https://unknown.invalid/", "(2)"), null,
    "A counter-only title never becomes an empty custom label");
  is(WhimsyTidyTitles.heuristic("about:blank", "A long non-web page title"), null,
    "Internal pages are excluded");
});
