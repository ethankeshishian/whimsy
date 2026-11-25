"""Summarize an AI eval run: per-feature pass rates, every failure with the
model's output and the reason, tokens and cost, and what changed since the
previous run in the same runs folder (regressions first).

    python3 whimsy/tools/aievals_report.py .surfer/aievals/runs/<time>

Reads the <file>.json files browser_whimsy_aievals_*.js wrote there (via
head_aievals.js) and writes report.md beside them, printing it too. The
previous run is the newest sibling folder older than this one that holds
results. Exits 1 when the folder has no results at all (the harness never
got to write them).
"""
import json
import sys
from pathlib import Path

OUTPUT_CHARS = 400
STATUSES = ("pass", "fail", "error", "skipped-budget")


def load_run(folder):
    """All cases of a run folder, by id, plus the run totals."""
    cases = {}
    totals = {"requests": 0, "input": 0, "output": 0, "cost": 0.0}
    files = []
    for path in sorted(Path(folder).glob("*.json")):
        try:
            data = json.loads(path.read_text())
        except (OSError, ValueError):
            continue
        if not isinstance(data, dict) or "results" not in data:
            continue
        files.append(data)
        for r in data["results"]:
            cases[r["id"]] = r
        for k in ("requests", "input", "output", "cost"):
            totals[k] += data.get("totals", {}).get(k, 0) or 0
    return {"cases": cases, "totals": totals, "files": files}


def previous_run(folder):
    me = Path(folder).resolve()
    siblings = sorted(p for p in me.parent.iterdir() if p.is_dir() and not p.is_symlink() and p.name < me.name)
    for p in reversed(siblings):
        run = load_run(p)
        if run["cases"]:
            return p, run
    return None, None


def by_feature(cases):
    out = {}
    for r in cases.values():
        f = out.setdefault(r["feature"], {s: 0 for s in STATUSES})
        f[r["status"] if r["status"] in STATUSES else "error"] += 1
    return out


def rate(f):
    ran = f["pass"] + f["fail"] + f["error"]
    return (f["pass"] / ran) if ran else 0.0, ran


def short(value, n=OUTPUT_CHARS):
    if value is None:
        return ""
    text = value if isinstance(value, str) else json.dumps(value, ensure_ascii=False)
    text = " ".join(text.split())
    return text if len(text) <= n else text[: n - 1] + "…"


def output_text(r):
    out = r.get("output")
    if isinstance(out, dict):
        slim = {k: v for k, v in out.items() if k not in ("tabObjects",) and v not in ("", None, [], 0)}
        if "files" in slim:
            slim["files"] = short(slim["files"], 200)
        return short(slim)
    return short(out)


def compare(now, before):
    """Regressions (passed before, not now), fixes, and new or gone cases."""
    regressions, fixes, new, gone = [], [], [], []
    for cid, r in now.items():
        if cid not in before:
            new.append(cid)
            continue
        was, is_ = before[cid]["status"], r["status"]
        if was == "pass" and is_ in ("fail", "error"):
            regressions.append((cid, is_, r.get("reason", "")))
        elif was in ("fail", "error") and is_ == "pass":
            fixes.append(cid)
    for cid in before:
        if cid not in now:
            gone.append(cid)
    return regressions, fixes, new, gone


