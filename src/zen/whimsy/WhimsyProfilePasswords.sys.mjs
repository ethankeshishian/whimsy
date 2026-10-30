/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// wave5/profiles, phase 2: saved passwords per profile (Arc: each profile
// has its own passwords). Firefox keeps one login store for every
// container, so a login carries its profile as a tag and the password
// manager only looks at the page's profile:
//
// - Autofill, the login autocomplete list and the save/update prompt all
//   find logins through LoginManagerParent.searchAndDedupeLogins(formOrigin).
//   Its four callers (public instance methods, all given that formOrigin)
//   are wrapped to note "formOrigin → this page's profile" for the length of
//   the call; the wrapped search keeps that profile's logins only. If two
//   profiles ask about the same origin at the same instant, the search
//   returns nothing rather than risk the other profile's login.
// - A login saved from a page gets the page's profile right after it's added.
//
// The tag lives in the login's `unknownFields` (a JSON string of extra
// record fields that Firefox Sync uploads as top-level fields and keeps when
// it downloads them), as `whimsyProfile: <profile key>`, so it syncs to
// Whimsy on other devices and stock Firefox keeps it intact. A sidecar file
// (guid → key) backs it locally, which is all there is when Firefox's Rust
// login store is active (it doesn't expose unknownFields to JS). Untagged
// logins — everything saved before profiles — are Default's. Changing only
// unknownFields doesn't mark a login for upload, so a new login is tagged
// before its first upload, and re-tagging an old one travels with its next
// real change. Not covered: HTTP-auth prompts and about:logins, which still
// list every login.

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  JSONFile: "resource://gre/modules/JSONFile.sys.mjs",
  LoginHelper: "resource://gre/modules/LoginHelper.sys.mjs",
  LoginManagerParent: "resource://gre/modules/LoginManagerParent.sys.mjs",
  WhimsyProfiles: "resource:///modules/whimsy/WhimsyProfiles.sys.mjs",
});

export const TAG = "whimsyProfile";
const FILE_NAME = "whimsy-login-profiles.json";
// A save prompt can sit open for a while before the person answers it.
const PENDING_MS = 30 * 60 * 1000;

