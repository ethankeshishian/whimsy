/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// W14 19: plan sign-in. Sign in with ChatGPT against a mock OpenAI issuer
// (discovery, PKCE S256, state, nonce, a one-shot loopback callback, a signed
// ID token, OSKeyStore storage, one refresh at a time, revocation, the
// Responses API stream), and the Claude plan through a stand-in `claude`
// that Whimsy runs with fixed arguments.

const { WhimsyAIProviders, WhimsyAIError } = ChromeUtils.importESModule(
  "resource:///modules/whimsy/WhimsyAIProviders.sys.mjs"
);
const { WhimsyAIOpenAIAuth, sseEvents } = ChromeUtils.importESModule(
  "resource:///modules/whimsy/WhimsyAIOpenAIAuth.sys.mjs"
);
const { WhimsyAIClaudeCode } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyAIClaudeCode.sys.mjs");
const { WhimsyAIRouter } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyAIRouter.sys.mjs");
const { WhimsyAI } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyAI.sys.mjs");
const { OSKeyStoreTestUtils } = ChromeUtils.importESModule("resource://testing-common/OSKeyStoreTestUtils.sys.mjs");
const { HttpServer } = ChromeUtils.importESModule("resource://testing-common/httpd.sys.mjs");

const PLAN_FILE = PathUtils.join(PathUtils.profileDir, "whimsy-ai-openai-plan.json");
const DEVICE_NAME_PREF = "identity.fxaccounts.account.device.name";
const deviceNameHadUserValue = Services.prefs.prefHasUserValue(DEVICE_NAME_PREF);
const deviceNameValue = deviceNameHadUserValue ? Services.prefs.getStringPref(DEVICE_NAME_PREF) : null;
// Token-looking fixtures, built by concatenation.
const REFRESH_1 = "rt-" + "first-0001";
const REFRESH_2 = "rt-" + "second-0002";
const ACCESS = n => "at-" + "token-" + n;
const ISSUED = "client-" + "issued-42";

OSKeyStoreTestUtils.setup();
registerCleanupFunction(async () => {
  WhimsyAIOpenAIAuth.setTestEndpoints(null);
  WhimsyAIClaudeCode.setTestSearchPath(null);
  await IOUtils.remove(PLAN_FILE, { ignoreAbsent: true });
  for (const pref of [
    "whimsy.ai.provider",
    "whimsy.ai.openai.auth",
    "whimsy.ai.claude.auth",
    "whimsy.ai.openai.model",
    "whimsy.ai.claude.model",
    "whimsy.ai.openai.plan-welcomed",
    "whimsy.ai.auto-enabled",
    "whimsy.ai.order",
    "whimsy.ai.resting",
    "whimsy.ai.claude-code.stream-probe",
    "whimsy.ai.gemini.model",
  ]) {
    Services.prefs.clearUserPref(pref);
  }
  Services.prefs.setBoolPref("whimsy.ai.enabled", true);
  if (deviceNameHadUserValue) {
    Services.prefs.setStringPref(DEVICE_NAME_PREF, deviceNameValue);
  } else {
    Services.prefs.clearUserPref(DEVICE_NAME_PREF);
  }
  await OSKeyStoreTestUtils.cleanup();
});

async function rejectsWith(promise, code, message) {
  try {
    await promise;
    ok(false, `${message}: expected ${code}`);
  } catch (error) {
    is(error?.code, code, message);
  }
}

const b64 = bytes => ChromeUtils.base64URLEncode(bytes, { pad: false });
const b64json = value => b64(new TextEncoder().encode(JSON.stringify(value)));
const bodyOf = request => {
  const stream = request.bodyInputStream;
  const count = stream.available();
  return count ? NetUtil.readInputStreamToString(stream, count, { charset: "UTF-8" }) : "";
};

