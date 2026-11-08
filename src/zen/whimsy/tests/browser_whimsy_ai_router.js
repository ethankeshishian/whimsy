/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// W23 ai-core: the provider order, per-provider switches, capabilities,
// resting, and WhimsyAIRouter (routing, Quick text on Apple, handoff before
// the first token, the kept partial answer mid-stream, capability fallback,
// thinking levels per provider, and the event stream).

const { WhimsyAIProviders, WhimsyAIError, ENDPOINTS, parseResetTime } = ChromeUtils.importESModule(
  "resource:///modules/whimsy/WhimsyAIProviders.sys.mjs"
);
const { WhimsyAIRouter } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyAIRouter.sys.mjs");
const { OSKeyStoreTestUtils } = ChromeUtils.importESModule("resource://testing-common/OSKeyStoreTestUtils.sys.mjs");
const { HttpServer } = ChromeUtils.importESModule("resource://testing-common/httpd.sys.mjs");

const PREFS = [
  "whimsy.ai.auto-enabled",
  "whimsy.ai.order",
  "whimsy.ai.off",
  "whimsy.ai.quick-text-apple",
  "whimsy.ai.resting",
  "whimsy.ai.provider",
  "whimsy.ai.openai.model",
  "whimsy.ai.gemini.model",
  "whimsy.ai.claude.model",
  "whimsy.ai.ollama.model",
  "whimsy.ai.ollama.endpoint",
  "whimsy.ai.openai.auth",
  "whimsy.ai.claude.auth",
  "whimsy.feature.ai-claude-plan",
];
const BUILT_IN_PLANS = { ...WhimsyAIProviders._plans };
const savedEndpoints = { ...ENDPOINTS };

OSKeyStoreTestUtils.setup();
registerCleanupFunction(async () => {
  WhimsyAIProviders.setTestProvider(null);
  Object.assign(ENDPOINTS, savedEndpoints);
  for (const provider of ["claude", "openai", "gemini"]) {
    await WhimsyAIProviders.setKey(provider, "");
  }
  WhimsyAIProviders._plans.claude = BUILT_IN_PLANS.claude;
  WhimsyAIProviders._claudePlanStreams = null;
  WhimsyAIProviders._ollamaDetails.clear();
  for (const pref of PREFS) {
    Services.prefs.clearUserPref(pref);
  }
  Services.prefs.setBoolPref("whimsy.ai.enabled", true);
  await OSKeyStoreTestUtils.cleanup();
});

async function rejectsWith(promise, code, message) {
  try {
    await promise;
    ok(false, `${message}: expected ${code}`);
    return null;
  } catch (error) {
    is(error?.code, code, message);
    return error;
  }
}

// A stand-in for every provider: script[id] is an async generator body.
function stub(script) {
  const calls = [];
  WhimsyAIProviders.setTestProvider(async function* (provider, request) {
    calls.push({ provider, request });
    yield* (script[provider] ?? (async function* () {
      throw new WhimsyAIError("unavailable");
    }))(request);
  });
  return calls;
}

const says = text =>
  async function* () {
    yield { type: "text", delta: text };
  };
const fails = code =>
  async function* () {
    throw new WhimsyAIError(code);
  };

function collect() {
  const events = [];
  return { events, onEvent: event => events.push(event) };
}

// A local stand-in for the cloud APIs and Ollama; each handler gets the
// parsed JSON body and returns { status?, type?, body }.
function mockServer(routes) {
  const server = new HttpServer();
  server.start(-1);
  const base = `http://localhost:${server.identity.primaryPort}`;
  const seen = [];
  server.registerPrefixHandler("/", (request, response) => {
    let body = {};
    try {
      const stream = request.bodyInputStream;
      const count = stream.available();
      body = JSON.parse(count ? NetUtil.readInputStreamToString(stream, count, { charset: "UTF-8" }) : "{}");
    } catch {}
    seen.push({ path: request.path, body });
    const route = Object.keys(routes).find(prefix => request.path.startsWith(prefix));
    const reply = route ? routes[route](body, request) : { status: 404, body: "{}" };
    response.setStatusLine(request.httpVersion, reply.status ?? 200, "x");
    response.setHeader("content-type", reply.type ?? "application/json");
    response.write(typeof reply.body == "string" ? reply.body : JSON.stringify(reply.body));
  });
  return { base, seen, stop: () => new Promise(r => server.stop(r)) };
}

