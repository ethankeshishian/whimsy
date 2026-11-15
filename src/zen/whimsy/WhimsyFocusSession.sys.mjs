/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// W29 focus sessions (intake-w28/designs/focus-wellbeing.md, built on the
// W27 design).
//
// One session at a time, for the whole app. Start Focus Session opens the
// sheet (WhimsyFocusSheet): a dial for the length (25 minutes the first
// time, then the last pick) and what the session turns on, each remembered:
//
//   Do Not Disturb           WhimsyDoNotDisturb.setPaused (no toast); if it
//                            was already on it stays on afterwards.
//   Pause distracting sites  new top-level loads of a listed site show
//                            about:whimsy?focus instead (tabs already open
//                            are left alone; private windows too).
//   Mute background tabs     WhimsyAccessCommands' Mute Background Tabs; if
//                            it was already on it stays on afterwards.
//   Break reminder           the done toast says it's time for a break, and
//                            5 minutes later a toast offers another session.
//
// All off is just a timer: nothing in the browser changes, but the
// countdown, the confetti, and the done toast still happen.
//
// The countdown is a notch in each window's page corner (WhimsyFocusNotch).
// The timer is wall-clock (endsAt, kept in a pref so a restart picks the
// session up; one that ended while Whimsy was closed ends quietly). Ending
// early, from the notch's panel or the command, does the same clean-up
// with no toast or confetti.

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  BrowserWindowTracker: "resource:///modules/BrowserWindowTracker.sys.mjs",
  clearTimeout: "resource://gre/modules/Timer.sys.mjs",
  setTimeout: "resource://gre/modules/Timer.sys.mjs",
  WhimsyAccessCommands: "resource:///modules/whimsy/WhimsyAccessCommands.sys.mjs",
  WhimsyCommands: "resource:///modules/whimsy/WhimsyCommands.sys.mjs",
  WhimsyDoNotDisturb: "resource:///modules/whimsy/WhimsyDoNotDisturb.sys.mjs",
  WhimsyFocusNotch: "resource:///modules/whimsy/WhimsyFocusNotch.sys.mjs",
  WhimsyFocusSheet: "resource:///modules/whimsy/WhimsyFocusSheet.sys.mjs",
});

const FEATURE_PREF = "whimsy.feature.focus-sessions";
const PREFS = {
  lastLength: "whimsy.focus.lastLength",
  dnd: "whimsy.focus.dnd",
  pauseSites: "whimsy.focus.pauseSites",
  muteBackground: "whimsy.focus.muteBackground",
  breakReminder: "whimsy.focus.breakReminder",
  social: "whimsy.focus.social",
  video: "whimsy.focus.video",
  sites: "whimsy.focus.sites",
  endsAt: "whimsy.focus.endsAt",
  dndWasOn: "whimsy.focus.dndWasOn",
  mutedBySession: "whimsy.focus.mutedBySession",
};
const ICON = "chrome://browser/content/whimsy/icons/clock.svg";
const PAGE = "about:whimsy?focus";
export const BREAK_MINUTES = 5;

// The built-in lists (design §5). They live here so a release can update
// them. LinkedIn and Discord are left out on purpose: they're work tools
// for many people.
export const SOCIAL_SITES = [
  "x.com", "twitter.com", "facebook.com", "instagram.com", "tiktok.com", "reddit.com",
  "threads.net", "bsky.app", "snapchat.com", "pinterest.com", "tumblr.com", "mastodon.social",
];
export const VIDEO_SITES = [
  "youtube.com", "netflix.com", "twitch.tv", "primevideo.com", "disneyplus.com", "hulu.com", "max.com",
  "tv.apple.com", "peacocktv.com", "crunchyroll.com", "kick.com", "9gag.com", "imgur.com", "buzzfeed.com",
];
// The three Settings names first, the rest as "and N more".
export const SOCIAL_SAMPLE = ["x.com", "instagram.com", "tiktok.com"];
export const VIDEO_SAMPLE = ["youtube.com", "netflix.com", "twitch.tv"];

const bool = name => Services.prefs.getBoolPref(PREFS[name], false);

/**
 * One line of "Your sites" as a host ("https://www.x.com/home" → "x.com"),
 * "" for a blank line, or null when it isn't a site.
 */
