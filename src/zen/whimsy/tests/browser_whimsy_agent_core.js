/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// W23 agent-core: the agent's tools. A local MCP server for outside apps
// (off until turned on), task-scoped Stop, no per-site dialog or grants,
// no Claude space, private/hidden/locked checks on every call, secret
// fields masked before capture and left out of what the agent reads, load
// retries, injection notices, Activity retention, and one-click connect.

const { WhimsyAI } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyAI.sys.mjs");
const { WhimsyClaude } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyClaude.sys.mjs");
const { WhimsyClaudeReplay } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyClaudeReplay.sys.mjs");
const { WhimsyAgentTasks } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyAgentTasks.sys.mjs");
const { WhimsyAgentGuard } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyAgentGuard.sys.mjs");
const { WhimsyOutsideAgents } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyOutsideAgents.sys.mjs");
const { WhimsyAIStore } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyAIStore.sys.mjs");
const { WhimsyPrivate } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyPrivate.sys.mjs");
const { WhimsyHiddenSpaces } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyHiddenSpaces.sys.mjs");
const { WhimsySpaceLock } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsySpaceLock.sys.mjs");
const { MASK_COLOR } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyAISensitive.sys.mjs");

const FEATURE = "whimsy.feature.ai-outside-agents";
const ENABLED = "whimsy.ai.outside-agents";
const OWN = "whimsy.ai.outside-agents.own-space";
const OWN_ID = "whimsy.ai.outside-agents.space-id";
const DAYS = "whimsy.ai.activity.days";
const PORT = "whimsy.claude.port";
const AI_ENABLED = "whimsy.ai.enabled";
const LEGACY = ["whimsy.claude.enabled", "whimsy.claude.whole-browser", "whimsy.claude.ask-per-site", "whimsy.claude.space-id"];
const ROOT = getRootDirectory(gTestPath).replace("chrome://mochitests/content", "https://example.com");
const PAGE = ROOT + "whimsy_claude.html";
const SENSITIVE = ROOT + "whimsy_ai_sensitive.html";
const INJECTION = ROOT + "whimsy_claude_injection.html";

const aiHadUserValue = Services.prefs.prefHasUserValue(AI_ENABLED);
const aiValue = Services.prefs.getBoolPref(AI_ENABLED, false);
// Opening about:preferences caches a default device name; restore it.
const DEVICE_NAME_PREF = "identity.fxaccounts.account.device.name";
const deviceNameHadUserValue = Services.prefs.prefHasUserValue(DEVICE_NAME_PREF);
const deviceNameValue = deviceNameHadUserValue ? Services.prefs.getStringPref(DEVICE_NAME_PREF) : null;

function textOf(result) {
  return result.content.filter(c => c.type == "text").map(c => c.text).join("\n");
}

// Outside app calls go through a session; Whimsy's own through a task.
function outside(name, args = {}, session = "test-session") {
  return WhimsyClaude.callTool(name, args, { session, clientName: "test-app" });
}

function own(task, name, args = {}) {
  return WhimsyClaude.callTool(name, args, { taskId: task.id });
}

async function ok_result(promise, label) {
  const result = await promise;
  ok(!result.isError, `${label}: ${textOf(result).slice(0, 200)}`);
  return result;
}

function refIn(tree, pattern) {
  const line = tree.split("\n").find(l => pattern.test(l));
  ok(line, `The outline has ${pattern}`);
  return line?.match(/\[(ref_\d+)\]/)?.[1];
}

function stub(obj, name, value) {
  const real = obj[name];
  obj[name] = value;
  return () => {
    obj[name] = real;
  };
}

async function turnOn() {
  Services.prefs.setBoolPref(AI_ENABLED, true);
  Services.prefs.setBoolPref(ENABLED, true);
  const info = await WhimsyClaude.start();
  ok(info?.url, "The server is running");
  return info;
}

function rawPost(url, body, headers) {
  const { NetUtil } = ChromeUtils.importESModule("resource://gre/modules/NetUtil.sys.mjs");
  const channel = NetUtil.newChannel({ uri: url, loadUsingSystemPrincipal: true }).QueryInterface(Ci.nsIHttpChannel);
  const stream = Cc["@mozilla.org/io/string-input-stream;1"].createInstance(Ci.nsIStringInputStream);
  stream.setUTF8Data(JSON.stringify(body));
  channel.QueryInterface(Ci.nsIUploadChannel2).explicitSetUploadStream(stream, "application/json", -1, "POST");
  for (const [name, value] of Object.entries(headers)) {
    channel.setRequestHeader(name, value, false);
  }
  return new Promise(resolve => NetUtil.asyncFetch(channel, () => resolve(channel.responseStatus)));
}

function listedIds(result) {
  const body = textOf(result);
  return body.startsWith("[") ? JSON.parse(body).map(t => t.tabId) : [];
}

function newTask(opts = {}) {
  return WhimsyAgentTasks.start({ client: "whimsy", mode: "background", ...opts });
}

async function openTabFor(task, url) {
  const created = JSON.parse(textOf(await ok_result(own(task, "tabs_create", { url }), "tabs_create")));
  return { tabId: created.tabId, tab: WhimsyClaude.tabById(created.tabId) };
}

function waitForPause(task, kind) {
  return TestUtils.waitForCondition(() => task.pause && !task.pause.choice && (!kind || task.pause.kind == kind) && task.pause,
    `The task pauses${kind ? ` (${kind})` : ""}`);
}

function pixel(data, width, x, y) {
  const i = (Math.round(y) * width + Math.round(x)) * 4;
  return [data[i], data[i + 1], data[i + 2]];
}

function near(rgb, target, slack = 24) {
  return rgb.every((v, i) => Math.abs(v - target[i]) <= slack);
}

