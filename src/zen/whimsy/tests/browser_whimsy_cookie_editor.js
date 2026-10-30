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
    await TestUtils.waitForCondition(
      () => SpecialPowers.spawn(browser, [], () => content.document.cookie.includes("a=2")),
      "Editing the value updates what the page sees"
    );

    WhimsyCookieEditor.removeCookie(HOST, "a", a.path, oa);
    cookies = WhimsyCookieEditor.cookiesFor(HOST, oa);
    ok(!cookies.some(c => c.name == "a"), "Deleting removes it");
  });
});
