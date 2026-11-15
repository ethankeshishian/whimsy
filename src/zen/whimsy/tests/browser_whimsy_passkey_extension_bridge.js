/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// W29: "1pass login on google.com isn't working": 1Password's toast led to
// Firefox's own "Touch your security key" prompt instead of its passkey.
// Password managers (1Password 8.12 is the model here) don't decide in the
// page. Their page-world hook (world: MAIN, a non-configurable getter on
// navigator.credentials.get) asks their isolated content script over
// window.postMessage, which asks the background over runtime messaging. When
// the page hears nothing back within a second it calls the browser's own
// WebAuthn, which is that prompt. So this test proves the whole round trip,
// on a page with Google's kind of policy (nonce, strict-dynamic, Trusted
// Types), in a Whimsy profile's tab, with Whimsy's own passkeys on.
const { WhimsyProfiles } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyProfiles.sys.mjs");
const { ContextualIdentityService } = ChromeUtils.importESModule("moz-src:///toolkit/components/contextualidentity/ContextualIdentityService.sys.mjs");
const ROOT = getRootDirectory(gTestPath).replace("chrome://mochitests/content", "https://example.com");
const PAGE = ROOT + "whimsy_passkey_bridge.sjs";

// The page-world half: what 1Password's webauthn-listeners.js does.
const MAIN_WORLD = `
  (() => {
    const credentials = navigator.credentials;
    const nativeGet = credentials.get.bind(credentials);
    window.bridgeCalls = [];
    const ask = (name, body) => new Promise(resolve => {
      const msgId = crypto.getRandomValues(new Uint32Array(1))[0].toString(36);
      const onMessage = event => {
        const data = event.data;
        if (data?.bridge != "reply" || data.msgId != msgId) {
          return;
        }
        event.stopImmediatePropagation();
        clearTimeout(timer);
        removeEventListener("message", onMessage, true);
        resolve(data.message);
      };
      // 1Password's own ack timeout: no answer means "use the browser's".
      const timer = setTimeout(() => {
        removeEventListener("message", onMessage, true);
        resolve({ type: "no-receiving-end" });
      }, 1000);
      addEventListener("message", onMessage, true);
      postMessage({ bridge: "request", msgId, name, body: JSON.stringify(body) });
    });
    async function get(options) {
      const decision = await ask("should-intercept", {});
      const call = { decision: decision.type, origin: location.origin, tab: decision.tab ?? null };
      window.bridgeCalls.push(call);
      if (!decision.fillPasskeys) {
        call.fellBack = true;
        return nativeGet(options);
      }
      const answer = await ask("get-credential", { rpId: options.publicKey.rpId ?? location.hostname });
      if (answer.type != "success") {
        call.fellBack = true;
        return nativeGet(options);
      }
      return { id: answer.id };
    }
    Object.defineProperty(credentials, "get", {
      configurable: false,
      enumerable: true,
      get() { return get; },
      set() {},
    });
  })();
`;

// The isolated half: what 1Password's webauthn.js does.
const ISOLATED = `
  addEventListener("message", async event => {
    const data = event.data;
    if (data?.bridge != "request") {
      return;
    }
    const msgId = data.msgId;
    const message = await browser.runtime.sendMessage({ name: data.name, body: data.body });
    postMessage({ bridge: "reply", msgId, message });
  }, true);
`;

function background() {
  browser.runtime.onMessage.addListener(async (message, sender) => {
    if (!sender.tab) {
      return { type: "no-tab" };
    }
    if (!sender.tab.url) {
      return { type: "no-tab-url" };
    }
    const tab = { url: sender.tab.url, cookieStoreId: sender.tab.cookieStoreId };
    if (message.name == "should-intercept") {
      return { type: "success", fillPasskeys: true, tab };
    }
    if (message.name == "get-credential") {
      return { type: "success", id: "bridge-get" };
    }
    return { type: "unknown" };
  });
}

let extension;
let space;
let profile;
const tabs = [];

async function loaded(browser, url) {
  await TestUtils.waitForCondition(() => browser.currentURI.spec == url &&
    !browser.webProgress.isLoadingDocument, `Loaded ${url}`);
  await SpecialPowers.spawn(browser, [], () => ContentTaskUtils.waitForCondition(
    () => content.document.readyState == "complete", "Fixture complete"));
}

async function openPage(url, userContextId = 0) {
  const tab = BrowserTestUtils.addTab(gBrowser, url, { userContextId });
  tabs.push(tab);
  gBrowser.selectedTab = tab;
  await loaded(tab.linkedBrowser, url);
  const win = tab.linkedBrowser.documentGlobal;
  await SimpleTest.promiseFocus(win);
  tab.linkedBrowser.focus();
  // Native WebAuthn refuses an unfocused document before it prompts, which
  // would hide the very prompt this test watches for.
  await SpecialPowers.spawn(tab.linkedBrowser, [], () => ContentTaskUtils.waitForCondition(
    () => content.document.hasFocus(), "Credential document has focus"));
  return tab;
}

