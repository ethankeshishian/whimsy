// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.

// W26 passkeys: the Secure Enclave helper (whimsy-passkeys.app). One
// request per process, as JSON on stdin; one JSON line on stdout.
//
//   {"op":"available"}
//     -> {"ok":true,"se":bool,"biometry":bool,"biometryType":"touchID"|"none"}
//   {"op":"create","reason":"save a passkey for github.com"}
//     -> {"ok":true,"blob":b64,"x":b64,"y":b64}
//   {"op":"sign","blob":b64,"message":b64,"reason":"sign in to github.com"}
//     -> {"ok":true,"der":b64}
//   failure -> {"ok":false,"error":"cancel"|"bad-blob"|"unavailable"|
//               "bad-request"|"failed","detail":"..."}
//
// The key is a CryptoKit Secure Enclave P-256 key whose access control is
// [.privateKeyUsage, .userPresence]: macOS asks for Touch ID when it can
// and for the Mac password when it can't (lid closed, no sensor), on every
// signature. The key never exists outside this Mac's Secure Enclave; the
// blob Whimsy stores is only usable here. On create, the key signs a fixed
// nonce right away so the person verifies once and a key that can't sign
// is never stored. The reason is passed by Whimsy from the validated RP ID
// only, never from text the page controls.

import CryptoKit
import Foundation
import LocalAuthentication
import Security

struct Request: Decodable {
  let op: String
  let reason: String?
  let blob: String?
  let message: String?
}

func respond(_ fields: [String: Any]) -> Never {
  let data = (try? JSONSerialization.data(withJSONObject: fields)) ?? Data("{\"ok\":false,\"error\":\"failed\"}".utf8)
  FileHandle.standardOutput.write(data)
  FileHandle.standardOutput.write(Data("\n".utf8))
  exit(0)
}

func fail(_ code: String, _ detail: String) -> Never {
  respond(["ok": false, "error": code, "detail": detail])
}

// Cancelled, not recognised, or the wrong password: macOS doesn't tell
// these apart, so neither does Whimsy ("cancel"). Anything else is "failed".
func classify(_ error: Error) -> String {
  let ns = error as NSError
  if ns.domain == LAError.errorDomain {
    switch LAError.Code(rawValue: ns.code) {
    case .userCancel, .appCancel, .systemCancel, .authenticationFailed, .userFallback, .biometryLockout,
      .passcodeNotSet, .notInteractive:
      return "cancel"
    default:
      return "failed"
    }
  }
  if ns.domain == NSOSStatusErrorDomain && (ns.code == Int(errSecUserCanceled) || ns.code == Int(errSecAuthFailed)) {
    return "cancel"
  }
  let text = "\(error)"
  if text.contains("-128") || text.contains("-25293") || text.lowercased().contains("cancel") {
    return "cancel"
  }
  return "failed"
}

func biometry() -> (Bool, String) {
  let context = LAContext()
  var error: NSError?
  let can = context.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &error)
  let type: String
  switch context.biometryType {
  case .touchID:
    type = "touchID"
  case .faceID:
    type = "faceID"
  default:
    type = "none"
  }
  return (can, type)
}

let input = FileHandle.standardInput.readDataToEndOfFile()
guard let request = try? JSONDecoder().decode(Request.self, from: input) else {
  fail("bad-request", "no request")
}

switch request.op {
case "available":
  let (can, type) = biometry()
  respond(["ok": true, "se": SecureEnclave.isAvailable, "biometry": can, "biometryType": type])

case "create":
  guard SecureEnclave.isAvailable else {
    fail("unavailable", "no Secure Enclave")
  }
  var acError: Unmanaged<CFError>?
  guard
    let access = SecAccessControlCreateWithFlags(
      nil, kSecAttrAccessibleWhenUnlockedThisDeviceOnly, [.privateKeyUsage, .userPresence], &acError)
  else {
    fail("failed", "access control: \(String(describing: acError?.takeRetainedValue()))")
  }
  let context = LAContext()
  context.localizedReason = request.reason ?? ""
  do {
    let key = try SecureEnclave.P256.Signing.PrivateKey(accessControl: access, authenticationContext: context)
    _ = try key.signature(for: Data("whimsy-passkey-first-use".utf8))
    let raw = key.publicKey.rawRepresentation
    guard raw.count == 64 else {
      fail("failed", "unexpected public key length \(raw.count)")
    }
    respond([
      "ok": true,
      "blob": key.dataRepresentation.base64EncodedString(),
      "x": raw.prefix(32).base64EncodedString(),
      "y": raw.suffix(32).base64EncodedString(),
    ])
  } catch {
    fail(classify(error), "\(error)")
  }

case "sign":
  guard let blobText = request.blob, let blob = Data(base64Encoded: blobText),
    let messageText = request.message, let message = Data(base64Encoded: messageText)
  else {
    fail("bad-request", "blob and message required")
  }
  let context = LAContext()
  context.localizedReason = request.reason ?? ""
  let key: SecureEnclave.P256.Signing.PrivateKey
  do {
    key = try SecureEnclave.P256.Signing.PrivateKey(dataRepresentation: blob, authenticationContext: context)
  } catch {
    fail("bad-blob", "\(error)")
  }
  do {
    let signature = try key.signature(for: message)
    respond(["ok": true, "der": signature.derRepresentation.base64EncodedString()])
  } catch {
    fail(classify(error), "\(error)")
  }

default:
  fail("bad-request", "unknown op \(request.op)")
}
