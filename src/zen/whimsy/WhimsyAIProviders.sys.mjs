/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// AI v1: the one provider every Whimsy AI feature talks to (Tidy Tabs, tab
// titles, Ask on Page, 5-second previews, Watch a page). The person picks
// it in Settings → Privacy & Security → AI:
//   - "apple":  Apple's on-device model (Foundation Models, macOS 26+). The
//               framework is Swift-only, so a tiny helper is compiled with
//               the Xcode command line tools on first use and cached in the
//               profile. Nothing leaves the Mac.
//   - "claude": the Claude Messages API with the person's own API key.
//   - "ollama": a local Ollama server.
// Rules (user, Oct 29): only the chosen provider is ever contacted; there's
// no automatic fallback to the cloud. The AI kill switch (whimsy.ai.blocked,
// WhimsyAI.sys.mjs) refuses every request and aborts the ones in flight.
// The API key never goes into prefs: it's encrypted with OSKeyStore (the
// macOS Keychain) and the ciphertext lives in the profile.

import { clearTimeout, setTimeout } from "resource://gre/modules/Timer.sys.mjs";

const lazy = {};
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
const BLOCKED_PREF = "whimsy.ai.blocked";

export const PROVIDERS = ["apple", "claude", "ollama"];
const DEFAULT_PROVIDER = "apple";
// Latest Claude (user: "Default model: latest Claude").
const DEFAULT_CLAUDE_MODEL = "claude-opus-5-5";
const CLAUDE_URL = "https://api.anthropic.com/v1/messages";
const KEY_FILE = "whimsy-ai-keys.json";
const REQUEST_TIMEOUT_MS = 90 * 1000;

// Apple's on-device model has a 4,096-token window shared by the prompt and
// the answer, so its inputs are cut much shorter than the others'.
const MAX_INPUT_CHARS = { apple: 7000, claude: 60000, ollama: 24000, test: 60000 };

