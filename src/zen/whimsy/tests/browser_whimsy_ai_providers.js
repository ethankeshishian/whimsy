/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// AI provider: every Whimsy AI feature asks WhimsyAIProviders, which only
// ever uses the provider picked in Settings (no automatic cloud fallback),
// refuses everything while the AI kill switch is on, aborts requests in
// flight when it goes on, and keeps the Claude API key out of prefs.

const { WhimsyAIProviders, WhimsyAIError, ENDPOINTS } = ChromeUtils.importESModule(
  "resource:///modules/whimsy/WhimsyAIProviders.sys.mjs"
);
const { OSKeyStoreTestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/OSKeyStoreTestUtils.sys.mjs"
);

// The fakes below stand in for the real sign-ins (browser_whimsy_ai_plans.js
// drives those); both plan gates are off unless a test turns one on.
const BUILT_IN_PLANS = { ...WhimsyAIProviders._plans };
Services.prefs.setBoolPref("whimsy.feature.ai-openai-plan", false);
Services.prefs.setBoolPref("whimsy.feature.ai-claude-plan", false);

// Reading about:preferences lazily caches a default device name (from the
// hostname) the first time anything touches FxA; not this file's pref, but
// it leaks if nothing restores it.
const DEVICE_NAME_PREF = "identity.fxaccounts.account.device.name";
const deviceNameHadUserValue = Services.prefs.prefHasUserValue(DEVICE_NAME_PREF);
const deviceNameValue = deviceNameHadUserValue ? Services.prefs.getStringPref(DEVICE_NAME_PREF) : null;

registerCleanupFunction(async () => {
  WhimsyAIProviders.setTestProvider(null);
  for (const provider of ["claude", "openai", "gemini"]) {
    await WhimsyAIProviders.setKey(provider, "");
  }
  for (const pref of [
    "whimsy.ai.openai.model",
    "whimsy.ai.gemini.model",
    "whimsy.ai.claude.model",
    "whimsy.ai.openai.auth",
    "whimsy.ai.claude.auth",
    "whimsy.ai.gemini.auth",
    "whimsy.ai.plan-fallback",
    "whimsy.ai.ollama.endpoint",
    "whimsy.feature.ai-openai-plan",
    "whimsy.feature.ai-claude-plan",
    "whimsy.ai.provider",
    "whimsy.ai.order",
    "whimsy.ai.off",
    "whimsy.ai.resting",
    "whimsy.ai.auto-enabled",
    "whimsy.ai.ollama.model",
    "whimsy.feature.ai-providers",
    "whimsy.ai.test.macos-version",
  ]) {
    Services.prefs.clearUserPref(pref);
  }
  Services.prefs.setBoolPref("whimsy.ai.enabled", true);
  if (deviceNameHadUserValue) {
    Services.prefs.setStringPref(DEVICE_NAME_PREF, deviceNameValue);
  } else {
    Services.prefs.clearUserPref(DEVICE_NAME_PREF);
  }
});

async function rejectsWith(promise, code, message) {
  try {
    await promise;
    ok(false, `${message}: expected ${code}`);
  } catch (error) {
    is(error.code, code, message);
  }
}

add_task(async function test_defaults() {
  ok(Services.prefs.getBoolPref("whimsy.feature.ai-providers"), "The feature switch is on");
  is(Services.prefs.getStringPref("whimsy.ai.provider"), "apple", "On-device is the default provider");
  is(WhimsyAIProviders.provider, "apple", "and the module agrees");
  ok(!WhimsyAIProviders.isCloud, "which keeps text on the Mac");
  Services.prefs.setStringPref("whimsy.ai.provider", "nonsense");
  is(WhimsyAIProviders.provider, "apple", "An unknown provider falls back to the default, not the cloud");
  Services.prefs.clearUserPref("whimsy.ai.provider");
  is(WhimsyAIProviders.claudeModel, "claude-opus-5-5", "Claude defaults to the latest model");
});

add_task(async function test_fake_provider() {
  const seen = [];
  WhimsyAIProviders.setTestProvider(async request => {
    seen.push(request);
    return '  {"ok": true}  ';
  });
  is(WhimsyAIProviders.provider, "test", "The fake provider is in use");
  ok(await WhimsyAIProviders.isReady(), "and ready");
  is(await WhimsyAIProviders.complete({ prompt: "hi", system: "sys" }), '{"ok": true}', "Answers are trimmed");
  is(seen[0].prompt, "hi", "The prompt reaches the provider");
  is(seen[0].system, "sys", "and the system text");
  Assert.deepEqual(await WhimsyAIProviders.completeJSON({ prompt: "json" }), { ok: true }, "JSON answers parse");

  WhimsyAIProviders.setTestProvider(() => "no json here");
  await rejectsWith(WhimsyAIProviders.completeJSON({ prompt: "x" }), "bad-response", "A non-JSON answer is a bad response");
});

add_task(async function test_kill_switch() {
  let calls = 0;
  WhimsyAIProviders.setTestProvider(() => {
    calls++;
    return "answer";
  });
  Services.prefs.setBoolPref("whimsy.ai.enabled", false);
  ok(!WhimsyAIProviders.enabled, "The kill switch turns the provider off");
  ok(!(await WhimsyAIProviders.isReady()), "Nothing is ready");
  await rejectsWith(WhimsyAIProviders.complete({ prompt: "x" }), "blocked", "Requests are refused");
  is(calls, 0, "without reaching the provider");
  Services.prefs.setBoolPref("whimsy.ai.enabled", true);

  Services.prefs.setBoolPref("whimsy.feature.ai-providers", false);
  await rejectsWith(WhimsyAIProviders.complete({ prompt: "x" }), "blocked", "The feature switch off refuses too");
  Services.prefs.clearUserPref("whimsy.feature.ai-providers");
  is(await WhimsyAIProviders.complete({ prompt: "x" }), "answer", "Back on, requests work");
});

add_task(async function test_kill_switch_aborts_inflight() {
  let started;
  const begun = new Promise(r => (started = r));
  WhimsyAIProviders.setTestProvider(request => {
    started();
    // Never answers on its own: only the abort ends it.
    return new Promise((_, reject) => request.signal.addEventListener("abort", () => reject(new Error("aborted"))));
  });
  const pending = WhimsyAIProviders.complete({ prompt: "slow" });
  await begun;
  Services.prefs.setBoolPref("whimsy.ai.enabled", false);
  await rejectsWith(pending, "blocked", "Turning AI off ends a request in flight");
  Services.prefs.setBoolPref("whimsy.ai.enabled", true);

  // Turned off before the request is in flight (the connectors are still
  // being gathered), it ends too.
  const gathering = WhimsyAIProviders.complete({ prompt: "slow" });
  Services.prefs.setBoolPref("whimsy.ai.enabled", false);
  await rejectsWith(gathering, "blocked", "Turning AI off while the connectors are gathered ends the request");
  Services.prefs.setBoolPref("whimsy.ai.enabled", true);

  const controller = new AbortController();
  const cancelled = WhimsyAIProviders.complete({ prompt: "slow", signal: controller.signal });
  controller.abort();
  await rejectsWith(cancelled, "aborted", "A caller can cancel its own request");
  is(WhimsyAIProviders._inflight.size, 0, "Nothing is left in flight");
});

add_task(async function test_no_cloud_fallback() {
  WhimsyAIProviders.setTestProvider(null);
  // Claude with no key fails right away instead of trying another provider.
  Services.prefs.setStringPref("whimsy.ai.order", "claude");
  ok(WhimsyAIProviders.isCloud, "Claude is the cloud provider");
  ok(!(await WhimsyAIProviders.isReady()), "Not ready without a key");
  await rejectsWith(WhimsyAIProviders.complete({ prompt: "x" }), "no-key", "No key: an error, not a fallback");

  // Ollama with no model picked fails the same way.
  Services.prefs.setStringPref("whimsy.ai.order", "ollama");
  ok(!(await WhimsyAIProviders.isReady()), "Ollama isn't ready without a model");
  await rejectsWith(WhimsyAIProviders.complete({ prompt: "x" }), "no-model", "No model: an error, not a fallback");
  Services.prefs.clearUserPref("whimsy.ai.order");
});

