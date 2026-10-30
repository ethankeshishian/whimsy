# Fast checks to run before spending build time. Run from the repo root:
#   python3 whimsy/precheck.py            # files changed vs HEAD
#   python3 whimsy/precheck.py --all-ids  # also check every l10n id in src/
# Exits non-zero on any problem and says which build is needed.
import glob
import os
import re
import subprocess
import sys
import xml.dom.minidom

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
os.chdir(ROOT)
problems = []


def changed_files():
    out = subprocess.run(["git", "status", "--porcelain", "--untracked-files=all"],
                         capture_output=True, text=True, check=True).stdout
    return [line[3:].split(" -> ")[-1] for line in out.splitlines()]


def ftl_ids():
    ids = set()
    for path in glob.glob("locales/en-US/**/*.ftl", recursive=True) + \
            glob.glob("engine/browser/locales/en-US/**/*.ftl", recursive=True) + \
            glob.glob("engine/toolkit/locales/en-US/**/*.ftl", recursive=True):
        for line in open(path, encoding="utf-8"):
            m = re.match(r"^(-?[a-zA-Z][\w-]*)\s*=", line)
            if m:
                ids.add(m.group(1))
    return ids


def check_js_syntax(files):
    for f in files:
        if f.endswith((".js", ".mjs")) and os.path.exists(f):
            r = subprocess.run(["node", "--check", f], capture_output=True, text=True)
            if r.returncode:
                problems.append(f"{f}: syntax error\n{r.stderr.strip()}")


def added_lines(f):
    """(line number, text) for lines added vs HEAD; the whole file if untracked."""
    tracked = subprocess.run(["git", "ls-files", "--error-unmatch", f], capture_output=True).returncode == 0
    if not tracked:
        return list(enumerate(open(f, encoding="utf-8"), 1))
    diff = subprocess.run(["git", "diff", "-U0", "HEAD", "--", f], capture_output=True, text=True).stdout
    lines, n = [], 0
    for line in diff.splitlines():
        m = re.match(r"^@@ -\S+ \+(\d+)", line)
        if m:
            n = int(m.group(1))
        elif line.startswith("+") and not line.startswith("+++"):
            lines.append((n, line[1:]))
            n += 1
    return lines


def check_l10n_ids(files, known, whole=False):
    pat = re.compile(r'data-l10n-id="([\w-]+)"|setAttributes\([^,]+,\s*"([\w-]+)"|\{\s*id:\s*"(\w+(?:-\w+)+)"')
    for f in files:
        if not f.endswith((".xhtml", ".js", ".mjs", ".inc")) or not os.path.exists(f):
            continue
        lines = list(enumerate(open(f, encoding="utf-8"), 1)) if whole else added_lines(f)
        for n, line in lines:
            for m in pat.finditer(line):
                id_ = next(g for g in m.groups() if g)
                if id_ not in known:
                    problems.append(f"{f}:{n}: string id '{id_}' is not in any en-US .ftl")


def check_xhtml(files):
    for f in files:
        # Only Whimsy's own markup: Zen's goes through its preprocessor.
        if f.endswith(".xhtml") and "whimsy" in f and os.path.exists(f):
            body = "".join(l for l in open(f, encoding="utf-8") if not l.startswith("#"))
            body = re.sub(r"<\?xml[^>]*\?>", "", body)
            # home: a standalone page (not a Zen .inc.xhtml fragment) starts
            # with a DOCTYPE, which can't appear inside the wrapper below.
            body = re.sub(r"<!DOCTYPE[^>]*>", "", body, flags=re.I)
            wrapped = ('<root xmlns="http://www.mozilla.org/keymaster/gatekeeper/there.is.only.xul" '
                       'xmlns:html="http://www.w3.org/1999/xhtml">' + body + "</root>")
            try:
                xml.dom.minidom.parseString(wrapped)
            except Exception as e:
                problems.append(f"{f}: not well-formed XML: {e}")


def check_jars(files):
    # Paths in a jar.inc.mn are relative to the jar.mn that includes it, so
    # accept a path that resolves from any ancestor directory in the engine.
    for mn in [f for f in files if f.endswith("jar.inc.mn") and os.path.exists(f)]:
        rel_dir = os.path.relpath(os.path.dirname(mn), "src")
        bases = []
        d = rel_dir
        while d and d != ".":
            # The engine has src/ linked in, so either tree resolves a path.
            bases.append(os.path.join("engine", d))
            bases.append(os.path.join("src", d))
            d = os.path.dirname(d)
        for n, line in enumerate(open(mn), 1):
            m = re.search(r"\(([^)]+)\)\s*$", line)
            if not m or line.lstrip().startswith("#") or "*" in m.group(1):
                continue
            if not any(os.path.exists(os.path.normpath(os.path.join(b, m.group(1)))) for b in bases):
                problems.append(f"{mn}:{n}: packaged file not found: {m.group(1)}")


