/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

const { WhimsyCookieEditor } = ChromeUtils.importESModule(
  "resource:///modules/whimsy/WhimsyCookieEditor.sys.mjs"
);

const HOST = "example.com";

add_task(async function test_edit_and_delete_a_cookie() {
  await BrowserTestUtils.withNewTab(`https://${HOST}/`, async browser => {
    await SpecialPowers.spawn(browser, [], () => {
      content.document.cookie = "a=1";
    });
    const oa = browser.contentPrincipal.originAttributes;

    let cookies = WhimsyCookieEditor.cookiesFor(HOST, oa);
    const a = cookies.find(c => c.name == "a");
    ok(a, "The editor sees the page's own cookie");
    is(a.value, "1", "With its value");

    WhimsyCookieEditor.setCookie(HOST, oa, { name: "a", value: "2", path: a.path });
    const edited = WhimsyCookieEditor.cookiesFor(HOST, oa).find(c => c.name == "a");
    ok(edited.expiry > Date.now(), "The edited cookie expires in the future (milliseconds)");
    await TestUtils.waitForCondition(
      () => SpecialPowers.spawn(browser, [], () => content.document.cookie.includes("a=2")),
      "Editing the value updates what the page sees"
    );

    WhimsyCookieEditor.removeCookie(HOST, "a", a.path, oa);
    cookies = WhimsyCookieEditor.cookiesFor(HOST, oa);
    ok(!cookies.some(c => c.name == "a"), "Deleting removes it");
  });
});

// fixB: the Cookies sheet (WhimsyPanels). The user couldn't close the old
// one: it now closes with Esc (even with focus still in the page), with
// its close button and with a click outside. A card per cookie edits the
// value in place; Add Cookie shows a small form.
async function openSheet() {
  const shown = BrowserTestUtils.waitForEvent(document, "popupshown", true, e => e.target.id == "whimsy-cookie-editor-panel");
  WhimsyCookieEditor.open(window);
  await shown;
  return document.getElementById("whimsy-cookie-editor-panel");
}

add_task(async function test_cookie_sheet_edits_and_closes() {
  await BrowserTestUtils.withNewTab(`https://${HOST}/`, async browser => {
    await SpecialPowers.spawn(browser, [], () => {
      content.document.cookie = "sheet=1";
    });
    const oa = browser.contentPrincipal.originAttributes;

    let panel = await openSheet();
    ok(panel.classList.contains("whimsy-sheet"), "It is a Whimsy sheet");
    is(panel.querySelector(".whimsy-sheet-subtitle").textContent, HOST, "It names the site");
    const card = [...panel.querySelectorAll(".whimsy-cookie")].find(c => c.getAttribute("aria-label") == "sheet");
    ok(card, "A card for the page's cookie");
    const value = card.querySelector(".whimsy-cookie-value");
    value.value = "2";
    value.dispatchEvent(new Event("change"));
    is(WhimsyCookieEditor.cookiesFor(HOST, oa).find(c => c.name == "sheet").value, "2", "Editing the field saves the value");

    // Esc, with focus moved back to the page.
    browser.focus();
    let hidden = BrowserTestUtils.waitForEvent(panel, "popuphidden");
    EventUtils.synthesizeKey("KEY_Escape", {}, window);
    await hidden;
    ok(!document.getElementById("whimsy-cookie-editor-panel"), "Esc closes it");

    // The close button.
    panel = await openSheet();
    hidden = BrowserTestUtils.waitForEvent(panel, "popuphidden");
    panel.querySelector(".whimsy-sheet-close").doCommand();
    await hidden;
    ok(true, "The close button closes it");

    // Add Cookie.
    panel = await openSheet();
    panel.querySelector(".whimsy-sheet-footer .footer-button").doCommand();
    const form = panel.querySelector(".whimsy-cookie-new");
    ok(!form.hidden, "Add Cookie shows the form");
    form.querySelector(".whimsy-cookie-new-name").value = "added";
    form.querySelector(".whimsy-cookie-new-value").value = "yes";
    form.querySelector(".footer-button").doCommand();
    ok(WhimsyCookieEditor.cookiesFor(HOST, oa).some(c => c.name == "added" && c.value == "yes"), "The new cookie is set");
    ok(form.hidden, "The form folds away");
    hidden = BrowserTestUtils.waitForEvent(panel, "popuphidden");
    panel.hidePopup();
    await hidden;

    for (const c of WhimsyCookieEditor.cookiesFor(HOST, oa)) {
      WhimsyCookieEditor.removeCookie(c.host, c.name, c.path, oa);
    }
  });
});
