/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// W23: what starts a routine. Schedules are plain clock math; the rest
// watch the browser and the Mac and tell WhimsyRoutines when something
// happened:
//   return    the Mac was asleep, or nobody touched it (a locked screen),
//             for at least the routine's time; fires once on the way back
//   open-site the first visit each day to a site, never a private or
//             off-limits tab
//   download  a finished download, never a private one
//   meeting   a calendar event starts within the lead time
//   email     new mail in Gmail or Outlook (read only), polled
// Nothing here calls AI; WhimsyRoutines decides what runs.

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  Downloads: "resource://gre/modules/Downloads.sys.mjs",
  WhimsyAIContext: "resource:///modules/whimsy/WhimsyAIContext.sys.mjs",
  WhimsyConnectors: "resource:///modules/whimsy/WhimsyConnectors.sys.mjs",
  WhimsyNextMeeting: "resource:///modules/whimsy/WhimsyNextMeeting.sys.mjs",
});

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
// The shortest "I come back" a routine can ask for, and the idle check.
const MIN_AWAY_MINUTES = 15;
const MAIL_POLL_MS = 5 * MINUTE;
const MAX_SEEN_MAIL = 300;
const MAX_SLOTS = 2000;

export const TRIGGER_KINDS = ["schedule", "page", "return", "meeting", "email", "open-site", "download"];
// Triggers that read through a connector.
export const CONNECTOR_TRIGGERS = {
  meeting: { scope: "calendar", ids: ["google", "microsoft", "apple-calendar"] },
  email: { scope: "mail", ids: ["google", "microsoft"] },
};
const MAIL_TOOLS = { google: "gmail_search", microsoft: "outlook_mail_search" };
const MAIL_SCOPES = { google: "gmail", microsoft: "outlook" };
const CALENDAR_SCOPES = { google: "calendar", microsoft: "calendar", "apple-calendar": null };

function hostOf(url) {
  try {
    return new URL(url).host.replace(/^www\./, "").toLowerCase();
  } catch {
    return "";
  }
}

