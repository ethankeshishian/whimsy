"""Tests for whimsy/tools that need no engine: the merge drivers on fixture
repositories, the patch check, the URL resolver, the build-kind rules, the
log classifier on real W24 log excerpts, the engine-overrides ledger and the
queue's ordering.

    python3 -m unittest whimsy/tests/test_tools.py
"""
import importlib.util
import json
import os
import shutil
import subprocess
import sys
import tempfile
import textwrap
import time
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
WHIMSY = HERE.parent
TOOLS = WHIMSY / "tools"
FIXTURES = HERE / "fixtures" / "logs"
sys.path.insert(0, str(TOOLS))
import buildkind  # noqa: E402
import merge_features  # noqa: E402
import merge_listfile  # noqa: E402
import patchtools  # noqa: E402
import reason  # noqa: E402
import urlcheck  # noqa: E402

GIT_ID = ["-c", "user.name=Test", "-c", "user.email=test@example.org"]


def git(cwd, *args, check=True):
    return subprocess.run(["git", *GIT_ID, *args], cwd=cwd, capture_output=True, text=True, check=check)


def make_engine(root):
    """A tiny 'Firefox' repo: engine/browser/foo.mjs with 30 lines."""
    engine = Path(root) / "engine"
    (engine / "browser").mkdir(parents=True)
    (engine / "browser" / "foo.mjs").write_text("".join(f"line {i}\n" for i in range(1, 31)))
    git(engine, "init", "-q")
    git(engine, "add", ".")
    git(engine, "commit", "-qm", "Firefox")
    return engine


def patch_for(rel, original, modified):
    return patchtools.regenerate(rel, original.encode(), modified.encode())


def edited(lines_changes):
    """30 numbered lines with {lineno: replacement or (insert_after)} edits."""
    out = []
    for i in range(1, 31):
        line = f"line {i}\n"
        change = lines_changes.get(i)
        if isinstance(change, tuple):
            out.append(line)
            out.append(change[0])
        elif change is not None:
            out.append(change)
        else:
            out.append(line)
    return "".join(out)


class PatchMergeTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.engine = make_engine(self.tmp)
        self.rel = "browser/foo.mjs"
        self.original = (self.engine / self.rel).read_text()
        self.old_root, self.old_engine = patchtools.ROOT, patchtools.ENGINE
        patchtools.ROOT, patchtools.ENGINE = self.tmp, str(self.engine)
        (Path(self.tmp) / "src" / "browser").mkdir(parents=True)
        # Zen's own patch for the file: a line after 5.
        self.zen_text = edited({5: ("zen line\n",)})
        (Path(self.tmp) / "src/browser/foo-mjs.patch").write_text(patch_for(self.rel, self.original, self.zen_text))
        self.patch_rel = "src/browser/whimsy-foo-mjs.patch"

    def tearDown(self):
        patchtools.ROOT, patchtools.ENGINE = self.old_root, self.old_engine
        shutil.rmtree(self.tmp)

    def whimsy_patch(self, changes):
        """A whimsy patch on top of Zen's: changes apply to the Zen-patched text."""
        zen_lines = self.zen_text.splitlines(keepends=True)
        text = "".join(zen_lines)
        for n, change in changes.items():
            idx = [i for i, l in enumerate(zen_lines) if l == f"line {n}\n"][0]
            if isinstance(change, tuple):
                zen_lines.insert(idx + 1, change[0])
            else:
                zen_lines[idx] = change
        return patchtools.regenerate(self.rel, self.zen_text.encode(), "".join(zen_lines).encode())

    def write_versions(self, base, ours, theirs):
        paths = []
        for name, text in (("base", base), ("ours", ours), ("theirs", theirs)):
            p = Path(self.tmp) / f"{name}.patch"
            p.write_text(text)
            paths.append(str(p))
        return paths

    def test_two_lanes_hunks_both_survive_and_apply(self):
        base = self.whimsy_patch({10: ("base hunk\n",)})
        ours = self.whimsy_patch({10: ("base hunk\n",), 20: ("ours hunk\n",)})
        theirs = self.whimsy_patch({10: ("base hunk\n",), 28: ("theirs hunk\n",)})
        b, o, t = self.write_versions(base, ours, theirs)
        self.assertEqual(patchtools.merge(b, o, t, self.patch_rel), 0)
        merged = open(o).read()
        self.assertIn("+ours hunk", merged)
        self.assertIn("+theirs hunk", merged)
        self.assertIn("+base hunk", merged)
        self.assertIsNone(patchtools.check_patch(str(Path(self.tmp) / self.patch_rel), text=merged))

    def test_same_line_conflict_is_reported_not_guessed(self):
        base = self.whimsy_patch({10: ("base hunk\n",)})
        ours = self.whimsy_patch({10: ("base hunk\n",), 15: "ours 15\n"})
        theirs = self.whimsy_patch({10: ("base hunk\n",), 15: "theirs 15\n"})
        b, o, t = self.write_versions(base, ours, theirs)
        self.assertEqual(patchtools.merge(b, o, t, self.patch_rel), 1)
        self.assertEqual(open(o).read(), ours, "ours is left for a person to resolve")

    def test_corrupt_hunk_header_fails_the_check(self):
        good = self.whimsy_patch({10: ("base hunk\n",)})
        bad = good.replace(" line 9\n", " line 99\n", 1)  # a context line the source never had
        p = Path(self.tmp) / self.patch_rel
        p.write_text(bad)
        problem = patchtools.check_patch(str(p))
        self.assertIsNotNone(problem)
        self.assertIn("does not apply", problem)

    def test_textually_merged_patch_that_lost_context_fails_the_check(self):
        # What git's text merge does to two lanes' hunks: a hunk whose line
        # counts no longer match its body.
        good = self.whimsy_patch({10: ("base hunk\n",), 20: ("ours hunk\n",)})
        broken = good.replace("+ours hunk\n", "+ours hunk\n+another\n")
        p = Path(self.tmp) / self.patch_rel
        p.write_text(broken)
        self.assertIsNotNone(patchtools.check_patch(str(p)))