async function decode(src) {
  const img = new Image();
  img.src = src;
  await img.decode();
  const canvas = document.createElementNS("http://www.w3.org/1999/xhtml", "canvas");
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(img, 0, 0);
  return { data: ctx.getImageData(0, 0, canvas.width, canvas.height).data, width: canvas.width, height: canvas.height };
}

const MASK_RGB = MASK_COLOR.match(/\d+/g).map(Number);

add_setup(async function () {
  await gZenWorkspaces.promiseInitialized;
  WhimsyAgentGuard._setSiteKnownForTesting(() => true);
  registerCleanupFunction(async () => {
    WhimsyAgentGuard._setSiteKnownForTesting(null);
    WhimsyAgentTasks._resetForTesting();
    for (const pref of [ENABLED, FEATURE, OWN, OWN_ID, DAYS, PORT, ...LEGACY]) {
      Services.prefs.clearUserPref(pref);
    }
    WhimsyClaude.shutdown();
    if (aiHadUserValue) {
      Services.prefs.setBoolPref(AI_ENABLED, aiValue);
    } else {
      Services.prefs.clearUserPref(AI_ENABLED);
    }
    await WhimsyAI.pending;
    if (deviceNameHadUserValue) {
      Services.prefs.setStringPref(DEVICE_NAME_PREF, deviceNameValue);
    } else {
      Services.prefs.clearUserPref(DEVICE_NAME_PREF);
    }
  });
});

add_task(async function test_off_until_turned_on() {
  ok(!Services.prefs.getBoolPref(ENABLED), "Outside agents are off by default");
  ok(!WhimsyClaude.running, "No server runs while it's off");
  is(WhimsyClaude.connectInfo(), null, "Settings has no command to show");
  const result = await outside("tabs_list");
  ok(result.isError && textOf(result).includes("turned off"), "Tools refuse while it's off, and say why");
});

add_task(async function no_claude_space_created() {
  const before = gZenWorkspaces.getWorkspaces().map(w => w.uuid);
  const legacyToken = "a".repeat(64);
  Services.prefs.setStringPref("whimsy.claude.token", legacyToken);
  const info = await turnOn();
  Assert.deepEqual(gZenWorkspaces.getWorkspaces().map(w => w.uuid), before, "Turning outside agents on creates no space");
  ok(!Services.prefs.prefHasUserValue("whimsy.claude.space-id"), "and remembers none");
  ok(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/.test(info.url), "Loopback only, on its own port");
  const token = (await IOUtils.readUTF8(PathUtils.join(PathUtils.parent(info.bridgePath), "token"))).trim();
  ok(/^[0-9a-f]{64}$/.test(token) && token != legacyToken, "A random token; the old pref one is retired");
  ok(!JSON.stringify(info).includes(token), "Connection info contains no secret");
  ok(info.command.startsWith("claude mcp add -s user whimsy -- '"), "A shell-quoted bridge command with user scope");

  const post = (body, headers = {}) =>
    fetch(info.url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...headers },
      body: JSON.stringify(body),
    });
  const auth = { Authorization: `Bearer ${token}` };
  const init = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } } };
  is((await post(init)).status, 401, "No token, no access");
  is(await rawPost(info.url, init, { ...auth, Origin: "https://evil.example" }), 403, "Requests from web pages are refused");
  const response = await post(init, auth);
  is(response.status, 200, "initialize works with the token");
  ok(response.headers.get("Mcp-Session-Id"), "Each connection gets a session (one task each)");
  const body = await response.json();
  ok(body.result.instructions.includes(WhimsyAgentGuard.WAITING_TEXT), "The instructions say how a held call reads");
  ok(!/Claude space/.test(body.result.instructions), "and never mention a Claude space");
  const names = (await (await post({ jsonrpc: "2.0", id: 2, method: "tools/list" }, auth)).json()).result.tools.map(t => t.name);
  for (const name of ["tabs_list", "tabs_create", "tabs_close", "navigate", "read_page", "get_page_text", "find", "click", "type", "key", "form_input", "scroll", "screenshot"]) {
    ok(names.includes(name), `tools/list has ${name}`);
  }
  is((await post({ jsonrpc: "2.0", method: "notifications/initialized" }, auth)).status, 202, "Notifications get 202");
  is((await WhimsyClaude.handleRpc({ jsonrpc: "2.0", id: 3, method: "nope" })).error.code, -32601, "Unknown methods");
  is(WhimsyClaude.ensureSpace, undefined, "There's no Claude space to make");
});

// Exercise the generated executable, not a parallel JS implementation of it.
add_task(async function test_private_bridge_and_live_rotation() {
  const { AppConstants } = ChromeUtils.importESModule("resource://gre/modules/AppConstants.sys.mjs");
  if (AppConstants.platform != "macosx") {
    ok(true, "The stock macOS curl bridge is tested on macOS");
    return;
  }
  const { Subprocess } = ChromeUtils.importESModule("resource://gre/modules/Subprocess.sys.mjs");
  const connection = WhimsyClaude.connectInfo();
  const dir = PathUtils.parent(connection.bridgePath);
  const tokenPath = PathUtils.join(dir, "token");
  for (const [path, mode] of [[dir, 0o700], [connection.bridgePath, 0o700], [tokenPath, 0o600], [PathUtils.join(dir, "endpoint"), 0o600]]) {
    is((await IOUtils.stat(path)).permissions & 0o777, mode, "Private bridge permissions");
  }
  const oldToken = (await IOUtils.readUTF8(tokenPath)).trim();
  ok(!(await IOUtils.readUTF8(connection.bridgePath)).includes(oldToken), "Script has no embedded secret");
  const process = await Subprocess.call({ command: connection.bridgePath, stderr: "pipe" });
  try {
    let buffered = "";
    const readLine = async () => {
      while (!buffered.includes("\n")) {
        const chunk = await process.stdout.readString();
        if (!chunk) {
          throw new Error("Bridge closed before replying");
        }
        buffered += chunk;
      }
      const end = buffered.indexOf("\n");
      const line = buffered.slice(0, end);
      buffered = buffered.slice(end + 1);
      return JSON.parse(line);
    };
    await process.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 10, method: "initialize", params: { clientInfo: { name: "bridge-test" } } }) + "\n");
    is((await readLine()).id, 10, "initialize relays through the executable");
    await process.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    await process.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 11, method: "tools/list" }) + "\n");
    const listed = await readLine();
    is(listed.id, 11, "202 notification emits no stdio line");
    await WhimsyClaude.regenerateToken();
    const rotated = (await IOUtils.readUTF8(tokenPath)).trim();
    ok(rotated != oldToken, "New token rewrites the file");
    is((await IOUtils.stat(tokenPath)).permissions & 0o777, 0o600, "Rotation keeps the token private");
    is(await rawPost(connection.url, { jsonrpc: "2.0", id: 12, method: "ping" }, { Authorization: `Bearer ${oldToken}` }), 401, "Old token is rejected");
    await process.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 13, method: "tools/list" }) + "\n");
    is((await readLine()).id, 13, "Running bridge reads the new token for its next request");
    await process.stdin.close();
    is((await process.wait()).exitCode, 0, "Bridge exits cleanly on EOF");
  } finally {
    process.kill();
    await process.wait();
  }
});

