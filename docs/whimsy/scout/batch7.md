# Scout batch 7: input, files, nav, dev, URL schemes, delight

Read-only research, 2026-10-29. Paths are relative to ~/Repos/whimsy. "Overlay" means
new code in src/zen/whimsy/ (+ prefs/whimsy/whimsy.yaml, whimsy-settings.js), no Zen edits.
Zen feature requests live in GitHub Discussions, cited as D#. No open Zen *issues or PRs* exist
for most of these (checked with `gh search issues` and a Discussions GraphQL search).

BUILD-PLAN answers that apply: new features default **ON** unless the note says otherwise.
Arc features copy Arc exactly. Write down why users love it and how they use it in the commit body.
Links from other apps open in the quick window (Little Arc), so `whimsy://open` follows that rule too.

Shared building blocks:
- Shortcuts: plain `<key>` elements (src/browser/base/content/zen-keysets.inc.xhtml) customised through Firefox's
  CustomKeys (about:keyboard, engine/browser/components/customkeys/CustomKeys.sys.mjs). `CustomKeysParent`
  "CustomKeys:GetKeys" returns every key grouped into categories, and Zen adds its own groups (`ZEN_KEY_CATEGORIES`,
  src/zen/kbs/ZenKeyboardShortcuts.sys.mjs:34). Whimsy defaults live in src/zen/whimsy/WhimsyShortcuts.sys.mjs.
  Cmd+Opt+Left/Right is already **space switch** (zen-keysets:26), as in Arc.
- macOS: `nsIMacDockSupport` (engine/widget/nsIMacDockSupport.idl: `badgeText`, `setBadgeImage`, `setApplicationIcon`,
  plus nsITaskbarProgress `setProgressState`), `nsIMacSharingService`, `nsIMacFinderProgress`, `nsILocalFileMac`.
  **Gecko has no Quick Look API**: no QLPreviewPanel anywhere in engine/.
- Internal pages: about: pages are C++ (`kRedirMap` in nsAboutRedirector.cpp / AboutRedirector.cpp + components.conf
  `about_pages`). Overlay option: register a JS `nsIAboutModule` factory at runtime
  (`Components.manager.registerFactory`, contract `@mozilla.org/network/protocol/about;1?what=whimsy`).
  JS cannot register a new *protocol* like `whimsy:`, so `whimsy://x` has to be rewritten to `about:whimsy?x`.
- Tests: mochitests in src/zen/whimsy/tests/ (browser.toml). Visual items also get a shot in browser_whimsy_screens.js.

---

## 1. Keyboard sidebar navigation
Queue: `[input|new|S]` (no note).
- (a) Firefox already supports arrow keys inside the tab strip: `on_keydown` in engine/browser/components/tabbrowser/content/tabs.mjs:555
  handles Up/Down/Left/Right and Ctrl+arrows to move a tab, using `ariaFocusableItems` and `ariaFocusedItem`. The hard part is reaching the strip: F6 and Tab
  only cycle through toolbars (`browser.toolbars.keyboard_navigation`=true). Zen has no "focus the sidebar" key. Next and previous tab: Ctrl+Tab and Cmd+Opt+Left/Right are taken by space switching.
- (b) Nothing specific. D#10577 (command bar ideas, 33 votes) touches on it.
- (c) Arc: Cmd+Opt+Up/Down goes to the previous/next tab **in sidebar order**, across pinned and today tabs. Vivaldi and Sidebery
  have "focus tab bar", then arrows, Enter to open, Delete to close. Loved by keyboard users who never touch the mouse.
- (d) Bind `whimsy-tab-next` and `-prev` to Cmd+Opt+Down/Up (both free; check with CustomKeys). They walk `gBrowser.visibleTabs` in sidebar DOM order, including
  essentials, folders and pinned tabs, and skip collapsed folders. Add "Focus sidebar" (Cmd+Opt+S, check for conflicts): it focuses the selected tab, then Up/Down/Enter/Delete/Esc,
  and Space opens a Glance. Draw a visible focus ring.
  Test: three tabs. Cmd+Opt+Down twice selects the third. Focus sidebar, ArrowUp, Enter → the second tab is selected. Delete closes it.

