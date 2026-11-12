"""Git merge driver for whimsy/overlay.py: both lanes add list entries.

Every feature lane appends an entry to FEATURES (and often HOTFIXES or HOOKS)
in whimsy/overlay.py, so any two concurrent lanes conflict there although
neither touches the other's lines. This driver runs git's own merge and then
looks at each conflict: when both sides consist only of complete list
entries (balanced brackets, each ending in a comma), it keeps both, ours
first. Anything else stays a conflict for a person. The result must still
parse as Python.

    python3 whimsy/tools/merge_listfile.py %O %A %B %P
"""
import ast
import os
import re
import subprocess
import sys
import tempfile

OPEN, CLOSE = "([{", ")]}"


def complete_entries(lines):
    """True when the lines are whole list entries: brackets balance back to
    zero only at lines ending with ',' and nothing sits at depth zero but
    entry starts and comments."""
    text = "".join(lines)
    if not text.strip():
        return False
    depth = 0
    in_str = None
    entries = 0
    for line in lines:
        stripped = line.strip()
        if not stripped:
            continue
        if depth == 0:
            if stripped.startswith("#"):
                continue
            if not stripped[0] in OPEN + "\"'":
                return False
            entries += 1
        i = 0
        while i < len(line):
            c = line[i]
            if in_str:
                if c == "\\":
                    i += 1
                elif line.startswith(in_str, i):
                    i += len(in_str) - 1
                    in_str = None
            elif c == "#":
                break
            elif line.startswith(('"""', "'''"), i):
                in_str = line[i:i + 3]
                i += 2
            elif c in "\"'":
                in_str = c
            elif c in OPEN:
                depth += 1
            elif c in CLOSE:
                depth -= 1
                if depth < 0:
                    return False
            elif c in ":=" and depth == 0:
                return False  # a dict key or an assignment, not a list entry
            i += 1
        if depth == 0 and not stripped.startswith("#") and not stripped.endswith(","):
            return False
    return depth == 0 and in_str is None and entries > 0


def resolve(merged_with_markers):
    """Union each both-sides-are-entries conflict; returns (text, unresolved)."""
    out, unresolved = [], 0
    lines = merged_with_markers.splitlines(keepends=True)
    i = 0
    while i < len(lines):
        if lines[i].startswith("<<<<<<<"):
            j = i + 1
            ours = []
            while j < len(lines) and not lines[j].startswith("======="):
                ours.append(lines[j]); j += 1
            k = j + 1
            theirs = []
            while k < len(lines) and not lines[k].startswith(">>>>>>>"):
                theirs.append(lines[k]); k += 1
            if k < len(lines) and complete_entries(ours) and complete_entries(theirs):
                out += ours + theirs
            else:
                out += lines[i:k + 1]
                unresolved += 1
            i = k + 1
        else:
            out.append(lines[i])
            i += 1
    return "".join(out), unresolved


def merge_text(base, ours, theirs, labels=("ours", "base", "theirs")):
    with tempfile.TemporaryDirectory() as t:
        p = {}
        for n, text in (("base", base), ("ours", ours), ("theirs", theirs)):
            p[n] = os.path.join(t, n)
            open(p[n], "w", encoding="utf-8").write(text)
        r = subprocess.run(["git", "merge-file", "-p", "-L", labels[0], "-L", labels[1], "-L", labels[2],
                            p["ours"], p["base"], p["theirs"]], capture_output=True, text=True)
    if r.returncode == 0:
        return r.stdout, 0, 0
    if r.returncode < 0 or r.returncode > 127:
        raise RuntimeError("git merge-file failed: " + r.stderr)
    text, unresolved = resolve(r.stdout)
    return text, r.returncode, unresolved


def main(argv):
    if len(argv) < 3:
        print("usage: merge_listfile.py %O %A %B [%P]", file=sys.stderr)
        return 2
    base_f, ours_f, theirs_f = argv[:3]
    path = argv[3] if len(argv) > 3 else ours_f
    read = lambda f: open(f, encoding="utf-8").read()
    text, conflicts, unresolved = merge_text(read(base_f), read(ours_f), read(theirs_f))
    if conflicts and not unresolved and path.endswith(".py"):
        try:
            ast.parse(text)
        except SyntaxError as e:
            print(f"list merge: {path}: union of both sides' entries is not valid Python ({e}); "
                  "leaving the conflict", file=sys.stderr)
            unresolved = conflicts
    with open(ours_f, "w", encoding="utf-8") as f:
        f.write(text)
    if unresolved:
        print(f"list merge: {path}: {unresolved} of {conflicts} conflict(s) are not whole list entries; "
              "resolve by hand", file=sys.stderr)
        return 1
    if conflicts:
        print(f"list merge: {path}: kept both sides' entries in {conflicts} place(s)", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