def render(folder, run, prev_path, prev):
    cases, totals, files = run["cases"], run["totals"], run["files"]
    lines = [f"# AI evals: {Path(folder).name}", ""]
    if files:
        f0 = files[0]
        lines.append(f"Mode {f0.get('mode', '?')}, model {f0.get('model', '?')}, judge {f0.get('judgeModel', '?')}, cases v{f0.get('version', '?')}, {len(files)} file(s).")
    feats = by_feature(cases)
    all_pass = sum(f["pass"] for f in feats.values())
    all_ran = sum(rate(f)[1] for f in feats.values())
    skipped = sum(f["skipped-budget"] for f in feats.values())
    lines += [
        "",
        f"**Overall: {all_pass}/{all_ran} passed ({(all_pass / all_ran * 100) if all_ran else 0:.0f}%)**"
        + (f", {skipped} skipped for budget" if skipped else "")
        + f". {totals['requests']} requests, {totals['input']:,} input + {totals['output']:,} output tokens, ${totals['cost']:.2f}.",
        "",
        "## Per feature",
        "",
        "| Feature | Pass | Fail | Error | Skipped | Rate |",
        "|---|---|---|---|---|---|",
    ]
    for name in sorted(feats):
        f = feats[name]
        r, ran = rate(f)
        lines.append(f"| {name} | {f['pass']} | {f['fail']} | {f['error']} | {f['skipped-budget']} | {r * 100:.0f}% of {ran} |")
    if prev:
        regressions, fixes, new, gone = compare(cases, prev["cases"])
        lines += ["", f"## Compared with {prev_path.name}", ""]
        if regressions:
            lines.append("**Regressions** (passed before):")
            for cid, status, reason in regressions:
                lines.append(f"- {cid}: now {status}. {short(reason, 200)}")
        else:
            lines.append("No regressions.")
        if fixes:
            lines.append("Fixed: " + ", ".join(fixes))
        if new:
            lines.append("New cases: " + ", ".join(new))
        if gone:
            lines.append("No longer run: " + ", ".join(gone))
        d = totals["cost"] - prev["totals"]["cost"]
        lines.append(f"Cost ${totals['cost']:.2f} vs ${prev['totals']['cost']:.2f} ({'+' if d >= 0 else '-'}${abs(d):.2f}).")
    else:
        lines += ["", "No previous run to compare with."]
    failures = [r for r in cases.values() if r["status"] in ("fail", "error")]
    lines += ["", f"## Failures ({len(failures)})", ""]
    for r in sorted(failures, key=lambda r: (r["feature"], r["id"])):
        lines.append(f"### {r['id']}: {r['title']} ({r['status']})")
        lines.append(f"- Reason: {short(r.get('reason', ''), 300)}")
        failed = [c for c in r.get("checks", []) if not c.get("pass")]
        if len(failed) > 1:
            lines.append("- Also failed: " + "; ".join(f"{c['type']} ({short(c.get('detail', ''), 120)})" for c in failed[1:]))
        lines.append(f"- Output: {output_text(r)}")
        lines.append(f"- {r.get('requests', 0)} requests, {r.get('tokens', {}).get('input', 0):,}+{r.get('tokens', {}).get('output', 0):,} tokens, ${r.get('cost', 0):.3f}, {r.get('ms', 0) / 1000:.0f} s")
        lines.append("")
    skipped_ids = [r["id"] for r in cases.values() if r["status"] == "skipped-budget"]
    if skipped_ids:
        lines += ["## Skipped for budget", "", ", ".join(sorted(skipped_ids)), ""]
    lines += ["## Cost by case", "", "| Case | Status | Requests | Tokens in+out | Cost | Time |", "|---|---|---|---|---|---|"]
    for r in sorted(cases.values(), key=lambda r: -(r.get("cost") or 0)):
        t = r.get("tokens", {})
        lines.append(f"| {r['id']} | {r['status']} | {r.get('requests', 0)} | {t.get('input', 0):,}+{t.get('output', 0):,} | ${r.get('cost', 0):.3f} | {r.get('ms', 0) / 1000:.0f} s |")
    return "\n".join(lines) + "\n"


def main(argv):
    if len(argv) != 2:
        print(__doc__)
        return 2
    folder = Path(argv[1])
    run = load_run(folder)
    if not run["cases"]:
        print(f"aievals_report: no results in {folder} (did the harness write <file>.json?)", file=sys.stderr)
        return 1
    prev_path, prev = previous_run(folder)
    report = render(folder, run, prev_path, prev)
    (folder / "report.md").write_text(report)
    print(report)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