## 2. Shortcut cheat sheet
Queue: `[input|new|S]` (no note).
- (a) about:keyboard (`chrome://browser/content/customkeys/customkeys.html`) is the full editable list with search, and it already includes Zen's groups.
  There is no quick overlay. Firefox's Help → Keyboard Shortcuts links to a SUMO web page.
- (b) D#5214 "Open keybindings in a Zen web panel" (2 votes).
- (c) The macOS CheatSheet app (hold Cmd to see a sheet), the `?` overlay in Gmail, GitHub and Linear, and Arc's Settings → Shortcuts list.
  People love a one-glance, searchable sheet that reflects *their* bindings and closes with Esc.
- (d) Cmd+/ (check for conflicts) and the command bar action "Keyboard shortcuts" open a centred chrome panel. It reads the same data as
  "CustomKeys:GetKeys" (call `CustomKeys` and `ZenKeyboardShortcuts.addKeys` from the parent). Show grouped columns with a search box and an "Edit…" link
  to about:keyboard (also at `whimsy://shortcuts`). Fade and scale in, plain fade under reduced motion.
  Test: open with the key → the panel shows the "zen-duplicate-tab" row with ⇧⌘D. Customise a key → the sheet shows the new binding. Esc closes it.

## 3. Download progress on the Dock icon
Queue: `[mac|new|S]` (no note).
- (a) **Exists.** `DownloadsTaskbar` (engine/browser/components/downloads/DownloadsTaskbar.sys.mjs:137) registers the global
  `macTaskbarProgress` (nsMacDockSupport, which implements nsITaskbarProgress). `SetProgressState` draws `MOZProgressDockOverlayView`, a bar across the Dock tile
  (widget/cocoa/nsMacDockSupport.mm:194). It still works with Whimsy's custom icon: `setApplicationIcon` rebuilds the tile around the overlay
  (WhimsyAppIcon.sys.mjs:79). What's missing is the **count badge** (`badgeText` is unused in browser code) and a finished bounce.
- (b) No issue or discussion.
- (c) Chrome and Safari show a progress bar plus a badge with the number of active downloads. The Dock bounces once when a download finishes. People can leave the
  window and glance at the Dock.
- (d) In a `WhimsyDownloads.sys.mjs`, a `Downloads.getList(ALL)` view sets `dock.badgeText = String(inProgressCount)` (or "" at zero).
  When a download finishes while the app is in the background, call `win.getAttention()` for one Dock bounce (not `activateApplication`,
  which steals focus). Pref `whimsy.downloads.dock-badge` (on).
  Test: start a slow download (use the test server's slow `.sjs`) → `badgeText == "1"`. Cancel it → "". The progress state is already covered by Firefox's own tests.

## 4. Quick Look downloads
Queue: `[files|new|S]` NOTE: "Arc has this".
- (a) **No Gecko Quick Look API.** Zen's Library has its own media preview (src/zen/library/ZenLibraryMediaPreview.mjs) and download thumbnails
  (`#previewUrl` in sections/ZenLibraryDownloadsSection.mjs:280), but no native Quick Look. `nsILocalFileMac.reveal()` and `launch()` exist.
- (b) D#15160 "Quickly attach files from clipboard or downloads" touches on it. Nothing else.
- (c) Arc: in the downloads popover and Library → Downloads, select a file and press **Space** (or right-click → Quick Look). The native macOS
  Quick Look panel opens, and arrow keys move through files. Users love it for checking a PDF or image without opening Preview.
- (d) Native and best: add a small XPCOM component in Whimsy's own widget code. It needs C++ (a new interface on top of nsMacDockSupport, or a
  `nsIWhimsyQuickLook.showPreview(Array<AString> paths, index)` built on `QLPreviewPanel` with a data source). Cheap fallback: `Subprocess.call({command:"/usr/bin/qlmanage", arguments:["-p", path]})`.
  It shows a non-native window. Bind Space and the context-menu item in the downloads panel, the Library downloads section and the Library widget.
  Test: a JS mock of the component. Space on a finished download's row calls `showPreview` with its `target.path`. A missing file → no call and an "Item removed" toast.

