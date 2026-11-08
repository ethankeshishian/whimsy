/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

requestLongerTimeout(3);

// W23 connectors: the framework (OAuth with PKCE through a loopback, the MCP
// client, tokens in OSKeyStore, tools for the router and Claude Code), and
// Settings › AI › Connectors. A local server stands in for Google's sign-in
// and APIs and for MCP servers; nothing leaves the Mac.

const { WhimsyConnectors } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyConnectors.sys.mjs");
const { WhimsyConnectorOAuth } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyConnectorOAuth.sys.mjs");
const { WhimsyMCPClient } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyMCPClient.sys.mjs");
const { WhimsyNextMeeting } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyNextMeeting.sys.mjs");
const { WhimsyAIClaudeCode } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyAIClaudeCode.sys.mjs");
const { WhimsyAIProviders } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyAIProviders.sys.mjs");
const { WhimsyAIRouter } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyAIRouter.sys.mjs");
const { WhimsyChatPanel } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyChatPanel.sys.mjs");
const { WhimsyChatContextUI } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyChatContextUI.sys.mjs");
const { HttpServer } = ChromeUtils.importESModule("resource://testing-common/httpd.sys.mjs");

const TOUCHED = ["whimsy.connectors.google.client-id", "whimsy.connectors.granola.url", "whimsy.ai.enabled", "whimsy.ai.order", "whimsy.ai.off", "whimsy.next-meeting.apple-calendar"];
const saved = new Map(TOUCHED.map(name => [name, Services.prefs.prefHasUserValue(name) ? { type: Services.prefs.getPrefType(name), value: whimsyReadPref(name, Services.prefs.getPrefType(name)) } : null]));
// Built by concatenation so nothing token-shaped sits in the source.
const TOKEN = ["acc", "ess", "-", "t0k"].join("");
const REFRESH = ["ref", "resh", "-", "t0k"].join("");
let server;
let base;
let issued = 0;
let refreshFails = false;
const signIns = [];

function restorePrefs() {
  for (const [name, was] of saved) {
    if (was) {
      whimsyWritePref(name, was.type, was.value);
    } else {
      Services.prefs.clearUserPref(name);
    }
  }
}

function json(response, body, status = 200) {
  response.setStatusLine("1.1", status, "x");
  response.setHeader("Content-Type", "application/json");
  response.write(JSON.stringify(body));
}

function body(request) {
  const stream = request.bodyInputStream;
  return NetUtil.readInputStreamToString(stream, stream.available());
}

// A tiny MCP server: `tools` by name, each answering with its text.
function mcp(path, { name, tools, auth = false }) {
  server.registerPathHandler(path, (request, response) => {
    if (auth && !(request.hasHeader("Authorization") && request.getHeader("Authorization").startsWith(`Bearer ${TOKEN}`))) {
      response.setStatusLine("1.1", 401, "Unauthorized");
      response.setHeader("WWW-Authenticate", `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource"`);
      return;
    }
    const message = JSON.parse(body(request));
    if (message.id === undefined) {
      response.setStatusLine("1.1", 202, "Accepted");
      return;
    }
    const result = {
      initialize: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name } },
      "tools/list": { tools: Object.keys(tools).map(t => ({ name: t, description: t, inputSchema: { type: "object" } })) },
      "tools/call": { content: [{ type: "text", text: tools[message.params?.name] ?? "" }] },
    }[message.method];
    json(response, { jsonrpc: "2.0", id: message.id, result });
  });
}

