/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */
"use strict";

const { WhimsyAIProviders: P, parseUsageHeaders, parseResetTime, USAGE_PREF, RESTING_PREF } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyAIProviders.sys.mjs");
const { WhimsyAIClaudeCode: Claude } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyAIClaudeCode.sys.mjs");
const { WhimsyAIOpenAIAuth: ChatGPT } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyAIOpenAIAuth.sys.mjs");
const headers = values => new Headers(values);
const response = (status, error, values = {}) => new Response(JSON.stringify({ error }), { status, headers: values });
const at = Date.UTC(2026, 10, 16, 20);

add_setup(async function () {
  await SpecialPowers.pushPrefEnv({ set: [[USAGE_PREF, "{}"], [RESTING_PREF, "{}"], ["whimsy.ai.openai.auth", "key"], ["whimsy.ai.claude.auth", "key"]] });
});

add_task(function codex_windows_are_reported_not_assumed() {
  const limits = parseUsageHeaders("openai", headers({
    "x-codex-primary-used-percent": "82.5", "x-codex-primary-window-minutes": "300", "x-codex-primary-reset-after-seconds": "45",
    "x-codex-secondary-used-percent": "31", "x-codex-secondary-window-minutes": "10080", "x-codex-secondary-reset-at": String(at / 1000 + 900),
  }), "plan", at);
  is(limits.length, 2, "Both windows reported");
  is(limits[0].label, "5-hour limit", "Window duration names the limit");
  is(limits[0].usedPercent, 82.5, "Fractional percentages preserved");
  is(limits[0].resetAt, at + 45000, "Relative reset uses observation time");
  is(limits[1].label, "Weekly limit", "Weekly duration names the limit");
  is(limits[1].resetAt, at + 900000, "Absolute reset is epoch seconds");
  is(parseUsageHeaders("openai", headers({}), "plan", at).length, 0, "No fabricated windows");
  for (const value of ["", "NaN", "-1", "Infinity"]) {
    is(parseUsageHeaders("openai", headers({ "x-codex-primary-used-percent": value, "x-codex-primary-window-minutes": "300" }), "plan", at).length, 0, `Reject ${value}`);
  }
  const noReset = parseUsageHeaders("openai", headers({ "x-codex-primary-used-percent": "0", "x-codex-primary-window-minutes": "300" }), "plan", at);
  is(noReset[0].usedPercent, 0, "Reported zero is valid");
  is(noReset[0].resetAt, null, "No guessed reset");
});

add_task(function api_headers_and_cached_threshold() {
  const anthropic = parseUsageHeaders("claude", headers({ "anthropic-ratelimit-tokens-limit": "1000", "anthropic-ratelimit-tokens-remaining": "200", "anthropic-ratelimit-tokens-reset": "2026-11-16T21:00:00Z" }), "key", at);
  is(anthropic[0].usedPercent, 80, "Anthropic remaining and limit form a percentage");
  is(anthropic[0].resetAt, at + 3600000, "Anthropic ISO reset");
  const openai = parseUsageHeaders("openai", headers({ "x-ratelimit-limit-requests": "100", "x-ratelimit-remaining-requests": "21", "x-ratelimit-reset-requests": "1m30s" }), "key", at);
  is(openai[0].resetAt, at + 90000, "API duration reset");
  P.cacheUsage("openai", openai, "key", at);
  is(P.usage("openai"), null, "API meters hidden below 80 percent");
  P.cacheUsage("openai", [{ ...openai[0], usedPercent: 80 }], "key", at);
  is(P.usage("openai").limits.length, 1, "80 percent is visible");
  is(P.usage("openai").checkedAt, at, "Observation timestamp retained");
  P.observeUsage("openai", headers({}));
  is(P.usage("openai").checkedAt, at, "Missing headers don't refresh the timestamp");
  is(parseUsageHeaders("gemini", headers({}), "key", at).length, 0, "Gemini quota never inferred");
  is(parseUsageHeaders("claude", headers({ "anthropic-ratelimit-tokens-limit": "1000" }), "key", at).length, 0, "Incomplete pair omitted");
  is(P.usage("apple"), null, "Apple unchanged");
  is(P.usage("ollama"), null, "Ollama unchanged");
});

add_task(function claude_code_verified_stream_schema() {
  const reset = at / 1000 + 3600;
  const until = Claude._observeRateLimit({ type: "rate_limit_event", rate_limit_info: {
    status: "rejected", rateLimitType: "five_hour", utilization: 1, resetsAt: reset,
    unifiedWindows: { five_hour: { utilization: 1, resetsAt: reset }, seven_day: { utilization: 0.31, resetsAt: reset + 86400 } },
  } });
  is(until, reset * 1000, "Rejected window supplies the real reset");
  const cached = JSON.parse(Services.prefs.getStringPref(USAGE_PREF))["claude:plan"];
  is(cached.limits.length, 2, "All reported windows cached");
  is(cached.limits.find(l => l.id == "seven_day").usedPercent, 31, "Utilization is a fraction");
  is(Claude._observeRateLimit({ type: "result", usage: { input_tokens: 100 } }), null, "Token usage isn't account quota");
  is(Claude._observeRateLimit({ type: "rate_limit_event", rate_limit_info: { status: "allowed", utilization: 0.5 } }), null, "No named window, no invented limit");
});

