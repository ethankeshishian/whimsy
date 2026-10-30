/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

const { WhimsyProtocol } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyProtocol.sys.mjs");

add_task(function test_route_table() {
  is(WhimsyProtocol.route("whimsy://settings").url, "about:preferences", "settings routes to preferences");
  is(WhimsyProtocol.route("whimsy://downloads").url, "about:downloads", "downloads routes to the downloads page");
  is(WhimsyProtocol.route("whimsy://nonsense"), null, "An unknown page has no route");
  is(WhimsyProtocol.route("not-a-whimsy-url"), null, "A non-whimsy:// value has no route");
  // batch7b: offline game + year in tabs (about:whimsy).
  is(WhimsyProtocol.route("whimsy://game").url, "about:whimsy?game", "game routes to about:whimsy?game");
  is(WhimsyProtocol.route("whimsy://year").url, "about:whimsy?year", "year routes to about:whimsy?year");
});

// batch7b: about:whimsy itself (WhimsyAboutPage.sys.mjs) serves a real
// chrome document per query string, and falls back for an unknown one.
add_task(async function test_about_whimsy_routes_by_query() {
  await BrowserTestUtils.withNewTab("about:whimsy?game", async browser => {
    is(
      browser.contentDocument.location.href,
      "about:whimsy?game",
      "The address bar keeps about:whimsy?game, not the chrome:// URL"
    );
    ok(browser.contentDocument.getElementById("whimsy-game-canvas"), "It served the game page");
  });
  await BrowserTestUtils.withNewTab("about:whimsy?year", async browser => {
    ok(browser.contentDocument.getElementById("whimsy-year-root"), "It served the Year in tabs page");
  });
  await BrowserTestUtils.withNewTab("about:whimsy?nonsense", async browser => {
    ok(browser.contentDocument.getElementById("whimsy-game-canvas"), "An unknown query string falls back to the game");
  });
});

add_task(async function test_typing_settings_navigates() {
  await BrowserTestUtils.withNewTab("https://example.com/", async () => {
    gURLBar.focus();
    gURLBar.value = "whimsy://settings";
    EventUtils.synthesizeKey("KEY_Enter", {}, window);
    await TestUtils.waitForCondition(
      () => gBrowser.selectedBrowser.currentURI.spec.startsWith("about:preferences"),
      "Typing whimsy://settings opens about:preferences in the current tab"
    );
  });
});

