#!/usr/bin/env python3
"""Whimsy's updater: builds and installs Whimsy, and publishes the Release channel.

Two launchd jobs run it (see install.sh):

  updater.py run     nightly: build the Release channel (see below)
  updater.py apply   every minute: install a staged build once Whimsy is closed,
                     and carry out rollbacks
By hand:
  updater.py ship            `npm run ship`: build dev, quick tests, push dev,
                             install here, publish to the Dev channel only
  updater.py promote [commit] [--older]
                             `npm run promote`: move the `release` tag to a
                             dev commit (default: dev's HEAD) that passed a
                             full verify, and push the tag
  updater.py stage <app>     stage an app built by hand (whimsy/install_app.sh)
  updater.py status          print the state

Release flow. A person decides what reaches Release by moving the annotated
`release` tag with `npm run promote`; it refuses a commit without a green full
`whimsy/verify.sh` (all or gate) of a clean build of exactly that commit
(recorded in .surfer/verify/verified.json by verify.sh). The nightly job then
builds Release only when the tag moved since the last Release build, or Zen
published a newer release:
  1. On `main` (the Release branch), merge the tagged commit.
  2. If Zen has a newer release, fetch it by its exact commit, check Zen's tag
     still points there (it refuses otherwise), replace Zen's files with it as
     one commit, and log Zen's changes to build-relevant files (package.json,
     surfer.json, configs/, mozconfig, build scripts, .github, ...) to
     update.log.
  3. Build, then the full verify (`verify.sh gate`). Publish to Release only if
     it's green, and only if `hold` still isn't set.
  4. Merge `main` (the Zen sync and the version commit) back into `dev`.
New dev work never reaches Release without a promote; `npm run ship` never
merges Zen and only ever publishes to Dev.

It never needs a person. Anything that isn't right (hold, on battery, low
disk, the repository has uncommitted work, a build fails, a test fails)
leaves the installed app alone, puts the branches back, logs why, and tries
again the next night. A Zen release that fails twice is skipped until a newer
one comes out; a promoted commit that fails twice on its own is skipped until
the tag moves again.

State lives in ~/Library/Application Support/Whimsy Updater:
  state.json    for the browser's Settings (WhimsyUpdates.sys.mjs);
                release_build records the last Release build (tag commit, Zen)
  control.json  from the browser: auto_install, install_requested, rollback, channel, app_icon (the
                browser never starts a build or a publish);
                by hand only: hold (stops the nightly build and every Release
                publish; the browser never writes it. Remove it by deleting
                the "hold" line. Older builds wrote `paused`; it's ignored)
  staged/ previous/   app bundles
  logs/update.log
"""
import datetime
import fcntl
import json
import os
import re
import shutil
import subprocess
import sys
import time
import traceback
import uuid

# version.py sits next to this file (install.sh copies both), or in the repo.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(1, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
import version  # noqa: E402

HOME = os.path.expanduser("~")
DATA = os.path.join(HOME, "Library", "Application Support", "Whimsy Updater")
LOGS = os.path.join(DATA, "logs")
LOG = os.path.join(LOGS, "update.log")
APP = "/Applications/Whimsy.app"
STAGED = os.path.join(DATA, "staged", "Whimsy.app")
PREVIOUS = os.path.join(DATA, "previous", "Whimsy.app")
DEV = "dev"    # every change; dev builds and the Dev channel
MAIN = "main"  # what the Release channel gets, moved nightly
RELEASE_TAG = "release"  # the dev commit Release is built from (npm run promote)
REMOTE = "origin"
MIN_FREE_GB = 15
MAX_ATTEMPTS = 2
# verify.sh modes that count as a full verify for promote.
FULL_VERIFY_MODES = ("all", "gate")
def pinned_node_bin():
    """The nvm Node matching the repo's .nvmrc (surfer breaks on newer Node)."""
    try:
        repo = json.load(open(os.path.join(DATA, "config.json"))).get("repo") or ""
        major = open(os.path.join(repo, ".nvmrc")).read().strip().lstrip("v").split(".")[0]
        root = os.path.join(HOME, ".nvm", "versions", "node")
        found = sorted((v for v in os.listdir(root) if v.lstrip("v").split(".")[0] == major),
                       key=lambda v: [int(x) for x in v.lstrip("v").split(".")])
        return [os.path.join(root, found[-1], "bin")] if found else []
    except (OSError, ValueError):
        return []


PATH = ":".join([
    *pinned_node_bin(),
    os.path.join(HOME, ".cargo", "bin"), os.path.join(HOME, ".mozbuild", "sccache"),
    "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin",
])


class Skip(Exception):
    """Not an error: conditions aren't right, try again later."""


def now():
    return datetime.datetime.now().astimezone().isoformat(timespec="seconds")


def log(message):
    os.makedirs(LOGS, exist_ok=True)
    if os.path.exists(LOG) and os.path.getsize(LOG) > 2_000_000:
        os.replace(LOG, LOG + ".1")
    line = f"[{datetime.datetime.now():%Y-%m-%d %H:%M:%S}] {message}"
    with open(LOG, "a") as f:
        f.write(line + "\n")
    print(line, flush=True)


def read_json(name, default):
    try:
        with open(os.path.join(DATA, name)) as f:
            return json.load(f)
    except (OSError, ValueError):
        return default


def write_json(name, value):
    os.makedirs(DATA, exist_ok=True)
    path = os.path.join(DATA, name)
    with open(path + ".tmp", "w") as f:
        json.dump(value, f, indent=2)
    os.replace(path + ".tmp", path)


def update_state(**changes):
    state = read_json("state.json", {})
    state.update(changes)
    write_json("state.json", state)
    return state


def update_control(**changes):
    control = read_json("control.json", {})
    control.update(changes)
    write_json("control.json", control)
    return control


def config():
    return read_json("config.json", {})


def sh(cmd, cwd=None, check=True, quiet=False, timeout=None):
    """Run a command, streaming its output to the log."""
    env = dict(os.environ, PATH=PATH, _ZO_DOCTOR="0")
    if not quiet:
        log(f"$ {cmd if isinstance(cmd, str) else ' '.join(cmd)}")
    proc = subprocess.run(cmd, cwd=cwd, shell=isinstance(cmd, str), env=env, text=True,
                          stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=timeout)
    if not quiet and proc.stdout.strip():
        with open(LOG, "a") as f:
            tail = proc.stdout.strip().splitlines()[-60:]
            f.write("    " + "\n    ".join(tail) + "\n")
    if check and proc.returncode != 0:
        raise RuntimeError(f"{cmd if isinstance(cmd, str) else cmd[0]} failed (exit {proc.returncode})")
    return proc.stdout


