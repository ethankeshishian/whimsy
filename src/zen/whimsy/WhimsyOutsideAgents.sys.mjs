/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// W23: outside agents (Claude Code, Codex, Cursor, VS Code, Claude Desktop,
// or any MCP client) using Whimsy through its connector script.
//
// - connect(id) adds Whimsy to an app's MCP config: Claude Code through its
//   own `claude mcp add`, the others by editing their JSON or TOML file
//   after a `.whimsy-backup` copy. The config names only the connector
//   script; the token stays in the private profile file (0600).
// - Apps that connected are listed (by the name they give) with when they
//   were last used; remove() forgets one and takes Whimsy out of its config.
// - "Keep apps in their own space" (off by default) makes a normal, visible
//   AI space with its own container and limits outside apps to it.
//   Outside apps otherwise use every space under the same rules as
//   Whimsy's agent (never private; hidden or locked only when asked).

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  BrowserWindowTracker: "resource:///modules/BrowserWindowTracker.sys.mjs",
  ContextualIdentityService: "resource://gre/modules/ContextualIdentityService.sys.mjs",
  PrivateBrowsingUtils: "resource://gre/modules/PrivateBrowsingUtils.sys.mjs",
  Subprocess: "resource://gre/modules/Subprocess.sys.mjs",
  WhimsyAIStore: "resource:///modules/whimsy/WhimsyAIStore.sys.mjs",
  WhimsyClaude: "resource:///modules/whimsy/WhimsyClaude.sys.mjs",
});

const ENABLED_PREF = "whimsy.ai.outside-agents";
const OWN_SPACE_PREF = "whimsy.ai.outside-agents.own-space";
const SPACE_ID_PREF = "whimsy.ai.outside-agents.space-id";
const APPS_DOC = "outside-apps";
const MAX_APPS = 30;
const SERVER_NAME = "whimsy";
const BACKUP_SUFFIX = ".whimsy-backup";
const SPACE_ICON = "chrome://browser/skin/zen-icons/sparkles.svg";

let homeOverride = null;
let runner = null;
let observing = false;
let ensuring = null;

function home(...parts) {
  const base = homeOverride ?? Services.dirsvc.get("Home", Ci.nsIFile).path;
  return PathUtils.join(base, ...parts.flatMap(p => p.split("/")));
}

// Where each app keeps its MCP servers (checked against each app's docs,
// 2026-11): Claude Code's user scope is ~/.claude.json, written by its CLI.
const TARGETS = {
  "claude-code": {
    name: "Claude Code",
    format: "cli",
    config: () => home(".claude.json"),
    detect: () => [home(".claude"), ...claudeBinaries()],
  },
  codex: {
    name: "Codex",
    format: "toml",
    config: () => home(".codex/config.toml"),
    detect: () => [home(".codex")],
  },
  cursor: {
    name: "Cursor",
    format: "json",
    key: "mcpServers",
    config: () => home(".cursor/mcp.json"),
    detect: () => [home(".cursor"), "/Applications/Cursor.app"],
  },
  vscode: {
    name: "VS Code",
    format: "json",
    key: "servers",
    entry: { type: "stdio" },
    config: () => home("Library/Application Support/Code/User/mcp.json"),
    detect: () => [home("Library/Application Support/Code/User"), "/Applications/Visual Studio Code.app"],
  },
  "claude-desktop": {
    name: "Claude",
    format: "json",
    key: "mcpServers",
    config: () => home("Library/Application Support/Claude/claude_desktop_config.json"),
    detect: () => [home("Library/Application Support/Claude"), "/Applications/Claude.app"],
  },
};

function claudeBinaries() {
  return [home(".local/bin/claude"), home(".claude/local/claude"), "/opt/homebrew/bin/claude", "/usr/local/bin/claude"];
}

function slug(name) {
  return String(name ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);
}

function tomlString(value) {
  return `"${String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

// The file as it is now, copied beside it before Whimsy changes it.
async function backup(path) {
  if (!(await IOUtils.exists(path))) {
    return null;
  }
  const copy = path + BACKUP_SUFFIX;
  await IOUtils.copy(path, copy);
  await IOUtils.setPermissions(copy, 0o600, false);
  return copy;
}

// Replaces a file atomically, keeping its mode (new files are 0600).
async function writeKeepingMode(path, contents) {
  const mode = (await IOUtils.exists(path)) ? (await IOUtils.stat(path)).permissions & 0o777 : 0o600;
  const dir = PathUtils.parent(path);
  await IOUtils.makeDirectory(dir, { ignoreExisting: true, createAncestors: true, permissions: 0o700 });
  const tmp = await IOUtils.createUniqueFile(dir, ".whimsy-write", 0o600);
  try {
    await IOUtils.writeUTF8(tmp, contents);
    await IOUtils.setPermissions(tmp, mode, false);
    await IOUtils.move(tmp, path);
  } finally {
    await IOUtils.remove(tmp, { ignoreAbsent: true });
  }
}

async function readJSON(path) {
  if (!(await IOUtils.exists(path))) {
    return {};
  }
  const raw = (await IOUtils.readUTF8(path)).trim();
  if (!raw) {
    return {};
  }
  const value = JSON.parse(raw);
  if (!value || typeof value != "object" || Array.isArray(value)) {
    throw new Error(`${path} isn't a JSON object`);
  }
  return value;
}

