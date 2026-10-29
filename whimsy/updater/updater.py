#!/usr/bin/env python3
"""Whimsy's updater: keeps /Applications/Whimsy.app on the newest Zen release.

Two launchd jobs run it (see install.sh):

  updater.py run     nightly: sync the newest Zen release, build, test, stage
  updater.py apply   every minute: install a staged build once Whimsy is closed,
                     and carry out rollbacks
  updater.py stage <app>   stage an app built by hand (whimsy/install_app.sh)
  updater.py status        print the state

It never needs a person. Anything that isn't right (on battery, low disk,
the repository has uncommitted work, a build fails, a test fails) leaves the
installed app alone, logs why, and tries again the next night. A release that
fails twice is skipped until a newer one comes out.

State lives in ~/Library/Application Support/Whimsy Updater:
  state.json    for the browser's Settings (WhimsyUpdates.sys.mjs)
  control.json  from the browser: paused, check_requested, rollback
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
MIN_FREE_GB = 15
MAX_ATTEMPTS = 2
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
    out = sh(["git", "ls-remote", "--tags", "--refs", "upstream"], cwd=repo, quiet=True)
    tags = {}
    for line in out.splitlines():
        sha, ref = line.split("\t")
        tag = ref.removeprefix("refs/tags/")
        if re.fullmatch(r"\d+\.\d+(\.\d+)*[a-z]?", tag):
            tags[tag] = sha
    return tags


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


def preflight(repo, manual):
    control = read_json("control.json", {})
    if control.get("paused"):
        raise Skip("updates are paused")
    if not manual and "AC Power" not in sh(["pmset", "-g", "batt"], quiet=True):
        raise Skip("on battery; waiting for power")
    free_gb = shutil.disk_usage(repo).free / 1e9
    if free_gb < MIN_FREE_GB:
        raise Skip(f"only {free_gb:.0f} GB free; needs {MIN_FREE_GB} GB")
    if git(repo, "rev-parse", "--abbrev-ref", "HEAD", quiet=True).strip() not in (DEV, MAIN):
        raise Skip("the repository isn't on dev or main")
    if git(repo, "status", "--porcelain", quiet=True).strip():
        raise Skip("the repository has uncommitted changes")
    if subprocess.run(["pgrep", "-f", "mach build|surfer build"], capture_output=True).returncode == 0:
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


def build_and_test(repo):
    update_state(message="Importing patches")
    sh("npm run import", cwd=repo)
    sh(["python3", "whimsy/overlay.py", "check"], cwd=repo)
    sh(["python3", "whimsy/precheck.py"], cwd=repo)
    update_state(message="Building (this takes a while after a Firefox update)")
    sh("npx surfer build", cwd=repo, timeout=4 * 3600)
    update_state(message="Testing")
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


def stage(app_path, meta, info=None):
    """Copy an app (dereferencing a dev build's symlinks) into staged/."""
    tmp = STAGED + ".tmp"
    shutil.rmtree(tmp, ignore_errors=True)
    os.makedirs(os.path.dirname(STAGED), exist_ok=True)
    # Follow a dev build's symlinks; skip stale ones left by moved files.
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
    kick("app.whimsy.applier")


def kick(job):
    subprocess.run(["/bin/launchctl", "kickstart", f"gui/{os.getuid()}/{job}"], capture_output=True)


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


def sync_zen(repo, state):
    """Take the newest published Zen release onto the current branch, as one
    commit. Returns its tag, or None when Zen has nothing newer."""
    base = json.load(open(os.path.join(repo, "whimsy", "upstream.json")))
    target = pick_release(repo, base, state)
    if not target:
        log(f"Zen: nothing newer than {base.get('tag') or base.get('label')}")
        return None
    tag, sha = target
    attempts = state.get("attempts", {}).get(tag, 0)
    log(f"Merging Zen {tag} (attempt {attempts + 1})")
    update_state(message=f"Merging Zen {tag}")
    git(repo, "fetch", "--quiet", "--depth", "1", "upstream", "tag", tag, quiet=True)
    replace_upstream_files(repo, tag)
    report = sh(["python3", "whimsy/overlay.py", "apply"], cwd=repo, check=False)
    with open(os.path.join(repo, "whimsy", "upstream.json"), "w") as f:
        json.dump({"repo": base["repo"], "tag": tag, "sha": sha, "label": tag}, f, indent=2)
        f.write("\n")
    git(repo, "add", "-A", quiet=True)
    git(repo, "commit", "-q", "-m", f"Sync upstream Zen {tag}\n\n{report.strip()}", quiet=True)
    ensure_engine(repo)
    superseded = [l for l in report.splitlines() if l.startswith("superseded:")]
    if superseded:
        log("; ".join(superseded))
    return tag


def failed(state, tag, error):
    """Count a failed Zen release; give up on it after MAX_ATTEMPTS."""
    attempts = dict(state.get("attempts", {}))
    skip = list(state.get("skip_tags", []))
    message = str(error)
    if tag:
        attempts[tag] = attempts.get(tag, 0) + 1
        if attempts[tag] >= MAX_ATTEMPTS:
            skip.append(tag)
            message += f". Skipping Zen {tag} until a newer release"
        else:
            message += ". Will try again"
    update_state(status="idle", last_result="failed", message=message, attempts=attempts, skip_tags=skip)


def succeeded(state, tag, result):
    attempts = {k: v for k, v in state.get("attempts", {}).items() if k != tag}
    update_state(status="idle", last_result=result, attempts=attempts, message="")


def cmd_run():
    """Nightly: dev + the newest Zen release becomes main, tested, and is
    published to the Release channel."""
    repo = config().get("repo")
    if not repo:
        log("Not installed: run whimsy/updater/install.sh")
        return
    control = read_json("control.json", {})
    manual = bool(control.get("check_requested"))
    update_control(check_requested=None)
    with Lock("run.lock"):
        update_state(status="running", message="Checking for a new Zen release", last_run=now())
        state = read_json("state.json", {})
        heads, branch, tag = None, None, None
        try:
            preflight(repo, manual)
            branch = current_branch(repo)
            heads = {DEV: branch_sha(repo, DEV) or branch_sha(repo, MAIN), MAIN: branch_sha(repo, MAIN)}
            use_dev_branch(repo)
            if subprocess.run(["git", "merge-base", "--is-ancestor", MAIN, DEV], cwd=repo).returncode:
                # main has commits dev lacks (made by hand): bring them in.
                git(repo, "merge", "-q", "--no-edit", MAIN, quiet=True)
            tag = sync_zen(repo, state)
            unreleased = not version.describe(repo)["released"]
            if not tag and not unreleased:
                log("Up to date: main has everything, and Zen has nothing newer")
                update_state(status="idle", last_result="up-to-date", message="")
                return
            upcoming = version.describe(repo)["version"].split("-dev")[0]
            log(f"Building Whimsy {upcoming} for the Release channel")
            build_and_test(repo)
            git(repo, "branch", "-f", MAIN, "HEAD", quiet=True)
            if config().get("publish"):
                # Other Macs get it through Firefox's updater (whimsy/publish.py).
                update_state(message=f"Publishing Whimsy {upcoming}")
                try:
                    sh(["python3", "whimsy/publish.py"], cwd=repo, timeout=3600)
                    git(repo, "branch", "-f", MAIN, "HEAD", quiet=True)
                except Exception as e:
                    log(f"Publishing failed (the local install is unaffected): {e}")
                if subprocess.run(["git", "push", "-q", "origin", DEV], cwd=repo).returncode:
                    log("Couldn't push dev to GitHub")
            if local_channel() == "release" or tag:
                stage(built_app(repo), *build_meta(repo))
            succeeded(state, tag, "updated")
        except Skip as e:
            log(f"Not updating tonight: {e}")
            update_state(status="idle", last_result="skipped", message=str(e))
        except Exception as e:
            log("Update failed:\n" + traceback.format_exc())
            if heads:
                restore_repo(repo, heads, branch)
            failed(state, tag, e)


def local_channel():
    """This Mac's channel (Settings → Updates): dev installs every dev build."""
    return read_json("control.json", {}).get("channel", "release")


def cmd_ship():
    """A dev build: commit first. Merges any newer Zen release, builds, tests,
    pushes dev, installs here, and publishes to the Dev channel in the
    background."""
    repo = config().get("repo") or os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    if git(repo, "status", "--porcelain", "--untracked-files=no", quiet=True).strip():
        raise SystemExit("ship: commit your changes first")
    print("ship: waiting for any other updater run to finish...", flush=True)
    with Lock("run.lock", wait=True):
        state = read_json("state.json", {})
        branch = current_branch(repo)
        heads = {DEV: branch_sha(repo, DEV) or branch_sha(repo, MAIN), MAIN: branch_sha(repo, MAIN)}
        tag = None
        try:
            use_dev_branch(repo)
            update_state(status="running", message="Dev build: checking Zen")
            tag = sync_zen(repo, state)
            update_state(message="Dev build: importing and building")
            sh("npm run import", cwd=repo)
            sh(["python3", "whimsy/precheck.py"], cwd=repo)
            sh("npx surfer build", cwd=repo, timeout=4 * 3600)
            update_state(message="Dev build: testing")
            sh(["sh", "whimsy/verify.sh", "quick"], cwd=repo, timeout=3600)
        except Exception as e:
            log("Dev build failed:\n" + traceback.format_exc())
            if tag:
                restore_repo(repo, heads, branch)
            failed(state, tag, e)
            raise SystemExit(f"ship: {e}")
        meta, info = build_meta(repo, hand_built=True)
        log(f"Dev build {info['version']} passed")
        if subprocess.run(["git", "push", "-q", "origin", DEV], cwd=repo).returncode:
            log("Couldn't push dev to GitHub")
        succeeded(state, tag, "dev-build")
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
    with Lock("run.lock", wait=True):
        try:
            sh(["python3", "whimsy/publish.py", "--channel", "dev"], cwd=repo, timeout=3600)
            log(f"Published {version.describe(repo)['version']} to the Dev channel")
        except Exception as e:
            log(f"Dev publish failed: {e}")



# ---- installing --------------------------------------------------------------

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
    subprocess.run(["/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework"
                    "/Support/lsregister", "-f", APP], capture_output=True)


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
        log(f"Installing {staged.get('version')}")
        current = state.get("installed")
        swap_in(STAGED, keep_previous=os.path.exists(APP))
        update_state(installed=dict(staged, installed_at=now()),
                     previous=current if os.path.isdir(PREVIOUS) else None, staged=None)
        log(f"Installed {staged.get('version')} at {APP}")


def cmd_stage(app_path):
    repo = config().get("repo") or os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    stage(app_path, *build_meta(repo, hand_built=True))
    cmd_apply()


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
        else:
            print(json.dumps({"state": read_json("state.json", {}),
                              "control": read_json("control.json", {})}, indent=2))
    except Skip as e:
        log(f"{cmd}: {e}")


if __name__ == "__main__":
    main()