def whimsy_running():
    return subprocess.run(["pgrep", "-f", f"{APP}/Contents/MacOS/"], capture_output=True).returncode == 0


class Lock:
    def __init__(self, name, wait=False):
        os.makedirs(DATA, exist_ok=True)
        self.f = open(os.path.join(DATA, name), "w")
        self.wait = wait

    def __enter__(self):
        try:
            fcntl.flock(self.f, fcntl.LOCK_EX | (0 if self.wait else fcntl.LOCK_NB))
        except BlockingIOError:
            raise Skip("another updater run is in progress")
        return self

    def __exit__(self, *exc):
        fcntl.flock(self.f, fcntl.LOCK_UN)


# ---- choosing a release ----------------------------------------------------

def version_key(tag):
    return tuple(int(n) for n in re.findall(r"\d+", tag))


def release_tags(repo):
    """Zen's release tags and the commit each points at (an annotated tag's
    peeled commit, so a fetch by that commit gets exactly what was checked)."""
    out = sh(["git", "ls-remote", "--tags", "upstream"], cwd=repo, quiet=True)
    tags, peeled = {}, {}
    for line in out.splitlines():
        if "\t" not in line:
            continue
        sha, ref = line.split("\t")
        tag = ref.removeprefix("refs/tags/")
        if tag.endswith("^{}"):
            peeled[tag[:-3]] = sha
        else:
            tags[tag] = sha
    return {tag: peeled.get(tag, sha) for tag, sha in tags.items()
            if re.fullmatch(r"\d+\.\d+(\.\d+)*[a-z]?", tag)}


def is_newer(base_sha, target_sha, upstream_repo):
    """True if target comes after base on Zen's history (base is its ancestor)."""
    out = sh(["gh", "api", f"repos/{upstream_repo}/compare/{base_sha}...{target_sha}",
              "--jq", ".status"], quiet=True).strip()
    return out == "ahead"


def pick_release(repo, base, state):
    skipped = set(state.get("skip_tags", []))
    tags = release_tags(repo)
    for tag in sorted(tags, key=version_key, reverse=True):
        if tag in skipped:
            continue
        if tags[tag] == base["sha"]:
            return None
        if is_newer(base["sha"], tags[tag], base["repo"]):
            return tag, tags[tag]
        # The newest release that isn't ahead of us: nothing newer to take.
        return None
    return None


# ---- syncing ---------------------------------------------------------------

def git(repo, *args, **kw):
    return sh(["git", *args], cwd=repo, **kw)


def on_hold():
    """`hold` is set by hand in control.json and always holds the nightly
    and every Release publish."""
    return bool(read_json("control.json", {}).get("hold"))


def on_ac_power():
    return "AC Power" in sh(["pmset", "-g", "batt"], quiet=True)


def build_running():
    return subprocess.run(["pgrep", "-f", "mach build|surfer build"], capture_output=True).returncode == 0


def preflight(repo, manual):
    if on_hold():
        raise Skip("the nightly build is on hold (control.json hold)")
    if not manual and not on_ac_power():
        raise Skip("on battery; waiting for power")
    free_gb = shutil.disk_usage(repo).free / 1e9
    if free_gb < MIN_FREE_GB:
        raise Skip(f"only {free_gb:.0f} GB free; needs {MIN_FREE_GB} GB")
    if git(repo, "rev-parse", "--abbrev-ref", "HEAD", quiet=True).strip() not in (DEV, MAIN):
        raise Skip("the repository isn't on dev or main")
    if git(repo, "status", "--porcelain", quiet=True).strip():
        raise Skip("the repository has uncommitted changes")
    if build_running():
        raise Skip("another build is running")


def replace_upstream_files(repo, tag):
    """Swap Zen's files for the release's, leaving Whimsy's files alone."""
    listing = os.path.join(repo, "whimsy", "upstream-files.txt")
    old = set(open(listing).read().split("\n")) - {""}
    new = git(repo, "ls-tree", "-r", "--name-only", tag, quiet=True).split("\n")
    new = [f for f in new if f]
    keep_ours = [f for f in new if f.startswith("configs/branding/") and os.path.exists(os.path.join(repo, f))]
    for rel in old:
        path = os.path.join(repo, rel)
        if os.path.lexists(path) and not rel.startswith("configs/branding/"):
            os.remove(path)
    git(repo, "checkout", tag, "--", ".", quiet=True)
    if keep_ours:
        git(repo, "checkout", "HEAD", "--", *keep_ours, quiet=True)
    with open(listing, "w") as f:
        f.write("\n".join(new) + "\n")


def firefox_version(repo):
    c = json.load(open(os.path.join(repo, "surfer.json")))
    return c["version"]["version"]


def engine_firefox_version(repo):
    try:
        lines = open(os.path.join(repo, "engine", "config", "milestone.txt")).read().split()
        return lines[-1]
    except OSError:
        return None


def ensure_engine(repo):
    """The engine must be the Firefox version surfer.json names."""
    want = firefox_version(repo)
    have = engine_firefox_version(repo)
    if have == want:
        return
    log(f"Firefox source is {have}, {want} needed: downloading it")
    update_state(message=f"Downloading Firefox {want}")
    shutil.rmtree(os.path.join(repo, "engine"), ignore_errors=True)
    for old in os.listdir(os.path.join(repo, ".surfer", "engine")) if os.path.isdir(os.path.join(repo, ".surfer", "engine")) else []:
        if want not in old:
            os.remove(os.path.join(repo, ".surfer", "engine", old))
    sh("npm run download", cwd=repo)
    sh("./mach --no-interactive bootstrap --application-choice browser", cwd=os.path.join(repo, "engine"))


