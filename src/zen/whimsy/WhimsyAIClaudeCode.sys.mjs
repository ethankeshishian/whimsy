/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Claude plan, through Claude Code (W14 19). Anthropic lets a product run
// the person's own, unmodified Claude Code signed in with their own plan
// (code.claude.com/docs/en/legal-and-compliance, "Authentication and
// credential use"); Whimsy accepts Anthropic's Commercial Terms for that.
// So Whimsy runs the installed `claude` with a fixed argument list (no
// shell), never reads Claude Code's credentials, never calls Anthropic's
// sign-in itself and never restricts how Claude Code signs in. W23: every
// Whimsy feature may use the plan (routines, previews, the index too), and
// connectors reach it as a temporary --mcp-config for that one run.

import { clearTimeout, setTimeout } from "resource://gre/modules/Timer.sys.mjs";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  Subprocess: "resource://gre/modules/Subprocess.sys.mjs",
  parseResetTime: "resource:///modules/whimsy/WhimsyAIProviders.sys.mjs",
  pipeChunks: "resource:///modules/whimsy/WhimsyAIStream.sys.mjs",
  textLines: "resource:///modules/whimsy/WhimsyAIStream.sys.mjs",
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
// Whether this Claude Code version streams on the plan: { version, streams }.
export const STREAM_PROBE_PREF = "whimsy.ai.claude-code.stream-probe";
const PROBE_TIMEOUT_MS = 60 * 1000;
const SIGNED_OUT = /not logged in|please run \/login|run \/login|invalid api key|oauth token (?:has )?expired|authentication_error|not authenticated/i;
const LIMIT = /usage limit|limit reached|limit will reset|out of (?:extra )?usage|rate_limit_error|credit balance is too low/i;

const error = (code, message) => new lazy.WhimsyAIError(code, message);

