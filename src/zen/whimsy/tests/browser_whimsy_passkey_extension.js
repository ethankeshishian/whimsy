/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// BUGS.md #21: a loaded extension must intercept the actual page-world
// request, including the first head script. Merely seeing a content script
// marker, or succeeding through a virtual native authenticator, proves less.
const { WhimsyProfiles } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyProfiles.sys.mjs");
const { WhimsyProfileMoves } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyProfileMoves.sys.mjs");
const { WhimsySpaceExtensions } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsySpaceExtensions.sys.mjs");
const { WhimsyQuickWindow } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyQuickWindow.sys.mjs");
const { WhimsyPrivate } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyPrivate.sys.mjs");
const { ContextualIdentityService } = ChromeUtils.importESModule("moz-src:///toolkit/components/contextualidentity/ContextualIdentityService.sys.mjs");
const ROOT = getRootDirectory(gTestPath).replace("chrome://mochitests/content", "https://example.com");
const PAGE = ROOT + "whimsy_passkey_extension.sjs";
const tabs = new Set();
const windows = new Set();
const spaces = [];
const profiles = [];
let home, defaultSpace, workSpace, extension;

async function installPasskeyExtension(privateAllowed = false) {
  const ext = ExtensionTestUtils.loadExtension({
    useAddonManager: "temporary",
    // Temporary test extensions can otherwise receive private access from
    // harness defaults. Model the user's default explicitly.
    incognitoOverride: privateAllowed ? "spanning" : "not_allowed",
    manifest: {
      // MockExtension sets the private permission before AddonManager installs
      // the XPI, so it needs an ID on the input manifest before installation.
      browser_specific_settings: { gecko: { id: "passkey-interception@whimsy.test" } },
      content_scripts: [{
        matches: ["https://example.com/*", "https://example.org/*"],
        js: ["passkey.js"],
        all_frames: true,
        run_at: "document_start",
        world: "MAIN",
      }],
    },
    files: {
      "passkey.js": `
        window.passkeyExtensionCalls = [];
        for (const method of ["get", "create"]) {
          Object.defineProperty(navigator.credentials, method, {
            configurable: true,
            value(options) {
              window.passkeyExtensionCalls.push({
                method, mediation: options.mediation ?? null, origin: location.origin,
              });
              return Promise.resolve({ id: "extension-" + method });
            },
          });
        }
      `,
    },
  });
  await ext.startup();
  const policy = WebExtensionPolicy.getByID(ext.id);
  ok(policy?.active, "Passkey extension policy is active before opening fixtures");
  is(policy?.privateBrowsingAllowed, privateAllowed, "Private permission matches the requested install");
  is(WhimsySpaceExtensions.getAllowedProfiles(ext.id), null, "User install defaults to All Profiles");
  return ext;
}

async function loaded(browser, url = PAGE) {
  await TestUtils.waitForCondition(() => browser.currentURI.spec == url &&
    !browser.webProgress.isLoadingDocument, `Loaded ${url}`);
  await SpecialPowers.spawn(browser, [], () => ContentTaskUtils.waitForCondition(
    () => content.document.readyState == "complete", "Fixture complete"));
}

async function newTab(url = PAGE, userContextId = 0) {
  const tab = BrowserTestUtils.addTab(gBrowser, url, { userContextId });
  tabs.add(tab);
  gBrowser.selectedTab = tab;
  await loaded(tab.linkedBrowser, url);
  return tab;
}

// The observer is the same notification source WebAuthnPromptHelper uses.
// Keep it active through document_start and asynchronous request completion;
// checking only the currently visible panel can miss a short-lived prompt.
async function watchNative(callback) {
  const prompts = [];
  const observer = (_subject, _topic, data) => {
    const type = JSON.parse(data).prompt.type;
    if (type != "cancel") {
      prompts.push(type);
    }
  };
  Services.obs.addObserver(observer, "webauthn-prompt");
  try {
    const value = await callback();
    await TestUtils.waitForTick();
    return { value, prompts };
  } finally {
    Services.obs.removeObserver(observer, "webauthn-prompt");
  }
}