add_task(async function test_disabled_feature_leaves_the_value_alone() {
  Services.prefs.setBoolPref("whimsy.feature.url-schemes", false);
  registerCleanupFunction(() => Services.prefs.clearUserPref("whimsy.feature.url-schemes"));
  await BrowserTestUtils.withNewTab("https://example.com/", async () => {
    gURLBar.focus();
    gURLBar.value = "whimsy://settings";
    // This capture listener runs after Whimsy's listener and stops Firefox's
    // public search fallback once we've checked that Whimsy left Enter alone.
    let passedThrough = false;
    const stopSearch = event => {
      if (event.key == "Enter") {
        passedThrough = !event.defaultPrevented;
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    };
    gURLBar.inputField.addEventListener("keydown", stopSearch, true);
    try {
      EventUtils.synthesizeKey("KEY_Enter", {}, window);
      ok(passedThrough, "Disabled protocol handler leaves Enter unhandled");
    } finally {
      gURLBar.inputField.removeEventListener("keydown", stopSearch, true);
    }
    ok(
      !gBrowser.selectedBrowser.currentURI.spec.startsWith("about:preferences"),
      "With the feature off, whimsy:// is left to Firefox's own (failing) navigation"
    );
  });
  Services.prefs.clearUserPref("whimsy.feature.url-schemes");
});

// batch hover: whimsy:// links from other apps.
add_task(function test_link_routes_are_strict() {
  const open = WhimsyProtocol.linkRoute("whimsy://open?space=Work&url=https%3A%2F%2Fexample.com%2Fa%3Fb%3D1");
  is(open.action, "open", "open action");
  is(open.space, "Work", "Space kept");
  is(open.url, "https://example.com/a?b=1", "Target decoded once");
  is(WhimsyProtocol.linkRoute("whimsy://new-tab?url=https://example.com/").action, "new-tab", "new-tab action");
  for (const uri of [
    "whimsy://open?url=javascript:alert(1)",
    "whimsy://open?url=file:///etc/passwd",
    "whimsy://open?url=about:config",
    "whimsy://open?url=https://example.com/&url=https://example.org/",
    "whimsy://open?url=https://user:pw@example.com/",
    "whimsy://open?url=https://example.com/&extra=1",
    "whimsy://new-tab?url=https://example.com/&space=Work",
    "whimsy://delete?url=https://example.com/",
    "whimsy://open",
  ]) {
    is(WhimsyProtocol.linkRoute(uri), null, `Rejected: ${uri}`);
  }
});

add_task(async function test_command_line_takes_whimsy_args_only() {
  const { WhimsyCommandLine } = ChromeUtils.importESModule(
    "resource:///modules/whimsy/WhimsyProtocol.sys.mjs"
  );
  const args = ["-url", "whimsy://settings", "-url", "https://example.com/", "whimsy://downloads"];
  const commandLine = {
    get length() {
      return args.length;
    },
    getArgument: i => args[i],
    removeArguments(first, last) {
      args.splice(first, last - first + 1);
    },
    state: Ci.nsICommandLine.STATE_REMOTE_EXPLICIT,
    preventDefault: false,
  };
  const original = WhimsyProtocol.openExternal;
  const received = [];
  WhimsyProtocol.openExternal = async value => received.push(value);
  try {
    const handler = new WhimsyCommandLine();
    handler.handle(commandLine);
    await handler._pending;
    Assert.deepEqual(received, ["whimsy://settings", "whimsy://downloads"], "In order");
    Assert.deepEqual(args, ["-url", "https://example.com/"], "Other links left to Firefox");
    ok(commandLine.preventDefault, "No extra window for a running app");
  } finally {
    WhimsyProtocol.openExternal = original;
  }
});

add_task(async function test_open_in_space_and_pages() {
  await SpecialPowers.pushPrefEnv({ set: [["whimsy.external-links.target", "tab"]] });
  const tabCount = gBrowser.tabs.length;
  try {
    ok(await WhimsyProtocol.openExternal("whimsy://settings"), "A page link opens");
    await TestUtils.waitForCondition(() => gBrowser.selectedBrowser.currentURI.spec.startsWith("about:preferences"));
    is(gBrowser.tabs.length, tabCount + 1, "In a new tab, not over the current one");
    BrowserTestUtils.removeTab(gBrowser.selectedTab);

    const active = gZenWorkspaces.getActiveWorkspace();
    ok(
      !(await WhimsyProtocol.openExternal("whimsy://open?space=No%20such%20space&url=https://example.com/")),
      "An unknown space opens nothing"
    );
    is(gZenWorkspaces.activeWorkspace, active.uuid, "And doesn't switch spaces");

    const loaded = BrowserTestUtils.waitForNewTab(gBrowser, "https://example.com/", true);
    ok(
      await WhimsyProtocol.openExternal(`whimsy://open?space=${encodeURIComponent(active.name)}&url=https://example.com/`),
      "A space link opens"
    );
    const tab = await loaded;
    is(tab.getAttribute("zen-workspace-id"), active.uuid, "In that space");
    BrowserTestUtils.removeTab(tab);

    Services.prefs.setBoolPref("whimsy.feature.url-schemes", false);
    ok(!(await WhimsyProtocol.openExternal("whimsy://settings")), "Feature off: nothing opens");
  } finally {
    Services.prefs.clearUserPref("whimsy.feature.url-schemes");
    await SpecialPowers.popPrefEnv();
  }
});
