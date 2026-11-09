/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// W23 page-act: the scam warning (spec "Scam warning"; fu-page dec-13,
// page-8.2–8.4). An on-device pattern check (WhimsyScamCheckChild) plus
// what only the browser knows (whether you've been here before). Shown as
// a standard notification in the tab's notification box, warning
// priority, with plain reasons and Leave / I trust this. No close button,
// Esc does nothing, and it stays until you choose. "I trust this" is
// remembered per site, undoable in the toast, and reset from the site
// panel's menu.
//
// Guards: the page decides nothing. It can't trust itself (trust is a
// pref only the buttons and the site menu write), and the reasons are
// fixed strings; the one page quote ("Only 2 slots left") is a Fluent
// argument, shown as text.

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  PlacesUtils: "resource://gre/modules/PlacesUtils.sys.mjs",
  WhimsyAI: "resource:///modules/whimsy/WhimsyAI.sys.mjs",
  WhimsyAIContext: "resource:///modules/whimsy/WhimsyAIContext.sys.mjs",
  WhimsyCommands: "resource:///modules/whimsy/WhimsyCommands.sys.mjs",
  WhimsyUndo: "resource:///modules/whimsy/WhimsyUndo.sys.mjs",
});

const FEATURE_PREF = "whimsy.feature.ai-scam-warning";
const TRUST_PREF = "whimsy.ai.scam.trusted";
const VALUE = "whimsy-scam-warning";
const SHIELD_ICON = "chrome://browser/skin/zen-icons/tracking-protection.svg";
const ICON = "chrome://browser/content/whimsy/icons/scam.svg";
const WEIGHTS = { "account-elsewhere": 2, threat: 2, "card-new-site": 2, rush: 1, "from-email": 1, "new-site": 1 };
const STRONG = new Set(["account-elsewhere", "threat"]);
const SHOW_AT = 3;

function trusted() {
  return Services.prefs.getStringPref(TRUST_PREF, "").split(",").filter(Boolean);
}

export class WhimsyScamCheckParent extends JSWindowActorParent {
  receiveMessage(message) {
    if (message.name != "WhimsyScamCheck:Signals") {
      return;
    }
    const browser = this.browsingContext.top?.embedderElement;
    if (browser) {
      WhimsyScamCheck.onSignals(browser, message.data).catch(e => console.error("Whimsy scam check", e));
    }
  }
}

