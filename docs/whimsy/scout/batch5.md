# Scout batch 5: media, page tools, reading

Read-only research, 2026-10-29. Paths are relative to ~/Repos/whimsy. "Overlay" means
new code in src/zen/whimsy/ (+ prefs/whimsy/whimsy.yaml, whimsy-settings.js), no Zen edits.
Zen's tracker has almost no open *issues* for these. Feature requests live in GitHub
Discussions, cited as D#.

Shared building blocks:
- Tab mute: `tab.toggleMuteAudio()` (engine/browser/components/tabbrowser/content/tab.mjs:932),
  `browser.audioMuted` (browser-custom-element.mjs:807), Firefox `Ctrl+M` = `key_toggleMute` → `cmd_toggleMute`
  (browser-sets.inc.xhtml:194). Zen's media bar mutes the same way (src/zen/media/ZenMediaController.sys.mjs:337 `onMute`).
- Content-side work needs a JSWindowActor. `WhimsySiteColorChild/Parent.sys.mjs` are listed in
  src/zen/whimsy/moz.build but the files are **empty right now**: the other agent is building them. Reuse
  that registration pattern (`ChromeUtils.registerWindowActor` from Whimsy init), and add one shared
  `WhimsyPageChild/Parent` actor for designMode, copy unblocking, media volume/speed and word count.
- Settings toggles: `initPrefCheckbox(id, pref)` in src/zen/whimsy/content/whimsy-settings.js:236.
- Tests: mochitests in src/zen/whimsy/tests/ (browser.toml). Visual items also get a shot in browser_whimsy_screens.js.

---

## 1. Mute background tabs (toggle)
Queue: `[media|new|S]`. NOTE: "Add settings togglr."
- (a) No such feature in Firefox or Zen. The nearest is `media.block-autoplay-until-in-foreground` (StaticPrefList.yaml:14136),
  which only stops autoplay from starting in tabs that were never shown. Building blocks: `TabSelect`, `tab.soundPlaying` (tab.mjs:309), `toggleMuteAudio`.
- (b) No open issue. D#15423/15425 (per-tab volume + media panel) touch on it.
- (c) Vivaldi: Settings → Tabs → Tab Muting offers "Allow all", "Active tab only", "Prioritize active tab"
  (background audio pauses only while the active tab plays sound). Users love it because a stray autoplay
  in a background tab never talks over the tab they're looking at. Arc has no such mode.
- (d) `WhimsyMedia.sys.mjs`: pref `whimsy.media.background-mute` = "off" | "background" | "prioritize".
  On TabSelect / `TabAttrModified(soundplaying)`, mute non-selected sound tabs that Whimsy muted itself (tag them
  `whimsy-auto-muted` so a mute the user set by hand is left alone), and unmute when a tab is selected.
  PiP tabs and tabs in split view stay exempt. Add a Settings radio under Tab Management.
  Test: two tabs playing a looping `<audio>` file. Select A → B gets `muted`. Select B → A muted, B unmuted. A mute set by hand stays put. Pref off → nothing changes.

## 2. Remember muted sites
Queue: `[media|new|S]` (no note).
- (a) Firefox has nothing persistent. A mute lasts for the tab only (and survives session restore via the `muted` attribute).
  Store the choice with `Services.perms` (any custom type string works, e.g. "whimsy-muted").
- (b) No open issue or discussion.
- (c) Chrome: tab context menu "Mute site" sets the per-site Sound content setting (chrome://settings/content/sound),
  and every future tab on that origin opens muted. People use it for news and shopping sites with autoplay video ads.
- (d) In WhimsyMedia: add a tab context-menu item "Mute site / Unmute site" (insert after `context_toggleMuteTab`) that
  adds or removes `perms.addFromPrincipal(principal, "whimsy-muted", ALLOW)`. A tabs progress listener's `onLocationChange`
  mutes the browser when the site's permission is set (scope it to the site's base domain). The Settings list can come later.
  Test: mute site on example.com, open a new example.com tab → `linkedBrowser.audioMuted`. Open example.org → not muted. Unmute site → clears the permission.

## 3. Per-tab volume
Queue: `[media|new|S]` (no note).
- (a) **No engine API.** No window or browsing-context volume exists: nsIDOMWindowUtils and BrowsingContext.webidl have no
  volume attribute, and MediaController.webidl only has mute. So a slider has to scale every `HTMLMediaElement.volume` in content.