add_task(async function test_claude_key_storage() {
  OSKeyStoreTestUtils.setup();
  registerCleanupFunction(() => OSKeyStoreTestUtils.cleanup());
  const secret = "sk-ant-test-0123456789";
  ok(!(await WhimsyAIProviders.hasClaudeKey()), "No key at first");
  await WhimsyAIProviders.setClaudeKey(`  ${secret}  `);
  ok(await WhimsyAIProviders.hasClaudeKey(), "The key is saved");
  is(await WhimsyAIProviders.getClaudeKey(), secret, "and reads back, trimmed");
  const file = await IOUtils.readUTF8(PathUtils.join(PathUtils.profileDir, "whimsy-ai-keys.json"));
  ok(!file.includes(secret), "The file only holds ciphertext");
  for (const name of Services.prefs.getChildList("whimsy.ai.")) {
    if (Services.prefs.getPrefType(name) == Services.prefs.PREF_STRING) {
      ok(!Services.prefs.getStringPref(name).includes(secret), `${name} doesn't hold the key`);
    }
  }
  Services.prefs.setStringPref("whimsy.ai.order", "claude");
  ok(await WhimsyAIProviders.isReady(), "Claude is ready with a key");
  Services.prefs.clearUserPref("whimsy.ai.order");
  await WhimsyAIProviders.setClaudeKey("");
  ok(!(await WhimsyAIProviders.hasClaudeKey()), "Removing the key forgets it");
});

// W14 19: each provider's key is its own field; saving one keeps the others
// (setClaudeKey used to rewrite the whole file).
add_task(async function test_keys_kept_per_provider() {
  OSKeyStoreTestUtils.setup();
  registerCleanupFunction(() => OSKeyStoreTestUtils.cleanup());
  const claude = "sk-" + "ant-test-" + "1111";
  const gemini = "AIza" + "TestKey" + "2222";
  const openai = "sk-" + "proj-test-" + "3333";
  await WhimsyAIProviders.setKey("claude", claude);
  await WhimsyAIProviders.setKey("gemini", gemini);
  await WhimsyAIProviders.setKey("openai", openai);
  is(await WhimsyAIProviders.getKey("claude"), claude, "Saving the Gemini and OpenAI keys keeps Claude's");
  is(await WhimsyAIProviders.getKey("gemini"), gemini, "Gemini's reads back");
  is(await WhimsyAIProviders.getKey("openai"), openai, "OpenAI's reads back");
  const file = await IOUtils.readUTF8(PathUtils.join(PathUtils.profileDir, "whimsy-ai-keys.json"));
  ok(![claude, gemini, openai].some(k => file.includes(k)), "The file only holds ciphertext");
  await WhimsyAIProviders.setKey("gemini", "");
  ok(!(await WhimsyAIProviders.hasKey("gemini")), "Removing Gemini's key forgets it");
  is(await WhimsyAIProviders.getKey("claude"), claude, "and leaves Claude's");
  ok(await WhimsyAIProviders.hasKey("openai"), "and OpenAI's");
  await WhimsyAIProviders.setKey("claude", "");
  await WhimsyAIProviders.setKey("openai", "");
  ok(!(await IOUtils.exists(PathUtils.join(PathUtils.profileDir, "whimsy-ai-keys.json"))), "No keys, no file");
});

// W14 19: OpenAI (Responses API) and Gemini (generateContent) with API keys,
// against a local stand-in for each service.
add_task(async function test_openai_and_gemini_requests() {
  OSKeyStoreTestUtils.setup();
  registerCleanupFunction(() => OSKeyStoreTestUtils.cleanup());
  const { HttpServer } = ChromeUtils.importESModule("resource://testing-common/httpd.sys.mjs");
  const { NetUtil: Net } = ChromeUtils.importESModule("resource://gre/modules/NetUtil.sys.mjs");
  const server = new HttpServer();
  server.start(-1);
  const base = `http://localhost:${server.identity.primaryPort}`;
  const saved = { ...ENDPOINTS };
  ENDPOINTS.openai = `${base}/openai`;
  ENDPOINTS.gemini = `${base}/gemini`;
  const seen = [];
  let status = 200;
  let reply = {};
  const handler = (request, response) => {
    let body = {};
    try {
      const stream = request.bodyInputStream;
      body = JSON.parse(Net.readInputStreamToString(stream, stream.available()) || "{}");
    } catch {}
    seen.push({
      path: request.path,
      query: request.queryString,
      auth: request.hasHeader("authorization") ? request.getHeader("authorization") : "",
      goog: request.hasHeader("x-goog-api-key") ? request.getHeader("x-goog-api-key") : "",
      cookie: request.hasHeader("cookie"),
      body,
    });
    response.setStatusLine(request.httpVersion, status, "x");
    response.setHeader("content-type", "application/json");
    response.write(JSON.stringify(reply));
  };
  server.registerPrefixHandler("/openai/", handler);
  server.registerPrefixHandler("/gemini/", handler);
  registerCleanupFunction(async () => {
    Object.assign(ENDPOINTS, saved);
    await new Promise(r => server.stop(r));
  });
  const openaiKey = "sk-" + "proj-" + "abcd";
  const geminiKey = "AIza" + "Sy" + "efgh";
  await WhimsyAIProviders.setKey("openai", openaiKey);
  await WhimsyAIProviders.setKey("gemini", geminiKey);

  Services.prefs.setStringPref("whimsy.ai.order", "openai");
  ok(WhimsyAIProviders.isCloud, "OpenAI sends text off the Mac, so private tabs stay out");
  await rejectsWith(WhimsyAIProviders.complete({ prompt: "x" }), "no-model", "No model picked: an error");
  Services.prefs.setStringPref("whimsy.ai.openai.model", "gpt-test");
  ok(await WhimsyAIProviders.isReady(), "Ready with a key");
  reply = { output: [{ type: "message", content: [{ type: "output_text", text: "Hello " }, { type: "output_text", text: "there" }] }] };
  is(await WhimsyAIProviders.complete({ prompt: "Say hi", system: "Be brief" }), "Hello there", "OpenAI's answer");
  let last = seen.at(-1);
  is(last.path, "/openai/responses", "The Responses API");
  is(last.auth, `Bearer ${openaiKey}`, "with the key as a bearer token");
  is(last.body.model, "gpt-test", "the picked model");
  is(last.body.store, false, "nothing stored on OpenAI's side");
  is(last.body.instructions, "Be brief", "the system prompt as instructions");
  is(last.body.input, "Say hi", "and the prompt");
  ok(!last.cookie, "No cookies");
  reply = { output: [{ type: "message", content: [{ type: "refusal", refusal: "no" }] }] };
  await rejectsWith(WhimsyAIProviders.complete({ prompt: "x" }), "refused", "A refusal");
  status = 401;
  await rejectsWith(WhimsyAIProviders.complete({ prompt: "x" }), "bad-key", "401: a bad key");
  status = 429;
  await rejectsWith(WhimsyAIProviders.complete({ prompt: "x" }), "rate-limited", "429: rate limited");
  ok(WhimsyAIProviders.resting("openai"), "and OpenAI rests a while");
  WhimsyAIProviders.clearResting("openai");
  status = 200;
  reply = { data: [{ id: "gpt-a" }, { id: "gpt-b" }] };
  Assert.deepEqual(await WhimsyAIProviders.listModels("openai"), ["gpt-a", "gpt-b"], "OpenAI's models");

  Services.prefs.setStringPref("whimsy.ai.order", "gemini");
  ok(WhimsyAIProviders.isCloud, "Gemini sends text off the Mac too");
  Services.prefs.setStringPref("whimsy.ai.gemini.model", "gemini-test");
  reply = { candidates: [{ finishReason: "STOP", content: { parts: [{ text: "Hi " }, { text: "you" }] } }] };
  is(await WhimsyAIProviders.complete({ prompt: "Say hi", system: "Be brief" }), "Hi you", "Gemini's answer");
  last = seen.at(-1);
  is(last.path, "/gemini/models/gemini-test:streamGenerateContent", "streamGenerateContent for the picked model");
  is(last.goog, geminiKey, "the key in its header");
  ok(!last.query.includes(geminiKey), "never in the address");
  is(last.body.systemInstruction.parts[0].text, "Be brief", "the system prompt");
  is(last.body.contents[0].parts[0].text, "Say hi", "and the prompt");
  reply = { candidates: [{ finishReason: "SAFETY" }] };
  await rejectsWith(WhimsyAIProviders.complete({ prompt: "x" }), "refused", "Blocked for safety: refused");
  status = 400;
  reply = { error: { status: "INVALID_ARGUMENT", details: [{ reason: "API_KEY_INVALID" }] } };
  await rejectsWith(WhimsyAIProviders.complete({ prompt: "x" }), "bad-key", "API_KEY_INVALID: a bad key");
  status = 200;
  reply = { models: [
    { name: "models/gemini-a", supportedGenerationMethods: ["generateContent"] },
    { name: "models/embed", supportedGenerationMethods: ["embedContent"] },
  ] };
  Assert.deepEqual(await WhimsyAIProviders.listModels("gemini"), ["gemini-a"], "Gemini's models that write text");

  Services.prefs.clearUserPref("whimsy.ai.order");
  Services.prefs.clearUserPref("whimsy.ai.openai.model");
  Services.prefs.clearUserPref("whimsy.ai.gemini.model");
  await WhimsyAIProviders.setKey("openai", "");
  await WhimsyAIProviders.setKey("gemini", "");
});

