/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// The Claude space: a local MCP server (off until turned on) whose tools
// only reach tabs in the Claude space, unless the user allows the whole
// browser; never private tabs; per-site asking before actions; a glow,
// a bar and Stop on tabs Claude is using; the feature switch and the AI
// kill switch turn it off.

const { WhimsyClaude } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyClaude.sys.mjs");
const { WhimsyPrivate } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyPrivate.sys.mjs");

const FEATURE = "whimsy.feature.claude-space";
const ENABLED = "whimsy.claude.enabled";
const WHOLE = "whimsy.claude.whole-browser";
const ASK = "whimsy.claude.ask-per-site";
const SPACE = "whimsy.claude.space-id";
const AI_BLOCKED = "whimsy.ai.blocked";
const PAGE =
  getRootDirectory(gTestPath).replace("chrome://mochitests/content", "https://example.com") + "whimsy_claude.html";

const realConfirm = WhimsyClaude.confirmSite;
let asked = [];
let answer = "once";

function call(name, args = {}) {
  return WhimsyClaude.callTool(name, args);
}

function textOf(result) {
  return result.content
    .filter(c => c.type == "text")
    .map(c => c.text)
    .join("\n");
}

async function ok_call(name, args) {
  const result = await call(name, args);
  ok(!result.isError, `${name} succeeds: ${textOf(result).slice(0, 200)}`);
  return result;
}

function refIn(tree, pattern) {
  const line = tree.split("\n").find(l => pattern.test(l));
  ok(line, `The outline has ${pattern}`);
  return line?.match(/\[(ref_\d+)\]/)?.[1];
}

async function turnOn() {
  Services.prefs.setBoolPref(ENABLED, true);
  const info = await WhimsyClaude.start();
  ok(info?.url, "The server is running");
  return info;
}

add_setup(async function () {
  await gZenWorkspaces.promiseInitialized;
  WhimsyClaude.confirmSite = async (tab, details) => {
    asked.push(details);
    return answer;
  };
  registerCleanupFunction(async () => {
    WhimsyClaude.confirmSite = realConfirm;
    WhimsyClaude.forgetSitePermissions();
    const spaceId = Services.prefs.getStringPref(SPACE, "");
    for (const pref of [ENABLED, WHOLE, ASK, FEATURE, AI_BLOCKED, SPACE]) {
      Services.prefs.clearUserPref(pref);
    }
    WhimsyClaude.shutdown();
    if (spaceId && gZenWorkspaces.getWorkspaces().some(w => w.uuid == spaceId)) {
      await gZenWorkspaces.removeWorkspace(spaceId);
    }
  });
});

add_task(async function test_off_until_turned_on() {
  ok(!Services.prefs.getBoolPref(ENABLED), "Claude is off by default");
  ok(!WhimsyClaude.running, "No server runs while it's off");
  is(WhimsyClaude.connectInfo(), null, "Settings has no command to show");
  const result = await call("tabs_list");
  ok(result.isError, "Tools refuse while it's off");
  ok(textOf(result).includes("turned off"), "and say why");
});

add_task(async function test_server_and_space() {
  const activeBefore = gZenWorkspaces.activeWorkspace;
  const info = await turnOn();
  ok(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/.test(info.url), "Loopback only, on its own port");
  ok(/^[0-9a-f]{64}$/.test(info.token), "With a random token");
  ok(info.command.startsWith(`claude mcp add --transport http whimsy ${info.url} --header "Authorization: Bearer `), "The connect command is ready to copy");
  is(JSON.parse(info.json).mcpServers.whimsy.url, info.url, "and the JSON config");

  const space = gZenWorkspaces.getWorkspaces().find(w => w.uuid == Services.prefs.getStringPref(SPACE));
  ok(space, "Turning it on creates the Claude space");
  is(space.name, "Claude", "named Claude");
  ok(space.icon.includes("sparkles"), "with its own icon");
  Assert.deepEqual(space.theme.gradientColors[0].c, [217, 119, 87], "and Claude's colour");
  is(gZenWorkspaces.activeWorkspace, activeBefore, "without switching to it");

  const post = (body, headers = {}) =>
    fetch(info.url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...headers },
      body: JSON.stringify(body),
    });
  const auth = { Authorization: `Bearer ${info.token}` };
  const init = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } } };

  let response = await post(init);
  is(response.status, 401, "No token, no access");
  response = await post(init, { Authorization: "Bearer nope" });
  is(response.status, 401, "A wrong token is refused");
  response = await post(init, { ...auth, Origin: "https://evil.example" });
  is(response.status, 403, "Requests from web pages are refused");

  response = await post(init, auth);
  is(response.status, 200, "initialize works with the token");
  const initialized = await response.json();
  is(initialized.result.serverInfo.name, "whimsy", "It's Whimsy's server");
  is(initialized.result.protocolVersion, "2025-06-18", "speaking the client's protocol version");
  ok(initialized.result.capabilities.tools, "with tools");

  response = await post({ jsonrpc: "2.0", method: "notifications/initialized" }, auth);
  is(response.status, 202, "Notifications get 202 Accepted");

  response = await post({ jsonrpc: "2.0", id: 2, method: "tools/list" }, auth);
  const names = (await response.json()).result.tools.map(t => t.name);
  for (const name of ["tabs_list", "tabs_create", "tabs_close", "navigate", "read_page", "get_page_text", "find", "click", "type", "key", "form_input", "scroll", "screenshot"]) {
    ok(names.includes(name), `tools/list has ${name}`);
  }

  const unknown = await WhimsyClaude.handleRpc({ jsonrpc: "2.0", id: 3, method: "nope" });
  is(unknown.error.code, -32601, "Unknown methods get Method not found");
});

