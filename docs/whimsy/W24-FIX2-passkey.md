# W24 passkey fix, round 2

Root cause: the test uses the obsolete `tab.ownerGlobal` property instead of
`tab.documentGlobal`. The reported exception occurs in the test's window-ready
predicate, after `browser.windows.create` has returned successfully. It does not
establish a product popup/profile-routing failure. The first window case is a
normal HTTP window; the popup case follows it and was never reached in this task.

Failure mapping (source lines before this fix):

- `extension_account_tabs_stay_in_the_invoking_space` — `browser_whimsy_passkey_extension.js:299–301` stores undefined and then dereferences it in the startup predicate — use `documentGlobal`, retain the startup wait, and assert that the tracked window owns the extension API's tab.
- Cleanup `win is undefined` — `browser_whimsy_passkey_extension.js:150` dereferences the undefined entry inserted at line 299 — track the actual window before waiting, so cleanup can close it even if startup fails.
- `Extension left running at test shutdown` — the cleanup exception at line 150 aborts the cleanup function before the primary extension's unload at line 169 — removing the undefined entry restores that cleanup path; the account extension already has its own task-level `finally` unload.
- Unexpected browser window — the extension-created window is not tracked correctly at line 299 and cleanup aborts at line 150 — track and close the real window, including the normal, popup, and explicitly routed cases.
- Unexpected `about:blank` tab — the same cleanup abort skips the tracked-tab removal loop at lines 154–158 — restore the complete cleanup path. The log does not identify this tab's creator.

Evidence: `/tmp/w13/fail24b/passkey-p1.log:848–855` reports 234/239 subtests
passing and these five failures. The product's extension-window patch passes
window references directly (`src/browser/components/extensions/parent/whimsy-ext-windows-js.patch`);
the extension-tab patch and native space-routing handlers use `documentGlobal`
(`whimsy-ext-tabs-js.patch:16`, `ZenSpaceRoutingManager.sys.mjs:60,73`). No
corresponding product `ownerGlobal` defect was found in those paths. The previous
fix corrected the browser focus helper but left five tab-window accesses behind.
All five are corrected here, including later window assertions and closure.

Validation: `node --check src/zen/whimsy/tests/browser_whimsy_passkey_extension.js`
and `git diff --check` passed. Existing profile inheritance, explicit cookie
store, no-transient-space-switch, site-rule, and popup assertions are preserved.
No builds, browser tests, imports, commits, or NIGHT-LOG edits were made, as
required by the fix-run brief. Browser behavior remains unverified pending the
coordinator's rerun of `browser_whimsy_passkey_extension.js`, the only changed
test/consumer. No product files changed.