const sse = events => ({
  type: "text/event-stream",
  body: events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join(""),
});

// ---- Task 1: order, switches, capabilities, resting ----

add_task(async function order_appends_new_connection_at_end() {
  const mock = mockServer({
    "/claude/models": () => ({ body: { data: [{ id: "claude-x" }] } }),
    "/openai/models": () => ({ body: { data: [{ id: "gpt-5-x", created: 1 }] } }),
    "/gemini/models": () => ({ body: { models: [{ name: "models/gemini-2.5-x", supportedGenerationMethods: ["generateContent"] }] } }),
  });
  Object.assign(ENDPOINTS, { claude: `${mock.base}/claude`, openai: `${mock.base}/openai`, gemini: `${mock.base}/gemini` });
  const topics = [];
  const observer = (_, __, data) => topics.push(data);
  Services.obs.addObserver(observer, "whimsy-ai-providers-changed");
  const key = name => "key-" + name + "-0001";

  Services.prefs.setStringPref("whimsy.ai.order", "");
  await WhimsyAIProviders.connectKey("openai", key("openai"));
  await WhimsyAIProviders.connectKey("gemini", key("gemini"));
  Assert.deepEqual(WhimsyAIProviders.order, ["openai", "gemini"], "Connections line up in the order they were made");
  await WhimsyAIProviders.connectKey("claude", key("claude"));
  Assert.deepEqual(WhimsyAIProviders.order, ["openai", "gemini", "claude"], "A new connection goes at the end");
  await WhimsyAIProviders.connectKey("openai", key("openai"));
  Assert.deepEqual(WhimsyAIProviders.order, ["openai", "gemini", "claude"], "Connecting again keeps its place");
  WhimsyAIProviders.setOrder(["claude", "openai", "gemini", "nonsense", "claude"]);
  Assert.deepEqual(WhimsyAIProviders.order, ["claude", "openai", "gemini"], "setOrder keeps known ids once each");
  is(WhimsyAIProviders.provider, "claude", "The first one is tried first");
  await WhimsyAIProviders.disconnect("openai");
  Assert.deepEqual(WhimsyAIProviders.order, ["claude", "gemini"], "Disconnecting takes it out of the order");
  ok(topics.includes("order") && topics.includes("connected"), "whimsy-ai-providers-changed says what changed");

  Services.obs.removeObserver(observer, "whimsy-ai-providers-changed");
  await WhimsyAIProviders.disconnect("claude");
  await WhimsyAIProviders.disconnect("gemini");
  Object.assign(ENDPOINTS, savedEndpoints);
  await mock.stop();
  for (const pref of ["whimsy.ai.order", "whimsy.ai.auto-enabled", "whimsy.ai.claude.auth", "whimsy.ai.openai.auth"]) {
    Services.prefs.clearUserPref(pref);
  }
  Services.prefs.setBoolPref("whimsy.ai.enabled", true);
});

add_task(async function switched_off_provider_is_skipped() {
  const calls = stub({ claude: says("from claude"), openai: says("from openai") });
  WhimsyAIProviders.setOrder(["claude", "openai"]);
  WhimsyAIProviders.setOn("claude", false);
  ok(!WhimsyAIProviders.isOn("claude"), "Claude is switched off");
  ok(WhimsyAIProviders.isOn("openai"), "OpenAI is on");
  Assert.deepEqual(WhimsyAIProviders.order, ["claude", "openai"], "A switched-off provider keeps its place");
  Assert.deepEqual(WhimsyAIRouter.capable({}), ["openai"], "but isn't capable of anything");
  const result = await WhimsyAIRouter.run({ task: "chat", messages: [{ role: "user", content: "hi" }] });
  is(result.provider, "openai", "OpenAI answers");
  ok(calls.every(c => c.provider != "claude"), "Claude is never asked");
  is(WhimsyAIProviders.provider, "openai", "and isn't the provider tried first");
  WhimsyAIProviders.setOn("claude", true);
  ok(!Services.prefs.prefHasUserValue("whimsy.ai.off"), "Back on, nothing is left in the off list");
  WhimsyAIProviders.setTestProvider(null);
  Services.prefs.clearUserPref("whimsy.ai.order");
});

