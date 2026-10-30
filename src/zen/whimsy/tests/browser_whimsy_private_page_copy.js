/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// wave7/ux: the private page describes Whimsy's model. Private tabs and
// Scratch live in normal windows and are wiped when the last private tab
// closes, so the page mustn't say "when you close all your private
// windows" (whimsy/engine_overrides.py, private-page-last-private-tab).

add_task(async function test_private_page_says_last_private_tab() {
  const l10n = new Localization(["branding/brand.ftl", "browser/aboutPrivateBrowsing.ftl"], true);
  const body = l10n.formatValueSync("about-private-browsing-felt-privacy-v1-info-body");
  ok(body.includes("last private tab"), `It names the last private tab: "${body}"`);
  ok(!body.includes("private windows"), "...not private windows");
});
