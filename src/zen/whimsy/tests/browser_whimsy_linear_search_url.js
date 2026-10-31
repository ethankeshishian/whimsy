/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// wave7/small: Search Linear opens linear.app/<workspace>/search?q=<terms>,
// with the workspace taken from a Linear tab (and remembered).

const { WhimsyVerbs, linearWorkspace, linearSearchUrl } = ChromeUtils.importESModule(
  "resource:///modules/whimsy/WhimsyVerbs.sys.mjs"
);

add_task(function test_search_url_shape() {
  is(
    linearSearchUrl("acme", "login bug & crash"),
    "https://linear.app/acme/search?q=login%20bug%20%26%20crash",
    "Workspace search page, terms encoded"
  );
  is(linearSearchUrl(null, "x"), null, "No workspace, no guessed URL");
});

// A window with these tab addresses (only the addresses matter).
function fakeWindow(...urls) {
  return { gBrowser: { tabs: urls.map(url => ({ linkedBrowser: { currentURI: Services.io.newURI(url) } })) } };
}

add_task(async function test_workspace_from_tabs() {
  await SpecialPowers.pushPrefEnv({ clear: [["whimsy.verbs.linear-workspace"]] });
  is(linearWorkspace(fakeWindow("https://example.com/")), null, "No Linear tab, nothing remembered");
  is(
    linearWorkspace(fakeWindow("https://linear.app/docs/search", "https://linear.app/changelog")),
    null,
    "linear.app's own site pages aren't workspaces"
  );
  is(
    linearWorkspace(fakeWindow("https://example.com/", "https://linear.app/acme-co/issue/ENG-12/fix-it")),
    "acme-co",
    "Read from an issue tab"
  );
  is(linearWorkspace(fakeWindow("https://example.com/")), "acme-co", "and remembered after the tab closes");
  is(linearWorkspace(fakeWindow("https://linear.app/other/my-issues")), "other", "A newer Linear tab wins");
  await SpecialPowers.popPrefEnv();
});

add_task(async function test_verb_opens_search() {
  await SpecialPowers.pushPrefEnv({ set: [["whimsy.verbs.linear-workspace", "acme"]] });
  const opened = [];
  const original = WhimsyVerbs.openTab;
  WhimsyVerbs.openTab = (win, url) => opened.push(url);
  const originalConfigured = WhimsyVerbs.linearConfigured;
  WhimsyVerbs.linearConfigured = () => true;
  try {
    await WhimsyVerbs.runVerb(window, "linear-search", { kind: "selection", text: "Flaky login\nmore", markdown: "", title: "", url: "" });
    is(opened.at(-1), "https://linear.app/acme/search?q=Flaky%20login", "Searches the first line in the workspace");
  } finally {
    WhimsyVerbs.openTab = original;
    WhimsyVerbs.linearConfigured = originalConfigured;
    await SpecialPowers.popPrefEnv();
  }
});
