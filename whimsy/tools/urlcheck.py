"""Static check of chrome://, resource:// and moz-src:/// URLs.

In a test build a chrome:// or resource:// URL that names no packaged file is a
deliberate crash (CheckForBrokenChromeURL -> MOZ_CRASH), with no test output
that names the URL: W24's adult-history lane lost two days to an import of
resource:///modules/sessionstore/TabStateFlusher.sys.mjs after Firefox moved
it to moz-src:///browser/components/sessionstore/. This resolves every literal
URL in Whimsy's code, tests, overlay hooks and engine text fixes against the
built engine's chrome registry (dist/bin/**.manifest) and, for files the lane
itself adds, against the sources that declare them (jar.inc.mn, moz.build).

    python3 whimsy/tools/urlcheck.py            # all Whimsy sources
    python3 whimsy/tools/urlcheck.py FILE...    # just these files
"""
import glob
import os
import re
import sys

ROOT = os.environ.get("WHIMSY_ROOT") or os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
OBJDIR = "engine/obj-aarch64-apple-darwin"
DIST = os.path.join(OBJDIR, "dist", "bin")
IGNORE_MARK = "precheck: ignore-url"

# A literal URL. Stops before quotes, whitespace, ')', '$' (templates), '?'
# and '#', so a template prefix such as chrome://x/icons/${name}.svg comes
# out as chrome://x/icons/ and is skipped as a directory below.
URL = re.compile(r"\b(chrome|resource|moz-src)://[A-Za-z0-9_.@%+/-]*")

SOURCE_GLOBS = [
    "src/zen/whimsy/**/*.js", "src/zen/whimsy/**/*.mjs", "src/zen/whimsy/**/*.css",
    "src/zen/whimsy/**/*.xhtml", "src/zen/whimsy/**/*.html", "src/zen/whimsy/**/*.inc",
    "src/zen/whimsy/**/*.svg", "src/zen/whimsy/**/jar.inc.mn",
    "src/**/whimsy-*.xhtml", "src/**/whimsy-*.inc.xhtml", "src/**/whimsy-*.patch",
    "whimsy/overlay.py", "whimsy/engine_overrides.py",
]


class Registry:
    """The chrome registry of a built engine, read from its manifests."""

    def __init__(self, root):
        self.root = root
        self.dist = os.path.join(root, DIST)
        self.content = {}    # package -> [dir]
        self.skin = {}
        self.locale = {}
        self.resource = {}   # name -> target (dir or URL)
        self.override = {}   # chrome URL -> chrome URL
        self.loaded = False
        for rel in ("chrome.manifest", "browser/chrome.manifest"):
            self._load(os.path.join(self.dist, rel))

    def _load(self, manifest):
        if not os.path.exists(manifest):
            return
        self.loaded = True
        base = os.path.dirname(manifest)
        for line in open(manifest, encoding="utf-8", errors="replace"):
            parts = line.split()
            if not parts or parts[0].startswith("#"):
                continue
            kind = parts[0]
            if kind == "manifest" and len(parts) > 1:
                self._load(os.path.join(base, parts[1]))
            elif kind == "content" and len(parts) > 2:
                self.content.setdefault(parts[1], []).append(os.path.join(base, parts[2]))
            elif kind == "skin" and len(parts) > 3:
                self.skin.setdefault(parts[1], []).append(os.path.join(base, parts[3]))
            elif kind == "locale" and len(parts) > 3:
                self.locale.setdefault(parts[1], []).append(os.path.join(base, parts[3]))
            elif kind == "resource" and len(parts) > 2:
                target = parts[2]
                self.resource[parts[1]] = target if "://" in target else os.path.join(base, target)
            elif kind == "override" and len(parts) > 2:
                self.override[parts[1]] = parts[2]

    def resolve(self, url, depth=0):
        """A filesystem path the URL names, or None if it can't be mapped."""
        if depth > 8:
            return None
        if url in self.override:
            return self.resolve(self.override[url], depth + 1)
        scheme, _, rest = url.partition("://")
        if scheme == "moz-src":
            return os.path.join(self.dist, "moz-src", rest.lstrip("/"))
        if scheme == "resource":
            host, _, path = rest.partition("/")
            if host in ("", "app"):
                return os.path.join(self.dist, "browser", path)
            if host == "gre":
                return os.path.join(self.dist, path)
            if host == "testing-common":
                return os.path.join(self.root, OBJDIR, "_tests", "modules", path)
            target = self.resource.get(host)
            if target is None:
                return None
            if "://" in target:
                return self.resolve(target.rstrip("/") + "/" + path, depth + 1)
            return os.path.join(target, path)
        if scheme == "chrome":
            parts = rest.split("/", 2)
            if len(parts) < 3:
                return None
            package, provider, path = parts
            if package == "mochitests" and provider == "content":
                # The harness serves the test tree; in a dev build the engine
                # links Whimsy's tests from src/.
                sub = path.split("/", 1)[1] if path.startswith("browser/") else path
                for base in ("engine", "src"):
                    candidate = os.path.join(self.root, base, sub)
                    if os.path.exists(candidate):
                        return candidate
                return os.path.join(self.root, "engine", sub)
            if package == "mochikit" and provider == "content":
                return os.path.join(self.root, "engine", "testing", "mochitest", path)
            table = {"content": self.content, "skin": self.skin, "locale": self.locale}.get(provider)
            if table is None or package not in table:
                return None
            candidates = [os.path.join(d, path) for d in table[package]]
            for c in candidates:
                if os.path.exists(c):
                    return c
            return candidates[0]
        return None


