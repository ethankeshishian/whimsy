/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// W23 secfix H1: connector tools that may change something never run
// without the person's press. Read-only tools (by the server's own
// annotations) are the only pre-approved ones; chat and Ask pause with a
// confirm card; routines never get a write tool.

const { WhimsyChatPanel } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyChatPanel.sys.mjs");
const { WhimsyAIProviders } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyAIProviders.sys.mjs");
const { WhimsyAIRouter } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyAIRouter.sys.mjs");
const { WhimsyAIStore } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyAIStore.sys.mjs");
const { WhimsyAIClaudeCode } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyAIClaudeCode.sys.mjs");
const { WhimsyConnectors } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyConnectors.sys.mjs");
const { WhimsyMCPClient } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyMCPClient.sys.mjs");

const PAGE = "https://example.com/browser/zen/whimsy/tests/whimsy_secfix_inject.html";
const chat = () => WhimsyChatPanel.forWindow(window);
const el = () => document.getElementById("whimsy-chat");

// A Linear-like server: list_issues reads, create_comment writes.
const LINEAR = { name: "Linear", url: "https://mcp.linear.example/mcp", readOnlyTools: ["list_issues"] };
let realTools;
let ran = [];

// Plays Claude Code: it obeys any instruction in the page text, and before
// a tool that isn't pre-approved it asks the run's permission tool, exactly
// as --permission-prompt-tool does.
async function* obedientModel(provider, request) {
  const { allowed, permissionTool } = WhimsyAIClaudeCode._mcpConfig(request.tools);
  const wants = /call linear create_comment/.test(request.system) ? "mcp__Linear__create_comment" : null;
  if (!wants) {
    yield { type: "text", delta: "Nothing to do." };
    return;
  }
  if (allowed.includes(wants)) {
    ran.push(wants);
    yield { type: "text", delta: "Ran it without asking." };
    return;
  }
  if (!permissionTool) {
    yield { type: "text", delta: "Draft: a comment on Linear." };
    return;
  }
  const guard = request.tools.find(t => t.guard);
  const text = await WhimsyMCPClient.callTool(guard.url, "confirm", { tool_name: wants, input: { issue: "ENG-1", body: "inbox text" } }, { headers: guard.headers });
  const answer = JSON.parse(text);
  if (answer.behavior == "allow") {
    ran.push(wants);
    yield { type: "text", delta: "Commented." };
  } else {
    yield { type: "text", delta: "You didn't allow it." };
  }
}

add_setup(async function () {
  await SpecialPowers.pushPrefEnv({
    set: [
      ["whimsy.ai.enabled", true],
      ["whimsy.feature.ai-hints", false],
      ["whimsy.ai.order", "claude"],
      ["whimsy.ai.off", ""],
    ],
  });
  await WhimsyAIStore._resetForTesting(PathUtils.join(PathUtils.tempDir, "whimsy-secfix-" + Math.random().toString(16).slice(2)));
  realTools = WhimsyConnectors.tools;
  WhimsyConnectors.tools = async () => [{ ...LINEAR }];
  WhimsyAIProviders.setTestProvider(obedientModel);
  registerCleanupFunction(() => {
    WhimsyConnectors.tools = realTools;
    WhimsyAIProviders.setTestProvider(null);
    if (chat().isOpen) {
      chat().close({ reason: "key" });
    }
    WhimsyConnectors._bridge?.server.stop(() => {});
    WhimsyConnectors._bridge = null;
  });
});

