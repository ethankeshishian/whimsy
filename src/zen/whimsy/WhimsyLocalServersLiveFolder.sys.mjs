/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Local servers live folder: the dev servers running on this machine, as a
// folder of tabs that appear when a server starts and disappear when it
// stops. It probes a list of common dev-server ports on localhost (Vite,
// Next, Rails, Django, Storybook, ...), takes each server's name from its
// page <title> and its icon from the page's favicon. A browser can't read a
// project's package.json, so the page title is the name.
//
// Unlike the other providers this one polls fast (every few seconds), so it
// only polls while someone can see it: the folder is expanded, in the
// window's active space, and the window isn't hidden. Collapsing the folder,
// switching space or minimizing stops the timer outright -- zero background
// work -- and expanding it again probes at once, so it's never stale when
// looked at. The base class's DeferredTask schedule is not used at all:
// start()/stop()/refresh() are replaced here.
//
// Deferred: Bonjour/mDNS-advertised HTTP services on the LAN. Gecko's
// nsIDNSServiceDiscovery (netwerk/dns/mdns) was removed with FlyWeb and the
// Presentation API and isn't in this tree, so there's no browser API to
// browse _http._tcp. Doing it would mean a hand-rolled mDNS client over
// nsIUDPSocket (multicast 224.0.0.251:5353, contending with mDNSResponder,
// plus macOS's Local Network privacy prompt) -- too risky to land untested.

import { nsZenLiveFolderProvider } from "resource:///modules/zen/ZenLiveFolder.sys.mjs";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  clearInterval: "resource://gre/modules/Timer.sys.mjs",
  clearTimeout: "resource://gre/modules/Timer.sys.mjs",
  setInterval: "resource://gre/modules/Timer.sys.mjs",
  setTimeout: "resource://gre/modules/Timer.sys.mjs",
});

export const PORTS_PREF = "whimsy.live-folders.local-servers.ports";
export const POLL_PREF = "whimsy.live-folders.local-servers.poll-ms";

// Common dev-server ports, used when the pref is empty or unreadable.
export const DEFAULT_PORTS = [
  1313, 3000, 3001, 3002, 3003, 4000, 4173, 4200, 4321, 5000, 5001, 5173, 5174, 5500, 6006, 8000, 8001, 8080, 8081,
  8787, 8888, 9000, 19006,
];

const DEFAULT_POLL_MS = 5000;
const PROBE_TIMEOUT_MS = 800;
const MAX_HTML_BYTES = 256 * 1024;
const MAX_ICON_BYTES = 64 * 1024;
const FALLBACK_ICON = "chrome://browser/skin/zen-icons/selectable/code.svg";
export const FOLDER_ICON = "chrome://browser/skin/zen-icons/selectable/terminal.svg";

// Things that listen on dev ports but aren't dev servers. macOS's AirPlay
// Receiver answers on 5000 and 7000 with `Server: AirTunes/...`.
const IGNORED_SERVERS = /^AirTunes/i;

export function parsePorts(value) {
  const ports = String(value || "")
    .split(/[\s,]+/)
    .map(x => Number.parseInt(x, 10))
    .filter(x => Number.isInteger(x) && x > 0 && x < 65536);
  return ports.length ? [...new Set(ports)] : DEFAULT_PORTS;
}

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

function decodeEntities(text) {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, code) => {
    if (code[0] === "#") {
      const n = code[1] === "x" || code[1] === "X" ? Number.parseInt(code.slice(2), 16) : Number.parseInt(code.slice(1), 10);
      try {
        return String.fromCodePoint(n);
      } catch {
        return match;
      }
    }
    return ENTITIES[code.toLowerCase()] ?? match;
  });
}

export function parseTitle(html) {
  const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html || "");
  return match ? decodeEntities(match[1]).replace(/\s+/g, " ").trim() : "";
}