add_setup(async function () {
  await SpecialPowers.pushPrefEnv({ set: [["whimsy.feature.ai-hints", false]] });
  server = new HttpServer();
  server.start(-1);
  base = `http://127.0.0.1:${server.identity.primaryPort}`;
  server.identity.add("http", "127.0.0.1", server.identity.primaryPort);
  server.registerPathHandler("/token", (request, response) => {
    const form = new URLSearchParams(body(request));
    if (form.get("grant_type") == "refresh_token" && refreshFails) {
      json(response, { error: "invalid_grant" }, 400);
      return;
    }
    ok(form.get("grant_type") == "refresh_token" || form.get("code_verifier")?.length >= 43, "The code exchange carries the PKCE verifier");
    issued++;
    json(response, { access_token: TOKEN + issued, refresh_token: REFRESH, expires_in: 3600, scope: "x" });
  });
  server.registerPathHandler("/userinfo", (request, response) => json(response, { email: "ethan@example.com" }));
  server.registerPrefixHandler("/api/", (request, response) => json(response, { items: [], files: [] }));
  server.registerPathHandler("/.well-known/oauth-protected-resource", (request, response) => json(response, { authorization_servers: [base] }));
  server.registerPathHandler("/.well-known/oauth-authorization-server", (request, response) =>
    json(response, { authorization_endpoint: `${base}/authorize`, token_endpoint: `${base}/token`, registration_endpoint: `${base}/register` }));
  server.registerPathHandler("/register", (request, response) => json(response, { client_id: "whimsy-dyn" }, 201));
  server.registerPathHandler("/not-mcp", (request, response) => {
    response.setHeader("Content-Type", "text/html");
    response.write("<p>workspace</p>");
  });
  mcp("/notes-mcp", { name: "Notes", tools: { search_pages: "found", read_page: "page" } });
  mcp("/granola", { name: "Granola", tools: { search_meetings: "Last week: shipped the beta; Ana owns the launch post." }, auth: true });
  WhimsyConnectorOAuth.setTestEndpoints({
    google: { authorize: `${base}/authorize`, token: `${base}/token`, userinfo: `${base}/userinfo`, revoke: `${base}/revoke`, api: `${base}/api` },
  });
  // The provider's consent page: record what was asked, then come back.
  const realOpen = WhimsyConnectorOAuth.openSignIn;
  WhimsyConnectorOAuth.openSignIn = async (win, url, opts) => {
    const params = new URL(url).searchParams;
    signIns.push(params);
    if (params.get("redirect_uri")) {
      fetch(`${params.get("redirect_uri")}?code=c0de&state=${params.get("state")}`).catch(() => {});
    }
    return { close() {} };
  };
  Services.prefs.setStringPref("whimsy.connectors.google.client-id", "test-client.apps");
  Services.prefs.setStringPref("whimsy.connectors.granola.url", `${base}/granola`);
  await WhimsyConnectors._resetForTest();
  registerCleanupFunction(async () => {
    WhimsyConnectorOAuth.openSignIn = realOpen;
    WhimsyConnectorOAuth.setTestEndpoints(null);
    WhimsyNextMeeting.setConnectorEvents("test", null);
    WhimsyNextMeeting._appleOverride = undefined;
    await WhimsyConnectors._resetForTest();
    WhimsyConnectors._bridge?.server.stop(() => {});
    WhimsyConnectors._bridge = null;
    WhimsyChatContextUI.setLiveChip(window, null);
    restorePrefs();
    await new Promise(resolve => server.stop(resolve));
  });
});

async function openConnectors() {
  Services.prefs.setBoolPref("whimsy.ai.enabled", true);
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, "about:preferences#whimsyAI");
  const win = tab.linkedBrowser.contentWindow;
  const doc = win.document;
  await TestUtils.waitForCondition(() => doc.getElementById("whimsyConnectorsList")?.dataset.ready == "true", "Connectors shows");
  const row = id => doc.querySelector(`#whimsyConnectorsList .whimsy-ai-item[data-connector="${id}"]`);
  return { tab, win, doc, S: win.WhimsyAISettings, row, $: id => doc.getElementById(id) };
}

const click = (page, node) => {
  node.scrollIntoView({ block: "center", behavior: "instant" });
  EventUtils.synthesizeMouseAtCenter(node, {}, page.win);
};