add_task(async function test_settings_connection_and_rotation() {
  await BrowserTestUtils.withNewTab("about:preferences#whimsyAI", async browser => {
    const doc = browser.contentDocument;
    await TestUtils.waitForCondition(() => doc.getElementById("whimsyClaudeCommand")?.textContent, "Settings shows the ready command");
    ok(!doc.getElementById("whimsyClaudeWholeBrowser") && !doc.getElementById("whimsyClaudeAsk"), "No whole-browser or ask-per-site switches");
    ok(!doc.getElementById("whimsyClaudeForgetSites"), "No Forget Allowed Sites");
    const command = doc.getElementById("whimsyClaudeCommand");
    is(command.textContent, WhimsyClaude.connectInfo().command, "Settings shows the safe command");
    doc.getElementById("whimsyClaudeNewToken").doCommand();
    await TestUtils.waitForCondition(() => doc.getElementById("whimsyClaudeStatus").getAttribute("data-l10n-id") ==
      "whimsy-claude-new-token-note", "Settings confirms completed rotation");
  });
});

add_task(async function test_tools_for_a_task() {
  await turnOn();
  const task = newTask();
  const { tabId, tab } = await openTabFor(task, PAGE);
  ok(!tab.selected, "A new tab opens in the background");
  is(tab.getAttribute("zen-workspace-id"), gZenWorkspaces.activeWorkspace, "in the space the task started in");
  is(tab.getAttribute("whimsy-agent-task"), task.id, "marked with its task");
  ok(task.tabs.has(tab), "and counted as the task's tab");

  const tree = textOf(await ok_result(own(task, "read_page", { tabId }), "read_page"));
  ok(tree.includes('heading "Order form" level=1') && !tree.includes("hunter2"), "read_page outlines the page, never a password");
  ok(/textbox "Password" password \(hidden\)/.test(tree), "The password field shows as hidden");
  const search = refIn(tree, /textbox "Search"/);
  const go = refIn(tree, /button "Go"/);
  const extra = refIn(tree, /checkbox "Extra cheese" unchecked/);
  const size = refIn(tree, /combobox "Size"/);
  const password = refIn(tree, /textbox "Password"/);

  await ok_result(own(task, "type", { tabId, ref: search, text: "BLT" }), "type");
  await ok_result(own(task, "click", { tabId, ref: go }), "click");
  is(await SpecialPowers.spawn(tab.linkedBrowser, [], () => content.document.getElementById("result").textContent), "clicked BLT",
    "type and click act without asking (nothing risky)");
  await ok_result(own(task, "form_input", { tabId, ref: extra, value: true }), "checkbox");
  await ok_result(own(task, "form_input", { tabId, ref: size, value: "Large" }), "select");

  // Enter in a field submits its form: a submit pause first.
  await ok_result(own(task, "type", { tabId, ref: search, text: "" }), "focus the field");
  const pending = own(task, "key", { tabId, keys: "Enter" });
  pending.then(r => info("DIAG key result: " + textOf(r)));
  const pause = await waitForPause(task, "submit");
  ok(pause.allowForTask, "A submit pause may be allowed for this task");
  WhimsyAgentTasks.decide(task.id, "do");
  await ok_result(pending, "Enter after Submit");
  await TestUtils.waitForCondition(() => SpecialPowers.spawn(tab.linkedBrowser, [], () =>
    content.document.getElementById("result").textContent == "submitted"), "The form was submitted");

  const blocked = await own(task, "navigate", { tabId, url: "about:logins" });
  ok(blocked.isError, "navigate refuses browser pages");
  await ok_result(own(task, "tabs_close", { tabId }), "tabs_close");
  ok((await own(task, "read_page", { tabId })).isError, "A closed tab's id stops working");
  WhimsyAgentTasks.finish(task.id);
  void password;
});

add_task(async function no_native_dialog_anywhere() {
  await turnOn();
  const opened = [];
  const seen = subject => opened.push(subject);
  const topics = ["common-dialog-loaded", "tabmodal-dialog-loaded", "domwindowopened"];
  topics.forEach(t => Services.obs.addObserver(seen, t));
  try {
    const listed = JSON.parse(textOf(await ok_result(outside("tabs_create", { url: PAGE }), "outside tabs_create")));
    const tree = textOf(await ok_result(outside("read_page", { tabId: listed.tabId }), "read a new site"));
    await ok_result(outside("click", { tabId: listed.tabId, ref: refIn(tree, /button "Go"/) }), "click on a new site");
    await ok_result(outside("type", { tabId: listed.tabId, ref: refIn(tree, /textbox "Search"/), text: "x" }), "type on a new site");
    is(opened.length, 0, "No dialog or window opened for any of it");
    is(WhimsyClaude.confirmSite, undefined, "There's no per-site prompt to show");
    await outside("tabs_close", { tabId: listed.tabId });
  } finally {
    topics.forEach(t => Services.obs.removeObserver(seen, t));
  }
});

