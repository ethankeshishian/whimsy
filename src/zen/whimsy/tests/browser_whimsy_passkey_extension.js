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

async function intercepted(browser, label, conditional = false) {
  const win = browser.ownerGlobal;
  await SimpleTest.promiseFocus(win);
  browser.focus();
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
  await SimpleTest.promiseFocus(browser.ownerGlobal);
  browser.focus();
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
