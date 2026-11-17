/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

const { AddonManager } = ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs");
const { WhimsyCookieBanners } = ChromeUtils.importESModule(
  "resource:///modules/whimsy/WhimsyCookieBanners.sys.mjs"
);
const { PromiseTestUtils } = ChromeUtils.importESModule("resource://testing-common/PromiseTestUtils.sys.mjs");
// Turning the add-on off while autoconsent's content script is mid-message
// drops that message; the extension framework reports it as a rejection.
PromiseTestUtils.allowMatchingRejectionsGlobally(/Receiving end does not exist/);
const UNKNOWN_PAGE = "https://example.com/browser/zen/whimsy/tests/cookie_banner_unknown.html";

async function noticeState(browser) {
  return SpecialPowers.spawn(browser, [], () => ({
    choice: content.document.body.dataset.choice || null,
    visible: !!content.document.getElementById("notice")?.getBoundingClientRect().height,
  }));
}

add_task(async function test_builtin_unknown_banner() {
  await WhimsyCookieBanners.sync();
  await BrowserTestUtils.withNewTab(UNKNOWN_PAGE, async browser => {
    await TestUtils.waitForCondition(async () => (await noticeState(browser)).choice === "dismiss",
      "The built-in add-on dismisses an unknown CMP after rule detection finishes");
    is((await noticeState(browser)).choice, "dismiss", "Accept was never clicked");
  });
  await BrowserTestUtils.withNewTab(`${UNKNOWN_PAGE}?mode=accept`, async browser => {
    await TestUtils.waitForCondition(async () => !(await noticeState(browser)).visible,
      "An unknown Accept-only notice is hidden");
    is((await noticeState(browser)).choice, null, "Hiding does not accept cookies");
  });
});

add_task(async function test_existing_switches_disable_fallback() {
  for (const pref of [WhimsyCookieBanners.PREF, "whimsy.feature.cookie-banners"]) {
    await SpecialPowers.pushPrefEnv({ set: [[pref, false]] });
    try {
      await WhimsyCookieBanners.sync();
      const addon = await AddonManager.getAddonByID(WhimsyCookieBanners.ADDON_ID);
      ok(!addon.isActive, `${pref} disables all content scripts`);
      await BrowserTestUtils.withNewTab(UNKNOWN_PAGE, async browser => {
        const result = await noticeState(browser);
        is(result.choice, null, "The disabled add-on makes no choice");
        ok(result.visible, "The disabled add-on leaves the unknown banner visible");
      });
    } finally {
      await SpecialPowers.popPrefEnv();
      await WhimsyCookieBanners.sync();
    }
  }
});

// Run the packaged fallback in a test extension, with an acknowledged scan.
// Negative assertions then prove that detection ran, without fixed sleeps or
// a production-only test hook. The built-in integration is exercised above.
add_task(async function test_fallback_safety() {
  const addon = await AddonManager.getAddonByID(WhimsyCookieBanners.ADDON_ID);
  const source = await (await fetch(addon.getResourceURI("fallback.js").spec)).text();
  await SpecialPowers.pushPrefEnv({ set: [[WhimsyCookieBanners.PREF, false]] });
  await WhimsyCookieBanners.sync();
  const extension = ExtensionTestUtils.loadExtension({
    manifest: {
      permissions: ["tabs", "https://example.com/*"],
      content_scripts: [{ matches: ["https://example.com/*"], js: ["fallback.js", "probe.js"] }],
    },
    files: {
      "fallback.js": source,
      "probe.js": function () {
        browser.runtime.onMessage.addListener(message => {
          if (message.type === "snapshot") {
            return Promise.resolve({
              choice: document.body.dataset.choice || null,
              visible: !!document.getElementById("notice")?.getBoundingClientRect().height,
            });
          }
          return undefined;
        });
        browser.runtime.sendMessage({ type: "ready" });
      },
    },
    background() {
      let tabId;
      browser.runtime.onMessage.addListener((message, sender) => {
        if (message.type === "ready") {
          tabId = sender.tab.id;
          browser.test.sendMessage("page-ready");
        }
      });
      browser.test.onMessage.addListener(async (command, enabled) => {
        if (command === "scan") {
          await browser.tabs.sendMessage(tabId, { type: "whimsyCookieFallback", enabled });
          browser.test.sendMessage("scanned", await browser.tabs.sendMessage(tabId, { type: "snapshot" }));
        }
      });
    },
  });
  await extension.startup();
  try {
    for (const [mode, enabled, expectedChoice, expectedVisible] of [
      ["dismiss", true, "dismiss", false],
      ["accept", true, null, false],
      ["acknowledge", true, "dismiss", false],
      ["close", true, "dismiss", false],
      ["cross", true, "dismiss", false],
      ["thanks", true, "dismiss", false],
      ["misleading", true, null, false],
      ["implied", true, null, false],
      ["ordinary", true, null, true],
      ["login", true, null, true],
      ["payment", true, null, true],
      ["modal", true, null, true],
      ["blocked", true, null, true],
      ["dismiss", false, null, true],
    ]) {
      await BrowserTestUtils.withNewTab(`${UNKNOWN_PAGE}?mode=${mode}`, async () => {
        await extension.awaitMessage("page-ready");
        extension.sendMessage("scan", enabled);
        const result = await extension.awaitMessage("scanned");
        is(result.choice, expectedChoice, `${mode}, enabled=${enabled}: only non-consent actions`);
        is(result.visible, expectedVisible, `${mode}, enabled=${enabled}: expected visibility`);
      });
    }
    await BrowserTestUtils.withNewTab(`${UNKNOWN_PAGE}?mode=late`, async browser => {
      await extension.awaitMessage("page-ready");
      extension.sendMessage("scan", true);
      await extension.awaitMessage("scanned");
      await SpecialPowers.spawn(browser, [], () => content.wrappedJSObject.showNotice());
      await TestUtils.waitForCondition(async () => (await noticeState(browser)).choice === "dismiss",
        "Mutation observation handles a late banner");
    });
  } finally {
    await extension.unload();
    await SpecialPowers.popPrefEnv();
    await WhimsyCookieBanners.sync();
  }
});