add_task(async function no_permanent_site_permission_written() {
  const principal = Services.scriptSecurityManager.createContentPrincipalFromOrigin("https://example.com");
  Services.perms.addFromPrincipal(principal, "whimsy-claude", Services.perms.ALLOW_ACTION);
  Services.prefs.setBoolPref("whimsy.claude.whole-browser", true);
  Services.prefs.setBoolPref("whimsy.claude.ask-per-site", false);
  WhimsyClaude.migrate();
  is(Services.perms.getAllByTypes(["whimsy-claude"]).length, 0, "Old Always-allow grants are removed");
  ok(!Services.prefs.prefHasUserValue("whimsy.claude.ask-per-site"), "and the ask-per-site bypass is gone");
  ok(!Services.prefs.prefHasUserValue("whimsy.claude.whole-browser"), "as is whole-browser");
  await turnOn();
  const task = newTask();
  const { tabId } = await openTabFor(task, PAGE);
  const tree = textOf(await ok_result(own(task, "read_page", { tabId }), "read"));
  await ok_result(own(task, "click", { tabId, ref: refIn(tree, /button "Go"/) }), "click");
  is(Services.perms.getAllByTypes(["whimsy-claude"]).length, 0, "Acting writes no site permission");
  await own(task, "tabs_close", { tabId });
  WhimsyAgentTasks.finish(task.id);
});

add_task(async function stop_ends_task_only() {
  await turnOn();
  const a = newTask();
  const b = newTask({ mode: "drive" });
  const { tabId: aTab, tab: tabA } = await openTabFor(a, PAGE);
  const { tabId: bTab, tab: tabB } = await openTabFor(b, PAGE);
  await ok_result(own(a, "read_page", { tabId: aTab }), "A reads");
  ok(tabA.hasAttribute("whimsy-claude-active"), "A's tab glows while it works");
  ok(WhimsyClaude.stopTask(a.id), "Stop A");
  is(a.state, "stopped", "A is stopped");
  ok(!tabA.hasAttribute("whimsy-claude-active"), "and its glow goes");
  const refused = await own(a, "read_page", { tabId: aTab });
  ok(refused.isError, "A's next call is refused");
  await ok_result(own(b, "read_page", { tabId: bTab }), "B carries on");
  ok(Services.prefs.getBoolPref(ENABLED), "Stop doesn't turn outside agents off");
  ok(WhimsyClaude.running, "and the server keeps running");

  // ⌘. stops the task using the selected tab.
  gBrowser.selectedTab = tabB;
  EventUtils.synthesizeKey(".", { accelKey: true });
  await TestUtils.waitForCondition(() => b.state == "stopped", "⌘. stops B");

  // An outside app: the first call after Stop says so; the next starts a new task.
  await ok_result(outside("tabs_list", {}, "stop-session"), "outside call");
  const first = WhimsyAgentTasks.forSession("stop-session");
  WhimsyClaude.stopTask(first.id);
  const told = await outside("tabs_list", {}, "stop-session");
  ok(told.isError && textOf(told).includes("stopped this task"), "The app is told once");
  await ok_result(outside("tabs_list", {}, "stop-session"), "then a new task starts");
  isnot(WhimsyAgentTasks.forSession("stop-session").id, first.id, "with a new id");
  BrowserTestUtils.removeTab(tabA);
  BrowserTestUtils.removeTab(tabB);
});

add_task(async function sleep_pauses_nothing_resumes() {
  const task = newTask();
  Services.obs.notifyObservers(null, "sleep_notification");
  is(task.state, "paused", "Sleep pauses a running task");
  is(task.pause.kind, "sleep", "as a sleep pause");
  Services.obs.notifyObservers(null, "wake_notification");
  is(task.state, "paused", "Waking resumes nothing by itself");
  ok(task.pause.until >= task.pause.since, "It knows how long the Mac slept");
  WhimsyAgentTasks.resume(task.id);
  is(task.state, "running", "Continue resumes it");
  // Sleep paused every task; the others carry on here too.
  for (const other of WhimsyAgentTasks.list().filter(t => t.pause?.kind == "sleep")) {
    WhimsyAgentTasks.resume(other.id);
  }
  WhimsyAgentTasks.finish(task.id);
});

add_task(async function outside_agent_cannot_list_private_tab() {
  await turnOn();
  const normal = await BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE + "?normal");
  const secret = WhimsyPrivate.openPrivateTab(window, { url: PAGE + "?private", force: true });
  await BrowserTestUtils.browserLoaded(secret.linkedBrowser, false, PAGE + "?private");
  ok(!PrivateBrowsingUtils.isWindowPrivate(window), "A private tab in a normal window");
  const listed = JSON.parse(textOf(await ok_result(outside("tabs_list", {}, "private-session"), "tabs_list")));
  ok(listed.some(t => t.url.endsWith("?normal")), "The normal tab is listed");
  ok(!listed.some(t => t.url.includes("?private")), "The private tab isn't");
  const privateId = WhimsyClaude.tabId(secret);
  const read = await outside("read_page", { tabId: privateId }, "private-session");
  ok(read.isError && !textOf(read).includes("Order form"), "and can't be read by id");
  ok((await outside("screenshot", { tabId: privateId }, "private-session")).isError, "or captured");
  BrowserTestUtils.removeTab(secret);
  BrowserTestUtils.removeTab(normal);
});

