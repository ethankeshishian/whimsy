"""Which build a change needs: faster, backend, binaries or full.

W24 ran a full 24-minute build for every lane; most lanes were front-end
only (21 s with `mach build faster`). precheck.py prints the answer as
`BUILD: <kind>` and lane.sh runs that build:

    faster    JS, CSS, FTL, XHTML, images, jar manifests:  mach build faster
    backend   a moz.build changed (new modules, tests):   mach build-backend, then faster
              (a moz.build that declares an app bundle or a generated file
              is full: `build faster` never makes those, and W27's passkeys
              helper went missing from dist/bin that way)
    binaries  C++, Obj-C, Rust:                           mach build binaries, then faster
    full      surfer.json, configs/, mozconfig, build patches, *.in: npm run build;
              also IDL, WebIDL, IPDL, components.conf and StaticPrefList.yaml
              (lane.sh runs mach build)

The last group generates headers in the export tier (xpidl headers,
bindings, Components.h/StaticComponents.cpp, StaticPrefList_*.h).
`mach build binaries` skips that tier or regenerates them while other
objects compile, so XUL links objects built against the old headers. On
2026-11-13 that left mismatched static component ids in the shared engine:
no chrome-manifest `resource` substitutions (resource://services-settings,
resource://default-theme) and xpcshell crashing with -11.

A whimsy-*.patch counts as the engine files it patches.
"""
import os
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import patchtools  # noqa: E402

NATIVE_EXT = (".cpp", ".cc", ".c", ".h", ".hpp", ".mm", ".m", ".rs")
# Inputs of export-tier code generation: they need a tier-ordered mach build.
EXPORT_EXT = (".idl", ".webidl", ".ipdl", ".ipdlh")
EXPORT_NAMES = ("components.conf", "StaticPrefList.yaml")
FULL_EXT = (".in", ".configure", ".mozbuild", "mozconfig", "Cargo.toml", "Cargo.lock")
# moz.build declarations whose outputs only a tier-ordered mach build makes.
FULL_MOZBUILD = ("MacOSBundle(", "GeneratedFile(", "Program(", "SharedLibrary(")
ORDER = ["faster", "backend", "binaries", "full"]
HOW = {
    "faster": "front-end only (cd engine && ./mach build faster, under a minute)",
    "backend": "backend + front-end (cd engine && ./mach build-backend && ./mach build faster, minutes)",
    "binaries": "binaries + front-end (cd engine && ./mach build binaries && ./mach build faster, minutes)",
    "full": "FULL build (npm run build, ~25 min)",
}


def kind_of(path, read=None):
    """The build one changed repo path needs. `read` returns a patch's text
    (default: the file on disk)."""
    if path == "surfer.json" or path.startswith(("configs/", "src/build/")) or path == "whimsy/engine_prepare.py":
        return "full"
    if path.endswith(".patch"):
        try:
            text = read(path) if read else open(path, encoding="utf-8", errors="replace").read()
        except OSError:
            text = ""
        targets = patchtools.targets(text)
        if not targets:
            return "binaries"
        return max((kind_of("engine/" + t) for t in targets), key=ORDER.index)
    base = os.path.basename(path)
    if path.endswith(FULL_EXT) or base == "moz.configure":
        return "full"
    if path.endswith(EXPORT_EXT) or base in EXPORT_NAMES:
        return "full"
    if path.endswith(NATIVE_EXT):
        return "binaries"
    if base == "moz.build":
        if path.startswith("engine/"):
            return "backend"  # a patched engine moz.build: judged as before
        try:
            text = read(path) if read else open(path, encoding="utf-8", errors="replace").read()
        except OSError:
            text = ""
        return "full" if any(d in text for d in FULL_MOZBUILD) else "backend"
    return "faster"


def needed(files, read=None):
    """(kind, explanation) for a set of changed repo paths."""
    kinds = {}
    for f in files:
        kinds.setdefault(kind_of(f, read), []).append(f)
    kind = max(kinds, key=ORDER.index) if kinds else "faster"
    why = ", ".join(kinds.get(kind, [])[:3])
    return kind, HOW[kind] + (f": {why}" if why else "")


def changed_between(a, b, cwd=None):
    """Every repo path that differs between two commits (or trees), deletions
    included: a file the engine was built with and the new tree lacks needs
    a rebuild as much as a new one. Two-dot diff, so `a` need not be an
    ancestor of `b`."""
    out = subprocess.run(["git", "diff", "--name-only", "--no-renames", a, b],
                         cwd=cwd, capture_output=True, text=True, check=True).stdout
    return out.split()


def needed_between(a, b, cwd=None):
    """(kind, explanation) for the change from `a` to `b`. A patch counts as
    the engine files either version of it patches."""
    def read(path):
        texts = []
        for ref in (b, a):
            r = subprocess.run(["git", "show", f"{ref}:{path}"], cwd=cwd, capture_output=True, text=True)
            if r.returncode == 0:
                texts.append(r.stdout)
        return "\n".join(texts)
    return needed(changed_between(a, b, cwd), read)
