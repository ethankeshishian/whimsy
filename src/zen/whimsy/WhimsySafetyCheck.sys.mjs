/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// W29 safety-check: Settings → Privacy & Security → Safety Check, a card
// that checks four things that most often go wrong, on this device only:
// whether an update is staged, whether a saved password appears in a known
// data breach, whether an extension can read every site and isn't from
// addons.mozilla.org (or is blocklisted), and whether a site holding
// camera/microphone/location/notification/screen-sharing access hasn't
// been visited in 90 days. Nothing is sent anywhere.

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  WhimsyUpdates: "resource:///modules/whimsy/WhimsyUpdates.sys.mjs",
  LoginBreaches: "moz-src:///browser/components/aboutlogins/LoginBreaches.sys.mjs",
  LoginHelper: "resource://gre/modules/LoginHelper.sys.mjs",
  AddonManager: "resource://gre/modules/AddonManager.sys.mjs",
  SitePermissions: "resource:///modules/SitePermissions.sys.mjs",
  PlacesUtils: "resource://gre/modules/PlacesUtils.sys.mjs",
});

// Design's "Unused window" default (S.4 open question 3, resolved to the
// recommended 90 days).
const UNUSED_DAYS = 90;
// Design S.4: camera, microphone, location, notifications, screen sharing.
const PERMISSION_TYPES = ["camera", "microphone", "geo", "desktop-notification", "screen"];
// Short nouns for the card's detail line and the sheet's rows (mockup's
// "Camera and microphone", "Location · last visited in March"), not
// SitePermissions.getPermissionLabel's full sentences ("Use the camera").
const PERMISSION_LABELS = {
  camera: "camera",
  microphone: "microphone",
  geo: "location",
  "desktop-notification": "notifications",
  screen: "screen sharing",
};
const AMO_HOST_RE = /(^|\.)addons\.mozilla\.org$/;

