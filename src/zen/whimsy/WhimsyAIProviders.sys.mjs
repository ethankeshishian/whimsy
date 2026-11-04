/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// AI v1: the one provider every Whimsy AI feature talks to (Tidy Tabs, tab
// titles, Ask on Page, 5-second previews, Watch a page). The person picks
// it in Settings → AI (W14 v2: connect each provider once, then pick the
// one to use for AI):
//   - "apple":  Apple's on-device model (Foundation Models, macOS 26+). The
//               framework is Swift-only, so a tiny helper is compiled with
//               the Xcode command line tools on first use and cached in the
//               profile. Nothing leaves the Mac.
//   - "claude": the Claude Messages API with the person's own API key.
//   - "ollama": a local Ollama server.
//   - "openai": OpenAI's Responses API with the person's own API key.
//   - "gemini": Google's Gemini API with the person's own API key.
// Rules (user, Oct 29): only the chosen provider is ever contacted; there's
// no automatic fallback, except the opt-in "use the next one" when a plan
// runs out (whimsy.ai.plan-fallback, W14). The AI kill switch (Enable AI, whimsy.ai.enabled,
// WhimsyAI.sys.mjs) refuses every request and aborts the ones in flight.
// API keys never go into prefs: each is encrypted with OSKeyStore (the
// macOS Keychain) and the ciphertext lives in the profile.

import { clearTimeout, setTimeout } from "resource://gre/modules/Timer.sys.mjs";

const lazy = {};
ChromeUtils.defineLazyGetter(lazy, "l10n", () => new Localization(["browser/whimsy.ftl"], true));
ChromeUtils.defineESModuleGetters(lazy, {
  OSKeyStore: "resource://gre/modules/OSKeyStore.sys.mjs",
  Subprocess: "resource://gre/modules/Subprocess.sys.mjs",
  WhimsyAI: "resource:///modules/whimsy/WhimsyAI.sys.mjs",
});

const FEATURE_PREF = "whimsy.feature.ai-providers";
const PROVIDER_PREF = "whimsy.ai.provider";
const CLAUDE_MODEL_PREF = "whimsy.ai.claude.model";
const OLLAMA_ENDPOINT_PREF = "whimsy.ai.ollama.endpoint";
const OLLAMA_MODEL_PREF = "whimsy.ai.ollama.model";
const OPENAI_MODEL_PREF = "whimsy.ai.openai.model";
const GEMINI_MODEL_PREF = "whimsy.ai.gemini.model";
// W10-28: Settings → AI's Enable AI (WhimsyAI.PREF).
const AI_ENABLED_PREF = "whimsy.ai.enabled";

export const PROVIDERS = ["apple", "claude", "ollama", "openai", "gemini"];
// The providers that send text off the computer.
export const CLOUD_PROVIDERS = ["claude", "openai", "gemini"];
// The providers whose API key Whimsy keeps (whimsy-ai-keys.json, one field
// each, encrypted with OSKeyStore).
export const KEY_PROVIDERS = ["claude", "openai", "gemini"];
const DEFAULT_PROVIDER = "apple";
// W14: Settings → AI's accounts list, top to bottom; "use the next one"
// goes down it from the provider in use.
export const ACCOUNT_ORDER = ["apple", "claude", "openai", "gemini", "ollama"];
// Providers with a subscription path (L7b registers each one's plan).
export const PLAN_PROVIDERS = ["openai", "claude"];
const PLAN_GATES = { openai: "whimsy.feature.ai-openai-plan", claude: "whimsy.feature.ai-claude-plan" };
// How a plan-capable provider is connected: "plan" or "key".
const authPref = provider => `whimsy.ai.${provider}.auth`;
export const PLAN_FALLBACK_PREF = "whimsy.ai.plan-fallback";
const MODEL_PREFS = { claude: CLAUDE_MODEL_PREF, openai: OPENAI_MODEL_PREF, gemini: GEMINI_MODEL_PREF, ollama: OLLAMA_MODEL_PREF };
// Ids of models that don't write text (embeddings, speech, images, ...).
const NOT_TEXT_MODEL = /embed|tts|whisper|dall-e|moderation|image|audio|realtime|transcribe|search|computer-use|davinci|babbage|aqa/i;
// Latest Claude (user: "Default model: latest Claude").
const DEFAULT_CLAUDE_MODEL = "claude-opus-5-5";
// Tests point these at a local server.
export const ENDPOINTS = {
  claude: "https://api.anthropic.com/v1",
  openai: "https://api.openai.com/v1",
  gemini: "https://generativelanguage.googleapis.com/v1beta",
};
const KEY_FILE = "whimsy-ai-keys.json";
const REQUEST_TIMEOUT_MS = 90 * 1000;

// Apple's on-device model has a 4,096-token window shared by the prompt and
// the answer, so its inputs are cut much shorter than the others'.
const MAX_INPUT_CHARS = { apple: 7000, claude: 60000, ollama: 24000, openai: 60000, gemini: 60000, test: 60000 };

// Bump when the Swift source changes so a stale helper is rebuilt.
// 2 (W10-07): helpers built before were quarantined, and macOS remembers
// that it refused to run them even once the flag is gone, so they're
// rebuilt under a new name.
// 3 (W12-F22): exit(0) on completion so the process exits cleanly instead of
// hanging Swift concurrency runtime in proc.wait().
const HELPER_VERSION = 3;
// How long the helper's availability check may take before Whimsy decides
// macOS is holding it back (a quarantined helper hangs at launch).
const HELPER_CHECK_TIMEOUT_MS = 20 * 1000;
// W10-07: toolchains tried before giving up (each build takes seconds).
const MAX_BUILD_ATTEMPTS = 4;
// FoundationModels (Apple's on-device model) needs macOS 26. Below that,
// the SDK's headers still exist (so the helper would build), but the
// framework traps at runtime, so this is checked first.
const MIN_MACOS_VERSION = 26;
// Tests only: pretend to be on this macOS major version instead of asking
// sw_vers, so the OS gate can be exercised without depending on the host.
const MACOS_VERSION_OVERRIDE_PREF = "whimsy.ai.test.macos-version";
const HELPER_SOURCE = String.raw`import Foundation
import FoundationModels

@main
struct WhimsyFM {
  static func main() async {
    let model = SystemLanguageModel.default
    if CommandLine.arguments.contains("--check") {
      switch model.availability {
      case .available:
        print("available")
      case .unavailable(let reason):
        print("unavailable \(reason)")
      }
      exit(0)
    }
    guard case .available = model.availability else {
      FileHandle.standardError.write("unavailable\n".data(using: .utf8)!)
      exit(3)
    }
    let input = FileHandle.standardInput.readDataToEndOfFile()
    guard let object = try? JSONSerialization.jsonObject(with: input) as? [String: Any],
          let prompt = object["prompt"] as? String else {
      exit(2)
    }
    let instructions = object["system"] as? String ?? ""
    let session = LanguageModelSession(instructions: instructions)
    do {
      let response = try await session.respond(to: prompt)
      FileHandle.standardOutput.write(response.content.data(using: .utf8)!)
      exit(0)
    } catch {
      FileHandle.standardError.write("\(error)\n".data(using: .utf8)!)
      exit(1)
    }
  }
}
`;

