# Brief for feature subagents (overnight build, Oct 29 2026)

You are implementing one batch of Whimsy features. Whimsy is a Zen Browser
(Firefox) fork at ~/Repos/whimsy, branch `dev`. The user is asleep; never wait
for input. Read, in order: `CLAUDE.md`, `docs/whimsy/BUILD-PLAN.md` (rules and
the user's answers, which win over anything here), and the relevant lines of
`docs/whimsy/build-queue.md` (the user's notes per feature).

## Steps for each feature
1. **Verify what exists first.** grep Zen (`src/zen/`, `prefs/`), Firefox
   (`engine/browser/`, `engine/toolkit/`, `engine/modules/libpref/init/`) for
   the feature, prefs and shortcuts. If it exists, expose/polish it (pref
   default, Settings toggle, menu item) instead of rebuilding.
1b. **Check Zen's GitHub issues/PRs** (`gh search issues --repo zen-browser/desktop <terms>`, `gh pr list`). If an open issue or PR covers the feature, use it as reference (requested behavior, edge cases, proposed designs) and mention it in the commit body.
2. **Know the original.** One or two sentences in the commit body: where it
   comes from, why users love it, the exact user flow. Arc features: match
   Arc's behavior and shortcuts (parity). Use WebSearch sparingly if unsure.
3. **Build it as an overlay.** Never edit Zen files; see CLAUDE.md. New code
   goes in `src/zen/whimsy/` (one module per feature area, e.g.
   `WhimsyCopy.sys.mjs`, or `content/whimsy-<area>.js`; keep
   `Whimsy.sys.mjs`/`whimsy-window.js` as thin dispatchers). New files need
   `moz.build`/`jar.inc.mn` entries and `npm run import`. Strings in
   `locales/en-US/browser/browser/whimsy.ftl`. Prefs in `prefs/whimsy/`.
   Add a `FEATURES` entry in `whimsy/overlay.py` (id, title, detect pattern)
   so there's a `whimsy.feature.<id>` switch; default ON unless the note says
   off. User-facing toggles go in Settings
   (`src/browser/components/preferences/whimsy-preferences-head.inc.xhtml`).
4. **Polish, no bloat.** Considered motion (short, eased, respects
   `prefers-reduced-motion`), clear empty states, toasts that confirm actions
   (reuse Zen's `gZenUIManager.showToast` if it exists). Lazy-load modules;
   no work at startup unless needed; no polling unless the feature is polling.
5. **Test thoroughly.** A mochitest in `src/zen/whimsy/tests/` (add to
   `browser.toml`) covering the main flow, the feature switch off, and edge
   cases. Visual changes: add a screenshot case to `browser_whimsy_screens.js`
   and look at the PNG in `.surfer/shots/`.
6. **Loop:** `python3 whimsy/precheck.py` → `npm run import` if new files or
   prefs → `cd engine && ./mach build faster` → `sh whimsy/verify.sh quick`
   (log: `.surfer/verify/whimsy.log`). Everything must pass, including
   existing tests. Then commit on `dev`, one commit per feature, message
   "<Feature>: <what>", NO Co-Authored-By/Claude-Session/"Generated with"
   lines. Don't push; don't run `npm run ship` (the lead does).
7. **Stuck?** If a feature can't pass in reasonable time (about 3 fix
   attempts), `git checkout`/revert it, leave the tree clean, and report it.

## Keep context small
Don't read big files whole (use grep, sed -n ranges). Keep command output
short (`| tail -20`). Build and test output: tail only.

## Report back (under 150 words)
Per feature: done / already existed (what you exposed) / dropped (why);
commit hashes; any Arc-vs-Zen call you made; anything the user should know.
Leave the working tree clean on `dev`.

## Never spawn sub-agents
Do all the work yourself in this one agent. Spawning agents wastes the usage budget.

## Context budget
Auto-compaction runs at ~200k tokens; keep going. Only if context passes ~220k without compacting: commit, leave the tree clean, report what's left.
