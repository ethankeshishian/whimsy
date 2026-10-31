/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// wave7/native1: Firefox's shortcut editor (about:keyboard) names
// Cmd+Shift+T the way Whimsy does everywhere else (Zen's command palette,
// the cheat sheet): "Restore Last Closed Tab", not Firefox's "Reopen Last
// Closed Tab" (whimsy-customkeys-ftl.patch).

const ID = "customkeys-history-reopen-tab";
const LABEL = "Restore Last Closed Tab";

add_task(async function test_the_string() {
  const l10n = new Localization(["browser/customkeys.ftl"], true);
  is(l10n.formatValueSync(ID), LABEL, "customkeys.ftl says Restore");
  is(
    await new Localization(["browser/whimsy.ftl"]).formatValue("whimsy-cheatsheet-reopen-tab"),
    LABEL,
    "Same words as the cheat sheet"
  );
  // The window's companion string is untouched.
  is(l10n.formatValueSync("customkeys-history-reopen-window"), "Reopen Last Closed window", "Reopen window stays Firefox's");
});

add_task(async function test_about_keyboard() {
  await BrowserTestUtils.withNewTab("about:keyboard", async browser => {
    await SpecialPowers.spawn(browser, [LABEL], async label => {
      const doc = content.document;
      if (!doc.getElementById("table").firstElementChild) {
        await ContentTaskUtils.waitForEvent(content, "CustomKeysUpdate", false, null, true);
      }
      const row = doc.querySelector('.key[data-id="key_restoreLastClosedTabOrWindowOrSession"]');
      ok(row, "Cmd+Shift+T is listed");
      is(row?.dataset.label, label, "about:keyboard names it Restore Last Closed Tab");
      ok(!doc.body.textContent.includes("Reopen Last Closed Tab"), "Firefox's name is gone");
    });
  });
});
