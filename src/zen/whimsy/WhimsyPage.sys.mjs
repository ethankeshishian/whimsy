/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Page tools: things you do to the page you're on.
//
// Capture (Arc's Capture, Edge's Web Capture): Firefox Screenshots is the
// capture tool (drag a region, click an element, or Visible / Full Page,
// then Copy or Download). Whimsy adds Arc's Cmd+Shift+2 for it, and a
// one-step "Copy Full-Page Screenshot" (Cmd+Shift+1 and the command
// bar) that drops the whole page on the clipboard with no editor between.

import { AppConstants } from "resource://gre/modules/AppConstants.sys.mjs";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  BrowserUtils: "resource://gre/modules/BrowserUtils.sys.mjs",
  LanguageDetector: "resource://gre/modules/translations/LanguageDetector.sys.mjs",
  TranslationsParent: "resource://gre/actors/TranslationsParent.sys.mjs",
  ReaderMode: "moz-src:///toolkit/components/reader/ReaderMode.sys.mjs",
  PrivateBrowsingUtils: "resource://gre/modules/PrivateBrowsingUtils.sys.mjs",
  ScreenshotsUtils: "moz-src:///browser/components/screenshots/ScreenshotsUtils.sys.mjs",
  WhimsyMedia: "resource:///modules/whimsy/WhimsyMedia.sys.mjs",
  WhimsyCommands: "resource:///modules/whimsy/WhimsyCommands.sys.mjs",
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
// with its date. "Open in Wayback Machine" in the command bar works on any
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
// Reading time (Medium's "6 min read"): when the address bar shows the
// Reader View button (the page is an article), a small "6 min" sits next
// to it, so you know up front whether to read now or later. It uses Reader
// View's own reading speeds, so it agrees with Reader View's estimate.
// whimsy.reader.reading-time (Settings → Look and Feel).
const TIME_FEATURE_PREF = "whimsy.feature.reading-time";
const TIME_PREF = "whimsy.reader.reading-time";
const TIME_ID = "whimsy-reading-time";

