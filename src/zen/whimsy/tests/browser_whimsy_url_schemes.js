/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

const { WhimsyProtocol } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyProtocol.sys.mjs");
const { SearchTestUtils } = ChromeUtils.importESModule("resource://testing-common/SearchTestUtils.sys.mjs");

SearchTestUtils.init(this);

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
    // W29: space, search and command.
    "whimsy://space",
    "whimsy://space?name=",
    "whimsy://space?name=Work&name=Home",
    "whimsy://space?name=Work&url=https://example.com/",
    "whimsy://search?q=",
    "whimsy://search?q=%20%20",
    "whimsy://search?q=a&q=b",
    `whimsy://search?q=${"a".repeat(2049)}`,
    "whimsy://search?q=cats&url=https://example.com/",
    "whimsy://command?id=close-all",
    "whimsy://command?id=toString",
    "whimsy://command?id=__proto__",
    "whimsy://command?id=new-easel&id=new-note",
    "whimsy://command?id=new-easel&space=Work",
    // W30: ask.
    "whimsy://ask",
    "whimsy://ask?q=",
    "whimsy://ask?q=%20",
    "whimsy://ask?q=a&q=b",
    `whimsy://ask?q=${"a".repeat(2049)}`,
    "whimsy://ask?q=hi&url=https://example.com/",
    "whimsy://ask?q=hi&space=Work",
    "whimsy://ask?q=hi&send=1",
  ]) {
    is(WhimsyProtocol.linkRoute(uri), null, `Rejected: ${uri}`);
  }
  const space = WhimsyProtocol.linkRoute("whimsy://space?name=My%20Work");
  is(space.action, "space", "space action");
  is(space.space, "My Work", "Space name decoded");
  const search = WhimsyProtocol.linkRoute("whimsy://search?q=%20best%20ramen%20&space=Home");
  is(search.query, "best ramen", "Query trimmed and decoded");
  is(search.space, "Home", "Search keeps its space");
  is(WhimsyProtocol.linkRoute("whimsy://command?id=new-easel").command, "cmd_whimsyNewEasel", "Allowed command");
});

// W29: whimsy://space, whimsy://search and whimsy://command from other apps.
add_task(async function test_space_search_and_command_links() {
  await SpecialPowers.pushPrefEnv({ set: [["whimsy.external-links.target", "tab"]] });
  const active = gZenWorkspaces.getActiveWorkspace();
  const other = await gZenWorkspaces.createAndSaveWorkspace("Whimsy link test space");
  try {
    ok(await WhimsyProtocol.openExternal("whimsy://space?name=Whimsy%20link%20test%20space"), "A space link opens");
    await TestUtils.waitForCondition(() => gZenWorkspaces.activeWorkspace == other.uuid, "It switched to that space");
    ok(!(await WhimsyProtocol.openExternal("whimsy://space?name=No%20such%20space")), "An unknown space does nothing");
    is(gZenWorkspaces.activeWorkspace, other.uuid, "And stays put");

    // A local default engine: tests can't reach the real ones.
    await SearchTestUtils.installSearchExtension(
      { name: "Whimsy Link Search", search_url: "https://example.com/link-search", search_url_get_params: "q={searchTerms}" },
      { setAsDefault: true }
    );
    const { SearchService } = ChromeUtils.importESModule("moz-src:///toolkit/components/search/SearchService.sys.mjs");
    const engine = SearchService.defaultEngine;
    is(engine.name, "Whimsy Link Search", "The test engine is the default");
    const expected = engine.getSubmission("whimsy ramen").uri.spec;
    const searched = BrowserTestUtils.waitForNewTab(gBrowser, expected);
    ok(
      await WhimsyProtocol.openExternal(`whimsy://search?q=whimsy%20ramen&space=${encodeURIComponent(active.name)}`),
      "A search link opens"
    );
    const tab = await searched;
    is(tab.getAttribute("zen-workspace-id"), active.uuid, "In the named space, with the default engine");
    is(gBrowser.selectedTab, tab, "And selected");
    BrowserTestUtils.removeTab(tab);

    const tabs = gBrowser.tabs.length;
    ok(!(await WhimsyProtocol.openExternal("whimsy://command?id=close-all")), "A command off the list does nothing");
    is(gBrowser.tabs.length, tabs, "Nothing closed");
    const command = document.getElementById("cmd_zenToggleSidebar");
    let ran = 0;
    const onCommand = () => ran++;
    command.addEventListener("command", onCommand);
    try {
      ok(await WhimsyProtocol.openExternal("whimsy://command?id=toggle-sidebar"), "An allowed command runs");
      is(ran, 1, "Exactly once");
      ok(await WhimsyProtocol.openExternal("whimsy://command?id=toggle-sidebar"), "And again, back as it was");
    } finally {
      command.removeEventListener("command", onCommand);
    }
  } finally {
    await gZenWorkspaces.changeWorkspaceWithID(active.uuid);
    await gZenWorkspaces.removeWorkspace(other.uuid);
    await SpecialPowers.popPrefEnv();
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

// W30: whimsy://ask only fills the composer: never sent, nothing attached.
add_task(async function test_ask_fills_the_composer_only() {
  const ask = WhimsyProtocol.linkRoute("whimsy://ask?q=%20what%27s%20new%3F%20");
  Assert.deepEqual(ask, { action: "ask", prompt: "what's new?" }, "Prompt trimmed and decoded, nothing else");

  const { WhimsyChat } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyChat.sys.mjs");
  const calls = [];
  const original = WhimsyChat.open;
  WhimsyChat.open = (win, opts) => {
    calls.push({ win, opts });
    return true;
  };
  try {
    await SpecialPowers.pushPrefEnv({ set: [["whimsy.ai.enabled", false]] });
    ok(!(await WhimsyProtocol.openExternal("whimsy://ask?q=hello")), "Not with AI off");
    await SpecialPowers.pushPrefEnv({ set: [["whimsy.ai.enabled", true], ["whimsy.feature.ai-chat", false]] });
    ok(!(await WhimsyProtocol.openExternal("whimsy://ask?q=hello")), "Not with chat off");
    await SpecialPowers.pushPrefEnv({ set: [["whimsy.feature.ai-chat", true], ["whimsy.feature.url-schemes", false]] });
    ok(!(await WhimsyProtocol.openExternal("whimsy://ask?q=hello")), "Not with whimsy:// links off");
    is(calls.length, 0, "Chat never opened");

    await SpecialPowers.pushPrefEnv({ set: [["whimsy.feature.url-schemes", true]] });
    ok(await WhimsyProtocol.openExternal("whimsy://ask?q=summarize%20my%20day"), "An ask link opens chat");
    is(calls.length, 1, "Once");
    is(calls[0].win, window, "In the main window");
    Assert.deepEqual(calls[0].opts, { prompt: "summarize my day", send: false }, "Composer only: no send, tab, chips, or thread");
  } finally {
    WhimsyChat.open = original;
    await SpecialPowers.popPrefEnv();
    await SpecialPowers.popPrefEnv();
    await SpecialPowers.popPrefEnv();
    await SpecialPowers.popPrefEnv();
  }
});
