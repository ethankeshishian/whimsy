# Scout batch 13: page & reading (split layouts, people cards, history preview, bionic, print, menu bar)

Read-only research, 2026-10-29. Paths relative to ~/Repos/whimsy. "Overlay" = new code in
src/zen/whimsy/ (+ prefs/whimsy/whimsy.yaml, whimsy-settings.js), no Zen edits. gh search
issues --repo zen-browser/desktop found nothing on-topic for any item below. Split view's
existing capabilities (Peek, Glance-into-split, swap panes, splits-survive-restart, etc.) were
already scouted in docs/whimsy/scout/batch6.md #1–12 — this batch covers only the two split
items not in that list.

## Shared piece: one hover-popup pattern for people cards and history preview

Both "People cards" and "Preview from history" are the same UI shape: hover a link/row →
after a short delay → a small popup with extra info → dismiss on mouseleave with a short grace
period so moving the mouse into the popup itself doesn't close it. Zen already has exactly this
pattern for the "already exists" folder hover-search feature: `ZenFolders.mjs`'s
`#groupInit()` wires `mouseenter` → `setTimeout(..., Services.prefs.getIntPref("zen.folders.search.hover-delay"))`
→ open `this.#popup`, and `mouseleave` → a second short `setTimeout` that checks
`this.#popup.matches(":hover")` before hiding, so hovering into the popup cancels the close
(:1222-1249). That `#popup` instance is private to `ZenFolders` and folder-specific, so it
can't be reused directly, but the *pattern* is proven in this codebase and should be copied
nearly verbatim into one shared `WhimsyHoverCard` helper (a generic `<panel>` plus the same
enter-delay/leave-grace timers) that both features below instantiate with different content
renderers, rather than two independent hover implementations.

---

## 1. More split layouts
Queue: `[split|partial|M]` "More layouts" (no note).
- (a) `ZenViewSplitter.mjs`'s `calculateLayoutTree(tabs, gridType)` (:1639) only recognizes
  three `gridType` values: `"vsep"` (two tabs, vertical divider), `"hsep"` (two tabs,
  horizontal divider), and `"grid"` (2+ tabs in an even grid — for exactly 2 tabs `"grid"`
  collapses to the same tree as `"vsep"`, :1641). There's no 3-pane asymmetric layout (one
  large pane + two stacked small ones), no custom split ratio beyond whatever the grid divides
  evenly, and `"unsplit"` is the only exit.
- (b) No open issue/discussion.
- (c) Common requests across split-capable browsers (Vivaldi's tiling, Edge's split tabs) are
  specifically the asymmetric layouts — one primary pane with the others stacked narrower — for
  "reference doc + two small chat/notes panes" workflows, not just symmetric halves/quarters.
- (d) Extend `calculateLayoutTree`'s switch with new `gridType` values —
  e.g. `"primary-left"`/`"primary-right"`/`"primary-top"`/`"primary-bottom"` for a 3-tab layout
  (one pane sized larger via the layout tree's existing split-ratio mechanism, two stacked in
  the remainder) — as Whimsy-side additions layered on top of the existing tree builder rather
  than inside it (since `ZenViewSplitter.mjs` is a Zen file): a
  `WhimsySplitLayouts.calculateLayoutTree(tabs, gridType)` that handles the new types itself and
  delegates to the original `calculateLayoutTree` for the four it doesn't know (wrapping the
  method the same way `WhimsyGithubReviews` wraps `fetchItems`). The modifier-preview UI that
  already previews `["hsep", "vsep", "grid", "unsplit"]` on hover (:2006-2013) needs the new
  types added to that list and a matching preview thumbnail/CSS class per new layout.
  Test: a 3-tab split with `"primary-left"` renders one wide left pane and two stacked right
  panes (check computed widths/heights, not just that 3 browsers exist); switching from
  `"grid"` to `"primary-left"` on an active split reflows without losing any tab; `"unsplit"`
  still works from any new layout type.

## 2. Pin or favorite a split
Queue: `[split|partial|M]` "Pin or favorite a split" (no note).
- (a) No favorite/pin flag exists on a `splitData` entry (`this._data` array in
  `ZenViewSplitter.mjs`, :1515-1533) — splits are purely per-session objects tied to the tabs
  currently in them; there's nothing that survives past "these specific tabs are closed" the
  way a pinned tab's URL survives tab close.