add_task(async function test_tools_in_claude_space() {
  await turnOn();
  asked = [];
  answer = "once";
  const created = JSON.parse(textOf(await ok_call("tabs_create", { url: PAGE })));
  const tab = WhimsyClaude.tabById(created.tabId);
  ok(tab, "tabs_create returns the new tab's id");
  is(tab.getAttribute("zen-workspace-id"), Services.prefs.getStringPref(SPACE), "It opens in the Claude space");
  ok(!tab.selected, "in the background");
  is(created.url, PAGE, "and loads the page");

  const listed = JSON.parse(textOf(await ok_call("tabs_list")));
  ok(listed.some(t => t.tabId == created.tabId && t.claudeSpace), "tabs_list has it");

  const tree = textOf(await ok_call("read_page", { tabId: created.tabId }));
  ok(tree.includes('heading "Order form" level=1'), "read_page outlines headings");
  ok(tree.includes("Fill in the form"), "and text");
  ok(!tree.includes("Secret hidden text"), "but not hidden text");
  ok(!tree.includes("hunter2"), "and never a password");
  ok(/textbox "Password" password \(hidden\)/.test(tree), "The password field shows as hidden");
  const search = refIn(tree, /textbox "Search"/);
  const go = refIn(tree, /button "Go"/);
  const extra = refIn(tree, /checkbox "Extra cheese" unchecked/);
  const size = refIn(tree, /combobox "Size"/);
  const password = refIn(tree, /textbox "Password"/);
  is(asked.length, 0, "Reading in the Claude space doesn't ask");

  const interactive = textOf(await ok_call("read_page", { tabId: created.tabId, filter: "interactive" }));
  ok(!interactive.includes("Fill in the form") && interactive.includes('button "Go"'), "filter interactive lists only controls");

  const found = textOf(await ok_call("find", { tabId: created.tabId, query: "go button" }));
  ok(found.includes(`[${go}]`), "find finds the Go button by role and name");

  await ok_call("type", { tabId: created.tabId, ref: search, text: "BLT" });
  is(asked.length, 1, "Typing on a new site asks first");
  is(asked[0].action, "type", "for typing");
  is(asked[0].host, "example.com", "on that site");
  is(await SpecialPowers.spawn(tab.linkedBrowser, [], () => content.document.getElementById("q").value), "BLT", "type fills the field");

  await ok_call("click", { tabId: created.tabId, ref: go });
  is(
    await SpecialPowers.spawn(tab.linkedBrowser, [], () => content.document.getElementById("result").textContent),
    "clicked BLT",
    "click clicks the button (in a background tab too)"
  );

  await ok_call("form_input", { tabId: created.tabId, ref: extra, value: true });
  await ok_call("form_input", { tabId: created.tabId, ref: size, value: "Large" });
  const form = await SpecialPowers.spawn(tab.linkedBrowser, [], () => ({
    extra: content.document.getElementById("extra").checked,
    size: content.document.getElementById("size").value,
  }));
  Assert.deepEqual(form, { extra: true, size: "l" }, "form_input sets checkboxes and selects (by label)");

  let refused = await call("type", { tabId: created.tabId, ref: password, text: "x" });
  ok(refused.isError && textOf(refused).includes("password"), "Typing into a password field is refused");
  refused = await call("form_input", { tabId: created.tabId, ref: password, value: "x" });
  ok(refused.isError, "and so is filling one");
  is(
    await SpecialPowers.spawn(tab.linkedBrowser, [], () => content.document.getElementById("pw").value),
    "hunter2",
    "The password is untouched"
  );

  await ok_call("type", { tabId: created.tabId, ref: search, text: "" });
  await ok_call("key", { tabId: created.tabId, keys: "Enter" });
  await TestUtils.waitForCondition(
    () => SpecialPowers.spawn(tab.linkedBrowser, [], () => content.document.getElementById("result").textContent == "submitted"),
    "Enter in a field submits its form"
  );

  const pageText = textOf(await ok_call("get_page_text", { tabId: created.tabId }));
  ok(pageText.includes("Fill in the form to order a sandwich."), "get_page_text returns the text");

  const stale = await call("click", { tabId: created.tabId, ref: "ref_99999" });
  ok(stale.isError && textOf(stale).includes("read_page"), "Unknown refs say to read the page again");

  const shot = await ok_call("screenshot", { tabId: created.tabId });
  const image = shot.content.find(c => c.type == "image");
  ok(image?.data.length > 100 && image.mimeType == "image/jpeg", "screenshot returns a JPEG");

  const blocked = await call("navigate", { tabId: created.tabId, url: "about:logins" });
  ok(blocked.isError, "navigate refuses browser pages (no password manager)");
  const moved = JSON.parse(textOf(await ok_call("navigate", { tabId: created.tabId, url: PAGE + "?two" })));
  is(moved.url, PAGE + "?two", "navigate loads a URL and waits for it");

  await ok_call("tabs_close", { tabId: created.tabId });
  ok(!WhimsyClaude.tabById(created.tabId), "tabs_close closes it");
  const gone = await call("read_page", { tabId: created.tabId });
  ok(gone.isError, "A closed tab's id stops working");
});