def pin_build_date():
    """One build ID per build. Gecko stamps buildid.h with the current time
    whenever it's regenerated, so the binaries and the later-preprocessed
    application.ini/platform.ini (and `mach package` while publishing) got
    different IDs. update.xml publishes the application.ini one, which is
    newer than the ID the running app reports, so every build kept offering
    itself as an update. MOZ_BUILD_DATE (14 digits) pins it; publishing
    reuses the same value from state.json."""
    date = os.environ.get("MOZ_BUILD_DATE")
    if not (date and len(date) == 14 and date.isdigit()):
        date = time.strftime("%Y%m%d%H%M%S")
        os.environ["MOZ_BUILD_DATE"] = date
    state = read_json("state.json", {})
    state["build_date"] = date
    write_json("state.json", state)
    return date


def reuse_build_date():
    """Publishing after a build: package with the build's pinned ID."""
    if not os.environ.get("MOZ_BUILD_DATE"):
        date = read_json("state.json", {}).get("build_date")
        if date:
            os.environ["MOZ_BUILD_DATE"] = date


# ---- build and verify records (for promote) -----------------------------------
#
# A full surfer build records the commit it was built from
# (.surfer/verify/build.json); verify.sh records each run's result against
# that build (verified.json). promote only moves the release tag to a commit
# whose own clean build passed a full verify.

VERIFY_DIR = os.path.join(".surfer", "verify")
VERIFIED_KEPT = 50


def head_state(repo):
    """HEAD's full commit, and whether tracked files differ from it."""
    sha = git(repo, "rev-parse", "HEAD", quiet=True).strip()
    dirty = bool(git(repo, "status", "--porcelain", "--untracked-files=no", quiet=True).strip())
    return sha, dirty


def _record_path(repo, name):
    return os.path.join(repo, VERIFY_DIR, name)


def _read_record(repo, name, default):
    try:
        with open(_record_path(repo, name)) as f:
            return json.load(f)
    except (OSError, ValueError):
        return default


def _write_record(repo, name, value):
    path = _record_path(repo, name)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path + ".tmp", "w") as f:
        json.dump(value, f, indent=2)
    os.replace(path + ".tmp", path)


def begin_build(repo):
    """Before a full build: forget the last build's commit (a failed build
    leaves no record) and return what's being built."""
    try:
        os.remove(_record_path(repo, "build.json"))
    except OSError:
        pass
    return head_state(repo)


def record_build(repo, built=None):
    """After a successful full build: the commit the engine was built from."""
    sha, dirty = built or head_state(repo)
    _write_record(repo, "build.json", {"commit": sha, "dirty": dirty, "at": now()})


def record_verify(repo, mode, status):
    """After verify.sh: its result, against the commit of the build it tested."""
    sha, dirty = head_state(repo)
    build = _read_record(repo, "build.json", {})
    entry = {"mode": mode, "status": int(status), "dirty": dirty, "at": now(),
             "built_commit": build.get("commit"), "build_dirty": build.get("dirty")}
    records = _read_record(repo, "verified.json", {})
    records.pop(sha, None)
    records[sha] = entry
    # Newest last; keep the newest few.
    records = dict(list(records.items())[-VERIFIED_KEPT:])
    _write_record(repo, "verified.json", records)
    return entry


def verified_green(repo, sha):
    """Why `sha` can't be promoted, or None when a green full verify of a clean
    build of exactly that commit is recorded."""
    entry = _read_record(repo, "verified.json", {}).get(sha)
    if not entry:
        return "no verify run is recorded for it"
    if entry.get("mode") not in FULL_VERIFY_MODES:
        return f"its last verify was `{entry.get('mode')}`, not a full one (sh whimsy/verify.sh)"
    if entry.get("status") != 0:
        return "its last full verify failed"
    if entry.get("dirty") or entry.get("build_dirty"):
        return "it was verified with uncommitted changes"
    if entry.get("built_commit") != sha:
        return "the verified build wasn't built from it (npm run ship or npm run build, then verify)"
    return None


def build_and_test(repo):
    update_state(message="Importing patches")
    sh("npm run import", cwd=repo)
    sh(["python3", "whimsy/overlay.py", "check"], cwd=repo)
    sh(["python3", "whimsy/precheck.py"], cwd=repo)
    update_state(message="Building (this takes a while after a Firefox update)")
    pin_build_date()
    built = begin_build(repo)
    sh("npx surfer set brand release && npx surfer build", cwd=repo, timeout=4 * 3600)
    record_build(repo, built)
    update_state(message="Testing (full verify)")
    sh(["sh", "whimsy/verify.sh", "gate"], cwd=repo, timeout=3600)


def built_app(repo):
    for name in os.listdir(os.path.join(repo, "engine")):
        candidate = os.path.join(repo, "engine", name, "dist", "Whimsy.app")
        if name.startswith("obj-") and os.path.isdir(candidate):
            return candidate
    raise RuntimeError("no built Whimsy.app")


def build_meta(repo, **extra):
    """What a build of the repo is: its Whimsy version, Zen base, commit."""
    info = version.describe(repo)
    base = json.load(open(os.path.join(repo, "whimsy", "upstream.json")))
    meta = {"version": info["version"], "zen": info["zen"], "zen_label": info["zen_label"],
            "zen_sha": base["sha"], "firefox": info["firefox"], "whimsy_commit": info["commit"],
            "built_at": now(), **extra}
    return meta, info


def packaged(app_path):
    """The packaged app (`mach package`: omni.ja, precomplete, removed-files)
    for a build. W14-22: a dev build's dist/Whimsy.app is loose files with no
    precomplete. Installed, a later packaged update laid over it removes only
    what precomplete and removed-files name, so its loose defaults/preferences,
    manifests and modules stayed and Gecko read them over omni.ja's."""
    if os.path.exists(os.path.join(app_path, "Contents", "Resources", "precomplete")):
        return app_path
    dist = os.path.dirname(os.path.abspath(app_path))
    engine = os.path.dirname(os.path.dirname(dist))
    sh(["./mach", "package"], cwd=engine, timeout=3600)
    for name in sorted(os.listdir(dist)):
        candidate = os.path.join(dist, name, "Whimsy.app")
        if os.path.exists(os.path.join(candidate, "Contents", "Resources", "precomplete")):
            return candidate
    raise RuntimeError("mach package produced no packaged Whimsy.app")