// A mock of OpenAI's issuer and API on 127.0.0.1.
async function mockOpenAI() {
  const keys = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"]
  );
  const jwk = { ...(await crypto.subtle.exportKey("jwk", keys.publicKey)), kid: "k1", use: "sig", alg: "RS256" };
  const server = new HttpServer();
  server.start(-1);
  const base = `http://127.0.0.1:${server.identity.primaryPort}`;
  server.identity.add("http", "127.0.0.1", server.identity.primaryPort);
  const mock = {
    base,
    authorize: [],
    tokens: [],
    revoked: [],
    responses: [],
    refreshDelay: 0,
    refreshError: null,
    stream: null,
    // What the authorize step sends back (changeable per test).
    callback: params => ({ code: "code-1", state: params.get("state"), client_id: ISSUED }),
    idClaims: params => ({ nonce: params.get("nonce") }),
    scope: "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct",
    async jwt(claims) {
      const input = `${b64json({ alg: "RS256", kid: "k1", typ: "JWT" })}.${b64json(claims)}`;
      const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", keys.privateKey, new TextEncoder().encode(input));
      return `${input}.${b64(new Uint8Array(signature))}`;
    },
    stop: () => new Promise(resolve => server.stop(resolve)),
  };
  const json = (response, value, status = 200) => {
    response.setStatusLine("1.1", status, "OK");
    response.setHeader("Content-Type", "application/json", false);
    response.write(JSON.stringify(value));
  };
  server.registerPathHandler("/.well-known/openid-configuration", (request, response) =>
    json(response, {
      issuer: base,
      authorization_endpoint: `${base}/authorize`,
      token_endpoint: `${base}/token`,
      jwks_uri: `${base}/jwks`,
      revocation_endpoint: `${base}/revoke`,
    })
  );
  server.registerPathHandler("/jwks", (request, response) => json(response, { keys: [jwk] }));
  server.registerPathHandler("/authorize", (request, response) => {
    const params = new URLSearchParams(request.queryString);
    mock.authorize.push(params);
    const answer = mock.callback(params);
    if (!answer) {
      response.setStatusLine("1.1", 200, "OK");
      response.setHeader("Content-Type", "text/html", false);
      response.write("<!DOCTYPE html><title>Sign in</title>");
      return;
    }
    const target = new URL(params.get("redirect_uri"));
    for (const [name, value] of Object.entries(answer)) {
      target.searchParams.set(name, value);
    }
    response.setStatusLine("1.1", 302, "Found");
    response.setHeader("Location", target.href, false);
  });
  server.registerPathHandler("/token", (request, response) => {
    const form = new URLSearchParams(bodyOf(request));
    mock.tokens.push(form);
    response.processAsync();
    (async () => {
      if (form.get("grant_type") == "refresh_token") {
        await new Promise(resolve => setTimeout(resolve, mock.refreshDelay));
        if (mock.refreshError) {
          json(response, { error: mock.refreshError }, 400);
        } else {
          json(response, { access_token: ACCESS(mock.tokens.length), refresh_token: REFRESH_2, expires_in: 3600 });
        }
        response.finish();
        return;
      }
      const authorize = mock.authorize.at(-1);
      const challenge = b64(
        new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(form.get("code_verifier"))))
      );
      if (challenge != authorize.get("code_challenge") || form.get("code") != "code-1") {
        json(response, { error: "invalid_grant" }, 400);
        response.finish();
        return;
      }
      const now = Math.floor(Date.now() / 1000);
      const id_token = await mock.jwt({
        iss: base,
        aud: form.get("client_id"),
        sub: "user-1",
        email: "me@example.com",
        exp: now + 3600,
        iat: now,
        ...mock.idClaims(authorize),
      });
      json(response, {
        access_token: ACCESS(mock.tokens.length),
        refresh_token: REFRESH_1,
        id_token,
        token_type: "Bearer",
        expires_in: 3600,
        scope: mock.scope,
      });
      response.finish();
    })();
  });
  server.registerPathHandler("/revoke", (request, response) => {
    mock.revoked.push(new URLSearchParams(bodyOf(request)));
    response.setStatusLine("1.1", 200, "OK");
  });
  server.registerPathHandler("/v1/models", (request, response) =>
    json(response, {
      models: [
        { slug: "gpt-plan-1", visibility: "list" },
        { slug: "gpt-hidden", visibility: "hide" },
        { slug: "gpt-plan-2", visibility: "list" },
      ],
    })
  );
  server.registerPathHandler("/v1/responses", (request, response) => {
    mock.responses.push({ auth: request.getHeader("Authorization"), body: JSON.parse(bodyOf(request)) });
    response.setStatusLine("1.1", 200, "OK");
    response.setHeader("Content-Type", "text/event-stream", false);
    response.write(
      mock.stream ??
        'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"Hel"}\n\n' +
          'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"lo"}\n\n' +
          'event: response.completed\ndata: {"type":"response.completed","response":{"output":[]}}\n\n'
    );
  });
  WhimsyAIOpenAIAuth.setTestEndpoints({ issuer: base, api: `${base}/v1` });
  return mock;
}

add_task(async function test_sse_across_chunks() {
  const chunks = ["event: a\r\ndata: {\"x\":", "1}\r\n\r\n: comment\n\nev", "ent: b\ndata: one\ndata: two\n\ndata: tail"];
  const body = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(new TextEncoder().encode(chunk));
      }
      controller.close();
    },
  });
  const events = [];
  for await (const event of sseEvents(body)) {
    events.push(event);
  }
  Assert.deepEqual(
    events,
    [
      { event: "a", data: '{"x":1}' },
      { event: "b", data: "one\ntwo" },
      { event: "", data: "tail" },
    ],
    "Events split across chunks and CRLF line ends come out whole"
  );
});