add_task(async function error_mapping_and_real_resets() {
  let failure = await P._httpError("claude", response(400, { message: "Your credit balance is too low" }));
  is(failure.code, "credit-used-up", "Anthropic credit is distinct from a plan limit");
  is(P.errorL10n(failure.code, "claude", failure).id, "whimsy-ai-error-credit-used-up", "Credit copy selected");
  failure = await P._httpError("gemini", response(429, { status: "RESOURCE_EXHAUSTED", message: "Quota exceeded: GenerateRequestsPerDayPerProjectPerModel-FreeTier" }));
  is(failure.code, "daily-quota", "Daily Gemini quota named correctly");
  ok(!failure.until, "No guessed midnight");
  failure = await P._httpError("gemini", response(429, { status: "RESOURCE_EXHAUSTED", message: "Quota exceeded: GenerateRequestsPerMinute", details: [{ "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "40s" }] }));
  is(failure.code, "rate-limited", "Minute quota is busy");
  ok(failure.until > Date.now(), "Provider retry delay retained");
  is(P.errorL10n(failure.code, "gemini", failure).id, "whimsy-ai-error-rate-limited-retry", "Retry seconds copy selected");
  failure = await P._httpError("claude", response(429, { message: "rate_limit_error" }, { "retry-after": "40" }));
  const args = P.errorL10n(failure.code, "claude", failure).args;
  ok(args.seconds > 0 && args.seconds <= 40, "Retry-After supplies seconds");
  const reset = Date.now() + 7200000;
  failure = await P._httpError("claude", response(429, { message: "rate_limit_error" }, { "anthropic-ratelimit-tokens-limit": "1000", "anthropic-ratelimit-tokens-remaining": "0", "anthropic-ratelimit-tokens-reset": new Date(reset).toISOString() }));
  is(failure.until, reset, "Exhausted token reset retained");
  P.setResting("claude", { until: failure.until, code: failure.code });
  is(P.resting("claude").until, reset, "Resting uses reported reset");
  P.setResting("claude", { code: "plan-limit" });
  is(P.resting("claude").until, null, "Fallback never becomes a displayed time");
  for (const status of [500, 503, 529]) {
    failure = await P._httpError("claude", response(status, { message: "rate limit overloaded" }, { "retry-after": "40" }));
    is(failure.code, "unavailable", `${status} is an outage`);
    ok(!failure.until, "Outage carries no resting reset");
    is(await ChatGPT._failure(response(status, { code: "subscription_sharing_usage_limit_exceeded" })), "unavailable", "ChatGPT server status wins over a misleading body");
  }
  const plan = P.errorL10n("plan-limit", "openai", { until: reset });
  is(plan.id, "whimsy-ai-error-plan-limit-until", "Plan limit includes known reset");
});

add_task(async function chatgpt_normal_responses_cache_headers_and_limit_resets() {
  const send = ChatGPT._authorized;
  const reset = Math.floor(Date.now() / 1000) + 7200;
  try {
    ChatGPT._authorized = async () => new Response('data: {"type":"response.completed","response":{"output":[]}}\n\n', {
      headers: { "content-type": "text/event-stream", "x-codex-primary-used-percent": "62", "x-codex-primary-window-minutes": "300" },
    });
    await ChatGPT.complete({ prompt: "fixture", model: "fixture-model", signal: new AbortController().signal });
    const cached = JSON.parse(Services.prefs.getStringPref(USAGE_PREF))["openai:plan"];
    is(cached.limits[0].usedPercent, 62, "Ordinary successful request caches plan headers");
    is(cached.limits[0].resetAt, null, "Successful response invents no reset");
    ChatGPT._authorized = async () => response(429, { code: "usage_limit_reached", message: "Usage limit reached" }, {
      "x-codex-primary-used-percent": "100", "x-codex-primary-window-minutes": "300", "x-codex-primary-reset-at": String(reset),
    });
    let failure;
    try {
      await ChatGPT.complete({ prompt: "fixture", model: "fixture-model", signal: new AbortController().signal });
    } catch (e) { failure = e; }
    is(failure?.code, "plan-limit", "Codex usage-limit error is a plan limit");
    is(failure?.until, reset * 1000, "Plan request supplies header reset to the router");
    is(failure?.detail, "Usage limit reached", "Provider's own message retained");
    is(Claude._failure("529 overloaded; rate_limit_error", 1).code, "unavailable", "Claude overload never becomes a plan limit");
  } finally {
    ChatGPT._authorized = send;
  }
});


add_task(function provider_message_resets_are_explicit() {
  is(parseResetTime("Resets in 40 seconds", at), at + 40000, "Seconds in a reset message");
  is(parseResetTime("Resets at 2026-11-16T21:00:00Z", at), at + 3600000, "Absolute reset message");
  is(parseResetTime("Resets 4pm (America/New_York)", at), at + 3600000, "Provider timezone overrides machine timezone");
  is(parseResetTime("Resets 25:10", at), null, "Invalid clock isn't wrapped to a guessed hour");
  is(parseResetTime("Limit reached", at), null, "No message reset means no displayed time");
});
