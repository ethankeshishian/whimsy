/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// W23 settings-ai: Claude Code's verified install. A signed manifest (test
// key made here with WebCrypto), the binary's SHA-256, Anthropic's code
// signature and notarization (stand-in codesign and spctl), and removal of
// only what Whimsy installed. Downloads come from a local .sjs.

const { WhimsyClaudeCodeInstall, readPublicKey, verifyDetached, RELEASE_KEY, RELEASE_KEY_FINGERPRINT, STEPS, TOPIC } = ChromeUtils.importESModule(
  "resource:///modules/whimsy/WhimsyClaudeCodeInstall.sys.mjs"
);

const ROOT = getRootDirectory(gTestPath).replace("chrome://mochitests/content", "https://example.com");
const SJS = ROOT + "whimsy_claude_code_install.sjs";
const BASE = SJS + "?path=";
const AI_DIR = PathUtils.join(PathUtils.profileDir, "whimsy-ai");
const TEAM = "Q6L2SF6YDW";
const tmpDirs = [];
const putPaths = [];

registerCleanupFunction(async () => {
  WhimsyClaudeCodeInstall.setTestBase(null);
  await WhimsyClaudeCodeInstall.setTestKey(null);
  WhimsyClaudeCodeInstall.setTestTools(null);
  WhimsyClaudeCodeInstall.setTestHome(null);
  await IOUtils.remove(WhimsyClaudeCodeInstall.recordPath, { ignoreAbsent: true });
  for (const path of putPaths) {
    await fetch(`${SJS}?put=${encodeURIComponent(path)}&b64=`);
  }
  for (const dir of tmpDirs) {
    await IOUtils.remove(dir, { recursive: true, ignoreAbsent: true });
  }
});

const enc = text => new TextEncoder().encode(text);
const cat = (...parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};
const toB64 = bytes => btoa(Array.from(bytes, b => String.fromCharCode(b)).join(""));
const hexOf = bytes => Array.from(bytes, b => b.toString(16).padStart(2, "0")).join("");
const be = (n, size) => Uint8Array.from({ length: size }, (_, i) => (n / 2 ** (8 * (size - 1 - i))) & 0xff);

// A tiny OpenPGP writer: a v4 RSA public key packet and detached v4 signatures.
function mpi(bytes) {
  let i = 0;
  while (i < bytes.length - 1 && !bytes[i]) {
    i++;
  }
  const v = bytes.subarray(i);
  const bits = (v.length - 1) * 8 + (32 - Math.clz32(v[0]));
  return cat(be(bits, 2), v);
}
function packet(tag, body) {
  const len = body.length;
  const header = len < 192 ? [len] : len < 8384 ? [((len - 192) >> 8) + 192, (len - 192) & 0xff] : [255, ...be(len, 4)];
  return cat(new Uint8Array([0xc0 | tag, ...header]), body);
}
function armor(type, bytes) {
  const lines = toB64(bytes).match(/.{1,64}/g).join("\n");
  return `-----BEGIN PGP ${type}-----\n\n${lines}\n-----END PGP ${type}-----\n`;
}

async function makeKey() {
  const pair = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"]
  );
  const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  const n = ChromeUtils.base64URLDecode(jwk.n, { padding: "ignore" });
  const e = ChromeUtils.base64URLDecode(jwk.e, { padding: "ignore" });
  const body = cat(new Uint8Array([4]), be(Math.floor(Date.now() / 1000), 4), new Uint8Array([1]), mpi(new Uint8Array(n)), mpi(new Uint8Array(e)));
  const fp = new Uint8Array(await crypto.subtle.digest("SHA-1", cat(new Uint8Array([0x99]), be(body.length, 2), body)));
  return { privateKey: pair.privateKey, armored: armor("PUBLIC KEY BLOCK", packet(6, body)), fingerprint: fp };
}

async function sign(key, data) {
  const sub = (type, body) => cat(new Uint8Array([body.length + 1, type]), body);
  const hashed = cat(sub(2, be(Math.floor(Date.now() / 1000), 4)), sub(33, cat(new Uint8Array([4]), key.fingerprint)));
  const trailer = cat(new Uint8Array([4, 0, 1, 8]), be(hashed.length, 2), hashed);
  const signed = cat(data, trailer, new Uint8Array([4, 0xff]), be(trailer.length, 4));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", signed));
  const sig = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key.privateKey, signed));
  return enc(armor("SIGNATURE", packet(2, cat(trailer, new Uint8Array([0, 0]), digest.subarray(0, 2), mpi(sig)))));
}

