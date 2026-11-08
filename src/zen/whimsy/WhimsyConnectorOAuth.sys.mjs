/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// W23: connector sign-ins (OAuth 2.1 for native apps). PKCE S256 + state,
// a one-shot loopback callback on 127.0.0.1 (the pattern of
// WhimsyAIOpenAIAuth), the provider's page in a small window. Google and
// Microsoft use the owner's registered client IDs (prefs); MCP servers are
// found through their metadata (RFC 9728, RFC 8414) and register Whimsy
// themselves (RFC 7591). This module only signs in and refreshes; the
// tokens are kept by WhimsyConnectors, encrypted with OSKeyStore.

import { clearTimeout, setTimeout } from "resource://gre/modules/Timer.sys.mjs";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  AppConstants: "resource://gre/modules/AppConstants.sys.mjs",
  BrowserWindowTracker: "resource:///modules/BrowserWindowTracker.sys.mjs",
  HttpServer: "chrome://remote/content/server/httpd.sys.mjs",
  PlacesUtils: "resource://gre/modules/PlacesUtils.sys.mjs",
});
ChromeUtils.defineLazyGetter(lazy, "l10n", () => new Localization(["browser/whimsy.ftl"], true));

const CALLBACK_PATH = "/connector/callback";
const SIGN_IN_TIMEOUT_MS = 5 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 20000;

export const OAUTH_PROVIDERS = {
  google: {
    authorize: "https://accounts.google.com/o/oauth2/v2/auth",
    token: "https://oauth2.googleapis.com/token",
    revoke: "https://oauth2.googleapis.com/revoke",
    userinfo: "https://openidconnect.googleapis.com/v1/userinfo",
    base: ["openid", "email"],
    scopes: {
      gmail: "https://www.googleapis.com/auth/gmail.readonly",
      calendar: "https://www.googleapis.com/auth/calendar.readonly",
      drive: "https://www.googleapis.com/auth/drive.readonly",
    },
    extra: { access_type: "offline", prompt: "consent", include_granted_scopes: "true" },
  },
  microsoft: {
    authorize: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
    token: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
    userinfo: "https://graph.microsoft.com/v1.0/me",
    base: ["openid", "email", "offline_access", "User.Read"],
    scopes: { outlook: "Mail.Read", calendar: "Calendars.Read", onedrive: "Files.Read" },
    extra: { prompt: "select_account" },
  },
};

export class WhimsyConnectorError extends Error {
  constructor(code, message = code) {
    super(message);
    this.name = "WhimsyConnectorError";
    this.code = code;
  }
}

const error = (code, message) => new WhimsyConnectorError(code, message);

function randomString(bytes = 32) {
  return ChromeUtils.base64URLEncode(crypto.getRandomValues(new Uint8Array(bytes)), { pad: false });
}

async function challengeOf(verifier) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return ChromeUtils.base64URLEncode(new Uint8Array(digest), { pad: false });
}

const escapeHTML = text => String(text).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

