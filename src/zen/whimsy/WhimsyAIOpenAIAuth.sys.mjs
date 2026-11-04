/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Sign in with ChatGPT (W14 19): OpenAI's documented flow for open-source,
// locally run apps to use the person's ChatGPT plan
// (developers.openai.com/siwc/token-sharing-open-source). Whimsy registers
// its own client per install (no shipped or borrowed client ID): OIDC
// discovery, PKCE S256 + state + nonce, a one-shot loopback callback on
// 127.0.0.1, the ID token checked (signature, issuer, audience, nonce,
// expiry) before anything is saved. Every token and the issued client ID are
// encrypted with OSKeyStore; the access token lives in memory only; nothing
// goes into prefs or logs. Requests use the Responses API with store off and
// streaming on; included usage never moves to paid billing.

import { clearTimeout, setTimeout } from "resource://gre/modules/Timer.sys.mjs";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  BrowserWindowTracker: "resource:///modules/BrowserWindowTracker.sys.mjs",
  HttpServer: "chrome://remote/content/server/httpd.sys.mjs",
  OSKeyStore: "resource://gre/modules/OSKeyStore.sys.mjs",
  PlacesUtils: "resource://gre/modules/PlacesUtils.sys.mjs",
  PrivateBrowsingUtils: "resource://gre/modules/PrivateBrowsingUtils.sys.mjs",
  WhimsyAIError: "resource:///modules/whimsy/WhimsyAIProviders.sys.mjs",
  WhimsyAIProviders: "resource:///modules/whimsy/WhimsyAIProviders.sys.mjs",
});
ChromeUtils.defineLazyGetter(lazy, "l10n", () => new Localization(["browser/whimsy.ftl"], true));