export function siteFromLine(line) {
  let text = String(line).trim().toLowerCase();
  if (!text) {
    return "";
  }
  text = text.replace(/^[a-z][a-z0-9+.-]*:\/\//, "").replace(/[/?#].*$/, "").replace(/^\*\./, "");
  text = text.replace(/:\d+$/, "").replace(/\.$/, "");
  if (!text.includes(".") || /\s/.test(text)) {
    return null;
  }
  let host;
  try {
    host = new URL(`http://${text}/`).hostname;
  } catch (e) {
    return null;
  }
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host) || host.split(".").some(p => !p || p.startsWith("-") || p.endsWith("-"))) {
    return null;
  }
  return host.replace(/^www\./, "");
}

/** "x.com" matches x.com and every subdomain of it. */
export function hostMatches(host, site) {
  host = String(host || "").toLowerCase().replace(/\.$/, "");
  return host == site || host.endsWith(`.${site}`);
}

// --- state -------------------------------------------------------------------

let initialized = false;
let timer = null;
let breakTimer = null;
// Open anyway (and the tabs already on a site when the session started):
// "<browserId>|<site>" pairs let through until the session ends.
const allowed = new Set();
let observing = false;

function windows() {
  return lazy.BrowserWindowTracker.orderedWindows.filter(w => !w.closed && w.gBrowser);
}

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