- (b) No open issue/discussion.
- (c) The want (not tied to one specific competitor by name in the atlas, but a natural
  extension of "splits survive restart," already partial per the queue) is a split you use
  every day — e.g. "email + calendar side by side" — reopening with one click instead of
  manually re-splitting two tabs each time.
- (d) A "favorite" action on an active split saves `{ urls: tabs.map(t => t.linkedBrowser.currentURI.spec), gridType,
  layoutTree-shape }` to a Whimsy JSONFile list (not the live `splitData`, which is ephemeral by
  design) with a name/icon. Opening a favorite from a menu/command-bar entry opens each URL as
  a fresh tab and calls the existing `splitTabs(tabs, gridType)` (:1502+) to recreate the split
  — this reconstructs rather than restores, so scroll position/form state won't come back (same
  honest limitation a pinned tab already has), which is a reasonable and worth-stating scope
  cut rather than trying to snapshot full tab state.
  Test: favoriting a 2-pane split and reopening it from the favorites list recreates both URLs
  in the same `gridType`; deleting a favorite doesn't affect a currently-open split that was
  created from it; a favorite with a now-dead URL still opens (just errors normally on load,
  same as any bad bookmark).

## 3. People cards
Queue: `[quick|new|M]` "People cards" — NOTE (user): "Get arc parity." Atlas: "Hover a GitHub,
LinkedIn or X profile link to see who it is."
- (a) Nothing exists. No link-hover-to-identity feature anywhere in Zen or Firefox.
- (b) No open issue/discussion.
- (c) Arc's people cards: hovering a profile link (in an email, a doc, a tweet) pops a small
  card with the person's photo/name/headline before you click through — useful for "who is
  this" moments without a context switch.
- (d) Honest feasibility split by site, which matters for scoping tonight:
  **GitHub** is the easy, fully-feasible one — `api.github.com/users/<login>` is a public,
  unauthenticated REST endpoint returning avatar, name, and bio directly; a hover on a link
  matching `github.com/<user>` (not `github.com/<user>/<repo>`) triggers a `fetch()` to that
  endpoint and renders the `WhimsyHoverCard` from the shared pattern above.
  **LinkedIn and X/Twitter are a real gap, not a small build task**: neither offers a public,
  unauthenticated profile-lookup API; LinkedIn's profile pages require a logged-in session to
  even render most content and actively block typical scraping; X's API requires paid access
  for this kind of lookup. A card for these two would have to either (a) do nothing more than
  show the raw URL/handle parsed from the link text (no fetched data — a much smaller "card"
  than GitHub's) or (b) attempt a signed-in-session fetch of the profile page itself (reusing
  the same cookie-included-channel trick live folders use) and scrape whatever's in the page,
  which is fragile and likely against both sites' terms. Recommend scoping LinkedIn/X down to
  the handle-only card tonight and flagging the full version as a Maybe pending a decision on
  scraping risk, rather than quietly shipping something likely to break or raise ToS concerns
  the user hasn't weighed in on.
  Test: hovering a `github.com/<user>` link shows a card with the fetched avatar/name;
  hovering `github.com/<user>/<repo>` does *not* trigger a people card (it's not a profile
  link); a LinkedIn/X link shows the scoped-down handle-only card, not a fetch attempt;
  hovering briefly and moving away before the delay elapses never fires a network request.

## 4. Preview before opening from history
Queue: `[quick|new|M]` "Preview before opening from history" (no note).
- (a) Nothing exists for History specifically. The only related "preview" precedent is the
  folder hover-search popup above, which previews a *list of open tabs*, not a thumbnail of a
  closed page.
