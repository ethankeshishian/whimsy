/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// W26 passkeys: the nsIWebAuthnService Gecko's WebAuthnService hands
// platform requests to on a Mac where Apple's passkey API isn't available
// (see WhimsyPasskeyService.h). Thin by design: every request is copied
// into a JSON record and given to WhimsyPasskeys.sys.mjs, which owns the
// store, the routing, the prompt and the Secure Enclave helper, and
// answers through nsIWhimsyPasskeyCallback. A request that isn't for one
// of Whimsy's passkeys is delegated, with its original arguments, to the
// authenticator-rs service (USB security keys), so YubiKey users see
// exactly what they saw before.

#include "mozilla/WhimsyPasskeyService.h"

#include "mozilla/Base64.h"
#include "mozilla/JSONStringWriteFuncs.h"
#include "mozilla/JSONWriter.h"
#include "mozilla/Maybe.h"
#include "mozilla/Preferences.h"
#include "mozilla/dom/BrowsingContext.h"
#include "mozilla/dom/WebAuthnEnumStrings.h"
#include "nsIWebAuthnArgs.h"
#include "nsIWebAuthnPromise.h"
#include "nsIWebAuthnResult.h"
#include "nsIWhimsyPasskeys.h"
#include "nsServiceManagerUtils.h"
#include "nsString.h"
#include "nsTArray.h"
#include "nsThreadUtils.h"

