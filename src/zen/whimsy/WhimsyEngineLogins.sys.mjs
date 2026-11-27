/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// W32: Firefox's password manager for engine tabs. An engine's page reports
// a trusted focus on a login field and a submitted login ("login" events,
// their origin verified by the engine's native side); this answers with
// Firefox's own surfaces: the login autocomplete popup (AutoCompleteParent),
// LoginManagerParent's save and change doorhanger, its edit and remove
// actions, and saved-login lookups.
//
// Security: a field is filled only after the user chooses one of the popup's
// logins, never on page load, and only with a saved login whose origin
// matches the page's verified origin (checked again here by guid, so a row
// can't name another site's login). The engine fills only the main frame's
// document the event came from, on that origin; subframes never report.

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  AutoCompleteParent: "moz-src:///toolkit/actors/AutoCompleteParent.sys.mjs",
  LoginAutoCompleteResult: "resource://gre/modules/LoginAutoComplete.sys.mjs",
  LoginHelper: "resource://gre/modules/LoginHelper.sys.mjs",
  LoginManagerParent: "resource://gre/modules/LoginManagerParent.sys.mjs",
  PrivateBrowsingUtils: "resource://gre/modules/PrivateBrowsingUtils.sys.mjs",
});

let gClasses = null;

// LoginManagerParent and AutoCompleteParent are window actors; these stand
// in for them on the engine's page, which has no Gecko window global.
function actorClasses() {
  if (gClasses) {
    return gClasses;
  }
  class EngineLoginActor extends lazy.LoginManagerParent {
    constructor(session) {
      super();
      this._session = session;
    }
    get browsingContext() {
      return this._session.context;
    }
    get manager() {
      return this._session.manager;
    }
    get origin() {
      return this._session.formOrigin;
    }
    getRootBrowser() {
      return this._session.browser;
    }
    getBrowsingContextToUse() {
      return null;
    }
    maybeRecordPasswordGenerationShownTelemetryEvent() {}
    sendAsyncMessage(name, data) {
      this._session.onLoginMessage(name, data);
    }
  }
  class EngineAutoCompleteActor extends lazy.AutoCompleteParent {
    constructor(session) {
      super();
      this._session = session;
    }
    get browsingContext() {
      return this._session.context;
    }
    sendAsyncMessage(name, data) {
      this._session.onPopupMessage(name, data);
    }
  }
  gClasses = { EngineLoginActor, EngineAutoCompleteActor };
  return gClasses;
}

function principalFor(origin) {
  try {
    return Services.scriptSecurityManager.createContentPrincipalFromOrigin(
      origin
    );
  } catch {
    return null;
  }
}

// One login field the user focused in an engine tab's page.
class LoginSession {
  constructor(owner, tab, state, svc, data) {
    this.owner = owner;
    this.tab = tab;
    this.state = state;
    this.svc = svc;
    this.id = state.id;
    this.epoch = String(data.e || "");
    this.origin = String(data.origin || "");
    this.formOrigin = lazy.LoginHelper.getLoginOrigin(this.origin);
    this.principal = principalFor(this.origin);
    this.data = data;
    this.results = [];
    this.closed = false;
    const { EngineLoginActor, EngineAutoCompleteActor } = actorClasses();
    this.loginActor = new EngineLoginActor(this);
    this.popupActor = new EngineAutoCompleteActor(this);
  }

  get browser() {
    return this.tab.linkedBrowser;
  }

  get win() {
    return this.tab.documentGlobal;
  }

  get manager() {
    return {
      isClosed: this.closed || !this.isCurrent(),
      documentPrincipal: this.principal,
    };
  }

  // The browsing context both stand-in actors report: the tab's parked
  // Gecko <browser> embeds it, and its only actor is the login one.
  get context() {
    if (!this._context) {
      const session = this;
      this._context = {
        get canOpenModalPicker() {
          return session.mayShow();
        },
        top: {
          get embedderElement() {
            return session.browser;
          },
        },
        get topChromeWindow() {
          return session.win;
        },
        currentWindowGlobal: {
          documentPrincipal: this.principal,
          getActor: name =>
            name == "LoginManager" ? session.loginActor : null,
        },
      };
    }
    return this._context;
  }

  // Still the same engine view, document, and origin.
  isCurrent() {
    const state = this.owner._engineTabs.stateOf(this.tab);
    if (!state || state != this.state || state.id != this.id || !state.id) {
      return false;
    }
    try {
      return this.svc.currentEpoch(this.id) == this.epoch;
    } catch {
      return false;
    }
  }

  mayShow() {
    const win = this.win;
    return (
      !this.closed &&
      this.isCurrent() &&
      this.tab.selected &&
      !win.closed &&
      Services.focus.activeWindow == win
    );
  }

  act(action) {
    if (!this.isCurrent()) {
      return false;
    }
    try {
      this.svc.loginAction(
        this.id,
        this.epoch,
        this.origin,
        JSON.stringify(action)
      );
      return true;
    } catch {
      return false;
    }
  }