add_task(async function hidden_space_only_when_named_in_task() {
  await turnOn();
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE + "?taxes");
  const uuid = tab.getAttribute("zen-workspace-id");
  const restore = stub(WhimsyHiddenSpaces, "hidden", () => [{ uuid, name: "Taxes" }]);
  try {
    const tabId = WhimsyClaude.tabId(tab);
    ok(!listedIds(await ok_result(outside("tabs_list"), "outside list")).includes(tabId), "An outside app never sees a hidden space");
    const unnamed = newTask();
    ok((await own(unnamed, "read_page", { tabId })).isError, "Whimsy's agent doesn't either, unless asked");
    const named = newTask({ namedSpaceIds: [uuid] });
    await ok_result(own(named, "read_page", { tabId }), "Named in the person's message, it's in");
    WhimsyAgentTasks.finish(unnamed.id);
    WhimsyAgentTasks.finish(named.id);
  } finally {
    restore();
  }
  BrowserTestUtils.removeTab(tab);
});

add_task(async function relock_mid_task_refuses_next_call() {
  await turnOn();
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE + "?locked");
  const uuid = tab.getAttribute("zen-workspace-id");
  let covered = false;
  const restores = [
    stub(WhimsySpaceLock, "space", id => (id == uuid ? { uuid, name: "Taxes", whimsyLocked: true } : null)),
    stub(WhimsySpaceLock, "coveringSpace", t => (covered && t.getAttribute("zen-workspace-id") == uuid ? uuid : null)),
  ];
  try {
    const tabId = WhimsyClaude.tabId(tab);
    ok(!listedIds(await ok_result(outside("tabs_list"), "outside list")).includes(tabId), "A locked space is never an outside app's, even unlocked");
    const task = newTask({ namedSpaceIds: [uuid] });
    await ok_result(own(task, "read_page", { tabId }), "Named and unlocked, it's in");
    covered = true;
    const next = own(task, "read_page", { tabId });
    const pause = await waitForPause(task, "unlock");
    is(pause.spaceId, uuid, "Locked again: Whimsy's Unlock card, for that space");
    Assert.deepEqual(pause.choices, ["do", "skip"], "Unlock or Never mind");
    WhimsyAgentTasks.decide(task.id, "do");
    const result = await next;
    ok(result.isError, "Still locked after the card: the call is refused, nothing cached");
    WhimsyAgentTasks.finish(task.id);
  } finally {
    restores.forEach(r => r());
  }
  BrowserTestUtils.removeTab(tab);
});

add_task(async function step_screenshot_masks_before_capture() {
  await turnOn();
  await WhimsyClaudeReplay.clear();
  const task = newTask();
  const { tabId, tab } = await openTabFor(task, SENSITIVE);
  const rect = await SpecialPowers.spawn(tab.linkedBrowser, ["4242 " + "4242 4242 4242"], card => {
    const cc = content.document.getElementById("cc");
    cc.value = card;
    const r = cc.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: content.innerWidth };
  });
  for (const sel of [false, true]) {
    if (sel) {
      gBrowser.selectedTab = tab;
    }
    const diag = await own(task, "screenshot", { tabId });
    const im = await decode("data:image/jpeg;base64," + diag.content.find(c => c.type == "image").data);
    const sc = im.width / rect.w;
    info(`DIAG selected=${sel} img=${im.width}x${im.height} rect=${JSON.stringify(rect)} px=${pixel(im.data, im.width, rect.x * sc, rect.y * sc)} left=${pixel(im.data, im.width, (rect.x - 100) * sc, rect.y * sc)}`);
  }
  const shot = await ok_result(own(task, "screenshot", { tabId }), "screenshot");
  const image = await decode("data:image/jpeg;base64," + shot.content.find(c => c.type == "image").data);
  const scale = image.width / rect.w;
  const seen = pixel(image.data, image.width, rect.x * scale, rect.y * scale);
  ok(near(seen, MASK_RGB), `The card field is a solid mask in the agent's screenshot (${seen})`);
  ok(!near(seen, [255, 230, 0], 60), "not the field's own yellow");
  await WhimsyClaudeReplay.flush();
  const run = (await WhimsyClaudeReplay.runs()).find(r => r.taskId == task.id);
  const step = run?.steps.find(s => s.tool == "screenshot" && s.thumb);
  ok(step, "Activity kept a thumbnail of the step");
  const thumb = await decode(step.thumb);
  const ts = thumb.width / rect.w;
  ok(near(pixel(thumb.data, thumb.width, rect.x * ts, rect.y * ts), MASK_RGB, 40), "The saved step is masked too");
  const bitmap = await tab.linkedBrowser.browsingContext.currentWindowGlobal.drawSnapshot(null, 1, "white");
  const canvas = document.createElementNS("http://www.w3.org/1999/xhtml", "canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  canvas.getContext("2d").drawImage(bitmap, 0, 0);
  const plain = canvas.getContext("2d").getImageData(0, 0, bitmap.width, bitmap.height).data;
  const ps = bitmap.width / rect.w;
  ok(near(pixel(plain, bitmap.width, rect.x * ps, rect.y * ps), [255, 230, 0], 30), "The mask lifts after the capture");
  bitmap.close();
  await own(task, "tabs_close", { tabId });
  WhimsyAgentTasks.finish(task.id);
});

add_task(async function read_page_omits_card_values() {
  await turnOn();
  const task = newTask();
  const { tabId, tab } = await openTabFor(task, SENSITIVE);
  const card = "4242" + "424242424242";
  await SpecialPowers.spawn(tab.linkedBrowser, [card], value => {
    const doc = content.document;
    doc.getElementById("cc").value = value;
    doc.getElementById("otp").value = "135" + "791";
    doc.getElementById("otpedit").textContent = "246" + "802";
    doc.getElementById("notes").value = "card " + value;
    doc.getElementById("pw").setUserInput("hunter" + "22");
  });
  const tree = textOf(await ok_result(own(task, "read_page", { tabId }), "read_page"));
  const text = textOf(await ok_result(own(task, "get_page_text", { tabId }), "get_page_text"));
  const found = textOf(await ok_result(own(task, "find", { tabId, query: "code" }), "find"));
  for (const [label, body] of [["outline", tree], ["text", text], ["find", found]]) {
    ok(!body.includes(card) && !body.includes("4242 4242"), `${label}: no card number`);
    ok(!body.includes("135791") && !body.includes("246802"), `${label}: no one-time code`);
    ok(!body.includes("hunter22"), `${label}: no password, not even mirrored into the page`);
  }
  ok(/card \(hidden\)/.test(tree), "The card field shows as hidden");
  ok(tree.includes("Ada Lovelace"), "Ordinary values are still read");
  await own(task, "tabs_close", { tabId });
  WhimsyAgentTasks.finish(task.id);
});

