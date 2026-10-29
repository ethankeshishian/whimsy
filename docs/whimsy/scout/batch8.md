# Scout batch 8: tab lifecycle (archive, undo, snooze, tree tabs, fire button, heavy tabs)

Read-only research, 2026-10-29. Paths relative to ~/Repos/whimsy. "Overlay" = new code in
src/zen/whimsy/ (+ prefs/whimsy/whimsy.yaml, whimsy-settings.js), no Zen edits. Zen feature
requests live in GitHub Discussions (D#); gh search issues --repo zen-browser/desktop found
nothing on-topic for any item below except #13822 (noted in item 2).

## Shared model (build this first, the rest sit on top of it)

Six features, two shared pieces:

1. **One archive store.** Auto-archive, manual archive, and "closing a tree branch archives
   it" (tree tabs) all need the same thing: a durable, searchable list of "tabs that left a
   space, with enough state to recreate them." `SessionStore.sys.mjs` already keeps this as
   `_closedTabs` per window/space (`SessionStore.getClosedTabDataForWindow`,
   engine/browser/components/sessionstore/SessionStore.sys.mjs:4573 area) and Zen tags each
   closed-tab entry with the space it came from already (closed tabs restore into their own
   space, part of "already exists"). Don't build a second store: `WhimsyArchive.sys.mjs`
   should be a *view* over SessionStore's closed-tab/closed-tab-group list, adding only what
   SessionStore doesn't: a reason (`"idle"` vs `"closed"` vs `"tree"`), a timestamp bucket for
   grouping by day, and the search index. Persist nothing SessionStore already persists.
2. **One undo stack.** Undo-for-tab-actions and "closing a tree branch archives it" both want
   Cmd+Z to reverse the last thing. `WhimsyUndo.sys.mjs`: a small ring buffer of
   `{ type, redo(), undo() }` entries pushed by every other Whimsy tab feature (archive,
   snooze, tree-close, pin/unpin, move-to-space), consumed by one Cmd+Z handler. Firefox's own
   `cmd_undo`/`cmd_redo` are text-field editor commands (`goDoCommand`); Whimsy's stack must
   only engage when focus isn't in an editable field, and must come *before* the editor
   commands get the key (check `document.activeElement` editability first, matching how Zen's
   own shortcut dispatch already guards text fields in src/zen/common).

Build order: `WhimsyArchive` → auto-archive (reads it) → archive view UI (reads it) →
`WhimsyUndo` → undo for tab actions, tree tabs' "close archives the branch" (both push to it) →
snooze (independent, reads nothing above but should also push an undo entry) → fire button
(independent) → heavy tabs (fully independent, no shared code).

---

## 1. Auto-archive idle tabs
Queue: `[tabs|new|M]` "Auto-archive idle tabs" (no note). Atlas: 241 votes ("auto-close after
time"), Arc/SigmaOS inspiration.
- (a) Zen has tab unloading (`zen.tabs.unload`-style memory unload, keeps the tab in the
  strip) but nothing that *closes* an idle tab. No existing pref family for this.
- (b) No open issue/discussion found by search.
- (c) Arc archives unpinned tabs after 12 hours of disuse (adjustable); people love that the
  space always looks the way they left it without manual cleanup, and nothing is truly lost
  since the archive is one click away. SigmaOS copies the same model.
- (d) `WhimsyArchive.archiveIdleTabs()`, a `setInterval`-driven sweep (every 5 min is plenty)
  over `gBrowser.tabs` per window: skip pinned, Essentials, `tab.soundPlaying`/`tab.pictureinpicture`,
  tabs in a split, and the selected tab; for everything else compare
  `tab.lastAccessed`/`gBrowser.selectedTabs` history against
  `whimsy.archive.idle-after` (choices 12h/24h/7d/30d/Never, default 12h per the user's bedtime
  answer) and call `gBrowser.removeTab(tab, { ...closeReason: "whimsy-archive" })`, tagging the
  resulting SessionStore closed-tab entry (`closedBy` custom field) so the archive view can show
  "auto-archived" vs "closed". Toggle `whimsy.feature.auto-archive-tabs` (default on).
  Test: tab idle 13h with the 12h setting closes; a muted-but-playing tab, a pinned tab, and an
  Essential never close; a tab with the pref "Never" never closes; many tabs (500) sweep
  without jank (time the sweep, assert < 50ms).

## 2. Archive view with restore
Queue: `[tabs|partial|S]` "Archive view with restore" (no note). Atlas: "Arc's archive is part
of why auto-archive feels safe."
- (a) The data already exists (SessionStore closed tabs/closed tab groups, per window and, via
  Zen's own closed-tab-to-space behavior, taggable per space). There's no viewer UI; Zen's
  "Tab graveyard" idea (skipped in the queue) is a different, X-days-later-permanent-delete
  concept, not this.
- (b) Issue #13822 "Undo tab close with multiple tabs restores incorrect order" confirms
  `undoCloseTab`/multi-tab close ordering is an existing, slightly buggy surface this view will
  sit on top of — worth a regression test here too.
- (c) Arc's Archive is a searchable, by-day list of everything that left a space (closed or
  auto-archived), with one click putting a tab back where it was. The flow: Cmd+Shift+T-style
  muscle memory doesn't scale past one tab, so people open the archive, scan by day, and click
  to restore instead of hunting History.
  (d) A sidebar/library panel (reuse the Library's panel chrome, src/zen/library/ZenLibrary.mjs)
  backed entirely by `WhimsyArchive`: group `SessionStore.getClosedTabDataForWindow`/
  `SSWindowState closedTabs` entries by day, a search box filtering by title/URL, and a restore
  button calling `SessionStore.undoCloseTab(window, index, targetWindow)` (same API the existing
  Cmd+Shift+T uses) with the *target* space forced to the tab's original space. Push an undo
  entry on every auto-archive sweep so Cmd+Z right after a sweep un-archives the whole batch.
  Test: archive view lists an auto-archived and a manually-closed tab under today; restoring one
  lands it back in its original space, selected; empty state when nothing's archived; searching
  filters by partial title.

## 3. Undo for tab actions
Queue: `[tabs|new|M]` "Undo for tab actions" — NOTE (user): "I thought it already existed."
Atlas: Arc inspiration, 0 votes recorded (new ask).
- (a) **Partially exists, and this is the surprise behind the user's note.** Reopening a single
  closed tab already works: `History:UndoCloseTab` (engine/browser/base/content/browser-sets.inc.xhtml:115)
  is bound to Cmd+Shift+T and calls `SessionStore.undoCloseTab`
  (engine/browser/components/sessionstore/SessionStore.sys.mjs:4573). What does **not** exist is
  a *general* undo: moving a tab to another space, pinning/unpinning, clearing a folder, or
  reordering has no undo at all, and there's no Cmd+Z binding for tabs (Cmd+Z is the plain text
  `cmd_undo` editor command everywhere else).
- (b) No open issue/discussion.
- (c) Arc's Cmd+Z undoes the last tab-level action generically — close, move, clear — stacking
  shallowly (a handful of steps), not just "last closed tab." Users rely on it as a universal
  safety net rather than remembering Cmd+Shift+T is tab-close-only.
- (d) This is `WhimsyUndo` from the shared model above. Scope for tonight: push entries for
  close (wrap `gBrowser.removeTab`/`removeTabs`), move-to-space (wrap `ZenWorkspaces` move),
  pin/unpin, and clear-folder. Cmd+Z pops the stack and calls `.undo()`; Cmd+Shift+Z (or
  Cmd+Y) redoes. Falls through to `cmd_undo` when focus is in an editable field or the stack is
  empty.
  Test: close a tab, Cmd+Z restores it selected in place; move a tab to another space, Cmd+Z
  returns it; Cmd+Z in an open compose box or the URL bar edits text, not tabs; an empty stack
  leaves Cmd+Z as plain editor undo; redo re-applies.

## 4. Snooze a tab
Queue: `[tabs|new|M]` "Snooze a tab" (no note).
- (a) Nothing exists. Closest primitive: Zen's own tab unload (keeps the tab visible, just
  unloaded) — snooze needs the tab to *disappear* and reappear later, which is closer to
  archive-with-a-timer than unload.
- (b) No open issue/discussion.
- (c) SigmaOS and Edge Workspaces: pick "later today / tomorrow / next week / custom," the tab
  vanishes from the strip, and reappears (usually with a notification) at that time, still in
  its original space. People use it to clear visual clutter without losing the tab's state the
  way a bookmark would (session, scroll position, form data all come back).
- (d) Context-menu "Snooze…" opens a small date/preset popover; on confirm, close the tab via
  the same path as auto-archive (so it lands in `WhimsyArchive`'s store, tagged `reason:
  "snooze"` with a `wakeAt` timestamp) and push an undo entry. A `setTimeout`/`DeferredTask`
  per snoozed tab (rehydrated from a `whimsy.snoozed-tabs` JSONFile on startup, Zen-style
  storage like `ZenSpaceRoutingManager`'s own JSONFile) calls `SessionStore.undoCloseTab` when
  `wakeAt` passes, restoring into the original space, and shows a toast/notification badge.
  Test: snooze "in 1 minute," tab closes immediately and reopens ~60s later in the same space;
  snoozed tabs survive a restart (persisted); canceling a snooze from the archive view removes
  the pending timer.

## 5. Tree-style tabs with Islands mode
Queue: `[tabs|new|L]` "Tree-style tabs" — NOTE (user): "Make this optional with a toggle in
settings. Be thorough about the user experience we envision." Also `[tabs|new|M]` "Tab
islands" — NOTE: "I think this needs to be combined with the tab trees, if they are similar."
BUILD-PLAN answer: off by default, Tree and Islands styles, max depth 4, closing a parent
archives its whole branch (restorable from Archive). Atlas: Waterfox 6.7 ships native tree
tabs (96 votes "tree structure"); Opera Tab Islands is the "combine" source (402 in atlas).
- (a) **The nesting primitive already exists and isn't tab-specific.** Zen's folders
  (`ZenFolder.mjs`) are Firefox's native tab groups (`MozTabbrowserTabGroup`) under the hood,
  and a folder's `.group` getter already walks a parent chain
  (`while (currentGroup?.group) currentGroup = currentGroup?.group;`, src/zen/folders/ZenFolder.mjs:120),
  i.e. groups can already nest inside groups. There's no auto-nest-on-open-from-link today
  (Firefox does track `tab.openerTab` for other purposes, e.g. "close tab returns to opener"),
  and no "Islands" (single-level, colored, Opera-style) rendering — just the folder/group
  primitive to nest on.
- (b) No open issue/discussion about tree tabs or islands specifically for Zen.
- (c) Waterfox 6.7's native tree tabs and Sidebery nest a tab under whichever tab opened it,
  indented, collapsible per branch, any depth; people use it to keep a research thread (a
  search result and the five tabs it spawned) visually together and collapsible as a unit.
  Opera's Tab Islands is the same idea flattened to one visible level with a colored pill,
  favored by people who find deep indentation noisy.
- (d) Two rendering modes over one data model, so "combine them" (the user's instinct) is
  correct: a tab's parent is `tab.openerTab` captured at creation; `WhimsyTreeTabs` builds the
  tree from that chain (max depth 4 per the build-plan answer — beyond that, flatten into the
  depth-4 ancestor) and reuses `ZenFolder`'s existing nesting/collapse for the "Tree" style
  (indented, collapsible per branch). "Islands" style collapses the same tree to depth 1 with
  an Opera-style colored pill per root, reusing `WhimsyFolderColors`. Off by default
  (`whimsy.feature.tree-tabs`), with a settings radio for Tree vs Islands. Closing a tab with
  children: per the build-plan, archive the whole branch (push every descendant into
  `WhimsyArchive` with a `reason: "tree"` group id so the archive view can restore the branch
  together) rather than silently reparenting orphaned children to the grandparent — reparenting
  is the Waterfox default and worth a settings note either way, but archiving-as-a-unit is what
  the user specified.
  Edge cases: a tab whose opener was closed/doesn't exist (orphan) renders at depth 0; dragging
  a child tab out of its tree detaches it (parent cleared); a tab opened from the command bar
  or a bookmark has no opener and is always depth 0; max depth 4 means a 5th-generation tab
  attaches visually to its depth-4 ancestor but keeps its real opener recorded, so restoring
  from the archive reconstructs the true chain.
  Test: open 3 links from one tab, tree shows 1 parent + 3 children, collapsible as one;
  closing the parent archives all 4 as one group, restorable together; 5 generations deep caps
  visual indent at 4; Islands mode shows the same data as one colored pill per root; toggle off
  returns to a flat strip with no data loss (tree relationships just stop being drawn).

## 6. Fire button
Queue: `[privacy|new|M]` "Fire button" (no note). Atlas: DuckDuckGo inspiration.
- (a) The actual data-clearing primitive already exists and is well-tested: `ForgetAboutSite`
  (engine/toolkit/components/forgetaboutsite/ForgetAboutSite.sys.mjs) clears cookies, cache,
  storage, history and permissions for a base domain in one call. Firefox also has
  `Services.clearData` (`ClearDataService`) for broader/"everything" clears. Neither is wired
  to a one-click button or has a "this space" / "last 15 min" scope.
- (b) No open issue/discussion.
- (c) DuckDuckGo's fire button: one tap burns the current tab's session (or everything), with
  a literal flame animation, closing every tab in scope. People trust it as a visible, fast
  "nothing here happened" gesture rather than hunting through Clear Recent History's dialog.
- (d) Per the build-plan answer: a toolbar/command-bar fire icon opens a popover with four
  scopes — **This site** (`ForgetAboutSite.remove(baseDomain)`), **Last 15 min**
  (`Services.clearData.deleteDataFromTimeRange` with `Date.now() - 15*60*1000`), **This space**
  (iterate the space's origins via its container's cookie jar, `ForgetAboutSite` per origin, or
  `Services.clearData.deleteDataFromOriginAttributesPattern({ userContextId })` for the whole
  container at once), **Everything** (`Services.clearData.deleteData(Ci.nsIClearDataService.CLEAR_ALL)`).
  Close the affected tabs after clearing (pinned tabs and Essentials survive, per the build-plan
  answer — exclude them from the close step, not from the data clear, since the user may still
  want a pinned Gmail tab's cookies burned without losing the tab). Play a short flame/burst
  animation (reduced-motion: an instant flash/checkmark instead) and push one undo entry that
  reopens the closed tabs (data is gone either way — undo is for the tab closures, not a data
  rollback, and that limit should show in the confirmation copy).
  Test: "This site" on a logged-in test page clears its cookie and reloads logged out; "Last 15
  min" doesn't touch data older than that window (seed two timestamps); "This space" clears only
  that container's origins, leaving other spaces' cookies intact; pinned/Essential tabs stay
  open after any scope; reduced motion skips the flame.

## 7. Find heavy tabs
Queue: `[perf|new|M]` "Find heavy tabs" (no note). Atlas: Opera GX Hot Tabs Killer inspiration;
Zen issue #8932 "[META]: Performance, consumption and memory leaks" is open and broad (not
heavy-tabs-specific, but the pain point this feature answers).
- (a) The data source already exists at the platform level: `ChromeUtils.requestProcInfo()`
  (used today in engine/toolkit/modules/Troubleshoot.sys.mjs:397) returns per-process CPU and
  memory, and each process's `windows` array maps back to tabs/browsers. There's no per-tab
  CPU attribution UI anywhere in Zen (`about:processes` exists upstream but Zen doesn't surface
  it), and no "close the worst offenders" action.
- (b) Issue #8932 is the open meta-bug people pile performance complaints into; no issue asks
  for this feature by name.
- (c) Opera GX's Hot Tabs Killer: a one-click list of the tabs using the most RAM/CPU with a
  close button next to each. Used reactively, the moment the browser feels sluggish, as a
  faster alternative to hunting through Activity Monitor/Task Manager for the browser's own
  tab-to-process mapping.
- (d) A command-bar action / toolbar popover `WhimsyHeavyTabs`: call
  `ChromeUtils.requestProcInfo()` periodically (poll only while the popover is open, not
  continuously), map each process's tab windows back to `gBrowser.tabs` via their
  `outerWindowID`/`browsingContextID`, sort by memory (CPU needs the delta between two samples a
  few seconds apart, since `requestProcInfo` reports cumulative CPU time), and list the top N
  with a close button and their space/title. Note the attribution gap up front: Fission means a
  tab's content process can be shared with other tabs on the same site (process-per-site-group),
  so "this tab's memory" is sometimes "this group of same-site tabs' memory" — show the tied
  tabs together rather than claiming false precision.
  Test: a page that aggressively allocates (a test page with a large retained array) shows up
  near the top after the poll interval; closing it from the list removes it and its process
  entry disappears/shrinks on the next sample; tabs sharing a content process are grouped, not
  double-counted.

---

## Native-code flags
None of batch 8 needs new native/C++ code. `ChromeUtils.requestProcInfo`, `ForgetAboutSite`,
`Services.clearData`, and `SessionStore` are all already-scriptable XPCOM/JS APIs; the tree-tab
and archive work is pure front-end JS/CSS over existing `tab.openerTab`/`ZenFolder`/SessionStore
primitives.