  async search(value) {
    const LoginHelper = lazy.LoginHelper;
    if (!Services.logins.isLoggedIn && Services.logins.uiBusy) {
      return [];
    }
    let actionOrigin = "";
    try {
      actionOrigin = LoginHelper.getLoginOrigin(this.data.action) || "";
    } catch {}
    const logins = await lazy.LoginManagerParent.searchAndDedupeLogins(
      this.formOrigin,
      {
        formActionOrigin: actionOrigin,
        ignoreActionAndRealm: true,
        acceptDifferentSubdomains: LoginHelper.includeOtherSubdomainsInLookup,
        relatedRealms: [],
      }
    );
    const isPassword = this.data.role == "password";
    const prefix = String(value || "").toLowerCase();
    const matching = logins.filter(
      login =>
        isPassword ||
        (login.username && login.username.toLowerCase().startsWith(prefix))
    );
    if (!matching.length) {
      return [];
    }
    let host = "";
    try {
      host = new URL(this.origin).host;
    } catch {}
    const result = new lazy.LoginAutoCompleteResult(
      isPassword ? "" : String(value || ""),
      matching,
      [],
      this.formOrigin,
      {
        isSecure: !!this.principal?.isOriginPotentiallyTrustworthy,
        hasBeenTypePassword: isPassword,
        hostname: host,
        telemetryEventData: {},
      }
    );
    const rows = [];
    for (let i = 0; i < result.matchCount; i++) {
      rows.push({
        value: result.getValueAt(i),
        label: result.getLabelAt(i),
        comment: result.getCommentAt(i),
        style: result.getStyleAt(i),
        image: result.getImageAt(i),
      });
    }
    return rows;
  }

  screenRect() {
    const { rect = {}, dpr = 1 } = this.data;
    const win = this.win;
    const box = this.browser.getBoundingClientRect();
    const scale = (Number(dpr) || 1) / (win.devicePixelRatio || 1);
    const num = v => (Number.isFinite(Number(v)) ? Number(v) : 0);
    return {
      left: win.mozInnerScreenX + box.left + num(rect.x) * scale,
      top: win.mozInnerScreenY + box.top + num(rect.y) * scale,
      width: Math.max(0, num(rect.w) * scale),
      height: Math.max(0, num(rect.h) * scale),
    };
  }

  async open() {
    if (!lazy.LoginHelper.enabled || !this.mayShow()) {
      return;
    }
    const rows = await this.search(this.data.value);
    if (
      !rows.length ||
      !this.mayShow() ||
      this.owner._sessions.get(this.tab) != this
    ) {
      return;
    }
    this.results = rows;
    this.popupActor.showPopupWithResults({
      rect: this.screenRect(),
      dir: this.data.dir == "rtl" ? "rtl" : "ltr",
      isDarkBackground: !!this.data.dark,
      results: rows,
      selectedIndex: -1,
      inputElementIdentifier: null,
    });
    if (this.popupActor.openedPopup) {
      this.act({ k: "popup", open: true, selected: false });
    }
  }

  async refilter(value) {
    this.data.value = value;
    if (!this.popupActor.openedPopup) {
      return;
    }
    const rows = await this.search(value);
    if (!this.popupActor.openedPopup) {
      return;
    }
    this.results = rows;
    this.popupActor.invalidate(rows);
    this.syncSelection();
  }

  syncSelection() {
    const popup = this.popupActor.openedPopup;
    this.act({
      k: "popup",
      open: !!popup,
      selected: !!popup && popup.selectedIndex >= 0,
    });
  }

  onKey(key) {
    const popup = this.popupActor.openedPopup;
    if (!popup) {
      return;
    }
    switch (key) {
      case "ArrowDown":
      case "ArrowUp":
        popup.selectBy(key == "ArrowUp", false);
        this.syncSelection();
        break;
      case "Enter":
        if (popup.selectedIndex >= 0) {
          this.choose();
        } else {
          this.close();
        }
        break;
      default:
        this.close();
    }
  }

  onBlur() {
    const popup = this.popupActor.openedPopup;
    // A click on the popup itself moves focus away from the page.
    if (popup && !popup.matches(":hover")) {
      this.close();
    }
  }

  // The user chose the popup's selected row: AutoCompleteParent routes it to
  // its provider (LoginManagerParent), as it does for a Gecko page.
  choose() {
    if (!this.popupActor.openedPopup) {
      return;
    }
    this.popupActor.selectAutoCompleteEntry();
    this.close();
  }

  onPopupMessage(name, data) {
    switch (name) {
      case "AutoComplete:HandleEnter":
        if (data?.isPopupSelection !== false) {
          this.choose();
        }
        break;
      case "AutoComplete:PopupClosed":
        this.act({ k: "popup", open: false, selected: false });
        break;
    }
  }

  onLoginMessage(name, data) {
    switch (name) {
      case "PasswordManager:OnFieldAutoComplete":
        this.fill(data?.guid).catch(console.error);
        break;
      case "PasswordManager:repopulateAutocompletePopup":
        if (this.owner._sessions.get(this.tab) == this) {
          this.open().catch(console.error);
        }
        break;
    }
  }

