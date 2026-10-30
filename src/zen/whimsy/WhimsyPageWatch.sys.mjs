/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Feature 3: Watch a page.
// - User picks a page and a condition in plain words (e.g. "Price drops below $50").
// - Whimsy re-checks on an interval ONLY while Whimsy is open (no background daemons).
// - Uses the user's logged-in session (cookies & container principal).
// - Shows a recurring alert until dismissed.
// - Obey kill switch and selected provider (no fallback).

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  NetUtil: "resource://gre/modules/NetUtil.sys.mjs",
  WhimsyAI: "resource:///modules/whimsy/WhimsyAI.sys.mjs",
  WhimsyAIProviders: "resource:///modules/whimsy/WhimsyAIProviders.sys.mjs",
});

const PREF_WATCH_FEATURE = "whimsy.feature.page-watch";
const STORAGE_FILE = "whimsy-page-watches.json";
const MENU_ID = "context_whimsyWatchPage";

export const WhimsyPageWatch = {
  _watches: new Map(),
  _timer: null,
  _initialized: false,

  get enabled() {
    return Services.prefs.getBoolPref(PREF_WATCH_FEATURE, true) && !lazy.WhimsyAI.blocked;
  },

  async init() {
    if (this._initialized) {
      return;
    }
    this._initialized = true;
    await this.loadWatches();

    // Polling interval timer: runs ONLY while Whimsy is open
    this._timer = Cc["@mozilla.org/timer;1"].createInstance(Ci.nsITimer);
    this._timer.initWithCallback(() => this.tick(), 30000, Ci.nsITimer.TYPE_REPEATING_SLACK);

    Services.obs.addObserver(() => this.shutdown(), "quit-application-granted");
  },

  initWindow(win) {
    this.init();
    this.initMenu(win);
  },

  initMenu(win) {
    const { document } = win;
    const menu = document.getElementById("tabContextMenu");
    menu?.addEventListener("popupshowing", event => {
      if (event.target == menu) {
        this.updateMenu(win);
      }
    });
  },

  updateMenu(win) {
    const { document } = win;
    let item = document.getElementById(MENU_ID);
    const enabled = this.enabled;
    if (!enabled) {
      if (item) {
        item.hidden = true;
      }
      return;
    }

    if (!item) {
      item = document.createXULElement("menuitem");
      item.id = MENU_ID;
      document.l10n.setAttributes(item, "tab-context-whimsy-watch-page");
      item.addEventListener("command", () => {
        const tab = win.TabContextMenu?.contextTab || win.gBrowser.selectedTab;
        if (tab?.linkedBrowser?.currentURI?.spec) {
          this.promptWatchPage(win, tab.linkedBrowser.currentURI.spec);
        }
      });
      const anchor = document.getElementById("context_whimsyAskOnPage") || document.getElementById("context_reloadTab");
      if (anchor) {
        anchor.after(item);
      } else {
        document.getElementById("tabContextMenu")?.appendChild(item);
      }
    }
    item.hidden = false;
  },

  promptWatchPage(win, url) {
    const condition = Services.prompt?.prompt(
      win,
      "Watch Page",
      `Describe in plain words what condition to watch for on ${url}:`,
      "Price drops or item in stock",
      null,
      { value: false }
    );
    if (condition) {
      this.addWatch({ url, condition });
      win.gZenUIManager?.showToast?.("whimsy-page-watch-started", { l10nArgs: { condition } });
    }
  },

  shutdown() {
    if (this._timer) {
      this._timer.cancel();
      this._timer = null;
    }
  },

  get storagePath() {
    return PathUtils.join(PathUtils.profileDir, STORAGE_FILE);
  },

  async loadWatches() {
    try {
      if (await IOUtils.exists(this.storagePath)) {
        const raw = await IOUtils.readUTF8(this.storagePath);
        const list = JSON.parse(raw);
        this._watches.clear();
        for (const item of list) {
          this._watches.set(item.id, item);
        }
      }
    } catch (e) {
      console.debug("WhimsyPageWatch: error loading watches", e);
    }
  },

  async saveWatches() {
    try {
      const list = Array.from(this._watches.values());
      await IOUtils.writeUTF8(this.storagePath, JSON.stringify(list, null, 2));
    } catch (e) {
      console.error("WhimsyPageWatch: error saving watches", e);
    }
  },

  addWatch({ url, condition, intervalMinutes = 30, userContextId = 0 }) {
    const id = "watch-" + Date.now() + "-" + Math.random().toString(36).slice(2, 7);
    const watch = {
      id,
      url,
      condition,
      intervalMs: Math.max(1, intervalMinutes) * 60 * 1000,
      userContextId,
      created: Date.now(),
      lastChecked: 0,
      lastContentHash: "",
      lastResult: null,
      triggered: false,
      dismissed: false,
    };
    this._watches.set(id, watch);
    this.saveWatches();
    return watch;
  },

  removeWatch(id) {
    const deleted = this._watches.delete(id);
    if (deleted) {
      this.saveWatches();
      this.hideAlertInWindows(id);
    }
    return deleted;
  },

  getWatches() {
    return Array.from(this._watches.values());
  },

  dismissAlert(id) {
    const watch = this._watches.get(id);
    if (watch) {
      watch.dismissed = true;
      this.saveWatches();
      this.hideAlertInWindows(id);
    }
  },

  async tick() {
    if (!this.enabled) {
      return;
    }
    const now = Date.now();
    for (const watch of this._watches.values()) {
      if (now - watch.lastChecked >= watch.intervalMs) {
        await this.checkWatch(watch).catch(e => console.error("WhimsyPageWatch: check failed", e));
      }
    }
  },

  // Fetch page with user's logged-in session (cookies & container principal)
  async fetchLoggedInSession(url, userContextId = 0) {
    const uri = Services.io.newURI(url);
    const principal = Services.scriptSecurityManager.createContentPrincipal(uri, { userContextId });

    const channel = lazy.NetUtil.newChannel({
      uri,
      contentPolicyType: Ci.nsIContentPolicy.TYPE_SAVEAS_DOWNLOAD,
      loadingPrincipal: principal,
      securityFlags:
        Ci.nsILoadInfo.SEC_ALLOW_CROSS_ORIGIN_SEC_CONTEXT_IS_NULL | Ci.nsILoadInfo.SEC_COOKIES_INCLUDE,
      triggeringPrincipal: principal,
    }).QueryInterface(Ci.nsIHttpChannel);

    channel.loadFlags = Ci.nsIRequest.LOAD_NORMAL;

    const { promise, resolve, reject } = Promise.withResolvers();
    const byteChunks = [];
    let totalLength = 0;

    channel.asyncOpen({
      onDataAvailable: (_req, stream, _offset, count) => {
        totalLength += count;
        byteChunks.push(lazy.NetUtil.readInputStream(stream, count));
      },
      onStartRequest: () => {},
      onStopRequest: (_req, status) => {
        if (!Components.isSuccessCode(status)) {
          reject(Components.Exception("Watch fetch failed", status));
          return;
        }
        const bytes = new Uint8Array(totalLength);
        let offset = 0;
        for (const chunk of byteChunks) {
          bytes.set(new Uint8Array(chunk), offset);
          offset += chunk.byteLength;
        }
        resolve(new TextDecoder("utf-8").decode(bytes));
      },
    });

    return promise;
  },

  simpleHash(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      hash = (hash << 5) - hash + str.charCodeAt(i);
      hash |= 0;
    }
    return String(hash);
  },

  async checkWatch(watch, { force = false } = {}) {
    if (!this.enabled) {
      return null;
    }

    watch.lastChecked = Date.now();
    let rawHtml = "";
    try {
      rawHtml = await this.fetchLoggedInSession(watch.url, watch.userContextId);
    } catch (e) {
      console.warn("WhimsyPageWatch: unable to fetch", watch.url, e);
      return null;
    }

    const text = rawHtml
      .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, "")
      .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, "")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim();

    const hash = this.simpleHash(text);
    // Deduplication: if content unchanged and not forced, reuse last result
    if (!force && watch.lastContentHash === hash && watch.lastResult) {
      // Recurring alert until dismissed: re-show alert if still met and not dismissed
      if (watch.lastResult.met && !watch.dismissed) {
        this.showAlert(watch, watch.lastResult);
      }
      return watch.lastResult;
    }

    watch.lastContentHash = hash;

    const prompt = `You are monitoring a web page for a specific condition described in plain words.
Condition: "${watch.condition}"
Page URL: "${watch.url}"
Page Text:
${text.slice(0, 10000)}

Determine if the condition is currently met. Respond with a JSON object ONLY with two keys:
- "met": true or false
- "reason": "brief plain text explanation"
Example: {"met": true, "reason": "Price is now $45 which is below $50"}`;

    try {
      const { text: aiResponse } = await lazy.WhimsyAIProviders.complete({
        system: "Evaluate whether the page condition is met. Output JSON only.",
        prompt,
      });

      const match = aiResponse.match(/\{[\s\S]*\}/);
      if (!match) {
        throw new Error("Invalid AI watch response");
      }

      const result = JSON.parse(match[0]);
      watch.lastResult = result;

      if (result.met) {
        watch.triggered = true;
        // Recurring alert until dismissed
        if (!watch.dismissed) {
          this.showAlert(watch, result);
        }
      } else {
        watch.triggered = false;
        watch.dismissed = false;
      }

      await this.saveWatches();
      return result;
    } catch (e) {
      console.error("WhimsyPageWatch: evaluation failed", e);
      return null;
    }
  },

  showAlert(watch, result) {
    const win = Services.wm.getMostRecentWindow("navigator:browser");
    if (!win) {
      return;
    }

    let alertBar = win.document.getElementById(`whimsy-watch-alert-${watch.id}`);
    if (!alertBar) {
      alertBar = win.document.createXULElement("notification");
      alertBar.id = `whimsy-watch-alert-${watch.id}`;
      alertBar.setAttribute("type", "warning");
      alertBar.setAttribute("label", `Page Watch: "${watch.condition}" met on ${watch.url}! ${result.reason || ""}`);

      const openBtn = win.document.createXULElement("button");
      openBtn.setAttribute("label", "Open Page");
      openBtn.addEventListener("command", () => {
        win.openTrustedLinkIn(watch.url, "tab");
      });

      const dismissBtn = win.document.createXULElement("button");
      dismissBtn.setAttribute("label", "Dismiss");
      dismissBtn.addEventListener("command", () => {
        this.dismissAlert(watch.id);
      });

      alertBar.appendChild(openBtn);
      alertBar.appendChild(dismissBtn);

      const box = win.document.getElementById("high-priority-global-notificationbox") ||
                  win.document.getElementById("global-notificationbox") ||
                  win.gNotificationBox?.stack;
      if (box) {
        box.prepend(alertBar);
      }
    }
  },

  hideAlertInWindows(id) {
    for (const win of Services.wm.getEnumerator("navigator:browser")) {
      const alert = win.document.getElementById(`whimsy-watch-alert-${id}`);
      if (alert) {
        alert.remove();
      }
    }
  },
};
