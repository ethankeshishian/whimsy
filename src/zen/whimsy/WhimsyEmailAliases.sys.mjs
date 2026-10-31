/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Email aliases (whimsy.feature.email-aliases): a small mask button in email
// fields opens a menu with two providers.
// - iCloud Hide My Email, through the person's own signed-in iCloud.com
//   session (the same requests the iCloud website makes). Sign-in state is
//   checked first: signed in, one click creates, reserves and fills an
//   alias; signed out, the item reads "Sign in to iCloud to use Hide My
//   Email" and opens iCloud.com in a Glance. Never bypasses a challenge:
//   anything but a valid session means "sign in on iCloud.com".
// - Firefox Relay, through Firefox's own integration (FirefoxRelay.sys.mjs:
//   its consent, Mozilla sign-in, reuse and error panels).
// The menu lives in the browser chrome (WhimsyEmailAliasesParent), so a page
// can't press it; every failure ends in a toast, never silence.

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  FirefoxRelay: "resource://gre/modules/FirefoxRelay.sys.mjs",
  NetUtil: "resource://gre/modules/NetUtil.sys.mjs",
  PrivateBrowsingUtils: "resource://gre/modules/PrivateBrowsingUtils.sys.mjs",
  WhimsyCommands: "resource:///modules/whimsy/WhimsyCommands.sys.mjs",
});

const FEATURE_PREF = "whimsy.feature.email-aliases";
const RELAY_PREF = "signon.firefoxRelay.feature";

const ICLOUD_ORIGIN = "https://www.icloud.com";
const ICLOUD_SIGN_IN_URL = "https://www.icloud.com/";
const ICLOUD_VALIDATE_URL = "https://setup.icloud.com/setup/ws/1/validate";
// The iCloud web client's build tag; the service wants one on each call.
const ICLOUD_CLIENT_BUILD = "2206Hotfix12";
const REQUEST_TIMEOUT_MS = 15000;
// Sign-in state is reused briefly so opening the menu twice doesn't call
// Apple twice; a sign-in or failure clears it.
const STATUS_TTL_MS = 60 * 1000;

export class AliasError extends Error {
  // reason: "signed-out" | "unavailable" | "network" | "service" |
  // "relay-off" | "relay"
  constructor(reason, message = reason) {
    super(message);
    this.reason = reason;
  }
}

