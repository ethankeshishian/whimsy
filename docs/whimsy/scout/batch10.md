# Scout batch 10: sidebar panels (notes, screenshot to sidebar, Finder folders, next meeting)

Read-only research, 2026-10-29. Paths relative to ~/Repos/whimsy. "Overlay" = new code in
src/zen/whimsy/ (+ prefs/whimsy/whimsy.yaml, whimsy-settings.js), no Zen edits. gh search
issues --repo zen-browser/desktop found nothing on-topic for any item below (only unrelated
bugs surfaced); noted where relevant.

## Shared framework: Zen's Library already has a section-plugin system — use it

Checked `src/zen/library/ZenLibrary.mjs`: the Library panel (the toolbar-button popout, not
the always-on sidebar strip) is built around `this.zenLibrarySections`, a plain object keyed by
tab id → Section class (history, downloads, boosts, media, spaces, space-routing — each its own
file in `src/zen/library/sections/`). Every Section is a small, consistent shape: a static
`id`, an optional static `tabMenu`, and lifecycle hooks the Library calls directly
(`onLibraryOpening`, `onLibraryOpened`, `onLibraryClosing` — see the `#tellSection` calls in
ZenLibrary.mjs around :576 and :874). This is a ready-made plugin point for exactly these four
features; building one more `WhimsyLibrarySection` base class and shipping each feature as a
section is less code than four bespoke panels, and it matches the surface the user already
associates with "the sidebar" (the Library button sits in the sidebar's toolbar).

`this.zenLibrarySections` is assigned per-instance inside the constructor, not exposed as a
getter, so Whimsy can't just monkey-patch a getter the way `WhimsyGithubReviews` wraps
`options`. The clean hook: `Object.defineProperty(ZenLibrary.prototype, "zenLibrarySections",
{ get() { return { ...this._whimsySections, ...extraSections }; }, set(v) { this._whimsySections
= v; } })`, installed once at startup before any `<zen-library>` element is constructed
(Whimsy's `init()` running before the custom element is first upgraded — verify via
`customElements.get("zen-library")` being undefined at Whimsy init time, or hook
`customElements.whenDefined`). Each of the four features below becomes one
`WhimsyLibrarySection` subclass registered this way; `extraSections` gated per-feature pref so
disabling one feature removes exactly its tab.

Build order: the shared `WhimsyLibrarySection` base + the `zenLibrarySections` hook first (one
small file), then Finder folders and Notes (both lean entirely on existing storage/native
pieces, least new code), then Screenshot-to-sidebar (needs the capture plumbing from
docs/whimsy/scout/batch5.md #6), then Next meeting last (the only one needing new native code).

---

## 1. Notes
Queue: `[page|new|M]` "Notes" (no note). Atlas: 15 votes, Arc/Vivaldi inspiration, "Markdown
notes in the sidebar, pinnable like tabs, optionally attached to a page."
- (a) No standalone notes feature exists, but **page-attached note storage already does, and
  it's reusable wholesale**: `engine/browser/components/tabnotes/TabNotes.sys.mjs` is a
  Firefox 149 feature (`TabNotesStorage`, exported as the singleton `TabNotes`, :393) — a
  SQLite-backed store keyed by canonical URL with `get(tab)`, `set(tab, note, options)`,
  `delete(tab)`, `has(tab)`, `count()`. It's wired to a hover-triggered UI
  (`tabnote-menu.js`, `tabnotes.manifest`) that is explicitly in the atlas's Skip list ("Tab
  notes" — the per-tab-hover UI is not something tonight builds). The *storage* underneath it
  is exactly what "optionally attached to a page" needs, so reuse `TabNotes.set/get` for that
  half of the feature instead of inventing a second URL-keyed note table.
- (b) No open issue/discussion.
- (c) Arc's Notes and Vivaldi's Notes panel: a lightweight markdown scratchpad that lives in
  the sidebar, can be pinned like a tab (so a running checklist or meeting notes stays one
  click away across tab switches), and can optionally anchor to the current page instead of
  floating free. People use it for the stuff too small for a real document — a pasted address,
  a running todo list for the browsing session.
- (d) `WhimsyNotesSection` (a `WhimsyLibrarySection`): a list of free-floating notes (Whimsy's
  own JSONFile store, markdown text + title + timestamp, following the `JSONFile` pattern
  `ZenSpaceRoutingManager` already uses) plus, per the atlas's "optionally attached to a page,"
  a toggle per note that backs it with `TabNotes.set(currentTab, text)` instead, so it travels
  with that URL via the existing Firefox 149 storage rather than Whimsy's own. "Pinnable like a
  tab": render a pinned note as a lightweight tab-strip entry pointing at
  `about:whimsy-notes#<id>` (a thin about: page rendering the note's markdown, editable inline)
  — reuses the tab strip's existing pin mechanics rather than building a parallel "pinned
  sidebar items" concept.
  Edge cases: a page-attached note on a URL visited in two different spaces — `TabNotes` keys
  by canonical URL, not space, so the same note shows in both (document this, it's a feature of
  reusing that storage, not a bug); deleting a pinned note's tab should delete the underlying
  note only on an explicit "delete note" action, not on ordinary tab close (closing ≠ deleting,
  same as any pinned tab).
  Test: a free note persists across restart; a page-attached note set on example.com shows when
  revisiting example.com, empty on example.org; pinning a note adds a tab strip entry rendering
  its markdown; unpinning removes the tab but keeps the note in the list.

## 2. Screenshot to sidebar
Queue: `[files|new|M]` "Screenshot to sidebar" (no note). Atlas: Arc inspiration, "Captures
land in the sidebar as files you can drag anywhere."
- (a) Builds directly on batch5 #6 (docs/whimsy/scout/batch5.md): Firefox Screenshots
  (`ScreenshotsUtils.sys.mjs`) already has `fetchFullPageBounds`, `createCanvas`, and a
  copy-to-clipboard path; batch5 proposed adding a "copy full-page screenshot" command on top.
  Nothing today lands a capture anywhere persistent — it's clipboard-only.
- (b) No open issue/discussion.
- (c) Arc's capture flow (Cmd+Shift+2) offers Copy, Save, or send-to-an-Easel; the sidebar
  landing spot is the "Easel" analogue minus the canvas — captures pile up as draggable image
  files you can drop into a doc, Slack, or a folder later, instead of only ever existing on the
  clipboard until overwritten by the next copy.
- (d) `WhimsyFilesSection` (a `WhimsyLibrarySection`, could share one tab with Finder folders
  below, or its own — decide based on how crowded the rail gets): after any capture (region,
  element, full-page — reuse batch5's calls), in addition to copying to the clipboard, write a
  PNG into `whimsy.captures.folder` default profile subdir `whimsy-captures/` via `IOUtils.write`
  and add an entry to this section's list (thumbnail, click-to-open, drag-out using the same
  `FILE_MIME`/drag source pattern `ZenLibraryMediaPreview.mjs` already uses for other files,
  :487-495 area, `new FileUtils.File(path).launch()`/`.reveal()` for "open"/"show in Finder").
  Test: capturing a region adds a thumbnail to the section within one capture cycle; dragging
  it onto a text field (or a test `<input type="file">`) delivers the PNG; "reveal in Finder"
  opens the containing folder.

## 3. Finder folders in the sidebar
Queue: `[files|new|M]` "Finder folders in the sidebar" (no note). Atlas: Arc inspiration.
- (a) **The expensive half already exists as native code.** `src/zen/library/nsIZenLibraryFiles.idl`
  + `nsZenLibraryFiles.cpp` is a scriptable XPCOM service (`@mozilla.org/zen/library-files;1`)
  that walks folders off the main thread (`scanMedia(roots, extensions, maxDepth, maxFolders,
  maxItems, callback)`) and already flags cloud placeholders (OneDrive-style stub files) so a
  thumbnail pass doesn't force a cloud download. It's currently used for the Library's own media
  scanning. Opening/revealing a file already works too: `ZenLibraryMediaPreview.mjs:487,495`
  call `FileUtils.File(path).launch()`/`.reveal()` (open with the OS default app / show in
  Finder) — both standard `nsIFile` methods, not new.
  What's missing: a "pin this folder" UI (pick a folder via a native picker,
  `nsIFilePicker.MODE_GETFOLDER`), live refresh (no `FileSystemWatcher`/`nsIDirectoryEnumerator`
  change-notification API turned up anywhere in the engine tree — refresh has to be a poll), and
  a sidebar list rendering (not just the Library's media-grid view, which assumes
  thumbnailable media).
- (b) Issue #15913 "Downloaded files are not flagged as missing in new Library view after
  being deleted/moved via File Manager" confirms the existing Library view already has a
  stale-state gap worth not repeating here — poll on an interval and on panel-open, don't trust
  a scan done once at pin time.
- (c) Arc lets you pin a Finder folder into the sidebar and browse its contents without
  leaving the browser — handy for a folder of reference PDFs or a project's assets you drag
  into web forms constantly.
- (d) `WhimsyFinderFoldersSection`: "Add folder" opens `nsIFilePicker` in folder mode, stores
  the path (`whimsy.finder-folders` pref/JSONFile list). Listing calls
  `Cc["@mozilla.org/zen/library-files;1"]`'s `scanMedia` with no extension filter (pass `[]` for
  "all files" if the API supports it; otherwise call `nsIFile.directoryEntries` directly for the
  flat, non-media case, since `scanMedia`'s depth/extension design is really built for the media
  grid) for the top-level listing, with a small folder icon per nsIFile.isDirectory() entry and
  click-to-expand. Poll every N seconds while the section is visible (`onLibraryOpened`/
  `onLibraryClosing` hooks gate the poll so it doesn't run in the background) comparing a
  directory listing's mtimes, rather than any attempt at a live watcher. "Open" and "reveal"
  reuse the existing `.launch()`/`.reveal()` calls.
  Test: pinning a folder with 3 files lists all 3 with correct icons; adding a file to the
  watched folder on disk shows up after the next poll (fake the clock or shrink the poll
  interval in the test); a cloud-placeholder file shows a distinct icon and doesn't trigger a
  download when listed (assert no network/provider call happens from the listing alone).

## 4. Next meeting in the sidebar
Queue: `[quick|new|M]` "Next meeting in the sidebar" (no note). Atlas: 9 votes, Arc + Dia "Tab
Groups for Meetings" inspiration. BUILD-PLAN answer (wins): support both macOS Calendar
(EventKit, all its accounts) and direct Google Calendar sign-in, multiple accounts of each;
build macOS Calendar first, Google is a morning item (needs an OAuth client ID the user hasn't
created yet).
- (a) **Nothing exists, and this is the one genuinely native-code item in this batch.**
  Checked for any existing calendar/EventKit bridge in the engine (none) and for the pattern
  Whimsy already uses to reach native macOS APIs without a Zen edit: `WhimsyAppIcon.sys.mjs`
  calls the already-shipped XPCOM service `nsIMacDockSupport`
  (`Cc["@mozilla.org/widget/macdocksupport;1"]`) directly from JS — that works because Gecko
  already wraps Dock support in C++. **There is no equivalent `nsICalendar`-style service for
  EventKit anywhere in this tree** (unlike Finder-folder scanning, which had
  `nsIZenLibraryFiles` ready-made, or the menu bar, which has `nsISystemStatusBar` ready-made —
  see batch13's menu-bar item). EventKit (`EKEventStore`, event/calendar access, the macOS
  permission prompt) is Objective-C/Swift API with no Gecko binding today.
- (b) No open issue/discussion.
- (c) Arc's meeting chip and Dia's "Tab Groups for Meetings" both surface the next event with a
  one-click join, floating the call window once joined so it stays visible while you browse —
  people use it to avoid tab-switching to a calendar app just to grab a Zoom link five minutes
  before a call.
- (d) This needs a small new native component, following the `nsZenLibraryFiles` precedent
  (a Whimsy-owned C++/Obj-C XPCOM class, scriptable, `MAIN_PROCESS_ONLY`): a
  `nsIWhimsyCalendar` interface wrapping `EKEventStore` — request access
  (`requestFullAccessToEvents`, triggers the macOS permission prompt and needs
  `NSCalendarsUsageDescription` added to the app bundle's Info.plist, which is a packaging
  change in `whimsy/` tooling, not a Zen file), enumerate configured calendar sources/accounts,
  and return the next N upcoming events with title/start/end/URL (EventKit exposes a
  conference/meeting URL on some events; otherwise regex a Zoom/Meet/Teams link out of the
  event's notes field, same heuristic Arc and Dia both need). JS side: `WhimsyNextMeetingSection`
  polls this service (events don't need push — a 60s poll is plenty) and renders the soonest
  upcoming event with a join button that opens its URL (into Little Arc per batch12, or the
  active tab). Google Calendar: defer per the build-plan (no OAuth client id yet); when it
  exists, add it as a second source merged into the same "next meeting" list rather than a
  separate UI.
  Test (native code can't be exercised by a mochitest the way JS can — note this as a gap):
  mock `nsIWhimsyCalendar` behind a test-only pref-swappable implementation (mirroring how
  `OSKeyStoreTestUtils` fakes `OSKeyStore` for tests, engine/toolkit/modules/tests/modules/
  OSKeyStoreTestUtils.sys.mjs) so the JS-side polling/rendering/join-button logic has a
  mochitest, while the actual EventKit glue needs manual verification on a real Mac with a
  populated Calendar (call out explicitly in the commit/PR that this one path lacks automated
  coverage).

---

## Native-code flags
Only item 4 (**Next meeting**) needs new native code: an EventKit-wrapping XPCOM component,
Info.plist entitlement addition, and a real permission-prompt flow that can't be headlessly
tested. Items 1–3 are pure JS/front-end over already-existing primitives (`TabNotes`,
batch5's screenshot utilities, `nsIZenLibraryFiles`, `nsIFile.launch/reveal`).
