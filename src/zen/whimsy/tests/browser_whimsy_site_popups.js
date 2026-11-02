/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// wave9/mini W8-23, the normal-window path (the user's case): a page in an
// ordinary Whimsy window calls window.open(url, name, "width=…,height=…")
// ("Continue with Google"). Firefox makes that a popup window. It must get
// Firefox's minimal popup chrome, not Mini's or a full window's: the
// read-only address bar with its identity (the security indicator), no
// sidebar, no Mini bar, the size the page asked for. It stays attached to
// its opener (window.opener, postMessage, window.close), and Whimsy's
// window extras (season toast, teaching hints, meeting card, Claude's
// target window, Archive) leave it alone. A screenshot is taken for the
// build lane to look at.

const { WhimsyQuickWindow } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyQuickWindow.sys.mjs");
const { WhimsySeasonToast } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsySeasonToast.sys.mjs");
const { WhimsyTeach } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyTeach.sys.mjs");
const { WhimsyClaude } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyClaude.sys.mjs");
const { WhimsyArchive } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyArchive.sys.mjs");

const ROOT = getRootDirectory(gTestPath).replace("chrome://mochitests/content", "https://example.com");
const OPENER = ROOT + "whimsy_oauth_opener.html";
const POPUP = ROOT + "whimsy_oauth_popup.html";

add_setup(async function () {
  await SpecialPowers.pushPrefEnv({ set: [["browser.link.open_newwindow.restriction", 2]] });
});

add_task(async function test_sign_in_popup_from_a_normal_window() {
  await BrowserTestUtils.withNewTab(OPENER, async browser => {
    await SpecialPowers.spawn(browser, [], () =>
      ContentTaskUtils.waitForCondition(() => content.document.readyState == "complete", "Page complete"));
    const minis = WhimsyQuickWindow.windows().length;
    const opened = BrowserTestUtils.waitForNewWindow({ url: POPUP });
    await BrowserTestUtils.synthesizeMouseAtCenter("#continue", {}, browser);
    const popup = await opened;
    const doc = popup.document;
    const root = doc.documentElement;

    // A real popup, attached to its opener.
    ok(!popup.toolbar.visible, "Firefox's popup window");
    ok(root.hasAttribute("popup-window"), "...styled as one");
    ok(!popup._whimsyQuickWindow && !root.hasAttribute("whimsy-quick-window"), "Not a Mini Whimsy window");
    ok(!doc.getElementById("whimsy-quick-window-bar"), "No Mini bar");
    is(WhimsyQuickWindow.windows().length, minis, "No Mini opened");
    const popupBrowser = popup.gBrowser.selectedBrowser;
    is(popupBrowser.browsingContext.opener, browser.browsingContext, "Attached to the page that opened it");
    // W11-12: an ordinary Firefox popup window at the native level too (the
    // macOS passkey sheet presents on the requesting window): not
    // always-on-top, not raised, the browser window type.
    const flags = popup.docShell.treeOwner.QueryInterface(Ci.nsIInterfaceRequestor)
      .getInterface(Ci.nsIAppWindow).chromeFlags;
    ok(!(flags & Ci.nsIWebBrowserChrome.CHROME_ALWAYS_ON_TOP), "Not always on top");
    ok(!(flags & Ci.nsIWebBrowserChrome.CHROME_ALWAYS_RAISED), "Not always raised");
    ok(!(flags & Ci.nsIWebBrowserChrome.CHROME_TOOLBAR), "Firefox's popup flags (no toolbar)");
    is(root.getAttribute("windowtype"), "navigator:browser", "A browser window, like Zen's popup");

    // Firefox's minimal popup chrome: the read-only address with identity
    // (Zen's sidebar, where it normally lives, is collapsed in popups).
    await TestUtils.waitForCondition(() => popup.gURLBar.checkVisibility(), "The address bar shows");
    if (root.hasAttribute("whimsy-site-popup")) {
      is(doc.getElementById("nav-bar").parentElement.id, "zen-appcontent-navbar-container",
        "...in the strip above the page");
    }
    ok(popup.gURLBar.readOnly, "...read-only, as Firefox keeps it in popups");
    await TestUtils.waitForCondition(() => popup.gURLBar.value.includes("example.com"),
      "...showing where the popup is (the security indicator a sign-in needs)");
    ok(doc.getElementById("identity-box")?.checkVisibility(), "The site identity is visible");
    const toolbox = doc.getElementById("navigator-toolbox");
    // Zen may leave its few-px splitter strip; what matters is no tabs and
    // no sidebar to use.
    ok(!toolbox.checkVisibility() || toolbox.getBoundingClientRect().width < 20, "No sidebar in a popup");
    const tabList = doc.getElementById("tabbrowser-tabs");
    ok(!tabList?.checkVisibility() || tabList.getBoundingClientRect().width < 20, "...and no tab list to use");
    const page = popupBrowser.getBoundingClientRect();
    Assert.greater(page.height, 300, `The page has the room it asked for (${page.width}x${page.height})`);
    Assert.lessOrEqual(Math.abs(popup.innerWidth - 420), 40, `The width the page asked for (${popup.innerWidth})`);

    // Whimsy's window extras stay out of it.
    is(WhimsySeasonToast.pending(popup), null, "No season toast in the popup");
    is(WhimsyTeach._kind(popup), "popup", "No teaching hints in the popup");
    isnot(WhimsyClaude.topWindow(), popup, "Claude never targets the popup");
    is(WhimsyArchive.recordClose(popup, popup.gBrowser.selectedTab), null, "Its tab never goes to Archive");

    await shot("site-popup-sign-in", popup.browsingContext.currentWindowGlobal);

    // The sign-in completes: result to the opener, then the popup closes itself.
    const closed = BrowserTestUtils.domWindowClosed(popup);
    await BrowserTestUtils.synthesizeMouseAtCenter("#account", {}, popupBrowser);
    await closed;
    const token = await SpecialPowers.spawn(browser, [], async () => {
      await ContentTaskUtils.waitForCondition(() => content.document.body.dataset.token, "Result arrived");
      return content.document.body.dataset.token;
    });
    is(token, "signed-in", "The opener received the result through postMessage");
    ok(!WhimsyArchive.storedEntries.some(entry => entry.url == POPUP), "Nothing archived when it closed");
  });
});