// W14 19 (v2): connect a provider once (the key is checked by listing its
// models, the first becomes the model), disconnect it, the plan seam that
// L7b fills, and the opt-in "use the next one" when a plan runs out.
add_task(async function test_accounts() {
  OSKeyStoreTestUtils.setup();
  registerCleanupFunction(() => OSKeyStoreTestUtils.cleanup());
  const { HttpServer } = ChromeUtils.importESModule("resource://testing-common/httpd.sys.mjs");
  const server = new HttpServer();
  server.start(-1);
  const base = `http://localhost:${server.identity.primaryPort}`;
  const saved = { ...ENDPOINTS };
  Object.assign(ENDPOINTS, { claude: `${base}/claude`, openai: `${base}/openai`, gemini: `${base}/gemini` });
  const replies = {
    claude: { data: [{ id: "claude-newest" }, { id: "claude-older" }, { id: "claude-embed-x" }] },
    openai: { data: [{ id: "gpt-old", created: 1 }, { id: "gpt-new", created: 9 }, { id: "text-embedding-z", created: 20 }] },
    gemini: { models: [{ name: "models/gemini-first", supportedGenerationMethods: ["generateContent"] }] },
  };
  const answers = { gemini: { candidates: [{ finishReason: "STOP", content: { parts: [{ text: "from gemini" }] } }] } };
  let rejectKey = false;
  const calls = [];
  for (const provider of ["claude", "openai", "gemini"]) {
    server.registerPrefixHandler(`/${provider}/`, (request, response) => {
      calls.push(request.path);
      const listing = request.path.endsWith("/models");
      response.setStatusLine(request.httpVersion, rejectKey ? 401 : 200, "x");
      response.setHeader("content-type", "application/json");
      response.write(JSON.stringify(listing ? replies[provider] : answers[provider] || {}));
    });
  }
  registerCleanupFunction(async () => {
    Object.assign(ENDPOINTS, saved);
    await new Promise(r => server.stop(r));
  });
  const keyFor = name => "key-" + name + "-1234";

  is(await WhimsyAIProviders.connection("openai"), null, "Nothing is connected to start with");
  rejectKey = true;
  await rejectsWith(WhimsyAIProviders.connectKey("openai", keyFor("openai")), "bad-key", "A key the service turns down");
  ok(!(await WhimsyAIProviders.hasKey("openai")), "isn't saved");
  rejectKey = false;
  await rejectsWith(WhimsyAIProviders.connectKey("openai", "  "), "no-key", "An empty key");

  await WhimsyAIProviders.connectKey("openai", keyFor("openai"));
  is(WhimsyAIProviders.modelOf("openai"), "gpt-new", "The default model is the newest the key lists, text models only");
  Assert.deepEqual(await WhimsyAIProviders.models("openai"), ["gpt-new", "gpt-old"], "The picker lists text models, newest first");
  is((await WhimsyAIProviders.connection("openai")).method, "key", "OpenAI is connected with a key");
  is(await WhimsyAIProviders.keyHint("openai"), "1234", "Settings tells keys apart by their last four");
  WhimsyAIProviders.setModel("openai", "gpt-old");
  await WhimsyAIProviders.connectKey("openai", keyFor("openai"));
  is(WhimsyAIProviders.modelOf("openai"), "gpt-old", "Connecting again keeps the model the person picked");
  await WhimsyAIProviders.connectKey("claude", keyFor("claude"));
  is((await WhimsyAIProviders.connection("claude")).method, "key", "Claude too");
  is(WhimsyAIProviders.modelOf("claude"), WhimsyAIProviders.claudeModel, "Claude keeps its model pref");
  await WhimsyAIProviders.connectKey("gemini", keyFor("gemini"));
  is(WhimsyAIProviders.modelOf("gemini"), "gemini-first", "Gemini's first model");
  Assert.deepEqual(await WhimsyAIProviders.connectedProviders(), ["claude", "openai", "gemini"], "Connected, in the list's order");
  Assert.deepEqual(WhimsyAIProviders.order, ["openai", "claude", "gemini"], "and in the order they connected");

  // The plan seam: not offered until its gate is on and a sign-in is registered.
  ok(!WhimsyAIProviders.planAvailable("openai"), "No plan sign-in yet");
  await rejectsWith(WhimsyAIProviders.connectPlan(window, "openai"), "unavailable", "so it can't be connected");
  let signedOut = 0;
  let planError = new WhimsyAIError("plan-limit");
  WhimsyAIProviders.registerPlan("openai", {
    connect: async () => ({}),
    disconnect: async () => signedOut++,
    status: async () => ({ connected: true, label: "me@example.com" }),
    isReady: async () => true,
    models: async () => ["gpt-plan"],
    complete: async () => {
      throw planError;
    },
  });
  ok(!WhimsyAIProviders.planAvailable("openai"), "A registered sign-in still waits for its feature gate");
  Services.prefs.setBoolPref("whimsy.feature.ai-openai-plan", true);
  ok(WhimsyAIProviders.planAvailable("openai"), "Gate on: the plan is offered");
  ok(!WhimsyAIProviders.planInUse, "Connected with a key: no plan label");
  await WhimsyAIProviders.connectPlan(window, "openai");
  is(WhimsyAIProviders.planInUse, "openai", "Connected through the plan: 'Using ChatGPT plan'");
  const connection = await WhimsyAIProviders.connection("openai");
  is(connection.method + connection.label, "planme@example.com", "with the account");
  Assert.deepEqual(await WhimsyAIProviders.models("openai"), ["gpt-plan"], "and the plan's models");

  // W23: a spent plan hands this request to the next provider in the order,
  // and it rests until it's back; a provider switched off is skipped.
  WhimsyAIProviders.setOrder(["openai", "claude", "gemini"]);
  WhimsyAIProviders.setOn("claude", false);
  calls.length = 0;
  Services.prefs.setStringPref("whimsy.ai.gemini.model", "gemini-first");
  is(await WhimsyAIProviders.complete({ prompt: "x" }), "from gemini", "Out of room: the next switched-on provider answers");
  ok(calls.some(c => c.includes("streamGenerateContent")), "Gemini answered");
  ok(!calls.some(c => c.includes("/claude/messages")), "Claude, switched off, was never asked");
  ok(WhimsyAIProviders.resting("openai"), "ChatGPT rests");
  WhimsyAIProviders.clearResting("openai");
  WhimsyAIProviders.setOn("claude", true);
  planError = new WhimsyAIError("bad-key");
  WhimsyAIProviders.setOrder(["openai"]);
  await rejectsWith(WhimsyAIProviders.complete({ prompt: "x" }), "bad-key", "With nothing else on, its own error");
  WhimsyAIProviders.setOrder(["openai", "claude", "gemini"]);

  // Disconnecting signs a plan out; a key is deleted and its model forgotten.
  await WhimsyAIProviders.disconnect("openai");
  is(signedOut, 1, "The plan's sign-in is told to sign out (revoke)");
  ok(!WhimsyAIProviders.planInUse, "No plan in use after");
  is(await WhimsyAIProviders.connection("openai"), null, "OpenAI isn't connected");
  await WhimsyAIProviders.disconnect("gemini");
  ok(!(await WhimsyAIProviders.hasKey("gemini")), "Gemini's key is gone");
  is(WhimsyAIProviders.modelOf("gemini"), "", "and its model");
  Assert.deepEqual(WhimsyAIProviders.order, ["claude"], "Disconnected providers leave the order");
  ok((await WhimsyAIProviders.hasKey("claude")), "Another provider's key is untouched");

  WhimsyAIProviders.registerPlan("openai", BUILT_IN_PLANS.openai);
  Services.prefs.setBoolPref("whimsy.feature.ai-openai-plan", false);
  for (const pref of ["whimsy.ai.provider", "whimsy.ai.openai.auth", "whimsy.ai.gemini.model", "whimsy.ai.claude.model"]) {
    Services.prefs.clearUserPref(pref);
  }
  await WhimsyAIProviders.disconnect("claude");
  Object.assign(ENDPOINTS, saved);
});