const ISSUER = "https://auth.openai.com";
const RESOURCE = "https://api.openai.com/v1";
const SCOPE = "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";
const PLAN_SCOPE = "chatgpt.tokens.use.direct";
const CALLBACK_PATH = "/auth/callback";
const AGENT_NAME = "Whimsy";
const USAGE_URL = "https://chatgpt.com/settings/usage";
const FILE = "whimsy-ai-openai-plan.json";
const GATE_PREF = "whimsy.feature.ai-openai-plan";
const MODEL_PREF = "whimsy.ai.openai.model";
const WELCOMED_PREF = "whimsy.ai.openai.plan-welcomed";
const WATCHED_PREFS = ["whimsy.ai.enabled", "whimsy.feature.ai-providers", GATE_PREF];
const SIGN_IN_TIMEOUT_MS = 5 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 30 * 1000;
const REFRESH_MARGIN_MS = 60 * 1000;
const CLOCK_SKEW_S = 120;
// Refresh answers that mean the sign-in is over (sign in again).
const REFRESH_ENDED = ["invalid_grant", "invalid_refresh_token", "token_expired", "refresh_token_invalidated"];
const CLIENT_ID = /^[\w.:~-]{1,256}$/;
const SIGNATURES = {
  RS256: { key: { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, verify: { name: "RSASSA-PKCS1-v1_5" } },
  ES256: { key: { name: "ECDSA", namedCurve: "P-256" }, verify: { name: "ECDSA", hash: "SHA-256" } },
};

// Gives up on a request after REQUEST_TIMEOUT_MS.
function timeoutSignal() {
  const controller = new AbortController();
  setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  return controller.signal;
}

const error = (code, message) => new lazy.WhimsyAIError(code, message);
const randomString = () => ChromeUtils.base64URLEncode(crypto.getRandomValues(new Uint8Array(32)), { pad: false });
const decodePart = part =>
  JSON.parse(new TextDecoder().decode(ChromeUtils.base64URLDecode(part, { padding: "ignore" })));
const escapeHTML = text =>
  String(text).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

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

// What an error code from OpenAI means for Whimsy (null: go by the status).
function codeFor(code) {
  switch (code) {
    case "subscription_sharing_usage_limit_exceeded":
      return "plan-limit";
    case "subscription_sharing_user_not_eligible":
    case "chatpass_v2_scope_not_authorized":
      return "plan-ineligible";
    case "subscription_sharing_invalid_user":
      return "signed-out";
    case "rate_limit_exceeded":
      return "rate-limited";
    case "model_not_found":
      return "no-model";
    default:
      return null;
  }
}

export const WhimsyAIOpenAIAuth = {
  // A spent plan's toast offers Manage usage; the plan may serve automatic
  // features too (the person sets this app's share in ChatGPT's settings).
  userStartedOnly: false,
  _test: null,
  _discovery: null,
  _secret: undefined,
  _access: null,
  _refreshing: null,
  _pending: null,
  _queue: Promise.resolve(),

  // Tests only: a mock issuer and API ({ issuer, api } on 127.0.0.1).
  setTestEndpoints(endpoints) {
    if (endpoints && !Cu.isInAutomation) {
      throw new Error("Test endpoints are for automated tests only");
    }
    this._test = endpoints || null;
    this._discovery = null;
    this._secret = undefined;
    this._access = null;
  },

  get _issuer() {
    return this._test?.issuer ?? ISSUER;
  },

  get _api() {
    return this._test?.api ?? RESOURCE;
  },

  _trusted(url) {
    try {
      const { protocol, hostname } = new URL(url);
      return protocol == "https:" || (!!this._test && protocol == "http:" && hostname == "127.0.0.1");
    } catch {
      return false;
    }
  },

  // ---- What WhimsyAIProviders asks of a plan ----

  async status() {
    const file = await this._readFile();
    if (!file.secret) {
      return { connected: false };
    }
    const secret = await this._loadSecret();
    return { connected: !!secret, label: secret?.email ?? "", signedOut: !!file.signedOut || !secret?.refreshToken };
  },

  async isReady() {
    const status = await this.status();
    return status.connected && !status.signedOut;
  },

  manageUsage(win) {
    this._openTab(win, USAGE_URL);
  },

  /**
   * Signs in (or back in) with ChatGPT in a normal tab. Resolves once the
   * plan can be used: { label, welcome } (welcome: the first sign-in on
   * this profile, which shows OpenAI's one-time note).
   */
  connect(win) {
    if (this._pending) {
      const { tab, win: tabWin } = this._pending.opened ?? {};
      if (tab?.isConnected && !tabWin.closed) {
        tabWin.gBrowser.selectedTab = tab;
      }
      return this._pending.promise;
    }
    const pending = { cancelled: false };
    pending.cancel = () => {
      pending.cancelled = true;
    };
    pending.promise = this._signIn(win, pending).finally(() => {
      if (this._pending == pending) {
        this._pending = null;
      }
    });
    this._pending = pending;
    return pending.promise;
  },

  // Ends a sign-in that's waiting (Settings closed, Cancel, Enable AI off).
  cancel() {
    this._pending?.cancel?.();
  },

  get signingIn() {
    return !!this._pending;
  },

  async disconnect() {
    this.cancel();
    await this._refreshing?.catch(() => {});
    const secret = await this._loadSecret();
    if (secret?.refreshToken) {
      try {
        await this._revoke(secret);
      } catch (e) {
        console.error("Whimsy AI: couldn't revoke the ChatGPT sign-in", e?.code ?? e?.name ?? "");
      }
    }
    this._access = null;
    await this._update(file => {
      delete file.secret;
      delete file.signedOut;
    });
    this._secret = null;
  },

  async models() {
    const response = await this._authorized(token =>
      this._fetch(`${this._api}/models`, { headers: { authorization: `Bearer ${token}` } })
    );
    if (!response.ok) {
      throw error(await this._failure(response), `ChatGPT models ${response.status}`);
    }
    const data = await response.json();
    return (Array.isArray(data?.models) ? data.models : [])
      .filter(model => typeof model?.slug == "string" && (model.visibility ?? "list") == "list")
      .map(model => model.slug);
  },

  async complete({ prompt, system, signal }) {
    let model = Services.prefs.getStringPref(MODEL_PREF, "");
    if (!model) {
      [model] = await this.models();
      if (!model) {
        throw error("no-model");
      }
    }
    const body = {
      model,
      input: [{ role: "user", content: [{ type: "input_text", text: String(prompt ?? "") }] }],
      store: false,
      stream: true,
    };
    if (system) {
      body.instructions = system;
    }
    const response = await this._authorized(token =>
      this._fetch(`${this._api}/responses`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "text/event-stream" },
        body: JSON.stringify(body),
        signal,
      })
    );
    if (!response.ok) {
      throw error(await this._failure(response), `ChatGPT responses ${response.status}`);
    }
    return this._read(response.body);
  },

  // ---- The stream ----

  async _read(body) {
    let text = "";
    let refused = false;
    for await (const { event, data } of sseEvents(body)) {
      if (!data || data == "[DONE]") {
        continue;
      }
      let message;
      try {
        message = JSON.parse(data);
      } catch {
        continue;
      }
      switch (message?.type || event) {
        case "response.output_text.delta":
          text += typeof message.delta == "string" ? message.delta : "";
          break;
        case "response.refusal.delta":
        case "response.refusal.done":
          refused = true;
          break;
        case "response.completed": {
          if (refused) {
            throw error("refused");
          }
          if (!text) {
            const parts = (message.response?.output || []).flatMap(item => (item.type == "message" ? item.content || [] : []));
            if (parts.some(part => part.type == "refusal")) {
              throw error("refused");
            }
            text = parts.filter(part => part.type == "output_text").map(part => part.text).join("");
          }
          return text;
        }
        case "response.failed":
          throw error(await this._mapped(codeFor(message.response?.error?.code), "failed"));
        case "response.incomplete":
          throw error("bad-response", "ChatGPT stopped before the answer was complete");
        case "error":
          throw error(await this._mapped(codeFor(message.code ?? message.error?.code), "failed"));
      }
    }
    // Only response.completed means the answer is whole.
    throw error("bad-response", "The ChatGPT stream ended early");
  },

  async _mapped(code, fallback) {
    if (code == "signed-out") {
      await this._markSignedOut();
    }
    return code ?? fallback;
  },

  // The code for a failed (non-stream) answer.
  async _failure(response) {
    let code = null;
    try {
      const data = await response.json();
      code = codeFor(data?.error?.code ?? data?.code);
    } catch {}
    if (code) {
      return this._mapped(code);
    }
    switch (response.status) {
      case 401:
        return this._mapped("signed-out");
      case 403:
        return "plan-ineligible";
      case 404:
        return "no-model";
      case 429:
        return "rate-limited";
      default:
        return response.status >= 500 ? "unavailable" : "failed";
    }
  },

  // Runs a request with the access token; once more with a fresh one when
  // the first is turned down.
  async _authorized(send) {
    let response = await send(await this._accessToken());
    if (response.status == 401) {
      response.body?.cancel().catch(() => {});
      response = await send(await this._accessToken({ force: true }));
    }
    return response;
  },

  async _fetch(url, options = {}) {
    try {
      return await fetch(url, { credentials: "omit", cache: "no-store", ...options });
    } catch (e) {
      if (options.signal?.aborted) {
        throw e;
      }
      throw error("network");
    }
  },

  // ---- Tokens ----

  // The access token, refreshed shortly before it runs out, one refresh at a
  // time.
  async _accessToken({ force = false } = {}) {
    if (!force && this._access && this._access.expiresAt - REFRESH_MARGIN_MS > Date.now()) {
      return this._access.token;
    }
    this._refreshing ??= this._refresh().finally(() => {
      this._refreshing = null;
    });
    return this._refreshing;
  },

  async _refresh() {
    const file = await this._readFile();
    const secret = await this._loadSecret();
    if (!secret?.refreshToken || file.signedOut) {
      throw error("signed-out");
    }
    const discovery = await this._discover();
    const response = await this._post(discovery.token_endpoint, {
      grant_type: "refresh_token",
      client_id: secret.clientId,
      refresh_token: secret.refreshToken,
      resource: RESOURCE,
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      if (REFRESH_ENDED.includes(data?.error)) {
        await this._markSignedOut();
        throw error("signed-out");
      }
      throw error(response.status >= 500 ? "unavailable" : "failed", `ChatGPT refresh ${response.status}`);
    }
    if (typeof data.access_token != "string" || !data.access_token) {
      throw error("bad-response", "No access token in the refresh");
    }
    if (typeof data.refresh_token == "string" && data.refresh_token && data.refresh_token != secret.refreshToken) {
      await this._saveSecret({ ...secret, refreshToken: data.refresh_token });
    }
    this._access = { token: data.access_token, expiresAt: Date.now() + (Number(data.expires_in) || 3600) * 1000 };
    return data.access_token;
  },

  async _markSignedOut() {
    this._access = null;
    const secret = await this._loadSecret();
    if (secret?.refreshToken) {
      await this._saveSecret({ ...secret, refreshToken: "" });
    }
    await this._update(file => {
      file.signedOut = true;
    });
    Services.obs.notifyObservers(null, "whimsy-ai-accounts-changed", "openai");
  },

  async _revoke(secret) {
    const discovery = await this._discover();
    if (!discovery.revocation_endpoint) {
      return;
    }
    for (let attempt = 0; ; attempt++) {
      let status = 0;
      try {
        const response = await this._post(discovery.revocation_endpoint, {
          token: secret.refreshToken,
          token_type_hint: "refresh_token",
          client_id: secret.clientId,
        });
        status = response.status;
        if (response.ok) {
          return;
        }
      } catch {}
      if ((status && status < 500) || attempt >= 2) {
        throw error("failed", `Revocation ${status || "network"}`);
      }
      await new Promise(resolve => setTimeout(resolve, 500 * 3 ** attempt));
    }
  },

  _post(url, form) {
    return this._fetch(url, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams(form).toString(),
      signal: timeoutSignal(),
    });
  },

  // The issuer's endpoints, never hardcoded (Sign in with ChatGPT is a
  // preview; its endpoints may move).
  async _discover() {
    if (!this._discovery) {
      this._discovery = (async () => {
        const response = await this._fetch(`${this._issuer}/.well-known/openid-configuration`, {
          signal: timeoutSignal(),
        });
        if (!response.ok) {
          throw error(response.status >= 500 ? "unavailable" : "failed", `Discovery ${response.status}`);
        }
        const doc = await response.json();
        if (doc?.issuer !== this._issuer) {
          throw error("failed", "The discovery document names another issuer");
        }
        for (const name of ["authorization_endpoint", "token_endpoint", "jwks_uri"]) {
          if (!this._trusted(doc[name])) {
            throw error("failed", `The discovery document's ${name} isn't https`);
          }
        }
        if (doc.revocation_endpoint && !this._trusted(doc.revocation_endpoint)) {
          delete doc.revocation_endpoint;
        }
        return doc;
      })();
      this._discovery.catch(() => {
        this._discovery = null;
      });
    }
    return this._discovery;
  },

  /**
   * Checks an ID token: the issuer's signature (RS256 or ES256 from its
   * JWKS), issuer, audience (the issued client), nonce and expiry.
   *
   * @returns {Promise<object>} The claims.
   */
  async _verifyIdToken(idToken, discovery, clientId, nonce) {
    const parts = String(idToken ?? "").split(".");
    if (parts.length != 3) {
      throw error("failed", "The ID token isn't a JWT");
    }
    let header, claims;
    try {
      header = decodePart(parts[0]);
      claims = decodePart(parts[1]);
    } catch {
      throw error("failed", "The ID token can't be read");
    }
    const algorithm = SIGNATURES[header?.alg];
    if (!algorithm) {
      throw error("failed", "The ID token's signature type isn't accepted");
    }
    const response = await this._fetch(discovery.jwks_uri, { signal: timeoutSignal() });
    const keys = response.ok ? (await response.json())?.keys : null;
    const candidates = (Array.isArray(keys) ? keys : []).filter(
      key => (!header.kid || key.kid == header.kid) && (!key.use || key.use == "sig") && (!key.alg || key.alg == header.alg)
    );
    if (candidates.length != 1) {
      throw error("failed", "No signing key for the ID token");
    }
    const { kty, n, e, crv, x, y } = candidates[0];
    let valid = false;
    try {
      const key = await crypto.subtle.importKey("jwk", { kty, n, e, crv, x, y }, algorithm.key, false, ["verify"]);
      valid = await crypto.subtle.verify(
        algorithm.verify,
        key,
        ChromeUtils.base64URLDecode(parts[2], { padding: "ignore" }),
        new TextEncoder().encode(`${parts[0]}.${parts[1]}`)
      );
    } catch {}
    if (!valid) {
      throw error("failed", "The ID token's signature doesn't check out");
    }
    const now = Date.now() / 1000;
    const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (
      claims.iss !== discovery.issuer ||
      !audiences.includes(clientId) ||
      (audiences.length > 1 && claims.azp !== clientId) ||
      typeof claims.exp != "number" ||
      claims.exp < now - CLOCK_SKEW_S ||
      (typeof claims.iat == "number" && claims.iat > now + CLOCK_SKEW_S) ||
      claims.nonce !== nonce ||
      typeof claims.sub != "string" ||
      !claims.sub
    ) {
      throw error("failed", "The ID token doesn't match this sign-in");
    }
    return claims;
  },

  // ---- Sign-in ----

  async _signIn(win, pending) {
    if (!lazy.WhimsyAIProviders.enabled || !Services.prefs.getBoolPref(GATE_PREF, false)) {
      throw error("blocked");
    }
    const watcher = () => {
      if (!lazy.WhimsyAIProviders.enabled || !Services.prefs.getBoolPref(GATE_PREF, false)) {
        this.cancel();
      }
    };
    for (const pref of WATCHED_PREFS) {
      Services.prefs.addObserver(pref, watcher);
    }
    let listener = null;
    try {
      const discovery = await this._discover();
      const hostId = await this._hostId();
      const saved = await this._loadSecret();
      const state = randomString();
      const nonce = randomString();
      const verifier = randomString();
      const challenge = ChromeUtils.base64URLEncode(
        new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))),
        { pad: false }
      );
      listener = await this._listen(state);
      pending.cancel = () => listener.fail(error("sign-in-cancelled"));
      if (pending.cancelled) {
        listener.fail(error("sign-in-cancelled"));
      }
      // A returning account signs in again with its issued client.
      const params = new URLSearchParams({
        response_type: "code",
        client_id: saved?.clientId || "dynamic_agent_client",
        redirect_uri: listener.redirectUri,
        scope: SCOPE,
        resource: RESOURCE,
        state,
        nonce,
        code_challenge: challenge,
        code_challenge_method: "S256",
        ext_agent_host_id: hostId,
      });
      if (!saved?.clientId) {
        params.set("agent_name_hint", AGENT_NAME);
      } else if (saved.email) {
        params.set("login_hint", saved.email);
      }
      const authorizeUrl = `${discovery.authorization_endpoint}?${params}`;
      const opened = await this._openTab(win, authorizeUrl);
      pending.opened = opened;
      const callback = await listener.result;
      this._forgetVisits([authorizeUrl, callback.url]);
      this._closeTab(opened, listener.redirectUri).catch(() => {});
      const clientId = callback.clientId || saved?.clientId || "";
      if (!CLIENT_ID.test(clientId)) {
        throw error("failed", "The sign-in didn't return a client");
      }
      const response = await this._post(discovery.token_endpoint, {
        grant_type: "authorization_code",
        client_id: clientId,
        code: callback.code,
        code_verifier: verifier,
        redirect_uri: listener.redirectUri,
        resource: RESOURCE,
      });
      const tokens = await response.json().catch(() => ({}));
      if (!response.ok || typeof tokens.access_token != "string" || typeof tokens.refresh_token != "string" || !tokens.refresh_token) {
        throw error(response.status >= 500 ? "unavailable" : "failed", `ChatGPT token exchange ${response.status}`);
      }
      const claims = await this._verifyIdToken(tokens.id_token, discovery, clientId, nonce);
      const scopes = String(tokens.scope ?? "").split(/\s+/);
      if (!scopes.includes(PLAN_SCOPE)) {
        // Signed in, but this plan can't be used here: nothing is kept.
        await this._revoke({ refreshToken: tokens.refresh_token, clientId }).catch(() => {});
        throw error("plan-ineligible");
      }
      await this._saveSecret({
        clientId,
        refreshToken: tokens.refresh_token,
        email: typeof claims.email == "string" ? claims.email : "",
        sub: claims.sub,
      });
      this._access = { token: tokens.access_token, expiresAt: Date.now() + (Number(tokens.expires_in) || 3600) * 1000 };
      const welcome = !Services.prefs.getBoolPref(WELCOMED_PREF, false);
      Services.prefs.setBoolPref(WELCOMED_PREF, true);
      await this._pickModel();
      return { label: claims.email ?? "", welcome };
    } finally {
      listener?.close();
      for (const pref of WATCHED_PREFS) {
        Services.prefs.removeObserver(pref, watcher);
      }
    }
  },

  // The plan's first listed model, when the one picked isn't on its list.
  async _pickModel() {
    try {
      const models = await this.models();
      if (models.length && !models.includes(Services.prefs.getStringPref(MODEL_PREF, ""))) {
        Services.prefs.setStringPref(MODEL_PREF, models[0]);
      }
    } catch (e) {
      console.error("Whimsy AI: listing the ChatGPT plan's models", e?.code ?? "");
    }
  },

  /**
   * One-shot loopback listener: 127.0.0.1 on a random port, one path, the
   * exact state, no requests from web pages (Origin), GET only; it closes on
   * the first callback, a wrong state, cancel or after five minutes.
   */
  async _listen(state) {
    const [doneText, failedText] = await lazy.l10n.formatValues([
      "whimsy-ai-plan-callback-done",
      "whimsy-ai-plan-callback-failed",
    ]);
    const page = text =>
      `<!DOCTYPE html><meta charset="utf-8"><title>Whimsy</title>` +
      `<p style="font: 15px system-ui; margin: 40px auto; max-width: 420px">${escapeHTML(text)}</p>`;
    const server = new lazy.HttpServer();
    let settle;
    const result = new Promise((resolve, reject) => (settle = { resolve, reject }));
    result.catch(() => {});
    let finished = false;
    let timer = null;
    const close = () => {
      clearTimeout(timer);
      if (server._socket) {
        Services.tm.dispatchToMainThread(() => server.stop(() => {}));
      }
    };
    const finish = (value, failure) => {
      if (finished) {
        return;
      }
      finished = true;
      failure ? settle.reject(failure) : settle.resolve(value);
      close();
    };
    server.registerPathHandler(CALLBACK_PATH, (request, response) => {
      response.setHeader("Cache-Control", "no-store", false);
      response.setHeader("Referrer-Policy", "no-referrer", false);
      response.setHeader("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'", false);
      response.setHeader("Content-Type", "text/html; charset=utf-8", false);
      if (finished || request.method != "GET" || request.hasHeader("Origin")) {
        response.setStatusLine(request.httpVersion, 403, "Forbidden");
        return;
      }
      const params = new URLSearchParams(request.queryString);
      const ok = params.get("state") === state && !params.has("error") && !!params.get("code");
      response.setStatusLine(request.httpVersion, ok ? 200 : 400, ok ? "OK" : "Bad Request");
      response.write(String.fromCharCode(...new TextEncoder().encode(page(ok ? doneText : failedText))));
      const url = `http://127.0.0.1:${server.identity.primaryPort}${CALLBACK_PATH}?${request.queryString}`;
      if (ok) {
        finish({ code: params.get("code"), clientId: params.get("client_id") ?? "", url });
      } else {
        finish(null, error(params.get("state") === state ? "sign-in-cancelled" : "failed", "The sign-in callback didn't match"));
      }
    });
    server._start(-1, "127.0.0.1");
    const port = server.identity.primaryPort;
    server.identity.add("http", "127.0.0.1", port);
    timer = setTimeout(() => finish(null, error("sign-in-cancelled", "The sign-in took too long")), SIGN_IN_TIMEOUT_MS);
    return {
      redirectUri: `http://127.0.0.1:${port}${CALLBACK_PATH}`,
      result,
      fail: failure => finish(null, failure),
      close: () => finish(null, error("sign-in-cancelled")),
    };
  },

  // A normal (never private) tab in front; a new normal window when only
  // private ones are open.
  async _openTab(win, url) {
    let target = win?.gBrowser && !win.closed && !lazy.PrivateBrowsingUtils.isWindowPrivate(win) ? win : null;
    target ??= lazy.BrowserWindowTracker.getTopWindow({ private: false });
    if (!target) {
      target = await lazy.BrowserWindowTracker.promiseOpenWindow({ private: false });
    }
    const previous = target.gBrowser.selectedTab;
    const tab = target.gBrowser.addTrustedTab(url, { inBackground: false });
    target.gBrowser.selectedTab = tab;
    target.focus();
    return { tab, previous, win: target };
  },

  // Closes the sign-in tab once it shows Whimsy's own page, back to where
  // the person was.
  async _closeTab(opened, redirectUri) {
    const { tab, previous, win } = opened ?? {};
    if (!tab || win.closed) {
      return;
    }
    const arrived = () => !!tab.linkedBrowser?.currentURI?.spec.startsWith(redirectUri);
    if (!arrived()) {
      await new Promise(resolve => {
        const listener = {
          onLocationChange: browser => browser == tab.linkedBrowser && arrived() && done(),
        };
        const done = () => {
          clearTimeout(timer);
          win.gBrowser.removeTabsProgressListener(listener);
          resolve();
        };
        const timer = setTimeout(done, 5000);
        win.gBrowser.addTabsProgressListener(listener);
      });
    }
    if (!tab.isConnected || win.closed || !arrived()) {
      return;
    }
    if (previous?.isConnected && win.gBrowser.selectedTab == tab) {
      win.gBrowser.selectedTab = previous;
    }
    win.gBrowser.removeTab(tab);
  },

  _forgetVisits(urls) {
    lazy.PlacesUtils.history.remove(urls.filter(Boolean)).catch(() => {});
  },

  // ---- Storage: ciphertext only, owner-only file ----

  get _path() {
    return PathUtils.join(PathUtils.profileDir, FILE);
  },

  async _readFile() {
    try {
      const saved = await IOUtils.readJSON(this._path);
      return saved && typeof saved == "object" ? saved : {};
    } catch {
      return {};
    }
  },

  // Read-change-write, one at a time.
  _update(change) {
    const run = this._queue.then(async () => {
      const file = await this._readFile();
      change(file);
      if (!Object.keys(file).length) {
        await IOUtils.remove(this._path, { ignoreAbsent: true });
        return;
      }
      await IOUtils.writeJSON(this._path, file, { tmpPath: this._path + ".tmp" });
      await IOUtils.setPermissions(this._path, 0o600);
    });
    this._queue = run.catch(() => {});
    return run;
  },

  // This install's stable host ID (not a secret).
  async _hostId() {
    let hostId = (await this._readFile()).hostId;
    if (typeof hostId != "string" || !hostId.startsWith("urn:uuid:")) {
      hostId = `urn:uuid:${Services.uuid.generateUUID().toString().slice(1, -1)}`;
      await this._update(file => {
        file.hostId = hostId;
      });
    }
    return hostId;
  },

  async _loadSecret() {
    if (this._secret !== undefined) {
      return this._secret;
    }
    const { secret } = await this._readFile();
    let value = null;
    if (secret) {
      try {
        value = JSON.parse(await lazy.OSKeyStore.decrypt(secret));
      } catch {
        console.error("Whimsy AI: couldn't decrypt the ChatGPT sign-in");
      }
    }
    this._secret = value;
    return value;
  },

  async _saveSecret(value) {
    await lazy.OSKeyStore.ensureLoggedIn(false);
    const secret = await lazy.OSKeyStore.encrypt(JSON.stringify(value));
    await this._update(file => {
      file.secret = secret;
      delete file.signedOut;
    });
    this._secret = value;
  },
};
