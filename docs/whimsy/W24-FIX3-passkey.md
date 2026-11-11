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


## Follow-up after c96be05f: routed window tab invalidation

The newer `/tmp/w13/passkey-p1.log` supersedes the earlier evidence above. Its lines 733–775 show ordinary extension-window account tabs surviving, keeping their extension IDs, and having no replacement; lines 789–793 show the ordinary `tabs.create` rule case passing too. The final `request("window", { url: httpAccount, cookieStoreId: "firefox-default" })` is the failing operation (stack at lines 837–842, test's former line 432). The window clones 29 tabs at line 808, the extension API succeeds at line 836, and resolving its populated tab IDs throws for ID 85 at line 837. The unexpected-window failure is at line 1193.

### Product cause and change

There are two independent consumers of the startup cookie store:

1. `src/browser/components/tabbrowser/whimsy-Tabbrowser-sys-mjs.patch:8–18` overrides the initial browser's store using the startup site's rule. The initial-space hook in `whimsy/overlay.py:81–98` likewise selects the routed space before tab placement.
2. Firefox's `browser/base/content/browser-init.js:857–860, 923–929` subsequently passes **window.arguments[5]** to `openLinkIn(..., "current", ...)`. Before this change, `whimsy-ext-windows-js.patch` still populated that argument with the extension's explicit Default store (or the invoking space's profile), despite the initial browser already using the rule's B profile.

Firefox's `browser/modules/URILoadingHelper.sys.mjs:579–586` responds to that mismatch by opening another tab. Before Zen startup is ready, `ZenSpaceRoutingManager.sys.mjs:434–437` skips ordinary addTab routing. The resulting Default-profile tab can therefore be placed in B's startup space. Once workspaces initialize, `Whimsy.sys.mjs:1154–1157` starts isolation: `WhimsyIsolation.sweep:184–188` calls `repair(..., { inPlace: true })`, which queues mismatches for `WhimsyProfileMoves.reopen` (`WhimsyIsolation.sys.mjs:292–294, 338–342`). **The actual close operation in that path is `gBrowser.removeTab(tab, { animate: false, skipPermitUnload: true })` at `WhimsyProfileMoves.sys.mjs:231`, after setting `_whimsyReopenedAs` at line 191.** This is a product bug; extension-created account tabs must not need that repair.

Fix: `src/browser/components/extensions/parent/whimsy-ext-windows-js.patch:13–28, 40–59` resolves the initial URL's site rule against the already initialized **source window**, then puts the destination's profile in args[5] as well as its space in the extra-options bag. Both startup stages now agree before any account document loads. An explicit cookie store is still validated before a site rule overrides it. With no matching rule, explicit stores and invoking-profile inheritance retain their existing behavior. Private windows and tab adoption retain their existing paths. No isolation exemption, in-place container mutation, or replacement-following workaround was introduced; genuinely crossed tabs still require isolation repair.

Evidence limit: this log contains neither a close stack nor an ID-to-URL dump for tab 85. It proves that a populated API ID became invalid during the final routed-window case, but does not independently identify which of the 29 cloned/initial/account tabs had ID 85. The source trace above identifies the concrete startup-store mismatch and the repair/close path it enables; associating that particular numeric ID with that close remains a runtime verification item. The earlier blanket statement that the replacement hypothesis did not explain the failure does not apply to this new log.

### Regression and cleanup

- `extension_account_tabs_stay_in_the_invoking_space` — startup store disagreed with routed profile (`whimsy-ext-windows-js.patch:13–59`); fix the store before window creation. Expand the real routed-window regression to cover both inherited and explicitly different stores, asserting the returned store, destination space/profile, exact URL, original tab ID, connection, and absence of replacements. Existing assertions remain intact; there are no sleeps or relaxed assertions.
- Unexpected browser window — `request()` resolved every returned tab ID before registering its window (`browser_whimsy_passkey_extension.js`, former lines 308–315), so the ID exception bypassed registration. Observe `domwindowopened` from setup (`browser_whimsy_passkey_extension.js:147–150`), before any request or ID lookup. Cleanup attempts every tracked window even if Scratch cleanup or an earlier window close fails, and retains those errors rather than hiding them.

### Static validation

- JavaScript syntax checks passed for the updated browser test and for `ext-windows.js` after applying the revised patch to an isolated temporary copy.
- The revised patch applies cleanly after reversing the previous Whimsy patch in that temporary copy; the shared engine was not modified.
- `git diff --check` passed.
- No build, import, browser test, or commit was run, per the fixrun brief. Runtime confirmation of the close path and green regression results remain outstanding. `NIGHT-LOG.md` is unchanged.
- The brief's separate `~/Repos/whimsy-handoff/intake-w24/fix-passkey-report.md` is outside this session's writable roots; the report is appended here as explicitly requested.