def stage(app_path, meta, info=None):
    """Copy the packaged app for a build into staged/ (never a dev bundle)."""
    app_path = packaged(app_path)
    tmp = STAGED + ".tmp"
    shutil.rmtree(tmp, ignore_errors=True)
    os.makedirs(os.path.dirname(STAGED), exist_ok=True)
    shutil.copytree(app_path, tmp, symlinks=False, ignore_dangling_symlinks=True,
                    ignore=shutil.ignore_patterns(".DS_Store"))
    if info:
        version.write_bundle(tmp, info)
    shutil.rmtree(STAGED, ignore_errors=True)
    os.replace(tmp, STAGED)
    meta = dict(meta, id=uuid.uuid4().hex, staged_at=now())
    with open(os.path.join(os.path.dirname(STAGED), "meta.json"), "w") as f:
        json.dump(meta, f, indent=2)
    update_state(staged=meta)
    log(f"Staged {meta.get('version')}; it installs when Whimsy isn't running")
    if job_installed(APPLY_JOB):
        kick(APPLY_JOB)


APPLY_JOB = "app.whimsy.applier"


def job_installed(job):
    """Whether whimsy/updater/install.sh installed this launchd job."""
    return os.path.exists(os.path.join(HOME, "Library", "LaunchAgents", f"{job}.plist"))


def kick(job):
    """Start a launchd job now; logs and returns False if launchctl fails."""
    result = subprocess.run(["/bin/launchctl", "kickstart", f"gui/{os.getuid()}/{job}"],
                            capture_output=True, text=True)
    if result.returncode != 0:
        detail = (result.stderr or result.stdout).strip()
        log(f"Couldn't start {job}: launchctl exited {result.returncode}" + (f": {detail}" if detail else ""))
        return False
    return True


def branch_sha(repo, branch):
    return git(repo, "rev-parse", "--verify", "-q", branch, check=False, quiet=True).strip() or None


def current_branch(repo):
    return git(repo, "rev-parse", "--abbrev-ref", "HEAD", quiet=True).strip()


def use_dev_branch(repo):
    """Work happens on dev; create it from main the first time."""
    if not branch_sha(repo, DEV):
        git(repo, "branch", DEV, MAIN, quiet=True)
    if current_branch(repo) != DEV:
        git(repo, "checkout", "-q", DEV, quiet=True)


def restore_repo(repo, heads, branch):
    """Put the branches back where they were before a failed run."""
    log("Putting the repository back the way it was")
    git(repo, "reset", "--hard", "-q", check=False, quiet=True)
    git(repo, "clean", "-fdq", check=False, quiet=True)
    git(repo, "checkout", "-q", "-f", DEV, check=False, quiet=True)
    git(repo, "reset", "--hard", "-q", heads[DEV], check=False, quiet=True)
    if heads.get(MAIN):
        git(repo, "branch", "-f", MAIN, heads[MAIN], check=False, quiet=True)
    if branch != DEV:
        git(repo, "checkout", "-q", branch, check=False, quiet=True)
    try:
        # Keep the engine matching the checkout, for hand builds.
        ensure_engine(repo)
        sh("npm run import", cwd=repo, check=False)
    except Exception as e:
        log(f"Couldn't re-import into the engine: {e}")


def zen_base(repo):
    with open(os.path.join(repo, "whimsy", "upstream.json")) as f:
        return json.load(f)


def newer_zen(repo, state):
    """(tag, commit) of a Zen release newer than the checkout's, or None."""
    base = zen_base(repo)
    target = pick_release(repo, base, state)
    if not target:
        log(f"Zen: nothing newer than {base.get('tag') or base.get('label')}")
    return target


def fetch_zen(repo, tag, sha):
    """Fetch exactly the commit seen when Zen was checked, never the tag by
    name, then make sure Zen's tag still points there. A tag that moved in
    between (a re-tag, or someone tampering with it) is refused."""
    if not re.fullmatch(r"[0-9a-f]{40}", sha or ""):
        raise RuntimeError(f"Zen {tag}: not a full commit id: {sha!r}")
    git(repo, "fetch", "--quiet", "--no-tags", "--depth", "1", "upstream", sha, quiet=True)
    got = git(repo, "rev-parse", "--verify", "-q", f"{sha}^{{commit}}", check=False, quiet=True).strip()
    if got != sha:
        raise RuntimeError(f"Zen {tag}: fetching commit {sha} didn't give that commit")
    now_sha = release_tags(repo).get(tag)
    if now_sha != sha:
        raise RuntimeError(f"Zen {tag}: the tag now points at {now_sha or 'nothing'}, not {sha} as when "
                           "it was checked; refusing to build it")


# Files run or read while building (Zen's own build scripts, npm and cargo
# config, CI). A Zen release that changes one is worth reading before trusting
# what the nightly built; the nightly lists them in update.log.
BUILD_FILES = {
    "package.json", "package-lock.json", ".nvmrc", ".npmrc", ".python-version", "requirements.txt",
    "surfer.json", "rust-toolchain.toml", "Cargo.toml", "Cargo.lock", "Makefile", "Taskfile.yml",
    "babel.config.json", "eslint.config.mjs", "svgo.config.js", "tsconfig.json",
}
BUILD_DIRS = ("configs/", "scripts/", "tools/", "build/", ".github/", ".husky/", ".cargo/", "python/",
              "taskcluster/", "toolkit/mozapps/update/updater/")
BUILD_SUFFIXES = (".py", ".sh", ".mk", ".configure", ".mozbuild", ".gyp", ".gypi")
# Shown in full (capped): small, and run on every build.
BUILD_DIFF_FILES = ("package.json", "surfer.json", ".nvmrc", ".npmrc", "mozconfig")
BUILD_DIFF_LINES = 200


def build_relevant(path):
    """Whether a path (in the repo, or in Firefox for a patch's target) is
    executed or read at build time."""
    base = os.path.basename(path)
    return (path in BUILD_FILES or base in BUILD_FILES or path.startswith(BUILD_DIRS)
            or base.startswith(("mozconfig", "Makefile", "moz.build", "moz.configure"))
            or base.endswith(BUILD_SUFFIXES) or base in ("package.json", "Cargo.toml"))


def patch_targets(text):
    return re.findall(r"^diff --git a/(\S+) b/", text, re.M)