async function credential(browserOrContext, method = "get", conditional = false) {
  return SpecialPowers.spawn(browserOrContext, [method, conditional], async (m, c) => {
    const page = content.wrappedJSObject;
    const result = await page.requestCredential(m, c);
    return {
      id: result.id,
      error: result.error,
      calls: Array.from(page.passkeyExtensionCalls ?? [], call => ({
        method: call.method, mediation: call.mediation, origin: call.origin,
      })),
    };
  });
}

async function focusCredentialPage(browser) {
  const win = browser.documentGlobal;
  await SimpleTest.promiseFocus(win);
  browser.focus();
  // Remote content focus follows chrome focus asynchronously. Native WebAuthn
  // rejects an unfocused document before it can open an authenticator prompt.
  await SpecialPowers.spawn(browser, [], () => ContentTaskUtils.waitForCondition(
    () => content.document.hasFocus(), "Credential document has focus"));
}

async function intercepted(browser, label, conditional = false) {
  await focusCredentialPage(browser);
  const observed = await watchNative(async () => {
    const get = await credential(browser, "get", conditional);
    is(get.id, "extension-get", `${label}: get resolves through extension`);
    is(get.error, null, `${label}: get has no native error`);
    const create = await credential(browser, "create");
    is(create.id, "extension-create", `${label}: create resolves through extension`);
    is(create.error, null, `${label}: create has no native error`);
    Assert.deepEqual(create.calls.slice(-2).map(call => call.method), ["get", "create"],
      `${label}: page records both calls`);
    is(get.calls.at(-1)?.mediation, conditional ? "conditional" : null, `${label}: mediation preserved`);
    is(get.calls.at(-1)?.origin, browser.currentURI.prePath, `${label}: hook belongs to this document`);
  });
  Assert.deepEqual(observed.prompts, [], `${label}: no Firefox WebAuthn prompt opened`);
}

add_setup(async function () {
  requestLongerTimeout(4);
  await SpecialPowers.pushPrefEnv({ set: [["browser.link.open_newwindow.restriction", 2]] });
  home = gZenWorkspaces.getActiveWorkspace();
  registerCleanupFunction(async () => {
    await WhimsyPrivate.closeScratch(window);
    for (const win of windows) {
      if (!win.closed) {
        await BrowserTestUtils.closeWindow(win);
      }
    }
    for (const tab of tabs) {
      if (tab.isConnected && !tab.closing) {
        await BrowserTestUtils.removeTab(tab);
      }
    }
    await gZenWorkspaces.changeWorkspace(home);
    for (const space of spaces) {
      await gZenWorkspaces.removeWorkspace(space.uuid);
    }
    for (const id of profiles) {
      ContextualIdentityService.remove(id);
    }
    if (extension) {
      await extension.unload();
    }
  });
  defaultSpace = await gZenWorkspaces.createAndSaveWorkspace("Passkey Default", undefined, true, 0);
  spaces.push(defaultSpace);
  const work = WhimsyProfiles.create("Passkey Work");
  profiles.push(work);
  workSpace = await gZenWorkspaces.createAndSaveWorkspace("Passkey Work", undefined, true, work);
  spaces.push(workSpace);
  extension = await installPasskeyExtension();
});

