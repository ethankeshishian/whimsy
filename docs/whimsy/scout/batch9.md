# Scout batch 9: spaces (Scratch, manager, archive/hide, lock, space-aware history, ATC)

Read-only research, 2026-10-29. Paths relative to ~/Repos/whimsy. "Overlay" = new code in
src/zen/whimsy/ (+ prefs/whimsy/whimsy.yaml, whimsy-settings.js), no Zen edits. gh search
issues --repo zen-browser/desktop found nothing on-topic for any item below (results were
unrelated bugs); cited only where a hit was relevant.

## Biggest finding first: Air Traffic Control already exists

Per BUILD-PLAN's own doubt ("Sidebery panels => Arc's Air Traffic Control parity... Verify
what Zen has first (user thinks it may exist)") — **it exists, nearly complete.**
`src/zen/space-routing/ZenSpaceRoutingManager.sys.mjs` is a full per-rule router: rules have a
`reference` string, a `matchType` (contains/etc., `isRouteMatching()` at :478), and an
`openIn` target space. `onBeforeAddTab`/`routeUri()` route **new tabs**, and
`pickWindowForExternalURI`-style logic (:287) routes **external links** (`fromExternal: true`)
to the matching space's window before the tab is even created — this is Arc's Air Traffic
Control. There's already a tab-context-menu entry ("Add domain to routing", added after
`context_undoCloseTab`) and a rules list surfaced in the Library. State persists in
`zen-space-routing.jsonlz4` via `JSONFile`, the same pattern Whimsy should reuse elsewhere.
What's missing against Arc parity: it's framed as "space routing," not labeled or discoverable
as Air Traffic Control, has no dedicated rules-management settings page (only the Library's
view + one context-menu add action), and doesn't obviously fire for links clicked *inside*
other spaces (worth verifying — `onBeforeAddTab` looks space-agnostic, i.e. should already
catch that case). **Action for tonight: expose/rename only.** Add a Settings → Spaces section
that surfaces the existing rules list with Arc-style language ("Air Traffic Control: send
links to a space automatically"), and verify in a test that a rule set from one space catches
a link opened while browsing a *different* space, not just external links. No new routing
logic needed.

---

## 1. Scratch (temporary private space) + private tabs in a space
Queue: `[spaces|new|M]` "Temporary containers" — NOTE: "Yes call it scratch." / `[privacy|new|M]`
"Private tab in a normal window" — NOTE: "I love this idea... We talked about a scratch area.
Maybe that's cmd n. Cmd shift n could be a private space. Another shortcut could be a private
tab." BUILD-PLAN answers (which win): Cmd+Shift+N = Scratch, a temporary private **space**
added to the right of all spaces, convertible to a real space, all data gone on close,
replacing the private window entirely; Cmd+Opt+T = a private tab inside the *current* space,
Waterfox-style; Little Arc keeps Cmd+Opt+N.
- (a) **The hard constraint: Firefox's private browsing flag is per-window, not per-tab.**
  `nsILoadContext.usePrivateBrowsing` is set when the chrome window (and its initial docshell)
  is created and inherited by every docshell under it; there is no `privateBrowsingId` argument
  on `gBrowser.addTab`/`addTrustedTab`, and no code path in
  engine/browser/components/tabbrowser/content/tabbrowser.js sets it per-tab. So a *true*
  Waterfox-style private tab (separate `OriginAttributes.privateBrowsingId`, separate cookie
  jar, separate process from the rest of the window, Firefox's private-mode ETP strictness)
  does not exist as a drop-in call — Waterfox had to patch Gecko for this, confirming it's a
  real gap, not an oversight. What Whimsy *can* do without touching Zen/engine code: give the
  tab a disposable `ContextualIdentityService` container (a fresh, hidden-from-UI identity per
  private tab, deleted when it closes) for cookie/storage isolation, force
  `privacy.resistFingerprinting`-adjacent strict settings and `network.cookie.cookieBehavior`
  total-cookie-protection (already Firefox's default) on that container, and wipe its
  Places/download history on close via `ForgetAboutSite`-equivalent clearing scoped to that
  `userContextId`. This is a strong approximation, not bit-for-bit PBM — flag the gap (no
  automatic "Private Browsing" ETP strictness bump, no distinct process) in the feature's
  settings copy rather than claim full parity.
- (a cont'd) Scratch-as-a-space has no such constraint: it's a `ZenWorkspace`
  (`src/zen/spaces/ZenSpaceManager.mjs`) like any other, just one Whimsy creates and tears down
  automatically, with its own container for isolation (spaces are already containers —
  `zen.workspaces.separate-essentials` and the "Essentials per container" item in the
  "already exists" list confirm each space already maps to a `userContextId`). Deleting it on
  close reuses `removeWorkspace(windowID)` (:1477) which already deletes the workspace's owned
  tabs (`#deleteWorkspaceOwnedTabs`, :1719).
- (b) No open issue/discussion (private tabs inside normal windows, specifically).
- (c) Arc's private windows are todays' baseline; the *model change* here (per the build-plan)
  is Waterfox 6.7's private-tabs-inside-a-window, which the user explicitly prefers over a
  separate private window because it keeps one window, one taskbar/Mission Control entry, and
  lets you glance at a private tab next to normal ones instead of alt-tabbing to a whole
  different window.
- (d) **Scratch**: Cmd+Shift+N calls `ZenSpaceManager.createWorkspace({ ephemeral: true })` (a
  new flag), inserted after the last space in the strip, visually marked (dashed border /
  distinct icon treatment, reusing `ZenSpaceIcons.mjs`). "Convert to a real space" just clears
  the `ephemeral` flag. Closing it (last tab closed, or an explicit "Close Scratch") calls
  `removeWorkspace` — no confirmation dialog needed since the whole point is it's meant to
  vanish, but "send this tab out" (drag to another space icon — already-exists per BUILD-PLAN)
  should keep that tab alive post-close.
  **Private tab**: Cmd+Opt+T (verify free — it isn't in
  engine/browser/base/content/browser-sets.inc.xhtml's existing bindings or Zen's own kbs) opens
  a tab in the current space tagged with a disposable container per the (a) note, visually
  marked (Waterfox uses a purple-tinted tab; reuse Whimsy's folder-color CSS variables for a
  consistent treatment), and torn down via `ContextualIdentityService.remove(id)` plus a data
  clear on tab close.
  Edge cases: closing the last normal tab in a space while private tabs remain open in it must
  not close the space (private tabs don't count toward "keep window open" tab-count logic);
  dragging a private tab to another space should either carry its disposable container along or
  refuse the drag (simpler: refuse, with a toast, since the container is scoped to one space's
  lifetime conceptually) — decide and document whichever is picked; Scratch created while
  already in Scratch should be disallowed (no nested Scratch).
  Test: Cmd+Shift+N creates a space to the right of all others, marked as Scratch; closing it
  deletes its tabs and workspace; "convert to real space" removes the marker and the space
  survives being emptied; Cmd+Opt+T's tab has its own cookie jar (set a cookie in it, confirm a
  normal tab on the same origin doesn't see it) and the container is gone after the tab closes
  (`ContextualIdentityService.getPublicIdentities()` no longer lists it).

## 2. Space manager
Queue: `[spaces|new|M]` "Space manager" (no note). Atlas: 12 votes, Arc inspiration.
- (a) No single "manage every space" view exists. The pieces are scattered: `ZenSpaceManager.mjs`
  has `reorderWorkspace` (:1608, confirmed "already exists" per build-plan), rename (inline,
  via the space strip), icon picking (`ZenSpaceIcons.mjs`), and delete (`removeWorkspace`,
  :1477, which is destructive — no archive). There's no one screen listing every space with
  batch actions.
- (b) No open issue/discussion.
- (c) Arc's space manager (accessed from the sidebar's space list) is a single list: drag to
  reorder, click to rename, a color/icon swatch per row, and a delete affordance, all without
  switching into each space first. People use it when they've accumulated 10+ spaces and
  reordering/cleaning up one at a time in the strip is fiddly (the strip only shows a handful
  at once).
- (d) A new panel (Settings → Spaces, or a dedicated popover from the space-switcher's "manage"
  entry) listing every `ZenWorkspace` as a row: drag-reorder calling the existing
  `reorderWorkspace`, inline rename, icon/color edit reusing `ZenSpaceIcons`/`ZenGradientGenerator`,
  and — once item 3 below exists — archive/hide toggles per row. This is thin glue over
  existing `ZenSpaceManager` APIs, not new space logic.
  Test: reordering two rows updates the space strip's order; renaming from the panel updates
  the strip's label live; deleting from the panel still prompts the existing confirmation
  (`zen-workspaces-delete-workspace-title`, ZenSpaceManager.mjs:3231) rather than skipping it.

## 3. Archive or hide a space
Queue: `[spaces|new|M]` "Archive or hide a space" (no note). Atlas: 16 votes, Arc inspiration.
- (a) Does not exist. `removeWorkspace` is the only "space goes away" path and it's
  permanent/destructive (deletes owned tabs). There's no "hidden" state field on a workspace.
- (b) No open issue/discussion.
- (c) Arc's archive/shelve: a space you're not using right now moves out of the switcher
  without deleting its tabs or settings, restorable later. People use it for seasonal or
  project spaces (a "Taxes 2026" space) they don't want cluttering the switcher year-round but
  also don't want to lose.
- (d) Add a `hidden`/`archived` boolean to the workspace's stored state (same JSONFile-backed
  object `ZenSpaceManager` already persists workspaces in) rather than deleting it. Hidden
  spaces drop out of the space strip/switcher but their tabs stay exactly as they were
  (critically, *don't* close their tabs the way `removeWorkspace` does — that's the difference
  from delete). A "Hidden spaces" row in the new space manager (item 2) or a Library section
  lists and restores them. Essentials/pinned tabs in a hidden space stay pinned, just invisible
  until restored.
  Test: archiving a space with 3 open tabs removes it from the switcher but the tabs still
  exist (check `gBrowser.tabs` count unchanged); restoring it re-adds it to the switcher at its
  original position with the same tabs selected as before.

## 4. Lock a space
Queue: `[spaces|new|M]` "Lock a space" (no note). Atlas: 11 votes, "Brave private tabs"
inspiration (likely a loose atlas tag; the real analogue is biometric-gated access, not PBM).
- (a) No per-space gating exists. But the primitive is already shipped and macOS-native:
  `OSKeyStore.sys.mjs` (engine/toolkit/modules/OSKeyStore.sys.mjs) wraps the macOS Keychain and
  its `ensureLoggedIn()` (:160) already triggers a Touch ID/password prompt today — it's what
  gates "reveal saved password" in Firefox's logins UI. This is the exact primitive "require
  Touch ID or a password" needs; no native code required.
- (b) No open issue/discussion.
- (c) The want here (per the atlas's own inspiration note and common ask across browsers) is
  simply: a space containing sensitive tabs (banking, a work project) shouldn't be visible to
  someone who picks up the laptop. Clicking the locked space prompts Touch ID/password before
  revealing its tabs.
- (d) A `locked` flag on the workspace; when set, switching to it (space-switcher click,
  Cmd+number, swipe) first calls `OSKeyStore.ensureLoggedIn(true)` and only proceeds on
  `.authenticated`. While locked and not the active space, blur/hide its thumbnail in the
  switcher (don't just rely on not-switching — a hover preview or thumbnail could leak content;
  check whatever renders space previews, e.g. the switcher's hover-preview code, is also gated).
  Auto-relock after N minutes away from the space (reuse Firefox's `ensureLoggedIn`'s own
  internal reauth timeout, or add a short Whimsy-side timer) so leaving the locked space and
  coming back shortly doesn't re-prompt but leaving it for the day does.
  Test: switching to a locked space triggers the OS prompt (use `OSKeyStoreTestUtils.sys.mjs`'s
  existing test-double pattern, engine/toolkit/modules/tests/modules/OSKeyStoreTestUtils.sys.mjs,
  to simulate success/cancel without a real Touch ID sensor); canceling the prompt leaves the
  previous space active; a hover preview of the locked space while it's not active doesn't
  render its tab titles.

## 5. Space-aware history
Queue: `[spaces|new|M]` "Space-aware history" (no note). Atlas: Arc inspiration.
- (a) **Does not exist, and the data isn't there to filter.** Checked `moz_historyvisits` (via
  PlacesUtils.sys.mjs) and the places/History code: visits carry no `userContextId`/space
  tagging at all. The only container-tagged Places-adjacent table is `moz_openpages_temp`
  (PlacesUtils.sys.mjs:3151), which is a transient "what's open right now, for urlbar
  autocomplete" cache keyed by `userContextId` + `groupId` — not persisted history, and cleared
  as tabs close. So filtering *existing* History by space isn't possible without either a
  Places schema change (against the no-edit-Zen/engine rule) or a parallel log.
- (b) No open issue/discussion.
- (c) Arc's History panel has a space filter; people use it because "where did I see that"
  is often answered by "which space was I in," especially with Essentials/work-vs-personal
  spaces that rarely overlap in sites visited.
- (d) Build a parallel, Whimsy-owned visit log: a `WhimsySpaceHistory` listener on
  `onLocationChange`/`TabSelect` records `{ url, title, timestamp, workspaceId }` to its own
  JSONFile or SQLite table (not Places), scoped and pruned the same way Places prunes (respect
  `places.history.enabled`/private browsing — never log in Scratch or a private tab, per item
  1). A History panel addition filters by space using this log, falling back to "no Whimsy
  history yet" for anything visited before the feature shipped (can't retroactively tag old
  Places visits with a space — note this gap plainly in the UI rather than guessing).
  Test: visiting a site in space A then space B logs two entries with different workspaceIds;
  filtering history by space A shows only its entry; a private-tab visit never appears in the
  log; disabling history (`places.history.enabled=false`) also stops this log.

---

## Native-code flags
None of batch 9 needs new native/C++ code. `OSKeyStore` (lock) and
`ContextualIdentityService`/`ForgetAboutSite`-style clearing (Scratch/private tab) are already
scriptable. The one real engineering gap is architectural, not native: Gecko's private-browsing
flag is per-window by design, so "private tab in a normal window" is a disposable-container
approximation, not true PBM, unless a future engine patch adds per-tab `privateBrowsingId` —
worth flagging to the user as a conscious trade-off, not a bug to fix later.