- (b) D#15423 / D#15425 "Per-tab volume control and a volume management panel for media tabs" (open, few votes).
- (c) The "Volume Master" Chrome extension (millions of users; slider per tab, can boost to 600%) and Opera GX's per-tab audio limiter.
  The flow: click the speaker icon on the tab → a slider pops up → drag it.
- (d) Show a popover slider on right-click (or long-press) of the tab's audio indicator, and also in Zen's media bar.
  The parent stores the level per tab (`tab.whimsyVolume`, persisted with SessionStore.setCustomTabValue). The child actor applies
  it by catching the `play`/`volumechange` events (capture phase on the window). It keeps each element's own volume in a WeakMap
  and sets `el.volume = own * level`. Known gap: Web Audio graphs aren't covered. Note this; boosting above 100% would need a Gecko patch.
  Test: page with `<audio>`, set the level to 0.5 → `audio.volume == 0.5`. The page sets 0.8 → it reads back 0.4 (scaled). The level survives tab reload.

## 4. PiP snaps back to the tab
Queue: `[media|new|S]` "PiP snaps back into view" (no note). See also "Automatic picture-in-picture" (NOTE: "I think it exists").
- (a) **Mostly exists.** The player's "Back to tab" button is `PictureInPicture.focusTabAndClosePip` (toolkit/components/pictureinpicture/PictureInPicture.sys.mjs:620).
  Automatic PiP (`media.videocontrols.picture-in-picture.enable-when-switching-tabs.enabled`, which Zen forces **false** in
  prefs/firefox/pip.yaml with "TODO: Enable once we have a proper settings page") already closes again when you return to
  the tab: `unpipAutoPipBrowser` on TabSelect (:497). There's also `...enable-when-occluded.enabled` (firefox.js:2628) and `...auto-close.*`.
  What's missing: **manually** opened PiP doesn't close when you return to its tab, and nothing snaps the window back on screen or to a corner.
- (b) D#15956 "Expose automatic PiP on tab switch in Settings UI". D#6555 "PiP above full-screen apps on macOS" (45 votes). Issue #11881: the PiP window stays open and empty.
- (c) Arc: switching away from a playing video pops it out automatically, and switching back (or clicking the PiP) puts it back
  in the page. macOS native PiP snaps to the nearest screen corner when you let go of it.
- (d) A Settings checkbox for auto-PiP that writes Firefox's pref (this covers the "I think it exists" note). Then a TabSelect listener:
  if the selected browser has a PiP (`PictureInPicture.browserWeakMap.has(browser)`), call
  `closeSinglePipWindow({reason:"Foregrounded", actorRef})` (find the actorRef via weakPipToWin/weakWinToBrowser).
  Corner snap: on the player window's `mouseup` after a move, `moveTo` the nearest corner of `screen.availRect`.
  Test: open PiP on the test video, switch tabs and back → the player window closes. Auto-PiP pref on: switching away opens PiP.

## 5. Playback speed control
Queue: `[media|new|M]` "Playback speed controls" (no note).
- (a) **Already in Firefox, hidden behind a pref:** `media.videocontrols.picture-in-picture.playback-speed.enabled` = false
  (firefox.js:2622). It drives a speed button and slider in the PiP player (pictureinpicture/content/player.js:31,155,332).
  For in-page video there is nothing beyond the site's own controls.
- (b) D#14190 "Playback speed control in the PiP player". Issue #16216 is a YouTube 2x hold bug, unrelated.
- (c) The "Video Speed Controller" extension (Chrome, millions of users): `S`/`D` = −/+0.1x, `R` = reset, `A`/`G` jump between
  preset speeds, with a small overlay showing the speed. People like that it works on any HTML5 video and that a chosen speed sticks per site.
- (d) Step 1, free: set the PiP speed pref to true in whimsy.yaml. Step 2: add a speed control to Zen's media bar plus shortcuts
  (Cmd+Opt+, and Cmd+Opt+.?) that send `setRate` to the actor, which sets `playbackRate` on the playing or largest `<video>`, with a toast.
  Test: the pref's default is true. Open PiP → `#playback-rate` is not hidden. In-page: a shortcut on the test video → `playbackRate == 1.25`.

