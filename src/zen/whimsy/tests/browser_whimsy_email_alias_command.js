/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// wave7/small: Create Email Alias in the command bar opens the alias menu
// at the focused email field; with none focused it says to click into one.

const PAGE =
  "https://example.com/document-builder.sjs?html=" +
  encodeURIComponent("<input id=name name=name><input id=mail type=email>");
const { WhimsyEmailAliases } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyEmailAliases.sys.mjs");

function action() {
  const { globalActions } = ChromeUtils.importESModule("resource:///modules/ZenUBGlobalActions.sys.mjs");
  return globalActions.find(a => a.l10nId == "whimsy-action-create-email-alias");
}

add_setup(async function () {
  // Keep the menu off the network: iCloud answers "signed out" at once.
  const original = WhimsyEmailAliases.iCloudStatus;
  WhimsyEmailAliases.iCloudStatus = async () => ({ state: "signed-out" });
  registerCleanupFunction(() => {
    WhimsyEmailAliases.iCloudStatus = original;
    document.getElementById("whimsy-email-aliases-popup")?.hidePopup();
  });
});

add_task(async function test_focused_email_field_opens_menu() {
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE);
  ok(action()?.isAvailable(window), "The command bar offers Create Email Alias");
  await SpecialPowers.spawn(tab.linkedBrowser, [], () => content.document.getElementById("mail").focus());
  const shown = BrowserTestUtils.waitForEvent(document, "popupshown", true, e => e.target.id == "whimsy-email-aliases-popup");
  is(await WhimsyEmailAliases.createForFocusedField(window), "menu", "The alias menu opens");
  await shown;
  const popup = document.getElementById("whimsy-email-aliases-popup");
  const hidden = BrowserTestUtils.waitForPopupEvent(popup, "hidden");
  popup.hidePopup();
  await hidden;
  BrowserTestUtils.removeTab(tab);
});

add_task(async function test_no_email_field_explains() {
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE);
  await SpecialPowers.spawn(tab.linkedBrowser, [], () => content.document.getElementById("name").focus());
  is(await WhimsyEmailAliases.createForFocusedField(window), "no-field", "A name field isn't an email field");
  await SpecialPowers.spawn(tab.linkedBrowser, [], () => content.document.activeElement.blur());
  is(await WhimsyEmailAliases.createForFocusedField(window), "no-field", "Nothing focused: it explains instead");
  BrowserTestUtils.removeTab(tab);
});

add_task(async function test_switch_off() {
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE);
  await SpecialPowers.pushPrefEnv({ set: [["whimsy.feature.email-aliases", false]] });
  ok(!action().isAvailable(window), "The switch hides the command");
  is(await WhimsyEmailAliases.createForFocusedField(window), "off", "and it does nothing");
  await SpecialPowers.popPrefEnv();
  BrowserTestUtils.removeTab(tab);
});

add_task(async function test_not_in_private_windows() {
  const win = await BrowserTestUtils.openNewBrowserWindow({ private: true });
  ok(!action().isAvailable(win), "Not offered in a private window");
  await BrowserTestUtils.closeWindow(win);
});