add_task(async function test_sign_in_with_chatgpt() {
  const mock = await mockOpenAI();
  const tabsBefore = gBrowser.tabs.length;
  await BrowserTestUtils.openNewForegroundTab(gBrowser, "about:preferences#whimsyAI");
  const settingsTab = gBrowser.selectedTab;
  const doc = gBrowser.selectedBrowser.contentDocument;
  const win = gBrowser.selectedBrowser.contentWindow;
  const $ = id => doc.getElementById(id);
  await TestUtils.waitForCondition(() => win.WhimsyAISettings?.root, "Settings → AI shows");
  const S = win.WhimsyAISettings;
  const click = node => EventUtils.synthesizeMouseAtCenter(node, {}, win);
  const sheetFor = id => TestUtils.waitForCondition(() => {
    const node = $("whimsyAISheet");
    return node?.dataset.sheet == id && node.checkVisibility() && node;
  }, `The ${id} sheet opens`);
  const row = () => doc.querySelector('#whimsyAIProviderList .whimsy-ai-item[data-provider="openai"]');

  const addButton = await TestUtils.waitForCondition(() => $("whimsyAISetUp") ?? $("whimsyAIAddProvider"), "Add a provider is offered");
  click(addButton);
  const add = await sheetFor("add-provider");
  await Promise.all(doc.getAnimations().map(a => a.finished.catch(() => {})));
  click(add.querySelector('.whimsy-ai-choice[data-provider="openai"]'));
  const openai = await sheetFor("openai");
  is(openai.querySelector('.whimsy-ai-seg [aria-checked="true"]')?.dataset.method, "plan", "The ChatGPT plan comes first");
  const continueButton = await TestUtils.waitForCondition(() => $("whimsyAIOpenAIContinue")?.checkVisibility() && !$("whimsyAIOpenAIContinue").disabled && $("whimsyAIOpenAIContinue"), "Continue with ChatGPT can be pressed");
  click(continueButton);

  await TestUtils.waitForCondition(() => mock.authorize.length == 1, "OpenAI's sign-in page opens");
  const params = mock.authorize[0];
  is(params.get("client_id"), "dynamic_agent_client", "First sign-in registers a client");
  is(params.get("agent_name_hint"), "Whimsy", "named Whimsy");
  ok(/^urn:uuid:[0-9a-f-]{36}$/.test(params.get("ext_agent_host_id")), "with this install's host ID");
  is(params.get("code_challenge_method"), "S256", "PKCE S256");
  ok(params.get("code_challenge").length >= 43 && params.get("state").length >= 43 && params.get("nonce").length >= 43, "fresh challenge, state and nonce");
  ok(params.get("scope").split(" ").includes("chatgpt.tokens.use.direct"), "asking to use the plan");
  is(params.get("resource"), "https://api.openai.com/v1", "for the API");
  const redirect = new URL(params.get("redirect_uri"));
  is(redirect.hostname, "127.0.0.1", "The callback is on loopback");
  is(redirect.pathname, "/auth/callback", "at one path");

  await TestUtils.waitForCondition(() => $("whimsyAIOpenAIDone")?.checkVisibility(), "First sign-in: OpenAI's one-time welcome");
  is(gBrowser.selectedTab, settingsTab, "The sign-in tab closed, back on Settings");
  is(gBrowser.tabs.length, tabsBefore + 1, "and nothing else stayed open");
  ok(!PrivateBrowsingUtils.isWindowPrivate(window), "It signed in in a normal window");
  click($("whimsyAIOpenAIDone"));
  await TestUtils.waitForCondition(() => !S.sheet, "Done closes the sheet");
  await TestUtils.waitForCondition(() => row()?.querySelector(".whimsy-ai-item-detail")?.getAttribute("data-l10n-id") == "whimsy-ai-row-plan-openai", "Settings says 'ChatGPT plan', in the row");

  // The listener is gone after its one callback.
  await rejectsWith(fetch(params.get("redirect_uri")).then(() => ({ code: "answered" })), undefined, "The loopback listener closed");

  // Only ciphertext on disk, nothing in prefs.
  const file = await IOUtils.readUTF8(PLAN_FILE);
  for (const secret of [REFRESH_1, ACCESS(1), ISSUED, "me@example.com"]) {
    ok(!file.includes(secret), "The plan file holds no plain token, client or email");
    for (const name of Services.prefs.getChildList("whimsy.")) {
      if (Services.prefs.getPrefType(name) == Services.prefs.PREF_STRING && Services.prefs.getStringPref(name).includes(secret)) {
        ok(false, `${name} holds a secret`);
      }
    }
  }
  is((await IOUtils.stat(PLAN_FILE)).permissions, 0o600, "and only its owner can read it");
  is(mock.tokens[0].get("client_id"), ISSUED, "The code was exchanged with the issued client");
  is(mock.tokens[0].get("redirect_uri"), params.get("redirect_uri"), "and the same redirect");
  const status = await WhimsyAIProviders.connection("openai");
  is(status.method + status.label, "planme@example.com", "Connected through the plan, with the checked email");
  is(Services.prefs.getStringPref("whimsy.ai.openai.model"), "gpt-plan-1", "The plan's first listed model is picked");

  // A request: the Responses API, streamed, nothing stored.
  is(await WhimsyAIProviders.complete({ prompt: "Hi", system: "Be brief" }), "Hello", "The streamed answer comes back whole");
  const sent = mock.responses.at(-1);
  is(sent.auth, `Bearer ${ACCESS(1)}`, "with the access token");
  is(sent.body.store, false, "store off");
  is(sent.body.stream, true, "stream on");
  is(sent.body.instructions, "Be brief", "the system text as instructions");
  ok(!("max_output_tokens" in sent.body), "no parameter the plan doesn't take");

  // A stream that ends early, a spent plan, an ineligible plan.
  mock.stream = 'data: {"type":"response.output_text.delta","delta":"Hal"}\n\n';
  await rejectsWith(WhimsyAIProviders.complete({ prompt: "x" }), "bad-response", "No response.completed: no answer");
  mock.stream = 'data: {"type":"response.failed","response":{"error":{"code":"subscription_sharing_usage_limit_exceeded"}}}\n\n';
  await rejectsWith(WhimsyAIProviders.complete({ prompt: "x" }), "plan-limit", "A spent plan says so");
  ok(WhimsyAIProviders.resting("openai"), "and rests");
  await rejectsWith(WhimsyAIProviders.complete({ prompt: "x" }), "plan-limit", "Resting, it isn't asked again");
  WhimsyAIProviders.clearResting("openai");
  mock.stream = 'data: {"type":"error","code":"subscription_sharing_user_not_eligible"}\n\n';
  await rejectsWith(WhimsyAIProviders.complete({ prompt: "x" }), "plan-ineligible", "An ineligible plan says so");
  mock.stream = null;

  // One refresh at a time, with the new refresh token kept.
  WhimsyAIOpenAIAuth._access.expiresAt = Date.now();
  mock.refreshDelay = 300;
  const answers = await Promise.all([WhimsyAIProviders.complete({ prompt: "a" }), WhimsyAIProviders.complete({ prompt: "b" })]);
  Assert.deepEqual(answers, ["Hello", "Hello"], "Both requests answer");
  const refreshes = mock.tokens.filter(form => form.get("grant_type") == "refresh_token");
  is(refreshes.length, 1, "after a single refresh");
  is(refreshes[0].get("refresh_token"), REFRESH_1, "with the saved refresh token");
  is(refreshes[0].get("client_id"), ISSUED, "and the issued client");
  WhimsyAIOpenAIAuth._secret = undefined;
  is((await WhimsyAIOpenAIAuth._loadSecret()).refreshToken, REFRESH_2, "The replacement refresh token is saved");

  // A refresh OpenAI turns down: signed out, sign in again.
  WhimsyAIOpenAIAuth._access.expiresAt = Date.now();
  mock.refreshError = "invalid_grant";
  await rejectsWith(WhimsyAIProviders.complete({ prompt: "x" }), "signed-out", "An ended sign-in says so");
  ok((await WhimsyAIProviders.connection("openai")).signedOut, "and Settings shows it signed out");
  ok(!(await WhimsyAIProviders.isReady()), "Nothing automatic runs on it");
  mock.refreshError = null;

  // Disconnect: the refresh token is revoked first.
  await WhimsyAIProviders.disconnect("openai");
  ok(!(await WhimsyAIProviders.connection("openai")), "Disconnected");
  const saved = await IOUtils.readJSON(PLAN_FILE);
  ok(!saved.secret && saved.hostId, "Only the host ID stays");

  // Signing in again from the command: no welcome the second time.
  mock.refreshError = null;
  WhimsyAIOpenAIAuth._secret = undefined;
  await WhimsyAIProviders.connectPlan(window, "openai");
  await WhimsyAIProviders.disconnect("openai");
  is(mock.revoked.at(-1).get("token"), REFRESH_1, "Disconnect revokes the refresh token");
  is(mock.revoked.at(-1).get("token_type_hint"), "refresh_token", "as a refresh token");
  is(mock.revoked.at(-1).get("client_id"), ISSUED, "for the issued client");

  gBrowser.selectedTab = settingsTab;
  await TestUtils.waitForCondition(() => !row(), "The row goes with the plan");
  WhimsyAIProviders.openSettings(window, "plan-openai");
  await sheetFor("openai");
  await TestUtils.waitForCondition(() => $("whimsyAIOpenAIContinue")?.checkVisibility() && !$("whimsyAIOpenAIContinue").disabled, "Sign in with ChatGPT (the command) opens the sheet, ready to continue");
  click($("whimsyAIOpenAIContinue"));
  await TestUtils.waitForCondition(() => mock.authorize.length == 3, "and starts the sign-in");
  await TestUtils.waitForCondition(() => WhimsyAIProviders.planInUse == "openai" && !S.sheet, "and finishes, no welcome again");
  await WhimsyAIProviders.disconnect("openai");

  BrowserTestUtils.removeTab(settingsTab);
  Services.prefs.clearUserPref("whimsy.ai.openai.model");
  Services.prefs.clearUserPref("whimsy.ai.openai.plan-welcomed");
  await mock.stop();
});