add_task(async function test_plan_limit_toast() {
  Services.prefs.setStringPref("whimsy.ai.provider", "openai");
  WhimsyAIProviders.showError(window, new WhimsyAIError("plan-limit"));
  const toasts = () => [...(document.getElementById("zen-toast-container")?.children ?? [])];
  const toast = await TestUtils.waitForCondition(
    () => toasts().find(t => t._messageId == "whimsy-ai-error-plan-limit"),
    "A spent plan gets a toast"
  );
  const buttons = [...toast.querySelectorAll(".whimsy-toast-button")];
  is(buttons.length, 1, "One action");
  is(buttons[0].querySelector(".whimsy-toast-button-label").getAttribute("data-l10n-id"), "whimsy-ai-manage-usage", "Manage usage");
  const original = window.openPreferences;
  let pane = null;
  window.openPreferences = value => (pane = value);
  try {
    await TestUtils.waitForCondition(() => buttons[0].checkVisibility() && buttons[0].textContent.trim(), "The button shows");
    let top = -1;
    await TestUtils.waitForCondition(async () => {
      await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
      const now = buttons[0].getBoundingClientRect().top;
      const settled = now == top;
      top = now;
      return settled;
    }, "The toast stops moving");
    EventUtils.synthesizeMouseAtCenter(buttons[0], {}, window);
  } finally {
    window.openPreferences = original;
  }
  is(pane, "paneWhimsyAI", "which opens Settings → AI");
  Services.prefs.clearUserPref("whimsy.ai.provider");
});

add_task(async function test_error_toasts() {
  for (const code of ["no-key", "blocked", "something-new", "signed-out"]) {
    WhimsyAIProviders.showError(window, new WhimsyAIError(code));
  }
  const toasts = () => [...(document.getElementById("zen-toast-container")?.children ?? [])].map(t => t._messageId);
  await TestUtils.waitForCondition(() => toasts().includes("whimsy-ai-error-no-key"), "A missing key says so");
  ok(toasts().includes("whimsy-ai-error-failed"), "An unknown error gets the general message");
  ok(toasts().includes("whimsy-ai-error-signed-out"), "A plan that signed you out says so");
  const before = toasts().length;
  WhimsyAIProviders.showError(window, new WhimsyAIError("aborted"));
  is(toasts().length, before, "A cancelled request shows nothing");
});

// W23: Settings → AI is one page. Providers only show once connected, so
// the five choices live in the "add a provider" sheet; each connected row
// has its own switch, a details chevron and, there, Disconnect.
add_task(async function test_settings_card() {
  OSKeyStoreTestUtils.setup();
  registerCleanupFunction(() => OSKeyStoreTestUtils.cleanup());
  const { HttpServer } = ChromeUtils.importESModule("resource://testing-common/httpd.sys.mjs");
  const server = new HttpServer();
  server.start(-1);
  const saved = { ...ENDPOINTS };
  ENDPOINTS.gemini = `http://localhost:${server.identity.primaryPort}/gemini`;
  let reject = true;
  server.registerPrefixHandler("/gemini/", (request, response) => {
    response.setStatusLine(request.httpVersion, reject ? 400 : 200, "x");
    response.setHeader("content-type", "application/json");
    response.write(JSON.stringify({ models: [{ name: "models/gemini-first", supportedGenerationMethods: ["generateContent"] }, { name: "models/gemini-second", supportedGenerationMethods: ["generateContent"] }] }));
  });
  registerCleanupFunction(async () => {
    Object.assign(ENDPOINTS, saved);
    await new Promise(r => server.stop(r));
  });
  Services.prefs.setStringPref("whimsy.ai.order", "");

  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, "about:preferences#whimsyAI");
  const doc = gBrowser.selectedBrowser.contentDocument;
  const win = gBrowser.selectedBrowser.contentWindow;
  const $ = id => doc.getElementById(id);
  await TestUtils.waitForCondition(() => win.WhimsyAISettings?.root, "Settings › AI is built");
  const S = win.WhimsyAISettings;
  const click = node => EventUtils.synthesizeMouseAtCenter(node, {}, win);
  const settled = async () => {
    const running = doc.getAnimations().filter(a => a.playState == "running" && a.effect?.getComputedTiming().iterations != Infinity);
    await Promise.all(running.map(a => a.finished.catch(() => {})));
  };
  const sheetFor = id => TestUtils.waitForCondition(() => {
    const node = $("whimsyAISheet");
    return node?.dataset.sheet == id && node.checkVisibility() && node;
  }, `The ${id} sheet opens`);
  const row = provider => doc.querySelector(`#whimsyAIProviderList .whimsy-ai-item[data-provider="${provider}"]`);

  const addButton = await TestUtils.waitForCondition(() => $("whimsyAISetUp") ?? $("whimsyAIAddProvider"), "Add a provider is offered");
  click(addButton);
  const add = await sheetFor("add-provider");
  // The four non-Apple choices paint right away; Apple's needs an async
  // eligibility check (W24 uipolish #1), so wait for all five rather than
  // just the first choice to exist.
  await TestUtils.waitForCondition(() => add.querySelectorAll(".whimsy-ai-choice").length == 5, "the choices are populated, Apple included once its check resolves");
  await settled();
  // Five providers, in order, each a packaged SVG.
  const choices = [...add.querySelectorAll(".whimsy-ai-choice")];
  Assert.deepEqual(choices.map(c => c.dataset.provider), ["apple", "claude", "openai", "gemini", "ollama"], "Five providers, in order");
  for (const [provider, file] of [
    ["apple", "whimsy/ai/apple-intelligence.svg"],
    ["claude", "whimsy/icons/claude.svg"],
    ["openai", "whimsy/icons/openai.svg"],
    ["gemini", "whimsy/icons/gemini.svg"],
    ["ollama", "whimsy/ai/ollama.svg"],
  ]) {
    const img = add.querySelector(`.whimsy-ai-choice[data-provider="${provider}"] .whimsy-ai-tile img`);
    is(img?.getAttribute("src"), `chrome://browser/content/${file}`, `${provider}: its logo`);
    is(img?.getAttribute("alt"), "", "…decorative");
    await TestUtils.waitForCondition(() => img.complete && img.naturalWidth > 0, `${provider}: the logo loads`);
    ok(img.closest(".whimsy-ai-tile").getAttribute("aria-hidden") == "true", "…in a hidden tile");
  }
  ok(!doc.querySelector("#whimsyAIProviderList select, #whimsyAIProviderList menulist, #whimsyAIProviderList input[type=radio]"), "No native lists or radios");

  // Connect Gemini: the free-tier note shows before the key is saved.
  click(add.querySelector('.whimsy-ai-choice[data-provider="gemini"]'));
  const gemini = await sheetFor("gemini");
  await TestUtils.waitForCondition(() => $("whimsyAIKeyField")?.checkVisibility(), "The connect sheet opens");
  is(gemini.querySelector(".whimsy-ai-sheet-head .whimsy-ai-tile img")?.getAttribute("src"), "chrome://browser/content/whimsy/icons/gemini.svg", "the sheet shows Gemini's logo");
  const warn = gemini.querySelector('[data-l10n-id="whimsy-ai-key-gemini-free"]');
  ok(warn?.checkVisibility(), "Gemini's free-tier note shows before any key is saved");
  const sheetRect = gemini.getBoundingClientRect();
  ok(sheetRect.width > 300 && sheetRect.left >= 0 && sheetRect.right <= win.innerWidth, "and isn't clipped");
  is(doc.activeElement, $("whimsyAIKeyField"), "The key field has focus");
  EventUtils.synthesizeKey("KEY_Tab", { shiftKey: true }, win);
  EventUtils.synthesizeKey("KEY_Tab", {}, win);
  is(doc.activeElement, $("whimsyAIKeyField"), "Tab stays inside the sheet");
  EventUtils.sendString("wrong-key-0000", win);
  EventUtils.synthesizeKey("KEY_Enter", {}, win);
  await TestUtils.waitForCondition(() => $("whimsyAIKeyError")?.checkVisibility() && $("whimsyAIKeyError").getAttribute("data-l10n-id") == "whimsy-ai-key-rejected-gemini", "A key Google turns down says so");
  ok($("whimsyAISheet"), "and the sheet stays open");
  ok(!(await WhimsyAIProviders.hasKey("gemini")), "nothing saved");
  reject = false;
  click($("whimsyAIKeyConnect"));
  await TestUtils.waitForCondition(() => !S.sheet, "A good key closes the sheet");
  await TestUtils.waitForCondition(() => row("gemini"), "Gemini is listed, connected");
  is(WhimsyAIProviders.modelOf("gemini"), "gemini-first", "The default model is the first one listed");

  // The model picker, in the row's details.
  click(row("gemini").querySelector('[data-action="details"]'));
  let body = await TestUtils.waitForCondition(() => row("gemini").nextElementSibling?.classList.contains("whimsy-ai-body") && row("gemini").nextElementSibling, "Details open");
  await settled();
  click(body.querySelector('[data-action="model"]'));
  await TestUtils.waitForCondition(() => doc.querySelectorAll("#whimsyAIModelMenu [role=option]").length == 3, "The models are listed");
  click([...doc.querySelectorAll("#whimsyAIModelMenu [role=option]")].find(o => o.dataset.value == "gemini-second"));
  await TestUtils.waitForCondition(() => WhimsyAIProviders.modelOf("gemini") == "gemini-second", "Clicking a model saves it");

  // Disconnect asks first: Cancel has focus, Escape cancels.
  click(body.querySelector('[data-action="disconnect"]'));
  let confirm = await TestUtils.waitForCondition(() => row("gemini").nextElementSibling?.classList.contains("whimsy-ai-confirm") && row("gemini").nextElementSibling, "Disconnect asks first");
  is(confirm.querySelector("b").getAttribute("data-l10n-args"), JSON.stringify({ provider: "Gemini" }), "naming the provider");
  await settled();
  is(doc.activeElement, confirm.querySelector("[data-action=cancel]"), "Cancel has focus");
  EventUtils.synthesizeKey("KEY_Escape", {}, win);
  ok(!confirm.isConnected, "Escape cancels");
  ok(await WhimsyAIProviders.hasKey("gemini"), "and nothing was removed");
  click(row("gemini").querySelector('[data-action="details"]'));
  body = await TestUtils.waitForCondition(() => row("gemini").nextElementSibling?.classList.contains("whimsy-ai-body") && row("gemini").nextElementSibling, "asks again, once reopened");
  await settled();
  click(body.querySelector('[data-action="disconnect"]'));
  confirm = await TestUtils.waitForCondition(() => row("gemini").nextElementSibling?.classList.contains("whimsy-ai-confirm") && row("gemini").nextElementSibling, "and again");
  await settled();
  click(confirm.querySelector("[data-action=confirm]"));
  await TestUtils.waitForCondition(() => !row("gemini"), "Disconnect removes it");
  ok(!(await WhimsyAIProviders.hasKey("gemini")), "the key is gone");

  // A plan isn't faked: with no sign-in registered and its gate off, the
  // segmented choice doesn't even show, only the API key.
  click($("whimsyAISetUp") ?? $("whimsyAIAddProvider"));
  const add2 = await sheetFor("add-provider");
  await TestUtils.waitForCondition(() => add2.querySelector(".whimsy-ai-choice"), "the choices are populated");
  await settled();
  click(add2.querySelector('.whimsy-ai-choice[data-provider="openai"]'));
  const openai = await sheetFor("openai");
  ok(!openai.querySelector(".whimsy-ai-seg"), "No plan sign-in offered");
  ok($("whimsyAIKeyField")?.checkVisibility(), "the API key field shows directly");
  EventUtils.synthesizeKey("KEY_Escape", {}, win);
  await TestUtils.waitForCondition(() => !S.sheet, "Escape closes it");

  // Ollama no longer uses a native list: the server field sits in the sheet.
  click($("whimsyAISetUp") ?? $("whimsyAIAddProvider"));
  const add3 = await sheetFor("add-provider");
  await TestUtils.waitForCondition(() => add3.querySelector(".whimsy-ai-choice"), "the choices are populated");
  await settled();
  click(add3.querySelector('.whimsy-ai-choice[data-provider="ollama"]'));
  await sheetFor("ollama");
  await TestUtils.waitForCondition(() => $("whimsyAIOllamaAddress")?.checkVisibility(), "Ollama's server field shows in the sheet");
  EventUtils.synthesizeKey("KEY_Escape", {}, win);
  await TestUtils.waitForCondition(() => !S.sheet, "Escape closes the sheet");

  // AI off folds the whole page to the one card.
  Services.prefs.setBoolPref("whimsy.ai.enabled", false);
  await TestUtils.waitForCondition(() => $("whimsyAIOffCard")?.checkVisibility() && !$("whimsyAIOn")?.checkVisibility(), "Turning AI off folds the page to the card");
  Services.prefs.setBoolPref("whimsy.ai.enabled", true);
  await TestUtils.waitForCondition(() => $("whimsyAIOn")?.checkVisibility(), "and back");

  Services.prefs.clearUserPref("whimsy.ai.gemini.model");
  Services.prefs.clearUserPref("whimsy.ai.order");
  BrowserTestUtils.removeTab(tab);
});

