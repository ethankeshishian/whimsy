/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// W28 plugins: the owner's own unsigned extensions in <profile>/whimsy-plugins
// (the loader and its approval are the XPIProvider, XPIDatabase, and
// ExtensionsUI patches). W30 extension builder: chat's write_plugin tool
// writes a plugin folder there. What it writes never runs until the person
// approves it through the same Run / Don't Run prompt, and a changed
// manifest asks again (the loader enforces both).

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  AddonManager: "resource://gre/modules/AddonManager.sys.mjs",
  AddonManagerPrivate: "resource://gre/modules/AddonManager.sys.mjs",
  ExtensionsUI: "resource:///modules/ExtensionsUI.sys.mjs",
  WhimsyAIProviders: "resource:///modules/whimsy/WhimsyAIProviders.sys.mjs",
  WhimsyAIStore: "resource:///modules/whimsy/WhimsyAIStore.sys.mjs",
  WhimsyConnectors: "resource:///modules/whimsy/WhimsyConnectors.sys.mjs",
});

const FEATURE_PREF = "whimsy.feature.local-plugins";
const DIR = "whimsy-plugins";
// The loader's own location name (installTelemetryInfo.source).
const LOCATION = "whimsy-local-plugins";
const TOOL = "write_plugin";
const SERVER = "whimsy_plugins";
// Well inside the loader's limits (1MB manifest, 4096 entries, depth 16).
const LIMITS = { files: 64, fileBytes: 512 * 1024, totalBytes: 2 * 1024 * 1024, pathChars: 200, depth: 8, folderChars: 48 };
// "Make an extension that…", "change my Hide Shorts plugin". Finding or
// installing someone else's extension stays the agent's.
const BUILD_ASK = /\b(?:make|build|create|write|code|change|edit|update|fix|modify|tweak|improve)\b[\s\S]*\b(?:extensions?|plug-?ins?|add-?ons?)\b/i;
// The add-on manager's id rule (gIDTest).
const ID_TEST = /^(\{[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\}|[a-z0-9-\._]*\@[a-z0-9-\._]+)$/i;

const DESCRIPTION = [
  "Writes a Firefox WebExtension into the person's local plugins folder. Use it only when they ask to make or change an extension or plugin.",
  "Pass a short folder name and every file of the extension, as text: manifest.json (manifest_version 3, name, version; for a background script use background.scripts, not service_worker) and the scripts, pages, and styles it names.",
  "Ask only for the permissions the extension needs. Whimsy sets the add-on id.",
  "It never runs on its own: the person reviews what it can do and presses Run. To change a plugin, call this again with the same folder and the complete new set of files; the folder is replaced.",
].join(" ");

const INPUT_SCHEMA = {
  type: "object",
  properties: {
    folder: { type: "string", description: "Short folder name, like hide-shorts" },
    files: {
      type: "array",
      items: {
        type: "object",
        properties: { path: { type: "string", description: "Relative path, like manifest.json or src/content.js" }, content: { type: "string" } },
        required: ["path", "content"],
      },
    },
  },
  required: ["folder", "files"],
};

/** A refusal the model reads (never an exception it can't explain). */
function refused(message) {
  const e = new Error(message);
  e.refused = true;
  return e;
}

// Whether `path` is itself a symbolic link (never followed). Synchronous on
// purpose: IOUtils.getFile returns a promise (and creates parent folders),
// so it can't answer this.
function isLink(path) {
  try {
    const file = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
    file.initWithPath(path);
    return file.isSymlink();
  } catch {
    return false;
  }
}

export const WhimsyLocalPlugins = {
  TOOL,
  LIMITS,

  get enabled() {
    return Services.prefs.getBoolPref(FEATURE_PREF, false);
  },

  /**
   * A chat message asking to make or change an extension, which chat's own
   * write_plugin answers (so the browsing agent leaves it alone).
   */
  takes(text) {
    return this.canBuild && BUILD_ASK.test(String(text ?? ""));
  },

  /** Chat may write plugins: local plugins and AI are both switched on. */
  get canBuild() {
    return this.enabled && lazy.WhimsyAIProviders.enabled;
  },

  get folder() {
    return PathUtils.join(PathUtils.profileDir, DIR);
  },

  async openFolder() {
    if (!this.enabled) {
      return;
    }
    const path = this.folder;
    await IOUtils.makeDirectory(path, { createAncestors: true });
    this.launchFolder(path);
  },

  launchFolder(path) {
    const { FileUtils } = ChromeUtils.importESModule("resource://gre/modules/FileUtils.sys.mjs");
    new FileUtils.File(path).launch();
  },

  // ---- W30 extension builder ----

  /**
   * The chat run's write_plugin tool, as a per-run MCP server, or null when
   * local plugins or AI is off. `run`: { threadId, confirm(ask), onWritten(artifact) }.
   * Returns { server, dispose }. The router may hand the server its own
   * confirm (server.bindConfirm), so a person deciding holds the run open.
   */
  async builder({ threadId, confirm = null, onWritten = null }) {
    if (!this.canBuild) {
      return null;
    }
    const run = { threadId, confirm, onWritten, written: new Set() };
    // The plugins this chat made, so "change it" finds the same folder.
    const made = await this.madeInThread(threadId);
    const known = made.length ? ` Plugins made in this chat (folder: name): ${made.map(a => `${a.folder}: ${JSON.stringify(a.name ?? "")}`).join(", ")}.` : "";
    const tools = lazy.WhimsyConnectors.runTools(
      SERVER,
      [{ name: TOOL, description: DESCRIPTION + known, inputSchema: INPUT_SCHEMA, run: args => this._call(args, run) }],
      // Pre-approved: writing files runs nothing, and the person's Run is the approval.
      { readOnly: true }
    );
    tools.server.bindConfirm = fn => (run.confirm = fn);
    return tools;
  },

  async _call(args, run) {
    try {
      const artifact = await this.write(args, run);
      run.onWritten?.(artifact);
      return {
        isError: false,
        text: `Wrote ${JSON.stringify(artifact.name)} to the folder ${JSON.stringify(artifact.folder)} (${artifact.files.length} files). It stays off until the person presses Review and run on its card and approves it. To change it, call ${TOOL} again with this folder and every file.`,
      };
    } catch (e) {
      if (e.refused) {
        return { isError: true, text: e.message };
      }
      console.error("Whimsy: couldn't write a plugin", e);
      return { isError: true, text: "Couldn't write the plugin." };
    }
  },

  /** A folder name made safe: lowercase letters, digits, and dashes. */
  folderName(raw) {
    return String(raw ?? "")
      .normalize("NFKD")
      // NFKD splits "É" into "E" and a combining accent; drop the accent.
      .replace(/\p{M}+/gu, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+/, "")
      .slice(0, LIMITS.folderChars)
      .replace(/-+$/, "");
  },

  /** The files, checked: relative paths inside the folder, text, within the limits. */
  checkFiles(files) {
    if (!Array.isArray(files) || !files.length) {
      throw refused("Pass the extension's files, including manifest.json.");
    }
    if (files.length > LIMITS.files) {
      throw refused(`A plugin can have at most ${LIMITS.files} files.`);
    }
    const seen = new Set();
    const dirs = new Set();
    let total = 0;
    const out = [];
    for (const file of files) {
      const path = String(file?.path ?? "");
      const show = JSON.stringify(path.slice(0, 80));
      // No absolute paths, home paths, drive letters, backslashes, or control characters.
      if (!path || path.length > LIMITS.pathChars || /[\\:\0-\x1f\x7f]/.test(path) || path.startsWith("/") || path.startsWith("~")) {
        throw refused(`The path ${show} isn't a relative path inside the plugin's folder.`);
      }
      const parts = path.split("/");
      if (parts.length > LIMITS.depth || parts.some(p => !p || p == "." || p == "..")) {
        throw refused(`The path ${show} isn't a relative path inside the plugin's folder.`);
      }
      if (typeof file.content != "string") {
        throw refused(`The file ${show} needs its content as text.`);
      }
      const key = path.toLowerCase();
      if (seen.has(key) || dirs.has(key)) {
        throw refused(`The path ${show} is used twice.`);
      }
      seen.add(key);
      for (let i = 1; i < parts.length; i++) {
        const dir = parts.slice(0, i).join("/").toLowerCase();
        if (seen.has(dir)) {
          throw refused(`The path ${show} is used twice.`);
        }
        dirs.add(dir);
      }
      const bytes = new TextEncoder().encode(file.content);
      if (bytes.byteLength > LIMITS.fileBytes) {
        throw refused(`The file ${show} is larger than ${LIMITS.fileBytes / 1024} KB.`);
      }
      total += bytes.byteLength;
      if (total > LIMITS.totalBytes) {
        throw refused(`A plugin can be at most ${LIMITS.totalBytes / 1024 / 1024} MB.`);
      }
      out.push({ path, bytes });
    }
    if (!out.some(f => f.path == "manifest.json")) {
      throw refused("The plugin needs a manifest.json at the top of its folder.");
    }
    return out;
  },

  /** The manifest, checked, with Whimsy's add-on id. */
  checkManifest(text) {
    let manifest;
    try {
      manifest = JSON.parse(text);
    } catch {
      throw refused("manifest.json isn't valid JSON.");
    }
    if (!manifest || typeof manifest != "object" || Array.isArray(manifest)) {
      throw refused("manifest.json must be a JSON object.");
    }
    if (manifest.manifest_version !== 2 && manifest.manifest_version !== 3) {
      throw refused("manifest.json needs manifest_version 3 (or 2).");
    }
    for (const key of ["name", "version"]) {
      if (typeof manifest[key] != "string" || !manifest[key].trim()) {
        throw refused(`manifest.json needs a "${key}".`);
      }
    }
    return manifest;
  },

  /** The plugin artifacts this chat's saved answers made. */
  async madeInThread(threadId) {
    if (!threadId) {
      return [];
    }
    const out = new Map();
    for (const msg of await lazy.WhimsyAIStore.messages(threadId).catch(() => [])) {
      for (const a of msg.artifacts ?? []) {
        if (a?.kind == "plugin" && a.folder) {
          out.set(a.folder, a);
        }
      }
    }
    return [...out.values()];
  },

  /** The id a folder's manifest already has, if it's a valid one. */
  async _idIn(dir) {
    const path = PathUtils.join(dir, "manifest.json");
    try {
      if (isLink(path) || (await IOUtils.stat(path)).size > 1024 * 1024) {
        return null;
      }
      const manifest = JSON.parse(await IOUtils.readUTF8(path));
      const id = (manifest.browser_specific_settings ?? manifest.applications)?.gecko?.id;
      return typeof id == "string" && ID_TEST.test(id) ? id : null;
    } catch {
      return null;
    }
  },

  /** A new plugin's id: <folder>@whimsy-plugins, or the next free one. */
  async _freshId(folder) {
    for (let n = 1; ; n++) {
      const id = n == 1 ? `${folder}@whimsy-plugins` : `${folder}-${n}@whimsy-plugins`;
      if (!(await lazy.AddonManager.getAddonByID(id))) {
        return id;
      }
    }
  },

  /**
   * Writes the plugin folder and lets the loader find it. Resolves to the
   * chat card's artifact; throws a refusal (e.refused) the model reads.
   */
  async write(args, run = {}) {
    if (!this.canBuild) {
      throw refused("Local plugins are turned off.");
    }
    const files = this.checkFiles(args?.files);
    const manifest = this.checkManifest(new TextDecoder().decode(files.find(f => f.path == "manifest.json").bytes));
    const folder = this.folderName(args?.folder) || this.folderName(manifest.name);
    if (!folder) {
      throw refused("Give the plugin a folder name made of letters or digits.");
    }
    const root = this.folder;
    await IOUtils.makeDirectory(root, { createAncestors: true });
    if (isLink(root)) {
      throw refused("The plugins folder isn't a real folder.");
    }
    const dir = PathUtils.join(root, folder);
    const exists = await IOUtils.exists(dir);
    const before = exists ? await this.madeInThread(run.threadId) : [];
    const ours = run.written?.has(folder) || before.some(a => a.folder == folder);
    let id = null;
    let previous = 0;
    if (exists) {
      if (isLink(dir) || (await IOUtils.stat(dir)).type != "directory") {
        throw refused(`${JSON.stringify(folder)} isn't a plugin folder Whimsy can change.`);
      }
      // A plugin this chat didn't make changes only when the person allows it.
      if (!ours) {
        const label = new Localization(["browser/whimsy.ftl"], true).formatValueSync("whimsy-local-plugins-label");
        const shown = { folder, files: (args.files ?? []).map(f => ({ path: f.path, content: f.content })) };
        const allowed = typeof run.confirm == "function" && (await run.confirm({ server: label, tool: TOOL, args: shown }).catch(() => false)) === true;
        if (!allowed) {
          throw refused(`The person didn't allow changing ${JSON.stringify(folder)}, a plugin this chat didn't make. Don't try it another way.`);
        }
      }
      id = await this._idIn(dir);
      previous = await IOUtils.stat(PathUtils.join(dir, "manifest.json")).then(s => s.lastModified, () => 0);
    }
    id ??= await this._freshId(folder);
    manifest.browser_specific_settings = {
      ...(manifest.browser_specific_settings ?? {}),
      gecko: { ...(manifest.browser_specific_settings?.gecko ?? {}), id },
    };
    delete manifest.applications;
    const manifestBytes = new TextEncoder().encode(JSON.stringify(manifest, null, 2) + "\n");

    // Written beside the folder, then swapped in whole, so a failure never
    // leaves half a plugin (or loses the last one).
    const staging = PathUtils.join(PathUtils.profileDir, `whimsy-plugin-${Math.random().toString(16).slice(2)}.tmp`);
    try {
      for (const file of files) {
        const path = PathUtils.join(staging, ...file.path.split("/"));
        await IOUtils.makeDirectory(PathUtils.parent(path), { createAncestors: true });
        await IOUtils.write(path, file.path == "manifest.json" ? manifestBytes : file.bytes);
      }
      if (exists) {
        await IOUtils.remove(dir, { recursive: true });
      }
      await IOUtils.move(staging, dir);
    } finally {
      await IOUtils.remove(staging, { recursive: true, ignoreAbsent: true });
    }
    // The loader notices a folder by its time and its manifest's time.
    const time = Math.max(Date.now(), previous + 1000);
    await IOUtils.setModificationTime(PathUtils.join(dir, "manifest.json"), time);
    await IOUtils.setModificationTime(dir, time);

    await lazy.AddonManagerPrivate.getNewSideloads();
    const addon = await this.addonIn(dir, id);
    if (!addon) {
      throw refused("Firefox didn't load the plugin. Check manifest.json against Firefox's WebExtension rules.");
    }
    run.written?.add(folder);
    return {
      kind: "plugin",
      folder,
      id,
      name: addon.name,
      files: files.map(f => f.path).sort(),
      permissions: this.permissions(addon),
      ...(ours ? { revision: true } : {}),
    };
  },

  /** The installed plugin loaded from `dir`, or null. */
  async addonIn(dir, id) {
    const addon = await lazy.AddonManager.getAddonByID(id);
    if (addon?.installTelemetryInfo?.source != LOCATION) {
      return null;
    }
    const manifest = PathUtils.toFileURI(PathUtils.join(dir, "manifest.json"));
    return addon.getResourceURI("manifest.json")?.spec == manifest ? addon : null;
  },

  /**
   * Firefox's own permission descriptions, exactly as the Run prompt words
   * them: [{ text, domains? }]. With two or more sites the prompt says
   * "Access your data for sites in N domains" and lists the domains under
   * it (fullDomainsList); `domains` is that list, so the card names them too.
   */
  permissions(addon) {
    try {
      const strings = lazy.ExtensionsUI._buildStrings({ addon, permissions: addon.installPermissions, type: "sideload" });
      const full = strings.fullDomainsList;
      return (strings.msgs ?? []).map((text, i) => (full?.domainsSet?.size && full.msgIdIndex === i ? { text, domains: [...full.domainsSet] } : { text }));
    } catch (e) {
      console.error("Whimsy: no permission descriptions for a plugin", e);
      return [];
    }
  },

  /** A plugin folder's files (relative paths), links left out. */
  async files(folder) {
    const root = PathUtils.join(this.folder, this.folderName(folder));
    const out = [];
    const walk = async (dir, prefix, depth) => {
      for (const child of await IOUtils.getChildren(dir).catch(() => [])) {
        if (out.length >= LIMITS.files * 4 || isLink(child)) {
          continue;
        }
        const name = PathUtils.filename(child);
        const stat = await IOUtils.stat(child).catch(() => null);
        if (stat?.type == "directory" && depth < LIMITS.depth) {
          await walk(child, `${prefix}${name}/`, depth + 1);
        } else if (stat?.type == "regular") {
          out.push(`${prefix}${name}`);
        }
      }
    };
    await walk(root, "", 1);
    return out.sort();
  },

  /**
   * What a plugin card shows, read fresh: { name, running, permissions,
   * files }, or null once the plugin is gone.
   */
  async describe(artifact) {
    const dir = PathUtils.join(this.folder, this.folderName(artifact?.folder));
    const addon = artifact?.id ? await this.addonIn(dir, artifact.id) : null;
    if (!addon) {
      return null;
    }
    return { name: addon.name, running: addon.isActive, permissions: this.permissions(addon), files: await this.files(artifact.folder) };
  },

  /** Opens the existing Run / Don't Run prompt; resolves once it's answered. */
  async review(win, artifact) {
    const dir = PathUtils.join(this.folder, this.folderName(artifact?.folder));
    const addon = artifact?.id ? await this.addonIn(dir, artifact.id) : null;
    if (!addon) {
      return;
    }
    const answered = new Promise(resolve => lazy.ExtensionsUI.once("sideload-response", resolve));
    lazy.ExtensionsUI.showSideloaded(win.gBrowser, addon);
    await answered;
  },

  /** One file of a plugin, in a tab's view-source. */
  viewSource(win, folder, path) {
    const parts = String(path ?? "").split("/");
    if (!this.folderName(folder) || parts.some(p => !p || p == "." || p == ".." || /[\\:\0-\x1f]/.test(p))) {
      return;
    }
    const file = PathUtils.join(this.folder, this.folderName(folder), ...parts);
    win.openTrustedLinkIn(`view-source:${PathUtils.toFileURI(file)}`, "tab");
  },
};
