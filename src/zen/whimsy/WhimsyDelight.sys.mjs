/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Inbox-zero balloons: Superhuman's full-bleed "You've hit Inbox Zero",
// Todoist's cleared-list celebration, iMessage's Balloons screen effect -
// a small, earned reward at the exact moment an inbox tab's unread count
// hits 0, once, and never in the way. Watches the selected mail tab's
// title (Gmail/Outlook/Fastmail put the unread count right in it) and, on
// the >0 -> 0 transition, releases about a dozen Whimsy-gradient balloons
// rising from the bottom of the content area for ~2.5s. At most once per
// tab per 10 minutes. Reduced motion shows a small toast instead.
// whimsy.feature.inbox-zero.

const FEATURE_PREF = "whimsy.feature.inbox-zero";
const THROTTLE_MS = 10 * 60 * 1000;
const BALLOON_COUNT = 12;
const BALLOON_DURATION_MS = 2500;

// host test -> { regex: count match (group 1 is the number), zero: matches
// the zero state, where the title has no count at all }.
const HOSTS = [
  {
    match: host => host == "mail.google.com",
    regex: /\bInbox \((\d+)\)/,
    zero: /^Inbox\b(?!\s*\()/,
  },
  {
    match: host => host == "outlook.live.com" || host == "outlook.office.com" || host == "outlook.office365.com",
    regex: /\bInbox \((\d+)\)/,
    zero: /^Inbox\b(?!\s*\()/,
  },
  {
    match: host => host == "www.fastmail.com" || host == "app.fastmail.com",
    regex: /^\((\d+)\) Inbox/,
    zero: /^Inbox\b/,
  },
];

// Exported for the unit test: a host the test can add without touching the
// real table.
export const TEST_HOSTS = [];

/**
 * @param {string} host
 * @param {string} title
 * @returns {number|null} The inbox's unread count, or null if this host/
 *   title doesn't look like an inbox title at all.
 */
export function parseInboxCount(host, title) {
  const entry = [...HOSTS, ...TEST_HOSTS].find(h => h.match(host));
  if (!entry || !title) {
    return null;
  }
  const counted = entry.regex.exec(title);
  if (counted) {
    return parseInt(counted[1], 10);
  }
  return entry.zero.test(title) ? 0 : null;
}

const lastCount = new WeakMap(); // tab -> last known count
const lastCelebrated = new WeakMap(); // tab -> timestamp (Date.now())

export const WhimsyDelight = {
  parseInboxCount,

  get enabled() {
    return Services.prefs.getBoolPref(FEATURE_PREF, true);
  },

  initWindow(win) {
    win.gBrowser.tabContainer.addEventListener("TabAttrModified", event => {
      if (!this.enabled || !event.detail.changed?.includes("label")) {
        return;
      }
      // Every tab's count is tracked, so a mail tab that loaded in the
      // background (or before you switched to it) already has its ">0"
      // when you clear it; only the selected tab celebrates.
      this.onLabelChanged(win, event.target);
    });
  },

  onLabelChanged(win, tab) {
    const browser = tab.linkedBrowser;
    const host = browser?.currentURI?.asciiHost;
    if (!host) {
      return;
    }
    const count = parseInboxCount(host, tab.label);
    if (count == null) {
      return;
    }
    const previous = lastCount.get(tab);
    lastCount.set(tab, count);
    if (previous > 0 && count == 0 && tab == win.gBrowser.selectedTab) {
      this.celebrate(win, tab);
    }
  },

  celebrate(win, tab) {
    // wave7/focus: no celebration while Do Not Disturb is on.
    if (ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyDoNotDisturb.sys.mjs").WhimsyDoNotDisturb.quiet) {
      return;
    }
    const now = Date.now();
    const last = lastCelebrated.get(tab) || 0;
    if (now - last < THROTTLE_MS) {
      return;
    }
    lastCelebrated.set(tab, now);
    const reduced = win.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduced || !win.gZenUIManager?.showToast) {
      win.gZenUIManager?.showToast?.("whimsy-inbox-zero-toast", {});
      return;
    }
    this.releaseBalloons(win);
  },

  releaseBalloons(win) {
    const host = win.document.getElementById("zen-appcontent-wrapper");
    if (!host) {
      return;
    }
    const layer = win.document.createElement("div");
    layer.className = "whimsy-balloons";
    for (let i = 0; i < BALLOON_COUNT; i++) {
      const balloon = win.document.createElement("span");
      balloon.className = "whimsy-balloon";
      balloon.style.setProperty("--whimsy-balloon-x", `${Math.round(Math.random() * 100)}%`);
      balloon.style.setProperty("--whimsy-balloon-delay", `${Math.round(Math.random() * 400)}ms`);
      balloon.style.setProperty("--whimsy-balloon-hue", `${Math.round(Math.random() * 360)}`);
      layer.appendChild(balloon);
    }
    host.appendChild(layer);
    win.setTimeout(() => layer.remove(), BALLOON_DURATION_MS);
  },
};
