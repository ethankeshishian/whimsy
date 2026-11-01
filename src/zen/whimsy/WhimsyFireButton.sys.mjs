/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// The point (DuckDuckGo's Fire Button, which this follows): one press ends
// the session you're in, closing its tabs and erasing the traces they left,
// so you can start fresh.
//
// batch8 shipped it as four scopes (This Site / Last 15 Minutes / This Space
// / Everything). wave7/fire narrows it to what serves that point, in the
// user's words:
//   - "Fire in This Profile" (the default): the profile (container) the
//     current space uses. Closes the unpinned tabs of every space in that
//     profile, removes that profile's history visits from the last hour
//     (WhimsySpaceHistory's per-visit profile; unattributed visits count as
//     Default, as the History filter does), and clears cookies, site data
//     and cache for the sites those visits and tabs touched, only in that
//     container. Other profiles keep theirs. (Gecko can't clear one
//     container by time, so it's by site.)
//   - "Fire Everywhere": every profile, all time, behind a second confirm
//     with Cancel as the default.
// Per-site forgetting isn't ending a session; it's Firefox's "Forget About
// This Site" (History), and stays reachable as the "Forget About This Site…"
// command. The old "This Space" scope is the default row now; "Last 15
// Minutes" became the last hour (Clear Recent History has finer ranges).
//
// Build-plan answer: pinned tabs and Essentials survive (DuckDuckGo's
// Fireproof): they're left out of the close step, not the clear.
//
// Security review H2: burned tabs must not come back. Each burn closes its
// tabs FIRST, with skipSessionStore (so they never enter the closed-tab
// list, the Archive or Undo), forgets the closed tabs/windows in its scope
// that are already there, writes the session file, and only then clears
// data.

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  ForgetAboutSite: "moz-src:///toolkit/components/forgetaboutsite/ForgetAboutSite.sys.mjs",
  PrivateBrowsingUtils: "resource://gre/modules/PrivateBrowsingUtils.sys.mjs",
  Sanitizer: "resource:///modules/Sanitizer.sys.mjs",
  SessionSaver: "moz-src:///browser/components/sessionstore/SessionSaver.sys.mjs",
  SessionStore: "moz-src:///browser/components/sessionstore/SessionStore.sys.mjs",
  PlacesUtils: "resource://gre/modules/PlacesUtils.sys.mjs",
  WhimsyArchive: "resource:///modules/whimsy/WhimsyArchive.sys.mjs",
  WhimsyProfiles: "resource:///modules/whimsy/WhimsyProfiles.sys.mjs",
  WhimsySpaceHistory: "resource:///modules/whimsy/WhimsySpaceHistory.sys.mjs",
  WhimsySurface: "resource:///modules/whimsy/WhimsySurface.sys.mjs",
  WhimsyToast: "resource:///modules/whimsy/WhimsyToast.sys.mjs",
  WhimsyUndo: "resource:///modules/whimsy/WhimsyUndo.sys.mjs",
});

const FEATURE_PREF = "whimsy.feature.fire-button";
const PANEL_ID = "whimsyFirePanel";
const PANEL_WIDTH = 400;
const ICONS = {
  profile: "chrome://browser/skin/zen-icons/history.svg",
  site: "chrome://browser/skin/zen-icons/forget.svg",
  everything: "chrome://browser/skin/zen-icons/selectable/flame.svg",
};
const LAST_HOUR_MS = 60 * 60 * 1000;
// W10-58: the "Clearing…" toast waits for the result (which replaces it);
// the result stays long enough to read.
const WORKING_TIMEOUT_MS = 120 * 1000;
const DONE_TIMEOUT_MS = 6000;
// What Everything clears, and exactly what the sheet names: history,
// cookies, site data, cache and the download list. Bookmarks, passwords,
// downloaded files and site permissions stay. Fire in This Profile clears SITE_FLAGS per site, and
// that profile's history visits.
const FORGET_FLAGS =
  Ci.nsIClearDataService.CLEAR_HISTORY |
  Ci.nsIClearDataService.CLEAR_COOKIES_AND_SITE_DATA |
  Ci.nsIClearDataService.CLEAR_ALL_CACHES |
  // The download list (Clear History's "downloads"); files on disk stay.
  Ci.nsIClearDataService.CLEAR_DOWNLOADS;
