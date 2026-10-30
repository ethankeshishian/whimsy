/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// AI provider: every Whimsy AI feature asks WhimsyAIProviders, which only
// ever uses the provider picked in Settings (no automatic cloud fallback),
// refuses everything while the AI kill switch is on, aborts requests in
// flight when it goes on, and keeps the Claude API key out of prefs.

const { WhimsyAIProviders, WhimsyAIError } = ChromeUtils.importESModule(
  "resource:///modules/whimsy/WhimsyAIProviders.sys.mjs"
);
const { OSKeyStoreTestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/OSKeyStoreTestUtils.sys.mjs"
);

registerCleanupFunction(async () => {
  WhimsyAIProviders.setTestProvider(null);
  await WhimsyAIProviders.setClaudeKey("");
  for (const pref of ["whimsy.ai.blocked", "whimsy.ai.provider", "whimsy.ai.ollama.model", "whimsy.feature.ai-providers"]) {
    Services.prefs.clearUserPref(pref);
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
  Services.prefs.setBoolPref("whimsy.ai.blocked", true);
  ok(!WhimsyAIProviders.enabled, "The kill switch turns the provider off");
  ok(!(await WhimsyAIProviders.isReady()), "Nothing is ready");
  await rejectsWith(WhimsyAIProviders.complete({ prompt: "x" }), "blocked", "Requests are refused");
  is(calls, 0, "without reaching the provider");
  Services.prefs.clearUserPref("whimsy.ai.blocked");

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
  Services.prefs.setBoolPref("whimsy.ai.blocked", true);
  await rejectsWith(pending, "blocked", "Turning AI off ends a request in flight");
  Services.prefs.clearUserPref("whimsy.ai.blocked");

  const controller = new AbortController();
  const cancelled = WhimsyAIProviders.complete({ prompt: "slow", signal: controller.signal });
  controller.abort();
  await rejectsWith(cancelled, "aborted", "A caller can cancel its own request");
  is(WhimsyAIProviders._inflight.size, 0, "Nothing is left in flight");
});

add_task(async function test_no_cloud_fallback() {
  WhimsyAIProviders.setTestProvider(null);
  // Claude with no key fails right away instead of trying another provider.
  Services.prefs.setStringPref("whimsy.ai.provider", "claude");
  ok(WhimsyAIProviders.isCloud, "Claude is the cloud provider");
  ok(!(await WhimsyAIProviders.isReady()), "Not ready without a key");
  await rejectsWith(WhimsyAIProviders.complete({ prompt: "x" }), "no-key", "No key: an error, not a fallback");

  // Ollama with no model picked fails the same way.
  Services.prefs.setStringPref("whimsy.ai.provider", "ollama");
  ok(!(await WhimsyAIProviders.isReady()), "Ollama isn't ready without a model");
  await rejectsWith(WhimsyAIProviders.complete({ prompt: "x" }), "no-model", "No model: an error, not a fallback");
  Services.prefs.clearUserPref("whimsy.ai.provider");
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
  Services.prefs.setStringPref("whimsy.ai.provider", "claude");
  ok(await WhimsyAIProviders.isReady(), "Claude is ready with a key");
  Services.prefs.clearUserPref("whimsy.ai.provider");
  await WhimsyAIProviders.setClaudeKey("");
  ok(!(await WhimsyAIProviders.hasClaudeKey()), "Removing the key forgets it");
});

add_task(async function test_error_toasts() {
  for (const code of ["no-key", "blocked", "something-new"]) {
    WhimsyAIProviders.showError(window, new WhimsyAIError(code));
  }
  const toasts = () => [...(document.getElementById("zen-toast-container")?.children ?? [])].map(t => t._messageId);
  await TestUtils.waitForCondition(() => toasts().includes("whimsy-ai-error-no-key"), "A missing key says so");
  ok(toasts().includes("whimsy-ai-error-failed"), "An unknown error gets the general message");
  const before = toasts().length;
  WhimsyAIProviders.showError(window, new WhimsyAIError("aborted"));
  is(toasts().length, before, "A cancelled request shows nothing");
});

add_task(async function test_settings_card() {
  await BrowserTestUtils.openNewForegroundTab(gBrowser, "about:preferences#privacy");
  const doc = gBrowser.selectedBrowser.contentDocument;
  const group = await TestUtils.waitForCondition(() => doc.getElementById("whimsyAIProvidersGroup"), "The card is there");
  ok(!group.hidden, "and showing");
  const picker = doc.getElementById("whimsyAIProvider");
  is(picker.value, "apple", "The picker shows the provider");
  ok(!doc.getElementById("whimsyAIAppleRow").hidden, "Apple's status row shows");
  ok(doc.getElementById("whimsyAIClaudeRow").hidden, "Claude's key row doesn't");

  Services.prefs.setStringPref("whimsy.ai.provider", "claude");
  await TestUtils.waitForCondition(() => !doc.getElementById("whimsyAIClaudeRow").hidden, "Picking Claude shows the key row");
  ok(doc.getElementById("whimsyAIAppleRow").hidden, "and hides Apple's");
  is(doc.getElementById("whimsyAIClaudeKey").value, "", "The key field never shows a saved key");

  Services.prefs.setBoolPref("whimsy.ai.blocked", true);
  await TestUtils.waitForCondition(() => group.hidden, "Turning off all AI hides the card");
  Services.prefs.clearUserPref("whimsy.ai.blocked");
  await TestUtils.waitForCondition(() => !group.hidden, "and back");
  Services.prefs.clearUserPref("whimsy.ai.provider");
  BrowserTestUtils.removeTab(gBrowser.selectedTab);
});