def zen_build_changes(repo, before, after):
    """Lines describing changes between two commits to build-relevant files,
    including patches that change Firefox's build files."""
    status = git(repo, "diff", "--name-status", "--no-renames", before, after, quiet=True)
    numstat = {}
    for line in git(repo, "diff", "--numstat", "--no-renames", before, after, quiet=True).splitlines():
        parts = line.split("\t")
        if len(parts) == 3:
            numstat[parts[2]] = f"+{parts[0]} -{parts[1]}"
    lines, shown = [], []
    for line in status.splitlines():
        if "\t" not in line:
            continue
        kind, path = line.split("\t", 1)
        why = ""
        if path.endswith(".patch"):
            text = git(repo, "show", f"{after if kind != 'D' else before}:{path}", check=False, quiet=True)
            touched = [t for t in patch_targets(text) if build_relevant(t)]
            if not touched:
                continue
            why = " [patches " + ", ".join(touched[:4]) + (", ..." if len(touched) > 4 else "") + "]"
        elif not build_relevant(path):
            continue
        lines.append(f"  {kind[0]} {path} ({numstat.get(path, 'binary')}){why}")
        if os.path.basename(path).startswith(BUILD_DIFF_FILES) and path != "package-lock.json":
            shown.append(path)
    if not lines:
        return []
    out = [f"{len(lines)} build-relevant file(s) changed:", *lines]
    budget = BUILD_DIFF_LINES
    for path in shown:
        diff = git(repo, "diff", "--no-color", "-U1", before, after, "--", path, check=False, quiet=True)
        body = diff.splitlines()
        # Skip the diff/index/mode/---/+++ header.
        body = body[next((i for i, l in enumerate(body) if l.startswith("@@")), len(body)):]
        if not body or budget <= 0:
            continue
        out.append(f"  --- {path}")
        out += ["    " + l for l in body[:budget]]
        if len(body) > budget:
            out.append(f"    ... {len(body) - budget} more lines")
        budget -= len(body)
    return out


def sync_zen(repo, state, target=None):
    """Take a published Zen release onto the current branch, as one commit
    (by default the newest one). Returns its tag, or None when Zen has nothing
    newer."""
    base = zen_base(repo)
    target = target or newer_zen(repo, state)
    if not target:
        return None
    tag, sha = target
    attempts = state.get("attempts", {}).get(tag, 0)
    log(f"Merging Zen {tag} at {sha} (attempt {attempts + 1})")
    update_state(message=f"Merging Zen {tag}")
    fetch_zen(repo, tag, sha)
    before = git(repo, "rev-parse", "HEAD", quiet=True).strip()
    replace_upstream_files(repo, sha)
    report = sh(["python3", "whimsy/overlay.py", "apply"], cwd=repo, check=False)
    with open(os.path.join(repo, "whimsy", "upstream.json"), "w") as f:
        json.dump({"repo": base["repo"], "tag": tag, "sha": sha, "label": tag}, f, indent=2)
        f.write("\n")
    git(repo, "add", "-A", quiet=True)
    git(repo, "commit", "-q", "-m", f"Sync upstream Zen {tag}\n\n{report.strip()}", quiet=True)
    changes = zen_build_changes(repo, before, "HEAD")
    log(f"Zen {tag}: " + ("\n".join(changes) if changes else "no build-relevant files changed"))
    ensure_engine(repo)
    superseded = [l for l in report.splitlines() if l.startswith("superseded:")]
    if superseded:
        log("; ".join(superseded))
    return tag


def refresh_autoconsent(repo, state):
    """Cookie banners: take a newer DuckDuckGo Autoconsent release (the
    rules behind "Reject cookie banners") as one commit on dev, like any other
    dev change: the next ship builds it, and it reaches Release with the next
    promote. Returns the new version, or None. Never raises: a failed fetch is
    logged and the bundled rules stay. Versions in state autoconsent_skip
    (set by older nightlies after a failed build) are skipped."""
    script = os.path.join(repo, "whimsy", "autoconsent.py")
    if not os.path.exists(script):
        return None
    update_state(message="Checking for new cookie banner rules")
    skip = state.get("autoconsent_skip", [])
    try:
        out = sh(["python3", "whimsy/autoconsent.py", "update", "--commit", "--skip", ",".join(skip)],
                 cwd=repo, check=False, timeout=600)
    except Exception as e:
        out = f"failed: {e}"
    result = (out.strip().splitlines() or [""])[-1]
    if git(repo, "status", "--porcelain", "--", "src/zen/whimsy/cookie-banners", check=False, quiet=True).strip():
        # Shouldn't happen (autoconsent.py only writes complete releases),
        # but never build or commit half an update.
        git(repo, "checkout", "-q", "--", "src/zen/whimsy/cookie-banners", check=False, quiet=True)
    if result.startswith("updated "):
        new = result.split()[-1]
        log(f"Cookie banners: Autoconsent rules updated to {new}")
        return new
    if result.startswith("failed"):
        log(f"Cookie banners: kept the bundled rules ({result})")
    return None


def failed(state, tag, error, release=None):
    """Count a failed Zen release (or, when no Zen release was involved, the
    promoted commit); give up on it after MAX_ATTEMPTS."""
    attempts = dict(state.get("attempts", {}))
    skip = list(state.get("skip_tags", []))
    changes = {}
    message = str(error)
    key = tag or (f"release:{release}" if release else None)
    if key:
        attempts[key] = attempts.get(key, 0) + 1
        if attempts[key] >= MAX_ATTEMPTS:
            if tag:
                skip.append(tag)
                message += f". Skipping Zen {tag} until a newer release"
            else:
                changes["skip_release"] = release
                message += (f". Skipping the promoted commit {release[:12]} until the release tag "
                            "moves (npm run promote)")
        else:
            message += ". Will try again"
    update_state(status="idle", last_result="failed", message=message, attempts=attempts, skip_tags=skip,
                 **changes)


def succeeded(state, tag, result, release=None):
    done = {tag, f"release:{release}" if release else None}
    attempts = {k: v for k, v in state.get("attempts", {}).items() if k not in done}
    update_state(status="idle", last_result=result, attempts=attempts, message="")


def release_commit(repo):
    """The commit the annotated `release` tag points at, or None."""
    return git(repo, "rev-parse", "-q", "--verify", f"refs/tags/{RELEASE_TAG}^{{commit}}",
               check=False, quiet=True).strip() or None