namespace mozilla::dom {

namespace {

constexpr const char* kFeaturePref = "whimsy.feature.passkeys";
constexpr const char* kFrontEndContract = "@whimsy/passkeys;1";

// The tab behind the autocomplete request in flight (see the header).
uint64_t sAutoFillBrowsingContextId = 0;

nsCString Base64Url(const nsTArray<uint8_t>& aBytes) {
  nsAutoCString out;
  if (NS_FAILED(Base64URLEncode(aBytes.Length(), aBytes.Elements(),
                                Base64URLEncodePaddingPolicy::Omit, out))) {
    out.Truncate();
  }
  return std::move(out);
}

// The container the request's tab belongs to: Whimsy profiles are Firefox
// containers, and the front end keeps each profile's passkeys apart.
uint32_t UserContextIdOf(uint64_t aBrowsingContextId) {
  RefPtr<BrowsingContext> bc = BrowsingContext::Get(aBrowsingContextId);
  if (!bc) {
    return 0;
  }
  BrowsingContext* top = bc->Top();
  return top ? top->OriginAttributesRef().mUserContextId
             : bc->OriginAttributesRef().mUserContextId;
}

// What the site asked for, as WhimsyPasskeys.sys.mjs reads it
// (`request.rpId`, `request.excludeList`, ...). Bytes are base64url.
void SerializeRegisterArgs(nsIWebAuthnRegisterArgs* aArgs,
                           uint64_t aBrowsingContextId, nsACString& aJson) {
  JSONStringRefWriteFunc f(aJson);
  JSONWriter w(f, JSONWriter::CollectionStyle::SingleLineStyle);
  w.Start();
  nsString str;
  nsTArray<uint8_t> bytes;
  bool flag = false;
  uint32_t number = 0;

  (void)aArgs->GetOrigin(str);
  w.StringProperty("origin", NS_ConvertUTF16toUTF8(str));
  (void)aArgs->GetRpId(str);
  w.StringProperty("rpId", NS_ConvertUTF16toUTF8(str));
  str.Truncate();
  (void)aArgs->GetRpName(str);
  w.StringProperty("rpName", NS_ConvertUTF16toUTF8(str));
  (void)aArgs->GetClientDataHash(bytes);
  w.StringProperty("clientDataHash", Base64Url(bytes));
  bytes.Clear();
  (void)aArgs->GetUserId(bytes);
  w.StringProperty("userId", Base64Url(bytes));
  str.Truncate();
  (void)aArgs->GetUserName(str);
  w.StringProperty("userName", NS_ConvertUTF16toUTF8(str));
  str.Truncate();
  (void)aArgs->GetUserDisplayName(str);
  w.StringProperty("userDisplayName", NS_ConvertUTF16toUTF8(str));

  nsTArray<int32_t> algs;
  (void)aArgs->GetCoseAlgs(algs);
  w.StartArrayProperty("coseAlgs");
  for (int32_t alg : algs) {
    w.IntElement(alg);
  }
  w.EndArray();

  nsTArray<nsTArray<uint8_t>> excludeList;
  (void)aArgs->GetExcludeList(excludeList);
  w.StartArrayProperty("excludeList");
  for (const auto& id : excludeList) {
    w.StringElement(Base64Url(id));
  }
  w.EndArray();

  flag = false;
  (void)aArgs->GetCredProps(&flag);
  w.BoolProperty("credProps", flag);
  str.Truncate();
  (void)aArgs->GetResidentKey(str);
  w.StringProperty("residentKey", NS_ConvertUTF16toUTF8(str));
  str.Truncate();
  (void)aArgs->GetUserVerification(str);
  w.StringProperty("userVerification", NS_ConvertUTF16toUTF8(str));
  str.Truncate();
  (void)aArgs->GetAuthenticatorAttachment(str);
  w.StringProperty("authenticatorAttachment", NS_ConvertUTF16toUTF8(str));
  str.Truncate();
  (void)aArgs->GetAttestationConveyancePreference(str);
  w.StringProperty("attestation", NS_ConvertUTF16toUTF8(str));
  (void)aArgs->GetTimeoutMS(&number);
  w.IntProperty("timeoutMS", number);
  flag = false;
  (void)aArgs->GetPrivateBrowsing(&flag);
  w.BoolProperty("privateBrowsing", flag);
  w.IntProperty("userContextId", UserContextIdOf(aBrowsingContextId));
  w.End();
}

void SerializeSignArgs(nsIWebAuthnSignArgs* aArgs, uint64_t aBrowsingContextId,
                       nsACString& aJson) {
  JSONStringRefWriteFunc f(aJson);
  JSONWriter w(f, JSONWriter::CollectionStyle::SingleLineStyle);
  w.Start();
  nsString str;
  nsTArray<uint8_t> bytes;
  bool flag = false;
  uint32_t number = 0;

  (void)aArgs->GetOrigin(str);
  w.StringProperty("origin", NS_ConvertUTF16toUTF8(str));
  (void)aArgs->GetRpId(str);
  w.StringProperty("rpId", NS_ConvertUTF16toUTF8(str));
  (void)aArgs->GetClientDataHash(bytes);
  w.StringProperty("clientDataHash", Base64Url(bytes));

  nsTArray<nsTArray<uint8_t>> allowList;
  (void)aArgs->GetAllowList(allowList);
  w.StartArrayProperty("allowList");
  for (const auto& id : allowList) {
    w.StringElement(Base64Url(id));
  }
  w.EndArray();

  str.Truncate();
  (void)aArgs->GetUserVerification(str);
  w.StringProperty("userVerification", NS_ConvertUTF16toUTF8(str));
  (void)aArgs->GetTimeoutMS(&number);
  w.IntProperty("timeoutMS", number);
  flag = false;
  (void)aArgs->GetConditionallyMediated(&flag);
  w.BoolProperty("conditionallyMediated", flag);
  flag = false;
  (void)aArgs->GetPrivateBrowsing(&flag);
  w.BoolProperty("privateBrowsing", flag);
  // The FIDO AppID extension names a U2F key; none of ours.
  str.Truncate();
  w.BoolProperty("appId", NS_SUCCEEDED(aArgs->GetAppId(str)));
  w.IntProperty("userContextId", UserContextIdOf(aBrowsingContextId));
  w.End();
}

// ---------------------------------------------------------------------------
// Results. Sites see a plain platform passkey: attestation "none" (built by
// the front end, nothing identifying in it, so no consent prompt is
// needed and attestationConsentPromptShown says so), transport internal.

class WhimsyRegisterResult final : public nsIWebAuthnRegisterResult {
 public:
  NS_DECL_THREADSAFE_ISUPPORTS
  NS_DECL_NSIWEBAUTHNREGISTERRESULT

  WhimsyRegisterResult(const nsTArray<uint8_t>& aAttestationObject,
                       const nsTArray<uint8_t>& aCredentialId,
                       bool aCredPropsRequested)
      : mCredPropsRk(aCredPropsRequested ? Some(true) : Nothing()) {
    mAttestationObject.Assign(aAttestationObject);
    mCredentialId.Assign(aCredentialId);
  }

 private:
  ~WhimsyRegisterResult() = default;

