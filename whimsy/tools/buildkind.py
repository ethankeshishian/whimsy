"""Which build a change needs: faster, backend, binaries or full.

W24 ran a full 24-minute build for every lane; most lanes were front-end
only (21 s with `mach build faster`). precheck.py prints the answer as
`BUILD: <kind>` and lane.sh runs that build:

    faster    JS, CSS, FTL, XHTML, images, jar manifests:  mach build faster
    backend   a moz.build changed (new modules, tests):   mach build-backend, then faster
    binaries  C++, Obj-C, IDL, WebIDL, Rust, IPDL:        mach build binaries, then faster
    full      surfer.json, configs/, mozconfig, build patches, *.in: npm run build

A whimsy-*.patch counts as the engine files it patches.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import patchtools  # noqa: E402

NATIVE_EXT = (".cpp", ".cc", ".c", ".h", ".hpp", ".mm", ".m", ".idl", ".webidl", ".rs", ".ipdl", ".ipdlh")
FULL_EXT = (".in", ".configure", ".mozbuild", "mozconfig", "Cargo.toml", "Cargo.lock")
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
    if path.endswith(NATIVE_EXT):
        return "binaries"
    if base == "moz.build":
        return "backend"
    return "faster"


def needed(files, read=None):
    """(kind, explanation) for a set of changed repo paths."""
    kinds = {}
    for f in files:
        kinds.setdefault(kind_of(f, read), []).append(f)
    kind = max(kinds, key=ORDER.index) if kinds else "faster"
    why = ", ".join(kinds.get(kind, [])[:3])
    return kind, HOW[kind] + (f": {why}" if why else "")
