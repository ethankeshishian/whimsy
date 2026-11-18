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
    ["media.navigator.streams.fake", true],
    // The harness's loopback device takes precedence over streams.fake.
    ["media.audio_loopback_dev", ""],
    ["media.video_loopback_dev", ""],
    ["media.navigator.permission.force", false],
    // A fake mic counts as capturing (as a real one does) only with this on.
    ["media.navigator.permission.fake", true],
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
  let registered = true;
  // A tab of profile 2 lives in a space of profile 2 (as Whimsy opens it).
  const home = gZenWorkspaces.getActiveWorkspace();
  let space, tab;
  const cleanup = async () => {
    if (!registered && !space && !tab?.isConnected) {
      return;
    }
    if (registered) {
      pps.unregisterChannelFilter(recorder);
      registered = false;
    }
    try {
      if (tab?.isConnected && !tab.closing) {
        try {
          await SpecialPowers.spawn(tab.linkedBrowser, [], () => {
            content.whimsyTestClosed = true;
            content.whimsyTestPc?.close();
            content.whimsyTestStream?.getTracks().forEach(t => t.stop());
          });
        } finally {
          const flushed = BrowserTestUtils.waitForSessionStoreUpdate(tab);
          BrowserTestUtils.removeTab(tab, { animate: false });
          await flushed;
        }
      }
    } finally {
      await gZenWorkspaces.changeWorkspace(home);
      if (space) {
        for (const t of gZenWorkspaces.allStoredTabs.filter(t => t.getAttribute("zen-workspace-id") == space.uuid &&
          !t.hasAttribute("zen-essential") && !t.hasAttribute("zen-empty-tab"))) {
          await BrowserTestUtils.removeTab(t);
        }
        await gZenWorkspaces.removeWorkspace(space.uuid);
        space = null;
      }
    }
  };
  registerCleanupFunction(cleanup);
  try {
    space = await gZenWorkspaces.createAndSaveWorkspace("Profile 2", undefined, true, 2);
    await gZenWorkspaces.changeWorkspace(space);
    tab = BrowserTestUtils.addTab(gBrowser, "about:blank", { userContextId: 2 });
    await BrowserTestUtils.switchTab(gBrowser, tab);
    const browser = tab.linkedBrowser;
    const loaded = BrowserTestUtils.browserLoaded(browser, false, "https://example.com/");
    BrowserTestUtils.startLoadingURIString(browser, "https://example.com/");
    await loaded;
    is(browser.contentPrincipal.originAttributes.userContextId, 2, "The page is in profile 2");
    await SpecialPowers.spawn(browser, [RELAY_PORT], port => {
      const pc = new content.RTCPeerConnection({ iceServers: [{
        urls: `turn:127.0.0.1:${port}?transport=tcp`, username: "whimsy", credential: "whimsy",
      }] });
      content.whimsyTestPc = pc;
      content.whimsyTestErrors = [];
      pc.onicecandidateerror = e => content.whimsyTestErrors.push(`${e.url} ${e.errorCode} ${e.errorText}`);
      // A call captures the mic. Without a capture, ICE gathers on the
      // default route only, and it finds that route with a UDP probe, which a
      // page forced through the proxy may not send: no candidates at all.
      content.whimsyTestPhase = "requesting microphone";
      content.whimsyTestError = null;
      // Force the fake device for this request too, independent of the
      // harness's devices. Keep capture/offer completion observable without
      // blocking SpecialPowers.spawn (and thus failure cleanup) on either.
      content.navigator.mediaDevices.getUserMedia({ audio: true, fake: true }).then(async stream => {
        content.whimsyTestStream = stream;
        if (content.whimsyTestClosed) {
          stream.getTracks().forEach(t => t.stop());
          return;
        }
        content.whimsyTestPhase = "creating offer";
        pc.addTrack(stream.getAudioTracks()[0], stream);
        await pc.setLocalDescription();
        content.whimsyTestPhase = "gathering";
      }).catch(e => { content.whimsyTestError = `${e.name}: ${e.message}`; });
    });
    let phase;
    await TestUtils.waitForCondition(async () => {
      const state = await SpecialPowers.spawn(browser, [], () => ({
        phase: content.whimsyTestPhase, error: content.whimsyTestError,
      }));
      phase = state.phase;
      if (state.error) {
        throw new Error(`${phase}: ${state.error}`);
      }
      return phase == "gathering";
    }, "The fake microphone and offer are ready").catch(e => {
      throw new Error(`${e.message || e} (phase=${phase})`);
    });
    await TestUtils.waitForCondition(() => lookups.length, "The call looks up a proxy for its relay").catch(async e => {
      // What ICE did instead, so a failure here says why.
      const why = await SpecialPowers.spawn(browser, [], async () => {
        const pc = content.whimsyTestPc;
        const stats = [];
        (await pc.getStats()).forEach(r => {
          if (r.type == "local-candidate") {
            stats.push(`${r.candidateType}/${r.protocol}/${r.relayProtocol ?? ""}`);
          }
        });
        return `gathering=${pc.iceGatheringState} ice=${pc.iceConnectionState} ` +
          `candidates=[${stats}] errors=[${content.whimsyTestErrors}]`;
      }).catch(err => `no stats: ${err}`);
      throw new Error(`${e.message || e} (${why})`);
    });
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
    try {
      await cleanup();
    } finally {
      await SpecialPowers.popPrefEnv();
    }
  }
});
