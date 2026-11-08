/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Installs Claude Code the way code.claude.com/docs/en/setup ("Binary
// integrity and code signing") verifies it: a release manifest signed with
// Anthropic's pinned OpenPGP key, the binary's SHA-256 from that manifest,
// Anthropic PBC's Developer ID signature, and Apple's notarization.

import { AppConstants } from "resource://gre/modules/AppConstants.sys.mjs";
import { clearTimeout, setTimeout } from "resource://gre/modules/Timer.sys.mjs";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  Subprocess: "resource://gre/modules/Subprocess.sys.mjs",
  WhimsyAIError: "resource:///modules/whimsy/WhimsyAIProviders.sys.mjs",
});

const DEFAULT_BASE = "https://downloads.claude.ai/claude-code-releases";
export const RELEASE_KEY_FINGERPRINT = "31DDDE24DDFAB679F42D7BD2BAA929FF1A7ECACE";
export const TEAM_ID = "Q6L2SF6YDW";
export const TOPIC = "whimsy-claude-code-install";
export const STEPS = ["fetch", "signature", "download", "hash", "codesign", "notarization", "install"];
const VERSION_RE = /^\d+\.\d+\.\d+(-[\w.]+)?$/;
const RECORD_DIR = "whimsy-ai";
const RECORD_NAME = "claude-code-installed.json";
const TOOL_TIMEOUT_MS = 2 * 60 * 1000;
const INSTALL_TIMEOUT_MS = 10 * 60 * 1000;
const WRITE_CHUNK = 8 * 1024 * 1024;

// https://downloads.claude.ai/keys/claude-code.asc, verbatim.
export const RELEASE_KEY = `-----BEGIN PGP PUBLIC KEY BLOCK-----

mQINBGnK73ABEACnbytJXkjweYrwIr0aLEFRlH+C0nF44KxFc7gQmJ6PjSPMGZAD
dxZcaixU7zZl8WxEpVO0wLmIH8cf2zGOdyuZg1Yaugk1vHb2b8WBhAGCQJdPgB8W
XquedepEYtk56uP/gCoTjJDUZluEGBHnlnuujSJ4orxEdhSykEoAUfJZGEILPpMd
bphFt/Sn+Eb/TxM5jpKPdwnv8AShNF/1mZU1fWTQq9tRKJUakZj04gdaDFElQXak
CtTij+GT6yoYCARSHwGO+PC/Pr6q4tc+D7LRjxSBvUWDoFSmlqb/PJ1hj9D/7I2O
e4XXniAPWMR56KvxHlzOzrNQdJujbJdSkCwh1ZijkSd3y8ayW5WYUTGdRab99NUw
agzlabe/VVF6kzJ0Scn5q3PihB2Y9Bwo0CKnkYk7a7KT77EWv0Kkq+VHmOtqX3a2
hhX+b6a6ve9rzJ1qZYGj+obv/C3Sx1LzUjAfqVy7RJDf2uAoP5t2g8u/TkSpUxhM
VEjZBkSxYZhMyzQM6t8IgkUfnSrIPTHixbDWARZ4beMOBjxyPZK1nP7OOrNR3TkK
JtwLMQAabURCDnL0PjS0iwBTU4jtumBD1XSULyWuoTvMljrpQr1nV1oDyOt0OLqa
KA2McWtd9PdXhC8y2EIg7TmrTlJLfHYbdmkiCYj4J49Q8HWkN/6WE+RTUwARAQAB
tD5BbnRocm9waWMgQ2xhdWRlIENvZGUgUmVsZWFzZSBTaWduaW5nIDxzZWN1cml0
eUBhbnRocm9waWMuY29tPokCUQQTAQoAOxYhBDHd3iTd+rZ59C170rqpKf8afsrO
BQJpyu9wAhsPBQsJCAcCAiICBhUKCQgLAgQWAgMBAh4HAheAAAoJELqpKf8afsrO
l5IP/2I8X1dFy5xYczWB/coIxGjuzS/V6ByZGZZEJsbr04pmuHiFUykJqPGWGQ6q
U0YF5iEwvEkaagS5m7DzhSEf3FM3Cgafax/6d70tar9Vr1D+w6uPfxetu7u/WYJp
aolIsdh5fTrBh9zSM1Njl8FM8wG8CwZQjS33Oa7d8cwRkgdUWbt6LXgz+cTQNuBn
BgW6Ks7oZFI25dfu0ojDR+aDFJg4+4wZoyDLPvJz1SIrJ5WFGs67zsx9SfS3yZnf
XKmBe+f0dUy+GJ2nFZrXFf99+c0dPEHYO8DCeAHZizjkFrdYtUHdDU0YDYEGkLJa
bE+pgcpkHf5EvsZzHsyDbl95W/eh7pcXMbwkN+W4CBYUE9X4uHhqzWaC5yAVRWUA
1BJ9V4LjZfHPLEJt0I3TxzXiEg9/BVeaTYq9RjaxIFo9Nfk158HqJY6SA5jslBlx
Gv/No8u+xVcze2UJyGVfEIUfm92+0UAIkny3+5cuVV0ICzJxXlXj0CnLM9Lt50wE
p3suVwuBEviCbZ08eAH1Ht8gbBdSsiOkIU8CX3v/scwHHx5q0+NBL6xLrQObg13a
tRXBlKObfElkPN3lTUbUnJOW4U8uSjH8VRP+AujKWMDFe7x0zCs+iYY1mTOvbrTS
9n3CmZUmbynZ+E/QWNENpW/pDNZdWFy43PASmML5FHu4m9Sn
=oqMI
-----END PGP PUBLIC KEY BLOCK-----`;