// Without Whimsy's table ([mcp_servers.whimsy] up to the next table).
function tomlWithout(text) {
  const lines = String(text ?? "").split("\n");
  const out = [];
  let skipping = false;
  for (const line of lines) {
    const header = line.match(/^\s*\[([^\]]+)\]\s*$/);
    if (header) {
      skipping = header[1].trim() == `mcp_servers.${SERVER_NAME}` || header[1].trim().startsWith(`mcp_servers.${SERVER_NAME}.`);
    }
    if (!skipping) {
      out.push(line);
    }
  }
  return out.join("\n").replace(/\n{3,}$/, "\n\n");
}

async function run(command, args) {
  if (runner) {
    return runner(command, args);
  }
  const proc = await lazy.Subprocess.call({ command, arguments: args, stderr: "stdout" });
  let output = "";
  for (let chunk; (chunk = await proc.stdout.readString());) {
    output += chunk;
  }
  const { exitCode } = await proc.wait();
  return { exitCode, output };
}

export const WhimsyOutsideAgents = {
  TARGETS,

  get enabled() {
    return Services.prefs.getBoolPref(ENABLED_PREF, false);
  },

  set enabled(value) {
    Services.prefs.setBoolPref(ENABLED_PREF, !!value);
  },

  get ownSpace() {
    return Services.prefs.getBoolPref(OWN_SPACE_PREF, false);
  },

  get ownSpaceId() {
    return Services.prefs.getStringPref(SPACE_ID_PREF, "");
  },

  init() {
    if (observing) {
      return;
    }
    observing = true;
    // Not inside the pref notification: the space is made on the next turn.
    Services.prefs.addObserver(OWN_SPACE_PREF, () => Services.tm.dispatchToMainThread(() => {
      const win = this.window();
      if (this.ownSpace && win) {
        this.ensureOwnSpace(win).catch(e => console.error("Whimsy: outside agents space", e));
      }
    }));
  },

  window() {
    for (const win of lazy.BrowserWindowTracker.orderedWindows) {
      if (!win.closed && win.toolbar.visible && !win._whimsyQuickWindow && !lazy.PrivateBrowsingUtils.isWindowPrivate(win)) {
        return win;
      }
    }
    return null;
  },

  // --- Apps that connected ---

  async apps() {
    const list = await lazy.WhimsyAIStore.readDoc(APPS_DOC, []);
    return (Array.isArray(list) ? list : []).slice().sort((a, b) => (b.lastUsed ?? 0) - (a.lastUsed ?? 0));
  },

  /** An app connected (MCP initialize), by the name it gives. */
  async noteApp(name) {
    const id = slug(name);
    if (!id) {
      return;
    }
    const list = await this.apps();
    const now = Date.now();
    const existing = list.find(a => a.id == id);
    if (existing) {
      existing.lastUsed = now;
    } else {
      list.unshift({ id, name: String(name).slice(0, 60), lastUsed: now });
    }
    await lazy.WhimsyAIStore.writeDoc(APPS_DOC, list.slice(0, MAX_APPS));
    Services.obs.notifyObservers(null, "whimsy-outside-agents-changed");
  },

  /** Forgets an app, and takes Whimsy out of its config when Whimsy put it there. */
  async remove(id) {
    const list = await this.apps();
    await lazy.WhimsyAIStore.writeDoc(APPS_DOC, list.filter(a => a.id != id));
    const target = TARGETS[id] ?? Object.entries(TARGETS).find(([, t]) => slug(t.name) == id)?.[1];
    if (target) {
      await this.unwrite(target).catch(e => console.error("Whimsy: outside agents remove", e));
    }
    Services.obs.notifyObservers(null, "whimsy-outside-agents-changed");
  },

  // --- One-click connect ---

  /** Apps found on this Mac that can connect. */
  async detect() {
    const found = [];
    for (const [id, target] of Object.entries(TARGETS)) {
      for (const path of target.detect()) {
        if (await IOUtils.exists(path).catch(() => false)) {
          found.push({ id, name: target.name, configPath: target.config() });
          break;
        }
      }
    }
    return found;
  },

  connectInfo() {
    return lazy.WhimsyClaude.connectInfo();
  },

  /**
   * Adds Whimsy to an app's MCP servers. Turns outside agents on first.
   * Returns {path, backupPath}.
   */
  async connect(id) {
    const target = TARGETS[id];
    if (!target) {
      throw new Error(`Unknown app ${id}`);
    }
    if (!this.enabled) {
      this.enabled = true;
    }
    const info = lazy.WhimsyClaude.connectInfo() ?? (await lazy.WhimsyClaude.start());
    if (!info?.bridgePath) {
      throw new Error("Outside agents aren't available while AI is off");
    }
    const path = target.config();
    if (target.format == "cli") {
      const claude = await this.claudeBinary();
      if (!claude) {
        throw new Error("Claude Code isn't installed");
      }
      const backupPath = await backup(path);
      await run(claude, ["mcp", "remove", "-s", "user", SERVER_NAME]).catch(() => null);
      const result = await run(claude, ["mcp", "add", "-s", "user", SERVER_NAME, "--", info.bridgePath]);
      if (result?.exitCode) {
        throw new Error(`claude mcp add failed: ${String(result.output ?? "").slice(0, 200)}`);
      }
      return { path, backupPath };
    }
    if (target.format == "json") {
      const config = await readJSON(path);
      const backupPath = await backup(path);
      const servers = config[target.key] && typeof config[target.key] == "object" ? config[target.key] : {};
      servers[SERVER_NAME] = { ...(target.entry ?? {}), command: info.bridgePath, args: [] };
      config[target.key] = servers;
      await writeKeepingMode(path, JSON.stringify(config, null, 2) + "\n");
      return { path, backupPath };
    }
    const before = (await IOUtils.exists(path)) ? await IOUtils.readUTF8(path) : "";
    const backupPath = await backup(path);
    const kept = tomlWithout(before).replace(/\s*$/, "");
    const table = `[mcp_servers.${SERVER_NAME}]\ncommand = ${tomlString(info.bridgePath)}\nargs = []\n`;
    await writeKeepingMode(path, (kept ? kept + "\n\n" : "") + table);
    return { path, backupPath };
  },

  async unwrite(target) {
    const path = target.config();
    if (target.format == "cli") {
      const claude = await this.claudeBinary();
      if (claude) {
        await backup(path);
        await run(claude, ["mcp", "remove", "-s", "user", SERVER_NAME]);
      }
      return;
    }
    if (!(await IOUtils.exists(path))) {
      return;
    }
    if (target.format == "json") {
      const config = await readJSON(path);
      if (!config[target.key]?.[SERVER_NAME]) {
        return;
      }
      await backup(path);
      delete config[target.key][SERVER_NAME];
      await writeKeepingMode(path, JSON.stringify(config, null, 2) + "\n");
      return;
    }
    const text = await IOUtils.readUTF8(path);
    const kept = tomlWithout(text);
    if (kept != text) {
      await backup(path);
      await writeKeepingMode(path, kept);
    }
  },

  async claudeBinary() {
    for (const path of claudeBinaries()) {
      if (await IOUtils.exists(path).catch(() => false)) {
        return path;
      }
    }
    return null;
  },

  // --- Their own space (off by default) ---

  /** The AI space: a normal, visible space with its own container. */
  async ensureOwnSpace(win) {
    ensuring ??= this._ensureOwnSpace(win).finally(() => (ensuring = null));
    return ensuring;
  },

  async _ensureOwnSpace(win) {
    const spaces = win?.gZenWorkspaces;
    if (!spaces?.workspaceEnabled || spaces.privateWindowOrDisabled) {
      return null;
    }
    await spaces.promiseInitialized;
    const existing = spaces.getWorkspaces().find(ws => ws.uuid == this.ownSpaceId);
    if (existing) {
      return existing;
    }
    const [name] = await win.document.l10n.formatValues([{ id: "whimsy-outside-agents-space-name" }]);
    const identity = lazy.ContextualIdentityService.create(name || "AI", "circle", "orange");
    const last = spaces.getWorkspaces().filter(ws => !ws.whimsyScratch).at(-1);
    const space = await spaces.createAndSaveWorkspace(name || "AI", SPACE_ICON, true, identity.userContextId, {
      insertAfterId: last?.uuid ?? null,
    });
    if (!space) {
      return null;
    }
    // Zen names a space after its container in an unsynced window.
    space.name = name || "AI";
    space.icon = SPACE_ICON;
    spaces.saveWorkspace(space);
    Services.prefs.setStringPref(SPACE_ID_PREF, space.uuid);
    return space;
  },

  // --- Tests ---

  _setHomeForTesting(path) {
    homeOverride = path;
  },

  _setRunnerForTesting(fn) {
    runner = fn;
  },
};