add_task(async function capabilities_plan_claude_is_text_only_no_stream() {
  const key = WhimsyAIProviders.capabilities("claude", "claude-opus-5-5");
  ok(key.images && key.streaming && key.thinking?.length == 3, "With a key, Claude takes images, streams, and thinks");
  Services.prefs.setBoolPref("whimsy.feature.ai-claude-plan", true);
  Services.prefs.setStringPref("whimsy.ai.claude.auth", "plan");
  WhimsyAIProviders._plans.claude = { ...BUILT_IN_PLANS.claude, isReady: async () => true };
  WhimsyAIProviders._claudePlanStreams = null;
  const plan = WhimsyAIProviders.capabilities("claude");
  is(plan.images, false, "The plan takes no images");
  is(plan.thinking, null, "has no thinking control");
  is(plan.streaming, false, "and doesn't stream until the probe says so");
  ok(plan.text && plan.tools, "It writes text and gets connectors");
  WhimsyAIProviders._claudePlanStreams = true;
  ok(WhimsyAIProviders.capabilities("claude").streaming, "The stream-json probe turns streaming on");
  WhimsyAIProviders._claudePlanStreams = null;
  is(WhimsyAIProviders.usageUrl("claude"), "https://claude.ai/settings/usage", "The plan's usage page");
  Services.prefs.clearUserPref("whimsy.ai.claude.auth");
  Services.prefs.clearUserPref("whimsy.feature.ai-claude-plan");
  WhimsyAIProviders._plans.claude = BUILT_IN_PLANS.claude;
  ok(WhimsyAIProviders.usageUrl("claude").startsWith("https://"), "A key has the console's usage page");
  is(WhimsyAIProviders.usageUrl("apple"), null, "On this Mac: no usage page");
  ok(WhimsyAIProviders.capabilities("apple").onDevice, "Apple runs on this Mac");
  is(WhimsyAIProviders.capabilities("apple").maxInputChars, 7000, "with a short window");
});

add_task(async function capabilities_ollama_reads_model_details() {
  let details = { capabilities: ["completion", "vision", "thinking"] };
  const mock = mockServer({ "/api/show": () => ({ body: details }) });
  Services.prefs.setStringPref("whimsy.ai.ollama.endpoint", mock.base);
  Services.prefs.setStringPref("whimsy.ai.ollama.model", "llava:7b");
  let caps = WhimsyAIProviders.capabilities("ollama");
  ok(!caps.images && caps.thinking === null, "Before its details are read: no labels");
  await WhimsyAIProviders.refreshCapabilities("ollama");
  caps = WhimsyAIProviders.capabilities("ollama");
  is(caps.images, true, "vision: takes images");
  Assert.deepEqual(caps.thinking, ["light", "normal", "deep"], "thinking: has the thinking control");
  ok(caps.onDevice, "A local server is on this Mac");
  is(mock.seen.at(-1).body.model, "llava:7b", "It asked about the picked model");
  details = { modelfile: "x" };
  await WhimsyAIProviders.refreshCapabilities("ollama");
  caps = WhimsyAIProviders.capabilities("ollama");
  ok(!caps.images && caps.thinking === null, "Details without capabilities: the labels go");
  Services.prefs.clearUserPref("whimsy.ai.ollama.endpoint");
  Services.prefs.clearUserPref("whimsy.ai.ollama.model");
  WhimsyAIProviders._ollamaDetails.clear();
  await mock.stop();
});