add_task(async function test_switch_off_leaves_zens_popup_chrome() {
  await SpecialPowers.pushPrefEnv({ set: [["whimsy.feature.site-popup-chrome", false]] });
  await BrowserTestUtils.withNewTab(OPENER, async browser => {
    await SpecialPowers.spawn(browser, [], () =>
      ContentTaskUtils.waitForCondition(() => content.document.readyState == "complete", "Page complete"));
    const opened = BrowserTestUtils.waitForNewWindow({ url: POPUP });
    await BrowserTestUtils.synthesizeMouseAtCenter("#continue", {}, browser);
    const popup = await opened;
    await new Promise(resolve => popup.requestAnimationFrame(() => popup.requestAnimationFrame(resolve)));
    ok(!popup.document.documentElement.hasAttribute("whimsy-site-popup"), "With the switch off, nothing is moved");
    is(popup.gBrowser.selectedBrowser.browsingContext.opener, browser.browsingContext, "...and the popup is still attached");
    await BrowserTestUtils.closeWindow(popup);
  });
  await SpecialPowers.popPrefEnv();
});

// W11-12: a password manager's passkey flow in a sign-in popup ("Continue
// with Google", then "Use your passkey"). 1Password hooks
// navigator.credentials from its content script and talks to its
// background page about the popup's tab. An extension limited to the
// opener's profile must run in the popup exactly as in the opener's tab:
// its content script, its page-world hook, its messages (with the popup's
// tab as the sender) and the tabs API on that tab. The popup's page must
// also have focus, or WebAuthn refuses the request.
add_task(async function test_extension_runs_in_sign_in_popup() {
  const { WhimsySpaceExtensions } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsySpaceExtensions.sys.mjs");
  const { WhimsyProfiles } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyProfiles.sys.mjs");
  const extension = ExtensionTestUtils.loadExtension({
    useAddonManager: "temporary",
    manifest: {
      permissions: ["tabs", "cookies"],
      content_scripts: [{ matches: ["https://example.com/*"], js: ["cs.js"], run_at: "document_start", all_frames: true }],
    },
    background() {
      browser.runtime.onMessage.addListener(async (message, sender) => {
        let tabsGet = null;
        try {
          tabsGet = (await browser.tabs.get(sender.tab.id))?.url ?? null;
        } catch (e) {
          tabsGet = "error: " + e.message;
        }
        browser.test.sendMessage("content", {
          message,
          url: sender.url,
          tabId: sender.tab?.id ?? null,
          cookieStoreId: sender.tab?.cookieStoreId ?? null,
          tabsGet,
        });
      });
    },
    files: {
      "cs.js": `
        if (window == window.top) {
          browser.runtime.sendMessage(location.pathname.split("/").pop());
        }
        try {
          const credentials = window.wrappedJSObject.navigator.credentials;
          exportFunction(function () {
            document.documentElement.dataset.passkeyHook = "called";
            return window.wrappedJSObject.Promise.resolve(null);
          }, credentials, { defineAs: "get" });
          document.documentElement.dataset.whimsyExtension = "ran";
        } catch (e) {
          document.documentElement.dataset.whimsyExtension = "error: " + e;
        }
      `,
    },
  });
  await extension.startup();
  const profileId = WhimsyProfiles.activeProfileId(window) ?? 0;
  const key = WhimsyProfiles.keyFor(profileId);
  // Limited to the opener's profile: the per-profile isolation is on.
  WhimsySpaceExtensions.setAllowedProfiles(extension.id, [key]);
  try {
    const tab = BrowserTestUtils.addTab(gBrowser, OPENER, { userContextId: profileId });
    gBrowser.selectedTab = tab;
    const browser = tab.linkedBrowser;
    await TestUtils.waitForCondition(() => browser.currentURI.spec == OPENER && !browser.webProgress?.isLoadingDocument,
      "The opener page loaded");
    const first = await extension.awaitMessage("content");
    is(first.message, "whimsy_oauth_opener.html", "The extension runs in the opener");

    const opened = BrowserTestUtils.waitForNewWindow({ url: POPUP });
    await BrowserTestUtils.synthesizeMouseAtCenter("#continue", {}, browser);
    const popup = await opened;
    const popupBrowser = popup.gBrowser.selectedBrowser;
    const seen = await extension.awaitMessage("content");
    is(seen.message, "whimsy_oauth_popup.html", "Its content script runs in the sign-in popup");
    is(seen.url, POPUP, "...and messages its background page from there");
    Assert.notEqual(seen.tabId, null, "The popup's tab is the sender");
    is(seen.tabsGet, POPUP, "The tabs API can see the popup's tab");
    is(popupBrowser.contentPrincipal.originAttributes.userContextId, profileId,
      "The popup is in the opener's profile");

    const state = await SpecialPowers.spawn(popupBrowser, [], async () => {
      await ContentTaskUtils.waitForCondition(() => content.document.hasFocus(), "The popup's page has focus");
      // As the sign-in page itself would call it.
      await content.wrappedJSObject.eval("navigator.credentials.get({ publicKey: { challenge: new Uint8Array(16) } })");
      return {
        ran: content.document.documentElement.dataset.whimsyExtension,
        hook: content.document.documentElement.dataset.passkeyHook,
      };
    });
    is(state.ran, "ran", "The content script ran in the popup's page");
    is(state.hook, "called", "The page's passkey request reaches the extension's hook");
    await BrowserTestUtils.closeWindow(popup);
    BrowserTestUtils.removeTab(tab);
  } finally {
    WhimsySpaceExtensions.setAllowedProfiles(extension.id, null);
    await extension.unload();
  }
});