async function put(path, bytes) {
  putPaths.push(path);
  const response = await fetch(`${SJS}?put=${encodeURIComponent(path)}&b64=${encodeURIComponent(toB64(bytes))}`);
  is(await response.text(), "ok", `stored ${path}`);
}

async function tempDir(name) {
  const dir = await IOUtils.createUniqueDirectory(PathUtils.tempDir, name);
  tmpDirs.push(dir);
  return dir;
}

async function script(dir, name, body) {
  const path = PathUtils.join(dir, name);
  await IOUtils.writeUTF8(path, "#!/bin/sh\n" + body);
  await IOUtils.setPermissions(path, 0o755);
  return path;
}

const stubBinary = version =>
  enc(
    "#!/bin/sh\n" +
      '[ "$1" = "install" ] || exit 2\n' +
      `v="$HOME/.local/share/claude/versions/${version}"\n` +
      'mkdir -p "$HOME/.local/bin" "$v"\n' +
      "printf stub > \"$v/claude\"\n" +
      'ln -sf "$v/claude" "$HOME/.local/bin/claude"\n'
  );

/**
 * Publishes a release on the stand-in server and points the installer at
 * it, a fresh home, and stand-in tools.
 */
async function setUpRelease({ version, team = TEAM, tamper = false, wrongChecksum = false }) {
  const key = await makeKey();
  const binary = stubBinary(version);
  const checksum = hexOf(new Uint8Array(await crypto.subtle.digest("SHA-256", wrongChecksum ? enc("other") : binary)));
  const entry = { binary: "claude", checksum, size: binary.length };
  const manifest = enc(JSON.stringify({ version, platforms: { "darwin-arm64": entry, "darwin-x64": entry } }, null, 2));
  const signature = await sign(key, manifest);
  await put("/latest", enc(version + "\n"));
  await put(`/${version}/manifest.json`, tamper ? cat(manifest, enc(" ")) : manifest);
  await put(`/${version}/manifest.json.sig`, signature);
  await put(`/${version}/darwin-arm64/claude`, binary);
  await put(`/${version}/darwin-x64/claude`, binary);

  const tools = await tempDir("whimsy-cc-tools");
  const log = PathUtils.join(tools, "calls.log");
  const codesign = await script(
    tools,
    "codesign",
    `echo "codesign $*" >> "${log}"\n` +
      'for a in "$@"; do\n' +
      `  if [ "$a" = "-dv" ]; then echo "Identifier=com.anthropic.claude-code" >&2; echo "TeamIdentifier=${team}" >&2; exit 0; fi\n` +
      "done\nexit 0\n"
  );
  const spctl = await script(
    tools,
    "spctl",
    `echo "spctl $*" >> "${log}"\n` +
      'echo "$5: accepted" >&2\n' +
      'echo "source=Notarized Developer ID" >&2\n' +
      `echo "origin=Developer ID Application: Anthropic PBC (${team})" >&2\n`
  );
  const home = await tempDir("whimsy-cc-home");
  WhimsyClaudeCodeInstall.setTestBase(BASE.replace(/\/$/, ""));
  await WhimsyClaudeCodeInstall.setTestKey(key.armored);
  WhimsyClaudeCodeInstall.setTestTools({ codesign, spctl });
  WhimsyClaudeCodeInstall.setTestHome(home);
  await IOUtils.remove(WhimsyClaudeCodeInstall.recordPath, { ignoreAbsent: true });
  return { home, log, version };
}

async function downloadsLeft() {
  if (!(await IOUtils.exists(AI_DIR))) {
    return [];
  }
  return (await IOUtils.getChildren(AI_DIR)).filter(p => PathUtils.filename(p).startsWith("claude-code-download-"));
}

async function installObserved() {
  const steps = [];
  const topics = [];
  const observer = (_s, _t, data) => topics.push(data);
  Services.obs.addObserver(observer, TOPIC);
  try {
    const result = await WhimsyClaudeCodeInstall.install({ onStep: s => steps.push(s) });
    return { result, steps, topics };
  } catch (error) {
    return { error, steps, topics };
  } finally {
    Services.obs.removeObserver(observer, TOPIC);
  }
}