async function settledPage(page) {
  await Promise.all(page.doc.getAnimations().filter(a => a.playState == "running").map(a => a.finished.catch(() => {})));
}

async function connectGoogle(scopes = ["gmail", "calendar", "drive"]) {
  signIns.length = 0;
  await WhimsyConnectors.connect(window, "google", { scopes });
}

add_task(async function scopes_sheet_before_sign_in() {
  signIns.length = 0;
  const page = await openConnectors();
  click(page, page.row("google").querySelector('[data-action="fix"]'));
  const sheet = await TestUtils.waitForCondition(() => page.$("whimsyAISheet")?.dataset.sheet == "connector-scopes" && page.$("whimsyAISheet"), "The scopes sheet opens first");
  await settledPage(page);
  is(signIns.length, 0, "Nothing signs in before the sheet's Continue");
  const boxes = [...sheet.querySelectorAll('input[type="checkbox"]')];
  Assert.deepEqual(boxes.map(b => [b.dataset.scope, b.checked]), [["gmail", true], ["calendar", true], ["drive", true]], "Every scope starts on");
  click(page, boxes[2]);
  click(page, page.$("whimsyConnectorsContinue"));
  await TestUtils.waitForCondition(() => page.row("google")?.dataset.status == "ok", "Google connects");
  const scope = signIns[0].get("scope");
  ok(scope.includes("gmail.readonly") && scope.includes("calendar.readonly") && !scope.includes("drive"), "Google is asked for exactly the scopes left on");
  is(signIns[0].get("code_challenge_method"), "S256", "PKCE S256");
  ok(signIns[0].get("redirect_uri").startsWith("http://127.0.0.1:"), "The callback is a loopback address");
  await TestUtils.waitForCondition(() => page.row("google").querySelector(".whimsy-ai-item-detail").textContent.includes("ethan@example.com"), "The row shows the account");
  BrowserTestUtils.removeTab(page.tab);
});

add_task(async function scope_switch_reopens_consent() {
  const page = await openConnectors();
  click(page, page.row("google").querySelector(".whimsy-ai-chev"));
  const toggle = await TestUtils.waitForCondition(() => page.doc.querySelector('.whimsy-ai-body moz-toggle[data-scope="drive"]'), "The scopes show");
  await settledPage(page);
  await toggle.updateComplete;
  ok(!toggle.pressed, "Drive is off");
  signIns.length = 0;
  click(page, toggle.buttonEl);
  await TestUtils.waitForCondition(async () => (await WhimsyConnectors.list()).find(c => c.id == "google").scopes.find(s => s.id == "drive").on, "Drive turns on");
  ok(signIns.at(-1)?.get("scope").includes("drive.readonly"), "Turning a scope back on reopens Google's consent for it");
  BrowserTestUtils.removeTab(page.tab);
});

add_task(async function disconnect_confirms_and_names_routines() {
  const stop = WhimsyConnectors.registerUser(id => (id == "google" ? ["Daily brief", "Meeting prep"] : []));
  const page = await openConnectors();
  if (!page.doc.querySelector('.whimsy-ai-body[data-connector="google"]')) {
    click(page, page.row("google").querySelector(".whimsy-ai-chev"));
  }
  const button = await TestUtils.waitForCondition(() => page.doc.querySelector('.whimsy-ai-body [data-action="disconnect"]'), "Disconnect shows");
  await settledPage(page);
  click(page, button);
  const strip = await TestUtils.waitForCondition(() => page.doc.querySelector(".whimsy-ai-confirm"), "Disconnect asks in the page");
  await TestUtils.waitForCondition(() => strip.textContent.includes("Daily brief and Meeting prep"), "The confirm names the routines that stop");
  ok((await WhimsyConnectors.list()).find(c => c.id == "google").connected, "Nothing happens until it's confirmed");
  click(page, strip.querySelector('[data-action="confirm"]'));
  await TestUtils.waitForCondition(async () => !(await WhimsyConnectors.list()).find(c => c.id == "google").connected, "Google disconnects");
  stop();
  BrowserTestUtils.removeTab(page.tab);
});

