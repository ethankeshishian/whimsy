/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// W23: Whimsy as an MCP client (Streamable HTTP). It asks a server what it
// offers (initialize, tools/list) and calls its tools for Whimsy's own chat,
// agent, and routines. Replies may be JSON or a short SSE stream. A server
// that wants a sign-in answers 401 with its resource metadata, and
// WhimsyConnectorOAuth takes it from there.

import { clearTimeout, setTimeout } from "resource://gre/modules/Timer.sys.mjs";

const PROTOCOL = "2025-06-18";
const TIMEOUT_MS = 20000;
// P2-L1: a reply is read with a cap and an idle limit after its headers,
// so a server that streams forever can't hang a call or grow memory.
const timing = { maxBytes: 5 * 1024 * 1024, idleMs: 60 * 1000 };

export class WhimsyMCPError extends Error {
  constructor(code, message = code, extra = {}) {
    super(message);
    this.name = "WhimsyMCPError";
    this.code = code;
    Object.assign(this, extra);
  }
}

// https only; plain http only to this Mac (local servers and tests).
export function mcpUrl(input) {
  let url;
  try {
    url = new URL(String(input ?? "").trim());
  } catch {
    return null;
  }
  const local = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  if (url.protocol != "https:" && !(url.protocol == "http:" && local)) {
    return null;
  }
  if (url.username || url.password) {
    return null;
  }
  url.hash = "";
  return url;
}

/**
 * P2-L1: the reply's body, at most `timing.maxBytes`, failing when nothing
 * arrives for `timing.idleMs`. `done(text)` may end the read early (an
 * SSE stream that already holds the reply). Cancels the stream when it
 * stops reading.
 */
async function readBody(response, controller, done = null) {
  const reader = response.body?.getReader();
  if (!reader) {
    return "";
  }
  const decoder = new TextDecoder();
  let text = "";
  let bytes = 0;
  let idle = false;
  let timer = null;
  const arm = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      idle = true;
      controller.abort();
    }, timing.idleMs);
  };
  try {
    arm();
    for (;;) {
      let chunk;
      try {
        chunk = await reader.read();
      } catch (e) {
        throw new WhimsyMCPError(idle ? "failed" : "aborted", idle ? "The server stopped answering" : String(e?.message ?? e));
      }
      if (chunk.done) {
        break;
      }
      bytes += chunk.value.byteLength;
      if (bytes > timing.maxBytes) {
        throw new WhimsyMCPError("failed", "The reply was too large");
      }
      text += decoder.decode(chunk.value, { stream: true });
      if (done?.(text)) {
        return text;
      }
      arm();
    }
    return text + decoder.decode();
  } finally {
    clearTimeout(timer);
    reader.cancel().catch(() => {});
  }
}

function sseMessages(text) {
  const out = [];
  for (const block of text.split(/\r?\n\r?\n/)) {
    const data = block.split(/\r?\n/).filter(l => l.startsWith("data:")).map(l => l.slice(5).trimStart()).join("\n");
    if (data) {
      try {
        out.push(JSON.parse(data));
      } catch {}
    }
  }
  return out;
}