add_task(async function resting_persists_until_reset() {
  const until = Date.now() + 60 * 60 * 1000;
  WhimsyAIProviders.setResting("claude", { until, message: "resets at 10 PM" });
  Assert.deepEqual(WhimsyAIProviders.resting("claude"), { until, message: "resets at 10 PM" }, "Resting, in the provider's words");
  const saved = JSON.parse(Services.prefs.getStringPref("whimsy.ai.resting"));
  is(saved.claude.until, until, "kept in a pref, so it survives a restart");
  is(WhimsyAIProviders.resting("openai"), null, "Others aren't resting");

  const calls = stub({ claude: says("no"), openai: says("yes") });
  WhimsyAIProviders.setOrder(["claude", "openai"]);
  const { events, onEvent } = collect();
  const result = await WhimsyAIRouter.run({ task: "chat", messages: [{ role: "user", content: "hi" }], onEvent });
  is(result.provider, "openai", "A resting provider is passed over");
  ok(calls.every(c => c.provider != "claude"), "without being asked");
  const handoff = events.filter(e => e.type == "handoff");
  is(handoff.length, 1, "one note");
  is(handoff[0].reason + handoff[0].from + handoff[0].until, "quota" + "claude" + until, "naming when it's back");

  WhimsyAIProviders.setResting("claude", { until: Date.now() - 1, message: "old" });
  is(WhimsyAIProviders.resting("claude"), null, "Past its reset time it isn't resting");
  ok(!Services.prefs.prefHasUserValue("whimsy.ai.resting"), "and the pref is cleared");

  const now = new Date(2026, 10, 8, 18, 0).getTime();
  is(new Date(parseResetTime("Claude usage limit reached. Resets 10pm", now)).getHours(), 22, "'Resets 10pm' is read");
  is(parseResetTime("limit reached|1767225600", now), 1767225600 * 1000, "Claude Code's reset seconds are read");
  is(parseResetTime("out of room", now), null, "No time said: none guessed");
  WhimsyAIProviders.setTestProvider(null);
  Services.prefs.clearUserPref("whimsy.ai.order");
});

// ---- Task 2: the router ----

add_task(async function routes_first_enabled_capable() {
  const calls = stub({ gemini: says("gemini"), claude: says("claude") });
  WhimsyAIProviders.setOrder(["gemini", "claude"]);
  let result = await WhimsyAIRouter.run({ task: "chat", messages: [{ role: "user", content: "hi" }] });
  is(result.provider, "gemini", "The first in the order answers");
  is(result.text, "gemini", "with its text");
  Assert.deepEqual(result.tried, ["gemini"], "and only it was tried");
  Assert.deepEqual(result.handoffs, [], "no handoff");
  is(calls[0].request.thinking, "normal", "Chat thinks at Normal by default");
  result = await WhimsyAIRouter.run({ task: "chat", provider: "claude", messages: [{ role: "user", content: "hi" }] });
  is(result.provider, "claude", "A provider picked for this chat goes first");
  WhimsyAIProviders.setOrder(["apple", "claude"]);
  Assert.deepEqual(WhimsyAIRouter.capable({ images: true }), ["claude"], "capable() lists those that can, in order");
  Assert.deepEqual(WhimsyAIRouter.capable({ chars: 20000 }), ["claude"], "a long page skips Apple's short window");
  is(await WhimsyAIProviders.complete({ prompt: "hi" }), "claude", "complete() goes through the router");
  WhimsyAIProviders.setOrder([]);
  await rejectsWith(WhimsyAIRouter.run({ messages: [{ role: "user", content: "hi" }] }), "none-capable", "Nothing connected");
  WhimsyAIProviders.setTestProvider(null);
  Services.prefs.clearUserPref("whimsy.ai.order");
});

add_task(async function quick_text_goes_to_apple_first() {
  stub({ apple: says("apple"), claude: says("claude") });
  WhimsyAIProviders.setOrder(["claude", "apple"]);
  ok(WhimsyAIProviders.quickTextOnApple, "Quick text on Apple is on by default");
  let result = await WhimsyAIRouter.run({ task: "quick-text", messages: [{ role: "user", content: "fix this" }] });
  is(result.provider, "apple", "A short rewrite goes to Apple first");
  result = await WhimsyAIRouter.run({ task: "translate", messages: [{ role: "user", content: "hola" }] });
  is(result.provider, "apple", "and a translation");
  result = await WhimsyAIRouter.run({ task: "chat", messages: [{ role: "user", content: "hi" }] });
  is(result.provider, "claude", "Chat follows the order");
  WhimsyAIProviders.quickTextOnApple = false;
  result = await WhimsyAIRouter.run({ task: "quick-text", messages: [{ role: "user", content: "fix this" }] });
  is(result.provider, "claude", "Switched off, quick text follows the order too");
  WhimsyAIProviders.setOn("apple", false);
  WhimsyAIProviders.quickTextOnApple = true;
  result = await WhimsyAIRouter.run({ task: "quick-text", messages: [{ role: "user", content: "fix this" }] });
  is(result.provider, "claude", "Apple switched off is never used for quick text");
  WhimsyAIProviders.setOn("apple", true);
  WhimsyAIProviders.setTestProvider(null);
  Services.prefs.clearUserPref("whimsy.ai.quick-text-apple");
  Services.prefs.clearUserPref("whimsy.ai.order");
});

