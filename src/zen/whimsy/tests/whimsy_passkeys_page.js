/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// Runs in the fixture page (https://example.com). `window.passkey` makes
// WebAuthn requests with chosen options and checks the answers the way a
// relying party would: it parses the attestation object (CBOR), reads the
// authenticator data (rpIdHash, flags, counter, AAGUID, credential ID,
// COSE key), and verifies each assertion's ES256 signature with WebCrypto.

const B64URL = {
  encode(bytes) {
    let s = "";
    for (const b of new Uint8Array(bytes)) {
      s += String.fromCharCode(b);
    }
    return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  },
  decode(text) {
    const padded = text.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (text.length % 4)) % 4);
    return Uint8Array.from(atob(padded), c => c.charCodeAt(0));
  },
};

// A CBOR reader for what an attestation object holds: maps, byte and text
// strings, and small integers.
function decodeCBOR(bytes) {
  let at = 0;
  const read = () => {
    const first = bytes[at++];
    const major = first >> 5;
    let info = first & 0x1f;
    if (info == 24) {
      info = bytes[at++];
    } else if (info == 25) {
      info = (bytes[at] << 8) | bytes[at + 1];
      at += 2;
    } else if (info == 26) {
      info = ((bytes[at] << 24) >>> 0) + (bytes[at + 1] << 16) + (bytes[at + 2] << 8) + bytes[at + 3];
      at += 4;
    } else if (info > 26) {
      throw new Error(`CBOR: unsupported length ${info}`);
    }
    switch (major) {
      case 0:
        return info;
      case 1:
        return -1 - info;
      case 2: {
        const out = bytes.slice(at, at + info);
        at += info;
        return out;
      }
      case 3: {
        const out = new TextDecoder().decode(bytes.slice(at, at + info));
        at += info;
        return out;
      }
      case 4: {
        const out = [];
        for (let i = 0; i < info; i++) {
          out.push(read());
        }
        return out;
      }
      case 5: {
        const out = new Map();
        for (let i = 0; i < info; i++) {
          const key = read();
          out.set(key, read());
        }
        return out;
      }
      default:
        throw new Error(`CBOR: unsupported major type ${major}`);
    }
  };
  const value = read();
  if (at != bytes.length) {
    throw new Error(`CBOR: ${bytes.length - at} trailing bytes`);
  }
  return value;
}

function parseAuthData(authData) {
  const out = {
    rpIdHash: B64URL.encode(authData.slice(0, 32)),
    flags: authData[32],
    counter: new DataView(authData.buffer, authData.byteOffset + 33, 4).getUint32(0),
    length: authData.length,
  };
  if (out.flags & 0x40) {
    const aaguid = authData.slice(37, 53);
    out.aaguid = [...aaguid].map(b => b.toString(16).padStart(2, "0")).join("");
    const idLength = (authData[53] << 8) | authData[54];
    out.credentialId = B64URL.encode(authData.slice(55, 55 + idLength));
    const cose = decodeCBOR(authData.slice(55 + idLength));
    out.cose = { kty: cose.get(1), alg: cose.get(3), crv: cose.get(-1), x: B64URL.encode(cose.get(-2)), y: B64URL.encode(cose.get(-3)) };
  }
  return out;
}

// DER ECDSA (SEQUENCE of two INTEGERs) to the raw r ‖ s WebCrypto verifies.
function derToRaw(der) {
  if (der[0] != 0x30) {
    throw new Error("not a DER sequence");
  }
  let at = 2;
  const part = () => {
    if (der[at++] != 0x02) {
      throw new Error("not a DER integer");
    }
    let length = der[at++];
    let start = at;
    at += length;
    let value = der.slice(start, start + length);
    while (value.length > 32 && value[0] == 0) {
      value = value.slice(1);
    }
    const out = new Uint8Array(32);
    out.set(value, 32 - value.length);
    return out;
  };
  const r = part();
  const s = part();
  const raw = new Uint8Array(64);
  raw.set(r);
  raw.set(s, 32);
  return raw;
}

async function sha256(bytes) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
}

let pending = null;