// Errors carry a code the UI turns into a string (whimsy-ai-error-<code>).
export class WhimsyAIError extends Error {
  constructor(code, message = code) {
    super(message);
    this.name = "WhimsyAIError";
    this.code = code;
  }
}

// Every code has a toast string, whimsy-ai-error-<code>.
export const AI_ERROR_CODES = [
  "blocked",
  "no-key",
  "bad-key",
  "rate-limited",
  "network",
  "unavailable",
  "no-model",
  "apple-needs-tools",
  // fix7: what exactly is missing when the helper can't be built.
  "apple-tools-outdated",
  // W10-07: the Swift compiler is older than the SDK it was given.
  "apple-tools-mismatch",
  "apple-tools-path-invalid",
  "apple-needs-license",
  "apple-build-failed",
  // W10-07: macOS wouldn't start the helper.
  "apple-helper-blocked",
  // W13-B11: the helper started but crashed (a signal other than SIGKILL)
  // before saying anything, usually because this Mac can't run the model.
  "apple-helper-crashed",
  // W13-B11: Apple's on-device model needs macOS 26+; older Macs never
  // reach the helper (no build is even attempted).
  "apple-unavailable-os",
  "apple-intelligence-off",
  "apple-not-ready",
  "apple-not-set-up",
  "refused",
  // W14: a subscription plan's share ran out, or its sign-in ended.
  "plan-limit",
  "signed-out",
  "bad-response",
  "timeout",
  "failed",
];

