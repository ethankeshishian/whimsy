/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// AI Providers mochitest:
// - Provider picker (Claude / Apple / Ollama / Fake)
// - Claude API key stored in Firefox Login Manager, never in preferences
// - Global AI kill switch blocks all inferences
// - Strict rule: NO automatic cloud fallback

const { WhimsyAI } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyAI.sys.mjs");
const { WhimsyAIProviders } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyAIProviders.sys.mjs");

registerCleanupFunction(async () => {
  Services.prefs.clearUserPref("whimsy.ai.provider");
  Services.prefs.clearUserPref("whimsy.ai.blocked");
  WhimsyAIProviders.setFakeHandler(null);
  await WhimsyAIProviders.setClaudeApiKey("");
});

add_task(async function test_provider_picker() {
  is(WhimsyAIProviders.provider, "apple", "Default provider is apple");

  WhimsyAIProviders.provider = "claude";
  is(Services.prefs.getStringPref("whimsy.ai.provider"), "claude", "Provider changed to claude");

  WhimsyAIProviders.provider = "ollama";
  is(WhimsyAIProviders.provider, "ollama", "Provider changed to ollama");

  WhimsyAIProviders.provider = "fake";
  is(WhimsyAIProviders.provider, "fake", "Provider changed to fake");
});

add_task(async function test_secrets_in_login_manager_never_prefs() {
  const testKey = "sk-ant-test-secret-key-12345";

  // Ensure key is not present in prefs
  ok(!Services.prefs.prefHasUserValue("whimsy.ai.claude.key"), "Key is not in preferences");

  // Save key
  await WhimsyAIProviders.setClaudeApiKey(testKey);

  // Retrieve key
  const retrieved = await WhimsyAIProviders.getClaudeApiKey();
  is(retrieved, testKey, "Key retrieved securely from Firefox Login Manager");

  // Verify again that it was never written to prefs
  ok(!Services.prefs.prefHasUserValue("whimsy.ai.claude.key"), "Key is still not in preferences");

  // Verify via raw Services.logins search
  const logins = await Services.logins.searchLoginsAsync({
    hostname: "chrome://whimsy-ai",
    httpRealm: "Whimsy Claude API",
    username: "claude-api-key",
  });
  is(logins.length, 1, "Exactly one login stored in Login Manager");
  is(logins[0].password, testKey, "Login password matches the secret key");

  // Clear key
  await WhimsyAIProviders.setClaudeApiKey("");
  const empty = await WhimsyAIProviders.getClaudeApiKey();
  is(empty, "", "Key cleared from Login Manager");
});

add_task(async function test_kill_switch_blocks_inference() {
  WhimsyAIProviders.provider = "fake";
  WhimsyAIProviders.setFakeHandler(() => ({ text: "I should not run" }));

  // When AI is blocked
  Services.prefs.setBoolPref(WhimsyAI.PREF, true);
  ok(WhimsyAI.blocked, "Kill switch is active");

  let threw = false;
  try {
    await WhimsyAIProviders.complete({ prompt: "Hello AI" });
  } catch (e) {
    threw = true;
    ok(e.message.includes("blocked by kill switch"), "Error mentions kill switch");
  }
  ok(threw, "complete() threw when AI kill switch was on");

  // Unblock
  Services.prefs.setBoolPref(WhimsyAI.PREF, false);
  ok(!WhimsyAI.blocked, "Kill switch is off");

  const res = await WhimsyAIProviders.complete({ prompt: "Hello AI" });
  is(res.text, "I should not run", "complete() works when unblocked");
});

add_task(async function test_no_automatic_cloud_fallback() {
  // If provider is set to 'apple', it must NOT automatically fall back to Claude or anything else
  WhimsyAIProviders.provider = "apple";
  WhimsyAIProviders.setFakeHandler(null);

  let error = null;
  try {
    await WhimsyAIProviders.complete({ prompt: "Test fallback" });
  } catch (e) {
    error = e;
  }
  ok(error, "Attempting apple without native bridge threw error directly");
  ok(!error.message.includes("claude"), "Did not attempt cloud fallback to Claude");
});

add_task(async function test_fake_provider_mocking() {
  WhimsyAIProviders.provider = "fake";
  WhimsyAIProviders.setFakeHandler(({ prompt, system }) => {
    return { text: `Mocked [${system}] for: ${prompt}` };
  });

  const response = await WhimsyAIProviders.complete({
    system: "sys-prompt",
    prompt: "user-prompt",
  });
  is(response.text, "Mocked [sys-prompt] for: user-prompt", "Fake provider handler returned mock response");
});