add_task(async function profiles_pins_essentials_and_new_profile() {
  await gZenWorkspaces.changeWorkspace(defaultSpace);
  const normal = await newTab();
  await intercepted(normal.linkedBrowser, "Default profile tab");
  gBrowser.pinTab(normal);
  await intercepted(normal.linkedBrowser, "Pinned tab");
  gZenPinnedTabManager.addToEssentials(normal);
  ok(normal.hasAttribute("zen-essential"), "Real Essential tab");
  await intercepted(normal.linkedBrowser, "Essential tab");

  await gZenWorkspaces.changeWorkspace(workSpace);
  const work = await newTab(PAGE, workSpace.containerTabId);
  is(work.userContextId, workSpace.containerTabId, "Second space uses a different profile/container");
  await intercepted(work.linkedBrowser, "Second profile");

  // Created after installation, to catch stale restrictions on new identities.
  const fresh = WhimsyProfiles.create("Passkey Newly Created");
  profiles.push(fresh);
  const freshSpace = await gZenWorkspaces.createAndSaveWorkspace("Passkey New", undefined, true, fresh);
  spaces.push(freshSpace);
  await gZenWorkspaces.changeWorkspace(freshSpace);
  const freshTab = await newTab(PAGE, fresh);
  await intercepted(freshTab.linkedBrowser, "Newly created profile");
  const question = BrowserTestUtils.promiseAlertDialogOpen(null);
  const moving = WhimsyProfileMoves.moveSpace(window, freshSpace, workSpace.containerTabId);
  EventUtils.synthesizeKey("KEY_Enter", {}, await question);
  ok(await moving, "Accepted the space's profile change");
  const reopened = await TestUtils.waitForCondition(() =>
    gZenWorkspaces.allStoredTabs.find(tab => tab != freshTab && !tab.closing &&
      tab.getAttribute("zen-workspace-id") == freshSpace.uuid &&
      tab.userContextId == workSpace.containerTabId && tab.linkedBrowser?.currentURI.spec == PAGE),
  "Space's page reopened in its new profile");
  tabs.add(reopened);
  gBrowser.selectedTab = reopened;
  await loaded(reopened.linkedBrowser);
  await intercepted(reopened.linkedBrowser, "After changing a space's profile");
  await gZenWorkspaces.changeWorkspace(defaultSpace);
  gBrowser.selectedTab = normal;
  await intercepted(normal.linkedBrowser, "Return after profile/space switch");
});

