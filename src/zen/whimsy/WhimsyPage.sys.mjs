/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Page tools: things you do to the page you're on.
//
// Capture (Arc's Capture, Edge's Web Capture): Firefox Screenshots is the
// capture tool (drag a region, click an element, or Visible / Full Page,
// then Copy or Download). Whimsy adds Arc's Cmd+Shift+2 for it, and a
// one-step "Copy Full-Page Screenshot" (Cmd+Opt+Shift+F and the command
// bar) that drops the whole page on the clipboard with no editor between.

import { AppConstants } from "resource://gre/modules/AppConstants.sys.mjs";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  BrowserUtils: "resource://gre/modules/BrowserUtils.sys.mjs",
  PrivateBrowsingUtils: "resource://gre/modules/PrivateBrowsingUtils.sys.mjs",
  ScreenshotsUtils: "moz-src:///browser/components/screenshots/ScreenshotsUtils.sys.mjs",
  WhimsyMedia: "resource:///modules/whimsy/WhimsyMedia.sys.mjs",
  WhimsyShortcuts: "resource:///modules/whimsy/WhimsyShortcuts.sys.mjs",
});

const CAPTURE_FEATURE_PREF = "whimsy.feature.capture";

// Edit text on page (the designMode bookmarklet): turn it on from the page
// menu or the command bar, click anywhere and type, then press Esc (or
// click the "Editing" pill in the address bar) to finish. People use it to
// try copy changes, redact a screenshot, or test text lengths. It's per
// page: reloading or leaving the page ends it.
const EDIT_FEATURE_PREF = "whimsy.feature.edit-page";
const EDIT_MENU_ID = "context-whimsy-edit-page";
const EDIT_PILL_ID = "whimsy-editing-pill";

// Allow copy and paste ("Absolute Enable Right Click & Copy", "Don't
// F*** With Paste"): on a site that blocks selecting, copying, pasting or
// right-clicking, the command bar's "Allow Copy and Paste on This Site"
// makes them work again, and remembers it for the site. The page's
// copy/cut/paste/contextmenu/selectstart/dragstart handlers no longer run
// there, and user-select: none is overridden. Off by default, per site.
const COPY_FEATURE_PREF = "whimsy.feature.allow-copy";
const COPY_PERMISSION = "whimsy-allow-copy";

// Internet Archive for dead pages (Brave's Wayback Machine prompt and the
// official extension): when a page is gone (404, 410, 451, 5xx) or its
// site can't be reached, a bar offers the Wayback Machine's latest copy,
// with its date. "Open in Internet Archive" in the command bar works on any
// page. Never asked for private windows or local addresses.
const ARCHIVE_FEATURE_PREF = "whimsy.feature.wayback";
const ARCHIVE_PROMPT_PREF = "whimsy.archive.prompt";
const ARCHIVE_API_PREF = "whimsy.archive.api";
const ARCHIVE_API = "https://archive.org/wayback/available?url=";
const ARCHIVE_WEB = "https://web.archive.org/web/";
const ARCHIVE_STATUSES = new Set([404, 410, 451, 500, 502, 503, 504, 520, 521, 522, 523, 524]);
const ARCHIVE_ERRORS = new Set(["dnsNotFound", "connectionFailure", "netTimeout", "netReset", "unknownHost"]);
const ARCHIVE_BAR = "whimsy-archive";

// Translate selection (Safari and Edge: select, translate, an inline
// popover): Firefox's on-device "Translate Selection" panel, which was only
// in the context menu, gets a shortcut (Cmd+Opt+Shift+T) and a command bar
// action. Not an AI feature, so the AI kill switch leaves it alone.
const TRANSLATE_FEATURE_PREF = "whimsy.feature.translate-selection";