function dayKey(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

function sameSite(host, wanted) {
  const want = String(wanted ?? "").replace(/^www\./, "").toLowerCase();
  return !!want && (host == want || host.endsWith(`.${want}`));
}

export const WhimsyRoutineTriggers = {
  _handler: null,
  _now: () => Date.now(),
  _windows: new Set(),
  _downloadView: null,
  _idle: null,
  _awaySince: null,
  _sleepAt: null,
  _visits: new Map(),
  _seenMail: new Map(),
  _mailPolled: 0,
  _test: {},

  // ---- Schedules ----

  /** The first time the schedule fires after `after` (ms), or null. */
  nextScheduled(trigger, after) {
    if (trigger?.every == "hour") {
      const d = new Date(after);
      d.setMinutes(Number(trigger.minute) || 0, 0, 0);
      while (d.getTime() <= after) {
        d.setTime(d.getTime() + HOUR);
      }
      return d.getTime();
    }
    const days = Array.isArray(trigger?.days) && trigger.days.length ? trigger.days : [0, 1, 2, 3, 4, 5, 6];
    const hour = Math.min(23, Math.max(0, Number(trigger?.hour) || 0));
    const minute = Math.min(59, Math.max(0, Number(trigger?.minute) || 0));
    for (let i = 0; i <= 8; i++) {
      const d = new Date(after);
      d.setDate(d.getDate() + i);
      d.setHours(hour, minute, 0, 0);
      if (d.getTime() > after && days.includes(d.getDay())) {
        return d.getTime();
      }
    }
    return null;
  },

  /** How many times the schedule fired in (from, to]. */
  slotsBetween(trigger, from, to) {
    let count = 0;
    let at = from;
    while (count < MAX_SLOTS) {
      const next = this.nextScheduled(trigger, at);
      if (next == null || next > to) {
        break;
      }
      count++;
      at = next;
    }
    return count;
  },

  /** The last time the schedule fired at or before `at`, or null. */
  lastSlot(trigger, from, at) {
    let last = null;
    let cursor = from;
    for (let i = 0; i < MAX_SLOTS; i++) {
      const next = this.nextScheduled(trigger, cursor);
      if (next == null || next > at) {
        break;
      }
      last = next;
      cursor = next;
    }
    return last;
  },

  // ---- Starting and stopping ----

  /**
   * handler: { fire(kind, event), routines(kind) -> Routine[] }. Events:
   *   return {awayMs}, open-site {url, host, title}, download {url, path,
   *   contentType, host}, email {connector, from, subject, date, snippet}.
   */
  start(handler, { now } = {}) {
    this._handler = handler;
    if (now) {
      this._now = now;
    }
    if (this._started) {
      return;
    }
    this._started = true;
    Services.obs.addObserver(this, "sleep_notification");
    Services.obs.addObserver(this, "wake_notification");
    this._watchIdle();
    this._watchDownloads().catch(e => console.error("Whimsy routines: downloads", e));
  },

  stop() {
    if (!this._started) {
      return;
    }
    this._started = false;
    Services.obs.removeObserver(this, "sleep_notification");
    Services.obs.removeObserver(this, "wake_notification");
    if (this._idle) {
      try {
        Cc["@mozilla.org/widget/useridleservice;1"].getService(Ci.nsIUserIdleService).removeIdleObserver(this, this._idle);
      } catch {}
      this._idle = null;
    }
    if (this._downloadView) {
      const { list, view } = this._downloadView;
      list.removeView(view);
      this._downloadView = null;
    }
    for (const win of this._windows) {
      win.gBrowser?.removeTabsProgressListener(this._progress);
    }
    this._windows.clear();
  },

  _fire(kind, event) {
    try {
      this._handler?.fire(kind, event);
    } catch (e) {
      console.error(`Whimsy routines: ${kind}`, e);
    }
  },

  _routines(kind) {
    try {
      return this._handler?.routines(kind) ?? [];
    } catch {
      return [];
    }
  },

  // ---- I come back: asleep, or the Mac untouched (a locked screen) ----

  _watchIdle() {
    try {
      const idle = Cc["@mozilla.org/widget/useridleservice;1"].getService(Ci.nsIUserIdleService);
      this._idle = MIN_AWAY_MINUTES * 60;
      idle.addIdleObserver(this, this._idle);
    } catch {
      this._idle = null;
    }
  },

  observe(subject, topic) {
    const now = this._now();
    switch (topic) {
      case "sleep_notification":
        this._sleepAt = now;
        this._awaySince ??= now;
        break;
      case "idle":
        // Idle for the threshold already: away since then.
        this._awaySince ??= now - MIN_AWAY_MINUTES * MINUTE;
        break;
      case "wake_notification":
        this._sleepAt = null;
        // Back from sleep, but nobody's there until there's input.
        if (!this._idle) {
          this._back(now);
        }
        break;
      case "active":
        this._back(now);
        break;
    }
  },

  _back(now) {
    if (this._awaySince == null) {
      return;
    }
    const awayMs = now - this._awaySince;
    this._awaySince = null;
    this._fire("return", { awayMs, at: now });
  },

  // Tests: away for `ms`, then back.
  _simulateAway(ms) {
    const now = this._now();
    this._awaySince = now - ms;
    this._back(now);
  },

  // ---- I open a site: first visit each day, never private ----

  initWindow(win) {
    if (this._windows.has(win) || !win.gBrowser) {
      return;
    }
    this._windows.add(win);
    this._progress ??= {
      onLocationChange: (browser, webProgress, request, location, flags) => {
        if (!webProgress?.isTopLevel || flags & Ci.nsIWebProgressListener.LOCATION_CHANGE_SAME_DOCUMENT) {
          return;
        }
        const tab = browser.ownerGlobal?.gBrowser?.getTabForBrowser(browser);
        this._visited(tab, location?.spec ?? "");
      },
    };
    win.gBrowser.addTabsProgressListener(this._progress);
    win.addEventListener("unload", () => this._windows.delete(win), { once: true });
  },

  _visited(tab, url) {
    if (!tab || !/^https?:/.test(url)) {
      return;
    }
    // Private, locked, or hidden: as if the visit never happened.
    if (lazy.WhimsyAIContext.isOffLimits(tab)) {
      return;
    }
    const host = hostOf(url);
    const today = dayKey(this._now());
    for (const r of this._routines("open-site")) {
      if (!sameSite(host, r.trigger.host)) {
        continue;
      }
      const key = `${r.id}|${today}`;
      if (this._visits.has(key) || r.lastVisitDay == today) {
        continue;
      }
      this._visits.set(key, true);
      if (this._visits.size > 500) {
        this._visits.delete(this._visits.keys().next().value);
      }
      this._fire("open-site", { routineId: r.id, url, host, title: tab.label ?? "", day: today });
    }
  },

  // ---- A download finishes ----

  async _watchDownloads() {
    // PUBLIC: private windows' downloads are a separate list, never read.
    const list = await lazy.Downloads.getList(lazy.Downloads.PUBLIC);
    const done = new WeakSet();
    const view = {
      onDownloadAdded: d => {
        if (d.succeeded) {
          done.add(d);
        }
      },
      onDownloadChanged: d => {
        if (!d.succeeded || done.has(d)) {
          return;
        }
        done.add(d);
        this._downloaded(d);
      },
    };
    await list.addView(view);
    if (!this._started) {
      list.removeView(view);
      return;
    }
    this._downloadView = { list, view };
  },

  _downloaded(d) {
    if (d.source?.isPrivate) {
      return;
    }
    const url = d.source?.url ?? "";
    const path = d.target?.path ?? "";
    const event = { url, path, host: hostOf(url), contentType: d.contentType ?? "", name: PathUtils.filename(path || "file") };
    this._fire("download", event);
  },

  /** Whether a finished download is one a routine's detail asks for. */
  downloadMatches(trigger, event) {
    const name = String(event.name ?? "").toLowerCase();
    const type = String(event.contentType ?? "").toLowerCase();
    switch (trigger?.match ?? "any") {
      case "pdf":
        return type == "application/pdf" || name.endsWith(".pdf");
      case "image":
        return type.startsWith("image/") || /\.(png|jpe?g|gif|webp|heic|avif|svg)$/.test(name);
      case "site":
        return sameSite(event.host, trigger.host);
      default:
        return true;
    }
  },

  // ---- Before a meeting ----

  /** Events from the connected calendars, in time order. */
  async calendarEvents(now) {
    if (this._test.calendar) {
      return this._test.calendar(now);
    }
    if (!(await this.connected("meeting"))) {
      return [];
    }
    return lazy.WhimsyNextMeeting.upcoming(now);
  },

  // ---- An email arrives ----

  /** New mail since the last poll, from every connected mailbox. */
  async newMail(now, { force = false } = {}) {
    if (!force && now - this._mailPolled < MAIL_POLL_MS) {
      return [];
    }
    this._mailPolled = now;
    const out = [];
    const ids = this._test.mail ? ["test"] : await this.connected("email");
    for (const id of ids) {
      let list;
      try {
        list = this._test.mail ? await this._test.mail(now) : await this._mailOf(id, now);
      } catch (e) {
        // An expired sign-in is a routine failure; WhimsyRoutines reports it.
        if (e?.code == "expired") {
          this._fire("connector-expired", { connector: id });
        }
        continue;
      }
      const seen = this._seenMail.get(id);
      const keys = list.map(m => `${m.date}|${m.from}|${m.subject}`);
      this._seenMail.set(id, new Set([...(seen ?? []), ...keys].slice(-MAX_SEEN_MAIL)));
      // The first poll only learns what's there.
      if (!seen) {
        continue;
      }
      list.forEach((m, i) => !seen.has(keys[i]) && out.push({ ...m, connector: id }));
    }
    return out;
  },

  async _mailOf(id, now) {
    const since = new Date(now - DAY);
    const query = id == "google" ? "newer_than:1d in:inbox" : `received>=${since.toISOString().slice(0, 10)}`;
    const text = await lazy.WhimsyConnectors.call(id, MAIL_TOOLS[id], { query });
    const items = JSON.parse(text || "[]");
    return (Array.isArray(items) ? items : []).map(m => ({
      from: String(m.from?.emailAddress?.address ?? m.from ?? ""),
      subject: String(m.subject ?? ""),
      date: String(m.receivedDateTime ?? m.date ?? ""),
      snippet: String(m.bodyPreview ?? m.snippet ?? "").slice(0, 500),
    }));
  },

  /** Whether a new mail is one the routine's detail asks for. */
  async mailMatches(trigger, mail) {
    const text = String(trigger?.text ?? "").trim().toLowerCase();
    switch (trigger?.match ?? "anyone") {
      case "sender":
        return !!text && mail.from.toLowerCase().includes(text);
      case "subject":
        return !!text && mail.subject.toLowerCase().includes(text);
      case "known": {
        const address = (mail.from.match(/[^\s<>"]+@[^\s<>"]+/) ?? [])[0];
        if (!address) {
          return false;
        }
        if (this._test.known) {
          return this._test.known(address);
        }
        const id = mail.connector;
        const query = id == "google" ? `in:sent to:${address}` : `to:${address}`;
        const sent = await lazy.WhimsyConnectors.call(id, MAIL_TOOLS[id], { query }).catch(() => "[]");
        return JSON.parse(sent || "[]").length > 0;
      }
      default:
        return true;
    }
  },

  // ---- Connectors a trigger needs ----

  /** The connected connector ids a trigger can read through ([] if none). */
  async connected(kind) {
    const need = CONNECTOR_TRIGGERS[kind];
    if (!need) {
      return [];
    }
    let list = [];
    try {
      list = await lazy.WhimsyConnectors.list();
    } catch {}
    const scopes = kind == "email" ? MAIL_SCOPES : CALENDAR_SCOPES;
    return list
      .filter(c => need.ids.includes(c.id) && c.connected && c.status != "expired")
      .filter(c => !scopes[c.id] || c.scopes.find(s => s.id == scopes[c.id])?.on !== false)
      .map(c => c.id);
  },

  /** Expired connectors a trigger would read through. */
  async expired(kind) {
    const need = CONNECTOR_TRIGGERS[kind];
    if (!need) {
      return [];
    }
    const list = await lazy.WhimsyConnectors.list().catch(() => []);
    return list.filter(c => need.ids.includes(c.id) && c.connected && c.status == "expired").map(c => c.id);
  },

  // Tests: stand-in calendar, mailbox, and "people I've written to".
  setTestSource(kind, fn) {
    if (fn && !Cu.isInAutomation) {
      throw new Error("Test sources are for automated tests only");
    }
    if (fn) {
      this._test[kind] = fn;
    } else {
      delete this._test[kind];
    }
  },

  _resetForTesting() {
    this._visits.clear();
    this._seenMail.clear();
    this._mailPolled = 0;
    this._awaySince = null;
  },
};
