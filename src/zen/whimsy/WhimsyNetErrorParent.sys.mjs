/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Parent half of WhimsyNetErrorChild: navigating a privileged page away from
// about:neterror needs chrome privilege, so the child only sends a message
// and this opens whimsy://game's real page (about:whimsy?game) in the
// error page's own tab, the same way WhimsyProtocol.go() does for the
// address bar.

import { clearInterval, clearTimeout, setInterval, setTimeout } from "resource://gre/modules/Timer.sys.mjs";

// While the game plays on an error page, "back online" means a page really
// loads: the OS's link state can stay up with no internet (and on macOS
// isLinkUp is only the cached reachability flag), so a check of the
// captive-portal page, the one Firefox and macOS use, decides. Network
// events check at once; a poll every 5s catches a reconnect nobody reported.
const CHECK_TOPICS = [
  "network:link-status-changed",
  "network:offline-status-changed",
  "network:connectivity-service:ip-checks-complete",
  "network:connectivity-service:dns-checks-complete",
];

// W16-7: "a page loads" is any completed HTTP response, not one page
// matching byte for byte: the captive-portal page (a different body is
// only a captive-portal hint) or, as Reload would, the failed page itself
// (HEAD, uncached). Online when either answers.
export const WhimsyNetProbe = {
  intervalMs: 5000,
  timeoutMs: 4000,

  // One request: true when any HTTP response comes back, false when none.
  async reaches(url, { method = "GET", expected = "" } = {}) {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), this.timeoutMs);
    try {
      const response = await fetch(url, {
        method,
        cache: "no-store",
        credentials: "omit",
        redirect: "manual",
        signal: abort.signal,
      });
      if (expected && response.ok) {
        try {
          if ((await response.text()) != expected) {
            console.debug("Whimsy: back-online probe: the captive-portal page answered differently (a portal?)", url);
          }
        } catch {}
      }
      return true;
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  },

  // true when a page loads, false when nothing answers, null when there's
  // nothing to ask. `page`: the failed page's URL (the error page's u=).
  async check({ page = null, reason = "check" } = {}) {
    const canonical = Services.prefs.getStringPref("captivedetect.canonicalURL", "");
    let target = null;
    try {
      const url = page ? new URL(page) : null;
      target = url && /^https?:$/.test(url.protocol) ? url.href : null;
    } catch {}
    if (!canonical && !target) {
      return null;
    }
    let result = false;
    if (!Services.io.offline) {
      const probes = [];
      if (canonical) {
        probes.push(this.reaches(canonical, {
          expected: Services.prefs.getStringPref("captivedetect.canonicalContent", ""),
        }));
      }
      if (target) {
        probes.push(this.reaches(target, { method: "HEAD" }));
      }
      // The first that answers decides; false only when none does.
      result = await new Promise(resolve => {
        let left = probes.length;
        for (const probe of probes) {
          probe.then(ok => {
            if (ok) {
              resolve(true);
            } else if (--left == 0) {
              resolve(false);
            }
          });
        }
      });
    }
    console.debug("Whimsy: back-online probe", reason, result);
    return result;
  },
};

export class WhimsyNetErrorParent extends JSWindowActorParent {
  receiveMessage(message) {
    if (message.name == "WhimsyNetError:WatchConnectivity") {
      this.watch();
      return;
    }
    if (message.name == "WhimsyNetError:InTab") {
      return !!this.tabBrowser();
    }
    // The game, embedded in the offline error page, saves its high score,
    // look and sound choice through here (content can't write prefs).
    if (message.name == "WhimsyNetError:SetPref" && this.manager.documentURI.spec.startsWith("about:neterror?")) {
      const { name, value } = message.data ?? {};
      if (name == "whimsy.game.high-score" && Number.isInteger(value) && value >= 0) {
        Services.prefs.setIntPref(name, Math.max(value, Services.prefs.getIntPref(name, 0)));
      } else if (name == "whimsy.game.style" && ["retro", "gradient"].includes(value)) {
        Services.prefs.setStringPref(name, value);
      } else if (name == "whimsy.game.chiptune" && typeof value == "boolean") {
        Services.prefs.setBoolPref(name, value);
      }
      return;
    }
    if (message.name != "WhimsyNetError:PlayGame" ||
        !Services.prefs.getBoolPref("whimsy.feature.game", true) ||
        !this.manager.documentURI.spec.startsWith("about:neterror?")) {
      return;
    }
    const browser = this.tabBrowser();
    browser?.documentGlobal.openTrustedLinkIn("about:whimsy?game", "current", { targetBrowser: browser });
  }

  // The tab's browser when this error page is a tab's page (not a note or
  // Easel block, or a hidden page).
  tabBrowser() {
    if (this.browsingContext != this.browsingContext.top) {
      return null;
    }
    const browser = this.browsingContext.embedderElement;
    if (browser?.getAttribute("messagemanagergroup") != "browsers") {
      return null;
    }
    return browser.documentGlobal?.gBrowser?.getTabForBrowser(browser) ? browser : null;
  }

  watch() {
    if (this._observer) {
      return;
    }
    this._observer = (subject, topic) => this.check(topic);
    for (const topic of CHECK_TOPICS) {
      Services.obs.addObserver(this._observer, topic);
    }
    this._timer = setInterval(() => this.check("poll"), WhimsyNetProbe.intervalMs);
    this.check("start");
  }

  // The page the error is for (what Reload loads), from the error page's u=.
  failedPage() {
    try {
      return new URL(this.manager.documentURI.spec).searchParams.get("u");
    } catch {
      return null;
    }
  }

  async check(reason = "check") {
    if (this._checking) {
      this._again = true;
      return;
    }
    this._checking = true;
    try {
      do {
        this._again = false;
        const online = await WhimsyNetProbe.check({ page: this.failedPage(), reason });
        if (!this._observer || online === null || online === this._online) {
          continue;
        }
        this._online = online;
        try {
          this.sendAsyncMessage(online ? "WhimsyNetError:BackOnline" : "WhimsyNetError:Offline");
        } catch {
          // The page is gone.
        }
      } while (this._again && this._observer);
    } finally {
      this._checking = false;
    }
  }

  didDestroy() {
    if (this._observer) {
      for (const topic of CHECK_TOPICS) {
        Services.obs.removeObserver(this._observer, topic);
      }
      this._observer = null;
    }
    clearInterval(this._timer);
  }
}