export const WhimsyConnectorOAuth = {
  _test: null,

  // Tests only: replaces provider endpoints ({google: {...}}) on 127.0.0.1.
  setTestEndpoints(endpoints) {
    this._test = endpoints || null;
  },

  provider(id) {
    const base = OAUTH_PROVIDERS[id];
    return base && { ...base, ...(this._test?.[id] ?? {}) };
  },

  clientId(id) {
    return Services.prefs.getStringPref(`whimsy.connectors.${id}.client-id`, "").trim();
  },

  // Google's desktop clients come with a client secret that isn't secret
  // (Google's docs say so for installed apps); Microsoft's have none.
  clientSecret(id) {
    return Services.prefs.getStringPref(`whimsy.connectors.${id}.client-secret`, "").trim();
  },

  _trusted(url) {
    try {
      const { protocol, hostname } = new URL(url);
      return protocol == "https:" || (protocol == "http:" && ["127.0.0.1", "localhost"].includes(hostname));
    } catch {
      return false;
    }
  },

  async _fetch(url, options = {}) {
    if (!this._trusted(url)) {
      throw error("failed", "Not an https address");
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      return await fetch(url, { credentials: "omit", cache: "no-store", ...options, signal: options.signal ?? controller.signal });
    } catch (e) {
      throw error("unreachable", String(e?.message ?? e));
    } finally {
      clearTimeout(timer);
    }
  },

  async _post(url, form, headers = {}) {
    return this._fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json", ...headers },
      body: new URLSearchParams(Object.entries(form).filter(([, v]) => v != null && v !== "")).toString(),
    });
  },

  /**
   * Google or Microsoft: the provider's sign-in for `scopes` (connector
   * scope ids). Resolves to {tokens, account}.
   */
  async signInProvider(win, id, scopes, pending = {}) {
    const p = this.provider(id);
    const clientId = this.clientId(id);
    if (!p || !clientId) {
      throw error("needs-client-id");
    }
    const scope = [...p.base, ...scopes.map(s => p.scopes[s]).filter(Boolean)].join(" ");
    const tokens = await this.authorize(win, {
      authorize: p.authorize,
      token: p.token,
      clientId,
      clientSecret: this.clientSecret(id),
      scope,
      extra: p.extra,
      pending,
    });
    let account = "";
    try {
      const response = await this._fetch(p.userinfo, { headers: { Authorization: `Bearer ${tokens.access}` } });
      const me = await response.json();
      account = String(me.email ?? me.mail ?? me.userPrincipalName ?? "").slice(0, 200);
    } catch {}
    return { tokens: { ...tokens, clientId }, account };
  },

  /**
   * An MCP server's sign-in: its protected resource metadata names the
   * authorization server; Whimsy registers itself there when it can.
   */
  async signInMcp(win, serverUrl, { resourceMetadata = null, pending = {}, saved = null } = {}) {
    const server = new URL(serverUrl);
    let metaUrl = resourceMetadata;
    if (!metaUrl) {
      metaUrl = `${server.origin}/.well-known/oauth-protected-resource${server.pathname == "/" ? "" : server.pathname}`;
    }
    let issuer = server.origin;
    try {
      const meta = await (await this._fetch(metaUrl, { headers: { Accept: "application/json" } })).json();
      issuer = meta.authorization_servers?.[0] ?? issuer;
    } catch {}
    const as = await this._discover(issuer);
    let clientId = saved?.clientId ?? "";
    if (!clientId) {
      if (!as.registration_endpoint) {
        throw error("needs-client-id");
      }
      clientId = await this._register(as.registration_endpoint);
    }
    const tokens = await this.authorize(win, {
      authorize: as.authorization_endpoint,
      token: as.token_endpoint,
      clientId,
      scope: (as.scopes_supported ?? []).includes("offline_access") ? "offline_access" : "",
      extra: { resource: server.href },
      pending,
      tab: true,
    });
    return { ...tokens, clientId, tokenUrl: as.token_endpoint, resource: server.href };
  },

  async _discover(issuer) {
    const url = new URL(issuer);
    const path = url.pathname == "/" ? "" : url.pathname;
    for (const candidate of [`${url.origin}/.well-known/oauth-authorization-server${path}`, `${url.origin}/.well-known/openid-configuration${path}`]) {
      try {
        const response = await this._fetch(candidate, { headers: { Accept: "application/json" } });
        if (response.ok) {
          const meta = await response.json();
          if (this._trusted(meta.authorization_endpoint) && this._trusted(meta.token_endpoint)) {
            return meta;
          }
        }
      } catch {}
    }
    throw error("failed", "No sign-in found for this server");
  },

  async _register(endpoint) {
    const response = await this._fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        client_name: "Whimsy",
        redirect_uris: [`http://127.0.0.1${CALLBACK_PATH}`],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      }),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || typeof body.client_id != "string") {
      throw error("failed", "The server didn't register Whimsy");
    }
    return body.client_id;
  },

  /**
   * Authorization code + PKCE through the loopback. `pending.cancel` is set
   * so a Cancel press stops it. Resolves to {access, refresh, expiresAt, scope}.
   */
  async authorize(win, { authorize, token, clientId, clientSecret = "", scope, extra = {}, pending = {}, tab = false }) {
    const state = randomString();
    const verifier = randomString();
    const listener = await this._listen(state);
    try {
      pending.cancel = () => listener.fail(error("cancelled"));
      if (pending.cancelled) {
        listener.fail(error("cancelled"));
      }
      const params = new URLSearchParams({
        response_type: "code",
        client_id: clientId,
        redirect_uri: listener.redirectUri,
        state,
        code_challenge: await challengeOf(verifier),
        code_challenge_method: "S256",
        ...(scope ? { scope } : {}),
        ...extra,
      });
      const url = `${authorize}?${params}`;
      const opened = await this.openSignIn(win, url, { tab, onClosed: () => listener.fail(error("cancelled")) });
      pending.opened = opened;
      const callback = await listener.result;
      lazy.PlacesUtils.history.remove([url, callback.url]).catch(() => {});
      opened?.close?.();
      const response = await this._post(token, {
        grant_type: "authorization_code",
        client_id: clientId,
        client_secret: clientSecret,
        code: callback.code,
        code_verifier: verifier,
        redirect_uri: listener.redirectUri,
        ...(extra.resource ? { resource: extra.resource } : {}),
      });
      return await this._tokens(response);
    } finally {
      listener.close();
    }
  },

  async _tokens(response, previous = null) {
    const body = await response.json().catch(() => ({}));
    if (!response.ok || typeof body.access_token != "string") {
      throw error(body.error == "invalid_grant" || response.status == 400 || response.status == 401 ? "expired" : "failed", `Token ${response.status}`);
    }
    return {
      access: body.access_token,
      refresh: typeof body.refresh_token == "string" ? body.refresh_token : previous?.refresh ?? "",
      expiresAt: Date.now() + (Number(body.expires_in) || 3600) * 1000,
      scope: String(body.scope ?? previous?.scope ?? ""),
    };
  },

  /** A fresh access token from a refresh token; "expired" when it's gone. */
  async refresh({ tokenUrl, clientId, clientSecret = "", tokens, resource = "" }) {
    if (!tokens?.refresh) {
      throw error("expired");
    }
    const response = await this._post(tokenUrl, {
      grant_type: "refresh_token",
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: tokens.refresh,
      ...(resource ? { resource } : {}),
    });
    return this._tokens(response, tokens);
  },

  async revoke(id, tokens) {
    const p = this.provider(id);
    if (p?.revoke && tokens?.refresh) {
      await this._post(p.revoke, { token: tokens.refresh }).catch(() => {});
    }
  },

  /**
   * The provider's page in a small window over Whimsy (or a tab, for MCP
   * servers), never private. Tests replace this.
   */
  async openSignIn(win, url, { tab = false, onClosed } = {}) {
    let target = win && !win.closed && win.gBrowser ? win : lazy.BrowserWindowTracker.getTopWindow({ private: false });
    if (tab && target) {
      const opened = target.gBrowser.addTrustedTab(url, { inBackground: false });
      target.focus();
      const onClose = () => onClosed?.();
      opened.addEventListener("TabClose", onClose, { once: true });
      return {
        close() {
          opened.removeEventListener("TabClose", onClose);
          if (opened.isConnected) {
            target.gBrowser.removeTab(opened);
          }
        },
      };
    }
    const features = "chrome,dialog=no,toolbar=no,menubar=no,location=yes,resizable,width=520,height=680,centerscreen";
    const args = Cc["@mozilla.org/supports-string;1"].createInstance(Ci.nsISupportsString);
    args.data = url;
    const popup = Services.ww.openWindow(target ?? null, lazy.AppConstants.BROWSER_CHROME_URL, "_blank", features, args);
    let closing = false;
    popup.addEventListener("unload", () => !closing && onClosed?.(), { once: true });
    return {
      window: popup,
      close() {
        closing = true;
        if (!popup.closed) {
          popup.close();
        }
      },
    };
  },

  /** One-shot loopback listener: one path, the exact state, GET, no Origin. */
  async _listen(state) {
    const [doneText, failedText] = await lazy.l10n.formatValues(["whimsy-connectors-callback-done", "whimsy-connectors-callback-failed"]);
    const page = text => `<!DOCTYPE html><meta charset="utf-8"><title>Whimsy</title><p style="font: 15px system-ui; margin: 40px auto; max-width: 420px">${escapeHTML(text)}</p>`;
    const server = new lazy.HttpServer();
    let settle;
    const result = new Promise((resolve, reject) => (settle = { resolve, reject }));
    result.catch(() => {});
    let finished = false;
    let timer = null;
    const finish = (value, failure) => {
      if (finished) {
        return;
      }
      finished = true;
      clearTimeout(timer);
      failure ? settle.reject(failure) : settle.resolve(value);
      if (server._socket) {
        Services.tm.dispatchToMainThread(() => server.stop(() => {}));
      }
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
        finish({ code: params.get("code"), url });
      } else {
        finish(null, error(params.get("state") === state ? "cancelled" : "failed", "The sign-in callback didn't match"));
      }
    });
    server._start(-1, "127.0.0.1");
    const port = server.identity.primaryPort;
    server.identity.add("http", "127.0.0.1", port);
    timer = setTimeout(() => finish(null, error("cancelled", "The sign-in took too long")), SIGN_IN_TIMEOUT_MS);
    return {
      redirectUri: `http://127.0.0.1:${port}${CALLBACK_PATH}`,
      result,
      fail: failure => finish(null, failure),
      close: () => finish(null, error("cancelled")),
    };
  },
};