## 5. Drag downloads into sites
Queue: `[files|partial|S]` (no note).
- (a) **Mostly exists.** Dragging from the downloads panel sets `application/x-moz-file` + `text/uri-list` (downloads.js:1118 `_onDownloadDragStart`).
  Zen's Library downloads section (ZenLibraryDownloadsSection.mjs:517) and the Library widget (ZenLibraryWidget.sys.mjs:229,346) do the same.
  Gecko exposes `x-moz-file` to content as `DataTransfer.files`, so dropping on a site's upload zone should work. What's missing: verify it, and the drag
  probably ends as the panel closes (`DownloadsPanel` hides on blur).
- (b) No issue. D#14712 "Fix DownloadTab".
- (c) Arc and Safari: drag a download straight from the downloads popover into Gmail, Slack or a Drive window. The popover stays open while you drag.
  Loved because it skips Finder.
- (d) Keep the panel open during the drag: set `DownloadsPanel.keepOpen` for the drag, or set `noautohide` on dragstart and clear it on dragend. Also allow a drag from the
  Zen download-finished animation chip. Add a mochitest that proves the drop works.
  Test: a page with a `drop` listener that records `e.dataTransfer.files[0].name`. Synthesize a drag from the Library download row (EventUtils.synthesizeDrop)
  → the page gets the file name. The panel stays open until dragend.

## 6. Upload from the clipboard
Queue: `[apps|new|S]` (no note).
- (a) Nothing in Firefox. The OS file picker (nsIFilePicker) has no clipboard source. Pasting into a page only works where the site handles `paste`.
  Building block: `HTMLInputElement.mozSetFileArray(files)` (ChromeOnly, dom/webidl/HTMLInputElement.webidl:170), callable from a JSWindowActorChild.
- (b) D#4673 "Uploading files from clipboard" (7 votes), D#15160 (4), D#12558 "Opera-style Easy Files" (6).
- (c) Opera's **Easy Files**: clicking any upload button first shows a small popup listing the clipboard image/file and recent downloads,
  and "Browse…" opens the normal picker. Loved for screenshots: Cmd+Ctrl+Shift+4, then click upload, then click the thumbnail.
- (d) A `WhimsyUpload` actor catches `click` (capture) on `input[type=file]` with a trusted event and calls `preventDefault`. The parent shows a popup anchored
  to the element: the clipboard image (`Services.clipboard` → PNG `File`), the five newest downloads, and "Choose file…" (calls `input.showPicker()`
  with a one-shot bypass). Choosing an item → the child calls `mozSetFileArray`, then fires `input` and `change`. Respect the `accept` and `multiple` attributes. Pref on, with an Esc fallback.
  Test: put a PNG on the clipboard, click the test page's file input, choose the clipboard row → `input.files[0].type == "image/png"` and `change` fired.

## 7. Keep the window when the last tab closes
Queue: `[nav|partial|S]` (no note).
- (a) **Exists.** Zen sets `browser.tabs.closeWindowWithLastTab` = false (prefs/firefox/browser.yaml:66).
  `ZenSpaceManager.handleTabBeforeClose` (src/zen/spaces/ZenSpaceManager.mjs:1234) then selects or creates an empty tab instead of closing.
  `shouldCloseWindow()` (:1202) still closes popup windows and windows with spaces disabled.