window.passkey = {
  /** Aborts the request in flight (its AbortController). */
  abort() {
    pending?.abort();
  },

  async create(opts = {}) {
    const controller = new AbortController();
    pending = controller;
    const rpId = opts.rpId ?? location.hostname;
    const publicKey = {
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      rp: { name: "Whimsy test", id: rpId },
      user: {
        id: B64URL.decode(opts.userId ?? "AQID"),
        name: opts.name ?? "mona",
        displayName: opts.displayName ?? "Mona Lisa Octocat",
      },
      pubKeyCredParams: opts.algs ?? [{ type: "public-key", alg: -7 }],
      timeout: opts.timeout ?? 60000,
      excludeCredentials: (opts.exclude ?? []).map(id => ({ type: "public-key", id: B64URL.decode(id) })),
      authenticatorSelection: {
        ...(opts.attachment ? { authenticatorAttachment: opts.attachment } : {}),
        residentKey: opts.residentKey ?? "preferred",
        userVerification: opts.uv ?? "preferred",
      },
      attestation: opts.attestation ?? "none",
      ...(opts.credProps === false ? {} : { extensions: { credProps: true } }),
    };
    try {
      const credential = await navigator.credentials.create({ publicKey, signal: controller.signal });
      const attestation = decodeCBOR(new Uint8Array(credential.response.attestationObject));
      const authData = parseAuthData(attestation.get("authData"));
      const clientData = JSON.parse(new TextDecoder().decode(credential.response.clientDataJSON));
      return {
        ok: true,
        id: credential.id,
        rawId: B64URL.encode(credential.rawId),
        fmt: attestation.get("fmt"),
        attStmtSize: attestation.get("attStmt")?.size ?? -1,
        authData,
        rpIdHashMatches: authData.rpIdHash == B64URL.encode(await sha256(new TextEncoder().encode(rpId))),
        clientData,
        extensions: credential.getClientExtensionResults(),
        attachment: credential.authenticatorAttachment,
        transports: credential.response.getTransports?.() ?? null,
        publicKeyAlg: credential.response.getPublicKeyAlgorithm?.() ?? null,
      };
    } catch (error) {
      return { ok: false, error: error.name, message: error.message };
    } finally {
      pending = null;
    }
  },

  /**
   * opts.allow: credential IDs (base64url); opts.publicKey: {x, y} of the
   * passkey expected to answer, to verify the signature.
   */
  async get(opts = {}) {
    const controller = new AbortController();
    pending = controller;
    const rpId = opts.rpId ?? location.hostname;
    const publicKey = {
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      rpId,
      allowCredentials: (opts.allow ?? []).map(id => ({ type: "public-key", id: B64URL.decode(id), transports: ["internal"] })),
      userVerification: opts.uv ?? "preferred",
      timeout: opts.timeout ?? 60000,
    };
    try {
      const credential = await navigator.credentials.get({
        publicKey,
        signal: controller.signal,
        ...(opts.mediation ? { mediation: opts.mediation } : {}),
      });
      const authDataBytes = new Uint8Array(credential.response.authenticatorData);
      const authData = parseAuthData(authDataBytes);
      const clientDataJSON = new Uint8Array(credential.response.clientDataJSON);
      const clientData = JSON.parse(new TextDecoder().decode(clientDataJSON));
      let verified = null;
      if (opts.publicKey) {
        const key = await crypto.subtle.importKey(
          "jwk",
          { kty: "EC", crv: "P-256", x: opts.publicKey.x, y: opts.publicKey.y, ext: true },
          { name: "ECDSA", namedCurve: "P-256" },
          false,
          ["verify"],
        );
        const hash = await sha256(clientDataJSON);
        const signed = new Uint8Array(authDataBytes.length + hash.length);
        signed.set(authDataBytes);
        signed.set(hash, authDataBytes.length);
        const raw = derToRaw(new Uint8Array(credential.response.signature));
        verified = await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, raw, signed);
      }
      return {
        ok: true,
        id: credential.id,
        rawId: B64URL.encode(credential.rawId),
        authData,
        rpIdHashMatches: authData.rpIdHash == B64URL.encode(await sha256(new TextEncoder().encode(rpId))),
        userHandle: credential.response.userHandle ? B64URL.encode(credential.response.userHandle) : null,
        verified,
        clientData,
        attachment: credential.authenticatorAttachment,
      };
    } catch (error) {
      return { ok: false, error: error.name, message: error.message };
    } finally {
      pending = null;
    }
  },
};