add_task(async function test_site_permission() {
  await turnOn();
  WhimsyClaude.forgetSitePermissions();
  const { tabId } = JSON.parse(textOf(await ok_call("tabs_create", { url: PAGE })));
  const tab = WhimsyClaude.tabById(tabId);
  const tree = textOf(await ok_call("read_page", { tabId }));
  const go = refIn(tree, /button "Go"/);
  const result = () => SpecialPowers.spawn(tab.linkedBrowser, [], () => content.document.getElementById("result").textContent);

  asked = [];
  answer = "deny";
  const denied = await call("click", { tabId, ref: go });
  ok(denied.isError && textOf(denied).includes("didn't allow"), "Don't allow refuses the action");
  is(await result(), "", "and nothing was clicked");

  answer = "always";
  await ok_call("click", { tabId, ref: go });
  is(asked.length, 2, "Asked again after a refusal");
  await ok_call("click", { tabId, ref: go });
  is(asked.length, 2, "Always allow remembers the site");

  WhimsyClaude.forgetSitePermissions();
  answer = "once";
  await ok_call("click", { tabId, ref: go });
  is(asked.length, 3, "Forget Allowed Sites asks again");

  Services.prefs.setBoolPref(ASK, false);
  await ok_call("click", { tabId, ref: go });
  is(asked.length, 3, "With asking off, it doesn't ask");
  Services.prefs.clearUserPref(ASK);
  await ok_call("tabs_close", { tabId });
});

