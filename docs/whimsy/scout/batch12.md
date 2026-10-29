# Scout batch 12: links & media windows (Little Arc, PiP/floating calls, follower tabs, routing)

Read-only research, 2026-10-29. Paths relative to ~/Repos/whimsy. "Overlay" = new code in
src/zen/whimsy/ (+ prefs/whimsy/whimsy.yaml, whimsy-settings.js), no Zen edits. gh search
issues --repo zen-browser/desktop found nothing on-topic for any item below. External-link
routing and whimsy:// URL schemes were already scouted in docs/whimsy/scout/batch6.md (#5,
"External links in Glance") and batch7.md (#13, "whimsy:// URL schemes + open in a space from
the command line") — referenced below, not repeated.

## What already decides where a link lands

`WhimsyExternalLinks.sys.mjs` (src/zen/whimsy/) already wraps `BrowserDOMWindow.openURI` for
`OPEN_EXTERNAL`-flagged opens and branches on `whimsy.external-links.target`: `"glance"` opens
a Glance over the current window (implemented, calls `gZenGlanceManager.openGlance`);
`"quick-window"` is named in the code and the setting, but **falls through to Firefox's own
"tab" handling today — nothing builds the quick window itself** (the file's own comment says
so: "not built yet; falls back to a tab until Whimsy has one"). Per the build-plan, Little Arc
is the default target (Arc parity) with Glance as a setting — so item 1 below is really "finish
`WhimsyExternalLinks`'s third branch," not a new subsystem; the routing decision already
exists, only the destination window type is missing.

---

## 1. Little Arc (quick window for external links)
Queue: `[quick|new|M]` "Quick window for external links" (no note; also appears as
`[quick|new|M]` "Quick window hotkey from any app"). Atlas: 102 votes ("Little Arc"), the
single most-cited Arc-parity ask ("HN: the big missing piece in Zen", feature-atlas.html:219).
BUILD-PLAN answers (win): Cmd+Opt+N opens Little Arc; links from other apps default to Little
Arc (Glance stays a setting, per batch6 #5); a "Move to space" button promotes the page into a
real tab/space; closing it discards it.
- (a) **Nothing resembling it exists**, and there's no ready-made "minimal browser window" type
  to extend. Checked for a site-specific-browser/PWA-style reduced-chrome window anywhere in
  Zen (`src/zen`) — none. The nearest *adjacent* precedent for a non-standard top-level Gecko
  window is the Picture-in-Picture player (`engine/toolkit/components/pictureinpicture/content/player.xhtml`),
  which proves the pattern "a small, chrome-flagged top-level window that isn't the full
  `browser.xhtml` chrome" is buildable in this engine, but it's a video player, not a
  navigable browser surface — Little Arc needs a URL bar, back/forward, and a real `<browser>`,
  so it's closer to a stripped-down `browser.xhtml` instance than to the PiP player.
  `window.open`/`openDialog` with narrow `chromeFlags` (no menubar, no toolbar, no sidebar)
  already exists at the platform level (this is how Firefox renders any site's
  `window.open(url, '_blank', 'width=400,height=300')` popup) — that's the real building
  block: open a new top-level browser window whose `browser.xhtml` document gets a Whimsy
  attribute (e.g. `windowtype="navigator:whimsy-quick"`) and a CSS rule hiding the sidebar,
  space switcher, and tab strip when that attribute is present, leaving just a URL bar, nav
  buttons, and the content area — all Whimsy-owned CSS/JS, no change to `browser.xhtml` itself
  (the attribute is set at window-creation time by Whimsy's own code, read by Whimsy's own
  stylesheet).
- (b) No open issue/discussion.
- (c) Arc's Little Arc (Cmd+Opt+N, or any link opened from another app): a small, separate
  window — no tab strip, no sidebar, just a URL bar and the page — that floats above the main
  window. People use it to peek at a link (a Slack URL, a doc someone sent) without committing
  a tab to their actual space, and either close it when done or promote it ("Cmd+O" in Arc, or
  dragging it onto a space) once it's clear the page is worth keeping. One HN commenter quoted
  in the atlas called it "the big missing piece" moving from Arc to Zen — it's less about the
  window chrome and more about *not polluting your spaces* with throwaway tabs.
- (d) A new `WhimsyQuickWindow.sys.mjs`: `open(url, { triggeringPrincipal })` opens a new
  browser window via the standard window-opening path (`BrowserWindowTracker`/`OpenBrowserWindow`-equivalent, or more likely a direct
  `Services.ww.openWindow` call against `chrome://browser/content/browser.xhtml` with a custom
  feature string) with the `whimsy-quick-window` attribute set before first paint (read in
  Whimsy's content script/CSS to hide sidebar/tabstrip/space-switcher elements and collapse to
  a single pinned-width toolbar: back, forward, reload, URL bar, "Move to space"). Reuses
  `WhimsyExternalLinks`'s existing `target` branch — add the `"quick-window"` case calling
  `WhimsyQuickWindow.open(uri.spec, ...)` exactly where `openInGlance` is called today. Cmd+Opt+N
  is a new global shortcut (verify free against Zen's existing kbs, same check batch9 flags for
  Cmd+Opt+T) opening an empty quick window focused on the URL bar. "Move to space": a toolbar
  button that calls `gBrowser` tab-adoption into the chosen space's window (the same mechanic
  that already moves a tab between windows/spaces elsewhere in Zen) and closes the quick
  window. Closing without moving discards the page entirely (no session-restore entry) per the
  build-plan's "temporary" framing.
  Open design question worth flagging rather than guessing past: whether the quick window
  should float above the main window (`alwaysontop`/floating level, like Arc) or behave as an
  ordinary window in the window list — Arc floats it; decide and note the call either way, this
  is more a product decision than a technical blocker.
  Edge cases: a second external link while one quick window is already open — Arc reuses the
  same Little Arc window for the next link rather than stacking more; a quick window has no
  sidebar, so it also has no space context — "Move to space" needs its own space picker, not an
  assumption about which space is "current."
  Test: Cmd+Opt+N opens a chromeless window with a focused URL bar; an external-link open with
  the pref on "quick-window" lands there, not a tab, and not Glance; "Move to space" adopts the
  tab into the chosen space's window and the quick window closes; closing it directly (Cmd+W)
  leaves no trace in History/SessionStore.

## 2. Automatic PiP above full-screen apps + floating video calls
Queue: `[media|new|M]` "Automatic picture-in-picture" — NOTE (user): "I think it exists." /
`[media|new|M]` "Picture-in-picture over full-screen apps" — NOTE: "Get parity." /
`[media|new|M]` "Floating video calls" — NOTE: "Get parity." Three queue lines, one real
surprise underneath.
- (a) **"Over full-screen apps" already works at the engine level — this is the batch's
  biggest finding.** `engine/widget/cocoa/nsCocoaWindow.mm` already gives any
  `PiPType::MediaPiP` window `NSWindowCollectionBehaviorFullScreenAuxiliary` plus
  `NSWindowCollectionBehaviorCanJoinAllSpaces` (:5480-5489), with a comment explicitly citing
  "bug 1688932" and explaining exactly why ("only a FullScreenAuxiliary window may be placed on
  another application's fullscreen Space"). `DoMakeFullScreen` (:6686) has a second, more
  detailed comment block (:6692-6702) handling the case where the *player itself* goes
  fullscreen, specifically to avoid stealing `FullScreenPrimary` status and breaking this
  exact behavior — this reads as deliberate, already-landed, already-debugged work (it cites
  two more bug numbers, 2031249 and 2038980, for crash fixes found while maintaining it), not
  a stub. In other words: **any PiP window — manual or automatic — that this engine opens
  already floats above other apps' full-screen Spaces on macOS.** There is nothing to build for
  this item specifically; it needs verification (open PiP, full-screen a different app, confirm
  the player stays visible) and then simply shipping automatic PiP (next point) so people
  actually get a PiP window often enough to notice this already works.
  Automatic PiP itself, separately: `media.videocontrols.picture-in-picture.enable-when-switching-tabs.enabled`
  is forced `false` in Zen's own `prefs/firefox/pip.yaml` with a `TODO: Enable once we have a
  proper settings page` (already flagged in batch5 #4) — this is the literal reason the user
  "thinks it exists": the engine-level feature is there, Zen just hasn't exposed a toggle for
  it, so it has effectively never been on. batch5 already proposes the Settings checkbox;
  nothing new to add here beyond confirming this checkbox is the whole fix for that queue line.
- (a cont'd) Floating video calls (Meet/Zoom specifically) is the one piece with no existing
  support: automatic PiP picks whichever `<video>` element Firefox's own heuristic considers
  "the" playing video (largest/most recently played) — there's no concept of "this page is a
  video call" or any preference for the camera-grid tile specifically over, say, a shared
  screen share tile or a YouTube video open in a background tab.
- (b) D#6555 "PiP above full-screen apps on macOS" (45 votes, cited already in batch5 #4) is
  the Discussion tracking exactly the behavior that's already shipped at the engine level —
  worth closing out/commenting on once Whimsy verifies and ships the automatic-PiP checkbox,
  since the underlying ask is already satisfied.
- (c) Arc and Dia float Meet/Zoom calls in a small always-visible window the instant you
  switch away from the call tab, so you can keep talking while reading docs or taking notes
  elsewhere — the "floating" part specifically means it recognizes a call, not just any video.
- (d) `WhimsyFloatingCalls.sys.mjs`: a small list of known conferencing origins
  (`meet.google.com`, `*.zoom.us`, `teams.microsoft.com`, `*.webex.com` — extensible via a
  pref/JSONFile list since this will always be incomplete) checked on `TabSelect`/navigation;
  when the active tab matches and the tab has a playing `<video>`, force-trigger
  `PictureInPicture.handlePictureInPictureRequest`-equivalent (reuse the Settings-exposed
  auto-PiP path from batch5 #4, just triggered by "this is a call" rather than only "I switched
  tabs") on switching away, regardless of the generic auto-PiP setting. The inherited
  full-screen-Space behavior from above applies automatically once it's a real `MediaPiP`
  window — no extra work needed for that half.
  Edge cases: a Meet tab with no camera/video track active (audio-only call) has no video
  element to PiP — fall back to not floating rather than erroring; a page that matches the
  origin list but isn't actually in a call (e.g. sat on meet.google.com's landing page) having
  "floating" trigger on any video it happens to autoplay would be a false positive — gate on
  some call-specific signal if the site exposes one (Meet's DOM has a reasonably stable
  "in call" indicator; worth a quick manual check before committing to a selector, since this
  is the kind of thing that breaks silently on a site redesign).
  Test: a Meet-like test page's video PiPs on tab-switch-away even with the generic auto-PiP
  setting off; a non-conferencing site with an autoplaying video does not; the resulting PiP
  window's collection behavior still includes `FullScreenAuxiliary` (confirms it rode the
  normal PiP path, not a special-cased window).

## 3. Follower tabs
Queue: `[tabs|new|M]` "Follower tabs" (no note). Atlas: Vivaldi 7.9 inspiration, "Opens a link
as a follower: the source stays on one side and each link you click opens on the other."
- (a) Nothing exists — this is Vivaldi's newest (2026) feature and has no analogue anywhere in
  Firefox or Zen's split-view code (`ZenViewSplitter.mjs`, see batch13 for its existing
  2-pane/grid layouts). It's conceptually a split view with a *sticky role*: one pane is "the
  source," the other is "wherever a followed link lands," rather than two independent panes.
- (b) No open issue/discussion.
- (c) Vivaldi 7.9 (alternativeto.net news item cited in the atlas, feature-atlas.html:309):
  browsing a reference page (docs, a wiki, a forum thread) and following its links one after
  another without losing the source page — every click replaces the *other* pane's content, the
  source pane never moves. People use it for research/reading flows where you keep bouncing
  back to one anchor page.
- (d) Builds on `ZenViewSplitter`'s existing split mechanics rather than a new pane system: a
  split created "as followers" tags one side's `splitData` entry with `role: "source"` and the
  other `role: "follower"`; a `click` capture-phase listener in the source pane's content
  (reusing the actor pattern from batch5, a `WhimsyPageChild` hook) intercepts same-window
  navigations and link clicks and redirects them to load in the follower pane's browser instead
  of navigating the source pane itself, while link clicks happening *in* the follower pane
  behave normally (so following link after link in the follower pane doesn't ping-pong back to
  the source). Toggled per split via a context-menu item ("Make this a follower split") rather
  than a separate split type users have to pick up front, since Vivaldi's framing is "a split
  view with a sticky role," not a wholly different feature.
  Edge cases: the user explicitly navigates the source pane itself (typing a new URL into it) —
  that should just... navigate the source pane; only *clicked links on the page* get
  redirected, not direct navigation; closing the follower pane while in follower mode should
  offer to keep the source pane as a normal single tab, not disappear both.
  Test: clicking an in-page link in the source pane loads it in the follower pane, leaving the
  source's URL unchanged; clicking a second link in the source pane replaces the follower pane's
  content again (not the source's); a link clicked inside the follower pane navigates the
  follower pane normally, not back to the source.

---

## Native-code flags
None. Little Arc is pure front-end window-chrome work over Firefox's existing window-opening
primitives (no new native window type). The full-screen PiP behavior needing *zero* new code is
this batch's headline finding — it's already native, already landed, and just needs the
Settings checkbox from batch5 to actually get used. Follower tabs and floating-call detection
are both JS/actor-level work over existing split-view and PiP primitives.