add_task(async function test_settings_actions_and_plan_rows() {
  Services.prefs.setStringPref("whimsy.ai.order", "");
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, "about:preferences#whimsyAI");
  const doc = gBrowser.selectedBrowser.contentDocument;
  const win = gBrowser.selectedBrowser.contentWindow;
  const $ = id => doc.getElementById(id);
  await TestUtils.waitForCondition(() => win.WhimsyAISettings?.root, "Settings → AI shows");
  const S = win.WhimsyAISettings;
  const click = node => EventUtils.synthesizeMouseAtCenter(node, {}, win);
  const settled = async () => {
    const running = doc.getAnimations().filter(a => a.playState == "running" && a.effect?.getComputedTiming().iterations != Infinity);
    await Promise.all(running.map(a => a.finished.catch(() => {})));
  };
  const sheetFor = id => TestUtils.waitForCondition(() => {
    const node = $("whimsyAISheet");
    return node?.dataset.sheet == id && node.checkVisibility() && node;
  }, `The ${id} sheet opens`);
  const rowOf = provider => doc.querySelector(`#whimsyAIProviderList .whimsy-ai-item[data-provider="${provider}"]`);
  ok(!$("whimsyAIPlanFallback"), "No 'use the next one' setting: the order decides");

  // Connect a provider: the sheet lists every provider not yet connected.
  WhimsyAIProviders.openSettings(null, "add-provider");
  const add = await sheetFor("add-provider");
  // Same wait as above: Apple's choice lands after an async check.
  await TestUtils.waitForCondition(() => add.querySelectorAll(".whimsy-ai-choice").length == 5, "the choices are populated, Apple included once its check resolves");
  await settled();
  Assert.deepEqual([...add.querySelectorAll(".whimsy-ai-choice:not([aria-disabled])")].map(c => c.dataset.provider), ["apple", "claude", "openai", "gemini", "ollama"], "all of them, nothing connected yet");
  click(add.querySelector('.whimsy-ai-choice[data-provider="openai"]'));
  await sheetFor("openai");
  is($("whimsyAISheetTitle").getAttribute("data-l10n-args"), JSON.stringify({ provider: "ChatGPT" }), "ChatGPT");
  EventUtils.synthesizeKey("KEY_Escape", {}, win);
  await TestUtils.waitForCondition(() => !S.sheet, "Escape closes it");

  // A registered plan with its gate on: the row shows the plan, and its
  // details' Disconnect revokes it.
  WhimsyAIProviders.registerPlan("openai", {
    connect: async () => ({}),
    disconnect: async () => {},
    status: async () => ({ connected: true, label: "me@example.com" }),
    isReady: async () => true,
    models: async () => ["m"],
    complete: async () => "x",
    manageUsage: () => {},
  });
  Services.prefs.setBoolPref("whimsy.feature.ai-openai-plan", true);
  await WhimsyAIProviders.connectPlan(window, "openai");
  await TestUtils.waitForCondition(() => rowOf("openai")?.querySelector(".whimsy-ai-item-detail")?.getAttribute("data-l10n-id") == "whimsy-ai-row-plan-openai", "Settings says the ChatGPT plan, in the row");
  click(rowOf("openai").querySelector('[data-action="details"]'));
  const body = await TestUtils.waitForCondition(() => rowOf("openai").nextElementSibling?.classList.contains("whimsy-ai-body") && rowOf("openai").nextElementSibling, "and the account, in the details");
  ok(body.textContent.includes("me@example.com"), "with the signed-in account");
  await settled();
  click(body.querySelector('[data-action="disconnect"]'));
  const confirm = await TestUtils.waitForCondition(() => rowOf("openai").nextElementSibling?.classList.contains("whimsy-ai-confirm") && rowOf("openai").nextElementSibling, "Disconnecting a plan asks first");
  ok(confirm.textContent.includes("revokes"), "and says the token is revoked");
  await settled();
  click(confirm.querySelector("[data-action=confirm]"));
  await TestUtils.waitForCondition(() => !rowOf("openai"), "The row goes with the plan");

  WhimsyAIProviders.registerPlan("openai", BUILT_IN_PLANS.openai);
  Services.prefs.setBoolPref("whimsy.feature.ai-openai-plan", false);
  Services.prefs.clearUserPref("whimsy.ai.order");
  BrowserTestUtils.removeTab(tab);
});