// The first <link rel="icon"> (or "shortcut icon"/"apple-touch-icon"), else
// /favicon.ico, resolved against the page's URL.
export function parseIconHref(html, baseUrl) {
  for (const tag of (html || "").match(/<link\b[^>]*>/gi) || []) {
    const rel = /\brel\s*=\s*["']?([^"'>]+)/i.exec(tag)?.[1] || "";
    if (!/(^|\s)(icon|apple-touch-icon)(\s|$)/i.test(rel)) {
      continue;
    }
    const href = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(tag);
    const value = href?.[1] ?? href?.[2] ?? href?.[3];
    if (value) {
      try {
        return new URL(decodeEntities(value), baseUrl).href;
      } catch {}
    }
  }
  return new URL("/favicon.ico", baseUrl).href;
}

async function timedFetch(url, timeoutMs, { redirect = "follow" } = {}) {
  const controller = new AbortController();
  const timer = lazy.setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      signal: controller.signal,
      credentials: "omit",
      cache: "no-store",
      redirect,
    });
  } catch {
    return null;
  } finally {
    lazy.clearTimeout(timer);
  }
}

async function readCapped(response, maxBytes) {
  const reader = response.body?.getReader();
  if (!reader) {
    return new Uint8Array(0);
  }
  const chunks = [];
  let total = 0;
  try {
    while (total < maxBytes) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      chunks.push(value);
      total += value.byteLength;
    }
  } finally {
    reader.cancel().catch(() => {});
  }
  const bytes = new Uint8Array(Math.min(total, maxBytes));
  let offset = 0;
  for (const chunk of chunks) {
    const part = chunk.subarray(0, bytes.length - offset);
    bytes.set(part, offset);
    offset += part.byteLength;
    if (offset >= bytes.length) {
      break;
    }
  }
  return bytes;
}