add_task(async function mcp_add_lists_tools() {
  const page = await openConnectors();
  click(page, page.doc.querySelector("#whimsyConnectorsAddMcp .whimsy-connectors-rowbtn"));
  const field = await TestUtils.waitForCondition(() => page.$("whimsyConnectorsMcpUrl"), "The address sheet opens");
  await settledPage(page);
  ok(page.doc.querySelector(".whimsy-connectors-direction")?.textContent.includes("Outside agents"), "The sheet says which direction it is (fu-settings 5.6)");
  field.select();
  EventUtils.sendString(`${base}/not-mcp`, page.win);
  click(page, page.$("whimsyConnectorsMcpGo"));
  await TestUtils.waitForCondition(() => page.$("whimsyConnectorsMcpError"), "A non-MCP address says so in place (set-5.9)");
  is(field.getAttribute("aria-invalid"), "true", "The field is marked");
  field.select();
  EventUtils.sendString(`${base}/notes-mcp`, page.win);
  click(page, page.$("whimsyConnectorsMcpGo"));
  const found = await TestUtils.waitForCondition(() => page.$("whimsyConnectorsMcpFound"), "The server answers (set-5.8)");
  await TestUtils.waitForCondition(() => found.textContent.includes("Notes") && found.textContent.includes("2 tools"), "Its name and tool count show");
  click(page, page.$("whimsyConnectorsMcpGo"));
  const id = `mcp:127.0.0.1:${server.identity.primaryPort}`;
  await TestUtils.waitForCondition(() => page.row(id)?.dataset.status == "ok", "The server is listed");
  Assert.deepEqual((await WhimsyConnectors.list()).find(c => c.id == id).toolNames, ["search_pages", "read_page"], "Its tools are kept");
  is(await WhimsyConnectors.call(id, "search_pages", { query: "x" }), "found", "Whimsy calls its tools");
  BrowserTestUtils.removeTab(page.tab);
});

add_task(async function tokens_never_in_prefs() {
  await connectGoogle();
  const leaks = Services.prefs.getChildList("").filter(name => {
    const type = Services.prefs.getPrefType(name);
    return type == Services.prefs.PREF_STRING && /acc\w*-t0k|ref\w*-t0k/.test(Services.prefs.getStringPref(name, ""));
  });
  Assert.deepEqual(leaks, [], "No pref holds a token");
  const path = PathUtils.join(PathUtils.profileDir, "whimsy-connectors.json");
  const text = await IOUtils.readUTF8(path);
  ok(!text.includes(TOKEN) && !text.includes(REFRESH), "The file holds ciphertext only");
  is((await IOUtils.stat(path)).permissions, 0o600, "The file is owner-only");
});