// W11-12, the browser's own passkey path (1Password falls back to it for
// Google's related-origin requests): navigator.credentials.get in a sign-in
// popup must work exactly as in a tab. A virtual authenticator holds a
// passkey for example.com.
add_task(async function test_passkey_in_sign_in_popup() {
  await SpecialPowers.pushPrefEnv({
    set: [
      ["security.webauth.webauthn", true],
      ["security.webauth.webauthn_enable_softtoken", true],
      ["security.webauth.webauthn_enable_usbtoken", false],
      ["security.webauthn.ctap2", true],
      ["security.webauthn.enable_macos_passkeys", false],
    ],
  });
  const service = Cc["@mozilla.org/webauthn/service;1"].getService(Ci.nsIWebAuthnService);
  const authenticator = service.addVirtualAuthenticator("ctap2_1", "internal", true, true, true, true);
  const keyPair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign"]);
  const b64url = bytes => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const credBytes = crypto.getRandomValues(new Uint8Array(32));
  const credId = b64url(credBytes);
  service.addCredential(authenticator, credId, true, "example.com",
    b64url(await crypto.subtle.exportKey("pkcs8", keyPair.privateKey)), "VGVzdCBVc2Vy", 0);
  const getAssertion = browser => SpecialPowers.spawn(browser, [[...credBytes]], async bytes => {
    try {
      const assertion = await content.navigator.credentials.get({
        publicKey: {
          challenge: content.crypto.getRandomValues(new Uint8Array(16)),
          rpId: "example.com",
          allowCredentials: [{ type: "public-key", id: new Uint8Array(bytes), transports: ["internal"] }],
          userVerification: "discouraged",
        },
      });
      return assertion ? "ok" : "none";
    } catch (e) {
      return `${e.name}: ${e.message}`;
    }
  });
  try {
    await BrowserTestUtils.withNewTab(OPENER, async browser => {
      is(await getAssertion(browser), "ok", "The passkey works in a tab");
      const opened = BrowserTestUtils.waitForNewWindow({ url: POPUP });
      await BrowserTestUtils.synthesizeMouseAtCenter("#continue", {}, browser);
      const popup = await opened;
      const popupBrowser = popup.gBrowser.selectedBrowser;
      await SpecialPowers.spawn(popupBrowser, [], () =>
        ContentTaskUtils.waitForCondition(() => content.document.hasFocus(), "The popup's page has focus"));
      is(await getAssertion(popupBrowser), "ok", "...and in the sign-in popup");
      await BrowserTestUtils.closeWindow(popup);
    });
  } finally {
    service.removeVirtualAuthenticator(authenticator);
    await SpecialPowers.popPrefEnv();
  }
});