// Reader typography (Safari Reader's book fonts): Reader View's "Text and
// layout" panel already has size, width, spacing and colours; Whimsy adds
// the macOS reading fonts to its font list. The list is a JSON pref, set
// here rather than in YAML (a JSON string there breaks firefox.js).
const READER_FEATURE_PREF = "whimsy.feature.reader-fonts";
const READER_FONTS_PREF = "reader.font_type.values";
export const READER_FONTS = [
  "sans-serif",
  "serif",
  "monospace",
  "Charter",
  "Iowan Old Style",
  "Georgia",
  "Athelas",
  "Palatino",
  "Seravek",
];

function isWebPage(win) {
  const tab = win.gBrowser.selectedTab;
  const uri = tab.linkedBrowser?.currentURI;
  return !!tab.linkedPanel && !tab.hasAttribute("zen-empty-tab") && !!uri && !uri.spec.startsWith("about:blank");
}

export const WhimsyPage = {
  get captureEnabled() {
    return Services.prefs.getBoolPref(CAPTURE_FEATURE_PREF, true);
  },

  // Once per session.
  init() {
    if (this._initialized) {
      return;
    }
    this._initialized = true;
    this.initReaderFonts();
  },

  initWindow(win) {
    this.init();
    this.initCapture(win);
    this.initEditPage(win);
    this.initAllowCopy(win);
    this.initArchive(win);
    this.initTranslateSelection(win);
  },

  actorFor(browser) {
    return browser?.browsingContext?.currentWindowGlobal?.getActor("WhimsyPage") ?? null;
  },

  // --- Capture ---

  initCapture(win) {
    if (!this.captureEnabled) {
      return;
    }
    const { WhimsyShortcuts } = lazy;
    // Arc's capture shortcut, beside Firefox's Cmd+Shift+S.
    WhimsyShortcuts.addKey(win, {
      id: "key_whimsyScreenshotArc",
      command: "Browser:Screenshot",
      key: "2",
      modifiers: "accel,shift",
    });
    WhimsyShortcuts.addCommand(win, {
      id: "cmd_whimsyCopyFullPage",
      run: w => this.copyFullPageScreenshot(w),
      key: { id: "key_whimsyCopyFullPage", key: "F", modifiers: "accel,alt,shift" },
    });
    WhimsyShortcuts.addActions([
      {
        l10nId: "whimsy-action-copy-full-page",
        command: "cmd_whimsyCopyFullPage",
        icon: "chrome://browser/skin/zen-icons/screenshot.svg",
        isAvailable: w => this.captureEnabled && isWebPage(w),
      },
    ]);
  },

  // Copies the whole page as a PNG (Screenshots draws it). Returns the image's size in CSS pixels,
  // or null when the page can't be captured.
  async copyFullPageScreenshot(win, browser = win.gBrowser.selectedBrowser) {
    if (!this.captureEnabled || !isWebPage(win)) {
      return null;
    }
    const { ScreenshotsUtils, BrowserUtils } = lazy;
    let rect;
    try {
      rect = await browser.browsingContext.currentWindowGlobal.getActor("WhimsyPage").sendQuery("Whimsy:PageBounds");
    } catch (e) {
      console.error("Whimsy: full-page capture", e);
      win.gZenUIManager?.showToast?.("whimsy-capture-failed-toast");
      return null;
    }
    const canvas = await ScreenshotsUtils.createCanvas(rect, browser);
    const blob = await canvas.convertToBlob();
    BrowserUtils.copyImageToClipboard(await blob.arrayBuffer());
    win.gZenUIManager?.showToast?.("whimsy-capture-copied-toast");
    const ratio = rect.devicePixelRatio || 1;
    return { width: canvas.width / ratio, height: canvas.height / ratio };
  },

  // --- Edit text on page ---

  get editPageEnabled() {
    return Services.prefs.getBoolPref(EDIT_FEATURE_PREF, true);
  },

  initEditPage(win) {
    const { document, gBrowser } = win;
    const { WhimsyShortcuts } = lazy;
    WhimsyShortcuts.addCommand(win, {
      id: "cmd_whimsyEditPage",
      run: w => this.toggleEditing(w),
    });
    WhimsyShortcuts.addActions([
      {
        l10nId: "whimsy-action-edit-page",
        command: "cmd_whimsyEditPage",
        icon: "chrome://browser/skin/zen-icons/edit-theme.svg",
        isAvailable: w => this.editPageEnabled && isWebPage(w),
      },
    ]);
    const menu = document.getElementById("contentAreaContextMenu");
    menu?.addEventListener("popupshowing", event => {
      if (event.target == menu) {
        this.updateEditMenu(win);
      }
    });
    gBrowser.tabContainer.addEventListener("TabSelect", () => this.updateEditPill(win));
    gBrowser.addTabsProgressListener({
      onLocationChange: (browser, webProgress, request, location, flags) => {
        if (webProgress.isTopLevel && !(flags & Ci.nsIWebProgressListener.LOCATION_CHANGE_SAME_DOCUMENT) && browser.whimsyEditing) {
          browser.whimsyEditing = false;
          this.updateEditPill(win);
        }
      },
    });
  },

  updateEditMenu(win) {
    const { document } = win;
    let item = document.getElementById(EDIT_MENU_ID);
    const context = win.gContextMenu;
    const show = this.editPageEnabled && isWebPage(win) && !!context && !context.onTextInput && !context.onEditable;
    if (!show) {
      if (item) {
        item.hidden = true;
      }
      return;
    }
    if (!item) {
      item = document.createXULElement("menuitem");
      item.id = EDIT_MENU_ID;
      item.setAttribute("type", "checkbox");
      document.l10n.setAttributes(item, "whimsy-context-edit-page");
      item.addEventListener("command", () => this.toggleEditing(win));
      const anchor = document.getElementById("context-take-screenshot");
      anchor ? anchor.after(item) : document.getElementById("contentAreaContextMenu").appendChild(item);
    }
    item.hidden = false;
    item.toggleAttribute("checked", !!win.gBrowser.selectedBrowser.whimsyEditing);
  },

  // Turns editing on or off for the current page; returns whether it's on.
  async toggleEditing(win, on = !win.gBrowser.selectedBrowser.whimsyEditing) {
    const browser = win.gBrowser.selectedBrowser;
    if (on && (!this.editPageEnabled || !isWebPage(win))) {
      return false;
    }
    const actor = this.actorFor(browser);
    if (!actor) {
      return false;
    }
    const editing = await actor.sendQuery("Whimsy:SetEditable", { on });
    browser.whimsyEditing = editing;
    this.updateEditPill(win);
    if (editing) {
      win.gZenUIManager?.showToast?.("whimsy-edit-page-toast");
    }
    return editing;
  },

  // From the page: Esc ended editing.
  onEditingEnded(browser) {
    browser.whimsyEditing = false;
    const win = browser.ownerDocument?.defaultView;
    if (win) {
      this.updateEditPill(win);
    }
  },

  updateEditPill(win) {
    const { document } = win;
    const editing = !!win.gBrowser.selectedBrowser?.whimsyEditing;
    let pill = document.getElementById(EDIT_PILL_ID);
    if (!pill) {
      if (!editing) {
        return;
      }
      pill = document.createXULElement("hbox");
      pill.id = EDIT_PILL_ID;
      pill.setAttribute("align", "center");
      pill.setAttribute("role", "button");
      pill.setAttribute("tabindex", "0");
      const label = document.createXULElement("label");
      document.l10n.setAttributes(label, "whimsy-editing-pill");
      pill.append(label);
      pill.addEventListener("click", () => this.toggleEditing(win, false));
      pill.addEventListener("keydown", event => {
        if (event.key == "Enter" || event.key == " ") {
          this.toggleEditing(win, false);
        }
      });
      const buttons = document.getElementById("page-action-buttons");
      buttons ? buttons.prepend(pill) : document.getElementById("urlbar-container")?.append(pill);
    }
    pill.hidden = !editing;
  },

  // --- Allow copy and paste ---

  get allowCopyEnabled() {
    return Services.prefs.getBoolPref(COPY_FEATURE_PREF, true);
  },

  copyAllowed(browser) {
    const site = lazy.WhimsyMedia.siteFor(browser);
    return (
      !!site &&
      Services.perms.testExactPermissionFromPrincipal(site.principal, COPY_PERMISSION) == Services.perms.ALLOW_ACTION
    );
  },

  initAllowCopy(win) {
    const { WhimsyShortcuts } = lazy;
    const available = (w, allowed) =>
      this.allowCopyEnabled && !!lazy.WhimsyMedia.siteFor(w.gBrowser.selectedBrowser) && this.copyAllowed(w.gBrowser.selectedBrowser) == allowed;
    WhimsyShortcuts.addActions([
      {
        l10nId: "whimsy-action-allow-copy",
        command: w => this.toggleAllowCopy(w),
        icon: "chrome://browser/skin/zen-icons/edit-copy.svg",
        isAvailable: w => available(w, false),
      },
      {
        l10nId: "whimsy-action-disallow-copy",
        command: w => this.toggleAllowCopy(w),
        icon: "chrome://browser/skin/zen-icons/edit-copy.svg",
        isAvailable: w => available(w, true),
      },
    ]);
    win.gBrowser.addTabsProgressListener({
      onLocationChange: (browser, webProgress, request, location, flags) => {
        if (
          webProgress.isTopLevel &&
          !(flags & Ci.nsIWebProgressListener.LOCATION_CHANGE_SAME_DOCUMENT) &&
          this.allowCopyEnabled &&
          this.copyAllowed(browser)
        ) {
          lazy.WhimsyMedia.sendToFrames(browser, "Whimsy:AllowCopy", { on: true });
        }
      },
    });
  },

  // Returns whether copying is now allowed on the current tab's site.
  toggleAllowCopy(win, browser = win.gBrowser.selectedBrowser) {
    const site = lazy.WhimsyMedia.siteFor(browser);
    if (!this.allowCopyEnabled || !site) {
      return false;
    }
    const allow = !this.copyAllowed(browser);
    if (allow) {
      const expire = site.principal.privateBrowsingId ? Services.perms.EXPIRE_SESSION : Services.perms.EXPIRE_NEVER;
      Services.perms.addFromPrincipal(site.principal, COPY_PERMISSION, Services.perms.ALLOW_ACTION, expire);
    } else {
      Services.perms.removeFromPrincipal(site.principal, COPY_PERMISSION);
    }
    for (const other of Services.wm.getEnumerator("navigator:browser")) {
      for (const b of other.gBrowser?.browsers ?? []) {
        if (lazy.WhimsyMedia.siteFor(b)?.principal.equals(site.principal)) {
          lazy.WhimsyMedia.sendToFrames(b, "Whimsy:AllowCopy", { on: allow });
        }
      }
    }
    win.gZenUIManager?.showToast?.(allow ? "whimsy-allow-copy-toast" : "whimsy-disallow-copy-toast", {
      l10nArgs: { site: site.host },
    });
    return allow;
  },

  // --- Internet Archive ---

  get archiveEnabled() {
    return Services.prefs.getBoolPref(ARCHIVE_FEATURE_PREF, true);
  },

  // A public web address the Archive could have, or null.
  archivableURL(uri) {
    if (!uri || !["http", "https"].includes(uri.scheme)) {
      return null;
    }
    const host = uri.host;
    if (
      !host ||
      host == "localhost" ||
      /\.(local|localhost|internal|lan|home\.arpa)$/.test(host) ||
      /^(\d+\.){3}\d+$/.test(host) ||
      host.includes(":")
    ) {
      return null;
    }
    if (host.startsWith("web.archive.org") || host == "archive.org") {
      return null;
    }
    return uri.spec;
  },

  // Remembers each top-level page's HTTP status on its <browser>.
  observeHttpStatus() {
    if (this._httpObserver) {
      return;
    }
    this._httpObserver = subject => {
      try {
        const channel = subject.QueryInterface(Ci.nsIHttpChannel);
        if (!channel.isMainDocumentChannel) {
          return;
        }
        const context = channel.loadInfo?.browsingContext;
        const browser = context && !context.parent ? context.embedderElement : null;
        if (browser) {
          browser.whimsyHttpStatus = { spec: channel.URI.spec, status: channel.responseStatus };
        }
      } catch (e) {
        // Not an HTTP channel with a response.
      }
    };
    Services.obs.addObserver(this._httpObserver, "http-on-examine-response");
    Services.obs.addObserver(this._httpObserver, "http-on-examine-cached-response");
  },

  initArchive(win) {
    const { WhimsyShortcuts } = lazy;
    WhimsyShortcuts.addActions([
      {
        l10nId: "whimsy-action-open-archive",
        command: w => this.openInArchive(w),
        icon: "chrome://browser/skin/zen-icons/history.svg",
        isAvailable: w =>
          this.archiveEnabled && !!this.archivableURL(this.originalURI(w.gBrowser.selectedBrowser)),
      },
    ]);
    if (lazy.PrivateBrowsingUtils.isWindowPrivate(win)) {
      return;
    }
    this.observeHttpStatus();
    win.gBrowser.addTabsProgressListener({
      onStateChange: (browser, webProgress, request, flags) => {
        const done = Ci.nsIWebProgressListener.STATE_STOP | Ci.nsIWebProgressListener.STATE_IS_WINDOW;
        if ((flags & done) != done || !webProgress.isTopLevel) {
          return;
        }
        // In the parent the request is a stand-in; the status comes from
        // the HTTP observer below.
        const status = browser.whimsyHttpStatus?.spec == browser.currentURI?.spec ? browser.whimsyHttpStatus.status : 0;
        if (ARCHIVE_STATUSES.has(status)) {
          this.offerArchive(win, browser, browser.currentURI);
        }
      },
      onLocationChange: (browser, webProgress, request, location, flags) => {
        if (!webProgress.isTopLevel) {
          return;
        }
        if (!(flags & Ci.nsIWebProgressListener.LOCATION_CHANGE_SAME_DOCUMENT)) {
          win.gBrowser.getNotificationBox(browser)?.getNotificationWithValue(ARCHIVE_BAR)?.close();
        }
        if (flags & Ci.nsIWebProgressListener.LOCATION_CHANGE_ERROR_PAGE) {
          const error = /[?&]e=([^&]+)/.exec(browser.documentURI?.spec ?? "")?.[1];
          if (ARCHIVE_ERRORS.has(error)) {
            this.offerArchive(win, browser, location);
          }
        }
      },
    });
  },

  // The address the page was meant to be (error pages keep it as the
  // current URI).
  originalURI(browser) {
    return browser?.currentURI ?? null;
  },

  async offerArchive(win, browser, uri) {
    const url = this.archivableURL(uri);
    if (!url || !this.archiveEnabled || !Services.prefs.getBoolPref(ARCHIVE_PROMPT_PREF, true)) {
      return null;
    }
    const snapshot = await this.findSnapshot(url);
    // Still on that page?
    if (!snapshot || browser.currentURI?.spec != url) {
      return null;
    }
    const box = win.gBrowser.getNotificationBox(browser);
    if (box.getNotificationWithValue(ARCHIVE_BAR)) {
      return null;
    }
    const date = snapshot.date
      ? new Intl.DateTimeFormat(undefined, { month: "short", year: "numeric" }).format(snapshot.date)
      : "";
    return box.appendNotification(
      ARCHIVE_BAR,
      {
        label: { "l10n-id": date ? "whimsy-archive-bar-dated" : "whimsy-archive-bar", "l10n-args": { date } },
        priority: box.PRIORITY_INFO_MEDIUM,
      },
      [
        {
          "l10n-id": "whimsy-archive-open",
          callback: () => {
            this.loadArchived(browser, snapshot.url);
          },
        },
      ]
    );
  },

  // The Wayback Machine's nearest copy of a page: { url, date }, or null.
  async findSnapshot(url) {
    const configured = Services.prefs.getStringPref(ARCHIVE_API_PREF, "");
    // Tests load plenty of missing pages; they never reach archive.org.
    if (!configured && Cu.isInAutomation) {
      return null;
    }
    const api = configured || ARCHIVE_API;
    try {
      const response = await fetch(api + encodeURIComponent(url), { credentials: "omit", cache: "no-store" });
      if (!response.ok) {
        return null;
      }
      const closest = (await response.json())?.archived_snapshots?.closest;
      if (!closest?.available || !closest.url) {
        return null;
      }
      const ts = /^(\d{4})(\d{2})(\d{2})/.exec(closest.timestamp ?? "");
      return {
        url: closest.url.replace(/^http:/, "https:"),
        date: ts ? new Date(Date.UTC(+ts[1], +ts[2] - 1, +ts[3])) : null,
      };
    } catch (e) {
      return null;
    }
  },

  loadArchived(browser, url) {
    browser.fixupAndLoadURIString(url, {
      triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
    });
  },

  // The command bar's "Open in Internet Archive": the latest copy of the
  // current page (the Wayback Machine redirects to it).
  openInArchive(win) {
    const browser = win.gBrowser.selectedBrowser;
    const url = this.archivableURL(this.originalURI(browser));
    if (!url || !this.archiveEnabled) {
      return null;
    }
    const target = ARCHIVE_WEB + url;
    this.loadArchived(browser, target);
    return target;
  },

  // --- Translate selection ---

  get translateSelectionEnabled() {
    return (
      Services.prefs.getBoolPref(TRANSLATE_FEATURE_PREF, true) &&
      Services.prefs.getBoolPref("browser.translations.select.enable", false) &&
      Services.prefs.getBoolPref("browser.translations.enable", true)
    );
  },

  initTranslateSelection(win) {
    const { WhimsyShortcuts } = lazy;
    WhimsyShortcuts.addCommand(win, {
      id: "cmd_whimsyTranslateSelection",
      run: w => this.translateSelection(w),
      key: { id: "key_whimsyTranslateSelection", key: "T", modifiers: "accel,alt,shift" },
    });
    WhimsyShortcuts.addActions([
      {
        l10nId: "whimsy-action-translate-selection",
        command: "cmd_whimsyTranslateSelection",
        icon: "chrome://browser/skin/zen-icons/translations.svg",
        isAvailable: w => this.translateSelectionEnabled && isWebPage(w),
      },
    ]);
  },

  // The selected text in the tab (any frame) and where it is on screen.
  async findSelection(browser) {
    const contexts = browser?.browsingContext?.getAllBrowsingContextsInSubtree() ?? [];
    for (const context of contexts) {
      try {
        const found = await context.currentWindowGlobal?.getActor("WhimsyPage").sendQuery("Whimsy:Selection");
        if (found?.text) {
          return found;
        }
      } catch (e) {
        // A frame that went away.
      }
    }
    return null;
  },

  // Opens Firefox's selection translation panel under the selection.
  // Returns the text it translates, or null (with a toast) when nothing is
  // selected.
  async translateSelection(win) {
    if (!this.translateSelectionEnabled || !isWebPage(win) || !win.SelectTranslationsPanel) {
      return null;
    }
    const found = await this.findSelection(win.gBrowser.selectedBrowser);
    if (!found) {
      win.gZenUIManager?.showToast?.("whimsy-translate-none-toast");
      return null;
    }
    const panel = win.SelectTranslationsPanel;
    panel
      .open(null, found.x, found.y, found.text, true, panel.getLangPairPromise(found.text))
      .catch(console.error);
    return found.text;
  },

  // --- Reader typography ---

  initReaderFonts() {
    if (!Services.prefs.getBoolPref(READER_FEATURE_PREF, true) || AppConstants.platform != "macosx") {
      return;
    }
    Services.prefs.getDefaultBranch("").setStringPref(READER_FONTS_PREF, JSON.stringify(READER_FONTS));
  },
};
