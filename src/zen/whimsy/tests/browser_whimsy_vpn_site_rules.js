/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */
"use strict";

// W15: Settings > Privacy > Manage website rules was an empty page (Firefox
// registers it with no items). Whimsy fills it from the ipp-vpn permissions:
// Always use VPN (included) and Never use VPN (excluded), each row removable,
// refreshing while the page is open.

const { IPPPermissionRules, IPPPrincipalRules } = ChromeUtils.importESModule(
  "moz-src:///toolkit/components/ipprotection/IPPSiteRuleManager.sys.mjs"
);

const IN = "https://included-w15.example.com";
const OUT = "https://excluded-w15.example.com";
const LATE = "https://late-w15.example.com";

function principal(origin) {
  return Services.scriptSecurityManager.createContentPrincipalFromOrigin(origin);
}

function clear() {
  for (const origin of [IN, OUT, LATE]) {
    Services.perms.removeFromPrincipal(principal(origin), "ipp-vpn");
  }
}

function sites(doc, kind) {
  return [...doc.querySelectorAll(`#whimsyVpnRules-${kind} .whimsy-vpn-rule`)].map(row => row.dataset.site);
}

async function openRules() {
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, "about:preferences#privacy");
  const doc = tab.linkedBrowser.contentDocument;
  await SpecialPowers.spawn(tab.linkedBrowser, [], async () => {
    await content.wrappedJSObject.gotoPref("vpnSiteRules");
  });
  await TestUtils.waitForCondition(() => doc.getElementById("whimsyVpnSiteRules"), "Rules page filled");
  return { tab, doc };
}

// Opening the privacy pane makes Firefox set some prefs (the VPN's
// onboarding mask, the clear-on-shutdown migration); put them back.
const WATCHED = ["browser.ipProtection.", "privacy."];
const userPrefs = () =>
  WATCHED.flatMap(root => Services.prefs.getChildList(root)).filter(name => Services.prefs.prefHasUserValue(name));
const before = new Map(userPrefs().map(name => [name, Services.prefs.getStringPref(name, null)]));

registerCleanupFunction(() => {
  clear();
  for (const name of userPrefs()) {
    if (!before.has(name)) {
      Services.prefs.clearUserPref(name);
    }
  }
});

add_task(async function test_lists_rules_under_sections_and_removes() {
  clear();
  IPPPermissionRules.setRule(principal(IN), IPPPrincipalRules.INCLUDED);
  IPPPermissionRules.setRule(principal(OUT), IPPPrincipalRules.EXCLUDED);
  const { tab, doc } = await openRules();
  Assert.deepEqual(sites(doc, "included"), ["included-w15.example.com"], "Included site under Always use VPN");
  Assert.deepEqual(sites(doc, "excluded"), ["excluded-w15.example.com"], "Excluded site under Never use VPN");
  ok(!doc.querySelector('setting-group[groupid="vpnSiteRules"]:not([hidden])'), "No blank Firefox card");

  IPPPermissionRules.setRule(principal(LATE), IPPPrincipalRules.INCLUDED);
  await TestUtils.waitForCondition(
    () => sites(doc, "included").includes("late-w15.example.com"),
    "A rule added while the page is open appears"
  );

  doc.querySelector('#whimsyVpnRules-included [data-site="included-w15.example.com"] .whimsy-vpn-rule-remove').click();
  await TestUtils.waitForCondition(
    () => !sites(doc, "included").includes("included-w15.example.com"),
    "Remove: the row disappears"
  );
  is(IPPPermissionRules.getRule(principal(IN)), IPPPrincipalRules.DEFAULT, "...and the permission is gone");
  is(IPPPermissionRules.getRule(principal(OUT)), IPPPrincipalRules.EXCLUDED, "Other rules are untouched");
  BrowserTestUtils.removeTab(tab);
});

add_task(async function test_empty_states() {
  clear();
  const { tab, doc } = await openRules();
  Assert.deepEqual(sites(doc, "included"), [], "No included rows");
  Assert.deepEqual(sites(doc, "excluded"), [], "No excluded rows");
  is(doc.querySelectorAll("#whimsyVpnSiteRules .whimsy-vpn-rules-empty").length, 2, "Both empty states show");
  ok(!doc.querySelector('setting-group[groupid="vpnSiteRules"]:not([hidden])'), "No blank card remains");
  BrowserTestUtils.removeTab(tab);
});
