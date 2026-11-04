/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Claude plan, through Claude Code (W14 19). Anthropic lets a product run
// the person's own, unmodified Claude Code signed in with their own plan
// (code.claude.com/docs/en/legal-and-compliance, "Authentication and
// credential use"); Whimsy accepts Anthropic's Commercial Terms for that.
// So Whimsy runs the installed `claude` with a fixed argument list (no
// shell), never reads Claude Code's credentials, never calls Anthropic's
// sign-in itself and never restricts how Claude Code signs in. Plan limits
// assume ordinary, individual use: only things the person starts use it.

import { clearTimeout, setTimeout } from "resource://gre/modules/Timer.sys.mjs";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  Subprocess: "resource://gre/modules/Subprocess.sys.mjs",
  WhimsyAIError: "resource:///modules/whimsy/WhimsyAIProviders.sys.mjs",
  WhimsyAIProviders: "resource:///modules/whimsy/WhimsyAIProviders.sys.mjs",
});

const GATE_PREF = "whimsy.feature.ai-claude-plan";
const MODEL_PREF = "whimsy.ai.claude.model";
const WATCHED_PREFS = ["whimsy.ai.enabled", "whimsy.feature.ai-providers", GATE_PREF];
const USAGE_URL = "https://claude.ai/settings/usage";
const STATUS_TTL_MS = 30 * 1000;
const STATUS_TIMEOUT_MS = 20 * 1000;
const SIGN_IN_TIMEOUT_MS = 5 * 60 * 1000;
const SIGN_IN_POLL_MS = 2000;
const MAX_OUTPUT = 4 * 1024 * 1024;
const SIGNED_OUT = /not logged in|please run \/login|run \/login|invalid api key|oauth token (?:has )?expired|authentication_error|not authenticated/i;
const LIMIT = /usage limit|limit reached|limit will reset|out of (?:extra )?usage|rate_limit_error|credit balance is too low/i;

const error = (code, message) => new lazy.WhimsyAIError(code, message);

