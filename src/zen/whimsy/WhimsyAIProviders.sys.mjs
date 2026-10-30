/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Whimsy AI Provider Manager:
// Provides inference via user-chosen provider (Claude Messages API, Apple
// on-device Foundation Models, local Ollama, or Fake provider for testing).
// Strict rules:
// - Kill switch (whimsy.ai.blocked) disables all providers and inference.
// - NO automatic cloud fallback: only the chosen provider is used.
// - Secrets (Claude API key) are stored in Firefox's login manager, never prefs.

import { AppConstants } from "resource://gre/modules/AppConstants.sys.mjs";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  WhimsyAI: "resource:///modules/whimsy/WhimsyAI.sys.mjs",
});

const LOGIN_HOSTNAME = "chrome://whimsy-ai";
const LOGIN_REALM = "Whimsy Claude API";
const LOGIN_USERNAME = "claude-api-key";

const PREF_PROVIDER = "whimsy.ai.provider";
const PREF_CLAUDE_MODEL = "whimsy.ai.claude.model";
const PREF_OLLAMA_ENDPOINT = "whimsy.ai.ollama.endpoint";
const PREF_OLLAMA_MODEL = "whimsy.ai.ollama.model";

export const WhimsyAIProviders = {
  _fakeHandler: null,

  get provider() {
    return Services.prefs.getStringPref(PREF_PROVIDER, "apple");
  },

  set provider(val) {
    Services.prefs.setStringPref(PREF_PROVIDER, val);
  },

  setFakeHandler(fn) {
    this._fakeHandler = fn;
  },

  getFakeHandler() {
    return this._fakeHandler;
  },

  // Retrieve Claude API key from Firefox LoginManager (never preferences)
  async getClaudeApiKey() {
    try {
      const logins = await Services.logins.searchLoginsAsync({
        hostname: LOGIN_HOSTNAME,
        httpRealm: LOGIN_REALM,
        username: LOGIN_USERNAME,
      });
      return logins.length > 0 ? logins[0].password : "";
    } catch (e) {
      console.error("WhimsyAIProviders: failed to get Claude key from login manager", e);
      return "";
    }
  },

  // Save or delete Claude API key in Firefox LoginManager
  async setClaudeApiKey(key) {
    const trimmed = (key || "").trim();
    const logins = await Services.logins.searchLoginsAsync({
      hostname: LOGIN_HOSTNAME,
      httpRealm: LOGIN_REALM,
      username: LOGIN_USERNAME,
    });

    if (trimmed) {
      if (logins.length > 0) {
        const propBag = Cc["@mozilla.org/hash-property-bag;1"].createInstance(Ci.nsIWritablePropertyBag2);
        propBag.setPropertyAsAString("password", trimmed);
        await Services.logins.modifyLoginAsync(logins[0], propBag);
      } else {
        const loginInfo = Cc["@mozilla.org/login-manager/loginInfo;1"].createInstance(Ci.nsILoginInfo);
        loginInfo.init(LOGIN_HOSTNAME, null, LOGIN_REALM, LOGIN_USERNAME, trimmed, "", "");
        await Services.logins.addLoginAsync(loginInfo);
      }
    } else if (logins.length > 0) {
      await Services.logins.removeLoginAsync(logins[0]);
    }
  },

  // Unified completion entry point.
  // Throws if kill switch blocked, or if chosen provider fails.
  // NO automatic cloud fallback: only the chosen provider is contacted.
  async complete({ prompt, system = "", maxTokens = 1024 } = {}) {
    if (lazy.WhimsyAI.blocked) {
      throw new Components.Exception("AI is blocked by kill switch", Cr.NS_ERROR_ABORT);
    }

    const currentProvider = this.provider;

    // Fake provider for test suites
    if (currentProvider === "fake" || this._fakeHandler) {
      if (this._fakeHandler) {
        return this._fakeHandler({ prompt, system, maxTokens });
      }
      return { text: "Fake AI response for prompt: " + (prompt || "").slice(0, 60) };
    }

    switch (currentProvider) {
      case "claude":
        return this._completeClaude({ prompt, system, maxTokens });
      case "apple":
        return this._completeApple({ prompt, system, maxTokens });
      case "ollama":
        return this._completeOllama({ prompt, system, maxTokens });
      default:
        throw new Error(`Unsupported AI provider: ${currentProvider}`);
    }
  },

  async _completeClaude({ prompt, system, maxTokens }) {
    const apiKey = await this.getClaudeApiKey();
    if (!apiKey) {
      throw new Error("Claude API key not configured in login manager");
    }

    const model = Services.prefs.getStringPref(PREF_CLAUDE_MODEL, "claude-3-5-haiku-20241022");
    const payload = {
      model,
      max_tokens: maxTokens,
      messages: [{ role: "user", content: prompt }],
    };
    if (system) {
      payload.system = system;
    }

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => "");
      throw new Error(`Claude API returned status ${response.status}: ${errText}`);
    }

    const data = await response.json();
    const text = data.content?.map(part => part.text || "").join("") || "";
    return { text };
  },

  async _completeApple({ prompt: _prompt, system: _system, maxTokens: _maxTokens }) {
    if (AppConstants.platform !== "macosx") {
      throw new Error("Apple on-device model only available on macOS");
    }
    // Apple Intelligence on macOS Sequoia Foundation Models
    // When the native bridge or system model is not present, report unavailable
    throw new Error("Apple on-device model is unavailable on this device");
  },

  async _completeOllama({ prompt, system }) {
    const endpoint = Services.prefs.getStringPref(PREF_OLLAMA_ENDPOINT, "http://127.0.0.1:11434");
    const model = Services.prefs.getStringPref(PREF_OLLAMA_MODEL, "llama3.2");
    const fullPrompt = system ? `${system}\n\n${prompt}` : prompt;

    const url = `${endpoint.replace(/\/+$/, "")}/api/generate`;
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model,
        prompt: fullPrompt,
        stream: false,
      }),
    });

    if (!response.ok) {
      throw new Error(`Ollama request failed with status ${response.status}`);
    }

    const data = await response.json();
    return { text: data.response || "" };
  },
};