def merge_back(repo):
    """Give dev main's new commits (a Zen sync, the version commit). Never
    raises: on a conflict dev is left as it was, and the log says so."""
    if not branch_sha(repo, MAIN):
        return True
    if current_branch(repo) != DEV:
        git(repo, "checkout", "-q", DEV, quiet=True)
    if not subprocess.run(["git", "merge-base", "--is-ancestor", MAIN, DEV], cwd=repo).returncode:
        return True
    try:
        git(repo, "merge", "-q", "--no-edit", MAIN, quiet=True)
        log("Merged main (Release) back into dev")
        return True
    except Exception as e:
        git(repo, "merge", "--abort", check=False, quiet=True)
        git(repo, "reset", "--hard", "-q", check=False, quiet=True)
        log(f"Couldn't merge main into dev ({e}); dev is unchanged. Merge it by hand: "
            "git checkout dev && git merge main")
        return False


def publish_release(repo):
    """Sign and publish the checked-out build to the Release channel."""
    sh(["python3", "whimsy/publish.py", "--channel", "release"], cwd=repo, timeout=3600)


def cmd_run():
    """Nightly: when the release tag moved or Zen has a newer release, build
    the tagged commit (plus that Zen release) on main, run the full verify,
    publish to Release if it's green, and merge back into dev."""
    repo = config().get("repo")
    if not repo:
        log("Not installed: run whimsy/updater/install.sh")
        return
    manual = False  # only launchd or a person at the terminal runs this
    update_control(check_requested=None)  # left by older builds; unused
    with Lock("run.lock"):
        update_state(status="running", message="Checking the release tag and Zen", last_run=now())
        state = read_json("state.json", {})
        heads, branch, tag, release = None, None, None, None
        restore = True  # until something is published
        try:
            preflight(repo, manual)
            branch = current_branch(repo)
            heads = {DEV: branch_sha(repo, DEV) or branch_sha(repo, MAIN), MAIN: branch_sha(repo, MAIN)}
            use_dev_branch(repo)
            # A failed merge-back on an earlier night: try again.
            merge_back(repo)
            heads[DEV] = branch_sha(repo, DEV)
            release = release_commit(repo)
            if not release:
                raise Skip("there's no release tag yet: promote a verified dev commit (npm run promote)")
            last = state.get("release_build") or {}
            moved = last.get("commit") != release
            if moved and state.get("skip_release") == release:
                log(f"The promoted commit {release[:12]} failed twice; waiting for the release tag to move")
                moved = False
            if moved:
                # The tag can be moved by hand too; promote's check still applies.
                why_not = verified_green(repo, release)
                if why_not:
                    raise Skip(f"the release tag points at {release[:12]}, which can't be released: {why_not}")

            # Start from the tagged commit, on the Release branch.
            if not branch_sha(repo, MAIN):
                git(repo, "branch", MAIN, release, quiet=True)
            git(repo, "checkout", "-q", MAIN, quiet=True)
            git(repo, "merge", "-q", "--no-edit", release, quiet=True)
            target = newer_zen(repo, state)
            if not moved and not target:
                git(repo, "checkout", "-q", "-f", DEV, quiet=True)
                git(repo, "branch", "-f", MAIN, heads[MAIN] or release, quiet=True)
                log("Up to date: the release tag hasn't moved, and Zen has nothing newer")
                update_state(status="idle", last_result="up-to-date", message="")
                return
            if target:
                tag = target[0]  # counted against Zen if anything from here fails
                sync_zen(repo, state, target)
            upcoming = version.describe(repo)["version"].split("-dev")[0]
            why = " and ".join(filter(None, [moved and f"release tag at {release[:12]}",
                                             tag and f"Zen {tag}"]))
            log(f"Building Whimsy {upcoming} for the Release channel ({why})")
            build_and_test(repo)
            log("Full verify passed")
            published = False
            if not config().get("publish"):
                published = True  # this Mac only installs; nothing to publish
            elif on_hold():
                log("Not publishing: hold was set during the build (it builds again once hold is removed)")
            else:
                # Other Macs get it through Firefox's updater (whimsy/publish.py).
                update_state(message=f"Publishing Whimsy {upcoming}")
                restore = False  # publish.py may have pushed main: never rewind it now
                try:
                    publish_release(repo)
                    published = True
                except Exception as e:
                    log(f"Publishing failed (the local install is unaffected; it tries again tomorrow): {e}")
            restore = False
            if published:
                update_state(release_build={"commit": release, "zen": zen_base(repo).get("tag"),
                                            "main": branch_sha(repo, MAIN), "at": now()},
                             skip_release=None)
            if local_channel() == "release":
                try:
                    stage(built_app(repo), *build_meta(repo))
                except Exception as e:
                    log(f"Couldn't stage the Release build here: {e}")
            merge_back(repo)
            if config().get("publish") and subprocess.run(["git", "push", "-q", REMOTE, DEV], cwd=repo).returncode:
                log("Couldn't push dev to GitHub")
            succeeded(state, tag, "updated" if published else "built", release)
        except Skip as e:
            log(f"Not updating tonight: {e}")
            update_state(status="idle", last_result="skipped", message=str(e))
        except Exception as e:
            log("Update failed:\n" + traceback.format_exc())
            if heads and restore:
                restore_repo(repo, heads, branch)
            failed(state, tag, e, None if tag else release)
        finally:
            if heads:
                try:
                    if current_branch(repo) != DEV:
                        git(repo, "checkout", "-q", DEV, check=False, quiet=True)
                    if not git(repo, "status", "--porcelain", quiet=True).strip():
                        # Cookie banner rules land on dev like any other change
                        # and reach Release with the next promote.
                        refresh_autoconsent(repo, state)
                except Exception as e:
                    log(f"After the nightly: {e}")


def local_channel():
    """This Mac's channel (Settings → Updates): dev installs every dev build."""
    return read_json("control.json", {}).get("channel", "release")


