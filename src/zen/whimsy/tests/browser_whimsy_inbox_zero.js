/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

const { parseInboxCount, TEST_HOSTS } = ChromeUtils.importESModule(
  "resource:///modules/whimsy/WhimsyDelight.sys.mjs"
);

add_task(function test_parse_inbox_count() {
  is(parseInboxCount("mail.google.com", "Inbox (3) - me@gmail.com - Gmail"), 3, "Gmail, 3 unread");
  is(parseInboxCount("mail.google.com", "Inbox - me@gmail.com - Gmail"), 0, "Gmail, zero");
  is(parseInboxCount("outlook.office.com", "Inbox (12) - Outlook"), 12, "Outlook, 12 unread");
  is(parseInboxCount("www.fastmail.com", "(2) Inbox"), 2, "Fastmail, 2 unread");
  is(parseInboxCount("www.fastmail.com", "Inbox"), 0, "Fastmail, zero");
  is(parseInboxCount("example.com", "Inbox (3)"), null, "An unrelated host is never an inbox");
});

add_task(async function test_balloons_on_zero_transition() {
  TEST_HOSTS.push({
    match: host => host == "example.com",
    regex: /^Inbox \((\d+)\)/,
    zero: /^Inbox$/,
  });
  registerCleanupFunction(() => TEST_HOSTS.length = 0);

  await BrowserTestUtils.withNewTab("https://example.com/", async browser => {
    const tab = gBrowser.getTabForBrowser(browser);
    const { WhimsyDelight } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyDelight.sys.mjs");
    tab.label = "Inbox (2)";
    WhimsyDelight.onLabelChanged(window, tab);

    tab.label = "Inbox";
    WhimsyDelight.onLabelChanged(window, tab);

    const layer = window.document.querySelector(".whimsy-balloons");
    ok(layer, "Balloons appear on the 2 -> 0 transition");
    await TestUtils.waitForCondition(
      () => !window.document.querySelector(".whimsy-balloons"),
      "Balloons remove themselves"
    );
  });
});