  nsTArray<uint8_t> mAttestationObject;
  nsTArray<uint8_t> mCredentialId;
  Maybe<bool> mCredPropsRk;
};

NS_IMPL_ISUPPORTS(WhimsyRegisterResult, nsIWebAuthnRegisterResult)

NS_IMETHODIMP
WhimsyRegisterResult::GetClientDataJSON(nsACString& aClientDataJSON) {
  // The parent built clientDataJSON itself and keeps it.
  return NS_ERROR_NOT_AVAILABLE;
}

NS_IMETHODIMP
WhimsyRegisterResult::GetAttestationObject(
    nsTArray<uint8_t>& aAttestationObject) {
  aAttestationObject.Assign(mAttestationObject);
  return NS_OK;
}

NS_IMETHODIMP
WhimsyRegisterResult::GetAttestationConsentPromptShown(bool* aShown) {
  *aShown = true;
  return NS_OK;
}

NS_IMETHODIMP
WhimsyRegisterResult::GetCredentialId(nsTArray<uint8_t>& aCredentialId) {
  aCredentialId.Assign(mCredentialId);
  return NS_OK;
}

NS_IMETHODIMP
WhimsyRegisterResult::GetTransports(nsTArray<nsString>& aTransports) {
  aTransports.Clear();
  aTransports.AppendElement(
      NS_LITERAL_STRING_FROM_CSTRING(MOZ_WEBAUTHN_AUTHENTICATOR_TRANSPORT_INTERNAL));
  return NS_OK;
}

NS_IMETHODIMP
WhimsyRegisterResult::GetHmacCreateSecret(bool* aHmacCreateSecret) {
  return NS_ERROR_NOT_AVAILABLE;
}

NS_IMETHODIMP
WhimsyRegisterResult::GetCredPropsRk(bool* aCredPropsRk) {
  if (mCredPropsRk.isNothing()) {
    return NS_ERROR_NOT_AVAILABLE;
  }
  *aCredPropsRk = mCredPropsRk.ref();
  return NS_OK;
}

NS_IMETHODIMP
WhimsyRegisterResult::SetCredPropsRk(bool aCredPropsRk) {
  mCredPropsRk = Some(aCredPropsRk);
  return NS_OK;
}

NS_IMETHODIMP
WhimsyRegisterResult::GetLargeBlobSupported(bool* aLargeBlobSupported) {
  *aLargeBlobSupported = false;
  return NS_OK;
}

NS_IMETHODIMP
WhimsyRegisterResult::GetPrfEnabled(bool* aPrfEnabled) {
  *aPrfEnabled = false;
  return NS_OK;
}

NS_IMETHODIMP
WhimsyRegisterResult::GetPrfResultsFirst(nsTArray<uint8_t>& aFirst) {
  return NS_ERROR_NOT_AVAILABLE;
}

NS_IMETHODIMP
WhimsyRegisterResult::GetPrfResultsSecond(nsTArray<uint8_t>& aSecond) {
  return NS_ERROR_NOT_AVAILABLE;
}

NS_IMETHODIMP
WhimsyRegisterResult::GetAuthenticatorAttachment(nsAString& aAttachment) {
  aAttachment.AssignLiteral(MOZ_WEBAUTHN_AUTHENTICATOR_ATTACHMENT_PLATFORM);
  return NS_OK;
}

NS_IMETHODIMP
WhimsyRegisterResult::HasIdentifyingAttestation(bool* aIdentifying) {
  *aIdentifying = false;
  return NS_OK;
}

NS_IMETHODIMP
WhimsyRegisterResult::Anonymize() {
  // Attestation "none" already carries nothing that could identify this Mac.
  return NS_OK;
}

class WhimsySignResult final : public nsIWebAuthnSignResult {
 public:
  NS_DECL_THREADSAFE_ISUPPORTS
  NS_DECL_NSIWEBAUTHNSIGNRESULT

  WhimsySignResult(const nsTArray<uint8_t>& aCredentialId,
                   const nsTArray<uint8_t>& aAuthenticatorData,
                   const nsTArray<uint8_t>& aSignature,
                   const nsTArray<uint8_t>& aUserHandle) {
    mCredentialId.Assign(aCredentialId);
    mAuthenticatorData.Assign(aAuthenticatorData);
    mSignature.Assign(aSignature);
    mUserHandle.Assign(aUserHandle);
  }

 private:
  ~WhimsySignResult() = default;

