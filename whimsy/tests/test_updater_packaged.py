"""W14-22: the updater installs the packaged app, never a dev bundle, and an
update removes what a dev bundle once left behind."""
import importlib.util
from pathlib import Path
import tempfile
import unittest

ROOT = Path(__file__).parents[2]
spec = importlib.util.spec_from_file_location("updater", ROOT / "whimsy" / "updater" / "updater.py")
updater = importlib.util.module_from_spec(spec)
spec.loader.exec_module(updater)


def make_app(path, packaged=False):
    resources = path / "Contents" / "Resources"
    (resources / "browser" / "defaults" / "preferences").mkdir(parents=True)
    if packaged:
        (resources / "precomplete").write_text("")
        (resources / "browser" / "omni.ja").write_text("")
    else:
        (resources / "browser" / "defaults" / "preferences" / "firefox.js").write_text("")
    return path


class PackagedTests(unittest.TestCase):
    def setUp(self):
        self.calls = []
        self.real_sh = updater.sh
        updater.sh = lambda cmd, cwd=None, **kw: self.calls.append((cmd, cwd))

    def tearDown(self):
        updater.sh = self.real_sh

    def test_a_dev_bundle_is_packaged_first(self):
        with tempfile.TemporaryDirectory() as tmp:
            engine = Path(tmp) / "engine"
            dist = engine / "obj-test" / "dist"
            dev = make_app(dist / "Whimsy.app")

            def package(cmd, cwd=None, **kw):
                self.calls.append((cmd, cwd))
                make_app(dist / "zen" / "Whimsy.app", packaged=True)

            updater.sh = package
            got = updater.packaged(str(dev))
            self.assertEqual(Path(got), dist / "zen" / "Whimsy.app")
            self.assertEqual(self.calls, [(["./mach", "package"], str(engine))])

    def test_a_packaged_app_is_used_as_it_is(self):
        with tempfile.TemporaryDirectory() as tmp:
            app = make_app(Path(tmp) / "Whimsy.app", packaged=True)
            self.assertEqual(updater.packaged(str(app)), str(app))
            self.assertEqual(self.calls, [])

    def test_no_package_is_an_error(self):
        with tempfile.TemporaryDirectory() as tmp:
            dev = make_app(Path(tmp) / "engine" / "obj-test" / "dist" / "Whimsy.app")
            with self.assertRaises(RuntimeError):
                updater.packaged(str(dev))

    def test_an_update_removes_a_dev_bundles_leftovers(self):
        patch = (ROOT / "src" / "browser" / "installer" / "whimsy-removed-files-in.patch").read_text()
        added = {line[1:].strip() for line in patch.splitlines() if line.startswith("+") and not line.startswith("+++")}
        for path in ["browser/defaults/*", "browser/modules/*", "browser/chrome/*", "browser/chrome.manifest",
                     "browser/actors/*", "browser/components/*", "modules/*", "defaults/*", "greprefs.js"]:
            self.assertIn(f"@DIR_RESOURCES@{path}", added)


if __name__ == "__main__":
    unittest.main()