def cmd_ship():
    """A dev build: commit first. Builds dev, runs the quick tests, pushes dev,
    installs here, and publishes to the Dev channel in the background. It
    never merges Zen (the nightly does, on main, then merges it into dev) and
    never publishes to Release."""
    repo = config().get("repo") or os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    if git(repo, "status", "--porcelain", "--untracked-files=no", quiet=True).strip():
        raise SystemExit("ship: commit your changes first")
    print("ship: waiting for any other updater run to finish...", flush=True)
    with Lock("run.lock", wait=True):
        state = read_json("state.json", {})
        try:
            use_dev_branch(repo)
            update_state(status="running", message="Dev build: importing and building")
            pin_build_date()
            sh("npm run import", cwd=repo)
            sh(["python3", "whimsy/precheck.py"], cwd=repo)
            built = begin_build(repo)
            sh("npx surfer set brand release && npx surfer build", cwd=repo, timeout=4 * 3600)
            record_build(repo, built)
            update_state(message="Dev build: testing")
            sh(["sh", "whimsy/verify.sh", "quick"], cwd=repo, timeout=3600)
        except Exception as e:
            log("Dev build failed:\n" + traceback.format_exc())
            failed(state, None, e)
            raise SystemExit(f"ship: {e}")
        meta, info = build_meta(repo, hand_built=True)
        log(f"Dev build {info['version']} passed")
        if subprocess.run(["git", "push", "-q", REMOTE, DEV], cwd=repo).returncode:
            log("Couldn't push dev to GitHub")
        succeeded(state, None, "dev-build")
        stage(built_app(repo), meta, info)
    if config().get("publish"):
        # In the background: package, sign, upload (a few minutes).
        out = open(os.path.join(LOGS, "publish-dev.log"), "a")
        subprocess.Popen([sys.executable, os.path.abspath(__file__), "publish-dev"], cwd=repo,
                         stdout=out, stderr=out, start_new_session=True)
        log(f"Publishing {info['version']} to the Dev channel in the background "
            "(logs/publish-dev.log)")
    cmd_apply()


def cmd_publish_dev():
    repo = config().get("repo")
    reuse_build_date()
    with Lock("run.lock", wait=True):
        try:
            sh(["python3", "whimsy/publish.py", "--channel", "dev"], cwd=repo, timeout=3600)
            log(f"Published {version.describe(repo)['version']} to the Dev channel")
        except Exception as e:
            log(f"Dev publish failed: {e}")



def cmd_promote(args):
    """`npm run promote [commit]`: move the annotated release tag to a dev
    commit (default: dev's HEAD) that passed a full verify, and push it. The
    nightly then builds Release from it. Moving the tag to an older commit
    (back in history) needs --older."""
    repo = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    older = "--older" in args
    rest = [a for a in args if a != "--older"]
    if len(rest) > 1 or any(a.startswith("-") for a in rest):
        raise SystemExit("usage: npm run promote -- [commit] [--older]")
    spec = rest[0] if rest else DEV
    sha = git(repo, "rev-parse", "-q", "--verify", f"{spec}^{{commit}}", check=False, quiet=True).strip()
    if not sha:
        raise SystemExit(f"promote: {spec} isn't a commit")
    if not branch_sha(repo, DEV) or subprocess.run(["git", "merge-base", "--is-ancestor", sha, DEV],
                                                   cwd=repo).returncode:
        raise SystemExit(f"promote: {sha[:12]} isn't on dev; only dev commits are released")
    why_not = verified_green(repo, sha)
    if why_not:
        raise SystemExit(f"promote: {sha[:12]} can't be released: {why_not}.\n"
                         "Build it (npm run ship), run the full verify (sh whimsy/verify.sh), then promote again.")
    old_ref = git(repo, "rev-parse", "-q", "--verify", f"refs/tags/{RELEASE_TAG}", check=False, quiet=True).strip()
    old = release_commit(repo)
    if old and old != sha and not older and subprocess.run(
            ["git", "merge-base", "--is-ancestor", old, sha], cwd=repo).returncode:
        raise SystemExit(f"promote: {sha[:12]} doesn't come after the current release ({old[:12]}); "
                         "pass --older to release an older commit anyway")
    entry = _read_record(repo, "verified.json", {})[sha]
    subject = git(repo, "log", "-1", "--format=%s", sha, quiet=True).strip()
    message = (f"Release {sha[:12]}: {subject}\n\nPromoted {now()}; full verify ({entry['mode']}) "
               f"passed {entry['at']}.")
    git(repo, "tag", "-a", "-f", "-m", message, RELEASE_TAG, sha, quiet=True)
    push = subprocess.run(["git", "push", "-q", "-f", REMOTE, f"refs/tags/{RELEASE_TAG}"], cwd=repo,
                          capture_output=True, text=True)
    if push.returncode:
        # Keep the local tag where GitHub's is, so both agree.
        if old_ref:
            git(repo, "update-ref", f"refs/tags/{RELEASE_TAG}", old_ref, quiet=True)
        else:
            git(repo, "tag", "-d", RELEASE_TAG, check=False, quiet=True)
        detail = (push.stderr or push.stdout).strip().splitlines()[-1:] or [""]
        raise SystemExit(f"promote: couldn't push the release tag ({detail[0]}); nothing changed")
    print(f"promote: release now points at {sha[:12]} ({subject}).")
    print("The nightly job builds and publishes it to Release (unless control.json has \"hold\").")


def cmd_record(kind, args):
    """Called by verify.sh (record-verify <mode> <status>) and after a full
    build (record-build)."""
    repo = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    if kind == "build":
        record_build(repo)
    else:
        mode, status = args[0], args[1]
        entry = record_verify(repo, mode, status)
        green = mode in FULL_VERIFY_MODES and entry["status"] == 0 and not entry["dirty"]
        print(f"verify: recorded {mode} {'pass' if entry['status'] == 0 else 'fail'}"
              + (" (counts for npm run promote)" if green else ""))


# ---- installing --------------------------------------------------------------

LSREGISTER = ("/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework"
              "/Support/lsregister")


def swap_in(source, keep_previous):
    """Put an app at /Applications/Whimsy.app; optionally keep the current one."""
    if os.path.exists(APP):
        if keep_previous:
            shutil.rmtree(PREVIOUS, ignore_errors=True)
            os.makedirs(os.path.dirname(PREVIOUS), exist_ok=True)
            os.replace(APP, PREVIOUS)
        else:
            trash = APP + ".old"
            shutil.rmtree(trash, ignore_errors=True)
            os.replace(APP, trash)
            shutil.rmtree(trash, ignore_errors=True)
    os.replace(source, APP)
    subprocess.run([LSREGISTER, "-f", APP], capture_output=True)
    apply_app_icon()


APP_ICON = os.path.join(DATA, "app-icon.icns")


