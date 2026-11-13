"""Regression coverage for engine_prepare: patches sharing context/targets,
and engine files a previously imported branch left behind."""
import importlib.util
import os
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


def run(cwd, *args):
    return subprocess.check_output(args, cwd=cwd)


def commit(cwd, message):
    run(cwd, "git", "-c", "user.name=Test", "-c", "user.email=test@example.org", "commit", "-qm", message)


class StaleEngineTests(unittest.TestCase):
    """A lane's import, then dev's: nothing the lane added may survive."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.engine = self.root / "engine"
        self.old = prepare.ROOT, prepare.ENGINE
        prepare.ROOT, prepare.ENGINE = str(self.root), str(self.engine)

    def tearDown(self):
        prepare.ROOT, prepare.ENGINE = self.old
        self.tmp.cleanup()

    def write(self, base, rel, text):
        path = base / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text)
        return path

    def make_patch(self, name, edits):
        """src/<name>: a git patch of `edits` ({engine path: new text}) against HEAD."""
        for rel, text in edits.items():
            self.write(self.engine, rel, text)
        run(self.engine, "git", "add", "-N", *edits)
        patch = run(self.engine, "git", "diff", "--", *edits)
        run(self.engine, "git", "reset", "-q", "--", *edits)
        for rel in edits:
            if subprocess.run(["git", "cat-file", "-e", f"HEAD:{rel}"], cwd=self.engine,
                              capture_output=True).returncode == 0:
                run(self.engine, "git", "checkout", "-q", "HEAD", "--", rel)
            else:
                os.remove(self.engine / rel)
        self.write(self.root, "src/" + name, "").write_bytes(patch)

    def surfer_import(self):
        """What surfer import does: apply every patch, link every other src/ file."""
        prepare.main()
        src = self.root / "src"
        for path in sorted(src.rglob("*")):
            rel = path.relative_to(src).as_posix()
            if path.suffix == ".patch":
                if subprocess.run(["git", "apply", "-R", "--check", str(path)], cwd=self.engine,
                                  capture_output=True).returncode != 0:
                    run(self.engine, "git", "apply", str(path))
            elif path.is_file():
                target = self.engine / rel
                if target.exists() or target.is_symlink():
                    target.unlink()
                target.parent.mkdir(parents=True, exist_ok=True)
                target.symlink_to(path)
        prepare.finish()

    def test_dev_import_after_lane_import_restores_the_lanes_files(self):
        base = {
            "widget/nsXPLookAndFeel.cpp": "#include \"nsXPLookAndFeel.h\"\nint look;\n",
            "widget/moz.build": "SOURCES += ['nsXPLookAndFeel.cpp']\n",
            "layout/shared.cpp": "int shared;\n",
            "browser/config/version.txt": "159.0\n",
            "browser/themes/icon.svg": "<svg/>\n",
        }
        self.engine.mkdir()
        run(self.engine, "git", "init", "-q")
        for rel, text in base.items():
            self.write(self.engine, rel, text)
        run(self.engine, "git", "add", ".")
        commit(self.engine, "Firefox")
        run(self.root, "git", "init", "-q", "-b", "dev")
        self.make_patch("layout/shared-cpp.patch", {"layout/shared.cpp": "int shared;\nint dev;\n"})
        run(self.root, "git", "add", "src")
        commit(self.root, "dev")

        # The lane: a new patch that adds an include and a source file, a
        # header linked from src/, and an icon replacing Firefox's own.
        run(self.root, "git", "checkout", "-q", "-b", "lane/darkmode")
        self.make_patch("widget/whimsy-nsXPLookAndFeel-cpp.patch", {
            "widget/nsXPLookAndFeel.cpp": "#include \"nsXPLookAndFeel.h\"\n"
                                          "#include \"mozilla/WhimsyAdaptiveDark.h\"\nint look;\n",
            "widget/WhimsyDark.cpp": "int dark;\n",
        })
        self.write(self.root, "src/zen/darkmode/WhimsyAdaptiveDark.h", "#pragma once\n")
        self.write(self.root, "src/browser/themes/icon.svg", "<svg id='whimsy'/>\n")
        run(self.root, "git", "add", "src")
        commit(self.root, "lane")
        self.surfer_import()
        self.assertIn("WhimsyAdaptiveDark", (self.engine / "widget/nsXPLookAndFeel.cpp").read_text())
        self.assertTrue((self.engine / "widget/WhimsyDark.cpp").exists())
        self.assertTrue((self.engine / "zen/darkmode/WhimsyAdaptiveDark.h").is_symlink())

        # Another import step's file and the build folder must stay as they are.
        version = self.write(self.engine, "browser/config/version.txt", "1.24b\n")
        built = self.write(self.engine, "obj-aarch64-apple-darwin/widget/out.o", "object\n")
        shared = self.engine / "layout/shared.cpp"
        old = 1_600_000_000_000_000_000
        for path in (version, built, shared):
            os.utime(path, ns=(old, old))

        # dev again: its import must leave the engine exactly as dev's own would.
        run(self.root, "git", "checkout", "-q", "dev")
        self.assertFalse((self.root / "src/widget").exists())
        self.surfer_import()
        self.assertEqual((self.engine / "widget/nsXPLookAndFeel.cpp").read_text(),
                         base["widget/nsXPLookAndFeel.cpp"])
        self.assertFalse((self.engine / "widget/WhimsyDark.cpp").exists())
        self.assertFalse(os.path.lexists(self.engine / "zen/darkmode/WhimsyAdaptiveDark.h"))
        self.assertFalse((self.engine / "browser/themes/icon.svg").is_symlink())
        self.assertEqual((self.engine / "browser/themes/icon.svg").read_text(), base["browser/themes/icon.svg"])
        self.assertEqual(shared.read_text(), "int shared;\nint dev;\n")
        self.assertEqual(version.read_text(), "1.24b\n")
        self.assertTrue(built.exists())
        for path in (version, built, shared):
            self.assertEqual(path.stat().st_mtime_ns, old, path)
        status = run(self.engine, "git", "status", "--porcelain", "--untracked-files=no").decode()
        self.assertEqual(sorted(line[3:] for line in status.splitlines()),
                         ["browser/config/version.txt", "layout/shared.cpp"])

        # A patch that only existed in the previous import (never committed)
        # is put back too: the state file remembers what was imported.
        self.make_patch("widget/whimsy-moz-build.patch", {"widget/moz.build": "SOURCES += ['x.cpp']\n"})
        self.surfer_import()
        self.assertIn("x.cpp", (self.engine / "widget/moz.build").read_text())
        os.remove(self.root / "src/widget/whimsy-moz-build.patch")
        self.surfer_import()
        self.assertEqual((self.engine / "widget/moz.build").read_text(), base["widget/moz.build"])

    def test_restored_files_that_come_back_identical_keep_their_timestamps(self):
        lines = [f"line {n}\n" for n in range(12)]
        self.engine.mkdir()
        run(self.engine, "git", "init", "-q")
        self.write(self.engine, "a.cpp", "a\n")
        self.write(self.engine, "b.cpp", "".join(lines))
        run(self.engine, "git", "add", ".")
        commit(self.engine, "Firefox")
        # Two patches sharing b.cpp form one unit; only the second changes.
        self.make_patch("first.patch", {"a.cpp": "a\nfirst\n", "b.cpp": "".join(["first\n"] + lines)})
        self.make_patch("second.patch", {"b.cpp": "".join(lines + ["second\n"])})
        self.surfer_import()
        old = 1_600_000_000_000_000_000
        for rel in ("a.cpp", "b.cpp"):
            os.utime(self.engine / rel, ns=(old, old))
        self.make_patch("second.patch", {"b.cpp": "".join(lines + ["second, changed\n"])})
        self.surfer_import()
        self.assertEqual((self.engine / "a.cpp").read_text(), "a\nfirst\n")
        self.assertEqual((self.engine / "b.cpp").read_text(), "".join(["first\n"] + lines + ["second, changed\n"]))
        self.assertEqual((self.engine / "a.cpp").stat().st_mtime_ns, old)
        self.assertNotEqual((self.engine / "b.cpp").stat().st_mtime_ns, old)


    def test_a_lanes_patch_stacked_on_an_owned_file_is_removed(self):
        """dev patches nsImageFrame.cpp too; the lane's extra patch on top must still go."""
        lines = [f"line {n}\n" for n in range(12)]
        self.engine.mkdir()
        run(self.engine, "git", "init", "-q")
        self.write(self.engine, "layout/nsImageFrame.cpp", "".join(lines))
        run(self.engine, "git", "add", ".")
        commit(self.engine, "Firefox")
        run(self.root, "git", "init", "-q", "-b", "dev")
        self.make_patch("layout/nsImageFrame-cpp.patch", {"layout/nsImageFrame.cpp": "".join(["zen\n"] + lines)})
        run(self.root, "git", "add", "src")
        commit(self.root, "dev")
        self.surfer_import()
        dev_text = (self.engine / "layout/nsImageFrame.cpp").read_text()

        run(self.root, "git", "checkout", "-q", "-b", "lane/darkmode")
        self.make_patch("layout/whimsy-nsImageFrame-cpp.patch", {
            "layout/nsImageFrame.cpp": "".join(lines + ["#include \"mozilla/WhimsyAdaptiveDarkImage.h\"\n"])})
        run(self.root, "git", "add", "src")
        commit(self.root, "lane")
        self.surfer_import()
        self.assertIn("WhimsyAdaptiveDarkImage", (self.engine / "layout/nsImageFrame.cpp").read_text())

        run(self.root, "git", "checkout", "-q", "dev")
        self.surfer_import()
        self.assertEqual((self.engine / "layout/nsImageFrame.cpp").read_text(), dev_text)

        # An intact lone patch is left alone: same contents, same timestamp.
        old = 1_600_000_000_000_000_000
        os.utime(self.engine / "layout/nsImageFrame.cpp", ns=(old, old))
        self.surfer_import()
        self.assertEqual((self.engine / "layout/nsImageFrame.cpp").stat().st_mtime_ns, old)


if __name__ == "__main__":
    unittest.main()