async function expectFailure(step) {
  const { error, steps, topics } = await installObserved();
  is(error?.code, "install-failed", `fails with install-failed at ${step}`);
  is(error?.step, step, `the failing step is ${step}`);
  is(steps.at(-1), step, `stopped at ${step}`);
  is(topics.at(-1), "failed", "observers hear failed");
  is(WhimsyClaudeCodeInstall.current.error?.step, step, "the state keeps the failed step");
  Assert.deepEqual(await downloadsLeft(), [], "the download is deleted");
  ok(!(await WhimsyClaudeCodeInstall.installedByWhimsy()), "nothing is recorded");
  ok(!WhimsyClaudeCodeInstall.running, "not running");
  return { error, steps };
}

add_task(async function real_key_fingerprint_and_release_manifest() {
  const key = await readPublicKey(RELEASE_KEY);
  is(key.fingerprint, RELEASE_KEY_FINGERPRINT, "the embedded key's v4 fingerprint is the pinned one");
  is(key.fingerprint, "31DDDE24DDFAB679F42D7BD2BAA929FF1A7ECACE", "pinned fingerprint");
  is(key.alg, 1, "RSA");
  const manifest = new Uint8Array(await (await fetch(ROOT + "whimsy_claude_code_manifest.json")).arrayBuffer());
  const sig = new Uint8Array(await (await fetch(ROOT + "whimsy_claude_code_manifest.json.sig")).arrayBuffer());
  await verifyDetached(manifest, sig, RELEASE_KEY, RELEASE_KEY_FINGERPRINT);
  ok(true, "Anthropic's real signed manifest verifies with the embedded key");
  const tampered = manifest.slice();
  tampered[20] ^= 1;
  await Assert.rejects(verifyDetached(tampered, sig, RELEASE_KEY, RELEASE_KEY_FINGERPRINT), /does not match/, "one changed byte fails");
  const other = await makeKey();
  await Assert.rejects(verifyDetached(manifest, sig, other.armored, RELEASE_KEY_FINGERPRINT), /pinned fingerprint/, "another key fails");
});

add_task(async function test_hooks_need_automation() {
  ok(Cu.isInAutomation, "these tests run in automation");
});

add_task(async function bad_signature_stops_and_deletes() {
  await setUpRelease({ version: "1.0.1", tamper: true });
  const { steps } = await expectFailure("signature");
  Assert.deepEqual(steps, ["fetch", "signature"], "nothing past the signature ran");
});

add_task(async function hash_mismatch_stops() {
  const { home } = await setUpRelease({ version: "1.0.2", wrongChecksum: true });
  await expectFailure("hash");
  ok(!(await IOUtils.exists(PathUtils.join(home, ".local"))), "nothing installed");
});

add_task(async function wrong_team_id_stops() {
  const { home, log } = await setUpRelease({ version: "1.0.3", team: "ABCDE12345" });
  await expectFailure("codesign");
  ok(!(await IOUtils.exists(PathUtils.join(home, ".local"))), "nothing installed");
  ok(!(await IOUtils.readUTF8(log)).includes("spctl"), "notarization never ran");
});

add_task(async function happy_path_records_paths() {
  const { home, log, version } = await setUpRelease({ version: "1.0.4" });
  const { result, steps, topics, error } = await installObserved();
  ok(!error, `installed (${error?.message})`);
  Assert.deepEqual(steps, STEPS, "every step, in order");
  Assert.deepEqual(topics, [...STEPS, "done"], "observers hear each step, then done");
  Assert.deepEqual(STEPS, ["fetch", "signature", "download", "hash", "codesign", "notarization", "install"], "step ids");
  const launcher = PathUtils.join(home, ".local", "bin", "claude");
  const versionDir = PathUtils.join(home, ".local", "share", "claude", "versions", version);
  Assert.deepEqual(result, { path: launcher, version }, "returns the path and version");
  Assert.deepEqual(WhimsyClaudeCodeInstall.current.done, STEPS, "the state lists every step done");
  is(WhimsyClaudeCodeInstall.current.step, "done", "the state ends at done");

  const record = await IOUtils.readJSON(WhimsyClaudeCodeInstall.recordPath);
  is(record.version, version, "records the version");
  Assert.deepEqual(record.paths, [launcher, versionDir], "records the paths it created");
  ok(record.at > 0, "records when");
  is((await IOUtils.stat(WhimsyClaudeCodeInstall.recordPath)).permissions, 0o600, "record is 0600");
  is((await IOUtils.stat(AI_DIR)).permissions, 0o700, "its folder is 0700");
  ok(await WhimsyClaudeCodeInstall.installedByWhimsy(), "installed by Whimsy");
  Assert.deepEqual(await downloadsLeft(), [], "the download is deleted");

  const calls = await IOUtils.readUTF8(log);
  ok(calls.includes(`codesign --verify --strict -R=anchor apple generic and certificate leaf[subject.OU] = "${TEAM}"`), "requires Anthropic's Developer ID");
  ok(calls.includes("codesign --verify --strict -R=notarized"), "requires a notarization ticket");
  ok(calls.includes("spctl --assess --type open --context context:primary-signature -vv"), "asks Gatekeeper");
});

