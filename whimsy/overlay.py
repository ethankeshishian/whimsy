"""Whimsy's overlay on top of Zen.

Whimsy keeps Zen's files exactly as upstream ships them. Everything Whimsy
adds lives in Whimsy-owned paths (src/zen/whimsy/, whimsy/, prefs/whimsy/,
locales/en-US/.../whimsy*.ftl, src/**/whimsy-*). The few changes Whimsy needs
inside Zen's files are listed here and applied by this script after every
upstream sync. Each one is idempotent and checked, so syncing never needs a
merge:

- HOOKS insert one line next to an anchor in a Zen file.
- OVERRIDES rewrite settings in surfer.json, mozconfig and package.json.
- PREF_OVERRIDES change the default of a pref Zen already declares.
- HOTFIXES patch Zen bugs, only while the buggy code is still there.
- FALLBACK_STRINGS supply strings Zen uses but no longer ships.
- FEATURES name Whimsy features and how to spot Zen shipping the same thing;
  a superseded feature is switched off so Zen's version wins.

  python3 whimsy/overlay.py apply   # after an upstream sync
  python3 whimsy/overlay.py check   # exit 1 if anything is missing
"""
import json
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# (id, file, anchor regex, line to insert, "after" | "before")
HOOKS = [
    ("startup", "src/zen/common/modules/ZenStartup.mjs",
     r"^(\s*)gZenCompactModeManager\.init\(\);\s*$",
     '{indent}ChromeUtils.importESModule("resource:///modules/whimsy/Whimsy.sys.mjs").Whimsy.initWindow(window); // Whimsy hook',
     "after"),
    ("moz-build", "src/zen/moz.build",
     r'^(\s*)"common",\s*$',
     '{indent}"whimsy",  # Whimsy hook',
     "after"),
    ("jar", "src/browser/base/content/zen-assets.jar.inc.mn",
     r"^#include \.\./\.\./\.\./zen/common/jar\.inc\.mn\s*$",
     "#include ../../../zen/whimsy/jar.inc.mn",
     "after"),
    ("browser-strings", "src/browser/base/content/zen-locales.inc.xhtml",
     r"^(\s*)</linkset>\s*$",
     '{indent}<link rel="localization" href="browser/whimsy.ftl"/>',
     "before"),
    ("settings", "src/browser/components/preferences/zen-preferences-links.xhtml",
     r'^<link rel="localization" href="browser/preferences/zen-preferences\.ftl"/>',
     "#include whimsy-preferences-head.inc.xhtml",
     "after"),
]

HOTFIXES = [
    {
        "id": "pinned-tab-null-l10n-arg",
        "file": "src/zen/tabs/ZenPinnedTabManager.mjs",
        "why": "A null isEssential argument makes Fluent drop the whole tab "
               "context menu's labels.",
        "old": "          document.l10n.setArgs(element, { isEssential });",
        "new": "          document.l10n.setArgs(element, {\n"
               "            isEssential: isEssential ? \"true\" : \"false\", // Whimsy hotfix\n"
               "          });",
    },
]

# Prefs Zen declares whose defaults Whimsy changes: {name: value}.
PREF_OVERRIDES = {
    "zen.ctrlTab.show-pending-tabs": True,       # Arc-style Ctrl+Tab
    "zen.updates.show-update-notification": False,  # Whimsy shows its own
}

# Strings Zen's markup uses that its .ftl files no longer define.
FALLBACK_STRINGS = {
    "preferences-web-appearance-footer":
        'preferences-web-appearance-footer = Manage themes in '
        '<a data-l10n-name="themes-link">Extensions & Themes</a>',
}
FALLBACK_FILE = "locales/en-US/browser/browser/preferences/whimsy-fallbacks.ftl"

