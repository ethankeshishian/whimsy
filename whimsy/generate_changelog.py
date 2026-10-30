"""Generates the data behind the Changelog tab (about:whimsy?tab=changelog)
from docs/whimsy/NIGHT-LOG.md: one short, user-facing line per change,
grouped by the dev build version it shipped in. No commit hashes, no
build/session process notes.

    python3 whimsy/generate_changelog.py

This also runs as part of `npm run import` (see overlay.py's package.json
OVERRIDES), but its output is committed like prefs/whimsy/features.yaml:
there's no CI to generate it, so re-run this and commit the result whenever
NIGHT-LOG.md changes.
"""
import json
import os
import re

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LOG = os.path.join(ROOT, "docs", "whimsy", "NIGHT-LOG.md")
OUT = os.path.join(ROOT, "src", "zen", "whimsy", "content", "whimsy-changelog.json")

SHIP_RE = re.compile(r"^Shipped\s+([\w.-]+)\s+at\s+", re.I)
HASH_RE = re.compile(r"\b[0-9a-f]{7,40}\b")
TIME_PREFIX_RE = re.compile(r"^\(?\d{1,2}:\d{2}[^)]*\)?\s*:?\s*")
BATCH_PREFIX_RE = re.compile(r"^\s*Batch\s+\d+\w*\s*(\([^)]*\))?\s*:?\s*", re.I)
WS_RE = re.compile(r"\s{2,}")
DONE_RE = re.compile(r"\b(DONE|WIP|RUNNING)\b")

# Sentences that are build/session process notes, not a user-facing change.
SKIP_RE = re.compile(
    r"(?i)("
    r"\bscout(s|ed)?\b|\bwave\d|wave mode|\bcodex\b|\bsonnet\b|\bopus\b|"
    r"session (limit|budget)|resume order|fix batch|merge note|git stash|"
    r"\bstash(ed)?\b|\bbuilder\b|sub-?agent|usage (limit|budget)|"
    r"context budget|spawned its own|hit a session|wrap up at|"
    r"told to (continue|wrap)|writer in whimsy-wt|whimsy-wt/|"
    r"\bRESUME\b|docs/whimsy/scout|lead (merges|ships|reviews)|"
    r"^all done\.?$|^gotcha:|\d+\s+(passed|failed)\b|"
    r"^(when it reports|after it)[:,]|no new batch|limit resets|"
    r"^ship(ping)?\b"
    r")"
)


def clean_sentence(text):
    text = HASH_RE.sub("", text)
    text = TIME_PREFIX_RE.sub("", text)
    text = BATCH_PREFIX_RE.sub("", text)
    text = DONE_RE.sub("", text)
    text = WS_RE.sub(" ", text).strip(" .,:;-")
    return text


def entries_from_line(line):
    out = []
    for sentence in re.split(r"(?<=[.!])\s+", line):
        sentence = sentence.strip()
        if not sentence or SKIP_RE.search(sentence):
            continue
        cleaned = clean_sentence(sentence)
        if len(cleaned) >= 6 and not SKIP_RE.search(cleaned):
            out.append(cleaned)
    return out


def dedupe(entries):
    seen = set()
    out = []
    for e in entries:
        if e not in seen:
            seen.add(e)
            out.append(e)
    return out


def generate():
    groups = []
    pending = []
    if os.path.exists(LOG):
        for raw in open(LOG, encoding="utf-8"):
            line = raw.strip()
            if not line or line.startswith("#"):
                continue
            line = re.sub(r"^-\s*", "", line)
            shipped = SHIP_RE.match(line)
            if shipped:
                groups.append({"version": shipped.group(1), "entries": dedupe(pending)})
                pending = []
                continue
            pending.extend(entries_from_line(line))
    if pending:
        groups.append({"version": "Unreleased", "entries": dedupe(pending)})
    groups = [g for g in groups if g["entries"]]
    groups.reverse()
    return groups


def main():
    groups = generate()
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump({"groups": groups}, f, indent=2)
        f.write("\n")
    print(f"wrote {len(groups)} version group(s) to {os.path.relpath(OUT, ROOT)}")


if __name__ == "__main__":
    main()
