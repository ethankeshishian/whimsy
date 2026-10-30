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

const FEATURE_PREF = "whimsy.feature.cookie-editor";

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

  setCookie(host, originAttributes, { name, value, path = "/", secure = false, httpOnly = false, sameSite = 0 }) {
    const oneYear = Math.floor(Date.now() / 1000) + 365 * 24 * 60 * 60;
    Services.cookies.add(
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
      Ci.nsICookie.SCHEME_UNSET,
      false // isPartitioned
    );
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

  open(win) {
    const { document, gBrowser } = win;
    const browser = gBrowser.selectedBrowser;
    const host = browser.currentURI?.asciiHost;
    if (!host) {
      return;
    }
    const originAttributes = browser.contentPrincipal?.originAttributes ?? {};
    document.getElementById("whimsy-cookie-editor-panel")?.remove();

    const panel = document.createXULElement("panel");
    panel.id = "whimsy-cookie-editor-panel";
    panel.className = "whimsy-cookie-editor";
    panel.setAttribute("noautohide", "false");
    panel.setAttribute("type", "arrow");

    const list = document.createXULElement("vbox");
    list.className = "whimsy-cookie-editor-list";

    const render = () => {
      list.replaceChildren();
      for (const cookie of this.cookiesFor(host, originAttributes)) {
        list.appendChild(this.row(win, host, originAttributes, cookie, render));
      }
    };

    const toolbar = document.createXULElement("hbox");
    const addButton = document.createXULElement("toolbarbutton");
    document.l10n.setAttributes(addButton, "whimsy-cookie-editor-add");
    addButton.addEventListener("command", () => {
      this.setCookie(host, originAttributes, { name: "new-cookie", value: "" });
      render();
    });
    const copyButton = document.createXULElement("toolbarbutton");
    document.l10n.setAttributes(copyButton, "whimsy-cookie-editor-copy-all");
    copyButton.addEventListener("command", () => this.copyAllAsJSON(win, host, originAttributes));
    toolbar.append(addButton, copyButton);

    panel.append(toolbar, list);
    panel.addEventListener("keydown", e => e.key == "Escape" && panel.hidePopup());
    panel.addEventListener("popuphidden", () => panel.remove());
    document.documentElement.appendChild(panel);
    render();
    panel.openPopup(browser, "overlap");
  },

  row(win, host, originAttributes, cookie, rerender) {
    const { document } = win;
    const line = document.createXULElement("hbox");
    line.className = "whimsy-cookie-editor-row";

    const name = document.createXULElement("label");
    name.value = cookie.name;
    name.className = "whimsy-cookie-editor-name";

    const value = document.createElementNS("http://www.w3.org/1999/xhtml", "input");
    value.setAttribute("type", "text");
    value.value = cookie.value;
    value.className = "whimsy-cookie-editor-value";
    value.addEventListener("change", () => {
      this.setCookie(cookie.host, originAttributes, {
        name: cookie.name,
        value: value.value,
        path: cookie.path,
        secure: cookie.isSecure,
        httpOnly: cookie.isHttpOnly,
        sameSite: cookie.sameSite,
      });
    });

    const remove = document.createXULElement("toolbarbutton");
    remove.className = "whimsy-cookie-editor-delete";
    document.l10n.setAttributes(remove, "whimsy-cookie-editor-delete");
    remove.addEventListener("command", () => {
      this.removeCookie(cookie.host, cookie.name, cookie.path, originAttributes);
      rerender();
    });

    line.append(name, value, remove);
    return line;
  },
};