add_task(async function test_plan_label_in_composer() {
  const { WhimsyAIPage } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyAIPage.sys.mjs");
  const findbar = await gBrowser.getFindBar();
  findbar.open();
  registerCleanupFunction(() => findbar.close());
  const panel = () => document.getElementById("whimsy-ask-panel");
  WhimsyAIPage.showAnswer(window, findbar, { question: "q", answer: "a" });
  // The find card always names the provider ("Using …"); only a plan adds its label.
  ok(!panel().querySelector('.whimsy-ask-plan [data-l10n-id="whimsy-ai-plan-using"], .whimsy-ask-manage'), "On a key or locally: no plan label");
  let managed = 0;
  WhimsyAIProviders.registerPlan("openai", {
    connect: async () => ({}),
    disconnect: async () => {},
    status: async () => ({ connected: true, label: "me" }),
    isReady: async () => true,
    models: async () => ["m"],
    complete: async () => "x",
    manageUsage: () => managed++,
  });
  Services.prefs.setBoolPref("whimsy.feature.ai-openai-plan", true);
  Services.prefs.setStringPref("whimsy.ai.provider", "openai");
  await WhimsyAIProviders.connectPlan(window, "openai");
  WhimsyAIPage.showAnswer(window, findbar, { question: "q", answer: "a" });
  const footer = panel().querySelector(".whimsy-ask-plan");
  ok(footer, "On a plan: the footer shows");
  is(footer.querySelector("span").getAttribute("data-l10n-id"), "whimsy-ai-plan-using", "Using ChatGPT plan");
  is(footer.querySelector("span").getAttribute("data-l10n-args"), JSON.stringify({ provider: "ChatGPT" }), "naming ChatGPT");
  await TestUtils.waitForCondition(() => panel().state == "open", "The composer is open");
  const manage = footer.querySelector("button");
  await TestUtils.waitForCondition(() => manage.textContent.trim(), "Its button says Manage usage");
  EventUtils.synthesizeMouseAtCenter(manage, {}, window);
  is(managed, 1, "Manage usage goes to the plan's own page");
  panel().hidePopup();
  await WhimsyAIProviders.disconnect("openai");
  WhimsyAIProviders.registerPlan("openai", BUILT_IN_PLANS.openai);
  Services.prefs.setBoolPref("whimsy.feature.ai-openai-plan", false);
  for (const pref of ["whimsy.ai.provider", "whimsy.ai.openai.auth"]) {
    Services.prefs.clearUserPref(pref);
  }
});

add_task(async function test_commands() {
  const { WhimsyCommands } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyCommands.sys.mjs");
  Services.prefs.setBoolPref("whimsy.feature.ai-openai-plan", true);
  // W23: the Use for AI picker and its command are gone with it.
  ok(!WhimsyCommands.entries.find(e => e.id == "cmd_whimsyAIUse"), "cmd_whimsyAIUse is gone");
  ok(!document.getElementById("cmd_whimsyAIUse"), "and not registered as a <command>");
  for (const [id, l10nId, action] of [
    ["cmd_whimsyAIConnect", "whimsy-action-ai-connect", "add-provider"],
    ["cmd_whimsyAISignInChatGPT", "whimsy-action-ai-sign-in-chatgpt", "plan-openai"],
  ]) {
    const entry = WhimsyCommands.entries.find(e => e.id == id);
    ok(entry, `${id} is registered`);
    is(entry.l10nId, l10nId, "with its name");
    ok(entry.keyId && document.getElementById(entry.keyId), "and a key the person can assign a shortcut to");
    const original = window.openPreferences;
    let pane = null;
    window.openPreferences = value => (pane = value);
    try {
      document.getElementById(id).doCommand();
    } finally {
      window.openPreferences = original;
    }
    is(pane, "paneWhimsyAI", "running it opens Settings → AI");
    is(WhimsyAIProviders.takeSettingsAction(), action, "and asks it to " + action);
  }
  Services.prefs.setBoolPref("whimsy.feature.ai-openai-plan", false);
});

// fix7: Settings said Apple's command line tools were missing although
// "xcode-select --install" said they were installed. The tools are now
// found wherever they are, and each failure names what's missing.
add_task(async function test_apple_toolchain_detection() {
  const { AI_ERROR_CODES } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyAIProviders.sys.mjs");
  const root = await IOUtils.createUniqueDirectory(PathUtils.tempDir, "whimsy-devtools");
  const clt = PathUtils.join(root, "CommandLineTools");
  const xcode = PathUtils.join(root, "Xcode.app", "Contents", "Developer");
  const swiftc = PathUtils.join(clt, "usr", "bin", "swiftc");
  const framework = PathUtils.join(clt, "SDKs", "MacOSX.sdk", "System", "Library", "Frameworks", "FoundationModels.framework");
  const realRun = WhimsyAIProviders._run;
  const realDirs = WhimsyAIProviders._developerDirCandidates;
  // xcode-select points at an Xcode that's gone (moved or deleted).
  WhimsyAIProviders._run = async (command, args) => {
    is(command, "/usr/bin/xcode-select", "Only xcode-select runs (xcrun could prompt)");
    Assert.deepEqual(args, ["-p"], "asked for the selected folder");
    return { exitCode: 0, output: xcode + "\n" };
  };
  WhimsyAIProviders._developerDirCandidates = [clt];
  try {
    is(await WhimsyAIProviders._findToolchain(), "apple-needs-tools", "No swiftc anywhere: the tools are missing");
    ok(WhimsyAIProviders.appleDetail.includes(clt), "Settings names the folders that were searched");

    await IOUtils.makeDirectory(PathUtils.parent(swiftc));
    await IOUtils.writeUTF8(swiftc, "");
    is(await WhimsyAIProviders._findToolchain(), "apple-tools-outdated", "swiftc without the FoundationModels SDK: tools too old");

    await IOUtils.makeDirectory(framework);
    Assert.deepEqual(
      await WhimsyAIProviders._findToolchain(),
      { developerDir: clt, sdk: PathUtils.join(clt, "SDKs", "MacOSX.sdk") },
      "The command line tools are found even when xcode-select points at a missing Xcode"
    );

    // An Xcode with the newer SDK in its platform folder works too.
    WhimsyAIProviders._developerDirCandidates = [];
    const xcodeSwiftc = PathUtils.join(xcode, "Toolchains", "XcodeDefault.xctoolchain", "usr", "bin", "swiftc");
    await IOUtils.makeDirectory(PathUtils.parent(xcodeSwiftc));
    await IOUtils.writeUTF8(xcodeSwiftc, "");
    const xcodeSdk = PathUtils.join(xcode, "Platforms", "MacOSX.platform", "Developer", "SDKs", "MacOSX.sdk");
    await IOUtils.makeDirectory(PathUtils.join(xcodeSdk, "System", "Library", "Frameworks", "FoundationModels.framework"));
    Assert.deepEqual(await WhimsyAIProviders._findToolchain(), { developerDir: xcode, sdk: xcodeSdk }, "Xcode's SDK is found");

    is(
      WhimsyAIProviders._buildFailure("You have not agreed to the Xcode license agreements."),
      "apple-needs-license",
      "An unaccepted Xcode license says so"
    );
    is(
      WhimsyAIProviders._buildFailure("error: active developer path (/Applications/Xcode.app) does not exist"),
      "apple-tools-path-invalid",
      "Invalid developer path diagnosed"
    );
    is(
      WhimsyAIProviders._buildFailure("error: no such module 'FoundationModels'"),
      "apple-tools-outdated",
      "Missing FoundationModels module diagnosed as outdated tools"
    );
    is(WhimsyAIProviders._buildFailure("error: cannot find 'X' in scope"), "apple-build-failed", "Other build errors aren't 'missing tools'");
    is(
      WhimsyAIProviders._buildDetail("warning: unused\n/tmp/WhimsyFM.swift:3:5: error: cannot find 'X' in scope\n"),
      "error: cannot find 'X' in scope",
      "The compiler's first error is what Settings shows"
    );

    const l10n = new Localization(["browser/whimsy.ftl"], true);
    for (const code of [
      "apple-needs-tools",
      "apple-tools-outdated",
      "apple-tools-path-invalid",
      "apple-needs-license",
      "apple-build-failed",
      "apple-helper-blocked",
    ]) {
      ok(AI_ERROR_CODES.includes(code), `${code} is a known error`);
      ok(l10n.formatValueSync(`whimsy-ai-error-${code}`), `${code} has a toast`);
      const status = l10n.formatValueSync(`whimsy-ai-apple-status-${code}`, { detail: "DETAIL" });
      ok(status, `${code} has a Settings message`);
      // W10-07: only "no swiftc anywhere" may send people to install tools.
      if (code != "apple-needs-tools") {
        ok(!status.includes("xcode-select --install"), `${code} doesn't tell people to install tools they have`);
      }
    }
    ok(
      l10n.formatValueSync("whimsy-ai-apple-status-apple-needs-tools", { detail: "DETAIL" }).includes("DETAIL"),
      "Missing tools name the folders searched"
    );
    // A failed build's compiler error shows under the status
    // (test_apple_build_falls_back_and_says_why).
  } finally {
    WhimsyAIProviders._run = realRun;
    WhimsyAIProviders._developerDirCandidates = realDirs;
    await IOUtils.remove(root, { recursive: true });
  }
});

