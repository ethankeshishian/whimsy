/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// AI v1: the providers every Whimsy AI feature talks to (Tidy Tabs, tab
// titles, Ask on Page, previews, Watch a page, chat):
//   - "apple":  Apple's on-device model (Foundation Models, macOS 26+). The
//               framework is Swift-only, so a tiny helper is compiled with
//               the Xcode command line tools on first use and cached in the
//               profile. Nothing leaves the Mac.
//   - "claude": the Claude Messages API with the person's own API key, or
//               the Claude plan through Claude Code.
//   - "ollama": a local Ollama server.
//   - "openai": OpenAI's Responses API with the person's own API key, or the
//               ChatGPT plan.
//   - "gemini": Google's Gemini API with the person's own API key.
// W23: every connected provider is in one order (whimsy.ai.order), each
// with its own switch (whimsy.ai.off); WhimsyAIRouter tries them in order,
// skips what can't do the task, and hands off on quota with a note. The AI
// kill switch (Enable AI, whimsy.ai.enabled, WhimsyAI.sys.mjs) refuses
// every request and aborts the ones in flight; it stays off until the
// first provider connects. API keys never go into prefs: each is encrypted
// with OSKeyStore (the macOS Keychain) and the ciphertext lives in the
// profile.

import { clearTimeout, setTimeout } from "resource://gre/modules/Timer.sys.mjs";