FEATURES_BASE = textwrap.dedent("""\
    # Generated by whimsy/overlay.py. Don't edit.

    - name: whimsy.feature.ctrl-tab
      value: true

    - name: whimsy.feature.ui-zoom
      value: true

    # Arc-style Ctrl+Tab: recently used order.
    - name: browser.ctrlTab.sortByRecentlyUsed
      value: true
    """)


class FeaturesMergeTests(unittest.TestCase):
    def test_both_added_blocks_keep_their_values(self):
        ours = FEATURES_BASE.replace("- name: whimsy.feature.ctrl-tab",
                                     "- name: whimsy.feature.image-drop\n  value: true\n\n- name: whimsy.feature.ctrl-tab")
        theirs = FEATURES_BASE.replace("- name: whimsy.feature.ctrl-tab",
                                       "- name: whimsy.feature.cmd-tab-numbers\n  value: true\n\n- name: whimsy.feature.ctrl-tab")
        # Plain git loses one value: this is W24's 51fe763a.
        with tempfile.TemporaryDirectory() as t:
            for n, text in (("b", FEATURES_BASE), ("o", ours), ("th", theirs)):
                open(os.path.join(t, n), "w").write(text)
            plain = subprocess.run(["git", "merge-file", "-p", f"{t}/o", f"{t}/b", f"{t}/th"], capture_output=True, text=True).stdout
        self.assertFalse(merge_features.well_formed(plain), "git's own merge is the broken shape")
        merged = merge_features.merge_text(FEATURES_BASE, ours, theirs)
        self.assertIsNotNone(merged)
        self.assertTrue(merge_features.well_formed(merged))
        names = [n for n, _ in merge_features.parse(merged)[1]]
        self.assertEqual(sorted(names[:2]), ["whimsy.feature.cmd-tab-numbers", "whimsy.feature.image-drop"])
        self.assertEqual(names[2], "whimsy.feature.ctrl-tab")
        self.assertEqual(merged.count("value: true"), 5)
        self.assertIn("# Arc-style Ctrl+Tab", merged)

    def test_a_side_that_removes_a_block_wins(self):
        ours = FEATURES_BASE.replace("- name: whimsy.feature.ui-zoom\n  value: true\n\n", "")
        theirs = FEATURES_BASE.replace("value: true\n\n# Arc", "value: false\n\n# Arc")
        merged = merge_features.merge_text(FEATURES_BASE, ours, theirs)
        self.assertNotIn("ui-zoom", merged)
        self.assertIn("- name: whimsy.feature.ctrl-tab\n  value: true", merged)

    def test_driver_cli_writes_ours(self):
        with tempfile.TemporaryDirectory() as t:
            ours = FEATURES_BASE.replace("- name: whimsy.feature.ctrl-tab", "- name: whimsy.feature.a\n  value: true\n\n- name: whimsy.feature.ctrl-tab")
            theirs = FEATURES_BASE.replace("- name: whimsy.feature.ctrl-tab", "- name: whimsy.feature.b\n  value: true\n\n- name: whimsy.feature.ctrl-tab")
            for n, text in (("b", FEATURES_BASE), ("o", ours), ("th", theirs)):
                open(os.path.join(t, n), "w").write(text)
            r = subprocess.run([sys.executable, str(TOOLS / "merge_features.py"), f"{t}/b", f"{t}/o", f"{t}/th", "prefs/whimsy/features.yaml"],
                               capture_output=True, text=True)
            self.assertEqual(r.returncode, 0, r.stderr)
            self.assertTrue(merge_features.well_formed(open(f"{t}/o").read()))


