/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// Cmd+F highlights every match like Chrome: Firefox's own "Highlight All"
// is on by default, and the find bar's checkbox reflects it.
add_task(async function test_highlight_all_default() {
  ok(Services.prefs.getBoolPref("findbar.highlightAll"), "Highlight All is on by default");
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, "data:text/html,<p>apple apple apple</p>");
  const findbar = await gBrowser.getFindBar();
  findbar.open();
  await TestUtils.waitForCondition(() => !findbar.hidden, "find bar opens");
  ok(findbar.getElement("highlight").checked, "The Highlight All checkbox is checked");
  findbar.close();
  BrowserTestUtils.removeTab(tab);
});