- (b) No open issue/discussion.
- (c) Common across browsers with a rich History UI: hovering a history entry shows a
  thumbnail/snapshot of the page as it looked, so you can tell two similarly-titled visits
  apart (or confirm you're about to open the right thing) before committing a click.
- (d) The real constraint: Firefox doesn't keep a screenshot of every page you've ever visited
  (that would be enormous) — there's a limited top-sites thumbnail cache
  (`PlacesUtils`/`Thumbnails.sys.mjs`, used for the new-tab page's top sites), not a general
  per-history-entry snapshot. Two honest options: (1) only show a preview for entries that
  happen to already have a cached thumbnail (top sites, recently-closed tabs still in
  SessionStore) and fall back to a text-only card (title, URL, visit time) for everything else
  — correct but inconsistent coverage; (2) start capturing a lightweight thumbnail on every
  page visit going forward (hook `onLocationChange`, debounce to avoid capturing mid-load,
  store keyed by URL+timestamp in Whimsy's own cache with a size cap and eviction) so coverage
  improves over time but is empty for anything visited before the feature shipped. Recommend
  (1) for tonight (zero new capture machinery, honest "no preview available" fallback) and
  flag (2) as a reasonable follow-up given it's genuinely more storage/IO than the other items
  in this batch.
  Test: hovering a history entry with an existing thumbnail (visit a top site, check it)
  shows the image card; hovering one without falls back to the text-only card, not a broken
  image; the card dismisses using the same hover-grace pattern as people cards.

## 5. Bionic or guided reading
Queue: `[reading|new|S]` "Bionic or guided reading" (no note). Related: batch5's reader
typography/reading-time items, both already-partial features this slots next to.
- (a) Nothing exists. Reader mode's content (`AboutReader.sys.mjs`) is rendered from
  Readability's extracted article HTML with no word-level processing — bionic reading needs
  bolding the first ~40-60% of each word's letters, which has to happen to the DOM text nodes
  themselves.
- (b) No open issue/discussion.
- (c) Bionic Reading (the commercial tool/extensions implementing it) bolds the leading
  portion of each word so the eye's natural fixation points land on already-emphasized
  letters, which some readers find measurably faster and others find distracting — hence it
  should ship as an opt-in reader-view toggle, not a default.
- (d) A reader-view-only CSS/DOM pass (scope it to `about:reader`, not arbitrary pages, since
  mutating arbitrary page DOM on every site is far riskier and the feature's whole premise —
  long-form reading — already lives in reader mode): a small text-node walker over the
  article's content that wraps each word's leading letters in a `<b>`/`<strong>` (or a
  `font-weight` span to avoid semantic `<strong>` misuse), run once when reader mode's content
  is injected, toggled by a reader-view toolbar button next to the existing typography controls
  from batch5. Reduced-motion/no-animation concerns don't really apply here (it's static text
  styling, not motion) but it should respect a "legible" escape hatch — toggling off must fully
  restore the original text nodes, not just hide the bolding visually (a screen reader or
  Find-in-page shouldn't see injected markup when the feature is off).
  Test: toggling bionic reading on an article wraps the expected letter-count prefix per word
  (check a known word's markup, not just a visual snapshot); toggling off restores the original
  text content exactly (string-compare, catches any correctness bug a visual-only check would
  miss); Find-in-page still finds words correctly with the feature on (the wrapping must not
  break textContent-based search).

## 6. Print a clean page
Queue: `[reading|new|M]` "Print a clean page" (no note). Atlas: Edge inspiration.
- (a) **Most of this already exists, just not wired to Print.** Reader mode's whole purpose is
  stripping ads/sidebars/nav down to the article (Readability's extraction, already used for
  reader view and already used for batch5's "reading time" estimate). `ReaderMode.sys.mjs`
  exposes `downloadAndParseDocument(url, attrs, docContentType)` (:199) as the programmatic
  entry point to get that clean article content without necessarily navigating the user's
  visible tab into `about:reader` first. There's no dedicated "print" button in reader mode
  (checked `AboutReader.sys.mjs` and the reader content files — no print-specific code found)
  and no command that prints the clean version while leaving the original tab's view alone.
- (b) No open issue/discussion.
- (c) Edge's "print clean" / its reading-view print path strips the surrounding chrome so the
  printed page is just the article, not three pages of sidebar and ad placeholders bleeding
  across the print job. People reach for it specifically to avoid wasting paper/PDF pages on
  page furniture.
- (d) A command-bar action / print-dialog addition "Print a clean page": call
  `ReaderMode.downloadAndParseDocument(currentURL)` to get the extracted article, render it
  into a hidden/off-screen document (or simplest: navigate a new background tab to
  `about:reader?url=<currentURL>`, wait for it to finish rendering, trigger print on *that* tab
  via the existing print command, then close it) so the user's actual visible tab never
  changes. The simplest version — just open `about:reader?url=...` and let the user hit Cmd+P
  themselves — is nearly free given reader mode already exists; the one-click "Print a clean
  page" action is the only new glue, wiring reader-mode-then-print into a single command rather
  than two manual steps.
  Edge cases: a page Readability can't parse as an article (not "readerable",
  `Readerable.isProbablyReaderable`) has no clean version — fall back to the browser's normal
  print preview with a note, rather than failing silently.
  Test: running the command on a readerable article opens a print dialog whose preview shows
  only the article content (check that known sidebar/nav text from the original page is absent
  from the print-target document); on a non-readerable page (e.g. a single `<img>` test page)
  it falls back to normal print, not an error.

## 7. Menu bar extra
Queue: `[mac|new|S]` "Menu bar extra" — NOTE (user): "Get arc parity." Atlas: Arc inspiration,
"A menu bar icon for the quick window and recent tabs."
- (a) **No native code needed — the XPCOM service already exists and is already scriptable.**
  `engine/widget/nsISystemStatusBar.idl` defines `nsISystemStatusBar` with exactly two methods,
  `addItem(aMenuElement)`/`removeItem(aMenuElement)`: hand it a XUL `<menu>` element containing
  a `<menupopup>`, and the menu's icon appears in the macOS menu bar; clicking it opens the
  popup's contents as a native menu (the label itself is not shown, icon-only, matching a menu
  bar extra's usual look). This is the same category of pre-existing native bridge
  `WhimsyAppIcon.sys.mjs` already leans on for `nsIMacDockSupport` — just a different service,
  equally ready to call from JS.
- (b) No open issue/discussion.
- (c) Arc's menu bar icon gives a global entry point even when no Arc window is focused: click
  it for a quick window / recent tabs, usable from anywhere in macOS without alt-tabbing to the
  browser first.
- (d) `WhimsyMenuBarExtra.sys.mjs`: build a hidden XUL `<menu>` element (parked in a hidden
  part of the hidden window or the main browser document, matching however other hidden
  menu-driving elements are typically parked in this codebase) whose icon is Whimsy's own
  (reuse `WhimsyAppIcon`'s icon assets) and whose `<menupopup>` contains "New Quick Window"
  (calls `WhimsyQuickWindow.open()` from batch12 #1) and a dynamically-rebuilt list of recent
  tabs (reuse whatever `RecentlyClosedTabsAndWindowsMenuUtils`-style API Firefox already uses
  for the History menu's "Recently Closed Tabs" list, rather than building a second recent-tabs
  source). Call `Cc["@mozilla.org/widget/systemstatusbar;1"].getService(Ci.nsISystemStatusBar).addItem(menuEl)`
  once at startup (macOS only, gated the same way `WhimsyAppIcon.init()` gates on
  `AppConstants.platform != "macosx"`), with a Settings toggle to show/hide it (`removeItem` on
  disable).
  Test: enabling the setting adds a status item whose popup lists "New Quick Window" plus
  recent tabs; clicking a recent-tab entry focuses/reopens it; disabling the setting removes
  the status item (`removeItem` called, and a fresh `addItem` with the same element is a no-op
  per the IDL's own doc comment, so toggling off-then-on must not silently fail from reusing a
  stale element reference — recreate the menu element rather than reusing one that was already
  removed, if that distinction matters for this IDL's implementation).

---

## Native-code flags
Only "People cards" has a real, non-technical limiting factor (LinkedIn/X have no API path
that doesn't involve fragile scraping or ToS risk — a product decision, not a native-code gap).
Everything else in this batch is pure JS/front-end: split layouts and pin-a-split extend
existing `ZenViewSplitter` data structures, bionic reading and print-a-clean-page are DOM/print
work over the already-existing Readability/reader-mode pipeline, and the menu bar extra needs
zero new native code thanks to the already-shipped `nsISystemStatusBar`.