- (b) Issue #9426 "Closing last tab no longer opens a new tab". Issue #10981 "Closing last tab individually prevents restoring window/session".
- (c) Arc: closing the last tab leaves the window with its sidebar and an empty page, and Cmd+T is one key away. Cmd+W on an already empty window closes it.
- (d) Verify only: expose it in Settings ("Keep window open after closing the last tab", reversed checkbox on Firefox's pref). Make Cmd+W on an empty
  window close it, matching Arc. Check that the empty state shows the new-tab hint and not a blank white page.
  Test: one window, close its only unpinned tab → the window is still open and the selected tab has `zen-empty-tab`. Cmd+W again → the window closes.

## 8. Show the full URL on click
Queue: `[nav|partial|S]` (no note).
- (a) **Mostly exists.** `browser.urlbar.untrimOnUserInteraction.featureGate`=true and `trimHttps`=true (prefs/firefox/urlbar.yaml).
  Focusing the URL bar untrims it to the full `https://…` URL. `zen.urlbar.show-domain-only-in-sidebar`=true (zen-urlbar.yaml:20,
  used in ZenUrlbarController.mjs:35 and the UrlbarValueFormatter patch) shows just the domain until you interact. Missing: a "Show full URL" setting.
  Issue #13852: opening the URL bar messes up the displayed URL.
- (b) D#15072 "Show full URL on hovering a tab" (1).
- (c) Safari: Settings → Advanced → "Show full website address". Arc shows the domain, and clicking it reveals the full, selected, editable URL.
  People want the full URL to check where they are, then copy or edit it.
- (d) Add a Settings checkbox "Always show full address" that writes `zen.urlbar.show-domain-only-in-sidebar` = false and `browser.urlbar.trimURLs` = false.
  Check that a single click selects the whole untrimmed URL (Arc). Fix #13852 only if it reproduces in Whimsy.
  Test: load https://example.com/a?b. Click the URL bar → `gURLBar.value` is the full `https://example.com/a?b` and fully selected. Turn the setting on → the full URL shows without focus.

## 9. Hardware video decoding toggle
Queue: `[perf|partial|M]` NOTE: "Toggle in settings".
- (a) Prefs: `media.hardware-video-decoding.enabled` (true, StaticPrefList.yaml:13218, read **at startup only**:
  gfxPlatform.cpp:2865 `media_hardware_video_decoding_enabled_AtStartup`) and `media.hardware-video-decoding.force-enabled`.
  On macOS this is VideoToolbox. Firefox's Settings only has "Use hardware acceleration when available" (`layers.acceleration.disabled`,
  config/tabs-browsing.mjs:577), hidden unless "Use recommended performance settings" is unchecked.
- (b) No direct issue. Issues #15521 (GPU freezes) and #16194 (Widevine) are cases where users toggle these by hand.
- (c) Chrome: Settings → System → "Use graphics acceleration when available", with a Relaunch button. Users switch it off for video glitches and
  on for battery life. `about:support` → Media shows what's actually in use.
- (d) Add a Settings checkbox "Hardware video decoding" under Performance, bound to `media.hardware-video-decoding.enabled` (default on). Changing it shows an inline
  "Restart Whimsy to apply" button (`Services.startup.quit(eRestart|eAttemptQuit)`). Optionally also show Firefox's
  hidden graphics acceleration toggle. Respect the note: it's a setting, not a feature.
  Test: the checkbox reflects the pref, unticking sets it false, and the restart prompt appears. No decode test (it needs real hardware).

## 10. Developer mode tabs (Arc parity)
Queue: `[dev|new|M]` NOTE: "Get parity".
- (a) Pieces exist: DevTools keys (Cmd+Opt+I toolbox, Cmd+Opt+K console, Cmd+Opt+C inspector, Cmd+Opt+E network), the built-in JSON viewer
  (`devtools.jsonview.enabled`), and untrimmed URLs. There's no per-tab mode.
