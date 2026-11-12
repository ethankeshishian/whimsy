"""W25: a build staged on this Mac is signed with Whimsy's stable identity,
so the keychain doesn't ask for the login password after every update; with
no identity here it stays ad-hoc and staging still works."""
import importlib.util
from pathlib import Path
import tempfile
import unittest

ROOT = Path(__file__).parents[2]
spec = importlib.util.spec_from_file_location("updater", ROOT / "whimsy" / "updater" / "updater.py")
updater = importlib.util.module_from_spec(spec)
spec.loader.exec_module(updater)


class Result:
    def __init__(self, code):
        self.returncode = code


class SigningTests(unittest.TestCase):
    def setUp(self):
        self.calls, self.logs = [], []
        self.saved = (updater.sh, updater.log, updater.config, updater.subprocess.run)
        updater.sh = lambda cmd, cwd=None, **kw: self.calls.append(cmd)
        updater.log = self.logs.append
        self.tmp = tempfile.TemporaryDirectory()
        self.repo = Path(self.tmp.name)
        updater.config = lambda: {"repo": str(self.repo)}

    def tearDown(self):
        updater.sh, updater.log, updater.config, updater.subprocess.run = self.saved
        self.tmp.cleanup()

    def add_sign_sh(self, check_code):
        sign = self.repo / "whimsy" / "signing" / "sign.sh"
        sign.parent.mkdir(parents=True)
        sign.write_text("")
        updater.subprocess.run = lambda cmd, **kw: Result(check_code)
        return str(sign)

    def test_signs_with_the_stable_identity_and_verifies(self):
        sign = self.add_sign_sh(0)
        updater.sign_stable("/x/Whimsy.app")
        self.assertEqual(self.calls, [
            ["sh", sign, "/x/Whimsy.app"],
            ["/usr/bin/codesign", "--verify", "--deep", "--strict", "/x/Whimsy.app"],
        ])

    def test_without_the_identity_it_stays_ad_hoc_and_says_so(self):
        self.add_sign_sh(1)
        updater.sign_stable("/x/Whimsy.app")
        self.assertEqual(self.calls, [])
        self.assertIn("ad-hoc", self.logs[0])

    def test_without_sign_sh_it_stays_ad_hoc(self):
        updater.sign_stable("/x/Whimsy.app")
        self.assertEqual(self.calls, [])
        self.assertIn("ad-hoc", self.logs[0])

    def test_stage_signs_the_copy_it_installs(self):
        signed = []
        saved = (updater.sign_stable, updater.packaged, updater.STAGED, updater.update_state, updater.job_installed)
        try:
            updater.sign_stable = signed.append
            app = self.repo / "Built.app"
            (app / "Contents").mkdir(parents=True)
            updater.packaged = lambda p: str(app)
            updater.STAGED = str(self.repo / "staged" / "Whimsy.app")
            updater.update_state = lambda **kw: None
            updater.job_installed = lambda job: False
            updater.stage(str(app), {"version": "t"})
            self.assertEqual(signed, [updater.STAGED + ".tmp"])
        finally:
            (updater.sign_stable, updater.packaged, updater.STAGED,
             updater.update_state, updater.job_installed) = saved


if __name__ == "__main__":
    unittest.main()