export const WhimsyEmailAliases = {
  get enabled() {
    return Services.prefs.getBoolPref(FEATURE_PREF, true);
  },

  get relayAvailable() {
    return Services.prefs.getStringPref(RELAY_PREF, "") != "disabled";
  },

  _status: new Map(), // userContextId -> { at, value }
  _clientId: null,

  clearStatus() {
    this._status.clear();
  },

  // A quick local look for iCloud's web session cookies, so a signed-out
  // person costs no network request.
  hasICloudCookie(userContextId = 0) {
    try {
      return Services.cookies
        .getCookiesFromHost("icloud.com", { userContextId })
        .some(c => c.name.startsWith("X-APPLE-WEBAUTH-"));
    } catch (e) {
      console.error("Whimsy: email aliases cookie check", e);
      return false;
    }
  },

  // { state: "signed-in", baseUrl, dsid } | { state: "signed-out" } |
  // { state: "unavailable" } (no iCloud+) | { state: "error" }.
  async iCloudStatus(userContextId = 0, { fresh = false } = {}) {
    const cached = this._status.get(userContextId);
    if (!fresh && cached && Date.now() - cached.at < STATUS_TTL_MS) {
      return cached.value;
    }
    let value;
    if (!this.hasICloudCookie(userContextId)) {
      value = { state: "signed-out" };
    } else {
      try {
        const res = await this._request(ICLOUD_VALIDATE_URL, "", { userContextId });
        const baseUrl = res.json?.webservices?.premiummailsettings?.url;
        if (res.status == 200 && this._isICloudUrl(baseUrl)) {
          value = {
            state: "signed-in",
            baseUrl: baseUrl.replace(/:443$/, "").replace(/\/$/, ""),
            dsid: String(res.json.dsInfo?.dsid ?? ""),
          };
        } else if (res.status == 200) {
          // Signed in, but the account has no Hide My Email (no iCloud+).
          value = { state: "unavailable" };
        } else if (res.status == 401 || res.status == 421 || res.status == 450) {
          // The session needs a fresh sign-in or two-factor: the website
          // handles that, never us.
          value = { state: "signed-out" };
        } else {
          value = { state: "error" };
        }
      } catch (e) {
        console.error("Whimsy: iCloud status", e);
        value = { state: "error" };
      }
    }
    if (value.state != "error") {
      this._status.set(userContextId, { at: Date.now(), value });
    }
    return value;
  },

  // Creates and reserves a Hide My Email address labelled with the site.
  // Resolves to the address; rejects with an AliasError.
  async createICloudAlias({ userContextId = 0, label }) {
    const status = await this.iCloudStatus(userContextId);
    if (status.state == "signed-out") {
      throw new AliasError("signed-out");
    }
    if (status.state == "unavailable") {
      throw new AliasError("unavailable");
    }
    if (status.state != "signed-in") {
      throw new AliasError("network");
    }
    const query = new URLSearchParams({
      clientBuildNumber: ICLOUD_CLIENT_BUILD,
      clientMasteringNumber: ICLOUD_CLIENT_BUILD,
      clientId: this._getClientId(),
      dsid: status.dsid,
    });
    const call = async (path, body) => {
      let res;
      try {
        res = await this._request(`${status.baseUrl}/v1/hme/${path}?${query}`, JSON.stringify(body), {
          userContextId,
        });
      } catch (e) {
        throw new AliasError("network", e.message);
      }
      if (res.status == 401 || res.status == 421) {
        this.clearStatus();
        throw new AliasError("signed-out");
      }
      if (res.status != 200 || !res.json?.success) {
        const detail = res.json?.error?.errorMessage || `HTTP ${res.status}`;
        throw new AliasError("service", String(detail).slice(0, 200));
      }
      return res.json.result;
    };
    const generated = await call("generate", { langCode: "en-us" });
    const hme = generated?.hme;
    if (typeof hme != "string" || !hme.includes("@")) {
      throw new AliasError("service", "no address returned");
    }
    await call("reserve", { hme, label: label || "Whimsy", note: "" });
    return hme;
  },

  // Firefox Relay through Firefox's own flow. Firefox shows its own consent,
  // sign-in and error panels; resolves to the mask, or null when the person
  // cancelled one of those.
  async createRelayAlias(browser, origin) {
    if (!this.relayAvailable) {
      throw new AliasError("relay-off");
    }
    try {
      const enabled = Services.prefs.getStringPref(RELAY_PREF, "") == "enabled";
      const address = enabled
        ? await lazy.FirefoxRelay.generateUsername(browser, origin)
        : await lazy.FirefoxRelay.offerRelayIntegration(browser, origin);
      return address || null;
    } catch (e) {
      throw new AliasError("relay", e.message);
    }
  },

  // wave7/small: "Create Email Alias" in the command bar. It opens the
  // alias menu at the email field that has focus in the current tab (any
  // frame), the same menu the field's mask button opens; with no email
  // field focused, a toast says to click into one first.
  initWindow(win) {
    lazy.WhimsyCommands.register(win, {
      id: "cmd_whimsyCreateEmailAlias",
      l10nId: "whimsy-action-create-email-alias",
      run: w => this.createForFocusedField(w),
      icon: "chrome://browser/skin/zen-icons/mail.svg",
      isAvailable: w => {
        const uri = w.gBrowser?.selectedBrowser?.currentURI;
        return (
          this.enabled &&
          !lazy.PrivateBrowsingUtils.isWindowPrivate(w) &&
          !!uri &&
          (uri.schemeIs("https") || uri.schemeIs("http"))
        );
      },
    });
  },

  // Resolves to "menu" (opened at the field), "no-field", "private" or "off".
  async createForFocusedField(win) {
    if (!this.enabled) {
      return "off";
    }
    const browser = win.gBrowser.selectedBrowser;
    if (lazy.PrivateBrowsingUtils.isBrowserPrivate(browser)) {
      return "private";
    }
    const contexts = browser.browsingContext?.getAllBrowsingContextsInSubtree() ?? [];
    for (const context of contexts) {
      let actor = null;
      try {
        actor = context.currentWindowGlobal?.getActor("WhimsyEmailAliases");
      } catch (e) {
        // Not a web page (the actor only matches http and https).
        continue;
      }
      let field = null;
      try {
        field = await actor?.sendQuery("WhimsyEmailAliases:FocusedField");
      } catch (e) {
        continue;
      }
      if (field) {
        actor.openMenu(field).catch(e => console.error("Whimsy: email aliases", e));
        return "menu";
      }
    }
    win.gZenUIManager?.showToast?.("whimsy-email-aliases-toast-no-field");
    return "no-field";
  },

  openICloudSignIn(win) {
    this.clearStatus();
    const triggeringPrincipal = Services.scriptSecurityManager.getSystemPrincipal();
    if (win.gZenGlanceManager?.openGlance) {
      win.gZenGlanceManager.openGlance({ url: ICLOUD_SIGN_IN_URL, triggeringPrincipal });
    } else {
      win.openWebLinkIn(ICLOUD_SIGN_IN_URL, "tab", { triggeringPrincipal });
    }
  },

  _isICloudUrl(url) {
    try {
      const uri = Services.io.newURI(url);
      return uri.scheme == "https" && (uri.host == "icloud.com" || uri.host.endsWith(".icloud.com"));
    } catch {
      return false;
    }
  },

  _getClientId() {
    this._clientId ??= Services.uuid.generateUUID().toString().slice(1, -1).toUpperCase();
    return this._clientId;
  },

  // POSTs to an iCloud URL with the iCloud.com session of that container
  // (the cookies go with the request the way they would from the website).
  // Resolves to { status, json }. Tests replace this.
  _request(url, body, { userContextId = 0 } = {}) {
    if (!this._isICloudUrl(url)) {
      return Promise.reject(new Error("not an iCloud URL"));
    }
    const uri = Services.io.newURI(url);
    const principal = Services.scriptSecurityManager.createContentPrincipal(
      Services.io.newURI(ICLOUD_ORIGIN),
      { userContextId }
    );
    const channel = lazy.NetUtil.newChannel({
      uri,
      loadingPrincipal: principal,
      triggeringPrincipal: principal,
      securityFlags: Ci.nsILoadInfo.SEC_ALLOW_CROSS_ORIGIN_SEC_CONTEXT_IS_NULL | Ci.nsILoadInfo.SEC_COOKIES_INCLUDE,
      contentPolicyType: Ci.nsIContentPolicy.TYPE_OTHER,
    }).QueryInterface(Ci.nsIHttpChannel);
    channel.loadFlags |= Ci.nsIRequest.LOAD_BYPASS_CACHE | Ci.nsIRequest.INHIBIT_CACHING;
    const stream = Cc["@mozilla.org/io/string-input-stream;1"].createInstance(Ci.nsIStringInputStream);
    stream.setUTF8Data(body);
    channel.QueryInterface(Ci.nsIUploadChannel2).explicitSetUploadStream(stream, "text/plain", -1, "POST", false);
    channel.setRequestHeader("Origin", ICLOUD_ORIGIN, false);
    channel.setRequestHeader("Referer", ICLOUD_ORIGIN + "/", false);
    channel.setRequestHeader("Accept", "application/json", false);

    return new Promise((resolve, reject) => {
      const timer = Cc["@mozilla.org/timer;1"].createInstance(Ci.nsITimer);
      timer.initWithCallback(
        () => channel.cancel(Cr.NS_ERROR_NET_TIMEOUT),
        REQUEST_TIMEOUT_MS,
        Ci.nsITimer.TYPE_ONE_SHOT
      );
      lazy.NetUtil.asyncFetch(channel, (inputStream, result, request) => {
        timer.cancel();
        if (!Components.isSuccessCode(result)) {
          reject(Components.Exception("iCloud request failed", result));
          return;
        }
        let status = 0;
        try {
          status = request.QueryInterface(Ci.nsIHttpChannel).responseStatus;
        } catch {}
        let json = null;
        try {
          const text = lazy.NetUtil.readInputStreamToString(inputStream, inputStream.available(), {
            charset: "UTF-8",
          });
          json = JSON.parse(text);
        } catch {}
        resolve({ status, json });
      });
    });
  },
};
