/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// wave7/small: Settings cleanup. Strings left behind by fix/panes and
// wave5/uxfix are gone, and every Whimsy string Settings uses still
// resolves, in every pane (no empty labels, no blank Fluent batch).

const REMOVED = [
  "whimsy-updates-header",
  // Not whimsy-updated-settings-label: Zen's sidebar notification builds it
  // from the "Update settings" link's id (<id>-label), like -tooltip.
  "whimsy-meeting-header",
  "whimsy-meeting-apple-enable",
  "whimsy-archive-panel",
  "whimsy-cheatsheet-group-tabs",
  "whimsy-useragent-default",
];

add_task(async function test_dead_strings_are_gone() {
  const l10n = new Localization(["browser/whimsy.ftl"], true);
  for (const id of REMOVED) {
    // One at a time: with intl.l10n.strict a missing id throws instead of
    // coming back empty, and that is what "removed" looks like.
    let message = null;
    try {
      [message] = l10n.formatMessagesSync([{ id }]);
    } catch (e) {
      ok(/Missing message/.test(e.message), `${id}: ${e.message}`);
    }
    ok(!message, `${id} was removed`);
  }
});

add_task(async function test_every_settings_string_resolves() {
  // Firefox's settings redesign (on in Zen) folds General into its first
  // pane: #general opens paneSync there (whimsy-settings.js knows this too).
  const general = Services.prefs.getBoolPref("browser.settings-redesign.enabled", false) ? "paneSync" : "paneGeneral";
  const panes = { general, zenLooks: "paneZenLooks", zenTabManagement: "paneZenTabManagement", privacy: "panePrivacy", search: "paneSearch" };
  for (const [hash, pane] of Object.entries(panes)) {
    await BrowserTestUtils.withNewTab(`about:preferences#${hash}`, async browser => {
      const win = browser.contentWindow;
      const doc = browser.contentDocument;
      await TestUtils.waitForCondition(() => win.gLastCategory?.category == pane, `${pane} is showing`);
      await doc.l10n.ready;
      // With each element's own arguments (some strings take a value).
      const byId = new Map();
      for (const el of doc.querySelectorAll("[data-l10n-id^='whimsy-']")) {
        const { id, args } = doc.l10n.getAttributes(el);
        if (!byId.has(id) || (args && !byId.get(id))) {
          byId.set(id, args ?? null);
        }
      }
      const ids = [...byId.keys()];
      const messages = await doc.l10n.formatMessages(ids.map(id => ({ id, args: byId.get(id) ?? undefined })));
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