// The same notification WebAuthnPromptHelper opens its doorhanger from.
async function signIn(browser) {
  const prompts = [];
  const observer = (_subject, _topic, data) => {
    const type = JSON.parse(data).prompt.type;
    if (type != "cancel") {
      prompts.push(type);
    }
  };
  Services.obs.addObserver(observer, "webauthn-prompt");
  try {
    const result = await SpecialPowers.spawn(browser, [], async () => {
      const page = content.wrappedJSObject;
      const answer = await page.requestCredential("get");
      return {
        id: answer.id,
        error: answer.error,
        calls: Array.from(page.bridgeCalls ?? [], call => ({
          decision: call.decision,
          fellBack: !!call.fellBack,
          origin: call.origin,
          cookieStoreId: call.tab?.cookieStoreId ?? null,
          url: call.tab?.url ?? null,
        })),
      };
    });
    await TestUtils.waitForTick();
    return { ...result, prompts };
  } finally {
    Services.obs.removeObserver(observer, "webauthn-prompt");
  }
}

function checkHandled(result, url, cookieStoreId, label) {
  is(result.calls.length, 1, `${label}: the page-world hook took the request`);
  is(result.calls[0]?.decision, "success", `${label}: the background answered through the bridge`);
  ok(!result.calls[0]?.fellBack, `${label}: the hook did not fall back to the browser's WebAuthn`);
  is(result.calls[0]?.url, url, `${label}: the background saw this tab`);
  is(result.calls[0]?.cookieStoreId, cookieStoreId, `${label}: the background saw this tab's profile`);
  is(result.id, "bridge-get", `${label}: sign-in resolves with the extension's passkey`);
  is(result.error, null, `${label}: no native error`);
  Assert.deepEqual(result.prompts, [], `${label}: no Firefox security-key prompt`);
}

add_setup(async function () {
  // Whimsy's own Touch ID passkeys sit behind WebAuthnService when on, which
  // is the owner's build; the extension must still come first.
  await SpecialPowers.pushPrefEnv({ set: [["whimsy.feature.passkeys", true]] });
  extension = ExtensionTestUtils.loadExtension({
    useAddonManager: "temporary",
    background,
    manifest: {
      browser_specific_settings: { gecko: { id: "passkey-bridge@whimsy.test" } },
      // 1Password's own: the background reads the asking tab's URL, which
      // needs host access or "tabs".
      permissions: ["<all_urls>", "tabs"],
      content_scripts: [
        { matches: ["https://*/*"], js: ["isolated.js"], all_frames: true, run_at: "document_start" },
        { matches: ["https://*/*"], js: ["main.js"], all_frames: true, run_at: "document_start", world: "MAIN" },
      ],
    },
    files: { "isolated.js": ISOLATED, "main.js": MAIN_WORLD },
  });
  await extension.startup();
  const home = gZenWorkspaces.getActiveWorkspace();
  profile = WhimsyProfiles.create("Passkey Bridge");
  space = await gZenWorkspaces.createAndSaveWorkspace("Passkey Bridge", undefined, true, profile);
  registerCleanupFunction(async () => {
    for (const tab of tabs) {
      if (tab.isConnected && !tab.closing) {
        await BrowserTestUtils.removeTab(tab);
      }
    }
    await gZenWorkspaces.changeWorkspace(home);
    await gZenWorkspaces.removeWorkspace(space.uuid);
    ContextualIdentityService.remove(profile);
    await extension.unload();
  });
});

add_task(async function bridge_answers_on_a_plain_page() {
  const url = PAGE;
  const tab = await openPage(url);
  checkHandled(await signIn(tab.linkedBrowser), url, "firefox-default", "Plain page");
});

add_task(async function bridge_answers_under_a_google_style_policy() {
  const url = PAGE + "?strict";
  const tab = await openPage(url);
  checkHandled(await signIn(tab.linkedBrowser), url, "firefox-default", "Nonce, strict-dynamic, Trusted Types");
});

add_task(async function bridge_answers_in_a_whimsy_profile_tab() {
  await gZenWorkspaces.changeWorkspace(space);
  const url = PAGE + "?strict";
  const tab = await openPage(url, space.containerTabId);
  is(tab.userContextId, space.containerTabId, "The tab is in the profile's container");
  checkHandled(await signIn(tab.linkedBrowser), url, `firefox-container-${space.containerTabId}`,
    "Whimsy profile tab");
});