  // Looks the chosen login up again by guid: a row's data is only a hint,
  // and the login must match the page's verified origin.
  async findLogin(guid) {
    if (!guid || typeof guid != "string") {
      return null;
    }
    const [login] = await Services.logins.searchLoginsAsync({ guid });
    if (!login || login.httpRealm !== null) {
      return null;
    }
    return lazy.LoginHelper.isOriginMatching(login.origin, this.formOrigin, {
      schemeUpgrades: lazy.LoginHelper.schemeUpgrades,
      acceptDifferentSubdomains:
        lazy.LoginHelper.includeOtherSubdomainsInLookup,
    })
      ? login
      : null;
  }

  async fill(guid) {
    const login = await this.findLogin(guid);
    if (!login || !this.isCurrent()) {
      return;
    }
    if (
      this.act({
        k: "fill",
        username: login.username || "",
        password: login.password,
      })
    ) {
      this.owner._filled.set(this.tab, {
        guid: login.guid,
        origin: this.formOrigin,
        epoch: this.epoch,
      });
    }
  }

  close() {
    this.popupActor.closePopup();
  }
}

export const WhimsyEngineLogins = {
  _sessions: new WeakMap(),
  // tab -> the login last filled from the popup, for the doorhanger.
  _filled: new WeakMap(),
  _engineTabs: null,

  // A "login" event from an engine tab's page (its origin already verified
  // natively). engineTabs is WhimsyEngineTabs.
  onEvent(engineTabs, tab, state, svc, data) {
    this._engineTabs = engineTabs;
    if (!data || typeof data.origin != "string" || !svc?.loginAction) {
      return;
    }
    if (!/^https?:\/\//.test(data.origin)) {
      return;
    }
    const current = this._sessions.get(tab);
    switch (data.k) {
      case "show": {
        current?.close();
        const session = new LoginSession(this, tab, state, svc, data);
        this._sessions.set(tab, session);
        session.open().catch(console.error);
        break;
      }
      case "input":
        if (current?.epoch == data.e) {
          current.refilter(String(data.value || "")).catch(console.error);
        }
        break;
      case "key":
        if (current?.epoch == data.e) {
          current.onKey(String(data.key || ""));
        }
        break;
      case "blur":
        if (current?.epoch == data.e) {
          current.onBlur();
        }
        break;
      case "submit":
        this._onSubmit(tab, state, svc, data).catch(console.error);
        break;
    }
  },

  // Closes the login popup of a tab that navigated, hid, or went away.
  close(tab) {
    const session = this._sessions.get(tab);
    if (session) {
      session.closed = true;
      session.close();
      this._sessions.delete(tab);
    }
  },

  // Ends the session of a document the tab no longer shows. A reload or a
  // load of the same URL sends no location change, so the engine's load
  // reports check the document too.
  closeIfStale(tab) {
    const session = this._sessions.get(tab);
    if (session && !session.isCurrent()) {
      this.close(tab);
    }
  },

  async _onSubmit(tab, state, svc, data) {
    const LoginHelper = lazy.LoginHelper;
    const browser = tab.linkedBrowser;
    if (!LoginHelper.enabled || !browser?.browsingContext) {
      return;
    }
    if (
      lazy.PrivateBrowsingUtils.isBrowserPrivate(browser) &&
      !LoginHelper.privateBrowsingCaptureEnabled
    ) {
      return;
    }
    const field = f =>
      f && typeof f.value == "string" && f.value
        ? { value: f.value, name: String(f.name || "") }
        : null;
    const passwords = (Array.isArray(data.passwords) ? data.passwords : [])
      .map(field)
      .filter(Boolean)
      .slice(0, 3);
    if (!passwords.length) {
      return;
    }
    // As LoginManagerChild reads a form: one password is the login's; two
    // equal ones are a new password and its confirmation; otherwise the
    // first is the old password and the second the new one.
    let newPasswordField = passwords[0];
    let oldPasswordField = null;
    if (passwords.length > 1 && passwords[1].value != passwords[0].value) {
      oldPasswordField = passwords[0];
      newPasswordField = passwords[1];
    }
    const usernameField =
      typeof data.username == "string" && data.username
        ? { value: data.username, name: String(data.usernameName || "") }
        : null;
    const session = new LoginSession(this, tab, state, svc, data);
    let formActionOrigin = "";
    try {
      formActionOrigin = LoginHelper.getLoginOrigin(data.action) || "";
    } catch {}
    const filled = this._filled.get(tab);
    const autoFilledLoginGuid =
      filled && filled.origin == session.formOrigin ? filled.guid : null;
    await session.loginActor.showDoorhanger(browser, session.formOrigin, {
      browsingContextId: browser.browsingContext.id,
      formActionOrigin: formActionOrigin || session.formOrigin,
      autoFilledLoginGuid,
      usernameField,
      newPasswordField,
      oldPasswordField,
      dismissedPrompt: false,
    });
  },
};
