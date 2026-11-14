/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#ifndef mozilla_WhimsyPasskeyService_h
#define mozilla_WhimsyPasskeyService_h

#include "nsIWebAuthnService.h"
#include "nsCOMPtr.h"

// W26 passkeys: Whimsy's own platform authenticator for macOS, used by
// WebAuthnService when Apple's passkey API isn't available to this build
// (src/dom/webauthn/whimsy-WebAuthnService-h.patch). The keys live in the
// Secure Enclave behind Touch ID or the Mac password; the policy, the
// store, and the prompt are in WhimsyPasskeys.sys.mjs. Requests that
// aren't for a platform passkey are handed to authenticator-rs untouched.

namespace mozilla::dom {

// Returns Whimsy's service when the whimsy.feature.passkeys switch is on,
// else nullptr. aAuthrs is the authenticator-rs service the transactions
// Whimsy doesn't take are delegated to.
already_AddRefed<nsIWebAuthnService> NewWhimsyPasskeyServiceIfEnabled(
    nsIWebAuthnService* aAuthrs);

// WebAuthnService::GetAutoFillEntries knows which tab asked but
// nsIWebAuthnService.getAutoFillEntriesForRpId doesn't carry it; the
// one-line whimsy-WebAuthnService-cpp.patch notes it here first so the
// autocomplete list only shows the asking profile's passkeys.
void WhimsyPasskeyNoteAutoFillContext(uint64_t aBrowsingContextId);

}  // namespace mozilla::dom

#endif  // mozilla_WhimsyPasskeyService_h
