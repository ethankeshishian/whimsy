"""Publish a Whimsy build so other Macs get it, Firefox/Zen style.

  python3 whimsy/publish.py            package, sign, release, update update.xml
  python3 whimsy/publish.py --dry-run  everything except uploading
  python3 whimsy/publish.py --channel dev   a dev build for the Dev channel

Two update channels: Release (standard users; main, published by the nightly
updater from the promoted `release` tag) and Dev (opt-in in Settings; every
dev build, published by `npm run ship`). Each has its own update.xml path and
MAR channel ID (`mar_channels` in publish.json: whimsy-release, whimsy-dev).
While `mar_channel_bridge` is true, both still sign with the old shared ID
("release"), which is all that builds from before wave 9 accept; set it to
false once every install runs a wave 9 build (they accept the new IDs too).
`hold` in the updater's control.json refuses a Release publish.

The MAR's signed product version is the build's ID as YYYYMMDD.HHMMSS, not
Zen's version. Whimsy's updater (whimsy-updater-cpp.patch) compares it with
the installed build's ID, so a signed but older build is refused as a
downgrade, whatever update.xml claims (security-full-3 M3).

1. `mach package`: a standalone app (omni.ja, update metadata).
2. Ad-hoc code signing (free: new users approve it once in System Settings).
3. Whimsy-<version>.dmg with an Applications shortcut, for first installs.
4. A full .mar update signed with Whimsy's key. Installed Whimsys only accept
   .mar files signed by it (whimsy/engine_overrides.py puts the public
   certificate in the updater). The private key lives in 1Password
   (whimsy/signing_backup.py; until it's migrated there, the old on-disk key
   is used with a warning): it's fetched while signing, into a private
   temporary folder that is wiped afterwards. Commands never carry a password,
   and none is printed.
Each release is Zen's version plus a Whimsy revision, like 1.24b-w3
(whimsy/version.py); whimsy/version.json records it and the history.

5. A GitHub Release with both, and update.xml on GitHub Pages, which every
   Whimsy polls (Zen's update host is pointed there by whimsy/overlay.py).
   Whimsy downloads updates in the background and installs them on restart.
"""
import base64
import configparser
import datetime
import glob
import hashlib
import json
import os
import re
import secrets
import shutil
import signal
import subprocess
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ENGINE = os.path.join(ROOT, "engine")
CONFIG = json.load(open(os.path.join(ROOT, "whimsy", "publish.json")))
WORK = os.path.expanduser("~/Library/Application Support/Whimsy Updater/publish")
CONTROL = os.path.expanduser("~/Library/Application Support/Whimsy Updater/control.json")
PUBLIC_DER = os.path.join(ROOT, "whimsy", "signing", "whimsy-mar.der")
sys.path.insert(0, os.path.join(ROOT, "whimsy"))
import signing_backup  # noqa: E402
PATH = ":".join([os.path.expanduser("~/.cargo/bin"), "/opt/homebrew/bin", "/usr/local/bin",
                 "/usr/bin", "/bin", "/usr/sbin", "/sbin"])


# Arguments whose value is a secret unless it names a file or variable.
SECRET_FLAGS = {"-passout", "-passin", "-W", "-K", "-password", "--password"}


def redact(cmd):
    """The command as printed (and so logged): never a password (security-full-3 L1)."""
    if isinstance(cmd, str):
        return re.sub(r"pass:\S+", "pass:***", cmd)
    out, hide = [], False
    for arg in cmd:
        arg = str(arg)
        if hide and not arg.startswith(("file:", "env:", "fd:")) and arg != "":
            arg = "***"
        elif arg.startswith("pass:"):
            arg = "pass:***"
        hide = arg in SECRET_FLAGS
        out.append(arg)
    return " ".join(out)


def run(cmd, cwd=ROOT, env=None, capture=False, input=None):
    print("$", redact(cmd), flush=True)
    kw = {"input": input} if input is not None else {}
    return subprocess.run(cmd, cwd=cwd, shell=isinstance(cmd, str), check=True, text=input is None,
                          env=dict(os.environ, PATH=PATH, _ZO_DOCTOR="0", **(env or {})),
                          stdout=subprocess.PIPE if capture else None, **kw).stdout


def objdir():
    # The configured build folder (ignore stray empty obj-* folders).
    dirs = [d for d in glob.glob(os.path.join(ENGINE, "obj-*"))
            if os.path.exists(os.path.join(d, "config.status"))]
    if not dirs:
        raise SystemExit("publish: build first")
    return dirs[0]


def packaged_app(obj):
    """The app `mach package` staged (not the dev build in dist/)."""
    for app in glob.glob(os.path.join(obj, "dist", "*", "Whimsy.app")):
        if os.path.exists(os.path.join(app, "Contents", "Resources", "precomplete")):
            return app
    raise SystemExit("publish: mach package produced no app")