export const WhimsyProfilePasswords = {
  QueryInterface: ChromeUtils.generateQI(["nsIObserver", "nsISupportsWeakReference"]),
  TAG,
  // formOrigin → Map(profile key → number of calls in flight)
  _active: new Map(),
  // formOrigin → { key, time } of the last prompt shown there
  _pending: new Map(),

  get enabled() {
    return lazy.WhimsyProfiles.enabled;
  },

  get rustStore() {
    return Services.prefs.getBoolPref("signon.storage.rust.active", false);
  },

  // -- the tag -----------------------------------------------------------

  file() {
    if (!this._file) {
      this._file = new lazy.JSONFile({
        path: PathUtils.join(PathUtils.profileDir, FILE_NAME),
        dataPostProcessor: data => ({ logins: data?.logins || {} }),
      });
      this._file.ensureDataReady();
    }
    return this._file;
  },

  parseUnknown(login) {
    try {
      const parsed = login.unknownFields ? JSON.parse(login.unknownFields) : null;
      return parsed && typeof parsed == "object" ? parsed : {};
    } catch {
      return {};
    }
  },

  /** The profile key a login belongs to. */
  keyOfLogin(login) {
    login.QueryInterface?.(Ci.nsILoginMetaInfo);
    const synced = this.parseUnknown(login)[TAG];
    if (typeof synced == "string" && synced) {
      return synced;
    }
    return this.file().data.logins[login.guid] || lazy.WhimsyProfiles.DEFAULT_KEY;
  },

  /** Gives a stored login to a profile (by key). */
  async tag(login, key) {
    login.QueryInterface(Ci.nsILoginMetaInfo);
    const file = this.file();
    const isDefault = !key || key == lazy.WhimsyProfiles.DEFAULT_KEY;
    if (isDefault) {
      delete file.data.logins[login.guid];
    } else {
      file.data.logins[login.guid] = key;
    }
    file.saveSoon();
    if (this.rustStore) {
      return;
    }
    const fields = this.parseUnknown(login);
    if (isDefault ? !(TAG in fields) : fields[TAG] == key) {
      return;
    }
    if (isDefault) {
      delete fields[TAG];
    } else {
      fields[TAG] = key;
    }
    const unknownFields = Object.keys(fields).length ? JSON.stringify(fields) : null;
    await Services.logins.modifyLoginAsync(login,
      lazy.LoginHelper.newPropertyBag({ unknownFields }));
  },

  // -- scoping LoginManagerParent ------------------------------------------

  keyForActor(actor, browser = null) {
    let context = null;
    try {
      context = actor.getBrowsingContextToUse?.() ?? actor.browsingContext;
    } catch {}
    const id = context?.originAttributes?.userContextId ??
      browser?.browsingContext?.originAttributes?.userContextId ?? 0;
    return lazy.WhimsyProfiles.keyFor(id);
  },

  enter(origin, key) {
    let keys = this._active.get(origin);
    if (!keys) {
      keys = new Map();
      this._active.set(origin, keys);
    }
    keys.set(key, (keys.get(key) ?? 0) + 1);
  },

  leave(origin, key) {
    const keys = this._active.get(origin);
    if (!keys) {
      return;
    }
    const count = (keys.get(key) ?? 1) - 1;
    if (count > 0) {
      keys.set(key, count);
    } else {
      keys.delete(key);
    }
    if (!keys.size) {
      this._active.delete(origin);
    }
  },

  /** Keeps only the logins of the profile asking about `origin`. */
  filter(origin, logins) {
    const keys = this._active.get(origin);
    if (!this.enabled || !keys?.size) {
      return logins;
    }
    if (keys.size != 1) {
      return [];
    }
    const [key] = keys.keys();
    return logins.filter(login => this.keyOfLogin(login) == key);
  },

  wrapLoginManager() {
    const LMP = lazy.LoginManagerParent;
    if (LMP._whimsyProfiles) {
      return;
    }
    LMP._whimsyProfiles = true;
    const self = this;
    const search = LMP.searchAndDedupeLogins;
    LMP.searchAndDedupeLogins = async function (formOrigin, ...rest) {
      const logins = await search.call(this, formOrigin, ...rest);
      return self.filter(formOrigin, logins);
    };
    // [method, index of formOrigin, index of browser (or -1), records a save prompt]
    const methods = [
      ["sendLoginDataToChild", 0, -1, false],
      ["doAutocompleteSearch", 0, -1, false],
      ["showDoorhanger", 1, 0, true],
      ["_onPasswordEditedOrGenerated", 1, 0, true],
    ];
    for (const [name, originIndex, browserIndex, prompts] of methods) {
      const original = LMP.prototype[name];
      if (typeof original != "function") {
        console.error(`Whimsy: LoginManagerParent.${name} is gone; passwords aren't scoped there`);
        continue;
      }
      LMP.prototype[name] = async function (...args) {
        const origin = args[originIndex];
        if (!self.enabled || typeof origin != "string") {
          return original.apply(this, args);
        }
        const key = self.keyForActor(this, browserIndex >= 0 ? args[browserIndex] : null);
        if (prompts) {
          self._pending.set(origin, { key, time: Date.now() });
        }
        self.enter(origin, key);
        try {
          return await original.apply(this, args);
        } finally {
          self.leave(origin, key);
        }
      };
    }
  },

  // A login saved from a page: give it the profile that page's prompt was
  // shown in. Login origins and form origins are the same string.
  async onLoginAdded(login) {
    login.QueryInterface(Ci.nsILoginMetaInfo);
    const pending = this._pending.get(login.origin);
    if (!pending || Date.now() - pending.time > PENDING_MS ||
        pending.key == lazy.WhimsyProfiles.DEFAULT_KEY) {
      return;
    }
    const [stored] = await Services.logins.searchLoginsAsync({
      guid: login.guid,
      origin: login.origin,
    });
    if (stored) {
      await this.tag(stored, pending.key);
    }
  },

  observe(subject, topic, data) {
    if (topic != "passwordmgr-storage-changed") {
      return;
    }
    if (data == "addLogin" && this.enabled) {
      this.onLoginAdded(subject).catch(e => console.error("Whimsy: tag login", e));
    } else if (data == "removeLogin") {
      subject.QueryInterface(Ci.nsILoginMetaInfo);
      const file = this.file();
      if (subject.guid in file.data.logins) {
        delete file.data.logins[subject.guid];
        file.saveSoon();
      }
    }
  },

  /** Deletes every login of a profile (the profile is being deleted). */
  async removeProfile(key) {
    if (!key || key == lazy.WhimsyProfiles.DEFAULT_KEY) {
      return;
    }
    for (const login of await Services.logins.getAllLogins()) {
      if (this.keyOfLogin(login) == key) {
        await Services.logins.removeLoginAsync(login);
      }
    }
  },

  init() {
    if (this._initialized) {
      return;
    }
    this._initialized = true;
    this.wrapLoginManager();
    Services.obs.addObserver(this, "passwordmgr-storage-changed");
    lazy.WhimsyProfiles.onDelete((id, key) => this.removeProfile(key));
  },
};
