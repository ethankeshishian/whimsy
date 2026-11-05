/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

add_task(async function test_click_selects_full_url() {
  await BrowserTestUtils.withNewTab("https://example.com/a?b", async browser => {
    gURLBar.blur();
    await EventUtils.synthesizeMouseAtCenter(gURLBar.inputField, {});
    await TestUtils.waitForCondition(() => gURLBar.focused);
    is(gURLBar.value, "https://example.com/a?b", "Click untrims to the full URL");
    is(
      gURLBar.inputField.selectionStart,
      0,
      "The full value is selected from the start"
    );
    is(
      gURLBar.inputField.selectionEnd,
      gURLBar.inputField.value.length,
      "...to the end"
    );
  });
});

add_task(async function test_always_full_url_pref_mirrors() {
  const { WhimsyUrlbar } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyUrlbar.sys.mjs");
  registerCleanupFunction(() => {
    Services.prefs.clearUserPref("whimsy.urlbar.always-full-url");
    WhimsyUrlbar.applyAlwaysFull();
  });
  Services.prefs.setBoolPref("whimsy.urlbar.always-full-url", true);
  WhimsyUrlbar.applyAlwaysFull();
  ok(!Services.prefs.getBoolPref("browser.urlbar.trimURLs"), "trimURLs turned off");
  ok(!Services.prefs.getBoolPref("zen.urlbar.show-domain-only-in-sidebar"), "domain-only turned off");

  Services.prefs.setBoolPref("whimsy.urlbar.always-full-url", false);
  WhimsyUrlbar.applyAlwaysFull();
  ok(Services.prefs.getBoolPref("browser.urlbar.trimURLs"), "trimURLs restored");
});

// W16-25: a dotless host typed once (and visited) becomes an address, as in
// Chrome: intranet-test/page then opens http://intranet-test/page instead
// of searching. A link visit teaches nothing; neither does an IP address.
add_task(async function test_typed_dotless_host_becomes_an_address() {
  const { WhimsyUrlbar } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyUrlbar.sys.mjs");
  const { PlacesTestUtils } = ChromeUtils.importESModule("resource://testing-common/PlacesTestUtils.sys.mjs");
  const { PlacesUtils } = ChromeUtils.importESModule("resource://gre/modules/PlacesUtils.sys.mjs");
  const known = host => Services.prefs.getBoolPref(`browser.fixup.domainwhitelist.${host}`, false);
  const isSearch = text => {
    const fixed = Services.uriFixup.getFixupURIInfo(text, Ci.nsIURIFixup.FIXUP_FLAG_ALLOW_KEYWORD_LOOKUP);
    info(`${text}: ${fixed.preferredURI?.spec} keyword=${fixed.keywordProviderName} sent=${fixed.keywordAsSent}`);
    return !!(fixed.keywordProviderName || fixed.keywordAsSent);
  };
  const hosts = ["intranet-test", "linked-test", "earlier-test"];
  try {
    ok(isSearch("intranet-test/page"), "Before: a dotless host and path is a search");
    await PlacesTestUtils.addVisits({ uri: "http://intranet-test/", transition: PlacesUtils.history.TRANSITION_TYPED });
    await TestUtils.waitForCondition(() => known("intranet-test"), "A typed visit teaches the host");
    const info = Services.uriFixup.getFixupURIInfo("intranet-test/page", Ci.nsIURIFixup.FIXUP_FLAG_ALLOW_KEYWORD_LOOKUP);
    is(info.preferredURI?.spec, "http://intranet-test/page", "…so its path is an address now");
    ok(!info.keywordProviderName, "…not a search");

    await PlacesTestUtils.addVisits({ uri: "http://linked-test/", transition: PlacesUtils.history.TRANSITION_LINK });
    await new Promise(resolve => setTimeout(resolve, 300)); // eslint-disable-line mozilla/no-arbitrary-setTimeout
    ok(!known("linked-test"), "A link visit teaches nothing");
    ok(isSearch("linked-test/page"), "…it still searches");

    is(WhimsyUrlbar.dotlessHost("http://2130706433/"), null, "A number host (an IPv4 address) is never learned");
    is(WhimsyUrlbar.dotlessHost("http://[::1]/"), null, "…nor an IPv6 one");
    is(WhimsyUrlbar.dotlessHost("ftp://files/"), null, "…nor another scheme");
    is(WhimsyUrlbar.dotlessHost("https://example.com/"), null, "…nor a host with a dot");

    // Typed before: the startup pass learns it.
    await PlacesTestUtils.addVisits({ uri: "http://earlier-test/", transition: PlacesUtils.history.TRANSITION_TYPED });
    await TestUtils.waitForCondition(() => known("earlier-test"), "Learned as it's typed");
    Services.prefs.clearUserPref("browser.fixup.domainwhitelist.earlier-test");
    Services.prefs.clearUserPref("browser.fixup.domainwhitelist.intranet-test");
    Assert.greaterOrEqual(await WhimsyUrlbar.learnFromHistory(), 2, "The startup pass learns hosts already typed");
    ok(known("earlier-test") && known("intranet-test"), "…both of them");
    ok(!known("linked-test"), "…and not the linked one");
  } finally {
    for (const host of hosts) {
      Services.prefs.clearUserPref(`browser.fixup.domainwhitelist.${host}`);
    }
    await PlacesUtils.history.clear();
  }
});