const HASHES = { 8: "SHA-256", 10: "SHA-512" };
const textBytes = text => new TextEncoder().encode(text);
const hex = bytes => Array.from(bytes, b => b.toString(16).padStart(2, "0")).join("").toUpperCase();
const concat = (...parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
};
const b64url = bytes => ChromeUtils.base64URLEncode(bytes, { pad: false });

function dearmor(input) {
  const bytes = typeof input == "string" ? textBytes(input) : input;
  const head = new TextDecoder().decode(bytes.subarray(0, 64));
  if (!head.trimStart().startsWith("-----BEGIN PGP ")) {
    return bytes;
  }
  const lines = new TextDecoder().decode(bytes).split(/\r?\n/);
  let i = lines.findIndex(l => l.startsWith("-----BEGIN PGP "));
  while (++i < lines.length && lines[i].trim() !== "") {
    if (!/^[\w-]+: /.test(lines[i])) {
      break;
    }
  }
  let body = "";
  for (; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.startsWith("-----END") || line.startsWith("=")) {
      break;
    }
    body += line;
  }
  const raw = atob(body);
  return Uint8Array.from(raw, c => c.charCodeAt(0));
}

function readPackets(bytes) {
  const packets = [];
  let i = 0;
  while (i < bytes.length) {
    const h = bytes[i++];
    if (!(h & 0x80)) {
      throw new Error("Not an OpenPGP packet");
    }
    let tag, len;
    if (h & 0x40) {
      tag = h & 0x3f;
      const l = bytes[i++];
      if (l < 192) {
        len = l;
      } else if (l < 224) {
        len = ((l - 192) << 8) + bytes[i++] + 192;
      } else if (l == 255) {
        len = ((bytes[i] << 24) | (bytes[i + 1] << 16) | (bytes[i + 2] << 8) | bytes[i + 3]) >>> 0;
        i += 4;
      } else {
        throw new Error("Partial packet lengths are not supported");
      }
    } else {
      tag = (h >> 2) & 0xf;
      const type = h & 3;
      if (type == 3) {
        throw new Error("Indeterminate packet lengths are not supported");
      }
      const n = [1, 2, 4][type];
      len = 0;
      for (let k = 0; k < n; k++) {
        len = len * 256 + bytes[i++];
      }
    }
    if (i + len > bytes.length) {
      throw new Error("Truncated packet");
    }
    packets.push({ tag, body: bytes.subarray(i, i + len) });
    i += len;
  }
  return packets;
}