export const WhimsyAIClaudeCode = {
  userStartedOnly: true,
  _testDirs: null,
  _status: null,
  _pending: null,

  // Tests only: where to look for `claude` instead of the usual places.
  setTestSearchPath(dirs) {
    if (dirs && !Cu.isInAutomation) {
      throw new Error("The test search path is for automated tests only");
    }
    this._testDirs = dirs || null;
    this._status = null;
  },

  get _searchDirs() {
    if (this._testDirs) {
      return this._testDirs;
    }
    const home = Services.dirsvc.get("Home", Ci.nsIFile).path;
    const fromEnv = (Services.env.get("PATH") || "").split(":").filter(Boolean);
    return [
      PathUtils.join(home, ".local", "bin"),
      PathUtils.join(home, ".claude", "local"),
      "/opt/homebrew/bin",
      "/usr/local/bin",
      PathUtils.join(home, ".npm-global", "bin"),
      PathUtils.join(home, ".bun", "bin"),
      ...fromEnv,
      "/usr/bin",
      "/bin",
    ];
  },

  // The installed `claude`, or "" (not installed).
  async _find() {
    try {
      return await lazy.Subprocess.pathSearch("claude", { PATH: [...new Set(this._searchDirs)].join(":") });
    } catch {
      return "";
    }
  },

  /**
   * Runs `claude` with fixed arguments. The environment is the person's,
   * with PATH widened so a Node-based install finds node.
   *
   * @returns {Promise<{ exitCode: number, stdout: string, stderr: string }>}
   */
  async _run(command, args, { input = null, signal = null, timeoutMs = 0 } = {}) {
    const environment = Object.assign(lazy.Subprocess.getEnvironment(), {
      PATH: [...new Set([PathUtils.parent(command), ...this._searchDirs, "/usr/bin", "/bin", "/usr/sbin", "/sbin"])].join(":"),
    });
    const workdir = PathUtils.join(PathUtils.tempDir, "whimsy-claude-code");
    await IOUtils.makeDirectory(workdir, { permissions: 0o700 });
    const proc = await lazy.Subprocess.call({ command, arguments: args, environment, workdir, stderr: "pipe" });
    let killed = null;
    const kill = reason => {
      killed ??= reason;
      proc.kill();
    };
    const onAbort = () => kill("aborted");
    signal?.addEventListener("abort", onAbort, { once: true });
    const timer = timeoutMs ? setTimeout(() => kill("timeout"), timeoutMs) : null;
    const readAll = async pipe => {
      let text = "";
      for (let chunk; (chunk = await pipe.readString()); ) {
        if (text.length < MAX_OUTPUT) {
          text += chunk;
        }
      }
      return text;
    };
    try {
      const writing = (async () => {
        if (input != null) {
          await proc.stdin.write(input);
        }
        await proc.stdin.close();
      })().catch(() => {});
      const [stdout, stderr] = await Promise.all([readAll(proc.stdout), readAll(proc.stderr)]);
      await writing;
      const { exitCode } = await proc.wait();
      if (killed) {
        throw signal?.aborted ? signal.reason ?? error("aborted") : error(killed);
      }
      return { exitCode, stdout, stderr };
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  },

  // Claude Code's own account status (`claude auth status`), for a short
  // while from memory.
  async _authStatus({ fresh = false } = {}) {
    if (!fresh && this._status && Date.now() - this._status.at < STATUS_TTL_MS) {
      return this._status.value;
    }
    const command = await this._find();
    let value;
    if (!command) {
      value = { installed: false, loggedIn: false };
    } else {
      value = { installed: true, loggedIn: false, email: "" };
      try {
        const { stdout } = await this._run(command, ["auth", "status", "--json"], { timeoutMs: STATUS_TIMEOUT_MS });
        const status = JSON.parse(stdout.slice(stdout.indexOf("{")));
        value.loggedIn = status?.loggedIn === true;
        value.email = typeof status?.email == "string" ? status.email : "";
      } catch {}
    }
    this._status = { at: Date.now(), value };
    return value;
  },

  // ---- What WhimsyAIProviders asks of a plan ----

  async status() {
    const status = await this._authStatus();
    return { connected: true, label: status.email ?? "", signedOut: !status.loggedIn };
  },

  async isReady() {
    return (await this._authStatus()).loggedIn;
  },

  manageUsage(win) {
    win?.openTrustedLinkIn?.(USAGE_URL, "tab");
  },

  async models() {
    return [];
  },

  /**
   * Connects: Claude Code has to be installed; when it isn't signed in, its
   * own sign-in (`claude auth login`, which opens Anthropic's page) runs
   * until it's done, cancelled or five minutes pass.
   */
  connect() {
    if (this._pending) {
      return this._pending.promise;
    }
    const pending = { cancelled: false, cancel: () => (pending.cancelled = true) };
    pending.promise = this._connect(pending).finally(() => {
      if (this._pending == pending) {
        this._pending = null;
      }
    });
    this._pending = pending;
    return pending.promise;
  },

  cancel() {
    this._pending?.cancel();
  },

  get signingIn() {
    return !!this._pending;
  },

  async _connect(pending) {
    const status = await this._authStatus({ fresh: true });
    if (!status.installed) {
      throw error("claude-code-missing");
    }
    if (status.loggedIn) {
      return { label: status.email };
    }
    const command = await this._find();
    const controller = new AbortController();
    pending.cancel = () => {
      pending.cancelled = true;
      controller.abort(error("sign-in-cancelled"));
    };
    const watcher = () => {
      if (!lazy.WhimsyAIProviders.enabled || !Services.prefs.getBoolPref(GATE_PREF, false)) {
        pending.cancel();
      }
    };
    for (const pref of WATCHED_PREFS) {
      Services.prefs.addObserver(pref, watcher);
    }
    try {
      const login = this._run(command, ["auth", "login"], {
        signal: controller.signal,
        timeoutMs: SIGN_IN_TIMEOUT_MS,
      }).then(
        () => "exited",
        () => "exited"
      );
      for (;;) {
        const step = await Promise.race([login, new Promise(resolve => setTimeout(resolve, SIGN_IN_POLL_MS, "poll"))]);
        if (pending.cancelled) {
          throw error("sign-in-cancelled");
        }
        const now = await this._authStatus({ fresh: true });
        if (now.loggedIn) {
          controller.abort(error("aborted"));
          return { label: now.email };
        }
        if (step == "exited") {
          throw error("claude-code-signed-out");
        }
      }
    } finally {
      for (const pref of WATCHED_PREFS) {
        Services.prefs.removeObserver(pref, watcher);
      }
    }
  },

  async disconnect() {
    this.cancel();
    this._status = null;
  },

  async complete({ prompt, system, signal, userStarted }) {
    if (!userStarted) {
      throw error("plan-user-only");
    }
    const command = await this._find();
    if (!command) {
      throw error("claude-code-missing");
    }
    const args = ["-p", "--output-format", "json", "--tools", "", "--strict-mcp-config", "--no-session-persistence"];
    if (system) {
      args.push("--system-prompt", system);
    }
    if (Services.prefs.prefHasUserValue(MODEL_PREF)) {
      args.push("--model", Services.prefs.getStringPref(MODEL_PREF));
    }
    const { exitCode, stdout, stderr } = await this._run(command, args, { input: String(prompt ?? ""), signal });
    let result = null;
    for (const line of stdout.trim().split("\n").reverse()) {
      try {
        const parsed = JSON.parse(line);
        if (parsed?.type == "result") {
          result = parsed;
          break;
        }
      } catch {}
    }
    if (result && !result.is_error && result.subtype == "success" && typeof result.result == "string") {
      return result.result;
    }
    const said = `${typeof result?.result == "string" ? result.result : ""}\n${stderr}`;
    if (SIGNED_OUT.test(said)) {
      this._status = null;
      Services.obs.notifyObservers(null, "whimsy-ai-accounts-changed", "claude");
      throw error("claude-code-signed-out");
    }
    if (LIMIT.test(said)) {
      throw error("plan-limit");
    }
    throw error("failed", `Claude Code exited with ${exitCode}`);
  },
};
