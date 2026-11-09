/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// W23: one router for every AI request. It tries the switched-on providers
// in the person's order (WhimsyAIProviders.order) and the first one that
// can do the task answers. Before the answer starts, a provider that's out
// of room, down, or can't do the task is passed over automatically, with
// one handoff event naming both. Once text has arrived, nothing switches by
// itself: the partial answer is kept and continuing on the next provider
// takes a press (continueOn). A switched-off provider is never tried.

import { clearTimeout, setTimeout } from "resource://gre/modules/Timer.sys.mjs";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  REQUEST_TIMEOUT_MS: "resource:///modules/whimsy/WhimsyAIProviders.sys.mjs",
  WhimsyAIError: "resource:///modules/whimsy/WhimsyAIProviders.sys.mjs",
  WhimsyAIProviders: "resource:///modules/whimsy/WhimsyAIProviders.sys.mjs",
  WhimsyConnectors: "resource:///modules/whimsy/WhimsyConnectors.sys.mjs",
});

export const TASKS = ["chat", "ask", "quick-text", "summary", "preview", "routine", "agent", "translate", "memory", "index"];
// Tasks that go to Apple's on-device model first (Quick text on Apple).
// W23 memory-fire: memory extraction is a quick-text-shaped task too.
const QUICK_TASKS = new Set(["quick-text", "translate", "memory"]);
// Tasks a person reads as they're written: thinking defaults to Normal.
const DEEP_TASKS = new Set(["chat", "ask", "agent"]);
// Tasks that get the connectors' tools unless the caller passes its own.
const TOOL_TASKS = new Set(["chat", "ask", "agent", "routine"]);
// Out of room: the provider rests until its reset time.
const QUOTA_CODES = new Set(["plan-limit", "rate-limited"]);
// Never handed to another provider.
const FINAL_CODES = new Set(["aborted", "blocked", "refused"]);
const NEED_FLAGS = ["images", "video", "research", "imageGen", "code", "tools"];
const CONTINUE_PROMPT = "Continue exactly where your last answer stopped. Don't repeat anything already written.";

const error = (code, extra = {}) => Object.assign(new lazy.WhimsyAIError(code), extra);

function textOf(content) {
  if (typeof content == "string") {
    return content;
  }
  return (Array.isArray(content) ? content : [])
    .filter(part => part?.type == "text")
    .map(part => part.text ?? "")
    .join("\n");
}

function hasImages(messages) {
  return messages.some(m => Array.isArray(m.content) && m.content.some(part => part?.type == "image"));
}