// Dark PDFs (Edge's and Skim's dark pages; Zen D#3982): Settings → Look
// and Feel → "Dark pages in PDFs" sets pdf.js's own page colours (light
// text on a dark page; images keep their colours) and its dark theme, and
// reloads open PDFs, which read the prefs when they load. Off by default;
// turning it off puts pdf.js's defaults back.
const PDF_FEATURE_PREF = "whimsy.feature.dark-pdf";
const PDF_PREF = "whimsy.pdf.dark";
export const DARK_PDF_PREFS = {
  "pdfjs.forcePageColors": true,
  "pdfjs.pageColorsBackground": "#1c1b22",
  "pdfjs.pageColorsForeground": "#e8e6e3",
  "pdfjs.viewerCssTheme": 2,
};

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
    this.initDarkPdf();
  },

  initWindow(win) {
    this.init();
    this.initCapture(win);
    this.initEditPage(win);
    this.initAllowCopy(win);
    this.initArchive(win);
    this.initTranslateSelection(win);
    this.initReadingTime(win);
  },

  actorFor(browser) {
    return browser?.browsingContext?.currentWindowGlobal?.getActor("WhimsyPage") ?? null;
  },

  // --- Capture ---

  initCapture(win) {
    if (!this.captureEnabled) {
      return;
    }
    const { WhimsyCommands } = lazy;
    // Arc's capture shortcut, beside Firefox's Cmd+Shift+S. By keycode:
    // with Shift held, Gecko only tries the shifted character ("@" on a US
    // layout) against key="2", so a key="2" binding never fired. Zen's
    // command bar already offers this command ("Capture Screenshot").
    WhimsyCommands.register(win, {
      id: "Browser:Screenshot",
      l10nId: "whimsy-action-capture",
      keyId: "key_whimsyScreenshotArc",
      key: { keycode: "VK_2", modifiers: "accel,shift" },
      commandBar: false,
    });
    WhimsyCommands.register(win, {
      id: "cmd_whimsyCopyFullPage",
      l10nId: "whimsy-action-copy-full-page",
      run: w => this.copyFullPageScreenshot(w),
      // Cmd+Shift+1, beside Cmd+Shift+2 (Screenshots); by keycode for the
      // same reason as that one.
      keyId: "key_whimsyCopyFullPage",
      key: { keycode: "VK_1", modifiers: "accel,shift" },
      icon: "chrome://browser/skin/zen-icons/screenshot.svg",
      isAvailable: w => this.captureEnabled && isWebPage(w),
    });
    // wave6/parity: Arc's File → Capture in Portrait Mode: the visible page
    // cropped to a centred 9:16 frame (a phone-shaped shot), copied.
    WhimsyCommands.register(win, {
      id: "cmd_whimsyCapturePortrait",
      l10nId: "whimsy-action-capture-portrait",
      run: w => this.copyPortraitScreenshot(w),
      icon: "chrome://browser/skin/zen-icons/screenshot.svg",
      isAvailable: w => this.captureEnabled && isWebPage(w),
    });
    // A <key> only matches keypress, whose keyCode is 0 for a printable key
    // and whose character is the shifted one ("!", "@" on a US layout), so
    // neither key="2" nor keycode="VK_2" ever fired with Shift held. The
    // <key>s stay (about:keyboard, the cheat sheet); this keydown listener,
    // like Firefox's Ctrl+Tab, runs them by physical key (Digit1/Digit2),
    // as long as the <key> still has its default binding and isn't disabled.
    win.addEventListener("keydown", event => this.onCaptureKeyDown(win, event), true);
  },

  onCaptureKeyDown(win, event) {
    if (event.defaultPrevented || event.repeat || !this.captureEnabled) {
      return;
    }
    const mac = AppConstants.platform == "macosx";
    const accel = mac ? event.metaKey : event.ctrlKey;
    const other = mac ? event.ctrlKey : event.metaKey;
    if (!accel || other || !event.shiftKey || event.altKey) {
      return;
    }
    const keyId = { Digit1: "key_whimsyCopyFullPage", Digit2: "key_whimsyScreenshotArc" }[event.code];
    const keyEl = keyId && win.document.getElementById(keyId);
    if (
      !keyEl ||
      keyEl.getAttribute("disabled") == "true" ||
      keyEl.getAttribute("keycode") != (event.code == "Digit1" ? "VK_1" : "VK_2") ||
      keyEl.getAttribute("modifiers") != "accel,shift"
    ) {
      return;
    }
    const command = win.document.getElementById(keyEl.getAttribute("command"));
    if (!command || command.getAttribute("disabled") == "true") {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    command.doCommand();
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

  // The largest 9:16 rect inside the visible area: centred across, from the
  // top down (a phone shows the top of what's scrolled to).
  portraitRect(rect) {
    const ratio = 9 / 16;
    let { left, top, width, height } = rect;
    if (width / height > ratio) {
      const w = Math.round(height * ratio);
      left += Math.round((width - w) / 2);
      width = w;
    } else {
      height = Math.round(width / ratio);
    }
    return { ...rect, left, top, width, height, right: left + width, bottom: top + height };
  },

  // wave7/small: Arc's Capture in Portrait Mode shoots the page as a phone
  // shows it, so the page is laid out at a phone's width (390 CSS px, an
  // iPhone) for the moment of the shot: the browser is narrowed, the page
  // reflows, the top of the viewport is drawn in a 9:16 frame, and the
  // browser goes back. A page that doesn't reflow is cropped to 9:16 instead.
  PORTRAIT_WIDTH: 390,

  async copyPortraitScreenshot(win, browser = win.gBrowser.selectedBrowser) {
    if (!this.captureEnabled || !isWebPage(win)) {
      return null;
    }
    const { ScreenshotsUtils, BrowserUtils } = lazy;
    const { style } = browser;
    const saved = { maxWidth: style.maxWidth, marginInline: style.marginInline };
    let rect, canvas;
    try {
      style.maxWidth = `${this.PORTRAIT_WIDTH}px`;
      style.marginInline = "auto";
      const actor = browser.browsingContext.currentWindowGlobal.getActor("WhimsyPage");
      rect = this.portraitRect(await actor.sendQuery("Whimsy:PortraitBounds", { width: this.PORTRAIT_WIDTH }));
      canvas = await ScreenshotsUtils.createCanvas(rect, browser);
    } catch (e) {
      console.error("Whimsy: portrait capture", e);
      win.gZenUIManager?.showToast?.("whimsy-capture-failed-toast");
      return null;
    } finally {
      style.maxWidth = saved.maxWidth;
      style.marginInline = saved.marginInline;
    }
    const blob = await canvas.convertToBlob();
    BrowserUtils.copyImageToClipboard(await blob.arrayBuffer());
    win.gZenUIManager?.showToast?.("whimsy-capture-copied-toast");
    const ratio = rect.devicePixelRatio || 1;
    return { width: canvas.width / ratio, height: canvas.height / ratio, layoutWidth: rect.layoutWidth };
  },

  // --- Edit text on page ---

  get editPageEnabled() {
    return Services.prefs.getBoolPref(EDIT_FEATURE_PREF, true);
  },

  initEditPage(win) {
    const { document, gBrowser } = win;
    lazy.WhimsyCommands.register(win, {
      id: "cmd_whimsyEditPage",
      l10nId: "whimsy-action-edit-page",
      run: w => this.toggleEditing(w),
      icon: "chrome://browser/skin/zen-icons/edit-theme.svg",
      isAvailable: w => this.editPageEnabled && isWebPage(w),
    });
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
    const available = (w, allowed) =>
      this.allowCopyEnabled && !!lazy.WhimsyMedia.siteFor(w.gBrowser.selectedBrowser) && this.copyAllowed(w.gBrowser.selectedBrowser) == allowed;
    lazy.WhimsyCommands.register(win, {
      id: "cmd_whimsyAllowCopy",
      l10nId: "whimsy-action-allow-copy-toggle",
      run: w => this.allowCopyEnabled && this.toggleAllowCopy(w),
      icon: "chrome://browser/skin/zen-icons/edit-copy.svg",
      variants: [
        { l10nId: "whimsy-action-allow-copy", isAvailable: w => available(w, false) },
        { l10nId: "whimsy-action-disallow-copy", isAvailable: w => available(w, true) },
      ],
    });
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
    lazy.WhimsyCommands.register(win, {
      id: "cmd_whimsyOpenInWayback",
      l10nId: "whimsy-action-open-archive",
      run: w => this.openInArchive(w),
      icon: "chrome://browser/skin/zen-icons/history.svg",
      isAvailable: w =>
        this.archiveEnabled && !!this.archivableURL(this.originalURI(w.gBrowser.selectedBrowser)),
    });
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

  // The command bar's "Open in Wayback Machine": the latest copy of the
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
    lazy.WhimsyCommands.register(win, {
      id: "cmd_whimsyTranslateSelection",
      l10nId: "whimsy-action-translate-selection",
      run: w => this.translateSelection(w),
      keyId: "key_whimsyTranslateSelection",
      key: { key: "T", modifiers: "accel,alt,shift" },
      icon: "chrome://browser/skin/zen-icons/translations.svg",
      isAvailable: w => this.translateSelectionEnabled && isWebPage(w),
    });
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
    panel.open(null, found.x, found.y, found.text, true, this.langPair(win, found.text)).catch(console.error);
    return found.text;
  },

  // The panel's languages: from = the language of the selected text itself
  // (Firefox's on-device language identification, not the page's lang),
  // to = the user's own language. Firefox's own pair is kept where it agrees:
  // it maps a detected language onto the exact tag its models use; but when
  // it can't (no model list yet) it falls back to the page's language and
  // English, which gave "English -> English" for foreign text.
  async langPair(win, text) {
    let pair = {};
    try {
      pair = (await win.SelectTranslationsPanel?.getLangPairPromise(text)) ?? {};
    } catch (e) {
      console.error("Whimsy: translate selection languages", e);
    }
    const base = tag => (tag || "").split("-")[0].toLowerCase();
    let detected = null;
    try {
      const { language, languages } = await lazy.LanguageDetector.detectLanguage(text);
      detected = languages?.[0]?.languageCode || language || null;
    } catch (e) {
      console.error("Whimsy: language detection", e);
    }
    if (detected == "un" || detected == "und") {
      detected = null;
    }
    let sourceLanguage = pair.sourceLanguage;
    if (detected && base(sourceLanguage) != base(detected)) {
      sourceLanguage = detected;
    }
    let userLanguages = [];
    try {
      userLanguages = lazy.TranslationsParent.getPreferredLanguages({ excludeLangTags: sourceLanguage ? [sourceLanguage] : [] });
    } catch (e) {
      userLanguages = [Services.locale.appLocaleAsBCP47];
    }
    let targetLanguage = pair.targetLanguage;
    const userLanguage = userLanguages.find(tag => base(tag) != base(sourceLanguage));
    if (!targetLanguage || base(targetLanguage) == base(sourceLanguage) || (userLanguage && base(targetLanguage) != base(userLanguage))) {
      targetLanguage = userLanguage ? base(userLanguage) : targetLanguage;
    }
    return { sourceLanguage, targetLanguage };
  },

  // --- Reader typography ---

  initReaderFonts() {
    if (!Services.prefs.getBoolPref(READER_FEATURE_PREF, true) || AppConstants.platform != "macosx") {
      return;
    }
    Services.prefs.getDefaultBranch("").setStringPref(READER_FONTS_PREF, JSON.stringify(READER_FONTS));
  },

  // --- Reading time ---

  get readingTimeEnabled() {
    return Services.prefs.getBoolPref(TIME_FEATURE_PREF, true) && Services.prefs.getBoolPref(TIME_PREF, true);
  },

  // Minutes to read `length` characters in `lang`, at Reader View's average
  // speed for the language.
  readingMinutes(length, lang) {
    const { cpm } = lazy.ReaderMode._getReadingSpeedForLanguage((lang || "en").split("-")[0]);
    return Math.max(1, Math.round(length / cpm));
  },

  initReadingTime(win) {
    const { document } = win;
    const button = document.getElementById("reader-mode-button");
    if (!button) {
      return;
    }
    const update = () => this.updateReadingTime(win).catch(e => console.error("Whimsy: reading time", e));
    new win.MutationObserver(update).observe(button, { attributes: true, attributeFilter: ["hidden", "readeractive"] });
    win.gBrowser.tabContainer.addEventListener("TabSelect", update);
    const observer = () => update();
    Services.prefs.addObserver(TIME_PREF, observer);
    win.addEventListener("unload", () => Services.prefs.removeObserver(TIME_PREF, observer), { once: true });
  },

  async updateReadingTime(win) {
    const { document } = win;
    const button = document.getElementById("reader-mode-button");
    const browser = win.gBrowser.selectedBrowser;
    let label = document.getElementById(TIME_ID);
    const show = this.readingTimeEnabled && button && !button.hidden && !button.hasAttribute("readeractive") && browser.isArticle;
    if (!show) {
      if (label) {
        label.hidden = true;
      }
      return null;
    }
    const spec = browser.currentURI?.spec;
    if (browser.whimsyReadingTime?.spec != spec) {
      let text = null;
      try {
        text = await this.actorFor(browser)?.sendQuery("Whimsy:ReadingLength");
      } catch (e) {
        // The page went away.
      }
      if (!text?.length || browser.currentURI?.spec != spec) {
        return null;
      }
      browser.whimsyReadingTime = { spec, minutes: this.readingMinutes(text.length, text.lang) };
    }
    if (win.gBrowser.selectedBrowser != browser) {
      return null;
    }
    if (!label) {
      label = document.createXULElement("label");
      label.id = TIME_ID;
      label.className = "urlbar-page-action";
      button.before(label);
    }
    const { minutes } = browser.whimsyReadingTime;
    document.l10n.setAttributes(label, "whimsy-reading-time", { minutes });
    label.hidden = false;
    return minutes;
  },

  // --- Dark PDFs ---

  get darkPdf() {
    return Services.prefs.getBoolPref(PDF_FEATURE_PREF, true) && Services.prefs.getBoolPref(PDF_PREF, false);
  },

  initDarkPdf() {
    const observer = () => {
      try {
        this.applyDarkPdf({ reload: true });
      } catch (e) {
        console.error("Whimsy: dark PDFs", e);
      }
    };
    Services.prefs.addObserver(PDF_PREF, observer);
    Services.prefs.addObserver(PDF_FEATURE_PREF, observer);
    // Only touches pdf.js's prefs when the setting changed since last time.
    if (this.darkPdf != Services.prefs.getBoolPref("pdfjs.forcePageColors", false)) {
      this.applyDarkPdf({ reload: false });
    }
  },

  applyDarkPdf({ reload }) {
    const dark = this.darkPdf;
    for (const [name, value] of Object.entries(DARK_PDF_PREFS)) {
      if (!dark) {
        Services.prefs.clearUserPref(name);
      } else if (typeof value == "boolean") {
        Services.prefs.setBoolPref(name, value);
      } else if (typeof value == "number") {
        Services.prefs.setIntPref(name, value);
      } else {
        Services.prefs.setStringPref(name, value);
      }
    }
    if (!reload) {
      return;
    }
    for (const win of Services.wm.getEnumerator("navigator:browser")) {
      for (const browser of win.gBrowser?.browsers ?? []) {
        if (browser.documentContentType == "application/pdf") {
          browser.reload();
        }
      }
    }
  },
};