function readMPI(bytes, at) {
  const bits = (bytes[at] << 8) | bytes[at + 1];
  const len = (bits + 7) >> 3;
  if (at + 2 + len > bytes.length) {
    throw new Error("Truncated MPI");
  }
  return { value: bytes.subarray(at + 2, at + 2 + len), next: at + 2 + len };
}

const ED25519_OID = "2B06010401DA470F01";

async function parseKeyPacket(body) {
  if (body[0] != 4) {
    throw new Error("Only v4 keys are supported");
  }
  const alg = body[5];
  const key = { alg };
  if (alg == 1 || alg == 3) {
    const n = readMPI(body, 6);
    const e = readMPI(body, n.next);
    Object.assign(key, { n: n.value, e: e.value });
  } else if (alg == 22) {
    const oidLen = body[6];
    if (hex(body.subarray(7, 7 + oidLen)) != ED25519_OID) {
      throw new Error("Unsupported EdDSA curve");
    }
    const q = readMPI(body, 7 + oidLen).value;
    if (q.length != 33 || q[0] != 0x40) {
      throw new Error("Bad Ed25519 point");
    }
    key.ed25519 = q.subarray(1);
  } else if (alg == 27) {
    key.ed25519 = body.subarray(6, 38);
  } else {
    throw new Error(`Unsupported key algorithm ${alg}`);
  }
  const prefix = new Uint8Array([0x99, body.length >> 8, body.length & 0xff]);
  const fingerprint = hex(new Uint8Array(await crypto.subtle.digest("SHA-1", concat(prefix, body))));
  return { ...key, fingerprint, keyId: fingerprint.slice(-16) };
}

/**
 * The primary key of an OpenPGP public key (armored or binary).
 *
 * @returns {Promise<{ alg: number, fingerprint: string, keyId: string }>}
 */
export async function readPublicKey(armored) {
  const primary = readPackets(dearmor(armored)).find(p => p.tag == 6);
  if (!primary) {
    throw new Error("No public key packet");
  }
  return parseKeyPacket(primary.body);
}

function readSubpackets(bytes) {
  const out = [];
  let i = 0;
  while (i < bytes.length) {
    let len = bytes[i++];
    if (len >= 192 && len < 255) {
      len = ((len - 192) << 8) + bytes[i++] + 192;
    } else if (len == 255) {
      len = ((bytes[i] << 24) | (bytes[i + 1] << 16) | (bytes[i + 2] << 8) | bytes[i + 3]) >>> 0;
      i += 4;
    }
    if (!len || i + len > bytes.length) {
      throw new Error("Bad signature subpacket");
    }
    out.push({ type: bytes[i] & 0x7f, body: bytes.subarray(i + 1, i + len) });
    i += len;
  }
  return out;
}

function parseSignature(body) {
  if (body[0] != 4) {
    throw new Error("Only v4 signatures are supported");
  }
  const [, type, alg, hashAlg] = body;
  const hashedLen = (body[4] << 8) | body[5];
  const trailerEnd = 6 + hashedLen;
  const unhashedLen = (body[trailerEnd] << 8) | body[trailerEnd + 1];
  const unhashedEnd = trailerEnd + 2 + unhashedLen;
  if (unhashedEnd + 2 > body.length) {
    throw new Error("Truncated signature");
  }
  const subpackets = [...readSubpackets(body.subarray(6, trailerEnd)), ...readSubpackets(body.subarray(trailerEnd + 2, unhashedEnd))];
  let at = unhashedEnd + 2;
  const mpis = [];
  while (at < body.length) {
    const mpi = readMPI(body, at);
    mpis.push(mpi.value);
    at = mpi.next;
  }
  let issuerFingerprint = null;
  let issuerKeyId = null;
  for (const { type: t, body: b } of subpackets) {
    if (t == 33 && b[0] == 4 && b.length == 21) {
      issuerFingerprint = hex(b.subarray(1));
    } else if (t == 16 && b.length == 8) {
      issuerKeyId = hex(b);
    }
  }
  return {
    type,
    alg,
    hashAlg,
    left16: body.subarray(unhashedEnd, unhashedEnd + 2),
    trailer: body.subarray(0, trailerEnd),
    mpis,
    issuerFingerprint,
    issuerKeyId,
  };
}