add_task(async function handoff_before_first_token_notes_once() {
  const calls = stub({
    claude: async function* () {
      const failure = new WhimsyAIError("plan-limit");
      failure.detail = "Claude usage limit reached. Resets 10pm";
      failure.until = Date.now() + 3600 * 1000;
      throw failure;
    },
    openai: async function* () {
      yield { type: "text", delta: "Hi " };
      yield { type: "text", delta: "there" };
    },
  });
  WhimsyAIProviders.setOrder(["claude", "openai"]);
  const { events, onEvent } = collect();
  const result = await WhimsyAIRouter.run({ task: "chat", messages: [{ role: "user", content: "hi" }], onEvent });
  const handoffs = events.filter(e => e.type == "handoff");
  is(handoffs.length, 1, "Exactly one handoff note");
  is(`${handoffs[0].from}>${handoffs[0].to}:${handoffs[0].reason}`, "claude>openai:quota", "Claude is out, so ChatGPT took this");
  ok(handoffs[0].until > Date.now(), "with when Claude is back");
  ok(events.indexOf(handoffs[0]) < events.findIndex(e => e.type == "text"), "The note comes before the answer");
  is(result.provider, "openai", "The second provider answered");
  is(result.text, "Hi there", "the whole answer");
  is(result.handoffs.length, 1, "The result carries the handoff");
  Assert.deepEqual(result.tried, ["claude", "openai"], "and what was tried");
  is(WhimsyAIProviders.resting("claude")?.message, "Claude usage limit reached. Resets 10pm", "Claude rests, in its own words");
  is(calls.length, 2, "Two calls in all");
  WhimsyAIProviders.clearResting("claude");
  WhimsyAIProviders.setTestProvider(null);
  Services.prefs.clearUserPref("whimsy.ai.order");
});

add_task(async function mid_stream_quota_keeps_partial_and_waits() {
  const calls = stub({
    claude: async function* () {
      yield { type: "text", delta: "Hello " };
      throw new WhimsyAIError("plan-limit");
    },
    openai: says("world"),
  });
  WhimsyAIProviders.setOrder(["claude", "openai"]);
  const { events, onEvent } = collect();
  const req = { task: "chat", messages: [{ role: "user", content: "hi" }], onEvent };
  const result = await WhimsyAIRouter.run(req);
  is(result.partial, true, "The answer is partial");
  is(result.text, "Hello ", "and what arrived is kept");
  is(result.provider, "claude", "from Claude");
  is(calls.filter(c => c.provider == "openai").length, 0, "No other provider is asked by itself");
  const mid = events.find(e => e.type == "quota-mid");
  is(mid?.provider + ">" + mid?.next, "claude>openai", "quota-mid names who could continue");
  ok(!events.some(e => e.type == "handoff"), "No automatic handoff after the first token");

  const more = await WhimsyAIRouter.continueOn(result, "openai", req);
  is(more.provider, "openai", "Continue on ChatGPT, after a press");
  is(more.text, "Hello world", "The whole answer reads on");
  const sent = calls.at(-1).request.messages;
  is(sent.at(-2).content, "Hello ", "The partial answer is passed along");
  is(sent.at(-1).content, WhimsyAIRouter.CONTINUE_PROMPT, "with the ask to continue");
  WhimsyAIProviders.clearResting("claude");
  WhimsyAIProviders.setTestProvider(null);
  Services.prefs.clearUserPref("whimsy.ai.order");
});

