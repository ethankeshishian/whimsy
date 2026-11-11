# W24 tidy: implementation report

Branch: `lane/w24-tidy`. Changes are uncommitted. No builds, browser tests,
imports, verification scripts, shipping, or publishing were run, as required
by `intake-w24/brief-w24-tidy.md`. This worktree has no `engine/` checkout.

## Root cause and evidence

The confirmed default-profile failure is a missing general fallback, combined
with AI being off by default. Before this change:

- `prefs/whimsy/whimsy.yaml:38–39` defaults `whimsy.ai.enabled` to false.
  `WhimsyAI.sys.mjs:141–142` maps that to the AI block, and
  `WhimsyAIProviders.sys.mjs:247–248` gates provider enablement on it.
- `WhimsyTidyTitles.sys.mjs:81–87` at HEAD returns null for a host or route
  outside its fixed rules. Its only production caller is
  `WhimsyAITabs.sys.mjs:633` at HEAD.
- `WhimsyAITabs.sys.mjs:638–639` at HEAD then returns without changing the
  label when AI is disabled or the title is shorter than 24 characters.
  With AI enabled but no configured provider, lines 644–646 apply null.
  If the provider is offline, line 647 only logs the error. All four cases
  leave the title untouched, even though the tidy-titles feature defaults
  to true (`prefs/whimsy/features.yaml:381–382`).
- Essentials fail independently and unconditionally:
  `WhimsyAITabs.sys.mjs:619` at HEAD explicitly excludes `zen-essential`.
  `ZenPinnedTabManager.mjs:549` sets that attribute before pinning at line
  562, so moving a Today tab into Essentials always hits that exclusion.

These are exact failing code branches, including the default-profile case.
The brief does not supply the owner's page, title, pin gesture, or profile
prefs, so it is not possible to identify which branch their particular tab
hit without inventing evidence. No claim of a reproduced owner session or
missing Zen event is made here. Original line references above refer to HEAD,
so they remain useful after the edited module's lines move.

## Caller and pin-path trace

`Whimsy.sys.mjs:1006` always installs `WhimsyAITabs.initWindow`; its `run`
helper at lines 642–647 catches initialization errors rather than gating this
on tidy-tabs. The original title handler was registered for `TabPinned` on
`gBrowser.tabContainer` (`WhimsyAITabs.sys.mjs:96` at HEAD). No other
production caller invokes `onTabPinned`, and the title-rules module has no
separate event listener.

| Entry point | Source and destination |
| --- | --- |
| Context-menu Pin | Firefox's Pin command enters `gBrowser.pinTab`. Zen's context-menu updater retains this item for ordinary tabs (`ZenPinnedTabManager.mjs:674,705`). The engine implementation is absent in this worktree; the tests exercise the actual menu item. |
| Drag into pins | The drag/drop overlay calls `moveToAnotherTabContainerIfNecessary` (`src/browser/components/tabbrowser/content/drag-and-drop-js.patch:50`). `ZenPinnedTabManager.mjs:823–825` identifies the pinned target, and lines 885–887 call `gBrowser.pinTab`. |
| Drag into Essentials | The same manager identifies Essentials at lines 826–828, calls `addToEssentials` at line 881, and that method calls `gBrowser.pinTab` at line 562 for an unpinned tab. Already-pinned tabs move directly, then dispatch `TabAddedToEssentials` at lines 571–576. |
| Keyboard | `WhimsyShortcuts.sys.mjs:47` binds Cmd/Ctrl+D to `zen-toggle-pin-tab`; `src/zen/common/zen-sets.js:90–99` handles `cmd_zenTogglePinTab` and calls `gBrowser.pinTab`. |
| Command bar | `ZenUBGlobalActions.sys.mjs:123–130` supplies Pin Tab with `cmd_zenTogglePinTab`. `ZenUBActionsProvider.sys.mjs:567–597` dispatches that command, reaching the same keyboard handler. |
| Folders | `ZenFolders.mjs:743–745` pins each supplied tab before folder creation. Existing-folder insertion uses `ZenFolder.mjs:289–299`, then the tabbrowser group-move overlay pins the tab when the destination group is pinned (`src/browser/components/tabbrowser/Tabbrowser-sys-mjs.patch:1193–1197`). Split-group pinning recursively pins sibling tabs (`ZenFolders.mjs:837–859`). |

Zen's pin overlay (`src/browser/components/tabbrowser/Tabbrowser-sys-mjs.patch:155–177`)
changes placement and folder handling, then retains the base pin implementation.
It does not add a bypass that explains a missing event on the paths above.
The drag-image code's direct `pinned` attributes in `ZenDragAndDrop.js:2098–2099`
belong to preview clones, not a separate committed pin operation. No broad
attribute observer was added, which could otherwise rename restored pins or
previews. The handler now captures on the window and also handles
`TabAddedToEssentials`, covering moves of an already-pinned Essential.