add_task(async function connectors_passed_to_plan_via_mcp_config() {
  await WhimsyConnectors.connect(window, "granola");
  const tools = await WhimsyConnectors.tools();
  const granola = tools.find(t => t.name == "granola");
  is(granola?.url, `${base}/granola`, "Granola goes as its own MCP server");
  ok(granola.headers.Authorization.startsWith("Bearer "), "With its sign-in");
  const bridge = tools.find(t => t.name == "whimsy_connectors");
  ok(bridge?.url.startsWith("http://127.0.0.1:"), "Google's tools go through a loopback MCP endpoint");
  const listed = await WhimsyMCPClient.connect(bridge.url, { headers: bridge.headers });
  ok(listed.tools.some(t => t.name == "gmail_search") && listed.tools.some(t => t.name == "google_calendar_events"), "It lists the switched-on scopes' tools");
  await Assert.rejects(WhimsyMCPClient.connect(bridge.url), e => e.code == "auth", "It refuses calls without its token");
  const { file } = await WhimsyAIClaudeCode._writeMcpConfig(tools);
  is((await IOUtils.stat(file)).permissions, 0o600, "Claude Code's config file is owner-only");
  const config = JSON.parse(await IOUtils.readUTF8(file));
  ok(config.mcpServers.granola && config.mcpServers.whimsy_connectors, "Both servers are in --mcp-config");
  await IOUtils.remove(file);
  // The router hands them to the provider that answers.
  Services.prefs.setBoolPref("whimsy.ai.enabled", true);
  Services.prefs.setStringPref("whimsy.ai.order", "claude");
  let seen = null;
  WhimsyAIProviders.setTestProvider(async function* (provider, req) {
    seen = req.tools;
    yield { type: "text", delta: "ok" };
  });
  try {
    await WhimsyAIRouter.run({ task: "chat", messages: [{ role: "user", content: "hi" }] });
  } finally {
    WhimsyAIProviders.setTestProvider(null);
  }
  ok(seen?.some(t => t.name == "granola"), "A chat run gets the connectors as tools");
});

add_task(async function expired_token_one_button() {
  await connectGoogle();
  const file = await WhimsyConnectors._read();
  WhimsyConnectors._secrets.set("google", { ...WhimsyConnectors._secrets.get("google"), expiresAt: Date.now() - 1000 });
  refreshFails = true;
  await Assert.rejects(WhimsyConnectors.accessToken("google"), e => e.code == "expired", "A refused refresh is an expired sign-in");
  refreshFails = false;
  is(file.connectors.google.status, "expired", "It's marked expired");
  const page = await openConnectors();
  const end = page.row("google").querySelector(".whimsy-ai-item-end");
  is(end.querySelectorAll("button").length, 1, "One button");
  is(end.querySelector("button").dataset.l10nId ?? end.querySelector("button").getAttribute("data-l10n-id"), "whimsy-connectors-sign-in-again", "It signs in again");
  click(page, end.querySelector("button"));
  await TestUtils.waitForCondition(() => page.$("whimsyAISheet")?.dataset.sheet == "connector-scopes", "Signing in again starts with the scopes");
  page.S.closeSheet({ restore: false });
  BrowserTestUtils.removeTab(page.tab);
});

add_task(async function settings_grouped_like_onboarding() {
  await WhimsyConnectors.disconnect("google");
  const page = await openConnectors();
  const captions = [...page.doc.querySelectorAll("#whimsyConnectorsList > .whimsy-ai-caption")].map(c => c.getAttribute("data-l10n-id"));
  Assert.deepEqual(captions, ["whimsy-connectors-group-schedule", "whimsy-connectors-group-work", "whimsy-connectors-group-mcp"], "Grouped like onboarding");
  const ids = [...page.doc.querySelectorAll("#whimsyConnectorsList .whimsy-ai-item[data-connector]")].map(r => r.dataset.connector);
  Assert.deepEqual(ids.slice(0, 6), ["google", "microsoft", "apple-calendar", "granola", "linear", "jira"], "In onboarding's order");
  Services.prefs.setStringPref("whimsy.connectors.google.client-id", "");
  await TestUtils.waitForCondition(() => page.row("google")?.querySelector(".whimsy-ai-item-detail").getAttribute("data-l10n-id") == "whimsy-connectors-needs-client-id", "No client ID: one line says so");
  is(page.row("google").querySelector('[data-action="fix"]').getAttribute("data-l10n-id"), "whimsy-connectors-set-up", "and Set Up shows the steps");
  Services.prefs.setStringPref("whimsy.connectors.google.client-id", "test-client.apps");
  BrowserTestUtils.removeTab(page.tab);
});