def check_app_icons(known):
    path = "src/zen/whimsy/WhimsyAppIcon.sys.mjs"
    if not os.path.exists(path):
        return
    src = open(path).read()
    icons = re.findall(r'^\s+"([\w-]+)",$', src.split("const ICONS = [")[1].split("];")[0], re.M)
    jar = open("src/zen/whimsy/jar.inc.mn").read()
    for id_ in icons:
        files = [f"{id_}-light", f"{id_}-dark"] if id_ == "day-and-night" else [id_]
        for f in files:
            if not os.path.exists(f"src/zen/whimsy/content/app-icons/{f}.png"):
                problems.append(f"app icon '{id_}': missing src/zen/whimsy/content/app-icons/{f}.png")
            if f"app-icons/{f}.png" not in jar:
                problems.append(f"app icon '{id_}': {f}.png not packaged in src/zen/whimsy/jar.inc.mn")
        if f"whimsy-app-icon-{id_}" not in known:
            problems.append(f"app icon '{id_}': no whimsy-app-icon-{id_} string")


def check_l10n_containers(files):
    # Fluent replaces an element's children with its string, so an element
    # with data-l10n-id must not be a container that code fills in.
    filled = set()
    for f in glob.glob("src/**/*.js", recursive=True) + glob.glob("src/**/*.mjs", recursive=True):
        for m in re.finditer(r'getElementById\("([\w-]+)"\)', open(f, encoding="utf-8").read()):
            filled.add(m.group(1))
    js = "".join(open(f, encoding="utf-8").read() for f in files
                 if f.endswith((".js", ".mjs")) and os.path.exists(f))
    for f in files:
        if not f.endswith(".xhtml") or not os.path.exists(f):
            continue
        for n, line in enumerate(open(f, encoding="utf-8"), 1):
            for m in re.finditer(r'<[^>]*\bid="([\w-]+)"[^>]*data-l10n-id=|<[^>]*data-l10n-id=[^>]*\bid="([\w-]+)"', line):
                id_ = m.group(1) or m.group(2)
                if re.search(r'(const|let|var)\s+(\w+)\s*=\s*document\.getElementById\("' + id_ + r'"\)[^;]*;[\s\S]{0,4000}?\b\2\.(append|appendChild|replaceChildren)\(', js):
                    problems.append(f"{f}:{n}: #{id_} has data-l10n-id but code adds children to it; Fluent will wipe them")


def needed_build(files):
    full = [f for f in files if f in ("surfer.json", "configs/common/mozconfig") or f.startswith("configs/")]
    native = [f for f in files if f.endswith((".patch", ".cpp", ".h", ".mm", ".idl", ".rs"))
              or f.endswith("moz.build")]
    if full:
        return "FULL build (npm run build, ~1h): " + ", ".join(full[:3])
    if native:
        return "binaries build (cd engine && ./mach build binaries, minutes): " + ", ".join(native[:3])
    return "front-end only (cd engine && ./mach build faster, ~2 min)"


files = changed_files()
known = ftl_ids()
check_js_syntax(files)
if "--all-ids" in sys.argv:
    check_l10n_ids(glob.glob("src/**/*.xhtml", recursive=True), known, whole=True)
else:
    check_l10n_ids(files, known)
check_xhtml(files)
check_jars(files)
check_app_icons(known)
check_l10n_containers(files)

overlay = subprocess.run([sys.executable, "whimsy/overlay.py", "check"], capture_output=True, text=True)
if overlay.returncode:
    problems.append("whimsy/overlay.py check failed:\n" + overlay.stdout.strip())

missing_strings = [f for f in os.listdir("locales/en-US/browser/browser")
                   if f.startswith("zen") and not os.path.exists(f"engine/browser/locales/en-US/browser/{f}")]
if missing_strings:
    problems.append("Zen strings are not in the engine (menus will be blank): run npm run import:strings")

print(f"Checked {len(files)} changed files.")
for p in problems:
    print("PROBLEM:", p)
print("Needs:", needed_build(files))
sys.exit(1 if problems else 0)