add_task(async function type_refuses_sensitive_fields() {
  await turnOn();
  const task = newTask();
  const { tabId, tab } = await openTabFor(task, SENSITIVE);
  const tree = textOf(await ok_result(own(task, "read_page", { tabId }), "read_page"));
  const cc = refIn(tree, /card \(hidden\)/);
  const typing = own(task, "type", { tabId, ref: cc, text: "4242" });
  const pause = await waitForPause(task);
  ok(pause.handOver, "Typing into a card field hands the step to the person");
  Assert.deepEqual(pause.choices, ["self", "skip"], "with only I'll do it and Don't");
  ok(!WhimsyAgentTasks.decide(task.id, "do"), "The agent can't be told to do it");
  WhimsyAgentTasks.decide(task.id, "skip");
  const result = await typing;
  ok(textOf(result).includes("chose not to"), "Skipped");
  is(await SpecialPowers.spawn(tab.linkedBrowser, [], () => content.document.getElementById("cc").value), "", "The field is untouched");
  // The page half refuses too, whatever the parent asks.
  const actor = tab.linkedBrowser.browsingContext.currentWindowGlobal.getActor("WhimsyClaude");
  for (const id of ["cc", "otp", "pw"]) {
    const answer = await actor.sendQuery("Claude:FormInput", { ref: refIn(tree, new RegExp(id == "cc" ? "card \\(hidden\\)" : id == "otp" ? "otp \\(hidden\\)" : "password \\(hidden\\)")), value: "1" });
    ok(answer?.error, `The page refuses to fill the ${id} field: ${answer?.error}`);
  }
  await own(task, "tabs_close", { tabId });
  WhimsyAgentTasks.finish(task.id);
});

add_task(async function load_timeout_retries_twice_then_drive_pauses() {
  await turnOn();
  is(WhimsyClaude.timing.load, 20000, "A page gets 20 seconds");
  Assert.deepEqual(WhimsyClaude.timing.retries, [5000, 15000], "then tries again after 5s and 15s");
  const retries = WhimsyClaude.timing.retries;
  WhimsyClaude.timing.retries = [0, 0];
  let waits = 0;
  const restore = stub(WhimsyClaude, "waitForLoad", async () => (waits++, false));
  const task = newTask({ mode: "drive" });
  try {
    const creating = own(task, "tabs_create", { url: PAGE + "?slow" });
    const pause = await waitForPause(task, "timeout");
    is(waits, 3, "Three tries");
    Assert.deepEqual(task.steps.filter(s => s.step == "retry").map(s => s.n), [2, 3], "shown as trying again (2 of 3), (3 of 3)");
    Assert.deepEqual(pause.choices, ["do", "skip", "stop"], "Drive: Try again, Skip this site, End task");
    WhimsyAgentTasks.decide(task.id, "skip");
    const result = await creating;
    ok(textOf(result).includes("skipped"), "Skip this site");
    ok(task.skipped.includes("example.com"), "and it's listed");
  } finally {
    restore();
    WhimsyClaude.timing.retries = retries;
    WhimsyAgentTasks.finish(task.id);
  }
  for (const tab of [...task.tabs]) {
    BrowserTestUtils.removeTab(tab);
  }
});

add_task(async function background_skips_and_lists() {
  await turnOn();
  const retries = WhimsyClaude.timing.retries;
  WhimsyClaude.timing.retries = [0, 0];
  const restore = stub(WhimsyClaude, "waitForLoad", async () => false);
  const task = newTask({ mode: "background" });
  try {
    const result = await own(task, "tabs_create", { url: PAGE + "?slow" });
    ok(result.isError && textOf(result).includes("skipped"), "Background skips the site and carries on");
    ok(!task.pause, "without asking");
    ok(task.skipped.includes("example.com"), "and lists it for the end");
  } finally {
    restore();
    WhimsyClaude.timing.retries = retries;
    WhimsyAgentTasks.finish(task.id);
  }
  for (const tab of [...task.tabs]) {
    BrowserTestUtils.removeTab(tab);
  }
});

add_task(async function injection_notice_folds_per_site() {
  await turnOn();
  const thread = await WhimsyAIStore.createThread({ kind: "agent", title: "Injection test" });
  const task = newTask({ threadId: thread.id });
  const { tabId } = await openTabFor(task, INJECTION);
  const first = textOf(await ok_result(own(task, "read_page", { tabId }), "read_page"));
  ok(first.includes("Whimsy ignored it"), "The page's instructions are ignored and the agent is told so");
  ok(!task.pause, "The task doesn't pause for it");
  await ok_result(own(task, "get_page_text", { tabId }), "get_page_text");
  await ok_result(own(task, "read_page", { tabId }), "read again");
  const notices = await TestUtils.waitForCondition(async () => {
    const cards = (await WhimsyAIStore.messages(thread.id)).filter(m => m.card == "agent-injection");
    return cards.length == 1 && cards[0].count == 3 && cards;
  }, "One notice in the thread for the site, counting every hit");
  ok(notices[0].snippets[0], "with the snippet");
  is(notices[0].host, "example.com", "and the site");
  ok(notices[0].where?.url, "and where it was, for Show where");
  await own(task, "tabs_close", { tabId });
  WhimsyAgentTasks.finish(task.id);
  await WhimsyAIStore.deleteThread(thread.id);
});