- (b) D#11016 "[Feature Request] Arc's Developer Mode" (45 votes).
- (c) Arc: any **localhost** URL (or one with a port, like localhost:3000) switches the tab into Developer Mode automatically. Manually: Site Control Center → Site Settings → "Developer
  Mode", or Cmd+T "Turn on Developer Mode for this site". The UI shows the **full URL bar across the top of the window**, buttons for Console, Network and
  Elements, and a **yellow and black outline** on the focused tab. Arc also installs a JSON formatter. Devs love not hunting for DevTools and seeing the port and path.
- (d) A `WhimsyDevMode.sys.mjs` progress listener sets `tab.whimsyDevMode` when the host is localhost, 127.0.0.1, `*.local`, or has a port, or is in the stored site list
  (`Services.perms` "whimsy-devmode"). Then show a top toolbar with the full URL (`trimURLs` off for this tab), reload, Console, Network and Inspector
  (`gDevToolsBrowser` / `DevToolsShim.showToolboxForTab(tab,{toolId})`), and a striped outline (CSS attribute). Add a command bar toggle and a site-panel checkbox.
  Test: open http://localhost:PORT (test server) → the tab has `whimsy-devmode` and the toolbar is visible. example.org → no. Turn it on for that site → it's set and saved.

## 11. Cookie editor
Queue: `[dev|new|S]` (no note).
- (a) DevTools Storage panel (Shift+F9) can edit cookies. Settings → Manage Data can only delete. API: `Services.cookies.getCookiesFromHost(host, originAttributes)`
  (netwerk/cookie/nsICookieManager.idl:261), `add(host,path,name,value,secure,httpOnly,session,expiry,oa,sameSite,schemeMap,partitioned)` (:138), and `remove(host,name,path,oa)` (:84).
- (b) No issue. D#15851 (custom JS in Boosts) is the nearest.
- (c) The "Cookie-Editor" and EditThisCookie extensions (millions of users): click the icon → a list of this site's cookies → edit, add, delete, import or export as JSON.
  Used for debugging logins and switching test accounts.
- (d) Add a "Cookies (N)" row in the site panel (Zen's unified site popup) that opens a small panel listing cookies for the base domain with the tab's
  `originAttributes` (containers matter). Inline edit name, value, expiry and flags, plus Delete, Add, and Copy-all as JSON. All of it goes through `Services.cookies`.
  Test: set `document.cookie="a=1"` on the test page, open the editor → a row shows a=1. Edit it to 2 → `content.document.cookie` includes a=2. Delete → gone.

## 12. Per-site user agent
Queue: `[privacy|new|S]` (no note).
- (a) There's only a global `general.useragent.override`, plus Mozilla's WebCompat interventions. Per tab: `BrowsingContext.customUserAgent` (settable from
  the parent, dom/chrome-webidl/BrowsingContext.webidl:125, used by Responsive Design Mode). It applies to the context's navigator and HTTP header.
- (b) No issue or discussion.
- (c) Safari: Develop → User Agent (per tab). The "User-Agent Switcher and Manager" extension adds per-site rules. People use it for sites that block Firefox
  ("best viewed in Chrome") or to get mobile layouts.
- (d) Add a site-panel item "Pretend to be…": Default, Chrome (macOS), Safari (macOS), Safari (iPhone), or Custom. Store it per site in `Services.perms` plus a JSON
  pref for the strings. A tabs progress listener's `onLocationChange` (or better, `onStateChange` STATE_START for the top level) sets
  `browser.browsingContext.customUserAgent` for matching sites and clears it otherwise, then reloads once on change.
  Test: set Chrome for the test host and reload → `content.navigator.userAgent` includes "Chrome". Another host → the default.

## 13. whimsy:// URL schemes (Arc parity) + open in a space from the command line
Queue: `[auto|new|S]` NOTE: "Get arc parity. Use whimsy:// though." Plus `[auto|new|S]` "Open in a space from the command line" (no note).
- (a) **The command line already exists.** Zen's BrowserContentHandler patch adds `--space <name|uuid|index>`
  (src/browser/components/BrowserContentHandler-sys-mjs.patch:40). It calls `gZenWorkspaces.changeWorkspaceFromCommandLine` (ZenSpaceManager.mjs:1912),
  and a URL on the same command line opens in that space. On a cold start it's stashed in `zen.workspaces.cmdline-initial-workspace`. But macOS `open -a` drops
  args when the app is already running, and Info.plist registers only http, https and file (engine/browser/app/macbuild/Contents/Info.plist.in:212).
- (b) D#14786 "No way to open a URL into a specific space from the command line" (1), D#7186 "Open to workspace (command line)" (8).
- (c) Arc: internal pages are Chromium's `chrome://` pages under **`arc://`**: arc://history (confirmed in Arc's help), arc://extensions, arc://settings,
  arc://downloads, arc://flags, arc://inspect, arc://version, arc://about (the list). Arc has no extra Arc-only arc:// commands I could confirm.
  Its automation surface is **AppleScript**, which the Raycast Arc extension and arc-cli use: `tell application "Arc" to tell front window to tell space "Work" to focus`,
  `… to make new tab with properties {URL:"…"}` (in a space), `make new tab` at the application level opens Little Arc, and `properties of every space`.
  There's also `open -a Arc <url>`.