export const WhimsyFocusSession = {
  FEATURE_PREF,
  PREFS,
  PAGE,
  BREAK_MINUTES,
  // Tests shorten the break.
  breakMs: BREAK_MINUTES * 60 * 1000,
  // The finish: the notch says Done this long, then the toast.
  doneHoldMs: 1500,

  get enabled() {
    return Services.prefs.getBoolPref(FEATURE_PREF, true);
  },

  get isActive() {
    return this.endsAt > Date.now();
  },

  /** When the running session ends, in ms (0 when there's none). */
  get endsAt() {
    return Services.prefs.getIntPref(PREFS.endsAt, 0) * 1000;
  },

  /** The session's length in ms (the pie empties over it). */
  get totalMs() {
    return this.lastLength * 60 * 1000;
  },

  get lastLength() {
    return Math.max(1, Math.min(120, Services.prefs.getIntPref(PREFS.lastLength, 25)));
  },

  /** The sheet's ticks: the last session's, or the defaults. */
  get ticks() {
    return {
      dnd: bool("dnd"),
      pauseSites: bool("pauseSites"),
      muteBackground: bool("muteBackground"),
      breakReminder: bool("breakReminder"),
    };
  },

  // --- the site lists ------------------------------------------------------

  /** Your own sites, as saved. */
  get ownSites() {
    return Services.prefs
      .getStringPref(PREFS.sites, "")
      .split("\n")
      .map(siteFromLine)
      .filter(Boolean);
  },

  /** Every site a session pauses, without repeats. */
  get pausedSites() {
    const all = [...(bool("social") ? SOCIAL_SITES : []), ...(bool("video") ? VIDEO_SITES : []), ...this.ownSites];
    return [...new Set(all)];
  },

  /** What the sheet's Pause distracting sites row says. */
  summary() {
    const social = bool("social");
    const video = bool("video");
    const count = this.ownSites.length;
    const l10nId = social && video ? "whimsy-focus-pause-both"
      : social ? "whimsy-focus-pause-social"
      : video ? "whimsy-focus-pause-video"
      : "whimsy-focus-pause-own";
    return { l10nId, args: { count } };
  },

  /**
   * Checks "Your sites" text. Returns { sites } (hosts, one per site) or
   * { invalid } (the first line that isn't a site, as typed).
   */
  parseSites(text) {
    const sites = [];
    for (const line of String(text).split("\n")) {
      const site = siteFromLine(line);
      if (site === null) {
        return { invalid: line.trim() };
      }
      if (site && !sites.includes(site)) {
        sites.push(site);
      }
    }
    return { sites };
  },

  /** Saves "Your sites"; returns parseSites()'s answer. */
  saveSites(text) {
    const result = this.parseSites(text);
    if (result.sites) {
      Services.prefs.setStringPref(PREFS.sites, result.sites.join("\n"));
    }
    return result;
  },

  /** The listed site `host` belongs to, or null. */
  siteFor(host) {
    if (!host) {
      return null;
    }
    return this.pausedSites.find(site => hostMatches(host, site)) ?? null;
  },

  // --- start and end -------------------------------------------------------

  openSheet(win) {
    if (!this.enabled || this.isActive) {
      return null;
    }
    return lazy.WhimsyFocusSheet.open(win, {
      minutes: this.lastLength,
      ticks: this.ticks,
      onStart: options => this.start(win, options),
    });
  },

  /**
   * Starts a session. The length and the ticks are remembered for next
   * time.
   *
   * @param {Window} win
   * @param {object} options - { minutes, dnd, pauseSites, muteBackground, breakReminder }
   */
  start(win, { minutes = this.lastLength, ...ticks } = {}) {
    if (!this.enabled) {
      return;
    }
    if (this.isActive) {
      this.cleanUp();
    }
    this.dropBreak();
    minutes = Math.max(1, Math.min(120, Math.round(minutes)));
    const t = { ...this.ticks, ...ticks };
    Services.prefs.setIntPref(PREFS.lastLength, minutes);
    for (const name of ["dnd", "pauseSites", "muteBackground", "breakReminder"]) {
      Services.prefs.setBoolPref(PREFS[name], !!t[name]);
    }

    if (t.dnd) {
      const was = lazy.WhimsyDoNotDisturb.paused;
      Services.prefs.setBoolPref(PREFS.dndWasOn, was);
      if (!was) {
        lazy.WhimsyDoNotDisturb.setPaused(true);
      }
    }
    if (t.muteBackground && !lazy.WhimsyAccessCommands.backgroundMuted()) {
      lazy.WhimsyAccessCommands.toggleBackgroundMute();
      Services.prefs.setBoolPref(PREFS.mutedBySession, true);
    }
    allowed.clear();
    if (t.pauseSites) {
      this.allowOpenTabs();
      this.listen(true);
    }
    Services.prefs.setIntPref(PREFS.endsAt, nowSeconds() + minutes * 60);
    this.arm();
    for (const w of windows()) {
      lazy.WhimsyFocusNotch.attach(w, this);
    }
    Services.obs.notifyObservers(null, "whimsy-focus-changed", "start");
  },

  /** Ends the session early: the clean-up, no toast. */
  end() {
    if (!this.endsAt) {
      return;
    }
    this.cleanUp();
    for (const w of windows()) {
      lazy.WhimsyFocusNotch.detach(w);
    }
    Services.obs.notifyObservers(null, "whimsy-focus-changed", "end");
  },

  /** The time is up: clean up, then confetti, Done, and the toast. */
  finish() {
    if (!this.endsAt) {
      return;
    }
    const minutes = this.lastLength;
    const breakReminder = bool("breakReminder");
    this.cleanUp();
    const top = windows()[0] ?? null;
    for (const w of windows()) {
      lazy.WhimsyFocusNotch.celebrate(w, { confetti: w == top, holdMs: this.doneHoldMs });
    }
    Services.obs.notifyObservers(null, "whimsy-focus-changed", "finish");
    lazy.setTimeout(() => {
      const win = windows()[0];
      if (win) {
        this.doneToast(win, { breakReminder, minutes });
      }
    }, this.doneHoldMs);
    if (breakReminder) {
      breakTimer = lazy.setTimeout(() => {
        breakTimer = null;
        const win = windows()[0];
        if (win) {
          this.breakToast(win, minutes);
        }
      }, this.breakMs);
    }
  },

  /** Undoes what the session turned on and forgets it. */
  cleanUp() {
    if (timer) {
      lazy.clearTimeout(timer);
      timer = null;
    }
    const ticks = this.ticks;
    Services.prefs.setIntPref(PREFS.endsAt, 0);
    if (ticks.dnd && !bool("dndWasOn")) {
      lazy.WhimsyDoNotDisturb.setPaused(false);
    }
    Services.prefs.clearUserPref(PREFS.dndWasOn);
    this.restoreMute();
    this.listen(false);
    allowed.clear();
    this.reopenPausedTabs();
  },

  restoreMute() {
    if (!bool("mutedBySession")) {
      return;
    }
    Services.prefs.clearUserPref(PREFS.mutedBySession);
    if (lazy.WhimsyAccessCommands.backgroundMuted()) {
      lazy.WhimsyAccessCommands.toggleBackgroundMute();
    }
  },

  arm() {
    if (timer) {
      lazy.clearTimeout(timer);
    }
    timer = lazy.setTimeout(() => {
      timer = null;
      this.finish();
    }, Math.max(0, this.endsAt - Date.now()));
  },

  dropBreak() {
    if (breakTimer) {
      lazy.clearTimeout(breakTimer);
      breakTimer = null;
    }
    for (const w of windows()) {
      w.gZenUIManager?.toasts?.getToast("whimsy-focus-break-over")?.close({ instant: true });
    }
  },

  get breakPending() {
    return !!breakTimer;
  },

  doneToast(win, { breakReminder, minutes }) {
    return win.gZenUIManager?.toasts?.open("whimsy-focus-done-toast", {
      descriptionId: breakReminder ? "whimsy-focus-done-break" : undefined,
      timeout: 0,
      icon: { src: "chrome://global/skin/icons/check.svg" },
      buttons: [
        {
          id: "whimsy-focus-start-another",
          l10nId: "whimsy-focus-start-another",
          command: () => this.startAnother(win, minutes),
        },
      ],
    });
  },

  breakToast(win, minutes) {
    return win.gZenUIManager?.toasts?.open("whimsy-focus-break-over", {
      descriptionId: "whimsy-focus-break-over-description",
      descriptionArgs: { minutes },
      timeout: 0,
      icon: { src: ICON },
      buttons: [
        {
          id: "whimsy-focus-break-start",
          l10nId: "whimsy-focus-start-another",
          command: () => this.startAnother(win, minutes),
        },
      ],
    });
  },

  // Start another: the same length and ticks, at once.
  startAnother(win, minutes) {
    for (const w of windows()) {
      for (const id of ["whimsy-focus-done-toast", "whimsy-focus-break-over"]) {
        w.gZenUIManager?.toasts?.getToast(id)?.close();
      }
    }
    this.start(win.closed ? windows()[0] : win, { minutes });
  },

  // --- pausing sites -----------------------------------------------------

  listen(on) {
    if (on == observing) {
      return;
    }
    observing = on;
    if (on) {
      Services.obs.addObserver(this, "http-on-modify-request");
    } else {
      Services.obs.removeObserver(this, "http-on-modify-request");
    }
  },

  QueryInterface: ChromeUtils.generateQI(["nsIObserver"]),

  pauseIfListed(channel) {
    if (!(channel instanceof Ci.nsIHttpChannel)) {
      return;
    }
    const info = channel.loadInfo;
    if (info?.externalContentPolicyType != Ci.nsIContentPolicy.TYPE_DOCUMENT) {
      return;
    }
    const bc = info.targetBrowsingContext ?? info.browsingContext;
    if (!bc || bc.parent) {
      return;
    }
    const uri = channel.URI;
    if (!uri?.schemeIs("http") && !uri?.schemeIs("https")) {
      return;
    }
    const site = this.siteFor(uri.host);
    if (!site || allowed.has(`${bc.browserId}|${site}`)) {
      return;
    }
    const browser = bc.top.embedderElement;
    if (!browser || browser.localName != "browser" || !browser.ownerDocument.defaultView?.gBrowser) {
      return;
    }
    channel.cancel(Cr.NS_BINDING_ABORTED);
    const spec = uri.spec;
    Services.tm.dispatchToMainThread(() => {
      if (!browser.isConnected) {
        return;
      }
      browser.loadURI(Services.io.newURI(`${PAGE}&url=${encodeURIComponent(spec)}`), {
        triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
      });
    });
  },

  // nsIObserver (http-on-modify-request).
  observe(subject, topic) {
    if (topic == "http-on-modify-request") {
      try {
        this.pauseIfListed(subject);
      } catch (e) {
        console.error("Whimsy focus: pausing a site", e);
      }
    }
  },

  // Tabs already showing a listed site are left alone.
  allowOpenTabs() {
    for (const w of windows()) {
      for (const browser of w.gBrowser.browsers) {
        let host = "";
        try {
          host = browser.currentURI?.host;
        } catch (e) {
          // No host (about:, file:).
        }
        const site = this.siteFor(host);
        if (site && browser.browserId) {
          allowed.add(`${browser.browserId}|${site}`);
        }
      }
    }
  },

  /** The paused page's Open anyway: lets this tab load the site. */
  openAnyway(browser, url) {
    const uri = this.validURL(url);
    if (!uri || !browser) {
      return;
    }
    const site = this.siteFor(uri.host);
    if (site) {
      allowed.add(`${browser.browserId}|${site}`);
    }
    this.loadIn(browser, uri);
  },

  /** The paused page's Go back: back, or close a tab with nowhere to go. */
  goBack(browser) {
    if (!browser) {
      return;
    }
    if (browser.canGoBack) {
      browser.goBack();
      return;
    }
    const win = browser.ownerDocument.defaultView;
    const tab = win?.gBrowser?.getTabForBrowser(browser);
    if (tab) {
      win.gBrowser.removeTab(tab);
    }
  },

  /** An http(s) URL from the paused page's address, or null. */
  validURL(url) {
    try {
      const uri = Services.io.newURI(url);
      return uri.schemeIs("http") || uri.schemeIs("https") ? uri : null;
    } catch (e) {
      return null;
    }
  },

  // In place of the paused page, so Back skips it.
  loadIn(browser, uri) {
    browser.loadURI(uri, {
      triggeringPrincipal: Services.scriptSecurityManager.createNullPrincipal({
        userContextId: browser.getAttribute("usercontextid") ? Number(browser.getAttribute("usercontextid")) : 0,
      }),
      loadFlags: Ci.nsIWebNavigation.LOAD_FLAGS_REPLACE_HISTORY,
    });
  },

  // When a session ends, tabs showing the paused page load their site.
  reopenPausedTabs() {
    for (const w of windows()) {
      for (const browser of w.gBrowser.browsers) {
        const spec = browser.currentURI?.spec ?? "";
        if (!spec.startsWith(`${PAGE}&`)) {
          continue;
        }
        const url = new URLSearchParams(spec.slice(spec.indexOf("?") + 1)).get("url");
        const uri = url && this.validURL(url);
        if (uri) {
          this.loadIn(browser, uri);
        }
      }
    }
  },

  // --- set-up --------------------------------------------------------------

  init() {
    if (initialized) {
      return;
    }
    initialized = true;
    const endsAt = this.endsAt;
    if (endsAt && endsAt > Date.now() && this.enabled) {
      // A restart mid-session: pick it up. Do Not Disturb doesn't outlive
      // a quit, so it was off before this start.
      if (bool("dnd")) {
        Services.prefs.setBoolPref(PREFS.dndWasOn, false);
        lazy.WhimsyDoNotDisturb.setPaused(true);
      }
      if (bool("pauseSites")) {
        this.listen(true);
      }
      this.arm();
    } else if (endsAt) {
      // It ended while Whimsy was closed: end it quietly.
      Services.prefs.setIntPref(PREFS.endsAt, 0);
      Services.prefs.clearUserPref(PREFS.dndWasOn);
      this.restoreMute();
    }
    Services.prefs.addObserver(FEATURE_PREF, () => {
      if (!this.enabled) {
        this.dropBreak();
        this.end();
      }
    });
  },

  initWindow(win) {
    this.init();
    lazy.WhimsyCommands.register(win, {
      id: "cmd_whimsyFocusSession",
      l10nId: "whimsy-action-focus-toggle",
      run: w => (this.isActive ? this.end() : this.openSheet(w)),
      icon: ICON,
      isAvailable: () => this.enabled,
      whimsyKeywords: () => lazy.WhimsyCommands.keywords("whimsy-keywords-focus"),
      variants: [
        { l10nId: "whimsy-action-focus-start", isAvailable: () => this.enabled && !this.isActive },
        { l10nId: "whimsy-action-focus-end", isAvailable: () => this.enabled && this.isActive },
      ],
    });
    if (this.isActive) {
      lazy.WhimsyFocusNotch.attach(win, this);
    }
  },
};