// W10-07: Set Up still failed on a Mac with the tools installed. Whimsy (like
// Firefox) has LSFileQuarantineEnabled, so the helper swiftc linked was
// flagged com.apple.quarantine and macOS held it at launch: the --check
// never returned. The flag is now cleared before the helper runs, and a
// helper that still doesn't start says so instead of hanging.
add_task(async function test_apple_helper_quarantine() {
  if (Services.appinfo.OS != "Darwin") {
    ok(true, "macOS only");
    return;
  }
  const root = await IOUtils.createUniqueDirectory(PathUtils.tempDir, "whimsy-fm");
  const helper = PathUtils.join(root, "whimsy-fm-test");
  const descriptor = Object.getOwnPropertyDescriptor(WhimsyAIProviders, "_helperPath");
  const realTimeout = WhimsyAIProviders._helperCheckTimeoutMs;
  Object.defineProperty(WhimsyAIProviders, "_helperPath", { get: () => helper, configurable: true });
  const quarantine = "com.apple.quarantine";
  try {
    await IOUtils.writeUTF8(helper, "#!/bin/sh\necho available\n");
    await IOUtils.setPermissions(helper, 0o755);
    await IOUtils.setMacXAttr(helper, quarantine, new TextEncoder().encode("0081;6ae6c5e6;Whimsy;"));
    ok(await IOUtils.hasMacXAttr(helper, quarantine), "The helper starts out quarantined, as Whimsy's files are");
    WhimsyAIProviders._helperPromise = null;
    is(await WhimsyAIProviders.appleStatus({ build: true }), "available", "The helper runs");
    ok(!(await IOUtils.hasMacXAttr(helper, quarantine)), "Its quarantine flag was cleared before it ran");

    // A helper macOS holds at launch reports that, not "Checking…" forever.
    await IOUtils.writeUTF8(helper, "#!/bin/sh\nexec sleep 30\n");
    await IOUtils.setPermissions(helper, 0o755);
    WhimsyAIProviders._helperPromise = null;
    WhimsyAIProviders._helperCheckTimeoutMs = 500;
    is(await WhimsyAIProviders.appleStatus({ build: true }), "apple-helper-blocked", "A helper that never starts is reported as blocked");

    // F22: a helper that answers but never exits: its answer, not
    // "Checking…" forever.
    await IOUtils.writeUTF8(helper, "#!/bin/sh\necho available\nexec sleep 30\n");
    await IOUtils.setPermissions(helper, 0o755);
    WhimsyAIProviders._helperPromise = null;
    is(await WhimsyAIProviders.appleStatus({ build: true }), "available", "A helper that answers but stays up still counts");
  } finally {
    Object.defineProperty(WhimsyAIProviders, "_helperPath", descriptor);
    WhimsyAIProviders._helperCheckTimeoutMs = realTimeout;
    WhimsyAIProviders._helperPromise = null;
    await IOUtils.remove(root, { recursive: true });
  }
});

// B11: a helper that's killed by SIGKILL before printing anything (macOS
// refusing to run it) and a helper that crashes on its own (any other
// signal, usually because this Mac can't run the model) both used to be
// reported as "apple-helper-blocked", sending people to System Settings
// for a problem that setting can't fix. They're now told apart.
add_task(async function test_apple_helper_crash_vs_blocked() {
  if (Services.appinfo.OS != "Darwin") {
    ok(true, "macOS only");
    return;
  }
  const root = await IOUtils.createUniqueDirectory(PathUtils.tempDir, "whimsy-fm-crash");
  const helper = PathUtils.join(root, "whimsy-fm-test");
  const descriptor = Object.getOwnPropertyDescriptor(WhimsyAIProviders, "_helperPath");
  Object.defineProperty(WhimsyAIProviders, "_helperPath", { get: () => helper, configurable: true });
  try {
    // Killed by SIGKILL with no output: still "blocked", as before.
    await IOUtils.writeUTF8(helper, "#!/bin/sh\nkill -KILL $$\n");
    await IOUtils.setPermissions(helper, 0o755);
    WhimsyAIProviders._helperPromise = null;
    is(await WhimsyAIProviders.appleStatus({ build: true }), "apple-helper-blocked", "SIGKILL with no output is still reported as blocked");

    // Any other signal with no output: the helper crashed on its own.
    await IOUtils.writeUTF8(helper, "#!/bin/sh\nkill -ABRT $$\n");
    await IOUtils.setPermissions(helper, 0o755);
    WhimsyAIProviders._helperPromise = null;
    is(await WhimsyAIProviders.appleStatus({ build: true }), "apple-helper-crashed", "A crash is told apart from being blocked");

    const l10n = new Localization(["browser/whimsy.ftl"], true);
    for (const id of ["whimsy-ai-error-apple-helper-crashed", "whimsy-ai-apple-status-apple-helper-crashed"]) {
      ok(l10n.formatValueSync(id), `${id} has a string`);
    }
  } finally {
    Object.defineProperty(WhimsyAIProviders, "_helperPath", descriptor);
    WhimsyAIProviders._helperPromise = null;
    await IOUtils.remove(root, { recursive: true });
  }
});

