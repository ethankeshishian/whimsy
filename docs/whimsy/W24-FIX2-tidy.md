# W24 tidy — fix round 2

- `browser_whimsy_tidy_titles_pinning.js / test_every_pin_path_tidies_preserves_and_persists` — test snapshot race at `src/zen/whimsy/tests/browser_whimsy_tidy_titles_pinning.js:108`: `getTabState()` synchronously collects cached content history, while `page()` waits only for the chrome title and busy flag. An empty/stale active entry means SessionStore's `#updateTabLabelAndIcon()` has no page from which to paint the restored name. Flush content state before serializing, and assert that the active saved URL equals the loaded page. All existing background-visible-name, static-name, manual-name, and pin-path checks remain.
- `browser_whimsy_screens.js / vpn_panel` — shared-engine contamination, rather than a missing test summary: `/tmp/w13/fail24b/tidy-p3.log:975` records SIGSEGV at 0:28.53, immediately after entering `vpn_panel` at 0:28.50. W24 uifix2 commit `5b3ebd09` adds a native VPN CSS import through `engine_overrides.py`, plus its stylesheet and jar entry. The shared engine retains that import at `browser/components/ipprotection/content/ipprotection-content.css:6`, but tidy has neither the asset nor its jar entry. `apply_engine_text_fixes()` previously only added replacements; switching branches never removed retired ones. Fix at `whimsy/engine_overrides.py:246`: migrate the pre-ledger VPN hook, record override replacements in the engine's Git metadata, and reverse exact retired/changed replacements on subsequent imports. Keep the VPN import when its owning branch declares it, and preserve unrelated engine edits. Added `whimsy/tests/test_engine_overrides.py` covering migration, active-hook retention, branch switches, changed replacements, idempotence, and upstream changes.

## Evidence and limits

The pinning log passes serialized `zenStaticLabel` for keyboard pinning, then times out on the restored visible name (`tidy-p1.log:420`). The six preceding context-menu/drag restores pass. The asynchronous-history cache ordering is established by `SessionStore.getTabState()`, `TabState.#collectBaseTabData()`/`copyFromCache()`, and `SessionStore.#updateTabLabelAndIcon()` in this engine. The failed run did not log its serialized history; the empty/stale-entry explanation is a source-backed diagnosis requiring browser confirmation. The new URL assertion exposes an invalid snapshot directly instead of allowing a later label timeout.

The crash also occurs at `vpn_panel` in `/tmp/w13/fail24/tidy-p3.log` (0:29.23). The matching earlier native report, `~/Library/Logs/DiagnosticReports/zen-2026-11-10-201326.ips` (PID 66749), has `CheckForBrokenChromeURL` → `nsFileChannel::MakeFileInputStream` → synchronous CSS loading → `LoadChildSheet`/`LoadImportSheet`. The second run has no matching native report available, but repeats the same task and timing. The dangling CSS import is still present in the shared engine and is absent from this lane's override inventory. No engine file was edited directly.

Recorded results are **54 passed / 1 failed** for pinning, **125 passed / 0 failed** for rules, and **33 passed / 0 failed before process death** for screenshots. The screenshot counts are partial, and do not constitute a passing file: there is no `TEST_END` for it.

## Validation and follow-up

Node syntax check for the modified browser test, Python AST parsing for both Python files, and `git diff --check` pass. Per `brief-w24-fixrun.md`, no tests, imports, builds, verify runs, or commits were performed. `NIGHT-LOG.md` is unchanged. The shared engine has deliberately been left untouched; the next import must execute the fixed override cleanup before building.

Pending owner-run validation: `python3 -m unittest discover -s whimsy/tests -p test_engine_overrides.py`, followed by the locked lane import/build and the three original browser files (`browser_whimsy_tidy_titles_pinning.js`, `browser_whimsy_tidy_titles_rules.js`, and `browser_whimsy_screens.js` with screenshots enabled). Confirm the screenshot file reaches `TEST_END`, rather than accepting its partial zero-failure count. Also run `browser_whimsy_vpn.js` and `browser_whimsy_vpn_controls.js` to exercise the native panel consumer. This is not yet a verified green lane.

The report is written here as requested in the round-2 instruction. The older brief's handoff report destination is outside this session's writable roots and was not written.


Orchestrator note: the engine_overrides.py ledger change was not taken. The shared-engine leak is a test-runner issue and is fixed in the runner (it now resets every engine text fix before each lane import).