add_task(async function extension_account_tabs_stay_in_the_invoking_space() {
  // Both containers are unique to one space: this exercises the actual
  // force-container-workspace branch, rather than mocking the space manager.
  const accountSpaces = [];
  for (const name of ["Account A", "Account B"]) {
    const profile = WhimsyProfiles.create(name);
    profiles.push(profile);
    const space = await gZenWorkspaces.createAndSaveWorkspace(name, undefined, true, profile);
    spaces.push(space);
    accountSpaces.push(space);
  }
  const [a, b] = accountSpaces;
  const httpAccount = PAGE.replace("https:", "http:") + "?account=one";
  const mock = ExtensionTestUtils.loadExtension({
    // tabs.create updates ExtensionSettingsStore, which reads installDate from
    // AddonManager. A bare in-memory Extension has no corresponding add-on.
    useAddonManager: "temporary",
    manifest: {
      permissions: ["tabs", "cookies", "contextualIdentities"],
      content_scripts: [{
        matches: ["http://example.com/*"], js: ["account-content.js"],
        run_at: "document_start", world: "MAIN",
      }],
    },
    background() {
      browser.test.onMessage.addListener(async (operation, properties) => {
        try {
          let tab;
          let accountURL;
          if (operation == "update") {
            const { id, ...update } = properties;
            accountURL = update.url;
            tab = await browser.tabs.update(id, update);
          } else {
            const { account, ...create } = properties;
            if (account == "two") {
              create.url = browser.runtime.getURL("account-two.html");
            }
            accountURL = create.url;
            if (operation == "window") {
              const { active, ...options } = create;
              const win = await browser.windows.create(options);
              tab = win.tabs[0];
            } else {
              tab = await browser.tabs.create(create);
            }
          }
          browser.test.sendMessage("account-result", { ...tab, accountURL });
        } catch (error) {
          browser.test.sendMessage("account-result", { error: error.message });
        }
      });
    },
    files: {
      "account-two.html": "<!doctype html><title>Second account sign in</title><p>Sign in</p>",
      "account-content.js": "window.accountContentScript = location.href;",
    },
  });
  await mock.startup();
  const { ExtensionParent } = ChromeUtils.importESModule("resource://gre/modules/ExtensionParent.sys.mjs");
  const { tabTracker } = ExtensionParent.apiManager.global;
  const originalRoutes = gZenSpaceRoutingManager.getAllRoutes;
  // Isolate this regression from the test profile's saved site rules. The
  // last case supplies a rule through the real routing matcher/dispatcher.
  let rules = [];
  gZenSpaceRoutingManager.getAllRoutes = () => rules;
  await SpecialPowers.pushPrefEnv({ set: [
    ["zen.workspaces.force-container-workspace", true],
    // This case explicitly tests an HTTP content script. Keep HTTPS-First
    // from upgrading its URL out of both the matcher and the load assertion.
    ["dom.security.https_first", false],
  ] });
  async function request(operation, properties) {
    mock.sendMessage(operation, properties);
    const result = await mock.awaitMessage("account-result");
    Assert.ok(!result.error, result.error || "Extension API succeeded");
    const tab = tabTracker.getTab(result.id);
    tabs.add(tab);
    if (operation == "window") {
      // Gecko exposes a chrome node's window through documentGlobal.
      // Track it before waiting so failed startup still closes the window.
      const win = tab.documentGlobal;
      windows.add(win);
      is(win.gBrowser.getTabForBrowser(tab.linkedBrowser), tab,
        "Extension API tab belongs to the tracked browser window");
      await TestUtils.waitForCondition(() => win.gZenStartup?.isReady,
        "Extension window initialized");
    }
    info(`DEBUGW24 request(${operation}) tab.id=${tab.id} userContextId=${tab.userContextId} ` +
      `zen-workspace-id=${tab.getAttribute("zen-workspace-id")} active=${gZenWorkspaces.activeWorkspace} ` +
      `target=${result.accountURL}`);
    try {
      await loaded(tab.linkedBrowser, result.accountURL);
    } catch (e) {
      info(`DEBUGW24 loaded() failed for tab.id=${tab.id} closing=${tab.closing} ` +
        `connected=${tab.isConnected} userContextId=${tab.userContextId} ` +
        `zen-workspace-id=${tab.getAttribute("zen-workspace-id")} ` +
        `browser=${!!tab.linkedBrowser} currentURI=${tab.linkedBrowser?.currentURI?.spec} ` +
        `webProgress=${!!tab.linkedBrowser?.webProgress} ` +
        `isLoadingDocument=${tab.linkedBrowser?.webProgress?.isLoadingDocument}`);
      throw e;
    }
    return { tab, result };
  }
  async function stays(space, properties, expectedProfile = space.containerTabId) {
    await gZenWorkspaces.changeWorkspace(space);
    await newTab(PAGE, space.containerTabId);
    const switches = [];
    const onSwitch = () => switches.push(gZenWorkspaces.activeWorkspace);
    Services.prefs.addObserver("zen.workspaces.active", onSwitch);
    try {
      const opened = await request("create", { active: true, ...properties });
      is(opened.tab.getAttribute("zen-workspace-id"), space.uuid, "Account tab belongs to invoking space");
      is(opened.tab.userContextId, expectedProfile, "Account tab uses the expected profile");
      is(gZenWorkspaces.activeWorkspace, space.uuid, "Opening an account leaves the active space unchanged");
      Assert.deepEqual(switches, [], "No transient space jump while opening the account");
      return opened;
    } finally {
      Services.prefs.removeObserver("zen.workspaces.active", onSwitch);
    }
  }
  try {
    // These fail without the fix: the add-on-principal early return leaves
    // userContextId undefined, so Gecko creates both accounts in container 0.
    for (const force of [false, true]) {
      await SpecialPowers.pushPrefEnv({ set: [["zen.workspaces.force-container-workspace", force]] });
      try {
        for (const space of [a, b]) {
          const web = await stays(space, { url: httpAccount });
          is(await SpecialPowers.spawn(web.tab.linkedBrowser, [], () =>
            content.wrappedJSObject.accountContentScript), httpAccount,
          "All Profiles content script runs in each space's HTTP account page");
          const own = await stays(space, { account: "two" });
          ok(own.result.accountURL.startsWith("moz-extension://"), "Second account is the extension's own page");
          is(own.result.cookieStoreId, `firefox-container-${space.containerTabId}`, "Returned store matches the space profile");
        }
      } finally {
        await SpecialPowers.popPrefEnv();
      }
    }

    // Firefox API parity: an explicit store must keep that cookie jar. Arc's
    // profile invariant means it belongs in a B space, never B's cookies in A.
    await gZenWorkspaces.changeWorkspace(a);
    await newTab(PAGE, a.containerTabId);
    const explicit = await request("create", {
      url: httpAccount, active: true, cookieStoreId: `firefox-container-${b.containerTabId}`,
    });
    await TestUtils.waitForCondition(() => gZenWorkspaces.activeWorkspace == b.uuid &&
      explicit.tab.getAttribute("zen-workspace-id") == b.uuid, "Explicit B store opens in B's space");
    is(explicit.tab.userContextId, b.containerTabId, "Explicit B request keeps its profile");
    is(explicit.result.cookieStoreId, `firefox-container-${b.containerTabId}`, "Explicit cookie store is honored");

    // Reuse preserves the existing document's profile and space. A background
    // update doesn't focus it; active:true intentionally selects it (Firefox's
    // tabs.update contract) and therefore reveals its original space in Zen.
    const existing = await stays(b, { url: httpAccount });
    await gZenWorkspaces.changeWorkspace(a);
    await newTab(PAGE, a.containerTabId);
    await request("update", { id: existing.result.id, url: httpAccount + "&reuse=background", active: false });
    is(gZenWorkspaces.activeWorkspace, a.uuid, "Background reuse does not switch spaces");
    await request("update", { id: existing.result.id, url: httpAccount + "&reuse=active", active: true });
    await TestUtils.waitForCondition(() => gZenWorkspaces.activeWorkspace == b.uuid &&
      gBrowser.selectedTab == existing.tab, "Explicit activation reveals the existing account tab");
    is(existing.tab.getAttribute("zen-workspace-id"), b.uuid, "Reuse never moves the existing tab");
    is(existing.tab.userContextId, b.containerTabId, "Reuse never changes its cookie jar");

    for (const properties of [
      { url: httpAccount },
      { account: "two", type: "popup" },
      { url: httpAccount, cookieStoreId: `firefox-container-${b.containerTabId}` },
    ]) {
      await SimpleTest.promiseFocus(window);
      await gZenWorkspaces.changeWorkspace(a);
      const opened = await request("window", properties);
      const win = opened.tab.documentGlobal;
      try {
        if (win.gZenWorkspaces.workspaceEnabled) {
          await TestUtils.waitForCondition(() => win.gZenWorkspaces.activeWorkspace ==
            (properties.cookieStoreId ? b.uuid : a.uuid), "Window shows the requested profile's space");
        }
        is(opened.tab.userContextId, properties.cookieStoreId ? b.containerTabId : a.containerTabId,
          "Extension window inherits profile unless a store was explicitly requested");
      } finally {
        await BrowserTestUtils.closeWindow(win);
      }
    }

    // A user rule wins even over an explicit third profile (Default), which
    // differs from both the source A and the destination B.
    rules = [{ reference: "account=one", matchType: "contains", openIn: b.uuid }];
    await gZenWorkspaces.changeWorkspace(a);
    await newTab(PAGE, a.containerTabId);
    const routed = await request("create", {
      url: httpAccount, active: true, cookieStoreId: "firefox-default",
    });
    await TestUtils.waitForCondition(() => gZenWorkspaces.activeWorkspace == b.uuid, "User site rule wins");
    is(routed.tab.getAttribute("zen-workspace-id"), b.uuid, "Rule selected destination space");
    is(routed.tab.userContextId, b.containerTabId, "Rule selected destination profile");
    await SimpleTest.promiseFocus(window);
    await gZenWorkspaces.changeWorkspace(a);
    const routedWindow = await request("window", {
      url: httpAccount, cookieStoreId: "firefox-default",
    });
    try {
      await TestUtils.waitForCondition(() => routedWindow.tab.documentGlobal.gZenWorkspaces.activeWorkspace == b.uuid,
        "User rule routes the extension's initial window tab");
      is(routedWindow.tab.userContextId, b.containerTabId, "Window's initial tab uses the rule's profile");
    } finally {
      await BrowserTestUtils.closeWindow(routedWindow.tab.documentGlobal);
    }
  } finally {
    gZenSpaceRoutingManager.getAllRoutes = originalRoutes;
    await SpecialPowers.popPrefEnv();
    await mock.unload();
  }
});