LIST_BASE = textwrap.dedent('''\
    """overlay"""
    FEATURES = [
        {"id": "ctrl-tab", "title": "Ctrl+Tab",
         "detect": [("prefs", r"name:\\s*browser\\.ctrlTab")]},
        {"id": "ui-zoom", "title": "Interface zoom",
         "detect": [("src", r"ui-zoom")]},
    ]
    ''')


class ListMergeTests(unittest.TestCase):
    def test_entries_added_at_the_same_place_are_both_kept(self):
        ours = LIST_BASE.replace('    {"id": "ctrl-tab"', '    {"id": "cmd-tab-numbers", "title": "Numbers",\n     "detect": [("src/zen", r"tab-?number")]},\n    {"id": "ctrl-tab"')
        theirs = LIST_BASE.replace('    {"id": "ctrl-tab"', '    # W24 image drop\n    {"id": "image-drop", "title": "Drop",\n     "detect": [("src/zen", r"imageDrop"),\n                ("src/browser", r"openDropped")]},\n    {"id": "ctrl-tab"')
        text, conflicts, unresolved = merge_listfile.merge_text(LIST_BASE, ours, theirs)
        self.assertEqual(conflicts, 1)
        self.assertEqual(unresolved, 0)
        self.assertNotIn("<<<<", text)
        ns = {}
        exec(text, ns)
        ids = [f["id"] for f in ns["FEATURES"]]
        self.assertEqual(ids, ["cmd-tab-numbers", "image-drop", "ctrl-tab", "ui-zoom"])

    def test_same_entry_edited_both_ways_stays_a_conflict(self):
        ours = LIST_BASE.replace('"title": "Ctrl+Tab"', '"title": "Ours"')
        theirs = LIST_BASE.replace('"title": "Ctrl+Tab"', '"title": "Theirs"')
        text, conflicts, unresolved = merge_listfile.merge_text(LIST_BASE, ours, theirs)
        self.assertEqual(unresolved, 1)
        self.assertIn("<<<<<<<", text)

    def test_partial_entry_is_not_unioned(self):
        ours = LIST_BASE.replace('     "detect": [("prefs"', '     "extra": 1,\n     "detect": [("prefs"')
        theirs = LIST_BASE.replace('     "detect": [("prefs"', '     "other": 2,\n     "detect": [("prefs"')
        text, conflicts, unresolved = merge_listfile.merge_text(LIST_BASE, ours, theirs)
        self.assertEqual(unresolved, conflicts)