// Bump when the Swift source changes so a stale helper is rebuilt.
const HELPER_VERSION = 1;
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
      return
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
  "apple-tools-path-invalid",
  "apple-needs-license",
  "apple-build-failed",
  "apple-intelligence-off",
  "apple-not-ready",
  "apple-not-set-up",
  "refused",
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
  _appleReady: null,

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
    return this.provider == "claude";
  },

  get maxInputChars() {
    return MAX_INPUT_CHARS[this.provider] ?? 20000;
  },

  // The toast for a failed request (nothing when the person cancelled).
  showError(win, error) {
    const code = error?.code;
    if (code == "aborted" || !win?.gZenUIManager) {
      return;
    }
    win.gZenUIManager.showToast(`whimsy-ai-error-${AI_ERROR_CODES.includes(code) ? code : "failed"}`);
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
    Services.prefs.addObserver(BLOCKED_PREF, abortAll);
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
      let text;
      switch (this.provider) {
        case "test":
          text = await Promise.race([this._testProvider(request), aborted(controller.signal)]);
          break;
        case "claude":
          text = await this._claude(request);
          break;
        case "ollama":
          text = await this._ollama(request);
          break;
        default:
          text = await this._apple(request);
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
      case "claude":
        return this.hasClaudeKey();
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
      response = await fetch(CLAUDE_URL, {
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

  async hasClaudeKey() {
    try {
      const saved = await IOUtils.readJSON(this._keyPath);
      return !!saved?.claude;
    } catch {
      return false;
    }
  },

  async getClaudeKey() {
    let saved;
    try {
      saved = await IOUtils.readJSON(this._keyPath);
    } catch {
      return "";
    }
    if (!saved?.claude) {
      return "";
    }
    try {
      return await lazy.OSKeyStore.decrypt(saved.claude);
    } catch (error) {
      console.error("Whimsy AI: couldn't decrypt the Claude API key", error);
      return "";
    }
  },

  // Saves (or, with an empty key, forgets) the Claude API key.
  async setClaudeKey(key) {
    const value = String(key ?? "").trim();
    if (!value) {
      await IOUtils.remove(this._keyPath, { ignoreAbsent: true });
      return;
    }
    // Creates the Keychain secret on first use; no prompt (reauth = false).
    await lazy.OSKeyStore.ensureLoggedIn(false);
    const claude = await lazy.OSKeyStore.encrypt(value);
    await IOUtils.writeJSON(this._keyPath, { claude }, { tmpPath: this._keyPath + ".tmp" });
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

  // The SDK folders a developer folder may have (command line tools, Xcode).
  _sdkPaths(dir) {
    return [
      PathUtils.join(dir, "SDKs", "MacOSX.sdk"),
      PathUtils.join(dir, "Platforms", "MacOSX.platform", "Developer", "SDKs", "MacOSX.sdk"),
    ];
  },

  // Finds the tools to build the helper with: { developerDir, sdk } or a
  // WhimsyAIError code: "apple-needs-tools" (no swiftc anywhere) or
  // "apple-tools-outdated" (swiftc, but no SDK with FoundationModels).
  // Never runs xcrun: without the tools it pops up macOS's install dialog.
  async _findToolchain() {
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
    for (const dir of dirs) {
      let swiftc = false;
      for (const rel of ["usr/bin/swiftc", "Toolchains/XcodeDefault.xctoolchain/usr/bin/swiftc"]) {
        if (await IOUtils.exists(PathUtils.join(dir, ...rel.split("/")))) {
          swiftc = true;
        }
      }
      if (!swiftc) {
        continue;
      }
      hasSwiftc = true;
      for (const sdk of this._sdkPaths(dir)) {
        if (await IOUtils.exists(PathUtils.join(sdk, "System", "Library", "Frameworks", "FoundationModels.framework"))) {
          return { developerDir: dir, sdk };
        }
      }
    }
    return hasSwiftc ? "apple-tools-outdated" : "apple-needs-tools";
  },

  // What a failed swiftc build means, from its output.
  _buildFailure(output) {
    if (/license/i.test(output)) {
      return "apple-needs-license";
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
  // then reuses it.
  _ensureHelper() {
    if (Services.appinfo.OS != "Darwin") {
      return Promise.reject(new WhimsyAIError("unavailable"));
    }
    this._helperPromise ??= (async () => {
      const path = this._helperPath;
      if (await IOUtils.exists(path)) {
        return path;
      }
      const toolchain = await this._findToolchain();
      if (typeof toolchain == "string") {
        throw new WhimsyAIError(toolchain);
      }
      const dir = PathUtils.parent(path);
      await IOUtils.makeDirectory(dir, { ignoreExisting: true });
      const source = PathUtils.join(dir, "WhimsyFM.swift");
      await IOUtils.writeUTF8(source, HELPER_SOURCE);
      let result;
      try {
        result = await this._run(
          "/usr/bin/xcrun",
          ["swiftc", "-O", "-parse-as-library", "-sdk", toolchain.sdk, "-o", path, source],
          { environment: { DEVELOPER_DIR: toolchain.developerDir }, environmentAppend: true }
        );
      } catch (e) {
        console.error("Whimsy AI: couldn't run swiftc", e);
        throw new WhimsyAIError("apple-build-failed");
      }
      if (result.exitCode != 0 || !(await IOUtils.exists(path))) {
        console.error("Whimsy AI: building the on-device helper failed", toolchain, result.output);
        throw new WhimsyAIError(this._buildFailure(result.output));
      }
      return path;
    })();
    // A failed build may succeed later (tools installed), so don't cache it.
    this._helperPromise.catch(() => (this._helperPromise = null));
    return this._helperPromise;
  },

  // "available", or why not: "unavailable", "apple-needs-tools",
  // "apple-tools-outdated", "apple-needs-license", "apple-build-failed",
  // "apple-intelligence-off", "apple-not-ready", or (with build: false,
  // before the helper exists) "not-set-up".
  async appleStatus({ build = true } = {}) {
    this._appleReady = null;
    if (!build && !(await IOUtils.exists(this._helperPath))) {
      return Services.appinfo.OS == "Darwin" ? "not-set-up" : "unavailable";
    }
    let path;
    try {
      path = await this._ensureHelper();
    } catch (error) {
      return error.code || "unavailable";
    }
    try {
      const proc = await lazy.Subprocess.call({ command: path, arguments: ["--check"], stderr: "stdout" });
      const output = (await proc.stdout.readString()).trim();
      await proc.wait();
      if (output == "available") {
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