# Whimsy features, and signs that Zen now ships its own version.
FEATURES = [
    {"id": "ctrl-tab", "title": "Arc-style Ctrl+Tab",
     "detect": [("prefs", r"name:\s*browser\.ctrlTab\.sortByRecentlyUsed")]},
    {"id": "ui-zoom", "title": "Interface zoom",
     "detect": [("src", r"ui-zoom|uiZoom|interface-zoom")]},
    {"id": "app-icon", "title": "App icon picker",
     "detect": [("src", r"setApplicationIcon|applicationIconImage|zen\.app-icon|app-icon-picker")]},
    {"id": "copy", "title": "Copy & share: rich links, selected tabs, Copy Links menu item",
     "detect": [("src/zen", r"context_copyLinks|copySelectedTabsURL|copyTabsURLs|text/html.*copyCurrentURL")]},
    {"id": "cookie-banners", "title": "Reject cookie banners (built-in DuckDuckGo Autoconsent add-on + toggle)",
     "detect": [("src/zen", r"(?i)autoconsent|cookiebanners\.service\.mode"),
                ("prefs", r"name:\s*cookiebanners\.service\.mode")]},
    {"id": "strip-tracking", "title": "Strip tracking parameters from links (query stripping on by default + toggle)",
     "detect": [("prefs", r"name:\s*privacy\.query_stripping\.enabled\s*$")]},
    {"id": "github-reviews", "title": "My Review Requests (GitHub live folders, Zen PR #16183)",
     "detect": [("src/zen/live-folders", r"user-review-requested|myReviewRequests"),
                ("locales/en-US", r"(?i)my review requests")]},
]


def path(rel):
    return os.path.join(ROOT, rel)


def read(rel):
    with open(path(rel), encoding="utf-8") as f:
        return f.read()


def write(rel, text):
    with open(path(rel), "w", encoding="utf-8") as f:
        f.write(text)


def is_whimsy_path(rel):
    parts = rel.split("/")
    return (rel.startswith(("whimsy/", "src/zen/whimsy/", "prefs/whimsy/", "configs/branding/"))
            or any(p.startswith("whimsy") for p in parts))


def upstream_files(under):
    out = []
    for base, dirs, files in os.walk(path(under)):
        dirs[:] = [d for d in dirs if d not in ("node_modules", "__pycache__")]
        for name in files:
            rel = os.path.relpath(os.path.join(base, name), ROOT)
            if not is_whimsy_path(rel):
                out.append(rel)
    return out


def detect_superseded():
    superseded = []
    for feature in FEATURES:
        for under, pattern in feature["detect"]:
            rx = re.compile(pattern)
            hit = None
            for rel in upstream_files(under):
                if not rel.endswith((".mjs", ".js", ".ftl", ".yaml", ".xhtml", ".css", ".patch", ".mm", ".idl")):
                    continue
                try:
                    text = read(rel)
                except (UnicodeDecodeError, OSError):
                    continue
                # Lines Whimsy itself put into Zen files don't count.
                text = "\n".join(l for l in text.splitlines() if "Whimsy" not in l)
                if rx.search(text):
                    hit = rel
                    break
            if hit:
                superseded.append({"id": feature["id"], "title": feature["title"], "found_in": hit})
                break
    return superseded


def apply_hooks(report, dry):
    for hook_id, rel, anchor, line, where in HOOKS:
        if not os.path.exists(path(rel)):
            report["problems"].append(f"hook {hook_id}: {rel} no longer exists")
            continue
        lines = read(rel).split("\n")
        wanted = line.replace("{indent}", "").strip()
        if any(l.strip() == wanted for l in lines):
            report["hooks"].append({"id": hook_id, "status": "present"})
            continue
        rx = re.compile(anchor)
        for i, l in enumerate(lines):
            m = rx.match(l)
            if m:
                indent = m.group(1) if m.groups() else ""
                text = line.replace("{indent}", indent)
                lines.insert(i + 1 if where == "after" else i, text)
                if not dry:
                    write(rel, "\n".join(lines))
                report["hooks"].append({"id": hook_id, "status": "applied" if not dry else "missing"})
                break
        else:
            report["problems"].append(f"hook {hook_id}: anchor not found in {rel}")


def apply_hotfixes(report, dry):
    for fix in HOTFIXES:
        text = read(fix["file"]) if os.path.exists(path(fix["file"])) else ""
        if fix["new"] in text:
            report["hotfixes"].append({"id": fix["id"], "status": "present"})
        elif fix["old"] in text:
            if not dry:
                write(fix["file"], text.replace(fix["old"], fix["new"], 1))
            report["hotfixes"].append({"id": fix["id"], "status": "applied" if not dry else "missing"})
        else:
            # Zen changed this code, so presumably fixed it its own way.
            report["hotfixes"].append({"id": fix["id"], "status": "obsolete (Zen changed the code)"})