- (d) Map `whimsy://` to Firefox pages in the URL bar: settings → about:preferences, history → Library, downloads → about:downloads, extensions → about:addons,
  flags → about:config, keyboard → about:keyboard, plus Whimsy's own `about:whimsy?game|year|shortcuts`. Do it with a URL bar `handleCommand` rewrite plus a JS
  `nsIAboutModule` for `about:whimsy`. External links: add `whimsy` to CFBundleURLSchemes (an Info.plist patch, so not pure overlay) and a `command-line-handler`
  category entry ("a-whimsy", ordered before b-browser) that parses `whimsy://open?space=Work&url=…` and `whimsy://new-tab?url=…` (the quick window, per the answers).
  Ship a `whimsy` CLI shim that calls `Whimsy.app/Contents/MacOS/whimsy --space X url` (remoting reaches the running app). AppleScript parity: Maybe/Tier C.
  Test: type `whimsy://settings` in the URL bar → about:preferences. Feed the handler `whimsy://open?space=Elsewhere&url=https://example.com` → the tab opens in
  that space (reuse the setup in browser_space_routing_external_window.js).

## 14. Inbox-zero balloons
Queue: `[delight|new|S]` NOTE: "I've seen in other apps like todoist superhuman mail ios messages i think etc. maybe balloons fly up too so that are on brand with the browser."
- (a) Nothing in Firefox or Zen.
- (b) No issue or discussion.
- (c) Superhuman's Inbox Zero shows a full-bleed photo and "You've hit Inbox Zero". Todoist celebrates a cleared list (with Karma). iMessage has its "Balloons" screen effect. The joy is a small, earned
  reward at the exact moment the count hits 0, once, and never in the way.
- (d) A `WhimsyDelight.sys.mjs` listens for `TabAttrModified` (label) on mail tabs. Gmail goes "Inbox (3) – …" → "Inbox – …".
  Outlook web and Fastmail get their own title regexes, kept in one table (`whimsy.delight.inbox-zero` on). When the count goes from >0 to 0 on the **selected** tab, release about 12 Whimsy-gradient
  balloons rising from the bottom of the content area (a CSS-animated chrome overlay, pointer-events none, about 2.5 s). Allow it once per tab per 10 minutes.
  Reduced motion shows a small "Inbox zero" toast instead.
  Test: an exported `parseInboxCount(host,title)` unit test. Add a test-only host to the table, change a test page's title "Inbox (2)" → "Inbox" → `#whimsy-balloons` is added and then removed.