add_task(async function glance_mini_and_mini_profile_switch() {
  await gZenWorkspaces.changeWorkspace(workSpace);
  const parent = await newTab(PAGE, workSpace.containerTabId);
  try {
    const glance = await gZenGlanceManager.openGlance({
      url: PAGE, clientX: 0, clientY: 0, width: 0, height: 0,
      triggeringPrincipal: parent.linkedBrowser.contentPrincipal,
    });
    await loaded(glance.linkedBrowser);
    is(glance.userContextId, parent.userContextId, "Glance inherits its parent's profile");
    await intercepted(glance.linkedBrowser, "Glance");
  } finally {
    await gZenGlanceManager.closeGlance({ onTabClose: true });
  }
  const mini = WhimsyQuickWindow.open(PAGE, { opener: window });
  windows.add(mini);
  try {
    await WhimsyQuickWindow.whenReady(mini);
    await loaded(mini.gBrowser.selectedBrowser);
    is(mini.gBrowser.selectedTab.userContextId, workSpace.containerTabId, "Mini uses destination profile");
    await intercepted(mini.gBrowser.selectedBrowser, "Mini Whimsy / Quick Window");
    const shown = BrowserTestUtils.waitForEvent(mini.document, "popupshown", false,
      e => e.target.id == "whimsy-quick-window-profile-picker");
    mini.document.getElementById("whimsy-quick-window-profile").click();
    const { target: picker } = await shown;
    picker.activateItem([...picker.children].find(item => item.getAttribute("label") == "Default"));
    await TestUtils.waitForCondition(() => mini.gBrowser.selectedTab.userContextId == 0, "Mini switched profile");
    await loaded(mini.gBrowser.selectedBrowser);
    await intercepted(mini.gBrowser.selectedBrowser, "After Mini profile switch");
  } finally {
    await BrowserTestUtils.closeWindow(mini);
  }
});

