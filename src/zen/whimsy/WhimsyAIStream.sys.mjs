/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// W23: readers for streamed answers. Server-sent events (Claude, OpenAI,
// Gemini), newline-delimited JSON (Ollama), and lines from a subprocess
// pipe (Claude Code's stream-json).

/**
 * Server-sent events from a fetch body: { event, data } per block, across
 * chunk boundaries.
 */
export async function* sseEvents(body) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const parse = block => {
    let event = "";
    const data = [];
    for (const line of block.split("\n")) {
      if (!line || line.startsWith(":")) {
        continue;
      }
      const colon = line.indexOf(":");
      const field = colon < 0 ? line : line.slice(0, colon);
      const value = colon < 0 ? "" : line.slice(colon + 1).replace(/^ /, "");
      if (field == "event") {
        event = value;
      } else if (field == "data") {
        data.push(value);
      }
    }
    return data.length || event ? { event, data: data.join("\n") } : null;
  };
  try {
    for (;;) {
      const { value, done } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      buffer = buffer.replace(/\r\n/g, "\n");
      let index;
      while ((index = buffer.indexOf("\n\n")) >= 0) {
        const parsed = parse(buffer.slice(0, index));
        buffer = buffer.slice(index + 2);
        if (parsed) {
          yield parsed;
        }
      }
      if (done) {
        const parsed = buffer.trim() && parse(buffer);
        if (parsed) {
          yield parsed;
        }
        return;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

// SSE blocks whose data is JSON, parsed ({ event, json }); "[DONE]" and
// unparsable blocks are skipped.
export async function* sseJSON(body) {
  for await (const { event, data } of sseEvents(body)) {
    if (!data || data == "[DONE]") {
      continue;
    }
    let json;
    try {
      json = JSON.parse(data);
    } catch {
      continue;
    }
    yield { event, json };
  }
}

// Lines from a source of text chunks (an async iterable of strings).
export async function* textLines(chunks) {
  let buffer = "";
  for await (const chunk of chunks) {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, index).replace(/\r$/, "");
      buffer = buffer.slice(index + 1);
      if (line.trim()) {
        yield line;
      }
    }
  }
  if (buffer.trim()) {
    yield buffer;
  }
}

async function* bodyChunks(body) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) {
        const rest = decoder.decode();
        if (rest) {
          yield rest;
        }
        return;
      }
      yield decoder.decode(value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }
}

// Newline-delimited JSON objects from a fetch body.
export async function* ndjson(body) {
  for await (const line of textLines(bodyChunks(body))) {
    try {
      yield JSON.parse(line);
    } catch {}
  }
}

// Text chunks from a Subprocess pipe until it closes.
export async function* pipeChunks(pipe) {
  for (let chunk; (chunk = await pipe.readString()); ) {
    yield chunk;
  }
}