class Declared:
    """Whimsy files the sources declare, so a lane's new files count before
    the build that installs them."""

    def __init__(self, root):
        self.chrome = set()      # chrome://browser/content/whimsy/... URLs
        self.modules = set()     # resource:///modules/whimsy/... URLs
        self.overrides = set()   # chrome URLs that jar.inc.mn overrides
        jar = os.path.join(root, "src/zen/whimsy/jar.inc.mn")
        if os.path.exists(jar):
            for line in open(jar, encoding="utf-8"):
                m = re.match(r"\s*%\s*override\s+(\S+)\s+(\S+)", line)
                if m:
                    self.overrides.add(m.group(1))
                    continue
                m = re.match(r"\s*\*?\s*(content|skin)/(\S+?)\s+\(", line)
                if m:
                    provider, path = m.groups()
                    if provider == "content":
                        pkg, _, rest = path.partition("/")
                        self.chrome.add(f"chrome://{pkg}/content/{rest}")
                    else:
                        _classic, _, rest = path.partition("/")
                        pkg, _, rest = rest.partition("/")
                        self.chrome.add(f"chrome://{pkg}/skin/{rest}")
        mb = os.path.join(root, "src/zen/whimsy/moz.build")
        if os.path.exists(mb):
            text = open(mb, encoding="utf-8").read()
            for m in re.finditer(r"EXTRA_JS_MODULES((?:\.\w+)+)\s*\+=\s*\[(.*?)\]", text, re.S):
                sub = "/".join(m.group(1).strip(".").split("."))
                for name in re.findall(r'"([^"]+)"', m.group(2)):
                    self.modules.add(f"resource:///modules/{sub}/{os.path.basename(name)}")
            for m in re.finditer(r"FINAL_TARGET_FILES((?:\.\w+)+)\s*\+=\s*\[(.*?)\]", text, re.S):
                sub = "/".join(m.group(1).strip(".").split("."))
                for name in re.findall(r'"([^"]+)"', m.group(2)):
                    self.chrome.add(f"resource:///{sub}/{os.path.basename(name)}")

    def has(self, url):
        return url in self.chrome or url in self.modules or url in self.overrides


def urls_in(path):
    """(line number, url) for every literal URL in a source file. Comment
    lines, template prefixes and directories are skipped; a line marked
    'precheck: ignore-url' is skipped too."""
    out = []
    is_patch = path.endswith(".patch")
    for n, line in enumerate(open(path, encoding="utf-8", errors="replace"), 1):
        if is_patch:
            if not line.startswith("+") or line.startswith("+++"):
                continue
            line = line[1:]
        stripped = line.lstrip()
        if IGNORE_MARK in line or stripped.startswith(("//", "*", "/*", "#")) and not path.endswith(".py"):
            continue
        if path.endswith(".py") and stripped.startswith("#"):
            continue
        for m in URL.finditer(line):
            url = m.group(0).rstrip("/.")
            if url != m.group(0) and m.group(0).endswith("/"):
                continue  # a directory or template prefix, not a file
            last = url.rsplit("/", 1)[-1]
            if "." not in last:
                continue  # chrome://x/content alone, or a prefix
            out.append((n, url))
    return out


def check(root=ROOT, files=None):
    """Problems as 'file:line: url does not resolve (hint)'."""
    registry = Registry(root)
    declared = Declared(root)
    problems = []
    if files is None:
        files = []
        for pattern in SOURCE_GLOBS:
            files += glob.glob(os.path.join(root, pattern), recursive=True)
    moved = {}
    moz_src = os.path.join(registry.dist, "moz-src")
    for path in sorted(set(files)):
        rel = os.path.relpath(path, root)
        if not os.path.isfile(path):
            continue
        for n, url in urls_in(path):
            if declared.has(url):
                continue
            target = registry.resolve(url)
            if target is not None and os.path.exists(target):
                continue
            if not registry.loaded:
                continue  # no built engine to check against
            hint = ""
            name = url.rsplit("/", 1)[-1]
            if url.startswith("resource://") and name.endswith(".sys.mjs") and os.path.isdir(moz_src):
                if not moved:
                    for base, _dirs, names in os.walk(moz_src):
                        for f in names:
                            if f.endswith(".sys.mjs"):
                                moved.setdefault(f, "moz-src:///" + os.path.relpath(os.path.join(base, f), moz_src))
                if name in moved:
                    hint = f"; Firefox moved it: use {moved[name]}"
            if target is None:
                hint = hint or "; no manifest registers it"
            problems.append(f"{rel}:{n}: {url} is not a packaged file{hint}")
    return problems


def main():
    files = [os.path.abspath(f) for f in sys.argv[1:]] or None
    problems = check(ROOT, files)
    for p in problems:
        print("PROBLEM:", p)
    print(f"urlcheck: {len(problems)} unresolved URL(s)")
    sys.exit(1 if problems else 0)


if __name__ == "__main__":
    main()