add_task(async function capability_fallback_on_device_to_cloud_is_named() {
  const calls = stub({ apple: says("apple"), claude: says("I see a cat") });
  WhimsyAIProviders.setOrder(["apple", "claude"]);
  const { events, onEvent } = collect();
  const image = { type: "image", mediaType: "image/png", data: "iVBORw0KGgo=" };
  const result = await WhimsyAIRouter.run({
    task: "chat",
    messages: [{ role: "user", content: [image, { type: "text", text: "What's this?" }] }],
    onEvent,
  });
  is(result.provider, "claude", "An image goes to the first provider that takes images");
  const handoff = events.find(e => e.type == "handoff");
  is(`${handoff.from}>${handoff.to}:${handoff.reason}`, "apple>claude:capability", "and the note names both");
  ok(calls.every(c => c.provider != "apple"), "Apple is never sent the image");
  events.length = 0;
  await WhimsyAIRouter.run({ task: "ask", needs: { chars: 30000 }, messages: [{ role: "user", content: "x" }], onEvent });
  is(events.find(e => e.type == "handoff")?.reason, "capability", "A long page is a capability handoff too");
  WhimsyAIProviders.setOrder(["apple"]);
  const error = await rejectsWith(
    WhimsyAIRouter.run({ needs: { images: true }, messages: [{ role: "user", content: "x" }] }),
    "none-capable",
    "Nothing that can: none-capable"
  );
  Assert.deepEqual(error.tried, ["apple"], "listing what was considered");
  WhimsyAIProviders.setTestProvider(null);
  Services.prefs.clearUserPref("whimsy.ai.order");
});

add_task(async function disabled_provider_never_handed_to() {
  const calls = stub({ claude: fails("unavailable"), openai: says("openai"), gemini: says("gemini") });
  WhimsyAIProviders.setOrder(["claude", "openai", "gemini"]);
  WhimsyAIProviders.setOn("openai", false);
  const { events, onEvent } = collect();
  const result = await WhimsyAIRouter.run({ task: "chat", messages: [{ role: "user", content: "hi" }], onEvent });
  is(result.provider, "gemini", "The next switched-on provider answers");
  ok(calls.every(c => c.provider != "openai"), "The switched-off one is never handed to");
  is(events.find(e => e.type == "handoff")?.reason, "down", "Claude being down is the reason");
  WhimsyAIProviders.setOn("openai", true);
  WhimsyAIProviders.setTestProvider(null);
  Services.prefs.clearUserPref("whimsy.ai.order");
});

add_task(async function all_fail_lists_tried() {
  stub({ claude: fails("unavailable"), openai: fails("network"), gemini: fails("bad-key") });
  WhimsyAIProviders.setOrder(["claude", "openai", "gemini"]);
  const error = await rejectsWith(
    WhimsyAIRouter.run({ task: "chat", messages: [{ role: "user", content: "hi" }] }),
    "all-failed",
    "Every provider failing is all-failed"
  );
  Assert.deepEqual(error.tried, ["claude", "openai", "gemini"], "tried lists the enabled providers in order");
  is(error.causes.gemini, "bad-key", "with what each one said");
  stub({ claude: fails("refused"), openai: says("x") });
  await rejectsWith(WhimsyAIRouter.run({ messages: [{ role: "user", content: "hi" }] }), "refused", "A refusal is never handed on");
  stub({ claude: fails("no-key") });
  WhimsyAIProviders.setOrder(["claude"]);
  await rejectsWith(WhimsyAIProviders.complete({ prompt: "x" }), "no-key", "One provider: its own error");
  WhimsyAIProviders.setTestProvider(null);
  Services.prefs.clearUserPref("whimsy.ai.order");
});