export const WhimsyScamCheck = {
  // Tests: host -> visits, in place of history.
  _visitCount: null,
  _shownFor: new WeakMap(),

  get enabled() {
    return Services.prefs.getBoolPref(FEATURE_PREF, true) && lazy.WhimsyAI.enabled;
  },

  isTrusted(host) {
    return trusted().includes(String(host).toLowerCase());
  },

  setTrusted(host, on) {
    const list = trusted().filter(h => h != host);
    if (on) {
      list.push(host);
    }
    Services.prefs.setStringPref(TRUST_PREF, list.join(","));
  },

  /**
   * Visits to `host` before today (M7): reloading, or a page that reloads
   * itself, never makes a site look known.
   */
  async visits(host) {
    if (this._visitCount) {
      return this._visitCount(host);
    }
    try {
      const db = await lazy.PlacesUtils.promiseDBConnection();
      const rev = `${[...host].reverse().join("")}.`;
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const rows = await db.execute(
        `SELECT COUNT(*) AS n FROM moz_historyvisits v JOIN moz_places h ON h.id = v.place_id
         WHERE h.rev_host = :rev AND v.visit_date < :before`,
        { rev, before: today.getTime() * 1000 }
      );
      return Number(rows[0]?.getResultByName("n") ?? 0);
    } catch {
      return 0;
    }
  },

  /** Signals → {show, weak, reasons: [l10n, args][]}. */
  judge(data, visits) {
    const signals = [...data.signals];
    const fresh = visits < 1;
    if (fresh && data.card) {
      signals.push({ id: "card-new-site" });
    } else if (fresh) {
      signals.push({ id: "new-site" });
    }
    const score = signals.reduce((sum, s) => sum + (WEIGHTS[s.id] ?? 0), 0);
    const reasons = [];
    const has = id => signals.some(s => s.id == id);
    for (const s of signals) {
      if (s.id == "new-site" || s.id == "from-email") {
        continue;
      }
      reasons.push(s.quote && s.id == "rush" ? [`whimsy-scam-reason-${s.id}`, { quote: s.quote }] : [`whimsy-scam-reason-${s.id}`]);
    }
    if (has("new-site") && has("from-email")) {
      reasons.push(["whimsy-scam-reason-new-from-email"]);
    } else if (has("new-site")) {
      reasons.push(["whimsy-scam-reason-new-site"]);
    } else if (has("from-email")) {
      reasons.push(["whimsy-scam-reason-from-email"]);
    }
    return { show: score >= SHOW_AT, weak: !signals.some(s => STRONG.has(s.id)), reasons, score };
  },

  async onSignals(browser, data) {
    const win = browser.documentGlobal;
    const tab = win?.gBrowser?.getTabForBrowser(browser);
    if (!this.enabled || !tab || lazy.WhimsyAIContext.isPrivate(tab)) {
      return null;
    }
    // The site is the tab's, never what the page says it is (M7).
    const host = browser.currentURI?.host?.toLowerCase() ?? "";
    if (!host || this.isTrusted(host)) {
      return null;
    }
    const verdict = this.judge(data, await this.visits(host));
    if (!verdict.show || (this.notificationFor(browser) && this._shownFor.get(browser) == host)) {
      return null;
    }
    this._shownFor.set(browser, host);
    return this.show(browser, host, verdict);
  },

  notificationFor(browser) {
    const win = browser.documentGlobal;
    return win.gBrowser.getNotificationBox(browser)?.getNotificationWithValue(VALUE) ?? null;
  },

  async show(browser, host, verdict) {
    const win = browser.documentGlobal;
    const box = win.gBrowser.getNotificationBox(browser);
    box.getNotificationWithValue(VALUE)?.remove();
    const notification = await box.appendNotification(
      VALUE,
      { label: { "l10n-id": "whimsy-scam-title" }, priority: box.PRIORITY_WARNING_HIGH },
      [
        { "l10n-id": "whimsy-scam-trust", callback: () => (this.trust(win, browser, host, verdict), true) },
        { "l10n-id": "whimsy-scam-leave", primary: true, callback: () => (this.leave(win, browser), true) },
      ],
      false,
      false
    );
    notification.classList.add("whimsy-scam");
    notification.dataset.host = host;
    const doc = win.document;
    const ns = "http://www.w3.org/1999/xhtml";
    const body = doc.createElementNS(ns, "div");
    body.setAttribute("slot", "message");
    body.className = "whimsy-scam-body";
    const title = doc.createElementNS(ns, "b");
    doc.l10n.setAttributes(title, "whimsy-scam-title");
    const sub = doc.createElementNS(ns, "span");
    doc.l10n.setAttributes(sub, verdict.weak ? "whimsy-scam-sub-weak" : "whimsy-scam-sub");
    const list = doc.createElementNS(ns, "ul");
    for (const [id, args] of verdict.reasons) {
      const li = doc.createElementNS(ns, "li");
      doc.l10n.setAttributes(li, id, args);
      list.append(li);
    }
    body.append(title, " ", sub, list);
    notification.append(body);
    // A shield, not the generic warning triangle (05-page 8.3).
    await notification.updateComplete;
    notification.messageImage?.setAttribute("src", SHIELD_ICON);
    // Esc does nothing here: the warning stays until a choice is made.
    notification.addEventListener("keydown", event => event.key == "Escape" && event.preventDefault(), true);
    return notification;
  },

  leave(win, browser) {
    this.notificationFor(browser)?.remove();
    const tab = win.gBrowser.getTabForBrowser(browser);
    if (browser.webNavigation?.canGoBack) {
      browser.goBack();
    } else if (tab) {
      win.gBrowser.removeTab(tab);
    }
  },

  trust(win, browser, host, verdict) {
    this.notificationFor(browser)?.remove();
    this.setTrusted(host, true);
    lazy.WhimsyUndo.showToast(
      win,
      "whimsy-scam-trusted-toast",
      {
        type: "scam-trust",
        undo: () => {
          this.setTrusted(host, false);
          if (browser.isConnected && browser.currentURI?.host == host) {
            this.show(browser, host, verdict);
          }
        },
        redo: () => this.setTrusted(host, true),
      },
      { host }
    );
  },

  initWindow(win) {
    if (!win.gBrowser) {
      return;
    }
    const popup = win.document.getElementById("zenSiteDataActions");
    popup?.addEventListener("popupshowing", event => {
      if (event.target != popup) {
        return;
      }
      const doc = win.document;
      let item = doc.getElementById("whimsy-scam-reset");
      if (!item) {
        item = doc.createXULElement("menuitem");
        item.id = "whimsy-scam-reset";
        doc.l10n.setAttributes(item, "whimsy-scam-reset");
        item.addEventListener("command", () => {
          const host = win.gBrowser.currentURI?.host;
          if (host) {
            this.setTrusted(host, false);
          }
        });
        popup.append(item);
      }
      let host = "";
      try {
        host = win.gBrowser.currentURI?.host ?? "";
      } catch {}
      item.hidden = !this.enabled || !host || !this.isTrusted(host);
    });
    lazy.WhimsyCommands.register(win, {
      id: "cmd_whimsyScamReset",
      l10nId: "whimsy-scam-reset-cmd",
      icon: ICON,
      isAvailable: w => {
        try {
          return this.enabled && this.isTrusted(w.gBrowser.currentURI.host);
        } catch {
          return false;
        }
      },
      run: w => this.setTrusted(w.gBrowser.currentURI.host, false),
    });
  },
};