  nsTArray<uint8_t> mCredentialId;
  nsTArray<uint8_t> mAuthenticatorData;
  nsTArray<uint8_t> mSignature;
  nsTArray<uint8_t> mUserHandle;
  Maybe<bool> mUsedAppId;
};

NS_IMPL_ISUPPORTS(WhimsySignResult, nsIWebAuthnSignResult)

NS_IMETHODIMP
WhimsySignResult::GetClientDataJSON(nsACString& aClientDataJSON) {
  return NS_ERROR_NOT_AVAILABLE;
}

NS_IMETHODIMP
WhimsySignResult::GetCredentialId(nsTArray<uint8_t>& aCredentialId) {
  aCredentialId.Assign(mCredentialId);
  return NS_OK;
}

NS_IMETHODIMP
WhimsySignResult::GetAuthenticatorData(nsTArray<uint8_t>& aAuthenticatorData) {
  aAuthenticatorData.Assign(mAuthenticatorData);
  return NS_OK;
}

NS_IMETHODIMP
WhimsySignResult::GetSignature(nsTArray<uint8_t>& aSignature) {
  aSignature.Assign(mSignature);
  return NS_OK;
}

NS_IMETHODIMP
WhimsySignResult::GetUserHandle(nsTArray<uint8_t>& aUserHandle) {
  aUserHandle.Assign(mUserHandle);
  return NS_OK;
}

NS_IMETHODIMP
WhimsySignResult::GetUserName(nsACString& aUserName) {
  return NS_ERROR_NOT_AVAILABLE;
}

NS_IMETHODIMP
WhimsySignResult::GetUsedAppId(bool* aUsedAppId) {
  if (mUsedAppId.isNothing()) {
    return NS_ERROR_NOT_AVAILABLE;
  }
  *aUsedAppId = mUsedAppId.ref();
  return NS_OK;
}

NS_IMETHODIMP
WhimsySignResult::SetUsedAppId(bool aUsedAppId) {
  mUsedAppId = Some(aUsedAppId);
  return NS_OK;
}

NS_IMETHODIMP
WhimsySignResult::GetLargeBlobValue(nsTArray<uint8_t>& aLargeBlobValue) {
  return NS_ERROR_NOT_AVAILABLE;
}

NS_IMETHODIMP
WhimsySignResult::GetLargeBlobWritten(bool* aLargeBlobWritten) {
  *aLargeBlobWritten = false;
  return NS_OK;
}

NS_IMETHODIMP
WhimsySignResult::GetPrfMaybe(bool* aPrfMaybe) {
  *aPrfMaybe = false;
  return NS_OK;
}

NS_IMETHODIMP
WhimsySignResult::GetPrfResultsFirst(nsTArray<uint8_t>& aFirst) {
  return NS_ERROR_NOT_AVAILABLE;
}

NS_IMETHODIMP
WhimsySignResult::GetPrfResultsSecond(nsTArray<uint8_t>& aSecond) {
  return NS_ERROR_NOT_AVAILABLE;
}

NS_IMETHODIMP
WhimsySignResult::GetAuthenticatorAttachment(nsAString& aAttachment) {
  aAttachment.AssignLiteral(MOZ_WEBAUTHN_AUTHENTICATOR_ATTACHMENT_PLATFORM);
  return NS_OK;
}

}  // namespace

// ---------------------------------------------------------------------------

class WhimsyPasskeyService;

// One per transaction. Answers for a transaction that was cancelled or
// superseded are dropped (the service compares the id).
class WhimsyPasskeyCallback final : public nsIWhimsyPasskeyCallback {
 public:
  NS_DECL_ISUPPORTS
  NS_DECL_NSIWHIMSYPASSKEYCALLBACK

  WhimsyPasskeyCallback(WhimsyPasskeyService* aService, uint64_t aTransactionId)
      : mService(aService), mTransactionId(aTransactionId) {}

 private:
  ~WhimsyPasskeyCallback() = default;

  RefPtr<WhimsyPasskeyService> mService;
  uint64_t mTransactionId;
};

class WhimsyPasskeyService final : public nsIWebAuthnService {
 public:
  NS_DECL_THREADSAFE_ISUPPORTS
  NS_DECL_NSIWEBAUTHNSERVICE

  explicit WhimsyPasskeyService(nsIWebAuthnService* aAuthrs)
      : mAuthrs(aAuthrs) {}

  // Called by WhimsyPasskeyCallback.
  void OnRegister(uint64_t aTransactionId,
                  const nsTArray<uint8_t>& aAttestationObject,
                  const nsTArray<uint8_t>& aCredentialId);
  void OnSign(uint64_t aTransactionId, const nsTArray<uint8_t>& aCredentialId,
              const nsTArray<uint8_t>& aAuthenticatorData,
              const nsTArray<uint8_t>& aSignature,
              const nsTArray<uint8_t>& aUserHandle);
  void OnError(uint64_t aTransactionId, nsresult aError);
  void OnDelegate(uint64_t aTransactionId);

