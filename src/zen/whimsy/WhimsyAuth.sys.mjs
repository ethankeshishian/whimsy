/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// W11-17: one way to ask for Touch ID or the Mac password, shared by Lock
// Space and (W11-14) the private lock.
//
// Lock Space used OSKeyStore.ensureLoggedIn(true). OSKeyStore only takes
// `false` or a non-empty prompt string and throws on `true`; the catch
// returned false, so a locked space never opened. OSKeyStore is also the
// wrong tool: it wraps a Keychain secret (and may generate one) for
// encrypting saved data, and only reauthenticates on the side. This calls
// Firefox's OSReauthenticator directly, the same service OSKeyStore and
// about:logins use: on macOS that is LocalAuthentication's
// deviceOwnerAuthentication (Touch ID, an Apple Watch, or the password).
//
// unlock() resolves to "ok", "cancel" (cancelled or failed; macOS doesn't
// tell them apart) or "unavailable" (no OS authentication on this
// platform). Calls while one prompt is up share it.

import { AppConstants } from "resource://gre/modules/AppConstants.sys.mjs";

const lazy = {};
ChromeUtils.defineLazyGetter(lazy, "l10n", () => new Localization(["branding/brand.ftl", "browser/whimsy.ftl"], true));

let pending = null;

export const WhimsyAuth = {
  // Tests replace this with a stand-in ({ asyncReauthenticateUser }).
  _reauthenticator: null,

  get reauthenticator() {
    return this._reauthenticator ??
      Cc["@mozilla.org/security/osreauthenticator;1"].getService(Ci.nsIOSReauthenticator);
  },

  available() {
    return !!this._reauthenticator || AppConstants.platform == "macosx" || AppConstants.platform == "win";
  },

  /**
   * Asks for Touch ID or the Mac password.
   *
   * @param {Window} win - the window the system prompt belongs to
   * @param {string} reasonL10nId - completes "Whimsy is trying to …"
   * @param {object} [args] - Fluent arguments for the reason
   * @returns {Promise<"ok"|"cancel"|"unavailable">}
   */
  unlock(win, reasonL10nId, args = undefined) {
    if (!this.available()) {
      return Promise.resolve("unavailable");
    }
    if (pending) {
      return pending;
    }
    pending = (async () => {
      try {
        const [reason, caption] = lazy.l10n.formatValuesSync([
          { id: reasonL10nId, args },
          { id: "whimsy-auth-caption" },
        ]);
        const result = await this.reauthenticator.asyncReauthenticateUser(reason, caption, win ?? null);
        // macOS resolves [authenticated, isBlankPassword, ...]; Windows
        // rejects on cancel.
        return (Array.isArray(result) ? result[0] : result) ? "ok" : "cancel";
      } catch (e) {
        return "cancel";
      } finally {
        pending = null;
      }
    })();
    return pending;
  },
};
