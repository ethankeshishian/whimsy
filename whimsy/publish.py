"""Publish a Whimsy build so other Macs get it, Firefox/Zen style.

  python3 whimsy/publish.py            package, sign, release, update update.xml
  python3 whimsy/publish.py --dry-run  everything except uploading

1. `mach package`: a standalone app (omni.ja, update metadata).
2. Ad-hoc code signing (free: new users approve it once in System Settings).
3. Whimsy-<version>.dmg with an Applications shortcut, for first installs.
4. A full .mar update signed with Whimsy's key. Installed Whimsys only accept
   .mar files signed by it (whimsy/engine_overrides.py puts the public
   certificate in the updater). The private key stays on this Mac, in
   ~/Library/Application Support/Whimsy Updater/signing. Back it up: without it,
   existing installs can't take updates.
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
import shutil
import subprocess
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ENGINE = os.path.join(ROOT, "engine")
CONFIG = json.load(open(os.path.join(ROOT, "whimsy", "publish.json")))
SIGNING = os.path.expanduser("~/Library/Application Support/Whimsy Updater/signing")
WORK = os.path.expanduser("~/Library/Application Support/Whimsy Updater/publish")
PATH = ":".join([os.path.expanduser("~/.cargo/bin"), "/opt/homebrew/bin", "/usr/local/bin",
                 "/usr/bin", "/bin", "/usr/sbin", "/sbin"])


def run(cmd, cwd=ROOT, env=None, capture=False):
    print("$", cmd if isinstance(cmd, str) else " ".join(cmd), flush=True)
    return subprocess.run(cmd, cwd=cwd, shell=isinstance(cmd, str), check=True, text=True,
                          env=dict(os.environ, PATH=PATH, _ZO_DOCTOR="0", **(env or {})),
                          stdout=subprocess.PIPE if capture else None).stdout


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


def make_mar(obj, app, out):
    unsigned = out + ".unsigned"
    env = {"MAR": os.path.join(obj, "dist", "host", "bin", "mar"),
           "MAR_CHANNEL_ID": CONFIG["channel"], "MOZ_PRODUCT_VERSION": app_info(app)["version"]}
    run(["./tools/update-packaging/make_full_update.sh", unsigned, app], cwd=ENGINE, env=env)
    signmar = os.path.join(obj, "dist", "bin", "signmar")
    db = tempfile.mkdtemp()
    password = base64.b16encode(os.urandom(16)).decode()
    p12 = os.path.join(db, "key.p12")
    run(["openssl", "pkcs12", "-export", "-inkey", os.path.join(SIGNING, "private_key.pem"),
         "-in", os.path.join(SIGNING, "cert.pem"), "-name", "mar_sig",
         "-passout", f"pass:{password}", "-out", p12])
    # An NSS database with an empty password, so signmar needn't prompt.
    run(["certutil", "-N", "-d", db, "--empty-password"])
    run(["pk12util", "-i", p12, "-d", db, "-W", password, "-K", ""])
    env = {"DYLD_LIBRARY_PATH": os.path.join(obj, "dist", "bin")}
    run([signmar, "-d", db, "-n", "mar_sig", "-s", unsigned, out], env=env)
    # Verify against the certificate the updater ships with.
    run([signmar, "-D", os.path.join(ROOT, "whimsy", "signing", "whimsy-mar.der"), "-v", out], env=env)
    shutil.rmtree(db)
    os.remove(unsigned)


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


def ensure_signing_key():
    """Restore the key from 1Password if missing; back it up if it never was."""
    sys.path.insert(0, os.path.join(ROOT, "whimsy"))
    import signing_backup
    if not os.path.exists(signing_backup.KEY):
        signing_backup.restore()
    if not signing_backup.is_backed_up():
        try:
            signing_backup.backup()
        except Exception as e:
            print(f"publish: couldn't back up the signing key to 1Password ({e}); "
                  "run python3 whimsy/signing_backup.py backup", flush=True)


def main():
    dry = "--dry-run" in sys.argv
    ensure_signing_key()
    obj = objdir()
    check_updater_trusts_whimsy()
    run(["./mach", "package"], cwd=ENGINE)
    app = packaged_app(obj)
    info = app_info(app)
    repo = CONFIG["github_repo"]
    sys.path.insert(0, os.path.join(ROOT, "whimsy"))
    import version
    revision, release = version.next_release(ROOT)
    tag = f"v{release['version']}"
    release["notes_url"] = release["history"][0]["notes_url"] = f"https://github.com/{repo}/releases/tag/{tag}"
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
    make_mar(obj, signed_app, mar)
    xml = update_xml(info, release, tag, mar)
    open(os.path.join(out, "update.xml"), "w").write(xml)
    print(f"Built {tag}: {dmg}, {mar}")
    if dry:
        return
    version.record_release(ROOT, revision, release)
    run(["git", "add", "whimsy/version.json"])
    run(["git", "commit", "-q", "-m", f"Whimsy {release['version']}"])
    run(["git", "push", "origin", "HEAD:main"])
    gh("release", "create", tag, dmg, mar, "--repo", repo, "--target", "main",
       "--title", f"Whimsy {release['version']} ({datetime.date.today():%b %d})",
       "--notes", notes(release), capture=False)
    channel_path = f"updates/browser/{CONFIG['build_target']}/{CONFIG['channel']}/update.xml"
    publish_pages_file(channel_path, xml, f"Whimsy {tag}")
    print(f"Published {tag}: https://github.com/{repo}/releases/tag/{tag}")


if __name__ == "__main__":
    main()
