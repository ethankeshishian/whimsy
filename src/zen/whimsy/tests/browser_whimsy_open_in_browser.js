/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// W28: "Open in Safari" / "Open in Chrome" (research/multi-engine.md
// option A, step 1). A command-bar row per engine, shown only when that
// browser is installed, that hands the current tab's address to
// `open -a <app> <url>` (stubbed here; nothing is actually launched).

const { WhimsyOpenInBrowser, ENGINES } = ChromeUtils.importESModule(
  "resource:///modules/whimsy/WhimsyOpenInBrowser.sys.mjs"
);
const { WhimsyCommands } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyCommands.sys.mjs");
const { globalActions } = ChromeUtils.importESModule("resource:///modules/ZenUBGlobalActions.sys.mjs");

const SAFARI = ENGINES.find(e => e.id == "safari");
const CHROME = ENGINES.find(e => e.id == "chrome");
const ARTICLE = "https://example.com/";

function commandId(engine) {
  return `cmd_whimsyOpenIn${engine.id[0].toUpperCase()}${engine.id.slice(1)}`;
}

function action(engine) {
  return globalActions.find(a => a.whimsyCommand == commandId(engine));
}

// Replaces installed() for one task, restored after; `map` is engine id →
// boolean.
function stubInstalled(map) {
  const original = WhimsyOpenInBrowser.installed;
  WhimsyOpenInBrowser.installed = engine => map[engine.id] ?? original.call(WhimsyOpenInBrowser, engine);
  registerCleanupFunction(() => {
    WhimsyOpenInBrowser.installed = original;
  });
}

// Replaces launch() for one task so nothing is actually opened; returns the
// calls it got.
function stubLaunch() {
  const calls = [];
  const original = WhimsyOpenInBrowser.launch;
  WhimsyOpenInBrowser.launch = (appName, url) => calls.push({ appName, url });
  registerCleanupFunction(() => {
    WhimsyOpenInBrowser.launch = original;
  });
  return calls;
}

add_task(async function test_commands_registered() {
  for (const engine of ENGINES) {
    const entry = WhimsyCommands.get(commandId(engine));
    ok(entry, `${commandId(engine)} is registered`);
    is(entry.l10nId, engine.l10nId, `${engine.id} command is named by ${engine.l10nId}`);
  }
});

add_task(async function test_availability_needs_an_address() {
  stubInstalled({ safari: true, chrome: true });
  await BrowserTestUtils.withNewTab(ARTICLE, async () => {
    ok(action(SAFARI)?.isAvailable(window), "Open in Safari available on an http(s) page");
    ok(action(CHROME)?.isAvailable(window), "Open in Chrome available on an http(s) page");
  });
  await BrowserTestUtils.withNewTab("about:blank", async () => {
    ok(!action(SAFARI)?.isAvailable(window), "Unavailable on about:blank");
    ok(!action(CHROME)?.isAvailable(window), "Unavailable on about:blank");
  });
});

add_task(async function test_availability_needs_the_browser_installed() {
  await BrowserTestUtils.withNewTab(ARTICLE, async () => {
    stubInstalled({ safari: true, chrome: false });
    ok(action(SAFARI)?.isAvailable(window), "Open in Safari shown: Safari is installed");
    ok(!action(CHROME)?.isAvailable(window), "Open in Chrome hidden: Chrome isn't installed");

    stubInstalled({ safari: false, chrome: true });
    ok(!action(SAFARI)?.isAvailable(window), "Open in Safari hidden once it isn't installed");
    ok(action(CHROME)?.isAvailable(window), "Open in Chrome shown once it's installed");
  });
});

add_task(async function test_run_opens_the_tabs_address() {
  stubInstalled({ safari: true, chrome: true });
  const calls = stubLaunch();
  await BrowserTestUtils.withNewTab(ARTICLE, async () => {
    const ok1 = WhimsyOpenInBrowser.openInApp(window, SAFARI);
    ok(ok1, "openInApp reports it launched");
    is(calls.length, 1, "launch() was called once");
    is(calls[0].appName, "Safari", "Safari's app name");
    is(calls[0].url, ARTICLE, "the tab's own address");
  });
});

add_task(async function test_run_unwraps_reader_mode() {
  stubInstalled({ safari: true, chrome: true });
  const calls = stubLaunch();
  await BrowserTestUtils.withNewTab(`about:reader?url=${encodeURIComponent(ARTICLE)}`, async () => {
    WhimsyOpenInBrowser.openInApp(window, CHROME);
    is(calls.length, 1, "launch() was called once");
    is(calls[0].appName, "Google Chrome", "Chrome's app name");
    is(calls[0].url, ARTICLE, "the article's address, not about:reader?url=…");
  });
});

add_task(async function test_run_does_nothing_without_an_address() {
  stubInstalled({ safari: true, chrome: true });
  const calls = stubLaunch();
  await BrowserTestUtils.withNewTab("about:blank", async () => {
    const result = WhimsyOpenInBrowser.openInApp(window, SAFARI);
    ok(!result, "openInApp reports it did nothing");
    is(calls.length, 0, "launch() was never called");
  });
});

add_task(async function test_feature_switch() {
  stubInstalled({ safari: true, chrome: true });
  const calls = stubLaunch();
  await SpecialPowers.pushPrefEnv({ set: [["whimsy.feature.open-in-browser", false]] });
  await BrowserTestUtils.withNewTab(ARTICLE, async () => {
    ok(!action(SAFARI)?.isAvailable(window), "Hidden while the feature is off");
    const result = WhimsyOpenInBrowser.openInApp(window, SAFARI);
    ok(!result, "openInApp does nothing while the feature is off");
    is(calls.length, 0, "launch() was never called");
  });
  await SpecialPowers.popPrefEnv();
});