## 6. Capture tool + full-page screenshot to clipboard
Queue: `[page|partial|S]` "Capture tool" and `[page|partial|S]` "Full-page capture to clipboard" (no notes). Related: "Screenshot to sidebar" and "Annotate captures".
- (a) Firefox Screenshots (engine/browser/components/screenshots/ScreenshotsUtils.sys.mjs) is on (`screenshots.browser.component.enabled`).
  It lets you drag a region, hover to snap to an element, or pick "visible" or "full page", then Copy or Download. Shortcut: `key_screenshot`
  = Cmd+Shift+S (browser-sets.inc.xhtml:343). Zen exposes it as a command bar action, "zen-action-capture-screenshot" (src/zen/urlbar/ZenUBGlobalActions.sys.mjs:262).
  Full-page copy takes three clicks today. All the pieces exist: `fetchFullPageBounds(browser)`, `createCanvas(rect, browser)`,
  `copyScreenshot(blob, browser, eventName)` (:1168, :1253, :1409), and `cropScreenshotRectIfNeeded` handles very long pages.
- (b) D#16068 "Built-in screenshot editor after capturing". Issue #14601: no screenshots during Ctrl+Tab.
- (c) Arc's Capture (Cmd+Shift+2): drag a region or click an element, then Copy, Save or send it to an Easel. Edge's Web Capture (Cmd+Shift+S) adds "Capture full page".
  The joy is a single shortcut that drops a clean image on the clipboard, with no editor in between.
- (d) Add Arc's Cmd+Shift+2 as a second key for `Browser:Screenshot` (use WhimsyShortcuts, check for conflicts). Add a command
  "Copy full-page screenshot" (command bar + Cmd+Opt+Shift+S): `rect = await ScreenshotsUtils.fetchFullPageBounds(b)`,
  `canvas = await createCanvas(rect,b)`, `copyScreenshot(await canvas.convertToBlob(), b, "whimsy")`, then a Whimsy toast.
  Test: run the command on a tall test page → the clipboard has `image/png` with height > the viewport (check with `Services.clipboard.hasDataMatchingFlavors`).

## 7. Edit text on page
Queue: `[page|new|S]` (no note).
- (a) Nothing in the UI. The known approach is `document.designMode = "on"` (or DevTools). Zen's Zap (src/zen/boosts/ZenZapOverlayChild.sys.mjs)
  *removes* elements but doesn't edit text.
- (b) No issue or discussion.
- (c) The designMode bookmarklet and "Edit page" extensions. People use it to mock up copy changes, redact things before a screenshot, or test text lengths.
  Flow: toggle on → click anywhere and type → toggle off or press Esc.
