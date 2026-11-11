# W24 FIX3: Command tab numbers

- `real_digits_match_badges` — product cause: the window-targeted `blur` handler in `src/zen/whimsy/WhimsyCmdTabNumbers.sys.mjs:98` cleared held-key state and cancelled the next hold during chrome/content focus transfer after the real shortcut; reset on top-level `deactivate` instead, retaining genuine window-loss cancellation.
- `other_spaces_have_no_badges` — same product cause at `src/zen/whimsy/WhimsyCmdTabNumbers.sys.mjs:98`, after the first real digit in the new space; same activation-based fix. Space filtering, badge assertions, and real shortcut selection assertions are unchanged.
- `private_space_excludes_essentials` — same product cause at `src/zen/whimsy/WhimsyCmdTabNumbers.sys.mjs:98`, after the first real digit in Private Space; same activation-based fix. Essential/sentinel exclusions and shortcut assertions are unchanged.

## Evidence and diagnosis

Read `/tmp/w13/cmdhints-p1.log` with targeted searches. The supplied
`/tmp/w13/cmdhints-p2.log` and `-p3.log` do not exist in this workspace;
the older `/tmp/w13/fail24/cmdhints-p1.log`, `-p2.log`, and `-p3.log` are
available and were searched for failures/errors as directed by the brief.

In the instrumented log, lines 297–303 show Digit1 down/up, Meta up, and
a fresh Meta down with `meta=false`, empty `keys`, and `buttons=0`, followed
by `TIMER STARTED`. No timer callback follows before the failure at line 304.
This rules out a stale Meta/chord guard or a listener bound to the old tab:
the new press reached the listener and passed its guards. The equivalent
sequences are lines 428–435 and 511–518. At lines 435 and 518, before the
cleanup Meta keyup is processed, the logged state is already `meta=false`
with empty `keys`. The old blur handler is the only live-window path that
both clears the entire key set and cancels the timer without a key event.
The diagnosis is inferred from those state transitions; the supplied debug
output does not log blur itself.

Gecko's `dom/base/nsFocusManager.cpp:2699`–2704 sends document and window
blur when leaving a focused document. Testing `event.target == win` does
not distinguish that from top-level window loss. In contrast,
`nsFocusManager::ActivateOrDeactivate` at line 1659 dispatches the
chrome-only `activate`/`deactivate` event for the top-level browser window.
The fix uses that lifecycle event, with the existing target guard and
state/timer cleanup. Registration and unload removal still use the same
listener table. No tab-selection or workspace state reset is needed.

The older fail24 log also reports early Cmd+1 destination comparisons.
The current source already awaits the captured native `command` event in
`assertShortcutTargets`; the newer instrumented log passes those comparisons
before the hold timeout. That existing asynchronous-command correction is
preserved. Key simulation, remote-reply filtering, and the hold delay are
unchanged.

## Regression coverage and validation

Added `chrome_document_blur_preserves_hold` in
`src/zen/whimsy/tests/browser_whimsy_cmd_tab_numbers.js:107`: dispatch a
window-targeted blur during a pending hold, wait for the actual visible
attribute, dispatch another blur while visible, and verify release still
hides the badges. The old handler deterministically cancels this pending
hold. The existing real second-window focus test still checks immediate
cancellation, and now also checks a fresh hold after returning to the first
window. The three original failing tasks continue to exercise actual
Cmd+digit commands and normal/Private Space filtering.

`node --check` passed for both changed JavaScript files, and
`git diff --check` passed. A scoped consumer search found only
`browser_whimsy_cmd_tab_numbers.js` directly loading the module in the tests.
No browser tests, other test runs, imports, builds, or verify runs were
performed, per the fix-run brief. Runtime confirmation of all three
reported failures and the added regression remains outstanding; this is
not a claim of a green browser run. No sleeps, relaxed assertions, or longer
timeouts were added. No commit was made, and `NIGHT-LOG.md` was left alone.