def app_info(app):
    ini = configparser.RawConfigParser()
    ini.read(os.path.join(app, "Contents", "Resources", "application.ini"))
    platform = configparser.RawConfigParser()
    platform.read(os.path.join(app, "Contents", "Resources", "platform.ini"))
    url = ini.get("AppUpdate", "URL", fallback="")
    if CONFIG["update_host"] not in url:
        raise SystemExit(f"publish: this build checks {url} for updates, not Whimsy's channel. "
                         "Run npm run import and rebuild.")
    return {
        "version": ini["App"]["Version"],
        "build_id": ini["App"]["BuildID"],
        "platform_version": platform.get("Build", "Milestone", fallback=ini["App"]["Version"]),
    }


def check_updater_trusts_whimsy():
    want = open(os.path.join(ROOT, "whimsy", "signing", "whimsy-mar.der"), "rb").read()
    cert = os.path.join(ENGINE, "toolkit", "mozapps", "update", "updater", "release_primary.der")
    if open(cert, "rb").read() != want:
        raise SystemExit("publish: the updater doesn't trust Whimsy's certificate. "
                         "Run npm run import and rebuild.")


def sign_app(app):
    run(["codesign", "--force", "--deep", "--sign", "-", app])
    run(["codesign", "--verify", "--deep", "--strict", app])


def make_dmg(app, out, version):
    root = tempfile.mkdtemp()
    shutil.copytree(app, os.path.join(root, "Whimsy.app"), symlinks=True)
    os.symlink("/Applications", os.path.join(root, "Applications"))
    run(["hdiutil", "create", "-volname", f"Whimsy {version}", "-srcfolder", root,
         "-ov", "-format", "UDZO", out])
    shutil.rmtree(root)


def mar_channel_id(channel):
    """The MAR channel ID a channel's updates are signed with."""
    if CONFIG.get("mar_channel_bridge", True):
        # Builds from before wave 9 only accept the old shared ID.
        return CONFIG["channel"]
    return CONFIG["mar_channels"][channel]


def mar_product_version(build_id):
    """The signed product version: the build ID as YYYYMMDD.HHMMSS (each part
    fits Firefox's version comparator). Whimsy's updater compares it with the
    installed build's ID and refuses older builds."""
    if not re.fullmatch(r"\d{14}", build_id or ""):
        raise SystemExit(f"publish: the build ID {build_id!r} isn't YYYYMMDDHHMMSS")
    return f"{build_id[:8]}.{build_id[8:]}"


def sign_mar(obj, unsigned, out):
    """Sign with the key from 1Password. The PEM only ever goes to openssl on
    stdin; the PKCS#12 export and the NSS database live in a private folder
    that's wiped afterwards, and both are protected by random passwords that
    are never on a command line or in the log. signmar reads the database's
    password from stdin, so the database is never password-less, even if this
    process is killed before the cleanup."""
    signmar = os.path.join(obj, "dist", "bin", "signmar")
    env = {"DYLD_LIBRARY_PATH": os.path.join(obj, "dist", "bin")}
    key = signing_backup.signing_key()
    with signing_backup.private_dir() as tmp:
        cert = os.path.join(tmp, "cert.pem")
        run(["openssl", "x509", "-inform", "DER", "-in", PUBLIC_DER, "-out", cert])
        p12_password, db_password = secrets.token_hex(24), secrets.token_hex(24)
        p12_pass_file = os.path.join(tmp, "p12.pass")
        db_pass_file = os.path.join(tmp, "db.pass")
        signing_backup.write_private(p12_pass_file, p12_password.encode() + b"\n")
        signing_backup.write_private(db_pass_file, db_password.encode() + b"\n")
        p12 = os.path.join(tmp, "key.p12")
        run(["openssl", "pkcs12", "-export", "-inkey", "/dev/stdin", "-in", cert, "-name", "mar_sig",
             "-passout", f"file:{p12_pass_file}", "-out", p12], input=key)
        del key
        db = os.path.join(tmp, "nssdb")
        os.mkdir(db, 0o700)
        run(["certutil", "-N", "-d", db, "-f", db_pass_file])
        run(["pk12util", "-i", p12, "-d", db, "-w", p12_pass_file, "-k", db_pass_file])
        # Only the database (password-protected) is needed from here on.
        for name in (p12, p12_pass_file, db_pass_file):
            signing_backup.shred(name)
        run([signmar, "-d", db, "-n", "mar_sig", "-s", unsigned, out], env=env,
            input=(db_password + "\n").encode())