function appleMock(status) {
  return {
    authorizationStatus: status,
    requests: 0,
    requestAccess(cb) {
      this.requests++;
      cb(status == "fullAccess", status == "fullAccess" ? "" : status);
    },
    fetchEvents(from, to, cb) {
      cb(true, "[]");
    },
  };
}

add_task(async function apple_calendar_denied_shows_system_settings() {
  WhimsyNextMeeting.testing.setAppleCalendar(appleMock("denied"));
  await Assert.rejects(WhimsyConnectors.connect(window, "apple-calendar"), e => e.code == "denied", "macOS said no");
  const page = await openConnectors();
  const row = page.row("apple-calendar");
  is(row.querySelector(".whimsy-ai-item-detail").getAttribute("data-l10n-id"), "whimsy-connectors-apple-denied", "The row says why");
  const buttons = row.querySelectorAll(".whimsy-ai-item-end button");
  is(buttons.length, 1, "One button");
  is(buttons[0].getAttribute("data-l10n-id"), "whimsy-connectors-open-system-settings", "It opens System Settings");
  BrowserTestUtils.removeTab(page.tab);
  await WhimsyConnectors.disconnect("apple-calendar");
});

function meetingNow() {
  const now = Date.now();
  WhimsyNextMeeting.setConnectorEvents("test", [{ title: "Launch sync", start: now - 10 * 60000, end: now + 20 * 60000 }]);
}

add_task(async function granola_chip_during_meeting_degrades_to_event_and_past_notes() {
  if (!(await WhimsyConnectors.list()).find(c => c.id == "granola").connected) {
    await WhimsyConnectors.connect(window, "granola");
  }
  WhimsyNextMeeting.setConnectorEvents("test", null);
  is(await WhimsyConnectors.granolaNow(window), null, "No meeting, no chip");
  meetingNow();
  const chip = await WhimsyConnectors.granolaNow(window);
  is(chip.label, "Launch sync", "The chip is the meeting");
  ok(!chip.liveNotes, "Granola has no in-progress notes here");
  ok(chip.parts[0].text.includes("Meeting in progress: Launch sync") && chip.parts[0].text.includes("Ana owns the launch post"), "It carries the event and the series' past notes");
  is(chip.icon, "chrome://browser/content/whimsy/icons/granola.svg", "Granola's own mark leads");
});

add_task(async function granola_chip_removable() {
  meetingNow();
  const panel = WhimsyChatPanel.forWindow(window);
  await panel.open();
  await WhimsyConnectors.poll();
  const chip = await TestUtils.waitForCondition(() => panel.chips?.querySelector('[data-chip="granola:live"]'), "Granola joins chat silently");
  ok(chip.hasAttribute("live"), "with a live dot");
  EventUtils.synthesizeMouseAtCenter(chip.querySelector(".whimsy-chat-chip-x"), {});
  await TestUtils.waitForCondition(() => !panel.chips.querySelector('[data-chip="granola:live"]'), "The chip can be removed");
  const ctx = await WhimsyChatContextUI.contextFor(panel, panel.thread);
  ok(!ctx.chips.some(c => c.id == "granola:live"), "and the chat stops reading it");
  WhimsyChatContextUI.setLiveChip(window, null);
  WhimsyNextMeeting.setConnectorEvents("test", null);
  await panel.close?.();
});

add_task(async function next_meeting_calendar_rows_gone() {
  await BrowserTestUtils.withNewTab("about:preferences#general", async browser => {
    const doc = browser.contentDocument;
    const group = await TestUtils.waitForCondition(() => doc.getElementById("whimsyNextMeetingGroup")?.checkVisibility() && doc.getElementById("whimsyNextMeetingGroup"), "Next meeting shows");
    ok(!group.querySelector(".whimsy-calendar-row, #whimsyMeetingGoogleForm, #whimsyMeetingApple"), "No calendar rows in General");
    ok(doc.getElementById("whimsyMeetingOpenConnectors").checkVisibility(), "It points to Connectors instead");
  });
});