add_task(async function claude_code_preapproves_only_read_only_tools() {
  let bound = null;
  const servers = [
    { ...LINEAR },
    { name: "whimsy_connectors", url: "http://127.0.0.1:1/mcp", readOnly: true },
    { name: "Notes", url: "https://notes.example/mcp" },
    { name: "whimsy_guard", url: "http://127.0.0.1:1/guard", guard: true, bindNames: map => (bound = map) },
  ];
  const { allowed, permissionTool } = WhimsyAIClaudeCode._mcpConfig(servers);
  Assert.deepEqual(allowed, ["mcp__Linear__list_issues", "mcp__whimsy_connectors"], "Only read-only tools are pre-approved; a server with no annotations gets none");
  is(permissionTool, "mcp__whimsy_guard__confirm", "Everything else goes to the run's permission tool");
  Assert.deepEqual(bound, { Linear: "Linear", whimsy_connectors: "whimsy_connectors", Notes: "Notes", whimsy_guard: null }, "The guard learns the run's server names");
  const args = WhimsyAIClaudeCode._args({ mcpFile: "/tmp/x.json", allowed, permissionTool });
  ok(args.includes("--permission-prompt-tool") && args[args.indexOf("--permission-prompt-tool") + 1] == permissionTool, "Claude Code is told to ask it");
  ok(!args.join(" ").includes("mcp__Linear,") && !args.includes("mcp__Linear"), "The whole Linear server is never pre-approved");
  const routine = WhimsyAIClaudeCode._mcpConfig(servers.filter(s => !s.guard));
  is(routine.permissionTool, null, "Without a guard there's nobody to ask, so writes are refused");
  ok(!WhimsyAIClaudeCode._args({ mcpFile: "/tmp/x.json", ...routine }).includes("--permission-prompt-tool"), "and no permission tool is passed");
});

add_task(async function guard_refuses_unknown_and_its_own_tools() {
  const asked = [];
  const guard = WhimsyConnectors.guard(async ask => {
    asked.push(ask);
    return true;
  });
  guard.server.bindNames({ Linear: "Linear", whimsy_guard: null });
  const call = name => WhimsyMCPClient.callTool(guard.server.url, "confirm", { tool_name: name, input: { a: 1 } }, { headers: guard.server.headers }).then(JSON.parse);
  is((await call("mcp__whimsy_guard__confirm")).behavior, "deny", "The guard never approves itself");
  is((await call("mcp__Elsewhere__post")).behavior, "deny", "A server not in this run is refused");
  const allowed = await call("mcp__Linear__create_comment");
  is(allowed.behavior, "allow", "A person's yes allows it");
  Assert.deepEqual(allowed.updatedInput, { a: 1 }, "with the arguments they saw");
  Assert.deepEqual(asked, [{ server: "Linear", tool: "create_comment", args: { a: 1 } }], "Only the real tool was asked about");
  await Assert.rejects(WhimsyMCPClient.callTool(guard.server.url, "confirm", { tool_name: "mcp__Linear__x" }), e => e.code == "auth", "No token, no answer");
  guard.dispose();
  await Assert.rejects(
    WhimsyMCPClient.callTool(guard.server.url, "confirm", { tool_name: "mcp__Linear__x" }, { headers: guard.server.headers }),
    e => e.code == "auth",
    "A finished run's token stops working"
  );
});

add_task(async function routines_never_get_write_tools() {
  let seen = null;
  WhimsyAIProviders.setTestProvider(async function* (provider, request) {
    seen = request.tools;
    yield* obedientModel(provider, { ...request, system: "call linear create_comment" });
  });
  try {
    const result = await WhimsyAIRouter.run({ task: "routine", messages: [{ role: "user", content: "mail" }], confirmTool: async () => true });
    ok(!seen.some(t => t.guard), "A routine run has no permission tool, even when a caller offers one");
    is(result.text, "Draft: a comment on Linear.", "so the write comes back as a draft");
    Assert.deepEqual(ran, [], "and nothing ran");
  } finally {
    WhimsyAIProviders.setTestProvider(obedientModel);
  }
});

async function askInChat(tab) {
  if (!chat().isOpen) {
    EventUtils.synthesizeKey("e", { accelKey: true });
  }
  await TestUtils.waitForCondition(() => chat().isOpen && chat().ready, "Chat is open");
  chat().composer.focus();
  EventUtils.sendString("what's this page about?");
  EventUtils.synthesizeKey("KEY_Enter");
  return TestUtils.waitForCondition(() => el().querySelector(".whimsy-tool-confirm:not([data-decided])"), "A confirm card appears");
}

