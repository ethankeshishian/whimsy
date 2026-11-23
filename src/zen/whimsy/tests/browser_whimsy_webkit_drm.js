/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// W30 drm-webkit: a page asking for Widevine switches its tab to WebKit, with
// one toast. Gecko's "mediakeys-request" notice is fired from the page itself
// (no CDM needed), so the real actor, the real switch, and the real toast
// run; only the native WebKit service is stood in for (a WKWebView can't run
// headless), as in browser_whimsy_webkit_cookies.js.

const { WhimsyWebKit } = ChromeUtils.importESModule(
  "resource:///modules/whimsy/WhimsyWebKit.sys.mjs"
);
const { WhimsyWebKitDRM } = ChromeUtils.importESModule(
  "resource:///modules/whimsy/WhimsyWebKitDRM.sys.mjs"
);

const TOAST_ID = "whimsy-webkit-drm-toast";
const TOAST_TEXT = "Switched to WebKit for this site";
const PAGE = "https://example.com/";

function installFakeService() {
  const fake = { created: 0, loaded: [] };
  let nextId = 1;
  const impl = {
    available: () => true,
    createTab: () => {
      fake.created++;
      return nextId++;
    },
    loadURL: (id, url) => fake.loaded.push(url),
    getCookies: async () => "[]",
    setCookies: async () => 0,
    canGoBack: () => false,
    canGoForward: () => false,
    isLoading: () => false,
    isFocused: () => false,
  };
  WhimsyWebKit._service = new Proxy(impl, {
    get: (target, key) => (key in target ? target[key] : () => {}),
  });
  return fake;
}

// The load waiters the stand-in never fires.
function releaseLoads(tab) {
  for (const done of [...(WhimsyWebKit.stateOf(tab)?.loadWaiters ?? [])]) {
    done();
  }
}

// What Gecko's MediaKeySystemAccess sends, from the page's own window.
async function requestKeySystem(tab, requests) {
  await SpecialPowers.spawn(tab.linkedBrowser, [requests], list => {
    for (const { keySystem, status } of list) {
      Services.obs.notifyObservers(
        content,
        "mediakeys-request",
        JSON.stringify({ keySystem, status })
      );
    }
  });
}

// Records each request the parent hands on, then runs it as usual.
function spyRequests() {
  const calls = [];
  const orig = WhimsyWebKitDRM.onKeySystemRequest;
  WhimsyWebKitDRM.onKeySystemRequest = function (tab, keySystem, options) {
    const run = orig.call(this, tab, keySystem, options);
    calls.push({ tab, keySystem, run });
    return run;
  };
  calls.restore = () => (WhimsyWebKitDRM.onKeySystemRequest = orig);
  return calls;
}

function drmToasts() {
  return gZenUIManager.toasts.getToasts().filter(t => t.messageId == TOAST_ID);
}

async function removeTab(tab) {
  releaseLoads(tab);
  BrowserTestUtils.removeTab(tab);
}

add_setup(async function () {
  closeToasts();
  installFakeService();
  registerCleanupFunction(() => {
    WhimsyWebKit._service = undefined;
    closeToasts();
    Services.prefs.clearUserPref("whimsy.webkit.datastores");
    Services.prefs.clearUserPref("whimsy.feature.webkit-drm");
    Services.prefs.clearUserPref("whimsy.feature.webkit-tabs");
  });
});

add_task(async function test_widevine_switches_with_one_toast() {
  const fake = installFakeService();
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE);
  const calls = spyRequests();
  try {
    ok(!WhimsyWebKit.isWebKitTab(tab), "The tab starts in Firefox");
    await requestKeySystem(tab, [{ keySystem: "com.widevine.alpha", status: "cdm-not-supported" }]);
    await TestUtils.waitForCondition(() => calls.length == 1, "The Widevine request reached Whimsy");
    is(await calls[0].run, true, "The switch went through");
    ok(WhimsyWebKit.isWebKitTab(tab), "The tab is a WebKit tab");
    is(fake.created, 1, "One WKWebView");
    is(fake.loaded[0], PAGE, "WebKit loads the same page");
    is(tab._whimsyWebKitOverride, "webkit", "Through the manual switch's path");

    await TestUtils.waitForCondition(() => drmToasts().length == 1, "A toast shows");
    const toast = drmToasts()[0];
    ok(!toast.element.querySelector(".whimsy-toast-icon"), "No icon");
    ok(!toast.element.querySelector("button, toolbarbutton"), "No buttons");
    await document.l10n.translateFragment(toast.element);
    const label = toast.element.querySelector("label:not(.description)");
    is((label.value || label.textContent).trim(), TOAST_TEXT, "The toast's exact words");
    ok(!toast.element.querySelector(".description")?.textContent, "and nothing else");

    // The same request again (the page retrying): already WebKit.
    is(
      await WhimsyWebKitDRM.onKeySystemRequest(tab, "com.widevine.alpha", {
        innerWindowId: 1,
      }),
      false,
      "A WebKit tab doesn't switch again"
    );
    is(fake.created, 1, "Still one WKWebView");
    is(drmToasts().length, 1, "Still one toast");
  } finally {
    calls.restore();
    closeToasts();
    await removeTab(tab);
  }
});