const canonicalText = data => textBytes(new TextDecoder().decode(data).replace(/\r?\n/g, "\r\n"));
const pad = (bytes, length) => (bytes.length >= length ? bytes : concat(new Uint8Array(length - bytes.length), bytes));

/**
 * Verifies a detached v4 OpenPGP signature over `data` with the primary key
 * of `armoredKey`, which must be `fingerprint`. Throws on any failure.
 */
export async function verifyDetached(data, signature, armoredKey, fingerprint) {
  const key = await readPublicKey(armoredKey);
  if (key.fingerprint != fingerprint.toUpperCase()) {
    throw new Error("Release key does not match the pinned fingerprint");
  }
  const packets = readPackets(dearmor(signature)).filter(p => p.tag == 2);
  if (packets.length != 1) {
    throw new Error("Expected exactly one signature");
  }
  const sig = parseSignature(packets[0].body);
  if (sig.issuerFingerprint ? sig.issuerFingerprint != key.fingerprint : sig.issuerKeyId != key.keyId) {
    throw new Error("Signed by another key");
  }
  if (sig.type != 0 && sig.type != 1) {
    throw new Error("Not a document signature");
  }
  const hash = HASHES[sig.hashAlg];
  if (!hash) {
    throw new Error(`Unsupported hash algorithm ${sig.hashAlg}`);
  }
  const trailer = sig.trailer;
  const n = trailer.length;
  const signed = concat(sig.type == 1 ? canonicalText(data) : data, trailer, new Uint8Array([4, 0xff, (n >>> 24) & 0xff, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff]));
  const digest = new Uint8Array(await crypto.subtle.digest(hash, signed));
  if (digest[0] != sig.left16[0] || digest[1] != sig.left16[1]) {
    throw new Error("Signature does not match");
  }
  let valid = false;
  if ((key.alg == 1 || key.alg == 3) && sig.alg == key.alg && sig.mpis.length == 1) {
    const algorithm = { name: "RSASSA-PKCS1-v1_5", hash };
    const publicKey = await crypto.subtle.importKey("jwk", { kty: "RSA", n: b64url(key.n), e: b64url(key.e) }, algorithm, false, ["verify"]);
    const modulus = key.n.length;
    valid = await crypto.subtle.verify(algorithm, publicKey, pad(sig.mpis[0], modulus), signed);
  } else if (key.ed25519 && (sig.alg == 22 || sig.alg == 27)) {
    const raw = sig.alg == 22 && sig.mpis.length == 2 ? concat(pad(sig.mpis[0], 32), pad(sig.mpis[1], 32)) : null;
    if (raw) {
      const publicKey = await crypto.subtle.importKey("raw", key.ed25519, { name: "Ed25519" }, false, ["verify"]);
      valid = await crypto.subtle.verify({ name: "Ed25519" }, publicKey, raw, digest);
    }
  }
  if (!valid) {
    throw new Error("Signature does not match");
  }
}