add_task(async function activity_retention_menu_and_delete_run() {
  Assert.deepEqual(WhimsyClaudeReplay.RETENTION_CHOICES, [7, 30, 90, 0], "7 days, 30 days, 90 days, Forever");
  is(WhimsyClaudeReplay.retentionDays, 30, "30 days by default");
  Assert.throws(() => (WhimsyClaudeReplay.retentionDays = 12), /7, 30, or 90/, "Nothing else");
  const day = 24 * 60 * 60 * 1000;
  const now = Date.now();
  const make = (id, ago, client = "whimsy") => ({ id, taskId: id, client, start: now - ago, end: now - ago, steps: [{ t: now - ago, tool: "read_page", ok: true }] });
  const runs = () => [make("new", 0), make("ten", 10 * day, "outside"), make("forty", 40 * day), make("old", 400 * day)];
  WhimsyClaudeReplay.retentionDays = 7;
  Assert.deepEqual(WhimsyClaudeReplay.prune(runs(), now).map(r => r.id), ["new"], "7 days");
  WhimsyClaudeReplay.retentionDays = 30;
  Assert.deepEqual(WhimsyClaudeReplay.prune(runs(), now).map(r => r.id), ["new", "ten"], "30 days");
  WhimsyClaudeReplay.retentionDays = 0;
  is(WhimsyClaudeReplay.prune(runs(), now).length, 4, "Forever keeps them all");
  Services.prefs.clearUserPref(DAYS);

  await turnOn();
  await WhimsyClaudeReplay.clear();
  const mine = newTask();
  const { tabId } = await openTabFor(mine, PAGE);
  await ok_result(own(mine, "read_page", { tabId }), "own read");
  await ok_result(outside("tabs_list", {}, "activity-session"), "outside call");
  await WhimsyClaudeReplay.flush();
  const all = await WhimsyClaudeReplay.runs();
  ok(all.some(r => r.client == "whimsy" && r.taskId == mine.id), "Own runs are in Activity");
  ok(all.some(r => r.client == "outside" && r.clientName == "test-app"), "and outside apps' runs");
  is((await WhimsyClaudeReplay.runs({ client: "outside" })).every(r => r.client == "outside"), true, "filtered by who ran them");
  const path = PathUtils.join(WhimsyAIStore.dir, "agent-runs.json");
  ok(await IOUtils.exists(path), "kept in the AI store");
  is((await IOUtils.stat(path)).permissions & 0o777, 0o600, "privately");
  const doomed = all.find(r => r.taskId == mine.id);
  await WhimsyClaudeReplay.deleteRun(doomed.id);
  ok(!(await WhimsyClaudeReplay.runs()).some(r => r.id == doomed.id), "Delete Run removes it");
  await WhimsyAIStore.clear({ kinds: ["activity"] });
  is((await WhimsyClaudeReplay.runs()).length, 0, "The Fire button clears Activity");
  await own(mine, "tabs_close", { tabId });
  WhimsyAgentTasks.finish(mine.id);
});

add_task(async function own_space_limits_outside_apps() {
  await turnOn();
  const mine = await BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE + "?mine");
  const before = gZenWorkspaces.getWorkspaces().length;
  Services.prefs.setBoolPref(OWN, true);
  const spaceId = await TestUtils.waitForCondition(() => Services.prefs.getStringPref(OWN_ID, ""), "Turning it on makes the AI space");
  const space = gZenWorkspaces.getWorkspaces().find(w => w.uuid == spaceId);
  try {
    ok(space, "a normal space");
    is(gZenWorkspaces.getWorkspaces().length, before + 1, "one more in the switcher");
    is(space.name, "AI", "named AI");
    ok(space.containerTabId > 0, "with its own container");
    ok(!WhimsyHiddenSpaces.hidden(window).some(s => s.uuid == spaceId), "and visible, not hidden");
    const listed = textOf(await ok_result(outside("tabs_list", {}, "own-session"), "outside list"));
    ok(!listed.includes("?mine"), "Outside apps no longer see the person's other spaces");
    const created = JSON.parse(textOf(await ok_result(outside("tabs_create", { url: PAGE + "?ai" }, "own-session"), "outside create")));
    const tab = WhimsyClaude.tabById(created.tabId);
    is(tab.getAttribute("zen-workspace-id"), spaceId, "Their tabs open in the AI space");
    is(tab.userContextId, space.containerTabId, "in its container");
    const task = newTask();
    const ownList = textOf(await ok_result(own(task, "tabs_list"), "own list"));
    ok(ownList.includes("?mine"), "Whimsy's own agent isn't limited by it");
    WhimsyAgentTasks.finish(task.id);
    BrowserTestUtils.removeTab(tab);
  } finally {
    Services.prefs.clearUserPref(OWN);
    Services.prefs.clearUserPref(OWN_ID);
    if (space) {
      await gZenWorkspaces.removeWorkspace(space.uuid);
      const { ContextualIdentityService } = ChromeUtils.importESModule("resource://gre/modules/ContextualIdentityService.sys.mjs");
      ContextualIdentityService.remove(space.containerTabId);
    }
    BrowserTestUtils.removeTab(mine);
  }
});