def make_mar(obj, app, out, channel="release"):
    unsigned = out + ".unsigned"
    env = {"MAR": os.path.join(obj, "dist", "host", "bin", "mar"),
           "MAR_CHANNEL_ID": mar_channel_id(channel),
           "MOZ_PRODUCT_VERSION": mar_product_version(app_info(app)["build_id"])}
    run(["./tools/update-packaging/make_full_update.sh", unsigned, app], cwd=ENGINE, env=env)
    try:
        sign_mar(obj, unsigned, out)
    finally:
        if os.path.exists(unsigned):
            os.remove(unsigned)
    # Verify against the certificate the updater ships with.
    signmar = os.path.join(obj, "dist", "bin", "signmar")
    run([signmar, "-D", PUBLIC_DER, "-v", out], env={"DYLD_LIBRARY_PATH": os.path.join(obj, "dist", "bin")})


def update_xml(info, release, tag, mar):
    repo = CONFIG["github_repo"]
    sha512 = hashlib.sha512(open(mar, "rb").read()).hexdigest()
    url = f"https://github.com/{repo}/releases/download/{tag}/{os.path.basename(mar)}"
    return f'''<?xml version="1.0" encoding="UTF-8"?>
<updates>
  <update type="minor" displayVersion="{release["version"]}" appVersion="{info["version"]}" platformVersion="{info["platform_version"]}" buildID="{info["build_id"]}" detailsURL="https://github.com/{repo}/releases/tag/{tag}">
    <patch type="complete" URL="{url}" hashFunction="sha512" hashValue="{sha512}" size="{os.path.getsize(mar)}"/>
  </update>
</updates>
'''


def gh(*args, capture=True, **kw):
    return run(["gh", *args], capture=capture, **kw)


def publish_pages_file(path, content, message):
    """Write one file on the gh-pages branch (creating the branch and Pages)."""
    repo = CONFIG["github_repo"]
    try:
        gh("api", f"repos/{repo}/git/ref/heads/gh-pages")
    except subprocess.CalledProcessError:
        tree = json.loads(gh("api", f"repos/{repo}/git/trees", "-X", "POST", "-f", "tree[][path]=.nojekyll",
                             "-f", "tree[][mode]=100644", "-f", "tree[][type]=blob", "-f", "tree[][content]="))
        commit = json.loads(gh("api", f"repos/{repo}/git/commits", "-X", "POST",
                               "-f", "message=Whimsy update channel", "-f", f"tree={tree['sha']}"))
        gh("api", f"repos/{repo}/git/refs", "-X", "POST", "-f", "ref=refs/heads/gh-pages", "-f", f"sha={commit['sha']}")
    try:
        gh("api", f"repos/{repo}/pages")
    except subprocess.CalledProcessError:
        try:
            gh("api", f"repos/{repo}/pages", "-X", "POST", "-f", "source[branch]=gh-pages", "-f", "source[path]=/")
        except subprocess.CalledProcessError:
            pass  # Already enabled (GitHub can lag behind a fresh repo).
    sha = None
    try:
        sha = json.loads(gh("api", f"repos/{repo}/contents/{path}?ref=gh-pages"))["sha"]
    except subprocess.CalledProcessError:
        pass
    args = ["api", f"repos/{repo}/contents/{path}", "-X", "PUT", "-f", f"message={message}",
            "-f", "branch=gh-pages", "-f", f"content={base64.b64encode(content.encode()).decode()}"]
    if sha:
        args += ["-f", f"sha={sha}"]
    gh(*args)


def notes(release):
    changes = "".join(f"- {line}\n" for line in release["notes"]) or "- Rebuilt on the same Zen\n"
    return f"""Whimsy {release['version']}: built on Zen {release['zen']} ({release['zen_label']}), Firefox {release['firefox']}, Whimsy commit {release['commit']}.

**Changes**
{changes}

**First install (Apple silicon Mac):** download the .dmg, drag Whimsy to Applications, open it. macOS will say it can't verify the developer: open System Settings → Privacy & Security, and click **Open Anyway** next to Whimsy. That's needed once; after that Whimsy updates itself in the background and installs updates when you restart it.
"""


def on_hold():
    """`hold` (set by hand in the updater's control.json) stops every Release
    publish, whoever starts it."""
    try:
        with open(CONTROL) as f:
            return bool(json.load(f).get("hold"))
    except (OSError, ValueError):
        return False


def exit_on_signal(signum, frame):
    # Turn SIGTERM/SIGHUP into an exception, so the signing folder's cleanup runs.
    raise SystemExit(f"publish: stopped by signal {signum}")


DEV_KEPT = 5