add_task(async function thinking_maps_per_provider() {
  WhimsyAIProviders.setTestProvider(null);
  const mock = mockServer({
    "/claude/messages": () =>
      sse([
        ["message_start", { type: "message_start" }],
        ["content_block_delta", { type: "content_block_delta", delta: { type: "thinking_delta", thinking: "hm" } }],
        ["content_block_delta", { type: "content_block_delta", delta: { type: "text_delta", text: "ok" } }],
        ["message_stop", { type: "message_stop" }],
      ]),
    "/openai/responses": () =>
      sse([
        ["response.reasoning_summary_text.delta", { type: "response.reasoning_summary_text.delta", delta: "hm" }],
        ["response.output_text.delta", { type: "response.output_text.delta", delta: "ok" }],
        ["response.completed", { type: "response.completed", response: { output: [] } }],
      ]),
    "/gemini/models": () => ({
      type: "text/event-stream",
      body: `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: "hm", thought: true }, { text: "ok" }] } }] })}\n\n`,
    }),
    "/ollama/api/show": () => ({ body: { capabilities: ["completion", "thinking"] } }),
    "/ollama/api/chat": () => ({
      type: "application/x-ndjson",
      body: `${JSON.stringify({ message: { thinking: "hm" }, done: false })}\n${JSON.stringify({ message: { content: "ok" }, done: true })}\n`,
    }),
  });
  Object.assign(ENDPOINTS, { claude: `${mock.base}/claude`, openai: `${mock.base}/openai`, gemini: `${mock.base}/gemini` });
  Services.prefs.setStringPref("whimsy.ai.ollama.endpoint", `${mock.base}/ollama`);
  Services.prefs.setStringPref("whimsy.ai.ollama.model", "qwen3:8b");
  Services.prefs.setStringPref("whimsy.ai.openai.model", "gpt-5-test");
  Services.prefs.setStringPref("whimsy.ai.gemini.model", "gemini-2.5-test");
  for (const provider of ["claude", "openai", "gemini"]) {
    await WhimsyAIProviders.setKey(provider, "key-" + provider + "-0002");
  }
  await WhimsyAIProviders.refreshCapabilities("ollama");

  const expected = {
    claude: { light: "low", normal: "medium", deep: "high" },
    openai: { light: "low", normal: "medium", deep: "high" },
    gemini: { light: 1024, normal: 8192, deep: 24576 },
    ollama: { light: false, normal: true, deep: true },
  };
  const read = {
    claude: body => body.output_config?.effort,
    openai: body => body.reasoning?.effort,
    gemini: body => body.generationConfig?.thinkingConfig?.thinkingBudget,
    ollama: body => body.think,
  };
  for (const provider of Object.keys(expected)) {
    WhimsyAIProviders.setOrder([provider]);
    for (const level of ["light", "normal", "deep"]) {
      const { events, onEvent } = collect();
      const result = await WhimsyAIRouter.run({ task: "chat", thinking: level, messages: [{ role: "user", content: "hi" }], onEvent });
      const body = mock.seen.findLast(s => !s.path.endsWith("/api/show")).body;
      is(read[provider](body), expected[provider][level], `${provider} ${level}`);
      is(result.text, "ok", `${provider} streams its answer`);
      ok(events.some(e => e.type == "thinking" && e.text == "hm"), `${provider} streams its thinking`);
    }
  }
  const claudeBody = mock.seen.findLast(s => s.path == "/claude/messages").body;
  ok(claudeBody.stream && claudeBody.thinking?.display == "summarized", "Claude streams with summarized thinking");
  ok(mock.seen.some(s => s.path.includes(":streamGenerateContent")), "Gemini streams");

  Object.assign(ENDPOINTS, savedEndpoints);
  for (const provider of ["claude", "openai", "gemini"]) {
    await WhimsyAIProviders.setKey(provider, "");
  }
  for (const pref of ["whimsy.ai.ollama.endpoint", "whimsy.ai.ollama.model", "whimsy.ai.openai.model", "whimsy.ai.gemini.model", "whimsy.ai.order"]) {
    Services.prefs.clearUserPref(pref);
  }
  WhimsyAIProviders._ollamaDetails.clear();
  await mock.stop();
});

add_task(async function stream_events_in_order() {
  stub({
    gemini: async function* () {
      yield { type: "thinking", text: "Let me see" };
      await new Promise(r => setTimeout(r, 20));
      yield { type: "text", delta: "One" };
      yield { type: "citation", n: 1, source: { url: "https://example.com/", title: "Example" } };
      yield { type: "text", delta: " two" };
    },
  });
  WhimsyAIProviders.setOrder(["gemini"]);
  const { events, onEvent } = collect();
  const result = await WhimsyAIRouter.run({ task: "chat", messages: [{ role: "user", content: "hi" }], onEvent });
  Assert.deepEqual(
    events.map(e => e.type),
    ["status", "thinking", "text", "citation", "text"],
    "Events arrive in the order the provider sent them"
  );
  is(result.text, "One two", "The text is the deltas joined");
  ok(result.thinkingMs >= 0, "and how long it thought is kept");

  const controller = new AbortController();
  stub({
    gemini: async function* () {
      yield { type: "text", delta: "a" };
      await new Promise(() => {});
    },
  });
  const pending = WhimsyAIRouter.run({ messages: [{ role: "user", content: "x" }], signal: controller.signal, onEvent: () => controller.abort() });
  await rejectsWith(pending, "aborted", "The caller can stop a stream");
  is(WhimsyAIProviders._inflight.size, 0, "Nothing is left in flight");
  WhimsyAIProviders.setTestProvider(null);
  Services.prefs.clearUserPref("whimsy.ai.order");
});
