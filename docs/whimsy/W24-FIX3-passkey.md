# W24 FIX3: passkey

- `extension_account_tabs_stay_in_the_invoking_space` — test selected the first restored tab, rather than the requested account tab (`src/zen/whimsy/tests/browser_whimsy_passkey_extension.js`, former line 260, `win.tabs[0]`). Fix: give each window account request a unique query parameter, wait for its exact URL among the API-returned tabs after window initialization, and retain the existing profile, space, routing, and load assertions. Assert that account tabs remain connected, keep their extension IDs, and have no `WhimsyProfileMoves` replacement (`browser_whimsy_passkey_extension.js:259–332`).
- Cleanup `removeProgressListener` exception — cleanup closed windows before removing their tracked tabs, whose browser progress objects had already been destroyed (`browser_whimsy_passkey_extension.js:149–156`). Fix: window-owned account tabs are cleaned up through their tracked windows, and the tab cleanup skips closed owning windows.
- `Extension left running` — the preceding cleanup exception prevented cleanup from reaching `extension.unload()` (`browser_whimsy_passkey_extension.js:166–167`). The closed-window cleanup fix removes this failure path.

## Evidence and hypothesis

The replacement hypothesis does not explain the observed timeout:

- `/tmp/w13/passkey-p1.log:607` records sync ID `1794394072131-d31a1982-15c7-4b0b-8820-751d53d901f9` in session data, already associated with the HTTPS fixture without an account query.
- Line 657 reports that same sync ID as the test's `request(window)` tab, although the request was for the HTTP fixture with `?account=one`.
- Line 663 reports the same tab still connected, not closing, with a browser, live `webProgress`, and the original HTTPS URL. This is the restored fixture tab, not a dead account tab.
- `ZenSessionManager.sys.mjs:908–976` clones existing tabs into a new normal window. Gecko's extension `Window.getTabs()` enumerates `gBrowser.tabs`, and `windows.create()` returns `win.convert({ populate: true })`; neither promises that the requested startup URL occupies array index zero in Zen's populated window.
- `WhimsyIsolation.sys.mjs:84–93` detects a container mismatch; the logged tab has container 8 in Account A's space, matching the successful Account A requests. `WhimsyProfileMoves.reopen()` creates a new tab, records `_whimsyReopenedAs`, and removes the old tab. No matching repair/reopen stack appears in the supplied debug log, and the observed tab state does not establish a replacement.

No product isolation exception or replacement-following workaround was added. The new identity assertions will expose an actual account-tab teardown instead of following its replacement. The unique window URL also prevents selecting a restored tab from an earlier account request.

## Validation and limits

- `node --check src/zen/whimsy/tests/browser_whimsy_passkey_extension.js` passed.
- `git diff --check` passed.
- No failure lines were found in `/tmp/w13/fail24/passkey-p2.log` or `passkey-p3.log`. The newer debug files `/tmp/w13/passkey-p2.log` and `passkey-p3.log` are absent.
- No build, import, browser test, or commit was run, as directed by the fixrun brief. Browser execution of the updated test remains outstanding; this is not a green test-run claim.
- `NIGHT-LOG.md` is unchanged. This report is at the user's requested in-worktree path; the brief's separate handoff report path is outside the writable roots.