export const WhimsyAIClaudeCode = {
  usageUrl: USAGE_URL,
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
    const run = await this._spawn(command, args, { input, signal, timeoutMs });
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
      const [stdout, stderr] = await Promise.all([readAll(run.proc.stdout), readAll(run.proc.stderr)]);
      const { exitCode } = await run.finish();
      return { exitCode, stdout, stderr };
    } finally {
      run.cleanup();
    }
  },

  // Starts `claude`: { proc, finish() -> { exitCode } (throws when killed),
  // cleanup() }.
  async _spawn(command, args, { input = null, signal = null, timeoutMs = 0 } = {}) {
    const environment = Object.assign(lazy.Subprocess.getEnvironment(), {
      PATH: [...new Set([PathUtils.parent(command), ...this._searchDirs, "/usr/bin", "/bin", "/usr/sbin", "/sbin"])].join(":"),
    });
    const workdir = await this._workdir();
    const proc = await lazy.Subprocess.call({ command, arguments: args, environment, workdir, stderr: "pipe" });
    let killed = null;
    const kill = reason => {
      killed ??= reason;
      proc.kill();
    };
    const onAbort = () => kill("aborted");
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) {
      kill("aborted");
    }
    let timer = timeoutMs ? setTimeout(() => kill("timeout"), timeoutMs) : null;
    const writing = (async () => {
      if (input != null) {
        await proc.stdin.write(input);
      }
      await proc.stdin.close();
    })().catch(() => {});
    return {
      proc,
      kill,
      // Streams push the deadline back with each line.
      extend() {
        if (timer) {
          clearTimeout(timer);
          timer = setTimeout(() => kill("timeout"), timeoutMs);
        }
      },
      async finish() {
        await writing;
        const { exitCode } = await proc.wait();
        if (killed) {
          throw signal?.aborted && signal.reason instanceof lazy.WhimsyAIError ? signal.reason : error(killed);
        }
        return { exitCode };
      },
      cleanup() {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
      },
    };
  },

  // Claude Code runs in a private folder of its own (0700), where the
  // per-run connector files live too.
  async _workdir() {
    const workdir = PathUtils.join(PathUtils.tempDir, "whimsy-claude-code");
    await IOUtils.makeDirectory(workdir, { permissions: 0o700, ignoreExisting: true });
    await IOUtils.setPermissions(workdir, 0o700);
    return workdir;
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
        // An old Claude Code has no `auth login`: offer the verified update.
        ({ stdout, stderr }) => (/unknown command|unknown option|did you mean/i.test(`${stdout}\n${stderr}`) ? "outdated" : "exited"),
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
        if (step == "outdated") {
          throw error("claude-code-outdated");
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

  // Connectors as Claude Code's --mcp-config: { mcpServers: { name: … } }.
  // W23 secfix H1: only read-only tools are pre-approved (`allowed`); a
  // server marked `guard` is the run's --permission-prompt-tool, which
  // Claude Code asks before every other tool. No guard: every other tool
  // is refused, since nobody is asked in -p mode.
  _mcpConfig(servers) {
    const config = { mcpServers: {} };
    const names = [];
    const allowed = [];
    const shown = {};
    let guard = null;
    const clean = value => String(value ?? "").replace(/[^A-Za-z0-9_-]/g, "_");
    for (const server of servers) {
      let name = clean(server?.name).slice(0, 64) || "connector";
      while (config.mcpServers[name]) {
        name += "_";
      }
      if (server.url) {
        config.mcpServers[name] = { type: "http", url: String(server.url), ...(server.headers ? { headers: { ...server.headers } } : {}) };
      } else if (server.command) {
        config.mcpServers[name] = {
          type: "stdio",
          command: String(server.command),
          args: (server.args ?? []).map(String),
          ...(server.env ? { env: { ...server.env } } : {}),
        };
      } else {
        continue;
      }
      names.push(name);
      if (server.guard) {
        guard = { name, server };
        shown[name] = null;
        continue;
      }
      shown[name] = String(server.name ?? name);
      if (server.readOnly === true) {
        allowed.push(`mcp__${name}`);
      } else {
        for (const tool of Array.isArray(server.readOnlyTools) ? server.readOnlyTools : []) {
          allowed.push(`mcp__${name}__${clean(tool)}`);
        }
      }
    }
    guard?.server.bindNames?.(shown);
    return { config, names, allowed, permissionTool: guard ? `mcp__${guard.name}__confirm` : null };
  },

  /**
   * The fixed argument list. Claude Code's own tools stay off; connectors
   * are the only MCP servers it sees (from a 0600 file that's deleted after
   * the run). Only their read-only tools run without asking; any other
   * tool goes to the run's permission tool, or is refused without one.
   */
  _args({ systemFile = null, mcpFile = null, allowed = [], permissionTool = null, stream = false }) {
    const args = ["-p", "--output-format", stream ? "stream-json" : "json"];
    if (stream) {
      args.push("--verbose", "--include-partial-messages");
    }
    args.push("--tools", "");
    if (mcpFile) {
      args.push("--mcp-config", mcpFile, "--strict-mcp-config");
      if (allowed.length) {
        args.push("--allowedTools", allowed.join(","));
      }
      if (permissionTool) {
        args.push("--permission-prompt-tool", permissionTool);
      }
    } else {
      args.push("--strict-mcp-config");
    }
    args.push("--no-session-persistence");
    // L2: the system prompt (page text, memories) goes in a 0600 file,
    // never on the command line where `ps` shows it to other users.
    if (systemFile) {
      args.push("--system-prompt-file", systemFile);
    }
    if (Services.prefs.prefHasUserValue(MODEL_PREF)) {
      args.push("--model", Services.prefs.getStringPref(MODEL_PREF));
    }
    return args;
  },

  // Writes one run's private file (0600 in the 0700 folder, mode set before
  // anything is written); the caller deletes it.
  async _writePrivate(prefix, text) {
    const file = PathUtils.join(await this._workdir(), `${prefix}-${Services.uuid.generateUUID().toString().slice(1, -1)}`);
    await IOUtils.writeUTF8(file, "", { mode: "create" });
    await IOUtils.setPermissions(file, 0o600);
    await IOUtils.writeUTF8(file, text, { mode: "overwrite" });
    return file;
  },

  // Writes the run's connector file (0600 in the 0700 folder), or null.
  async _writeMcpConfig(servers) {
    const { config, names, allowed, permissionTool } = this._mcpConfig(servers ?? []);
    if (!names.length) {
      return { file: null, names, allowed: [], permissionTool: null };
    }
    const file = PathUtils.join(await this._workdir(), `mcp-${Services.uuid.generateUUID().toString().slice(1, -1)}.json`);
    await IOUtils.writeUTF8(file, "", { mode: "create" });
    await IOUtils.setPermissions(file, 0o600);
    await IOUtils.writeUTF8(file, JSON.stringify(config), { mode: "overwrite" });
    return { file, names, allowed, permissionTool };
  },

  // What went wrong, from what Claude Code said.
  _failure(said, exitCode) {
    if (SIGNED_OUT.test(said)) {
      this._status = null;
      Services.obs.notifyObservers(null, "whimsy-ai-accounts-changed", "claude");
      return error("claude-code-signed-out");
    }
    if (LIMIT.test(said)) {
      const failure = error("plan-limit");
      const words = said.trim().split("\n")[0].replace(/\|\d{10}\b/, "").trim();
      failure.detail = words.slice(0, 300);
      const until = lazy.parseResetTime(said);
      if (until) {
        failure.until = until;
      }
      return failure;
    }
    return error("failed", `Claude Code exited with ${exitCode}`);
  },

  async complete({ prompt, system, signal, mcpServers, tools }) {
    const command = await this._find();
    if (!command) {
      throw error("claude-code-missing");
    }
    const { file, allowed, permissionTool } = await this._writeMcpConfig(mcpServers ?? tools);
    const systemFile = system ? await this._writePrivate("system", String(system)) : null;
    try {
      const args = this._args({ systemFile, mcpFile: file, allowed, permissionTool });
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
      throw this._failure(`${typeof result?.result == "string" ? result.result : ""}\n${stderr}`, exitCode);
    } finally {
      for (const path of [file, systemFile].filter(Boolean)) {
        await IOUtils.remove(path, { ignoreAbsent: true });
      }
    }
  },

  /**
   * The answer as AIEvents through `--output-format stream-json
   * --include-partial-messages` (text and thinking deltas). Used only when
   * supportsStreamJson() said this version streams.
   */
  async *stream({ prompt, system, signal, mcpServers, tools }) {
    const command = await this._find();
    if (!command) {
      throw error("claude-code-missing");
    }
    const { file, allowed, permissionTool } = await this._writeMcpConfig(mcpServers ?? tools);
    const systemFile = system ? await this._writePrivate("system", String(system)) : null;
    let run = null;
    try {
      run = await this._spawn(command, this._args({ systemFile, mcpFile: file, allowed, permissionTool, stream: true }), {
        input: String(prompt ?? ""),
        signal,
      });
      const errors = (async () => {
        let text = "";
        for await (const chunk of lazy.pipeChunks(run.proc.stderr)) {
          if (text.length < MAX_OUTPUT) {
            text += chunk;
          }
        }
        return text;
      })();
      let streamed = false;
      let result = null;
      for await (const line of lazy.textLines(lazy.pipeChunks(run.proc.stdout))) {
        let parsed;
        try {
          parsed = JSON.parse(line);
        } catch {
          continue;
        }
        if (parsed?.type == "stream_event" && parsed.event?.type == "content_block_delta") {
          const delta = parsed.event.delta ?? {};
          if (delta.type == "text_delta" && delta.text) {
            streamed = true;
            yield { type: "text", delta: delta.text };
          } else if (delta.type == "thinking_delta" && delta.thinking) {
            yield { type: "thinking", text: delta.thinking };
          }
        } else if (parsed?.type == "result") {
          result = parsed;
        }
      }
      const stderr = await errors;
      const { exitCode } = await run.finish();
      if (result && !result.is_error && result.subtype == "success") {
        if (!streamed && typeof result.result == "string" && result.result) {
          yield { type: "text", delta: result.result };
        }
        return;
      }
      throw this._failure(`${typeof result?.result == "string" ? result.result : ""}\n${stderr}`, exitCode);
    } finally {
      try {
        run?.proc.kill();
      } catch {}
      run?.cleanup();
      for (const path of [file, systemFile].filter(Boolean)) {
        await IOUtils.remove(path, { ignoreAbsent: true });
      }
    }
  },

  /**
   * Whether Claude Code streams on the plan: one tiny stream-json run per
   * Claude Code version (cached by `claude --version`); partial text
   * deltas mean yes.
   */
  async supportsStreamJson() {
    const command = await this._find();
    if (!command) {
      return false;
    }
    let version = "";
    try {
      version = (await this._run(command, ["--version"], { timeoutMs: STATUS_TIMEOUT_MS })).stdout.trim();
    } catch {
      return false;
    }
    try {
      const cached = JSON.parse(Services.prefs.getStringPref(STREAM_PROBE_PREF, "{}"));
      if (cached?.version == version && typeof cached.streams == "boolean") {
        return cached.streams;
      }
    } catch {}
    let streams = false;
    let answered = false;
    try {
      const { stdout } = await this._run(command, this._args({ stream: true }), {
        input: "Reply with the word OK.",
        timeoutMs: PROBE_TIMEOUT_MS,
      });
      for (const line of stdout.split("\n")) {
        try {
          const parsed = JSON.parse(line);
          if (parsed?.type == "stream_event" && parsed.event?.delta?.type == "text_delta") {
            streams = true;
          }
          if (parsed?.type == "result" && !parsed.is_error) {
            answered = true;
          }
        } catch {}
      }
    } catch {
      return false;
    }
    // A probe that didn't get an answer (signed out, out of room) says
    // nothing about streaming, so it's tried again next time.
    if (answered) {
      Services.prefs.setStringPref(STREAM_PROBE_PREF, JSON.stringify({ version, streams }));
    }
    return streams;
  },
};