add_task(async function site_and_cross_origin_coop_popups() {
  await gZenWorkspaces.changeWorkspace(workSpace);
  const opener = await newTab(PAGE, workSpace.containerTabId);
  for (const url of [PAGE + "?popup", PAGE.replace("example.com", "example.org") + "?coop"]) {
    const observed = await watchNative(async () => {
      await SpecialPowers.spawn(opener.linkedBrowser, [url], target => {
        content.wrappedJSObject.passkeyPopupURL = target;
      });
      const opened = BrowserTestUtils.waitForNewWindow({ url });
      await BrowserTestUtils.synthesizeMouseAtCenter("#popup", {}, opener.linkedBrowser);
      const popup = await opened;
      windows.add(popup);
      try {
        await loaded(popup.gBrowser.selectedBrowser, url);
        ok(!popup.toolbar.visible && !popup._whimsyQuickWindow, "Real site popup");
        is(popup.gBrowser.selectedTab.userContextId, opener.userContextId, "Popup inherits opener profile");
        if (url.endsWith("?coop")) {
          is(popup.gBrowser.selectedBrowser.browsingContext.opener, null, "Cross-origin COOP changes browsing context group");
        }
        await intercepted(popup.gBrowser.selectedBrowser, url);
      } finally {
        await BrowserTestUtils.closeWindow(popup);
      }
    });
    Assert.deepEqual(observed.prompts, [], "No native prompt during popup loading or requests");
  }
});

