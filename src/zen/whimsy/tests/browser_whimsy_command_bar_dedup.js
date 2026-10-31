/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// wave6/parity: Arc's command bar dedupes results by title and host on its
// 10 hosts.

const { dedupResults, DEDUP_HOSTS } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyCommandBar.sys.mjs");

const row = (url, title, heuristic = false) => ({ payload: { url, title }, heuristic });

add_task(function test_dedup() {
  is(DEDUP_HOSTS.size, 10, "Arc's 10 hosts");
  const results = [
    row("https://www.figma.com/file/a?node=1", "Design", true),
    row("https://www.figma.com/file/a?node=1", "Design"),
    row("https://www.figma.com/file/a?node=2", "Design"),
    row("https://github.com/a/b/issues", "a/b"),
    row("https://github.com/a/b/pulls", "a/b"),
    row("https://example.com/1", "Same"),
    row("https://example.com/2", "Same"),
    row("https://figma.com/file/b", "Other"),
  ];
  const out = dedupResults(results);
  is(out[0], results[0], "The heuristic result stays");
  is(out.filter(r => r.payload.title == "Design").length, 2, "One Design row besides the heuristic");
  is(out.filter(r => r.payload.title == "a/b").length, 1, "One GitHub row per title");
  is(out.filter(r => r.payload.title == "Same").length, 2, "Other sites keep every row");
  ok(out.some(r => r.payload.title == "Other"), "Different titles stay");
  ok(dedupResults([row(null, "x"), row("not a url", "x")]).length == 2, "Rows without a URL are left alone");
});