export const WhimsyMCPClient = {
  // Tests: the reply cap and idle limit ({maxBytes, idleMs}); null resets.
  _setTimingForTesting(values) {
    Object.assign(timing, values ?? { maxBytes: 5 * 1024 * 1024, idleMs: 60 * 1000 });
  },

  /**
   * One JSON-RPC exchange. Returns the matching response's result.
   * @param {object} session {url, headers, sessionId}
   */
  async request(session, method, params = {}, { signal, notify = false } = {}) {
    const id = notify ? undefined : Math.floor(Math.random() * 1e9);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    signal?.addEventListener("abort", () => controller.abort(), { once: true });
    let response;
    try {
      response = await fetch(session.url, {
        method: "POST",
        credentials: "omit",
        cache: "no-store",
        redirect: "error",
        signal: controller.signal,
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          "MCP-Protocol-Version": PROTOCOL,
          ...(session.sessionId ? { "Mcp-Session-Id": session.sessionId } : {}),
          ...(session.headers ?? {}),
        },
        body: JSON.stringify({ jsonrpc: "2.0", method, params, ...(notify ? {} : { id }) }),
      });
    } catch (e) {
      throw new WhimsyMCPError(signal?.aborted ? "aborted" : "unreachable", String(e?.message ?? e));
    } finally {
      clearTimeout(timer);
    }
    if (response.status == 401) {
      const header = response.headers.get("WWW-Authenticate") ?? "";
      const meta = /resource_metadata="([^"]+)"/i.exec(header)?.[1] ?? null;
      throw new WhimsyMCPError("auth", "The server wants a sign-in", { resourceMetadata: meta });
    }
    if (response.status == 403) {
      throw new WhimsyMCPError("auth", "The server refused this sign-in");
    }
    session.sessionId = response.headers.get("Mcp-Session-Id") ?? session.sessionId;
    if (notify) {
      return null;
    }
    if (!response.ok) {
      throw new WhimsyMCPError(response.status == 404 || response.status == 405 ? "not-mcp" : "failed", `HTTP ${response.status}`);
    }
    const type = response.headers.get("Content-Type") ?? "";
    const sse = type.includes("text/event-stream");
    if (!sse && !type.includes("json")) {
      throw new WhimsyMCPError("not-mcp", "Not an MCP reply");
    }
    // An SSE stream may stay open: stop once it holds this call's reply.
    // Only events not yet seen are parsed, so a long stream stays linear.
    let seen = 0;
    const text = await readBody(response, controller, sse
      ? body => {
          const end = Math.max(body.lastIndexOf("\n\n"), body.lastIndexOf("\r\n\r\n"));
          if (end < seen) {
            return false;
          }
          const fresh = body.slice(seen, end);
          seen = end;
          return sseMessages(fresh).some(m => m?.jsonrpc == "2.0" && m.id === id);
        }
      : null);
    let messages;
    if (sse) {
      messages = sseMessages(text);
    } else if (type.includes("json")) {
      try {
        const parsed = JSON.parse(text);
        messages = Array.isArray(parsed) ? parsed : [parsed];
      } catch {
        messages = [];
      }
    }
    const reply = messages.find(m => m?.jsonrpc == "2.0" && m.id === id);
    if (!reply) {
      throw new WhimsyMCPError("not-mcp", "No JSON-RPC reply");
    }
    if (reply.error) {
      throw new WhimsyMCPError("rpc", String(reply.error.message ?? "Error"), { rpcCode: reply.error.code });
    }
    return reply.result ?? {};
  },

  /** initialize + tools/list: {name, title, tools: [{name, description, inputSchema}], session}. */
  async connect(input, { headers = {}, signal } = {}) {
    const url = mcpUrl(input);
    if (!url) {
      throw new WhimsyMCPError("bad-url");
    }
    const session = { url: url.href, headers, sessionId: null };
    const init = await this.request(
      session,
      "initialize",
      { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: "Whimsy", version: Services.appinfo.version } },
      { signal }
    );
    if (!init || typeof init != "object" || !init.serverInfo && !init.capabilities) {
      throw new WhimsyMCPError("not-mcp");
    }
    await this.request(session, "notifications/initialized", {}, { notify: true, signal }).catch(() => {});
    const tools = [];
    let cursor;
    for (let page = 0; page < 10; page++) {
      const result = await this.request(session, "tools/list", cursor ? { cursor } : {}, { signal });
      tools.push(...(Array.isArray(result.tools) ? result.tools : []).filter(t => typeof t?.name == "string"));
      cursor = result.nextCursor;
      if (!cursor) {
        break;
      }
    }
    const info = init.serverInfo ?? {};
    return { name: String(info.title || info.name || url.hostname).slice(0, 60), tools, session };
  },

  /** Calls one tool and returns its text. */
  async callTool(input, name, args = {}, { headers = {}, signal } = {}) {
    const { session } = await this.connect(input, { headers, signal });
    const result = await this.request(session, "tools/call", { name, arguments: args }, { signal });
    const text = (Array.isArray(result.content) ? result.content : [])
      .map(part => (part?.type == "text" ? part.text : part?.type == "resource" ? part.resource?.text ?? "" : ""))
      .filter(Boolean)
      .join("\n");
    if (result.isError) {
      throw new WhimsyMCPError("tool-failed", text || "The tool failed");
    }
    return text || (result.structuredContent ? JSON.stringify(result.structuredContent) : "");
  },
};