export const WhimsySafetyCheck = {
  UNUSED_DAYS,
  PERMISSION_TYPES,

  // Overridable for tests: each defaults to the real lazy module below, so
  // a test only needs to replace the one check it's exercising.
  _lastVisit: null,
  _readUpdates: null,
  _getLogins: null,
  _getBreaches: null,
  _getAddons: null,

  // Four results, always computed in this fixed order (Updates, Passwords,
  // Extensions, Site permissions), though the rows always render in that
  // order regardless of which finish first.
  async run() {
    const [updates, passwords, extensions, permissions] = await Promise.all([
      this.checkUpdates(),
      this.checkPasswords(),
      this.checkExtensions(),
      this.checkPermissions(),
    ]);
    return { updates, passwords, extensions, permissions };
  },

  async checkUpdates() {
    const [state, version] = this._readUpdates
      ? await this._readUpdates()
      : await Promise.all([lazy.WhimsyUpdates.readState(), lazy.WhimsyUpdates.readVersion()]);
    if (state?.staged?.version) {
      return { status: "warn", version: state.staged.version };
    }
    return {
      status: "ok",
      version: version.version,
      installedAt: state?.installed?.installed_at ?? null,
    };
  },

  async checkPasswords() {
    const logins = this._getLogins ? await this._getLogins() : await lazy.LoginHelper.getAllUserFacingLogins();
    if (!logins.length) {
      return { status: "ok", count: 0 };
    }
    const breaches = this._getBreaches
      ? await this._getBreaches(logins)
      : await lazy.LoginBreaches.getPotentialBreachesByLoginGUID(logins);
    const breached = logins.filter(l => breaches.has(l.guid));
    if (!breached.length) {
      return { status: "ok", count: logins.length };
    }
    return {
      status: "warn",
      count: breached.length,
      sites: [...new Set(breached.map(l => l.origin))],
    };
  },

  async checkExtensions() {
    const addons = this._getAddons ? await this._getAddons() : await lazy.AddonManager.getAddonsByTypes(["extension"]);
    const visible = addons.filter(a => !a.hidden);
    const flagged = [];
    for (const addon of visible) {
      const blocklisted = addon.blocklistState !== Ci.nsIBlocklistService.STATE_NOT_BLOCKED;
      const readsEverySite = !!addon.userPermissions?.origins?.includes("<all_urls>");
      const fromAMO = !!(addon.sourceURI && AMO_HOST_RE.test(addon.sourceURI.host ?? ""));
      if (blocklisted || (readsEverySite && !fromAMO)) {
        flagged.push({ id: addon.id, name: addon.name });
      }
    }
    if (!flagged.length) {
      return { status: "ok", count: visible.length };
    }
    return { status: "warn", count: flagged.length, first: flagged[0] };
  },

  async checkPermissions() {
    const unused = await this.getUnusedPermissions();
    if (!unused.length) {
      return { status: "ok" };
    }
    // Services.perms.all's enumeration order isn't meaningful; always list
    // the flagged types in PERMISSION_TYPES's fixed order (the mockup's
    // "Camera, location, and notifications"), not whatever order they were
    // found in.
    const present = new Set(unused.flatMap(site => site.types));
    const types = PERMISSION_TYPES.filter(t => present.has(t));
    return { status: "warn", count: unused.length, typesText: this.formatPermissionList(types) };
  },

  // Every allowed camera/microphone/location/notification/screen-sharing
  // permission on a site not visited in UNUSED_DAYS days, one entry per
  // site. SitePermissions only enumerates per-principal/browser, so this
  // walks Services.perms.all directly, the way LoginManager.sys.mjs and
  // ClearDataService.sys.mjs do.
  async getUnusedPermissions() {
    const cutoffMs = Date.now() - UNUSED_DAYS * 24 * 60 * 60 * 1000;
    const bySite = new Map();
    for (const perm of Services.perms.all) {
      if (perm.capability != Services.perms.ALLOW_ACTION || !PERMISSION_TYPES.includes(perm.type)) {
        continue;
      }
      let host;
      try {
        host = perm.principal.URI?.host;
      } catch {
        host = null;
      }
      if (!host) {
        continue;
      }
      const lastVisitMs = await this.lastVisit(host);
      if (lastVisitMs !== null && lastVisitMs >= cutoffMs) {
        continue;
      }
      const origin = perm.principal.origin;
      if (!bySite.has(origin)) {
        bySite.set(origin, { origin, host, principal: perm.principal, types: [], lastVisitMs });
      }
      const site = bySite.get(origin);
      if (!site.types.includes(perm.type)) {
        site.types.push(perm.type);
      }
    }
    // Services.perms.all's enumeration order isn't meaningful; always list
    // each site's own types in PERMISSION_TYPES's fixed order too.
    for (const site of bySite.values()) {
      site.types.sort((a, b) => PERMISSION_TYPES.indexOf(a) - PERMISSION_TYPES.indexOf(b));
    }
    return [...bySite.values()];
  },

  // Adapted from WhimsyScamCheck.sys.mjs's visits(host): the host's most
  // recent visit, in milliseconds since epoch, or null if never visited.
  async lastVisit(host) {
    if (this._lastVisit) {
      return this._lastVisit(host);
    }
    try {
      const db = await lazy.PlacesUtils.promiseDBConnection();
      const rev = `${[...host].reverse().join("")}.`;
      const rows = await db.execute(
        `SELECT MAX(last_visit_date) AS lv FROM moz_historyvisits v JOIN moz_places h ON h.id = v.place_id
         WHERE h.rev_host = :rev`,
        { rev }
      );
      const lv = rows[0]?.getResultByName("lv");
      return lv ? Math.floor(lv / 1000) : null;
    } catch {
      return null;
    }
  },

  // "camera", "microphone" (unjoined; the caller is almost always about to
  // join or render one at a time).
  permissionLabel(type) {
    return PERMISSION_LABELS[type] ?? type;
  },

  // "Camera and microphone", "Camera, location, and notifications" (no
  // trailing period: callers like the sheet row and the card's detail line
  // add their own).
  formatPermissionList(types) {
    const labels = types.map(t => this.permissionLabel(t));
    const joined = new Intl.ListFormat(Services.locale.appLocalesAsBCP47[0] ?? "en", {
      type: "conjunction",
    }).format(labels);
    return joined.charAt(0).toUpperCase() + joined.slice(1);
  },

  removePermissions(principal, types) {
    for (const type of types) {
      lazy.SitePermissions.removeFromPrincipal(principal, type);
    }
  },
};