add_task(async function cross_origin_frame_csp_early_and_conditional() {
  await gZenWorkspaces.changeWorkspace(defaultSpace);
  const frameTab = await newTab(PAGE + "?frame");
  const child = frameTab.linkedBrowser.browsingContext.children[0];
  is(await SpecialPowers.spawn(frameTab.linkedBrowser, [], () =>
    content.document.getElementById("credential-frame").getAttribute("allow")),
  "publickey-credentials-get", "Cross-origin iframe explicitly delegates WebAuthn get");
  const observed = await watchNative(async () => {
    const result = await credential(child);
    is(result.id, "extension-get", "Cross-origin frame request reaches extension");
    is(result.calls.at(-1)?.origin, "https://example.org", "Hook is in the cross-origin frame");
    const create = await credential(child, "create");
    is(create.id, "extension-create", "all_frames installs both wrappers in child");
  });
  Assert.deepEqual(observed.prompts, [], "Iframe never opens native prompt");
  const csp = await newTab(PAGE + "?csp");
  is(await SpecialPowers.spawn(csp.linkedBrowser, [], () => content.wrappedJSObject.inlineScriptRan),
    undefined, "Strict CSP actually blocks page inline scripts");
  await intercepted(csp.linkedBrowser, "Strict script-src self CSP");
  const early = await watchNative(async () => {
    const tab = await newTab(PAGE + "?early");
    return SpecialPowers.spawn(tab.linkedBrowser, [], async () => {
      const page = content.wrappedJSObject;
      const result = await page.earlyCredential;
      return { id: result.id, first: page.passkeyExtensionCalls?.[0]?.method };
    });
  });
  is(early.value.id, "extension-get", "Immediate inline head request reaches document_start hook");
  is(early.value.first, "get", "Early call recorded by extension");
  Assert.deepEqual(early.prompts, [], "No native prompt for early request");
  await intercepted((await newTab()).linkedBrowser, "Conditional mediation", true);
});

async function privateNativeResult(browser) {
  await focusCredentialPage(browser);
  const observed = await watchNative(() => credential(browser));
  is(observed.value.calls.length, 0, "No private permission: extension never handles get");
  is(observed.value.id, null, "No synthetic extension result in private document");
  ok(observed.value.error, "Native request terminates (abort/error), never hangs");
  return { error: observed.value.error, prompts: observed.prompts };
}

add_task(async function private_permission_matches_firefox() {
  await gZenWorkspaces.changeWorkspace(defaultSpace);
  // A true private window is the Gecko baseline for Whimsy's private tabs
  // inside a normal window. Do not disable WebAuthn or use a virtual token.
  const baseline = await BrowserTestUtils.openNewBrowserWindow({ private: true });
  windows.add(baseline);
  try {
    const browser = baseline.gBrowser.selectedBrowser;
    BrowserTestUtils.startLoadingURIString(browser, PAGE);
    await loaded(browser);
    const native = await privateNativeResult(browser);
    for (const scratch of [false, true]) {
      if (scratch) {
        await WhimsyPrivate.openScratch(window);
      }
      const tab = WhimsyPrivate.openPrivateTab(window, { url: PAGE, force: true });
      tabs.add(tab);
      await loaded(tab.linkedBrowser);
      is(tab.linkedBrowser.contentPrincipal.originAttributes.privateBrowsingId, 1, "Real private document");
      Assert.deepEqual(await privateNativeResult(tab.linkedBrowser), native,
        `${scratch ? "Private Space" : "Private tab"} without permission matches Firefox private window`);
      await BrowserTestUtils.removeTab(tab);
      if (scratch) {
        await WhimsyPrivate.closeScratch(window);
      }
    }
  } finally {
    await BrowserTestUtils.closeWindow(baseline);
  }
  await extension.unload();
  extension = null;
  extension = await installPasskeyExtension(true);
  await gZenWorkspaces.changeWorkspace(defaultSpace);
  for (const scratch of [false, true]) {
    if (scratch) {
      await WhimsyPrivate.openScratch(window);
    }
    const tab = WhimsyPrivate.openPrivateTab(window, { url: PAGE, force: true });
    tabs.add(tab);
    await loaded(tab.linkedBrowser);
    await intercepted(tab.linkedBrowser, `${scratch ? "Private Space" : "Private tab"} with private permission`);
    await BrowserTestUtils.removeTab(tab);
    if (scratch) {
      await WhimsyPrivate.closeScratch(window);
    }
  }
});