def prune_dev_releases(repo):
    """Keep only the newest few dev pre-releases (each is ~100 MB)."""
    listing = json.loads(gh("release", "list", "--repo", repo, "--limit", "100",
                            "--json", "tagName,isPrerelease,createdAt"))
    dev = sorted((r for r in listing if r["isPrerelease"] and "-dev." in r["tagName"]),
                 key=lambda r: r["createdAt"], reverse=True)
    for old in dev[DEV_KEPT:]:
        gh("release", "delete", old["tagName"], "--repo", repo, "--yes", "--cleanup-tag")


def main():
    dry = "--dry-run" in sys.argv
    channel = sys.argv[sys.argv.index("--channel") + 1] if "--channel" in sys.argv else "release"
    if channel not in ("release", "dev"):
        raise SystemExit("publish: --channel is release or dev")
    if channel == "release" and on_hold():
        raise SystemExit("publish: control.json has hold: not publishing to Release")
    for sig in (signal.SIGTERM, signal.SIGHUP):
        signal.signal(sig, exit_on_signal)
    try:
        # Fail before packaging when signing can't work. Without a vault yet,
        # the on-disk key is used (with a warning) until signing_migrate.py.
        signing_backup.key_source()
    except RuntimeError as e:
        raise SystemExit(f"publish: {e}")
    obj = objdir()
    check_updater_trusts_whimsy()
    run(["./mach", "package"], cwd=ENGINE)
    app = packaged_app(obj)
    info = app_info(app)
    repo = CONFIG["github_repo"]
    sys.path.insert(0, os.path.join(ROOT, "whimsy"))
    import version
    if channel == "dev":
        revision, release = None, version.describe(ROOT)
        if release["released"] or release["commit"].endswith("+"):
            raise SystemExit("publish: dev builds need committed, unreleased changes")
        release["notes"] = version.notes_since(ROOT, version.load(ROOT).get("commit"))
        release["date"] = datetime.date.today().isoformat()
    else:
        revision, release = version.next_release(ROOT)
    tag = f"v{release['version']}"
    release["notes_url"] = f"https://github.com/{repo}/releases/tag/{tag}"
    if channel == "release":
        release["history"][0]["notes_url"] = release["notes_url"]
    if not dry and subprocess.run(["gh", "release", "view", tag, "--repo", repo],
                                  capture_output=True).returncode == 0:
        raise SystemExit(f"publish: {tag} is already released")
    out = os.path.join(WORK, tag)
    shutil.rmtree(out, ignore_errors=True)
    os.makedirs(out)
    signed_app = os.path.join(out, "Whimsy.app")
    shutil.copytree(app, signed_app, symlinks=True)
    version.write_bundle(signed_app, release)
    sign_app(signed_app)
    dmg = os.path.join(out, f"Whimsy-{release['version']}-macos-arm64.dmg")
    make_dmg(signed_app, dmg, release["version"])
    mar = os.path.join(out, "whimsy-macos-arm64.mar")
    make_mar(obj, signed_app, mar, channel)
    xml = update_xml(info, release, tag, mar)
    open(os.path.join(out, "update.xml"), "w").write(xml)
    print(f"Built {tag}: {dmg}, {mar}")
    if dry:
        return
    if channel == "dev":
        # The dev branch is already pushed (npm run ship); just release it.
        commit = run(["git", "rev-parse", "HEAD"], capture=True).strip()
        gh("release", "create", tag, dmg, mar, "--repo", repo, "--target", commit, "--prerelease",
           "--title", f"Whimsy {release['version']} (dev)", "--notes", notes(release), capture=False)
        publish_pages_file(f"updates/browser/{CONFIG['build_target']}/dev/update.xml", xml, f"Whimsy {tag}")
        prune_dev_releases(repo)
        print(f"Published {tag} to the Dev channel")
        return
    version.record_release(ROOT, revision, release)
    run(["git", "add", "whimsy/version.json"])
    run(["git", "commit", "-q", "-m", f"Whimsy {release['version']}"])
    try:
        run(["git", "push", "origin", "HEAD:main"])
    except subprocess.CalledProcessError:
        # Not published: drop the version commit so it's still unreleased.
        run(["git", "reset", "-q", "--hard", "HEAD~1"])
        raise SystemExit("publish: couldn't push main (has GitHub's main diverged?)")
    gh("release", "create", tag, dmg, mar, "--repo", repo, "--target", "main",
       "--title", f"Whimsy {release['version']} ({datetime.date.today():%b %d})",
       "--notes", notes(release), capture=False)
    channel_path = f"updates/browser/{CONFIG['build_target']}/release/update.xml"
    publish_pages_file(channel_path, xml, f"Whimsy {tag}")
    print(f"Published {tag}: https://github.com/{repo}/releases/tag/{tag}")


if __name__ == "__main__":
    main()