 private:
  ~WhimsyPasskeyService() = default;

  nsCOMPtr<nsIWhimsyPasskeys> FrontEnd();
  bool IsCurrent(uint64_t aTransactionId) const {
    return mTransactionId.isSome() && mTransactionId.ref() == aTransactionId &&
           !mDelegated;
  }
  // Rejects what is pending with aError (when it is still ours) and forgets
  // the transaction. The front end is told to close its prompt.
  void Abort(nsresult aError);
  void Clear();
  void Delegate();

  nsCOMPtr<nsIWebAuthnService> mAuthrs;

  // The active transaction (main thread only).
  Maybe<uint64_t> mTransactionId;
  uint64_t mBrowsingContextId = 0;
  bool mDelegated = false;
  bool mCredPropsRequested = false;
  nsCOMPtr<nsIWebAuthnRegisterArgs> mRegisterArgs;
  nsCOMPtr<nsIWebAuthnRegisterPromise> mRegisterPromise;
  nsCOMPtr<nsIWebAuthnSignArgs> mSignArgs;
  nsCOMPtr<nsIWebAuthnSignPromise> mSignPromise;
};

NS_IMPL_ISUPPORTS(WhimsyPasskeyCallback, nsIWhimsyPasskeyCallback)
NS_IMPL_ISUPPORTS(WhimsyPasskeyService, nsIWebAuthnService)

NS_IMETHODIMP
WhimsyPasskeyCallback::OnRegister(const nsTArray<uint8_t>& aAttestationObject,
                                  const nsTArray<uint8_t>& aCredentialId) {
  mService->OnRegister(mTransactionId, aAttestationObject, aCredentialId);
  return NS_OK;
}

NS_IMETHODIMP
WhimsyPasskeyCallback::OnSign(const nsTArray<uint8_t>& aCredentialId,
                              const nsTArray<uint8_t>& aAuthenticatorData,
                              const nsTArray<uint8_t>& aSignature,
                              const nsTArray<uint8_t>& aUserHandle) {
  mService->OnSign(mTransactionId, aCredentialId, aAuthenticatorData,
                   aSignature, aUserHandle);
  return NS_OK;
}

NS_IMETHODIMP
WhimsyPasskeyCallback::OnError(nsresult aError) {
  mService->OnError(mTransactionId, aError);
  return NS_OK;
}

NS_IMETHODIMP
WhimsyPasskeyCallback::OnDelegate() {
  mService->OnDelegate(mTransactionId);
  return NS_OK;
}

nsCOMPtr<nsIWhimsyPasskeys> WhimsyPasskeyService::FrontEnd() {
  if (!Preferences::GetBool(kFeaturePref, true)) {
    return nullptr;
  }
  nsCOMPtr<nsIWhimsyPasskeys> frontEnd = do_GetService(kFrontEndContract);
  return frontEnd;
}

void WhimsyPasskeyService::Clear() {
  mTransactionId.reset();
  mBrowsingContextId = 0;
  mDelegated = false;
  mCredPropsRequested = false;
  mRegisterArgs = nullptr;
  mRegisterPromise = nullptr;
  mSignArgs = nullptr;
  mSignPromise = nullptr;
}

void WhimsyPasskeyService::Abort(nsresult aError) {
  MOZ_ASSERT(NS_IsMainThread());
  if (mTransactionId.isNothing()) {
    return;
  }
  if (!mDelegated) {
    if (nsCOMPtr<nsIWhimsyPasskeys> frontEnd = FrontEnd()) {
      (void)frontEnd->Cancel(mTransactionId.ref());
    }
    if (mRegisterPromise) {
      (void)mRegisterPromise->Reject(aError);
    }
    if (mSignPromise) {
      (void)mSignPromise->Reject(aError);
    }
  }
  Clear();
}

// Hands the pending transaction to authenticator-rs as if Whimsy's service
// had never seen it. From here on, cancel, reset, PIN and selection
// callbacks go there too.
void WhimsyPasskeyService::Delegate() {
  MOZ_ASSERT(NS_IsMainThread());
  if (mTransactionId.isNothing() || mDelegated) {
    return;
  }
  mDelegated = true;
  uint64_t tid = mTransactionId.ref();
  nsresult rv = NS_ERROR_FAILURE;
  if (mRegisterArgs && mRegisterPromise) {
    rv = mAuthrs->MakeCredential(tid, mBrowsingContextId, mRegisterArgs,
                                 mRegisterPromise);
    if (NS_FAILED(rv)) {
      (void)mRegisterPromise->Reject(NS_ERROR_DOM_NOT_ALLOWED_ERR);
    }
  } else if (mSignArgs && mSignPromise) {
    rv = mAuthrs->GetAssertion(tid, mBrowsingContextId, mSignArgs,
                               mSignPromise);
    if (NS_FAILED(rv)) {
      (void)mSignPromise->Reject(NS_ERROR_DOM_NOT_ALLOWED_ERR);
    }
  }
  // authenticator-rs owns the promises now; keep only what cancel needs.
  mRegisterArgs = nullptr;
  mRegisterPromise = nullptr;
  mSignArgs = nullptr;
  mSignPromise = nullptr;
}

// -- nsIWebAuthnService -----------------------------------------------------

NS_IMETHODIMP
WhimsyPasskeyService::GetIsUVPAA(bool* aAvailable) {
  *aAvailable = false;
  if (nsCOMPtr<nsIWhimsyPasskeys> frontEnd = FrontEnd()) {
    (void)frontEnd->GetAvailable(aAvailable);
  }
  return NS_OK;
}

NS_IMETHODIMP
WhimsyPasskeyService::MakeCredential(uint64_t aTransactionId,
                                     uint64_t aBrowsingContextId,
                                     nsIWebAuthnRegisterArgs* aArgs,
                                     nsIWebAuthnRegisterPromise* aPromise) {
  MOZ_ASSERT(NS_IsMainThread());
  Abort(NS_ERROR_DOM_ABORT_ERR);
  mTransactionId = Some(aTransactionId);
  mBrowsingContextId = aBrowsingContextId;
  mRegisterArgs = aArgs;
  mRegisterPromise = aPromise;
  (void)aArgs->GetCredProps(&mCredPropsRequested);

  nsCOMPtr<nsIWhimsyPasskeys> frontEnd = FrontEnd();
  if (!frontEnd) {
    Delegate();
    return NS_OK;
  }
  nsAutoCString json;
  SerializeRegisterArgs(aArgs, aBrowsingContextId, json);
  RefPtr<WhimsyPasskeyCallback> callback =
      new WhimsyPasskeyCallback(this, aTransactionId);
  nsresult rv = frontEnd->MakeCredential(aTransactionId, aBrowsingContextId,
                                         NS_ConvertUTF8toUTF16(json), callback);
  if (NS_FAILED(rv) && IsCurrent(aTransactionId)) {
    Delegate();
  }
  return NS_OK;
}

NS_IMETHODIMP
WhimsyPasskeyService::GetAssertion(uint64_t aTransactionId,
                                   uint64_t aBrowsingContextId,
                                   nsIWebAuthnSignArgs* aArgs,
                                   nsIWebAuthnSignPromise* aPromise) {
  MOZ_ASSERT(NS_IsMainThread());
  Abort(NS_ERROR_DOM_ABORT_ERR);
  mTransactionId = Some(aTransactionId);
  mBrowsingContextId = aBrowsingContextId;
  mSignArgs = aArgs;
  mSignPromise = aPromise;

  nsCOMPtr<nsIWhimsyPasskeys> frontEnd = FrontEnd();
  if (!frontEnd) {
    Delegate();
    return NS_OK;
  }
  nsAutoCString json;
  SerializeSignArgs(aArgs, aBrowsingContextId, json);
  RefPtr<WhimsyPasskeyCallback> callback =
      new WhimsyPasskeyCallback(this, aTransactionId);
  nsresult rv = frontEnd->GetAssertion(aTransactionId, aBrowsingContextId,
                                       NS_ConvertUTF8toUTF16(json), callback);
  if (NS_FAILED(rv) && IsCurrent(aTransactionId)) {
    Delegate();
  }
  return NS_OK;
}

void WhimsyPasskeyService::OnRegister(
    uint64_t aTransactionId, const nsTArray<uint8_t>& aAttestationObject,
    const nsTArray<uint8_t>& aCredentialId) {
  MOZ_ASSERT(NS_IsMainThread());
  if (!IsCurrent(aTransactionId) || !mRegisterPromise) {
    return;
  }
  RefPtr<WhimsyRegisterResult> result = new WhimsyRegisterResult(
      aAttestationObject, aCredentialId, mCredPropsRequested);
  nsCOMPtr<nsIWebAuthnRegisterPromise> promise = std::move(mRegisterPromise);
  Clear();
  (void)promise->Resolve(result);
}

void WhimsyPasskeyService::OnSign(uint64_t aTransactionId,
                                  const nsTArray<uint8_t>& aCredentialId,
                                  const nsTArray<uint8_t>& aAuthenticatorData,
                                  const nsTArray<uint8_t>& aSignature,
                                  const nsTArray<uint8_t>& aUserHandle) {
  MOZ_ASSERT(NS_IsMainThread());
  if (!IsCurrent(aTransactionId) || !mSignPromise) {
    return;
  }
  RefPtr<WhimsySignResult> result = new WhimsySignResult(
      aCredentialId, aAuthenticatorData, aSignature, aUserHandle);
  nsCOMPtr<nsIWebAuthnSignPromise> promise = std::move(mSignPromise);
  Clear();
  (void)promise->Resolve(result);
}

void WhimsyPasskeyService::OnError(uint64_t aTransactionId, nsresult aError) {
  MOZ_ASSERT(NS_IsMainThread());
  if (!IsCurrent(aTransactionId)) {
    return;
  }
  if (NS_SUCCEEDED(aError)) {
    aError = NS_ERROR_DOM_NOT_ALLOWED_ERR;
  }
  if (mRegisterPromise) {
    (void)mRegisterPromise->Reject(aError);
  }
  if (mSignPromise) {
    (void)mSignPromise->Reject(aError);
  }
  Clear();
}

void WhimsyPasskeyService::OnDelegate(uint64_t aTransactionId) {
  MOZ_ASSERT(NS_IsMainThread());
  if (!IsCurrent(aTransactionId)) {
    return;
  }
  Delegate();
}

NS_IMETHODIMP
WhimsyPasskeyService::Reset() {
  MOZ_ASSERT(NS_IsMainThread());
  if (mTransactionId.isSome() && mDelegated) {
    (void)mAuthrs->Reset();
    Clear();
    return NS_OK;
  }
  Abort(NS_ERROR_DOM_ABORT_ERR);
  return NS_OK;
}

NS_IMETHODIMP
WhimsyPasskeyService::Cancel(uint64_t aTransactionId) {
  MOZ_ASSERT(NS_IsMainThread());
  if (mTransactionId.isSome() && mTransactionId.ref() == aTransactionId) {
    if (mDelegated) {
      (void)mAuthrs->Cancel(aTransactionId);
      Clear();
    } else {
      Abort(NS_ERROR_DOM_NOT_ALLOWED_ERR);
    }
  }
  return NS_OK;
}

NS_IMETHODIMP
WhimsyPasskeyService::HasPendingConditionalGet(uint64_t aBrowsingContextId,
                                               const nsAString& aOrigin,
                                               uint64_t* aRv) {
  // WebAuthnService holds conditional requests itself.
  *aRv = 0;
  return NS_OK;
}

NS_IMETHODIMP
WhimsyPasskeyService::GetAutoFillEntries(
    uint64_t aTransactionId, nsIWebAuthnAutoFillEntriesCallback* aCallback) {
  aCallback->Reject(NS_ERROR_NOT_AVAILABLE);
  return NS_OK;
}

void WhimsyPasskeyNoteAutoFillContext(uint64_t aBrowsingContextId) {
  sAutoFillBrowsingContextId = aBrowsingContextId;
}

NS_IMETHODIMP
WhimsyPasskeyService::GetAutoFillEntriesForRpId(
    const nsAString& aRpId, const nsTArray<nsTArray<uint8_t>>& aAllowList,
    nsIWebAuthnAutoFillEntriesCallback* aCallback) {
  MOZ_ASSERT(NS_IsMainThread());
  uint64_t browsingContextId = sAutoFillBrowsingContextId;
  sAutoFillBrowsingContextId = 0;
  nsCOMPtr<nsIWhimsyPasskeys> frontEnd = FrontEnd();
  if (!frontEnd) {
    return mAuthrs->GetAutoFillEntriesForRpId(aRpId, aAllowList, aCallback);
  }
  nsresult rv = frontEnd->GetAutoFillEntries(aRpId, browsingContextId,
                                             aAllowList, aCallback);
  if (NS_FAILED(rv)) {
    aCallback->Reject(rv);
  }
  return NS_OK;
}

NS_IMETHODIMP
WhimsyPasskeyService::SelectAutoFillEntry(uint64_t aTransactionId,
                                          const nsTArray<uint8_t>& aCredentialId) {
  // Promoted by WebAuthnService into a GetAssertion with that allow list.
  return NS_OK;
}

NS_IMETHODIMP
WhimsyPasskeyService::ResumeConditionalGet(uint64_t aTransactionId) {
  return NS_OK;
}

NS_IMETHODIMP
WhimsyPasskeyService::PinCallback(uint64_t aTransactionId,
                                  const nsACString& aPin) {
  if (mDelegated) {
    return mAuthrs->PinCallback(aTransactionId, aPin);
  }
  return NS_OK;
}

NS_IMETHODIMP
WhimsyPasskeyService::SetHasAttestationConsent(uint64_t aTransactionId,
                                               bool aHasConsent) {
  if (mDelegated) {
    return mAuthrs->SetHasAttestationConsent(aTransactionId, aHasConsent);
  }
  return NS_OK;
}

NS_IMETHODIMP
WhimsyPasskeyService::SelectionCallback(uint64_t aTransactionId,
                                        uint64_t aIndex) {
  if (mDelegated) {
    return mAuthrs->SelectionCallback(aTransactionId, aIndex);
  }
  return NS_OK;
}

// WebDriver's virtual authenticators and about:webauthn always run on
// authenticator-rs (WebAuthnService routes them there itself); forwarded
// for completeness.

NS_IMETHODIMP
WhimsyPasskeyService::AddVirtualAuthenticator(
    const nsACString& aProtocol, const nsACString& aTransport,
    bool aHasResidentKey, bool aHasUserVerification, bool aIsUserConsenting,
    bool aIsUserVerified, nsACString& aRetval) {
  return mAuthrs->AddVirtualAuthenticator(aProtocol, aTransport,
                                          aHasResidentKey, aHasUserVerification,
                                          aIsUserConsenting, aIsUserVerified,
                                          aRetval);
}

NS_IMETHODIMP
WhimsyPasskeyService::HasVirtualAuthenticator(const nsACString& aId,
                                              bool* aRetval) {
  return mAuthrs->HasVirtualAuthenticator(aId, aRetval);
}

NS_IMETHODIMP
WhimsyPasskeyService::RemoveVirtualAuthenticator(const nsACString& aId) {
  return mAuthrs->RemoveVirtualAuthenticator(aId);
}

NS_IMETHODIMP
WhimsyPasskeyService::AddCredential(const nsACString& aAuthenticatorId,
                                    const nsACString& aCredentialId,
                                    bool aIsResidentCredential,
                                    const nsACString& aRpId,
                                    const nsACString& aPrivateKey,
                                    const nsACString& aUserHandle,
                                    uint32_t aSignCount) {
  return mAuthrs->AddCredential(aAuthenticatorId, aCredentialId,
                                aIsResidentCredential, aRpId, aPrivateKey,
                                aUserHandle, aSignCount);
}

NS_IMETHODIMP
WhimsyPasskeyService::GetCredentials(
    const nsACString& aAuthenticatorId,
    nsTArray<RefPtr<nsICredentialParameters>>& aRetval) {
  return mAuthrs->GetCredentials(aAuthenticatorId, aRetval);
}

NS_IMETHODIMP
WhimsyPasskeyService::RemoveCredential(const nsACString& aAuthenticatorId,
                                       const nsACString& aCredentialId) {
  return mAuthrs->RemoveCredential(aAuthenticatorId, aCredentialId);
}

NS_IMETHODIMP
WhimsyPasskeyService::RemoveAllCredentials(const nsACString& aAuthenticatorId) {
  return mAuthrs->RemoveAllCredentials(aAuthenticatorId);
}

NS_IMETHODIMP
WhimsyPasskeyService::SetUserVerified(const nsACString& aAuthenticatorId,
                                      bool aIsUserVerified) {
  return mAuthrs->SetUserVerified(aAuthenticatorId, aIsUserVerified);
}

NS_IMETHODIMP
WhimsyPasskeyService::Listen() { return mAuthrs->Listen(); }

NS_IMETHODIMP
WhimsyPasskeyService::RunCommand(const nsACString& aCommand) {
  return mAuthrs->RunCommand(aCommand);
}

// ---------------------------------------------------------------------------

already_AddRefed<nsIWebAuthnService> NewWhimsyPasskeyServiceIfEnabled(
    nsIWebAuthnService* aAuthrs) {
  if (!aAuthrs || !Preferences::GetBool(kFeaturePref, true)) {
    return nullptr;
  }
  nsCOMPtr<nsIWebAuthnService> service = new WhimsyPasskeyService(aAuthrs);
  return service.forget();
}

}  // namespace mozilla::dom