add_task(async function test_sign_in_refusals() {
  const mock = await mockOpenAI();
  const before = gBrowser.selectedTab;
  const tryOnce = async (message, code) => {
    await rejectsWith(WhimsyAIOpenAIAuth.connect(window), code, message);
    ok(!(await IOUtils.readJSON(PLAN_FILE).catch(() => ({}))).secret, "and nothing was saved");
  };
  mock.callback = params => ({ code: "code-1", state: params.get("state") + "x", client_id: ISSUED });
  await tryOnce("A wrong state ends the attempt", "failed");
  mock.callback = params => ({ code: "code-1", state: params.get("state"), client_id: ISSUED });
  mock.idClaims = () => ({ nonce: "another" });
  await tryOnce("An ID token with another nonce is refused", "failed");
  mock.idClaims = params => ({ nonce: params.get("nonce"), aud: "someone-else" });
  await tryOnce("An ID token for another client is refused", "failed");
  mock.idClaims = params => ({ nonce: params.get("nonce"), exp: 1 });
  await tryOnce("An expired ID token is refused", "failed");
  mock.idClaims = params => ({ nonce: params.get("nonce") });
  mock.scope = "openid profile email offline_access";
  await tryOnce("A plan that can't be used here is turned away", "plan-ineligible");
  is(mock.revoked.at(-1)?.get("token"), REFRESH_1, "and its token revoked");
  mock.scope = "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";

  // A request from a web page (Origin) can't complete it; Cancel ends it.
  mock.callback = params => ({ error: "access_denied", state: params.get("state") });
  let pending = WhimsyAIOpenAIAuth.connect(window);
  await TestUtils.waitForCondition(() => mock.authorize.length == 6, "Signing in");
  await rejectsWith(pending, "sign-in-cancelled", "Declining on OpenAI's page cancels");
  mock.callback = () => null;
  mock.authorize.length = 0;
  pending = WhimsyAIOpenAIAuth.connect(window);
  await TestUtils.waitForCondition(() => mock.authorize.length == 1, "Signing in");
  const callback = mock.authorize[0].get("redirect_uri") + `?code=x&state=${mock.authorize[0].get("state")}`;
  // A web page that learnt the address and state still can't finish it.
  const page = await BrowserTestUtils.openNewForegroundTab(gBrowser, `${mock.base}/jwks`);
  const fromPage = await SpecialPowers.spawn(page.linkedBrowser, [callback], url =>
    content.fetch(url).then(
      () => "answered",
      () => "blocked"
    )
  );
  is(fromPage, "blocked", "A request from a web page (with an Origin) is refused");
  ok(WhimsyAIOpenAIAuth.signingIn, "and the sign-in still waits");
  BrowserTestUtils.removeTab(page);
  Services.prefs.setBoolPref("whimsy.ai.enabled", false);
  await rejectsWith(pending, "sign-in-cancelled", "Enable AI off cancels a waiting sign-in");
  Services.prefs.setBoolPref("whimsy.ai.enabled", true);
  for (const tab of [...gBrowser.tabs]) {
    if (tab != before && tab.linkedBrowser.currentURI.spec.startsWith("http://127.0.0.1")) {
      BrowserTestUtils.removeTab(tab);
    }
  }
  gBrowser.selectedTab = before;
  await mock.stop();
});