def apply_json_overrides(report, dry):
    rel = "surfer.json"
    c = json.loads(read(rel))
    before = json.dumps(c, sort_keys=True)
    c["name"], c["vendor"], c["appId"] = "Whimsy", "Whimsy", "whimsy"
    c.pop("updateHostname", None)
    names = {"release": ("Whimsy", "Whimsy", "Whimsy"),
             "twilight": ("Whimsy", "Whimsy Twilight", "Whimsy Twilight")}
    for brand, (shorter, short, full) in names.items():
        b = c.get("brands", {}).get(brand)
        if b:
            b["brandShorterName"], b["brandShortName"], b["brandFullName"] = shorter, short, full
            b.get("release", {}).pop("github", None)
    if json.dumps(c, sort_keys=True) != before:
        if not dry:
            write(rel, json.dumps(c, indent=2) + "\n")
        report["overrides"].append({"file": rel, "status": "applied" if not dry else "missing"})

    rel = "package.json"
    c = json.loads(read(rel))
    s = c["scripts"]
    before = json.dumps(s)
    wanted = {
        "import:strings": "python3 scripts/copy_language_pack.py en-US",
        "postbuild": "sh whimsy/install_app.sh",
        "postbuild:ui": "sh whimsy/install_app.sh",
        "install:app": "sh whimsy/install_app.sh",
        "ship": "python3 whimsy/updater/updater.py ship",
    }
    if "import:strings" not in s.get("import", ""):
        s["import"] = s["import"] + " && npm run import:strings"
    if "whimsy/engine_prepare.py" not in s["import"]:
        s["import"] = s["import"].replace("surfer import", "python3 whimsy/engine_prepare.py && surfer import", 1)
    if "whimsy/engine_overrides.py" not in s["import"]:
        s["import"] = s["import"] + " && python3 whimsy/engine_overrides.py"
    items = list(s.items())
    for key, value in wanted.items():
        if s.get(key) != value:
            s[key] = value
            items = list(s.items())
    if json.dumps(s) != before:
        c["scripts"] = dict(items)
        if not dry:
            write(rel, json.dumps(c, indent=2) + "\n")
        report["overrides"].append({"file": rel, "status": "applied" if not dry else "missing"})


def apply_update_host(report, dry):
    """Zen's build patch hard-codes Zen's update server. Point it at Whimsy's,
    so Whimsy never offers Zen's own updates."""
    rel = "src/build/moz-build.patch"
    host = json.loads(read("whimsy/publish.json"))["update_host"]
    text = read(rel)
    new = re.sub(r'(\+\s*appini_defines\["MOZ_APPUPDATE_HOST"\] = ")[^"]+(")', r"\g<1>" + host + r"\g<2>", text)
    if host not in new:
        report["problems"].append("update host: Zen's build patch no longer sets MOZ_APPUPDATE_HOST")
        return
    if new != text:
        if not dry:
            write(rel, new)
        report["overrides"].append({"file": rel, "status": "applied" if not dry else "missing"})


def apply_mozconfig(report, dry):
    rel = "configs/common/mozconfig"
    text = read(rel)
    new = re.sub(r"--with-app-basename=\S+", "--with-app-basename=Whimsy", text)
    new = re.sub(r"^export MOZ_APP_BASENAME=\S+", "export MOZ_APP_BASENAME=Whimsy", new, flags=re.M)
    sccache = ('\n# Whimsy: cache compiles so weekly Firefox updates rebuild faster.\n'
               'if test -z "$SCCACHE_GHA_ENABLED" -a -x "$HOME/.mozbuild/sccache/sccache"; then\n'
               '  ac_add_options --with-ccache="$HOME/.mozbuild/sccache/sccache"\n'
               'fi\n')
    if "Whimsy: cache compiles" not in new:
        new = new.rstrip("\n") + "\n" + sccache
    if new != text:
        if not dry:
            write(rel, new)
        report["overrides"].append({"file": rel, "status": "applied" if not dry else "missing"})