add_task(async function test_only_widevine_triggers() {
  const fake = installFakeService();
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE);
  const calls = spyRequests();
  try {
    // ClearKey, then Widevine's screen-capture probe (not a request), then
    // a Widevine variant. Messages arrive in order, so the first call that
    // comes through shows whether the first two were passed on.
    await requestKeySystem(tab, [
      { keySystem: "org.w3.clearkey", status: "cdm-created" },
      { keySystem: "com.widevine.alpha", status: "is-capture-possible" },
      { keySystem: "com.widevine.alpha.experiment", status: "cdm-not-supported" },
    ]);
    await TestUtils.waitForCondition(() => calls.length >= 1, "A request reached Whimsy");
    is(calls[0].keySystem, "com.widevine.alpha.experiment", "Only the Widevine request was passed on");
    await calls[0].run;
    ok(WhimsyWebKit.isWebKitTab(tab), "A Widevine variant switches too");
    is(calls.length, 1, "Once");
  } finally {
    calls.restore();
    closeToasts();
    await removeTab(tab);
  }

  // ClearKey (and anything not Widevine) never switches.
  const tab2 = await BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE);
  try {
    for (const keySystem of ["org.w3.clearkey", "com.apple.fps", "com.microsoft.playready", "com.widevine.alphabet", ""]) {
      is(await WhimsyWebKitDRM.onKeySystemRequest(tab2, keySystem), false, `${keySystem || "(none)"} doesn't switch`);
    }
    ok(!WhimsyWebKit.isWebKitTab(tab2), "The tab stays in Firefox");
    is(fake.created, 1, "No WKWebView for it");
    is(drmToasts().length, 0, "No toast");
  } finally {
    await removeTab(tab2);
  }
});

add_task(async function test_switching_back_to_firefox_sticks() {
  const fake = installFakeService();
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE);
  try {
    is(await WhimsyWebKitDRM.onKeySystemRequest(tab, "com.widevine.alpha"), true, "Switched");
    releaseLoads(tab);
    closeToasts();

    // You put it back in Firefox; the page loads there and asks again.
    const loaded = BrowserTestUtils.browserLoaded(tab.linkedBrowser, false, PAGE);
    await WhimsyWebKit.setTabEngine(tab, "firefox");
    await loaded;
    ok(!WhimsyWebKit.isWebKitTab(tab), "Back in Firefox");

    const calls = spyRequests();
    try {
      await requestKeySystem(tab, [{ keySystem: "com.widevine.alpha", status: "cdm-not-supported" }]);
      await TestUtils.waitForCondition(() => calls.length == 1, "The request reached Whimsy");
      is(await calls[0].run, false, "It doesn't switch back to WebKit");
    } finally {
      calls.restore();
    }
    ok(!WhimsyWebKit.isWebKitTab(tab), "The tab stays in Firefox");
    is(fake.created, 1, "No second WKWebView");
    is(drmToasts().length, 0, "No toast");
  } finally {
    closeToasts();
    await removeTab(tab);
  }
});

add_task(async function test_switches_off() {
  const fake = installFakeService();
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE);
  try {
    Services.prefs.setBoolPref("whimsy.feature.webkit-drm", false);
    is(await WhimsyWebKitDRM.onKeySystemRequest(tab, "com.widevine.alpha"), false, "Off: no switch");
    Services.prefs.clearUserPref("whimsy.feature.webkit-drm");

    Services.prefs.setBoolPref("whimsy.feature.webkit-tabs", false);
    is(await WhimsyWebKitDRM.onKeySystemRequest(tab, "com.widevine.alpha"), false, "WebKit tabs off: no switch");
    Services.prefs.clearUserPref("whimsy.feature.webkit-tabs");

    ok(!WhimsyWebKit.isWebKitTab(tab), "The tab stays in Firefox");
    is(fake.created, 0, "No WKWebView");
    is(drmToasts().length, 0, "No toast");
  } finally {
    await removeTab(tab);
  }
});
