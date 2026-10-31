/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// wave9/secfix (security-full-2 M2): "Run in Profiles" limits an extension
// through Firefox's container isolation (extensions.userContextIsolation.
// <id>.restricted), which only tabs, webRequest and proxy checked. The
// cookies API and declarativeNetRequest now check it too (the
// whimsy-ext-cookies-js and whimsy-ExtensionDNR-sys-mjs engine patches): a
// limited extension can't read another profile's cookies, and its rules
// don't touch that profile's requests.

const { ContextualIdentityService } = ChromeUtils.importESModule(
  "moz-src:///toolkit/components/contextualidentity/ContextualIdentityService.sys.mjs"
);

let workId;

add_setup(async function () {
  await SpecialPowers.pushPrefEnv({ set: [["extensions.userContextIsolation.enabled", true]] });
  workId = ContextualIdentityService.create("Whimsy secfix M2", "briefcase", "blue").userContextId;
  Services.cookies.add(".example.com", "/", "secfixWork", "session-" + "value", true, false, false,
    Date.now() + 3600 * 1000, { userContextId: workId }, Ci.nsICookie.SAMESITE_NONE, Ci.nsICookie.SCHEME_HTTPS);
  registerCleanupFunction(() => {
    Services.cookies.removeCookiesWithOriginAttributes(JSON.stringify({ userContextId: workId }));
    ContextualIdentityService.remove(workId);
  });
});

function restrict(extension, ids) {
  const pref = `extensions.userContextIsolation.${extension.id}.restricted`;
  if (ids) {
    Services.prefs.setStringPref(pref, JSON.stringify(ids));
  } else {
    Services.prefs.clearUserPref(pref);
  }
}

add_task(async function a_limited_extension_cant_read_another_profiles_cookies() {
  const extension = ExtensionTestUtils.loadExtension({
    manifest: { permissions: ["cookies", "<all_urls>"] },
    background() {
      browser.test.onMessage.addListener(async (msg, storeId) => {
        try {
          const cookies = await browser.cookies.getAll({ storeId });
          browser.test.sendMessage("result", cookies.map(c => c.name));
        } catch (e) {
          browser.test.sendMessage("result", "error: " + e.message);
        }
      });
    },
  });
  await extension.startup();
  const storeId = `firefox-container-${workId}`;

  extension.sendMessage("getAll", storeId);
  const allowed = await extension.awaitMessage("result");
  ok(Array.isArray(allowed) && allowed.includes("secfixWork"), "Unlimited, it reads the profile's cookies");

  restrict(extension, [workId]);
  extension.sendMessage("getAll", storeId);
  const limited = await extension.awaitMessage("result");
  ok(typeof limited == "string" && limited.startsWith("error"), `Limited, it gets an error (${limited})`);

  extension.sendMessage("getAll", "firefox-default");
  const own = await extension.awaitMessage("result");
  ok(Array.isArray(own), "…and still reads the profiles it runs in");

  restrict(extension, null);
  await extension.unload();
});

// A fetch-like load in a container; resolves with the load's status.
function loadIn(userContextId, url) {
  const principal = Services.scriptSecurityManager.createContentPrincipal(
    Services.io.newURI("https://example.com/"), { userContextId });
  const channel = NetUtil.newChannel({
    uri: url,
    loadingPrincipal: principal,
    securityFlags: Ci.nsILoadInfo.SEC_ALLOW_CROSS_ORIGIN_SEC_CONTEXT_IS_NULL,
    contentPolicyType: Ci.nsIContentPolicy.TYPE_FETCH,
  });
  return new Promise(resolve => {
    NetUtil.asyncFetch(channel, (stream, status) => {
      try {
        stream?.close();
      } catch (e) {}
      resolve(status);
    });
  });
}

add_task(async function a_limited_extensions_rules_skip_another_profile() {
  const extension = ExtensionTestUtils.loadExtension({
    manifest: {
      manifest_version: 3,
      permissions: ["declarativeNetRequest"],
      host_permissions: ["<all_urls>"],
    },
    async background() {
      await browser.declarativeNetRequest.updateSessionRules({
        addRules: [{
          id: 1,
          condition: { urlFilter: "secfix-dnr", resourceTypes: ["xmlhttprequest", "other"] },
          action: { type: "block" },
        }],
      });
      browser.test.sendMessage("ready");
    },
  });
  await extension.startup();
  await extension.awaitMessage("ready");
  const url = "https://example.com/?secfix-dnr";

  ok(!Components.isSuccessCode(await loadIn(workId, url)), "Unlimited, its rule blocks the profile's request");
  restrict(extension, [workId]);
  ok(Components.isSuccessCode(await loadIn(workId, url)), "Limited, its rule leaves the profile's request alone");
  ok(!Components.isSuccessCode(await loadIn(0, url)), "…and still blocks in the profiles it runs in");

  restrict(extension, null);
  await extension.unload();
});