// A stand-in `claude`: answers `auth status` from status.json and a prompt
// from result.json, and records what it was given.
async function fakeClaude() {
  const dir = PathUtils.join(PathUtils.tempDir, `whimsy-fake-claude-${Date.now()}`);
  await IOUtils.makeDirectory(dir);
  const script = PathUtils.join(dir, "claude");
  await IOUtils.writeUTF8(
    script,
    [
      "#!/bin/sh",
      `d="${dir}"`,
      'if [ "$1" = auth ] && [ "$2" = status ]; then cat "$d/status.json"; exit 0; fi',
      'if [ "$1" = auth ] && [ "$2" = login ]; then cp "$d/after-login.json" "$d/status.json"; exit 0; fi',
      'if [ "$1" = --version ]; then echo "9.9.9 (Claude Code)"; exit 0; fi',
      'printf "%s\\n" "$@" > "$d/args.txt"',
      'prev=""; for a in "$@"; do if [ "$prev" = --mcp-config ]; then stat -f %Lp "$a" > "$d/mode.txt"; cp "$a" "$d/mcp.json"; printf "%s" "$a" > "$d/mcp-path.txt"; fi; prev="$a"; done',
      'cat > "$d/stdin.txt"',
      'if [ -f "$d/hang" ]; then exec sleep 30; fi',
      'case "$*" in *stream-json*) if [ -f "$d/stream.jsonl" ]; then cat "$d/stream.jsonl"; else cat "$d/result.json"; fi;; *) cat "$d/result.json";; esac',
    ].join("\n") + "\n"
  );
  await IOUtils.setPermissions(script, 0o755);
  const write = (name, value) => IOUtils.writeJSON(PathUtils.join(dir, name), value);
  const writeText = (name, value) => IOUtils.writeUTF8(PathUtils.join(dir, name), value);
  const remove = name => IOUtils.remove(PathUtils.join(dir, name), { ignoreAbsent: true });
  return { dir, write, writeText, remove, read: name => IOUtils.readUTF8(PathUtils.join(dir, name)) };
}