export const WhimsyAIProviders = {
  // Tests only: a fake provider, (request) => text or Promise<text>.
  _testProvider: null,
  _inflight: new Set(),
  _observing: false,
  _helperPromise: null,
  _helperCheckTimeoutMs: HELPER_CHECK_TIMEOUT_MS,
  _appleReady: null,
  // W10-07: more about the last Apple status, shown in Settings: what the
  // Swift compiler said when the helper failed to build, or the folders
  // searched when no usable tools were found ("" otherwise).
  appleDetail: "",
  _macOSVersionCache: null,

  get enabled() {
    return Services.prefs.getBoolPref(FEATURE_PREF, true) && !lazy.WhimsyAI.blocked;
  },

  get provider() {
    if (this._testProvider) {
      return "test";
    }
    const value = Services.prefs.getStringPref(PROVIDER_PREF, DEFAULT_PROVIDER);
    return PROVIDERS.includes(value) ? value : DEFAULT_PROVIDER;
  },

  // Whether text leaves the computer with the current provider. Automatic
  // features (tab titles, search-page previews) skip private tabs then.
  get isCloud() {
    return CLOUD_PROVIDERS.includes(this.provider);
  },

  get maxInputChars() {
    return MAX_INPUT_CHARS[this.provider] ?? 20000;
  },

  // A provider's name as Settings and the errors say it.
  providerName(provider = this.provider) {
    return lazy.l10n.formatValueSync(`whimsy-ai-name-${PROVIDERS.includes(provider) ? provider : "other"}`);
  },

  // The string for an error code, with the provider it came from.
  errorL10n(code, provider = this.provider) {
    return {
      id: `whimsy-ai-error-${AI_ERROR_CODES.includes(code) ? code : "failed"}`,
      args: { provider: this.providerName(provider) },
    };
  },

  // The toast for a failed request (nothing when the person cancelled). A
  // spent plan gets one action, Manage usage.
  showError(win, error) {
    const code = error?.code;
    if (code == "aborted" || !win?.gZenUIManager) {
      return;
    }
    const { id, args } = this.errorL10n(code, error?.provider);
    if (code == "plan-limit" && win.gZenUIManager.toasts) {
      win.gZenUIManager.toasts.open(id, {
        key: "whimsy-ai-plan-limit",
        l10nArgs: args,
        descriptionId: "whimsy-ai-error-plan-limit-detail",
        buttons: [{ l10nId: "whimsy-ai-manage-usage", command: () => this.manageUsage(win, error?.provider) }],
      });
      return;
    }
    win.gZenUIManager.showToast(id, { l10nArgs: args });
  },

  // ---- Accounts (W14 v2: connect once, disconnect, use for AI) ----

  // L7b's plan sign-ins: { connect(win), disconnect(), status(), complete(request), isReady(), manageUsage?(win) }.
  _plans: {},

  registerPlan(provider, plan) {
    if (!PLAN_PROVIDERS.includes(provider)) {
      throw new Error(`No plan for ${provider}`);
    }
    this._plans[provider] = plan || null;
    Services.obs.notifyObservers(null, "whimsy-ai-accounts-changed", provider);
  },

  // Whether Settings can offer a provider's plan (its feature gate is on and
  // its sign-in is built in).
  planAvailable(provider) {
    return !!(PLAN_GATES[provider] && Services.prefs.getBoolPref(PLAN_GATES[provider], false) && this._plans[provider]);
  },

  anyPlanAvailable() {
    return PLAN_PROVIDERS.some(provider => this.planAvailable(provider));
  },

  _usesPlan(provider) {
    return this.planAvailable(provider) && Services.prefs.getStringPref(authPref(provider), "") == "plan";
  },

  // The provider in use when it's connected through a plan, else null
  // ("Using ChatGPT plan" in the Ask on Page card and Settings).
  get planInUse() {
    const provider = this.provider;
    return this._usesPlan(provider) ? provider : null;
  },

  // Opens Settings → AI; a plan's own usage page when it has one.
  manageUsage(win, provider = this.planInUse) {
    const plan = provider && this._plans[provider];
    if (plan?.manageUsage) {
      plan.manageUsage(win);
      return;
    }
    this.openSettings(win);
  },

  // Settings → AI, optionally doing one thing there ("connect": the list
  // of providers to connect; "use": the Use for AI picker).
  openSettings(win, action = null) {
    this.pendingSettingsAction = action;
    win?.openPreferences?.("paneWhimsyAI");
    Services.obs.notifyObservers(null, "whimsy-ai-settings-action", action ?? "");
  },

  pendingSettingsAction: null,

  takeSettingsAction() {
    const action = this.pendingSettingsAction;
    this.pendingSettingsAction = null;
    return action;
  },

  /**
   * How a provider is connected, or null.
   *
   * @returns {Promise<{ method: "plan" | "key" | "local", label?: string } | null>}
   */
  async connection(provider) {
    if (this._usesPlan(provider)) {
      try {
        const status = await this._plans[provider].status();
        if (status?.connected) {
          return { method: "plan", label: status.label ?? "", signedOut: !!status.signedOut };
        }
      } catch (error) {
        console.error(`Whimsy AI: the ${provider} plan's status`, error);
      }
      return null;
    }
    switch (provider) {
      case "apple":
        return (await IOUtils.exists(this._helperPath)) ? { method: "local" } : null;
      case "ollama":
        return Services.prefs.getStringPref(OLLAMA_MODEL_PREF, "") ? { method: "local" } : null;
      default:
        return KEY_PROVIDERS.includes(provider) && (await this.hasKey(provider)) ? { method: "key" } : null;
    }
  },

  async connectedProviders() {
    const connected = [];
    for (const provider of ACCOUNT_ORDER) {
      if (await this.connection(provider)) {
        connected.push(provider);
      }
    }
    return connected;
  },

  // The last four characters of a saved key, to tell keys apart.
  async keyHint(provider) {
    const key = await this.getKey(provider);
    return key.length > 8 ? key.slice(-4) : "";
  },

  /**
   * Connects a provider with an API key: checks it (by listing the models
   * it can use; Claude's too), saves it and picks the first model when none
   * is picked. A key the service turns down isn't saved.
   */
  async connectKey(provider, key) {
    const value = String(key ?? "").trim();
    if (!value) {
      throw new WhimsyAIError("no-key");
    }
    await this.setKey(provider, value);
    let models;
    try {
      models = await this.listModels(provider);
    } catch (error) {
      if (error?.code == "bad-key") {
        await this.setKey(provider, "");
      }
      throw error;
    }
    if (PLAN_PROVIDERS.includes(provider)) {
      Services.prefs.setStringPref(authPref(provider), "key");
    }
    if (provider != "claude" && models.length && !Services.prefs.getStringPref(MODEL_PREFS[provider], "")) {
      Services.prefs.setStringPref(MODEL_PREFS[provider], models[0]);
    }
    Services.obs.notifyObservers(null, "whimsy-ai-accounts-changed", provider);
    return models;
  },

  // Signs a provider's plan in (L7b's sign-in does the work).
  async connectPlan(win, provider) {
    if (!this.planAvailable(provider)) {
      throw new WhimsyAIError("unavailable");
    }
    const result = await this._plans[provider].connect(win);
    Services.prefs.setStringPref(authPref(provider), "plan");
    Services.obs.notifyObservers(null, "whimsy-ai-accounts-changed", provider);
    return result;
  },

  // Connects Ollama at an address: it has to answer with at least one model.
  async connectOllama(endpoint) {
    const address = String(endpoint ?? "").trim();
    const previous = Services.prefs.getStringPref(OLLAMA_ENDPOINT_PREF, "");
    Services.prefs.setStringPref(OLLAMA_ENDPOINT_PREF, address);
    let models = [];
    try {
      models = await this.ollamaModels();
    } catch {}
    if (!models.length) {
      Services.prefs.setStringPref(OLLAMA_ENDPOINT_PREF, previous);
      throw new WhimsyAIError("unavailable");
    }
    const current = Services.prefs.getStringPref(OLLAMA_MODEL_PREF, "");
    if (!models.includes(current)) {
      Services.prefs.setStringPref(OLLAMA_MODEL_PREF, models[0]);
    }
    Services.obs.notifyObservers(null, "whimsy-ai-accounts-changed", "ollama");
    return models;
  },

  /**
   * Disconnects a provider: a plan is signed out (and its token revoked),
   * a key is deleted from this Mac, Apple's helper is removed and Ollama's
   * model forgotten. The provider in use stays picked (AI features wait
   * until another one is picked); nothing switches by itself.
   */
  async disconnect(provider) {
    if (this._usesPlan(provider)) {
      await this._plans[provider].disconnect();
      Services.prefs.clearUserPref(authPref(provider));
    }
    if (KEY_PROVIDERS.includes(provider)) {
      await this.setKey(provider, "");
      Services.prefs.clearUserPref(authPref(provider));
      Services.prefs.clearUserPref(MODEL_PREFS[provider]);
    } else if (provider == "apple") {
      await IOUtils.remove(this._helperPath, { ignoreAbsent: true });
      this._helperPromise = null;
      this._appleReady = null;
    } else if (provider == "ollama") {
      Services.prefs.clearUserPref(OLLAMA_MODEL_PREF);
      Services.prefs.clearUserPref(OLLAMA_ENDPOINT_PREF);
    }
    Services.obs.notifyObservers(null, "whimsy-ai-accounts-changed", provider);
  },

  // The models a connected provider offers, for Settings' model picker.
  async models(provider) {
    if (provider == "ollama") {
      return this.ollamaModels();
    }
    if (this._usesPlan(provider)) {
      return (await this._plans[provider].models?.()) ?? [];
    }
    return this.listModels(provider);
  },

  modelOf(provider) {
    if (provider == "claude") {
      return this.claudeModel;
    }
    return MODEL_PREFS[provider] ? Services.prefs.getStringPref(MODEL_PREFS[provider], "") : "";
  },

  setModel(provider, model) {
    if (MODEL_PREFS[provider]) {
      Services.prefs.setStringPref(MODEL_PREFS[provider], String(model ?? ""));
    }
  },

  // "Use the next one": the next connected provider down the accounts list.
  async nextProvider(provider) {
    const connected = await this.connectedProviders();
    const start = ACCOUNT_ORDER.indexOf(provider);
    for (let i = 1; i < ACCOUNT_ORDER.length; i++) {
      const next = ACCOUNT_ORDER[(start + i) % ACCOUNT_ORDER.length];
      if (connected.includes(next)) {
        return next;
      }
    }
    return null;
  },

  setTestProvider(fn) {
    if (fn && !Cu.isInAutomation) {
      throw new Error("The test provider is for automated tests only");
    }
    this._testProvider = fn || null;
  },

  // Ends every request in flight the moment the kill switch goes on.
  _observe() {
    if (this._observing) {
      return;
    }
    this._observing = true;
    const abortAll = () => {
      if (!this.enabled) {
        for (const controller of this._inflight) {
          controller.abort(new WhimsyAIError("blocked"));
        }
      }
    };
    Services.prefs.addObserver(AI_ENABLED_PREF, abortAll);
    Services.prefs.addObserver(FEATURE_PREF, abortAll);
  },

  /**
   * One completion from the chosen provider. Never falls back to another.
   *
   * @param {object} request
   * @param {string} request.prompt
   * @param {string} [request.system]
   * @param {number} [request.maxTokens]
   * @param {AbortSignal} [request.signal]
   * @returns {Promise<string>} The answer's text.
   */
  async complete({ prompt, system = "", maxTokens = 1024, signal } = {}) {
    if (!this.enabled) {
      throw new WhimsyAIError("blocked");
    }
    this._observe();
    const controller = new AbortController();
    const onAbort = () => controller.abort(signal.reason);
    if (signal?.aborted) {
      throw new WhimsyAIError("aborted");
    }
    signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => controller.abort(new WhimsyAIError("timeout")), REQUEST_TIMEOUT_MS);
    this._inflight.add(controller);
    const request = { prompt: String(prompt ?? ""), system, maxTokens, signal: controller.signal };
    try {
      const provider = this.provider;
      let text;
      try {
        text = await this._dispatch(provider, request);
      } catch (error) {
        // W14: opt-in "use the next one" when a plan runs out; this request
        // only, never for anything else.
        if (error?.code != "plan-limit" || controller.signal.aborted ||
            !Services.prefs.getBoolPref(PLAN_FALLBACK_PREF, false)) {
          throw error;
        }
        const next = await this.nextProvider(provider);
        if (!next || next == provider) {
          throw error;
        }
        text = await this._dispatch(next, request);
        this.lastFallback = { from: provider, to: next };
        Services.obs.notifyObservers(null, "whimsy-ai-plan-fallback", JSON.stringify(this.lastFallback));
      }
      // The switch may have gone on while the answer was on its way.
      if (!this.enabled) {
        throw new WhimsyAIError("blocked");
      }
      return String(text ?? "").trim();
    } catch (error) {
      if (controller.signal.aborted) {
        const reason = controller.signal.reason;
        throw reason instanceof WhimsyAIError ? reason : new WhimsyAIError("aborted");
      }
      throw error instanceof WhimsyAIError ? error : new WhimsyAIError("failed", String(error?.message || error));
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      this._inflight.delete(controller);
    }
  },

  lastFallback: null,

  // One request to one provider (a plan's own sign-in when it's connected
  // that way).
  async _dispatch(provider, request) {
    if (this._usesPlan(provider)) {
      try {
        return await this._plans[provider].complete(request);
      } catch (error) {
        if (error instanceof WhimsyAIError && !error.provider) {
          error.provider = provider;
        }
        throw error;
      }
    }
    switch (provider) {
      case "test":
        return Promise.race([this._testProvider(request), aborted(request.signal)]);
      case "claude":
        return this._claude(request);
      case "ollama":
        return this._ollama(request);
      case "openai":
        return this._openai(request);
      case "gemini":
        return this._gemini(request);
      default:
        return this._apple(request);
    }
  },

  /**
   * Whether the chosen provider is set up, without setting anything up
   * (never builds the Apple helper or contacts a server). Automatic features
   * (tab titles, search-page previews, watches) wait for this, so nothing
   * happens on its own until the person has picked and set up a provider.
   *
   * @returns {Promise<boolean>}
   */
  async isReady() {
    if (!this.enabled) {
      return false;
    }
    switch (this.provider) {
      case "test":
        return true;
    }
    if (this._usesPlan(this.provider)) {
      try {
        return !!(await this._plans[this.provider].isReady());
      } catch {
        return false;
      }
    }
    switch (this.provider) {
      case "claude":
      case "openai":
      case "gemini":
        return this.hasKey(this.provider);
      case "ollama":
        return !!Services.prefs.getStringPref(OLLAMA_MODEL_PREF, "");
      default:
        if (!(await IOUtils.exists(this._helperPath))) {
          return false;
        }
        this._appleReady ??= this.appleStatus().then(status => status == "available");
        return this._appleReady;
    }
  },

  // Asks for JSON and parses the first object or array in the answer.
  async completeJSON(request) {
    const text = await this.complete(request);
    const match = text.match(/[[{][\s\S]*[\]}]/);
    if (!match) {
      throw new WhimsyAIError("bad-response");
    }
    try {
      return JSON.parse(match[0]);
    } catch {
      throw new WhimsyAIError("bad-response");
    }
  },

  // Cuts page text to what the provider can take.
  clip(text, share = 1) {
    const max = Math.floor(this.maxInputChars * share);
    const value = String(text ?? "");
    return value.length > max ? value.slice(0, max) : value;
  },

  // ---- Claude ----

  get claudeModel() {
    return Services.prefs.getStringPref(CLAUDE_MODEL_PREF, "") || DEFAULT_CLAUDE_MODEL;
  },

  async _claude({ prompt, system, maxTokens, signal }) {
    const key = await this.getClaudeKey();
    if (!key) {
      throw new WhimsyAIError("no-key");
    }
    const body = {
      model: this.claudeModel,
      // Room for adaptive thinking on top of the short answers we ask for.
      max_tokens: Math.max(2048, maxTokens * 2),
      // Short, simple tasks: low effort keeps them quick and cheap.
      output_config: { effort: "low" },
      messages: [{ role: "user", content: prompt }],
    };
    if (system) {
      body.system = system;
    }
    let response;
    try {
      response = await fetch(`${ENDPOINTS.claude}/messages`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": key,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify(body),
        credentials: "omit",
        signal,
      });
    } catch (error) {
      if (signal.aborted) {
        throw error;
      }
      throw new WhimsyAIError("network");
    }
    if (response.status == 401 || response.status == 403) {
      throw new WhimsyAIError("bad-key");
    }
    if (response.status == 429) {
      throw new WhimsyAIError("rate-limited");
    }
    if (!response.ok) {
      throw new WhimsyAIError("failed", `Claude API ${response.status}`);
    }
    const data = await response.json();
    if (data.stop_reason == "refusal") {
      throw new WhimsyAIError("refused");
    }
    return (data.content || [])
      .filter(block => block.type == "text")
      .map(block => block.text)
      .join("");
  },

  get _keyPath() {
    return PathUtils.join(PathUtils.profileDir, KEY_FILE);
  },

  async _readKeys() {
    try {
      const saved = await IOUtils.readJSON(this._keyPath);
      return saved && typeof saved == "object" ? saved : {};
    } catch {
      return {};
    }
  },

  async hasKey(provider) {
    return !!(await this._readKeys())[provider];
  },

  async getKey(provider) {
    const saved = (await this._readKeys())[provider];
    if (!saved) {
      return "";
    }
    try {
      return await lazy.OSKeyStore.decrypt(saved);
    } catch (error) {
      console.error(`Whimsy AI: couldn't decrypt the ${provider} API key`, error);
      return "";
    }
  },

  // Saves (or, with an empty key, forgets) one provider's API key; the
  // others' stay as they are.
  async setKey(provider, key) {
    if (!KEY_PROVIDERS.includes(provider)) {
      throw new Error(`No API key for ${provider}`);
    }
    const value = String(key ?? "").trim();
    const saved = await this._readKeys();
    if (value) {
      // Creates the Keychain secret on first use; no prompt (reauth = false).
      await lazy.OSKeyStore.ensureLoggedIn(false);
      saved[provider] = await lazy.OSKeyStore.encrypt(value);
    } else {
      delete saved[provider];
    }
    if (!Object.keys(saved).length) {
      await IOUtils.remove(this._keyPath, { ignoreAbsent: true });
      return;
    }
    await IOUtils.writeJSON(this._keyPath, saved, { tmpPath: this._keyPath + ".tmp" });
  },

  hasClaudeKey() {
    return this.hasKey("claude");
  },

  getClaudeKey() {
    return this.getKey("claude");
  },

  setClaudeKey(key) {
    return this.setKey("claude", key);
  },

  // ---- OpenAI (API key; the Responses API) ----

  async _openai({ prompt, system, maxTokens, signal }) {
    const key = await this.getKey("openai");
    if (!key) {
      throw new WhimsyAIError("no-key");
    }
    const model = Services.prefs.getStringPref(OPENAI_MODEL_PREF, "");
    if (!model) {
      throw new WhimsyAIError("no-model");
    }
    const body = {
      model,
      input: prompt,
      max_output_tokens: Math.max(2048, maxTokens * 2),
      // Nothing is kept on OpenAI's side.
      store: false,
    };
    if (system) {
      body.instructions = system;
    }
    const response = await this._post(`${ENDPOINTS.openai}/responses`, { authorization: `Bearer ${key}` }, body, signal);
    if (response.status == 401 || response.status == 403) {
      throw new WhimsyAIError("bad-key");
    }
    if (response.status == 404) {
      throw new WhimsyAIError("no-model");
    }
    if (response.status == 429) {
      throw new WhimsyAIError("rate-limited");
    }
    if (!response.ok) {
      throw new WhimsyAIError("failed", `OpenAI API ${response.status}`);
    }
    const data = await response.json();
    const parts = (data.output || []).flatMap(item => (item.type == "message" ? item.content || [] : []));
    if (parts.some(part => part.type == "refusal")) {
      throw new WhimsyAIError("refused");
    }
    return parts.filter(part => part.type == "output_text").map(part => part.text).join("");
  },

  // ---- Gemini (API key; the Generative Language API) ----

  async _gemini({ prompt, system, maxTokens, signal }) {
    const key = await this.getKey("gemini");
    if (!key) {
      throw new WhimsyAIError("no-key");
    }
    const model = Services.prefs.getStringPref(GEMINI_MODEL_PREF, "");
    if (!model) {
      throw new WhimsyAIError("no-model");
    }
    const body = {
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: { maxOutputTokens: Math.max(2048, maxTokens * 2) },
    };
    if (system) {
      body.systemInstruction = { parts: [{ text: system }] };
    }
    // The key goes in a header, never the address (logs, history).
    const url = `${ENDPOINTS.gemini}/models/${encodeURIComponent(model.replace(/^models\//, ""))}:generateContent`;
    const response = await this._post(url, { "x-goog-api-key": key }, body, signal);
    if (response.status == 400 || response.status == 401 || response.status == 403) {
      let reason = "";
      try {
        reason = JSON.stringify((await response.json())?.error ?? "");
      } catch {}
      throw new WhimsyAIError(response.status == 400 && !/API_KEY_INVALID/.test(reason) ? "failed" : "bad-key");
    }
    if (response.status == 404) {
      throw new WhimsyAIError("no-model");
    }
    if (response.status == 429) {
      throw new WhimsyAIError("rate-limited");
    }
    if (!response.ok) {
      throw new WhimsyAIError("failed", `Gemini API ${response.status}`);
    }
    const data = await response.json();
    const candidate = data.candidates?.[0];
    if (!candidate || candidate.finishReason == "SAFETY" || data.promptFeedback?.blockReason) {
      throw new WhimsyAIError("refused");
    }
    return (candidate.content?.parts || []).map(part => part.text ?? "").join("");
  },

  // A JSON POST that never carries cookies; a failed connection is
  // "network" (an abort passes through).
  async _post(url, headers, body, signal) {
    try {
      return await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(body),
        credentials: "omit",
        signal,
      });
    } catch (error) {
      if (signal.aborted) {
        throw error;
      }
      throw new WhimsyAIError("network");
    }
  },

  // The models a key can use, for the Settings picker.
  async listModels(provider) {
    const key = await this.getKey(provider);
    if (!key) {
      throw new WhimsyAIError("no-key");
    }
    const [url, headers] = {
      claude: [`${ENDPOINTS.claude}/models?limit=100`, { "x-api-key": key, "anthropic-version": "2023-06-01" }],
      openai: [`${ENDPOINTS.openai}/models`, { authorization: `Bearer ${key}` }],
      gemini: [`${ENDPOINTS.gemini}/models?pageSize=1000`, { "x-goog-api-key": key }],
    }[provider];
    let response;
    try {
      response = await fetch(url, { headers, credentials: "omit" });
    } catch {
      throw new WhimsyAIError("network");
    }
    if (response.status == 401 || response.status == 403 || response.status == 400) {
      throw new WhimsyAIError("bad-key");
    }
    if (!response.ok) {
      throw new WhimsyAIError("failed", `${provider} models ${response.status}`);
    }
    const data = await response.json();
    const text = id => !!id && !NOT_TEXT_MODEL.test(id);
    if (provider == "claude") {
      // Newest first already.
      return (data.data || []).map(m => m.id).filter(text);
    }
    if (provider == "openai") {
      // Newest first, so the first one (the default) is the latest model.
      return (data.data || [])
        .map((m, i) => ({ id: m.id, created: Number(m.created) || 0, i }))
        .sort((a, b) => b.created - a.created || a.i - b.i)
        .map(m => m.id)
        .filter(text);
    }
    return (data.models || [])
      .filter(m => (m.supportedGenerationMethods || []).includes("generateContent"))
      .map(m => String(m.name || "").replace(/^models\//, ""))
      .filter(text);
  },

  // ---- Ollama ----

  get ollamaEndpoint() {
    return (Services.prefs.getStringPref(OLLAMA_ENDPOINT_PREF, "") || "http://127.0.0.1:11434").replace(/\/+$/, "");
  },

  async _ollama({ prompt, system, signal }) {
    const model = Services.prefs.getStringPref(OLLAMA_MODEL_PREF, "");
    if (!model) {
      throw new WhimsyAIError("no-model");
    }
    const messages = [];
    if (system) {
      messages.push({ role: "system", content: system });
    }
    messages.push({ role: "user", content: prompt });
    let response;
    try {
      response = await fetch(`${this.ollamaEndpoint}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model, messages, stream: false }),
        credentials: "omit",
        signal,
      });
    } catch (error) {
      if (signal.aborted) {
        throw error;
      }
      throw new WhimsyAIError("unavailable");
    }
    if (response.status == 404) {
      throw new WhimsyAIError("no-model");
    }
    if (!response.ok) {
      throw new WhimsyAIError("failed", `Ollama ${response.status}`);
    }
    const data = await response.json();
    return data.message?.content ?? "";
  },

  // The models the local Ollama server has, for the Settings picker.
  async ollamaModels() {
    const response = await fetch(`${this.ollamaEndpoint}/api/tags`, { credentials: "omit" });
    if (!response.ok) {
      throw new WhimsyAIError("unavailable");
    }
    const data = await response.json();
    return (data.models || []).map(m => m.name).filter(Boolean);
  },

  // ---- Apple on-device ----

  get _helperPath() {
    return PathUtils.join(PathUtils.profileDir, "whimsy-ai", `whimsy-fm-${HELPER_VERSION}`);
  },

  // fix7: Settings said the command line tools were missing on a Mac where
  // "xcode-select --install" says they're installed. The old check only
  // looked in the folder xcode-select points at (often an Xcode that was
  // moved, renamed or deleted, while the tools sit in
  // /Library/Developer/CommandLineTools), and any failed build (tools too
  // old to have the FoundationModels SDK, Xcode's license not accepted)
  // was reported as "tools missing" too. Now each developer folder is
  // checked for swiftc and for an SDK with FoundationModels, the build
  // uses the folder that has both, and each failure says what's missing.
  _developerDirCandidates: ["/Library/Developer/CommandLineTools", "/Applications/Xcode.app/Contents/Developer"],

  // Runs a tool (never one that prompts) and returns { exitCode, output }.
  async _run(command, args, options = {}) {
    const proc = await lazy.Subprocess.call({ command, arguments: args, stderr: "stdout", ...options });
    const output = await proc.stdout.readString();
    const { exitCode } = await proc.wait();
    return { exitCode, output };
  },

  // The macOS major version (e.g. 26 for Tahoe), or null off Darwin or if it
  // can't be read. Services.sysinfo's "version" is the Darwin kernel release
  // (uname -r), not the macOS product version the two no longer track with a
  // fixed offset, so this asks sw_vers directly, like _run asks xcode-select.
  // Cached: it can't change while Whimsy runs. Tests override the pref
  // instead of mocking sw_vers, so they don't depend on the host Mac.
  async _macOSVersion() {
    const testVersion = Services.prefs.getIntPref(MACOS_VERSION_OVERRIDE_PREF, 0);
    if (testVersion) {
      return testVersion;
    }
    if (Services.appinfo.OS != "Darwin") {
      return null;
    }
    if (this._macOSVersionCache != null) {
      return this._macOSVersionCache;
    }
    try {
      const { exitCode, output } = await this._run("/usr/bin/sw_vers", ["-productVersion"]);
      const major = exitCode == 0 ? parseInt(output.trim(), 10) : NaN;
      this._macOSVersionCache = Number.isNaN(major) ? null : major;
    } catch (e) {
      console.error("Whimsy AI: reading the macOS version", e);
      this._macOSVersionCache = null;
    }
    return this._macOSVersionCache;
  },

  // The SDK folders a developer folder may have (command line tools, Xcode).
  _sdkPaths(dir) {
    return [
      PathUtils.join(dir, "SDKs", "MacOSX.sdk"),
      PathUtils.join(dir, "Platforms", "MacOSX.platform", "Developer", "SDKs", "MacOSX.sdk"),
    ];
  },

  // W10-07: every macOS SDK in a developer folder, the default first
  // (MacOSX.sdk, the one its compiler came with), then the versioned ones
  // newest first. Software Update can leave several (MacOSX26.5.sdk,
  // MacOSX27.0.sdk...) and move MacOSX.sdk to one the compiler can't read.
  async _allSdks(dir) {
    const sdks = [];
    for (const defaultSdk of this._sdkPaths(dir)) {
      const folder = PathUtils.parent(defaultSdk);
      let names = [];
      try {
        names = (await IOUtils.getChildren(folder)).map(child => PathUtils.filename(child));
      } catch {
        continue;
      }
      const version = name => (name.match(/^MacOSX([\d.]+)\.sdk$/)?.[1] ?? "").split(".").map(Number);
      const versioned = names
        .filter(name => /^MacOSX[\d.]+\.sdk$/.test(name))
        .sort((a, b) => {
          const [va, vb] = [version(a), version(b)];
          for (let i = 0; i < Math.max(va.length, vb.length); i++) {
            if ((va[i] ?? 0) != (vb[i] ?? 0)) {
              return (vb[i] ?? 0) - (va[i] ?? 0);
            }
          }
          return 0;
        });
      for (const name of [...(names.includes("MacOSX.sdk") ? ["MacOSX.sdk"] : []), ...versioned]) {
        sdks.push(PathUtils.join(folder, name));
      }
    }
    return sdks;
  },

  // Finds the tools to build the helper with: { developerDir, sdk } or a
  // WhimsyAIError code: "apple-needs-tools" (no swiftc anywhere) or
  // "apple-tools-outdated" (swiftc, but no SDK with FoundationModels).
  // Never runs xcrun: without the tools it pops up macOS's install dialog.
  async _findToolchain() {
    const found = await this._findToolchains();
    if (typeof found == "string") {
      return found;
    }
    const [{ developerDir, sdk }] = found;
    return { developerDir, sdk };
  },

  // W10-07: every way to build the helper, best first: [{ developerDir,
  // swiftc, sdk }], or the code above. The folder xcode-select picks comes
  // first, then the command line tools, then Xcode; in each, every SDK
  // with FoundationModels. One that fails to build (an SDK newer than its
  // compiler, an Xcode that needs its first launch) falls back to the next.
  async _findToolchains() {
    const dirs = [];
    try {
      const { exitCode, output } = await this._run("/usr/bin/xcode-select", ["-p"]);
      if (exitCode == 0 && output.trim()) {
        dirs.push(output.trim());
      }
    } catch {}
    for (const dir of this._developerDirCandidates) {
      if (!dirs.includes(dir)) {
        dirs.push(dir);
      }
    }
    let hasSwiftc = false;
    const toolchains = [];
    for (const developerDir of dirs) {
      let swiftc = null;
      for (const rel of ["usr/bin/swiftc", "Toolchains/XcodeDefault.xctoolchain/usr/bin/swiftc"]) {
        const candidate = PathUtils.join(developerDir, ...rel.split("/"));
        if (!swiftc && (await IOUtils.exists(candidate))) {
          swiftc = candidate;
        }
      }
      if (!swiftc) {
        continue;
      }
      hasSwiftc = true;
      for (const sdk of await this._allSdks(developerDir)) {
        if (await IOUtils.exists(PathUtils.join(sdk, "System", "Library", "Frameworks", "FoundationModels.framework"))) {
          toolchains.push({ developerDir, swiftc, sdk });
        }
      }
    }
    if (toolchains.length) {
      return toolchains;
    }
    // Settings names the folders searched.
    this.appleDetail = dirs.join(", ");
    return hasSwiftc ? "apple-tools-outdated" : "apple-needs-tools";
  },

  // W10-07: Whimsy's Info.plist has LSFileQuarantineEnabled (as Firefox's
  // does), so every file the browser or a tool it runs writes is flagged
  // com.apple.quarantine, the helper swiftc links included. macOS won't
  // launch an ad-hoc-signed quarantined executable: it hangs at dyld start
  // (or is killed), so Set Up never finished even though the tools were
  // there. The helper is our own build, so drop the flag before it runs.
  async _unquarantine(path) {
    if (Services.appinfo.OS != "Darwin") {
      return;
    }
    try {
      if (await IOUtils.hasMacXAttr(path, "com.apple.quarantine")) {
        await IOUtils.delMacXAttr(path, "com.apple.quarantine");
      }
    } catch (e) {
      console.error("Whimsy AI: couldn't clear the helper's quarantine flag", e);
    }
  },

  // W10-07: the compiler's own words, for Settings: its first error line
  // (or last line), without the source path.
  _buildDetail(output) {
    const lines = (output ?? "").split("\n").map(line => line.trim()).filter(Boolean);
    const line = lines.find(l => /\berror:/i.test(l)) ?? lines.at(-1) ?? "";
    return line.replace(/^\S*WhimsyFM\.swift:\d+:\d+:\s*/, "").slice(0, 300);
  },

  // What a failed swiftc build means, from its output.
  _buildFailure(output) {
    if (/license/i.test(output)) {
      return "apple-needs-license";
    }
    if (/SDK is not supported by the compiler|select a toolchain which matches the SDK|compiled with a newer version of the compiler|module compiled with Swift [\d.]+ cannot be imported/i.test(output)) {
      return "apple-tools-mismatch";
    }
    if (/no such module ['"]FoundationModels['"]|cannot find ['"]SystemLanguageModel['"]|cannot find ['"]LanguageModelSession['"]/i.test(output)) {
      return "apple-tools-outdated";
    }
    if (/active developer path.*does not exist|unable to find utility ['"]swiftc['"]/i.test(output)) {
      return "apple-tools-path-invalid";
    }
    return "apple-build-failed";
  },

  // Builds the helper once (swiftc from the command line tools or Xcode),
  // then reuses it. W10-07: tries each toolchain in turn (swiftc itself,
  // not the xcrun shim, with its own module cache), and when none builds,
  // keeps what the compiler said (appleDetail) so Settings can show it
  // instead of advice that doesn't apply.
  _ensureHelper() {
    if (Services.appinfo.OS != "Darwin") {
      return Promise.reject(new WhimsyAIError("unavailable"));
    }
    this._helperPromise ??= (async () => {
      const path = this._helperPath;
      if (await IOUtils.exists(path)) {
        await this._unquarantine(path);
        return path;
      }
      const version = await this._macOSVersion();
      if (version != null && version < MIN_MACOS_VERSION) {
        throw new WhimsyAIError("apple-unavailable-os");
      }
      this.appleDetail = "";
      const toolchains = await this._findToolchains();
      if (typeof toolchains == "string") {
        throw new WhimsyAIError(toolchains);
      }
      const dir = PathUtils.parent(path);
      await IOUtils.makeDirectory(dir, { ignoreExisting: true });
      // Older helpers (blocked by quarantine) are never used again.
      for (const child of await IOUtils.getChildren(dir).catch(() => [])) {
        if (/\/whimsy-fm-\d+$/.test(child) && child != path) {
          await IOUtils.remove(child).catch(() => {});
        }
      }
      const source = PathUtils.join(dir, "WhimsyFM.swift");
      await IOUtils.writeUTF8(source, HELPER_SOURCE);
      const failures = [];
      for (const toolchain of toolchains.slice(0, MAX_BUILD_ATTEMPTS)) {
        let result;
        try {
          result = await this._run(
            toolchain.swiftc,
            [
              "-O",
              "-parse-as-library",
              "-sdk",
              toolchain.sdk,
              "-module-cache-path",
              PathUtils.join(dir, "ModuleCache"),
              "-o",
              path,
              source,
            ],
            { environment: { DEVELOPER_DIR: toolchain.developerDir, SDKROOT: toolchain.sdk }, environmentAppend: true }
          );
        } catch (e) {
          result = { exitCode: -1, output: String(e?.message ?? e) };
        }
        if (result.exitCode == 0 && (await IOUtils.exists(path))) {
          await this._unquarantine(path);
          return path;
        }
        console.error("Whimsy AI: building the on-device helper failed", toolchain, result.output);
        failures.push({ code: this._buildFailure(result.output), detail: this._buildDetail(result.output) });
      }
      // The most telling failure: a specific cause over "build failed".
      const failure = failures.find(f => f.code != "apple-build-failed") ?? failures[0];
      this.appleDetail = failure?.detail ?? "";
      throw new WhimsyAIError(failure?.code ?? "apple-build-failed", this.appleDetail || undefined);
    })();
    // A failed build may succeed later (tools installed), so don't cache it.
    this._helperPromise.catch(() => (this._helperPromise = null));
    return this._helperPromise;
  },

  // "available", or why not: "unavailable", "apple-needs-tools",
  // "apple-tools-outdated", "apple-needs-license", "apple-build-failed",
  // "apple-helper-blocked", "apple-helper-crashed", "apple-unavailable-os",
  // "apple-intelligence-off", "apple-not-ready", or (with build: false,
  // before the helper exists) "not-set-up".
  // appleDetail says more (folders searched, compiler error).
  async appleStatus({ build = true } = {}) {
    this._appleReady = null;
    this.appleDetail = "";
    if (!build && !(await IOUtils.exists(this._helperPath))) {
      if (Services.appinfo.OS != "Darwin") {
        return "unavailable";
      }
      // W13-B11: below macOS 26 this never has a helper to find, so say
      // why up front instead of waiting for a Set Up click to fail.
      const version = await this._macOSVersion();
      if (version != null && version < MIN_MACOS_VERSION) {
        return "apple-unavailable-os";
      }
      return "not-set-up";
    }
    let path;
    try {
      path = await this._ensureHelper();
    } catch (error) {
      return error.code || "unavailable";
    }
    try {
      const proc = await lazy.Subprocess.call({ command: path, arguments: ["--check"], stderr: "stdout" });
      let timer;
      const timedOut = new Promise(resolve => {
        timer = setTimeout(() => resolve(null), this._helperCheckTimeoutMs);
      });
      const output = await Promise.race([proc.stdout.readString(), timedOut]);
      clearTimeout(timer);
      if (output === null) {
        // macOS is holding the helper at launch (quarantine, Gatekeeper).
        proc.kill();
        console.error("Whimsy AI: the on-device helper didn't start", path);
        return "apple-helper-blocked";
      }
      // F22: a helper that has answered but doesn't exit (the Swift runtime
      // can stay up after main returns) must not leave Set Up on
      // "Checking…": its answer counts, and it's stopped.
      let waitTimer;
      const exited = await Promise.race([
        proc.wait(),
        new Promise(resolve => {
          waitTimer = setTimeout(() => resolve(null), this._helperCheckTimeoutMs);
        }),
      ]);
      clearTimeout(waitTimer);
      if (!exited) {
        proc.kill();
      }
      const exitCode = exited?.exitCode ?? 0;
      if (!output.trim() && exitCode < 0) {
        // Negative exitCode means a signal (Subprocess reports it as
        // -signalNumber). SIGKILL (-9) with no output is macOS (or our own
        // proc.kill() above) refusing to let it run. Any other signal is
        // the helper itself crashing (a Swift trap, usually), a different
        // problem that "allow it in Privacy & Security" doesn't fix.
        return exitCode == -9 ? "apple-helper-blocked" : "apple-helper-crashed";
      }
      if (output.trim() == "available") {
        return "available";
      }
      if (/appleIntelligenceNotEnabled/.test(output)) {
        return "apple-intelligence-off";
      }
      if (/modelNotReady/.test(output)) {
        return "apple-not-ready";
      }
      return "unavailable";
    } catch {
      return "unavailable";
    }
  },

  async _apple({ prompt, system, signal }) {
    // Settings → Set Up builds the helper; requests never start a build.
    if (!(await IOUtils.exists(this._helperPath))) {
      throw new WhimsyAIError(Services.appinfo.OS == "Darwin" ? "apple-not-set-up" : "unavailable");
    }
    const path = await this._ensureHelper();
    const proc = await lazy.Subprocess.call({ command: path, arguments: [], stderr: "pipe" });
    const kill = () => proc.kill();
    signal.addEventListener("abort", kill, { once: true });
    try {
      await proc.stdin.write(JSON.stringify({ prompt, system }));
      await proc.stdin.close();
      const [output, errors] = await Promise.all([proc.stdout.readString(), proc.stderr.readString()]);
      const { exitCode } = await proc.wait();
      if (signal.aborted) {
        throw signal.reason;
      }
      if (exitCode == 3) {
        throw new WhimsyAIError("unavailable");
      }
      if (exitCode != 0) {
        throw new WhimsyAIError("failed", errors.trim() || `exit ${exitCode}`);
      }
      return output;
    } finally {
      signal.removeEventListener("abort", kill);
    }
  },
};

function aborted(signal) {
  return new Promise((_, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
    }
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}