add_task(async function connect_writes_backup_first() {
  await turnOn();
  const home = await IOUtils.createUniqueDirectory(PathUtils.tempDir, "whimsy-home");
  WhimsyOutsideAgents._setHomeForTesting(home);
  const calls = [];
  WhimsyOutsideAgents._setRunnerForTesting(async (command, args) => {
    calls.push({ command, args, backupThere: await IOUtils.exists(PathUtils.join(home, ".claude.json.whimsy-backup")) });
    return { exitCode: 0, output: "" };
  });
  try {
    const bridge = WhimsyClaude.connectInfo().bridgePath;
    // Cursor: JSON, another server kept.
    const cursor = PathUtils.join(home, ".cursor", "mcp.json");
    await IOUtils.makeDirectory(PathUtils.parent(cursor), { createAncestors: true });
    const original = JSON.stringify({ mcpServers: { other: { command: "/bin/other", args: [] } } });
    await IOUtils.writeUTF8(cursor, original);
    const found = (await WhimsyOutsideAgents.detect()).map(a => a.id);
    ok(found.includes("cursor") && !found.includes("codex"), `Only what's installed is found (${found})`);
    const { backupPath } = await WhimsyOutsideAgents.connect("cursor");
    is(backupPath, cursor + ".whimsy-backup", "A backup beside the file");
    is(await IOUtils.readUTF8(backupPath), original, "holding the file as it was");
    const written = JSON.parse(await IOUtils.readUTF8(cursor));
    Assert.deepEqual(written.mcpServers.whimsy, { command: bridge, args: [] }, "Whimsy's connector is added");
    ok(written.mcpServers.other, "and the app's other servers stay");

    // Codex: TOML, an old Whimsy table replaced, not doubled.
    const codex = PathUtils.join(home, ".codex", "config.toml");
    await IOUtils.makeDirectory(PathUtils.parent(codex), { createAncestors: true });
    await IOUtils.writeUTF8(codex, 'model = "x"\n\n[mcp_servers.whimsy]\ncommand = "/old"\n\n[mcp_servers.other]\ncommand = "/bin/other"\n');
    await WhimsyOutsideAgents.connect("codex");
    const toml = await IOUtils.readUTF8(codex);
    is(toml.match(/\[mcp_servers\.whimsy\]/g).length, 1, "One Whimsy table");
    ok(toml.includes(`command = "${bridge}"`) && !toml.includes("/old"), "pointing at the connector");
    ok(toml.includes("[mcp_servers.other]") && toml.includes('model = "x"'), "the rest kept");
    ok(await IOUtils.exists(codex + ".whimsy-backup"), "backed up first");

    // VS Code: its own "servers" key and a stdio entry.
    const vscode = PathUtils.join(home, "Library", "Application Support", "Code", "User", "mcp.json");
    await IOUtils.makeDirectory(PathUtils.parent(vscode), { createAncestors: true });
    await WhimsyOutsideAgents.connect("vscode");
    Assert.deepEqual(JSON.parse(await IOUtils.readUTF8(vscode)).servers.whimsy, { type: "stdio", command: bridge, args: [] }, "VS Code's format");
    is((await IOUtils.stat(vscode)).permissions & 0o777, 0o600, "A new config file is private");

    // Claude Code: its own command, after a backup of ~/.claude.json.
    await IOUtils.makeDirectory(PathUtils.join(home, ".local", "bin"), { createAncestors: true });
    await IOUtils.writeUTF8(PathUtils.join(home, ".local", "bin", "claude"), "#!/bin/sh\n");
    await IOUtils.writeUTF8(PathUtils.join(home, ".claude.json"), "{}");
    await WhimsyOutsideAgents.connect("claude-code");
    const add = calls.find(c => c.args.includes("add"));
    Assert.deepEqual(add.args, ["mcp", "add", "-s", "user", "whimsy", "--", bridge], "claude mcp add -s user whimsy -- <connector>");
    ok(add.backupThere, "after backing up ~/.claude.json");

    // Forgetting an app takes Whimsy out again.
    await WhimsyOutsideAgents.remove("cursor");
    ok(!JSON.parse(await IOUtils.readUTF8(cursor)).mcpServers.whimsy, "Remove takes Whimsy out of the app's config");
  } finally {
    WhimsyOutsideAgents._setHomeForTesting(null);
    WhimsyOutsideAgents._setRunnerForTesting(null);
    await IOUtils.remove(home, { recursive: true });
  }
});

add_task(async function token_never_in_app_config() {
  await turnOn();
  const home = await IOUtils.createUniqueDirectory(PathUtils.tempDir, "whimsy-home");
  WhimsyOutsideAgents._setHomeForTesting(home);
  try {
    const token = (await IOUtils.readUTF8(PathUtils.join(PathUtils.parent(WhimsyClaude.connectInfo().bridgePath), "token"))).trim();
    const written = [];
    for (const id of ["cursor", "codex", "vscode", "claude-desktop"]) {
      written.push((await WhimsyOutsideAgents.connect(id)).path);
    }
    for (const path of written) {
      const body = await IOUtils.readUTF8(path);
      ok(body.includes("bridge"), `${PathUtils.filename(path)} names the connector`);
      ok(!body.includes(token), `${PathUtils.filename(path)} never holds the token`);
    }
    const apps = await WhimsyOutsideAgents.apps();
    ok(apps.some(a => a.name == "test" && a.lastUsed), "Apps that connected are listed with when they were last used");
  } finally {
    WhimsyOutsideAgents._setHomeForTesting(null);
    await IOUtils.remove(home, { recursive: true });
  }
});

add_task(async function test_switches_turn_it_off() {
  await turnOn();
  Services.prefs.setBoolPref(FEATURE, false);
  ok(!WhimsyClaude.running, "The feature switch stops the server");
  Services.prefs.clearUserPref(FEATURE);
  await WhimsyClaude.start();
  ok(WhimsyClaude.running, "Switching it back on restarts it");
  Services.prefs.setBoolPref(AI_ENABLED, false);
  ok(!WhimsyClaude.running, "AI off stops it too");
  const task = newTask();
  ok((await own(task, "tabs_list")).isError, "and Whimsy's own agent");
  WhimsyAgentTasks.finish(task.id);
  Services.prefs.setBoolPref(AI_ENABLED, true);
  await WhimsyAI.pending;
  Services.prefs.clearUserPref(ENABLED);
  ok(!WhimsyClaude.running, "Turning it off in Settings stops it");
});