add_task(async function test_claude_plan_through_claude_code() {
  const empty = PathUtils.join(PathUtils.tempDir, `whimsy-no-claude-${Date.now()}`);
  await IOUtils.makeDirectory(empty);
  WhimsyAIClaudeCode.setTestSearchPath([empty]);
  await rejectsWith(WhimsyAIProviders.connectPlan(window, "claude"), "claude-code-missing", "No Claude Code: it says to install it");
  ok(!Services.prefs.prefHasUserValue("whimsy.ai.claude.auth"), "and nothing is connected");

  const fake = await fakeClaude();
  WhimsyAIClaudeCode.setTestSearchPath([fake.dir]);
  await fake.write("status.json", { loggedIn: false });
  await fake.write("after-login.json", { loggedIn: true, email: "me@example.com", subscriptionType: "max" });
  await WhimsyAIProviders.connectPlan(window, "claude");
  is((await WhimsyAIProviders.connection("claude")).label, "me@example.com", "Claude Code's own sign-in ran; connected");
  // Connecting probes stream-json in the background; let it finish first.
  await TestUtils.waitForCondition(() => WhimsyAIProviders._claudePlanStreams !== null, "The stream probe ran");
  Services.prefs.clearUserPref("whimsy.ai.claude-code.stream-probe");
  WhimsyAIProviders._claudePlanStreams = false;
  Assert.deepEqual(WhimsyAIProviders.order, ["claude"], "Claude is in the order");
  ok(await WhimsyAIProviders.isReady(), "Automatic features may use the plan");

  await fake.write("result.json", { type: "result", subtype: "success", is_error: false, result: "Answer" });
  is(await WhimsyAIProviders.complete({ prompt: "Page text; rm -rf ~", system: "Be brief", userStarted: true }), "Answer", "Claude Code answers");
  const args = (await fake.read("args.txt")).split("\n").slice(0, -1);
  Assert.deepEqual(
    args,
    ["-p", "--output-format", "json", "--tools", "", "--strict-mcp-config", "--no-session-persistence", "--system-prompt", "Be brief"],
    "with fixed arguments, no tools"
  );
  is(await fake.read("stdin.txt"), "Page text; rm -rf ~", "the page text on stdin, never on a command line");

  await fake.write("result.json", { type: "result", subtype: "success", is_error: true, result: "Claude usage limit reached. Resets 10pm" });
  await rejectsWith(WhimsyAIProviders.complete({ prompt: "x", userStarted: true }), "plan-limit", "A spent plan says so");
  ok(WhimsyAIProviders.resting("claude")?.message.startsWith("Claude usage limit reached"), "A spent plan rests, in its words");
  WhimsyAIProviders.clearResting("claude");
  await fake.write("result.json", { type: "result", subtype: "success", is_error: true, result: "Invalid API key · Please run /login" });
  await rejectsWith(WhimsyAIProviders.complete({ prompt: "x", userStarted: true }), "claude-code-signed-out", "Signed out of Claude Code says so");


  await plan_runs_unattended(fake);
  await plan_gets_temp_mcp_config_and_deletes_it(fake);
  await plan_no_stream_whole_answer(fake);
  await plan_stream_json_when_supported(fake);

  await WhimsyAIProviders.disconnect("claude");
  ok(!(await WhimsyAIProviders.connection("claude")), "Disconnecting stops using Claude Code");
  ok(JSON.parse(await fake.read("status.json")).loggedIn, "and leaves Claude Code signed in");
  Services.prefs.clearUserPref("whimsy.ai.provider");
  Services.prefs.clearUserPref("whimsy.ai.order");
  Services.prefs.clearUserPref("whimsy.ai.auto-enabled");
  Services.prefs.setBoolPref("whimsy.ai.enabled", true);
  WhimsyAIClaudeCode.setTestSearchPath(null);
  await IOUtils.remove(fake.dir, { recursive: true });
  await IOUtils.remove(empty, { recursive: true });
});

