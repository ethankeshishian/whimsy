/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// Cmd+F with text selected opens the find bar with the selection in it
// (Chrome and Safari; macOS Firefox leaves this off). Without a selection
// the find bar opens as usual.

const PAGE = "data:text/html,<p id=p>The quick brown fox jumps over the lazy dog</p>";

add_task(async function test_prefill() {
  ok(Services.prefs.getBoolPref("accessibility.typeaheadfind.prefillwithselection"), "Prefill is on");
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE);
  await SpecialPowers.spawn(tab.linkedBrowser, [], () => {
    const text = content.document.getElementById("p").firstChild;
    const range = content.document.createRange();
    range.setStart(text, 10);
    range.setEnd(text, 19);
    content.getSelection().removeAllRanges();
    content.getSelection().addRange(range);
  });
  tab.linkedBrowser.focus();
  EventUtils.synthesizeKey("f", { accelKey: true });
  const findBar = await TestUtils.waitForCondition(() => gBrowser.getCachedFindBar(tab), "find bar created");
  await TestUtils.waitForCondition(() => !findBar.hidden, "Cmd+F opens the find bar");
  await TestUtils.waitForCondition(() => findBar._findField.value == "brown fox", "filled with the selection");
  is(findBar._findField.value, "brown fox", "The find field holds the selected text");
  // batch8: W8-08: search runs immediately without Enter
  await TestUtils.waitForCondition(() => tab.linkedBrowser.finder?.searchString == "brown fox" || findBar._findField.getAttribute("status") != null, "searched immediately");
  findBar.close(true);

  // No selection: it opens, and the field doesn't get page text.
  await SpecialPowers.spawn(tab.linkedBrowser, [], () => content.getSelection().removeAllRanges());
  findBar._findField.value = "";
  // The search above went to macOS's find pasteboard (as any search does),
  // which a new find bar shows; clear it so only page text could fill it.
  if (Services.clipboard.isClipboardTypeSupported(Ci.nsIClipboard.kFindClipboard)) {
    Cc["@mozilla.org/widget/clipboardhelper;1"].getService(Ci.nsIClipboardHelper)
      .copyStringToClipboard("", Ci.nsIClipboard.kFindClipboard);
  }
  tab.linkedBrowser.focus();
  EventUtils.synthesizeKey("f", { accelKey: true });
  await TestUtils.waitForCondition(() => !findBar.hidden, "opens without a selection");
  await new Promise(r => setTimeout(r, 200));
  is(findBar._findField.value, "", "and stays empty");
  findBar.close(true);
  BrowserTestUtils.removeTab(tab);
});
