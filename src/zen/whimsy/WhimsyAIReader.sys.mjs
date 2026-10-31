/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// AI v1: page text for the AI features, through Firefox's own PageExtractor
// actor (the one Firefox's AI features use; it isn't behind any AI pref).
//   - readTab: the text of a page that's open (Ask on Page).
//   - readUrl: loads a page in a hidden browser and reads it once its
//     scripts have run (5-second previews, Watch a page). Unlike
//     PageExtractor's own headless reader, it runs in the space's container
//     with the person's cookies (the user asked for "the logged-in
//     session"), and keeps the visit out of history and the media session.

import { clearTimeout, setTimeout } from "resource://gre/modules/Timer.sys.mjs";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  HiddenFrame: "resource://gre/modules/HiddenFrame.sys.mjs",
});

const LOAD_TIMEOUT_MS = 25 * 1000;
const BROWSER_SIZE = { width: 1280, height: 900 };

export const WhimsyAIReader = {
  // Tests only: (url, options) => text, in place of loading the page.
  _testReader: null,

  setTestReader(fn) {
    if (fn && !Cu.isInAutomation) {
      throw new Error("The test reader is for automated tests only");
    }
    this._testReader = fn || null;
  },

  isReadableUrl(url) {
    return /^https?:\/\//i.test(String(url ?? ""));
  },

  /**
   * The text of the page open in `browser`.
   *
   * @returns {Promise<string>}
   */
  async readTab(browser, { sufficientLength = 60000, removeBoilerplate = false } = {}) {
    const actor = browser?.browsingContext?.currentWindowGlobal?.getActor("PageExtractor");
    if (!actor) {
      return "";
    }
    const result = await actor.getText({ sufficientLength, removeBoilerplate, useSimpleText: true });
    return result?.text ?? "";
  },

  /**
   * Loads `url` out of sight with the person's session and reads it.
   *
   * @param {string} url
   * @param {object} [options]
   * @param {number} [options.userContextId] The container (space) to load it in.
   * @param {AbortSignal} [options.signal]
   * @param {number} [options.sufficientLength]
   * @param {boolean} [options.removeBoilerplate] Reader-mode text (previews);
   *   off keeps everything on the page (watches look for prices, stock...).
   * @returns {Promise<{ text: string, title: string, url: string }>}
   */
  async readUrl(url, { userContextId = 0, signal, sufficientLength = 30000, removeBoilerplate = false } = {}) {
    if (!this.isReadableUrl(url)) {
      throw new Error("Only http(s) pages can be read");
    }
    if (this._testReader) {
      const text = await this._testReader(url, { userContextId, removeBoilerplate });
      return { text: String(text ?? ""), title: "", url };
    }
    return this.withHiddenPage(url, { userContextId, signal }, async browser => {
      const actor = browser.browsingContext.currentWindowGlobal.getActor("PageExtractor");
      // Lets client-rendered pages (most logged-in apps) fill in.
      await actor.waitForPageReady(undefined, 1500);
      const result = await actor.getText({ sufficientLength, removeBoilerplate, useSimpleText: true });
      return {
        text: result?.text ?? "",
        title: browser.contentTitle || "",
        url: browser.currentURI?.spec || url,
      };
    });
  },

  /**
   * Loads `url` in a hidden, sandboxed browser (no forms, popups, downloads,
   * top-level navigation or history; muted) and calls `fn(browser)` once it
   * has loaded. The browser is destroyed when `fn` settles. Shared by the AI
   * reader and the Search Deck (wave6/search), so both keep one sandbox.
   *
   * @param {string} url
   * @param {object} options
   * @param {number} [options.userContextId]
   * @param {AbortSignal} [options.signal]
   * @param {string} [options.messageManagerGroup] Which actors the page gets.
   * @param {(browser: Element) => Promise<any>} fn
   */
  async withHiddenPage(url, { userContextId = 0, signal, messageManagerGroup = "headless-browsers" } = {}, fn) {
    if (!this.isReadableUrl(url)) {
      throw new Error("Only http(s) pages can be read");
    }
    const uri = Services.io.newURI(url);
    const frame = new lazy.HiddenFrame();
    let timer;
    let listener;
    let browser;
    const onAbort = () => frame.destroy();
    try {
      const win = await frame.get();
      const doc = win.document;
      browser = doc.createXULElement("browser");
      browser.setAttribute("remote", "true");
      browser.setAttribute("type", "content");
      browser.setAttribute("maychangeremoteness", "true");
      browser.setAttribute("nodefaultsrc", "true");
      browser.setAttribute("disableglobalhistory", "true");
      // PageExtractor's actor is registered for this group as well.
      browser.setAttribute("messagemanagergroup", messageManagerGroup);
      if (userContextId) {
        browser.setAttribute("usercontextid", String(userContextId));
      }
      browser.style.width = browser.style.minWidth = `${BROWSER_SIZE.width}px`;
      browser.style.height = browser.style.minHeight = `${BROWSER_SIZE.height}px`;
      doc.documentElement.appendChild(browser);
      // Match PageExtractor's capability restrictions, while retaining the
      // container's authenticated session and scripts needed for rendering.
      browser.browsingContext.sandboxFlags |=
        0x2 | 0x4 | 0x20 | 0x40 | 0x100 | 0x800 | 0x2000 | 0x4000 | 0x8000 | 0x10000;
      browser.browsingContext?.mediaController?.mute();
      browser.addEventListener("DidChangeBrowserRemoteness", () =>
        browser.browsingContext?.mediaController?.mute()
      );
      signal?.addEventListener("abort", onAbort, { once: true });

      const loaded = new Promise((resolve, reject) => {
        listener = {
          QueryInterface: ChromeUtils.generateQI(["nsIWebProgressListener", "nsISupportsWeakReference"]),
          onStateChange(webProgress, _request, flags, status) {
            const { STATE_STOP, STATE_IS_WINDOW } = Ci.nsIWebProgressListener;
            if (webProgress.isTopLevel && flags & STATE_STOP && flags & STATE_IS_WINDOW) {
              if (Components.isSuccessCode(status)) {
                resolve();
              } else {
                reject(new Error(`The page didn't load (${status})`));
              }
            }
          },
        };
        browser.addProgressListener(listener, Ci.nsIWebProgress.NOTIFY_STATE_WINDOW);
        timer = setTimeout(() => reject(new Error("The page took too long to load")), LOAD_TIMEOUT_MS);
        signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });

      browser.loadURI(uri, {
        triggeringPrincipal: Services.scriptSecurityManager.createNullPrincipal({ userContextId }),
        loadFlags: Ci.nsIWebNavigation.LOAD_FLAGS_BYPASS_HISTORY,
      });
      await loaded;
      if (signal?.aborted) {
        throw new Error("aborted");
      }
      return await fn(browser);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      if (listener && browser) {
        try {
          browser.removeProgressListener(listener);
        } catch {}
      }
      frame.destroy();
    }
  },
};