class GitDriverTests(unittest.TestCase):
    """End to end: git merge in a repository configured like env.sh does it."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.engine = make_engine(self.tmp)
        self.repo = Path(self.tmp)
        rel = "browser/foo.mjs"
        original = (self.engine / rel).read_text()
        (self.repo / "src/browser").mkdir(parents=True)
        (self.repo / "prefs/whimsy").mkdir(parents=True)
        (self.repo / "whimsy").mkdir()
        zen = edited({5: ("zen line\n",)})
        (self.repo / "src/browser/foo-mjs.patch").write_text(patch_for(rel, original, zen))

        def whimsy(changes):
            lines = zen.splitlines(keepends=True)
            for n, ch in changes.items():
                idx = lines.index(f"line {n}\n")
                lines.insert(idx + 1, ch)
            return patchtools.regenerate(rel, zen.encode(), "".join(lines).encode())

        self.whimsy = whimsy
        (self.repo / "src/browser/whimsy-foo-mjs.patch").write_text(whimsy({10: "base hunk\n"}))
        (self.repo / "prefs/whimsy/features.yaml").write_text(FEATURES_BASE)
        (self.repo / "whimsy/overlay.py").write_text(LIST_BASE)
        (self.repo / ".gitattributes").write_text(
            "src/**/whimsy-*.patch merge=whimsy-patch\nprefs/whimsy/features.yaml merge=whimsy-features\nwhimsy/overlay.py merge=whimsy-list\n")
        git(self.repo, "init", "-q", "-b", "dev")
        for name, script in (("whimsy-patch", "patchtools.py merge"), ("whimsy-features", "merge_features.py"), ("whimsy-list", "merge_listfile.py")):
            git(self.repo, "config", f"merge.{name}.driver", f"{sys.executable} {TOOLS}/{script} %O %A %B %P")
        git(self.repo, "add", ".")
        git(self.repo, "commit", "-qm", "base")
        self.env = dict(os.environ, WHIMSY_ROOT=str(self.repo), WHIMSY_ENGINE=str(self.engine))

    def tearDown(self):
        shutil.rmtree(self.tmp)

    def commit_lane(self, name, patch_changes, feature, entry):
        git(self.repo, "checkout", "-q", "-b", name, "dev")
        (self.repo / "src/browser/whimsy-foo-mjs.patch").write_text(self.whimsy(patch_changes))
        y = self.repo / "prefs/whimsy/features.yaml"
        y.write_text(y.read_text().replace("- name: whimsy.feature.ctrl-tab", f"- name: whimsy.feature.{feature}\n  value: true\n\n- name: whimsy.feature.ctrl-tab"))
        o = self.repo / "whimsy/overlay.py"
        o.write_text(o.read_text().replace('    {"id": "ctrl-tab"', f'    {{"id": "{feature}", "title": "{entry}",\n     "detect": [("src", r"{feature}")]}},\n    {{"id": "ctrl-tab"'))
        git(self.repo, "commit", "-qam", name)

    def test_merge_of_two_lanes_needs_no_hand_edit(self):
        self.commit_lane("lane/a", {10: "base hunk\n", 20: "a hunk\n"}, "a-feature", "A")
        self.commit_lane("lane/b", {10: "base hunk\n", 28: "b hunk\n"}, "b-feature", "B")
        git(self.repo, "checkout", "-q", "lane/a")
        r = subprocess.run(["git", *GIT_ID, "merge", "--no-ff", "-m", "merge b", "lane/b"], cwd=self.repo,
                           capture_output=True, text=True, env=self.env)
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        patch = (self.repo / "src/browser/whimsy-foo-mjs.patch").read_text()
        self.assertIn("+a hunk", patch)
        self.assertIn("+b hunk", patch)
        old = patchtools.ROOT, patchtools.ENGINE
        patchtools.ROOT, patchtools.ENGINE = str(self.repo), str(self.engine)
        try:
            self.assertIsNone(patchtools.check_patch(str(self.repo / "src/browser/whimsy-foo-mjs.patch")))
        finally:
            patchtools.ROOT, patchtools.ENGINE = old
        yaml = (self.repo / "prefs/whimsy/features.yaml").read_text()
        self.assertTrue(merge_features.well_formed(yaml))
        self.assertIn("a-feature", yaml)
        self.assertIn("b-feature", yaml)
        ns = {}
        exec((self.repo / "whimsy/overlay.py").read_text(), ns)
        self.assertEqual({f["id"] for f in ns["FEATURES"]}, {"a-feature", "b-feature", "ctrl-tab", "ui-zoom"})

    def test_real_source_conflict_still_stops_the_merge(self):
        self.commit_lane("lane/a", {10: "base hunk\n", 15: "a 15\n"}, "a-feature", "A")
        self.commit_lane("lane/b", {10: "base hunk\n", 15: "b 15\n"}, "b-feature", "B")
        git(self.repo, "checkout", "-q", "lane/a")
        r = subprocess.run(["git", *GIT_ID, "merge", "--no-ff", "-m", "merge b", "lane/b"], cwd=self.repo,
                           capture_output=True, text=True, env=self.env)
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("whimsy-foo-mjs.patch", r.stdout + r.stderr)


class UrlcheckTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        root = Path(self.tmp)
        dist = root / urlcheck.DIST
        (dist / "chrome" / "toolkit" / "content" / "global").mkdir(parents=True)
        (dist / "chrome" / "toolkit" / "content" / "global" / "a.js").write_text("")
        (dist / "chrome.manifest").write_text("manifest chrome/toolkit.manifest\nmanifest browser/chrome.manifest\n")
        (dist / "chrome" / "toolkit.manifest").write_text(
            "content global toolkit/content/global/\nresource autofill toolkit/res/autofill/\n"
            "override chrome://global/content/old.js chrome://global/content/a.js\n")
        (dist / "chrome" / "toolkit" / "res" / "autofill").mkdir(parents=True)
        (dist / "chrome" / "toolkit" / "res" / "autofill" / "Storage.sys.mjs").write_text("")
        (dist / "browser").mkdir()
        (dist / "browser" / "chrome.manifest").write_text("manifest chrome/browser.manifest\n")
        (dist / "browser" / "chrome").mkdir()
        (dist / "browser" / "chrome" / "browser.manifest").write_text("content browser browser/content/browser/\n")
        (dist / "browser" / "chrome" / "browser" / "content" / "browser" / "whimsy").mkdir(parents=True)
        (dist / "browser" / "chrome" / "browser" / "content" / "browser" / "whimsy" / "built.css").write_text("")
        (dist / "modules").mkdir()
        (dist / "modules" / "AppConstants.sys.mjs").write_text("")
        (dist / "browser" / "modules" / "whimsy").mkdir(parents=True)
        (dist / "browser" / "modules" / "whimsy" / "Whimsy.sys.mjs").write_text("")
        (dist / "moz-src" / "browser" / "components" / "sessionstore").mkdir(parents=True)
        (dist / "moz-src" / "browser" / "components" / "sessionstore" / "TabStateFlusher.sys.mjs").write_text("")
        (root / "src/zen/whimsy/tests").mkdir(parents=True)
        (root / "src/zen/whimsy/jar.inc.mn").write_text(
            "        content/browser/whimsy/new.css (../../zen/whimsy/content/new.css)\n"
            "% override chrome://global/content/x.svg chrome://browser/content/whimsy/new.css\n")
        (root / "src/zen/whimsy/moz.build").write_text('EXTRA_JS_MODULES.whimsy += [\n    "WhimsyNew.sys.mjs",\n]\n')
        self.root = root

    def tearDown(self):
        shutil.rmtree(self.tmp)

    def check(self, source):
        f = self.root / "src/zen/whimsy/tests/browser_whimsy_x.js"
        f.write_text(source)
        return urlcheck.check(str(self.root), [str(f)])

    def test_resolvable_and_declared_urls_pass(self):
        problems = self.check(textwrap.dedent('''\
            import("chrome://global/content/a.js");
            import("chrome://global/content/old.js");        // override
            import("resource://gre/modules/AppConstants.sys.mjs");
            import("resource:///modules/whimsy/Whimsy.sys.mjs");
            import("resource://autofill/Storage.sys.mjs");
            import("moz-src:///browser/components/sessionstore/TabStateFlusher.sys.mjs");
            load("chrome://browser/content/whimsy/built.css");
            load("chrome://browser/content/whimsy/new.css");   // declared in jar.inc.mn, not built yet
            import("resource:///modules/whimsy/WhimsyNew.sys.mjs"); // declared in moz.build
            load(`chrome://browser/content/whimsy/icons/${name}.svg`); // template prefix
            load("chrome://browser/content/");                 // a directory
            // import("chrome://global/content/nothing.js");   // comment line
            bad("chrome://nope/content/x.js"); // precheck: ignore-url
            '''))
        self.assertEqual(problems, [])

    def test_moved_module_is_named_with_its_new_url(self):
        problems = self.check('ChromeUtils.importESModule("resource:///modules/sessionstore/TabStateFlusher.sys.mjs");\n')
        self.assertEqual(len(problems), 1)
        self.assertIn("resource:///modules/sessionstore/TabStateFlusher.sys.mjs is not a packaged file", problems[0])
        self.assertIn("use moz-src:///browser/components/sessionstore/TabStateFlusher.sys.mjs", problems[0])

    def test_unregistered_package_and_missing_file(self):
        problems = self.check('a("chrome://nope/content/x.js");\nb("chrome://global/content/missing.js");\n')
        self.assertEqual(len(problems), 2)
        self.assertIn("no manifest registers it", problems[0])

    def test_patch_added_lines_are_checked(self):
        f = self.root / "src/x/whimsy-x.patch"
        f.parent.mkdir(parents=True)
        f.write_text("--- a/x\n+++ b/x\n@@ -1 +1,2 @@\n-import(\"chrome://global/content/gone.js\");\n+import(\"chrome://global/content/a.js\");\n+import(\"chrome://global/content/missing.js\");\n")
        problems = urlcheck.check(str(self.root), [str(f)])
        self.assertEqual(len(problems), 1)
        self.assertIn("missing.js", problems[0])


class BuildKindTests(unittest.TestCase):
    def test_kinds(self):
        reads = {
            "src/a/whimsy-x-cpp.patch": "--- a/dom/base/x.cpp\n+++ b/dom/base/x.cpp\n",
            "src/a/whimsy-x-mjs.patch": "--- a/browser/x.sys.mjs\n+++ b/browser/x.sys.mjs\n",
            "src/a/whimsy-moz-build.patch": "--- a/toolkit/moz.build\n+++ b/toolkit/moz.build\n",
            "src/a/whimsy-plist.patch": "--- a/browser/app/macbuild/Contents/Info.plist.in\n+++ b/x\n",
        }
        read = reads.__getitem__
        self.assertEqual(buildkind.kind_of("src/zen/whimsy/Whimsy.sys.mjs"), "faster")
        self.assertEqual(buildkind.kind_of("src/zen/whimsy/jar.inc.mn"), "faster")
        self.assertEqual(buildkind.kind_of("locales/en-US/browser/browser/whimsy.ftl"), "faster")
        self.assertEqual(buildkind.kind_of("src/zen/whimsy/moz.build"), "backend")
        self.assertEqual(buildkind.kind_of("src/zen/whimsy/tests/browser.toml"), "faster")
        self.assertEqual(buildkind.kind_of("src/a/whimsy-x-cpp.patch", read), "binaries")
        self.assertEqual(buildkind.kind_of("src/a/whimsy-x-mjs.patch", read), "faster")
        self.assertEqual(buildkind.kind_of("src/a/whimsy-moz-build.patch", read), "backend")
        self.assertEqual(buildkind.kind_of("src/a/whimsy-plist.patch", read), "full")
        self.assertEqual(buildkind.kind_of("src/widget/cocoa/nsCocoaWindow.mm"), "binaries")
        self.assertEqual(buildkind.kind_of("surfer.json"), "full")
        self.assertEqual(buildkind.kind_of("configs/common/mozconfig"), "full")
        self.assertEqual(buildkind.kind_of("src/build/moz-build.patch", lambda p: ""), "full")
        self.assertEqual(buildkind.kind_of("package.json"), "faster")

    def test_needed_takes_the_largest(self):
        self.assertEqual(buildkind.needed([])[0], "faster")
        self.assertEqual(buildkind.needed(["a.css", "src/zen/whimsy/moz.build"])[0], "backend")
        self.assertEqual(buildkind.needed(["src/zen/whimsy/moz.build", "x.cpp"])[0], "binaries")
        self.assertEqual(buildkind.needed(["x.cpp", "surfer.json"])[0], "full")


class ReasonTests(unittest.TestCase):
    def read(self, name):
        return (FIXTURES / name).read_text(errors="replace")

    def test_green_log(self):
        green, why, passed, failed, fails = reason.analyse(self.read("green.log"), 0)
        self.assertTrue(green, why)
        self.assertEqual((passed, failed), (21, 0))

    def test_green_counts_but_nonzero_exit_is_red_and_says_so(self):
        green, why, *_ = reason.analyse(self.read("green.log"), 1)
        self.assertFalse(green)
        self.assertIn("harness exit 1", why)

    def test_sigsegv_names_signal_and_file(self):
        green, why, *_ = reason.analyse(self.read("crash-sigsegv.log"), 1)
        self.assertFalse(green)
        self.assertTrue(why.startswith("crashed (SIGSEGV) in zen/whimsy/tests/browser_whimsy_screens.js"), why)
        self.assertIn("crash-stack.sh", why)

    def test_crash_with_moz_crash_reason(self):
        log = self.read("crash-sigsegv.log") + "Hit MOZ_CRASH(Missing chrome or resource URLs: resource:///modules/x.sys.mjs) at nsNetUtil.cpp\n"
        _, why, *_ = reason.analyse(log, 1)
        self.assertIn("Missing chrome or resource URLs: resource:///modules/x.sys.mjs", why)

    def test_missing_requested_file(self):
        green, why, *_ = reason.analyse("", 1, ["zen/whimsy/tests/browser_whimsy_nope.js"])
        self.assertFalse(green)
        self.assertEqual(why, "test file not found: zen/whimsy/tests/browser_whimsy_nope.js")

    def test_harness_found_nothing(self):
        log = "The mochitest command could not find any mochitests under the following\ntest path(s):\n\n zen/whimsy/tests/x.js\n"
        _, why, *_ = reason.analyse(log, 1)
        self.assertIn("found no tests", why)

    def test_timeout(self):
        log = " 0:01.00 TEST_START: zen/whimsy/tests/browser_whimsy_ctrl_tab_look.js\n 0:50.00 TEST-UNEXPECTED-TIMEOUT | zen/whimsy/tests/browser_whimsy_ctrl_tab_look.js | Test timed out\n\tPassed: 3\n\tFailed: 1\n"
        _, why, passed, failed, fails = reason.analyse(log, 1)
        self.assertIn("timed out in zen/whimsy/tests/browser_whimsy_ctrl_tab_look.js", why)
        self.assertEqual(len(fails), 1)

    def test_assertion_failures_name_the_files(self):
        log = ("TEST_START: zen/whimsy/tests/browser_whimsy_home.js\n"
               "TEST-UNEXPECTED-FAIL | zen/whimsy/tests/browser_whimsy_home.js | README icon is the balloon - got false\n"
               "TEST-UNEXPECTED-FAIL | zen/whimsy/tests/browser_whimsy_home.js | second - got 1\n"
               " 0:09.00 INFO Passed: 40\n 0:09.00 INFO Failed: 2\n")
        green, why, passed, failed, fails = reason.analyse(log, 1)
        self.assertFalse(green)
        self.assertEqual(why, "2 assertion(s) failed in zen/whimsy/tests/browser_whimsy_home.js")
        self.assertEqual(len(fails), 2)

    def test_expected_fail_lines_are_not_failures(self):
        log = "TEST-KNOWN-FAIL | a.js | x\nFAIL something EXPECTED-FAIL\n 0:09.00 INFO Passed: 4\n 0:09.00 INFO Failed: 0\n"
        green, why, *_ = reason.analyse(log, 0)
        self.assertTrue(green, why)

    def test_traceback(self):
        log = "Traceback (most recent call last):\n  File x\nValueError: boom\n"
        _, why, *_ = reason.analyse(log, 1)
        self.assertEqual(why, "harness error: ValueError: boom")

    def test_cli(self):
        r = subprocess.run([sys.executable, str(TOOLS / "reason.py"), str(FIXTURES / "crash-sigsegv.log"), "--exit", "1"],
                           capture_output=True, text=True)
        self.assertEqual(r.returncode, 1)
        lines = r.stdout.splitlines()
        self.assertEqual(lines[0], "RESULT red")
        self.assertTrue(lines[1].startswith("REASON crashed (SIGSEGV)"))


class CrashStackTests(unittest.TestCase):
    def test_reason_and_frames_from_lldb_log(self):
        r = subprocess.run(["zsh", str(TOOLS / "crash-stack.sh"), "--from-log", str(FIXTURES / "lldb-missing-url.log")],
                           capture_output=True, text=True)
        lines = r.stdout.splitlines()
        self.assertEqual(lines[0], "CRASH Missing chrome or resource URLs: resource:///modules/sessionstore/TabStateFlusher.sys.mjs")
        frames = [l for l in lines if l.startswith("frame #")]
        self.assertGreaterEqual(len(frames), 10)
        self.assertIn("CheckForBrokenChromeURL", "\n".join(frames))


class EngineOverridesLedgerTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.engine = Path(self.tmp) / "engine"
        (self.engine / "toolkit").mkdir(parents=True)
        (self.engine / "toolkit" / "a.css").write_text('@import "x.css";\n')
        git(self.engine, "init", "-q")
        git(self.engine, "add", ".")
        git(self.engine, "commit", "-qm", "Firefox")
        spec = importlib.util.spec_from_file_location("engine_overrides", WHIMSY / "engine_overrides.py")
        self.mod = importlib.util.module_from_spec(spec)
        os.environ["WHIMSY_ROOT"] = self.tmp
        try:
            spec.loader.exec_module(self.mod)
        finally:
            del os.environ["WHIMSY_ROOT"]

    def tearDown(self):
        shutil.rmtree(self.tmp)

    def run_fixes(self, fixes):
        m = self.mod
        m.ENGINE_TEXT_FIXES = fixes
        m.restore_previous_overrides()
        m.apply_engine_text_fixes()
        m.record_overrides(m.tracked_in_engine(m.text_fix_paths()))

    def test_one_lanes_fix_is_reverted_before_the_next_lane(self):
        lane_a = [("vpn-sheet", "toolkit/a.css", '@import "x.css";', '@import "x.css";\n@import "chrome://browser/content/whimsy/only-in-a.css";', "why")]
        self.run_fixes(lane_a)
        self.assertIn("only-in-a.css", (self.engine / "toolkit/a.css").read_text())
        self.assertEqual(json.load(open(Path(self.tmp) / ".surfer/engine-overrides.json"))["paths"], ["toolkit/a.css"])
        self.run_fixes([])  # a lane without that fix
        self.assertEqual((self.engine / "toolkit/a.css").read_text(), '@import "x.css";\n', "Firefox's text is back")
        self.assertEqual(json.load(open(Path(self.tmp) / ".surfer/engine-overrides.json"))["paths"], [])

    def test_missing_ledger_and_untracked_paths_are_harmless(self):
        self.mod.ENGINE_TEXT_FIXES = [("x", "toolkit/not-tracked.css", "a", "b", "why")]
        self.mod.restore_previous_overrides()
        self.mod.record_overrides(self.mod.tracked_in_engine(self.mod.text_fix_paths()))
        self.assertEqual(json.load(open(Path(self.tmp) / ".surfer/engine-overrides.json"))["paths"], [])


class QueueTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.env = dict(os.environ, WHIMSY_QUEUE=f"{self.tmp}/queue", WHIMSY_LOCK=f"{self.tmp}/lock.d",
                        WHIMSY_MAIN=self.tmp, WHIMSY_RUNS=f"{self.tmp}/runs")
        self.env.pop("WHIMSY_TICKET", None)

    def q(self, *args, timeout=60):
        return subprocess.run(["zsh", str(TOOLS / "queue.sh"), *args], env=self.env, capture_output=True, text=True, timeout=timeout)

    def tearDown(self):
        pid_file = Path(self.tmp) / "queue" / "worker.pid"
        if pid_file.exists():
            try:
                os.kill(int(pid_file.read_text()), 15)
            except (ProcessLookupError, ValueError):
                pass
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_tickets_run_in_order_normal_before_low_and_exit_codes_pass_through(self):
        out = Path(self.tmp) / "order.txt"
        first = self.q("submit", "--name", "first", "--", "sh", "-c", f"sleep 1; echo first >> {out}").stdout.strip()
        low = self.q("submit", "--low", "--name", "verify", "--", "sh", "-c", f"echo low >> {out}").stdout.strip()
        second = self.q("submit", "--name", "second", "--", "sh", "-c", f"echo second >> {out}; exit 3").stdout.strip()
        dup = self.q("submit", "--low", "--dedupe", "--name", "verify", "--", "sh", "-c", "echo dup").stdout.strip()
        self.assertEqual(dup, low, "a pending ticket of the same name is reused")
        self.assertTrue(first.startswith("1-") and low.startswith("2-") and second.startswith("1-"))
        self.assertEqual(self.q("wait", second).returncode, 3)
        self.q("wait", low)
        self.assertEqual(out.read_text().split(), ["first", "second", "low"])
        status = self.q("status").stdout
        self.assertIn("worker: running", status)
        r = self.q("run", "--name", "direct", "--", "sh", "-c", "echo streamed; exit 4")
        self.assertEqual(r.returncode, 4)
        self.assertIn("streamed", r.stdout)
        self.q("stop")
        time.sleep(4)
        self.assertIn("worker: stopped", self.q("status").stdout)

    def test_inside_a_ticket_run_executes_directly(self):
        env = dict(self.env, WHIMSY_TICKET="1-000001-outer")
        r = subprocess.run(["zsh", str(TOOLS / "queue.sh"), "run", "--", "sh", "-c", "echo inner; exit 5"], env=env,
                           capture_output=True, text=True, timeout=20)
        self.assertEqual(r.returncode, 5)
        self.assertEqual(r.stdout.strip(), "inner")
        self.assertFalse((Path(self.tmp) / "queue" / "worker.pid").exists(), "no worker was started")


if __name__ == "__main__":
    unittest.main()