const SITE_FLAGS = Ci.nsIClearDataService.CLEAR_COOKIES_AND_SITE_DATA | Ci.nsIClearDataService.CLEAR_ALL_CACHES;

function siteOfURL(url) {
  try {
    const uri = Services.io.newURI(url);
    if (!/^https?$/.test(uri.scheme)) {
      return null;
    }
    try {
      return Services.eTLD.getBaseDomain(uri);
    } catch {
      return uri.host || null;
    }
  } catch {
    return null;
  }
}

function siteOf(tab) {
  const uri = tab.linkedBrowser?.currentURI;
  if (!uri || !/^https?$/.test(uri.scheme)) {
    return null;
  }
  try {
    return Services.eTLD.getBaseDomain(uri);
  } catch {
    return uri.host || null;
  }
}

function clearData(sinceMs = null) {
  return new Promise(resolve => {
    const callback = { onDataDeleted: resolve };
    if (sinceMs == null) {
      Services.clearData.deleteData(FORGET_FLAGS, callback);
    } else {
      const now = Date.now();
      Services.clearData.deleteDataInTimeRange((now - sinceMs) * 1000, now * 1000, true, FORGET_FLAGS, callback);
    }
  });
}

export const WhimsyFireButton = {
  // What Everything clears (the sheet names exactly these), and what the
  // profile fire clears for each site it touched.
  forgetFlags: FORGET_FLAGS,
  siteFlags: SITE_FLAGS,

  // Clears FORGET_FLAGS from the last `sinceMs` (all time when null).
  clearData(sinceMs = null) {
    return clearData(sinceMs);
  },

  get enabled() {
    return Services.prefs.getBoolPref(FEATURE_PREF, true);
  },

  initWindow(win) {
    const { WhimsyCommands } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyCommands.sys.mjs");
    WhimsyCommands.register(win, {
      id: "cmd_whimsyFireButton",
      l10nId: "whimsy-action-fire-button",
      run: w => this.openPanel(w),
      icon: "chrome://browser/skin/forget.svg",
      isAvailable: () => this.enabled,
    });
    // wave7/fire: the per-site clear that left the sheet. Not part of ending
    // a session, so it lives here, named as Firefox names it.
    WhimsyCommands.register(win, {
      id: "cmd_whimsyForgetSite",
      l10nId: "whimsy-action-forget-site",
      run: w => this.forgetSite(w),
      icon: "chrome://browser/skin/forget.svg",
      isAvailable: w => this.enabled && !!siteOf(w.gBrowser.selectedTab),
    });
    // wave8/cmds: W8-46 direct commands for Fire in This Profile and Fire Everywhere
    WhimsyCommands.register(win, {
      id: "cmd_whimsyFireProfile",
      l10nId: "whimsy-fire-profile",
      run: w => this.run(w, () => this.burnProfile(w), "profile"),
      icon: "chrome://browser/skin/forget.svg",
      isAvailable: () => this.enabled,
    });
    WhimsyCommands.register(win, {
      id: "cmd_whimsyFireEverywhere",
      l10nId: "whimsy-fire-everything",
      // W10-30: straight to the surface's second step; nothing runs
      // until its red button.
      run: w => this.openPanel(w, { choice: "everything", confirm: true }),
      icon: "chrome://browser/skin/forget.svg",
      isAvailable: () => this.enabled,
    });
  },

  closableTabs(win, tabs) {
    return tabs.filter(tab => tab && !tab.pinned && !tab.hasAttribute("zen-essential") && !tab.closing);
  },

  // Closes tabs for good: no closed-tab entry (Cmd+Shift+T, Recently
  // Closed), no Archive entry (it skips skipSessionStore closes) and no
  // Undo. Returns how many closed.
  burnTabs(win, tabs, reason) {
    const closable = this.closableTabs(win, tabs);
    if (closable.length) {
      lazy.WhimsyUndo.runSuppressed(() =>
        win.gBrowser.removeTabs(closable, { animate: false, skipSessionStore: true }));
    }
    return closable.length;
  },

  // Forgets already-closed tabs and windows that `matches(tabState,
  // closedAt)` accepts, in every ordinary window, then writes the session
  // file so none of them stay on disk. wave9/secfix (security-full-1 H2):
  // the Archive's and Snooze's own stores too, so nothing burned can be
  // restored from History → Closed, View Archive or a snooze waking up.
  async purgeClosed(matches) {
    const SS = lazy.SessionStore;
    for (const w of Services.wm.getEnumerator("navigator:browser")) {
      if (w.closed || lazy.PrivateBrowsingUtils.isWindowPrivate(w)) {
        continue;
      }
      for (const item of SS.getClosedTabDataForWindow(w)) {
        if (matches(item.state ?? {}, item.closedAt ?? 0)) {
          try {
            SS.forgetClosedTabById(item.closedId, w);
          } catch (e) {
            console.error("Whimsy: fire forget closed tab", e);
          }
        }
      }
    }
    for (const winData of SS.getClosedWindowData()) {
      const tabs = [...(winData.tabs ?? []), ...(winData._closedTabs ?? []).map(item => item.state ?? {})];
      if (tabs.some(tab => matches(tab, winData.closedAt ?? 0))) {
        try {
          SS.forgetClosedWindowById(winData.closedId);
        } catch (e) {
          console.error("Whimsy: fire forget closed window", e);
        }
      }
    }
    try {
      await lazy.WhimsyArchive.purge(matches);
    } catch (e) {
      console.error("Whimsy: fire purge archive", e);
    }
    await lazy.SessionSaver.run();
  },

  // The profile (container id) the current space uses; 0 is Default.
  profileId(win) {
    return lazy.WhimsyProfiles.activeProfileId(win);
  },

  // The spaces using a profile, in Zen's order.
  profileSpaces(win, id = this.profileId(win)) {
    return lazy.WhimsyProfiles.spacesFor(id, win).filter(space => !space.whimsyScratch);
  },

  // Every tab, in every ordinary window, that lives in one of the profile's
  // spaces: [[window, tabs], ...].
  profileTabs(win, id = this.profileId(win)) {
    const uuids = new Set(this.profileSpaces(win, id).map(space => space.uuid));
    const result = [];
    for (const w of Services.wm.getEnumerator("navigator:browser")) {
      if (w.closed || !w.gBrowser || lazy.PrivateBrowsingUtils.isWindowPrivate(w)) {
        continue;
      }
      // Every space's tabs: gBrowser.tabs holds only the showing space's.
      // Not Zen's shared empty tab, which carries a space id too.
      const tabs = (w.gZenWorkspaces?.allStoredTabs ?? w.gBrowser.tabs).filter(t =>
        uuids.has(t.getAttribute("zen-workspace-id")) && !t.hasAttribute("zen-empty-tab"));
      if (tabs.length) {
        result.push([w, tabs]);
      }
    }
    return result;
  },

  // History visits of a profile since `since` (ms), as the History
  // profile filter sees them.
  async profileVisits(id, since) {
    const rows = await lazy.WhimsySpaceHistory.query({
      profile: lazy.WhimsyProfiles.keyFor(id), days: (Date.now() - since) / 86400000, limit: 100000,
    });
    return rows.filter(row => row.date.getTime() >= since);
  },

  // One visit, not the page: other profiles' visits to the same URL stay.
  removeVisit(visit) {
    const ms = visit.date.getTime();
    return lazy.PlacesUtils.history.removeVisitsByFilter({
      url: visit.url, beginDate: new Date(ms), endDate: new Date(ms + 1),
    });
  },

  // Cookies, site data and cache for one site (base domain, subdomains and
  // its partitioned third-party data), in one container only.
  clearSiteData(site, userContextId) {
    return new Promise(resolve => {
      Services.clearData.deleteDataFromSite(site, { userContextId, privateBrowsingId: 0 }, true, SITE_FLAGS, {
        onDataDeleted: resolve,
      });
    });
  },

  // The default: fire this profile. Removes its last hour of history,
  // clears the sites it touched in its container only, and closes the
  // unpinned tabs of its spaces. Returns what went, for the toast.
  async burnProfile(win) {
    const id = this.profileId(win);
    const since = Date.now() - LAST_HOUR_MS;
    const groups = this.profileTabs(win, id);
    const sites = new Set();
    for (const [, tabs] of groups) {
      for (const tab of tabs) {
        const site = (tab.lastAccessed || 0) >= since ? siteOf(tab) : null;
        if (site) {
          sites.add(site);
        }
      }
    }
    // H2: close and forget first, then clear. W10-58: the tabs go before
    // the history lookup (seconds on a busy profile), so the window answers
    // the button at once; run() says it's still clearing.
    let count = 0;
    for (const [w, tabs] of groups) {
      count += this.burnTabs(w, tabs, "profile");
    }
    const visits = await this.profileVisits(id, since);
    for (const visit of visits) {
      const site = siteOfURL(visit.url);
      if (site) {
        sites.add(site);
      }
    }
    await this.purgeClosed((tab, closedAt) => (tab.userContextId || 0) == id && closedAt >= since);
    await Promise.all([...sites].map(site => this.clearSiteData(site, id)));
    await Promise.all(visits.map(visit => this.removeVisit(visit)));
    return { count, visits: visits.length, sites: sites.size, profile: lazy.WhimsyProfiles.nameOf(id) };
  },

  // Form & search history (and search bar/find bar text), all time, with
  // Firefox's own Clear History item, so Fire Everywhere covers what Clear
  // All History does. Saved passwords and bookmarks aren't touched.
  clearFormHistory() {
    return lazy.Sanitizer.sanitize(["formdata"]);
  },

  // Every ordinary window's tabs: [[window, tabs], ...].
  allTabs() {
    const result = [];
    for (const w of Services.wm.getEnumerator("navigator:browser")) {
      if (!w.closed && w.gBrowser && !lazy.PrivateBrowsingUtils.isWindowPrivate(w)) {
        // Every space's tabs, not just the showing space's (gBrowser.tabs).
        result.push([w, (w.gZenWorkspaces?.allStoredTabs ?? w.gBrowser.tabs).filter(t => !t.hasAttribute("zen-empty-tab"))]);
      }
    }
    return result;
  },

  // Fire Everywhere: close every unpinned tab in every window, forget every
  // closed tab and window, then clear (H2: that order).
  async burnEverything(win) {
    let count = 0;
    for (const [w, tabs] of this.allTabs(win)) {
      count += this.burnTabs(w, tabs, "everything");
    }
    await this.purgeClosed(() => true);
    await this.clearData();
    await this.clearFormHistory();
    return count;
  },

  // "Forget About This Site…" (command bar): ForgetAboutSite takes the base
  // domain, so every subdomain's history and data go, and its tabs close.
  async burnSite(win) {
    const site = siteOf(win.gBrowser.selectedTab);
    if (!site) {
      return 0;
    }
    let count = 0;
    for (const [w, tabs] of this.allTabs(win)) {
      count += this.burnTabs(w, tabs.filter(t => siteOf(t) == site), "site");
    }
    await this.purgeClosed(tab => (tab.entries ?? []).some(entry => siteOfURL(entry.url) == site));
    await lazy.ForgetAboutSite.removeDataFromBaseDomain(site);
    return count;
  },

  // "Forget About This Site…": the Fire surface with the site chosen
  // (W10-30: it replaced the system dialog). Nothing runs until its button.
  forgetSite(win) {
    if (!siteOf(win.gBrowser.selectedTab)) {
      return null;
    }
    return this.openPanel(win, { choice: "site" });
  },

  // What each choice would close, for the cards' wording.
  counts(win) {
    const profileId = this.profileId(win);
    const sum = groups => groups.reduce((n, [w, tabs]) => n + this.closableTabs(w, tabs).length, 0);
    const tab = win.gBrowser.selectedTab;
    const site = lazy.PrivateBrowsingUtils.isWindowPrivate(win) ||
      lazy.PrivateBrowsingUtils.isBrowserPrivate(tab.linkedBrowser) ? null : siteOf(tab);
    return {
      profileId,
      profile: sum(this.profileTabs(win, profileId)),
      site,
      siteTabs: site ? sum(this.allTabs(win).map(([w, tabs]) => [w, tabs.filter(t => siteOf(t) == site)])) : 0,
      everything: sum(this.allTabs(win)),
    };
  },

  // W10-30: a WhimsySurface (the Edit Look family). "What should Fire
  // erase?" over three choice cards that say in full what each erases (the
  // user didn't know what Fire Everywhere or Forget About This Site do),
  // what's always kept, and one red button that names the choice. Fire
  // Everywhere asks once more inside the same surface (Back is the
  // default). Return on a card only chooses it.
  panel(win, { choice = "profile" } = {}) {
    const doc = win.document;
    const c = this.counts(win);
    if (choice == "site" && !c.site) {
      choice = "profile";
    }
    const lang = Services.locale.appLocalesAsBCP47;
    const spaces = new Intl.ListFormat(lang, { style: "long", type: "conjunction" })
      .format(this.profileSpaces(win, c.profileId).map(space => space.name).filter(Boolean));
    const profile = lazy.WhimsyProfiles.nameOf(c.profileId);

    let step = "choose";
    const parts = lazy.WhimsySurface.create(win, {
      id: PANEL_ID,
      width: PANEL_WIDTH,
      titleL10nId: "whimsy-fire-heading",
      close: true,
      footer: true,
      className: "whimsy-fire",
      // Esc on the second step goes Back.
      onEscape: () => {
        if (step == "confirm") {
          showChoose();
          return true;
        }
        return false;
      },
      initialFocus: () => step == "confirm" ? back : group.querySelector("[aria-checked='true']"),
    });
    const { panel, view, footer, title } = parts;
    panel._whimsyFire = { profile, counts: c };

    // Step 1: the choices.
    const choose = doc.createXULElement("vbox");
    choose.className = "whimsy-fire-step whimsy-fire-choose";
    const group = lazy.WhimsySurface.group(doc, { role: "radiogroup", label: title.id });
    group.classList.add("whimsy-fire-choices");
    const cards = [
      {
        value: "profile",
        nameL10nId: "whimsy-fire-choice-profile",
        nameArgs: { profile },
        detailL10nId: spaces ? "whimsy-fire-choice-profile-detail" : "whimsy-fire-choice-profile-detail-unnamed",
        detailArgs: { count: c.profile, ...(spaces ? { spaces } : {}) },
      },
      c.site && {
        value: "site",
        nameL10nId: "whimsy-fire-choice-site",
        nameArgs: { site: c.site },
        detailL10nId: "whimsy-fire-choice-site-detail",
        detailArgs: { site: c.site, count: c.siteTabs },
      },
      {
        value: "everything",
        tone: "destructive",
        nameL10nId: "whimsy-fire-choice-everything",
        detailL10nId: "whimsy-fire-choice-everything-detail",
        detailArgs: { count: c.everything },
      },
    ].filter(Boolean);
    for (const card of cards) {
      const el = lazy.WhimsySurface.choice(doc, {
        ...card,
        icon: ICONS[card.value],
        onPick: value => this.selectScope(win, panel, value),
      });
      el.classList.add("whimsy-fire-scope");
      el.setAttribute("whimsy-fire-scope", card.value);
      group.append(el);
    }
    // Return or Space on a card chooses it; it never runs anything.
    group.addEventListener("keydown", event => {
      const card = event.target.closest?.(".whimsy-fire-scope");
      if (card && (event.key == "Enter" || event.key == " ")) {
        event.preventDefault();
        event.stopPropagation();
        this.selectScope(win, panel, card.dataset.value);
      }
    });
    const kept = doc.createXULElement("hbox");
    kept.className = "whimsy-fire-kept";
    kept.setAttribute("align", "start");
    const check = doc.createXULElement("image");
    check.className = "whimsy-fire-kept-icon";
    check.setAttribute("src", "chrome://global/skin/icons/check.svg");
    const keptText = doc.createElementNS("http://www.w3.org/1999/xhtml", "p");
    keptText.id = "whimsy-fire-kept";
    doc.l10n.setAttributes(keptText, "whimsy-fire-kept");
    kept.append(check, keptText);
    choose.append(group, kept);

    // Step 2 (Fire Everywhere): one more question, in the same surface.
    const confirm = doc.createXULElement("hbox");
    confirm.className = "whimsy-fire-step whimsy-fire-confirm";
    confirm.setAttribute("align", "start");
    confirm.hidden = true;
    const confirmText = doc.createXULElement("vbox");
    confirmText.setAttribute("flex", "1");
    const confirmTitle = doc.createElementNS("http://www.w3.org/1999/xhtml", "h2");
    confirmTitle.id = "whimsy-fire-confirm-title";
    confirmTitle.className = "whimsy-fire-confirm-title";
    doc.l10n.setAttributes(confirmTitle, "whimsy-fire-everything-confirm-title");
    const confirmBody = doc.createElementNS("http://www.w3.org/1999/xhtml", "p");
    confirmBody.className = "whimsy-fire-confirm-body";
    doc.l10n.setAttributes(confirmBody, "whimsy-fire-everything-confirm-body", { count: c.everything });
    confirmText.append(confirmTitle, confirmBody);
    confirm.append(lazy.WhimsySurface.tile(doc, { icon: ICONS.everything, tone: "destructive" }), confirmText);
    view.append(choose, confirm);

    const cancel = lazy.WhimsySurface.footerButton(doc, {
      l10nId: "whimsy-fire-cancel",
      id: "whimsy-fire-cancel",
      onCommand: () => lazy.WhimsySurface.close(panel),
    });
    const forget = lazy.WhimsySurface.footerButton(doc, {
      l10nId: "whimsy-fire-run-profile",
      id: "whimsy-fire-forget",
      destructive: true,
      onCommand: () => this.forget(win, panel),
    });
    const back = lazy.WhimsySurface.footerButton(doc, {
      l10nId: "whimsy-fire-back",
      id: "whimsy-fire-back",
      primary: true,
      onCommand: () => showChoose(),
    });
    const accept = lazy.WhimsySurface.footerButton(doc, {
      l10nId: "whimsy-fire-everything-confirm-accept",
      id: "whimsy-fire-everything-accept",
      destructive: true,
      onCommand: () => {
        lazy.WhimsySurface.close(panel);
        this.run(win, () => this.burnEverything(win), "everything");
      },
    });
    back.hidden = true;
    accept.hidden = true;
    footer.append(cancel, forget, back, accept);
    lazy.WhimsySurface.finish(parts);

    const showChoose = () => {
      step = "choose";
      panel.dataset.step = step;
      title.hidden = false;
      choose.hidden = false;
      confirm.hidden = true;
      cancel.hidden = forget.hidden = false;
      back.hidden = accept.hidden = true;
      panel.setAttribute("aria-labelledby", title.id);
      group.querySelector("[aria-checked='true']")?.focus();
    };
    const showConfirm = () => {
      step = "confirm";
      panel.dataset.step = step;
      title.hidden = true;
      choose.hidden = true;
      confirm.hidden = false;
      cancel.hidden = forget.hidden = true;
      back.hidden = accept.hidden = false;
      panel.setAttribute("aria-labelledby", confirmTitle.id);
      if (panel.state == "open") {
        back.focus();
      }
    };
    panel._whimsyFireConfirm = showConfirm;
    panel._whimsyFireChoose = showChoose;
    this.selectScope(win, panel, choice);
    return panel;
  },

  // Marks one choice, and names it on the red button.
  selectScope(win, panel, id) {
    const doc = win.document;
    const group = panel.querySelector(".whimsy-fire-choices");
    lazy.WhimsySurface.check(group, id);
    panel.dataset.scope = id;
    const forget = panel.querySelector("#whimsy-fire-forget");
    const site = panel._whimsyFire?.counts.site;
    doc.l10n.setAttributes(forget, `whimsy-fire-run-${id}`, id == "site" ? { site } : undefined);
    if (panel.state == "open") {
      group.querySelector(`[data-value="${id}"]`)?.focus();
    }
  },

  // Says it's clearing at once, runs, then the same toast says what went
  // (or that it failed, with Try Again). W10-58: clearing a busy profile
  // takes seconds, and the only confirmation used to come long after the
  // tabs vanished and leave after Zen's two seconds. W10-30: the result
  // has a title and a second line (WhimsyToast, 6s, held while hovered or
  // while the window is behind), in the window that ran it.
  async run(win, burn, kind, args = {}) {
    kind = kind.replace(/^whimsy-fire-done-/, "");
    const root = win.document.documentElement;
    // A brief flame/burst overlay (whimsy-browser.css); reduced motion
    // skips it, and the toast confirms.
    root.setAttribute("whimsy-fire-burning", "");
    win.setTimeout(() => root.removeAttribute("whimsy-fire-burning"), 700);
    const icon = ICONS[kind] ?? ICONS.everything;
    const working = lazy.WhimsyToast.show(win, {
      l10nId: `whimsy-fire-working-${kind}`,
      l10nArgs: args,
      icon,
      timeout: WORKING_TIMEOUT_MS,
    });
    // The result goes on the "Clearing…" toast if it's still up; else (a
    // window that lost every tab gets a fresh one first) a new one, a tick
    // later.
    const report = async o => {
      if (working?.isConnected && !working.hasAttribute("leaving")) {
        working.update({ ...o, detail: undefined, timeout: DONE_TIMEOUT_MS });
        return working;
      }
      await new Promise(resolve => win.setTimeout(resolve, 0));
      return win.closed ? null : lazy.WhimsyToast.show(win, { ...o, icon, timeout: DONE_TIMEOUT_MS });
    };
    let result;
    try {
      result = (await burn()) || 0;
    } catch (e) {
      console.error("Whimsy: fire button", e);
      await report({
        l10nId: "whimsy-fire-failed-title",
        detailL10nId: "whimsy-fire-failed-detail",
        action: {
          l10nId: "whimsy-fire-retry",
          onCommand: () => {
            this.run(win, burn, kind, args);
          },
        },
      });
      return;
    }
    // A burn returns the tabs it closed, or { count, ...what else went }.
    const what = typeof result == "number" ? { count: result } : result;
    const l10nArgs = { ...args, ...what };
    await report({
      l10nId: `whimsy-fire-done-${kind}-title`,
      l10nArgs,
      detailL10nId: `whimsy-fire-done-${kind}-detail`,
      detailArgs: l10nArgs,
      action: null,
    });
  },

  // The red footer button: Fire Everywhere goes to the second step; the
  // others close the surface and run.
  async forget(win, panel) {
    const id = panel.dataset.scope;
    if (id == "everything") {
      panel._whimsyFireConfirm?.();
      return;
    }
    lazy.WhimsySurface.close(panel);
    if (id == "site") {
      const site = panel._whimsyFire?.counts.site;
      if (site) {
        await this.run(win, () => this.burnSite(win), "site", { site });
      }
      return;
    }
    await this.run(win, () => this.burnProfile(win), "profile");
  },

  // Opens the surface: under `anchor` when given, else over the page where
  // the command bar sits. `choice` picks the starting card; `confirm`
  // opens Fire Everywhere's second step.
  openPanel(win, { choice = "profile", confirm = false, anchor = null, triggerEvent = null } = {}) {
    const panel = this.panel(win, { choice });
    if (confirm) {
      panel._whimsyFireConfirm();
    }
    if (anchor) {
      lazy.WhimsySurface.open(win, panel, { anchor, position: "after_start", y: 6, triggerEvent });
    } else {
      lazy.WhimsySurface.open(win, panel, { at: "page-top-center", triggerEvent });
    }
    return panel;
  },
};
