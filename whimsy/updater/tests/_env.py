"""Test bootstrap: a throwaway HOME (so the updater's data folder, logs,
control.json and 1Password scratch folders are all temporary), git identity,
and the updater/publish modules loaded from this checkout.

Nothing here touches the network, the real Whimsy Updater folder, real keys,
or the real repository: repos are temporary, `op`/`gh`/builds are faked.
"""
import importlib.util
import os
import subprocess
import sys
import tempfile

HOME = tempfile.mkdtemp(prefix="whimsy-updater-tests-")
os.environ["HOME"] = HOME
for key, value in {"GIT_AUTHOR_NAME": "Test", "GIT_AUTHOR_EMAIL": "test@example.org",
                   "GIT_COMMITTER_NAME": "Test", "GIT_COMMITTER_EMAIL": "test@example.org",
                   "GIT_CONFIG_NOSYSTEM": "1", "GIT_TERMINAL_PROMPT": "0"}.items():
    os.environ[key] = value
os.environ.pop("WHIMSY_SIGNING_VAULT", None)
os.environ.pop("MOZ_BUILD_DATE", None)

WHIMSY = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
ROOT = os.path.dirname(WHIMSY)
sys.path.insert(0, WHIMSY)


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


updater = load("updater", os.path.join(WHIMSY, "updater", "updater.py"))
assert updater.DATA.startswith(HOME), "the updater must use the throwaway HOME"
import signing_backup  # noqa: E402
assert signing_backup.DATA.startswith(HOME)
publish = load("publish", os.path.join(WHIMSY, "publish.py"))
import signing_migrate  # noqa: E402


def git(repo, *args, check=True):
    return subprocess.run(["git", *args], cwd=repo, capture_output=True, text=True, check=check).stdout.strip()


# Keep test output readable: the updater echoes its log lines to stdout.
updater.print = lambda *args, **kwargs: None
