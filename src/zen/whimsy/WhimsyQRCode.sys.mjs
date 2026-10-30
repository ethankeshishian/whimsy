/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// QR code for any page. Chrome, Safari and Edge put "Create QR code for this
// page" one right-click away; people use it to hand a page to their phone
// (or someone else's) without signing in to anything. Firefox already has
// the whole feature: SharingUtils.showQRCodePanel opens its QR dialog
// (QRCodeGenerator, Copy and Save buttons) in the tab, gated by
// browser.shareqrcode.enabled. It's only reachable from the address bar's
// context menu and the Share submenus, which Zen's compact sidebar and
// address bar hide. So this only exposes it where Whimsy users look:
// - the page context menu, "QR Code for Page", beside Save Page As;
// - the command bar, "Show QR Code for Page".
// Like Handoff, never for private tabs, Scratch or private windows: a QR
// code is a way to send the page elsewhere. Firefox's own QR entries (the
// address bar menu and Share submenus) are hidden there too.

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  BrowserUtils: "resource://gre/modules/BrowserUtils.sys.mjs",
  PrivateBrowsingUtils: "resource://gre/modules/PrivateBrowsingUtils.sys.mjs",
  SharingUtils: "moz-src:///browser/components/sharing/SharingUtils.sys.mjs",
  WhimsyPrivate: "resource:///modules/whimsy/WhimsyPrivate.sys.mjs",
  WhimsyShortcuts: "resource:///modules/whimsy/WhimsyShortcuts.sys.mjs",
});

const FEATURE_PREF = "whimsy.feature.qr-code";
const FIREFOX_PREF = "browser.shareqrcode.enabled";
const MENU_ID = "context-whimsy-qrcode";
const COMMAND_ID = "cmd_whimsyShowQRCode";
export const QR_ICON = "chrome://browser/content/sharing/qr-code.svg";

export const WhimsyQRCode = {
  get enabled() {
    return Services.prefs.getBoolPref(FEATURE_PREF, true) && Services.prefs.getBoolPref(FIREFOX_PREF, true);
  },

  // Whether the tab (or its browser) is one whose page must never leave the
  // device this way: private windows, private tabs and Scratch.
  isExcluded(win, browser) {
    if (lazy.PrivateBrowsingUtils.isWindowPrivate(win)) {
      return true;
    }
    const tab = browser ? win.gBrowser.getTabForBrowser(browser) : null;
    if (!tab) {
      return true;
    }
    const P = lazy.WhimsyPrivate;
    if (P.isPrivateTab(tab) || P.isPrivateBrowser(browser)) {
      return true;
    }
    if (P.isScratchId(win, tab.getAttribute("zen-workspace-id"))) {
      return true;
    }
    return tab.selected && P.activeSpaceIsScratch(win);
  },

  // The readable URL to encode for the browser's page, or null when there's
  // none to offer (about: pages, private tabs, Scratch, switches off).
  urlFor(win, browser = win.gBrowser.selectedBrowser) {
    if (!this.enabled || !browser || this.isExcluded(win, browser)) {
      return null;
    }
    const shareable = lazy.BrowserUtils.getShareableURL(browser.currentURI);
    if (!shareable) {
      return null;
    }
    try {
      return win.gURLBar?.makeURIReadable(shareable).displaySpec ?? shareable.displaySpec;
    } catch (e) {
      return shareable.displaySpec;
    }
  },

  // Opens Firefox's QR code dialog for the page. Returns whether it did.
  show(win, browser = win.gBrowser.selectedBrowser) {
    const url = this.urlFor(win, browser);
    if (!url) {
      return false;
    }
    lazy.SharingUtils.showQRCodePanel(win, browser, url).catch(e => console.error("Whimsy: QR code", e));
    return true;
  },

  initWindow(win) {
    const { document } = win;
    lazy.WhimsyShortcuts.addCommand(win, { id: COMMAND_ID, run: w => this.show(w) });
    lazy.WhimsyShortcuts.addActions([
      {
        l10nId: "whimsy-action-qrcode",
        command: COMMAND_ID,
        icon: QR_ICON,
        isAvailable: w => !!this.urlFor(w),
      },
    ]);

    const menu = document.getElementById("contentAreaContextMenu");
    if (menu) {
      const item = document.createXULElement("menuitem");
      item.id = MENU_ID;
      item.hidden = true;
      document.l10n.setAttributes(item, "whimsy-context-qrcode");
      // gContextMenu is read when the item is used, never kept.
      item.addEventListener("command", () => {
        const browser = win.gContextMenu?.browser ?? win.gBrowser.selectedBrowser;
        this.show(win, browser);
      });
      const anchor = document.getElementById("context-savepage");
      anchor ? anchor.after(item) : menu.append(item);
      menu.addEventListener("popupshowing", event => {
        if (event.target != menu) {
          return;
        }
        // Firefox has already decided whether page items show (Save Page
        // As is hidden on links, images, selections and fields).
        const pageItems = !document.getElementById("context-savepage")?.hidden;
        const browser = win.gContextMenu?.browser;
        item.hidden = !pageItems || !browser || !this.urlFor(win, browser);
      });
    }

    // Firefox's own QR entries (address bar menu, Share submenus): runs
    // after Firefox's handlers, which only check browser.shareqrcode.enabled.
    win.addEventListener("popupshowing", event => this.hideFirefoxItems(win, event.target));
  },

  hideFirefoxItems(win, popup) {
    if (!Services.prefs.getBoolPref(FEATURE_PREF, true) || !popup?.querySelectorAll) {
      return;
    }
    for (const item of popup.querySelectorAll(":scope > .share-qrcode-item")) {
      const ref = item.contextBrowserToShare ?? popup.parentNode?.contextBrowserToShare;
      const browser = ref?.get?.() ?? win.gBrowser.selectedBrowser;
      if (this.isExcluded(win, browser)) {
        item.hidden = true;
      }
    }
  },
};