// W11-12, the user's case: LinkedIn's "Continue with Google". The popup is
// cross-origin and Google serves it with Cross-Origin-Opener-Policy:
// same-origin-allow-popups, so it moves to its own browsing context group
// (and process) as it loads. After that switch the page must still have
// focus, run the extension's content script, and get the passkey.
add_task(async function test_coop_sign_in_popup() {
  await SpecialPowers.pushPrefEnv({
    set: [
      ["security.webauth.webauthn", true],
      ["security.webauth.webauthn_enable_softtoken", true],
      ["security.webauth.webauthn_enable_usbtoken", false],
      ["security.webauthn.ctap2", true],
      ["security.webauthn.enable_macos_passkeys", false],
    ],
  });
  const OPENER_COOP = ROOT + "whimsy_oauth_opener_coop.html";
  const POPUP_COOP = "https://example.org/browser/zen/whimsy/tests/whimsy_oauth_popup_coop.html";
  const extension = ExtensionTestUtils.loadExtension({
    manifest: { content_scripts: [{ matches: ["https://example.org/*"], js: ["cs.js"], run_at: "document_start" }] },
    files: { "cs.js": "document.documentElement.dataset.whimsyExtension = 'ran';" },
  });
  await extension.startup();
  const service = Cc["@mozilla.org/webauthn/service;1"].getService(Ci.nsIWebAuthnService);
  const authenticator = service.addVirtualAuthenticator("ctap2_1", "internal", true, true, true, true);
  const keyPair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign"]);
  const b64url = bytes => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const credBytes = crypto.getRandomValues(new Uint8Array(32));
  service.addCredential(authenticator, b64url(credBytes), true, "example.org",
    b64url(await crypto.subtle.exportKey("pkcs8", keyPair.privateKey)), "VGVzdCBVc2Vy", 0);
  let popup = null;
  try {
    await BrowserTestUtils.withNewTab(OPENER_COOP, async browser => {
      const opened = BrowserTestUtils.waitForNewWindow({ url: POPUP_COOP });
      await BrowserTestUtils.synthesizeMouseAtCenter("#continue", {}, browser);
      popup = await opened;
      const popupBrowser = popup.gBrowser.selectedBrowser;
      await TestUtils.waitForCondition(() => popupBrowser.currentURI.spec == POPUP_COOP && !popupBrowser.webProgress?.isLoadingDocument,
        "The COOP sign-in page loaded");
      is(popupBrowser.browsingContext.opener, null, "COOP gave it its own browsing context group (no opener)");
      const state = await SpecialPowers.spawn(popupBrowser, [[...credBytes]], async bytes => {
        await ContentTaskUtils.waitForCondition(() => content.document.hasFocus(), "The popup's page has focus");
        let result;
        try {
          const assertion = await content.navigator.credentials.get({
            publicKey: {
              challenge: content.crypto.getRandomValues(new Uint8Array(16)),
              rpId: "example.org",
              allowCredentials: [{ type: "public-key", id: new Uint8Array(bytes), transports: ["internal"] }],
              userVerification: "discouraged",
            },
          });
          result = assertion ? "ok" : "none";
        } catch (e) {
          result = `${e.name}: ${e.message}`;
        }
        return { result, ran: content.document.documentElement.dataset.whimsyExtension };
      });
      is(state.ran, "ran", "The extension's content script ran in the COOP popup");
      is(state.result, "ok", "The passkey works in the COOP popup");
      is(popup.document.activeElement?.closest?.("#urlbar"), null, "The address bar didn't take focus from the page");
      await BrowserTestUtils.closeWindow(popup);
      popup = null;
    });
  } finally {
    if (popup && !popup.closed) {
      await BrowserTestUtils.closeWindow(popup);
    }
    service.removeVirtualAuthenticator(authenticator);
    await extension.unload();
    await SpecialPowers.popPrefEnv();
  }
});

// Same screenshot convention as browser_whimsy_screens.js (WHIMSY_SHOTS).
async function shot(name, windowGlobal) {
  const dir = Services.env.get("WHIMSY_SHOTS");
  if (!dir) {
    return;
  }
  const bitmap = await windowGlobal.drawSnapshot(null, 1, "white");
  const canvas = document.createElementNS("http://www.w3.org/1999/xhtml", "canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  canvas.getContext("2d").drawImage(bitmap, 0, 0);
  const blob = await new Promise(resolve => canvas.toBlob(resolve));
  const path = PathUtils.join(dir, `${name}.png`);
  await IOUtils.write(path, new Uint8Array(await blob.arrayBuffer()));
  info(`Saved ${path}`);
}