// W10-07: Settings still said "xcode-select --install" on a Mac whose
// tools were installed. Any failed build was "reinstall the tools", and
// only MacOSX.sdk was tried (Software Update can point it at an SDK the
// compiler can't read, or leave FoundationModels only in a versioned SDK).
// Now every SDK and toolchain is tried, swiftc runs directly, and Settings
// shows what the compiler said.
add_task(async function test_apple_build_falls_back_and_says_why() {
  const root = await IOUtils.createUniqueDirectory(PathUtils.tempDir, "whimsy-devtools");
  const clt = PathUtils.join(root, "CommandLineTools");
  const swiftc = PathUtils.join(clt, "usr", "bin", "swiftc");
  const sdks = PathUtils.join(clt, "SDKs");
  const framework = sdk => PathUtils.join(sdks, sdk, "System", "Library", "Frameworks", "FoundationModels.framework");
  await IOUtils.makeDirectory(PathUtils.parent(swiftc));
  await IOUtils.writeUTF8(swiftc, "");
  // MacOSX.sdk is an old SDK; the new ones are only in versioned folders.
  await IOUtils.makeDirectory(PathUtils.join(sdks, "MacOSX.sdk"));
  await IOUtils.makeDirectory(framework("MacOSX26.5.sdk"));
  await IOUtils.makeDirectory(framework("MacOSX27.0.sdk"));
  await IOUtils.makeDirectory(PathUtils.join(sdks, "MacOSX12.0.sdk"));
  const helper = PathUtils.join(root, "profile", "whimsy-ai", "whimsy-fm-test");

  const realRun = WhimsyAIProviders._run;
  const realDirs = WhimsyAIProviders._developerDirCandidates;
  const realPath = Object.getOwnPropertyDescriptor(WhimsyAIProviders, "_helperPath");
  Object.defineProperty(WhimsyAIProviders, "_helperPath", { get: () => helper, configurable: true });
  WhimsyAIProviders._developerDirCandidates = [clt];
  Services.prefs.setIntPref("whimsy.ai.test.macos-version", 26);
  WhimsyAIProviders._macOSVersionCache = null;
  const calls = [];
  let builds = {};
  WhimsyAIProviders._run = async (command, args, options) => {
    if (command == "/usr/bin/xcode-select") {
      return { exitCode: 0, output: clt + "\n" };
    }
    calls.push({ command, args, options });
    const sdk = args[args.indexOf("-sdk") + 1];
    const result = builds[PathUtils.filename(sdk)] ?? { exitCode: 1, output: "error: unexpected" };
    if (result.exitCode == 0) {
      await IOUtils.writeUTF8(helper, "");
    }
    return result;
  };
  try {
    const found = await WhimsyAIProviders._findToolchains();
    Assert.deepEqual(
      found.map(t => PathUtils.filename(t.sdk)),
      ["MacOSX27.0.sdk", "MacOSX26.5.sdk"],
      "Every SDK with FoundationModels is found, newest first (before, an old MacOSX.sdk meant 'tools outdated')"
    );
    is(found[0].swiftc, swiftc, "with the swiftc beside it");
    if (Services.appinfo.OS != "Darwin") {
      ok(true, "Apple Intelligence only builds on macOS");
      return;
    }

    // The newest SDK is newer than the compiler; the next one builds.
    builds = {
      "MacOSX27.0.sdk": {
        exitCode: 1,
        output:
          "error: failed to build module 'FoundationModels'; this SDK is not supported by the compiler " +
          "(the SDK is built with 'Apple Swift version 6.4', while this compiler is 'Apple Swift version 6.2'). " +
          "Please select a toolchain which matches the SDK.\n",
      },
      "MacOSX26.5.sdk": { exitCode: 0, output: "" },
    };
    is(await WhimsyAIProviders._ensureHelper(), helper, "A failed SDK falls back to the next one");
    is(calls.length, 2, "Two builds were tried");
    is(calls[0].command, swiftc, "swiftc runs directly (xcrun's shim can prompt or need Xcode's first launch)");
    ok(calls[0].args.includes("-module-cache-path"), "with its own module cache");
    is(calls[0].options.environment.DEVELOPER_DIR, clt, "in its own developer folder");

    // Nothing builds: the most telling reason, and the compiler's words.
    await IOUtils.remove(helper);
    WhimsyAIProviders._helperPromise = null;
    calls.length = 0;
    builds = {
      "MacOSX27.0.sdk": { exitCode: 1, output: "/x/WhimsyFM.swift:9:5: error: something odd happened\n1 error generated.\n" },
      "MacOSX26.5.sdk": {
        exitCode: 1,
        output: "error: failed to build module 'FoundationModels'; this SDK is not supported by the compiler\n",
      },
    };
    is(await WhimsyAIProviders.appleStatus({ build: true }), "apple-tools-mismatch", "A compiler older than its SDK says so");
    ok(WhimsyAIProviders.appleDetail.includes("this SDK is not supported by the compiler"), "and keeps the compiler's words");

    builds["MacOSX26.5.sdk"] = builds["MacOSX27.0.sdk"];
    is(await WhimsyAIProviders.appleStatus({ build: true }), "apple-build-failed", "Another failure is a failed build");
    is(WhimsyAIProviders.appleDetail, "error: something odd happened", "shown without the file path");

    // Settings shows it under the status, and no longer says to reinstall.
    await BrowserTestUtils.withNewTab("about:preferences#whimsyAI", async browser => {
      const doc = browser.contentDocument;
      const win = browser.contentWindow;
      await TestUtils.waitForCondition(() => win.WhimsyAISettings?.root, "Settings › AI is built");
      win.WhimsyAISettings.openSheet("apple");
      const sheet = await TestUtils.waitForCondition(() => {
        const node = doc.getElementById("whimsyAISheet");
        return node?.dataset.sheet == "apple" && node.checkVisibility() && node;
      }, "Apple's sheet opens");
      const button = await TestUtils.waitForCondition(() => doc.getElementById("whimsyAIAppleCheck")?.checkVisibility() && doc.getElementById("whimsyAIAppleCheck"), "Apple's Check again button");
      // The first look (no build) shows a status before the click builds.
      await TestUtils.waitForCondition(() => !button.disabled && sheet.querySelector(".whimsy-ai-note [data-l10n-id]"), "Apple's status is shown");
      EventUtils.synthesizeMouseAtCenter(button, {}, win);
      await TestUtils.waitForCondition(() => sheet.querySelector('button[data-l10n-id="whimsy-ai-show-details"]'), "Show details offers the compiler's message");
      EventUtils.synthesizeMouseAtCenter(sheet.querySelector('button[data-l10n-id="whimsy-ai-show-details"]'), {}, win);
      const detail = sheet.querySelector("pre.whimsy-ai-code");
      await TestUtils.waitForCondition(() => !detail.hidden, "The compiler's message shows");
      is(detail.textContent, "error: something odd happened", "word for word");
      const status = () => sheet.querySelector(".whimsy-ai-note [data-l10n-id]");
      await TestUtils.waitForCondition(() => status()?.textContent.includes("Swift tools"), "with a reason that fits");
      ok(!status().textContent.includes("xcode-select"), "not 'xcode-select --install'");
    });

    const l10n = new Localization(["browser/whimsy.ftl"], true);
    for (const id of ["whimsy-ai-error-apple-tools-mismatch", "whimsy-ai-apple-status-apple-tools-mismatch"]) {
      ok(l10n.formatValueSync(id), `${id} has a string`);
    }
  } finally {
    WhimsyAIProviders._run = realRun;
    WhimsyAIProviders._developerDirCandidates = realDirs;
    if (realPath) {
      Object.defineProperty(WhimsyAIProviders, "_helperPath", realPath);
    } else {
      delete WhimsyAIProviders._helperPath;
    }
    WhimsyAIProviders._helperPromise = null;
    WhimsyAIProviders.appleDetail = "";
    await IOUtils.remove(root, { recursive: true });
  }
});

// B11: on a Mac below macOS 26, FoundationModels can't run: the SDK's
// headers still exist (so the compiler doesn't complain), but the helper
// traps at runtime and used to surface as a build/crash error code. The
// macOS version is now checked before any build is attempted, so Settings
// says plainly that this Mac is too old instead of showing an error.
add_task(async function test_apple_unavailable_os() {
  const root = await IOUtils.createUniqueDirectory(PathUtils.tempDir, "whimsy-fm-os");
  const helper = PathUtils.join(root, "whimsy-fm-test");
  const descriptor = Object.getOwnPropertyDescriptor(WhimsyAIProviders, "_helperPath");
  Object.defineProperty(WhimsyAIProviders, "_helperPath", { get: () => helper, configurable: true });
  const realRun = WhimsyAIProviders._run;
  let runCalls;
  WhimsyAIProviders._run = async (...args) => {
    runCalls.push(args);
    return realRun.apply(WhimsyAIProviders, args);
  };
  try {
    // A faked macOS 25: too old. No toolchain search, no build attempt.
    Services.prefs.setIntPref("whimsy.ai.test.macos-version", 25);
    WhimsyAIProviders._helperPromise = null;
    WhimsyAIProviders._macOSVersionCache = null;
    runCalls = [];
    is(
      await WhimsyAIProviders.appleStatus({ build: false }),
      "apple-unavailable-os",
      "Before a helper exists, the first look already names the OS as the reason"
    );
    is(runCalls.length, 0, "Checking the OS version doesn't need to run any tool");

    runCalls = [];
    is(
      await WhimsyAIProviders.appleStatus({ build: true }),
      "apple-unavailable-os",
      "Set Up itself refuses too: no swiftc, no helper, just the OS reason"
    );
    is(runCalls.find(call => call[0] != "/usr/bin/sw_vers"), undefined, "No toolchain search or build was attempted");
    ok(!(await IOUtils.exists(helper)), "No helper was built");

    const l10n = new Localization(["browser/whimsy.ftl"], true);
    for (const id of ["whimsy-ai-error-apple-unavailable-os", "whimsy-ai-apple-status-apple-unavailable-os"]) {
      const value = l10n.formatValueSync(id);
      ok(value, `${id} has a string`);
      ok(value.includes("macOS 26"), `${id} names macOS 26 as what's needed`);
    }

    // Settings never offers Set Up, and shows the reason, on a Mac that can
    // never finish setting up.
    await BrowserTestUtils.withNewTab("about:preferences#whimsyAI", async browser => {
      const doc = browser.contentDocument;
      const win = browser.contentWindow;
      await TestUtils.waitForCondition(() => win.WhimsyAISettings?.root, "Settings › AI is built");
      win.WhimsyAISettings.openSheet("apple");
      const sheet = await TestUtils.waitForCondition(() => {
        const node = doc.getElementById("whimsyAISheet");
        return node?.dataset.sheet == "apple" && node.checkVisibility() && node;
      }, "Apple's sheet opens");
      const status = await TestUtils.waitForCondition(
        () => sheet.querySelector('[data-l10n-id="whimsy-ai-apple-status-apple-unavailable-os"]'),
        "the OS reason shows"
      );
      ok(!doc.getElementById("whimsyAIAppleCheck"), "Set Up isn't offered on a Mac that's too old");
      await TestUtils.waitForCondition(() => status.textContent.includes("macOS 26"), "The reason is shown");
    });

    // A faked macOS 26: the existing flow (helper build, available) is
    // unchanged.
    Services.prefs.setIntPref("whimsy.ai.test.macos-version", 26);
    WhimsyAIProviders._helperPromise = null;
    WhimsyAIProviders._macOSVersionCache = null;
    runCalls = [];
    await IOUtils.writeUTF8(helper, "#!/bin/sh\necho available\n");
    await IOUtils.setPermissions(helper, 0o755);
    is(
      await WhimsyAIProviders.appleStatus({ build: true }),
      "available",
      "On macOS 26, an existing helper still just runs"
    );

    await IOUtils.remove(helper);
    WhimsyAIProviders._helperPromise = null;
    is(
      await WhimsyAIProviders.appleStatus({ build: false }),
      Services.appinfo.OS == "Darwin" ? "not-set-up" : "unavailable",
      "On macOS 26 with no helper yet, the first look still says not-set-up, not the OS reason"
    );
  } finally {
    WhimsyAIProviders._run = realRun;
    Object.defineProperty(WhimsyAIProviders, "_helperPath", descriptor);
    WhimsyAIProviders._helperPromise = null;
    WhimsyAIProviders._macOSVersionCache = null;
    WhimsyAIProviders.appleDetail = "";
    Services.prefs.clearUserPref("whimsy.ai.test.macos-version");
    await IOUtils.remove(root, { recursive: true });
  }
});
