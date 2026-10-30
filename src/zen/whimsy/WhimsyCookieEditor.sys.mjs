/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Cookie editor: the "Cookie-Editor" / EditThisCookie extensions (millions
// of users) - click the icon, see this site's cookies, edit, add, delete,
// or copy them all as JSON. Used for debugging logins and switching test
// accounts without reaching for DevTools' Storage panel. Everything goes
// through Services.cookies, honouring the tab's own originAttributes
// (containers matter: a cookie in one container isn't in another).
// whimsy.feature.cookie-editor; the command bar action "Cookies" opens it.

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  WhimsyPanels: "resource:///modules/whimsy/WhimsyPanels.sys.mjs",
});

const FEATURE_PREF = "whimsy.feature.cookie-editor";
const PANEL_ID = "whimsy-cookie-editor-panel";
const HTML_NS = "http://www.w3.org/1999/xhtml";

export const WhimsyCookieEditor = {
  get enabled() {
    return Services.prefs.getBoolPref(FEATURE_PREF, true);
  },

  baseDomain(host) {
    try {
      return Services.eTLD.getBaseDomainFromHost(host);
    } catch (e) {
      return host;
    }
  },

  cookiesFor(host, originAttributes) {
    const base = this.baseDomain(host);
    return Services.cookies.getCookiesFromHost(base, originAttributes);
  },

  setCookie(host, originAttributes, details) {
    const { name, value, path = "/" } = details;
    // Keep the original cookie's transport/SameSite attributes on edits.
    // SameSite=None without Secure is rejected by Gecko validation.
    const previous = this.cookiesFor(host, originAttributes).find(
      cookie => cookie.host == host && cookie.name == name && cookie.path == path
    );
    const secure = details.secure ?? previous?.isSecure ?? false;
    const httpOnly = details.httpOnly ?? previous?.isHttpOnly ?? false;
    const sameSite = details.sameSite ?? previous?.sameSite ?? Ci.nsICookie.SAMESITE_LAX;
    const schemeMap = details.schemeMap ?? previous?.schemeMap ?? Ci.nsICookie.SCHEME_HTTPS;
    const oneYear = Date.now() + 365 * 24 * 60 * 60 * 1000;
    const validation = Services.cookies.add(
      host,
      path,
      name,
      value,
      secure,
      httpOnly,
      false, // isSession
      oneYear,
      originAttributes,
      sameSite,
      schemeMap,
      details.isPartitioned ?? previous?.isPartitioned ?? false // isPartitioned
    );
    if (validation.result != Ci.nsICookieValidation.eOK) {
      throw new Error(validation.errorString);
    }
  },

  removeCookie(host, name, path, originAttributes) {
    Services.cookies.remove(host, name, path, originAttributes);
  },

  copyAllAsJSON(win, host, originAttributes) {
    const cookies = this.cookiesFor(host, originAttributes).map(c => ({
      name: c.name,
      value: c.value,
      domain: c.host,
      path: c.path,
      secure: c.isSecure,
      httpOnly: c.isHttpOnly,
    }));
    win.navigator.clipboard.writeText(JSON.stringify(cookies, null, 2));
    win.gZenUIManager?.showToast?.("whimsy-cookie-editor-copied-toast", {});
  },

  initWindow(win) {
    // Nothing to initialize eagerly; the panel is built on demand by open().
  },

  // fixB: a WhimsyPanels sheet hanging off the site button in the address
  // bar (or centred, like the command bar, when the address bar is hidden).
  // One card per cookie: its name, flags and a monospaced value field that
  // saves on Enter or when focus leaves; Add Cookie and Copy as JSON in the
  // footer. Esc, the close button or a click outside close it.
  open(win) {
    const { document, gBrowser } = win;
    const browser = gBrowser.selectedBrowser;
    const host = browser.currentURI?.asciiHost;
    if (!host) {
      return;
    }
    const originAttributes = browser.contentPrincipal?.originAttributes ?? {};
    let query = "";
    const { panel, body, footer } = lazy.WhimsyPanels.create(win, {
      id: PANEL_ID,
      titleL10nId: "whimsy-cookie-editor-title",
      subtitle: this.baseDomain(host),
      size: "large",
      search: {
        l10nId: "whimsy-cookie-editor-search",
        onInput: value => {
          query = value.trim().toLowerCase();
          render();
        },
      },
      footer: true,
    });
    panel.classList.add("whimsy-cookie-editor");

    // The new-cookie form, shown by Add Cookie.
    const form = document.createXULElement("vbox");
    form.className = "whimsy-cookie-new";
    form.hidden = true;
    const newName = document.createElementNS(HTML_NS, "input");
    newName.className = "whimsy-cookie-new-name";
    document.l10n.setAttributes(newName, "whimsy-cookie-editor-new-name");
    const newValue = document.createElementNS(HTML_NS, "input");
    newValue.className = "whimsy-cookie-new-value";
    document.l10n.setAttributes(newValue, "whimsy-cookie-editor-new-value");
    const save = lazy.WhimsyPanels.footerButton(document, {
      l10nId: "whimsy-cookie-editor-save-new",
      primary: true,
      onCommand: () => addCookie(),
    });
    save.classList.add("small-button");
    const addCookie = () => {
      const name = newName.value.trim();
      if (!name) {
        newName.focus();
        return;
      }
      try {
        this.setCookie(host, originAttributes, { name, value: newValue.value });
      } catch (e) {
        console.error("Whimsy: add cookie", e);
        return;
      }
      newName.value = newValue.value = "";
      form.hidden = true;
      render();
    };
    for (const input of [newName, newValue]) {
      input.addEventListener("keydown", event => {
        if (event.key == "Enter") {
          event.preventDefault();
          addCookie();
        }
      });
    }
    form.append(newName, newValue, save);
    body.before(form);

    const render = () => {
      body.replaceChildren();
      const cookies = this.cookiesFor(host, originAttributes).filter(
        c => !query || c.name.toLowerCase().includes(query) || c.value.toLowerCase().includes(query)
      );
      if (!cookies.length) {
        body.append(
          lazy.WhimsyPanels.empty(document, {
            l10nId: query ? "whimsy-cookie-editor-no-match" : "whimsy-cookie-editor-empty",
            l10nArgs: { site: this.baseDomain(host) },
            icon: "chrome://browser/skin/zen-icons/cookies-fill.svg",
          })
        );
        return;
      }
      for (const cookie of cookies) {
        body.appendChild(this.row(win, originAttributes, cookie, render));
      }
    };

    footer.append(
      lazy.WhimsyPanels.footerButton(document, {
        l10nId: "whimsy-cookie-editor-add",
        onCommand: () => {
          form.hidden = !form.hidden;
          if (!form.hidden) {
            newName.focus();
          }
        },
      }),
      lazy.WhimsyPanels.footerButton(document, {
        l10nId: "whimsy-cookie-editor-copy-all",
        onCommand: () => this.copyAllAsJSON(win, host, originAttributes),
      })
    );
    render();
    const anchor = lazy.WhimsyPanels.visibleAnchor(win, ["zen-site-data-icon-button", "identity-icon-box", "urlbar"]);
    lazy.WhimsyPanels.open(win, panel, { anchor, position: "after_start" });
  },

  row(win, originAttributes, cookie, rerender) {
    const { document } = win;
    const card = document.createXULElement("vbox");
    card.className = "whimsy-cookie whimsy-cookie-editor-row";
    card.setAttribute("role", "group");
    card.setAttribute("aria-label", cookie.name);

    const head = document.createXULElement("hbox");
    head.className = "whimsy-cookie-head";
    head.setAttribute("align", "center");
    const name = document.createXULElement("label");
    name.className = "whimsy-cookie-name whimsy-cookie-editor-name";
    name.setAttribute("crop", "end");
    name.setAttribute("value", cookie.name);
    name.setAttribute("tooltiptext", `${cookie.host}${cookie.path}`);
    head.append(name);
    for (const [on, l10nId] of [
      [cookie.isSecure, "whimsy-cookie-editor-flag-secure"],
      [cookie.isHttpOnly, "whimsy-cookie-editor-flag-httponly"],
      [cookie.isSession, "whimsy-cookie-editor-flag-session"],
    ]) {
      if (on) {
        const flag = document.createXULElement("label");
        flag.className = "whimsy-cookie-flag";
        document.l10n.setAttributes(flag, l10nId);
        head.append(flag);
      }
    }
    const remove = lazy.WhimsyPanels.iconButton(document, {
      icon: "chrome://browser/skin/zen-icons/trash.svg",
      l10nId: "whimsy-cookie-editor-delete",
      onCommand: () => {
        this.removeCookie(cookie.host, cookie.name, cookie.path, originAttributes);
        rerender();
      },
    });
    remove.classList.add("whimsy-cookie-delete");
    head.append(remove);

    const value = document.createElementNS(HTML_NS, "input");
    value.setAttribute("type", "text");
    value.value = cookie.value;
    value.className = "whimsy-cookie-value whimsy-cookie-editor-value";
    value.setAttribute("spellcheck", "false");
    document.l10n.setAttributes(value, "whimsy-cookie-editor-value", { name: cookie.name });
    value.addEventListener("change", () => {
      try {
        this.setCookie(cookie.host, originAttributes, {
          name: cookie.name,
          value: value.value,
          path: cookie.path,
          secure: cookie.isSecure,
          httpOnly: cookie.isHttpOnly,
          sameSite: cookie.sameSite,
          schemeMap: cookie.schemeMap,
          isPartitioned: cookie.isPartitioned,
        });
      } catch (e) {
        console.error("Whimsy: edit cookie", e);
        return;
      }
      // A brief accent on the field says it saved.
      value.setAttribute("saved", "true");
      win.setTimeout(() => value.removeAttribute("saved"), 900);
    });

    card.append(head, value);
    return card;
  },
};