// Rejects when the signal aborts (with its reason).
function whenAborted(signal) {
  return new Promise((_, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}

export const WhimsyAIRouter = {
  CONTINUE_PROMPT,

  // The switched-on providers, in order.
  _enabled() {
    const P = lazy.WhimsyAIProviders;
    if (P._testProvider && !P._testStreams) {
      return ["test"];
    }
    return P.order.filter(id => P.isOn(id));
  },

  _fits(id, needs = {}, model) {
    const caps = lazy.WhimsyAIProviders.capabilities(id, model);
    if (NEED_FLAGS.some(flag => needs[flag] && !caps[flag])) {
      return false;
    }
    return !(needs.chars > caps.maxInputChars);
  },

  /**
   * The switched-on providers, in order, that can do what's needed.
   *
   * @param {object} [needs] { images, video, chars, research, imageGen, code, tools }
   * @returns {string[]}
   */
  capable(needs = {}) {
    return this._enabled().filter(id => this._fits(id, needs));
  },

  // The providers to try for a request, best first.
  _route(request) {
    let ids = this._enabled();
    if (request.provider && request.provider != "auto" && ids.includes(request.provider)) {
      ids = [request.provider, ...ids.filter(id => id != request.provider)];
    } else if (QUICK_TASKS.has(request.task) && lazy.WhimsyAIProviders.quickTextOnApple && ids.includes("apple")) {
      ids = ["apple", ...ids.filter(id => id != "apple")];
    }
    return ids;
  },

  _normalize(req) {
    const messages = Array.isArray(req.messages) && req.messages.length
      ? req.messages.map(m => ({ role: m.role == "assistant" ? "assistant" : "user", content: m.content ?? "" }))
      : [{ role: "user", content: String(req.prompt ?? "") }];
    const task = TASKS.includes(req.task) ? req.task : "ask";
    const last = messages.findLast(m => m.role == "user");
    return {
      task,
      messages,
      // One-shot providers (Apple, Claude Code) and older callers read this.
      prompt:
        messages.length == 1
          ? textOf(messages[0].content)
          : messages.map(m => `${m.role == "assistant" ? "Assistant" : "User"}: ${textOf(m.content)}`).join("\n\n"),
      lastUserText: textOf(last?.content ?? ""),
      system: String(req.system ?? ""),
      maxTokens: Number(req.maxTokens) || (DEEP_TASKS.has(task) ? 8192 : 1024),
      thinking: ["light", "normal", "deep"].includes(req.thinking) ? req.thinking : DEEP_TASKS.has(task) ? "normal" : "light",
      provider: req.provider ?? "auto",
      model: req.model ?? "",
      tools: Array.isArray(req.tools) ? req.tools : [],
      userStarted: !!req.userStarted,
    };
  },

  /**
   * Runs one request on the first switched-on provider that can, handing
   * off before the answer starts.
   *
   * @param {object} req AIRequest: { task, messages, system?, needs?,
   *   provider?, model?, thinking?, tools?, userStarted?, signal?, onEvent? }
   * @returns {Promise<{ text, provider, model, thinkingMs?, handoffs, tried, partial? }>}
   */
  async run(req = {}) {
    const P = lazy.WhimsyAIProviders;
    if (!P.enabled) {
      throw error("blocked");
    }
    if (req.signal?.aborted) {
      throw error("aborted");
    }
    P._observe();
    const request = this._normalize(req);
    if (req.tools === undefined && TOOL_TASKS.has(request.task)) {
      request.tools = await lazy.WhimsyConnectors.tools().catch(() => []);
    }
    const needs = { ...(req.needs ?? {}) };
    needs.images ||= hasImages(request.messages);
    const emit = event => {
      try {
        req.onEvent?.(event);
      } catch (e) {
        console.error("Whimsy AI: an onEvent listener threw", e);
      }
    };

    const run = new AbortController();
    const onAbort = () => run.abort(req.signal.reason);
    req.signal?.addEventListener("abort", onAbort, { once: true });
    P._inflight.add(run);

    const ids = this._route(request);
    const tried = [];
    const causes = {};
    const handoffs = [];
    let passed = null;
    let attempted = 0;
    let lastError = null;
    let offlineOnly = true;
    try {
      for (const [index, id] of ids.entries()) {
        const model = id == request.provider ? request.model : "";
        if (!this._fits(id, needs, model || undefined)) {
          passed ??= { from: id, reason: "capability" };
          continue;
        }
        const resting = P.resting(id);
        if (resting) {
          tried.push(id);
          causes[id] = "resting";
          passed ??= { from: id, reason: "quota", until: resting.until };
          offlineOnly = false;
          continue;
        }
        if (Services.io.offline && !P.capabilities(id).onDevice && id != "test") {
          tried.push(id);
          causes[id] = "offline";
          passed ??= { from: id, reason: "down" };
          continue;
        }
        offlineOnly = false;
        tried.push(id);
        attempted++;
        const outcome = await this._attempt(id, { ...request, model }, run, passed, emit);
        if (outcome.result) {
          if (outcome.handoff) {
            handoffs.push(outcome.handoff);
          }
          const result = { ...outcome.result, handoffs, tried };
          if (result.partial) {
            const next = ids.slice(index + 1).find(other => this._fits(other, needs) && !P.resting(other)) ?? null;
            result.next = next;
            emit({ type: "quota-mid", provider: id, next, reason: outcome.reason });
          }
          if (!P.enabled) {
            throw error("blocked");
          }
          return result;
        }
        const failure = outcome.error;
        causes[id] = failure.code;
        lastError = failure;
        if (QUOTA_CODES.has(failure.code)) {
          P.setResting(id, { until: failure.until ?? null, message: failure.detail ?? "", code: failure.code });
          passed ??= { from: id, reason: "quota", until: P.resting(id)?.until ?? failure.until ?? null };
        } else {
          passed ??= { from: id, reason: "down" };
        }
      }
    } finally {
      req.signal?.removeEventListener("abort", onAbort);
      P._inflight.delete(run);
    }
    if (!tried.length) {
      throw error("none-capable", { tried: ids.slice() });
    }
    if (!attempted && offlineOnly) {
      throw error("offline", { tried, causes });
    }
    if (!attempted && Object.values(causes).includes("resting")) {
      const id = tried.find(other => causes[other] == "resting");
      const resting = P.resting(id);
      throw error("plan-limit", { provider: id, until: resting?.until ?? null, detail: resting?.message ?? "", tried, causes });
    }
    if (attempted == 1 && tried.length == 1 && lastError) {
      throw Object.assign(lastError, { tried, causes });
    }
    throw error("all-failed", { tried, causes });
  },

  // One provider: { result, handoff } on an answer (partial included), or
  // { error } when it failed before any text. Aborts of the whole run throw.
  async _attempt(id, request, run, passed, emit) {
    const P = lazy.WhimsyAIProviders;
    const attempt = new AbortController();
    const onRunAbort = () => attempt.abort(run.signal.reason);
    run.signal.addEventListener("abort", onRunAbort, { once: true });
    let timer = null;
    const arm = () => {
      clearTimeout(timer);
      timer = setTimeout(() => attempt.abort(error("timeout")), lazy.REQUEST_TIMEOUT_MS);
    };
    arm();
    emit({ type: "status", key: "waiting", provider: id });
    let text = "";
    let handoff = null;
    let started = false;
    let thinkingAt = 0;
    let thinkingMs;
    const iterator = P.stream(id, { ...request, signal: attempt.signal })[Symbol.asyncIterator]();
    const aborted = whenAborted(attempt.signal);
    aborted.catch(() => {});
    try {
      for (;;) {
        const { value: event, done } = await Promise.race([iterator.next(), aborted]);
        if (done) {
          break;
        }
        arm();
        if (!event?.type) {
          continue;
        }
        if (!started) {
          started = true;
          if (passed) {
            handoff = { type: "handoff", from: passed.from, to: id, reason: passed.reason };
            if (passed.until) {
              handoff.until = passed.until;
            }
            emit(handoff);
          }
        }
        if (event.type == "text") {
          const delta = String(event.delta ?? "");
          if (!delta) {
            continue;
          }
          if (thinkingAt && thinkingMs === undefined) {
            thinkingMs = Date.now() - thinkingAt;
          }
          text += delta;
          emit({ type: "text", delta });
        } else if (event.type == "thinking") {
          thinkingAt ||= Date.now();
          emit({ type: "thinking", text: String(event.text ?? "") });
        } else if (event.type == "status" || event.type == "citation" || event.type == "artifact") {
          emit(event);
        }
      }
      if (thinkingAt && thinkingMs === undefined) {
        thinkingMs = Date.now() - thinkingAt;
      }
      return { result: this._result(id, request, text, thinkingMs), handoff };
    } catch (caught) {
      if (run.signal.aborted) {
        const reason = run.signal.reason;
        throw reason instanceof lazy.WhimsyAIError ? reason : error("aborted");
      }
      const failure =
        caught instanceof lazy.WhimsyAIError
          ? caught
          : attempt.signal.aborted && attempt.signal.reason instanceof lazy.WhimsyAIError
            ? attempt.signal.reason
            : error("failed", { message: String(caught?.message || caught) });
      failure.provider ??= id;
      if (FINAL_CODES.has(failure.code)) {
        throw failure;
      }
      if (text) {
        const result = { ...this._result(id, request, text, thinkingMs), partial: true, stopped: failure.code };
        if (QUOTA_CODES.has(failure.code)) {
          P.setResting(id, { until: failure.until ?? null, message: failure.detail ?? "", code: failure.code });
        }
        return { result, handoff, reason: QUOTA_CODES.has(failure.code) ? "quota" : "down" };
      }
      return { error: failure };
    } finally {
      clearTimeout(timer);
      run.signal.removeEventListener("abort", onRunAbort);
      if (!attempt.signal.aborted) {
        attempt.abort(error("aborted"));
      }
      iterator.return?.().catch(() => {});
    }
  },

  _result(id, request, text, thinkingMs) {
    const P = lazy.WhimsyAIProviders;
    const result = { text, provider: id, model: request.model || P.modelOf(id) || "" };
    if (thinkingMs !== undefined) {
      result.thinkingMs = thinkingMs;
    }
    return result;
  },

  /**
   * Continues a partial answer on another provider (the person pressed
   * Continue on <provider>). The returned text is the whole answer.
   */
  async continueOn(result, nextId, req = {}) {
    const base = this._normalize(req);
    const more = await this.run({
      ...req,
      provider: nextId,
      model: "",
      messages: [...base.messages, { role: "assistant", content: result.text }, { role: "user", content: CONTINUE_PROMPT }],
    });
    return {
      ...more,
      text: result.text + more.text,
      continuedFrom: result.provider,
      handoffs: [...(result.handoffs ?? []), ...more.handoffs],
      tried: [...new Set([...(result.tried ?? []), ...more.tried])],
    };
  },
};
