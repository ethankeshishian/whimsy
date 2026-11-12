"""Git merge driver for prefs/whimsy/features.yaml (a generated file).

Two lanes that each add a feature both append a block at the same place.
Git's line merge then produces

    - name: whimsy.feature.image-drop
    - name: whimsy.feature.cmd-tab-numbers
      value: true

with no conflict (W24, 51fe763a): the shared "value: true" line is matched as
context and one block loses its value, so ffprefs fails inside the next
build. This driver merges the file as a list of blocks instead: a block is
"- name: X" with its value and the comment lines above it; the result is
ours' blocks in ours' order, each updated by theirs where theirs changed it,
then theirs' new blocks. Every block keeps its value. whimsy/overlay.py apply
regenerates the exact file afterwards (lane.sh does this on every landing).

    python3 whimsy/tools/merge_features.py %O %A %B %P
"""
import os
import re
import subprocess
import sys
import tempfile

NAME = re.compile(r"^- name:\s*(\S+)")


def parse(text):
    """(header, blocks): blocks are (name, lines) in file order; comment and
    blank lines belong to the block that follows them."""
    header, blocks, pending, current = [], [], [], None
    for line in text.splitlines(keepends=True):
        m = NAME.match(line)
        if m:
            current = (m.group(1), pending + [line])
            blocks.append(current)
            pending = []
        elif line.strip().startswith("#") or not line.strip():
            if current is None:
                header.append(line)
            else:
                pending.append(line)
        elif current is not None:
            current[1].extend(pending)
            pending = []
            current[1].append(line)
        else:
            header.append(line)
    # Trailing comments/blank lines after the last block stay with it.
    if pending and blocks:
        blocks[-1][1].extend(pending)
    return "".join(header), blocks


def well_formed(text):
    """Every block has a value and nothing is a conflict marker."""
    if re.search(r"^(<<<<<<<|=======|>>>>>>>)", text, re.M):
        return False
    _header, blocks = parse(text)
    for _name, lines in blocks:
        if not any(re.match(r"^\s+value:", l) for l in lines):
            return False
    return True


def render(header, blocks):
    out = header
    for name, lines in blocks:
        body = "".join(lines)
        # One blank line between blocks, as overlay.py writes them.
        if out and not out.endswith("\n\n"):
            out = out.rstrip("\n") + "\n\n"
        out += body.lstrip("\n").rstrip("\n") + "\n"
    return out


def merge_text(base, ours, theirs):
    """The merged file, or None when the inputs can't be merged."""
    with tempfile.TemporaryDirectory() as t:
        paths = {}
        for n, text in (("base", base), ("ours", ours), ("theirs", theirs)):
            paths[n] = os.path.join(t, n)
            open(paths[n], "w", encoding="utf-8").write(text)
        r = subprocess.run(["git", "merge-file", "-p", paths["ours"], paths["base"], paths["theirs"]],
                           capture_output=True, text=True)
    if r.returncode == 0 and well_formed(r.stdout):
        return r.stdout
    h_base, b_base = parse(base)
    h_ours, b_ours = parse(ours)
    h_theirs, b_theirs = parse(theirs)
    base_d = dict(b_base)
    ours_d = dict(b_ours)
    theirs_d = dict(b_theirs)
    header = h_ours if h_ours != h_base else h_theirs
    merged = []
    for name, lines in b_ours:
        if name in base_d and name not in theirs_d:
            continue  # theirs removed it
        if name in theirs_d and theirs_d[name] != base_d.get(name) and lines == base_d.get(name):
            lines = theirs_d[name]  # only theirs changed it
        merged.append((name, lines))
    # Theirs' new blocks go where theirs had them: after the block that
    # precedes them there (overlay.py lists features in a fixed order).
    previous = None
    for name, lines in b_theirs:
        names = [n for n, _ in merged]
        if name in names:
            previous = name
            continue
        if name in base_d and name not in ours_d:
            continue  # ours removed it
        at = names.index(previous) + 1 if previous in names else 0
        merged.insert(at, (name, lines))
        previous = name
    text = render(header, merged)
    return text if well_formed(text) else None


def main(argv):
    if len(argv) < 3:
        print("usage: merge_features.py %O %A %B [%P]", file=sys.stderr)
        return 2
    base_f, ours_f, theirs_f = argv[:3]
    path = argv[3] if len(argv) > 3 else ours_f
    read = lambda p: open(p, encoding="utf-8").read()
    merged = merge_text(read(base_f), read(ours_f), read(theirs_f))
    if merged is None:
        print(f"features merge: {path}: blocks can't be merged; fix by hand and run overlay.py apply",
              file=sys.stderr)
        return 1
    with open(ours_f, "w", encoding="utf-8") as f:
        f.write(merged)
    print(f"features merge: {path} merged as blocks ({len(parse(merged)[1])} prefs); "
          "overlay.py apply regenerates the exact text", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