def apply_pref_overrides(report, dry, superseded_ids):
    """Change Zen-declared pref defaults in place, so each pref is declared once."""
    for name, value in PREF_OVERRIDES.items():
        if name == "zen.ctrlTab.show-pending-tabs" and "ctrl-tab" in superseded_ids:
            continue
        found = False
        for rel in upstream_files("prefs"):
            if not rel.endswith(".yaml"):
                continue
            text = read(rel)
            rx = re.compile(r"(- name: " + re.escape(name) + r"\n\s*value: )([^\n#]*)(.*)")
            m = rx.search(text)
            if not m:
                continue
            found = True
            want = json.dumps(value) if not isinstance(value, bool) else ("true" if value else "false")
            if m.group(2).strip() != want:
                if not dry:
                    write(rel, text[:m.start()] + m.group(1) + want + " # Whimsy override" + text[m.end():])
                report["overrides"].append({"pref": name, "status": "applied" if not dry else "missing"})
        if not found:
            report["problems"].append(f"pref override {name}: Zen no longer declares it")


def write_generated(report, dry, superseded):
    # Fallback strings Zen doesn't define (any more).
    defined = set()
    for rel in upstream_files("locales/en-US"):
        if rel.endswith(".ftl"):
            defined.update(re.findall(r"^([a-zA-Z][\w-]*)\s*=", read(rel), re.M))
    fallbacks = [text for key, text in FALLBACK_STRINGS.items() if key not in defined]
    content = ("# Generated by whimsy/overlay.py: strings Zen uses but doesn't define.\n\n"
               + "\n".join(fallbacks) + ("\n" if fallbacks else ""))
    gen = {FALLBACK_FILE: content}

    # Feature switches: off for features Zen now ships itself. Prefs that only
    # exist for a feature are declared here too, so a superseded feature
    # leaves Zen's own defaults alone.
    gone = {s["id"]: s for s in superseded}
    prefs = "# Generated by whimsy/overlay.py. Don't edit.\n"
    for feature in FEATURES:
        s = gone.get(feature["id"])
        note = f"  # Zen ships this itself: {s['found_in']}" if s else ""
        prefs += f"\n- name: whimsy.feature.{feature['id']}\n  value: {'false' if s else 'true'}{note}\n"
    if "ctrl-tab" not in gone:
        prefs += "\n# Arc-style Ctrl+Tab: recently used order.\n- name: browser.ctrlTab.sortByRecentlyUsed\n  value: true\n"
    if "strip-tracking" not in gone:
        prefs += ("\n# Strip tracking parameters (utm_*, fbclid...) from links you open, in\n"
                  "# normal and private windows. Copy Clean Link's list already applies to\n"
                  "# copies (privacy.query_stripping.strip_on_share.enabled).\n"
                  "- name: privacy.query_stripping.enabled\n  value: true\n"
                  "\n- name: privacy.query_stripping.enabled.pbmode\n  value: true\n")
    gen["prefs/whimsy/features.yaml"] = prefs

    for rel, text in gen.items():
        current = read(rel) if os.path.exists(path(rel)) else None
        if current != text:
            if not dry:
                os.makedirs(os.path.dirname(path(rel)), exist_ok=True)
                write(rel, text)
            report["generated"].append({"file": rel, "status": "written" if not dry else "stale"})


def run(dry):
    report = {"hooks": [], "hotfixes": [], "overrides": [], "generated": [], "problems": []}
    superseded = detect_superseded()
    report["superseded"] = superseded
    ids = {s["id"] for s in superseded}
    apply_hooks(report, dry)
    apply_hotfixes(report, dry)
    apply_json_overrides(report, dry)
    apply_mozconfig(report, dry)
    apply_update_host(report, dry)
    apply_pref_overrides(report, dry, ids)
    write_generated(report, dry, superseded)
    return report


def main():
    mode = sys.argv[1] if len(sys.argv) > 1 else "check"
    report = run(dry=(mode != "apply"))
    pending = [x for k in ("hooks", "hotfixes", "overrides", "generated") for x in report[k]
               if x["status"] in ("missing", "stale")]
    for s in report["superseded"]:
        print(f"superseded: {s['title']} (Zen has it: {s['found_in']})")
    for p in report["problems"]:
        print("PROBLEM:", p)
    for p in pending:
        print("NOT APPLIED:", p)
    print(f"overlay {mode}: {len(report['problems'])} problems, {len(pending)} not applied")
    sys.exit(1 if report["problems"] or (mode == "check" and pending) else 0)


if __name__ == "__main__":
    main()