# Sets a Finder custom icon (argv: app, icns), as WhimsyAppIcon.sys.mjs does.
SET_ICON_JXA = """function run(a) {
  ObjC.import("AppKit");
  const img = $.NSImage.alloc.initWithContentsOfFile(a[1]);
  if (img.isNil()) throw new Error("unreadable icon " + a[1]);
  if (!$.NSWorkspace.sharedWorkspace.setIconForFileOptions(img, a[0], 0)) throw new Error("setIcon failed");
}"""


def apply_app_icon():
    """Re-apply the icon chosen in Whimsy's settings (saved by the browser as
    app-icon.icns) to a freshly installed app, so Finder and launchers keep it.
    Same steps as WhimsyAppIcon.sys.mjs, then a LaunchServices refresh.

    A signed bundle (publish.py's, with Whimsy's stable certificate) is never
    modified inside or re-signed: this Mac may not have the signing key, and
    an ad-hoc re-sign can't satisfy the certificate's designated requirement,
    so keychain items and TCC grants would stop matching and prompt again
    after every update. It gets a Finder custom icon instead (Icon\\r and
    FinderInfo at the bundle root), which leaves the sealed contents and so
    the signature valid, and an xattr marker. An unsigned local build gets
    the icns swapped inside, as before."""
    icon = read_json("control.json", {}).get("app_icon")
    if not icon or not os.path.exists(APP_ICON) or not os.path.isdir(APP):
        return
    res = os.path.join(APP, "Contents", "Resources")
    try:
        if os.path.exists(os.path.join(APP, "Contents", "_CodeSignature", "CodeResources")):
            sh(["/usr/bin/osascript", "-l", "JavaScript", "-e", SET_ICON_JXA, APP, APP_ICON], quiet=True)
            sh(["/usr/bin/xattr", "-w", "whimsy-app-icon", icon, APP], quiet=True)
        else:
            default = os.path.join(res, "firefox-default.icns")
            if not os.path.exists(default):
                shutil.copy2(os.path.join(res, "firefox.icns"), default)
            shutil.copy2(APP_ICON, os.path.join(res, "firefox.icns"))
            with open(os.path.join(res, "whimsy-app-icon"), "w") as f:
                f.write(icon)
        os.utime(APP)
        subprocess.run([LSREGISTER, "-f", APP], capture_output=True)
        log(f"Applied the {icon} app icon")
    except Exception as e:
        log(f"Couldn't apply the {icon} app icon: {e}")


def wait_for_quit(seconds):
    for _ in range(seconds):
        if not whimsy_running():
            return True
        time.sleep(1)
    return False


def cmd_apply():
    with Lock("apply.lock"):
        control = read_json("control.json", {})
        state = read_json("state.json", {})

        if control.get("rollback"):
            if not wait_for_quit(60):
                return
            relaunch = control["rollback"].get("relaunch", True)
            update_control(rollback=None)
            previous = state.get("previous")
            if not previous or not os.path.isdir(PREVIOUS):
                log("Rollback requested, but there's no previous version")
            else:
                installed = state.get("installed", {})
                log(f"Rolling back from {installed.get('version')} to {previous.get('version')}")
                swap_in(PREVIOUS, keep_previous=False)
                # Skip the Zen release being left (older states named it "version").
                leaving = installed.get("zen_label") or installed.get("version")
                skip = list(state.get("skip_tags", []))
                if leaving and leaving not in skip and re.fullmatch(r"\d+\.\d+(\.\d+)*[a-z]?", leaving):
                    skip.append(leaving)
                staged = state.get("staged")
                if staged and (staged.get("zen_label") or staged.get("version")) in skip:
                    shutil.rmtree(os.path.dirname(STAGED), ignore_errors=True)
                    staged = None
                update_state(installed=dict(previous, id=uuid.uuid4().hex, rolled_back=True,
                                            installed_at=now()),
                             previous=None, staged=staged, skip_tags=skip)
            if relaunch:
                subprocess.run(["open", "--env", "MOZ_ALLOW_DOWNGRADE=1", "-a", APP])
            return

        staged = state.get("staged")
        if not staged or not os.path.isdir(STAGED):
            return
        if whimsy_running():
            return
        if control.get("auto_install") is False and not control.get("install_requested"):
            # Firefox's "install automatically" is off: wait for a check from Settings.
            return
        update_control(install_requested=None)
        log(f"Installing {staged.get('version')}")
        current = state.get("installed")
        swap_in(STAGED, keep_previous=os.path.exists(APP))
        update_state(installed=dict(staged, installed_at=now()),
                     previous=current if os.path.isdir(PREVIOUS) else None, staged=None)
        log(f"Installed {staged.get('version')} at {APP}")


def cmd_stage(app_path):
    """Stage a hand build and install it now if Whimsy is closed. Without the
    local updater's applier job nothing installs it later, so say so."""
    repo = config().get("repo") or os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    stage(app_path, *build_meta(repo, hand_built=True))
    try:
        cmd_apply()
    except Skip as e:
        log(f"apply: {e}")
    if not read_json("state.json", {}).get("staged"):
        print(f"Installed {APP}")
    elif job_installed(APPLY_JOB):
        print("Staged: installs when you next quit Whimsy.")
    else:
        print("Staged, but not installed: Whimsy is running and the local updater isn't installed\n"
              "(whimsy/updater/install.sh), so nothing installs it when Whimsy quits. Quit Whimsy,\n"
              "then run: python3 whimsy/updater/updater.py apply", file=sys.stderr)


def main():
    cmd = sys.argv[1] if len(sys.argv) > 1 else "status"
    try:
        if cmd == "run":
            cmd_run()
        elif cmd == "apply":
            cmd_apply()
        elif cmd == "stage":
            cmd_stage(sys.argv[2])
        elif cmd == "ship":
            cmd_ship()
        elif cmd == "publish-dev":
            cmd_publish_dev()
        elif cmd == "promote":
            cmd_promote(sys.argv[2:])
        elif cmd == "record-verify":
            cmd_record("verify", sys.argv[2:])
        elif cmd == "record-build":
            cmd_record("build", sys.argv[2:])
        else:
            print(json.dumps({"state": read_json("state.json", {}),
                              "control": read_json("control.json", {})}, indent=2))
    except Skip as e:
        log(f"{cmd}: {e}")


if __name__ == "__main__":
    main()