// W23: the plan serves automatic work too (routines, previews, the index).
async function plan_runs_unattended(fake) {
  await fake.write("result.json", { type: "result", subtype: "success", is_error: false, result: "Routine answer" });
  is(await WhimsyAIProviders.complete({ prompt: "x", userStarted: false }), "Routine answer", "plan_runs_unattended: an automatic request is answered");
  is(await WhimsyAIClaudeCode.complete({ prompt: "x" }), "Routine answer", "and Claude Code itself has no gate");
}

// Connectors reach Claude Code as a 0600 --mcp-config file that's gone
// after the run, whether it finishes or is stopped.
async function plan_gets_temp_mcp_config_and_deletes_it(fake) {
  const servers = [
    { name: "granola", url: "https://mcp.example/granola", headers: { authorization: "Bearer " + "tok-" + "1" } },
    { name: "my files", command: "/usr/bin/true", args: ["--x"] },
  ];
  await fake.write("result.json", { type: "result", subtype: "success", is_error: false, result: "With connectors" });
  is(await WhimsyAIClaudeCode.complete({ prompt: "x", mcpServers: servers }), "With connectors", "Answered with connectors");
  const args = (await fake.read("args.txt")).split("\n").slice(0, -1);
  const file = await fake.read("mcp-path.txt");
  Assert.deepEqual(
    args,
    ["-p", "--output-format", "json", "--tools", "", "--mcp-config", file, "--strict-mcp-config", "--allowedTools", "mcp__granola,mcp__my_files", "--no-session-persistence"],
    "Claude Code's own tools stay off; only the connectors' tools may run"
  );
  ok(file.startsWith(PathUtils.join(PathUtils.tempDir, "whimsy-claude-code")) && /mcp-[0-9a-f-]+\.json$/.test(file), "The file is in Whimsy's Claude Code folder");
  is((await fake.read("mode.txt")).trim(), "600", "and only this user can read it");
  const config = JSON.parse(await fake.read("mcp.json"));
  is(config.mcpServers.granola.url, "https://mcp.example/granola", "An address server");
  is(config.mcpServers.my_files.command, "/usr/bin/true", "A command server");
  ok(!(await IOUtils.exists(file)), "The file is deleted after the run");
  const folder = await IOUtils.stat(PathUtils.parent(file));
  is(folder.permissions & 0o777, 0o700, "Its folder is 0700");

  await fake.remove("mcp-path.txt");
  await fake.writeText("hang", "1");
  const controller = new AbortController();
  const pending = WhimsyAIClaudeCode.complete({ prompt: "x", mcpServers: servers, signal: controller.signal });
  await TestUtils.waitForCondition(() => IOUtils.exists(PathUtils.join(fake.dir, "mcp-path.txt")), "Claude Code started");
  const stopped = await fake.read("mcp-path.txt");
  controller.abort();
  await rejectsWith(pending, "aborted", "Stopping the run");
  ok(!(await IOUtils.exists(stopped)), "deletes the file too");
  await fake.remove("hang");

  await WhimsyAIClaudeCode.complete({ prompt: "x" });
  const plain = (await fake.read("args.txt")).split("\n");
  ok(!plain.includes("--mcp-config"), "No connectors: no config file");
}

