/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */
"use strict";

// W29 vpncalls: while Firefox's VPN carries a page, Firefox lets its calls
// connect only through a relay (TURN over TCP or TLS) reached through a
// proxy. Firefox asked the proxy filters about that relay connection as
// the system, not as the page: the VPN's per-page choice (the page's
// profile, its site rule, a private window) didn't apply, so with the VPN
// on for one profile a call there got "direct" for its relay and, being
// forced through a proxy, no relay connection at all
// (whimsy-WebrtcTCPSocket-cpp.patch).

const { IPPChannelFilter } = ChromeUtils.importESModule(
  "moz-src:///toolkit/components/ipprotection/IPPChannelFilter.sys.mjs"
);

const RELAY_PORT = 3478;

add_task(async function test_relay_lookup_is_asked_as_the_page() {
  await SpecialPowers.pushPrefEnv({ set: [
    ["whimsy.feature.vpn", true],
    ["whimsy.feature.vpnspace", true],
    ["browser.ipProtection.mode", 0],
    ["browser.ipProtection.whimsy.userContextIds", "2"],
    ["media.peerconnection.ice.proxy_only_if_behind_proxy", true],
    ["media.navigator.permission.disabled", true],
    // The test relay lives on 127.0.0.1, and ICE skips loopback TURN servers
    // unless this is on.
    ["media.peerconnection.ice.loopback", true],
  ] });
  const pps = Cc["@mozilla.org/network/protocol-proxy-service;1"].getService(Ci.nsIProtocolProxyService);
  const lookups = [];
  const recorder = {
    QueryInterface: ChromeUtils.generateQI(["nsIProtocolProxyChannelFilter"]),
    applyFilter(channel, proxyInfo, callback) {
      if (channel.URI?.host == "127.0.0.1" && channel.URI.port == RELAY_PORT) {
        lookups.push(channel);
      }
      callback.onProxyFilterResult(proxyInfo);
    },
  };
  pps.registerChannelFilter(recorder, 0);
  // A tab of profile 2 lives in a space of profile 2 (as Whimsy opens it).
  const home = gZenWorkspaces.getActiveWorkspace();
  const space = await gZenWorkspaces.createAndSaveWorkspace("Profile 2", undefined, true, 2);
  await gZenWorkspaces.changeWorkspace(space);
  const tab = BrowserTestUtils.addTab(gBrowser, "https://example.com/", { userContextId: 2 });
  const browser = tab.linkedBrowser;
  try {
    await BrowserTestUtils.browserLoaded(browser, false, "https://example.com/");
    is(browser.contentPrincipal.originAttributes.userContextId, 2, "The page is in profile 2");
    await SpecialPowers.spawn(browser, [RELAY_PORT], async port => {
      const pc = new content.RTCPeerConnection({ iceServers: [{
        urls: `turn:127.0.0.1:${port}?transport=tcp`, username: "whimsy", credential: "whimsy",
      }] });
      content.whimsyTestPc = pc;
      pc.addTransceiver("audio");
      await pc.setLocalDescription();
    });
    await TestUtils.waitForCondition(() => lookups.length, "The call looks up a proxy for its relay");
    const channel = lookups[0];
    is(channel.loadInfo.originAttributes.userContextId, 2, "The relay lookup carries the page's profile");
    ok(!channel.loadInfo.loadingPrincipal?.isSystemPrincipal, "…and is asked as the page, not the system");
    is(channel.loadInfo.loadingPrincipal?.originNoSuffix, "https://example.com", "…the page that made the call");

    const filter = IPPChannelFilter.create();
    filter.proxyInfo = {};
    ok(filter.shouldProxy(channel), "With the VPN on for the page's profile, its relay goes through the VPN too");
    Services.prefs.setStringPref("browser.ipProtection.whimsy.userContextIds", "3");
    ok(!filter.shouldProxy(channel), "…and with the VPN on for another profile only, it doesn't");
  } finally {
    await SpecialPowers.spawn(browser, [], () => {
      content.whimsyTestPc?.close();
    }).catch(() => {});
    pps.unregisterChannelFilter(recorder);
    BrowserTestUtils.removeTab(tab);
    await gZenWorkspaces.changeWorkspace(home);
    for (const t of gZenWorkspaces.allStoredTabs.filter(t => t.getAttribute("zen-workspace-id") == space.uuid &&
      !t.hasAttribute("zen-essential") && !t.hasAttribute("zen-empty-tab"))) {
      BrowserTestUtils.removeTab(t);
    }
    await gZenWorkspaces.removeWorkspace(space.uuid);
    await SpecialPowers.popPrefEnv();
  }
});