function sha256File(path) {
  const hasher = Cc["@mozilla.org/security/hash;1"].createInstance(Ci.nsICryptoHash);
  hasher.init(Ci.nsICryptoHash.SHA256);
  return (async () => {
    for (let offset = 0; ; ) {
      const chunk = await IOUtils.read(path, { offset, maxBytes: WRITE_CHUNK });
      if (!chunk.length) {
        break;
      }
      hasher.update(chunk, chunk.length);
      offset += chunk.length;
    }
    return Array.from(hasher.finish(false), c => c.charCodeAt(0).toString(16).padStart(2, "0")).join("");
  })();
}

const failure = (step, cause) => {
  if (cause?.code == "install-failed") {
    return cause;
  }
  const error = new lazy.WhimsyAIError("install-failed", `${step}: ${cause?.message || cause}`);
  error.step = step;
  error.cause = cause;
  return error;
};

export const WhimsyClaudeCodeInstall = {
  current: null,
  _base: DEFAULT_BASE,
  _key: RELEASE_KEY,
  _fingerprint: RELEASE_KEY_FINGERPRINT,
  _tools: { codesign: "/usr/bin/codesign", spctl: "/usr/sbin/spctl" },
  _home: null,
  _pending: null,
  _listeners: new Set(),

  _testOnly(name) {
    if (!Cu.isInAutomation) {
      throw new Error(`${name} is for automated tests only`);
    }
  },

  setTestBase(url) {
    this._testOnly("setTestBase");
    this._base = url || DEFAULT_BASE;
  },

  async setTestKey(armored) {
    this._testOnly("setTestKey");
    this._key = armored || RELEASE_KEY;
    this._fingerprint = armored ? (await readPublicKey(armored)).fingerprint : RELEASE_KEY_FINGERPRINT;
  },

  setTestTools(tools) {
    this._testOnly("setTestTools");
    this._tools = { codesign: tools?.codesign || "/usr/bin/codesign", spctl: tools?.spctl || "/usr/sbin/spctl" };
  },

  setTestHome(dir) {
    this._testOnly("setTestHome");
    this._home = dir || null;
  },

  get running() {
    return !!this._pending;
  },

  get home() {
    return this._home || Services.dirsvc.get("Home", Ci.nsIFile).path;
  },

  get recordPath() {
    return PathUtils.join(PathUtils.profileDir, RECORD_DIR, RECORD_NAME);
  },

  _ownedPaths(version) {
    return [PathUtils.join(this.home, ".local", "bin", "claude"), PathUtils.join(this.home, ".local", "share", "claude", "versions", version)];
  },

  _isOwnedShape(path) {
    const versions = PathUtils.join(this.home, ".local", "share", "claude", "versions");
    return path == PathUtils.join(this.home, ".local", "bin", "claude") || (PathUtils.parent(path) == versions && VERSION_RE.test(PathUtils.filename(path)));
  },

  _set(step, extra = {}) {
    this.current = { ...this.current, step, ...extra };
    Services.obs.notifyObservers(null, TOPIC, step);
  },

  /**
   * Downloads, verifies and installs the latest Claude Code.
   *
   * @returns {Promise<{ path: string, version: string }>}
   */
  install({ onStep, signal } = {}) {
    if (onStep) {
      this._listeners.add(onStep);
    }
    if (!this._pending) {
      this.current = { step: null, done: [] };
      this._pending = this._install(signal).finally(() => {
        this._pending = null;
        this._listeners.clear();
      });
    }
    return this._pending;
  },

  async _install(signal) {
    let dir = null;
    let step = null;
    const enter = next => {
      if (step) {
        this.current.done = [...this.current.done, step];
      }
      step = next;
      signal?.throwIfAborted();
      this._set(step);
      for (const listener of this._listeners) {
        try {
          listener(step);
        } catch (e) {
          console.error(e);
        }
      }
    };
    try {
      enter("fetch");
      const version = (await this._fetchText(`${this._base}/latest`, 64, signal)).trim();
      if (!VERSION_RE.test(version)) {
        throw new Error("Bad version");
      }
      const manifestBytes = await this._fetchBytes(`${this._base}/${version}/manifest.json`, 1024 * 1024, signal);
      const sigBytes = await this._fetchBytes(`${this._base}/${version}/manifest.json.sig`, 64 * 1024, signal);

      enter("signature");
      await verifyDetached(manifestBytes, sigBytes, this._key, this._fingerprint);
      const manifest = JSON.parse(new TextDecoder().decode(manifestBytes));
      if (manifest.version != version) {
        throw new Error("Manifest is for another version");
      }

      enter("download");
      const platform = this._platform();
      const entry = manifest.platforms?.[platform];
      if (!entry || !/^[0-9a-f]{64}$/i.test(entry.checksum || "")) {
        throw new Error(`No ${platform} build`);
      }
      dir = PathUtils.join(PathUtils.profileDir, RECORD_DIR, `claude-code-download-${Services.uuid.generateUUID().toString().slice(1, 9)}`);
      await IOUtils.makeDirectory(dir, { createAncestors: true, permissions: 0o700 });
      await IOUtils.setPermissions(dir, 0o700);
      const file = PathUtils.join(dir, "claude");
      await this._download(`${this._base}/${version}/${platform}/claude`, file, entry.size, signal);

      enter("hash");
      if (Number.isFinite(entry.size) && (await IOUtils.stat(file)).size != entry.size) {
        throw new Error("Size does not match the manifest");
      }
      if ((await sha256File(file)) != entry.checksum.toLowerCase()) {
        throw new Error("Checksum does not match the manifest");
      }

      enter("codesign");
      const requirement = `-R=anchor apple generic and certificate leaf[subject.OU] = "${TEAM_ID}"`;
      const verify = await this._exec(this._tools.codesign, ["--verify", "--strict", requirement, file], signal);
      if (verify.exitCode != 0) {
        throw new Error("Code signature is not valid");
      }
      const details = await this._exec(this._tools.codesign, ["-dv", file], signal);
      if (details.exitCode != 0 || !new RegExp(`^TeamIdentifier=${TEAM_ID}$`, "m").test(details.stderr)) {
        throw new Error("Not signed by Anthropic");
      }

      enter("notarization");
      const ticket = await this._exec(this._tools.codesign, ["--verify", "--strict", "-R=notarized", file], signal);
      if (ticket.exitCode != 0) {
        throw new Error("Not notarized");
      }
      const assess = await this._exec(this._tools.spctl, ["--assess", "--type", "open", "--context", "context:primary-signature", "-vv", file], signal);
      const said = assess.stdout + assess.stderr;
      if (assess.exitCode != 0 || !/^source=Notarized Developer ID$/m.test(said) || !new RegExp(`^origin=Developer ID Application: .*\\(${TEAM_ID}\\)$`, "m").test(said)) {
        throw new Error("Gatekeeper did not accept it");
      }

      enter("install");
      await IOUtils.setPermissions(file, 0o755);
      const owned = this._ownedPaths(version);
      const before = await Promise.all(owned.map(p => IOUtils.exists(p)));
      const run = await this._exec(file, ["install"], signal, INSTALL_TIMEOUT_MS);
      if (run.exitCode != 0) {
        throw new Error(`claude install exited ${run.exitCode}`);
      }
      const created = [];
      for (const [i, path] of owned.entries()) {
        if (!before[i] && (await IOUtils.exists(path))) {
          created.push(path);
        }
      }
      await this._record(version, created);
      this.current.done = [...this.current.done, step];
      this._set("done");
      return { path: owned[0], version };
    } catch (e) {
      const error = failure(step, e);
      this._set("failed", { error: { code: error.code, step: error.step, message: error.message } });
      throw error;
    } finally {
      if (dir) {
        await IOUtils.remove(dir, { recursive: true, ignoreAbsent: true }).catch(console.error);
      }
    }
  },

  _platform() {
    if (AppConstants.platform != "macosx") {
      throw new Error("Only macOS is supported");
    }
    const info = Services.sysinfo;
    let rosetta = false;
    try {
      rosetta = info.getProperty("rosettaStatus");
    } catch {}
    return rosetta || info.getProperty("arch") == "aarch64" ? "darwin-arm64" : "darwin-x64";
  },

  async _get(url, signal) {
    const response = await fetch(url, { signal, cache: "no-store", credentials: "omit", redirect: "error" });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    return response;
  },

  async _fetchBytes(url, max, signal) {
    const bytes = new Uint8Array(await (await this._get(url, signal)).arrayBuffer());
    if (bytes.length > max) {
      throw new Error("Response too large");
    }
    return bytes;
  },

  async _fetchText(url, max, signal) {
    return new TextDecoder().decode(await this._fetchBytes(url, max, signal));
  },

  async _download(url, file, size, signal) {
    const reader = (await this._get(url, signal)).body.getReader();
    await IOUtils.write(file, new Uint8Array(), { mode: "create" });
    await IOUtils.setPermissions(file, 0o600);
    let parts = [];
    let buffered = 0;
    let total = 0;
    const flush = async () => {
      if (buffered) {
        await IOUtils.write(file, concat(...parts), { mode: "append" });
        parts = [];
        buffered = 0;
      }
    };
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      total += value.length;
      if (Number.isFinite(size) && total > size) {
        throw new Error("Download is larger than the manifest says");
      }
      parts.push(value);
      buffered += value.length;
      if (buffered >= WRITE_CHUNK) {
        await flush();
      }
    }
    await flush();
  },

  async _exec(command, args, signal, timeoutMs = TOOL_TIMEOUT_MS) {
    const environment = Object.assign(lazy.Subprocess.getEnvironment(), { HOME: this.home });
    const proc = await lazy.Subprocess.call({ command, arguments: args, environment, environmentAppend: false, stderr: "pipe" });
    const kill = () => proc.kill();
    signal?.addEventListener("abort", kill, { once: true });
    const timer = setTimeout(kill, timeoutMs);
    try {
      proc.stdin.close().catch(() => {});
      const readAll = async pipe => {
        let text = "";
        for (let chunk; (chunk = await pipe.readString()); ) {
          if (text.length < 1024 * 1024) {
            text += chunk;
          }
        }
        return text;
      };
      const [stdout, stderr] = await Promise.all([readAll(proc.stdout), readAll(proc.stderr)]);
      const { exitCode } = await proc.wait();
      signal?.throwIfAborted();
      return { exitCode, stdout, stderr };
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", kill);
    }
  },

  async _readRecord() {
    try {
      const record = await IOUtils.readJSON(this.recordPath);
      return record && Array.isArray(record.paths) ? record : null;
    } catch {
      return null;
    }
  },

  async _record(version, created) {
    const previous = await this._readRecord();
    const paths = [...new Set([...(previous?.paths || []), ...created])];
    if (!paths.length) {
      return;
    }
    const dir = PathUtils.parent(this.recordPath);
    await IOUtils.makeDirectory(dir, { createAncestors: true, permissions: 0o700 });
    await IOUtils.setPermissions(dir, 0o700);
    await IOUtils.writeJSON(this.recordPath, { version, paths, at: Date.now() }, { tmpPath: this.recordPath + ".tmp" });
    await IOUtils.setPermissions(this.recordPath, 0o600);
  },

  async installedByWhimsy() {
    return !!(await this._readRecord())?.paths.length;
  },

  // Deletes only what install() recorded creating; false when nothing was recorded.
  async remove() {
    const record = await this._readRecord();
    if (!record) {
      return false;
    }
    for (const path of record.paths) {
      if (typeof path == "string" && this._isOwnedShape(path)) {
        await IOUtils.remove(path, { recursive: true, ignoreAbsent: true });
      }
    }
    await IOUtils.remove(this.recordPath, { ignoreAbsent: true });
    return true;
  },
};