// Probe says no: the answer arrives whole, as one text event.
async function plan_no_stream_whole_answer(fake) {
  await fake.remove("stream.jsonl");
  Services.prefs.clearUserPref("whimsy.ai.claude-code.stream-probe");
  await fake.write("result.json", { type: "result", subtype: "success", is_error: false, result: "The whole answer" });
  await WhimsyAIProviders.refreshCapabilities("claude");
  ok(!WhimsyAIProviders.capabilities("claude").streaming, "plan_no_stream_whole_answer: no partial messages, no streaming");
  ok(Services.prefs.getStringPref("whimsy.ai.claude-code.stream-probe").includes("9.9.9"), "The probe is kept per version");
  const events = [];
  const result = await WhimsyAIRouter.run({ task: "chat", messages: [{ role: "user", content: "hi" }], onEvent: e => events.push(e) });
  const texts = events.filter(e => e.type == "text");
  is(texts.length, 1, "One text event");
  is(texts[0].delta, "The whole answer", "with the whole answer");
  is(result.provider, "claude", "from the plan");
}

// Probe says yes: text and thinking stream as deltas.
async function plan_stream_json_when_supported(fake) {
  const line = value => JSON.stringify(value);
  const delta = d => line({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: d } });
  await fake.writeText(
    "stream.jsonl",
    [
      line({ type: "system", subtype: "init" }),
      delta({ type: "thinking_delta", thinking: "Thinking it over" }),
      delta({ type: "text_delta", text: "Streamed " }),
      delta({ type: "text_delta", text: "answer" }),
      line({ type: "result", subtype: "success", is_error: false, result: "Streamed answer" }),
    ].join("\n") + "\n"
  );
  Services.prefs.clearUserPref("whimsy.ai.claude-code.stream-probe");
  await WhimsyAIProviders.refreshCapabilities("claude");
  ok(WhimsyAIProviders.capabilities("claude").streaming, "plan_stream_json_when_supported: the probe turns streaming on");
  const events = [];
  const result = await WhimsyAIRouter.run({ task: "chat", messages: [{ role: "user", content: "hi" }], onEvent: e => events.push(e) });
  Assert.deepEqual(events.filter(e => e.type == "text").map(e => e.delta), ["Streamed ", "answer"], "Several text deltas");
  ok(events.some(e => e.type == "thinking" && e.text == "Thinking it over"), "and its thinking");
  is(result.text, "Streamed answer", "The answer reads whole");
  const args = (await fake.read("args.txt")).split("\n");
  ok(args.includes("stream-json") && args.includes("--include-partial-messages") && args.includes("--verbose"), "with stream-json arguments");
  await fake.remove("stream.jsonl");
  WhimsyAIProviders._claudePlanStreams = null;
  Services.prefs.clearUserPref("whimsy.ai.claude-code.stream-probe");
}

// W23: AI is off until the first provider connects, and only that first
// connection turns it on.
add_task(async function ai_off_until_first_connection() {
  const server = new HttpServer();
  server.start(-1);
  const base = `http://localhost:${server.identity.primaryPort}`;
  server.registerPrefixHandler("/gemini/", (request, response) => {
    response.setHeader("content-type", "application/json");
    response.write(JSON.stringify({ models: [{ name: "models/gemini-a", supportedGenerationMethods: ["generateContent"] }] }));
  });
  const { ENDPOINTS } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyAIProviders.sys.mjs");
  const saved = ENDPOINTS.gemini;
  ENDPOINTS.gemini = `${base}/gemini`;
  Services.prefs.clearUserPref("whimsy.ai.enabled");
  Services.prefs.clearUserPref("whimsy.ai.auto-enabled");
  ok(!WhimsyAI.enabled, "Fresh profile: AI is off");
  ok(!WhimsyAIProviders.enabled, "and no provider can be used");
  await WhimsyAIProviders.connectKey("gemini", "AIza" + "Test" + "0003");
  ok(WhimsyAI.enabled, "The first connection turns AI on");
  Services.prefs.setBoolPref("whimsy.ai.enabled", false);
  await WhimsyAIProviders.disconnect("gemini");
  await WhimsyAIProviders.connectKey("gemini", "AIza" + "Test" + "0003");
  ok(!WhimsyAI.enabled, "After the person turns it off, a later connection leaves it off");
  await WhimsyAIProviders.disconnect("gemini");
  ENDPOINTS.gemini = saved;
  await new Promise(r => server.stop(r));
  for (const pref of ["whimsy.ai.auto-enabled", "whimsy.ai.order", "whimsy.ai.gemini.model"]) {
    Services.prefs.clearUserPref(pref);
  }
  Services.prefs.setBoolPref("whimsy.ai.enabled", true);
  await WhimsyAI.pending;
});