add_task(async function one_install_at_a_time() {
  await setUpRelease({ version: "1.0.5" });
  const first = WhimsyClaudeCodeInstall.install();
  const second = WhimsyClaudeCodeInstall.install();
  is(first, second, "a second call joins the first");
  ok(WhimsyClaudeCodeInstall.running, "running");
  await first;
  ok(!WhimsyClaudeCodeInstall.running, "done");
});

add_task(async function abort_cleans_up() {
  await setUpRelease({ version: "1.0.6" });
  const controller = new AbortController();
  const failed = WhimsyClaudeCodeInstall.install({ signal: controller.signal, onStep: s => s == "hash" && controller.abort() });
  const error = await failed.catch(e => e);
  is(error?.code, "install-failed", "an abort fails the install");
  ok(["hash", "codesign"].includes(error?.step), `at the step that was running (${error?.step})`);
  Assert.deepEqual(await downloadsLeft(), [], "the download is deleted");
  ok(!(await WhimsyClaudeCodeInstall.installedByWhimsy()), "nothing recorded");
});

add_task(async function remove_deletes_only_recorded() {
  const { home, version } = await setUpRelease({ version: "1.0.7" });
  const sibling = PathUtils.join(home, ".local", "bin", "other-tool");
  const olderVersion = PathUtils.join(home, ".local", "share", "claude", "versions", "0.9.0");
  await IOUtils.makeDirectory(PathUtils.parent(sibling), { createAncestors: true });
  await IOUtils.writeUTF8(sibling, "keep");
  await IOUtils.makeDirectory(olderVersion, { createAncestors: true });
  await WhimsyClaudeCodeInstall.install();
  const launcher = PathUtils.join(home, ".local", "bin", "claude");
  const versionDir = PathUtils.join(home, ".local", "share", "claude", "versions", version);
  ok((await IOUtils.exists(launcher)) && (await IOUtils.exists(versionDir)), "installed");

  const record = await IOUtils.readJSON(WhimsyClaudeCodeInstall.recordPath);
  record.paths.push(sibling, PathUtils.join(home, "Documents"));
  await IOUtils.writeJSON(WhimsyClaudeCodeInstall.recordPath, record);

  ok(await WhimsyClaudeCodeInstall.remove(), "removed");
  ok(!(await IOUtils.exists(versionDir)), "the version it installed is gone");
  ok(!(await IOUtils.exists(PathUtils.join(home, ".local", "bin", "claude"))), "the launcher is gone");
  ok(await IOUtils.exists(sibling), "a file it did not install survives, even if listed");
  ok(await IOUtils.exists(olderVersion), "an older version survives");
  ok(!(await IOUtils.exists(WhimsyClaudeCodeInstall.recordPath)), "the record is gone");
  ok(!(await WhimsyClaudeCodeInstall.installedByWhimsy()), "no longer installed by Whimsy");
  ok(!(await WhimsyClaudeCodeInstall.remove()), "nothing left to remove");
});

add_task(async function preexisting_install_has_no_remove() {
  ok(!(await WhimsyClaudeCodeInstall.installedByWhimsy()), "nothing recorded yet");
  const { home, version } = await setUpRelease({ version: "1.0.8" });
  const launcher = PathUtils.join(home, ".local", "bin", "claude");
  const versionDir = PathUtils.join(home, ".local", "share", "claude", "versions", version);
  await IOUtils.makeDirectory(versionDir, { createAncestors: true });
  await IOUtils.makeDirectory(PathUtils.parent(launcher), { createAncestors: true });
  await IOUtils.writeUTF8(launcher, "the person's own");
  await WhimsyClaudeCodeInstall.install();
  ok(!(await IOUtils.exists(WhimsyClaudeCodeInstall.recordPath)), "nothing recorded");
  ok(!(await WhimsyClaudeCodeInstall.installedByWhimsy()), "not installed by Whimsy");
  ok(!(await WhimsyClaudeCodeInstall.remove()), "remove does nothing");
  ok(await IOUtils.exists(launcher), "the person's launcher stays");
  ok(await IOUtils.exists(versionDir), "the person's version stays");
});