## What changed

- Added `WhimsyTidyTitles.heuristic`, which works for any HTTP(S) host,
  removes leading unread counters and host-derived branding at either edge,
  preserves unknown meaningful separators, and limits labels to four words
  and 28 Unicode code points. No site-specific list was added or expanded.
  Existing fixed rules remain supported and run first.
- `WhimsyAITabs.onTabPinned` uses that fallback when AI is disabled, no
  provider is ready, the provider fails, or the response is empty or fails
  to shorten the title. Removed the 24-character eligibility floor.
  The feature remains default-on; the global AI setting is respected.
- Added window capture for pin/Essential events, deferred until Zen finishes
  moving the tab. Duplicate events share one in-flight operation. Newly
  pinned loading tabs wait for their title/busy notification, without
  automatically renaming existing pins at startup.
- Protected manually named tabs, active rename inputs, unpinned or closed
  tabs, changed URLs, and changed titles against delayed responses.
  Private tabs use local rules only, avoiding cloud fallback routing.
- Tidy names still use Zen's `zenStaticLabel` and `_setTabLabel` path.
  `src/browser/components/sessionstore/TabState-sys-mjs.patch:24` serializes
  this name; `src/zen/common/modules/ZenSessionStore.mjs:32–33` restores it.
  Zen's inline renamer at `ZenTabRenamer.mjs:176–183` can replace or clear it.
- Title requests use the router's `quick-text` task, avoiding the default
  `ask` task's connector-tool discovery for this unattended naming operation.
- Added a subtle label reveal using `--whimsy-dur-base` and `--whimsy-ease`
  in `whimsy-browser.css`, enabled only when reduced motion is not requested.
  No UI strings were introduced.

## Tests added or extended, not executed

Registered `browser_whimsy_tidy_titles_pinning.js` in `browser.toml`:

- `test_every_pin_path_tidies_preserves_and_persists`: context menu, actual
  synthesized drops into pins and Essentials, Cmd/Ctrl+D, engagement of the
  real command-bar Pin result, folder creation, and insertion into an
  existing folder. Each path checks the visible label, keeps a manually
  set name without calling AI, and serializes/restores the name through
  SessionStore.
- `test_no_provider_offline_and_ai_disabled_fallback`: unavailable,
  failing, and empty stub providers, plus the AI kill switch.
- `test_short_titles_and_late_manual_rename`: a title below the old
  threshold and a real inline rename while a stub AI response is pending.
- `test_title_switch_off`: the feature switch preserves the page label.
- `test_loading_pin_and_reduced_motion`: deferred loading and disabled
  animation under reduced motion.

Extended `browser_whimsy_tidy_titles_rules.js` with
`test_general_heuristic_without_site_rules` for counters, arbitrary hosts,
prefix/suffix branding, length, meaningful separators, empty output, and
non-web URLs. Added `tidy_title_on_pin` to `browser_whimsy_screens.js`, saving
`w24-tidy-title-on-pin.png` when screenshots are enabled.

All AI paths in the new browser file use the automation-only stub provider,
never a real provider or key. No new tests write outside the test profile.

Static checks performed: Node syntax checks for both modules and all three
changed/new JS test files, Python `tomllib` parsing of `browser.toml`, and
`git diff --check`. All passed. These checks do not establish browser behavior.

Direct module/CSS consumer search identifies `browser_whimsy_ai_tabs.js`,
`browser_whimsy_tidy_titles_rules.js`, `browser_whimsy_screens_5.js`, and
`browser_whimsy_font_inspector.js`, in addition to the new pinning file and
changed screenshot file. Run these after the brief's test prohibition is
lifted. The shared browser stylesheet also warrants the usual visual suite.

## Risks and remaining validation

- Browser tests and screenshots are unrun; no green runtime claim is made.
  Native drag/drop, context-menu activation, keyboard dispatch, folder
  lifecycle, and session-restoration timing need Gecko validation.
- The fallback is deliberately conservative about site names that cannot
  be derived from the hostname. Long titles may lose distinguishing words
  when shortened. Already clean titles remain unchanged.
- AI responses wait for the existing provider/router timeout before the
  local fallback is applied on a stalled request; no independent timeout
  or new network path was introduced.
- Essentials are icon tiles: their shortened label is available to the
  existing tooltip/accessibility surfaces. Zen still hides its inline
  rename UI for Essentials (`ZenTabRenamer.mjs:104–109`), as before. Returning
  one to ordinary pins exposes the normal rename flow.
- No owner session was inspected, and no live restart was performed. The
  persistence test uses SessionStore serialization and restoration, matching
  the existing rename regression strategy.

## Report delivery

Copying this report to the requested
`~/Repos/whimsy-handoff/intake-w24/codex-tidy-report.md` failed with
`Operation not permitted`. That directory is outside this session's writable
roots. This worktree copy is retained; the denial was not bypassed.
