/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// wave9/menus: Share ▸ as a real submenu (W9-09, user: "the Share row today
// closes the menu and opens a second one; make it a normal submenu listing
// the share targets, like other submenus").
//
// Firefox's Share ▸ (SharingUtils, in the tab menu, the File menu and a
// split pane's ⋯ menu) holds Copy Link, maybe QR Code, then "Share…", which
// closes the menu and opens macOS's share picker. Here the submenu also
// lists the services themselves (AirDrop, Messages, Mail, Notes…, with
// their icons), from the native share/ component; picking one runs it for
// the same links Firefox would share (the tab, or every selected tab).
// Firefox's "Share…" stays last, for the services macOS only offers in its
// picker. Without the component (not macOS) nothing changes.

const FEATURE_PREF = "whimsy.feature.menu-parity";
const SERVICE_CLASS = "whimsy-share-service";

const installed = new WeakSet();

export const WhimsyShareMenu = {
  get enabled() {
    return Services.prefs.getBoolPref(FEATURE_PREF, true);
  },

  // The native component, or null. Tests replace it with `_service`.
  _service: undefined,
  get service() {
    if (this._service === undefined) {
      try {
        this._service = Cc["@whimsy/share;1"]?.getService(Ci.nsIWhimsyShare) ?? null;
      } catch (e) {
        this._service = null;
      }
    }
    return this._service;
  },

  initWindow(win) {
    if (installed.has(win)) {
      return;
    }
    installed.add(win);
    // Firefox fills the submenu from a listener on the popup itself, so this
    // window listener sees it already filled.
    const onShowing = event => {
      const popup = event.target;
      if (popup?.localName != "menupopup" || !popup.parentNode?.classList?.contains("share-tab-url-item")) {
        return;
      }
      try {
        this.fill(win, popup);
      } catch (e) {
        console.error("Whimsy: share menu", e);
      }
    };
    win.addEventListener("popupshowing", onShowing);
    win.addEventListener("unload", () => win.removeEventListener("popupshowing", onShowing), { once: true });
  },

  // The links Firefox's submenu would share: every selected tab's, or the
  // one tab's (SharingUtils keeps them on the <menu>).
  linksFor(win, menu) {
    const { SharingUtils } = win;
    if (!SharingUtils) {
      return [];
    }
    if (menu.browsersToShare) {
      return SharingUtils.getLinksToShare(menu);
    }
    const { urlToShare, titleToShare } = SharingUtils.getLinkToShare(menu);
    return urlToShare ? [{ url: urlToShare, title: titleToShare ?? "" }] : [];
  },

  servicesFor(urls) {
    const service = this.service;
    if (!service || !urls.length) {
      return [];
    }
    const names = {};
    const titles = {};
    const icons = {};
    try {
      service.getServices(urls, names, titles, icons);
    } catch (e) {
      console.error("Whimsy: share services", e);
      return [];
    }
    return (names.value ?? []).map((name, i) => ({
      name,
      title: titles.value?.[i] ?? "",
      icon: icons.value?.[i] ?? "",
    }));
  },

  fill(win, popup) {
    for (const old of popup.querySelectorAll(`.${SERVICE_CLASS}, .whimsy-share-separator`)) {
      old.remove();
    }
    if (!this.enabled) {
      return;
    }
    const menu = popup.parentNode;
    const links = this.linksFor(win, menu);
    const services = this.servicesFor(links.map(link => link.url));
    if (!services.length) {
      return;
    }
    const { document } = win;
    // Before Firefox's "Share…" (and its separator), else last.
    const picker = popup.querySelector(".share-mac-picker-item, .share-windows-item");
    const anchor = picker?.previousElementSibling?.localName == "menuseparator" ? picker.previousElementSibling : picker;
    const rows = [];
    const separator = document.createXULElement("menuseparator");
    separator.className = "whimsy-share-separator";
    rows.push(separator);
    for (const service of services) {
      const item = document.createXULElement("menuitem");
      item.className = `${SERVICE_CLASS} menuitem-iconic`;
      // A service's own name, as macOS gives it (not a Whimsy string).
      item.setAttribute("label", service.title);
      if (service.icon) {
        item.setAttribute("image", service.icon);
      }
      item.dataset.whimsyShareService = service.name;
      item.addEventListener("command", event => {
        event.stopPropagation();
        this.share(win, service.name, links);
      });
      rows.push(item);
    }
    if (anchor) {
      anchor.before(...rows);
    } else {
      popup.append(...rows);
    }
  },

  share(win, name, links) {
    const service = this.service;
    if (!service || !links.length) {
      return false;
    }
    try {
      return service.share(
        name,
        links.map(link => link.url),
        links.length == 1 ? links[0].title ?? "" : ""
      );
    } catch (e) {
      console.error("Whimsy: share", e);
      return false;
    }
  },
};