add_task(async function test_scope() {
  await turnOn();
  asked = [];
  answer = "once";
  // The user's own tab, in the space they're using.
  const mine = await BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE);
  const mineId = WhimsyClaude.tabId(mine);
  const listedIds = async () => {
    const text = textOf(await ok_call("tabs_list"));
    return text.startsWith("[") ? JSON.parse(text).map(t => t.tabId) : [];
  };
  ok(!(await listedIds()).includes(mineId), "The user's tabs aren't listed");
  let result = await call("read_page", { tabId: mineId });
  ok(result.isError && textOf(result).includes("Claude space"), "and can't be read");
  result = await call("click", { tabId: mineId, coordinate: [5, 5] });
  ok(result.isError, "or used");
  is(asked.length, 0, "without even asking");

  // A Claude tab moved out of the space is out of reach at once.
  const { tabId: claudeId } = JSON.parse(textOf(await ok_call("tabs_create", { url: PAGE })));
  const claudeTab = WhimsyClaude.tabById(claudeId);
  gZenWorkspaces.moveTabToWorkspace(claudeTab, gZenWorkspaces.activeWorkspace);
  result = await call("read_page", { tabId: claudeId });
  ok(result.isError, "A tab moved out of the Claude space can't be used");

  // The whole browser, when the user allows it.
  Services.prefs.setBoolPref(WHOLE, true);
  const listed = JSON.parse(textOf(await ok_call("tabs_list")));
  ok(listed.some(t => t.tabId == mineId && !t.claudeSpace), "Whole browser lists the user's tabs");
  const tree = textOf(await ok_call("read_page", { tabId: mineId }));
  is(asked.length, 1, "Reading a tab outside the Claude space asks");
  is(asked[0].action, "read_page", "for reading");
  // A visible tab gets real mouse events and keystrokes.
  const search = refIn(tree, /textbox "Search"/);
  await ok_call("click", { tabId: mineId, ref: search });
  await ok_call("type", { tabId: mineId, text: "Club" });
  await ok_call("click", { tabId: mineId, ref: refIn(tree, /button "Go"/) });
  is(
    await SpecialPowers.spawn(mine.linkedBrowser, [], () => content.document.getElementById("result").textContent),
    "clicked Club",
    "click and type work in a visible tab"
  );
  await ok_call("key", { tabId: mineId, keys: "shift+Tab Enter" });

  // Private tabs never, even with the whole browser.
  const privateWin = await BrowserTestUtils.openNewBrowserWindow({ private: true });
  BrowserTestUtils.startLoadingURIString(privateWin.gBrowser.selectedBrowser, PAGE);
  await BrowserTestUtils.browserLoaded(privateWin.gBrowser.selectedBrowser);
  const privateId = WhimsyClaude.tabId(privateWin.gBrowser.selectedTab);
  ok(!(await listedIds()).includes(privateId), "Private windows' tabs aren't listed");
  result = await call("read_page", { tabId: privateId });
  ok(result.isError, "and can't be read");
  await BrowserTestUtils.closeWindow(privateWin);

  if (WhimsyPrivate.inWindow && WhimsyPrivate.openPrivateTab) {
    const privateTab = WhimsyPrivate.openPrivateTab(window);
    if (privateTab) {
      ok(WhimsyClaude.isPrivate(privateTab), "A private tab in a normal window is private to Claude");
      ok(!WhimsyClaude.inScope(privateTab), "and never in scope");
      BrowserTestUtils.removeTab(privateTab);
    }
  }

  Services.prefs.clearUserPref(WHOLE);
  result = await call("read_page", { tabId: mineId });
  ok(result.isError, "Turning whole browser off takes the user's tabs away again");
  BrowserTestUtils.removeTab(mine);
  BrowserTestUtils.removeTab(claudeTab);
});

add_task(async function test_indicator_and_stop() {
  await turnOn();
  answer = "once";
  const { tabId } = JSON.parse(textOf(await ok_call("tabs_create", { url: PAGE })));
  const tab = WhimsyClaude.tabById(tabId);
  await ok_call("read_page", { tabId });
  ok(tab.hasAttribute("whimsy-claude-active"), "A tab Claude uses glows");
  const box = gBrowser.getNotificationBox(tab.linkedBrowser);
  const bar = await TestUtils.waitForCondition(() => box.getNotificationWithValue("whimsy-claude-control"), "and gets the bar");
  const stop = bar._buttons?.[0];
  ok(stop, "with a Stop button");
  stop.click();
  ok(!Services.prefs.getBoolPref(ENABLED), "Stop turns Claude off");
  ok(!WhimsyClaude.running, "and stops the server");
  ok(!tab.hasAttribute("whimsy-claude-active"), "The glow goes");
  await TestUtils.waitForCondition(() => !box.getNotificationWithValue("whimsy-claude-control"), "and so does the bar");
  const after = await call("read_page", { tabId });
  ok(after.isError, "Tools refuse after Stop");
  BrowserTestUtils.removeTab(tab);
});

add_task(async function test_switches_turn_it_off() {
  await turnOn();
  Services.prefs.setBoolPref(FEATURE, false);
  ok(!WhimsyClaude.running, "The feature switch stops the server");
  ok((await call("tabs_list")).isError, "and the tools");
  Services.prefs.clearUserPref(FEATURE);
  await WhimsyClaude.start();
  ok(WhimsyClaude.running, "Switching it back on restarts it (still turned on)");

  Services.prefs.setBoolPref(AI_BLOCKED, true);
  ok(!WhimsyClaude.running, "The AI kill switch stops it too");
  Services.prefs.clearUserPref(AI_BLOCKED);
  Services.prefs.clearUserPref(ENABLED);
  ok(!WhimsyClaude.running, "Turning it off in Settings stops it");
});
