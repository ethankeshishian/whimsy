"""Regression coverage for imports whose patches share context/targets."""
import importlib.util
from pathlib import Path
import subprocess
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("engine_prepare", Path(__file__).parents[1] / "engine_prepare.py")
prepare = importlib.util.module_from_spec(spec)
spec.loader.exec_module(prepare)


class PrepareTests(unittest.TestCase):
    def test_overlapping_patches_are_restored_as_a_unit(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            engine = root / "engine"
            engine.mkdir()
            src = root / "src"
            src.mkdir()

            def git(*args):
                return subprocess.check_output(["git", *args], cwd=engine)

            git("init", "-q")
            (engine / "shared").write_text("one\ntwo\nthree\n")
            (engine / "other").write_text("original\n")
            git("add", "shared", "other")
            git("-c", "user.name=Test", "-c", "user.email=test@example.org", "commit", "-qm", "Base")
            (engine / "shared").write_text("one\ninserted\ntwo\nthree\n")
            (engine / "other").write_text("changed\n")
            first = src / "first.patch"
            first.write_bytes(git("diff"))
            git("add", "shared", "other")
            (engine / "shared").write_text("one\ninserted\ntwo\nTHREE\n")
            second = src / "second.patch"
            second.write_bytes(git("diff"))
            git("reset", "-q")
            expected = git("diff")
            old_root, old_engine = prepare.ROOT, prepare.ENGINE
            prepare.ROOT, prepare.ENGINE = str(root), str(engine)
            try:
                for _ in range(2):
                    prepare.main()
                    self.assertEqual(git("diff"), b"")
                    git("apply", str(first))
                    git("apply", str(second))
                    self.assertEqual(git("diff"), expected)
            finally:
                prepare.ROOT, prepare.ENGINE = old_root, old_engine


if __name__ == "__main__":
    unittest.main()