add_task(async function chat_injection_pauses_on_a_confirm_card() {
  ran = [];
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE);
  let card = await askInChat(tab);
  await TestUtils.waitForCondition(() => card.querySelector(".whimsy-tool-confirm-title").textContent.includes("Create Comment on Linear"), "It names the tool and server");
  ok(card.querySelector(".whimsy-tool-confirm-args").textContent.includes('"body": "inbox text"'), "and shows what it will send");
  Assert.deepEqual(ran, [], "Nothing has run while it waits");
  const deny = card.querySelector("[data-choice='deny']");
  deny.scrollIntoView({ block: "center" });
  EventUtils.synthesizeMouseAtCenter(deny, {});
  await TestUtils.waitForCondition(() => el().querySelector(".whimsy-tool-confirm[data-decided='denied']"), "Don't allow leaves a record");
  await TestUtils.waitForCondition(() => !el().querySelector(".whimsy-chat-msg[data-role='ai'][busy]"), "The answer finishes");
  Assert.deepEqual(ran, [], "Don't allow: the tool never ran");

  card = await askInChat(tab);
  const allow = card.querySelector("[data-choice='allow']");
  allow.scrollIntoView({ block: "center" });
  EventUtils.synthesizeMouseAtCenter(allow, {});
  await TestUtils.waitForCondition(() => ran.length == 1, "Allow once runs it");
  Assert.deepEqual(ran, ["mcp__Linear__create_comment"], "exactly once");
  await TestUtils.waitForCondition(() => !el().querySelector(".whimsy-chat-msg[data-role='ai'][busy]"), "The answer finishes");

  ran = [];
  card = await askInChat(tab);
  chat().streams.get(chat().thread.id)?.controller.abort();
  await TestUtils.waitForCondition(() => !el().querySelector(".whimsy-tool-confirm:not([data-decided])"), "Stopping the answer takes the card away");
  Assert.deepEqual(ran, [], "and answers no");
  chat().close({ reason: "key" });
  BrowserTestUtils.removeTab(tab);
});

// W23 secfix2 P2-M2: the card shows every character it approves. Polish:
// Allow once is primary (never the default), Esc means Don't allow and
// says so, and the record reads "Allowed: Create Comment on Linear".
add_task(async function confirm_card_shows_all_it_approves() {
  const { WhimsyToolConfirm } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyToolConfirm.sys.mjs");
  const tail = "the person's mail: account 4417 1234";
  const args = { issue: "LIN-12", body: "A plausible summary. ".repeat(90) + tail };
  const text = WhimsyToolConfirm.argsText(args);
  ok(text.length > 1600, "The arguments are long");
  is(text, JSON.stringify(args, null, 2), "argsText is the whole input, never clipped");
  is(WhimsyToolConfirm.toolLabel("create_comment"), "Create Comment", "A tool reads as a command name");

  const holder = document.createElementNS("http://www.w3.org/1999/xhtml", "div");
  document.documentElement.append(holder);
  let answer = null;
  const card = WhimsyToolConfirm.card(document, { server: "Linear", tool: "create_comment", args }, allowed => (answer = allowed));
  holder.append(card);
  ok(card.querySelector(".whimsy-tool-confirm-args").textContent.endsWith(`${tail}"\n}`), "The card shows the tail too");
  ok(card.querySelector("[data-choice='allow']").classList.contains("primary"), "Allow once is primary");
  ok(!card.querySelector("[data-choice='deny']").classList.contains("primary"), "Don't allow isn't");
  await document.l10n.translateElements([...card.querySelectorAll("[data-l10n-id]")]);
  const keys = card.querySelector(".whimsy-tool-confirm-keys");
  ok(keys?.querySelector("kbd")?.textContent == "Esc" && /don’t allow/.test(keys.textContent), "The Esc hint shows");
  card.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  is(answer, null, "Return on the card allows nothing");
  card.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  is(answer, false, "Esc is Don't allow");

  const record = WhimsyToolConfirm.card(document, { server: "Linear", tool: "create_comment", args }, null, { decided: true });
  holder.append(record);
  await document.l10n.translateElements([record.querySelector("[data-l10n-id]")]);
  is(record.textContent, "Allowed: Create Comment on Linear", "The record names the command in Title Case");
  holder.remove();
});