- (d) A command bar action and page context-menu item "Edit text on page" sends `setEditable(true|false)` to the actor, which flips
  `contentDocument.designMode`. A URL-bar pill "Editing, Esc to finish" shows while it's on. It's cleared on navigation (it's per document anyway).
  Test: toggle on → `content.document.designMode == "on"`. Send a key into a `<p>` → its text changes. Esc → "off".

## 8. Allow copy and paste on sites that block it
Queue: `[page|new|S]` (no note).
- (a) Global, blunt switches: `dom.event.clipboardevents.enabled` (StaticPrefList.yaml:3019; turning it off breaks Docs and Sheets)
  and `dom.event.contextmenu.shift_suppresses_event` (:3025, Shift+right-click gets past a blocked menu). There's nothing per site
  and nothing for `user-select:none` or `selectstart` blockers.
- (b) No issue or discussion.
- (c) Extensions like "Absolute Enable Right Click & Copy" and "Allow Copy" (each with 1M+ Chrome users), and "Don't F*** With Paste"
  for password and confirm fields. Flow: click the toolbar toggle for this site → selecting, copying, pasting and right-click all work.
- (d) Add a per-site permission "whimsy-allow-copy" plus a command bar toggle. The actor's child, on `DOMDocElementInserted`
  (document start), adds capture-phase window listeners for copy, cut, paste, contextmenu, selectstart and dragstart that call
  `stopImmediatePropagation()` (they register first, so page handlers never run), plus a user sheet
  `*{user-select:text!important}` through `windowUtils.loadSheet(..., USER_SHEET)`. Off by default, applied per site.
  Test: a test page that blocks copy and paste (preventDefault + user-select:none). Without the permission, the paste doesn't arrive.
  With it, `goDoCommand("cmd_paste")` fills the input and the selection isn't empty.

## 9. Internet Archive for dead pages
Queue: `[page|new|S]` (no note).
- (a) Nothing in Firefox or Zen (`web.archive.org` appears only in search code). The error page is engine/toolkit/content/aboutNetError.mjs, which is Zen-owned, so don't patch it.
- (b) No issue or discussion.
- (c) Brave: on a 404, 410 or 5xx a bar asks "Sorry, that page is missing. Check for a saved version on the Wayback Machine?"
  (Settings → "Show Wayback Machine prompt"). The official Wayback Machine extension does the same.
  `https://archive.org/wayback/available?url=` returns the nearest snapshot, and `https://web.archive.org/web/<url>` redirects to the latest one.
- (d) A tabs progress listener: in `onStateChange(STATE_STOP)` read `request.QueryInterface(Ci.nsIHttpChannel).responseStatus`
  (404, 410, 451, 5xx), or catch a DNS error (`about:neterror`, `onLocationChange` with `LOCATION_CHANGE_ERROR_PAGE`). Fetch the availability API once,
  then show a `gBrowser.getNotificationBox(browser)` bar, "This page is gone. Open the archived copy (Jun 2024)". Also add an always-on
  command bar action "Open in Internet Archive". Add a pref to turn the bar off. Never send private-window or localhost URLs.
  Test: an .sjs that returns 404 → the notification appears (stub the API with a pref pointing at a local .sjs). Private window → no bar.

## 10. Image info
Queue: `[page|new|S]` (no note).
- (a) **A one-pref win:** `browser.menu.showViewImageInfo` (default false) shows "View Image Info" on the image context menu
  (nsContextMenu.sys.mjs:795, `viewImageInfo()` :1762). It opens Page Info's Media tab: dimensions, file size, type, alt text, a "Save As" button.
- (b) No issue (D#13908 is about PiP).
- (c) Firefox had this item until Fx88. Users who missed it asked for it back. The flow: right-click an image → View Image Info → dimensions and size.
- (d) Add `browser.menu.showViewImageInfo: true` to prefs/whimsy/whimsy.yaml. Later, maybe, a lighter hover popover
  (size and dimensions from `context.imageInfo`, ContextMenuChild.sys.mjs:990).
  Test: context-click an `<img>` in a test page → `#context-viewimageinfo` is not hidden. Click it → a pageInfo window opens on the media tab.

## 11. Translate selection
Queue: `[page|partial|S]` (no note). Related: `[ai|partial|M]` "Translate with context".
- (a) **Already on:** `browser.translations.select.enable` = true (firefox.js:2640). The context menu shows "Translate Selection to X",
  translating on-device with Bergamot (`SelectTranslationsPanel.open(event, screenX, screenY, sourceText, isTextSelected, langPairPromise)`,
  engine/browser/components/translations/content/selectTranslationsPanel.js:552, called from nsContextMenu.sys.mjs:2705). There's no keyboard shortcut.
- (b) D#13223 "Separate shortcuts for full-page and selection translation". D#13678 "Auto-translate highlight options". Issue #14526 "Translation not working".
- (c) Safari and Edge: select text → right-click → Translate shows an inline popover. Arc relied on Chrome's. People love that it's quick and stays private (local models).
- (d) Add a shortcut (Cmd+Shift+Y?) and a command bar action that grab the selection (`gBrowser.selectedBrowser` + the actor's
  `getSelection().toString()` and selection rect) and call `SelectTranslationsPanel.open(...)`, the same way nsContextMenu builds the call.
  Test: select a French `<p>` and press the key → `#select-translations-panel` state is "open". The AI kill switch shouldn't block it (it's not AI, but check WhimsyAI's list).

## 12. Reader typography
Queue: `[reading|partial|S]` "Reader view typography" (no note). Related: "Smarter reader mode" (NOTE: "Scope what exists today and what we can add").
- (a) Firefox's reader view "Text and layout" panel already covers font, size, weight, content width, line height, letter and word spacing, alignment,
  and color schemes with custom colors (all.js:3497–3541, `reader.*`). **Surprise:** `reader.font_type.values` is a JSON list
  and *any* font family works. `_setFontTypeSelector` sets `--font-family` directly, and an option without an l10n id shows its name
  (AboutReader.sys.mjs:313, :789, :813). So extra fonts cost one pref.
- (b) No issue.
- (c) Safari Reader (a few nice fonts: Charter, Iowan, Athelas, New York) and Arc, which had no reader view. People want a calm, book-like page.
- (d) In whimsy.yaml set `reader.font_type.values` = `["sans-serif","serif","monospace","Charter","Iowan Old Style","New York","Georgia"]`
  (all macOS system fonts), and maybe nicer defaults (`reader.line_height` 5, `reader.content_width` 4). Optional: a user CSS sheet for
  about:reader with tighter heading tracking and hanging punctuation.
  Test: open about:reader on a test article → `#font-type-selector` has a "Charter" option. Picking it → the body's computed fontFamily includes Charter.

## 13. Reading time
Queue: `[reading|partial|S]` "Estimated reading time" (no note).
- (a) **Exists inside reader view only:** ReaderMode computes `readingTimeMinsSlow/Fast` (ReaderMode.sys.mjs:461), and
  AboutReader shows "5–7 minutes" in the header (AboutReader.sys.mjs:1453). Nothing shows on the normal page.
- (b) No issue.
- (c) Medium's "6 min read" and Safari's reader. It tells you up front whether to read now or save the page for later.
- (d) When the URL bar's reader button becomes visible (`browser.isArticle`, via AboutReaderParent's "Reader:UpdateReaderButton"),
  ask the actor for the word count of `document.body.innerText` (or the Readability length cached by ReaderMode) and show "6 min" next to the reader icon, plus in the tab tooltip.
  Use ReaderMode's chars-per-minute numbers so the two estimates match. Add a pref to turn it off.
  Test: load a ~1,500-word test article → `#whimsy-reading-time` shows "6 min" (within the expected range). A non-article page → hidden.

## 14. Dark PDFs (toggle)
Queue: `[reading|new|S]` "Dark mode for PDFs". NOTE: "Add toggle in settings".
- (a) pdf.js prefs (engine/toolkit/components/pdfjs/PdfJsDefaultPrefs.js:57–71): `pdfjs.forcePageColors` (false),
  `pdfjs.pageColorsBackground` ("Canvas"), `pdfjs.pageColorsForeground` ("CanvasText"), and `pdfjs.viewerCssTheme` (0 auto, 1 light, 2 dark).
  forcePageColors recolors text and vector paths, but images stay as they are. Zen overrides only highlight, scripting and Nova (prefs/firefox/pdf.yaml, browser.yaml:120).
  Zen Boosts "smart invert" (src/zen/boosts) doesn't apply to pdf.js.
- (b) **D#3982 "Dark mode for PDFs"** (9 votes, open). D#13995 is about smart invert.
- (c) Chrome and Arc have no built-in option (people use extensions or OS invert). Edge's PDF viewer and Skim have dark pages. Readers want it for reading at night.
- (d) A Settings checkbox `whimsy.pdf.dark` (off by default) writes `pdfjs.forcePageColors=true`,
  `pageColorsBackground="#1c1b22"`, `pageColorsForeground="#e8e6e3"` and `viewerCssTheme=2`, and resets them when unchecked.
  pdf.js reads prefs when a PDF loads, so reload open PDF tabs. Possible extra: "follow system dark mode" only when `viewerCssTheme` is 0.
  Test: toggle on → open a test .pdf → `PDFViewerApplicationOptions.get("forcePageColors") === true` and the page canvas pixel at a blank spot is dark. Toggle off → the prefs reset.

---

## Cheapest wins (prefs only, in whimsy.yaml)
1. `browser.menu.showViewImageInfo: true` (image info, done).
2. `media.videocontrols.picture-in-picture.playback-speed.enabled: true` (PiP speed).
3. `reader.font_type.values` with macOS fonts (reader typography).
4. A Settings checkbox for `...picture-in-picture.enable-when-switching-tabs.enabled` (auto-PiP; Zen has it off "until a settings page" exists).
Translate selection and reader-view reading time already ship. They only need a shortcut or to show up in more places.
