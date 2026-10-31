/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// wave7/small: Settings cleanup. Strings left behind by fix/panes and
// wave5/uxfix are gone, and every Whimsy string Settings uses still
// resolves, in every pane (no empty labels, no blank Fluent batch).

const REMOVED = [
  "whimsy-updates-header",
  "whimsy-updated-settings-label",
  "whimsy-meeting-header",
  "whimsy-meeting-apple-enable",
  "whimsy-archive-panel",
  "whimsy-cheatsheet-group-tabs",
  "whimsy-useragent-default",
];

add_task(async function test_dead_strings_are_gone() {
  const l10n = new Localization(["browser/whimsy.ftl"], true);
  const messages = l10n.formatMessagesSync(REMOVED.map(id => ({ id })));
  for (let i = 0; i < REMOVED.length; i++) {
    ok(!messages[i], `${REMOVED[i]} was removed`);
  }
});

add_task(async function test_every_settings_string_resolves() {
  const panes = { general: "paneGeneral", zenLooks: "paneZenLooks", zenTabManagement: "paneZenTabManagement", privacy: "panePrivacy", search: "paneSearch" };
  for (const [hash, pane] of Object.entries(panes)) {
    await BrowserTestUtils.withNewTab(`about:preferences#${hash}`, async browser => {
      const win = browser.contentWindow;
      const doc = browser.contentDocument;
      await TestUtils.waitForCondition(() => win.gLastCategory?.category == pane, `${pane} is showing`);
      await doc.l10n.ready;
      const ids = [...new Set([...doc.querySelectorAll("[data-l10n-id^='whimsy-']")].map(el => el.dataset.l10nId))];
      const messages = await doc.l10n.formatMessages(ids.map(id => ({ id })));
      const missing = ids.filter((id, i) => !messages[i]);
      Assert.deepEqual(missing, [], `${pane}: every Whimsy string resolves (${ids.length} checked)`);
      // A visible Whimsy card always has something in it besides its heading.
      for (const card of doc.querySelectorAll("groupbox[id^='whimsy'], .whimsy-setting-card")) {
        if (card.hidden || !card.checkVisibility()) {
          continue;
        }
        ok(
          card.querySelector("checkbox, moz-checkbox, moz-toggle, moz-select, moz-radio-group, moz-button, menulist, button, input, textarea, select, a, [role='radiogroup'], setting-group"),
          `${card.id} has controls`
        );
      }
    });
  }
});