function toBase64(bytes) {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

export class WhimsyLocalServersLiveFolderProvider extends nsZenLiveFolderProvider {
  static type = "whimsy:local-servers";
  // Read by WhimsyLiveFolders' context-menu wrapper: the 15-minute-and-up
  // interval choices make no sense for a folder that polls while visible.
  static hidesIntervalMenu = true;

  #timer = null;
  #window = null;
  #pending = null;
  #signature = null;
  // origin -> icon URL (data: or chrome:), so an icon is fetched once per
  // server run, not once per poll.
  #icons = new Map();

  get ports() {
    return parsePorts(Services.prefs.getStringPref(PORTS_PREF, ""));
  }

  get pollMs() {
    return Math.max(1000, Services.prefs.getIntPref(POLL_PREF, DEFAULT_POLL_MS));
  }

  get isPolling() {
    return !!this.#timer;
  }

  // Visible = folder (and every folder it's nested in) expanded, in the
  // window's active space, and the window itself not hidden/minimized.
  get isVisible() {
    const folder = this.manager.getFolderForLiveFolder(this);
    const win = this.manager.window;
    if (!folder || !win || win.closed || win.document.hidden) {
      return false;
    }
    for (let el = folder; el; el = el.parentElement?.closest?.("zen-folder")) {
      if (el.collapsed) {
        return false;
      }
    }
    const spaceId = folder.getAttribute?.("zen-workspace-id");
    const active = win.gZenWorkspaces?.activeWorkspace;
    return !spaceId || !active || spaceId === active;
  }

  start() {
    this.#listen();
    this.#updatePolling();
  }

  stop() {
    this.#unlisten();
    this.#stopPolling();
  }

  async refresh() {
    return this.#tick();
  }

  handleEvent(event) {
    if (event.type === "unload") {
      this.stop();
      return;
    }
    // TabGroupExpand/Collapse fire after the attribute flips; space
    // switches and visibility changes are already settled too. A tick of
    // delay lets nested-folder and space state finish updating.
    lazy.setTimeout(() => this.#updatePolling(), 0);
  }

  #listen() {
    const win = this.manager.window;
    if (!win || this.#window === win) {
      return;
    }
    this.#unlisten();
    this.#window = win;
    win.addEventListener("TabGroupExpand", this);
    win.addEventListener("TabGroupCollapse", this);
    win.addEventListener("ZenWorkspacesUIUpdate", this);
    win.addEventListener("unload", this);
    win.document.addEventListener("visibilitychange", this);
  }

  #unlisten() {
    const win = this.#window;
    if (!win) {
      return;
    }
    this.#window = null;
    win.removeEventListener("TabGroupExpand", this);
    win.removeEventListener("TabGroupCollapse", this);
    win.removeEventListener("ZenWorkspacesUIUpdate", this);
    win.removeEventListener("unload", this);
    win.document?.removeEventListener("visibilitychange", this);
  }

  #updatePolling() {
    if (!this.isVisible) {
      this.#stopPolling();
      return;
    }
    if (this.#timer) {
      return;
    }
    this.#timer = lazy.setInterval(() => this.#tick(), this.pollMs);
    // Probe straight away: a folder that just became visible shows what's
    // running now, not what was running when it was last looked at.
    this.#tick();
  }

  #stopPolling() {
    if (this.#timer) {
      lazy.clearInterval(this.#timer);
      this.#timer = null;
    }
  }

  // One probe round at a time; overlapping callers share it.
  #tick() {
    if (!this.#pending) {
      this.#pending = this.#fetchAndApply().finally(() => {
        this.#pending = null;
      });
    }
    return this.#pending;
  }

  async #fetchAndApply() {
    let items;
    try {
      items = await this.fetchItems();
    } catch (e) {
      console.error("Whimsy: local servers probe failed", e);
      return null;
    }
    this.state.lastFetched = Date.now();

    // Only touch the folder when the set of servers changed: polling every
    // few seconds must not churn tabs or rewrite the session file.
    const signature = items.map(item => `${item.id}\n${item.title}`).join("\n\n");
    if (signature === this.#signature) {
      return items;
    }
    this.#signature = signature;

    // A server the user closed stays closed only while it's running: once
    // it stops, the next time it starts it shows up again.
    const live = new Set(items.map(item => `${this.id}:${item.id}`));
    const dismissed = this.manager.dismissedItems;
    if (dismissed) {
      for (const id of [...dismissed]) {
        if (id.startsWith(`${this.id}:`) && !live.has(id)) {
          dismissed.delete(id);
        }
      }
    }
    for (const origin of [...this.#icons.keys()]) {
      if (!items.some(item => item.url.startsWith(origin))) {
        this.#icons.delete(origin);
      }
    }

    this.manager.onLiveFolderFetch(this, items);
    return items;
  }

  async fetchItems() {
    const results = await Promise.all(this.ports.map(port => this.probe(port)));
    return results.filter(Boolean).sort((a, b) => a.port - b.port);
  }

  // Resolves to an item for a server answering on `port`, or null.
  async probe(port) {
    const origin = `http://localhost:${port}`;
    const response = await timedFetch(`${origin}/`, PROBE_TIMEOUT_MS);
    if (!response) {
      return null;
    }
    if (IGNORED_SERVERS.test(response.headers.get("server") || "")) {
      response.body?.cancel().catch(() => {});
      return null;
    }

    let html = "";
    const contentType = response.headers.get("content-type") || "";
    if (/html/i.test(contentType)) {
      try {
        html = new TextDecoder().decode(await readCapped(response, MAX_HTML_BYTES));
      } catch {}
    } else {
      response.body?.cancel().catch(() => {});
    }

    const host = `localhost:${port}`;
    const pageUrl = response.url || `${origin}/`;
    return {
      id: String(port),
      port,
      title: parseTitle(html) || host,
      subtitle: host,
      url: `${origin}/`,
      icon: await this.#iconFor(origin, html, pageUrl),
    };
  }

  // Tabs only take local (data:/chrome:) icon URLs from chrome code, so the
  // favicon is fetched here and inlined.
  async #iconFor(origin, html, pageUrl) {
    if (this.#icons.has(origin)) {
      return this.#icons.get(origin);
    }
    let icon = FALLBACK_ICON;
    try {
      const href = parseIconHref(html, pageUrl);
      if (href.startsWith("data:image/")) {
        icon = href;
      } else if (/^https?:/.test(href) && new URL(href).origin == origin) {
        // Only the server's own icon: a page can't make the browser call
        // other hosts (the LAN) from here (wave7/security L9).
        const response = await timedFetch(href, PROBE_TIMEOUT_MS, { redirect: "error" });
        const type = (response?.headers.get("content-type") || "").split(";")[0].trim();
        if (response?.ok && type.startsWith("image/")) {
          const bytes = await readCapped(response, MAX_ICON_BYTES + 1);
          if (bytes.length && bytes.length <= MAX_ICON_BYTES) {
            icon = `data:${type};base64,${toBase64(bytes)}`;
          }
        } else {
          response?.body?.cancel().catch(() => {});
        }
      }
    } catch {}
    this.#icons.set(origin, icon);
    return icon;
  }

  get options() {
    return [];
  }

  serialize() {
    return { state: this.state };
  }
}
