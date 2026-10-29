/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// Interface font: whimsy.look.ui-font sets the family of the browser's own
// text (tab titles, URL bar), live; empty is the system font; web pages
// keep theirs; odd characters can't break out of the CSS; Settings lists
// the system's fonts; the feature switch restores the system font.

const FEATURE = "whimsy.feature.ui-font";
const PREF = "whimsy.look.ui-font";

registerCleanupFunction(() => {
  Services.prefs.clearUserPref(FEATURE);
  Services.prefs.clearUserPref(PREF);
});

function tabFont() {
  const label = gBrowser.selectedTab.querySelector(".tab-label");
  return window.getComputedStyle(label).fontFamily;
}

add_task(async function test_font() {
  is(Services.prefs.getStringPref(PREF), "", "System font by default");
  const system = tabFont();
  ok(!system.includes("Menlo"), "Not Menlo to begin with");

  Services.prefs.setStringPref(PREF, "Menlo");
  ok(document.documentElement.hasAttribute("whimsy-ui-font"), "Applied");
  ok(tabFont().startsWith('"Menlo"') || tabFont().startsWith("Menlo"), "Tab titles use it");
  const urlbar = document.getElementById("urlbar-input");
  if (urlbar) {
    ok(window.getComputedStyle(urlbar).fontFamily.includes("Menlo"), "so does the URL bar");
  }

  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, "data:text/html,<p id=p>hi</p>");
  const pageFont = await SpecialPowers.spawn(tab.linkedBrowser, [], () =>
    content.getComputedStyle(content.document.getElementById("p")).fontFamily
  );
  ok(!pageFont.includes("Menlo"), "Web pages keep their own font");
  BrowserTestUtils.removeTab(tab);

  Services.prefs.setStringPref(PREF, 'Evil"; } * { color: red');
  ok(!document.documentElement.style.getPropertyValue("--whimsy-ui-font").includes(";"), "Odd characters are dropped");

  Services.prefs.setStringPref(PREF, "Menlo");
  Services.prefs.setBoolPref(FEATURE, false);
  ok(!document.documentElement.hasAttribute("whimsy-ui-font"), "The switch turns it off");
  is(tabFont(), system, "back to the system font");
  Services.prefs.clearUserPref(FEATURE);
  Services.prefs.clearUserPref(PREF);
  is(tabFont(), system, "Clearing the pref restores the system font");
});

add_task(async function test_settings_list() {
  await BrowserTestUtils.withNewTab("about:preferences#zenLooks", async browser => {
    const doc = browser.contentDocument;
    const list = await TestUtils.waitForCondition(() => doc.getElementById("whimsyUiFont"));
    ok(list, "Settings → Look and Feel has the font list");
    await TestUtils.waitForCondition(() => list.itemCount > 5, "listing the system's fonts");
    is(list.getItemAtIndex(0).value, "", "System font first");
    const menlo = [...list.menupopup.children].find(i => i.value == "Menlo");
    if (menlo) {
      list.selectedItem = menlo;
      list.dispatchEvent(new Event("command", { bubbles: true }));
      await TestUtils.waitForCondition(() => Services.prefs.getStringPref(PREF) == "Menlo", "Choosing one sets it");
    }
    Services.prefs.clearUserPref(PREF);
  });
});