const lazy = {};
ChromeUtils.defineLazyGetter(lazy, "l10n", () => new Localization(["browser/whimsy.ftl"], true));
ChromeUtils.defineESModuleGetters(lazy, {
  OSKeyStore: "resource://gre/modules/OSKeyStore.sys.mjs",
  Subprocess: "resource://gre/modules/Subprocess.sys.mjs",
  WhimsyAI: "resource:///modules/whimsy/WhimsyAI.sys.mjs",
  WhimsyAIRouter: "resource:///modules/whimsy/WhimsyAIRouter.sys.mjs",
  ndjson: "resource:///modules/whimsy/WhimsyAIStream.sys.mjs",
  sseJSON: "resource:///modules/whimsy/WhimsyAIStream.sys.mjs",
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
// W23: set once the first connection has turned AI on, so a later
// connection never turns it back on after the person turned it off.
const AUTO_ENABLED_PREF = "whimsy.ai.auto-enabled";
export const ORDER_PREF = "whimsy.ai.order";
export const OFF_PREF = "whimsy.ai.off";
export const QUICK_TEXT_APPLE_PREF = "whimsy.ai.quick-text-apple";
export const RESTING_PREF = "whimsy.ai.resting";
export const CHANGED_TOPIC = "whimsy-ai-providers-changed";
// A limit message with no reset time rests the provider this long.
const DEFAULT_REST_MS = { "plan-limit": 60 * 60 * 1000, "rate-limited": 60 * 1000 };
// Thinking levels, as Settings and the model menu name them.
export const THINKING_LEVELS = ["light", "normal", "deep"];
const CLAUDE_EFFORT = { light: "low", normal: "medium", deep: "high" };
const OPENAI_EFFORT = { light: "low", normal: "medium", deep: "high" };
const GEMINI_BUDGET = { light: 1024, normal: 8192, deep: 24576 };
const OLLAMA_THINK = { light: false, normal: true, deep: true };
const USAGE_URLS = {
  claude: "https://platform.claude.com/usage",
  openai: "https://platform.openai.com/usage",
  gemini: "https://aistudio.google.com/usage",
};

export const PROVIDERS = ["apple", "claude", "ollama", "openai", "gemini"];
// The providers that send text off the computer.
export const CLOUD_PROVIDERS = ["claude", "openai", "gemini"];
// The providers whose API key Whimsy keeps (whimsy-ai-keys.json, one field
// each, encrypted with OSKeyStore).
export const KEY_PROVIDERS = ["claude", "openai", "gemini"];
const DEFAULT_PROVIDER = "apple";
// Settings → AI's list of every provider, and the order an old profile's
// connections are seeded in (whimsy.ai.order has the real order).
export const ACCOUNT_ORDER = ["apple", "claude", "openai", "gemini", "ollama"];
// Providers with a subscription path (L7b registers each one's plan).
export const PLAN_PROVIDERS = ["openai", "claude"];
const PLAN_GATES = { openai: "whimsy.feature.ai-openai-plan", claude: "whimsy.feature.ai-claude-plan" };
// How a plan-capable provider is connected: "plan" or "key".
const authPref = provider => `whimsy.ai.${provider}.auth`;
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
// How long a request may go without a word (streams reset it).
export const REQUEST_TIMEOUT_MS = 90 * 1000;

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
  "plan-ineligible",
  "sign-in-cancelled",
  "claude-code-missing",
  "claude-code-signed-out",
  "claude-code-outdated",
  "install-failed",
  "bad-response",
  "timeout",
  "failed",
  // W23 (WhimsyAIRouter): no enabled provider can do this, every one that
  // could failed, or the Mac is offline and nothing on it can.
  "none-capable",
  "all-failed",
  "offline",
];

// W23 secfix L7: an owner-only file, written whole: the temporary file is
// made 0600 before anything goes in it, then moved into place.
async function writeOwnerOnlyJSON(path, value) {
  const tmp = await IOUtils.createUniqueFile(PathUtils.parent(path), `${PathUtils.filename(path)}.tmp`, 0o600);
  try {
    await IOUtils.setPermissions(tmp, 0o600, false);
    await IOUtils.writeJSON(tmp, value);
    await IOUtils.move(tmp, path);
  } finally {
    await IOUtils.remove(tmp, { ignoreAbsent: true });
  }
  await IOUtils.setPermissions(path, 0o600, false);
}

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

  // The provider tried first: the first switched-on one in the order (the
  // on-device one while nothing is connected).
  get provider() {
    if (this._testProvider && !this._testStreams) {
      return "test";
    }
    return this.order.find(id => this.isOn(id)) ?? DEFAULT_PROVIDER;
  },

  // ---- Order, switches, capabilities, resting (W23) ----

  // Connected providers in the order Whimsy tries them.
  get order() {
    const ids = Services.prefs.getStringPref(ORDER_PREF, "").split(",").map(id => id.trim());
    return [...new Set(ids.filter(id => PROVIDERS.includes(id)))];
  },

  setOrder(ids) {
    const next = [...new Set((ids ?? []).filter(id => PROVIDERS.includes(id)))];
    if (next.join(",") == this.order.join(",") && Services.prefs.prefHasUserValue(ORDER_PREF)) {
      return;
    }
    Services.prefs.setStringPref(ORDER_PREF, next.join(","));
    this._changed("order");
  },

  // A new connection goes last; one already in the order keeps its place.
  _addToOrder(id) {
    this._seedOrderSync();
    if (!this.order.includes(id)) {
      this.setOrder([...this.order, id]);
    }
  },

  _removeFromOrder(id) {
    this._seedOrderSync();
    this.setOrder(this.order.filter(other => other != id));
    this.setOn(id, true);
    this.clearResting(id);
  },

  // Once per profile: the providers an older Whimsy had connected, the one
  // it used (whimsy.ai.provider) first.
  async seedOrder() {
    if (Services.prefs.prefHasUserValue(ORDER_PREF)) {
      return;
    }
    const connected = await this.connectedProviders();
    if (Services.prefs.prefHasUserValue(ORDER_PREF)) {
      return;
    }
    const used = Services.prefs.getStringPref(PROVIDER_PREF, "");
    Services.prefs.setStringPref(ORDER_PREF, (connected.includes(used) ? [used, ...connected.filter(id => id != used)] : connected).join(","));
  },

  // A connection made before seeding finished: start from an empty order
  // rather than from nothing.
  _seedOrderSync() {
    if (!Services.prefs.prefHasUserValue(ORDER_PREF)) {
      Services.prefs.setStringPref(ORDER_PREF, "");
    }
  },

  _offList() {
    return Services.prefs.getStringPref(OFF_PREF, "").split(",").filter(id => PROVIDERS.includes(id));
  },

  // Off means connected but never tried, handoff included.
  isOn(id) {
    return !this._offList().includes(id);
  },

  setOn(id, on) {
    const off = new Set(this._offList());
    if (on == !off.has(id)) {
      return;
    }
    if (on) {
      off.delete(id);
    } else {
      off.add(id);
    }
    if (off.size) {
      Services.prefs.setStringPref(OFF_PREF, [...off].join(","));
    } else {
      Services.prefs.clearUserPref(OFF_PREF);
    }
    this._changed("switch");
  },

  // Short rewrite, translate, and summarize tasks go to Apple first.
  get quickTextOnApple() {
    return Services.prefs.getBoolPref(QUICK_TEXT_APPLE_PREF, true);
  },

  set quickTextOnApple(value) {
    Services.prefs.setBoolPref(QUICK_TEXT_APPLE_PREF, !!value);
    this._changed("quick-text");
  },

  _changed(what) {
    Services.obs.notifyObservers(null, CHANGED_TOPIC, what);
  },

  async anyConnected() {
    if (this.order.length) {
      return true;
    }
    return (await this.connectedProviders()).length > 0;
  },

  // What a provider (and model) can do. Ollama's labels come from its
  // model details (refreshCapabilities); the Claude plan streams only once
  // Claude Code's stream-json probe said so.
  capabilities(id, model = this.modelOf(id)) {
    const base = {
      text: true,
      images: false,
      video: false,
      thinking: null,
      research: false,
      imageGen: false,
      code: false,
      tools: false,
      streaming: false,
      onDevice: false,
      maxInputChars: MAX_INPUT_CHARS[id] ?? 20000,
    };
    const name = String(model ?? "").toLowerCase();
    switch (id) {
      case "test":
        return { ...base, images: true, video: true, thinking: [...THINKING_LEVELS], research: true, imageGen: true, code: true, tools: true, streaming: true };
      case "apple":
        return { ...base, onDevice: true };
      case "ollama": {
        const details = this._ollamaDetails.get(name);
        const can = new Set(details ?? []);
        return {
          ...base,
          images: can.has("vision"),
          thinking: can.has("thinking") ? [...THINKING_LEVELS] : null,
          tools: can.has("tools"),
          streaming: true,
          onDevice: /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:|\/|$)/.test(this.ollamaEndpoint),
        };
      }
      case "claude":
        if (this._usesPlan("claude")) {
          return { ...base, tools: true, streaming: this._claudePlanStreams === true };
        }
        return { ...base, images: true, thinking: /haiku/.test(name) ? null : [...THINKING_LEVELS], code: true, tools: true, streaming: true };
      case "openai": {
        const reasoning = /^(o\d|gpt-5)/.test(name) || (this._usesPlan("openai") && !name);
        return {
          ...base,
          images: true,
          thinking: reasoning ? [...THINKING_LEVELS] : null,
          research: /deep-research/.test(name),
          imageGen: !this._usesPlan("openai"),
          code: true,
          tools: !this._usesPlan("openai"),
          streaming: true,
        };
      }
      case "gemini":
        return {
          ...base,
          images: true,
          video: true,
          thinking: /gemini-(2\.5|[3-9])/.test(name) ? [...THINKING_LEVELS] : null,
          imageGen: /image/.test(name),
          code: true,
          tools: true,
          streaming: true,
        };
      default:
        return base;
    }
  },

  // Ollama model names to their capability labels, from /api/show.
  _ollamaDetails: new Map(),
  // Whether Claude Code streams (null: not probed yet).
  _claudePlanStreams: null,

  // Looks up what capabilities() can't know offline: an Ollama model's
  // details, or whether Claude Code can stream on the plan.
  async refreshCapabilities(id) {
    if (id == "ollama") {
      const model = this.modelOf("ollama");
      if (!model) {
        return;
      }
      try {
        const response = await fetch(`${this.ollamaEndpoint}/api/show`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ model }),
          credentials: "omit",
        });
        const data = response.ok ? await response.json() : null;
        if (Array.isArray(data?.capabilities)) {
          this._ollamaDetails.set(model.toLowerCase(), data.capabilities.map(String));
        } else {
          this._ollamaDetails.delete(model.toLowerCase());
        }
      } catch {
        this._ollamaDetails.delete(model.toLowerCase());
      }
    } else if (id == "claude" && this._usesPlan("claude")) {
      try {
        this._claudePlanStreams = !!(await this._plans.claude.supportsStreamJson?.());
      } catch {
        this._claudePlanStreams = false;
      }
    } else {
      return;
    }
    this._changed("capabilities");
  },

  _readResting() {
    try {
      const value = JSON.parse(Services.prefs.getStringPref(RESTING_PREF, "{}"));
      return value && typeof value == "object" ? value : {};
    } catch {
      return {};
    }
  },

  _writeResting(all) {
    if (Object.keys(all).length) {
      Services.prefs.setStringPref(RESTING_PREF, JSON.stringify(all));
    } else {
      Services.prefs.clearUserPref(RESTING_PREF);
    }
  },

  // Whether a provider is out of room: until when (null: unknown) and its
  // last limit message in its own words. Ends by itself at reset time.
  resting(id) {
    const all = this._readResting();
    const entry = all[id];
    if (!entry) {
      return null;
    }
    const ends = entry.until ?? (entry.at ?? 0) + (DEFAULT_REST_MS[entry.code] ?? DEFAULT_REST_MS["plan-limit"]);
    if (Date.now() >= ends) {
      delete all[id];
      this._writeResting(all);
      this._changed("resting");
      return null;
    }
    return { until: entry.until ?? null, message: String(entry.message ?? "") };
  },

  setResting(id, { until = null, message = "", code = "plan-limit" } = {}) {
    const all = this._readResting();
    all[id] = { until: Number.isFinite(until) ? until : null, message: String(message ?? "").slice(0, 300), code, at: Date.now() };
    this._writeResting(all);
    this._changed("resting");
  },

  clearResting(id) {
    const all = this._readResting();
    if (all[id]) {
      delete all[id];
      this._writeResting(all);
      this._changed("resting");
    }
  },

  // The provider's own usage page (a plan's when connected that way).
  usageUrl(id) {
    if (this._usesPlan(id)) {
      return this._plans[id]?.usageUrl ?? null;
    }
    return USAGE_URLS[id] ?? null;
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

  // Plan sign-ins: { connect(win), cancel(), disconnect(), status(), complete(request), isReady(), models(),
  // manageUsage?(win), userStartedOnly }.
  _plans: {},

  // The built-in sign-ins: ChatGPT (Sign in with ChatGPT) and Claude
  // (through Claude Code).
  _registerBuiltInPlans() {
    if (this._builtInPlans) {
      return;
    }
    this._builtInPlans = true;
    const { WhimsyAIOpenAIAuth } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyAIOpenAIAuth.sys.mjs");
    const { WhimsyAIClaudeCode } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyAIClaudeCode.sys.mjs");
    this._plans.openai ??= WhimsyAIOpenAIAuth;
    this._plans.claude ??= WhimsyAIClaudeCode;
  },

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

  // Whether a plan has a usage page of its own to open.
  canManageUsage(provider) {
    return !!this._plans[provider]?.manageUsage;
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

  // Settings → AI, optionally opening one sheet there ("add-provider", or a
  // provider's own: "claude", "openai", "gemini", "ollama", "apple") or
  // jumping to a section by its id.
  openSettings(win, action = null) {
    this.pendingSettingsAction = action;
    win?.openPreferences?.("paneWhimsyAI");
    Services.obs.notifyObservers(null, "whimsy-ai-settings-action", action ?? "");
  },

  pendingSettingsAction: null,

  initWindow(win) {
    this._registerBuiltInPlans();
    if (!this._seeded) {
      this._seeded = true;
      this.seedOrder()
        .then(() => Promise.all(["ollama", "claude"].filter(id => this.order.includes(id)).map(id => this.refreshCapabilities(id))))
        .catch(e => console.error("Whimsy AI: the provider order", e));
    }
    const { WhimsyCommands } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyCommands.sys.mjs");
    const isAvailable = () => this.enabled;
    WhimsyCommands.register(win, {
      id: "cmd_whimsyAISignInChatGPT",
      l10nId: "whimsy-action-ai-sign-in-chatgpt",
      run: w => this.openSettings(w, "plan-openai"),
      icon: "chrome://browser/skin/zen-icons/selectable/chat.svg",
      menu: "tools-menu",
      isAvailable: () => this.enabled && this.planAvailable("openai"),
    });
    WhimsyCommands.register(win, {
      id: "cmd_whimsyAIConnect",
      l10nId: "whimsy-action-ai-connect",
      run: w => this.openSettings(w, "add-provider"),
      icon: "chrome://browser/skin/zen-icons/selectable/key.svg",
      menu: "tools-menu",
      isAvailable,
    });
  },

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
    const previous = await this.getKey(provider);
    await this.setKey(provider, value);
    let models;
    try {
      models = await this.listModels(provider);
    } catch (error) {
      await this.setKey(provider, previous);
      throw error;
    }
    if (PLAN_PROVIDERS.includes(provider)) {
      Services.prefs.setStringPref(authPref(provider), "key");
    }
    if (provider != "claude" && models.length && !Services.prefs.getStringPref(MODEL_PREFS[provider], "")) {
      Services.prefs.setStringPref(MODEL_PREFS[provider], models[0]);
    }
    this._connected(provider);
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
    this._connected(provider);
    if (provider == "claude") {
      this.refreshCapabilities("claude").catch(() => {});
    }
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
    this._connected("ollama");
    await this.refreshCapabilities("ollama");
    Services.obs.notifyObservers(null, "whimsy-ai-accounts-changed", "ollama");
    return models;
  },

  // A provider just connected: it goes last in the order, and the first
  // connection ever turns AI on (W23: off until connected).
  _connected(provider) {
    this._addToOrder(provider);
    if (!Services.prefs.getBoolPref(AUTO_ENABLED_PREF, false)) {
      Services.prefs.setBoolPref(AUTO_ENABLED_PREF, true);
      if (!lazy.WhimsyAI.enabled) {
        Services.prefs.setBoolPref(AI_ENABLED_PREF, true);
      }
    }
    this._changed("connected");
  },

  // Apple's helper is built by Settings' Set Up; that counts as connecting.
  appleConnected() {
    this._connected("apple");
  },

  // Ends a plan sign-in that's waiting.
  cancelPlan(provider) {
    this._plans[provider]?.cancel?.();
  },

  async disconnect(provider) {
    // Revoked even while the plan's feature gate is off.
    if (this._plans[provider] && Services.prefs.getStringPref(authPref(provider), "") == "plan") {
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
    this._removeFromOrder(provider);
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
      if (provider == "ollama") {
        this.refreshCapabilities("ollama").catch(() => {});
      }
    }
  },

  // Tests only. An async generator fn(provider, request) stands in for
  // every real provider (the order and switches still apply) and yields
  // AIEvents; a plain fn(request) returning text is the one provider "test".
  setTestProvider(fn) {
    if (fn && !Cu.isInAutomation) {
      throw new Error("The test provider is for automated tests only");
    }
    this._testProvider = fn || null;
    this._testStreams = fn?.constructor?.name == "AsyncGeneratorFunction";
  },

  _testStreams: false,

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
   * One completion through WhimsyAIRouter (the order, switches, and
   * handoff apply), as text.
   *
   * @param {object} request
   * @param {string} request.prompt
   * @param {string} [request.system]
   * @param {number} [request.maxTokens]
   * @param {string} [request.task] An AIRequest task ("ask" by default).
   * @param {AbortSignal} [request.signal]
   * @returns {Promise<string>} The answer's text.
   */
  async complete({ prompt, system = "", maxTokens = 1024, signal, userStarted = false, task = "ask", thinking } = {}) {
    const result = await lazy.WhimsyAIRouter.run({
      task,
      messages: [{ role: "user", content: String(prompt ?? "") }],
      system,
      maxTokens,
      signal,
      userStarted,
      // Short, simple tasks: light thinking keeps them quick and cheap.
      thinking: thinking ?? "light",
    });
    // Callers here need the whole answer.
    if (result.partial) {
      throw Object.assign(new WhimsyAIError(result.stopped || "failed"), { provider: result.provider });
    }
    return String(result.text ?? "").trim();
  },

  /**
   * One provider's answer as AIEvents ({ type: "text", delta },
   * { type: "thinking", text }, { type: "citation", n, source }). The
   * router calls this; errors are WhimsyAIErrors (until and detail say
   * when a spent provider resets, in its own words).
   */
  async *stream(provider, request) {
    if (this._testProvider) {
      if (this._testStreams) {
        yield* this._testProvider(provider, request);
        return;
      }
      const text = await Promise.race([this._testProvider(request), aborted(request.signal)]);
      yield { type: "text", delta: String(text ?? "") };
      return;
    }
    if (this._usesPlan(provider)) {
      const plan = this._plans[provider];
      if (plan.stream && (provider != "claude" || this._claudePlanStreams === true)) {
        yield* plan.stream(request);
      } else {
        yield { type: "text", delta: String((await plan.complete(request)) ?? "") };
      }
      return;
    }
    switch (provider) {
      case "claude":
        yield* this._claudeStream(request);
        return;
      case "ollama":
        yield* this._ollamaStream(request);
        return;
      case "openai":
        yield* this._openaiStream(request);
        return;
      case "gemini":
        yield* this._geminiStream(request);
        return;
      default:
        yield { type: "text", delta: String((await this._apple(request)) ?? "") };
    }
  },

  /**
   * Whether a switched-on provider is set up, without setting anything up
   * (never builds the Apple helper or contacts a server). Automatic features
   * (tab titles, search-page previews, watches) wait for this, so nothing
   * happens on its own until the person has connected a provider.
   *
   * @returns {Promise<boolean>}
   */
  async isReady() {
    if (!this.enabled) {
      return false;
    }
    for (const id of lazy.WhimsyAIRouter._enabled()) {
      if (await this._ready(id)) {
        return true;
      }
    }
    return false;
  },

  async _ready(provider) {
    if (provider == "test") {
      return true;
    }
    if (this._testProvider) {
      return true;
    }
    if (this._usesPlan(provider)) {
      try {
        return !!(await this._plans[provider].isReady());
      } catch {
        return false;
      }
    }
    switch (provider) {
      case "claude":
      case "openai":
      case "gemini":
        return this.hasKey(provider);
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

  async *_claudeStream({ messages, system, maxTokens, signal, thinking, model: chosen }) {
    const key = await this.getClaudeKey();
    if (!key) {
      throw new WhimsyAIError("no-key");
    }
    const model = chosen || this.claudeModel;
    const body = {
      model,
      max_tokens: Math.max(2048, maxTokens * 2),
      stream: true,
      messages: messages.map(m => ({
        role: m.role,
        content:
          typeof m.content == "string"
            ? m.content
            : partsOf(m.content).map(part =>
                part.type == "image"
                  ? { type: "image", source: { type: "base64", media_type: part.mediaType, data: part.data } }
                  : { type: "text", text: part.text }
              ),
      })),
    };
    if (this.capabilities("claude", model).thinking) {
      body.thinking = { type: "adaptive", display: "summarized" };
      body.output_config = { effort: CLAUDE_EFFORT[thinking] ?? "low" };
    }
    if (system) {
      body.system = system;
    }
    const response = await this._post(
      `${ENDPOINTS.claude}/messages`,
      { "x-api-key": key, "anthropic-version": "2023-06-01" },
      body,
      signal
    );
    if (!response.ok) {
      throw await this._httpError("claude", response);
    }
    if (!isStream(response)) {
      const data = await response.json();
      if (data.stop_reason == "refusal") {
        throw new WhimsyAIError("refused");
      }
      for (const block of data.content || []) {
        if (block.type == "thinking" && block.thinking) {
          yield { type: "thinking", text: block.thinking };
        } else if (block.type == "text") {
          yield { type: "text", delta: block.text };
        }
      }
      return;
    }
    let citations = 0;
    for await (const { json } of lazy.sseJSON(response.body)) {
      switch (json.type) {
        case "content_block_delta": {
          const delta = json.delta ?? {};
          if (delta.type == "text_delta") {
            yield { type: "text", delta: delta.text ?? "" };
          } else if (delta.type == "thinking_delta" && delta.thinking) {
            yield { type: "thinking", text: delta.thinking };
          } else if (delta.type == "citations_delta" && delta.citation?.url) {
            yield { type: "citation", n: ++citations, source: { url: delta.citation.url, title: delta.citation.title ?? "" } };
          }
          break;
        }
        case "message_delta":
          if (json.delta?.stop_reason == "refusal") {
            throw new WhimsyAIError("refused");
          }
          break;
        case "error":
          throw streamError(json.error?.type, json.error?.message);
        case "message_stop":
          return;
      }
    }
    throw new WhimsyAIError("bad-response", "The Claude stream ended early");
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
    await writeOwnerOnlyJSON(this._keyPath, saved);
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

  async *_openaiStream({ messages, system, maxTokens, signal, thinking, model: chosen }) {
    const key = await this.getKey("openai");
    if (!key) {
      throw new WhimsyAIError("no-key");
    }
    const model = chosen || Services.prefs.getStringPref(OPENAI_MODEL_PREF, "");
    if (!model) {
      throw new WhimsyAIError("no-model");
    }
    const body = {
      model,
      input: openaiInput(messages),
      max_output_tokens: Math.max(2048, maxTokens * 2),
      // Nothing is kept on OpenAI's side.
      store: false,
      stream: true,
    };
    if (system) {
      body.instructions = system;
    }
    if (this.capabilities("openai", model).thinking) {
      body.reasoning = { effort: OPENAI_EFFORT[thinking] ?? "low", summary: "auto" };
    }
    const response = await this._post(`${ENDPOINTS.openai}/responses`, { authorization: `Bearer ${key}` }, body, signal);
    if (!response.ok) {
      throw await this._httpError("openai", response);
    }
    if (!isStream(response)) {
      const text = responsesText((await response.json())?.output);
      yield { type: "text", delta: text };
      return;
    }
    yield* responsesEvents(response.body);
  },

  // ---- Gemini (API key; the Generative Language API) ----

  async *_geminiStream({ messages, system, maxTokens, signal, thinking, model: chosen }) {
    const key = await this.getKey("gemini");
    if (!key) {
      throw new WhimsyAIError("no-key");
    }
    const model = chosen || Services.prefs.getStringPref(GEMINI_MODEL_PREF, "");
    if (!model) {
      throw new WhimsyAIError("no-model");
    }
    const body = {
      contents: messages.map(m => ({
        role: m.role == "assistant" ? "model" : "user",
        parts: partsOf(m.content).map(part =>
          part.type == "image" ? { inlineData: { mimeType: part.mediaType, data: part.data } } : { text: part.text }
        ),
      })),
      generationConfig: { maxOutputTokens: Math.max(2048, maxTokens * 2) },
    };
    if (this.capabilities("gemini", model).thinking) {
      body.generationConfig.thinkingConfig = { thinkingBudget: GEMINI_BUDGET[thinking] ?? GEMINI_BUDGET.light, includeThoughts: true };
    }
    if (system) {
      body.systemInstruction = { parts: [{ text: system }] };
    }
    // The key goes in a header, never the address (logs, history).
    const url = `${ENDPOINTS.gemini}/models/${encodeURIComponent(model.replace(/^models\//, ""))}:streamGenerateContent?alt=sse`;
    const response = await this._post(url, { "x-goog-api-key": key }, body, signal);
    if (!response.ok) {
      throw await this._httpError("gemini", response);
    }
    const chunks = isStream(response) ? lazy.sseJSON(response.body) : oneChunk(response);
    for await (const { json } of chunks) {
      if (json.error) {
        throw streamError(json.error.status, json.error.message);
      }
      if (json.promptFeedback?.blockReason) {
        throw new WhimsyAIError("refused");
      }
      const candidate = json.candidates?.[0];
      if (!candidate) {
        continue;
      }
      if (candidate.finishReason == "SAFETY") {
        throw new WhimsyAIError("refused");
      }
      for (const part of candidate.content?.parts || []) {
        if (part.thought && part.text) {
          yield { type: "thinking", text: part.text };
        } else if (part.text) {
          yield { type: "text", delta: part.text };
        }
      }
    }
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

  // A failed HTTP answer as a WhimsyAIError, with the provider's own words
  // (detail) and, for a limit, when it resets (until).
  async _httpError(provider, response) {
    let data = null;
    try {
      data = await response.json();
    } catch {}
    const status = response.status;
    let code;
    if (status == 401 || status == 403) {
      code = "bad-key";
    } else if (status == 400) {
      code = provider == "gemini" && /API_KEY_INVALID/.test(JSON.stringify(data?.error ?? "")) ? "bad-key" : "failed";
    } else if (status == 404) {
      code = "no-model";
    } else if (status == 429) {
      code = /insufficient_quota|credit balance/i.test(JSON.stringify(data ?? "")) ? "plan-limit" : "rate-limited";
    } else if (status >= 500) {
      code = "unavailable";
    } else {
      code = "failed";
    }
    const detail = typeof data?.error == "string" ? data.error : String(data?.error?.message ?? "");
    const failure = new WhimsyAIError(code, detail || `${provider} ${status}`);
    failure.detail = detail;
    failure.provider = provider;
    const until = retryAt(response.headers);
    if (until) {
      failure.until = until;
    }
    return failure;
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

  async *_ollamaStream({ messages, system, signal, thinking, model: chosen }) {
    const model = chosen || Services.prefs.getStringPref(OLLAMA_MODEL_PREF, "");
    if (!model) {
      throw new WhimsyAIError("no-model");
    }
    const chat = [];
    if (system) {
      chat.push({ role: "system", content: system });
    }
    for (const m of messages) {
      const parts = partsOf(m.content);
      const message = { role: m.role, content: parts.filter(p => p.type == "text").map(p => p.text).join("\n") };
      const images = parts.filter(p => p.type == "image").map(p => p.data);
      if (images.length) {
        message.images = images;
      }
      chat.push(message);
    }
    const body = { model, messages: chat, stream: true };
    if (this.capabilities("ollama", model).thinking) {
      body.think = OLLAMA_THINK[thinking] ?? false;
    }
    let response;
    try {
      response = await fetch(`${this.ollamaEndpoint}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        credentials: "omit",
        signal,
      });
    } catch (error) {
      if (signal.aborted) {
        throw error;
      }
      throw new WhimsyAIError("unavailable");
    }
    if (!response.ok) {
      throw await this._httpError("ollama", response);
    }
    const lines = isStream(response) ? lazy.ndjson(response.body) : oneObject(response);
    for await (const line of lines) {
      if (line.error) {
        throw streamError("", String(line.error));
      }
      if (line.message?.thinking) {
        yield { type: "thinking", text: line.message.thinking };
      }
      if (line.message?.content) {
        yield { type: "text", delta: line.message.content };
      }
      if (line.done) {
        return;
      }
    }
  },

  // The models the local Ollama server has, for the Settings picker.
  // Settings' Ollama sheet: each installed model with its size and, when
  // Ollama's model details say, whether it reads images or thinks.
  async ollamaModelDetails(endpoint = this.ollamaEndpoint) {
    const base = String(endpoint || "").replace(/\/+$/, "");
    const response = await fetch(`${base}/api/tags`, { credentials: "omit" });
    if (!response.ok) {
      throw new WhimsyAIError("unavailable");
    }
    const data = await response.json();
    const models = (data.models || []).filter(m => m?.name);
    return Promise.all(
      models.map(async m => {
        let caps = null;
        try {
          const show = await fetch(`${base}/api/show`, { method: "POST", credentials: "omit", body: JSON.stringify({ model: m.name }) });
          const list = show.ok ? (await show.json())?.capabilities : null;
          if (Array.isArray(list)) {
            caps = { images: list.includes("vision"), thinking: list.includes("thinking") };
          }
        } catch {}
        return { name: m.name, size: Number(m.size) || 0, caps };
      })
    );
  },

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
        if (!this.order.includes("apple")) {
          this.appleConnected();
        }
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
        const detail = errors.trim() || `exit ${exitCode}`;
        // W26: after a burst of requests (hovering one link after another)
        // macOS refuses every request for several minutes with
        // ModelManagerError 1013, often wrapped in a SensitiveContentAnalysis
        // error: the provider rests rather than being asked again and again.
        if (/ModelManagerError Code=1013|rateLimited|rate limit/i.test(detail)) {
          throw Object.assign(new WhimsyAIError("rate-limited", detail), { detail: "" });
        }
        // The guardrail says no to this text: asking again won't change it.
        if (/unsafe content|guardrailViolation/i.test(detail)) {
          throw Object.assign(new WhimsyAIError("failed", detail), { transient: false });
        }
        throw new WhimsyAIError("failed", detail);
      }
      return output;
    } finally {
      signal.removeEventListener("abort", kill);
    }
  },
};

// Parts of a message: [{ type: "text", text }, { type: "image", mediaType, data }].
function partsOf(content) {
  if (typeof content == "string") {
    return [{ type: "text", text: content }];
  }
  return (Array.isArray(content) ? content : []).filter(part => part?.type == "text" || part?.type == "image");
}

function isStream(response) {
  return /event-stream|ndjson/i.test(response.headers.get("content-type") ?? "");
}

// A whole JSON answer read like a one-chunk stream.
async function* oneChunk(response) {
  yield { json: await response.json() };
}

async function* oneObject(response) {
  yield await response.json();
}

// An error that arrived inside a stream.
function streamError(type, message) {
  const text = `${type ?? ""} ${message ?? ""}`;
  let code = "failed";
  if (/rate_limit|RESOURCE_EXHAUSTED|rate limit/i.test(text)) {
    code = "rate-limited";
  } else if (/insufficient_quota|usage limit|credit balance/i.test(text)) {
    code = "plan-limit";
  } else if (/overloaded|UNAVAILABLE|api_error|server_error/i.test(text)) {
    code = "unavailable";
  }
  const failure = new WhimsyAIError(code, String(message || type || code));
  failure.detail = String(message ?? "");
  return failure;
}

// When a limit resets, from Retry-After (seconds or a date) or Anthropic's
// reset header.
function retryAt(headers) {
  const after = headers.get("retry-after");
  if (after) {
    const seconds = Number(after);
    if (Number.isFinite(seconds)) {
      return Date.now() + seconds * 1000;
    }
    const date = Date.parse(after);
    if (Number.isFinite(date)) {
      return date;
    }
  }
  const reset = Date.parse(headers.get("anthropic-ratelimit-requests-reset") ?? "");
  return Number.isFinite(reset) ? reset : null;
}

/**
 * When a limit message says it resets ("resets 10pm", "resets at 10:30 PM",
 * "resets in 2 hours", or Claude Code's "|<seconds since 1970>"), as a
 * time; null when it doesn't say.
 */
export function parseResetTime(text, now = Date.now()) {
  const value = String(text ?? "");
  const epoch = value.match(/\|(\d{10})\b/);
  if (epoch) {
    return Number(epoch[1]) * 1000;
  }
  const inMatch = value.match(/resets?\s+in\s+(\d+)\s*(minute|min|hour|hr|h|m)/i);
  if (inMatch) {
    const unit = /^h/i.test(inMatch[2]) ? 3600 * 1000 : 60 * 1000;
    return now + Number(inMatch[1]) * unit;
  }
  const at = value.match(/resets?\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i);
  if (at) {
    let hours = Number(at[1]) % 24;
    const minutes = Number(at[2] ?? 0);
    const half = at[3]?.toLowerCase();
    if (half == "pm" && hours < 12) {
      hours += 12;
    } else if (half == "am" && hours == 12) {
      hours = 0;
    }
    if (hours > 23 || minutes > 59) {
      return null;
    }
    const date = new Date(now);
    date.setHours(hours, minutes, 0, 0);
    if (date.getTime() <= now) {
      date.setDate(date.getDate() + 1);
    }
    return date.getTime();
  }
  return null;
}

// The Responses API's input: plain text for one user message, else turns.
function openaiInput(messages) {
  if (messages.length == 1 && messages[0].role == "user" && typeof messages[0].content == "string") {
    return messages[0].content;
  }
  return messages.map(m => ({
    role: m.role,
    content: partsOf(m.content).map(part =>
      part.type == "image"
        ? { type: "input_image", image_url: `data:${part.mediaType};base64,${part.data}` }
        : { type: m.role == "assistant" ? "output_text" : "input_text", text: part.text }
    ),
  }));
}

// The answer text in a finished Responses API output (refusals throw).
export function responsesText(output) {
  const parts = (output || []).flatMap(item => (item.type == "message" ? item.content || [] : []));
  if (parts.some(part => part.type == "refusal")) {
    throw new WhimsyAIError("refused");
  }
  return parts.filter(part => part.type == "output_text").map(part => part.text).join("");
}

// A Responses API stream as AIEvents. mapCode turns OpenAI's error codes
// into Whimsy's (the ChatGPT plan has its own).
export async function* responsesEvents(body, mapCode = null) {
  let streamed = false;
  let refused = false;
  let citations = 0;
  const failed = async (code, message) => {
    const mapped = (mapCode && (await mapCode(code))) || null;
    if (mapped) {
      return new WhimsyAIError(mapped, message || mapped);
    }
    return streamError(code, message);
  };
  for await (const { event, json } of lazy.sseJSON(body)) {
    switch (json?.type || event) {
      case "response.output_text.delta":
        if (typeof json.delta == "string" && json.delta) {
          streamed = true;
          yield { type: "text", delta: json.delta };
        }
        break;
      case "response.reasoning_summary_text.delta":
        if (typeof json.delta == "string" && json.delta) {
          yield { type: "thinking", text: json.delta };
        }
        break;
      case "response.output_text.annotation.added":
        if (json.annotation?.type == "url_citation" && json.annotation.url) {
          yield { type: "citation", n: ++citations, source: { url: json.annotation.url, title: json.annotation.title ?? "" } };
        }
        break;
      case "response.refusal.delta":
      case "response.refusal.done":
        refused = true;
        break;
      case "response.completed": {
        if (refused) {
          throw new WhimsyAIError("refused");
        }
        if (!streamed) {
          const text = responsesText(json.response?.output);
          if (text) {
            yield { type: "text", delta: text };
          }
        }
        return;
      }
      case "response.failed":
        throw await failed(json.response?.error?.code, json.response?.error?.message);
      case "response.incomplete":
        throw new WhimsyAIError("bad-response", "The answer stopped before it was complete");
      case "error":
        throw await failed(json.code ?? json.error?.code, json.message ?? json.error?.message);
    }
  }
  // Only response.completed means the answer is whole.
  throw new WhimsyAIError("bad-response", "The stream ended early");
}

function aborted(signal) {
  return new Promise((_, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
    }
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}
