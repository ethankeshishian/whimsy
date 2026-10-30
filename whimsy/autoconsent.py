#!/usr/bin/env python3
"""Refresh the vendored DuckDuckGo Autoconsent (MPL-2.0) behind "Reject
cookie banners" (src/zen/whimsy/cookie-banners): the add-on's content script,
the library (for the compact rule filter and eval snippets), the compact rule
set and the license. The add-on's manifest version is Autoconsent's.

  python3 whimsy/autoconsent.py check              bundled vs. latest on npm
  python3 whimsy/autoconsent.py update [version]   vendor latest (or version)
      --commit        commit the files ("Cookie banners: ...")
      --skip A,B      versions not to take (the nightly's known-bad list)

Fetches with curl from the npm registry and checks the tarball's sha512
against the registry's integrity. Nothing is written until the new files are
complete and the rules parse, so a failed fetch leaves the tree as it was.
The nightly updater (updater.py cmd_run) runs `update --commit` on dev; any
failure here is logged there and never fails the nightly.

Exit status: 0 up to date or updated, 1 failed. The last line says which:
"up to date 17.1.0", "updated 17.0.0 17.1.0", or "failed: <why>".
"""
import base64
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEST = os.path.join("src", "zen", "whimsy", "cookie-banners")
PACKAGE = "@duckduckgo/autoconsent"
REGISTRY = "https://registry.npmjs.org/@duckduckgo%2Fautoconsent"
# package path -> vendored path (under DEST)
FILES = {
    "dist/addon-firefox/content.bundle.js": "autoconsent/content.js",
    "dist/autoconsent.esm.js": "autoconsent/autoconsent.mjs",
    "rules/compact-rules.json": "autoconsent/compact-rules.json",
    "LICENSE": "autoconsent/LICENSE",
}
MANIFEST = "manifest.json"


class Failed(Exception):
    pass


def version_key(text):
    parts = re.findall(r"\d+", text.split("-")[0])
    if not parts:
        raise Failed(f"not a version: {text!r}")
    # A prerelease ("18.0.0-beta.1") sorts before its release.
    return tuple(int(p) for p in parts[:3]) + ((0,) if "-" in text else (1,))


def curl(url, out=None):
    cmd = ["curl", "-fsSL", "--retry", "2", "--connect-timeout", "20", "--max-time", "180", url]
    if out:
        cmd += ["-o", out]
    proc = subprocess.run(cmd, capture_output=True)
    if proc.returncode:
        raise Failed(f"couldn't fetch {url}: {proc.stderr.decode(errors='replace').strip() or proc.returncode}")
    return proc.stdout


def bundled_version():
    with open(os.path.join(ROOT, DEST, MANIFEST)) as f:
        return json.load(f)["version"]


def registry_info(version="latest"):
    try:
        info = json.loads(curl(f"{REGISTRY}/{version}"))
        return info["version"], info["dist"]["tarball"], info["dist"].get("integrity", "")
    except (ValueError, KeyError) as e:
        raise Failed(f"unexpected registry reply for {PACKAGE}@{version}: {e}")


def verify(path, integrity):
    algo, _, expected = integrity.partition("-")
    if algo != "sha512" or not expected:
        raise Failed(f"no sha512 integrity from the registry ({integrity!r})")
    digest = hashlib.sha512()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            digest.update(chunk)
    if base64.b64encode(digest.digest()).decode() != expected:
        raise Failed("the tarball doesn't match the registry's sha512")


def extract(tgz):
    """The files Whimsy vendors, read from the tarball (nothing else is
    extracted, so no path in it lands on disk)."""
    out = {}
    with tarfile.open(tgz) as tar:
        for src in FILES:
            try:
                member = tar.getmember(f"package/{src}")
                data = tar.extractfile(member).read()
            except (KeyError, AttributeError):
                raise Failed(f"the package has no {src}")
            if not data.strip():
                raise Failed(f"{src} is empty")
            out[src] = data
        try:
            version = json.loads(tar.extractfile(tar.getmember("package/package.json")).read())["version"]
        except (KeyError, AttributeError, ValueError):
            raise Failed("the package has no readable package.json")
    try:
        rules = json.loads(out["rules/compact-rules.json"])
    except ValueError:
        raise Failed("compact-rules.json doesn't parse")
    if not isinstance(rules, dict) or not rules:
        raise Failed("compact-rules.json has no rules")
    return out, version


def write(files, version):
    dest = os.path.join(ROOT, DEST)
    manifest_path = os.path.join(dest, MANIFEST)
    with open(manifest_path) as f:
        manifest = f.read()
    # Only the version changes; the manifest keeps its hand formatting.
    manifest, count = re.subn(r'("version"\s*:\s*)"[^"]*"', lambda m: f'{m.group(1)}"{version}"', manifest, count=1)
    if not count:
        raise Failed("the add-on's manifest.json has no version")
    try:
        for src, rel in FILES.items():
            with open(os.path.join(dest, rel), "wb") as f:
                f.write(files[src])
        with open(manifest_path, "w") as f:
            f.write(manifest)
    except OSError as e:
        # Never leave half a release behind.
        subprocess.run(["git", "checkout", "--", DEST], cwd=ROOT)
        raise Failed(f"couldn't write the files: {e}")


def commit(old, new):
    paths = [os.path.join(DEST, rel) for rel in FILES.values()] + [os.path.join(DEST, MANIFEST)]
    message = (f"Cookie banners: Autoconsent rules {old} → {new}\n\n"
               f"DuckDuckGo Autoconsent {new} from npm (whimsy/autoconsent.py).")
    proc = subprocess.run(["git", "commit", "-q", "-m", message, "--", *paths], cwd=ROOT,
                          capture_output=True, text=True)
    if proc.returncode:
        subprocess.run(["git", "checkout", "--", DEST], cwd=ROOT)
        raise Failed(f"couldn't commit: {(proc.stderr or proc.stdout).strip()}")


def update(wanted="latest", do_commit=False, skip=()):
    old = bundled_version()
    version, tarball, integrity = registry_info(wanted)
    if wanted == "latest" and version_key(version) <= version_key(old):
        return f"up to date {old}"
    if version in skip:
        return f"up to date {old} (skipping {version})"
    if version == old:
        return f"up to date {old}"
    tmp = tempfile.mkdtemp(prefix="whimsy-autoconsent-")
    try:
        tgz = os.path.join(tmp, "package.tgz")
        curl(tarball, tgz)
        verify(tgz, integrity)
        files, packaged = extract(tgz)
        if packaged != version:
            raise Failed(f"the tarball is {packaged}, not {version}")
        write(files, version)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    if do_commit:
        commit(old, version)
    return f"updated {old} {version}"


def main(argv):
    args = list(argv)
    mode = args.pop(0) if args else "check"
    do_commit = "--commit" in args
    skip = ()
    if "--skip" in args:
        i = args.index("--skip")
        skip = tuple(v for v in (args[i + 1] if i + 1 < len(args) else "").split(",") if v)
        del args[i:i + 2]
    args = [a for a in args if a != "--commit"]
    try:
        if mode == "check":
            latest = registry_info()[0]
            old = bundled_version()
            print(f"bundled {old}, latest {latest}")
            print("up to date" if version_key(latest) <= version_key(old) else f"update available {latest}")
        elif mode == "update":
            print(update(args[0] if args else "latest", do_commit, skip))
        else:
            print(__doc__)
            return 1
    except Failed as e:
        print(f"failed: {e}")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