## 15. Offline game (whimsy://game)
Queue: `[delight|new|S]` NOTE: "Make it like balloon fight the arcade game. Use cool retro graphics or modern colorful gradients like the icon, and make it a setting on the game page. It should be accessible from the whimsy:// also."
- (a) Firefox has no offline game. The net-error page is aboutNetError (engine/browser/base/content/aboutNetError.*). Zen doesn't add one.
- (b) No issue or discussion.
- (c) Chrome's Dino (chrome://dino, and Space on the offline page) and Edge's Surf (edge://surf, with a Classic or Retro style toggle). The idea here is like Nintendo's 1984 Balloon Fight:
  you flap to rise and drift, and your balloons pop when an enemy lands on them from above, so you pop theirs by landing on them. Water at the bottom and a lurking fish.
  Loved for its one-button, physics-y feel. **Write all-original code and art** (no Nintendo sprites, sounds, names or level layouts).
- (d) Use a single canvas page at `about:whimsy?game` (whimsy://game). On the offline/net-error page, show a "Play while you wait" link (aboutNetError
  is engine code, so inject it through an actor, not a patch). The page has a Style switch, **Retro** (pixel palette, chiptune off by default) or **Gradient** (the icon's
  colours, soft shading), kept in `whimsy.game.style`. Use Space, Up or a click to flap, arrows to steer, P to pause, and keep the high score in a pref. Run at 60 fps with requestAnimationFrame, and pause on blur.
  Test: load whimsy://game → the canvas renders and the score is 0. Switch the style → the pref updates and `data-style` changes. Simulate a stomp collision via `window.__whimsyGame.step()` → the score goes up.

## 16. Seasonal themes
Queue: `[delight|new|S]` (no note).
- (a) Building blocks: WhimsyLook.sys.mjs (look and accent), WhimsyAppIcon.sys.mjs (it can swap the Dock icon while running via `setApplicationIcon`),
  and Zen's space gradients. Firefox itself has nothing (its Colorways were time-limited themes in 2021–22).
- (b) No issue or discussion.
- (c) Google Doodles and Firefox Colorways. The appeal is a gentle, dated surprise that you never have to set up and that goes away on its own.
- (d) `WhimsySeasons` has a date table: Halloween (Oct 24–31), winter holidays (Dec 15–Jan 1), New Year's, spring (cherry blossom). Each entry is
  a small accent tint, an optional Dock icon variant, and one empty-state or new-tab flourish (falling leaves or snow as a CSS layer, off under reduced motion).
  It never changes a space's own colours. Default on, with a Settings checkbox. Today (10-29) is Halloween, so it's easy to try.
  Test: stub the date (`WhimsySeasons._now`) to 10-30 → the root gets `whimsy-season="halloween"`. 07-01 → no attribute. Pref off → no attribute.

## 17. Year in tabs
Queue: `[delight|new|S]` (no note).
- (a) The data is in Places (`moz_places`, `moz_historyvisits` via `PlacesUtils.promiseDBConnection()`) plus Zen's spaces (which Places doesn't know about).
  Nothing like this ships in Firefox or Zen.
- (b) No issue or discussion.
- (c) Spotify Wrapped: a December story of swipeable cards ("your top sites, busiest day, total hours"), all private and on device, with a share
  image at the end. People love the self-reflection and the screenshot they can share.
- (d) Show `about:whimsy?year` (whimsy://year) from Dec 1 (a one-time toast plus a command bar entry). It has 6–7 full-bleed gradient cards: tabs opened (a counter Whimsy
  starts keeping now in `whimsy.stats.*`, per space), top 5 sites by visit count, busiest day and hour, most-used space, longest-open tab and a "night owl" score.
  Arrow keys or a click advance the cards. "Copy card" uses Screenshots `copyScreenshot`. Everything stays local, with no network.
  Test: seed visits with `PlacesTestUtils.addVisits`, open the page → card 2 lists the seeded top site first. ArrowRight advances `data-card`.
